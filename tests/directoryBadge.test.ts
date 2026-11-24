/**
 * A badge from the user directory (decision 62; ayni-spec D88): the claims of the person's entry found from a passport,
 * from a verified address or from both (IDENT-DIR-002..005, INTX-ISSUE-007/020/021), `as: dateint`, `emailId`, and what
 * the agent-pack may say of it (IDENT-DIR-002, INTX-AUTH-011/015). The issuance runs on the in-memory store with a
 * document read and an email check that the test makes pass; their own mechanics are tested elsewhere
 * (tests/issuance.test.ts, tests/emailCode.test.ts).
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
import { dateInt, documentId, emailId, type IssuanceDeps, IssuanceService, subjectIdKey } from '../src/core/issuance.js'
import type { Principal, Session } from '../src/core/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'

// biome-ignore lint/suspicious/noExplicitAny: a YAML document the tests edit freely
type Doc = Record<string, any>

const crypto = createEntryCrypto(Buffer.alloc(32, 5))
const key = subjectIdKey(Buffer.alloc(32, 5))
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'
const root = mkdtempSync(join(tmpdir(), 'ayni-badge-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A logger that keeps what it is given: the reasons go to the log, never a value (IDENT-DIR-003/007). */
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
  // two people a passport cannot tell apart
  {
    id: 'p-0050',
    firstName: 'Li',
    lastName: 'Wang',
    email: 'li.wang.1@northwind.example',
    birthDate: '19950303',
    nationality: 'CHN',
  },
  {
    id: 'p-0051',
    firstName: 'Li',
    lastName: 'Wang',
    email: 'li.wang.2@northwind.example',
    birthDate: '19950303',
    nationality: 'CHN',
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
const fromDirectory = (challenges: IssuanceProfile['authChallenge']): IssuanceProfile => {
  const reads = ([] as { type: string }[]).concat(challenges ?? []).some((c) => c.type === 'document')
  return {
    credential: { credentialDefinitionId: 'def-badge' },
    label: 'Northwind badge',
    authChallenge: challenges,
    claims: {
      badgeNumber: reads ? { from: 'computed', fn: 'documentId' } : { from: 'computed', fn: 'emailId' },
      name: { from: 'record', record: 'directory', field: 'name' },
      email: { from: 'record', record: 'directory', field: 'email' },
      department: { from: 'record', record: 'directory', field: 'department' },
      birthDate: reads
        ? { from: 'evidence', entry: 'document', attribute: 'dateOfBirth', as: 'dateint' }
        : { from: 'computed', fn: 'constant', value: '' },
      phoneNumber: { from: 'computed', fn: 'constant', value: '' },
    },
  }
}

const person = {
  id: 'prn_1',
  connectionType: 'verifiable-user-agent',
  capabilityChannelId: 'conn-1',
  roles: [],
} as unknown as Principal
const session = { id: 'ses_1', channelType: 'ag-ui' } as Session

/** A passport of the person read on the phone, as the event handler records it (PRIV-EVID-012). */
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

async function setup(
  profile: IssuanceProfile,
  opts: { read?: EvidenceInput; address?: string; people?: Record<string, unknown>[] } = {}
) {
  const pack = {
    identity: { roleRules: [] },
    evidence: { document, email: { store: { attributes: ['address'] } } },
    issuance: { badge: profile },
  } as unknown as AgentPack
  const store = new MemoryStore()
  const { lines, logger } = recorder()
  const evidence = new EvidenceService(store, pack, crypto, logger as never)
  const directory = await directoryOf(opts.people ?? PEOPLE)
  const emailCheck = {
    available: () => true,
    start: async (principal: Principal) => {
      // the person types the address and the right code: the check records its evidence (INTX-AUTH-015)
      if (opts.address)
        await evidence.record(principal, { kind: 'email', entry: 'email', values: { address: opts.address } })
      return { started: true as const, question: 'Which address?', challengeId: 'chl_1' }
    },
  }
  const claims = new DirectoryClaims(directory, evidence, logger as never, emailCheck)
  const asked: string[] = []
  const offers: Record<string, string>[] = []
  const deps: IssuanceDeps = {
    offer: async (input) => {
      offers.push(input.claims)
      return { outcome: 'issued', exchangeId: `cex-${offers.length}` }
    },
    challenge: async (principal, _session, policy) => {
      asked.push(policy.type)
      if (opts.read) await evidence.record(principal, opts.read)
      return { passed: true }
    },
    emailCheck,
    record: (principal, name, p, source) => claims.resolve(principal, name, p, source),
    allocateRevocation: async () => ({ registryDefinitionId: 'def-badge/revreg-1', index: offers.length }),
    holderOf: async () => 'holder-1',
  }
  const service = new IssuanceService(pack, evidence, deps, logger as never, key)
  return { service, evidence, offers, asked, lines }
}

describe('with a passport (IDENT-DIR-003, IDENT-DIR-005)', () => {
  const profile = fromDirectory([{ type: 'document' }])

  it('reports the claims of the directory pending until the read, which the issuance starts with (INTX-ISSUE-007/021)', async () => {
    const { service } = await setup(profile)
    const [badge] = await service.requirements(person)
    expect(badge?.state).toBe('ready')
    const byReading = { type: 'issue_credential', profile: 'badge', challenge: 'document', note: expect.any(String) }
    expect(badge?.claims).toEqual([
      { name: 'badgeNumber', status: 'missing', action: byReading },
      { name: 'name', status: 'pending', action: byReading },
      { name: 'email', status: 'pending', action: byReading },
      { name: 'department', status: 'pending', action: byReading },
      { name: 'birthDate', status: 'missing', action: byReading },
      { name: 'phoneNumber', status: 'available' },
    ])
  })

  it('issues from the one entry the passport matches: its name, address and department, the birth date as YYYYMMDD', async () => {
    const { service, offers, asked, evidence } = await setup(profile, { read: passport() })
    expect((await service.issue(person, session, 'badge', 'model')).outcome).toBe('issued')
    expect(asked).toEqual(['document'])
    expect(offers).toEqual([
      {
        badgeNumber: documentId(key, 'badge', 'ESP', 'X1234567'),
        name: 'Ana María Ríos',
        email: 'ana.rios@northwind.example',
        department: 'Depot Rotterdam',
        birthDate: '19910521',
        phoneNumber: '',
      },
    ])
    const record = (await evidence.list(person.id)).find((r) => r.kind === 'issuance')
    expect(record?.directoryEntryId).toBe('p-0042')
  })

  it('matches a name the zone writes with either form of the table, and a one-letter nationality', async () => {
    for (const lastName of ['MUELLER', 'MULLER']) {
      const read = passport({
        lastName,
        firstName: 'JUERGEN',
        dateOfBirth: '1980-01-01',
        nationality: 'D',
        issuingState: 'D',
      })
      const { service, offers } = await setup(profile, { read })
      expect((await service.issue(person, session, 'badge', 'model')).outcome).toBe('issued')
      expect(offers[0]).toMatchObject({ name: 'Jürgen Müller', department: '' })
    }
  })

  it('issues nothing from a passport that matches no entry, or several, and logs why without a value', async () => {
    const stranger = passport({ lastName: 'RIOS', firstName: 'ANA MARIA', dateOfBirth: '1991-05-22' })
    const none = await setup(profile, { read: stranger })
    const result = await none.service.issue(person, session, 'badge', 'model')
    expect(result.outcome).toBe('incomplete')
    expect(result.requirements?.claims.find((c) => c.name === 'name')).toMatchObject({
      status: 'missing',
      action: { type: 'none' },
    })
    expect(none.offers).toEqual([])
    const why = none.lines.find((l) => l.msg === 'no single directory entry for the badge')
    expect(why?.obj).toMatchObject({ reason: 'document-matches-no-entry', entries: 0 })
    const logged = JSON.stringify(none.lines)
    for (const value of ['1991-05-22', '1991-05-21', '19910521', 'ESP', 'RIOS', 'Ríos'])
      expect(logged).not.toContain(value)

    const twins = await setup(profile, {
      read: passport({
        lastName: 'WANG',
        firstName: 'LI',
        dateOfBirth: '1995-03-03',
        nationality: 'CHN',
        issuingState: 'CHN',
      }),
    })
    expect((await twins.service.issue(person, session, 'badge', 'model')).outcome).toBe('incomplete')
    expect(twins.lines.find((l) => l.msg === 'no single directory entry for the badge')?.obj).toMatchObject({
      reason: 'document-matches-several',
      entries: 2,
    })
  })
})

describe('with an email code (IDENT-DIR-004, INTX-ISSUE-020)', () => {
  const profile = fromDirectory([{ type: 'email' }])

  it('starts the check, and issues once the address is verified, numbered by the address', async () => {
    const { service, offers, evidence } = await setup(profile, { address: 'Ana.Rios@Northwind.example' })
    const first = await service.issue(person, session, 'badge', 'model')
    expect(first).toMatchObject({ outcome: 'challenge-started', ask: { text: 'Which address?', challengeId: 'chl_1' } })
    expect(offers).toEqual([])
    // the check passed: the issuance goes on, asking nothing again
    expect((await service.issue(person, session, 'badge', 'model')).outcome).toBe('issued')
    expect(offers[0]).toEqual({
      badgeNumber: emailId(key, 'badge', 'ana.rios@northwind.example'),
      name: 'Ana María Ríos',
      email: 'ana.rios@northwind.example',
      department: 'Depot Rotterdam',
      birthDate: '',
      phoneNumber: '',
    })
    const record = (await evidence.list(person.id)).find((r) => r.kind === 'issuance')
    expect(record?.directoryEntryId).toBe('p-0042')
  })

  it('reports the claims missing for an address that left the directory, and offers the check again', async () => {
    const { service } = await setup(profile, { address: 'gone@northwind.example' })
    await service.issue(person, session, 'badge', 'model')
    const [badge] = await service.requirements(person)
    expect(badge?.claims.find((c) => c.name === 'name')).toEqual({
      name: 'name',
      status: 'missing',
      action: { type: 'issue_credential', profile: 'badge', challenge: 'email', note: expect.any(String) },
    })
  })

  it('numbers an address the same for whoever proves it, two addresses apart, two profiles unlinked, the address unreadable', () => {
    const a = emailId(key, 'badge', 'ana.rios@northwind.example')
    expect(emailId(key, 'badge', ' ANA.RIOS@northwind.example ')).toBe(a)
    expect(emailId(key, 'badge', 'jonas@northwind.example')).not.toBe(a)
    expect(emailId(key, 'other', 'ana.rios@northwind.example')).not.toBe(a)
    expect(emailId(subjectIdKey(Buffer.alloc(32, 6)), 'badge', 'ana.rios@northwind.example')).not.toBe(a)
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/)
    expect(a.toLowerCase()).not.toContain('ana')
  })
})

