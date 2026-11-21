/**
 * A web session linked by a phone that scans its code (CHAN-BIND-008/009/017, FLOW-LINK-001/003, D5 as amended on
 * 2026-11-21). The binding invitation is a standalone invitation record of the DIDComm agent, so the events come as
 * VS Agent 2.x sends them: a new connection names its invitation record as `invitationId` and carries no
 * `outOfBandId`, a handshake reuse names it as `outOfBandId`. Either asks the same `link-session` question, with three
 * codes, and only the session's code binds. Found by Fabrice on devnet, 2026-11-21: a phone that connected for the
 * first time from the code was never asked, and the browser kept its code forever.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { codesAround, DidcommAdapter, invitationUrlOf, MediaLinks } from '../src/channels/didcomm/adapter.js'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { AYNI_FLOW_PROTOCOL, PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import type { FlowRecord } from '../src/channels/didcomm/vsAgentClient.js'
import { FlowService } from '../src/core/flows.js'
import type { Session } from '../src/core/types.js'
import type { Logger } from '../src/util/logger.js'
import { createLogger } from '../src/util/logger.js'
import { startTestAgent } from './helpers.js'

type Call = { method: string; args: unknown[]; result?: unknown }

const AGENT_DID = 'did:webvh:test:agent'
const PUBLIC_URL = 'https://vs.agent.test'

/** A VS Agent 2.x with the Ayni flow plugin: records calls, answers the way it does. */
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
    // `POST /v2/didcomm/invitations` (vs-agent#804): the record id, the invitation and its short URL, no `oob=` URL
    createInvitation: rec('createInvitation', (body) => {
      const b = body as { goalCode?: string; goal?: string }
      n += 1
      return {
        id: `oob-record-${n}`,
        invitation: {
          '@type': 'https://didcomm.org/out-of-band/1.1/invitation',
          '@id': `invitation-${n}`,
          goal_code: b.goalCode,
          goal: b.goal,
          handshake_protocols: ['https://didcomm.org/didexchange/1.1'],
          services: [AGENT_DID],
        },
        shortUrl: `${PUBLIC_URL}/s?id=short-${n}`,
      }
    }),
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
const uiClient = { name: 'ayni-ui', version: '3.4.0', platform: 'web' }

let running: RunningAgent
let events: DidcommEvents
let calls: Call[]
const warnings: { obj: Record<string, unknown>; msg: string }[] = []

const callsOf = (method: string) => calls.filter((c) => c.method === method)
type LinkRequest = { connectionId: string; flowId: string; request: { invitationId: string; codes: string[] | null } }
const lastLink = () =>
  callsOf('sendLinkSessionRequest').at(-1) as unknown as { args: [LinkRequest]; result: { threadId: string } }

/** The events' logger: warnings recorded, the rest dropped. */
function recordingLogger(): Logger {
  const silent = createLogger('silent')
  return Object.assign(Object.create(silent), {
    warn: (obj: Record<string, unknown>, msg: string) => {
      warnings.push({ obj, msg })
    },
  }) as Logger
}

beforeAll(async () => {
  running = await startTestAgent()
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
  flows.setAgentDid(AGENT_DID)
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
  Object.assign(running.agent, { flows })
  // the sessions mint their invitations through this adapter, on the stub DIDComm agent (CHAN-BIND-008)
  Object.assign(running.agent.sessions as unknown as { minter: unknown }, { minter: adapter })
  const identity = { establish: async (_c: string, did?: string) => facts(did ?? 'did:peer:x') }
  events = new DidcommEvents(
    running.agent,
    client as never,
    identity as never,
    adapter,
    peers,
    undefined,
    recordingLogger(),
    100
  )
})

afterAll(async () => {
  await running.stop()
})

async function createUiSession() {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    payload: { client: uiClient, locale: 'en' },
  })
  if (response.statusCode !== 201) throw new Error(`session creation ${response.statusCode}: ${response.body}`)
  const body = response.json() as { sessionId: string; binding: { oobUrl: string; bindingCode: string } }
  return { ...body, session: (await running.agent.sessions.get(body.sessionId)) as Session }
}

/**
 * A phone that connects for the first time from the code: the connection events exactly as VS Agent 2.x writes them
 * (`toConnectionDto`): `invitationId` names the invitation record, no `outOfBandId`, the request's id as `threadId`.
 */
