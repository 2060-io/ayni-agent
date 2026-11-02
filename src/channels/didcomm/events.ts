/**
 * Events from the DIDComm agent (webhook): connection lifecycle, invitation acceptance and handshake
 * reuse (binding), question answers (binding confirmation, device challenges, approvals), messages
 * (conversation on DIDComm), reactions, receipts, calls and documents (challenges), presentations,
 * discover-features disclosures (per-peer capability profile, D54), and on flow-capable wallets the
 * flows: `link-session` answers (binding), `confirm` answers (device challenges), flow closures (D55).
 */
import type { FastifyInstance } from 'fastify'
import type { AyniAgent } from '../../core/agent.js'
import type { TurnSink } from '../../core/orchestrator.js'
import type { MessageAttachment, Principal, Session } from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import { clientOfConnection, DidcommAdapter } from './adapter.js'
import type { IdentityFlow } from './identity.js'
import type { PeerProfiles } from './peerProfiles.js'
import type {
  CarrierExchange,
  ConnectionRecord,
  FlowRecord,
  PresentationRecord,
  VsAgentClient,
} from './vsAgentClient.js'

interface Envelope {
  id: string
  type: string
  timestamp: string
  data: Record<string, unknown>
}

const CODE_PATTERN = /^\/?(?:link\s+)?([a-z0-9]{2})-?([a-z0-9]{2})$/i
const LINK_ATTEMPTS = 5
const LINK_WINDOW_MS = 10 * 60_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** How long the serving-mode decision waits for a disclosure the DIDComm agent announced (D54). */
export const DISCLOSURE_WAIT_MS = 3_000

/** The connection event as the DIDComm agent forwards it: state changes and, in state `updated`, disclosed features. */
type ConnectionEvent = ConnectionRecord & { previousState?: string; metadata?: Record<string, string> }

function decoyCode(): string {
  const pick = () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return `${pick()}${pick()}-${pick()}${pick()}`
}

export class DidcommEvents {
  private readonly identifying = new Set<string>()
  /** connections that chose "Link a web session" and owe a code */
  private readonly awaitingCode = new Map<string, number>()
  /** re-link questions sent to a known device's phone, by connection and question thread */
  private readonly rebinds = new Map<string, { sessionId: string; stage: 'ask' | 'code'; codes: string[] }>()
  private readonly linkAttempts = new Map<string, { count: number; since: number }>()
  /** flow ids of re-link requests sent as `link-session`, by connection and request id */
  private readonly linkFlows = new Map<string, string>()

  public constructor(
    private readonly agent: AyniAgent,
    private readonly client: VsAgentClient,
    private readonly identity: IdentityFlow,
    private readonly adapter: DidcommAdapter,
    private readonly peers: PeerProfiles,
    private readonly apiKey: string | undefined,
    private readonly logger: Logger,
    private readonly disclosureWaitMs = DISCLOSURE_WAIT_MS
  ) {}

  public register(app: FastifyInstance): void {
    app.post('/vs-agent/events', async (request, reply) => {
      if (this.apiKey && request.headers.authorization !== `Bearer ${this.apiKey}`)
        return reply.code(401).send({ error: 'unauthorized' })
      const envelope = request.body as Envelope
      // acknowledge at once; processing never blocks the DIDComm agent
      void this.handle(envelope).catch((err) =>
        this.logger.error({ err, type: envelope?.type }, 'event handling failed')
      )
      return reply.code(202).send()
    })
  }

