/**
 * The LLM turn (architecture 4, 10.2, 11.8, 12.3): context assembly from the window, working
 * memory, preferences and semantic recall; RBAC-filtered tools; approvals, liveness and auth
 * challenges around tool calls; cancellation that persists the partial reply as interrupted (D47).
 */
import type { AgentPack } from '../config/packTypes.js'
import { challengeTypesOf, featuresOf } from '../config/packTypes.js'
import type { ChatDelta, ChatMessage, ChatModel, ContentPart, ToolCallRequest } from '../llm/types.js'
import type { ObjectStore } from '../media/objectStore.js'
import type { MemoryService, NewEntry, Recalled } from '../memory/service.js'
import type { StatsSink } from '../platform/stats.js'
import type { ApprovalService } from '../policy/approvals.js'
import { ToolCatalog } from '../tools/catalog.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { EndTurnMessage, MemoryChange, ToolContext } from '../tools/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { estimateRequestTokens } from '../util/tokens.js'
import type { ChallengeService } from './challenges.js'
import type { ContextAssembler } from './context.js'
import { conversationOf } from './conversationOf.js'
import { isEmailCheckMessage, withheldRecordText } from './emailCheck.js'
import { nameForModel } from './evidence.js'
import type { PrincipalService } from './principals.js'
import { addonTokenCount, renderPromptAddon } from './promptAddon.js'
import { isPersonalSpace, personalSpaceId } from './spaces.js'
import type { ToolGate, TurnTool, TurnToolState } from './toolGate.js'
import type { ApprovalRecord, MessageEntry, Principal, ReactionPolicy, Session, TurnSource } from './types.js'

/** The memories and preferences a turn was given (MEM-SPACE-006): what an answer's Info lists. */
export interface UsedMemory {
  memories: string[]
  preferences: string[]
}

export type TurnEvent =
  | { type: 'text-start'; messageId: string }
  | { type: 'text-delta'; messageId: string; delta: string }
  | { type: 'text-end'; messageId: string }
  | { type: 'step-started'; label: string }
  | { type: 'step-finished'; label: string }
  | { type: 'activity'; messageId: string; activityType: string; content: Record<string, unknown> }
  | { type: 'inbound'; entry: MessageEntry }
  /** the turn starts: until then it may have waited for another to end (D63) */
  | { type: 'turn-start' }
  /** a CUSTOM event of the conversation: a memory the turn changed (MEM-SPACE-005, PROF-STREAM-010) */
  | { type: 'custom'; name: string; value: Record<string, unknown> }

export interface TurnSink {
  emit(event: TurnEvent): Promise<void> | void
}

export interface TurnInput {
  entry: NewEntry
  /** bytes of image attachments for multimodal models, keyed by attachment id (never persisted) */
  imageBytes?: Map<string, Buffer>
  /**
   * the message may wait: when a turn of its conversation is in progress it is recorded, listed as waiting and
   * answered when that turn ends, and the caller is told at once (D63). Without it the caller waits for its turn.
   */
  mayWait?: boolean
}

export interface TurnResult {
  /** the person's message: the last one when several were answered together; none when no turn ran */
  inbound?: MessageEntry
  /** the agent's reply: its last message, when it wrote several (CORE-MSG-011) */
  reply?: MessageEntry
  /** every message of the reply, in order; one, unless the agent resumed after a pause */
  replies?: MessageEntry[]
  cancelled: boolean
  /** every message this turn answered, in the order they arrived */
  inbounds?: MessageEntry[]
  /** no turn ran: the message is recorded and waits for the turn in progress to end (D63) */
  waiting?: boolean
  /** no turn ran: the caller gave up while it waited for its turn */
  withdrawn?: boolean
}

/** What a turn is told of the conversation it runs in, beyond its own messages (D63). */
export interface TurnContext {
  /** the entries recorded while a turn ran and not answered yet: out of the model's context until their turn */
  notYet?: () => Promise<ReadonlySet<string>>
  /**
   * where the reply stands in the conversation, when not at the time it ends: before the first message that
   * arrived to wait while it was written
   */
  replyAt?: () => Promise<string | undefined>
}

/** The conversation a turn belongs to: one turn at a time in it, whatever the session or the device. */
export function conversationKey(session: Pick<Session, 'id' | 'conversationId'>): string {
  return session.conversationId ? `conv:${session.conversationId}` : `ses:${session.id}`
}

export interface OrchestratorHooks {
  /** the Principal's identity credential failed re-verification: terminate its sessions (IDENT-LIVE-004/005) */
  onCredentialInvalid(principal: Principal): Promise<void>
  /** an approval is pending for a tool call started in this session */
  onApprovalPending(session: Session, principal: Principal, record: ApprovalRecord, entry: MessageEntry): Promise<void>
}

