/**
 * The agent facade: wires the channel-agnostic core and exposes the operations channels call.
 * Channels never reach persistence or the model directly (architecture section 4).
 */

import {
  ACTIVITY,
  type AyniAction,
  type AyniState,
  type PrincipalDisplay,
  type SessionStatus,
} from '@ayni.org/ayni-agui-profile'
import type { CredentialOffers } from '../channels/didcomm/credentialOffers.js'
import { type IdentityRequests, identityOutcomeForPerson } from '../channels/didcomm/identityRequests.js'
import type { PeerStatusNotifier } from '../channels/didcomm/peerStatus.js'
import type { Env } from '../config/env.js'
import type { AgentPack, Features } from '../config/packTypes.js'
import { featuresOf, messageDeletionWindowSeconds } from '../config/packTypes.js'
import type { ChatModel } from '../llm/types.js'
import type { MediaService } from '../media/service.js'
import type { RagService } from '../memory/rag.js'
import { MemoryService, type NewEntry } from '../memory/service.js'
import type { StatsSink } from '../platform/stats.js'
import { type ApprovalChange, ApprovalError, type ApprovalService, displayName } from '../policy/approvals.js'
import { attestedFor } from '../policy/spacePolicy.js'
import type { Store } from '../store/types.js'
import type { ToolCatalog } from '../tools/catalog.js'
import type { ToolRegistry } from '../tools/registry.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { ChallengeService } from './challenges.js'
import type { CapabilityRouter } from './channel.js'
import type { ConnectionService } from './connections.js'
import type { ContextAssembler } from './context.js'
import { conversationOf } from './conversationOf.js'
import { CREDENTIAL_WITHHELD, CredentialScanner } from './credentials.js'
import { EMAIL_CHECK_KIND, type EmailChecks } from './emailCheck.js'
import type { EvidenceService } from './evidence.js'
import type { FlowService } from './flows.js'
import type { Governance } from './governance.js'
import { contextualMenuFor, describeDevices, describeSessions, greetingFor, PLATFORM_MENU } from './interaction.js'
import { DEFAULT_APP_LINK_BASE, type InvitationService } from './invitations.js'
import { type IssuanceService, type IssuanceTrigger, issuanceOutcomeForPerson } from './issuance.js'
import { Notifications } from './notifications.js'
import {
  conversationKey,
  type Orchestrator,
  type TurnContext,
  type TurnInput,
  type TurnResult,
  type TurnSink,
} from './orchestrator.js'
import type { PeopleService } from './people.js'
import type { PrincipalService, VerifiedFacts } from './principals.js'
import type { ServiceLanguage } from './serviceLanguage.js'
import { SessionError, type SessionService, TRANSCRIPT_MESSAGE_TYPES } from './sessions.js'
import { isPersonalSpace, personalSpaceId, SpaceError, type SpaceService, spaceIdOf } from './spaces.js'
import type { SpaceToolService } from './spaceTools.js'
import { approvalStateText, type ToolGate } from './toolGate.js'
import { TurnLock } from './turnLock.js'
import {
  type ApprovalRecord,
  type AuthChallengeRecord,
  CARD_STATE,
  type ClientDescription,
  type ClosureReason,
  type EvidenceRecord,
  type MessageEntry,
  type Principal,
  type Session,
  type ToolAction,
} from './types.js'
import { ProcessEnding, TooManyWaiting, type WaitingItem, WaitingList } from './waiting.js'

/** An approval reaches a person's phone again at most once in this time (PROF-TOOL-026, INTX-APPR-019). */
export const APPROVAL_RESEND_INTERVAL_MS = 30_000

export interface AgentParts {
  env: Env
  pack: AgentPack
  store: Store
  memory: MemoryService
  media: MediaService
  rag?: RagService
  principals: PrincipalService
  evidence: EvidenceService
  sessions: SessionService
  router: CapabilityRouter
  registry: ToolRegistry
  approvals: ApprovalService
  flows: FlowService
  challenges: ChallengeService
  orchestrator: Orchestrator
  /** the context of a turn and the figure of a conversation (D74, D75) */
  context: ContextAssembler
  /** spaces, their members and handovers (SPACE-DEF, SPACE-MEMB, SPACE-SHARE) */
  spaces: SpaceService
  llm: ChatModel
  stats: StatsSink
  logger: Logger
}

/** A sink that renders a server-initiated reply through the router (welcome, late results). */
export class RouterSink implements TurnSink {
  public constructor(
    private readonly agent: AyniAgent,
    private readonly session: Session
  ) {}
  public async emit(): Promise<void> {}
  public async text(entry: MessageEntry): Promise<void> {
    await this.agent.router.deliver(this.session, { kind: 'text', entry })
  }
}

/** A message that waits, as a device shows it (PROF-RUN-011). */
export interface WaitingView {
  /** the agent's id for the message */
  id: string
  sessionId: string
  /** the id the client gave it */
  messageId?: string
  text: string
  attachments: number
  at: string
}

/** Where the reply to what waited goes, for a turn the agent starts itself (PROF-RUN-012). */
export interface QueuedRun {
  sink: TurnSink
  /** aborted when the person stops the reply */
  signal: AbortSignal
  /** the turn has ended, well or not */
  finish(result?: TurnResult, error?: unknown): Promise<void>
}

export class AyniAgent {
  public readonly features: Features
  public readonly env: Env
  public readonly pack: AgentPack
  public readonly store: Store
  public readonly memory: MemoryService
  public readonly context: ContextAssembler
  public readonly spaces: SpaceService
  public readonly media: MediaService
  public readonly rag?: RagService
  public readonly principals: PrincipalService
  public readonly evidence: EvidenceService
  public readonly sessions: SessionService
  public readonly router: CapabilityRouter
  public readonly registry: ToolRegistry
  public readonly approvals: ApprovalService
  public readonly flows: FlowService
  /** the offers of issued credentials waiting for the wallet; set once the DIDComm side is wired */
  public credentialOffers?: Pick<CredentialOffers, 'onExchange'>
  /** credential issuance; set once the DIDComm side is wired (INTX-ISSUE) */
  public issuance?: IssuanceService
  /** the authentication asked on demand; set once the DIDComm side is wired (IDENT-RES-015) */
  public identityRequests?: Pick<IdentityRequests, 'request' | 'present' | 'onConnect'>
  /** tells each peer where it stands with the agent; set once the DIDComm side is wired (D71, IDENT-STAT) */
  public peerStatus?: PeerStatusNotifier
  /** the people of the user directory: who holds an entry, the member picker, the admin view (decision 61) */
  public people?: PeopleService
  /** the email code of a badge from the directory, served by the code in the conversation (decision 62, D89) */
  public emailChecks?: EmailChecks
  /** the service's own sentences in the person's language (decision 64) */
  public serviceLanguage?: ServiceLanguage
  /** the invitations of people of other organizations, bound when their badge is presented (decision 62, D90) */
  public invitations?: InvitationService
  /** what a tool call needs, its record, and the allowances (ayni-spec D99, D100); set by the composition root */
  public gate?: ToolGate
  /** the tool catalog (ayni-spec D96); set by the composition root */
  public catalog?: ToolCatalog
  /** the tools of each space (ayni-spec D98); set by the composition root */
  public spaceTools?: SpaceToolService
  /** the governance of the spaces: who their policies name, the notices (D135 to D142) */
  public governance?: Governance
  /** each person's own accounts (ayni-spec D104 to D110); set by the composition root */
  public connections?: ConnectionService
  /** the credentials a message of the person may carry, found as it arrives (D109, TOOL-ACCESS-013) */
  public readonly credentials: CredentialScanner
  /** the Notifications of each space and of the agent: approvals, pending and past (D114, INTX-APPR-017) */
  public readonly notifications: Notifications
  /** the agent's own DID, read from the DIDComm agent at start (IDENT-SELF-001) */
  public did = 'did:unknown'
  public readonly challenges: ChallengeService
  public readonly orchestrator: Orchestrator
  public readonly llm: ChatModel
  public readonly stats: StatsSink
  public readonly logger: Logger

  public constructor(parts: AgentParts) {
    Object.assign(this, parts)
    this.env = parts.env
    this.pack = parts.pack
    this.store = parts.store
    this.memory = parts.memory
    this.context = parts.context
    this.spaces = parts.spaces
    this.media = parts.media
    this.rag = parts.rag
    this.principals = parts.principals
    this.evidence = parts.evidence
    this.sessions = parts.sessions
    this.router = parts.router
    this.registry = parts.registry
    this.approvals = parts.approvals
    this.flows = parts.flows
    this.challenges = parts.challenges
    this.orchestrator = parts.orchestrator
    this.llm = parts.llm
    this.stats = parts.stats
    this.logger = parts.logger
    this.features = featuresOf(parts.pack)
    this.credentials = new CredentialScanner(parts.pack)
    this.notifications = new Notifications({
      store: parts.store,
      approvals: parts.approvals,
      card: (record, viewer) => this.approvalCard(record, viewer),
      // a past item is listed for the retention of its space; the agent's for Personal's (INTX-APPR-017, D84)
      retentionDays: async (place) =>
        (place ? (await parts.spaces.find(place))?.rules.retentionDays : undefined) ??
        parts.spaces.personalRules().retentionDays,
      purposeLabel: (id) => parts.pack.purposes?.find((p) => p.id === id)?.label,
      // a space's Notifications are its active members' (INTX-APPR-022)
      isMember: async (viewer, spaceId) => {
        const access = await parts.spaces.access(viewer, spaceId)
        return !!access && !access.left
      },
    })
    // an approval to attest is asked only of approvers whose phone takes its `authorize` flow (INTX-APPR-019)
    parts.approvals.askable = async (principal) => !!(await this.router.approvalPhone(principal))
  }

  /**
   * A message of the person that carries a credential, found as it arrives and before anything records, mirrors or queues
   * it (D109, TOOL-ACCESS-013/014): kept with each credential masked and marked as held back from the model, which reads
   * a record of the system in its place. Only the text the person typed is looked at (O35).
   */
  public withoutCredentials(input: TurnInput): TurnInput {
    const entry = input.entry
    if (entry.role !== 'principal') return input
    const typed =
      entry.sourceType === 'text' ||
      (entry.sourceType === 'media' && entry.text !== (entry.attachments ?? []).map((a) => a.textRepr).join('\n'))
    if (!typed || !entry.text) return input
    const held = this.credentials.scan(entry.text)
    if (!held) return input
    this.logger.info(
      { sessionId: entry.sessionId, credentials: held.count, source: held.source },
      'a message carried a credential: held back from the model, the credential kept nowhere (D109)'
    )
    return {
      ...input,
      entry: {
        ...entry,
        text: held.text,
        payload: {
          ...(entry.payload ?? {}),
          withheld: CREDENTIAL_WITHHELD,
          ...(held.source ? { credentialSource: held.source } : {}),
        },
      },
    }
  }

