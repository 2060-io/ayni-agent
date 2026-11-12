/**
 * Channel adapters are first-class peers (D1, CHAN-ADP-001/002). An adapter renders a capability
 * event on its transport or declares `unsupported` (CORE-MSG-008). The router picks a bound channel
 * whose profile supports the event; trust-bound events go to the DIDComm capability channel only
 * (D2, D40, CHAN-ROUTE-001/004/005, CHAN-PROF-002/005).
 */
import type { Store } from '../store/types.js'
import type { Logger } from '../util/logger.js'
import type { CapabilityEvent, ChannelType, Principal, Session } from './types.js'

export type Capability =
  | 'text'
  | 'menu'
  | 'media'
  | 'reaction'
  | 'receipt'
  | 'approval'
  | 'credential-exchange'
  | 'auth-challenge'

export type RenderResult = 'ok' | 'unsupported'

export interface ChannelAdapter {
  readonly type: ChannelType
  readonly capabilities: ReadonlySet<Capability>
  /** The profile for one session's peer when it differs from the channel's (DIDComm: per peer, CHAN-PROF-006). */
  capabilitiesFor?(session: Session): Promise<ReadonlySet<Capability>>
  /** `mirror`: the event was served on another session of the conversation; this one only shows it (PROF-STREAM-006). */
  render(session: Session, event: CapabilityEvent, options?: { mirror?: boolean }): Promise<RenderResult>
  /** Whether someone is listening on the session right now (AG-UI: an attached event stream), for wake-ups (D57). */
  isLive?(session: Session): boolean
  /** A wake-up on the capability channel (`notify`, D57); false when the peer cannot receive one. */
  notify?(connectionId: string, notification: WakeUp): Promise<boolean>
}

/** The `notify/1.0` notification (flow profile §6.10, INTX-NOTIFY-001). */
export interface WakeUp {
  conversationId: string
  sessionId?: string
  title: string
  preview?: string
  collapseKey: string
  priority: 'normal' | 'low'
}

export const AGUI_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'text',
  'menu',
  'media',
  'reaction',
  'receipt',
  'approval',
])
export const A2A_CAPABILITIES: ReadonlySet<Capability> = new Set(['text', 'menu', 'media', 'approval'])
export const DIDCOMM_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'text',
  'menu',
  'media',
  'reaction',
  'receipt',
  'approval',
  'credential-exchange',
  'auth-challenge',
])
/**
 * Flow mode (D54): a wallet that discloses `ayni-flow/1.0` gets no chat, menus, receipts or reactions on
 * its connection; the trust-bound capabilities are served as flows (INTX-FLOW-001).
 */
export const DIDCOMM_FLOW_MODE_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'credential-exchange',
  'auth-challenge',
  // an attested approval reaches a flow-capable approver as an `authorize` flow (D58)
  'approval',
])

export function capabilityOf(event: CapabilityEvent): Capability {
  switch (event.kind) {
    case 'text':
    case 'contextual-menu':
    case 'generating':
    case 'flow':
      return 'text'
    case 'menu':
      return 'menu'
    case 'media':
      return 'media'
    case 'approval':
      return 'approval'
    case 'reaction':
      return 'reaction'
    case 'receipt':
      return 'receipt'
    case 'routed':
      return event.trustBound === 'auth-challenge' || event.trustBound === 'confirmation'
        ? 'auth-challenge'
        : 'credential-exchange'
  }
}

/**
 * The events that are part of a conversation's transcript: every session of the conversation shows them. The
 * others (a session's own state, a receipt, the status of a routed capability, an approval sent to each eligible
 * session in its own shape) stay with the session they were made for.
 */
const CONVERSATION_EVENTS: ReadonlySet<CapabilityEvent['kind']> = new Set([
  'text',
  'menu',
  'media',
  'reaction',
  'generating',
  'flow',
])

export class CapabilityRouter {
  private readonly adapters = new Map<ChannelType, ChannelAdapter>()
  /** told when the agent adds a message to a conversation outside a turn; set where the services are wired */
  public onAgentMessage?: (session: Session) => Promise<void>