/** What a turn's model calls cost (LLM-USAGE-002): the sums, and the input of the last call, the context figure. */
export interface TurnUsage {
  calls: number
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** the input of the turn's last call: the size of the context */
  contextTokens: number
  /** the part of it the provider served from its cache */
  contextCached: number
}

/** What one recalled entry may cost in the request: its date, its origin and at most 300 characters. */
export const RECALLED_ITEM_TOKENS = 100

/** The recalled entries as a record of the system, each with where it comes from (MEM-RET-007). */
export function recallRecord(recalled: Recalled[]): string | undefined {
  if (!recalled.length) return undefined
  const lines = recalled.map(({ entry, origin }) => {
    const where = origin === 'this-conversation' ? 'earlier in this conversation' : 'another conversation'
    const who = entry.role === 'agent' ? 'you' : entry.role === 'principal' ? 'the person' : 'the system'
    return `- (${entry.createdAt.slice(0, 10)}, ${where}, ${who}) ${entry.text.slice(0, 300)}`
  })
  return `[system record, written by the system, not by the person and not by you: earlier messages that may be relevant, already authorized:\n${lines.join('\n')}]`
}

/** The turn's message with what was retrieved for it before its words. */
export function withRetrieved(turn: ChatMessage, record: string | undefined): ChatMessage {
  if (!record || turn.role !== 'user') return turn
  if (typeof turn.content === 'string') return { role: 'user', content: `${record}\n\n${turn.content}` }
  return { role: 'user', content: [{ type: 'text', text: record }, ...turn.content] }
}

export class TurnCancelled extends Error {
  public constructor() {
    super('turn cancelled')
    this.name = 'TurnCancelled'
  }
}

/**
 * What the system did in a conversation, as the model reads it in the history: a record, framed as one, in the
 * turn of the other side. These records were written in the agent's own voice, as `[note] <text>`. A request
 * shown on the phone reads as its title, so the history held an agent line "[note] Read your passport or
 * identity card" after the person's "Retry": at the next "Retry" the model wrote that line itself, as its
 * whole answer, and called no tool. The person saw the words and no request, three times.
 *
 * A request shown on the phone says what became of it, so that the model knows that an expired or declined one
 * is over and that asking again means calling the tool again.
 */
export function systemRecord(entry: Pick<MessageEntry, 'sourceType' | 'text' | 'payload'>): string {
  let what = entry.text
  if (entry.sourceType === 'flow') {
    const card = (entry.payload ?? {}) as { kind?: string; state?: string; outcome?: string }
    const became = card.outcome ?? card.state ?? 'pending'
    const over = became !== 'pending' && became !== 'active'
    what = `a request was shown on the phone of the person, "${entry.text}"${card.kind ? ` (${card.kind})` : ''}; it is ${became}${over ? ' and over: nothing is on their phone now' : ''}`
  }
  return `[system record, written by the system, not by the person and not by you: ${what}]`
}

export class Orchestrator {
  private readonly reactionPolicies = new Map<string, ReactionPolicy>()
  private readonly addon: string
  private readonly maxToolRounds = 8
  /**
   * A reply that resumes after its tools took this long is a new message (CORE-MSG-011): the person was away from
   * the conversation meanwhile, answering a request in their wallet, and what the agent says of the outcome must
   * not be the end of a message they already read. Under it the reply goes on, in a new paragraph.
   */
  public resumeAsNewMessageMs = 5_000
  /**
   * The space of a session's conversation (MEM-SPACE-001): its notes are the ones the model reads and writes. Set by the
   * composition root; Personal without it.
   */
  public spaceOf: (session: Session, principal: Principal) => Promise<string> = async (_session, principal) =>
    personalSpaceId(principal.id)
  /**
   * What the agent's code answers instead of the model in a space that does not allow the model provider it is
   * configured with (SPACE-CONV-004); set by the composition root. Undefined: the space allows it.
   */
  public providerRefusal?: (session: Session, principal: Principal, spaceId: string) => Promise<string | undefined>
  /** the messages each conversation's turn in progress answers: deleting one cancels the turn first (PRIV-ERASE-011) */
  private readonly answering = new Map<string, Set<string>>()
  /**
   * What a call needs and its record (ayni-spec D99, D100): every call of a turn goes through it. Set by the composition
   * root.
   */
  public gate?: ToolGate
  /** the space a session's conversation is in, opened: for the rules of its tools; set by the composition root */
  public spaceById?: (spaceId: string) => Promise<TurnToolState['space']>