  // ---- display ----------------------------------------------------------------------------------

  public principalDisplay(principal: Principal): PrincipalDisplay {
    return {
      displayName: displayName(principal),
      photo: principal.identityAttributes.photoRef ?? null,
      backingIdentity: principal.backingIdentity
        ? { kind: principal.backingIdentity.kind, name: principal.backingIdentity.name ?? principal.backingIdentity.id }
        : null,
    }
  }

  public async principalOf(session: Session): Promise<Principal | null> {
    return session.principalId ? ((await this.principals.get(session.principalId)) ?? null) : null
  }

  /** The status of a session; a device secret it holds is handed here once and erased (IDENT-DEV-001, PROF-BIND-010). */
  public async status(session: Session): Promise<SessionStatus> {
    const principal = await this.principalOf(session)
    const deviceSecret = session.state === 'bound' ? await this.sessions.takeDeviceSecret(session) : undefined
    return {
      sessionId: session.id,
      state: session.state,
      reason: session.closedReason,
      principal: principal ? this.principalDisplay(principal) : null,
      boundAt: session.boundAt,
      lastActivityAt: session.lastActivityAt,
      idleTimeoutSeconds: this.sessions.idleTimeoutSeconds,
      binding: session.state === 'provisional' && session.binding ? this.bindingMaterial(session) : undefined,
      parentSessionId: session.parentSessionId,
      deviceHandle: session.state === 'bound' ? session.deviceHandle : undefined,
      deviceSecret,
      conversationId: session.state === 'bound' ? session.conversationId : undefined,
      resumedFromSessionId: session.state === 'bound' ? session.resumedFromSessionId : undefined,
    }
  }

  public walletLinkTemplate(): string {
    return (
      this.env.walletLinkTemplate ??
      this.pack.channels?.agui?.walletLinkTemplate ??
      'https://hologram.zone/open?oob={oob}'
    )
  }

  public bindingMaterial(session: Session) {
    const b = session.binding
    if (!b) return undefined
    const oob = new URL(b.oobUrl).searchParams.get('oob') ?? new URL(b.oobUrl).searchParams.get('_oob') ?? ''
    return {
      oobUrl: b.oobUrl,
      walletLink: this.walletLinkTemplate().replace('{oob}', oob),
      bindingCode: b.bindingCode,
      expiresAt: b.expiresAt,
    }
  }

  public async ayniState(session: Session): Promise<AyniState> {
    const principal = await this.principalOf(session)
    const waiting = principal && this.features.approvals ? await this.approvals.pendingFor(principal) : []
    const pending = waiting.length
    // a DIDComm peer in chat mode decides from its menu only what needs no attestation (INTX-APPR-019)
    const menuPending =
      session.channelType === 'didcomm' && principal
        ? waiting.filter((r) => !attestedFor(r, principal.id)).length
        : pending
    // the context figure of the conversation's latest turn, the same on every device (D74, PROF-STREAM-007)
    const context = session.state === 'bound' ? await this.context.figure(conversationOf(session)) : undefined
    // the space of the conversation, as its header names it (SPACE-CONV-003, PROF-STREAM-009)
    const space = session.state === 'bound' && principal ? await this.spaceRef(session, principal) : undefined
    return {
      ...(context ? { context } : {}),
      ...(space ? { space } : {}),
      contextualMenu: { items: contextualMenuFor(this.pack, principal, session, menuPending) },
      pendingApprovals: pending,
      generating: this.media
        .generatingFor(session.id)
        .map((g) => ({ entryId: g.entryId, kind: g.kind, startedAt: g.startedAt })),
      // the person's messages that wait for the turn in progress to end (D63, PROF-RUN-011)
      waiting: await this.waitingOf(session),
      principal: principal ? this.principalDisplay(principal) : null,
      purposes: this.features.elevation
        ? (this.pack.purposes ?? []).map((p) => ({ id: p.id, label: p.label, description: p.description }))
        : [],
    }
  }

  // ---- spaces (decision 60) ------------------------------------------------------------------------

  /** The space of a session's conversation: the one its conversation names, else Personal (a DIDComm session). */
  public async spaceOfSession(session: Session, principal: Principal): Promise<string> {
    if (!session.conversationId) return personalSpaceId(principal.id)
    const conversation = await this.sessions.conversationById(session.conversationId)
    return conversation ? spaceIdOf(conversation) : personalSpaceId(principal.id)
  }

  /** `state.ayni.space`: the space of the session's conversation, as its header names it. */
  public async spaceRef(session: Session, principal: Principal) {
    const spaceId = await this.spaceOfSession(session, principal)
    const access = await this.spaces.access(principal, spaceId)
    const space = access?.space ?? (isPersonalSpace(spaceId) ? this.spaces.personal(principal) : undefined)
    return space ? { id: space.id, title: space.title, kind: space.kind } : undefined
  }

  /**
   * A run of the session on a conversation of a space its Principal left is refused, a receipt excepted: reading is not
   * writing (SPACE-MEMB-004, PROF-RUN-014). The model providers a space allows are checked by the turn itself
   * (SPACE-CONV-004).
   */
  public async runRefusal(session: Session, kind: AyniAction['kind']): Promise<SpaceError | undefined> {
    if (kind === 'receipt' || !session.conversationId) return undefined
    const principal = await this.principalOf(session)
    const conversation = await this.sessions.conversationById(session.conversationId)
    if (!principal || !conversation) return undefined
    return this.spaces.leftRefusal(principal, conversation)
  }

  /** What the agent keeps about a person (MEM-SPACE-007, PROF-MEM-003): preferences, memories and conversations by space, evidence. */
  public async aboutMe(principal: Principal, session: Session) {
    const preferences = await this.memory.ownPreferences(principal, session)
    const notes = await this.memory.ownNotes(principal, session)
    const spaces = new Map((await this.spaces.listFor(principal)).map((a) => [a.space.id, a.space]))
    const titleOf = (spaceId: string) => spaces.get(spaceId)?.title ?? ''
    const count = (ids: string[]) => {
      const counts = new Map<string, number>()
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
      return [...counts]
    }
    // the conversations the person reads, active and archived, by space (PROF-MEM-003)
    const conversations = (await this.sessions.allConversations(principal.id)).filter((c) => c.state !== 'final')
    // what the agent verified about the person and still keeps: no attribute value
    const verified = (await this.evidence.list(principal.id)).filter(
      (r) => r.outcome === 'verified' && r.kind !== 'issuance' && r.state === 'active' && !!r.encKeyRef
    )
    return {
      preferences: preferences.map((p) => ({ key: p.key, value: p.value, updatedAt: p.updatedAt })),
      memoriesBySpace: count(notes.map((n) => MemoryService.spaceOfNote(n))).map(([spaceId, n]) => ({
        spaceId,
        title: titleOf(spaceId),
        count: n,
      })),
      conversations: count(conversations.map(spaceIdOf)).map(([spaceId, n]) => ({
        spaceId,
        title: titleOf(spaceId),
        count: n,
        retentionDays: spaces.get(spaceId)?.rules.retentionDays ?? null,
      })),
      verified: await Promise.all(
        verified.map(async (r) => ({
          // the catalog entry, or the kind of evidence
          label: r.entry,
          // the issuing organization, the issuing state of a document, or `email` (MEM-SPACE-007)
          source: await this.evidenceSource(principal, r),
          verifiedAt: r.verifiedAt,
          expiresAt: r.expiresAt ?? null,
        }))
      ),
    }
  }

  /** Where a piece of evidence came from, as about-me says it: no attribute value but the issuing state of a document. */
  private async evidenceSource(principal: Principal, record: EvidenceRecord): Promise<string | null> {
    if (record.kind === 'email') return 'email'
    if (record.kind === 'document') {
      const values = record.stored.includes('issuingState')
        ? await this.evidence.values(principal.id, record.entry)
        : undefined
      return values?.issuingState ?? null
    }
    return record.issuerOrganization?.name ?? record.issuerOrganization?.key ?? null
  }

  // ---- erasure (D78, PRIV-ERASE-007, PRIV-ERASE-010..012) ----------------------------------------------------------------

