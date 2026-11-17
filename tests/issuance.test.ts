/**
 * Credential issuance (D68, D70; INTX-ISSUE-001..017, RBAC-FILTER-003): every claim comes from a source the
 * profile names, the model names a credential and nothing else, and the requirements never show a value.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { CredentialDefinitions } from '../src/channels/didcomm/credentialDefinitions.js'
import { CredentialOffers } from '../src/channels/didcomm/credentialOffers.js'
import { VsAgentError } from '../src/channels/didcomm/vsAgentClient.js'
import { crossFieldErrors, loadPack, validatePackDocument } from '../src/config/pack.js'
import type { AgentPack, IssuanceProfile, PresentationEntry } from '../src/config/packTypes.js'
import { type EvidenceInput, EvidenceService } from '../src/core/evidence.js'
import { contextualMenuFor } from '../src/core/interaction.js'
import {
  documentId,
  type IssuanceDeps,
  IssuanceService,
  issuanceEntry,
  issuanceOutcomeForModel,
  subjectId,
  subjectIdKey,
} from '../src/core/issuance.js'
import type { Principal, Session } from '../src/core/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'
import { startTestAgent } from './helpers.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
const crypto = createEntryCrypto(Buffer.alloc(32, 9))
const DIPLOMA = 'https://edu.example/vt/schemas-diploma-jsc.json'

const diploma: PresentationEntry = {
  credential: { jsonSchemaCredentialId: DIPLOMA },
  request: 'on-demand',
  purpose: 'Check your degree',
  attributes: ['degree', 'institution', 'graduationDate'],
  store: { attributes: ['degree', 'institution'] },
}
const alumni: IssuanceProfile = {
  credential: { credentialDefinitionId: 'did:webvh:issuer/resources/alumni' },
  label: 'Alumni card',
  claims: {
    degree: { from: 'evidence', entry: 'diploma', attribute: 'degree' },
    institution: { from: 'evidence', entry: 'diploma', attribute: 'institution' },
    issuedOn: { from: 'computed', fn: 'today' },
    member: { from: 'computed', fn: 'constant', value: 'yes' },
  },
}
const pass: IssuanceProfile = {
  credential: { credentialDefinitionId: 'did:webvh:issuer/resources/pass' },
  label: 'Visitor pass',
  trigger: 'request',
  claims: { validUntil: { from: 'computed', fn: 'addDays', days: 7 } },
}
const packWith = (issuance: Record<string, IssuanceProfile>, extra: Partial<AgentPack> = {}): AgentPack =>
  ({ identity: { roleRules: [] }, presentations: { diploma }, issuance, ...extra }) as unknown as AgentPack

const person = (over: Partial<Principal> = {}) =>
  ({
    id: 'prn_1',
    connectionType: 'verifiable-user-agent',
    capabilityChannelId: 'conn-1',
    identityCredentialRef: null,
    roles: [],
    ...over,
  }) as Principal
const session = { id: 'ses_1' } as Session
const presented = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  kind: 'presentation',
  entry: 'diploma',
  schema: DIPLOMA,
  issuerDid: 'did:webvh:uni',
  values: { degree: 'MSc', institution: 'A University', graduationDate: '2020-06-30' },
  requestRef: 'pex-1',
  ...over,
})

function setup(
  issuance: Record<string, IssuanceProfile>,
  deps: Partial<IssuanceDeps> = {},
  extra: Partial<AgentPack> = {}
) {
  const pack = packWith(issuance, extra)
  const store = new MemoryStore()
  const evidence = new EvidenceService(store, pack, crypto, silent as never)
  const offers: { connectionId: string; credentialDefinitionId: string; claims: Record<string, string> }[] = []
  const service = new IssuanceService(
    pack,
    evidence,
    {
      offer: async (input) => {
        offers.push(input)
        return { outcome: 'issued', exchangeId: `cex-${offers.length}` }
      },
      challenge: async () => ({ passed: true }),
      ...deps,
    },
    silent as never,
    subjectIdKey(Buffer.alloc(32, 9))
  )
  return { pack, store, evidence, service, offers }
}

describe('what is missing, and how to get it (INTX-ISSUE-005/006/007)', () => {
  it('tells the state of each credential and of each claim, with an action and never a value', async () => {
    const { service, evidence } = setup({ alumni })
    const [before] = await service.requirements(person())
    expect(before).toEqual({
      credential: 'alumni',
      label: 'Alumni card',
      state: 'incomplete',
      trigger: 'model',
      claims: [
        { name: 'degree', status: 'missing', action: { type: 'request_presentation', entry: 'diploma' } },
        { name: 'institution', status: 'missing', action: { type: 'request_presentation', entry: 'diploma' } },
        { name: 'issuedOn', status: 'available' },
        { name: 'member', status: 'available' },
      ],
    })
    await evidence.record(person(), presented())
    const [after] = await service.requirements(person())
    expect(after.state).toBe('ready')
    expect(JSON.stringify(after)).not.toMatch(/MSc|University|2020|yes/)
  })

  it('tells an attribute left unrevealed and evidence that is too old', async () => {
    const { service, evidence, store } = setup({ alumni: { ...alumni, evidenceMaxAgeMinutes: 15 } })
    await evidence.record(person(), presented({ values: { institution: 'A University' }, unrevealed: ['degree'] }))
    const [hidden] = await service.requirements(person())
    expect(hidden.claims[0]).toMatchObject({ name: 'degree', status: 'not-revealed' })
    expect(hidden.claims[1]).toMatchObject({ name: 'institution', status: 'available' })
    const [record] = await store.evidence.list('prn_1')
    await store.evidence.save({ ...record, verifiedAt: new Date(Date.now() - 20 * 60_000).toISOString() })
    const [old] = await service.requirements(person())
    expect(old.claims[1]).toMatchObject({ name: 'institution', status: 'expired' })
    expect(old.state).toBe('incomplete')
  })

  it('offers a credential to the persons whose role the profile names, and to no service', async () => {
    const { service } = setup({ alumni: { ...alumni, roles: ['member'] }, pass })
    expect((await service.requirements(person())).map((r) => r.credential)).toEqual(['pass'])
    expect((await service.requirements(person({ roles: ['member'] }))).map((r) => r.credential)).toEqual([
      'alumni',
      'pass',
    ])
    expect(await service.requirements(person({ connectionType: 'verifiable-service' }))).toEqual([])
  })
})

describe('issuing (INTX-ISSUE-003/004/008..014)', () => {
  it('fills every claim from its source, delivers to the connection of the Principal and leaves a record', async () => {
    const { service, evidence, offers, store } = setup({ alumni })
    const proof = await evidence.record(person(), presented())
    const result = await service.issue(person(), session, 'alumni', 'model')
    expect(result.outcome).toBe('issued')
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({
      connectionId: 'conn-1',
      credentialDefinitionId: 'did:webvh:issuer/resources/alumni',
      claims: { degree: 'MSc', institution: 'A University', member: 'yes' },
    })
    expect(offers[0].claims.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // the record names the evidence the claims came from and holds no value
    const record = await evidence.latest('prn_1', issuanceEntry('alumni'))
    expect(record).toMatchObject({ kind: 'issuance', evidenceRefs: [proof.id], requestRef: 'cex-1', stored: [] })
    expect(JSON.stringify(await store.evidence.get(record?.id as string))).not.toMatch(/MSc|University/)
    // what was issued is not something the person presented
    expect((await evidence.forModel('prn_1')).map((r) => r.entry)).toEqual(['diploma'])
    // issued once: the second call issues nothing
    expect((await service.requirements(person()))[0].state).toBe('held')
    expect((await service.issue(person(), session, 'alumni', 'model')).outcome).toBe('held')
    expect(offers).toHaveLength(1)
  })

  it('issues nothing when a claim cannot be resolved, and says what is missing', async () => {
    const { service, offers } = setup({ alumni })
    const result = await service.issue(person(), session, 'alumni', 'model')
    expect(result.outcome).toBe('incomplete')
    expect(result.requirements?.claims.filter((c) => c.status === 'missing').map((c) => c.name)).toEqual([
      'degree',
      'institution',
    ])
    expect(offers).toHaveLength(0)
  })

  it('is started by the one the profile names: the model, the person, or the agent', async () => {
    const auto: IssuanceProfile = { ...alumni, trigger: 'automatic' }
    const { service, evidence, offers } = setup({ alumni, pass, auto })
    await evidence.record(person(), presented())
    expect((await service.issue(person(), session, 'pass', 'model')).outcome).toBe('not-offered')
    expect((await service.issue(person(), session, 'auto', 'model')).outcome).toBe('not-offered')
    expect((await service.issue(person(), session, 'alumni', 'person')).outcome).toBe('not-offered')
    expect((await service.issue(person(), session, 'unknown', 'model')).outcome).toBe('not-offered')
    expect(offers).toHaveLength(0)
    expect((await service.issue(person(), session, 'pass', 'person')).outcome).toBe('issued')
    // the agent issues by itself what is complete, and only that
    await service.automatic(person(), session)
    expect(offers.map((o) => o.credentialDefinitionId)).toEqual([
      'did:webvh:issuer/resources/pass',
      'did:webvh:issuer/resources/alumni',
    ])
    expect((await service.requirements(person())).map((r) => `${r.credential}:${r.state}`)).toEqual([
      'alumni:ready',
      'pass:held',
      'auto:held',
    ])
  })

  it('enforces the challenge of the profile, and issues nothing when the offer is not accepted', async () => {
    const challenged = setup(
      { alumni: { ...alumni, authChallenge: { type: 'device' } } },
      { challenge: async () => ({ passed: false }) }
    )
    await challenged.evidence.record(person(), presented())
    expect((await challenged.service.issue(person(), session, 'alumni', 'model')).outcome).toBe('challenge-failed')
    expect(challenged.offers).toHaveLength(0)
    const declined = setup({ alumni }, { offer: async () => ({ outcome: 'declined', exchangeId: 'cex-9' }) })
    await declined.evidence.record(person(), presented())
    expect((await declined.service.issue(person(), session, 'alumni', 'model')).outcome).toBe('declined')
    expect((await declined.service.requirements(person()))[0].state).toBe('ready')
    expect(
      (await declined.service.issue(person({ capabilityChannelId: null }), session, 'alumni', 'model')).outcome
    ).toBe('unavailable')
  })

  it('keeps the issued claims, sealed, only when the profile says so', async () => {
    const { service, evidence, store } = setup({
      alumni: { ...alumni, record: { storeClaims: true, retention: { days: 30 } } },
    })
    await evidence.record(person(), presented())
    await service.issue(person(), session, 'alumni', 'model')
    const record = await evidence.latest('prn_1', issuanceEntry('alumni'))
    expect(record?.stored.sort()).toEqual(['degree', 'institution', 'issuedOn', 'member'])
    const stored = await store.evidence.get(record?.id as string)
    const { cipher, ...audit } = stored as NonNullable<typeof stored>
    expect(cipher).not.toBeNull()
    expect(JSON.stringify(audit)).not.toMatch(/MSc|University/)
    expect((await evidence.audit(record?.id as string))?.values.degree).toBe('MSc')
  })
})

describe('the offer in the wallet (INTX-ISSUE-004)', () => {
  it('sends the claims on the connection and waits for the exchange', async () => {
    const sent: unknown[] = []
    const client = {
      offerCredential: async (body: unknown) => {
        sent.push(body)
        return { credentialExchangeId: `cex-${sent.length}` }
      },
    }
    const offers = new CredentialOffers(client as never, undefined, async () => false, silent as never, 200)
    const input = {
      connectionId: 'conn-1',
      credentialDefinitionId: 'def-1',
      claims: { degree: 'MSc' },
      title: 'Alumni card',
    }
    const accepted = offers.offer(input)
    await new Promise((resolve) => setTimeout(resolve, 0))
    offers.onExchange({ credentialExchangeId: 'cex-1', state: 'request-received' })
    offers.onExchange({ credentialExchangeId: 'cex-1', state: 'done' })
    expect(await accepted).toEqual({ outcome: 'issued', exchangeId: 'cex-1' })
    expect(sent[0]).toEqual({
      connectionId: 'conn-1',
      credentialDefinitionId: 'def-1',
      claims: [{ name: 'degree', value: 'MSc' }],
      autoAccept: true,
    })
    const refused = offers.offer(input)
    await new Promise((resolve) => setTimeout(resolve, 0))
    offers.onExchange({ credentialExchangeId: 'cex-2', state: 'declined' })
    expect((await refused).outcome).toBe('declined')
    // an offer nobody answers in time is told apart from one the person declined (INTX-ISSUE-018)
    expect((await offers.offer(input)).outcome).toBe('unanswered')
    const broken = new CredentialOffers(
      { offerCredential: async () => Promise.reject(new Error('down')) } as never,
      undefined,
      async () => false,
      silent as never
    )
    expect(await broken.offer(input)).toEqual({ outcome: 'failed' })
  })

  it('tells apart the person who declines, the offer nobody answers and the wallet that refuses it (INTX-ISSUE-018)', async () => {
    const client = { offerCredential: async () => ({ credentialExchangeId: 'cex-flow' }) }
    const input = { connectionId: 'conn-2', credentialDefinitionId: 'def-1', claims: {}, title: 'Badge' }
    // the wallet closes the flow of the offer: how it closed is what the agent learns
    const endedBy = async (closed: Record<string, unknown>) => {
      const flows = {
        open: async () => ({ flowId: 'flow-1', connectionId: 'conn-2', kind: 'issue' }),
        waitForClose: async () => ({ flowId: 'flow-1', state: closed.outcome, ...closed }),
        close: async () => undefined,
      }
      return new CredentialOffers(client as never, flows as never, async () => true, silent as never, 5_000).offer(
        input
      )
    }
    expect(await endedBy({ outcome: 'declined', closedBy: 'peer' })).toEqual({
      outcome: 'declined',
      exchangeId: 'cex-flow',
    })
    expect(await endedBy({ outcome: 'expired', closedBy: 'expiry' })).toEqual({
      outcome: 'unanswered',
      exchangeId: 'cex-flow',
    })
    expect(await endedBy({ outcome: 'failed', closedBy: 'peer', errorCode: 'untrusted-issuer' })).toEqual({
      outcome: 'refused',
      reason: 'untrusted-issuer',
      exchangeId: 'cex-flow',
    })
    // and the model is told which it was, so that it can tell the person
    expect(issuanceOutcomeForModel('declined')).toMatch(/the person declined/)
    expect(issuanceOutcomeForModel('unanswered')).toMatch(/did not answer/)
    expect(issuanceOutcomeForModel('refused', undefined, 'untrusted-issuer')).toMatch(
      /wallet of the person refused the offer by itself.*untrusted-issuer/
    )
  })
})

describe('an identifier of the subject (INTX-ISSUE-015/016)', () => {
  const badge: IssuanceProfile = {
    credential: { credentialDefinitionId: 'did:webvh:issuer/resources/badge' },
    label: 'Badge',
    claims: {
      badgeNumber: { from: 'computed', fn: 'subjectId' },
      name: { from: 'computed', fn: 'constant', value: 'Tester' },
    },
  }
  const card: IssuanceProfile = {
    credential: { credentialDefinitionId: 'did:webvh:issuer/resources/card' },
    label: 'Card',
    claims: { number: { from: 'computed', fn: 'subjectId' } },
  }
  const other = () => person({ id: 'prn_2', capabilityChannelId: 'conn-2' })

  it('gives two persons different numbers, and nothing of the Principal can be read from them', async () => {
    const { service, offers } = setup({ badge })
    expect((await service.requirements(person()))[0]).toMatchObject({
      state: 'ready',
      claims: [
        { name: 'badgeNumber', status: 'available' },
        { name: 'name', status: 'available' },
      ],
    })
    expect((await service.issue(person(), session, 'badge', 'model')).outcome).toBe('issued')
    expect((await service.issue(other(), session, 'badge', 'model')).outcome).toBe('issued')
    const [first, second] = offers.map((offer) => offer.claims.badgeNumber)
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/)
    expect(second).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/)
    expect(second).not.toBe(first)
    expect(first.toLowerCase()).not.toContain('prn')
    expect(offers.map((offer) => offer.connectionId)).toEqual(['conn-1', 'conn-2'])
  })

  it('keeps the number of a person: the same value at every issuance, in another process too', async () => {
    const one = setup({ badge })
    const again = setup({ badge })
    await one.service.issue(person(), session, 'badge', 'model')
    await again.service.issue(person(), session, 'badge', 'model')
    expect(again.offers[0].claims.badgeNumber).toBe(one.offers[0].claims.badgeNumber)
    const key = subjectIdKey(Buffer.alloc(32, 9))
    expect(subjectId(key, 'badge', 'prn_1')).toBe(one.offers[0].claims.badgeNumber)
  })

  it('gives one person unrelated numbers under two profiles, and other numbers with another secret', async () => {
    const { service, offers } = setup({ badge, card })
    await service.issue(person(), session, 'badge', 'model')
    await service.issue(person(), session, 'card', 'model')
    expect(offers[1].claims.number).not.toBe(offers[0].claims.badgeNumber)
    const elsewhere = subjectIdKey(Buffer.alloc(32, 7))
    expect(subjectId(elsewhere, 'badge', 'prn_1')).not.toBe(offers[0].claims.badgeNumber)
    // the key is not the secret of the deployment itself
    expect(subjectIdKey(Buffer.alloc(32, 9)).equals(Buffer.alloc(32, 9))).toBe(false)
  })
})

describe('a credential named by its schema (INTX-ISSUE-017)', () => {
  const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'
  const bySchema: IssuanceProfile = {
    credential: { jsonSchemaCredentialId: BADGE },
    label: 'Badge',
    claims: { badgeNumber: { from: 'computed', fn: 'subjectId' } },
  }
  /** a DIDComm agent that holds the definitions given, and counts what it is asked */
  const didcommAgent = (held: { id: string; relatedJsonSchemaCredentialId?: string }[] = [], pageSize = 10) => {
    const calls = { list: 0, create: 0 }
    const client = {
      listCredentialDefinitions: async (cursor?: string) => {
        calls.list++
        const from = cursor ? Number(cursor) : 0
        const next = from + pageSize < held.length ? String(from + pageSize) : null
        return { items: held.slice(from, from + pageSize), nextCursor: next }
      },
      createCredentialDefinition: async (body: { relatedJsonSchemaCredentialId: string }) => {
        calls.create++
        const created = {
          id: `def-${held.length + 1}`,
          relatedJsonSchemaCredentialId: body.relatedJsonSchemaCredentialId,
        }
        held.push(created)
        return created
      },
    }
    return { client, calls, held }
  }

  it('creates the definition when the DIDComm agent holds none, and only once', async () => {
    const { client, calls } = didcommAgent()
    const definitions = new CredentialDefinitions(client, silent as never)
    const [one, two] = await Promise.all([definitions.forSchema(BADGE), definitions.forSchema(BADGE)])
    expect(one).toBe('def-1')
    expect(two).toBe('def-1')
    expect(await definitions.forSchema(BADGE)).toBe('def-1')
    expect(calls.create).toBe(1)
    // a second start finds it and creates none
    const restarted = new CredentialDefinitions(client, silent as never)
    expect(await restarted.forSchema(BADGE)).toBe('def-1')
    expect(calls.create).toBe(1)
  })

  it('finds the definition of the schema among those of other schemas, on any page', async () => {
    const others = Array.from({ length: 5 }, (_, i) => ({ id: `other-${i}`, relatedJsonSchemaCredentialId: `s-${i}` }))
    const { client, calls } = didcommAgent([...others, { id: 'badge-def', relatedJsonSchemaCredentialId: BADGE }], 2)
    expect(await new CredentialDefinitions(client, silent as never).forSchema(BADGE)).toBe('badge-def')
    expect(calls.create).toBe(0)
    expect(calls.list).toBe(3)
  })

  it('takes the definition that exists when the creation meets a conflict', async () => {
    const { client, held } = didcommAgent()
    client.createCredentialDefinition = async () => {
      held.push({ id: 'made-elsewhere', relatedJsonSchemaCredentialId: BADGE })
      throw new VsAgentError(409, '/anoncreds/credential-definitions', 'already exists')
    }
    expect(await new CredentialDefinitions(client, silent as never).forSchema(BADGE)).toBe('made-elsewhere')
  })

  it('issues nothing while the definition cannot be established, and issues once it can', async () => {
    let reachable = false
    const { client } = didcommAgent()
    const list = client.listCredentialDefinitions
    client.listCredentialDefinitions = async (cursor) => {
      if (!reachable) throw new Error('connect ECONNREFUSED')
      return list(cursor)
    }
    const definitions = new CredentialDefinitions(client, silent as never)
    const { service, offers } = setup({ badge: bySchema }, { definitionFor: (schema) => definitions.forSchema(schema) })
    await service.prepare()
    expect((await service.requirements(person()))[0].state).toBe('ready')
    expect(await service.issue(person(), session, 'badge', 'model')).toEqual({ outcome: 'not-ready' })
    expect(offers).toEqual([])
    expect(issuanceOutcomeForModel('not-ready')).toMatch(/cannot issue this credential yet/)
    reachable = true
    expect((await service.issue(person(), session, 'badge', 'model')).outcome).toBe('issued')
    expect(offers[0].credentialDefinitionId).toBe('def-1')
  })

  it('refuses a profile that names both a definition and a schema, or neither', () => {
    const env = { ...process.env, HOME_BACKING_IDENTITY: 'did:webvh:x:h' }
    const dev = structuredClone(loadPack('agent-packs/dev', env).pack) as unknown as Record<string, unknown>
    const withCredential = (credential: Record<string, string>) => ({
      ...dev,
      issuance: { badge: { credential, claims: { badgeNumber: { from: 'computed', fn: 'subjectId' } } } },
    })
    expect(
      validatePackDocument(withCredential({ jsonSchemaCredentialId: BADGE }), env).issuance?.badge.credential
    ).toEqual({ jsonSchemaCredentialId: BADGE })
    expect(() => validatePackDocument(withCredential({}), env)).toThrow(/issuance\/badge\/credential/)
    expect(() =>
      validatePackDocument(withCredential({ jsonSchemaCredentialId: BADGE, credentialDefinitionId: 'def' }), env)
    ).toThrow(/issuance\/badge\/credential/)
    const both = structuredClone(loadPack('agent-packs/dev', env).pack)
    both.issuance = {
      badge: { ...bySchema, credential: { jsonSchemaCredentialId: BADGE, credentialDefinitionId: 'def' } },
    }
    expect(crossFieldErrors(both).join('\n')).toMatch(/INTX-ISSUE-017: issuance\.badge\.credential names one of/)
  })
})