  public constructor(
    private readonly store: Store,
    private readonly logger: Logger
  ) {}

  public register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.type, adapter)
  }

  public adapter(type: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(type)
  }

  /**
   * Delivers an ordinary event on the session's own channel (served in place). What belongs to the conversation
   * (a message, a card, a reaction) is shown as well on the other sessions of that conversation, the person's
   * other devices (IDENT-SESS-016, PROF-STREAM-006); `peers: false` when the caller already reaches every session.
   */
  public async deliver(
    session: Session,
    event: CapabilityEvent,
    options: { peers?: boolean } = {}
  ): Promise<RenderResult> {
    const result = await this.render(session, event, false)
    if (options.peers !== false && CONVERSATION_EVENTS.has(event.kind)) {
      for (const peer of await this.conversationPeers(session)) await this.render(peer, event, true)
    }
    // a message the agent adds by itself is unread until a device shows it (IDENT-SESS-017)
    if ((event.kind === 'text' || event.kind === 'media') && event.entry.role === 'agent')
      await this.onAgentMessage?.(session).catch((error) =>
        this.logger.warn({ err: error, sessionId: session.id }, 'read state not updated')
      )
    return result
  }

  private async render(session: Session, event: CapabilityEvent, mirror: boolean): Promise<RenderResult> {
    const adapter = this.adapters.get(session.channelType)
    if (!adapter) return 'unsupported'
    const capability = capabilityOf(event)
    const capabilities = adapter.capabilitiesFor ? await adapter.capabilitiesFor(session) : adapter.capabilities
    if (!capabilities.has(capability)) return 'unsupported'
    try {
      return await adapter.render(session, event, mirror ? { mirror: true } : undefined)
    } catch (error) {
      this.logger.error({ err: error, sessionId: session.id, kind: event.kind }, 'render failed')
      return 'unsupported'
    }
  }

  /** The other bound AG-UI sessions on the conversation of this one. */
  private async conversationPeers(session: Session): Promise<Session[]> {
    if (session.channelType !== 'ag-ui' || !session.conversationId || !session.principalId) return []
    const open = await this.store.sessions.listByPrincipal(session.principalId, ['bound'])
    return open.filter(
      (s) => s.id !== session.id && s.channelType === 'ag-ui' && s.conversationId === session.conversationId
    )
  }

  /** Status of a trust-bound event mirrored to the originating session (CHAN-ROUTE-005). */
  public async notifyOrigin(
    originSessionId: string,
    event: Extract<CapabilityEvent, { kind: 'routed' }>
  ): Promise<void> {
    const session = await this.store.sessions.get(originSessionId)
    if (!session || session.state === 'closed') return
    const adapter = this.adapters.get(session.channelType)
    if (!adapter) return
    await adapter.render(session, event).catch((err) => this.logger.warn({ err }, 'routed status render failed'))
  }

  /** Fans an ordinary event out to every open session of a Principal (approval notifications, contextual menus). */
  public async broadcast(principal: Principal, event: CapabilityEvent, only?: (s: Session) => boolean): Promise<void> {
    const sessions = await this.store.sessions.listByPrincipal(principal.id, ['bound'])
    for (const session of sessions) {
      if (only && !only(session)) continue
      await this.deliver(session, event, { peers: false })
    }
  }

  public session(id: string): Promise<Session | undefined> {
    return this.store.sessions.get(id)
  }

  public isLive(session: Session): boolean {
    return this.adapters.get(session.channelType)?.isLive?.(session) ?? false
  }

  /** The Principal's capability channel: its bound DIDComm session, when live (D3). */
  public async capabilitySession(principal: Principal): Promise<Session | undefined> {
    if (!principal.capabilityChannelId) return undefined
    const sessions = await this.store.sessions.listByPrincipal(principal.id, ['bound'])
    return sessions.find((s) => s.channelType === 'didcomm' && s.externalRef === principal.capabilityChannelId)
  }
}
