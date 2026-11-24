/**
 * Flows on a flow-capable capability channel (D54, D55; INTX-FLOW-001..005, INTX-AUTH-009, CHAN-BIND-009):
 * binding through `link-session`, the device challenge as a `confirm` flow with its card in the conversation,
 * identity requests as flows, the pending cap and the holder's closures.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { DidcommAdapter, MediaLinks, MRTD_PROTOCOL } from '../src/channels/didcomm/adapter.js'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { IdentityFlow, TrustResolver } from '../src/channels/didcomm/identity.js'
import { AYNI_FLOW_PROTOCOL, PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import type { FlowRecord } from '../src/channels/didcomm/vsAgentClient.js'
import type { AgentPack } from '../src/config/packTypes.js'
import { FlowService } from '../src/core/flows.js'
import { greetingFor } from '../src/core/interaction.js'
import type { Principal, Session } from '../src/core/types.js'
import { createLogger } from '../src/util/logger.js'
import { badgeAuthentication, startTestAgent } from './helpers.js'

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
    requestEmrtd: rec('requestEmrtd', () => ({ id: `emrtd-${++n}` })),
    // authenticate/1.0 (flow profile §6.14): the plugin's routes answer with the exchange
    sendAuthenticateRequest: rec('sendAuthenticateRequest', (body) => {
      const b = body as { connectionId: string; flowId: string; request: unknown }
      return {
        threadId: `auth-${++n}`,
        flowId: b.flowId,
        connectionId: b.connectionId,
        role: 'requester',
        state: 'request-sent',
        request: b.request,
        steps: [],
        createdAt: new Date().toISOString(),
      }
    }),
    sendAuthenticateStep: rec('sendAuthenticateStep', (threadId) => ({ threadId, state: 'step-sent', steps: [] })),
    sendAuthenticateStepResult: rec('sendAuthenticateStepResult', (threadId) => ({
      threadId,
      state: 'step-result-sent',
      steps: [],
    })),
  }
}

/** The phone chooses a combination of the last authentication asked (flow profile §6.14, `choice`). */
function chooses(identity: IdentityFlow, calls: Call[], combination = ['badge']) {
  const request = calls.filter((c) => c.method === 'sendAuthenticateRequest').at(-1) as Call
  const exchange = request.result as { threadId: string; flowId: string; connectionId: string }
  identity.authenticator.onExchange({
    ...exchange,
    role: 'requester',
    state: 'choice-received',
    combination,
    steps: [],
    request: { purpose: 'connection', methods: {}, combinations: [] },
    createdAt: new Date().toISOString(),
  })
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

/** A new connection, as VS Agent 2.x reports it: the invitation record that produced it as `invitationId` (CHAN-BIND-017). */
async function connectFlowCapable(connectionId: string, invitationId?: string) {
  const completed = events.handle(
    envelope('didcomm.connections.state-updated', {
      id: connectionId,
      state: 'completed',
      theirDid: `did:peer:${connectionId}`,
      theirLabel: 'Ayni',
      invitationId: invitationId ?? null,
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
      last<[{ flowId: string; request: { invitationId: string; browser: { platform: string }; codes: string[] } }]>(
        'sendLinkSessionRequest'
      )[0]
    expect(link.request.invitationId).toBe(session.binding?.nonce)
    expect(link.request.browser.platform).toBe('web')
    // the scan path carries the three codes too, one of them the browser's (D5 as amended on 2026-11-21)
    expect(link.request.codes).toHaveLength(3)
    expect(link.request.codes).toContain(session.binding?.bindingCode)
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
        response: { link: true, code: session.binding?.bindingCode },
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

describe('the greeting of a linked session (INTX-MENU-001, PROF-CONV-006)', () => {
  const reuse = (connectionId: string, session: Session) =>
    events.handle(
      envelope('didcomm.out-of-band.handshake-reused', {
        outOfBandId: session.binding?.outOfBandId,
        invitationId: session.binding?.nonce,
        connectionId,
        reuseThreadId: `reuse-${connectionId}-${session.id}`,
      })
    )
  const answerLink = async (connectionId: string, session: Session) => {
    const link = last<[{ flowId: string }]>('sendLinkSessionRequest')[0]
    await events.handle(
      envelope('didcomm.link-session.state-changed', {
        threadId: (await running.agent.sessions.get(session.id))?.binding?.questionThreadId,
        flowId: link.flowId,
        connectionId,
        state: 'response-received',
        response: { link: true, code: session.binding?.bindingCode },
      })
    )
    await settle()
  }

  it('greets the session that starts a conversation, not the one linked later that continues it', async () => {
    const connectionId = 'conn-greet'
    const first = await createUiSession()
    const started = (await running.agent.sessions.get(first.sessionId)) as Session
    await connectFlowCapable(connectionId, started.binding?.outOfBandId)
    await settle()
    await answerLink(connectionId, started)
    const bound = (await running.agent.sessions.get(started.id)) as Session
    expect(bound.state).toBe('bound')
    const greeting = greetingFor(running.agent.pack, (await running.agent.principalOf(bound)) ?? null)
    const greetings = async (sessionId: string, token: string) =>
      (await history(sessionId, token)).filter((m) => m.content === greeting).length
    expect(await greetings(first.sessionId, first.sessionToken)).toBe(1)

    // the person reconnects the browser: a new session, linked by the same phone, continues the conversation
    const second = await createUiSession()
    const later = (await running.agent.sessions.get(second.sessionId)) as Session
    const links = callsOf('sendLinkSessionRequest').length
    await reuse(connectionId, later)
    await settle()
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links + 1)
    await answerLink(connectionId, later)
    const continued = (await running.agent.sessions.get(later.id)) as Session
    expect(continued.state).toBe('bound')
    expect(continued.conversationId).toBe(bound.conversationId)
    // its history holds the conversation's one greeting; no second one was written
    expect(await greetings(second.sessionId, second.sessionToken)).toBe(1)
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
        invitationId: null,
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
    const link =
      last<[{ flowId: string; request: { invitationId: string; codes: string[] } }]>('sendLinkSessionRequest')[0]
    expect(link.request.invitationId).toBe(session.binding?.nonce)
    expect(link.request.codes).toContain(session.binding?.bindingCode)
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
        response: { link: true, code: session.binding?.bindingCode },
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
        response: { link: true, code: session.binding?.bindingCode },
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

  it('closes a confirm answered no as completed, as any answer, and fails the challenge (flow profile §6, row confirm)', async () => {
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
      purpose: 'Wire 200 EUR',
    })
    await settle()
    const confirm = last<[{ flowId: string }]>('sendConfirmRequest')[0]
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
        response: { confirmed: false, attestation: { method: 'biometric', at: new Date().toISOString() } },
      })
    )
    const { outcome } = await run
    // the person said no: the action does not go on
    expect(outcome).toBe('failed')
    // but the flow was answered: it closes completed, with no reason, and the phone shows the person's own answer
    const close = last<[string, { outcome: string; reason?: string }]>('closeFlow')
    expect(close[0]).toBe(confirm.flowId)
    expect(close[1].outcome).toBe('completed')
    expect(close[1].reason).toBeUndefined()
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

/**
 * The specimen passport of the BSI reference data set (tests/document.test.ts). It expired in 2023, so the read
 * of a valid document uses the same zone with a later date of expiry and its check digits made again.
 */
const documentFixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/document/${name}`, import.meta.url)))
function checkDigit(text: string): string {
  const value = (c: string) => (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55)
  return String([...text].reduce((sum, c, i) => sum + value(c) * [7, 3, 1][i % 3], 0) % 10)
}
function dg1ExpiringOn(yymmdd: string): Buffer {
  const line1 = 'P<D<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<<<<<<<<<<'
  const number = 'C11T002JM4'
  const birth = '9608122'
  const expiry = yymmdd + checkDigit(yymmdd)
  const personal = '<<<<<<<<<<<<<<<'
  const line2 = `${number}D<<${birth}F${expiry}${personal}`
  const zone = line1 + line2 + checkDigit(number + birth + expiry + personal)
  return Buffer.concat([Buffer.from([0x61, zone.length + 3, 0x5f, 0x1f, zone.length]), Buffer.from(zone, 'latin1')])
}
const chipData = (dg1: Buffer, verification?: object) => ({
  raw: { DG1: dg1.toString('base64'), DG2: documentFixture('DG2.bin').toString('base64') },
  ...(verification ? { verification } : {}),
})

describe('the document read as an nfc-read flow (INTX-AUTH-010, PRIV-EVID-011, D73)', () => {
  const connectionId = 'conn-confirm'
  async function challenge() {
    const bound = await running.agent.didcommSession(connectionId)
    if (!bound) throw new Error('no bound connection')
    const uiSessions = await running.agent.store.sessions.listByPrincipal(bound.principal.id, ['bound'])
    const uiSession = uiSessions.find((s) => s.channelType === 'ag-ui') as Session
    const run = running.agent.challenges.run({
      principal: bound.principal,
      originSession: uiSession,
      toolName: 'issue_credential',
      policy: { type: 'document' },
      purpose: 'Badge from a passport',
    })
    await settle()
    return { run, principal: bound.principal }
  }
  const lastRead = async (principalId: string) =>
    (await running.agent.store.evidence.list(principalId)).filter((e) => e.kind === 'document').at(-1)

  it('is not asked of a phone that did not say it can read a chip', async () => {
    const before = callsOf('requestEmrtd').length
    const { run } = await challenge()
    expect((await run).outcome).toBe('unavailable')
    expect(callsOf('requestEmrtd')).toHaveLength(before)
  })

  it('one request for the chip under the flow; a valid document that verifies is kept and passes', async () => {
    // the phone now says it speaks the protocol
    await events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'updated',
        metadata: {
          [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL),
          'https://didcomm.org/confirm/1.0': feature('https://didcomm.org/confirm/1.0'),
          'https://didcomm.org/link-session/1.0': feature('https://didcomm.org/link-session/1.0'),
          [MRTD_PROTOCOL]: feature(MRTD_PROTOCOL),
        },
      })
    )
    const { run, principal } = await challenge()
    const open = last<[{ kind: string; expiresTime: string }]>('openFlow')[0]
    expect(open.kind).toBe('nfc-read')
    // five minutes to read a document
    expect(Date.parse(open.expiresTime) - Date.now()).toBeGreaterThan(4 * 60_000)
    const [asked, flowId] = last<[string, string]>('requestEmrtd')
    expect(asked).toBe(connectionId)
    const pending = (await running.agent.store.challenges.listPending()).find((c) => c.details?.flowId === flowId)
    if (!pending) throw new Error('challenge not pending')
    await events.handle(
      envelope('didcomm.mrtd.emrtd-data-received', {
        connectionId,
        threadId: pending.details?.threadId,
        dataGroups: chipData(dg1ExpiringOn('351031'), { authenticity: true, integrity: true }),
      })
    )
    expect((await run).outcome).toBe('completed')
    const close = last<[string, { outcome: string; references?: { type: string; id: string }[] }]>('closeFlow')
    expect(close[0]).toBe(flowId)
    expect(close[1]).toMatchObject({ outcome: 'completed', references: [{ type: 'document', id: 'passport' }] })
    const record = await lastRead(principal.id)
    expect(record).toMatchObject({ kind: 'document', entry: 'document', outcome: 'verified' })
    // the audit names what was read; no value is in it
    expect(record?.revealed).toContain('documentNumber')
    expect(JSON.stringify(record)).not.toMatch(/MUSTERMANN|C11T002JM/)
  })

  it('an expired document is recorded with its reason and no value, and the flow is closed as not valid', async () => {
    const { run, principal } = await challenge()
    const [, flowId] = last<[string, string]>('requestEmrtd')
    const pending = (await running.agent.store.challenges.listPending()).find((c) => c.details?.flowId === flowId)
    await events.handle(
      envelope('didcomm.mrtd.emrtd-data-received', {
        connectionId,
        threadId: pending?.details?.threadId,
        // the specimen as it is: expired on 2023-10-31
        dataGroups: chipData(documentFixture('DG1.bin'), { authenticity: true, integrity: true }),
      })
    )
    const { outcome, record } = await run
    expect(outcome).toBe('failed')
    expect(record?.details?.reason).toBe('document-expired')
    const report = last<[string, { code: string }]>('flowProblemReport')
    expect(report[0]).toBe(flowId)
    expect(report[1].code).toBe('not-valid')
    expect(await lastRead(principal.id)).toMatchObject({ outcome: 'refused', reason: 'expired', stored: [] })
  })

  it('a document the DIDComm agent did not verify is not kept, whatever it says', async () => {
    for (const [verification, reason] of [
      [{ authenticity: true, integrity: false }, 'document-not-verified'],
      [{ authenticity: false, integrity: true }, 'document-not-verified'],
      [undefined, 'document-no-verification'],
    ] as const) {
      const { run, principal } = await challenge()
      const [, flowId] = last<[string, string]>('requestEmrtd')
      const pending = (await running.agent.store.challenges.listPending()).find((c) => c.details?.flowId === flowId)
      await events.handle(
        envelope('didcomm.mrtd.emrtd-data-received', {
          connectionId,
          threadId: pending?.details?.threadId,
          dataGroups: chipData(dg1ExpiringOn('351031'), verification),
        })
      )
      const { outcome, record } = await run
      expect(outcome).toBe('failed')
      expect(record?.details?.reason).toBe(reason)
      expect((await lastRead(principal.id))?.outcome).toBe('refused')
    }
  })

  it('a person who declines on the phone fails the challenge as declined', async () => {
    const { run } = await challenge()
    const [, flowId] = last<[string, string]>('requestEmrtd')
    const pending = (await running.agent.store.challenges.listPending()).find((c) => c.details?.flowId === flowId)
    await events.handle(
      envelope('didcomm.mrtd.problem-report-received', {
        connectionId,
        threadId: pending?.details?.threadId,
        reason: 'e.p.emrtd-refused',
      })
    )
    const { outcome, record } = await run
    expect(outcome).toBe('failed')
    expect(record?.details?.reason).toBe('declined')
  })
})

describe('identity as flows (IDENT-RES-003, D54)', () => {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
  const pack = {
    metadata: { displayName: 'Test agent' },
    identity: {
      homeBackingIdentity: 'did:webvh:x:home',
      roleRules: [],
      userAgentGate: 'optional',
      credentials: { userAgent: { schemaId: 'ecs-user-agent' } },
      authentication: badgeAuthentication({
        credential: { jsonSchemaCredentialId: 'https://ecs.example/badge.json' },
        subjectKey: ['badgeNumber'],
      }),
    },
  } as unknown as AgentPack

  it('requests the user-agent credential as identify-ua, treats unsupported-kind as absent, and the badge as authenticate', async () => {
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
    // the issuer of the badge, as trust resolution knows it: a service of an organization
    const resolver = new TrustResolver(undefined, silent as never)
    resolver.resolve = async (did: string) => ({
      did,
      trusted: true,
      ecsCredentials: [
        {
          ecsSchema: 'OrganizationCredential',
          credentialSubject: { name: 'Issuer', countryCode: 'EE', registryId: '1' },
        },
      ],
    })
    const identity = new IdentityFlow(pack, local as never, resolver, false, silent as never)
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
    // authenticate: the badge, chosen on the phone, then verified
    const badge = localCalls.filter((c) => c.method === 'openFlow').at(-1)?.args[0] as { kind: string; title: string }
    expect(badge.kind).toBe('authenticate')
    expect(badge.title).toContain('Test agent')
    chooses(identity, localCalls)
    await settle()
    const presentationCall = localCalls.filter((c) => c.method === 'requestPresentation').at(-1)
    if (!presentationCall) throw new Error('no presentation request')
    const { proofExchangeId } = presentationCall.result as { proofExchangeId: string }
    identity.onPresentation({
      proofExchangeId,
      state: 'done',
      verified: true,
      claims: [
        { name: 'badgeNumber', value: '42' },
        { name: 'userName', value: 'Alice' },
      ],
      credentials: [
        {
          credentialDefinitionId: 'did:webvh:x:issuer/resources/def',
          issuerDid: 'did:webvh:x:issuer',
          claims: [
            { name: 'badgeNumber', value: '42' },
            { name: 'userName', value: 'Alice' },
          ],
          unrevealed: [],
        },
      ],
    })
    const facts = await establishing
    expect(facts).toMatchObject({ connectionType: 'verifiable-user-agent', userAgentVerified: false })
    expect(facts?.claims.userName).toBe('Alice')
    const close = localCalls.filter((c) => c.method === 'closeFlow').at(-1)?.args as [string, { outcome: string }]
    expect(close[1].outcome).toBe('completed')
  })
})

describe('the authentication of a person (D72; IDENT-RES-010/018/019/020, FLOW-SIGNIN)', () => {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
  const BADGE = 'https://ecs.example/badge.json'
  /** Two issuers of the badge, each of an organization of its own: org:EE:1 and org:EE:2. */
  const ISSUER_1 = 'did:webvh:x:issuer-1'
  const ISSUER_2 = 'did:webvh:x:issuer-2'

  function setup(authentication: Partial<Parameters<typeof badgeAuthentication>[0]> = {}) {
    const calls: Call[] = []
    const local = stubClient(calls)
    const flows = new FlowService(
      local as never,
      running.agent.memory,
      running.agent.router,
      running.agent.store.kv,
      createLogger('silent')
    )
    const resolver = new TrustResolver(undefined, silent as never)
    resolver.resolve = async (did: string) => ({
      did,
      trusted: true,
      ecsCredentials: [
        {
          ecsSchema: 'OrganizationCredential',
          credentialSubject: { name: 'Issuer', countryCode: 'EE', registryId: did === ISSUER_2 ? '2' : '1' },
        },
      ],
    })
    const pack = {
      metadata: { displayName: 'Test agent' },
      identity: {
        homeBackingIdentity: 'did:webvh:x:home',
        roleRules: [],
        userAgentGate: 'optional',
        authentication: badgeAuthentication({
          credential: { jsonSchemaCredentialId: BADGE },
          subjectKey: ['badgeNumber'],
          ...authentication,
        }),
      },
    } as unknown as AgentPack
    const identity = new IdentityFlow(pack, local as never, resolver, false, silent as never)
    identity.setFlows(flows)
    const refused: string[] = []
    const establishing = identity.establish(`conn-${Math.random()}`, 'did:peer:alice', {
      flowMode: true,
      onRefused: (code) => refused.push(code),
    })
    const opened = () =>
      calls.filter((c) => c.method === 'openFlow').map((c) => c.result as FlowRecord & { expiresTime: string })
    const flowNow = () => opened().at(-1) as FlowRecord & { expiresTime: string }
    /**
     * The person chooses the badge on the phone, and the wallet presents a badge of an issuer; `unrevealed` are the
     * attributes it leaves private.
     */
    const present = async (issuerDid: string, unrevealed: string[] = []) => {
      chooses(identity, calls)
      await settle()
      const request = calls.filter((c) => c.method === 'requestPresentation').at(-1) as Call
      const claims = [
        { name: 'badgeNumber', value: '42' },
        { name: 'userName', value: 'Alice' },
      ].filter((c) => !unrevealed.includes(c.name))
      identity.onPresentation({
        proofExchangeId: (request.result as { proofExchangeId: string }).proofExchangeId,
        state: 'done',
        verified: true,
        claims,
        credentials: [{ credentialDefinitionId: `${issuerDid}/resources/def`, issuerDid, claims, unrevealed }],
      })
    }
    /**
     * The wallet declines as a wallet does: the problem report of present-proof first, which the DIDComm agent
     * reports as an abandoned presentation in the wallet's words, then the close of the flow.
     */
    const declines = async () => {
      chooses(identity, calls)
      await settle()
      const request = calls.filter((c) => c.method === 'requestPresentation').at(-1) as Call
      const flow = flowNow()
      identity.onPresentation({
        proofExchangeId: (request.result as { proofExchangeId: string }).proofExchangeId,
        state: 'abandoned',
        verified: false,
        claims: [],
        errorMessage: 'abandoned: Request declined',
      })
      await settle()
      await flows.onFlowEvent({ ...flow, state: 'declined', closedBy: 'peer' } as never)
    }
    /** The wallet closes the flow itself: the person declined, or its time ran out. */
    const holder = (state: 'declined' | 'expired') =>
      flows.onFlowEvent({ ...flowNow(), state, closedBy: state === 'expired' ? 'expiry' : 'peer' } as never)
    const problems = () =>
      calls.filter((c) => c.method === 'flowProblemReport').map((c) => (c.args[1] as { code: string }).code)
    return {
      calls,
      establishing,
      refused,
      opened,
      flowNow,
      present,
      holder,
      declines,
      problems,
      identityOf: () => identity,
    }
  }

  it('asks in an authenticate flow valid fifteen minutes, runs the step of the badge chosen, and accepts any accredited issuer', async () => {
    const t = setup()
    await settle()
    const flow = t.flowNow()
    expect(flow.kind).toBe('authenticate')
    expect(flow.title).toBe('Authenticate to Test agent')
    const validMs = Date.parse(flow.expiresTime) - Date.now()
    expect(validMs).toBeGreaterThan(14.9 * 60_000)
    expect(validMs).toBeLessThanOrEqual(15 * 60_000)
    // the request names the purpose, the methods and the combinations (FLOW-SIGNIN-001)
    const sent = t.calls.find((c) => c.method === 'sendAuthenticateRequest')?.args[0] as {
      flowId: string
      request: unknown
    }
    expect(sent).toMatchObject({
      flowId: flow.flowId,
      request: {
        purpose: 'connection',
        methods: { badge: { type: 'credential', credential: { jsonSchemaCredentialId: BADGE } } },
        combinations: [['badge']],
      },
    })
    await t.present(ISSUER_2)
    const facts = await t.establishing
    expect(facts).toMatchObject({ actorIdentity: `org:EE:2|${BADGE}|42`, backingIdentity: { id: 'org:EE:2' } })
    expect(facts?.identityCredentialRef).toMatch(/^badge:/)
    expect(t.opened()).toHaveLength(1)
    expect(t.problems()).toEqual([])
    expect(t.refused).toEqual([])
    // the step, then the presentation request under the flow id, then the step's result (FLOW-SIGNIN-008)
    const step = t.calls.find((c) => c.method === 'sendAuthenticateStep')?.args[1]
    expect(step).toEqual({ step: '1', method: 'badge', type: 'credential' })
    expect(t.calls.find((c) => c.method === 'requestPresentation')?.args[3]).toBe(flow.flowId)
    expect(t.calls.find((c) => c.method === 'sendAuthenticateStepResult')?.args[1]).toEqual({
      step: '1',
      outcome: 'passed',
    })
  })

  it('accepts only the organizations the pack lists: it says why, asks again, and takes the next badge', async () => {
    const t = setup({ issuers: { organizations: ['org:EE:1'] } })
    await settle()
    await t.present(ISSUER_2)
    await settle()
    // not accepted: the flow fails with its reason, and a new request follows
    expect(t.problems()).toEqual(['issuer-not-accepted'])
    expect(t.opened().map((f) => f.kind)).toEqual(['authenticate', 'authenticate'])
    // the step ends failed with the reason before the problem report (flow profile §6.14)
    expect(t.calls.find((c) => c.method === 'sendAuthenticateStepResult')?.args[1]).toEqual({
      step: '1',
      outcome: 'failed',
      reason: 'issuer-not-accepted',
    })
    await t.present(ISSUER_1)
    const facts = await t.establishing
    expect(facts?.backingIdentity).toMatchObject({ id: 'org:EE:1' })
    const close = t.calls.filter((c) => c.method === 'closeFlow').at(-1)?.args as [string, { outcome: string }]
    expect(close).toMatchObject([t.flowNow().flowId, { outcome: 'completed' }])
  })

  it('asks again, with no limit, after a badge that leaves the subject key private; the person ends it by declining', async () => {
    const t = setup()
    await settle()
    for (let attempt = 0; attempt < 3; attempt++) {
      await t.present(ISSUER_1, ['badgeNumber'])
      await settle()
    }
    expect(t.problems()).toEqual(['incomplete', 'incomplete', 'incomplete'])
    expect(t.opened()).toHaveLength(4)
    await t.holder('declined')
    expect(await t.establishing).toBeUndefined()
    expect(t.refused).toEqual(['authentication-declined'])
  })

  it('required: a decline, and no answer in time, each end the connection with their own refusal', async () => {
    const declined = setup()
    await settle()
    await declined.holder('declined')
    expect(await declined.establishing).toBeUndefined()
    expect(declined.refused).toEqual(['authentication-declined'])

    const silentWallet = setup()
    await settle()
    await silentWallet.holder('expired')
    expect(await silentWallet.establishing).toBeUndefined()
    expect(silentWallet.refused).toEqual(['authentication-unanswered'])
  })

  it('offered: a decline lets the person in as a guest; no answer in time still ends the connection', async () => {
    const guest = setup({ visitors: true })
    await settle()
    expect(guest.flowNow().kind).toBe('authenticate')
    await guest.holder('declined')
    expect(await guest.establishing).toMatchObject({
      actorIdentity: 'did:peer:alice',
      backingIdentity: null,
      identityCredentialRef: null,
    })
    expect(guest.refused).toEqual([])

    const silentWallet = setup({ visitors: true })
    await settle()
    await silentWallet.holder('expired')
    expect(await silentWallet.establishing).toBeUndefined()
    expect(silentWallet.refused).toEqual(['authentication-unanswered'])

    // offered, and a badge that is not accepted: asked again, and the person may still enter as a guest
    const retry = setup({ visitors: true, issuers: { organizations: ['org:EE:1'] } })
    await settle()
    await retry.present(ISSUER_2)
    await settle()
    expect(retry.problems()).toEqual(['issuer-not-accepted'])
    await retry.holder('declined')
    expect(await retry.establishing).toMatchObject({ identityCredentialRef: null })
  })

  it('takes the decline of a wallet for a decline: its abandoned presentation is not one that failed to verify', async () => {
    // Found on devnet with a phone: Continue as guest brought the request back. The decline reached the agent
    // as an abandoned presentation, a moment before the flow closed, and was taken for a presentation that did
    // not verify: the agent said `not-valid` and asked again, for ever
    const guest = setup({ visitors: true })
    await settle()
    await guest.declines()
    expect(await guest.establishing).toMatchObject({ identityCredentialRef: null })
    expect(guest.problems()).toEqual([])
    expect(guest.opened()).toHaveLength(1)
    expect(guest.refused).toEqual([])

    const required = setup()
    await settle()
    await required.declines()
    expect(await required.establishing).toBeUndefined()
    expect(required.refused).toEqual(['authentication-declined'])
    expect(required.problems()).toEqual([])
    expect(required.opened()).toHaveLength(1)
  })

  it('still says not-valid, and asks again, of a presentation that came and did not verify', async () => {
    const t = setup({ visitors: true })
    await settle()
    chooses(t.identityOf(), t.calls)
    await settle()
    const request = t.calls.filter((c) => c.method === 'requestPresentation').at(-1) as Call
    t.identityOf().onPresentation({
      proofExchangeId: (request.result as { proofExchangeId: string }).proofExchangeId,
      state: 'abandoned',
      verified: false,
      claims: [],
      errorMessage: 'abandoned: Invalid proof',
    })
    await settle()
    expect(t.problems()).toEqual(['not-valid'])
    expect(t.opened()).toHaveLength(2)
    await t.holder('declined')
    expect(await t.establishing).toMatchObject({ identityCredentialRef: null })
  })

  it('on request: nothing is asked at connection and the person enters as a guest', async () => {
    const t = setup({ request: 'on-demand' })
    expect(await t.establishing).toMatchObject({ identityCredentialRef: null })
    expect(t.opened()).toEqual([])
  })

  it('refuses another identity on the flow of an identified connection, before it closes, and asks nothing again (IDENT-RES-019, FLOW-SIGNIN-004)', async () => {
    const t = setup({ request: 'on-demand' })
    await t.establishing
    const identity = t.identityOf()
    // the connection is bound to the badge number 7; the wallet presents the badge number 42
    const boundTo = (badgeNumber: string) =>
      ({ actorIdentity: `org:EE:1|${BADGE}|${badgeNumber}`, identityCredentialRef: 'badge:earlier' }) as Principal
    const asking = identity.authenticate('conn-identified', 'did:peer:alice', true, false, {
      purpose: 'visitor',
      bound: boundTo('7'),
    })
    await settle()
    await t.present(ISSUER_1)
    expect(await asking).toEqual({ outcome: 'not-accepted', code: 'another-identity' })
    await settle()
    // the reason goes on the flow, which never closes completed, and no new request follows
    expect(t.problems()).toEqual(['another-identity'])
    expect(t.calls.filter((c) => c.method === 'closeFlow')).toEqual([])
    expect(t.opened()).toHaveLength(1)
    // the same identity is accepted, and its flow closes completed
    const same = identity.authenticate('conn-identified', 'did:peer:alice', true, false, {
      purpose: 'visitor',
      bound: boundTo('42'),
    })
    await settle()
    await t.present(ISSUER_1)
    expect(await same).toMatchObject({ outcome: 'accepted', facts: { actorIdentity: `org:EE:1|${BADGE}|42` } })
    const close = t.calls.filter((c) => c.method === 'closeFlow').at(-1)?.args as [string, { outcome: string }]
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
