/**
 * The badge offered only when the connection holds none, and issued again when the holder asks for it (ayni-spec D156;
 * IDENT-AUTH-016, IDENT-STAT-009, INTX-ISSUE-022/023, INTX-FLOW-006, FLOW-REISSUE-002). What a connection holds is what
 * the agent issued on it, whatever Principal the connection belongs to, still valid: not revoked and not past the last
 * day of validity its profile names. A phone that holds none asks with `reissue` and the reason `missing`: the agent
 * revokes the one it issued on that connection and issues a new one with the same number, to an identified person
 * only and for a profile whose claims come from who they are. The peer status tells the phone which credentials it may
 * ask for so. The issuance runs on the in-memory store; the directory is a file of the test.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import { PeerStatusNotifier } from '../src/channels/didcomm/peerStatus.js'
import { PackError, validatePackDocument } from '../src/config/pack.js'
import { type AgentPack, type IssuanceProfile, issuedAgainOnRequest } from '../src/config/packTypes.js'
import { UserDirectory } from '../src/core/directory.js'
import { DirectoryClaims } from '../src/core/directoryClaims.js'
import { EvidenceService } from '../src/core/evidence.js'
import {
  type IssuanceDeps,
  IssuanceService,
  issuableAgain,
  issuanceEntry,
  stillValid,
  subjectIdKey,
  validUntilOf,
} from '../src/core/issuance.js'
import { PeopleService } from '../src/core/people.js'
import type { EvidenceRecord, Principal, Session } from '../src/core/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'
import { createLogger } from '../src/util/logger.js'
import { badgeAuthentication } from './helpers.js'

// biome-ignore lint/suspicious/noExplicitAny: a YAML document the tests edit freely
type Doc = Record<string, any>

const crypto = createEntryCrypto(Buffer.alloc(32, 7))
const key = subjectIdKey(Buffer.alloc(32, 7))
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'
const PASS = 'https://ecs.example/vt/schemas-pass-jsc.json'
const root = mkdtempSync(join(tmpdir(), 'ayni-badge-missing-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const silent = createLogger('silent')

const badgeProfile = (over: Partial<IssuanceProfile> = {}): IssuanceProfile => ({
  credential: { jsonSchemaCredentialId: BADGE },
  label: 'Northwind badge',
  trigger: 'automatic',
  claims: {
    badgeNumber: { from: 'computed', fn: 'subjectId' },
    name: { from: 'record', record: 'directory', field: 'name' },
    department: { from: 'record', record: 'directory', field: 'department' },
    birthDate: { from: 'evidence', entry: 'document', attribute: 'dateOfBirth', as: 'dateint' },
  },
  ...over,
})

/** a pass whose claims come from a credential the person presents on demand: not issued again on request */
const passProfile: IssuanceProfile = {
  credential: { jsonSchemaCredentialId: PASS },
  label: 'Driver pass',
  trigger: 'model',
  claims: {
    name: { from: 'evidence', entry: 'authentication', attribute: 'name' },
    categories: { from: 'evidence', entry: 'driving_licence', attribute: 'categories' },
  },
}

const identified = (entry = 'p-0042', connection = 'conn-1', id = `prn-${entry}`): Principal =>
  ({
    id,
    connectionType: 'verifiable-user-agent',
    capabilityChannelId: connection,
    identityCredentialRef: `entry:${entry}`,
    directoryEntryId: entry,
    roles: [],
  }) as unknown as Principal
const visitor = (connection = 'conn-9'): Principal =>
  ({
    id: 'prn-visitor',
    connectionType: 'verifiable-user-agent',
    capabilityChannelId: connection,
    identityCredentialRef: null,
    roles: [],
  }) as unknown as Principal
const session = { id: 'ses_dc', channelType: 'didcomm', state: 'bound' } as Session

