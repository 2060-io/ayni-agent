/**
 * Flows on a flow-capable capability channel (D54, D55; INTX-FLOW-001..005, INTX-AUTH-009, CHAN-BIND-009):
 * binding through `link-session`, the device challenge as a `confirm` flow with its card in the conversation,
 * identity requests as flows, the pending cap and the holder's closures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { DidcommAdapter, MediaLinks } from '../src/channels/didcomm/adapter.js'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { IdentityFlow } from '../src/channels/didcomm/identity.js'
import { AYNI_FLOW_PROTOCOL, PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import type { FlowRecord } from '../src/channels/didcomm/vsAgentClient.js'
import type { AgentPack } from '../src/config/packTypes.js'
import { FlowService } from '../src/core/flows.js'
import type { Session } from '../src/core/types.js'
import { createLogger } from '../src/util/logger.js'
import { startTestAgent } from './helpers.js'

type Call = { method: string; args: unknown[]; result?: unknown }

/** A VS Agent with the Ayni flow plugin: records calls, answers the way the plugin does. */
function stubClient(calls: Call[]) {
  let n = 0
  const flows = new Map<string, FlowRecord>()
  const rec = (method: string, answer: (...args: unknown[]) => unknown) => {
    return async (...args: unknown[]) => {
      const call: Call = { method, args }
      calls.push(call)
      call.result = answer(...args)
      return call.result
    }
  }
  return {
    flows,
    sendText: rec('sendText', () => ({ id: `msg-${++n}` })),
    sendQuestion: rec('sendQuestion', () => ({ id: `q-${++n}` })),
    sendActionMenu: rec('sendActionMenu', () => ({ id: `menu-${++n}` })),
    sendReceipts: rec('sendReceipts', () => ({ id: `r-${++n}` })),
    deleteConnection: async () => undefined,
    openFlow: rec('openFlow', (body) => {
      const b = body as { connectionId: string; kind: string; title: string; expiresTime: string }
      const record: FlowRecord = {
        flowId: `flow-${++n}`,
        connectionId: b.connectionId,
        role: 'service',
        openedByMe: true,
        state: 'pending',
        kind: b.kind,
        title: b.title,
        origin: { channel: 'none' },
        expiresTime: b.expiresTime,
        createdAt: new Date().toISOString(),
      }
      flows.set(record.flowId, record)
      return record
    }),
    closeFlow: rec('closeFlow', (flowId, body) => {
      const record = flows.get(String(flowId)) as FlowRecord
      const b = body as { outcome: FlowRecord['state']; references?: FlowRecord['references'] }
      return {
        ...record,
        state: b.outcome,
        references: b.references,
        closedBy: 'me',
        closedAt: new Date().toISOString(),
      }
    }),
    flowProblemReport: rec('flowProblemReport', (flowId) => ({ ...flows.get(String(flowId)), state: 'failed' })),
    sendConfirmRequest: rec('sendConfirmRequest', (body) => {
      const b = body as { connectionId: string; flowId: string; request: unknown }
      return { threadId: `confirm-${++n}`, flowId: b.flowId, connectionId: b.connectionId, state: 'request-sent' }
    }),
    sendLinkSessionRequest: rec('sendLinkSessionRequest', (body) => {
      const b = body as { connectionId: string; flowId: string; request: unknown }
      return { threadId: `link-${++n}`, flowId: b.flowId, connectionId: b.connectionId, state: 'request-sent' }
    }),
    requestPresentation: rec('requestPresentation', () => ({ proofExchangeId: `pex-${++n}` })),
  }
}

