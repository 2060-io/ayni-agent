/**
 * The DIDComm channel adapter: renders canonical entries and capability events as DIDComm messages
 * through the DIDComm agent, mints binding invitations, serves the trust-bound capability events
 * (CHAN-ADP-001/002, CHAN-ROUTE-001/003, CHAN-PROF-001/002, CHAN-BIND-008/009, INTX-AUTH-007/009).
 */
import { randomBytes } from 'node:crypto'
import type { HologramAgent } from '../../core/agent.js'
import type { CapabilityChannelOps } from '../../core/challenges.js'
import { type ChannelAdapter, DIDCOMM_CAPABILITIES, type RenderResult } from '../../core/channel.js'
import type { InvitationMinter } from '../../core/sessions.js'
import type {
  AuthChallengeRecord,
  CapabilityEvent,
  ClientDescription,
  MessageEntry,
  Session,
} from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import type { VsAgentClient } from './vsAgentClient.js'

export const BINDING_GOAL_CODE = 'hologram.bind-session'

/** Short-lived media links for the wallet: the agent streams decrypted bytes, keyed by a random token. */
export class MediaLinks {
  private readonly links = new Map<string, { sessionId: string; attachmentId: string; expiresAt: number }>()
  public constructor(private readonly ttlMs: number) {}
  public issue(sessionId: string, attachmentId: string): string {
    const token = randomBytes(24).toString('base64url')
    this.links.set(token, { sessionId, attachmentId, expiresAt: Date.now() + this.ttlMs })
    return token
  }
  public take(token: string): { sessionId: string; attachmentId: string } | undefined {
    const link = this.links.get(token)
    if (!link) return undefined
    if (link.expiresAt < Date.now()) {
      this.links.delete(token)
      return undefined
    }
    return link
  }
}

export class DidcommAdapter implements ChannelAdapter, CapabilityChannelOps, InvitationMinter {
  public readonly type = 'didcomm' as const
  public readonly capabilities = DIDCOMM_CAPABILITIES
  private agent?: HologramAgent

  public constructor(
    private readonly client: VsAgentClient,
    private readonly publicBaseUrl: string,
    private readonly mediaLinks: MediaLinks,
    private readonly webrtcServerUrl: string | undefined,
    readonly _logger: Logger
  ) {}

  public attach(agent: HologramAgent): void {
    this.agent = agent
  }

  // ---- InvitationMinter (CHAN-BIND-008) -----------------------------------------------------------

  public async mint(
    sessionId: string,
    client: ClientDescription
  ): Promise<{ invitationId: string; outOfBandId: string; url: string }> {
    const result = await this.client.createOutOfBandInvitation({
      goalCode: BINDING_GOAL_CODE,
      goal: `Link ${client.name} on ${client.platform} (session ${sessionId.slice(-6)})`,
    })
    return { invitationId: result.invitationId, outOfBandId: result.outOfBandId, url: result.url }
  }

  // ---- CapabilityChannelOps -------------------------------------------------------------------------

  public async askQuestion(
    connectionId: string,
    question: string,
    detail: string | undefined,
    answers: string[]
  ): Promise<string> {
    const { id } = await this.client.sendQuestion(connectionId, question, answers, detail)
    return id
  }

