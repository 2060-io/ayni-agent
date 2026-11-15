/**
 * Credential issuance (D68, D70; INTX-ISSUE-001..014, RBAC-FILTER-003): every claim comes from a source the
 * profile names, the model names a credential and nothing else, and the requirements never show a value.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { CredentialOffers } from '../src/channels/didcomm/credentialOffers.js'
import { crossFieldErrors, loadPack } from '../src/config/pack.js'
import type { AgentPack, IssuanceProfile, PresentationEntry } from '../src/config/packTypes.js'
import { type EvidenceInput, EvidenceService } from '../src/core/evidence.js'
import { contextualMenuFor } from '../src/core/interaction.js'
import { type IssuanceDeps, IssuanceService, issuanceEntry } from '../src/core/issuance.js'
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
const packWith = (issuance: Record<string, IssuanceProfile>): AgentPack =>
  ({ identity: { roleRules: [] }, presentations: { diploma }, issuance }) as unknown as AgentPack

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

function setup(issuance: Record<string, IssuanceProfile>, deps: Partial<IssuanceDeps> = {}) {
  const pack = packWith(issuance)
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
      challenge: async () => true,
      ...deps,
    },
    silent as never
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
      { challenge: async () => false }
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
    // an offer left unanswered ends as declined; one that cannot be sent as failed
    expect((await offers.offer(input)).outcome).toBe('declined')
    const broken = new CredentialOffers(
      { offerCredential: async () => Promise.reject(new Error('down')) } as never,
      undefined,
      async () => false,
      silent as never
    )
    expect(await broken.offer(input)).toEqual({ outcome: 'failed' })
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
        },
      },
    }
    const errors = crossFieldErrors(dev).join('\n')
    expect(errors).toMatch(/claims\.year reads diploma\.graduationDate, which that entry does not store/)
    expect(errors).toMatch(/claims\.name names the unknown entry passport/)
    expect(errors).toMatch(/claims\.until addDays needs days/)
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