const facts = (actor: string) => ({
  connectionType: 'verifiable-user-agent' as const,
  actorIdentity: actor,
  backingIdentity: null,
  claims: { userName: 'Alice' },
  userAgentVerified: false,
  identityCredentialRef: null,
})
const feature = (id: string) => JSON.stringify({ 'feature-type': 'protocol', id, roles: ['holder'] })
const envelope = (type: string, data: Record<string, unknown>) => ({
  id: `evt-${Math.random()}`,
  type,
  timestamp: new Date().toISOString(),
  data,
})
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const uiClient = { name: 'ayni-ui', version: '3.1.0', platform: 'web' }

let running: RunningAgent
let events: DidcommEvents
let calls: Call[]
let client: ReturnType<typeof stubClient>
let flows: FlowService

const callsOf = (method: string) => calls.filter((c) => c.method === method)
const last = <T>(method: string): T => callsOf(method).at(-1)?.args as T

beforeAll(async () => {
  running = await startTestAgent()
  calls = []
  const logger = createLogger('silent')
  client = stubClient(calls)
  const peers = new PeerProfiles(running.agent.store.kv, logger)
  flows = new FlowService(client as never, running.agent.memory, running.agent.router, running.agent.store.kv, logger)
  flows.setAgentDid('did:webvh:test:agent')
  const adapter = new DidcommAdapter(
    client as never,
    'http://agent.test',
    new MediaLinks(1000),
    undefined,
    peers,
    logger
  )
  adapter.attach(running.agent)
  adapter.setFlows(flows)
  running.agent.router.register(adapter)
  running.agent.challenges.setChannelOps(adapter)
  // the agent built by buildAgent holds its own FlowService on the unreachable client; the test one replaces it
  Object.assign(running.agent, { flows })
  // the DIDComm agent is not reachable: mint invitations locally (as tests/agui.test.ts does)
  const minter = running.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
  minter.minter = {
    mint: async (id: string) => ({
      invitationId: `inv-${id}`,
      outOfBandId: `oob-${id}`,
      url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
    }),
  }
  const identity = { establish: async (_c: string, did?: string) => facts(did ?? 'did:peer:x') }
  events = new DidcommEvents(running.agent, client as never, identity as never, adapter, peers, undefined, logger, 100)
})

afterAll(async () => {
  await running.stop()
})

async function connectFlowCapable(connectionId: string, outOfBandId?: string) {
  const completed = events.handle(
    envelope('didcomm.connections.state-updated', {
      id: connectionId,
      state: 'completed',
      theirDid: `did:peer:${connectionId}`,
      theirLabel: 'Ayni',
      outOfBandId: outOfBandId ?? null,
      metadata: {},
    })
  )
  await events.handle(
    envelope('didcomm.connections.state-updated', {
      id: connectionId,
      state: 'updated',
      metadata: {
        [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL),
        'https://didcomm.org/confirm/1.0': feature('https://didcomm.org/confirm/1.0'),
        'https://didcomm.org/link-session/1.0': feature('https://didcomm.org/link-session/1.0'),
      },
    })
  )
  await completed
}

async function createUiSession() {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    payload: { client: uiClient, locale: 'en' },
  })
  if (response.statusCode !== 201) throw new Error(`session creation ${response.statusCode}: ${response.body}`)
  return response.json() as { sessionId: string; sessionToken: string; binding: { invitationId: string } }
}

async function history(sessionId: string, token: string) {
  const response = await running.app.inject({
    method: 'GET',
    url: `/agui/v3/sessions/${sessionId}/messages`,
    headers: { authorization: `Bearer ${token}` },
  })
  return (response.json() as { messages: Record<string, unknown>[] }).messages
}

