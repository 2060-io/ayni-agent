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
  render(session: Session, event: CapabilityEvent): Promise<RenderResult>
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
])

export function capabilityOf(event: CapabilityEvent): Capability {
  switch (event.kind) {
    case 'text':
    case 'contextual-menu':
    case 'generating':
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
      return event.trustBound === 'auth-challenge' ? 'auth-challenge' : 'credential-exchange'
  }
}

export class CapabilityRouter {
  private readonly adapters = new Map<ChannelType, ChannelAdapter>()

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

  /** Delivers an ordinary event on the session's own channel (served in place). */
  public async deliver(session: Session, event: CapabilityEvent): Promise<RenderResult> {
    const adapter = this.adapters.get(session.channelType)
    if (!adapter) return 'unsupported'
    const capability = capabilityOf(event)
    const capabilities = adapter.capabilitiesFor ? await adapter.capabilitiesFor(session) : adapter.capabilities
    if (!capabilities.has(capability)) return 'unsupported'
    try {
      return await adapter.render(session, event)
    } catch (error) {
      this.logger.error({ err: error, sessionId: session.id, kind: event.kind }, 'render failed')
      return 'unsupported'
    }
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
      await this.deliver(session, event)
    }
  }

  /** The Principal's capability channel: its bound DIDComm session, when live (D3). */
  public async capabilitySession(principal: Principal): Promise<Session | undefined> {
    if (!principal.capabilityChannelId) return undefined
    const sessions = await this.store.sessions.listByPrincipal(principal.id, ['bound'])
    return sessions.find((s) => s.channelType === 'didcomm' && s.externalRef === principal.capabilityChannelId)
  }
}