describe('the pack, the tools and the menu (INTX-ISSUE-001/003, RBAC-FILTER-003)', () => {
  let running: RunningAgent | undefined
  afterEach(async () => {
    await running?.stop()
    running = undefined
  })

  it('refuses a claim whose source the agent cannot resolve', () => {
    const dev = structuredClone(
      loadPack('agent-packs/dev', { ...process.env, HOME_BACKING_IDENTITY: 'did:webvh:x:h' }).pack
    )
    dev.presentations = { diploma }
    dev.issuance = { alumni, pass }
    expect(crossFieldErrors(dev)).toEqual([])
    dev.issuance = {
      alumni: {
        ...alumni,
        claims: {
          year: { from: 'evidence', entry: 'diploma', attribute: 'graduationDate' },
          name: { from: 'evidence', entry: 'passport', attribute: 'name' },
          until: { from: 'computed', fn: 'addDays' },
          code: { from: 'computed', fn: 'random' as never },
        },
      },
    }
    const errors = crossFieldErrors(dev).join('\n')
    expect(errors).toMatch(/INTX-ISSUE-015: issuance\.alumni\.claims\.code names the unknown function random/)
    expect(errors).toMatch(/claims\.year reads diploma\.graduationDate, which that entry does not store/)
    expect(errors).toMatch(/claims\.name names the unknown entry passport/)
    expect(errors).toMatch(/claims\.until addDays needs days/)
  })

  it('takes the identifier of the subject in a pack document, and no function outside the list (INTX-ISSUE-015)', () => {
    const env = { ...process.env, HOME_BACKING_IDENTITY: 'did:webvh:x:h' }
    const dev = structuredClone(loadPack('agent-packs/dev', env).pack) as unknown as Record<string, unknown>
    const withBadge = (fn: string) => ({
      ...dev,
      issuance: {
        badge: {
          credential: { credentialDefinitionId: 'did:webvh:issuer/resources/badge' },
          claims: { badgeNumber: { from: 'computed', fn } },
        },
      },
    })
    expect(validatePackDocument(withBadge('subjectId'), env).issuance?.badge.claims.badgeNumber).toEqual({
      from: 'computed',
      fn: 'subjectId',
    })
    expect(() => validatePackDocument(withBadge('random'), env)).toThrow(/claims\/badgeNumber/)
  })

  it('gives the model the name of a credential and nothing else, and the person a menu item for what they ask themselves', async () => {
    running = await startTestAgent()
    const { agent } = running
    agent.pack.presentations = { diploma }
    agent.pack.issuance = { alumni, pass }
    const { principal, session: bound } = await agent.onPeerConnected(
      {
        connectionType: 'verifiable-user-agent',
        actorIdentity: 'did:peer:issuance',
        backingIdentity: null,
        claims: { userName: 'Unidentified peer' },
        userAgentVerified: false,
        identityCredentialRef: null,
      },
      'conn-issuance',
      { name: 'Wallet', version: '1', platform: 'ios' },
      { welcome: false }
    )
    const tools = await agent.registry.visible(principal.roles, [], principal)
    const issue = tools.find((t) => t.spec.name === 'issue_credential')?.spec
    const requirements = tools.find((t) => t.spec.name === 'credential_requirements')?.spec
    if (!issue || !requirements) throw new Error('issuance tools missing')
    // the profile the person starts is not in the model's list
    expect(issue.parameters).toEqual({
      type: 'object',
      required: ['credential'],
      additionalProperties: false,
      properties: { credential: { type: 'string', enum: ['alumni'] } },
    })
    const ctx = { principal, session: bound, roles: principal.roles, logger: agent.logger, language: 'en' }
    const listed = JSON.parse((await requirements.invoke({}, ctx)).content) as { credential: string; state: string }[]
    expect(listed.map((r) => `${r.credential}:${r.state}`)).toEqual(['alumni:incomplete', 'pass:ready'])
    const refused = await issue.invoke({ credential: 'alumni' }, ctx)
    expect(refused.content).toMatch(/^not issued: something is missing/)
    expect((await issue.invoke({ credential: 'pass' }, ctx)).content).toMatch(/^not issued: this credential is not one/)
    expect(contextualMenuFor(agent.pack, principal, bound, 0)).toContainEqual({
      id: 'ayni.issue:pass',
      label: 'Get Visitor pass',
    })
    // a service is offered nothing
    const service = { ...principal, connectionType: 'verifiable-service' as const }
    expect((await agent.registry.visible([], [], service)).map((t) => t.spec.name)).not.toContain('issue_credential')
  })
})