describe('link-session binding (CHAN-BIND-009, FLOW-LINK-001)', () => {
  it('asks through a link-session flow and binds on link: true, then closes the flow with the session', async () => {
    const created = await createUiSession()
    const session = (await running.agent.sessions.get(created.sessionId)) as Session
    const connectionId = 'conn-link'
    await connectFlowCapable(connectionId, session.binding?.outOfBandId)
    await settle()

    const open = last<[{ kind: string; origin: { channel: string; sessionId?: string } }]>('openFlow')[0]
    expect(open.kind).toBe('link-session')
    expect(open.origin).toMatchObject({ channel: 'ag-ui', sessionId: session.id })
    const link =
      last<[{ flowId: string; request: { invitationId: string; browser: { platform: string }; codes: null } }]>(
        'sendLinkSessionRequest'
      )[0]
    expect(link.request.invitationId).toBe(session.binding?.nonce)
    expect(link.request.browser.platform).toBe('web')
    expect(link.request.codes).toBeNull()
    expect(callsOf('sendQuestion')).toHaveLength(0) // no question-answer on a flow-capable wallet
    expect(callsOf('sendText')).toHaveLength(0) // no welcome on the connection

    expect(callsOf('sendLinkSessionRequest')).toHaveLength(1)
    const threadId = (callsOf('sendLinkSessionRequest')[0].result as { threadId: string }).threadId
    expect((await running.agent.sessions.get(session.id))?.binding?.questionThreadId).toBe(threadId)
    await events.handle(
      envelope('didcomm.link-session.state-changed', {
        threadId,
        flowId: link.flowId,
        connectionId,
        state: 'response-received',
        response: { link: true, code: null },
      })
    )
    await settle()
    const bound = await running.agent.sessions.get(session.id)
    expect(bound?.state).toBe('bound')
    const close = last<[string, { outcome: string; references?: { type: string; id: string }[] }]>('closeFlow')
    expect(close[0]).toBe(link.flowId)
    expect(close[1].outcome).toBe('completed')
    expect(close[1].references).toEqual([{ type: 'session', id: session.id }])
  })

  it('leaves the session provisional on link: false and cancels the flow', async () => {
    const created = await createUiSession()
    const session = (await running.agent.sessions.get(created.sessionId)) as Session
    const connectionId = 'conn-link-no'
    await connectFlowCapable(connectionId, session.binding?.outOfBandId)
    await settle()
    const link = last<[{ flowId: string }]>('sendLinkSessionRequest')[0]
    const threadId = (await running.agent.sessions.get(session.id))?.binding?.questionThreadId
    await events.handle(
      envelope('didcomm.link-session.state-changed', {
        threadId,
        flowId: link.flowId,
        connectionId,
        state: 'response-received',
        response: { link: false },
      })
    )
    await settle()
    expect((await running.agent.sessions.get(session.id))?.state).toBe('provisional')
    expect(last<[string, { outcome: string }]>('closeFlow')[1].outcome).toBe('cancelled')
  })
})

