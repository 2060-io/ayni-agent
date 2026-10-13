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

export interface TurnSink {
  emit(event: TurnEvent): Promise<void> | void
}

export interface TurnInput {
  entry: NewEntry
  /** bytes of image attachments for multimodal models, keyed by attachment id (never persisted) */
  imageBytes?: Map<string, Buffer>
}

export interface TurnResult {
  inbound: MessageEntry
  reply: MessageEntry
  cancelled: boolean
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
    const display = principal.identityAttributes.userName
      ? `The person is ${principal.identityAttributes.userName}`
      : 'The person is authenticated'
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
    const text = withReplyContext(entry)
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

  // ---- the turn -------------------------------------------------------------------------------

  public async run(
    session: Session,
    principal: Principal,
    input: TurnInput,
    sink: TurnSink,
    signal: AbortSignal
  ): Promise<TurnResult> {
    const liveness = await this.principals.ensureLive(principal)
    if (!liveness.ok && liveness.reason !== 'unavailable') {
      await this.hooks.onCredentialInvalid(principal)
      throw new Error('identity credential is no longer valid')
    }
    const inbound = await this.memory.append(input.entry)
    this.stats.emit('message-in', 1, { channel: session.channelType, sourceType: inbound.sourceType })
    await sink.emit({ type: 'inbound', entry: inbound })

    const features = featuresOf(this.pack)
    const budget = this.pack.memory?.contextWindowTokens ?? 12000
    const system = await this.systemMessages(principal, session)
    const systemTokens = system.reduce((n, m) => n + estimateTokens(m.role === 'system' ? m.content : ''), 0)
    const windowEntries = (
      await this.memory.window(principal, session, Math.max(1000, budget - systemTokens - 1500))
    ).filter((e) => e.id !== inbound.id)
    const recalled = features.semanticRecall
      ? await this.memory.recall(principal, session, inbound.text, this.pack.memory?.retrieval?.topK ?? 8)
      : []
    const messages: ChatMessage[] = [...system]
    if (recalled.length) {
      messages.push({
        role: 'system',
        content: `Relevant earlier messages (other conversations, already authorized):\n${recalled.map((e) => `- (${e.createdAt.slice(0, 10)}, ${e.role}) ${e.text.slice(0, 300)}`).join('\n')}`,
      })
    }
    for (const e of windowEntries) messages.push(...this.entryToMessages(e))
    messages.push(await this.userMessage(inbound, input.imageBytes))

    const grants = await this.approvals.activeGrants(principal.id)
    const visible = await this.registry.visible(principal.roles, grants)
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
    return { inbound, reply, cancelled }
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
    const visible = await this.registry.visible(principal.roles, grants)
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
        payload: { challengeId: record?.id, type: policy.authChallenge.type, outcome, toolName: rawName },
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

/** A reply carries the quoted message as context, in the user's voice (INTX-STATE-004). */
function withReplyContext(entry: MessageEntry): string {
  const r = entry.payload?.replyTo as { text?: string; role?: string } | undefined
  if (!r?.text) return entry.text
  const who = r.role === 'assistant' ? 'your message' : 'my earlier message'
  return `[replying to ${who}: "${r.text}"]\n${entry.text}`
}