describe('with both (IDENT-DIR-004)', () => {
  const profile = fromDirectory([{ type: 'document' }, { type: 'email' }])

  it('reads the passport first, then checks the address, and issues from the entry both find', async () => {
    const { service, offers, asked } = await setup(profile, { read: passport(), address: 'ana.rios@northwind.example' })
    expect((await service.issue(person, session, 'badge', 'model')).outcome).toBe('challenge-started')
    expect(asked).toEqual(['document'])
    expect((await service.issue(person, session, 'badge', 'model')).outcome).toBe('issued')
    // the passport is not read again
    expect(asked).toEqual(['document'])
    expect(offers[0]).toMatchObject({ name: 'Ana María Ríos', birthDate: '19910521' })
  })

  it('issues nothing when the passport and the address find two people', async () => {
    const { service, offers, lines } = await setup(profile, {
      read: passport(),
      address: 'jurgen.muller@northwind.example',
    })
    await service.issue(person, session, 'badge', 'model')
    const result = await service.issue(person, session, 'badge', 'model')
    expect(result.outcome).toBe('incomplete')
    expect(offers).toEqual([])
    expect(lines.some((l) => l.obj.reason === 'entries-differ')).toBe(true)
  })

  it('stops after a passport that matches nobody: no email is asked', async () => {
    const { service } = await setup(profile, {
      read: passport({ dateOfBirth: '2000-01-01' }),
      address: 'ana.rios@northwind.example',
    })
    expect((await service.issue(person, session, 'badge', 'model')).outcome).toBe('incomplete')
  })
})