describe('binding after a handshake reuse (decision 24, issue #27)', () => {
  /** A connection that completed with no disclosure on record (served as in v3 so far). */
  async function connectUndisclosed(connectionId: string) {
    await events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'completed',
        theirDid: `did:peer:${connectionId}`,
        theirLabel: 'Ayni',
        outOfBandId: null,
      })
    )
    await settle()
  }
  const reuse = (connectionId: string, session: Session) =>
    events.handle(
      envelope('didcomm.out-of-band.handshake-reused', {
        outOfBandId: session.binding?.outOfBandId,
        invitationId: session.binding?.nonce,
        connectionId,
        reuseThreadId: `reuse-${connectionId}`,
      })
    )
  const disclose = (connectionId: string) =>
    events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'updated',
        metadata: {
          [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL),
          'https://didcomm.org/link-session/1.0': feature('https://didcomm.org/link-session/1.0'),
        },
      })
    )

  it('waits for the disclosure the reuse triggers and asks through a link-session flow', async () => {
    const connectionId = 'conn-reuse'
    await connectUndisclosed(connectionId)
    const created = await createUiSession()
    const session = (await running.agent.sessions.get(created.sessionId)) as Session
    const questions = callsOf('sendQuestion').length
    const links = callsOf('sendLinkSessionRequest').length

    const reused = reuse(connectionId, session)
    await settle()
    await disclose(connectionId)
    await reused

    expect(callsOf('sendQuestion')).toHaveLength(questions)
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links + 1)
    const link = last<[{ connectionId: string; request: { invitationId: string } }]>('sendLinkSessionRequest')[0]
    expect(link.connectionId).toBe(connectionId)
    expect(link.request.invitationId).toBe(session.binding?.nonce)
  })

  it('asks again as a flow when the disclosure arrives after the question went out, and binds on its answer', async () => {
    const connectionId = 'conn-reuse-late'
    await connectUndisclosed(connectionId)
    const created = await createUiSession()
    const session = (await running.agent.sessions.get(created.sessionId)) as Session
    const questions = callsOf('sendQuestion').length
    const links = callsOf('sendLinkSessionRequest').length

    await reuse(connectionId, session) // no disclosure within the wait: question-answer form
    expect(callsOf('sendQuestion')).toHaveLength(questions + 1)
    const questionThread = (await running.agent.sessions.get(session.id))?.binding?.questionThreadId
    expect(questionThread).toBeTruthy()

    await disclose(connectionId)
    await settle()
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links + 1)
    const link = last<[{ flowId: string; request: { invitationId: string; codes: null } }]>('sendLinkSessionRequest')[0]
    expect(link.request.invitationId).toBe(session.binding?.nonce)
    expect(link.request.codes).toBeNull()
    const asked = (await running.agent.sessions.get(session.id))?.binding
    const threadId = (callsOf('sendLinkSessionRequest').at(-1)?.result as { threadId: string } | undefined)?.threadId
    expect(asked?.questionThreadId).toBe(threadId)
    expect(asked?.flowId).toBe(link.flowId)

    // a second disclosure does not ask again
    await disclose(connectionId)
    await settle()
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links + 1)

    // the old question thread no longer binds; the flow's answer does
    await events.handle(
      envelope('didcomm.question-answer.answer-received', { connectionId, threadId: questionThread, response: 'Yes' })
    )
    await settle()
    expect((await running.agent.sessions.get(session.id))?.state).toBe('provisional')
    await events.handle(
      envelope('didcomm.link-session.state-changed', {
        threadId,
        flowId: link.flowId,
        connectionId,
        state: 'response-received',
        response: { link: true, code: null },
      })
    )
    await settle()
    expect((await running.agent.sessions.get(session.id))?.state).toBe('bound')
  })

  it('does not ask again for a disclosure without ayni-flow', async () => {
    const connectionId = 'conn-reuse-v3'
    await connectUndisclosed(connectionId)
    const created = await createUiSession()
    const session = (await running.agent.sessions.get(created.sessionId)) as Session
    const links = callsOf('sendLinkSessionRequest').length
    await reuse(connectionId, session)
    await events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'updated',
        metadata: { 'https://didcomm.org/questionanswer/1.0': feature('https://didcomm.org/questionanswer/1.0') },
      })
    )
    await settle()
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links)
    expect((await running.agent.sessions.get(session.id))?.binding?.flowId).toBeUndefined()
  })
})