async function connectFromInvitation(connectionId: string, invitationId: string | null) {
  const connection = {
    id: connectionId,
    role: 'responder',
    did: `did:peer:4.agent-${connectionId}`,
    theirDid: `did:peer:4.${connectionId}`,
    theirLabel: 'Ayni',
    threadId: `didexchange-request-${connectionId}`,
    invitationId,
    parentConnectionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const completed = events.handle(
    envelope('didcomm.connections.state-updated', {
      ...connection,
      state: 'completed',
      previousState: 'response-sent',
      metadata: {},
    })
  )
  await events.handle(
    envelope('didcomm.connections.state-updated', {
      ...connection,
      state: 'updated',
      previousState: 'completed',
      metadata: {
        [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL),
        'https://didcomm.org/link-session/1.0': feature('https://didcomm.org/link-session/1.0'),
      },
    })
  )
  await completed
  await settle()
}

const answer = (connectionId: string, link: LinkRequest, threadId: string, code: string | null, yes = true) =>
  events.handle(
    envelope('didcomm.link-session.state-changed', {
      threadId,
      flowId: link.flowId,
      connectionId,
      state: 'response-received',
      response: { link: yes, code },
    })
  )

describe('the binding invitation (CHAN-BIND-008)', () => {
  it('is a standalone invitation record, single use, DIDComm v1, carried as oob= on the agent public URL', async () => {
    const created = await createUiSession()
    const mint = callsOf('createInvitation').at(-1)?.args[0] as Record<string, unknown>
    expect(mint).toMatchObject({ didcommVersion: 'v1', reusable: false, goalCode: 'ayni.bind-session' })
    const record = callsOf('createInvitation').at(-1)?.result as { id: string; invitation: Record<string, unknown> }
    expect(created.session.binding?.outOfBandId).toBe(record.id)
    expect(created.session.binding?.nonce).toBe(record.invitation['@id'])
    const url = new URL(created.binding.oobUrl)
    expect(`${url.origin}${url.pathname}`).toBe(`${PUBLIC_URL}/`)
    const decoded = JSON.parse(Buffer.from(url.searchParams.get('oob') ?? '', 'base64url').toString('utf8'))
    expect(decoded).toEqual(record.invitation)
  })

  it('keeps a path prefix of the public URL', () => {
    const url = invitationUrlOf({ '@id': 'i' }, 'https://host.test/agent/s?id=abc')
    expect(url.startsWith('https://host.test/agent?oob=')).toBe(true)
  })
})

describe('a phone that connects for the first time from the code (CHAN-BIND-017)', () => {
  it('is asked the link question, with three codes, as after a handshake reuse', async () => {
    const created = await createUiSession()
    const connectionId = 'conn-new-from-code'
    const links = callsOf('sendLinkSessionRequest').length
    await connectFromInvitation(connectionId, created.session.binding?.outOfBandId ?? null)

    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links + 1)
    const link = lastLink().args[0]
    expect(link.connectionId).toBe(connectionId)
    expect(link.request.invitationId).toBe(created.session.binding?.nonce)
    expect(link.request.codes).toHaveLength(3)
    expect(new Set(link.request.codes).size).toBe(3)
    expect(link.request.codes).toContain(created.binding.bindingCode)
    expect((await running.agent.sessions.get(created.sessionId))?.binding?.questionThreadId).toBe(
      lastLink().result.threadId
    )

    await answer(connectionId, link, lastLink().result.threadId, created.binding.bindingCode)
    await settle()
    expect((await running.agent.sessions.get(created.sessionId))?.state).toBe('bound')
    const close = callsOf('closeFlow').at(-1)?.args as [string, { outcome: string }]
    expect(close[0]).toBe(link.flowId)
    expect(close[1].outcome).toBe('completed')
  })

  it('warns, and asks nothing, when the invitation it names has no provisional session', async () => {
    const links = callsOf('sendLinkSessionRequest').length
    warnings.length = 0
    await connectFromInvitation('conn-new-unknown', 'oob-record-unknown')
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links)
    const warning = warnings.find((w) => /names no provisional session/.test(w.msg))
    expect(warning?.obj).toMatchObject({ connectionId: 'conn-new-unknown', outOfBandId: 'oob-record-unknown' })
  })

  it('warns with the session state when the invitation was already used', async () => {
    const created = await createUiSession()
    await connectFromInvitation('conn-first-use', created.session.binding?.outOfBandId ?? null)
    await answer('conn-first-use', lastLink().args[0], lastLink().result.threadId, created.binding.bindingCode)
    await settle()
    expect((await running.agent.sessions.get(created.sessionId))?.state).toBe('bound')
    warnings.length = 0
    const links = callsOf('sendLinkSessionRequest').length
    await events.handle(
      envelope('didcomm.out-of-band.handshake-reused', {
        outOfBandId: created.session.binding?.outOfBandId,
        invitationId: created.session.binding?.nonce,
        connectionId: 'conn-first-use',
        reuseThreadId: 'reuse-again',
      })
    )
    await settle()
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links)
    expect(warnings.find((w) => /names no provisional session/.test(w.msg))?.obj).toMatchObject({
      reused: true,
      sessionState: 'bound',
    })
  })

  it('a connection that names no invitation is not a binding one and logs nothing about it', async () => {
    warnings.length = 0
    const links = callsOf('sendLinkSessionRequest').length
    await connectFromInvitation('conn-by-did', null)
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links)
    expect(warnings.some((w) => /names no provisional session/.test(w.msg))).toBe(false)
  })
})

