/**
 * The LLM turn (architecture 4, 10.2, 11.8, 12.3): context assembly from the window, working
 * memory, preferences and semantic recall; RBAC-filtered tools; approvals, liveness and auth
 * challenges around tool calls; cancellation that persists the partial reply as interrupted (D47).
 */
import type { AgentPack } from '../config/packTypes.js'
import { featuresOf } from '../config/packTypes.js'
import type { ChatMessage, ChatModel, ContentPart, ToolCallRequest } from '../llm/types.js'
import type { ObjectStore } from '../media/objectStore.js'
import type { MemoryService, NewEntry } from '../memory/service.js'
import type { StatsSink } from '../platform/stats.js'
import type { ApprovalService } from '../policy/approvals.js'
import type { ToolRegistry, VisibleTool } from '../tools/registry.js'
import type { ToolContext } from '../tools/types.js'
import { prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { estimateTokens } from '../util/tokens.js'
import type { ChallengeService } from './challenges.js'
import { nameForModel } from './evidence.js'
import type { PrincipalService } from './principals.js'
import { addonTokenCount, renderPromptAddon } from './promptAddon.js'
import type { ApprovalRecord, MessageEntry, Principal, ReactionPolicy, Session } from './types.js'

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
  reply?: MessageEntry
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

export class TurnCancelled extends Error {
  public constructor() {
    super('turn cancelled')
    this.name = 'TurnCancelled'
  }
}

export class Orchestrator {
  private readonly reactionPolicies = new Map<string, ReactionPolicy>()
  private readonly addon: string
  private readonly maxToolRounds = 8

  public constructor(
    private readonly pack: AgentPack,
    private readonly llm: ChatModel,
    private readonly memory: MemoryService,
    private readonly principals: PrincipalService,
    private readonly registry: ToolRegistry,
    private readonly approvals: ApprovalService,
    private readonly challenges: ChallengeService,
    private readonly objects: ObjectStore,
    private readonly stats: StatsSink,
    private readonly hooks: OrchestratorHooks,
    private readonly logger: Logger
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
      appLinkBase: pack.channels?.agui?.appLinkBase,
    })
    const tokens = addonTokenCount(this.addon)
    if (tokens > 500) logger.warn({ tokens }, 'system-prompt add-on exceeds its 500-token target (CORE-PROMPT-004)')
  }

  public setReactionPolicy(sessionId: string, policy: ReactionPolicy): void {
    this.reactionPolicies.set(sessionId, policy)
  }

  // ---- context assembly -----------------------------------------------------------------------

  private async systemMessages(principal: Principal, session: Session): Promise<ChatMessage[]> {
    const features = featuresOf(this.pack)
    const parts: string[] = []
    const prefs = features.preferences ? await this.memory.preferences(principal) : []
    if (prefs.length) parts.push(`Preferences of the person: ${prefs.map((p) => `${p.key}=${p.value}`).join('; ')}`)
    if (features.workingMemory) {
      const notes = await this.memory.notes(principal)
      if (notes.length)
        parts.push(
          `Working memory notes:\n${notes.map((n) => `- [${n.id}]${n.needsRevision ? ' (needs revision)' : ''} ${n.content}`).join('\n')}`
        )
    }
    // a person identified by a credential is named only when the pack lets the model read the name (D68)
    const name = nameForModel(this.pack, principal)
    const display = name ? `The person is ${name}` : 'The person is authenticated'
    const backing = principal.backingIdentity?.name
      ? `, backed by ${principal.backingIdentity.name} (${principal.backingRelation})`
      : ''
    parts.push(`${display}${backing}. Roles: ${principal.roles.join(', ') || 'none'}. Channel: ${session.channelType}.`)
    return [
      { role: 'system', content: this.pack.persona.systemPrompt },
      { role: 'system', content: this.addon },
      { role: 'system', content: parts.join('\n\n') },
    ]
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
    // arrives as its own turn); approvals and challenges become short notes in the agent's voice
    if (entry.sourceType === 'state-update' || entry.sourceType === 'reaction') return []
    if (
      entry.sourceType === 'approval' ||
      entry.sourceType === 'refusal' ||
      entry.sourceType === 'auth-challenge' ||
      entry.sourceType === 'flow' ||
      entry.role === 'system'
    ) {
      return [{ role: 'assistant', content: `[note] ${entry.text}` }]
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
    for (const entry of inbounds) await sink.emit({ type: 'inbound', entry })
    // tools, the reply's language and what is recalled follow the latest message
    const inbound = inbounds[inbounds.length - 1] as MessageEntry
    const answered = new Set(inbounds.map((e) => e.id))
    const notYet = (await context.notYet?.()) ?? new Set<string>()

    const features = featuresOf(this.pack)
    const budget = this.pack.memory?.contextWindowTokens ?? 12000
    const system = await this.systemMessages(principal, session)
    const systemTokens = system.reduce((n, m) => n + estimateTokens(m.role === 'system' ? m.content : ''), 0)
    const windowEntries = (
      await this.memory.window(principal, session, Math.max(1000, budget - systemTokens - 1500))
    ).filter((e) => !answered.has(e.id) && !notYet.has(e.id))
    const recalled = features.semanticRecall
      ? await this.memory.recall(
          principal,
          session,
          inbounds.map((e) => e.text).join('\n'),
          this.pack.memory?.retrieval?.topK ?? 8
        )
      : []
    const messages: ChatMessage[] = [...system]
    if (recalled.length) {
      messages.push({
        role: 'system',
        content: `Relevant earlier messages (other conversations, already authorized):\n${recalled.map((e) => `- (${e.createdAt.slice(0, 10)}, ${e.role}) ${e.text.slice(0, 300)}`).join('\n')}`,
      })
    }
    for (const e of windowEntries) messages.push(...this.entryToMessages(e))
    messages.push(await this.userTurn(inbounds, imageBytes))

    const grants = await this.approvals.activeGrants(principal.id)
    const visible = await this.registry.visible(principal.roles, grants, principal)
    const tools = this.registry.toDefinitions(visible)
    const toolCtx: ToolContext = {
      principal,
      session,
      roles: principal.roles,
      logger: this.logger,
      language: inbound.language,
    }

    const messageId = prefixedId('msg')
    let text = ''
    let started = false
    let cancelled = false
    const emitText = async (delta: string) => {
      if (!started) {
        started = true
        await sink.emit({ type: 'text-start', messageId })
      }
      text += delta
      await sink.emit({ type: 'text-delta', messageId, delta })
    }

    try {
      for (let round = 0; round < this.maxToolRounds; round++) {
        if (signal.aborted) throw new TurnCancelled()
        const calls: ToolCallRequest[] = []
        let roundText = ''
        for await (const delta of this.llm.stream({
          messages,
          tools,
          temperature: this.pack.llm.temperature,
          maxOutputTokens: this.pack.llm.maxOutputTokens,
          signal,
        })) {
          if (signal.aborted) throw new TurnCancelled()
          if (delta.type === 'text') {
            roundText += delta.text
            await emitText(delta.text)
          } else if (delta.type === 'tool_call') calls.push(delta.call)
          else if (delta.type === 'usage')
            this.stats.emit('llm-tokens', delta.inputTokens + delta.outputTokens, { model: this.llm.id })
        }
        if (calls.length === 0) break
        messages.push({ role: 'assistant', content: roundText, toolCalls: calls })
        for (const call of calls) {
          if (signal.aborted) throw new TurnCancelled()
          const result = await this.executeToolCall(call, visible, session, principal, inbound, toolCtx, sink)
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result })
        }
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

    const reply = await this.memory.append({
      id: messageId,
      // after the messages it answers, and before one that arrived to wait while it was written (D63)
      initiatedAt: await context.replyAt?.(),
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'text',
      text: text.trim() || (cancelled ? '(stopped before any text)' : '(no reply)'),
      completion: cancelled ? 'interrupted' : 'complete',
      backingIdentity: principal.backingIdentity,
      reactionPolicy: this.reactionPolicies.get(session.id) ?? 'historize',
    })
    this.reactionPolicies.delete(session.id)
    this.stats.emit('message-out', 1, { channel: session.channelType, cancelled: String(cancelled) })
    return { inbound, reply, cancelled, inbounds }
  }

  /** Runs a tool directly (contextual-menu tool items, approved actions) with the same gates. */
  public async invokeTool(
    name: string,
    args: Record<string, unknown>,
    session: Session,
    principal: Principal,
    sink: TurnSink,
    skipApproval = false
  ): Promise<string> {
    const grants = await this.approvals.activeGrants(principal.id)
    const visible = await this.registry.visible(principal.roles, grants, principal)
    const ctx: ToolContext = {
      principal,
      session,
      roles: principal.roles,
      logger: this.logger,
      language: this.pack.language.agent,
    }
    const call = { id: prefixedId('call'), name, arguments: args }
    return this.executeToolCall(call, visible, session, principal, undefined, ctx, sink, skipApproval)
  }

  private async executeToolCall(
    call: ToolCallRequest,
    visible: VisibleTool[],
    session: Session,
    principal: Principal,
    inbound: MessageEntry | undefined,
    ctx: ToolContext,
    sink: TurnSink,
    skipApproval = false
  ): Promise<string> {
    const tool = visible.find((t) => t.spec.name === call.name)
    if (!tool) return `Tool ${call.name} is not available to this person.`
    const rawName = tool.spec.key.split(':').pop() ?? call.name
    const policy = this.pack.actions?.[rawName]

    // APPROVAL tier: per-use human approval unless the requester may self-approve (RBAC-TOOL-003, INTX-APPR-005)
    if (tool.resolution.tier === 'APPROVAL' && tool.resolution.approvalRule && !skipApproval) {
      const rule = tool.resolution.approvalRule
      if (!this.approvals.canSelfApprove(principal, rule)) {
        const record = await this.approvals.requestSensitivity({
          principal,
          role: principal.roles.find((r) => true) ?? '',
          originSessionId: session.id,
          toolName: rawName,
          serverName: tool.spec.serverName,
          args: call.arguments,
          rule,
        })
        const entry = await this.memory.append({
          sessionId: session.id,
          principalId: principal.id,
          role: 'system',
          sourceType: 'approval',
          text: `Approval requested for ${rawName} (${record.id})`,
          backingIdentity: principal.backingIdentity,
          payload: { approvalId: record.id, kind: record.kind, toolName: rawName, status: record.status },
        })
        await this.hooks.onApprovalPending(session, principal, record, entry)
        return `The action ${rawName} needs an approval by ${rule.approvers.join(' or ')}. The request ${record.id} is pending; the action runs automatically once approved. Tell the person.`
      }
    }

    // credential freshness (IDENT-LIVE-011, INTX-CRED-002)
    if (policy?.maxCredentialAge !== undefined) {
      const verdict = await this.principals.ensureLive(principal, policy.maxCredentialAge)
      if (!verdict.ok) {
        if (verdict.reason !== 'unavailable') await this.hooks.onCredentialInvalid(principal)
        return `The action ${rawName} was aborted: the person's identity credential could not be verified (${verdict.reason ?? 'invalid'}).`
      }
    }

    // auth challenge declared for the action (INTX-AUTH-002/003/006)
    if (policy?.authChallenge) {
      await sink.emit({ type: 'step-started', label: 'Waiting for your confirmation on your phone' })
      const { outcome, record } = await this.challenges.run({
        principal,
        originSession: session,
        toolName: rawName,
        policy: policy.authChallenge,
        purpose: tool.spec.stepLabel ?? rawName,
      })
      await sink.emit({ type: 'step-finished', label: 'Waiting for your confirmation on your phone' })
      await this.memory.append({
        sessionId: session.id,
        principalId: principal.id,
        role: 'system',
        sourceType: 'auth-challenge',
        text: `Identity check (${policy.authChallenge.type}) for ${rawName}: ${outcome}`,
        backingIdentity: principal.backingIdentity,
        payload: {
          challengeId: record?.id,
          type: policy.authChallenge.type,
          outcome,
          toolName: rawName,
          // served as a `confirm` flow: the flow card is the UI record, this note is for the model (D55)
          ...(typeof record?.details?.flowId === 'string' ? { flowId: record.details.flowId } : {}),
        },
      })
      if (outcome !== 'completed' && outcome !== 'degraded')
        return `The action ${rawName} did not run: the identity check ${outcome === 'failed' ? 'failed' : outcome === 'expired' ? 'timed out' : 'was not possible'}.`
    }

    const label = tool.spec.stepLabel ?? 'Working'
    await sink.emit({ type: 'step-started', label })
    let content: string
    let isError = false
    try {
      // a tool call already executing completes even if the turn is cancelled (D47): no run signal here
      const result = await tool.spec.invoke(call.arguments, ctx)
      content = result.content
      isError = result.isError === true
    } catch (error) {
      content = `tool failed: ${error instanceof Error ? error.message : String(error)}`
      isError = true
    }
    await sink.emit({ type: 'step-finished', label })
    this.stats.emit('tool-call', 1, { tool: rawName, error: String(isError) })
    await this.memory.append({
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'tool-call',
      text: `Used ${rawName}${isError ? ' (failed)' : ''}: ${content.slice(0, 200)}`,
      backingIdentity: principal.backingIdentity,
      payload: {
        name: call.name,
        server: tool.spec.serverName,
        arguments: call.arguments,
        result: content.slice(0, 20000),
        isError,
        inboundId: inbound?.id,
      },
    })
    return content.slice(0, 20000)
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