  public async handle(envelope: Envelope): Promise<void> {
    const { type, data } = envelope
    this.logger.debug({ type }, 'didcomm event')
    switch (type) {
      case 'didcomm.connections.state-updated':
        return this.onConnection(data as unknown as ConnectionEvent)
      case 'didcomm.out-of-band.handshake-reused':
        return this.onInvitationAccepted(
          String(data.outOfBandId ?? ''),
          String(data.invitationId ?? ''),
          String(data.connectionId ?? '')
        )
      case 'didcomm.basic-messages.message-received':
        // the record's thread id is the DIDComm message id when the message carries no thread decorator
        return this.onText(
          String(data.connectionId),
          String(data.content ?? ''),
          String(data.threadId ?? data.id ?? '')
        )
      case 'didcomm.question-answer.answer-received':
        return this.onAnswer(String(data.connectionId), String(data.threadId ?? ''), String(data.response ?? ''))
      case 'didcomm.action-menu.perform-received':
        return this.onContextualSelect(String(data.connectionId), String(data.name ?? ''))
      case 'didcomm.action-menu.menu-request-received':
        return this.onMenuRequest(String(data.connectionId))
      case 'didcomm.reactions.message-reactions-received':
        return this.onReactions(
          String(data.connectionId),
          (data.reactions as { messageId: string; emoji: string; action: 'add' | 'remove' }[]) ?? []
        )
      case 'didcomm.receipts.message-receipts-received':
        return this.onReceipts(
          String(data.connectionId),
          (data.receipts as { messageId: string; state: string }[]) ?? []
        )
      case 'didcomm.media-sharing.share-media-received':
        return this.onMedia(String(data.connectionId), data)
      case 'didcomm.calls.call-reject-received':
      case 'didcomm.calls.call-end-received':
        return this.onCallEnded(
          String(data.connectionId),
          String(data.threadId ?? ''),
          type.endsWith('reject-received')
        )
      case 'didcomm.mrtd.emrtd-data-received':
        return this.onDocument(String(data.connectionId), String(data.threadId ?? ''), true, data)
      case 'didcomm.mrtd.problem-report-received':
        return this.onDocument(String(data.connectionId), String(data.threadId ?? ''), false, data)
      case 'didcomm.presentations.state-updated':
        this.identity.onPresentation(data as unknown as PresentationRecord)
        return
      // ---- flows (plugin events, CC-VSA-005) ----
      case 'didcomm.ayni-flow.state-changed':
        return this.onFlowStateChanged(data as unknown as FlowRecord & { previousState?: string })
      case 'didcomm.confirm.state-changed':
        return this.onConfirmStateChanged(data as unknown as CarrierExchange & { previousState?: string })
      case 'didcomm.link-session.state-changed':
        return this.onLinkSessionStateChanged(data as unknown as CarrierExchange & { previousState?: string })
      case 'didcomm.session-grant.state-changed':
        return this.onSessionGrantStateChanged(data as unknown as CarrierExchange & { previousState?: string })
      default:
        return
    }
  }

  // ---- connections (IDENT-TRUST-002, IDENT-SESS-002/003, CHAN-PROF-006) --------------------------------

  private async onConnection(record: ConnectionEvent): Promise<void> {
    if (record.state === 'updated') {
      // a discover-features disclosure: the peer's capability profile (FLOW-CAP-002)
      if (record.metadata && Object.keys(record.metadata).length) await this.peers.record(record.id, record.metadata)
      return
    }
    if (record.state === 'completed' && record.previousState !== 'completed') {
      if (this.identifying.has(record.id)) return
      this.identifying.add(record.id)
      try {
        // the DIDComm agent announces a features query with an (empty) metadata object: wait a moment for the
        // disclosure, since identity itself is requested in the peer's mode (flows or v3 messages, D54)
        const profile =
          (await this.peers.get(record.id)) ??
          (record.metadata ? await this.peers.awaitDisclosure(record.id, this.disclosureWaitMs) : undefined)
        const flowMode = !!profile && (await this.peers.isFlowCapable(record.id))
        if (flowMode) this.logger.info({ connectionId: record.id }, 'peer served in flow mode')
        const facts = await this.identity.establish(record.id, record.theirDid, { flowMode })
        if (!facts) {
          await this.client
            .sendText(
              record.id,
              'This agent accepts connections from Verifiable User Agents with a valid identity credential only.'
            )
            .catch(() => undefined)
          await this.client.deleteConnection(record.id).catch(() => undefined)
          return
        }
        await this.agent.onPeerConnected(facts, record.id, clientOfConnection(record.theirLabel), {
          welcome: !flowMode,
        })
        // a connection created from a binding invitation: ask the confirmation question (CHAN-BIND-009)
        if (record.outOfBandId) await this.onInvitationAccepted(record.outOfBandId, '', record.id)
      } finally {
        this.identifying.delete(record.id)
      }
    } else if (record.state === 'terminated' || record.state === 'abandoned') {
      await this.agent.onPeerDisconnected(record.id)
      await this.peers.forget(record.id)
    }
  }

  // ---- binding (CHAN-BIND-003/009, PROF-BIND-002/004/005) -------------------------------------------