  public async offerFaceMatchCall(
    connectionId: string,
    challenge: AuthChallengeRecord,
    description: string
  ): Promise<string> {
    if (!this.webrtcServerUrl) throw new Error('WEBRTC_SERVER_URL is not configured')
    const response = await fetch(`${this.webrtcServerUrl.replace(/\/+$/, '')}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventNotificationUri: `${this.publicBaseUrl}/webrtc/call-event`, maxPeerCount: 50 }),
    })
    if (!response.ok) throw new Error(`webrtc room creation HTTP ${response.status}`)
    const room = (await response.json()) as { wsUrl: string; roomId: string }
    const peerId = randomBytes(12).toString('hex')
    challenge.details = { ...(challenge.details ?? {}), wsUrl: room.wsUrl, roomId: room.roomId, peerId }
    const { id } = await this.client.offerCall(
      connectionId,
      'service',
      { ...room, peerId, protocol: '2060-mediasoup-v1' },
      description,
      challenge.expiresAt
    )
    return id
  }

  public async requestDocument(connectionId: string): Promise<string> {
    const { id } = await this.client.requestEmrtd(connectionId)
    return id
  }

  // ---- ChannelAdapter (CORE-MSG-008) ------------------------------------------------------------------

  public async render(session: Session, event: CapabilityEvent): Promise<RenderResult> {
    const connectionId = session.externalRef
    switch (event.kind) {
      case 'text':
        await this.sendEntryText(connectionId, event.entry)
        await this.sendContextualMenu(session).catch(() => undefined)
        return 'ok'
      case 'menu':
        await this.client.sendQuestion(
          connectionId,
          event.prompt,
          event.items.map((i) => i.label)
        )
        return 'ok'
      case 'media': {
        const items = event.entry.attachments.map((a) => ({
          uri: `${this.publicBaseUrl}/media/${this.mediaLinks.issue(session.id, a.id)}`,
          mimeType: a.mimeType,
          fileName: a.filename,
          description: a.textRepr.slice(0, 200),
          byteCount: a.size,
        }))
        if (!items.length) return 'unsupported'
        await this.client.shareMedia(connectionId, items, event.entry.text.slice(0, 200))
        return 'ok'
      }
      case 'approval': {
        const a = event.approval
        const text = event.update
          ? `Approval for ${a.toolName} requested by ${a.requesterName}: ${a.status}.`
          : `${a.requesterName} asks to run ${a.toolName}${a.purpose ? ` for "${a.purpose}"` : ''}${a.justification ? `: ${a.justification}` : ''}.`
        if (event.update || a.status !== 'PENDING') {
          await this.client.sendText(connectionId, text)
        } else {
          await this.client.sendQuestion(connectionId, text, ['Approve', 'Reject'], `Approval ${a.id}`)
        }
        return 'ok'
      }
      case 'reaction':
        if (event.origin === 'principal') return 'ok' // the phone already shows what its user did
        await this.client.sendReactions(connectionId, [
          { messageId: event.messageId, emoji: event.emoji, action: event.action },
        ])
        return 'ok'
      case 'receipt':
        await this.client.sendReceipts(
          connectionId,
          event.messageIds.map((messageId) => ({ messageId, state: event.state }))
        )
        return 'ok'
      case 'contextual-menu':
        await this.sendContextualMenu(session)
        return 'ok'
      case 'generating':
        await this.client.sendText(connectionId, 'Working on your image, it will arrive shortly.')
        return 'ok'
      case 'routed': {
        // the capability channel serves the event itself; a status mirror is not needed here
        if (event.status === 'pending') return 'ok'
        return 'ok'
      }
    }
  }

  private async sendEntryText(connectionId: string, entry: MessageEntry): Promise<void> {
    const text = entry.completion === 'interrupted' ? `${entry.text}\n(interrupted)` : entry.text
    await this.client.sendText(connectionId, text)
  }

  /** The wallet keeps the last contextual menu it received: every message re-sends the current one (INTX-MENU-002). */
  public async sendContextualMenu(session: Session): Promise<void> {
    if (!this.agent) return
    const state = await this.agent.hologramState(session)
    const options = state.contextualMenu.items.map((i) => ({
      name: i.id,
      title: i.badge ? `${i.label} (${i.badge})` : i.label,
      description: '',
    }))
    if (!options.length) return
    await this.client.sendActionMenu(session.externalRef, this.agent.pack.metadata.displayName, 'Options', options)
  }

  /** A reply on the capability channel: the text, then the menu that reflects the new state. */
  public async sendText(session: Session, text: string): Promise<void> {
    if (text.trim()) await this.client.sendText(session.externalRef, text)
    await this.sendContextualMenu(session).catch(() => undefined)
  }
}

export function clientOfConnection(label: string | undefined, version?: string): ClientDescription {
  return { name: label ?? 'DIDComm peer', version: version ?? '', platform: 'didcomm' }
}

export const didcommLogger = (logger: Logger) => logger.child({ channel: 'didcomm' })
