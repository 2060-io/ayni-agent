/**
 * The DIDComm channel adapter: renders canonical entries and capability events as DIDComm messages
 * through the DIDComm agent, mints binding invitations, serves the trust-bound capability events
 * (CHAN-ADP-001/002, CHAN-ROUTE-001/003, CHAN-PROF-001/002/006, CHAN-BIND-008/009, INTX-AUTH-007/009).
 * The profile is per peer (D54): a flow-capable wallet is served in flow mode, with no chat, menus,
 * receipts or reactions on its connection.
 */
import { randomBytes } from 'node:crypto'
import type { AyniAgent } from '../../core/agent.js'
import { type CapabilityChannelOps, challengeCode, confirmationText } from '../../core/challenges.js'
import {
  type Capability,
  type ChannelAdapter,
  DIDCOMM_CAPABILITIES,
  DIDCOMM_FLOW_MODE_CAPABILITIES,
  type RenderResult,
  type WakeUp,
} from '../../core/channel.js'
import { clientDescriptionOf, type FlowService } from '../../core/flows.js'
import type { InvitationMinter } from '../../core/sessions.js'
import type {
  ApprovalRecord,
  AuthChallengeRecord,
  CapabilityEvent,
  ClientDescription,
  MessageEntry,
  Session,
} from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import type { PeerProfiles } from './peerProfiles.js'
import type { VsAgentClient } from './vsAgentClient.js'

