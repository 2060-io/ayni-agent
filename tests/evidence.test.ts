/**
 * Evidence (D67, D68; PRIV-EVID-001..009, INTX-CRED-001): what is kept of a verification, for how long, and
 * what the model may read of it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { crossFieldErrors, evidenceWarnings, loadPack } from '../src/config/pack.js'
import type { AgentPack, AuthenticationEntry } from '../src/config/packTypes.js'
import { AUTHENTICATION_ENTRY, type EvidenceInput, EvidenceService, nameForModel } from '../src/core/evidence.js'
import { PrincipalService, type VerifiedFacts } from '../src/core/principals.js'
import type { Principal } from '../src/core/types.js'
import { createEntryCrypto, sha256Hex } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'
import { startTestAgent } from './helpers.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'
const crypto = createEntryCrypto(Buffer.alloc(32, 3))

function packWith(policy: Partial<AuthenticationEntry> = {}): AgentPack {
  return {
    identity: {
      homeBackingIdentity: 'did:webvh:x:agent',
      roleRules: [],
      authentication: [{ credential: { jsonSchemaCredentialId: BADGE }, subjectKey: ['badgeNumber'], ...policy }],
    },
  } as unknown as AgentPack
}

const presentation = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  kind: 'presentation',
  entry: AUTHENTICATION_ENTRY,
  schema: BADGE,
  credentialDefinitionId: 'did:webvh:a/resources/def',
  issuerDid: 'did:webvh:a',
  issuerOrganization: { key: 'org:EE:1', name: 'Org A' },
  values: { badgeNumber: '42', name: 'Alice Martin', department: 'Finance', birthDate: '1990-01-02' },
  unrevealed: ['photo'],
  requestRef: 'pex-1',
  connectionRef: 'conn-1',
  ...over,
})

const service = (pack: AgentPack, store = new MemoryStore()) => ({
  store,
  evidence: new EvidenceService(store, pack, crypto, silent as never),
})

describe('an evidence record (PRIV-EVID-002/004/009)', () => {
  it('keeps the audit fields in the clear and no value by default', async () => {
    const { store, evidence } = service(packWith())
    const record = await evidence.record({ id: 'prn_1' }, presentation())
    expect(record).toMatchObject({
      principalId: 'prn_1',
      kind: 'presentation',
      entry: 'authentication',
      schema: BADGE,
      issuerDid: 'did:webvh:a',
      issuerOrganization: { key: 'org:EE:1', name: 'Org A' },
      outcome: 'verified',
      revealed: ['badgeNumber', 'name', 'department', 'birthDate'],
      unrevealed: ['photo'],
      stored: [],
      requestRef: 'pex-1',
      connectionRef: 'conn-1',
      state: 'active',
      encKeyRef: null,
    })
    const stored = await store.evidence.get(record.id)
    expect(stored?.cipher).toBeNull()
    // no attribute value anywhere in what is kept
    expect(JSON.stringify(stored)).not.toMatch(/Alice|Finance|1990|"42"/)
    expect(await evidence.forModel('prn_1')).toEqual([
      expect.objectContaining({ entry: 'authentication', issuer: 'Org A', usable: true, attributes: {} }),
    ])
    expect(await evidence.values('prn_1', AUTHENTICATION_ENTRY)).toEqual({})
  })

  it('seals the values the pack stores, and only those, under a key of the record', async () => {
    const { store, evidence } = service(
      packWith({ store: { attributes: ['name', 'department'], retention: { days: 30 } }, modelVisible: ['name'] })
    )
    const record = await evidence.record({ id: 'prn_1' }, presentation())
    expect(record.stored).toEqual(['name', 'department'])
    expect(record.onExpiry).toBe('erase')
    expect(Date.parse(record.expiresAt as string) - Date.parse(record.verifiedAt)).toBe(30 * 86_400_000)
    const stored = await store.evidence.get(record.id)
    // the audit fields hold no value; the digest is over the ciphertext
    const { cipher, ...audit } = stored as NonNullable<typeof stored>
    expect(JSON.stringify(audit)).not.toMatch(/Alice|Finance|1990/)
    expect(cipher?.toString('utf8')).not.toMatch(/Alice|Finance/)
    expect(record.contentDigest).toBe(sha256Hex(cipher as Buffer))
    // the code that issues reads what is stored; the unstored birth date is gone
    expect(await evidence.values('prn_1', AUTHENTICATION_ENTRY)).toEqual({
      name: 'Alice Martin',
      department: 'Finance',
    })
  })

  it('shows the model the visible attributes only: a stored attribute that is not visible never appears', async () => {
    const { evidence } = service(packWith({ store: { attributes: ['name', 'department'] }, modelVisible: ['name'] }))
    await evidence.record({ id: 'prn_1' }, presentation())
    const [seen] = await evidence.forModel('prn_1')
    expect(seen.attributes).toEqual({ name: 'Alice Martin' })
    expect(JSON.stringify(seen)).not.toMatch(/Finance|1990|did:webvh/)
    expect(await evidence.forModel('prn_other')).toEqual([])
  })

  it('erases the values of the earlier presentation when the credential is presented again', async () => {
    const { store, evidence } = service(packWith({ store: { attributes: ['name'] } }))
    const first = await evidence.record({ id: 'prn_1' }, presentation())
    const second = await evidence.record({ id: 'prn_1' }, presentation({ requestRef: 'pex-2' }))
    expect((await store.evidence.get(first.id))?.state).toBe('crypto-erased')
    expect((await store.evidence.get(first.id))?.cipher).toBeNull()
    expect((await store.evidence.get(second.id))?.state).toBe('active')
    // both remain as audit
    expect((await evidence.list('prn_1')).map((r) => r.requestRef)).toEqual(['pex-1', 'pex-2'])
  })
})

describe('the end of a retention (PRIV-EVID-007/008)', () => {
  const later = () => new Date(Date.now() + 2 * 86_400_000).toISOString()

  it('archive hides the values from the model and the tools and leaves them to the auditor', async () => {
    const { evidence } = service(
      packWith({ store: { attributes: ['name'], retention: { days: 1, onExpiry: 'archive' } }, modelVisible: ['name'] })
    )
    const record = await evidence.record({ id: 'prn_1' }, presentation())
    expect(await evidence.expire()).toEqual({ archived: 0, erased: 0 })
    expect(await evidence.expire(later())).toEqual({ archived: 1, erased: 0 })
    expect(await evidence.forModel('prn_1')).toEqual([expect.objectContaining({ usable: false, attributes: {} })])
    expect(await evidence.values('prn_1', AUTHENTICATION_ENTRY)).toBeUndefined()
    expect((await evidence.audit(record.id))?.values).toEqual({ name: 'Alice Martin' })
  })

  it('erase destroys the key: nobody reads the values, the audit fields and the digest remain', async () => {
    const { store, evidence } = service(packWith({ store: { attributes: ['name'], retention: { days: 1 } } }))
    const record = await evidence.record({ id: 'prn_1' }, presentation())
    expect(await evidence.expire(later())).toEqual({ archived: 0, erased: 1 })
    const stored = await store.evidence.get(record.id)
    expect(stored).toMatchObject({ state: 'crypto-erased', encKeyRef: null, cipher: null })
    expect(stored?.contentDigest).toBe(record.contentDigest)
    expect(stored).toMatchObject({
      issuerDid: 'did:webvh:a',
      schema: BADGE,
      outcome: 'verified',
      revealed: record.revealed,
    })
    expect((await evidence.audit(record.id))?.values).toEqual({})
  })

  it('an erasure request erases the values; a legal hold blocks it and the end of the retention', async () => {
    const { store, evidence } = service(packWith({ store: { attributes: ['name'], retention: { days: 1 } } }))
    const held = await evidence.record({ id: 'prn_1' }, presentation())
    const stored = await store.evidence.get(held.id)
    await store.evidence.save({ ...(stored as NonNullable<typeof stored>), state: 'legal-hold' })
    expect(await evidence.erase(held.id)).toEqual({ erased: false, reason: 'legal-hold' })
    expect(await evidence.expire(later())).toEqual({ archived: 0, erased: 0 })
    expect((await evidence.audit(held.id))?.values).toEqual({ name: 'Alice Martin' })
    const free = await evidence.record({ id: 'prn_2' }, presentation())
    expect(await evidence.erase(free.id)).toEqual({ erased: true })
    expect((await store.evidence.get(free.id))?.state).toBe('crypto-erased')
    expect(await evidence.erase('evd_missing')).toEqual({ erased: false, reason: 'not-found' })
  })
})

describe('what a Principal keeps of its identity credential (PRIV-EVID-004/005/009, D68)', () => {
  const liveness = { verify: async () => ({ ok: true, checkedAt: '' }) }
  const facts = (): VerifiedFacts => ({
    connectionType: 'verifiable-user-agent',
    actorIdentity: `org:EE:1|${BADGE}|42`,
    backingIdentity: { kind: 'org', id: 'org:EE:1', name: 'Org A' },
    claims: { badgeNumber: '42', name: 'Alice Martin', department: 'Finance', userName: 'Alice Martin' },
    userAgentVerified: true,
    identityCredentialRef: 'badge:pex-1',
    evidence: presentation(),
  })

  it('keeps nothing but the issuer by default, and the model is not told the name', async () => {
    const pack = packWith()
    const principal = await new PrincipalService(new MemoryStore(), pack, liveness, silent as never).resolve(facts())
    expect(principal.identityAttributes).toEqual({ issuerDid: 'did:webvh:a' })
    // the subject key lives in the actor identity for the life of the Principal
    expect(principal.actorIdentity).toContain('|42')
    expect(nameForModel(pack, principal)).toBeUndefined()
  })

  it('keeps the stored attributes; the model reads the name only when the pack makes it visible', async () => {
    const stored = packWith({ store: { attributes: ['name', 'department'] } })
    const kept = await new PrincipalService(new MemoryStore(), stored, liveness, silent as never).resolve(facts())
    expect(kept.identityAttributes).toEqual({
      name: 'Alice Martin',
      department: 'Finance',
      userName: 'Alice Martin',
      issuerDid: 'did:webvh:a',
    })
    expect(nameForModel(stored, kept)).toBeUndefined()
    const visible = packWith({ store: { attributes: ['name'] }, modelVisible: ['name'] })
    expect(nameForModel(visible, kept)).toBe('Alice Martin')
    // a service and an unidentified peer carry no credential value: named as before
    const service = { identityAttributes: { userName: 'Billing' }, identityCredentialRef: 'ecs-service:did:x' }
    expect(nameForModel(stored, service as unknown as Principal)).toBe('Billing')
  })

  it('loses the stored values when their retention ends', async () => {
    const pack = packWith({ store: { attributes: ['name'], retention: { days: 1 } } })
    const store = new MemoryStore()
    const principal = await new PrincipalService(store, pack, liveness, silent as never).resolve(facts())
    const evidence = new EvidenceService(store, pack, crypto, silent as never)
    await evidence.record(principal, presentation())
    await evidence.expire(new Date(Date.now() + 2 * 86_400_000).toISOString())
    expect((await store.principals.get(principal.id))?.identityAttributes).toEqual({ issuerDid: 'did:webvh:a' })
  })
})

describe('the pack (PRIV-EVID-006)', () => {
  const dev = () =>
    structuredClone(loadPack('agent-packs/dev', { ...process.env, HOME_BACKING_IDENTITY: 'did:webvh:x:h' }).pack)
  const entry = (over: Partial<AuthenticationEntry>): AuthenticationEntry => ({
    credential: { jsonSchemaCredentialId: BADGE },
    subjectKey: ['badgeNumber'],
    attributes: ['badgeNumber', 'name'],
    ...over,
  })

  it('refuses a model-visible attribute that is not stored and a stored attribute that is not asked', () => {
    const ok = dev()
    ok.identity.authentication = [entry({ store: { attributes: ['name'] }, modelVisible: ['name'] })]
    expect(crossFieldErrors(ok)).toEqual([])
    const notStored = dev()
    notStored.identity.authentication = [entry({ modelVisible: ['name'] })]
    expect(crossFieldErrors(notStored).join('\n')).toMatch(/PRIV-EVID-006.*\[name\].*without storing/)
    const notAsked = dev()
    notAsked.identity.authentication = [entry({ store: { attributes: ['department'] } })]
    expect(crossFieldErrors(notAsked).join('\n')).toMatch(/PRIV-EVID-006.*\[department\].*without asking/)
  })

  it('warns when the model reads an attribute kept for less time than the conversation', () => {
    const pack = dev()
    pack.identity.authentication = [
      entry({ store: { attributes: ['name'], retention: { days: 30 } }, modelVisible: ['name'] }),
    ]
    expect(evidenceWarnings(pack).join('\n')).toMatch(/\[name\] 30 days.*conversation for 365 days/)
    pack.identity.authentication = [entry({ store: { attributes: ['name'], retention: { days: 30 } } })]
    expect(evidenceWarnings(pack)).toEqual([])
  })
})

describe('through the agent (PRIV-EVID-001, INTX-CRED-001)', () => {
  let running: RunningAgent | undefined
  afterEach(async () => {
    await running?.stop()
    running = undefined
  })

  it('records the presentation that identified a peer, and the tool lists it for the model', async () => {
    running = await startTestAgent()
    const { principal } = await running.agent.onPeerConnected(
      {
        connectionType: 'verifiable-user-agent',
        actorIdentity: `org:EE:1|${BADGE}|42`,
        backingIdentity: { kind: 'org', id: 'org:EE:1', name: 'Org A' },
        claims: { badgeNumber: '42', name: 'Alice Martin' },
        userAgentVerified: false,
        identityCredentialRef: 'badge:pex-1',
        evidence: presentation({ connectionRef: undefined }),
      },
      'conn-evidence',
      { name: 'Wallet', version: '1', platform: 'ios' },
      { welcome: false }
    )
    const [record] = await running.agent.evidence.list(principal.id)
    expect(record).toMatchObject({ entry: 'authentication', connectionRef: 'conn-evidence', outcome: 'verified' })
    const tool = await running.agent.registry.find('principal_credentials')
    const session = (await running.agent.didcommSession('conn-evidence'))?.session
    if (!tool || !session) throw new Error('no tool or session')
    const result = await tool.invoke(
      {},
      { principal, session, roles: principal.roles, logger: running.agent.logger, language: 'en' }
    )
    const listed = JSON.parse(result.content) as { entry: string; attributes: Record<string, string> }[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ entry: 'authentication', issuer: 'Org A', usable: true, attributes: {} })
    expect(result.content).not.toMatch(/Alice|"42"/)
  })
})
