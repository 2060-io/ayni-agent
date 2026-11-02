/**
 * Flow mode on the capability channel (D54, CHAN-PROF-006): a wallet whose disclosure names
 * `ayni-flow/1.0` receives no welcome text, no menu, no receipts and no chat replies; a wallet without
 * it is served as in v3, on the same agent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { DidcommAdapter, MediaLinks } from '../src/channels/didcomm/adapter.js'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { AYNI_FLOW_PROTOCOL, PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import { createLogger } from '../src/util/logger.js'
import { startTestAgent } from './helpers.js'

type Call = { method: string; connectionId: string; args: unknown[] }

/** A VS Agent Admin API that records what the agent sends. */
function stubClient(calls: Call[]) {
  let n = 0
  const record =
    (method: string) =>
    async (connectionId: string, ...args: unknown[]) => {
      calls.push({ method, connectionId, args })
      return { id: `msg-${++n}` }
    }
  return {
    sendText: record('sendText'),
    sendQuestion: record('sendQuestion'),
    sendActionMenu: record('sendActionMenu'),
    sendReceipts: record('sendReceipts'),
    sendReactions: record('sendReactions'),
    deleteConnection: async () => undefined,
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
const settle = () => new Promise((r) => setTimeout(r, 30))

let running: RunningAgent
let events: DidcommEvents
let calls: Call[]

beforeAll(async () => {
  running = await startTestAgent()
  calls = []
  const logger = createLogger('silent')
  const client = stubClient(calls)
  const peers = new PeerProfiles(running.agent.store.kv, logger)
  const adapter = new DidcommAdapter(
    client as never,
    'http://agent.test',
    new MediaLinks(1000),
    undefined,
    peers,
    logger
  )
  adapter.attach(running.agent)
  running.agent.router.register(adapter)
  const identity = { establish: async (_c: string, did?: string) => facts(did ?? 'did:peer:x') }
  events = new DidcommEvents(running.agent, client as never, identity as never, adapter, peers, undefined, logger, 200)
})

afterAll(async () => {
  await running.stop()
})

const sentTo = (connectionId: string, method?: string) =>
  calls.filter((c) => c.connectionId === connectionId && (!method || c.method === method))

describe('flow mode (D54)', () => {
  it('serves a wallet that discloses ayni-flow/1.0 with no welcome, menu, receipts or chat', async () => {
    const connectionId = 'conn-flow'
    // the DIDComm agent announces a features query (empty metadata) and forwards the disclosure a moment later
    const completed = events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'completed',
        theirDid: 'did:peer:flow',
        theirLabel: 'Ayni',
        outOfBandId: null,
        metadata: {},
      })
    )
    await settle()
    await events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'updated',
        metadata: { [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL) },
      })
    )
    await completed
    const bound = await running.agent.didcommSession(connectionId)
    expect(bound?.session.state).toBe('bound')
    expect(sentTo(connectionId)).toEqual([])

    await events.handle(
      envelope('didcomm.basic-messages.message-received', { connectionId, content: 'hello?', id: 'm-1' })
    )
    await settle()
    expect(sentTo(connectionId)).toEqual([]) // no receipt, no reply
  })

  it('serves a wallet without the flow profile as in v3, on the same agent', async () => {
    const connectionId = 'conn-v3'
    await events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'completed',
        theirDid: 'did:peer:v3',
        theirLabel: 'Hologram',
        outOfBandId: null,
      })
    )
    await settle()
    expect(sentTo(connectionId, 'sendText').length).toBe(1)
    expect(String(sentTo(connectionId, 'sendText')[0].args[0])).toContain('Hello Alice')
    expect(sentTo(connectionId, 'sendActionMenu').length).toBeGreaterThanOrEqual(1)
  })

  it('decides v3 serving when no disclosure arrives in time', async () => {
    const connectionId = 'conn-late'
    const started = Date.now()
    await events.handle(
      envelope('didcomm.connections.state-updated', {
        id: connectionId,
        state: 'completed',
        theirDid: 'did:peer:late',
        outOfBandId: null,
        metadata: {},
      })
    )
    await settle()
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(sentTo(connectionId, 'sendText').length).toBe(1)
  })
})