  public constructor(
    private readonly pack: AgentPack,
    private readonly llm: ChatModel,
    private readonly memory: MemoryService,
    private readonly principals: PrincipalService,
    // the tools of a turn come from the gate (D96): the registry and the challenges are its
    _registry: ToolRegistry,
    private readonly approvals: ApprovalService,
    _challenges: ChallengeService,
    private readonly objects: ObjectStore,
    private readonly stats: StatsSink,
    private readonly hooks: OrchestratorHooks,
    private readonly logger: Logger,
    private readonly context: ContextAssembler
  ) {
    const features = featuresOf(pack)
    this.addon = renderPromptAddon({
      features,
      agentLanguage: pack.language.agent,
      hasTools: true,
      hasRequestableTools:
        (pack.tools?.access?.elevation?.length ?? 0) > 0 ||
        (pack.mcp?.servers ?? []).some((s) => (s.toolAccess?.elevation?.length ?? 0) > 0),
      challengesConfigured: Object.values(pack.actions ?? {}).some((a) => a.authChallenge),
      issuance: Object.keys(pack.issuance ?? {}).length > 0,
      appLinkBase: pack.channels?.agui?.appLinkBase,
      emailChecks: Object.values(pack.issuance ?? {}).some((p) => challengeTypesOf(p).includes('email')),
      // the person or an approver may be asked before an action runs (TOOL-CALL-010)
      toolsMayAsk: new ToolCatalog(pack).mayAsk(),
    })
    const tokens = addonTokenCount(this.addon)
    if (tokens > 500) logger.warn({ tokens }, 'system-prompt add-on exceeds its 500-token target (CORE-PROMPT-004)')
  }

  public setReactionPolicy(sessionId: string, policy: ReactionPolicy): void {
    this.reactionPolicies.set(sessionId, policy)
  }

  /** The messages the turn in progress of a conversation answers. */
  public answeringIn(conversationId: string): ReadonlySet<string> {
    return this.answering.get(conversationId) ?? new Set()
  }

  // ---- context assembly -----------------------------------------------------------------------

  /**
   * Parts 1 to 3 of the request, and what of the person's memory they hold (MEM-SPACE-001): every preference, which is
   * global, and the notes of the space of the conversation only.
   */
  private async systemMessages(
    principal: Principal,
    session: Session,
    spaceId: string
  ): Promise<{ messages: ChatMessage[]; used: UsedMemory }> {
    const features = featuresOf(this.pack)
    const parts: string[] = []
    const used: UsedMemory = { memories: [], preferences: [] }
    const prefs = features.preferences ? await this.memory.preferences(principal, session) : []
    if (prefs.length) parts.push(`Preferences of the person: ${prefs.map((p) => `${p.key}=${p.value}`).join('; ')}`)
    used.preferences = prefs.map((p) => p.key)
    if (features.workingMemory) {
      const notes = await this.memory.notes(principal, session, spaceId)
      if (notes.length)
        parts.push(
          `Working memory notes:\n${notes.map((n) => `- [${n.id}]${n.needsRevision ? ' (needs revision)' : ''} ${n.content}`).join('\n')}`
        )
      used.memories = notes.map((n) => n.id)
    }
    // a person identified by a credential is named only when the pack lets the model read the name (D68)
    const name = nameForModel(this.pack, principal)
    const display = name ? `The person is ${name}` : 'The person is authenticated'
    const backing = principal.backingIdentity?.name
      ? `, backed by ${principal.backingIdentity.name} (${principal.backingRelation})`
      : ''
    parts.push(`${display}${backing}. Roles: ${principal.roles.join(', ') || 'none'}. Channel: ${session.channelType}.`)
    return {
      messages: [
        { role: 'system', content: this.pack.persona.systemPrompt },
        { role: 'system', content: this.addon },
        { role: 'system', content: parts.join('\n\n') },
      ],
      used,
    }
  }

