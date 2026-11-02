/**
 * Wake-ups and attested approvals on flow-capable wallets (D57, D58; INTX-NOTIFY-001/002, INTX-APPR-011): a reply
 * that lands while no screen shows the conversation sends one `notify`; a live screen sends none; an approval rule
 * with `attested: true` reaches the approver's phone as an `authorize` flow whose decision carries its attestation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import type { SessionStreams } from '../src/channels/agui/streams.js'
import { DidcommAdapter, MediaLinks } from '../src/channels/didcomm/adapter.js'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { AYNI_FLOW_PROTOCOL, PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import { FlowService } from '../src/core/flows.js'
import type { Session } from '../src/core/types.js'
import { createLogger } from '../src/util/logger.js'
import { startTestAgent } from './helpers.js'

type Call = { method: string; args: unknown[]; result?: unknown }

function stubClient(calls: Call[]) {
  let n = 0
  const rec = (method: string, answer: (...args: unknown[]) => unknown) => {
    return async (...args: unknown[]) => {
      const call: Call = { method, args }
      calls.push(call)
      call.result = answer(...args)
      return call.result
    }
  }
  return {
    sendText: rec('sendText', () => ({ id: `msg-${++n}` })),
    sendQuestion: rec('sendQuestion', () => ({ id: `q-${++n}` })),
    sendActionMenu: rec('sendActionMenu', () => ({ id: `menu-${++n}` })),
    deleteConnection: async () => undefined,
    openFlow: rec('openFlow', (body) => ({
      ...(body as object),
      flowId: `flow-${++n}`,
      state: 'pending',
      createdAt: new Date().toISOString(),
    })),
    closeFlow: rec('closeFlow', (flowId, body) => ({ flowId, ...(body as object) })),
    flowProblemReport: rec('flowProblemReport', (flowId, body) => ({ flowId, state: 'failed', ...(body as object) })),
    grantSession: rec('grantSession', (threadId, grant) => ({ threadId, state: 'response-sent', response: grant })),
    sendAuthorizeRequest: rec('sendAuthorizeRequest', (body) => {
      const b = body as { connectionId: string; flowId: string }
      return { threadId: `authz-${++n}`, flowId: b.flowId, connectionId: b.connectionId, state: 'request-sent' }
    }),
    sendNotification: rec('sendNotification', () => ({ id: `notif-${++n}` })),
  }
}

const feature = (id: string) => JSON.stringify({ 'feature-type': 'protocol', id, roles: ['holder'] })
const envelope = (type: string, data: Record<string, unknown>) => ({
  id: `evt-${Math.random()}`,
  type,
  timestamp: new Date().toISOString(),
  data,
})
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

let running: RunningAgent
let events: DidcommEvents
let calls: Call[]
const callsOf = (method: string) => calls.filter((c) => c.method === method)

beforeAll(async () => {
  running = await startTestAgent({ publicBaseUrl: 'https://welcome.test' })
  calls = []
  const logger = createLogger('silent')
  const client = stubClient(calls)
  const peers = new PeerProfiles(running.agent.store.kv, logger)
  const flows = new FlowService(
    client as never,
    running.agent.memory,
    running.agent.router,
    running.agent.store.kv,
    logger
  )
  const adapter = new DidcommAdapter(
    client as never,
    'https://welcome.test',
    new MediaLinks(1000),
    undefined,
    peers,
    logger
  )
  adapter.attach(running.agent)
  adapter.setFlows(flows)
  running.agent.router.register(adapter)
  Object.assign(running.agent, { flows })
  const home = running.agent.pack.identity.homeBackingIdentity
  // the approver is a manager of the home organization; everyone else an unidentified guest
  const identity = {
    establish: async (connectionId: string) =>
      connectionId === 'conn-manager'
        ? {
            connectionType: 'verifiable-user-agent' as const,
            actorIdentity: 'did:peer:mia',
            backingIdentity: { kind: 'org' as const, id: home, name: 'Home' },
            claims: { userName: 'Mia', title: 'Manager' },
            userAgentVerified: false,
            identityCredentialRef: 'badge:mia',
          }
        : {
            connectionType: 'verifiable-user-agent' as const,
            actorIdentity: `did:peer:${connectionId}`,
            backingIdentity: null,
            claims: { userName: 'Ana' },
            userAgentVerified: false,
            identityCredentialRef: null,
          },
  }
  events = new DidcommEvents(running.agent, client as never, identity as never, adapter, peers, undefined, logger, 100)
})

afterAll(async () => {
  await running.stop()
})

async function connectFlowCapable(connectionId: string) {
  const completed = events.handle(
    envelope('didcomm.connections.state-updated', {
      id: connectionId,
      state: 'completed',
      theirDid: `did:peer:${connectionId}`,
      theirLabel: 'Ayni',
      outOfBandId: null,
      metadata: {},
    })
  )
  await events.handle(
    envelope('didcomm.connections.state-updated', {
      id: connectionId,
      state: 'updated',
      metadata: {
        [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL),
        'https://didcomm.org/notify/1.0': feature('https://didcomm.org/notify/1.0'),
        'https://didcomm.org/authorize/1.0': feature('https://didcomm.org/authorize/1.0'),
      },
    })
  )
  await completed
}

/** The app binds its own session through the grant (as in tests/sessionGrant.test.ts). */
async function appSession(connectionId: string) {
  await events.handle(
    envelope('didcomm.session-grant.state-changed', {
      threadId: `sg-${connectionId}`,
      connectionId,
      state: 'request-received',
      request: {
        agentDid: 'did:webvh:test:agent',
        newConversation: false,
        client: { description: 'Ayni on iPhone', platform: 'ios', appVersion: '1.0.0' },
      },
    })
  )
  const granted = callsOf('grantSession').at(-1)?.args[1] as { grant: string }
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    payload: { client: { name: 'ayni-app', version: '1.0.0', platform: 'ios' }, locale: 'en', grant: granted.grant },
  })
  if (response.statusCode !== 201) throw new Error(`session ${response.statusCode}: ${response.body}`)
  return response.json() as { sessionId: string; sessionToken: string; conversationId?: string }
}