describe('device challenge as a confirm flow (INTX-AUTH-009, D55)', () => {
  it('opens a confirm flow with a card in the conversation, completes on confirmed: true and closes it', async () => {
    const created = await createUiSession()
    const session = (await running.agent.sessions.get(created.sessionId)) as Session
    const connectionId = 'conn-confirm'
    await connectFlowCapable(connectionId, session.binding?.outOfBandId)
    await settle()
    const link = last<[{ flowId: string }]>('sendLinkSessionRequest')[0]
    await events.handle(
      envelope('didcomm.link-session.state-changed', {
        threadId: (await running.agent.sessions.get(session.id))?.binding?.questionThreadId,
        flowId: link.flowId,
        connectionId,
        state: 'response-received',
        response: { link: true },
      })
    )
    await settle()
    const uiSession = (await running.agent.sessions.get(session.id)) as Session
    const principal = await running.agent.principalOf(uiSession)
    if (!principal) throw new Error('no principal')

    const run = running.agent.challenges.run({
      principal,
      originSession: uiSession,
      toolName: 'wire_money',
      policy: { type: 'device' },
      purpose: 'Wire 100 EUR',
    })
    await settle()
    const open = last<[{ kind: string; title: string; origin: { sessionId?: string } }]>('openFlow')[0]
    expect(open.kind).toBe('confirm')
    expect(open.origin.sessionId).toBe(uiSession.id)
    const confirm =
      last<[{ flowId: string; request: { text: string; code: string; attested: boolean } }]>('sendConfirmRequest')[0]
    expect(confirm.request).toMatchObject({ text: 'Confirm: Wire 100 EUR', attested: true })
    expect(confirm.request.code).toHaveLength(6)

    // the card is in the conversation, pending
    let messages = await history(uiSession.id, created.sessionToken)
    let card = messages.find((m) => m.activityType === 'ayni.flow')
    expect(card?.content).toMatchObject({ kind: 'confirm', state: 'pending', flowId: confirm.flowId })

    const pending = (await running.agent.store.challenges.listPending()).find(
      (c) => c.details?.flowId === confirm.flowId
    )
    if (!pending) throw new Error('challenge not pending')
    await events.handle(
      envelope('didcomm.confirm.state-changed', {
        threadId: pending.details?.threadId,
        flowId: confirm.flowId,
        connectionId,
        state: 'response-received',
        response: { confirmed: true, attestation: { method: 'biometric', at: new Date().toISOString() } },
      })
    )
    const { outcome, record } = await run
    expect(outcome).toBe('completed')
    expect(record?.details?.attestation).toMatchObject({ method: 'biometric' })
    const close = last<[string, { outcome: string }]>('closeFlow')
    expect(close[0]).toBe(confirm.flowId)
    expect(close[1].outcome).toBe('completed')
    await settle()
    // the same card, replaced in place, closed
    messages = await history(uiSession.id, created.sessionToken)
    const cards = messages.filter((m) => m.activityType === 'ayni.flow')
    expect(cards).toHaveLength(1)
    card = cards[0]
    expect(card?.content).toMatchObject({ state: 'completed', outcome: 'completed', flowId: confirm.flowId })
    expect((card.metadata as { flowId?: string }).flowId).toBe(confirm.flowId)
    // the challenge note is not shown twice (the card is the record)
    expect(messages.some((m) => m.activityType === 'ayni.capability')).toBe(false)
  })

  it('fails the challenge when the holder closes the flow declined', async () => {
    const connectionId = 'conn-confirm'
    const bound = await running.agent.didcommSession(connectionId)
    if (!bound) throw new Error('no bound connection')
    const uiSessions = await running.agent.store.sessions.listByPrincipal(bound.principal.id, ['bound'])
    const uiSession = uiSessions.find((s) => s.channelType === 'ag-ui') as Session
    const run = running.agent.challenges.run({
      principal: bound.principal,
      originSession: uiSession,
      toolName: 'wire_money',
      policy: { type: 'device' },
      purpose: 'Wire 500 EUR',
    })
    await settle()
    const confirm = last<[{ flowId: string }]>('sendConfirmRequest')[0]
    const record = client.flows.get(confirm.flowId) as FlowRecord
    await events.handle(
      envelope('didcomm.ayni-flow.state-changed', {
        ...record,
        state: 'declined',
        closedBy: 'peer',
        closedAt: new Date().toISOString(),
        previousState: 'active',
      })
    )
    const { outcome } = await run
    expect(outcome).toBe('failed')
  })
})

