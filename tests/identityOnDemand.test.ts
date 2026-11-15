/**
 * The authentication asked on connect or on demand, who enters unidentified, and binding after connect
 * (D53, D65, D66; IDENT-RES-007/010/013..017).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { IdentityFlow } from '../src/channels/didcomm/identity.js'
import { type IdentityRequestDeps, IdentityRequests } from '../src/channels/didcomm/identityRequests.js'
import { type AgentPack, type AuthenticationEntry, admitsUnidentified } from '../src/config/packTypes.js'
import type { EvidenceInput } from '../src/core/evidence.js'
import { contextualMenuFor, PLATFORM_MENU } from '../src/core/interaction.js'
import type { VerifiedFacts } from '../src/core/principals.js'
import type { Principal, Session } from '../src/core/types.js'
import { startTestAgent } from './helpers.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'
const entry = (over: Partial<AuthenticationEntry> = {}): AuthenticationEntry => ({
  credential: { jsonSchemaCredentialId: BADGE },
  subjectKey: ['badgeNumber'],
  ...over,
})
const packWith = (authentication?: AuthenticationEntry[]): AgentPack =>
  ({
    metadata: { displayName: 'Test agent' },
    persona: {},
    identity: { homeBackingIdentity: 'did:webvh:x:agent', roleRules: [], userAgentGate: 'optional', authentication },
  }) as unknown as AgentPack

const evidence = (requestRef: string): EvidenceInput => ({
  kind: 'presentation',
  entry: 'authentication',
  schema: BADGE,
  issuerDid: 'did:webvh:a',
  issuerOrganization: { key: 'org:EE:1', name: 'Org A' },
  values: { badgeNumber: '42', name: 'Alice Martin' },
  requestRef,
})
const identified = (badgeNumber = '42', requestRef = 'pex-1'): VerifiedFacts => ({
  connectionType: 'verifiable-user-agent',
  actorIdentity: `org:EE:1|${BADGE}|${badgeNumber}`,
  backingIdentity: { kind: 'org', id: 'org:EE:1', name: 'Org A' },
  claims: { badgeNumber, name: 'Alice Martin' },
  userAgentVerified: false,
  identityCredentialRef: `badge:${requestRef}`,
  evidence: evidence(requestRef),
})
const visitor = (peer: string): VerifiedFacts => ({
  connectionType: 'verifiable-user-agent',
  actorIdentity: peer,
  backingIdentity: null,
  claims: { userName: 'Unidentified peer' },
  userAgentVerified: false,
  identityCredentialRef: null,
})

describe('who enters unidentified follows from the authentication (D53, IDENT-RES-007/010)', () => {
  it('no schema and on demand admit; on connect identifies or refuses', () => {
    expect(admitsUnidentified(packWith())).toBe(true)
    expect(admitsUnidentified(packWith([entry({ request: 'on-demand' })]))).toBe(true)
    expect(admitsUnidentified(packWith([entry({ request: 'on-connect' })]))).toBe(false)
    expect(admitsUnidentified(packWith([entry()]))).toBe(false)
  })

  it('asks nothing at connection when there is no schema or it is asked on demand', async () => {
    for (const pack of [packWith(), packWith([entry({ request: 'on-demand' })])]) {
      const calls: unknown[] = []
      const client = { requestPresentation: async (...args: unknown[]) => void calls.push(args) }
      const flow = new IdentityFlow(pack, client as never, {} as never, false, silent as never)
      expect(await flow.establish('conn-1', 'did:peer:4zVisitor')).toMatchObject({
        actorIdentity: 'did:peer:4zVisitor',
        backingIdentity: null,
        identityCredentialRef: null,
      })
      expect(calls).toHaveLength(0)
    }
  })

  it('refuses, on connect, a wallet that presents nothing', async () => {
    const ref: { flow?: IdentityFlow } = {}
    const client = {
      requestPresentation: async () => {
        setTimeout(
          () => ref.flow?.onPresentation({ proofExchangeId: 'pex-1', state: 'declined', claims: [], verified: false }),
          0
        )
        return { proofExchangeId: 'pex-1' }
      },
    }
    ref.flow = new IdentityFlow(packWith([entry()]), client as never, {} as never, false, silent as never)
    expect(await ref.flow.establish('conn-1', 'did:peer:4zVisitor')).toBeUndefined()
  })
})

describe('the request on demand (IDENT-RES-015/016)', () => {
  const principal = (over: Partial<Principal> = {}) =>
    ({
      id: 'prn_v',
      actorIdentity: 'did:peer:4zVisitor',
      capabilityChannelId: 'conn-1',
      identityCredentialRef: null,
      userAgentVerified: false,
      ...over,
    }) as Principal
  const deps = (over: Partial<IdentityRequestDeps> = {}): IdentityRequestDeps => ({
    identify: async () => identified(),
    isFlowCapable: async () => true,
    onIdentityPresented: async () => ({ outcome: 'identified' }),
    ...over,
  })
  const pack = packWith([entry({ request: 'on-demand' })])

  it('asks an unidentified person only, on their own connection', async () => {
    const asked: unknown[][] = []
    const requests = new IdentityRequests(
      pack,
      deps({
        identify: async (...args) => {
          asked.push(args)
          return identified()
        },
      }),
      silent as never
    )
    expect(await requests.request(principal(), 'model')).toBe('identified')
    expect(asked).toEqual([['conn-1', 'did:peer:4zVisitor', true, false]])
    expect(await requests.request(principal({ identityCredentialRef: 'badge:x' }), 'model')).toBe('already-identified')
    expect(await requests.request(principal({ capabilityChannelId: null }), 'model')).toBe('unavailable')
    expect(await new IdentityRequests(packWith(), deps(), silent as never).request(principal(), 'person')).toBe(
      'not-offered'
    )
    expect(asked).toHaveLength(1)
  })

  it('does not insist: the model waits after a request left unanswered, the person is always served', async () => {
    let calls = 0
    const requests = new IdentityRequests(
      pack,
      deps({
        identify: async () => {
          calls++
          return undefined
        },
      }),
      silent as never
    )
    expect(await requests.request(principal(), 'model')).toBe('not-presented')
    expect(await requests.request(principal(), 'model')).toBe('wait')
    expect(calls).toBe(1)
    expect(await requests.request(principal(), 'person')).toBe('not-presented')
    expect(calls).toBe(2)
    // no wait once the period is over
    const impatient = new IdentityRequests(pack, deps({ identify: async () => undefined }), silent as never, 0)
    expect(await impatient.request(principal(), 'model')).toBe('not-presented')
    expect(await impatient.request(principal(), 'model')).toBe('not-presented')
  })

  it('keeps one request pending on a connection', async () => {
    let release: (facts: VerifiedFacts | undefined) => void = () => undefined
    const waiting = new Promise<VerifiedFacts | undefined>((resolve) => {
      release = resolve
    })
    const requests = new IdentityRequests(pack, deps({ identify: () => waiting }), silent as never)
    const first = requests.request(principal(), 'person')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await requests.request(principal(), 'person')).toBe('pending')
    expect(await requests.request(principal(), 'model')).toBe('pending')
    release(identified())
    expect(await first).toBe('identified')
    expect(await requests.request(principal(), 'person')).toBe('identified')
  })
})

describe('binding after connect (D66, IDENT-RES-013/014/017)', () => {
  let running: RunningAgent | undefined
  afterEach(async () => {
    await running?.stop()
    running = undefined
  })
  const client = { name: 'Wallet', version: '1', platform: 'ios' }

  /** A visitor on a connection, with a conversation of two messages. */
  async function visit(agent: RunningAgent['agent'], connectionId: string) {
    const { principal, session } = await agent.onPeerConnected(
      visitor(`did:peer:${connectionId}`),
      connectionId,
      client,
      {
        welcome: false,
      }
    )
    const now = new Date().toISOString()
    await agent.store.conversations.save({
      id: `conv_${connectionId}`,
      principalId: principal.id,
      channelType: 'ag-ui',
      title: 'Before identifying',
      state: 'active',
      createdAt: now,
      lastActivityAt: now,
      sessionIds: [session.id],
    })
    for (const text of ['hello', 'what is Ayni?'])
      await agent.memory.append({
        sessionId: session.id,
        principalId: principal.id,
        role: 'principal',
        sourceType: 'text',
        text,
        backingIdentity: null,
      })
    return { principal, session }
  }

  it('upgrades an unidentified connection and moves its conversations, sessions and entries', async () => {
    running = await startTestAgent()
    const { agent } = running
    const before = await visit(agent, 'conn-up')
    const result = await agent.onIdentityPresented('conn-up', identified())
    expect(result.outcome).toBe('identified')
    const alice = result.principal as Principal
    expect(alice.id).not.toBe(before.principal.id)
    expect(alice.actorIdentity).toBe(`org:EE:1|${BADGE}|42`)
    expect(alice.capabilityChannelId).toBe('conn-up')
    // the conversation held before is hers, with its session and its entries
    expect((await agent.store.conversations.listByPrincipal(alice.id)).map((c) => c.id)).toEqual(['conv_conn-up'])
    expect(await agent.store.conversations.listByPrincipal(before.principal.id)).toEqual([])
    expect((await agent.store.sessions.get(before.session.id))?.principalId).toBe(alice.id)
    const bound = await agent.didcommSession('conn-up')
    expect(bound?.principal.id).toBe(alice.id)
    const entries = await agent.memory.history(alice, bound?.session as Session, { limit: 10 })
    expect(entries.map((e) => e.text).sort()).toEqual(['hello', 'what is Ayni?'])
    expect(entries.every((e) => e.principalId === alice.id)).toBe(true)
    // the visitor is no longer on the connection; the presentation is evidence of the identified person
    expect((await agent.store.principals.get(before.principal.id))?.capabilityChannelId).toBeNull()
    expect((await agent.evidence.list(alice.id)).map((r) => r.connectionRef)).toEqual(['conn-up'])
  })

  it('accepts the same person again and refuses another identity, of which nothing is kept', async () => {
    running = await startTestAgent()
    const { agent } = running
    await visit(agent, 'conn-same')
    const alice = (await agent.onIdentityPresented('conn-same', identified())).principal as Principal
    const again = await agent.onIdentityPresented('conn-same', identified('42', 'pex-2'))
    expect(again.outcome).toBe('refreshed')
    expect(again.principal?.id).toBe(alice.id)
    expect(await agent.evidence.list(alice.id)).toHaveLength(2)
    const other = await agent.onIdentityPresented('conn-same', identified('77', 'pex-3'))
    expect(other).toEqual({ outcome: 'another-identity' })
    expect(await agent.evidence.list(alice.id)).toHaveLength(2)
    expect(await agent.store.principals.findByActor(`org:EE:1|${BADGE}|77`)).toBeUndefined()
    expect((await agent.didcommSession('conn-same'))?.principal.id).toBe(alice.id)
    expect((await agent.onIdentityPresented('conn-unknown', identified())).outcome).toBe('unavailable')
  })

  it('offers the request to an unidentified person only: in the model’s tools and in the menu', async () => {
    running = await startTestAgent()
    const { agent } = running
    agent.pack.identity.authentication = [entry({ request: 'on-demand' })]
    const guest = await visit(agent, 'conn-menu')
    const names = async (p: Principal) => (await agent.registry.visible(p.roles, [], p)).map((t) => t.spec.name)
    expect(await names(guest.principal)).toContain('request_presentation')
    expect(contextualMenuFor(agent.pack, guest.principal, guest.session, 0).map((i) => i.id)).toContain(
      PLATFORM_MENU.identify
    )
    const alice = (await agent.onIdentityPresented('conn-menu', identified())).principal as Principal
    expect(await names(alice)).not.toContain('request_presentation')
    expect(contextualMenuFor(agent.pack, alice, guest.session, 0).map((i) => i.id)).not.toContain(
      PLATFORM_MENU.identify
    )
    // the tool takes the name of an entry and nothing else, and answers with a status
    const tool = await agent.registry.find('request_presentation')
    if (!tool) throw new Error('no request_presentation tool')
    expect(tool.parameters).toMatchObject({ required: ['entry'], additionalProperties: false })
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(['entry'])
    // (the wallet of this test cannot be reached: the request ends unanswered)
    const ctx = { principal: guest.principal, session: guest.session, roles: [], logger: agent.logger, language: 'en' }
    const asked = await tool.invoke({ entry: 'authentication' }, ctx)
    expect(asked.content).toMatch(/^not asked|^not presented/)
    expect(asked.content).not.toMatch(/Alice|42/)
  })
})