export const BINDING_GOAL_CODE = 'ayni.bind-session'

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
  private agent?: AyniAgent
  private flows?: FlowService
  /** `authorize` flows sent to approvers' phones, by approval and connection, and by connection and request id */
  private readonly authorizeByApproval = new Map<string, { flowId: string; threadId: string }>()
  private readonly authorizeByThread = new Map<string, { flowId: string; approvalId: string }>()

  public constructor(
    private readonly client: VsAgentClient,
    private readonly publicBaseUrl: string,
    private readonly mediaLinks: MediaLinks,
    private readonly webrtcServerUrl: string | undefined,
    private readonly peers: PeerProfiles,
    readonly _logger: Logger
  ) {}

  public attach(agent: AyniAgent): void {
    this.agent = agent
  }

  public setFlows(flows: FlowService): void {
    this.flows = flows
  }

  // ---- per-peer profile (CHAN-PROF-006) ---------------------------------------------------------------

  public async capabilitiesFor(session: Session): Promise<ReadonlySet<Capability>> {
    return (await this.flowMode(session.externalRef)) ? DIDCOMM_FLOW_MODE_CAPABILITIES : DIDCOMM_CAPABILITIES
  }

  /** Whether the connection's peer disclosed `ayni-flow/1.0` and is therefore served in flow mode (D54). */
  public flowMode(connectionId: string): Promise<boolean> {
    return this.peers.isFlowCapable(connectionId)
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

  /** INTX-AUTH-009: a `confirm` flow on a flow-capable wallet, a question-answer message otherwise. */
  public async askConfirmation(
    connectionId: string,
    challenge: AuthChallengeRecord,
    purpose: string,
    originSession: Session
  ): Promise<{ threadId: string; flowId?: string }> {
    const text = confirmationText(purpose)
    const code = challengeCode(challenge)
    const name = this.agent?.pack.metadata.displayName ?? 'The agent'
    if (this.flows && (await this.flowMode(connectionId))) {
      const flow = await this.flows.open({
        connectionId,
        kind: 'confirm',
        title: text,
        description: `${name} asks you to confirm this action.`,
        origin: originSession,
        expiresAt: challenge.expiresAt,
      })
      try {
        const exchange = await this.client.sendConfirmRequest({
          connectionId,
          flowId: flow.flowId,
          request: { text, code, attested: true },
        })
        return { threadId: exchange.threadId, flowId: flow.flowId }
      } catch (error) {
        await this.flows.close(flow.flowId, 'failed', { reason: 'The confirmation request could not be sent.' })
        throw error
      }
    }
    const threadId = await this.askQuestion(
      connectionId,
      text,
      `${name} asks you to confirm this action on your phone. Code ${code}.`,
      ['Yes', 'No']
    )
    return { threadId }
  }

  /**
   * The binding question on a flow-capable wallet (CHAN-BIND-009/012, FLOW-LINK-001/003): a `link-session` flow
   * naming the agent, the browser, the web origin, the start time and the invitation id; `codes` when the person
   * must pick the code the screen shows. Returns the request id (the correlation thread) and the flow id.
   */
  public async askLinkSession(
    connectionId: string,
    session: Session,
    codes?: string[]
  ): Promise<{ threadId: string; flowId: string }> {
    if (!this.flows || !this.agent) throw new Error('flows are not available')
    if (!session.binding) throw new Error('session has no binding material')
    const env = this.agent.env
    const flow = await this.flows.open({
      connectionId,
      kind: 'link-session',
      title: `Link ${session.client.name} on ${session.client.platform}`,
      origin: session,
      card: false,
      expiresAt: session.binding.expiresAt,
    })
    try {
      const exchange = await this.client.sendLinkSessionRequest({
        connectionId,
        flowId: flow.flowId,
        request: {
          agent: { did: this.agent.did ?? 'did:unknown', name: this.agent.pack.metadata.displayName },
          browser: clientDescriptionOf(session),
          webOrigin: env.aguiAllowedOrigins.find((o) => o !== '*') ?? env.publicBaseUrl,
          startedAt: session.createdAt,
          invitationId: session.binding.nonce,
          codes: codes ?? null,
        },
      })
      return { threadId: exchange.threadId, flowId: flow.flowId }
    } catch (error) {
      await this.flows.close(flow.flowId, 'failed', { reason: 'The link request could not be sent.' })
      throw error
    }
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
        if (await this.flowMode(connectionId)) return this.renderApprovalAsFlow(connectionId, a, event.update === true)
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
      case 'routed':
        // the capability channel serves the event itself; a status mirror is not needed here
        return 'ok'
      case 'flow':
        // the flow card belongs to the conversation; on the capability channel the flow itself is the record
        return 'ok'
    }
  }

  // ---- approvals and wake-ups on a flow-capable wallet (D57, D58) -----------------------------------

  /**
   * An attested approval reaches the approver's phone as an `authorize` flow (INTX-APPR-011); a non-attested one
   * is decided from the approver's own conversations (the AG-UI card). A later change closes the flow.
   */
  private async renderApprovalAsFlow(connectionId: string, a: ApprovalRecord, update: boolean): Promise<RenderResult> {
    const key = `${a.id}:${connectionId}`
    const open = this.authorizeByApproval.get(key)
    if (update || a.status !== 'PENDING') {
      if (open && this.flows) {
        this.authorizeByApproval.delete(key)
        this.authorizeByThread.delete(`${connectionId}:${open.threadId}`)
        await this.flows.close(
          open.flowId,
          a.status === 'APPROVED' || a.status === 'REJECTED' ? 'completed' : 'cancelled',
          {
            reason:
              a.status === 'APPROVED' || a.status === 'REJECTED'
                ? undefined
                : `The request is ${a.status.toLowerCase()}.`,
          }
        )
      }
      return 'ok'
    }
    if (!a.attested || !this.flows || open) return 'ok'
    const flow = await this.flows.open({
      connectionId,
      kind: 'authorize',
      title: `${a.requesterName} asks to run ${a.toolName}`,
      description: a.justification ?? a.purpose,
      expiresAt: a.expiresAt,
    })
    try {
      const exchange = await this.client.sendAuthorizeRequest({
        connectionId,
        flowId: flow.flowId,
        request: {
          requester: { name: a.requesterName, role: a.requesterRole || null, did: null },
          purpose: { id: a.purpose ?? a.toolName, label: a.purpose ?? a.toolName },
          justification: a.justification ?? '',
          scope: [`tool:${a.serverName ? `${a.serverName}.` : ''}${a.toolName}`],
          expiresAt: a.expiresAt,
          attested: true,
        },
      })
      this.authorizeByApproval.set(key, { flowId: flow.flowId, threadId: exchange.threadId })
      this.authorizeByThread.set(`${connectionId}:${exchange.threadId}`, { flowId: flow.flowId, approvalId: a.id })
      return 'ok'
    } catch (error) {
      await this.flows.close(flow.flowId, 'failed', { reason: 'The authorization request could not be sent.' })
      throw error
    }
  }

  /** The approval an `authorize` response answers, consumed once. */
  public takeAuthorize(connectionId: string, threadId: string): { flowId: string; approvalId: string } | undefined {
    const key = `${connectionId}:${threadId}`
    const found = this.authorizeByThread.get(key)
    if (found) {
      this.authorizeByThread.delete(key)
      this.authorizeByApproval.delete(`${found.approvalId}:${connectionId}`)
    }
    return found
  }

  /** `notify` on a flow-capable wallet that disclosed the protocol (INTX-NOTIFY-001); nothing otherwise. */
  public async notify(connectionId: string, notification: WakeUp): Promise<boolean> {
    if (!(await this.flowMode(connectionId))) return false
    if (!(await this.peers.supports(connectionId, 'https://didcomm.org/notify/1.0'))) return false
    await this.client.sendNotification({ connectionId, notification })
    return true
  }

  private async sendEntryText(connectionId: string, entry: MessageEntry): Promise<void> {
    const text = entry.completion === 'interrupted' ? `${entry.text}\n(interrupted)` : entry.text
    await this.client.sendText(connectionId, text)
  }

  /** The wallet keeps the last contextual menu it received: every message re-sends the current one (INTX-MENU-002). */
  public async sendContextualMenu(session: Session): Promise<void> {
    if (!this.agent) return
    if (await this.flowMode(session.externalRef)) return // no menus in flow mode (D54)
    const state = await this.agent.ayniState(session)
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

  /** A notice: the one use of basic messages on a flow-mode connection (D54). */
  public async notice(connectionId: string, text: string): Promise<void> {
    if (text.trim()) await this.client.sendText(connectionId, text)
  }
}

export function clientOfConnection(label: string | undefined, version?: string): ClientDescription {
  return { name: label ?? 'DIDComm peer', version: version ?? '', platform: 'didcomm' }
}

export const didcommLogger = (logger: Logger) => logger.child({ channel: 'didcomm' })
