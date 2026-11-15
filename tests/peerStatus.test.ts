/**
 * Peer status (D71; IDENT-STAT-001..008, CHAN-BIND-014, PROF-DESC-007): the agent tells a peer where it stands
 * with it. One message carries the rule by which the agent identifies the peer, whether it is identified, and what
 * is open to it on the connection. A wallet asks for its session grant on that message, and not before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { DidcommAdapter, MediaLinks } from '../src/channels/didcomm/adapter.js'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { AYNI_FLOW_PROTOCOL, PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import {
  PEER_STATUS_PROTOCOL,
  type PeerStatus,
  PeerStatusNotifier,
  type PeerStatusRefusalCode,
} from '../src/channels/didcomm/peerStatus.js'
import type { AgentPack } from '../src/config/packTypes.js'
import { FlowService } from '../src/core/flows.js'
import type { VerifiedFacts } from '../src/core/principals.js'
import { createLogger } from '../src/util/logger.js'
import { startTestAgent } from './helpers.js'

const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'

type Call = { method: string; args: unknown[] }

let running: RunningAgent
let events: DidcommEvents
let peers: PeerProfiles
let calls: Call[]
/** whether the DIDComm agent of the test speaks the protocol */
let capable: boolean | Error
/** what the identification of the next connection gives */
let outcome: { facts?: VerifiedFacts; refusal?: PeerStatusRefusalCode }
let n = 0
const logger = createLogger('silent')

function stubClient() {
  const rec =
    (method: string, answer: (...args: unknown[]) => unknown = () => undefined) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return answer(...args)
    }
  return {
    sendText: rec('sendText', () => ({ id: `msg-${++n}` })),
    sendActionMenu: rec('sendActionMenu', () => ({ id: `menu-${++n}` })),
    deleteConnection: rec('deleteConnection'),
    openFlow: rec('openFlow', (body) => ({ ...(body as object), flowId: `flow-${++n}`, state: 'pending' })),
    closeFlow: rec('closeFlow', (flowId, body) => ({ flowId, ...(body as object) })),
    flowProblemReport: rec('flowProblemReport', (flowId, body) => ({ flowId, state: 'failed', ...(body as object) })),
    grantSession: rec('grantSession', (threadId, grant) => ({ threadId, state: 'response-sent', response: grant })),
    sendPeerStatus: rec('sendPeerStatus', () => ({ id: `status-${++n}` })),
    supportsPeerStatus: async () => {
      if (capable instanceof Error) throw capable
      return capable
    },
  }
}

const person = (actor: string, identified = false): VerifiedFacts => ({
  connectionType: 'verifiable-user-agent',
  actorIdentity: actor,
  backingIdentity: null,
  claims: { userName: 'Alice' },
  userAgentVerified: false,
  identityCredentialRef: identified ? `badge:${actor}` : null,
})
const service = (did: string): VerifiedFacts => ({
  connectionType: 'verifiable-service',
  actorIdentity: did,
  backingIdentity: null,
  claims: { userName: 'Partner' },
  userAgentVerified: true,
  identityCredentialRef: `ecs-service:${did}`,
})
const feature = (id: string, roles: string[]) => JSON.stringify({ 'feature-type': 'protocol', id, roles })
const envelope = (type: string, data: Record<string, unknown>) => ({
  id: `evt-${Math.random()}`,
  type,
  timestamp: new Date().toISOString(),
  data,
})
const statuses = (connectionId: string) =>
  calls.filter((c) => c.method === 'sendPeerStatus' && c.args[0] === connectionId).map((c) => c.args[1] as PeerStatus)

/** The agent-pack of the test agent, with the authentication rule of a case. */
function packWith(rule: 'none' | 'optional' | 'required'): AgentPack {
  const pack = running.agent.pack
  const authentication =
    rule === 'none'
      ? undefined
      : [
          {
            credential: { jsonSchemaCredentialId: BADGE },
            subjectKey: ['id'],
            request: rule === 'optional' ? ('on-demand' as const) : ('on-connect' as const),
          },
        ]
  return { ...pack, identity: { ...pack.identity, authentication } } as AgentPack
}

function useRule(rule: 'none' | 'optional' | 'required'): PeerStatusNotifier {
  const notifier = new PeerStatusNotifier(packWith(rule), stubClient() as never, peers, logger)
  running.agent.peerStatus = notifier
  return notifier
}

