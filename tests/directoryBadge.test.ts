/**
 * A badge from the user directory, issued apart from the authentication (ayni-spec D130; IDENT-AUTH-016,
 * IDENT-DIR-005/006, INTX-ISSUE-007/008/020/021): its claims come from the entry the Principal's authentication
 * identified, `pending` before one; the birth date and the portrait from a passport of that entry read when the person
 * authenticated, empty without one; a badge is held by the wallet it was issued to, and the automatic trigger offers it
 * on a connection that holds none. Then what the agent-pack may say of it. The issuance runs on the in-memory store; the
 * authentication itself is tested in tests/authenticate.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { PackError, validatePackDocument } from '../src/config/pack.js'
import type { AgentPack, IssuanceProfile } from '../src/config/packTypes.js'
import { UserDirectory } from '../src/core/directory.js'
import { DirectoryClaims } from '../src/core/directoryClaims.js'
import { type EvidenceInput, EvidenceService } from '../src/core/evidence.js'
import { dateInt, type IssuanceDeps, IssuanceService, subjectId, subjectIdKey } from '../src/core/issuance.js'
import type { Principal, Session } from '../src/core/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'
import { badgeAuthentication } from './helpers.js'

// biome-ignore lint/suspicious/noExplicitAny: a YAML document the tests edit freely
type Doc = Record<string, any>

const crypto = createEntryCrypto(Buffer.alloc(32, 5))
const key = subjectIdKey(Buffer.alloc(32, 5))
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'
const root = mkdtempSync(join(tmpdir(), 'ayni-badge-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A logger that keeps what it is given: the reasons go to the log, never a value (IDENT-DIR-007). */
function recorder() {
  const lines: { level: string; obj: Record<string, unknown>; msg?: string }[] = []
  const at = (level: string) => (obj: Record<string, unknown>, msg?: string) => void lines.push({ level, obj, msg })
  return { lines, logger: { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') } }
}

const PEOPLE = [
  {
    id: 'p-0042',
    firstName: 'Ana María',
    lastName: 'Ríos',
    email: 'ana.rios@northwind.example',
    birthDate: '19910521',
    nationality: 'ESP',
    department: 'Depot Rotterdam',
  },
  {
    id: 'p-0043',
    firstName: 'Jürgen',
    lastName: 'Müller',
    email: 'jurgen.muller@northwind.example',
    birthDate: '19800101',
    nationality: 'D',
  },
]

async function directoryOf(people: Record<string, unknown>[]) {
  const file = join(root, `directory-${Math.random().toString(36).slice(2)}.yaml`)
  writeFileSync(file, stringifyYaml({ people }))
  const store = new MemoryStore()
  const { logger } = recorder()
  const directory = new UserDirectory(
    file,
    { roles: [], passport: true },
    store.kv,
    store.adminAudit,
    crypto,
    logger as never
  )
  directory.open()
  return directory
}

const document = {
  store: {
    attributes: ['documentNumber', 'issuingState', 'nationality', 'lastName', 'firstName', 'dateOfBirth', 'portrait'],
  },
}

/** The badge of the spec's example (architecture §11.10): no challenge, its claims from the entry (D130). */
const badgeProfile = (trigger: IssuanceProfile['trigger'] = 'model'): IssuanceProfile => ({
  credential: { credentialDefinitionId: 'def-badge' },
  label: 'Northwind badge',
  trigger,
  claims: {
    badgeNumber: { from: 'computed', fn: 'subjectId' },
    name: { from: 'record', record: 'directory', field: 'name' },
    email: { from: 'record', record: 'directory', field: 'email' },
    department: { from: 'record', record: 'directory', field: 'department' },
    birthDate: { from: 'evidence', entry: 'document', attribute: 'dateOfBirth', as: 'dateint' },
    photo: { from: 'evidence', entry: 'document', attribute: 'portrait' },
    phoneNumber: { from: 'computed', fn: 'constant', value: '' },
  },
})

/** A person the authentication identified as the entry, on the connection of a wallet. */
const identified = (entry = 'p-0042', connection = 'conn-1'): Principal =>
  ({
    id: `prn-${entry}`,
    connectionType: 'verifiable-user-agent',
    capabilityChannelId: connection,
    identityCredentialRef: `entry:${entry}`,
    directoryEntryId: entry,
    roles: [],
  }) as unknown as Principal
const visitor = {
  id: 'prn-visitor',
  connectionType: 'verifiable-user-agent',
  capabilityChannelId: 'conn-9',
  identityCredentialRef: null,
  roles: [],
} as unknown as Principal
const session = { id: 'ses_1', channelType: 'ag-ui' } as Session

/** A passport read on the phone during an authentication, as the agent records it once accepted (PRIV-EVID-012). */
const passport = (over: Record<string, string> = {}): EvidenceInput => ({
  kind: 'document',
  entry: 'document',
  values: {
    documentNumber: 'X1234567',
    issuingState: 'ESP',
    nationality: 'ESP',
    lastName: 'RIOS',
    firstName: 'ANA MARIA',
    dateOfBirth: '1991-05-21',
    portrait: 'data:image/jpeg;base64,AAAA',
    ...over,
  },
})

async function setup(profile: IssuanceProfile) {
  const pack = {
    identity: { roleRules: [] },
    evidence: { document },
    issuance: { badge: profile },
  } as unknown as AgentPack
  const store = new MemoryStore()
  const { lines, logger } = recorder()
  const evidence = new EvidenceService(store, pack, crypto, logger as never)
  const directory = await directoryOf(PEOPLE)
  const claims = new DirectoryClaims(directory, evidence, logger as never)
  const challenges: string[] = []
  const offers: { connectionId: string; claims: Record<string, string> }[] = []
  const deps: IssuanceDeps = {
    offer: async (input) => {
      offers.push({ connectionId: input.connectionId, claims: input.claims })
      return { outcome: 'issued', exchangeId: `cex-${offers.length}` }
    },
    challenge: async (_principal, _session, policy) => {
      challenges.push(policy.type)
      return { passed: true }
    },
    record: (principal, name, p, source) => claims.resolve(principal, name, p, source),
    entryDocument: (principal, p) => claims.entryDocument(principal, p),
    allocateRevocation: async () => ({ registryDefinitionId: 'def-badge/revreg-1', index: offers.length }),
    holderOf: async () => 'holder-1',
  }
  const service = new IssuanceService(pack, evidence, deps, logger as never, key)
  return { service, evidence, offers, challenges, lines }
}

describe('the claims of the entry the authentication identified (D130, INTX-ISSUE-021, IDENT-DIR-005)', () => {
  it('reports the claims of the directory pending before an authentication, which is their action (INTX-ISSUE-006/007)', async () => {
    const { service } = await setup(badgeProfile())
    const [badge] = await service.requirements(visitor)
    expect(badge?.state).toBe('incomplete')
    const authenticate = { type: 'request_presentation', entry: 'authentication' }
    expect(badge?.claims.filter((c) => c.status !== 'available')).toEqual([
      { name: 'name', status: 'pending', action: authenticate },
      { name: 'email', status: 'pending', action: authenticate },
      { name: 'department', status: 'pending', action: authenticate },
    ])
    expect((await service.issue(visitor, session, 'badge', 'model')).outcome).toBe('incomplete')
  })

  it('issues from the entry with no challenge, the claims of the passport empty when none was read (IDENT-DIR-005)', async () => {
    const { service, offers, challenges, evidence } = await setup(badgeProfile())
    const ana = identified()
    expect((await service.requirements(ana))[0]?.state).toBe('ready')
    expect((await service.issue(ana, session, 'badge', 'model')).outcome).toBe('issued')
    // issuing a badge asks nothing of the phone: it is independent of the authentication (IDENT-AUTH-016)
    expect(challenges).toEqual([])
    expect(offers[0]).toEqual({
      connectionId: 'conn-1',
      claims: {
        badgeNumber: subjectId(key, 'badge', ana.id),
        name: 'Ana María Ríos',
        email: 'ana.rios@northwind.example',
        department: 'Depot Rotterdam',
        birthDate: '',
        photo: '',
        phoneNumber: '',
      },
    })
    // the record keeps the entry it came from, by which a presented badge finds it again (IDENT-DIR-006)
    const record = (await evidence.list(ana.id)).find((r) => r.kind === 'issuance')
    expect(record).toMatchObject({ kind: 'issuance', directoryEntryId: 'p-0042', connectionRef: 'conn-1' })
  })

  it('takes the birth date as YYYYMMDD and the portrait from the passport of the entry read when the person authenticated', async () => {
    const { service, offers, evidence } = await setup(badgeProfile())
    const ana = identified()
    await evidence.record(ana, passport())
    expect((await service.issue(ana, session, 'badge', 'model')).outcome).toBe('issued')
    expect(offers[0]?.claims).toMatchObject({ birthDate: '19910521', photo: 'data:image/jpeg;base64,AAAA' })
  })

  it("leaves them empty for a passport that is not the entry's, and logs why without a value", async () => {
    const { service, offers, evidence, lines } = await setup(badgeProfile())
    const jurgen = identified('p-0043')
    // Ana's passport on Jürgen's connection: it gives his badge nothing of hers
    await evidence.record(jurgen, passport())
    expect((await service.issue(jurgen, session, 'badge', 'model')).outcome).toBe('issued')
    expect(offers[0]?.claims).toMatchObject({ name: 'Jürgen Müller', birthDate: '', photo: '' })
    expect(JSON.stringify(lines)).not.toMatch(/RIOS|1991|X1234567/)
  })

  it('gives a person who is not on the list no badge of the directory: unavailable, with nothing to do', async () => {
    const { service } = await setup(badgeProfile())
    const partner = {
      ...identified(),
      id: 'prn-partner',
      directoryEntryId: undefined,
      identityCredentialRef: 'badge:pex-1',
    } as Principal
    const [badge] = await service.requirements(partner)
    expect(badge?.claims.find((c) => c.name === 'name')).toMatchObject({
      status: 'unavailable',
      action: { type: 'none' },
    })
    expect((await service.issue(partner, session, 'badge', 'model')).outcome).toBe('incomplete')
  })
})

describe('held by the wallet it was issued to, and the automatic trigger (D130, IDENT-AUTH-016)', () => {
  it('is held on the connection it was issued to, and issued again, with the same number, to a new wallet', async () => {
    const { service, offers } = await setup(badgeProfile())
    expect((await service.issue(identified(), session, 'badge', 'model')).outcome).toBe('issued')
    expect((await service.issue(identified(), session, 'badge', 'model')).outcome).toBe('held')
    // a new phone: another connection of the same Principal holds no badge yet
    const onNewPhone = identified('p-0042', 'conn-2')
    expect((await service.requirements(onNewPhone))[0]?.state).toBe('ready')
    expect((await service.issue(onNewPhone, session, 'badge', 'model')).outcome).toBe('issued')
    expect(offers.map((o) => o.connectionId)).toEqual(['conn-1', 'conn-2'])
    expect(offers[1]?.claims.badgeNumber).toBe(offers[0]?.claims.badgeNumber)
  })

  it('offers an automatic badge once an authentication identified an entry, and once per connection', async () => {
    const { service, offers } = await setup(badgeProfile('automatic'))
    // a visitor: nothing is offered, the claims of the directory are pending
    await service.automatic(visitor, session)
    expect(offers).toEqual([])
    await service.automatic(identified(), session)
    expect(offers).toHaveLength(1)
    // a later authentication on the same connection offers nothing: the badge issued there is still valid
    await service.automatic(identified(), session)
    expect(offers).toHaveLength(1)
    // nor may the model or the person start it (INTX-ISSUE-008)
    expect((await service.issue(identified('p-0042', 'conn-3'), session, 'badge', 'model')).outcome).toBe('not-offered')
  })
})

describe('as: dateint (IDENT-DIR-005)', () => {
  it('writes a calendar date as the integer YYYYMMDD', () => {
    expect(dateInt('1991-05-21')).toBe('19910521')
    expect(dateInt('19910521')).toBe('19910521')
    expect(dateInt('21/05/1991')).toBeUndefined()
  })
})

describe('what the agent-pack may say of a badge from the directory (D130, INTX-ISSUE-010/020/021)', () => {
  const env = { HOME_BACKING_IDENTITY: 'did:webvh:x:home' }
  /** the dev pack with a directory, an email method and the badge of the spec's example, changed by `edit` */
  function packWith(edit: (doc: Doc) => void): () => AgentPack {
    const doc = parseYaml(readFileSync('agent-packs/dev/agent-pack.yaml', 'utf8')) as Doc
    doc.identity.directory = { file: '/var/run/secrets/directory.yaml' }
    const authentication = badgeAuthentication({
      credential: { jsonSchemaCredentialId: BADGE },
      subjectKey: ['badgeNumber'],
      request: 'on-demand',
      visitors: true,
    })
    doc.identity.authentication = {
      ...authentication,
      methods: { ...authentication.methods, email: { type: 'email' } },
      combinations: [['badge'], ['email']],
    }
    doc.evidence = { document, email: { store: { attributes: ['address'] } } }
    doc.issuance = { badge: { ...badgeProfile('automatic'), credential: { jsonSchemaCredentialId: BADGE } } }
    edit(doc)
    return () => validatePackDocument(doc, env)
  }
  const refused = (load: () => AgentPack, words: string) => {
    let error: unknown
    try {
      load()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(PackError)
    expect((error as Error).message).toContain(words)
  }

  it('accepts the badge with no challenge, and a single challenge of another profile', () => {
    expect(packWith(() => undefined)().issuance?.badge?.authChallenge).toBeUndefined()
    const single = packWith((doc) => {
      doc.issuance.pass = {
        credential: { credentialDefinitionId: 'def-pass' },
        authChallenge: { type: 'device' },
        claims: { validUntil: { from: 'computed', fn: 'addDays', days: 7 } },
      }
    })()
    expect(single.issuance?.pass?.authChallenge).toEqual({ type: 'device' })
  })

  it('refuses an email code or a face match as a challenge, in words: they are methods (INTX-ISSUE-010, TOOL-CAT-010)', () => {
    refused(
      packWith((doc) => {
        doc.issuance.badge.authChallenge = [{ type: 'email' }]
      }),
      'INTX-ISSUE-010: issuance.badge.authChallenge has the type email'
    )
    refused(
      packWith((doc) => {
        doc.issuance.badge.authChallenge = { type: 'face-match' }
      }),
      'INTX-ISSUE-010: issuance.badge.authChallenge has the type face-match'
    )
    refused(
      packWith((doc) => {
        doc.issuance.badge.authChallenge = [{ type: 'device' }, { type: 'document' }]
      }),
      'fails schema validation'
    )
  })

  it('needs a directory, and what the matching of the passport and the claims read stored (INTX-ISSUE-021, IDENT-DIR-005)', () => {
    refused(
      packWith((doc) => {
        Reflect.deleteProperty(doc.identity, 'directory')
      }),
      'INTX-ISSUE-021: issuance.badge takes claims from the user directory, and identity.directory names no file'
    )
    refused(
      packWith((doc) => {
        doc.evidence.document = {
          store: { attributes: ['documentNumber', 'issuingState', 'lastName', 'firstName', 'dateOfBirth'] },
        }
      }),
      'IDENT-DIR-005: issuance.badge takes claims from the passport read when the person authenticated: evidence.document must store [nationality, portrait]'
    )
  })

  it('needs an email method and the address stored for emailId, never shown to the model (INTX-ISSUE-020, IDENT-AUTH-009)', () => {
    const byAddress = (doc: Doc) => {
      doc.issuance.badge.claims.badgeNumber = { from: 'computed', fn: 'emailId' }
    }
    expect(packWith(byAddress)()).toBeTruthy()
    refused(
      packWith((doc) => {
        byAddress(doc)
        doc.identity.authentication.methods = { badge: doc.identity.authentication.methods.badge }
        doc.identity.authentication.combinations = [['badge']]
      }),
      'INTX-ISSUE-020: issuance.badge takes a claim from a verified address, and identity.authentication enables no email method'
    )
    refused(
      packWith((doc) => {
        byAddress(doc)
        Reflect.deleteProperty(doc.evidence, 'email')
      }),
      'INTX-ISSUE-020: issuance.badge takes a claim from a verified address: evidence.email must store [address]'
    )
    refused(
      packWith((doc) => {
        doc.evidence.email = { store: { attributes: ['address'] }, modelVisible: ['address'] }
      }),
      'IDENT-AUTH-009: evidence.email.modelVisible'
    )
  })

  it('refuses a field of the directory a claim may not take (INTX-ISSUE-021, IDENT-DIR-007)', () => {
    refused(
      packWith((doc) => {
        doc.issuance.badge.claims.birthDate = { from: 'record', record: 'directory', field: 'birthDate' }
      }),
      'fails schema validation'
    )
  })
})