async function setup(profiles: Record<string, IssuanceProfile>, options: { revokes?: boolean } = {}) {
  const file = join(root, `directory-${Math.random().toString(36).slice(2)}.yaml`)
  writeFileSync(
    file,
    stringifyYaml({
      people: [
        {
          id: 'p-0042',
          firstName: 'Ana',
          lastName: 'Ríos',
          email: 'ana@northwind.example',
          birthDate: '19910521',
          nationality: 'ESP',
          department: 'Depot',
        },
      ],
    })
  )
  const store = new MemoryStore()
  const directory = new UserDirectory(
    file,
    { roles: [], passport: true },
    store.kv,
    store.adminAudit,
    crypto,
    silent as never
  )
  directory.open()
  const pack = {
    identity: { roleRules: [] },
    evidence: { document: { store: { attributes: ['dateOfBirth', 'nationality', 'portrait'] } } },
    issuance: profiles,
  } as unknown as AgentPack
  const evidence = new EvidenceService(store, pack, crypto, silent as never)
  const claims = new DirectoryClaims(directory, evidence, silent as never)
  const offers: { connectionId: string; claims: Record<string, string>; description?: string; origin?: Session }[] = []
  const revoked: string[] = []
  let index = 0
  const deps: IssuanceDeps = {
    offer: async (input) => {
      offers.push({
        connectionId: input.connectionId,
        claims: input.claims,
        description: input.description,
        origin: input.origin,
      })
      return { outcome: 'issued', exchangeId: `cex-${offers.length}` }
    },
    challenge: async () => ({ passed: true }),
    record: (principal, name, p, source) => claims.resolve(principal, name, p, source),
    entryDocument: (principal, p) => claims.entryDocument(principal, p),
    definitionFor: async () => 'def-badge',
    allocateRevocation: async () => ({ registryDefinitionId: 'revreg-1', index: index++ }),
    holderOf: async () => 'holder-ana',
    revoke: async (record) => {
      if (options.revokes === false) return false
      revoked.push(record.id)
      await evidence.setRevocation(record.id, {
        ...(record.revocation as NonNullable<EvidenceRecord['revocation']>),
        revokedAt: new Date().toISOString(),
        reason: 'issued-again',
      })
      return true
    },
  }
  const service = new IssuanceService(pack, evidence, deps, silent as never, key)
  const issuedOn = async (connection: string, profile = 'badge') =>
    evidence.issuedOn(connection, issuanceEntry(profile))
  return { pack, store, service, evidence, offers, revoked, issuedOn }
}