describe('a phone that reuses its connection (CHAN-BIND-009, unchanged)', () => {
  it('is asked the same question, with three codes, and binds on the right one', async () => {
    const connectionId = 'conn-reuse-codes'
    await connectFromInvitation(connectionId, null)
    const created = await createUiSession()
    const links = callsOf('sendLinkSessionRequest').length
    await events.handle(
      envelope('didcomm.out-of-band.handshake-reused', {
        outOfBandId: created.session.binding?.outOfBandId,
        invitationId: created.session.binding?.nonce,
        connectionId,
        reuseThreadId: `reuse-${connectionId}`,
      })
    )
    await settle()
    expect(callsOf('sendLinkSessionRequest')).toHaveLength(links + 1)
    const link = lastLink().args[0]
    expect(link.request.invitationId).toBe(created.session.binding?.nonce)
    expect(link.request.codes).toContain(created.binding.bindingCode)
    await answer(connectionId, link, lastLink().result.threadId, created.binding.bindingCode)
    await settle()
    expect((await running.agent.sessions.get(created.sessionId))?.state).toBe('bound')
  })
})

describe('the code tapped on the scan path (D5 as amended on 2026-11-21, FLOW-LINK-003)', () => {
  async function asked(connectionId: string) {
    const created = await createUiSession()
    await connectFromInvitation(connectionId, created.session.binding?.outOfBandId ?? null)
    return { created, link: lastLink().args[0], threadId: lastLink().result.threadId }
  }

  it('a wrong code leaves the session provisional and cancels the flow', async () => {
    const { created, link, threadId } = await asked('conn-wrong-code')
    const wrong = link.request.codes?.find((c) => c !== created.binding.bindingCode) as string
    await answer('conn-wrong-code', link, threadId, wrong)
    await settle()
    expect((await running.agent.sessions.get(created.sessionId))?.state).toBe('provisional')
    const close = callsOf('closeFlow').at(-1)?.args as [string, { outcome: string }]
    expect(close[0]).toBe(link.flowId)
    expect(close[1].outcome).toBe('cancelled')
  })

  it('link: true with no code does not bind', async () => {
    const { created, link, threadId } = await asked('conn-no-code')
    await answer('conn-no-code', link, threadId, null)
    await settle()
    expect((await running.agent.sessions.get(created.sessionId))?.state).toBe('provisional')
  })

  it('the right code, written with a space, binds', async () => {
    const { created, link, threadId } = await asked('conn-spaced-code')
    await answer('conn-spaced-code', link, threadId, ` ${created.binding.bindingCode.toLowerCase()} `)
    await settle()
    expect((await running.agent.sessions.get(created.sessionId))?.state).toBe('bound')
  })

  it('three distinct codes, one of them the real one, every time', () => {
    for (let i = 0; i < 50; i++) {
      const codes = codesAround('EJ-3N')
      expect(codes).toHaveLength(3)
      expect(new Set(codes).size).toBe(3)
      expect(codes).toContain('EJ-3N')
      for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{2}-[A-Z2-9]{2}$/)
    }
  })
})