describe('identity as flows (IDENT-RES-003, D54)', () => {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
  const pack = {
    metadata: { displayName: 'Test agent' },
    identity: {
      homeBackingIdentity: 'did:webvh:x:home',
      recognizedBackingIdentities: [],
      roleRules: [],
      userAgentGate: 'optional',
      unidentifiedPeers: 'admit',
      credentials: { userAgent: { schemaId: 'ecs-user-agent' }, badge: [{ schemaId: 'ecs-badge' }] },
    },
  } as unknown as AgentPack

  it('requests the user-agent credential as identify-ua, treats unsupported-kind as absent, and the badge as present', async () => {
    const localCalls: Call[] = []
    const local = stubClient(localCalls)
    const logger = createLogger('silent')
    const localFlows = new FlowService(
      local as never,
      running.agent.memory,
      running.agent.router,
      running.agent.store.kv,
      logger
    )
    const identity = new IdentityFlow(pack, local as never, {} as never, false, silent as never)
    identity.setFlows(localFlows)
    const establishing = identity.establish('conn-id', 'did:peer:alice', { flowMode: true })
    await settle()
    // identify-ua: the app does not implement the kind
    const ua = localCalls.filter((c) => c.method === 'openFlow').at(-1)?.args[0] as { kind: string }
    expect(ua.kind).toBe('identify-ua')
    const uaRequest = localCalls.filter((c) => c.method === 'requestPresentation').at(-1)?.args as unknown[]
    const uaFlowId = [...local.flows.keys()].at(-1) as string
    expect(uaRequest[3]).toBe(uaFlowId) // parentThreadId = flow id
    await localFlows.onFlowEvent({
      ...(local.flows.get(uaFlowId) as FlowRecord),
      state: 'failed',
      errorCode: 'unsupported-kind',
      closedBy: 'peer',
    })
    await settle()
    // present: the badge, verified
    const badge = localCalls.filter((c) => c.method === 'openFlow').at(-1)?.args[0] as { kind: string; title: string }
    expect(badge.kind).toBe('present')
    expect(badge.title).toContain('Test agent')
    const presentationCall = localCalls.filter((c) => c.method === 'requestPresentation').at(-1)
    if (!presentationCall) throw new Error('no presentation request')
    const { proofExchangeId } = presentationCall.result as { proofExchangeId: string }
    identity.onPresentation({
      proofExchangeId,
      state: 'done',
      verified: true,
      claims: [
        { name: 'issuerDid', value: 'did:webvh:x:issuer' },
        { name: 'badgeNumber', value: '42' },
        { name: 'userName', value: 'Alice' },
      ],
    })
    const facts = await establishing
    expect(facts).toMatchObject({ connectionType: 'verifiable-user-agent', userAgentVerified: false })
    expect(facts?.claims.userName).toBe('Alice')
    const close = localCalls.filter((c) => c.method === 'closeFlow').at(-1)?.args as [string, { outcome: string }]
    expect(close[1].outcome).toBe('completed')
  })
})

describe('pending cap (INTX-FLOW-005)', () => {
  it('lets ten flows pend on a connection and makes the eleventh wait until one closes', async () => {
    const localCalls: Call[] = []
    const local = stubClient(localCalls)
    const logger = createLogger('silent')
    const svc = new FlowService(
      local as never,
      running.agent.memory,
      running.agent.router,
      running.agent.store.kv,
      logger
    )
    const handles = []
    for (let i = 0; i < 10; i++)
      handles.push(await svc.open({ connectionId: 'conn-cap', kind: 'confirm', title: `t${i}` }))
    let eleventh: unknown
    const waiting = svc.open({ connectionId: 'conn-cap', kind: 'confirm', title: 't10' }).then((h) => (eleventh = h))
    await settle()
    expect(eleventh).toBeUndefined()
    expect(svc.pendingOn('conn-cap')).toBe(10)
    await svc.close(handles[0].flowId, 'completed')
    await waiting
    expect(eleventh).toBeDefined()
    expect(svc.pendingOn('conn-cap')).toBe(10)
  })
})
