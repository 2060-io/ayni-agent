/**
 * The DIDComm channel adapter: renders canonical entries and capability events as DIDComm messages
 * through the DIDComm agent, mints binding invitations, serves the trust-bound capability events
 * (CHAN-ADP-001/002, CHAN-ROUTE-001/003, CHAN-PROF-001/002/006, CHAN-BIND-008/009, INTX-AUTH-007/009).
 * The profile is per peer (D54): a flow-capable wallet is served in flow mode, with no chat, menus,
 * receipts or reactions on its connection.
 */
import { randomBytes } from 'node:crypto'
import type { AyniAgent } from '../../core/agent.js'
import {
  type CapabilityChannelOps,
  type ConfirmationOptions,
  challengeCode,
  confirmationText,
} from '../../core/challenges.js'
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
import { attestedFor } from '../../policy/spacePolicy.js'
import type { Logger } from '../../util/logger.js'
import type { PeerProfiles } from './peerProfiles.js'
import type { VsAgentClient } from './vsAgentClient.js'

/** goal_code of a binding invitation (flow profile §4, FLOW-CONN-001): a web UI's session linked by the phone. */
export const BINDING_GOAL_CODE = 'ayni.link-session'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function decoyCode(): string {
  const pick = () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return `${pick()}${pick()}-${pick()}${pick()}`
}

/** The session's binding code and two decoys, shuffled: the person taps the one the browser shows (D5, FLOW-LINK-003). */
export function codesAround(real: string): string[] {
  const codes = new Set<string>([real])
  while (codes.size < 3) codes.add(decoyCode())
  return [...codes].sort(() => Math.random() - 0.5)
}

/**
 * The `oob=` URL of an invitation, as Credo writes it, on the DIDComm agent's public base URL, which the invitation's
 * short URL (`{base}/s?id=…`) is under (FLOW-CONN-001, PROF-BIND-001). The Ayni app reads `oob=`, not the short URL.
 */
export function invitationUrlOf(invitation: Record<string, unknown>, shortUrl: string): string {
  const short = new URL(shortUrl)
  const base = `${short.origin}${short.pathname.replace(/\/s\/?$/, '')}`
  return `${base}?oob=${Buffer.from(JSON.stringify(invitation)).toString('base64url')}`
}
/** kv index of the open `authorize` flow per approval and phone: `<prefix><approvalId>:<connectionId>` → flow id */
const AUTHORIZE_INDEX = 'authorize:'

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

/** The protocol a phone reads the chip of a travel document with (flow profile §3). */
export const MRTD_PROTOCOL = 'https://didcomm.org/mrtd/1.0'

export class DidcommAdapter implements ChannelAdapter, CapabilityChannelOps, InvitationMinter {
  public readonly type = 'didcomm' as const
  public readonly capabilities = DIDCOMM_CAPABILITIES
  private agent?: AyniAgent
  private flows?: FlowService