/** A peer connects and discloses its protocols; `receiver: false` is a peer without peer-status. */
async function connect(
  connectionId: string,
  options: { theirDid?: string; receiver?: boolean; roles?: string[] } = {}
): Promise<void> {
  const metadata: Record<string, string> = { [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL, ['holder']) }
  if (options.receiver !== false)
    metadata[PEER_STATUS_PROTOCOL] = feature(PEER_STATUS_PROTOCOL, options.roles ?? ['receiver'])
  const completed = events.handle(
    envelope('didcomm.connections.state-updated', {
      id: connectionId,
      state: 'completed',
      theirDid: options.theirDid ?? `did:peer:${connectionId}`,
      theirLabel: 'Ayni',
      outOfBandId: null,
      metadata: {},
    })
  )
  await events.handle(envelope('didcomm.connections.state-updated', { id: connectionId, state: 'updated', metadata }))
  await completed
}

const requestGrant = (connectionId: string, threadId: string, endpoint?: string) =>
  events.handle(
    envelope('didcomm.session-grant.state-changed', {
      threadId,
      flowId: `holder-flow-${threadId}`,
      connectionId,
      state: 'request-received',
      request: {
        agentDid: 'did:webvh:test:agent',
        ...(endpoint ? { endpoint } : {}),
        conversationId: null,
        newConversation: false,
        client: { description: 'Ayni on iPhone', platform: 'ios', appVersion: '1.0.0' },
      },
    })
  )

beforeAll(async () => {
  running = await startTestAgent({ publicBaseUrl: 'https://welcome.test' })
  calls = []
  const client = stubClient()
  peers = new PeerProfiles(running.agent.store.kv, logger)
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
  const identity = {
    establish: async (
      connectionId: string,
      did: string | undefined,
      options: { onRefused?: (code: PeerStatusRefusalCode) => void }
    ) => {
      calls.push({ method: 'establish', args: [connectionId] })
      if (outcome.refusal) {
        options.onRefused?.(outcome.refusal)
        return undefined
      }
      return outcome.facts ?? person(did ?? connectionId)
    },
  }
  events = new DidcommEvents(running.agent, client as never, identity as never, adapter, peers, undefined, logger, 100)
})

beforeEach(() => {
  calls.length = 0
  capable = true
  outcome = {}
})

afterAll(async () => {
  await running.stop()
})

describe('the status of a person (IDENT-STAT-001/002/003/004)', () => {
  it('no authentication schema: the rule is none, the person is not identified, the conversation channel is open', async () => {
    useRule('none')
    await connect('ps-none')
    expect(statuses('ps-none')).toEqual([{ authentication: { rule: 'none' }, identified: false, open: ['ag-ui'] }])
    // told once the Principal is resolved, and not before
    const order = calls.map((c) => c.method)
    expect(order.indexOf('establish')).toBeLessThan(order.indexOf('sendPeerStatus'))
  })

  it('a schema asked on demand: the rule is optional and names the schema; the person enters unidentified', async () => {
    useRule('optional')
    await connect('ps-optional')
    expect(statuses('ps-optional')).toEqual([
      {
        authentication: { rule: 'optional', credential: { jsonSchemaCredentialId: BADGE } },
        identified: false,
        open: ['ag-ui'],
      },
    ])
  })

  it('a schema asked on connect: nothing is open before the credential is asked, then the person is identified', async () => {
    useRule('required')
    outcome = { facts: person('did:peer:ps-required', true) }
    await connect('ps-required')
    const authentication = { rule: 'required', credential: { jsonSchemaCredentialId: BADGE } }
    expect(statuses('ps-required')).toEqual([
      { authentication, identified: false, open: [] },
      { authentication, identified: true, open: ['ag-ui'] },
    ])
    // the first status precedes the request for the credential (IDENT-STAT-003, FLOW-STAT-002)
    const order = calls.map((c) => c.method)
    expect(order.indexOf('sendPeerStatus')).toBeLessThan(order.indexOf('establish'))
    expect(order.lastIndexOf('sendPeerStatus')).toBeGreaterThan(order.indexOf('establish'))
  })

  it('says nothing to a peer that did not disclose the protocol, or disclosed it as a notifier only', async () => {
    useRule('none')
    await connect('ps-silent', { receiver: false })
    await connect('ps-notifier', { roles: ['notifier'] })
    expect(calls.filter((c) => c.method === 'sendPeerStatus')).toHaveLength(0)
  })

  it('tells a peer that discloses the protocol after its Principal was resolved, and tells the same status once', async () => {
    useRule('none')
    await connect('ps-late', { receiver: false })
    expect(statuses('ps-late')).toHaveLength(0)
    const disclosure = envelope('didcomm.connections.state-updated', {
      id: 'ps-late',
      state: 'updated',
      metadata: { [PEER_STATUS_PROTOCOL]: feature(PEER_STATUS_PROTOCOL, ['receiver']) },
    })
    await events.handle(disclosure)
    expect(statuses('ps-late')).toEqual([{ authentication: { rule: 'none' }, identified: false, open: ['ag-ui'] }])
    await events.handle(disclosure)
    expect(statuses('ps-late')).toHaveLength(1)
  })

  it('lists nothing as open when the agent does not serve the conversation channel', async () => {
    const pack = packWith('none')
    const notifier = new PeerStatusNotifier(
      { ...pack, channels: { ...pack.channels, agui: { enabled: false } } } as AgentPack,
      stubClient() as never,
      peers,
      logger
    )
    running.agent.peerStatus = notifier
    await connect('ps-no-agui')
    expect(statuses('ps-no-agui')).toEqual([{ authentication: { rule: 'none' }, identified: false, open: [] }])
  })
})

