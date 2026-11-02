/**
 * The session grant (D56; CHAN-BIND-014/015, PROF-SESS-013/014): a flow-capable wallet that is also a UI asks for a
 * grant on its connection and binds its own session in one request, with a device handle and secret; a replayed or
 * expired grant answers 409; the client platform and description are recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { DidcommAdapter, MediaLinks } from '../src/channels/didcomm/adapter.js'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { AYNI_FLOW_PROTOCOL, PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import { FlowService } from '../src/core/flows.js'
import { normalizeClient } from '../src/core/sessions.js'
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

let running: RunningAgent
let events: DidcommEvents
let calls: Call[]
const lastGrant = () =>
  calls.filter((c) => c.method === 'grantSession').at(-1)?.args[1] as {
    grant: string
    sessionsUrl: string
    expiresAt: string
  }

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
  const identity = { establish: async (_c: string, did?: string) => facts(did ?? 'did:peer:x') }
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
      metadata: { [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL) },
    })
  )
  await completed
}

async function requestGrant(connectionId: string, threadId: string) {
  await events.handle(
    envelope('didcomm.session-grant.state-changed', {
      threadId,
      flowId: `holder-flow-${threadId}`,
      connectionId,
      state: 'request-received',
      request: {
        agentDid: 'did:webvh:test:agent',
        conversationId: null,
        newConversation: false,
        client: { description: 'Ayni on iPhone', platform: 'ios', appVersion: '1.0.0' },
      },
    })
  )
}

const createWithGrant = (
  grant: string,
  client: Record<string, unknown> = { name: 'ayni-app', version: '1.0.0', platform: 'ios' }
) => running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client, locale: 'en', grant } })

describe('session grant (D56, CHAN-BIND-014, PROF-SESS-013)', () => {
  it('answers the request with a single-use grant and the sessions URL, and binds the session in one request', async () => {
    const connectionId = 'conn-grant'
    await connectFlowCapable(connectionId)
    await requestGrant(connectionId, 'sg-req-1')
    const granted = lastGrant()
    expect(granted.grant).toMatch(/^sg_/)
    expect(granted.sessionsUrl).toBe('https://welcome.test/agui/v3/sessions')
    expect(Date.parse(granted.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000)
    expect(calls.filter((c) => c.method === 'sendText')).toHaveLength(0) // nothing asked on the channel

    const response = await createWithGrant(granted.grant)
    expect(response.statusCode).toBe(201)
    const body = response.json() as Record<string, unknown>
    expect(body.state).toBe('bound')
    expect(body.deviceHandle).toMatch(/^dev_/)
    expect(body.deviceSecret).toMatch(/^dsk_/)
    expect((body.principal as { displayName: string }).displayName).toBe('Alice')
    const session = await running.agent.sessions.get(String(body.sessionId))
    const phone = await running.agent.didcommSession(connectionId)
    if (!phone) throw new Error('phone not bound')
    expect(session?.principalId).toBe(phone.principal.id)
    // the same Principal and capability channel as a session bound through the phone (CHAN-BIND-013)
    const capability = await running.agent.router.capabilitySession(phone.principal)
    expect(capability?.externalRef).toBe(connectionId)
    // the client platform and description are recorded and listed (CHAN-BIND-015, PROF-SESS-014)
    expect(session?.client).toMatchObject({ platform: 'ios', description: 'Ayni on iPhone' })
    const devices = await running.app.inject({
      method: 'GET',
      url: '/agui/v3/sessions/devices',
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    const list = (devices.json() as { devices: { client: Record<string, unknown>; current: boolean }[] }).devices
    expect(list.find((d) => d.current)?.client).toMatchObject({ platform: 'ios', description: 'Ayni on iPhone' })
  })

  it('refuses a replayed grant with 409 grant-used', async () => {
    const granted = lastGrant()
    const replay = await createWithGrant(granted.grant)
    expect(replay.statusCode).toBe(409)
    expect(replay.json().error).toBe('grant-used')
  })

  it('refuses an expired or unknown grant with 409 grant-expired', async () => {
    const unknown = await createWithGrant('sg_nobody')
    expect(unknown.statusCode).toBe(409)
    expect(unknown.json().error).toBe('grant-expired')
    await requestGrant('conn-grant', 'sg-req-2')
    const granted = lastGrant()
    // age the grant past its lifetime
    const kv = running.agent.store.kv
    const sessions = running.agent.sessions as unknown as { hash: (s: string) => string }
    const key = `session-grant:${sessions.hash(`grant:${granted.grant}`)}`
    const record = JSON.parse((await kv.get(key)) as string)
    record.expiresAt = new Date(Date.now() - 1000).toISOString()
    await kv.set(key, JSON.stringify(record))
    const expired = await createWithGrant(granted.grant)
    expect(expired.statusCode).toBe(409)
    expect(expired.json().error).toBe('grant-expired')
  })

  it('refuses a grant request on a connection with no resolved principal', async () => {
    const before = calls.filter((c) => c.method === 'grantSession').length
    await requestGrant('conn-stranger', 'sg-req-3')
    expect(calls.filter((c) => c.method === 'grantSession')).toHaveLength(before)
    const report = calls.filter((c) => c.method === 'flowProblemReport').at(-1)
    if (!report) throw new Error('no problem report')
    expect(report.args[0]).toBe('holder-flow-sg-req-3')
    expect((report.args[1] as { code: string }).code).toBe('not-eligible')
  })

  it('declares features.sessionGrant in the descriptor (PROF-DESC-004)', async () => {
    const response = await running.app.inject({ method: 'GET', url: '/.well-known/ayni-agent.json' })
    expect(response.json().features).toMatchObject({ sessionGrant: true, flows: true })
    expect(response.json().profileVersion).toBe('3.1')
  })
})

describe('client platform and description (PROF-SESS-014)', () => {
  it('moves a 3.0 free-text platform to the description and treats it as web', () => {
    expect(normalizeClient({ name: 'ayni-ui', version: '3.0.0', platform: 'Firefox on Linux' })).toEqual({
      name: 'ayni-ui',
      version: '3.0.0',
      platform: 'web',
      description: 'Firefox on Linux',
    })
    expect(
      normalizeClient({ name: 'ayni-app', version: '1.0.0', platform: 'android', description: 'Ayni on Pixel' })
    ).toEqual({ name: 'ayni-app', version: '1.0.0', platform: 'android', description: 'Ayni on Pixel' })
  })
})