  private entryToMessages(entry: MessageEntry): ChatMessage[] {
    if (entry.sourceType === 'tool-call') {
      const p = entry.payload as { name?: string; arguments?: unknown; result?: string } | undefined
      if (!p?.name) return []
      const id = `hist_${entry.id}`
      return [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id, name: p.name, arguments: (p.arguments as Record<string, unknown>) ?? {} }],
        },
        { role: 'tool', toolCallId: id, name: p.name, content: (p.result ?? '').slice(0, 2000) },
      ]
    }
    // receipts and reactions are bookkeeping, not conversation (a reaction the model must know about
    // arrives as its own turn); approvals, challenges and the requests shown on the phone are records of the
    // system, told as such and never in the agent's voice
    if (entry.sourceType === 'state-update' || entry.sourceType === 'reaction') return []
    // an email check (decision 65, INTX-AUTH-013, MEM-RET-006): the code's messages are the agent's, in the language
    // they were shown in; what the person typed for it never reaches the model, a record of the system stands in its
    // place, so that the model reads the order of what happened
    if (isEmailCheckMessage(entry)) {
      if (entry.role === 'agent') return [{ role: 'assistant', content: entry.text }]
      return [
        { role: 'user', content: systemRecord({ sourceType: 'auth-challenge', text: withheldRecordText(entry) }) },
      ]
    }
    if (
      entry.sourceType === 'approval' ||
      entry.sourceType === 'refusal' ||
      entry.sourceType === 'auth-challenge' ||
      entry.sourceType === 'flow' ||
      entry.role === 'system'
    ) {
      return [{ role: 'user', content: systemRecord(entry) }]
    }
    if (entry.role === 'agent')
      return [
        { role: 'assistant', content: entry.completion === 'interrupted' ? `${entry.text} [interrupted]` : entry.text },
      ]
    return [{ role: 'user', content: withReplyContext(entry) }]
  }

  private async userMessage(entry: MessageEntry, imageBytes?: Map<string, Buffer>): Promise<ChatMessage> {
    // extracted file content (a PDF's text) travels with the message; images go as parts when the model can see
    const files = entry.attachments
      .filter((a) => a.type === 'file' && a.textRepr && !a.textRepr.startsWith('[file '))
      .map((a) => `\n\n--- attached file: ${a.filename ?? a.id} ---\n${a.textRepr}`)
      .join('')
    const text = withReplyContext(entry) + files
    const parts: ContentPart[] = [{ type: 'text', text }]
    if (this.llm.multimodal) {
      for (const a of entry.attachments) {
        if (a.type !== 'image') continue
        try {
          const bytes = imageBytes?.get(a.id) ?? (await this.objects.get(a.bucketKey, a.objectKeyRef))
          parts.push({ type: 'image', mimeType: a.mimeType, data: bytes })
        } catch (error) {
          this.logger.warn({ err: error, attachmentId: a.id }, 'image not passed to the model')
        }
      }
    }
    return { role: 'user', content: parts.length === 1 ? text : parts }
  }

  /**
   * What the person said, as one message of the model's conversation: one message, or several that waited
   * together, in the order they arrived. One user message whatever their number: providers that want user and
   * assistant messages to alternate take it as it is.
   */
  private async userTurn(inbounds: MessageEntry[], imageBytes?: Map<string, Buffer>): Promise<ChatMessage> {
    const built = await Promise.all(inbounds.map((entry) => this.userMessage(entry, imageBytes)))
    if (built.length === 1) return built[0] as ChatMessage
    const parts: ContentPart[] = []
    for (const message of built) {
      if (message.role !== 'user') continue
      if (typeof message.content === 'string') parts.push({ type: 'text', text: message.content })
      else parts.push(...message.content)
    }
    const texts = parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    return { role: 'user', content: texts.length === parts.length ? texts.join('\n\n') : parts }
  }

  // ---- the turn -------------------------------------------------------------------------------

  /** A turn for a message of the Principal: the message is recorded, then answered. */
  public async run(
    session: Session,
    principal: Principal,
    input: TurnInput,
    sink: TurnSink,
    signal: AbortSignal,
    context: TurnContext = {}
  ): Promise<TurnResult> {
    await this.live(principal)
    const inbound = await this.record(session, input)
    return this.answer(session, principal, [inbound], sink, signal, context, input.imageBytes)
  }

  /** The Principal's credential still holds (IDENT-LIVE): checked before anything of a message is taken. */
  public async live(principal: Principal): Promise<void> {
    const liveness = await this.principals.ensureLive(principal)
    if (!liveness.ok && liveness.reason !== 'unavailable') {
      await this.hooks.onCredentialInvalid(principal)
      throw new Error('identity credential is no longer valid')
    }
  }

  /** Records a message of the Principal: now for a turn that starts, or for one that waits (D63). */
  public async record(session: Session, input: TurnInput): Promise<MessageEntry> {
    const inbound = await this.memory.append(input.entry)
    this.stats.emit('message-in', 1, { channel: session.channelType, sourceType: inbound.sourceType })
    return inbound
  }

  /**
   * The turn itself, for messages already recorded: one, or several that waited together (D63, CORE-MSG-010),
   * which the model reads in the order they arrived and answers by one reply.
   */
  public async answer(
    session: Session,
    principal: Principal,
    inbounds: MessageEntry[],
    sink: TurnSink,
    signal: AbortSignal,
    context: TurnContext = {},
    imageBytes?: Map<string, Buffer>
  ): Promise<TurnResult> {
    const conversationId = conversationOf(session)
    // the messages this turn answers: deleting one of them cancels the turn first (PRIV-ERASE-011)
    const inProgress = this.answering.get(conversationId) ?? new Set<string>()
    for (const entry of inbounds) inProgress.add(entry.id)
    this.answering.set(conversationId, inProgress)
    try {
      return await this.answerTurn(session, principal, inbounds, sink, signal, context, imageBytes)
    } finally {
      for (const entry of inbounds) inProgress.delete(entry.id)
      if (!inProgress.size && this.answering.get(conversationId) === inProgress) this.answering.delete(conversationId)
    }
  }

  private async answerTurn(
    session: Session,
    principal: Principal,
    inbounds: MessageEntry[],
    sink: TurnSink,
    signal: AbortSignal,
    context: TurnContext,
    imageBytes?: Map<string, Buffer>
  ): Promise<TurnResult> {
    for (const entry of inbounds) await sink.emit({ type: 'inbound', entry })
    // tools, the reply's language and what is recalled follow the latest message
    const inbound = inbounds[inbounds.length - 1] as MessageEntry
    const answered = new Set(inbounds.map((e) => e.id))
    const notYet = (await context.notYet?.()) ?? new Set<string>()
    // every entry of the turn names the messages it answers: deleting one of them deletes the turn (PRIV-ERASE-011)
    const inboundIds = inbounds.map((e) => e.id)

    const features = featuresOf(this.pack)
    const conversationId = conversationOf(session)
    const spaceId = await this.spaceOf(session, principal)
    // a space that does not allow this agent's model: no model call, no reply, no summary, no memory (SPACE-CONV-004)
    const refusal = await this.providerRefusal?.(session, principal, spaceId)
    if (refusal) return this.refuse(session, principal, inbounds, refusal, sink, context)
    const { messages: system, used } = await this.systemMessages(principal, session, spaceId)
    const grants = await this.approvals.activeGrants(principal.id)
    // the tools of the turn, taken once: they change only between turns (TOOL-AVAIL-006), in a fixed order, so that the
    // start of the request stays the same from one turn to the next (MEM-CTX-001)
    const turnTools = await this.toolsOf(principal, spaceId, grants)
    const tools = turnTools.map((t) => t.definition)
    const userTurn = await this.userTurn(inbounds, imageBytes)
    const topK = this.pack.memory?.retrieval?.topK ?? 8
    const assembled = await this.context.assemble({
      principal,
      session,
      system,
      tools,
      userTurn,
      exclude: new Set([...answered, ...notYet]),
      render: (entry) => this.entryToMessages(entry),
      retrievedReserve: features.semanticRecall ? topK * RECALLED_ITEM_TOKENS : 0,
      signal,
    })
    // what is retrieved for this turn comes after the window, with the message it answers (MEM-CTX-001, MEM-RET-007)
    const recalled = features.semanticRecall
      ? await this.memory.recall(
          principal,
          session,
          inbounds.map((e) => e.text).join('\n'),
          topK,
          [...assembled.window.map((e) => e.id), ...answered],
          spaceId
        )
      : []
    const messages: ChatMessage[] = [...assembled.messages, withRetrieved(userTurn, recallRecord(recalled))]

    /** the memories the turn changed: told as lines of the conversation once its reply is written (MEM-SPACE-005) */
    const changes: MemoryChange[] = []
    /** what the turn's calls read: the untrusted content (TOOL-CALL-008) and the sources (TOOL-PROV-002) */
    const toolState: TurnToolState = {
      conversationId,
      spaceId,
      ...(isPersonalSpace(spaceId) ? {} : { space: await this.spaceById?.(spaceId) }),
      untrustedRead: new Map(),
      sources: new Map(),
      newMessage: false,
      signal,
    }
    const turnSources = (): TurnSource[] => [...toolState.sources.values()]
    /** a tool ended the turn with a message of the code (INTX-AUTH-012) */
    let ended: EndTurnMessage | undefined
    const toolCtx: ToolContext = {
      principal,
      session,
      roles: principal.roles,
      logger: this.logger,
      language: inbound.language,
      inboundId: inbound.id,
      inboundIds,
      spaceId,
      memoryChanged: async (change) => {
        changes.push(change)
      },
      turnEnded: (message) => {
        ended ??= message
      },
    }

    let messageId = prefixedId('msg')
    let text = ''
    let started = false
    let cancelled = false
    /** the messages of the reply already written; the first sits where the reply does, the others where they end */
    const written: MessageEntry[] = []
    /** when the tools began, after the agent had said something */
    let pausedAt: number | undefined
    const save = async (completion: 'complete' | 'interrupted', body: string) => {
      const previous = written[written.length - 1]
      const entry = await this.memory.append({
        id: messageId,
        // after the messages it answers, and before one that arrived to wait while it was written (D63); a
        // message written after a pause is in its own place, after what happened meanwhile and after the
        // message before it
        initiatedAt: previous
          ? new Date(Math.max(Date.now(), Date.parse(previous.initiatedAt) + 1)).toISOString()
          : await context.replyAt?.(),
        sessionId: session.id,
        principalId: principal.id,
        role: 'agent',
        sourceType: 'text',
        text: body,
        completion,
        backingIdentity: principal.backingIdentity,
        reactionPolicy: this.reactionPolicies.get(session.id) ?? 'historize',
        // what it answers, and what of the person's memory it was given (PRIV-ERASE-011, MEM-SPACE-006)
        payload: {
          inboundId: inbound.id,
          inboundIds,
          usedMemories: used.memories,
          usedPreferences: used.preferences,
        },
        // the sources whose tools ran in the turn so far (TOOL-PROV-002)
        sources: turnSources(),
      })
      written.push(entry)
      return entry
    }
    const emitText = async (delta: string) => {
      let more = delta
      if (pausedAt !== undefined && started && text.trim()) {
        // after a card waited for the person, the reply goes on as a new message (TOOL-CALL-007, CORE-MSG-011)
        if (toolState.newMessage || Date.now() - pausedAt >= this.resumeAsNewMessageMs) {
          // the agent resumes after a pause: what it said before is a message, and this is another
          await sink.emit({ type: 'text-end', messageId })
          await save('complete', text.trim())
          messageId = prefixedId('msg')
          text = ''
          started = false
          more = delta.replace(/^\s+/, '')
        } else if (!/\n\s*$/.test(text)) {
          // the same message goes on, apart from what came before the tools
          more = `\n\n${delta.replace(/^\s+/, '')}`
        }
      }
      pausedAt = undefined
      toolState.newMessage = false
      if (!more) return
      if (!started) {
        started = true
        await sink.emit({ type: 'text-start', messageId })
      }
      text += more
      await sink.emit({ type: 'text-delta', messageId, delta: more })
    }

    const usage: TurnUsage = {
      calls: 0,
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      contextCached: 0,
    }
    try {
      for (let round = 0; round < this.maxToolRounds; round++) {
        if (signal.aborted) throw new TurnCancelled()
        const calls: ToolCallRequest[] = []
        let roundText = ''
        const estimate = estimateRequestTokens(messages, tools)
        let reported: Extract<ChatDelta, { type: 'usage' }> | undefined
        for await (const delta of this.llm.stream({
          messages,
          tools,
          temperature: this.pack.llm.temperature,
          maxOutputTokens: this.pack.llm.maxOutputTokens,
          signal,
          ...(this.pack.llm.cache?.enabled
            ? { cacheKey: conversationId, cacheTtl: this.pack.llm.cache.ttl ?? '5m' }
            : {}),
        })) {
          if (signal.aborted) throw new TurnCancelled()
          if (delta.type === 'text') {
            roundText += delta.text
            await emitText(delta.text)
          } else if (delta.type === 'tool_call') calls.push(delta.call)
          else if (delta.type === 'usage') reported = delta
        }
        await this.account(usage, reported, {
          conversationId,
          session,
          round,
          estimate: Math.ceil(estimate * assembled.factor),
        })
        if (round === 0 && reported) await this.context.calibrate(conversationId, reported.inputTokens, estimate)
        if (calls.length === 0) break
        messages.push({ role: 'assistant', content: roundText, toolCalls: calls })
        if (pausedAt === undefined) pausedAt = Date.now()
        // one at a time, in the model's order: while a card waits no other call starts (TOOL-CALL-007)
        for (const call of calls) {
          if (signal.aborted) throw new TurnCancelled()
          const result = await this.gateOf().execute(call, turnTools, toolState, {
            session,
            principal,
            inbound,
            toolCtx,
            sink,
          })
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result })
        }
        // the code takes the conversation over: no model call after it in this turn (INTX-AUTH-012)
        if (ended) break
      }
    } catch (error) {
      if (error instanceof TurnCancelled || signal.aborted) cancelled = true
      else {
        this.logger.error({ err: error, sessionId: session.id }, 'turn failed')
        const apology = text ? '' : 'Something went wrong on my side. Please try again.'
        if (apology) await emitText(apology)
      }
    }
    if (started) await sink.emit({ type: 'text-end', messageId })

    // a reply that said nothing after its pause is the messages before it, and no empty one is added; a turn a tool ended
    // ends with the code's message, and with no empty message of the model before it
    let reply =
      text.trim() || (!written.length && !ended)
        ? await save(
            cancelled ? 'interrupted' : 'complete',
            text.trim() || (cancelled ? '(stopped before any text)' : '(no reply)')
          )
        : (written[written.length - 1] as MessageEntry | undefined)
    if (ended)
      reply = await this.codeMessage(session, principal, ended, sink, { after: reply?.initiatedAt, inboundIds })
    if (!reply) throw new Error('a turn ended with no message')
    // every message of the reply records the sources of its turn, those written before its tools ran included
    // (TOOL-PROV-002)
    const sources = turnSources()
    if (sources.length)
      for (const message of written)
        if ((message.sources?.length ?? 0) !== sources.length) {
          message.sources = sources
          await this.memory.rewrite(message)
        }
    // the turn keeps its usage with its reply (LLM-USAGE-002), and the conversation its figure (LLM-USAGE-003)
    if (usage.calls > 0) {
      reply.payload = { ...(reply.payload ?? {}), usage }
      await this.memory.rewrite(reply)
      await this.context.setFigure(conversationId, {
        used: usage.contextTokens,
        cached: usage.contextCached,
        max: this.context.budget,
        at: new Date().toISOString(),
      })
    }
    // a memory the turn changed is a line of the conversation, after the reply (MEM-SPACE-005, PROF-HIST-012)
    await this.recordMemoryChanges(session, principal, changes, sink, {
      after: written[written.length - 1]?.initiatedAt,
      inboundIds,
    })
    this.reactionPolicies.delete(session.id)
    this.stats.emit('message-out', 1, { channel: session.channelType, cancelled: String(cancelled) })
    return { inbound, reply, replies: written, cancelled, inbounds }
  }

  /**
   * The message the code ends a turn with (INTX-AUTH-012): an `auth-challenge` entry that names the messages of the turn,
   * streamed as its last message. The model never reads it (MEM-RET-006).
   */
  private async codeMessage(
    session: Session,
    principal: Principal,
    message: EndTurnMessage,
    sink: TurnSink,
    place: { after?: string; inboundIds: string[] }
  ): Promise<MessageEntry> {
    const id = prefixedId('msg')
    await sink.emit({ type: 'text-start', messageId: id })
    await sink.emit({ type: 'text-delta', messageId: id, delta: message.text })
    await sink.emit({ type: 'text-end', messageId: id })
    const at = place.after ? Math.max(Date.now(), Date.parse(place.after) + 1) : Date.now()
    return this.memory.append({
      id,
      initiatedAt: new Date(at).toISOString(),
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'auth-challenge',
      text: message.text,
      backingIdentity: principal.backingIdentity,
      payload: {
        ...(message.payload ?? {}),
        inboundId: place.inboundIds.at(-1),
        inboundIds: place.inboundIds,
      },
    })
  }

  /**
   * The turn of a space whose rules do not allow the model this agent uses (SPACE-CONV-004, PROF-RUN-014): the person's
   * message is kept, and the code answers it with a `refusal` entry, which names the messages it answers as a reply
   * does, so that deleting the message takes it too.
   */
  private async refuse(
    session: Session,
    principal: Principal,
    inbounds: MessageEntry[],
    text: string,
    sink: TurnSink,
    context: TurnContext
  ): Promise<TurnResult> {
    const inbound = inbounds[inbounds.length - 1] as MessageEntry
    const messageId = prefixedId('msg')
    await sink.emit({ type: 'text-start', messageId })
    await sink.emit({ type: 'text-delta', messageId, delta: text })
    await sink.emit({ type: 'text-end', messageId })
    const reply = await this.memory.append({
      id: messageId,
      initiatedAt: await context.replyAt?.(),
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'refusal',
      text,
      backingIdentity: principal.backingIdentity,
      payload: {
        kind: 'space-rules',
        inboundId: inbound.id,
        inboundIds: inbounds.map((e) => e.id),
        usedMemories: [],
        usedPreferences: [],
      },
    })
    this.logger.info(
      { sessionId: session.id, conversationId: reply.conversationId },
      'turn refused by the rules of its space'
    )
    this.stats.emit('message-out', 1, { channel: session.channelType, cancelled: 'false', refused: 'space-rules' })
    return { inbound, reply, replies: [reply], cancelled: false, inbounds }
  }

  /**
   * A memory the agent added, changed or removed is a line of the conversation (MEM-SPACE-005): an entry (`state-update`,
   * `{ kind: 'memory', memoryId, spaceId, action }`, never the memory's content), told to the conversation's devices as
   * CUSTOM `ayni.memory.updated`. It names the messages of its turn: their deletion takes it with them.
   */
  private async recordMemoryChanges(
    session: Session,
    principal: Principal,
    changes: MemoryChange[],
    sink: TurnSink,
    place: { after?: string; inboundIds?: string[] }
  ): Promise<void> {
    let at = place.after ? Date.parse(place.after) : Date.now()
    for (const change of changes) {
      at = Math.max(Date.now(), at + 1)
      const entry = await this.memory.append({
        initiatedAt: new Date(at).toISOString(),
        sessionId: session.id,
        principalId: principal.id,
        role: 'agent',
        sourceType: 'state-update',
        text: `A memory was ${change.action}`,
        backingIdentity: principal.backingIdentity,
        payload: {
          kind: 'memory',
          memoryId: change.memoryId,
          spaceId: change.spaceId,
          action: change.action,
          ...(place.inboundIds?.length ? { inboundId: place.inboundIds.at(-1), inboundIds: place.inboundIds } : {}),
        },
      })
      await sink.emit({
        type: 'custom',
        name: 'ayni.memory.updated',
        value: {
          conversationId: entry.conversationId,
          entryId: entry.id,
          memoryId: change.memoryId,
          spaceId: change.spaceId,
          action: change.action,
        },
      })
    }
    // a line placed a millisecond after the reply may be ahead of the clock: what is recorded next must come after it
    const ahead = at - Date.now() + 1
    if (changes.length && ahead > 0) await new Promise((resolve) => setTimeout(resolve, ahead))
  }

  /** One model call: added to the turn, logged, counted (LLM-USAGE-001/002, PLAT-STATS-004). */
  private async account(
    usage: TurnUsage,
    reported: Extract<ChatDelta, { type: 'usage' }> | undefined,
    call: { conversationId: string; session: Session; round: number; estimate: number }
  ): Promise<void> {
    const counts = {
      inputTokens: reported?.inputTokens ?? 0,
      cachedTokens: reported?.cachedTokens ?? 0,
      cacheWriteTokens: reported?.cacheWriteTokens ?? 0,
      outputTokens: reported?.outputTokens ?? 0,
    }
    this.logger.info(
      {
        model: this.llm.id,
        conversationId: call.conversationId,
        sessionId: call.session.id,
        round: call.round,
        ...counts,
        estimatedTokens: call.estimate,
        reported: !!reported,
      },
      'model call'
    )
    if (!reported) return
    usage.calls++
    usage.inputTokens += counts.inputTokens
    usage.cachedTokens += counts.cachedTokens
    usage.cacheWriteTokens += counts.cacheWriteTokens
    usage.outputTokens += counts.outputTokens
    usage.contextTokens = counts.inputTokens
    usage.contextCached = counts.cachedTokens
    const dims = {
      model: this.llm.id,
      agent: this.pack.metadata.id,
      conversation: call.conversationId,
      session: call.session.id,
    }
    this.stats.emit('llm-input', counts.inputTokens, dims)
    this.stats.emit('llm-cached', counts.cachedTokens, dims)
    this.stats.emit('llm-cache-write', counts.cacheWriteTokens, dims)
    this.stats.emit('llm-output', counts.outputTokens, dims)
  }

  private gateOf(): ToolGate {
    if (!this.gate) throw new Error('the tool gate is not wired')
    return this.gate
  }

  /** The tools of a turn in a space (RBAC-FILTER-004): through the gate when it is wired. */
  private async toolsOf(
    principal: Principal,
    spaceId: string,
    grants: Awaited<ReturnType<ApprovalService['activeGrants']>>
  ): Promise<TurnTool[]> {
    return this.gateOf().toolsFor(principal, spaceId, grants)
  }

  /** Runs a tool directly (contextual-menu tool items) with the same gates as a call of the model. */
  public async invokeTool(
    name: string,
    args: Record<string, unknown>,
    session: Session,
    principal: Principal,
    sink: TurnSink
  ): Promise<string> {
    const grants = await this.approvals.activeGrants(principal.id)
    const spaceId = await this.spaceOf(session, principal)
    const tools = await this.toolsOf(principal, spaceId, grants)
    const changes: MemoryChange[] = []
    const ctx: ToolContext = {
      principal,
      session,
      roles: principal.roles,
      logger: this.logger,
      language: this.pack.language.agent,
      spaceId,
      memoryChanged: async (change) => {
        changes.push(change)
      },
    }
    const state: TurnToolState = {
      conversationId: conversationOf(session),
      spaceId,
      ...(isPersonalSpace(spaceId) ? {} : { space: await this.spaceById?.(spaceId) }),
      untrustedRead: new Map(),
      sources: new Map(),
      newMessage: false,
      signal: new AbortController().signal,
    }
    const call = { id: prefixedId('call'), name, arguments: args }
    const result = await this.gateOf().execute(call, tools, state, { session, principal, toolCtx: ctx, sink })
    await this.recordMemoryChanges(session, principal, changes, sink, { after: nowIso() })
    return result
  }
}

/** A reply carries the quoted message as context, in the user's voice (INTX-REPLY-001). */
function withReplyContext(entry: MessageEntry): string {
  const r = entry.payload?.replyTo as { text?: string; role?: string; media?: string; about?: string } | undefined
  // a media message with no words of its own is told by what it holds (its description, its file's name)
  const quoted = r?.text || r?.about
  if (!quoted) return entry.text
  const what = r?.media ? { image: 'picture', voice: 'voice note', video: 'video', file: 'file' }[r.media] : 'message'
  const who = r?.role === 'assistant' ? `your ${what}` : `my earlier ${what}`
  return `[replying to ${who}: "${quoted}"]\n${entry.text}`
}