describe('a status that changes (IDENT-STAT-005)', () => {
  it('a person identified after connect is told so', async () => {
    const notifier = useRule('optional')
    await connect('ps-upgrade')
    const bound = await running.agent.didcommSession('ps-upgrade')
    if (!bound) throw new Error('no session on the connection')
    // what the application does when a credential is presented on a connection already served
    await notifier.resolved('ps-upgrade', { ...bound.principal, identityCredentialRef: 'badge:alice' })
    const authentication = { rule: 'optional', credential: { jsonSchemaCredentialId: BADGE } }
    expect(statuses('ps-upgrade')).toEqual([
      { authentication, identified: false, open: ['ag-ui'] },
      { authentication, identified: true, open: ['ag-ui'] },
    ])
  })

  it('a credential that no longer holds: the person is identified no more and nothing is open', async () => {
    useRule('required')
    outcome = { facts: person('did:peer:ps-invalid', true) }
    await connect('ps-invalid')
    const bound = await running.agent.didcommSession('ps-invalid')
    if (!bound) throw new Error('no session on the connection')
    await running.agent.onCredentialInvalid(bound.principal)
    expect(statuses('ps-invalid').at(-1)).toEqual({
      authentication: { rule: 'required', credential: { jsonSchemaCredentialId: BADGE } },
      identified: false,
      open: [],
    })
    // and the agent refuses what it no longer lists: the sessions of the Principal are closed
    expect(await running.agent.didcommSession('ps-invalid')).toBeUndefined()
  })
})

describe('a peer the agent does not serve (IDENT-STAT-006)', () => {
  it('a credential the agent does not accept on connect: identity-refused, then the connection ends', async () => {
    useRule('required')
    outcome = { refusal: 'identity-refused' }
    await connect('ps-refused')
    expect(statuses('ps-refused').at(-1)).toEqual({
      authentication: { rule: 'required', credential: { jsonSchemaCredentialId: BADGE } },
      identified: false,
      open: [],
      refusal: { code: 'identity-refused' },
    })
    const order = calls.map((c) => c.method)
    expect(order.lastIndexOf('sendPeerStatus')).toBeLessThan(order.indexOf('deleteConnection'))
    expect(await running.agent.didcommSession('ps-refused')).toBeUndefined()
  })

  it('a wallet the policy lets in under no condition: not-admitted', async () => {
    useRule('none')
    outcome = { refusal: 'not-admitted' }
    await connect('ps-gate')
    expect(statuses('ps-gate')).toEqual([
      { authentication: { rule: 'none' }, identified: false, open: [], refusal: { code: 'not-admitted' } },
    ])
  })

  it('a service whose DID does not resolve as trusted: untrusted, with the rule none', async () => {
    useRule('required')
    outcome = { refusal: 'untrusted' }
    await connect('ps-untrusted', { theirDid: 'did:webvh:abc:partner.example', roles: ['notifier', 'receiver'] })
    expect(statuses('ps-untrusted')).toEqual([
      { authentication: { rule: 'none' }, identified: false, open: [], refusal: { code: 'untrusted' } },
    ])
  })
})

describe('a service peer (IDENT-STAT-007)', () => {
  it('is identified by its trusted DID: the rule is none, whatever the agent asks of a person', async () => {
    useRule('required')
    const did = 'did:webvh:abc:service.example'
    outcome = { facts: service(did) }
    await connect('ps-service', { theirDid: did, roles: ['notifier', 'receiver'] })
    expect(statuses('ps-service')).toEqual([{ authentication: { rule: 'none' }, identified: true, open: [] }])
  })

  it('takes the status a service sends about the agent itself, and changes nothing on it', async () => {
    useRule('none')
    const did = 'did:webvh:abc:talker.example'
    outcome = { facts: service(did) }
    await connect('ps-talker', { theirDid: did, roles: ['notifier', 'receiver'] })
    const before = statuses('ps-talker').length
    await events.handle(
      envelope('didcomm.peer-status.status-received', {
        messageId: 'm-1',
        connectionId: 'ps-talker',
        status: { authentication: { rule: 'none' }, identified: false, open: [], refusal: { code: 'untrusted' } },
        previous: null,
      })
    )
    expect(statuses('ps-talker')).toHaveLength(before)
    expect(await running.agent.didcommSession('ps-talker')).toBeDefined()
  })
})

