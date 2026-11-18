/**
 * The agent facade: wires the channel-agnostic core and exposes the operations channels call.
 * Channels never reach persistence or the model directly (architecture section 4).
 */

import type { AyniAction, AyniState, PrincipalDisplay, SessionStatus } from '@ayni.org/ayni-agui-profile'
import type { CredentialOffers } from '../channels/didcomm/credentialOffers.js'
import { type IdentityRequests, identityOutcomeForPerson } from '../channels/didcomm/identityRequests.js'
import type { PeerStatusNotifier } from '../channels/didcomm/peerStatus.js'
import type { Env } from '../config/env.js'
import type { AgentPack, Features } from '../config/packTypes.js'
import { featuresOf } from '../config/packTypes.js'
import type { ChatModel } from '../llm/types.js'
import type { MediaService } from '../media/service.js'
import type { RagService } from '../memory/rag.js'
import type { MemoryService, NewEntry } from '../memory/service.js'
import type { StatsSink } from '../platform/stats.js'
import { ApprovalError, type ApprovalService, displayName } from '../policy/approvals.js'
import type { Store } from '../store/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import { nowIso } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { ChallengeService } from './challenges.js'
import type { CapabilityRouter } from './channel.js'
import type { ContextAssembler } from './context.js'
import { conversationOf } from './conversationOf.js'
import type { EvidenceService } from './evidence.js'
import type { FlowService } from './flows.js'
import { contextualMenuFor, describeDevices, describeSessions, greetingFor, PLATFORM_MENU } from './interaction.js'
import { type IssuanceService, issuanceOutcomeForPerson } from './issuance.js'
import {
  conversationKey,
  type Orchestrator,
  type TurnContext,
  type TurnInput,
  type TurnResult,
  type TurnSink,
} from './orchestrator.js'
import type { PrincipalService, VerifiedFacts } from './principals.js'
import { SessionError, type SessionService, TRANSCRIPT_MESSAGE_TYPES } from './sessions.js'
import { TurnLock } from './turnLock.js'
import type { ApprovalRecord, ClientDescription, ClosureReason, MessageEntry, Principal, Session } from './types.js'
import { ProcessEnding, TooManyWaiting, type WaitingItem, WaitingList } from './waiting.js'

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

  public async status(session: Session): Promise<SessionStatus> {
    const principal = await this.principalOf(session)
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
      deviceSecret: session.state === 'bound' ? session.deviceSecret : undefined,
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
    const pending = principal && this.features.approvals ? (await this.approvals.pendingFor(principal)).length : 0
    // the context figure of the conversation's latest turn, the same on every device (D74, PROF-STREAM-007)
    const context = session.state === 'bound' ? await this.context.figure(conversationOf(session)) : undefined
    return {
      ...(context ? { context } : {}),
      contextualMenu: { items: contextualMenuFor(this.pack, principal, session, pending) },
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

  // ---- erasure (D78, PRIV-ERASE-007) -------------------------------------------------------------

  /**
   * A message the Principal wrote in the session's conversation, erased for good (PROF-HIST-010): named by the
   * agent's id or by the client's id. Any other message is not found; a message on legal hold is held.
   */
  public async eraseOwnMessage(
    session: Session,
    principal: Principal,
    messageId: string
  ): Promise<{
    outcome: 'erased' | 'not-found' | 'legal-hold'
    conversationId: string
    messageIds: string[]
    /** the ids the client gave the erased messages, when it gave one (PROF-STREAM-008) */
    clientIds: string[]
  }> {
    const conversationId = conversationOf(session)
    const own = (
      await this.store.entries.listAll({ conversationId, principalId: principal.id, limit: 100_000 })
    ).filter((e) => e.role === 'principal' && TRANSCRIPT_MESSAGE_TYPES.includes(e.sourceType))
    const target = own.find((e) => e.id === messageId) ?? own.find((e) => e.externalId === messageId)
    if (!target) return { outcome: 'not-found', conversationId, messageIds: [], clientIds: [] }
    const result = await this.memory.erase(target.id)
    if (result.reason === 'legal-hold') return { outcome: 'legal-hold', conversationId, messageIds: [], clientIds: [] }
    return {
      outcome: 'erased',
      conversationId,
      messageIds: [target.id],
      clientIds: target.externalId ? [target.externalId] : [],
    }
  }

  /** Every message the Principal wrote in a conversation, erased for good (PROF-CONV-009); the agent's stay. */
  public async eraseOwnConversation(
    principal: Principal,
    conversationId: string
  ): Promise<{ erased: string[]; held: string[]; clientIds: string[] }> {
    const own = (
      await this.store.entries.listAll({ conversationId, principalId: principal.id, limit: 100_000 })
    ).filter(
      (e) => e.role === 'principal' && TRANSCRIPT_MESSAGE_TYPES.includes(e.sourceType) && e.state !== 'crypto-erased'
    )
    const erased: string[] = []
    const held: string[] = []
    const clientIds: string[] = []
    for (const entry of own) {
      const result = await this.memory.erase(entry.id)
      if (result.erased) {
        erased.push(entry.id)
        if (entry.externalId) clientIds.push(entry.externalId)
      } else if (result.reason === 'legal-hold') held.push(entry.id)
    }
    return { erased, held, clientIds }
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
    resumeSessionId?: string
  ): Promise<{ session: Session; token: string }> {
    const record = await this.sessions.redeemGrant(grant)
    const principal = await this.store.principals.get(record.principalId)
    const capability = principal ? await this.router.capabilitySession(principal) : undefined
    if (!principal || !capability || capability.externalRef !== record.connectionId)
      throw new SessionError('the connection that received the grant is gone', 'grant-expired')
    const live = await this.principals.ensureLive(principal)
    if (!live.ok) throw new SessionError('identity credential no longer valid', 'grant-expired')
    const conversation = await this.sessions.requireOpenable(conversationId ?? record.conversationId, resumeSessionId)
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
      resumeSessionId
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
    silent = false
  ) {
    const conversation = await this.sessions.requireOpenable(conversationId, resumeSessionId)
    const created = await this.sessions.createProvisional(
      'ag-ui',
      client,
      locale,
      deviceHandle,
      resumeSessionId,
      conversation,
      newConversation
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
    newConversation = false
  ) {
    const conversation = await this.sessions.requireOpenable(conversationId, resumeSessionId)
    return this.sessions.createSibling(parent, client, locale, resumeSessionId, conversation, newConversation)
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
  public async turn(session: Session, input: TurnInput, sink: TurnSink, caller: AbortSignal): Promise<TurnResult> {
    this.sessions.requireBound(session)
    const principal = await this.principalOf(session)
    if (!principal) throw new Error('principal missing')
    await this.sessions.touch(session)
    const key = conversationKey(session)
    const signal = this.untilCut(caller)
    // while the process ends, as during a turn: the message waits, and the next process answers it
    if (input.mayWait && (this.ending || this.turns.busy(key))) return this.wait(key, session, principal, input)
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
  ): Promise<TurnResult | { text: string; await?: 'binding-code' } | undefined> {
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
        try {
          const record = await this.approvals.decide(action.approvalId, principal, action.decision, action.note)
          return { text: `Approval ${record.id} ${record.status.toLowerCase()}.` }
        } catch (error) {
          if (error instanceof ApprovalError) return { text: error.message }
          throw error
        }
      }
      case 'approval.cancel': {
        try {
          const record = await this.approvals.cancel(action.approvalId, principal)
          return { text: `Request ${record.id} withdrawn.` }
        } catch (error) {
          if (error instanceof ApprovalError) return { text: error.message }
          throw error
        }
      }
      case 'elevation.request':
        return this.requestElevation(session, principal, action.tool, action.purposeId, action.justification)
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
      const pending = await this.approvals.pendingFor(principal)
      const own = (await this.approvals.ownRequests(principal)).filter((r) => r.status === 'PENDING')
      if (!pending.length && !own.length) return { text: 'No pending approvals.' }
      const lines = [
        ...pending.map(
          (r) => `- To decide: ${r.requesterName} asks ${r.toolName}${r.purpose ? ` for ${r.purpose}` : ''} (${r.id})`
        ),
        ...own.map((r) => `- Your request ${r.toolName} is pending (${r.id})`),
      ]
      for (const r of pending)
        await this.router.deliver(session, {
          kind: 'approval',
          entry: await this.approvalEntry(session, principal, r),
          approval: r,
        })
      return { text: lines.join('\n') }
    }
    if (itemId.startsWith(PLATFORM_MENU.issuePrefix)) {
      // the person asks for a credential the pack issues on request (INTX-ISSUE-008)
      const name = itemId.slice(PLATFORM_MENU.issuePrefix.length)
      const result = await this.issuance?.issue(principal, session, name, 'person')
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
    justification: string
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
      await this.memory.append({
        sessionId: session.id,
        principalId: principal.id,
        role: 'principal',
        sourceType: 'approval',
        text: `Elevation requested for ${record.toolName}: ${purposeId}`,
        backingIdentity: principal.backingIdentity,
        payload: { approvalId: record.id, kind: 'elevation', toolName: record.toolName, status: record.status },
      })
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

  // ---- approvals: notifications and execution (INTX-APPR-006, RBAC-TOOL-003) --------------------

  private async approvalEntry(session: Session, principal: Principal, record: ApprovalRecord): Promise<MessageEntry> {
    return this.memory.append({
      sessionId: session.id,
      principalId: principal.id,
      role: 'system',
      sourceType: record.status === 'REJECTED' ? 'refusal' : 'approval',
      text: `Approval ${record.id} for ${record.toolName}: ${record.status}`,
      backingIdentity: principal.backingIdentity,
      payload: {
        approvalId: record.id,
        kind: record.kind,
        toolName: record.toolName,
        status: record.status,
        purpose: record.purpose,
      },
    })
  }

  public async onApprovalChange(
    record: ApprovalRecord,
    change: 'created' | 'decided' | 'cancelled' | 'expired'
  ): Promise<void> {
    const principals = await this.store.principals.list()
    for (const p of principals) {
      const eligible = this.approvals.isEligible(p, record)
      const requester = p.id === record.requesterId
      if (!eligible && !requester) continue
      const sessions = await this.sessions.listOpen(p.id)
      for (const s of sessions) {
        if (requester && s.id === record.originSessionId && change === 'created') continue // the origin already has its card
        await this.router.deliver(s, {
          kind: 'approval',
          entry: await this.approvalEntry(s, p, record),
          approval: record,
          update: change !== 'created',
        })
        await this.router.deliver(s, { kind: 'contextual-menu', sessionId: s.id })
      }
    }
    if (change === 'decided' && record.status === 'APPROVED' && record.kind === 'sensitivity')
      await this.executeApproved(record)
  }

  private async executeApproved(record: ApprovalRecord): Promise<void> {
    const session = await this.sessions.get(record.originSessionId)
    const principal = await this.principals.get(record.requesterId)
    if (session?.state !== 'bound' || !principal) return
    const sink = new RouterSink(this, session)
    const content = await this.orchestrator.invokeTool(
      record.toolName,
      record.actionArgs ?? {},
      session,
      principal,
      sink,
      true
    )
    const entry = await this.memory.append({
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'text',
      text: `The approved action ${record.toolName} ran. ${content.slice(0, 1500)}`,
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
    // the presentation that identified the peer is evidence of the Principal (PRIV-EVID-001)
    if (facts.evidence) await this.evidence.record(principal, { ...facts.evidence, connectionRef: connectionId })
    await this.sessions.supersede(principal, connectionId)
    principal.capabilityChannelId = connectionId
    await this.principals.save(principal)
    const existing = await this.store.sessions.findByExternalRef('didcomm', connectionId)
    const session = existing ?? (await this.sessions.createBound('didcomm', connectionId, principal, client)).session
    // a flow-capable wallet gets no welcome text and no menu on its connection (D54, CHAN-PROF-006)
    if (!existing && options.welcome !== false) await this.welcome(session)
    this.stats.emit('peer-connected', 1, { connectionType: facts.connectionType })
    if (facts.evidence) this.issueAutomatically(principal)
    return { principal, session }
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
      if (current.actorIdentity !== facts.actorIdentity) {
        this.logger.warn({ principalId: current.id }, 'another identity presented on a bound connection: refused')
        return { outcome: 'another-identity' }
      }
      const principal = await this.principals.resolve(facts)
      if (facts.evidence) await this.evidence.record(principal, { ...facts.evidence, connectionRef: connectionId })
      this.issueAutomatically(principal)
      return { outcome: 'refreshed', principal }
    }
    const target = await this.principals.resolve(facts)
    if (facts.evidence) await this.evidence.record(target, { ...facts.evidence, connectionRef: connectionId })
    // the identified Principal may hold another channel: the device policy applies, as at a connection
    await this.sessions.supersede(target, connectionId)
    const sessions = await this.store.sessions.listByPrincipal(current.id)
    for (const session of sessions) await this.store.sessions.save({ ...session, principalId: target.id })
    const conversations = await this.store.conversations.listByPrincipal(current.id, ['active', 'archived', 'final'])
    for (const conversation of conversations)
      await this.store.conversations.save({ ...conversation, principalId: target.id })
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