describe('as: dateint (IDENT-DIR-005)', () => {
  it('writes a calendar date as the integer YYYYMMDD', () => {
    expect(dateInt('1991-05-21')).toBe('19910521')
    expect(dateInt('19910521')).toBe('19910521')
    expect(dateInt('21/05/1991')).toBeUndefined()
  })
})

describe('what the agent-pack may say of a badge from the directory (IDENT-DIR-002, INTX-AUTH-011/015)', () => {
  const env = { HOME_BACKING_IDENTITY: 'did:webvh:x:home' }
  /** the dev pack with a directory and a badge profile, changed by `edit` */
  function packWith(edit: (doc: Doc) => void): () => AgentPack {
    const doc = parseYaml(readFileSync('agent-packs/dev/agent-pack.yaml', 'utf8')) as Doc
    doc.identity.directory = { file: '/var/run/secrets/directory.yaml' }
    doc.identity.authentication = [
      {
        credential: { jsonSchemaCredentialId: BADGE },
        subjectKey: ['badgeNumber'],
        request: 'on-demand',
        visitors: true,
      },
    ]
    doc.evidence = { document, email: { store: { attributes: ['address'] } } }
    doc.issuance = {
      badge: { ...fromDirectory([{ type: 'email' }]), credential: { jsonSchemaCredentialId: BADGE } },
    }
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

  it('accepts [email], [document], [document, email], and a single challenge as before', () => {
    expect(packWith(() => undefined)()).toBeTruthy()
    expect(
      packWith((doc) => {
        doc.issuance.badge = { ...fromDirectory([{ type: 'document' }]), credential: { jsonSchemaCredentialId: BADGE } }
      })()
    ).toBeTruthy()
    expect(
      packWith((doc) => {
        doc.issuance.badge = {
          ...fromDirectory([{ type: 'document' }, { type: 'email' }]),
          credential: { jsonSchemaCredentialId: BADGE },
        }
      })()
    ).toBeTruthy()
    const single = packWith((doc) => {
      doc.issuance.pass = {
        credential: { credentialDefinitionId: 'def-pass' },
        authChallenge: { type: 'device' },
        claims: { validUntil: { from: 'computed', fn: 'addDays', days: 7 } },
      }
    })()
    // one challenge, as an object: the fallback is `fail` when it names none (INTX-AUTH-005)
    expect(single.issuance?.pass?.authChallenge).toEqual({ type: 'device' })
  })

  it('refuses another order, no challenge, or another challenge for a badge from the directory (IDENT-DIR-002)', () => {
    refused(
      packWith((doc) => {
        doc.issuance.badge.authChallenge = [{ type: 'email' }, { type: 'document' }]
      }),
      'IDENT-DIR-002: issuance.badge takes claims from the user directory'
    )
    refused(
      packWith((doc) => {
        Reflect.deleteProperty(doc.issuance.badge, 'authChallenge')
      }),
      'IDENT-DIR-002'
    )
    refused(
      packWith((doc) => {
        doc.issuance.badge.authChallenge = [{ type: 'device' }]
      }),
      'IDENT-DIR-002'
    )
    refused(
      packWith((doc) => {
        Reflect.deleteProperty(doc.identity, 'directory')
      }),
      'identity.directory names no file'
    )
  })

  it('refuses the email code anywhere else, in words (INTX-AUTH-011)', () => {
    refused(
      packWith((doc) => {
        doc.tools.sources.echo.tools = { echo: { stepUp: { authChallenge: { type: 'email' } } } }
      }),
      'tools.sources.echo.tools.echo.stepUp.authChallenge: the email code is the challenge of an issuance profile that takes claims from the user directory'
    )
    refused(
      packWith((doc) => {
        doc.issuance.pass = {
          credential: { credentialDefinitionId: 'def-pass' },
          authChallenge: [{ type: 'email' }],
          claims: { validUntil: { from: 'computed', fn: 'addDays', days: 7 } },
        }
      }),
      'INTX-AUTH-011: issuance.pass declares an email challenge and takes no claim from the user directory'
    )
  })

  it('needs the address stored, never shown to the model, and an email challenge for emailId (INTX-AUTH-015, INTX-ISSUE-020)', () => {
    refused(
      packWith((doc) => {
        Reflect.deleteProperty(doc.evidence, 'email')
      }),
      'evidence.email must store [address]'
    )
    refused(
      packWith((doc) => {
        doc.evidence.email = { store: { attributes: ['address'] }, modelVisible: ['address'] }
      }),
      'INTX-AUTH-015: evidence.email.modelVisible'
    )
    refused(
      packWith((doc) => {
        doc.issuance.badge.authChallenge = [{ type: 'document' }]
        doc.issuance.badge.claims.badgeNumber = { from: 'computed', fn: 'emailId' }
      }),
      'INTX-ISSUE-020: issuance.badge takes a claim from a verified address and declares no email challenge'
    )
    refused(
      packWith((doc) => {
        doc.issuance.badge.trigger = 'automatic'
      }),
      'INTX-AUTH-012: issuance.badge declares an email challenge and is automatic'
    )
  })

  it('needs what the matching of a passport reads stored (IDENT-DIR-003)', () => {
    refused(
      packWith((doc) => {
        doc.issuance.badge = { ...fromDirectory([{ type: 'document' }]), credential: { jsonSchemaCredentialId: BADGE } }
        doc.evidence.document = {
          store: { attributes: ['documentNumber', 'issuingState', 'lastName', 'firstName', 'dateOfBirth'] },
        }
      }),
      'IDENT-DIR-003: issuance.badge finds the entry of a passport: evidence.document must store [nationality]'
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