describe('offered only when the connection holds none (IDENT-AUTH-016)', () => {
  it('offers nothing on a connection that holds one, even after the person received another on a new phone', async () => {
    const { service, offers } = await setup({ badge: badgeProfile() })
    await service.automatic(identified(), session)
    // a new phone of the same person: its own badge
    await service.automatic(identified('p-0042', 'conn-2'), session)
    expect(offers.map((o) => o.connectionId)).toEqual(['conn-1', 'conn-2'])
    // back on the first phone, the person signs in again by email: that wallet still holds its badge
    await service.automatic(identified(), session)
    await service.automatic(identified(), session)
    expect(offers.map((o) => o.connectionId)).toEqual(['conn-1', 'conn-2'])
    expect((await service.requirements(identified()))[0]?.state).toBe('held')
  })

  it('reads what the connection holds whatever Principal it belongs to now', async () => {
    const { service, offers } = await setup({ badge: badgeProfile() })
    await service.automatic(identified('p-0042', 'conn-1', 'prn-a'), session)
    // the same wallet, now the connection of another Principal of the same entry: it holds the badge
    await service.automatic(identified('p-0042', 'conn-1', 'prn-b'), session)
    expect(offers).toHaveLength(1)
  })

  it('offers it again once the one of the connection is revoked', async () => {
    const { service, offers, evidence, issuedOn } = await setup({ badge: badgeProfile() })
    await service.automatic(identified(), session)
    const [record] = await issuedOn('conn-1')
    await evidence.setRevocation(record?.id as string, {
      registryDefinitionId: 'revreg-1',
      index: 0,
      revokedAt: new Date().toISOString(),
    })
    await service.automatic(identified(), session)
    expect(offers).toHaveLength(2)
  })

  it('offers it again once the one of the connection is past its last day of validity (INTX-ISSUE-023)', async () => {
    const expired = badgeProfile({
      validUntilClaim: 'validUntil',
      claims: { ...badgeProfile().claims, validUntil: { from: 'computed', fn: 'addDays', days: -1 } },
    })
    const { service, offers, issuedOn } = await setup({ badge: expired })
    await service.automatic(identified(), session)
    const [record] = await issuedOn('conn-1')
    expect(record?.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(stillValid(record as EvidenceRecord)).toBe(false)
    await service.automatic(identified(), session)
    expect(offers).toHaveLength(2)
    // one valid a year on is held
    const valid = badgeProfile({
      validUntilClaim: 'validUntil',
      claims: { ...badgeProfile().claims, validUntil: { from: 'computed', fn: 'addDays', days: 365 } },
    })
    const second = await setup({ badge: valid })
    await second.service.automatic(identified(), session)
    await second.service.automatic(identified(), session)
    expect(second.offers).toHaveLength(1)
  })

  it('reads the last day of validity from a date, a dateint or a time', () => {
    expect(validUntilOf('2027-05-21')).toBe('2027-05-21')
    expect(validUntilOf('20270521')).toBe('2027-05-21')
    expect(validUntilOf('2027-05-21T23:00:00.000Z')).toBe('2027-05-21')
    expect(validUntilOf('next year')).toBeUndefined()
    expect(stillValid({ validUntil: '2027-05-21' }, '2027-05-21T12:00:00.000Z')).toBe(true)
    expect(stillValid({ validUntil: '2027-05-21' }, '2027-05-22T00:00:00.000Z')).toBe(false)
  })
})

describe('issued again when the holder holds none (INTX-ISSUE-022)', () => {
  it('revokes the one of the connection and issues a new one with the same number, its flow saying why', async () => {
    const { service, offers, revoked, issuedOn } = await setup({ badge: badgeProfile() })
    await service.automatic(identified(), session)
    const [first] = await issuedOn('conn-1')
    const result = await service.issueAgain(identified(), session, BADGE, { description: 'Issued again.' })
    expect(result).toMatchObject({ outcome: 'issued', profile: 'badge' })
    expect(revoked).toEqual([first?.id])
    expect(offers).toHaveLength(2)
    expect(offers[1]?.claims.badgeNumber).toBe(offers[0]?.claims.badgeNumber)
    expect(offers[1]).toMatchObject({ connectionId: 'conn-1', description: 'Issued again.', origin: undefined })
    // one valid credential on the connection, never two
    const records = await issuedOn('conn-1')
    expect(records.map((r) => stillValid(r))).toEqual([false, true])
    expect(records[0]?.revocation?.reason).toBe('issued-again')
    // and the automatic trigger does not offer a third
    await service.automatic(identified(), session)
    expect(offers).toHaveLength(2)
  })

  it('issues one on a connection that holds none, revoking nothing; any trigger', async () => {
    const { service, offers, revoked } = await setup({ badge: badgeProfile({ trigger: 'request' }) })
    expect((await service.issueAgain(identified('p-0042', 'conn-5'), session, BADGE)).outcome).toBe('issued')
    expect(revoked).toEqual([])
    expect(offers.map((o) => o.connectionId)).toEqual(['conn-5'])
  })

  it('refuses a visitor, a schema it does not issue and a profile not issued again on request', async () => {
    const { service, offers } = await setup({ badge: badgeProfile(), pass: passProfile })
    expect(await service.issueAgain(visitor(), session, BADGE)).toMatchObject({
      outcome: 'not-eligible',
      reason: 'not-identified',
    })
    expect((await service.issueAgain(identified(), session, 'https://other.example/schema.json')).outcome).toBe(
      'unknown-reference'
    )
    expect(await service.issueAgain(identified(), session, PASS)).toMatchObject({
      outcome: 'not-eligible',
      reason: 'not-issued-again',
    })
    expect(offers).toEqual([])
  })

  it('refuses a person whose claims do not resolve, revoking nothing', async () => {
    const { service, offers, revoked } = await setup({ badge: badgeProfile() })
    await service.automatic(identified(), session)
    // an identified person who is no longer on the list
    const gone = { ...identified(), directoryEntryId: undefined, identityCredentialRef: 'badge:pex-1' } as Principal
    expect((await service.issueAgain(gone, session, BADGE)).outcome).toBe('not-eligible')
    expect(revoked).toEqual([])
    expect(offers).toHaveLength(1)
  })

  it('issues nothing when the one of the connection cannot be revoked', async () => {
    const { service, offers, issuedOn } = await setup({ badge: badgeProfile() }, { revokes: false })
    await service.automatic(identified(), session)
    expect(await service.issueAgain(identified(), session, BADGE)).toMatchObject({
      outcome: 'unavailable',
      reason: 'not-revoked',
    })
    expect(offers).toHaveLength(1)
    expect((await issuedOn('conn-1')).every((r) => stillValid(r))).toBe(true)
  })

  it('is not started by the model or the menu as such: the trigger holder is the reissue only', async () => {
    const { service } = await setup({ badge: badgeProfile() })
    expect((await service.issue(identified(), session, 'badge', 'holder')).outcome).toBe('not-offered')
  })
})

describe('what the phone is told it may ask for again (IDENT-STAT-009)', () => {
  it('lists, to an identified person, the profiles issued again on request, by schema, with their label', async () => {
    const { pack } = await setup({
      badge: badgeProfile(),
      pass: passProfile,
      byDefinition: { ...badgeProfile(), credential: { credentialDefinitionId: 'def-x' } },
      staff: { ...badgeProfile(), roles: ['staff'] },
    })
    expect(issuedAgainOnRequest(badgeProfile())).toBe(true)
    expect(issuedAgainOnRequest(passProfile)).toBe(false)
    expect(issuableAgain(pack, identified())).toEqual([{ jsonSchemaCredentialId: BADGE, label: 'Northwind badge' }])
    expect(issuableAgain(pack, visitor())).toEqual([])
    const notifier = new PeerStatusNotifier(
      pack,
      { sendPeerStatus: async () => ({ id: 's' }), supportsPeerStatus: async () => true } as never,
      { get: async () => undefined } as never,
      silent as never
    )
    expect((await notifier.statusOf(identified())).issuable).toEqual([
      { jsonSchemaCredentialId: BADGE, label: 'Northwind badge' },
    ])
    expect(await notifier.statusOf(visitor())).not.toHaveProperty('issuable')
  })
})

describe('the reissue request with the reason missing (FLOW-REISSUE-002, INTX-FLOW-006)', () => {
  async function eventsWith(issueAgain: IssuanceService['issueAgain'] | undefined, bound = true) {
    const calls: { method: string; args: unknown[] }[] = []
    const rec =
      (method: string) =>
      async (...args: unknown[]) => {
        calls.push({ method, args })
        return {}
      }
    const client = {
      closeFlow: rec('closeFlow'),
      flowProblemReport: rec('flowProblemReport'),
      markReissueAnswered: rec('markReissueAnswered'),
    }
    const agent = {
      didcommSession: async () => (bound ? { principal: identified(), session } : undefined),
      issuance: issueAgain ? { issueAgain } : undefined,
      flows: {
        problemReport: async (flowId: string, code: string, description?: string) =>
          client.flowProblemReport(flowId, { code, description }),
      },
    }
    const events = new DidcommEvents(
      agent as never,
      client as never,
      {} as never,
      {} as never,
      new PeerProfiles(new MemoryStore().kv, silent),
      undefined,
      silent,
      100
    )
    const send = (reference: Record<string, unknown>, reason = 'missing') =>
      events.handle({
        id: 'evt',
        type: 'didcomm.reissue.state-changed',
        timestamp: new Date().toISOString(),
        data: {
          threadId: 'reissue-1',
          flowId: 'holder-flow-1',
          connectionId: 'conn-1',
          state: 'request-received',
          request: { reference, reason },
        },
      })
    return { calls, send }
  }

  it('answers with the issuance and closes the holder flow completed', async () => {
    const asked: unknown[] = []
    const { calls, send } = await eventsWith(async (_p, _s, schema, options) => {
      asked.push([schema, options])
      return { outcome: 'issued', profile: 'badge' }
    })
    await send({ jsonSchemaCredentialId: BADGE })
    expect(asked).toEqual([[BADGE, { description: 'Issued again, as you asked from your phone.' }]])
    expect(calls.map((c) => c.method)).toEqual(['closeFlow', 'markReissueAnswered'])
    expect(calls[0]?.args).toEqual(['holder-flow-1', { outcome: 'completed' }])
  })

  it('closes it failed with why when the person declines the offer', async () => {
    const { calls, send } = await eventsWith(async () => ({ outcome: 'declined', profile: 'badge' }))
    await send({ jsonSchemaCredentialId: BADGE })
    expect(calls[0]?.args).toEqual([
      'holder-flow-1',
      { outcome: 'failed', reason: 'You declined the offer. Nothing was issued.' },
    ])
  })

  it.each([
    ['unknown-reference', 'unknown-reference'],
    ['not-eligible', 'not-eligible'],
    ['incomplete', 'not-eligible'],
    ['unavailable', 'unavailable'],
    ['not-ready', 'unavailable'],
  ] as const)('answers %s with the problem report %s', async (outcome, code) => {
    const { calls, send } = await eventsWith(async () => ({ outcome }))
    await send({ jsonSchemaCredentialId: BADGE })
    expect(calls.map((c) => c.method)).toEqual(['flowProblemReport', 'markReissueAnswered'])
    expect(calls[0]?.args[0]).toBe('holder-flow-1')
    expect((calls[0]?.args[1] as { code: string } | undefined)?.code).toBe(code)
  })

  it('refuses a request that names no schema, and a connection with no identified session', async () => {
    const none = await eventsWith(async () => ({ outcome: 'issued' }))
    await none.send({})
    expect((none.calls[0]?.args[1] as { code: string } | undefined)?.code).toBe('unknown-reference')
    const unbound = await eventsWith(async () => ({ outcome: 'issued' }), false)
    await unbound.send({ jsonSchemaCredentialId: BADGE })
    expect((unbound.calls[0]?.args[1] as { code: string } | undefined)?.code).toBe('not-eligible')
  })

  it('still answers a restore with unknown-reference', async () => {
    const asked: unknown[] = []
    const { calls, send } = await eventsWith(async () => {
      asked.push(1)
      return { outcome: 'issued' }
    })
    await send({ credentialId: 'c', schemaId: 's', credDefId: 'd', issuedAt: '2026-03-02T10:00:00Z' }, 'restore')
    expect(asked).toEqual([])
    expect((calls[0]?.args[1] as { code: string } | undefined)?.code).toBe('unknown-reference')
  })
})

describe('the pack key validUntilClaim (INTX-ISSUE-023)', () => {
  const env = { HOME_BACKING_IDENTITY: 'did:webvh:x:home' }
  function packWith(edit: (doc: Doc) => void): () => AgentPack {
    const doc = parseYaml(readFileSync('agent-packs/dev/agent-pack.yaml', 'utf8')) as Doc
    doc.identity.directory = { file: '/var/run/secrets/directory.yaml' }
    doc.identity.authentication = badgeAuthentication({
      credential: { jsonSchemaCredentialId: BADGE },
      subjectKey: ['badgeNumber'],
      request: 'on-demand',
      visitors: true,
    })
    doc.evidence = {
      document: {
        store: {
          attributes: [
            'documentNumber',
            'issuingState',
            'nationality',
            'lastName',
            'firstName',
            'dateOfBirth',
            'portrait',
          ],
        },
      },
    }
    doc.issuance = {
      badge: {
        ...badgeProfile(),
        validUntilClaim: 'validUntil',
        claims: { ...badgeProfile().claims, validUntil: { from: 'computed', fn: 'addDays', days: 365 } },
      },
    }
    edit(doc)
    return () => validatePackDocument(doc, env)
  }

  it('accepts a claim of the profile and refuses any other', () => {
    expect(packWith(() => undefined)().issuance?.badge?.validUntilClaim).toBe('validUntil')
    let error: unknown
    try {
      packWith((doc) => {
        doc.issuance.badge.validUntilClaim = 'expiry'
      })()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(PackError)
    expect((error as Error).message).toContain(
      'INTX-ISSUE-023: issuance.badge.validUntilClaim names expiry, which is no claim of the profile'
    )
  })
})

describe('the revocation before a credential is issued again (INTX-ISSUE-022, INTX-FLOW-007)', () => {
  async function revocationOf(
    port: { revoke(): Promise<string>; notify(...args: unknown[]): Promise<void> } | undefined
  ) {
    const { store, evidence, service } = await setup({ badge: badgeProfile() })
    await service.automatic(identified(), session)
    const [record] = await evidence.issuedOn('conn-1', issuanceEntry('badge'))
    const people = new PeopleService({
      pack: {} as AgentPack,
      store,
      principals: {} as never,
      evidence,
      spaces: {} as never,
      revocations: port as never,
      homeKey: async () => undefined,
      endAccess: async () => undefined,
      logger: silent,
    })
    return { store, evidence, record: record as EvidenceRecord, people }
  }

  it('revokes now, records it in the admin audit and on the record, and tells the holder once on its connection', async () => {
    const told: unknown[] = []
    const { store, evidence, record, people } = await revocationOf({
      revoke: async () => '2026-11-25T10:00:00.000Z',
      notify: async (...args) => void told.push(args),
    })
    expect(await people.revokeForReissue(record)).toBe(true)
    expect(told).toEqual([
      ['conn-1', { registryDefinitionId: 'revreg-1', index: 0 }, 'Replaced by the one you asked for again.'],
    ])
    const [after] = await evidence.issuedOn('conn-1', issuanceEntry('badge'))
    expect(after?.revocation).toMatchObject({
      revokedAt: '2026-11-25T10:00:00.000Z',
      reason: 'issued-again',
      notifyAttempts: 1,
    })
    expect(after?.revocation?.notifiedAt).toBeDefined()
    const [audit] = await store.adminAudit.list(5, { action: 'credential-revocation' })
    expect(audit).toMatchObject({
      reason: 'issued-again',
      actor: record.principalId,
      detail: { evidenceId: record.id },
    })
  })

  it('answers false, changing nothing, when it cannot revoke', async () => {
    const failing = await revocationOf({
      revoke: async () => {
        throw new Error('503')
      },
      notify: async () => undefined,
    })
    expect(await failing.people.revokeForReissue(failing.record)).toBe(false)
    expect(stillValid((await failing.evidence.issuedOn('conn-1', issuanceEntry('badge')))[0] as EvidenceRecord)).toBe(
      true
    )
    const none = await revocationOf(undefined)
    expect(await none.people.revokeForReissue(none.record)).toBe(false)
  })
})