async function run(sessionId: string, token: string, text: string) {
  return running.app.inject({
    method: 'POST',
    url: `/agui/v3/sessions/${sessionId}/runs`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      threadId: sessionId,
      runId: `run-${Date.now()}-${Math.random()}`,
      messages: [{ id: 'u1', role: 'user', content: text }],
      tools: [],
      context: [],
    },
  })
}

describe('wake-ups (D57, INTX-NOTIFY-001)', () => {
  it('sends one notify for a reply that lands while no screen shows the conversation, none while one does', async () => {
    const connectionId = 'conn-notify'
    await connectFlowCapable(connectionId)
    const app = await appSession(connectionId)
    const session = (await running.agent.sessions.get(app.sessionId)) as Session
    // the welcome of the new session already woke the phone once: the app has no stream attached yet
    const welcomeWakeups = callsOf('sendNotification').length
    expect(welcomeWakeups).toBeGreaterThanOrEqual(1)

    const first = await run(app.sessionId, app.sessionToken, 'hello phone')
    expect(first.statusCode).toBe(200)
    await settle()
    const wakeups = callsOf('sendNotification')
    expect(wakeups.length).toBe(welcomeWakeups + 1)
    const last = wakeups.at(-1)?.args[0] as { connectionId: string; notification: Record<string, unknown> }
    expect(last.connectionId).toBe(connectionId)
    expect(last.notification).toMatchObject({
      conversationId: session.conversationId,
      sessionId: session.id,
      collapseKey: session.conversationId,
      priority: 'normal',
    })
    expect(String(last.notification.preview)).toContain('You said: hello phone')

    // a screen is live on the conversation: no wake-up
    const agui = running.agent.router.adapter('ag-ui') as unknown as { streams: SessionStreams }
    const detach = agui.streams.attach(session.id, { write: () => undefined, end: () => undefined })
    const second = await run(app.sessionId, app.sessionToken, 'still here')
    expect(second.statusCode).toBe(200)
    await settle()
    expect(callsOf('sendNotification').length).toBe(welcomeWakeups + 1)
    detach()
  })

  it('sends nothing to a wallet that did not disclose notify/1.0, and never through a push service', async () => {
    const connectionId = 'conn-silent'
    const completed = events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'completed',
        theirDid: 'did:peer:conn-silent',
        outOfBandId: null,
        metadata: {},
      })
    )
    await events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'updated',
        metadata: { [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL) },
      })
    )
    await completed
    const before = callsOf('sendNotification').length
    const app = await appSession(connectionId)
    await run(app.sessionId, app.sessionToken, 'quiet')
    await settle()
    expect(callsOf('sendNotification').length).toBe(before)
  })
})