  private async onInvitationAccepted(outOfBandId: string, invitationId: string, connectionId: string): Promise<void> {
    const session =
      (outOfBandId && (await this.agent.sessions.findProvisionalByOutOfBandId(outOfBandId))) ||
      (invitationId && (await this.agent.sessions.findProvisionalByNonce(invitationId))) ||
      undefined
    if (!session) return
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) {
      // handshake reuse on a connection whose Principal is not established yet: wait for identity
      this.logger.warn(
        { connectionId, sessionId: session.id },
        'invitation accepted before the principal was established'
      )
      return
    }
    await this.askBindingConfirmation(session, connectionId)
  }

  /**
   * The confirmation question names the agent, the code and the client (CHAN-BIND-009, PROF-BIND-004); on a
   * flow-capable wallet it is a `link-session` flow correlated to the invitation id (FLOW-LINK-001).
   */
  private async askBindingConfirmation(session: Session, connectionId: string): Promise<void> {
    if (session.binding && Date.parse(session.binding.expiresAt) < Date.now()) {
      await this.client.sendText(connectionId, 'This link code has expired. Ask the web page for a new one.')
      return
    }
    if (await this.adapter.flowMode(connectionId)) {
      const { threadId, flowId } = await this.adapter.askLinkSession(connectionId, session)
      await this.agent.sessions.markConfirmationSent(session, connectionId, threadId, flowId)
      return
    }
    const client = session.client
    const threadId = await this.adapter.askQuestion(
      connectionId,
      `Link a web session to ${this.agent.pack.metadata.displayName}?`,
      `Code ${session.binding?.bindingCode ?? ''}, ${client.name} ${client.version} on ${client.platform}. Answer Yes only if this code is shown on your screen.`,
      ['Yes', 'No']
    )
    await this.agent.sessions.markConfirmationSent(session, connectionId, threadId)
  }

  /**
   * A provisional session arrived from a device this Principal bound before (PROF-BIND-009): ask on
   * the phone whether to link it, then which of three codes the screen shows; the right pick binds.
   */
  public async offerRebind(session: Session, principal: Principal): Promise<boolean> {
    const capability = await this.agent.router.capabilitySession(principal)
    if (!capability || !session.binding) return false
    const connectionId = capability.externalRef
    if (await this.adapter.flowMode(connectionId)) {
      // one request carrying the real code and two decoys (FLOW-LINK-003, CHAN-BIND-012)
      const codes = this.codesAround(session.binding.bindingCode)
      const { threadId, flowId } = await this.adapter.askLinkSession(connectionId, session, codes)
      this.rebinds.set(`${connectionId}:${threadId}`, { sessionId: session.id, stage: 'code', codes })
      this.linkFlows.set(`${connectionId}:${threadId}`, flowId)
      return true
    }
    const threadId = await this.adapter.askQuestion(
      connectionId,
      `Link a new web session (${session.client.name} on ${session.client.platform})?`,
      `A page in your browser asks to be linked to ${this.agent.pack.metadata.displayName}. Answer No if you did not open it.`,
      ['Yes', 'No']
    )
    this.rebinds.set(`${connectionId}:${threadId}`, { sessionId: session.id, stage: 'ask', codes: [] })
    return true
  }

  private async onRebindAnswer(connectionId: string, threadId: string, response: string): Promise<boolean> {
    const key = `${connectionId}:${threadId}`
    const pending = this.rebinds.get(key)
    if (!pending) return false
    this.rebinds.delete(key)
    const session = await this.agent.sessions.get(pending.sessionId)
    if (session?.state !== 'provisional' || !session.binding || Date.parse(session.binding.expiresAt) < Date.now()) {
      await this.client.sendText(connectionId, 'That web session is no longer waiting.')
      return true
    }
    if (pending.stage === 'ask') {
      if (!/^(yes|y)$/i.test(response.trim())) return true
      // the real code and two decoys, shuffled: picking the one on the screen is the nonce confirmation
      const options = this.codesAround(session.binding.bindingCode)
      const next = await this.adapter.askQuestion(
        connectionId,
        'Which code is shown on the screen?',
        'Pick the code the web page displays.',
        options
      )
      this.rebinds.set(`${connectionId}:${next}`, { sessionId: session.id, stage: 'code', codes: options })
      return true
    }
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return true
    if (response.trim().toUpperCase() !== session.binding.bindingCode) {
      await this.client.sendText(connectionId, 'That is not the code on the screen. The web session was not linked.')
      return true
    }
    try {
      await this.agent.sessions.bind(session, bound.principal, session.binding.nonce)
      await this.client.sendText(
        connectionId,
        `Linked: ${session.client.name} on ${session.client.platform} (code ${session.binding.bindingCode}).`
      )
      await this.agent.welcome(session)
    } catch (error) {
      this.logger.warn({ err: error, sessionId: session.id }, 'rebind refused')
      await this.client.sendText(connectionId, 'This link could not be completed; ask the web page for a new code.')
    }
    return true
  }

  /**
   * Manual pairing: the person types the binding code shown on the screen (when the wallet does not
   * reuse the invitation). The confirmation question still gates the binding; attempts are limited.
   */
  private async linkByCode(connectionId: string, raw: string): Promise<boolean> {
    const match = CODE_PATTERN.exec(raw.trim())
    if (!match) return false
    const attempts = this.linkAttempts.get(connectionId) ?? { count: 0, since: Date.now() }
    if (Date.now() - attempts.since > LINK_WINDOW_MS) Object.assign(attempts, { count: 0, since: Date.now() })
    attempts.count += 1
    this.linkAttempts.set(connectionId, attempts)
    if (attempts.count > LINK_ATTEMPTS) {
      await this.client.sendText(connectionId, 'Too many attempts; try again in a few minutes.')
      return true
    }
    this.awaitingCode.delete(connectionId)
    const session = await this.agent.sessions.findProvisionalByCode(`${match[1]}${match[2]}`)
    if (!session) {
      await this.client.sendText(
        connectionId,
        'No web session is waiting with this code. Check the code on the screen, or ask the page for a new one.'
      )
      return true
    }
    await this.askBindingConfirmation(session, connectionId)
    return true
  }

  private async onAnswer(connectionId: string, threadId: string, response: string): Promise<void> {
    if (await this.onRebindAnswer(connectionId, threadId, response)) return
    const yes = /^(yes|approve|y)$/i.test(response.trim())
    const binding = await this.agent.sessions.findByConfirmation(connectionId, threadId)
    if (binding) {
      if (binding.state !== 'provisional' || !binding.binding) return
      if (!yes) {
        await this.client.sendText(connectionId, 'The web session was not linked.')
        return
      }
      const bound = await this.agent.didcommSession(connectionId)
      if (!bound) return
      try {
        await this.agent.sessions.bind(binding, bound.principal, binding.binding.nonce)
        await this.client.sendText(
          connectionId,
          `Linked: ${binding.client.name} on ${binding.client.platform} (code ${binding.binding.bindingCode}).`
        )
        await this.agent.welcome(binding)
      } catch (error) {
        this.logger.warn({ err: error, sessionId: binding.id }, 'binding refused')
        await this.client.sendText(connectionId, 'This link could not be completed; ask the web page for a new code.')
      }
      return
    }
    const challenge = await this.agent.challenges.findPendingByThread(connectionId, threadId)
    if (challenge) {
      await this.agent.challenges.complete(challenge.id, yes ? 'completed' : 'failed', { response })
      return
    }
    // an approval asked as a question (approval cards on DIDComm)
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    const pending = await this.agent.approvals.pendingFor(bound.principal)
    const sink = this.sinkFor(bound.session)
    if (pending.length === 1 && /^(approve|reject|yes|no)$/i.test(response.trim())) {
      await this.agent.action(
        bound.session,
        {
          kind: 'approval.decide',
          approvalId: pending[0].id,
          decision: /^(approve|yes)$/i.test(response.trim()) ? 'approve' : 'reject',
        },
        sink,
        new AbortController().signal
      )
      return
    }
    // an inline menu answered on DIDComm
    await this.turn(bound.session, response)
  }

  private codesAround(real: string): string[] {
    const codes = new Set<string>([real])
    while (codes.size < 3) codes.add(decoyCode())
    return [...codes].sort(() => Math.random() - 0.5)
  }

  // ---- flows on a flow-capable wallet (D54, D55) --------------------------------------------------------

  /** A flow closed by the holder or by expiry ends the capability event it served (INTX-FLOW-004). */
  private async onFlowStateChanged(record: FlowRecord & { previousState?: string }): Promise<void> {
    const closed = await this.agent.flows.onFlowEvent(record)
    if (!closed || closed.closedBy === 'me') return
    const challenge = (await this.agent.store.challenges.listPending()).find((c) => c.details?.flowId === closed.flowId)
    if (challenge) {
      await this.agent.challenges.complete(challenge.id, closed.outcome === 'expired' ? 'expired' : 'failed', {
        reason: closed.errorCode ?? closed.outcome,
      })
    }
  }

  /** `confirm/1.0/response`: the device challenge's answer (INTX-AUTH-009). */
  private async onConfirmStateChanged(exchange: CarrierExchange & { previousState?: string }): Promise<void> {
    if (exchange.state !== 'response-received' && exchange.state !== 'failed') return
    const challenge = await this.agent.challenges.findPendingByThread(exchange.connectionId, exchange.threadId)
    if (!challenge) return
    const response = (exchange.response ?? {}) as { confirmed?: boolean; attestation?: unknown }
    const ok = exchange.state === 'response-received' && response.confirmed === true
    await this.agent.challenges.complete(challenge.id, ok ? 'completed' : 'failed', {
      response: response.confirmed,
      attestation: response.attestation,
      ...(exchange.errorCode ? { reason: exchange.errorCode } : {}),
    })
    // the opener closes the flow when the carrier protocol ends (flow profile §5.2)
    if (exchange.flowId)
      await this.agent.flows.close(exchange.flowId, ok ? 'completed' : 'failed', {
        reason: ok ? undefined : 'Not confirmed.',
      })
  }

  /**
   * `session-grant/1.0/request` (D56, CHAN-BIND-014): a single-use grant for the connection's resolved Principal,
   * with the sessions URL; refused on a connection without a Principal.
   */
  private async onSessionGrantStateChanged(exchange: CarrierExchange & { previousState?: string }): Promise<void> {
    if (exchange.state !== 'request-received') return
    const bound = await this.agent.didcommSession(exchange.connectionId)
    if (!bound) {
      this.logger.warn(
        { connectionId: exchange.connectionId },
        'session grant requested before the principal was resolved'
      )
      if (exchange.flowId)
        await this.agent.flows.problemReport(
          exchange.flowId,
          'not-eligible',
          'This connection has no resolved principal.'
        )
      return
    }
    const request = exchange.request as {
      conversationId?: string | null
      newConversation?: boolean
      client?: { description?: string; platform?: string; appVersion?: string }
    }
    const { grant, expiresAt } = await this.agent.sessions.issueGrant({
      principalId: bound.principal.id,
      connectionId: exchange.connectionId,
      client: {
        name: 'Ayni',
        version: request.client?.appVersion ?? '',
        platform: request.client?.platform ?? 'web',
        description: request.client?.description,
      },
      conversationId: request.conversationId ?? undefined,
      newConversation: request.newConversation === true,
    })
    await this.client.grantSession(exchange.threadId, {
      grant,
      sessionsUrl: `${this.agent.env.publicBaseUrl}/agui/v3/sessions`,
      expiresAt,
    })
  }

  /** `link-session/1.0/response`: the binding answer of a flow-capable wallet (CHAN-BIND-009/012). */
  private async onLinkSessionStateChanged(exchange: CarrierExchange & { previousState?: string }): Promise<void> {
    if (exchange.state !== 'response-received' && exchange.state !== 'failed') return
    const connectionId = exchange.connectionId
    const key = `${connectionId}:${exchange.threadId}`
    const response = (exchange.response ?? {}) as { link?: boolean; code?: string | null }
    const linked = exchange.state === 'response-received' && response.link === true
    const settle = async (flowId: string | undefined, bound: boolean, sessionId?: string) => {
      if (!flowId) return
      await this.agent.flows.close(flowId, bound ? 'completed' : 'cancelled', {
        reason: bound ? undefined : 'Not linked.',
        references: bound && sessionId ? [{ type: 'session', id: sessionId }] : undefined,
      })
    }
    // a re-link of a known device: the right code binds (CHAN-BIND-012)
    const rebind = this.rebinds.get(key)
    if (rebind) {
      this.rebinds.delete(key)
      const flowId = this.linkFlows.get(key)
      this.linkFlows.delete(key)
      const session = await this.agent.sessions.get(rebind.sessionId)
      const bound = await this.agent.didcommSession(connectionId)
      const codeOk = (response.code ?? '').replace(/\s+/g, '').toUpperCase() === session?.binding?.bindingCode
      if (
        !linked ||
        !codeOk ||
        !session ||
        !bound ||
        session.state !== 'provisional' ||
        !session.binding ||
        Date.parse(session.binding.expiresAt) < Date.now()
      ) {
        await settle(flowId, false)
        return
      }
      try {
        await this.agent.sessions.bind(session, bound.principal, session.binding.nonce)
        await settle(flowId, true, session.id)
        await this.agent.welcome(session)
      } catch (error) {
        this.logger.warn({ err: error, sessionId: session.id }, 'rebind refused')
        await settle(flowId, false)
      }
      return
    }
    // the binding question of a provisional session (CHAN-BIND-009)
    const binding = await this.agent.sessions.findByConfirmation(connectionId, exchange.threadId)
    if (!binding?.binding) return
    const flowId = binding.binding.flowId ?? exchange.flowId
    if (binding.state !== 'provisional' || !linked) {
      await settle(flowId, false)
      return
    }
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    try {
      await this.agent.sessions.bind(binding, bound.principal, binding.binding.nonce)
      await settle(flowId, true, binding.id)
      await this.agent.welcome(binding)
    } catch (error) {
      this.logger.warn({ err: error, sessionId: binding.id }, 'binding refused')
      await settle(flowId, false)
    }
  }

  // ---- conversation on DIDComm (CHAN-ROUTE-003) ---------------------------------------------------------

  private sinkFor(session: Session): TurnSink {
    const client = this.client
    let buffer = ''
    return {
      emit: async (event) => {
        if (event.type === 'text-delta') buffer += event.delta
        else if (event.type === 'text-end') {
          const text = buffer
          buffer = ''
          if (text.trim()) await this.adapter.sendText(session, text)
        } else if (event.type === 'activity' && event.activityType === 'ayni.menu') {
          const content = event.content as { prompt: string; items: { label: string }[] }
          await client.sendQuestion(
            session.externalRef,
            content.prompt,
            content.items.map((i) => i.label)
          )
        }
      },
    }
  }

  private async turn(session: Session, text: string, attachments?: MessageAttachment[]): Promise<void> {
    const principal = await this.agent.principalOf(session)
    if (!principal) return
    const command = await this.agent.sessionsCommand(session, text)
    if (command !== undefined) {
      await this.adapter.sendText(session, command)
      return
    }
    await this.agent.turn(
      session,
      {
        entry: {
          sessionId: session.id,
          principalId: principal.id,
          role: 'principal',
          sourceType: attachments?.some((a) => a.type === 'voice') ? 'voice' : attachments?.length ? 'media' : 'text',
          text,
          attachments,
          backingIdentity: principal.backingIdentity,
        },
      },
      this.sinkFor(session),
      new AbortController().signal
    )
  }

  /** Message states for what the person sent (INTX-STATE-001): received at once, viewed when the agent reads it. */
  private async receipt(connectionId: string, messageId: string, state: 'received' | 'viewed'): Promise<void> {
    if (!messageId || !this.agent.features.receipts) return
    if (await this.adapter.flowMode(connectionId)) return // no receipts in flow mode (D54)
    await this.client
      .sendReceipts(connectionId, [{ messageId, state, timestamp: new Date().toISOString() }])
      .catch((err) => this.logger.debug({ err, messageId, state }, 'receipt not sent'))
  }

  private async onText(connectionId: string, content: string, messageId: string): Promise<void> {
    await this.receipt(connectionId, messageId, 'received')
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    await this.receipt(connectionId, messageId, 'viewed')
    const awaiting = this.awaitingCode.get(connectionId)
    if ((awaiting && awaiting > Date.now()) || /^\/link\b/i.test(content.trim())) {
      if (await this.linkByCode(connectionId, content.replace(/^\/link\s*/i, ''))) return
    }
    if (await this.adapter.flowMode(connectionId)) {
      // no chat on a flow-mode connection (D54): the wallet talks through its own sessions
      this.logger.debug({ connectionId }, 'basic message ignored in flow mode')
      return
    }
    await this.turn(bound.session, content)
  }

  private async onContextualSelect(connectionId: string, itemId: string): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound || (await this.adapter.flowMode(connectionId))) return
    const result = await this.agent.action(
      bound.session,
      { kind: 'contextual.select', itemId },
      this.sinkFor(bound.session),
      new AbortController().signal
    )
    if (result && 'await' in result && result.await === 'binding-code')
      this.awaitingCode.set(connectionId, Date.now() + 5 * 60_000)
    if (result && 'text' in result && result.text) await this.adapter.sendText(bound.session, result.text)
  }

  private async onMenuRequest(connectionId: string): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound || (await this.adapter.flowMode(connectionId))) return
    await this.agent.router.deliver(bound.session, { kind: 'contextual-menu', sessionId: bound.session.id })
  }

  private async onReactions(
    connectionId: string,
    reactions: { messageId: string; emoji: string; action: 'add' | 'remove' }[]
  ): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound || (await this.adapter.flowMode(connectionId))) return
    for (const r of reactions) {
      const entry = await this.agent.memory.findByExternalId(bound.session.id, r.messageId)
      await this.agent.action(
        bound.session,
        { kind: 'reaction', messageId: entry?.id ?? r.messageId, emoji: r.emoji, action: r.action },
        this.sinkFor(bound.session),
        new AbortController().signal
      )
    }
  }

  private async onReceipts(connectionId: string, receipts: { messageId: string; state: string }[]): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound || (await this.adapter.flowMode(connectionId))) return
    const viewed = receipts.filter((r) => r.state === 'viewed').map((r) => r.messageId)
    if (viewed.length)
      await this.agent.action(
        bound.session,
        { kind: 'receipt', messageIds: viewed, state: 'viewed' },
        this.sinkFor(bound.session),
        new AbortController().signal
      )
  }

  private async onMedia(connectionId: string, data: Record<string, unknown>): Promise<void> {
    const messageId = String(data.threadId ?? data.id ?? '')
    await this.receipt(connectionId, messageId, 'received')
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    await this.receipt(connectionId, messageId, 'viewed')
    const items =
      (data.items as
        | {
            uri: string
            mimeType: string
            fileName?: string
            description?: string
            ciphering?: { algorithm: string; parameters: { key: string; iv: string } }
          }[]
        | undefined) ?? []
    const attachments = []
    for (const item of items) {
      try {
        const response = await fetch(item.uri)
        if (!response.ok) continue
        let bytes = Buffer.from(await response.arrayBuffer())
        if (item.ciphering?.algorithm === 'aes-256-cbc') {
          const { createDecipheriv } = await import('node:crypto')
          const d = createDecipheriv(
            'aes-256-cbc',
            Buffer.from(item.ciphering.parameters.key, 'hex'),
            Buffer.from(item.ciphering.parameters.iv, 'hex')
          )
          bytes = Buffer.concat([d.update(bytes), d.final()])
        }
        attachments.push(
          await this.agent.media.ingest(
            bound.session,
            bytes,
            item.mimeType,
            item.fileName,
            this.agent.pack.language.agent
          )
        )
      } catch (error) {
        this.logger.warn({ err: error, uri: item.uri }, 'inbound media could not be fetched')
      }
    }
    if (!attachments.length) return
    const text = String(data.description ?? '') || attachments.map((a) => a.textRepr).join('\n')
    await this.turn(bound.session, text, attachments)
  }

  // ---- challenges (INTX-AUTH-007/009) ----------------------------------------------------------------

  private async onCallEnded(connectionId: string, threadId: string, rejected: boolean): Promise<void> {
    const challenge = await this.agent.challenges.findPendingByThread(connectionId, threadId)
    if (challenge && rejected) await this.agent.challenges.complete(challenge.id, 'failed', { reason: 'call-rejected' })
  }

  private async onDocument(
    connectionId: string,
    threadId: string,
    ok: boolean,
    data: Record<string, unknown>
  ): Promise<void> {
    const challenge = await this.agent.challenges.findPendingByThread(connectionId, threadId)
    if (!challenge) return
    const groups = (data.dataGroups as { dg1?: unknown } | undefined) ?? {}
    await this.agent.challenges.complete(
      challenge.id,
      ok ? 'completed' : 'failed',
      ok ? { documentRead: true, hasDg1: 'dg1' in groups } : { reason: String(data.reason ?? 'refused') }
    )
  }
}