  public constructor(
    private readonly client: VsAgentClient,
    private readonly publicBaseUrl: string,
    private readonly mediaLinks: MediaLinks,
    readonly _webrtcServerUrl: string | undefined,
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

  /**
   * A binding invitation is a standalone invitation record of the DIDComm agent: a connection it produces names the
   * record (`invitationId`), so a phone that connects for the first time is asked the binding question as one that
   * reuses its connection (CHAN-BIND-017). The record id is the session's `outOfBandId`, the invitation's `@id` its
   * nonce. DIDComm v1, single use (CC-VSA-008, PROF-BIND-002).
   */
  public async mint(
    sessionId: string,
    client: ClientDescription
  ): Promise<{ invitationId: string; outOfBandId: string; url: string }> {
    const result = await this.client.createInvitation({
      didcommVersion: 'v1',
      reusable: false,
      goalCode: BINDING_GOAL_CODE,
      goal: `Link ${client.name} on ${client.platform} (session ${sessionId.slice(-6)})`,
    })
    const invitationId = String(result.invitation['@id'] ?? result.invitation.id ?? '')
    if (!result.id || !invitationId) throw new Error('the DIDComm agent returned an invitation without its ids')
    return { invitationId, outOfBandId: result.id, url: invitationUrlOf(result.invitation, result.shortUrl) }
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
    originSession: Session,
    options: ConfirmationOptions = {}
  ): Promise<{ threadId: string; flowId?: string }> {
    const text = options.text ?? confirmationText(purpose)
    const code = options.code ?? challengeCode(challenge)
    const name = this.agent?.pack.metadata.displayName ?? 'The agent'
    if (this.flows && (await this.flowMode(connectionId))) {
      const flow = await this.flows.open({
        connectionId,
        kind: 'confirm',
        title: text,
        description: `${name} asks you to confirm this action.`,
        origin: originSession,
        expiresAt: challenge.expiresAt,
        ...(options.card === false ? { card: false } : {}),
        ...(options.withoutConversation ? { withoutConversation: true } : {}),
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

  /** Closes the flow of a confirmation the agent withdrew (TOOL-SPACE-009). */
  public async cancelConfirmation(flowId: string): Promise<void> {
    await this.flows?.close(flowId, 'cancelled', { reason: 'The change was withdrawn.' })
  }

  /**
   * The binding question on a flow-capable wallet (CHAN-BIND-009/012, FLOW-LINK-001/003): a `link-session` flow
   * naming the agent, the browser, the web origin, the start time and the invitation id, with three `codes` on every
   * link, the scan path as the known-device re-link: the person taps the one the browser shows (D5 as amended on
   * 2026-11-21). Returns the request id (the correlation thread), the flow id and the codes sent.
   */
  public async askLinkSession(
    connectionId: string,
    session: Session
  ): Promise<{ threadId: string; flowId: string; codes: string[] }> {
    if (!this.flows || !this.agent) throw new Error('flows are not available')
    if (!session.binding) throw new Error('session has no binding material')
    const codes = codesAround(session.binding.bindingCode)
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
          codes,
        },
      })
      return { threadId: exchange.threadId, flowId: flow.flowId, codes }
    } catch (error) {
      await this.flows.close(flow.flowId, 'failed', { reason: 'The link request could not be sent.' })
      throw error
    }
  }

  /**
   * INTX-AUTH-010: the chip of a passport or of an identity card, read in one request under an `nfc-read` flow
   * (flow profile §6.3). Asked only of a phone that said it speaks the protocol, which it says only when it can
   * read a chip (FLOW-SENSOR-004, FLOW-CAP-003).
   */
  public async requestDocument(
    connectionId: string,
    challenge: AuthChallengeRecord,
    purpose: string,
    originSession: Session
  ): Promise<{ threadId: string; flowId: string }> {
    if (!this.flows || !(await this.flowMode(connectionId))) throw new Error('the peer takes no flow')
    if (!(await this.peers.supports(connectionId, MRTD_PROTOCOL)))
      throw new Error('the phone did not say that it can read the chip of a document')
    const name = this.agent?.pack.metadata.displayName ?? 'The agent'
    const flow = await this.flows.open({
      connectionId,
      kind: 'nfc-read',
      title: 'Read your passport or identity card',
      description: `${name} asks to read the chip of your document: ${purpose}.`,
      origin: originSession,
      expiresAt: challenge.expiresAt,
    })
    try {
      const { id } = await this.client.requestEmrtd(connectionId, flow.flowId)
      return { threadId: id, flowId: flow.flowId }
    } catch (error) {
      await this.flows.close(flow.flowId, 'failed', { reason: 'The request to read the document could not be sent.' })
      throw error
    }
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
        // a flow-capable approver's phone takes the approval as an `authorize` flow, opened for it alone (D114); the
        // requester's card is the conversation's, never the phone's
        if (await this.flowMode(connectionId)) return 'ok'
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

  // ---- approvals and wake-ups on a flow-capable wallet (D57, D58, D114) ------------------------------

  /** Whether the session's peer takes the `authorize` flow of an approval: a flow-capable wallet (D54). */
  public async takesApprovalFlows(session: Session): Promise<boolean> {
    return session.channelType === 'didcomm' && !!this.flows && (await this.flowMode(session.externalRef))
  }

  /**
   * Every pending approval an approver can decide reaches their phone as one `authorize` flow, whatever its policy
   * (INTX-APPR-011, FLOW-AUTH-003): `attested` as the policy sets it, always for a requester's own confirmation
   * (INTX-APPR-023); `origin: none`, so that no conversation records a card of it; and `link` to the Notifications that
   * list it. One flow per approval and phone: the open one is kept in the store, so a restart still closes or answers
   * it. False when one was open already.
   */
  public async openApprovalFlow(
    session: Session,
    a: ApprovalRecord,
    link: string | undefined,
    approverId: string
  ): Promise<boolean> {
    const connectionId = session.externalRef
    const key = `${AUTHORIZE_INDEX}${a.id}:${connectionId}`
    const kv = this.agent?.store.kv
    if (!this.flows || !kv || a.status !== 'PENDING') return false
    if (await kv.get(key)) return false
    // a tool call's approval: the exact call as its justification, the action's title as its purpose (INTX-APPR-013);
    // an elevation: the purpose the person declared, by its label in the governance list, and their justification
    const call = a.action ? authorizeOfCall(a) : undefined
    const label = a.purpose ? this.agent?.pack.purposes?.find((p) => p.id === a.purpose)?.label : undefined
    const flow = await this.flows.open({
      connectionId,
      kind: 'authorize',
      // the requester's own confirmation says it is theirs (INTX-APPR-023, FLOW-AUTH-004)
      title:
        approverId === a.requesterId
          ? `Your own request: ${a.action?.title ?? a.toolName}`
          : `${a.requesterName} asks to run ${a.action?.title ?? a.toolName}`,
      description: call?.justification ?? a.justification ?? a.purpose,
      expiresAt: a.expiresAt,
      ...(link ? { link } : {}),
      ref: { type: 'approval', id: a.id },
    })
    try {
      // an approval of a tool of a space is one of several decisions: the threshold, the approver's own request, the
      // other entries as they are now; never sent again to show a later progress (FLOW-AUTH-004, INTX-APPR-026)
      const approvals = await this.agent?.governance?.approvalsFor(a, approverId)
      await this.client.sendAuthorizeRequest({
        connectionId,
        flowId: flow.flowId,
        request: {
          requester: { name: a.requesterName, role: a.requesterRole || null, did: null },
          purpose: call?.purpose ?? { id: a.purpose ?? a.toolName, label: label ?? a.purpose ?? a.toolName },
          justification: call?.justification ?? a.justification ?? '',
          scope: call?.scope ?? [`tool:${a.serverName ? `${a.serverName}.` : ''}${a.toolName}`],
          expiresAt: a.expiresAt,
          attested: attestedFor(a, approverId),
          ...(approvals ? { approvals } : {}),
        },
      })
      await kv.set(key, flow.flowId)
      return true
    } catch (error) {
      await this.flows.close(flow.flowId, 'failed', { reason: 'The authorization request could not be sent.' })
      throw error
    }
  }

  /**
   * Closes the flow of an approval this phone holds (INTX-APPR-011): once this approver decided elsewhere, once the
   * approval ended, or before it is sent again (INTX-APPR-019). False when the phone held none.
   */
  public async closeApprovalFlow(
    session: Session,
    a: ApprovalRecord,
    outcome: 'completed' | 'cancelled',
    reason?: string
  ): Promise<boolean> {
    const key = `${AUTHORIZE_INDEX}${a.id}:${session.externalRef}`
    const kv = this.agent?.store.kv
    const open = kv ? await kv.get(key) : undefined
    if (!open || !this.flows || !kv) return false
    await kv.set(key, '')
    await this.flows.close(open, outcome, reason ? { reason } : {})
    return true
  }

  /** The approval an `authorize` response answers (from the flow's persisted handle), consumed once. */
  public async takeAuthorize(
    connectionId: string,
    flowId: string | undefined
  ): Promise<{ flowId: string; approvalId: string } | undefined> {
    if (!flowId || !this.flows || !this.agent) return undefined
    const handle = await this.flows.handle(flowId)
    if (handle?.ref?.type !== 'approval' || handle.connectionId !== connectionId) return undefined
    await this.agent.store.kv.set(`${AUTHORIZE_INDEX}${handle.ref.id}:${connectionId}`, '')
    return { flowId, approvalId: handle.ref.id }
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

/**
 * The `authorize` request of a tool call's approval (INTX-APPR-013): its purpose names the action, its justification is the
 * exact call as text (the source's title and whose account on the first line, then one line per argument, its label, a
 * colon and its whole value), and its scope names the tool and the space.
 */
export function authorizeOfCall(a: ApprovalRecord): {
  purpose: { id: string; label: string }
  justification: string
  scope: string[]
} {
  const action = a.action as NonNullable<ApprovalRecord['action']>
  const whose =
    action.account.kind === 'space'
      ? `with the account of ${action.account.space?.title ?? 'the space'}`
      : action.account.kind === 'agent'
        ? "with the agent's account"
        : 'with no account'
  const lines = [`${action.source.title}, ${whose}`, ...action.fields.map((f) => `${f.label}: ${f.value}`)]
  return {
    purpose: { id: 'tool-call', label: action.title },
    justification: lines.join('\n'),
    scope: [`tool:${action.source.id}.${a.toolName}`, ...(a.spaceId ? [`space:${a.spaceId}`] : [])],
  }
}