describe('a query (IDENT-STAT-008)', () => {
  const query = (connectionId: string, answered: boolean) =>
    events.handle(envelope('didcomm.peer-status.query-received', { messageId: 'q-1', connectionId, answered }))

  it('is answered with the current status when the DIDComm agent held none, even told before', async () => {
    useRule('none')
    await connect('ps-query')
    await query('ps-query', false)
    const status = { authentication: { rule: 'none' }, identified: false, open: ['ag-ui'] }
    expect(statuses('ps-query')).toEqual([status, status])
  })

  it('is answered to a peer that asked without having disclosed the protocol', async () => {
    useRule('none')
    await connect('ps-query-undisclosed', { receiver: false })
    await query('ps-query-undisclosed', false)
    expect(statuses('ps-query-undisclosed')).toHaveLength(1)
  })

  it('is left to the DIDComm agent when it answered, and waits for the Principal when there is none', async () => {
    useRule('none')
    await connect('ps-query-answered')
    await query('ps-query-answered', true)
    expect(statuses('ps-query-answered')).toHaveLength(1)
    await query('ps-query-unknown', false)
    expect(statuses('ps-query-unknown')).toHaveLength(0)
  })
})

describe('the session grant names its endpoint (CHAN-BIND-014, FLOW-GRANT-004)', () => {
  it('grants for the conversation channel, named or not', async () => {
    useRule('none')
    await connect('ps-grant')
    await requestGrant('ps-grant', 'sg-1')
    await requestGrant('ps-grant', 'sg-2', 'ag-ui')
    expect(calls.filter((c) => c.method === 'grantSession').map((c) => c.args[0])).toEqual(['sg-1', 'sg-2'])
  })

  it('refuses with not-eligible an endpoint that is not open to the peer', async () => {
    useRule('none')
    await connect('ps-grant-a2a')
    await requestGrant('ps-grant-a2a', 'sg-3', 'a2a')
    expect(calls.filter((c) => c.method === 'grantSession')).toHaveLength(0)
    const report = calls.find((c) => c.method === 'flowProblemReport')
    expect(report?.args[0]).toBe('holder-flow-sg-3')
    expect(report?.args[1]).toMatchObject({ code: 'not-eligible' })
  })

  it('refuses a service: what a service may open is not the conversation channel', async () => {
    useRule('none')
    const did = 'did:webvh:abc:asker.example'
    outcome = { facts: service(did) }
    await connect('ps-grant-service', { theirDid: did })
    await requestGrant('ps-grant-service', 'sg-4')
    expect(calls.filter((c) => c.method === 'grantSession')).toHaveLength(0)
  })
})

describe('the descriptor declares the feature when the DIDComm agent can send a status (PROF-DESC-007)', () => {
  const features = async () =>
    (await running.app.inject({ method: 'GET', url: '/.well-known/ayni-agent.json' })).json().features

  it('declares it once the DIDComm agent is known to speak the protocol', async () => {
    const notifier = useRule('none')
    expect(notifier.declared).toBe(false)
    await notifier.supported()
    expect(notifier.declared).toBe(true)
    expect((await features()).peerStatus).toBe(true)
  })

  it('does not declare it, and sends nothing, with a DIDComm agent without the protocol', async () => {
    capable = false
    const notifier = useRule('none')
    await notifier.supported()
    expect((await features()).peerStatus).toBe(false)
    await connect('ps-old-vs-agent')
    expect(calls.filter((c) => c.method === 'sendPeerStatus')).toHaveLength(0)
    // a wallet of an agent that does not declare the feature asks as before, and is served
    await requestGrant('ps-old-vs-agent', 'sg-5')
    expect(calls.filter((c) => c.method === 'grantSession')).toHaveLength(1)
  })

  it('does not declare it while the DIDComm agent is out of reach, and asks again', async () => {
    capable = new Error('out of reach')
    const notifier = useRule('none')
    expect(await notifier.supported()).toBe(false)
    capable = true
    expect(await notifier.supported()).toBe(true)
    expect(notifier.declared).toBe(true)
  })
})

describe('a connection that ends', () => {
  it('takes its status with it: a new connection under the same id is told again', async () => {
    useRule('none')
    await connect('ps-ended')
    await events.handle(envelope('didcomm.connections.state-updated', { id: 'ps-ended', state: 'terminated' }))
    await connect('ps-ended')
    expect(statuses('ps-ended')).toHaveLength(2)
  })
})