  /**
   * A person deletes a message they wrote in the session's conversation (decision 60, PROF-HIST-010), named by the
   * agent's id or by the client's id, while it is younger than the pack's window: with it go the agent's reply to it
   * (its messages, the tool calls and the memory lines of the turn) and the memories taken from it. Any other message
   * is not found; one past its window, one whose reply is being written and one on legal hold are refused. A message
   * that waits for its turn leaves the list: nothing answered it.
   */
  public async eraseOwnMessage(
    session: Session,
    principal: Principal,
    messageId: string
  ): Promise<{
    outcome: 'erased' | 'not-found' | 'legal-hold' | 'window-passed' | 'turn-in-progress'
    conversationId: string
    messageIds: string[]
    /** the ids the client gave the erased messages, when it gave one (PROF-STREAM-008) */
    clientIds: string[]
    /** the person's memories deleted with them */
    memoryIds: string[]
  }> {
    const conversationId = conversationOf(session)
    const none = { conversationId, messageIds: [], clientIds: [], memoryIds: [] }
    const own = (
      await this.store.entries.listAll({ conversationId, principalId: principal.id, limit: 100_000 })
    ).filter(
      // a message of the person's email check is a message they wrote too (PROF-HIST-010, PROF-RUN-015): the only
      // `auth-challenge` entries of the person are what they typed while a check waited (INTX-AUTH-013)
      (e) =>
        e.role === 'principal' && (TRANSCRIPT_MESSAGE_TYPES.includes(e.sourceType) || e.sourceType === 'auth-challenge')
    )
    const target = own.find((e) => e.id === messageId) ?? own.find((e) => e.externalId === messageId)
    if (!target) return { outcome: 'not-found', ...none }
    // deleted already, from another device: nothing more to do
    if (target.state === 'crypto-erased') return { outcome: 'erased', ...none }
    if (target.state === 'legal-hold') return { outcome: 'legal-hold', ...none }
    // counted from when the agent recorded it; a window of 0 lets nobody delete (PRIV-ERASE-010)
    const window = messageDeletionWindowSeconds(this.pack)
    if (window <= 0 || Date.now() - Date.parse(target.createdAt) > window * 1000)
      return { outcome: 'window-passed', ...none }
    const key = conversationKey(session)
    // its reply is being written: the turn is cancelled, and what it recorded is erased once it has stopped
    // (PRIV-ERASE-011)
    if (this.orchestrator.answeringIn(conversationId).has(target.id)) {
      if (!this.cancelTurns?.(key)) return { outcome: 'turn-in-progress', ...none }
      const until = Date.now() + this.cancelWaitMs
      while (this.orchestrator.answeringIn(conversationId).has(target.id) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (this.orchestrator.answeringIn(conversationId).has(target.id)) return { outcome: 'turn-in-progress', ...none }
    }
    if ((await this.waitingMessages.list(key)).some((item) => item.entryId === target.id)) {
      await this.waitingMessages.remove(key, [target.id])
      this.waitingChanged?.(session)
    }
    const result = await this.memory.eraseTurn(target.id)
    if (result.outcome !== 'erased') return { ...none, outcome: result.outcome }
    return {
      outcome: 'erased',
      conversationId,
      messageIds: result.erased.map((e) => e.id),
      // in the order of messageIds, the empty string for an entry the client did not send (PROF-STREAM-008)
      clientIds: result.erased.map((e) => e.externalId ?? ''),
      memoryIds: result.memoryIds,
    }
  }

  // ---- sessions ----------------------------------------------------------------------------------

  /** Asks the phone of a known device to re-link a provisional session (PROF-BIND-009); set by the DIDComm channel. */
  public rebindOffer?: (session: Session, principal: Principal) => Promise<boolean>

  /**
   * A session from a grant (D56, CHAN-BIND-014): bound at once to the Principal and capability channel that received
   * the grant; refused when the grant is used or expired, or when that channel is no longer live.
   */
  public async createSessionFromGrant(
    client: ClientDescription,
    locale: string | undefined,
    grant: string,
    conversationId?: string,
    newConversation = false,
    resumeSessionId?: string,
    spaceId?: string
  ): Promise<{ session: Session; token: string }> {
    const record = await this.sessions.redeemGrant(grant)
    const principal = await this.store.principals.get(record.principalId)
    const capability = principal ? await this.router.capabilitySession(principal) : undefined
    if (!principal || !capability || capability.externalRef !== record.connectionId)
      throw new SessionError('the connection that received the grant is gone', 'grant-expired')
    const live = await this.principals.ensureLive(principal)
    if (!live.ok) throw new SessionError('identity credential no longer valid', 'grant-expired')
    const conversation = await this.sessions.requireOpenable(conversationId ?? record.conversationId, resumeSessionId)
    // the space of a new conversation is one the person may use (decision 60)
    if (spaceId && !conversation) await this.spaces.usable(principal, spaceId)
    const merged: ClientDescription = {
      ...record.client,
      ...client,
      description: client.description ?? record.client.description,
    }
    return this.sessions.createFromGrant(
      merged,
      locale,
      principal,
      record,
      conversation,
      newConversation,
      resumeSessionId,
      spaceId
    )
  }

  public async createSession(
    client: ClientDescription,
    locale?: string,
    deviceHandle?: string,
    resumeSessionId?: string,
    deviceProof?: string,
    conversationId?: string,
    newConversation = false,
    silent = false,
    spaceId?: string
  ) {
    const conversation = await this.sessions.requireOpenable(conversationId, resumeSessionId)
    const created = await this.sessions.createProvisional(
      'ag-ui',
      client,
      locale,
      deviceHandle,
      resumeSessionId,
      conversation,
      newConversation,
      spaceId
    )
    let rebind: 'asked' | 'unavailable' | undefined
    let pairing: 'expired' | 'invalid' | undefined
    if (deviceHandle) {
      const principal = await this.principalOfDevice(deviceHandle)
      const capability = principal ? await this.router.capabilitySession(principal) : undefined
      // a paired device binds at once when its proof, the channel and the credential all hold (IDENT-DEV-002)
      if (principal && capability && deviceProof) {
        const live = await this.principals.ensureLive(principal)
        if (!live.ok) pairing = 'expired'
        else {
          // bound at once: a space the person may not use is refused here, not left to the binding (PROF-CONV-011)
          if (spaceId && !conversation) {
            try {
              await this.spaces.usable(principal, spaceId)
            } catch (error) {
              await this.sessions.close(created.session, 'user')
              throw error
            }
          }
          try {
            await this.sessions.bindWithProof(created.session, principal, deviceProof)
            return { ...created, pairing: undefined, rebind: undefined }
          } catch (error) {
            if (error instanceof SessionError && error.code === 'pairing-expired') pairing = 'expired'
            else if (error instanceof SessionError && error.code === 'pairing-invalid') pairing = 'invalid'
            else throw error
          }
        }
      } else if (deviceProof) pairing = principal ? 'expired' : 'invalid'
      // a client that asked for a bound session or none gets none: no session is left waiting for the phone and
      // the phone is asked nothing (PROF-SESS-015). A client refreshing itself in the background asks this way
      if (silent) await this.refuseSilent(created.session, pairing)
      rebind = 'unavailable'
      // the phone is asked about a session opened somewhere else, in a browser. The phone's own app runs on that
      // phone and binds with a session grant: asking would show the person a request to link the device they hold
      // (PROF-BIND-009)
      const elsewhere = client.platform === 'web'
      if (elsewhere && principal && capability && this.rebindOffer) {
        rebind = (await this.rebindOffer(created.session, principal).catch(() => false)) ? 'asked' : 'unavailable'
      }
    }
    if (silent) await this.refuseSilent(created.session, pairing)
    return { ...created, rebind, pairing }
  }

  private async refuseSilent(session: Session, pairing: 'expired' | 'invalid' | undefined): Promise<never> {
    await this.sessions.close(session, 'user')
    throw new SessionError(
      'no session without the phone',
      pairing === 'expired' ? 'pairing-expired' : 'pairing-invalid'
    )
  }

  private async principalOfDevice(handle: string): Promise<Principal | undefined> {
    return (await this.store.principals.list()).find((p) => p.devices?.some((d) => d.handle === handle))
  }

  /**
   * Stops the turns in progress on a conversation, by its key, as the person stopping them would; set by the channel
   * that runs them. Returns how many it stopped.
   */
  public cancelTurns?: (key: string) => number
  /** how long a deletion waits for the turn it cancelled to stop */
  public cancelWaitMs = 15_000

  /** The Principal's paired devices (IDENT-DEV-005, PROF-SESS-011). */
  public listDevices(principal: Principal, currentHandle?: string) {
    return (principal.devices ?? []).map((d) => ({
      handle: d.handle,
      client: d.client,
      createdAt: d.createdAt,
      lastUsedAt: d.lastUsedAt ?? d.createdAt,
      current: d.handle === currentHandle,
    }))
  }

  /** Revokes a pairing by its own proof: a web client with no bound session unlinks itself (PROF-SESS-012). */
  public async revokeDeviceByProof(handle: string, proof: string): Promise<boolean> {
    const principal = await this.principalOfDevice(handle)
    const device = principal?.devices?.find((d) => d.handle === handle)
    if (!principal || !device || !this.sessions.proofMatches(device, proof)) return false
    return this.sessions.revokeDevice(principal, handle)
  }

  public async createSibling(
    parent: Session,
    client: ClientDescription,
    locale?: string,
    resumeSessionId?: string,
    conversationId?: string,
    newConversation = false,
    spaceId?: string
  ) {
    const conversation = await this.sessions.requireOpenable(conversationId, resumeSessionId)
    // the space of a new conversation is one the person may use (decision 60)
    const principal = parent.principalId ? await this.principals.get(parent.principalId) : undefined
    if (spaceId && !conversation && principal) await this.spaces.usable(principal, spaceId)
    return this.sessions.createSibling(parent, client, locale, resumeSessionId, conversation, newConversation, spaceId)
  }

  public async closeSession(session: Session, reason: ClosureReason): Promise<void> {
    await this.sessions.close(session, reason)
  }

  /**
   * Personalized welcome on connection and on every new conversation (INTX-MENU-001). A session that continues a
   * conversation (it has a lineage) gets none, whichever way it was bound: by a grant, a device proof, a sibling
   * token, or the phone confirming a link.
   */
  public async welcome(session: Session): Promise<void> {
    if (session.lineage?.length) return
    const principal = await this.principalOf(session)
    if (!principal) return
    const entry = await this.memory.append({
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'text',
      text: greetingFor(this.pack, principal),
      backingIdentity: principal.backingIdentity,
      reactionPolicy: 'historize',
    })
    await this.router.deliver(session, { kind: 'text', entry })
    await this.router.deliver(session, { kind: 'contextual-menu', sessionId: session.id })
  }

  // ---- turns and actions --------------------------------------------------------------------------

  // ---- one turn at a time; what is sent meanwhile waits (D63, CORE-MSG-010) ------------------------

  /** the lock a turn holds while it runs: one per conversation, in the memory of the process */
  private readonly turns = new TurnLock()
  /** the messages that wait, kept in the store: created with the agent's parts */
  private waitingList?: WaitingList
  /** the waiting messages a turn is answering now: still listed in the store until it ends, waiting no more */
  private readonly inTurn = new Set<string>()
  /** what waits in the conversation of this session changed: set by the channel that shows it */
  public waitingChanged?: (session: Session) => void
  /**
   * Where the reply to what waited goes: no request carries it, the agent starts that turn itself. Set by the
   * channel that serves the conversation; without it the reply is recorded and read from history.
   */
  public queuedRun?: (session: Session) => Promise<QueuedRun>

  // ---- the end of the process (PLAT-DEPLOY-004) ------------------------------------------------------

  /** the process was told to end: no turn starts any more */
  private ending = false
  /** cuts the turns that are still running when the time given to them is over */
  private readonly cut = new AbortController()
  /** the turns in progress, and who waits for them to be over */
  private running = 0
  private readonly whenIdle: (() => void)[] = []

  /** The signal of a turn: its caller's, and the end of the process. */
  private untilCut(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.cut.signal])
  }

  private async counted<T>(work: () => Promise<T>): Promise<T> {
    this.running++
    try {
      return await work()
    } finally {
      this.running--
      if (!this.running) for (const tell of this.whenIdle.splice(0)) tell()
    }
  }

  private idle(withinMs: number): Promise<boolean> {
    if (!this.running) return Promise.resolve(true)
    return new Promise((resolve) => {
      const late = setTimeout(() => resolve(false), withinMs)
      this.whenIdle.push(() => {
        clearTimeout(late)
        resolve(true)
      })
    })
  }

  /**
   * The process is told to end. From here no turn starts: a message that may wait is recorded and listed, and
   * the next process answers it; anything else is refused. The turns in progress are given `drainMs` to end as
   * they would; one that still runs then is cut like a turn the person stopped, its reply kept as interrupted,
   * and what it was answering from the list stays listed for the next process.
   */
  public async shutdown(drainMs = 20_000, cutMs = 3_000): Promise<void> {
    this.ending = true
    if (await this.idle(drainMs)) return
    this.logger.warn({ turns: this.running }, 'turns still in progress at the end of the process: cut')
    this.cut.abort()
    await this.idle(cutMs)
  }

  private get waitingMessages(): WaitingList {
    this.waitingList ??= new WaitingList(this.store.kv)
    return this.waitingList
  }

  /**
   * A turn for a message of the Principal. One turn runs at a time in a conversation: a message that may wait
   * and arrives during one is recorded, listed as waiting and answered when it ends (`waiting` in the result);
   * any other caller waits for its turn.
   */
  public async turn(session: Session, given: TurnInput, sink: TurnSink, caller: AbortSignal): Promise<TurnResult> {
    this.sessions.requireBound(session)
    // a credential is masked before the message is recorded, mirrored, queued or taken by an email check (D109)
    const input = this.withoutCredentials(given)
    const principal = await this.principalOf(session)
    if (!principal) throw new Error('principal missing')
    await this.sessions.touch(session)
    const key = conversationKey(session)
    const signal = this.untilCut(caller)
    // while an email check waits in this conversation, the message is the code's: it starts no turn and never reaches
    // the model (INTX-AUTH-013, PROF-RUN-015)
    if (this.emailChecks?.waitsFor(principal.id)) {
      await this.orchestrator.live(principal)
      const taken = await this.emailChecks.take(session, principal, input, sink)
      if (taken) {
        await this.sessions
          .readAfterTurn(session, taken.inbound?.id)
          .catch((err) => this.logger.warn({ err, sessionId: session.id }, 'read state not updated'))
        return taken
      }
    }
    // while the process ends, as during a turn: the message waits, and the next process answers it. A confirmation card
    // that waits in the conversation ends as cancelled: the person wrote instead of answering it (TOOL-CALL-004)
    if (input.mayWait && (this.ending || this.turns.busy(key))) {
      this.gate?.cancelConfirmations(conversationOf(session))
      return this.wait(key, session, principal, input)
    }
    return this.exclusive(session, signal, async () => {
      await sink.emit({ type: 'turn-start' })
      await this.sessions.noteActivity(session, input.entry.text, { title: true })
      const result = await this.orchestrator.run(session, principal, input, sink, signal, this.turnContext(key))
      await this.afterTurn(session, result)
      return result
    })
  }

  /** Runs one thing at a time in the conversation of a session; a caller that gives up while it waits ran nothing. */
  private async exclusive(session: Session, signal: AbortSignal, work: () => Promise<TurnResult>): Promise<TurnResult> {
    if (this.ending) throw new ProcessEnding()
    const release = await this.turns.acquire(conversationKey(session), signal)
    if (!release) return { cancelled: true, withdrawn: true }
    try {
      // its turn came after the process was told to end: it does not start
      if (this.ending) throw new ProcessEnding()
      return await this.counted(work)
    } finally {
      release()
    }
  }

  /** What follows a turn: the read marker, the conversation's activity, a wake-up when no screen shows it. */
  private async afterTurn(session: Session, result: TurnResult): Promise<void> {
    // the person's message is read up to, the reply counts until a device reports it viewed (IDENT-SESS-017)
    await this.sessions
      .readAfterTurn(session, result.inbound?.id)
      .catch((err) => this.logger.warn({ err, sessionId: session.id }, 'read state not updated'))
    if (result.reply?.text) {
      await this.sessions.noteActivity(session, result.reply.text)
      await this.notifyIfAway(session, result.reply.text).catch((err) =>
        this.logger.warn({ err, sessionId: session.id }, 'wake-up not sent')
      )
    }
  }

  /** What a turn is told of the messages that wait in its conversation. */
  private turnContext(key: string): TurnContext {
    const since = new Date().toISOString()
    const stillWaiting = async () =>
      (await this.waitingMessages.list(key)).filter((item) => !this.inTurn.has(item.entryId))
    return {
      // recorded, and not this turn's to answer: out of what the model reads
      notYet: async () => new Set((await stillWaiting()).map((item) => item.entryId)),
      // the reply stands before the first message that arrived while it was written: it does not answer it
      replyAt: async () => {
        const first = (await stillWaiting()).find((item) => item.at > since)
        return first ? new Date(Date.parse(first.at) - 1).toISOString() : undefined
      },
    }
  }

  /** A message that arrives during a turn: recorded, listed in the store as waiting, and answered next. */
  private async wait(key: string, session: Session, principal: Principal, input: TurnInput): Promise<TurnResult> {
    await this.orchestrator.live(principal)
    // refused before anything of it is recorded (PROF-RUN-011)
    if (!(await this.waitingMessages.room(key))) throw new TooManyWaiting()
    const entry = await this.orchestrator.record(session, input)
    await this.waitingMessages.add(key, {
      entryId: entry.id,
      sessionId: session.id,
      messageId: entry.externalId,
      at: entry.initiatedAt,
    })
    this.waitingChanged?.(session)
    // answered when the turn in progress has ended: this takes its place in line behind it
    void this.answerWaiting(key, session)
    return { cancelled: false, waiting: true, inbound: entry }
  }

  /**
   * Answers what waits in a conversation, in one turn, once the conversation is free. Called for each message that
   * comes to wait, and when the agent starts: whoever comes first answers everything, the others find nothing.
   */
  private async answerWaiting(key: string, witness: Session): Promise<void> {
    // the process ends: what waits stays listed, and the next process answers it
    if (this.ending) return
    const release = await this.turns.acquire(key)
    if (!release) return
    try {
      if (this.ending) return
      const items = await this.waitingMessages.list(key)
      if (items.length) await this.counted(() => this.turnForWaiting(key, witness, items))
    } catch (err) {
      this.logger.error({ err, conversation: key }, 'the messages that waited were not answered')
    } finally {
      release()
    }
  }

  private async turnForWaiting(key: string, witness: Session, items: WaitingItem[]): Promise<void> {
    const ids = items.map((item) => item.entryId)
    const entries = (await Promise.all(ids.map((id) => this.memory.get(id)))).filter((e): e is MessageEntry => !!e)
    // the turn runs on the session the latest message came through, whatever became of it since
    const last = items[items.length - 1] as WaitingItem
    const session = (await this.sessions.get(last.sessionId)) ?? witness
    const principal = await this.principalOf(session)
    const latest = entries[entries.length - 1]
    if (!principal || !latest) {
      await this.waitingMessages.remove(key, ids)
      this.waitingChanged?.(session)
      return
    }
    for (const id of ids) this.inTurn.add(id)
    this.waitingChanged?.(session)
    const queued = await this.queuedRun?.(session).catch((err) => {
      this.logger.warn({ err, sessionId: session.id }, 'no channel for the reply to what waited: it is recorded')
      return undefined
    })
    const sink: TurnSink = queued?.sink ?? { emit: () => undefined }
    let result: TurnResult | undefined
    let failure: unknown
    try {
      await sink.emit({ type: 'turn-start' })
      await this.sessions.noteActivity(session, latest.text, { title: true })
      result = await this.orchestrator.answer(
        session,
        principal,
        entries,
        sink,
        this.untilCut(queued?.signal ?? new AbortController().signal),
        this.turnContext(key)
      )
      await this.afterTurn(session, result)
    } catch (err) {
      failure = err
      this.logger.error({ err, sessionId: session.id }, 'the turn for what waited failed')
    } finally {
      // off the list once the turn has ended. One cut short because the process ends stays listed, as one cut
      // by a crash does: the next process answers it
      const cutShort = this.cut.signal.aborted && (!result || result.cancelled)
      if (!cutShort) await this.waitingMessages.remove(key, ids)
      for (const id of ids) this.inTurn.delete(id)
      this.waitingChanged?.(session)
      await queued?.finish(result, failure)
    }
  }

  /** The messages that wait in the conversation of a session, as its devices show them (PROF-RUN-011). */
  public async waitingOf(session: Pick<Session, 'id' | 'conversationId'>): Promise<WaitingView[]> {
    const items = (await this.waitingMessages.list(conversationKey(session))).filter(
      (item) => !this.inTurn.has(item.entryId)
    )
    const views: WaitingView[] = []
    for (const item of items) {
      const entry = await this.memory.get(item.entryId)
      if (!entry) continue
      views.push({
        id: entry.id,
        sessionId: item.sessionId,
        messageId: item.messageId,
        text: entry.text,
        attachments: entry.attachments.length,
        at: item.at,
      })
    }
    return views
  }

  /** What a restart left waiting is answered: called once the channels are up (CORE-MSG-010). */
  public async resumeWaiting(): Promise<void> {
    for (const key of await this.waitingMessages.conversations()) {
      const items = await this.waitingMessages.list(key)
      const last = items[items.length - 1]
      const session = last ? await this.sessions.get(last.sessionId) : undefined
      if (!session) {
        await this.waitingMessages.remove(
          key,
          items.map((item) => item.entryId)
        )
        continue
      }
      void this.answerWaiting(key, session)
    }
  }

  /**
   * A wake-up on the capability channel (D57, INTX-NOTIFY-001): when a reply or an agent-initiated run lands while
   * no screen of the Principal shows the conversation, a flow-capable phone receives one `notify` naming the
   * conversation. Never for a flow (the flow is its own notification); nothing is sent to any push service.
   */
  public async notifyIfAway(session: Session, preview: string): Promise<boolean> {
    if (session.channelType !== 'ag-ui') return false
    const principal = await this.principalOf(session)
    if (!principal) return false
    const capability = await this.router.capabilitySession(principal)
    if (!capability) return false
    const adapter = this.router.adapter('didcomm')
    if (!adapter?.notify) return false
    const conversationId = session.conversationId ?? session.id
    const screens = (await this.sessions.listOpen(principal.id)).filter(
      (s) => s.channelType === 'ag-ui' && (s.conversationId ?? s.id) === conversationId
    )
    if (screens.some((s) => this.router.isLive(s))) return false
    const text = preview.replace(/\s+/g, ' ').trim()
    return adapter.notify(capability.externalRef, {
      conversationId,
      sessionId: session.id,
      title: this.pack.metadata.displayName,
      preview: text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text || undefined,
      collapseKey: conversationId,
      priority: 'normal',
    })
  }

  /** Structured actions of a turn (profile section 6; INTX-MENU, INTX-APPR, INTX-REACT, INTX-STATE). */
  public async action(
    session: Session,
    action: AyniAction,
    sink: TurnSink,
    caller: AbortSignal
  ): Promise<
    | TurnResult
    | { text: string; await?: 'binding-code' }
    | { decision: { approvalId: string; status: ApprovalRecord['status'] } }
    | { refused: { code: 'decide-on-phone' | 'not-eligible'; message: string } }
    | undefined
  > {
    const signal = this.untilCut(caller)
    this.sessions.requireBound(session)
    const principal = await this.principalOf(session)
    if (!principal) throw new Error('principal missing')
    await this.sessions.touch(session)
    const entryBase = (
      text: string,
      sourceType: NewEntry['sourceType'],
      payload?: Record<string, unknown>
    ): NewEntry => ({
      sessionId: session.id,
      principalId: principal.id,
      role: 'principal',
      sourceType,
      text,
      backingIdentity: principal.backingIdentity,
      payload,
    })
    switch (action.kind) {
      case 'menu.select': {
        const menuEntry = await this.memory.get(action.menuId)
        const items = (menuEntry?.payload?.items as { id: string; label: string }[] | undefined) ?? []
        const item = items.find((i) => i.id === action.itemId)
        const text = item?.label ?? action.itemId
        if (menuEntry)
          await this.memory.rewrite({
            ...menuEntry,
            payload: { ...(menuEntry.payload ?? {}), selectedItemId: action.itemId },
          })
        return this.exclusive(session, signal, () =>
          this.orchestrator.run(
            session,
            principal,
            { entry: entryBase(text, 'text', { menuId: action.menuId, itemId: action.itemId }) },
            sink,
            signal,
            this.turnContext(conversationKey(session))
          )
        )
      }
      case 'contextual.select':
        return this.contextualSelect(session, principal, action.itemId, sink, signal)
      case 'approval.decide': {
        // the person's own confirmation of a call of theirs: decided while the turn waits, no turn of its own (PROF-TOOL-008)
        const confirmation = await this.gate?.decideConfirmation(
          action.approvalId,
          principal,
          session,
          action.decision,
          (action as { scope?: 'once' | 'conversation' }).scope
        )
        if (confirmation) return { decision: { approvalId: action.approvalId, status: confirmation.status } }
        // an approver's decision, from the Notifications: no turn, nothing added to any conversation (PROF-TOOL-026)
        return this.decideApproval(principal, action.approvalId, action.decision, action.note)
      }
      case 'approval.cancel':
        // the requester withdraws their request from its card: no turn either (INTX-APPR-010, PROF-TOOL-026)
        return this.withdrawApproval(principal, action.approvalId)
      case 'elevation.request':
        return this.requestElevation(session, principal, action.tool, action.purposeId, action.justification, sink)
      case 'reaction': {
        if (!this.features.reactions) return undefined
        const target = await this.memory.get(action.messageId)
        await this.memory.append(
          entryBase(`Reaction ${action.action} ${action.emoji} on ${action.messageId}`, 'reaction', { ...action })
        )
        // one reaction per person per message (INTX-REACT-004): the current one lives on the target entry.
        // The target is a message of this conversation: of this session or of an earlier one it continues
        // (IDENT-SESS-009), as for the quote of a reply. Checking this session alone dropped, without a
        // word, every reaction on a message older than the last idle timeout
        if (target && target.conversationId === conversationOf(session)) {
          const reactions = { ...((target.payload?.reactions as Record<string, unknown> | undefined) ?? {}) }
          if (action.action === 'add')
            reactions[principal.id] = { emoji: action.emoji, by: displayName(principal), at: new Date().toISOString() }
          else delete reactions[principal.id]
          await this.memory.rewrite({ ...target, payload: { ...(target.payload ?? {}), reactions } })
          await this.router.deliver(session, {
            kind: 'reaction',
            messageId: target.id,
            emoji: action.emoji,
            action: action.action,
            by: displayName(principal),
            origin: 'principal',
          })
        }
        const policy = target?.reactionPolicy ?? 'historize'
        const notify = policy === 'notify' || (typeof policy === 'object' && policy.notifyOn.includes(action.emoji))
        if (notify && action.action === 'add') {
          return this.exclusive(session, signal, () =>
            this.orchestrator.run(
              session,
              principal,
              {
                entry: entryBase(
                  `(reacted with ${action.emoji} to your message: "${target?.text.slice(0, 120) ?? ''}")`,
                  'text'
                ),
              },
              sink,
              signal,
              this.turnContext(conversationKey(session))
            )
          )
        }
        return undefined
      }
      case 'receipt': {
        if (action.state === 'viewed') {
          // the audit trail of what the person saw and when (INTX-STATE-004): never replaced by the marker
          if (this.features.receipts)
            await this.memory.append(
              entryBase(`Messages ${action.state}: ${action.messageIds.length}`, 'state-update', { ...action })
            )
          // and the conversation's read marker, the same for every device (IDENT-SESS-017)
          await this.sessions.markViewed(session, action.messageIds)
        }
        return undefined
      }
      default:
        return undefined
    }
  }

  private async contextualSelect(
    session: Session,
    principal: Principal,
    itemId: string,
    sink: TurnSink,
    signal: AbortSignal
  ): Promise<TurnResult | { text: string; await?: 'binding-code' }> {
    if (itemId === PLATFORM_MENU.approvals) {
      // an AG-UI session offers no such item: the approver's requests are in the Notifications (D114, PROF-TOOL-025)
      if (session.channelType !== 'didcomm') return { text: 'Your approvals are in the Notifications.' }
      // a DIDComm peer in chat mode: the questions it answers, and no entry in any conversation (INTX-APPR-006); one to
      // attest is decided on a phone that takes flows only (INTX-APPR-019)
      const pending = (await this.approvals.pendingFor(principal)).filter((r) => !attestedFor(r, principal.id))
      // a confirmation is the person's own card in its conversation, never a pending approval (INTX-APPR-012)
      const own = (await this.approvals.ownRequests(principal)).filter(
        (r) => r.status === 'PENDING' && r.kind !== 'confirmation'
      )
      if (!pending.length && !own.length) return { text: 'No pending approvals.' }
      const lines = [
        ...pending.map(
          (r) => `- To decide: ${r.requesterName} asks ${r.toolName}${r.purpose ? ` for ${r.purpose}` : ''} (${r.id})`
        ),
        ...own.map((r) => `- Your request ${r.toolName} is pending (${r.id})`),
      ]
      for (const r of pending) await this.router.deliver(session, { kind: 'approval', approval: r })
      return { text: lines.join('\n') }
    }
    if (itemId.startsWith(PLATFORM_MENU.issuePrefix)) {
      // the person asks for a credential the pack issues on request (INTX-ISSUE-008)
      const name = itemId.slice(PLATFORM_MENU.issuePrefix.length)
      const result = await this.issuance?.issue(principal, session, name, 'person')
      // an email check now waits in this conversation: the code asks its question here (INTX-AUTH-012)
      if (result?.ask) {
        await this.codeSays(session, principal, result.ask.text, sink, {
          kind: EMAIL_CHECK_KIND,
          challengeId: result.ask.challengeId,
          step: 'question',
        })
        return { cancelled: false }
      }
      return {
        text: issuanceOutcomeForPerson(result?.outcome ?? 'unavailable', result?.requirements, result?.reason),
      }
    }
    if (itemId === PLATFORM_MENU.identify) {
      // the person asks to authenticate: always served (IDENT-RES-015/016)
      const outcome = (await this.identityRequests?.request(principal, 'person')) ?? 'unavailable'
      return { text: identityOutcomeForPerson(outcome) }
    }
    if (itemId === PLATFORM_MENU.link) {
      return { text: 'Type the code shown on the web page (for example 47-KM), or /link 47-KM.', await: 'binding-code' }
    }
    if (itemId === PLATFORM_MENU.sessions) {
      const open = await this.sessions.listOpen(principal.id)
      return {
        text: `Your open sessions with ${this.pack.metadata.displayName}:\n${describeSessions(open, session)}\nReply "end <number>" to close one.`,
      }
    }
    if (itemId === PLATFORM_MENU.devices) {
      return {
        text: `Devices linked to ${this.pack.metadata.displayName}:\n${describeDevices(principal.devices ?? [])}\nReply "unlink <number>" to unlink one.`,
      }
    }
    if (itemId.startsWith(PLATFORM_MENU.endSessionPrefix)) {
      const target = await this.sessions.get(itemId.slice(PLATFORM_MENU.endSessionPrefix.length))
      if (target && target.principalId === principal.id && target.state === 'bound') {
        await this.sessions.close(target, 'user')
        return { text: 'Session closed.' }
      }
      return { text: 'Session not found.' }
    }
    const item = (this.pack.persona.menu ?? []).find((m) => m.id === itemId)
    if (!item) return { text: 'Unknown menu item.' }
    if (item.action.type === 'prompt' && item.action.prompt) {
      const prompt = item.action.prompt
      return this.exclusive(session, signal, () =>
        this.orchestrator.run(
          session,
          principal,
          {
            entry: {
              sessionId: session.id,
              principalId: principal.id,
              role: 'principal',
              sourceType: 'text',
              text: prompt,
              backingIdentity: principal.backingIdentity,
              payload: { menuItemId: itemId },
            },
          },
          sink,
          signal,
          this.turnContext(conversationKey(session))
        )
      )
    }
    if (item.action.type === 'tool' && item.action.tool) {
      const content = await this.orchestrator.invokeTool(item.action.tool, {}, session, principal, sink)
      return { text: content }
    }
    return { text: item.action.url ?? '' }
  }

  /** `/sessions` typed on the capability channel and `end <n>` (INTX-MENU-005). */
  public async sessionsCommand(session: Session, text: string): Promise<string | undefined> {
    const principal = await this.principalOf(session)
    if (!principal) return undefined
    const trimmed = text.trim().toLowerCase()
    if (trimmed === '/sessions') {
      const open = await this.sessions.listOpen(principal.id)
      return `Your open sessions with ${this.pack.metadata.displayName}:\n${describeSessions(open, session)}\nReply "end <number>" to close one.`
    }
    const end = /^end\s+(\d+)$/.exec(trimmed)
    if (end) {
      const open = await this.sessions.listOpen(principal.id)
      const target = open[Number(end[1]) - 1]
      if (!target) return 'No such session.'
      if (target.id === session.id) return 'This is the session you are using; disconnect from the app to close it.'
      await this.sessions.close(target, 'user')
      return `Session ${end[1]} closed.`
    }
    const unlink = /^unlink\s+(\d+)$/.exec(trimmed)
    if (unlink) {
      const device = (principal.devices ?? [])[Number(unlink[1]) - 1]
      if (!device) return 'No such device.'
      await this.sessions.revokeDevice(principal, device.handle)
      for (const s of await this.sessions.listOpen(principal.id))
        if (s.deviceHandle === device.handle) await this.sessions.close(s, 'user')
      return `Device ${unlink[1]} unlinked; its browser will ask you again before it can talk to me.`
    }
    return undefined
  }

  private async requestElevation(
    session: Session,
    principal: Principal,
    tool: string,
    purposeId: string,
    justification: string,
    sink: TurnSink
  ) {
    if (!this.features.elevation) return { text: 'Elevation is not enabled.' }
    const grants = await this.approvals.activeGrants(principal.id)
    const requestable = await this.registry.requestable(principal.roles, grants)
    const target = requestable.find((t) => t.spec.name === tool || t.spec.key.endsWith(`:${tool}`))
    if (!target?.resolution.elevationRule) return { text: `${tool} cannot be requested.` }
    try {
      const record = await this.approvals.requestElevation({
        principal,
        role: principal.roles[0] ?? '',
        originSessionId: session.id,
        toolName: target.spec.key.split(':').pop() ?? tool,
        serverName: target.spec.serverName,
        rule: target.resolution.elevationRule,
        purposeId,
        justification,
      })
      // the requester's card: one entry of this conversation, updated in place by what becomes of it (INTX-APPR-016)
      const card = await this.approvalCard(record, principal)
      const entry = await this.memory.append({
        sessionId: session.id,
        principalId: principal.id,
        role: 'principal',
        sourceType: 'approval',
        text: `The person requested an elevation for ${record.toolName} (${record.id}), for ${purposeId}, shown to them on a card`,
        backingIdentity: principal.backingIdentity,
        payload: { approvalId: record.id, kind: 'elevation', toolName: record.toolName, status: record.status, card },
      })
      const fresh = (await this.approvals.get(record.id)) ?? record
      fresh.entryId = entry.id
      await this.approvals.save(fresh)
      await sink.emit({ type: 'activity', messageId: entry.id, activityType: ACTIVITY.approval, content: card })
      return {
        text:
          record.status === 'APPROVED'
            ? `Access to ${record.toolName} granted until ${record.grantExpiresAt}.`
            : `Elevation request ${record.id} sent to ${record.eligibleRoles.join(', ')}.`,
      }
    } catch (error) {
      if (error instanceof ApprovalError) return { text: error.message }
      throw error
    }
  }

  // ---- approvals: each person once (INTX-APPR-006, INTX-APPR-016..019, D114) --------------------------------------------

  /**
   * An approver's decision from the Notifications (PROF-TOOL-026): it starts no turn and adds nothing to any conversation.
   * The first decision of each approver counts: a later one, or one after the approval ended, gets the status it has.
   * One whose decision must be attested is decided on the phone only (INTX-APPR-019).
   */
  public async decideApproval(
    principal: Principal,
    approvalId: string,
    decision: 'approve' | 'reject',
    note?: string
  ): Promise<
    | { decision: { approvalId: string; status: ApprovalRecord['status'] } }
    | { refused: { code: 'decide-on-phone' | 'not-eligible'; message: string } }
  > {
    const record = await this.approvals.get(approvalId)
    const notEligible = { refused: { code: 'not-eligible' as const, message: 'not an approval this person decides' } }
    if (!record || record.kind === 'confirmation') return notEligible
    const decided = record.decisions.some((d) => d.approverId === principal.id)
    if (decided || (record.status !== 'PENDING' && (await this.approvals.isEligible(principal, record))))
      return { decision: { approvalId, status: record.status } }
    if (!(await this.approvals.isEligible(principal, record))) return notEligible
    if (attestedFor(record, principal.id))
      return { refused: { code: 'decide-on-phone', message: 'the decision of this approval is made on the phone' } }
    try {
      const after = await this.approvals.decide(approvalId, principal, decision, note)
      return { decision: { approvalId, status: after.status } }
    } catch (error) {
      if (!(error instanceof ApprovalError)) throw error
      if (error.code === 'not-pending')
        return { decision: { approvalId, status: (await this.approvals.get(approvalId))?.status ?? record.status } }
      if (error.code === 'decide-on-phone') return { refused: { code: 'decide-on-phone', message: error.message } }
      return notEligible
    }
  }

  /** The requester withdraws their pending request, from its card (INTX-APPR-010): no turn, `CANCELLED`. */
  public async withdrawApproval(
    principal: Principal,
    approvalId: string
  ): Promise<
    | { decision: { approvalId: string; status: ApprovalRecord['status'] } }
    | { refused: { code: 'not-eligible'; message: string } }
  > {
    const record = await this.approvals.get(approvalId)
    if (!record || record.kind === 'confirmation' || record.requesterId !== principal.id)
      return { refused: { code: 'not-eligible', message: 'only the requester withdraws a request' } }
    if (record.status !== 'PENDING') return { decision: { approvalId, status: record.status } }
    try {
      return { decision: { approvalId, status: (await this.approvals.cancel(approvalId, principal)).status } }
    } catch (error) {
      if (!(error instanceof ApprovalError)) throw error
      return { decision: { approvalId, status: (await this.approvals.get(approvalId))?.status ?? record.status } }
    }
  }

  /** one resend of an approval to a person's phone at a time, by approval and person */
  private readonly resending = new TurnLock()
  /** when an approval was last sent again to a person's phone, by approval and person */
  private readonly resentAt = new Map<string, number>()

  /**
   * Decide on your phone (PROF-TOOL-026, INTX-APPR-019): the request of an approval the person may decide is sent to
   * their phone again, the one it held closed first. One at a time, and at most once every 30 seconds for an approval
   * and a person: a resend that comes while one is under way, or within 30 seconds of the last one, sends nothing new
   * and answers as it did. Found by Fabrice on devnet, 2026-11-22: ten resends in 22 seconds, his phone away from its
   * mediator, opened ten flows and closed nine; the phone took the thirty messages at once and listed closed ones.
   */
  public async resendApproval(principal: Principal, approvalId: string): Promise<{ expiresAt: string }> {
    const record = await this.approvals.get(approvalId)
    if (!record || record.kind === 'confirmation' || !(await this.approvals.isEligible(principal, record)))
      throw new SpaceError('approval not found', 'not-found')
    if (record.status !== 'PENDING' || record.decisions.some((d) => d.approverId === principal.id))
      throw new SpaceError(`the approval is ${record.status === 'PENDING' ? 'decided' : record.status}`, 'not-pending')
    const phone = await this.router.approvalPhone(principal)
    if (!phone) throw new SpaceError('no phone of the person takes the request', 'confirmation-unavailable')
    const key = `${approvalId}:${principal.id}`
    const release = await this.resending.acquire(key)
    try {
      const last = this.resentAt.get(key)
      if (last !== undefined && Date.now() - last < APPROVAL_RESEND_INTERVAL_MS) return { expiresAt: record.expiresAt }
      // the close of the flow the phone held leaves before the new open
      await phone.adapter.closeApprovalFlow(phone.session, record, 'cancelled', 'The request was sent again.')
      if (!record.approverIds?.includes(principal.id)) {
        record.approverIds = [...(record.approverIds ?? []), principal.id]
        await this.approvals.save(record)
      }
      await phone.adapter.openApprovalFlow(
        phone.session,
        record,
        await this.notificationsLinkFor(record, principal),
        principal.id
      )
      const now = Date.now()
      for (const [k, at] of this.resentAt) if (now - at >= APPROVAL_RESEND_INTERVAL_MS) this.resentAt.delete(k)
      this.resentAt.set(key, now)
      return { expiresAt: record.expiresAt }
    } finally {
      release?.()
    }
  }

  /**
   * The app link of the Notifications that list an approval for an approver (PROF-LINK-005), the `link` of its
   * `authorize` flow: those of the space for a tool of a space and a member of it, the agent's for any other
   * (INTX-APPR-022).
   */
  public async notificationsLinkFor(record: ApprovalRecord, approver: Principal): Promise<string> {
    const base = (this.pack.channels?.agui?.appLinkBase ?? DEFAULT_APP_LINK_BASE).replace(/\/*$/, '/')
    const place = await this.notifications.placeOf(record, approver)
    const path = place ? `service/${this.did}/spaces/${place}/notifications` : `service/${this.did}/notifications`
    return `${base}${path}?approval=${encodeURIComponent(record.id)}`
  }

  /**
   * The content of an approval's card as a viewer reads it (PROF-TOOL-009, PROF-TOOL-024): the requester's card in the
   * conversation where it was asked, and the items of the Notifications.
   */
  public async approvalCard(record: ApprovalRecord, viewer: Principal | null): Promise<Record<string, unknown>> {
    const canDecide =
      !!viewer &&
      record.status === 'PENDING' &&
      viewer.id !== record.requesterId &&
      !record.decisions.some((d) => d.approverId === viewer.id) &&
      (await this.approvals.isEligible(viewer, record))
    const space = record.spacePolicy && record.spaceId ? await this.spaces.find(record.spaceId) : undefined
    const purpose = record.purpose ? this.pack.purposes?.find((p) => p.id === record.purpose) : undefined
    // a tool of a space's: its policy as a member reads it, and where it stands (PROF-TOOL-037, §3.12)
    const policy =
      record.spacePolicy && space && this.governance
        ? await this.governance.memberView(space, record.spacePolicy)
        : record.spacePolicy
          ? { approvers: record.spacePolicy.approvers.map((e) => ({ ...e })), threshold: record.spacePolicy.threshold }
          : { type: record.policy.type, value: record.policy.value, vetoOnRefusal: record.policy.vetoOnRefusal }
    return {
      approvalId: record.id,
      kind: record.kind,
      tool: record.toolName,
      requester: { displayName: record.requesterName, role: record.requesterRole },
      policy,
      expiresAt: record.expiresAt,
      status: record.status,
      own: record.requesterId === viewer?.id,
      canDecide,
      decidedBy: record.decisions.map((d) => d.approverName).join(', ') || undefined,
      ...(record.kind === 'elevation' && record.purpose
        ? {
            purpose: { id: record.purpose, label: purpose?.label ?? record.purpose },
            justification: record.justification ?? '',
          }
        : {}),
      ...(record.grantExpiresAt ? { grantExpiresAt: record.grantExpiresAt } : {}),
      ...(record.action ? { action: await this.actionFor(record, viewer) } : {}),
      ...(space ? { space: { id: space.id, title: space.title } } : {}),
      ...(record.progress ? { progress: record.progress } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    }
  }

  /**
   * The action of an approval as a viewer reads it: a call made with a person's own account names that account at its
   * service on the requester's own card, and on no other (PROF-TOOL-021).
   */
  private async actionFor(record: ApprovalRecord, viewer: Principal | null): Promise<ToolAction | undefined> {
    const action = record.action
    if (action?.account.kind !== 'personal' || !viewer || viewer.id !== record.requesterId) return action
    const source = this.catalog?.source(action.source.id)
    const call = record.callId ? await this.store.toolCalls.get(record.callId) : undefined
    if (!source || !call || !this.connections) return action
    const label = await this.connections.labelIn(viewer, source, call.spaceId)
    return label ? { ...action, account: { ...action.account, label } } : action
  }

  /**
   * What became of an approval (D114). The approvers hear of it once: its `authorize` flow on each phone, opened when it is
   * made and closed once that approver decided or it ended (INTX-APPR-011), and their Notifications; never a card in a
   * conversation of theirs (INTX-APPR-006). The requester sees one card, in the conversation of the call, updated in place
   * (INTX-APPR-016). An approval of a tool call that ended then runs, or its record says what became of it (TOOL-CALL-009).
   */
  public async onApprovalChange(record: ApprovalRecord, change: ApprovalChange): Promise<void> {
    // a confirmation is the person's own, in its conversation only: nobody else is told (INTX-APPR-012)
    if (record.kind === 'confirmation') {
      if (change !== 'created') await this.gate?.onConfirmationChanged(record)
      return
    }
    // an approval that moved to a new owner: its phones were told where it moved (SPACE-MEMB-012)
    if (change !== 'moved')
      await this.approvalPhones(record, change).catch((err) =>
        this.logger.warn({ err, approvalId: record.id }, 'the phones of the approvers were not told')
      )
    if (change !== 'created') await this.requesterCardChanged(record, change)
    await this.notifications
      .changed(record)
      .catch((err) => this.logger.warn({ err, approvalId: record.id }, 'the notifications were not told'))
    await this.approvalMarks(record)
    if (change === 'created' || change === 'decision' || change === 'moved') return
    // a tool call's approval decided, cancelled or expired: it runs, or its record says what became of it (TOOL-CALL-009)
    if (record.sourceId && record.kind === 'sensitivity') {
      await this.gate?.onApprovalDecided(record, (session) => new RouterSink(this, session))
      return
    }
    if (change === 'decided' && record.status === 'APPROVED' && record.kind === 'sensitivity')
      await this.executeApproved(record)
  }

  /**
   * The approvers' phones (INTX-APPR-011): every approver it was asked of gets its `authorize` flow when it is made, with
   * the link of the Notifications that list it; an approver's flow closes once they decided, anywhere, and every flow
   * once it ended.
   */
  private async approvalPhones(record: ApprovalRecord, change: ApprovalChange): Promise<void> {
    if (change === 'created') {
      for (const id of record.approverIds ?? []) await this.approvalPhoneOpen(record, id)
      return
    }
    const ended = record.status !== 'PENDING'
    const ids = ended
      ? new Set([...(record.approverIds ?? []), ...record.decisions.map((d) => d.approverId)])
      : new Set(record.decisions.slice(-1).map((d) => d.approverId))
    const outcome = !ended || record.status === 'APPROVED' || record.status === 'REJECTED' ? 'completed' : 'cancelled'
    const reason =
      record.status === 'CANCELLED'
        ? 'The request was withdrawn.'
        : record.status === 'EXPIRED'
          ? 'The request is expired.'
          : undefined
    for (const id of ids) {
      const approver = await this.principals.get(id)
      const phone = approver ? await this.router.approvalPhone(approver) : undefined
      if (phone) await phone.adapter.closeApprovalFlow(phone.session, record, outcome, reason)
    }
  }

  /** An approver's phone takes the `authorize` flow of an approval, linked to the Notifications that list it for them. */
  public async approvalPhoneOpen(record: ApprovalRecord, approverId: string): Promise<void> {
    const approver = await this.principals.get(approverId)
    const phone = approver ? await this.router.approvalPhone(approver) : undefined
    if (approver && phone)
      await phone.adapter.openApprovalFlow(
        phone.session,
        record,
        await this.notificationsLinkFor(record, approver),
        approverId
      )
  }

  /** An approver's phone holds the flow of an approval no more: it moved to another approver (SPACE-MEMB-012). */
  public async approvalPhoneClose(record: ApprovalRecord, approverId: string): Promise<void> {
    const approver = await this.principals.get(approverId)
    const phone = approver ? await this.router.approvalPhone(approver) : undefined
    if (phone)
      await phone.adapter.closeApprovalFlow(phone.session, record, 'cancelled', 'The request moved to the new owner.')
  }

  /**
   * The requester's card (INTX-APPR-008, INTX-APPR-016, LLM-CACHE-004): its entry, in the conversation where it was
   * asked, is given to the devices in its current status, in place; what the model reads of it stays as it was written,
   * and what became of it is a record of its own, added when it happens, which no device is given. Every session of that
   * conversation, and of no other, receives the card again under its message id, with `ayni.approval.update`.
   */
  private async requesterCardChanged(record: ApprovalRecord, change: ApprovalChange): Promise<void> {
    if (!record.entryId) return
    const entry = await this.memory.get(record.entryId)
    if (!entry) return
    const requester = await this.principals.get(record.requesterId)
    const card = await this.approvalCard(record, requester ?? null)
    const fresh: MessageEntry = {
      ...entry,
      payload: { ...(entry.payload ?? {}), status: record.status, card },
    }
    await this.memory.rewrite(fresh)
    await this.memory.append({
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      principalId: entry.principalId,
      role: 'system',
      sourceType: record.status === 'REJECTED' ? 'refusal' : 'approval',
      text: approvalStateText(record, change),
      backingIdentity: entry.backingIdentity,
      payload: { kind: CARD_STATE, entryId: entry.id, approvalId: record.id, status: record.status },
    })
    const conversation = await this.sessions.conversationById(entry.conversationId)
    if (!conversation) return
    for (const session of await this.sessions.sessionsOfConversation(conversation))
      await this.router.deliver(
        session,
        { kind: 'approval', entry: fresh, approval: record, update: true },
        { peers: false }
      )
  }

  /**
   * The arguments of an approval erased with the message whose turn asked it (INTX-APPR-015): its card, on every session
   * of its conversation, and its items of the Notifications show the action's title, the source and the outcome only.
   */
  public async approvalErased(record: ApprovalRecord): Promise<void> {
    if (record.entryId) {
      const entry = await this.memory.get(record.entryId)
      const conversation = entry ? await this.sessions.conversationById(entry.conversationId) : undefined
      if (entry && conversation)
        for (const session of await this.sessions.sessionsOfConversation(conversation))
          await this.router.deliver(
            session,
            { kind: 'approval', entry, approval: record, update: true },
            { peers: false }
          )
    }
    await this.notifications.changed(record)
  }

  /**
   * What waits for each person concerned, on every session of theirs: `state.ayni.pendingApprovals`, and the item and badge
   * of the contextual menu of a DIDComm peer in chat mode (INTX-APPR-006, PROF-TOOL-025).
   */
  private async approvalMarks(record: ApprovalRecord): Promise<void> {
    const ids = new Set([...(record.approverIds ?? []), ...record.decisions.map((d) => d.approverId)])
    for (const p of await this.approvals.approversOf(record)) ids.add(p.id)
    for (const id of ids)
      for (const s of await this.sessions.listOpen(id))
        await this.router.deliver(s, { kind: 'contextual-menu', sessionId: s.id }, { peers: false })
  }

  /**
   * An approval of a tool call recorded before tools phase 1 (no source, no call record) and approved after it: it does
   * not run, since its card never showed the exact action (INTX-APPR-014); the person is told to ask again.
   */
  private async executeApproved(record: ApprovalRecord): Promise<void> {
    const session = await this.sessions.get(record.originSessionId)
    const principal = await this.principals.get(record.requesterId)
    if (session?.state !== 'bound' || !principal) return
    this.logger.warn(
      { approvalId: record.id },
      'an approval asked before tools phase 1 was approved: the action does not run'
    )
    const entry = await this.memory.append({
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'text',
      text: 'An action you asked for earlier was approved, but it was asked before this version of the agent and does not run: ask for it again.',
      backingIdentity: principal.backingIdentity,
    })
    await this.router.deliver(session, { kind: 'text', entry })
  }

  // ---- DIDComm-side lifecycle (CHAN-BIND, IDENT-SESS) -------------------------------------------

  /** A peer completed identity on a DIDComm connection: Principal resolved, capability channel set, supersede applied. */
  // `welcome: false` serves the connection in flow mode: the wallet will open its own sessions and flows.
  public async onPeerConnected(
    facts: VerifiedFacts,
    connectionId: string,
    client: ClientDescription,
    options: { welcome?: boolean } = {}
  ): Promise<{ principal: Principal; session: Session }> {
    const principal = await this.principals.resolve(facts)
    // what the authentication verified is evidence of the Principal (PRIV-EVID-001)
    await this.recordFactsEvidence(principal, facts, connectionId)
    // a person of the directory added to a list while invited is a member from now (SPACE-MEMB-002), and so is one of
    // another organization whose badge carries the invited address (SPACE-INV-003)
    await this.spaces.bindDirectoryMember(principal)
    await this.bindInvitations(principal, facts)
    await this.sessions.supersede(principal, connectionId)
    principal.capabilityChannelId = connectionId
    await this.principals.save(principal)
    // an invitation of its organization that waits asks it once for the email its stored evidence lacks (SPACE-INV-004)
    void this.invitations
      ?.onConnected(principal)
      .catch((err) => this.logger.warn({ err, principalId: principal.id }, 'waiting invitations not compared'))
    const existing = await this.store.sessions.findByExternalRef('didcomm', connectionId)
    const session = existing ?? (await this.sessions.createBound('didcomm', connectionId, principal, client)).session
    // a flow-capable wallet gets no welcome text and no menu on its connection (D54, CHAN-PROF-006)
    if (!existing && options.welcome !== false) await this.welcome(session)
    this.stats.emit('peer-connected', 1, { connectionType: facts.connectionType })
    if (facts.evidence) this.issueAutomatically(principal)
    return { principal, session }
  }

  /**
   * What an accepted authentication verified, as evidence of its Principal (PRIV-EVID-001, IDENT-AUTH-009/011): the
   * presentation of a credential, an address by its email code, a document read, a face match's audit fields.
   */
  private async recordFactsEvidence(principal: Principal, facts: VerifiedFacts, connectionId: string): Promise<void> {
    for (const input of [...(facts.evidence ? [facts.evidence] : []), ...(facts.moreEvidence ?? [])])
      await this.evidence.record(principal, { ...input, connectionRef: connectionId })
  }

  /**
   * An identity credential presented on a connection that is already served (D66, IDENT-RES-013/014/017).
   * An unidentified connection is upgraded to the Principal of the credential and its conversations, with
   * their sessions and entries, move to it. An identified connection accepts the credential only when it
   * resolves to the same Principal: any other is refused, changes nothing, and nothing of it is stored.
   */
  public async onIdentityPresented(
    connectionId: string,
    facts: VerifiedFacts
  ): Promise<{ outcome: 'identified' | 'refreshed' | 'another-identity' | 'unavailable'; principal?: Principal }> {
    const current = await this.store.principals.findByCapabilityChannel(connectionId)
    if (!current) return { outcome: 'unavailable' }
    if (current.identityCredentialRef) {
      // the same person, under its key or the key it had before (D59, IDENT-AUTH-003)
      if (current.actorIdentity !== facts.actorIdentity && current.actorIdentity !== facts.legacyActorIdentity) {
        this.logger.warn({ principalId: current.id }, 'another identity presented on a bound connection: refused')
        return { outcome: 'another-identity' }
      }
      const principal = await this.principals.resolve(facts)
      await this.recordFactsEvidence(principal, facts, connectionId)
      await this.spaces.bindDirectoryMember(principal)
      await this.bindInvitations(principal, facts)
      this.issueAutomatically(principal)
      return { outcome: 'refreshed', principal }
    }
    const target = await this.principals.resolve(facts)
    await this.recordFactsEvidence(target, facts, connectionId)
    await this.spaces.bindDirectoryMember(target)
    await this.bindInvitations(target, facts)
    // the identified Principal may hold another channel: the device policy applies, as at a connection
    await this.sessions.supersede(target, connectionId)
    const sessions = await this.store.sessions.listByPrincipal(current.id)
    for (const session of sessions) await this.store.sessions.save({ ...session, principalId: target.id })
    const conversations = await this.store.conversations.listByPrincipal(current.id, ['active', 'archived', 'final'])
    // a conversation of the guest's Personal space is one of the identified person's Personal space, and so are its
    // memories (decision 60, SPACE-DEF-002)
    for (const conversation of conversations)
      await this.store.conversations.save({
        ...conversation,
        principalId: target.id,
        spaceId:
          spaceIdOf(conversation) === personalSpaceId(current.id) ? personalSpaceId(target.id) : conversation.spaceId,
      })
    for (const note of await this.store.notes.list(current.id)) {
      if (MemoryService.spaceOfNote(note) !== personalSpaceId(current.id)) continue
      await this.store.notes.save({ ...note, principalId: target.id, spaceId: personalSpaceId(target.id) })
    }
    // what the agent verified about the guest (an address its email code checked, a document read) and the badge it
    // issued them are the identified person's: about-me shows them, and the badge is held (decision 62)
    await this.evidence.reassign(current.id, target.id)
    const entries = await this.store.entries.reassign(
      sessions.map((s) => s.id),
      target.id
    )
    // the devices paired on this connection stay paired: their sessions moved with them
    target.devices = [...(target.devices ?? []), ...(current.devices ?? [])]
    target.capabilityChannelId = connectionId
    await this.principals.save(target)
    current.capabilityChannelId = null
    current.devices = []
    await this.principals.save(current)
    this.stats.emit('peer-identified', 1, { connectionType: facts.connectionType })
    this.logger.info(
      {
        from: current.id,
        principalId: target.id,
        sessions: sessions.length,
        conversations: conversations.length,
        entries,
      },
      'unidentified connection upgraded: its conversations moved to the identified Principal'
    )
    this.issueAutomatically(target)
    return { outcome: 'identified', principal: target }
  }

  /**
   * The issuance an email check started goes on by itself once the code is right (INTX-AUTH-015): its claims resolve and
   * the credential is offered with no turn of the model. What became of it is told in the conversation by the code.
   */
  public async continueIssuance(record: AuthChallengeRecord): Promise<void> {
    const details = (record.details ?? {}) as {
      profile?: string
      by?: IssuanceTrigger
      conversationId?: string
      lastSessionId?: string
    }
    const principal = await this.principals.get(record.principalId)
    if (!principal || !details.profile || !this.issuance) return
    const session =
      (details.lastSessionId ? await this.sessions.get(details.lastSessionId) : undefined) ??
      (await this.sessions.get(record.originSessionId))
    if (!session) return
    const result = await this.issuance.issue(principal, session, details.profile, details.by ?? 'model')
    this.logger.info(
      { principalId: principal.id, profile: details.profile, outcome: result.outcome },
      'issuance after the email check'
    )
    const text = issuanceOutcomeForPerson(result.outcome, result.requirements, result.reason)
    const entry = await this.memory.append({
      sessionId: session.id,
      ...(details.conversationId ? { conversationId: details.conversationId } : {}),
      principalId: principal.id,
      role: 'agent',
      sourceType: 'text',
      text,
      backingIdentity: principal.backingIdentity,
      payload: { kind: 'issuance-outcome', profile: details.profile, usedMemories: [], usedPreferences: [] },
    })
    await this.deliverToConversation(session, entry)
  }

  /**
   * A message the agent adds outside a turn, shown in the conversation of a session: on that session when it is open,
   * else on an open session of the same conversation; history has it in any case.
   */
  public async deliverToConversation(session: Session, entry: MessageEntry): Promise<void> {
    const target =
      session.state === 'bound'
        ? session
        : (await this.sessions.listOpen(session.principalId ?? '')).find(
            (s) => (s.conversationId ?? s.id) === (session.conversationId ?? session.id)
          )
    if (target) await this.router.deliver(target, { kind: 'text', entry })
  }

  /** A message the code writes in a run (a question of an email check): an `auth-challenge` entry, streamed by the sink. */
  private async codeSays(
    session: Session,
    principal: Principal,
    text: string,
    sink: TurnSink,
    payload: Record<string, unknown>
  ): Promise<MessageEntry> {
    const id = prefixedId('msg')
    await sink.emit({ type: 'text-start', messageId: id })
    await sink.emit({ type: 'text-delta', messageId: id, delta: text })
    await sink.emit({ type: 'text-end', messageId: id })
    return this.memory.append({
      id,
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'auth-challenge',
      text,
      backingIdentity: principal.backingIdentity,
      payload,
    })
  }

  /** The invitations of other organizations an identity credential binds to its Principal (SPACE-INV-003). */
  private async bindInvitations(principal: Principal, facts: VerifiedFacts): Promise<void> {
    await this.invitations
      ?.bindPresented(principal, facts)
      .catch((err) => this.logger.error({ err, principalId: principal.id }, 'invitations not bound'))
  }

  /** The credentials the agent issues by itself are issued as soon as their evidence is complete (INTX-ISSUE-008). */
  public issueAutomatically(principal: Principal): void {
    const issuance = this.issuance
    const connectionId = principal.capabilityChannelId
    if (!issuance || !connectionId) return
    void this.didcommSession(connectionId)
      .then((bound) => (bound ? issuance.automatic(bound.principal, bound.session) : undefined))
      .catch((err) => this.logger.warn({ err, principalId: principal.id }, 'automatic issuance failed'))
  }

  public async onPeerDisconnected(connectionId: string): Promise<void> {
    const principal = await this.store.principals.findByCapabilityChannel(connectionId)
    if (!principal) return
    await this.sessions.closeAll(principal.id, 'channel-closed')
    principal.capabilityChannelId = null
    await this.principals.save(principal)
    await this.sessions.revokeAllDevices(principal) // no phone, no pairing (IDENT-DEV-005)
  }

  /** An inbound DIDComm message on the capability channel is a conversation turn (CHAN-ROUTE-003). */
  public async didcommSession(connectionId: string): Promise<{ session: Session; principal: Principal } | undefined> {
    const session = await this.store.sessions.findByExternalRef('didcomm', connectionId)
    if (session?.state !== 'bound') return undefined
    const principal = await this.principalOf(session)
    return principal ? { session, principal } : undefined
  }

  /** Credential failure terminates the Principal's sessions (IDENT-LIVE-004/005); its wallet is told (IDENT-STAT-005). */
  public async onCredentialInvalid(principal: Principal): Promise<void> {
    await this.peerStatus?.credentialInvalid(principal)
    await this.sessions.closeAll(principal.id, 'credential-invalid')
    await this.sessions.revokeAllDevices(principal)
  }

  public async closeByReason(session: Session, reason: ClosureReason): Promise<void> {
    await this.sessions.close(session, reason)
  }

  public get now(): string {
    return nowIso()
  }
}