describe('attested approvals as authorize flows (D58, INTX-APPR-011)', () => {
  it('routes the request to the approver phone and records the attestation on the decision', async () => {
    await connectFlowCapable('conn-manager')
    await connectFlowCapable('conn-ana')
    const manager = await running.agent.didcommSession('conn-manager')
    const ana = await running.agent.didcommSession('conn-ana')
    if (!manager || !ana) throw new Error('peers not connected')
    expect(manager.principal.roles).toContain('manager')

    const record = await running.agent.approvals.requestSensitivity({
      principal: ana.principal,
      role: 'guest',
      originSessionId: ana.session.id,
      toolName: 'echo',
      args: { text: 'hi' },
      rule: { tools: ['echo'], approvers: ['manager'], attested: true },
    })
    await settle()
    const open = callsOf('openFlow').at(-1)?.args[0] as { connectionId: string; kind: string; title: string }
    expect(open).toMatchObject({ connectionId: 'conn-manager', kind: 'authorize' })
    expect(open.title).toContain('Ana')
    const request = callsOf('sendAuthorizeRequest').at(-1)
    if (!request) throw new Error('no authorize request')
    const body = request.args[0] as { flowId: string; request: Record<string, unknown> }
    expect(body.request).toMatchObject({
      requester: { name: 'Ana' },
      scope: ['tool:echo'],
      attested: true,
      expiresAt: record.expiresAt,
    })
    expect(callsOf('sendQuestion')).toHaveLength(0) // no question-answer card on the phone

    const { threadId } = request.result as { threadId: string }
    await events.handle(
      envelope('didcomm.authorize.state-changed', {
        threadId,
        flowId: body.flowId,
        connectionId: 'conn-manager',
        state: 'response-received',
        response: {
          decision: 'approved',
          attestation: { method: 'biometric', at: new Date().toISOString() },
          comment: null,
        },
      })
    )
    await settle()
    const decided = await running.agent.store.approvals.get(record.id)
    expect(decided?.status).toBe('APPROVED')
    expect(decided?.decisions[0]).toMatchObject({
      approverName: 'Mia',
      decision: 'approve',
      attestation: { method: 'biometric' },
    })
    const close = callsOf('closeFlow').filter((c) => c.args[0] === body.flowId)
    expect(close).toHaveLength(1)
    expect((close[0].args[1] as { outcome: string }).outcome).toBe('completed')
  })

  it('still answers an authorize response after a restart (the flow reference is persisted)', async () => {
    const ana = await running.agent.didcommSession('conn-ana')
    if (!ana) throw new Error('peer not connected')
    const record = await running.agent.approvals.requestSensitivity({
      principal: ana.principal,
      role: 'guest',
      originSessionId: ana.session.id,
      toolName: 'echo',
      args: {},
      rule: { tools: ['echo'], approvers: ['manager'], attested: true },
    })
    await settle()
    const request = callsOf('sendAuthorizeRequest').at(-1)
    if (!request) throw new Error('no authorize request')
    const body = request.args[0] as { flowId: string }
    // a fresh process: new adapter, flow service and event handler over the same store and DIDComm agent
    const logger = createLogger('silent')
    const client = stubClient(calls)
    const peers = new PeerProfiles(running.agent.store.kv, logger)
    const flows = new FlowService(
      client as never,
      running.agent.memory,
      running.agent.router,
      running.agent.store.kv,
      logger
    )
    const adapter = new DidcommAdapter(
      client as never,
      'https://welcome.test',
      new MediaLinks(1000),
      undefined,
      peers,
      logger
    )
    adapter.attach(running.agent)
    adapter.setFlows(flows)
    Object.assign(running.agent, { flows })
    const restarted = new DidcommEvents(
      running.agent,
      client as never,
      {} as never,
      adapter,
      peers,
      undefined,
      logger,
      100
    )
    await restarted.handle(
      envelope('didcomm.authorize.state-changed', {
        threadId: (request.result as { threadId: string }).threadId,
        flowId: body.flowId,
        connectionId: 'conn-manager',
        state: 'response-received',
        response: { decision: 'rejected', attestation: { method: 'passcode', at: new Date().toISOString() } },
      })
    )
    await settle()
    const decided = await running.agent.store.approvals.get(record.id)
    expect(decided?.status).toBe('REJECTED')
    expect(decided?.decisions[0]?.attestation).toMatchObject({ method: 'passcode' })
    const close = callsOf('closeFlow').filter((c) => c.args[0] === body.flowId)
    expect(close).toHaveLength(1)
  })

  it('does not open a flow for a non-attested rule', async () => {
    const ana = await running.agent.didcommSession('conn-ana')
    if (!ana) throw new Error('peer not connected')
    const before = callsOf('openFlow').length
    await running.agent.approvals.requestSensitivity({
      principal: ana.principal,
      role: 'guest',
      originSessionId: ana.session.id,
      toolName: 'echo',
      args: {},
      rule: { tools: ['echo'], approvers: ['manager'] },
    })
    await settle()
    expect(callsOf('openFlow').length).toBe(before)
  })
})