describe('a credential from a document read (D73, INTX-AUTH-010, INTX-ISSUE-019)', () => {
  const document = {
    store: {
      attributes: ['documentNumber', 'issuingState', 'fullName', 'dateOfBirth', 'portrait'],
      retention: { days: 1, onExpiry: 'erase' as const },
    },
  }
  const badge: IssuanceProfile = {
    credential: { credentialDefinitionId: 'did:webvh:issuer/resources/badge' },
    label: 'Badge from a passport',
    authChallenge: { type: 'document' },
    evidenceMaxAgeMinutes: 15,
    claims: {
      badgeNumber: { from: 'computed', fn: 'documentId' },
      name: { from: 'evidence', entry: 'document', attribute: 'fullName' },
      birthDate: { from: 'evidence', entry: 'document', attribute: 'dateOfBirth' },
      photo: { from: 'evidence', entry: 'document', attribute: 'portrait' },
      issuedOn: { from: 'computed', fn: 'today' },
    },
  }
  /** what the event handler records of a read that verified: the specimen of the BSI reference data set */
  const read = (over: Record<string, string> = {}): EvidenceInput => ({
    kind: 'document',
    entry: 'document',
    values: {
      documentType: 'passport',
      documentNumber: 'C11T002JM',
      issuingState: 'D',
      nationality: 'D',
      lastName: 'MUSTERMANN',
      firstName: 'ERIKA',
      fullName: 'ERIKA MUSTERMANN',
      dateOfBirth: '1996-08-12',
      dateOfExpiry: '2033-10-31',
      sex: 'F',
      portrait: 'data:image/jpeg;base64,AAAA',
      ...over,
    },
    requestRef: 'thread-1',
  })
  /** an agent whose challenge is a read that succeeds, as the phone and the event handler make it */
  function reading(values: Record<string, string> = {}) {
    const asked: string[] = []
    const made = setup(
      { badge },
      {
        challenge: async (principal, _session, policy) => {
          asked.push(policy.type)
          await made.evidence.record(principal, read(values))
          return { passed: true }
        },
      },
      { evidence: { document } }
    )
    return { ...made, asked }
  }

  it('before the read the credential is ready: what is missing is what the issuance itself reads', async () => {
    const { service } = reading()
    const [requirements] = await service.requirements(person())
    const byIssuing = {
      type: 'issue_credential',
      profile: 'badge',
      note: 'the person reads their passport or identity card on their phone when the issuance starts',
    }
    expect(requirements.state).toBe('ready')
    expect(requirements.claims).toEqual([
      { name: 'badgeNumber', status: 'missing', action: byIssuing },
      { name: 'name', status: 'missing', action: byIssuing },
      { name: 'birthDate', status: 'missing', action: byIssuing },
      { name: 'photo', status: 'missing', action: byIssuing },
      { name: 'issuedOn', status: 'available' },
    ])
  })

  it('the issuance runs the read, then issues from what it gave and from nothing else', async () => {
    const { service, offers, asked } = reading()
    expect((await service.issue(person(), session, 'badge', 'model')).outcome).toBe('issued')
    expect(asked).toEqual(['document'])
    expect(offers).toHaveLength(1)
    expect(offers[0].claims).toMatchObject({
      name: 'ERIKA MUSTERMANN',
      birthDate: '1996-08-12',
      photo: 'data:image/jpeg;base64,AAAA',
    })
    expect(offers[0].claims.badgeNumber).toBe(documentId(subjectIdKey(Buffer.alloc(32, 9)), 'badge', 'D', 'C11T002JM'))
    // neither the number of the document nor its state is in the number of the badge
    expect(offers[0].claims.badgeNumber).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/)
    expect(offers[0].claims.badgeNumber).not.toContain('C11T002JM')
  })

  it('a read that does not pass issues nothing, and the model is told why', async () => {
    const failed = setup(
      { badge },
      {
        challenge: async () => ({
          passed: false,
          reason: 'the document has expired; another, valid document is needed',
        }),
      },
      { evidence: { document } }
    )
    const result = await failed.service.issue(person(), session, 'badge', 'model')
    expect(result.outcome).toBe('challenge-failed')
    expect(failed.offers).toHaveLength(0)
    expect(issuanceOutcomeForModel(result.outcome, undefined, result.reason)).toBe(
      'not issued: the document has expired; another, valid document is needed.'
    )
  })

  it('a read that is still good is not asked again: the person declined the offer and asks once more', async () => {
    let offered = 0
    const asked: string[] = []
    const made = setup(
      { badge },
      {
        challenge: async (principal, _session, policy) => {
          asked.push(policy.type)
          await made.evidence.record(principal, read())
          return { passed: true }
        },
        offer: async () => (++offered === 1 ? { outcome: 'declined' } : { outcome: 'issued', exchangeId: 'cex-2' }),
      },
      { evidence: { document } }
    )
    expect((await made.service.issue(person(), session, 'badge', 'model')).outcome).toBe('declined')
    expect((await made.service.issue(person(), session, 'badge', 'model')).outcome).toBe('issued')
    expect(asked).toEqual(['document'])
  })

  it('one document is one number through two connections; another document is another number', async () => {
    const first = reading()
    await first.service.issue(person({ id: 'prn_guest_1' }), session, 'badge', 'model')
    const second = reading()
    await second.service.issue(person({ id: 'prn_guest_2' }), session, 'badge', 'model')
    const renewed = reading({ documentNumber: 'C11T002JN' })
    await renewed.service.issue(person({ id: 'prn_guest_1' }), session, 'badge', 'model')
    expect(first.offers[0].claims.badgeNumber).toBe(second.offers[0].claims.badgeNumber)
    expect(renewed.offers[0].claims.badgeNumber).not.toBe(first.offers[0].claims.badgeNumber)
  })

  it('the pack refuses what could not work', () => {
    const errorsOf = (issuance: Record<string, IssuanceProfile>, extra: Partial<AgentPack>) =>
      crossFieldErrors({
        ...packWith(issuance, extra),
        privacy: { processingActivities: [] },
        persona: {},
      } as unknown as AgentPack).filter((e) =>
        /INTX-AUTH-010|INTX-ISSUE-019|INTX-ISSUE-001|PRIV-EVID-006|document/.test(e)
      )
    expect(errorsOf({ badge }, { evidence: { document } })).toEqual([])
    // nothing would read the document
    expect(errorsOf({ badge: { ...badge, authChallenge: undefined } }, { evidence: { document } })[0]).toMatch(
      /INTX-AUTH-010.*no document challenge/
    )
    // nobody asked for it
    expect(errorsOf({ badge: { ...badge, trigger: 'automatic' } }, { evidence: { document } })[0]).toMatch(
      /INTX-AUTH-010.*automatic/
    )
    // the number is made of two attributes that must be kept
    const noNumber = { store: { attributes: ['fullName', 'dateOfBirth', 'portrait'] } }
    expect(errorsOf({ badge }, { evidence: { document: noNumber } }).join(' ')).toMatch(
      /INTX-ISSUE-019.*documentNumber, issuingState/
    )
    // a read gives a closed list of attributes
    const unknown = { store: { attributes: [...document.store.attributes, 'eyeColour'] } }
    expect(errorsOf({ badge }, { evidence: { document: unknown } }).join(' ')).toMatch(
      /evidence\.document stores \[eyeColour\]/
    )
    // no entry of evidence.document at all
    expect(errorsOf({ badge }, {}).join(' ')).toMatch(/unknown entry document/)
  })
})
