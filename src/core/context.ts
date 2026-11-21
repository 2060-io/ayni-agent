/**
 * The context of a turn (D74, D75, MEM-CTX): the window, which moves in steps, and the conversation summary, which
 * covers everything older than the window; the estimate, scaled by what the provider last reported; the per-
 * conversation state kept for them (the window's first entry, the sealed summary, the scale, the context figure).
 */
import type { AgentPack } from '../config/packTypes.js'
import { callLogFields } from '../llm/timing.js'
import type { ChatMessage, ChatModel, ToolDefinition } from '../llm/types.js'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import type { MemoryService } from '../memory/service.js'
import { summarize } from '../memory/summary.js'
import type { StatsSink } from '../platform/stats.js'
import type { EntryKey, KvRepo } from '../store/types.js'
import type { Logger } from '../util/logger.js'
import { estimateMessageTokens, estimateRequestTokens, estimateToolTokens } from '../util/tokens.js'
import { conversationOf } from './conversationOf.js'
import type { MessageEntry, Principal, Session } from './types.js'

/** The context figure of a conversation (LLM-USAGE-003, profile `state.ayni.context`). */
export interface ContextFigure {
  used: number
  cached: number
  max: number
  at: string
}

interface SummaryContent {
  text: string
  /** the summary covers every entry before this place */
  until: EntryKey
  count: number
  from?: string
  to?: string
}

export interface ContextInput {
  principal: Principal
  session: Session
  /** persona, platform add-on, who the person is (MEM-CTX-001, parts 1 to 3) */
  system: ChatMessage[]
  tools: ToolDefinition[]
  /** what the turn answers, with what the agent keeps of the person and without what is retrieved for it (MEM-CTX-007) */
  userTurn: ChatMessage
  /** entries that are not the window's: the messages the turn answers, the ones that wait their turn */
  exclude: ReadonlySet<string>
  /** what the model receives for an entry */
  render: (entry: MessageEntry) => ChatMessage[]
  /** what retrieval may add to the turn, kept free in the budget */
  retrievedReserve: number
  signal?: AbortSignal
}

export interface AssembledContext {
  /** system parts, the summary record, the window; the caller adds the turn with what it retrieved */
  messages: ChatMessage[]
  window: MessageEntry[]
  /** the scale applied to estimates, from the conversation's last reported input */
  factor: number
  /** the window moved by a step at this turn */
  stepped: boolean
}

const key = (e: { initiatedAt: string; id: string }): EntryKey => ({ initiatedAt: e.initiatedAt, id: e.id })
const before = (a: EntryKey, b: EntryKey) =>
  Date.parse(a.initiatedAt) !== Date.parse(b.initiatedAt)
    ? Date.parse(a.initiatedAt) < Date.parse(b.initiatedAt)
    : a.id < b.id

/** How the summary is told to the model: a record of the system, after the system parts (MEM-CTX-004). */
export function summaryRecord(summary: { text: string; count: number; from?: string; to?: string }): string {
  const span = summary.from && summary.to ? `, ${summary.from.slice(0, 10)} to ${summary.to.slice(0, 10)}` : ''
  return `[system record, written by the system, not by the person and not by you: summary of the earlier part of this conversation (${summary.count} messages${span}), which you no longer see:\n${summary.text}]`
}

/** One line of a dropped entry, as the summarizer reads it. */
function summaryLine(entry: MessageEntry, render: (e: MessageEntry) => ChatMessage[]): string {
  const at = entry.initiatedAt.slice(0, 16).replace('T', ' ')
  const parts = render(entry).map((m) => {
    if (m.role === 'tool') return `tool ${m.name} answered: ${m.content.slice(0, 600)}`
    if (m.role === 'assistant' && m.toolCalls?.length)
      return `agent used ${m.toolCalls.map((c) => `${c.name} ${JSON.stringify(c.arguments)}`).join(', ')}`
    const text =
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ')
    return `${m.role === 'assistant' ? 'agent' : entry.role === 'principal' ? 'person' : 'system'}: ${text}`
  })
  return parts.length ? `[${at}] ${parts.join(' / ')}` : ''
}

export class ContextAssembler {
  public constructor(
    private readonly pack: AgentPack,
    private readonly llm: ChatModel,
    private readonly memory: MemoryService,
    private readonly kv: KvRepo,
    private readonly crypto: EntryCrypto,
    private readonly stats: StatsSink,
    private readonly logger: Logger
  ) {}

  public get budget(): number {
    return this.pack.memory?.contextWindowTokens ?? 12000
  }

  private get trigger(): number {
    return this.pack.memory?.summarization?.triggerTokens ?? this.budget
  }

  private get keepRatio(): number {
    return this.pack.memory?.window?.keepRatio ?? 0.6
  }

  private get maxEntries(): number {
    return this.pack.memory?.window?.maxEntries ?? 400
  }

  private get summarizing(): boolean {
    return this.pack.memory?.summarization?.enabled !== false
  }

  // ---- the per-conversation state ------------------------------------------------------------------

  public async figure(conversationId: string): Promise<ContextFigure | undefined> {
    const raw = await this.kv.get(`context:${conversationId}`)
    return raw ? (JSON.parse(raw) as ContextFigure) : undefined
  }

  public async setFigure(conversationId: string, figure: ContextFigure): Promise<void> {
    await this.kv.set(`context:${conversationId}`, JSON.stringify(figure))
  }

  /** The scale of the estimates: the provider's last reported input over its estimate, within bounds (MEM-CTX-002). */
  public async factor(conversationId: string): Promise<number> {
    const raw = await this.kv.get(`calibration:${conversationId}`)
    const value = raw ? Number(raw) : 1
    return Number.isFinite(value) ? Math.min(3, Math.max(0.5, value)) : 1
  }

  public async calibrate(conversationId: string, reported: number, estimated: number): Promise<void> {
    if (reported > 0 && estimated > 0) await this.kv.set(`calibration:${conversationId}`, String(reported / estimated))
  }

  private async windowStart(conversationId: string): Promise<EntryKey | undefined> {
    const raw = await this.kv.get(`window:${conversationId}`)
    return raw ? (JSON.parse(raw) as { start: EntryKey }).start : undefined
  }

  private async summary(conversationId: string): Promise<SummaryContent | undefined> {
    const raw = await this.kv.get(`summary:${conversationId}`)
    if (!raw) return undefined
    try {
      const sealed = JSON.parse(raw) as { keyRef: string; cipher: string }
      return openJson<SummaryContent>(this.crypto, sealed.keyRef, Buffer.from(sealed.cipher, 'base64'))
    } catch (error) {
      this.logger.warn({ err: error, conversationId }, 'conversation summary unreadable: it is made again')
      return undefined
    }
  }

  /** The summary is sealed under a key of its own, never an entry (MEM-TIER-004). */
  private async saveSummary(conversationId: string, content: SummaryContent): Promise<void> {
    const keyRef = this.crypto.newWrappedKey()
    const { cipher } = sealJson(this.crypto, keyRef, content)
    await this.kv.set(`summary:${conversationId}`, JSON.stringify({ keyRef, cipher: cipher.toString('base64') }))
  }

  /** An entry of the conversation was erased: its summary goes, and the next turn makes it again (PRIV-ERASE-005). */
  public async discardSummary(conversationId: string): Promise<void> {
    await this.kv.delete(`summary:${conversationId}`)
  }

  // ---- the context -----------------------------------------------------------------------------------

  public async assemble(input: ContextInput): Promise<AssembledContext> {
    const { principal, session } = input
    const conversationId = conversationOf(session)
    const factor = await this.factor(conversationId)
    let start = await this.windowStart(conversationId)
    let summary = this.summarizing ? await this.summary(conversationId) : undefined
    const cost = (messages: ChatMessage[]) =>
      Math.ceil(messages.reduce((n, m) => n + estimateMessageTokens(m), 0) * factor)

    // the window: the entries at or after its first, newest first, one more than it reads to know there are more
    const read = await this.memory.conversationEntries(principal, session, {
      from: start,
      order: 'desc',
      limit: this.maxEntries + 1,
    })
    const overflow = read.length > this.maxEntries
    let window = read
      .slice(0, this.maxEntries)
      .filter((e) => !input.exclude.has(e.id))
      .reverse()
    const rendered = new Map(window.map((e) => [e.id, input.render(e)]))
    const summaryCost = () => (summary ? cost([{ role: 'user', content: summaryRecord(summary) }]) : 0)
    const fixed = () =>
      cost(input.system) +
      cost([input.userTurn]) +
      summaryCost() +
      Math.ceil((estimateToolTokens(input.tools) + input.retrievedReserve) * factor)
    const windowCost = (entries: MessageEntry[]) => entries.reduce((n, e) => n + cost(rendered.get(e.id) ?? []), 0)

    let stepped = false
    if (overflow || fixed() + windowCost(window) > this.trigger) {
      // a step (MEM-CTX-003): drop the oldest entries until the context fits the kept share of the budget
      const keep = this.keepRatio * this.budget
      const keepCount = Math.max(1, Math.floor(this.maxEntries * this.keepRatio))
      let kept = window
      while (kept.length > 1 && (fixed() + windowCost(kept) > keep || kept.length > keepCount)) kept = kept.slice(1)
      const first = kept[0] ?? read[0]
      if (first) {
        start = key(first)
        await this.kv.set(`window:${conversationId}`, JSON.stringify({ start }))
      }
      stepped = true
      this.logger.info(
        { conversationId, dropped: window.length - kept.length, kept: kept.length, overflow },
        'the window moved by a step'
      )
      window = kept
    }

    // the summary covers every entry before the window's first (MEM-CTX-004): what a step dropped, what an erasure
    // made it forget, what an earlier step could not summarize (MEM-CTX-005)
    if (this.summarizing && start && (!summary || before(summary.until, start))) {
      summary = await this.extendSummary(input, conversationId, summary, start)
    }

    const messages: ChatMessage[] = [...input.system]
    if (summary) messages.push({ role: 'user', content: summaryRecord(summary) })
    for (const entry of window) messages.push(...(rendered.get(entry.id) ?? []))
    await this.memory.logShown(principal, session, window)
    const total = estimateRequestTokens([...messages, input.userTurn], input.tools)
    if (total * factor > this.budget) {
      this.logger.warn(
        { conversationId, estimate: Math.ceil(total * factor), budget: this.budget },
        'the context exceeds the budget with the window at its smallest'
      )
    }
    return { messages, window, factor, stepped }
  }

  /** The previous summary and the entries it does not cover yet, before `start`, folded into one; kept as it was on failure. */
  private async extendSummary(
    input: ContextInput,
    conversationId: string,
    previous: SummaryContent | undefined,
    start: EntryKey
  ): Promise<SummaryContent | undefined> {
    const { principal, session } = input
    const entries: MessageEntry[] = []
    const seen = new Set<string>()
    let from = previous?.until
    for (;;) {
      const page = await this.memory.conversationEntries(principal, session, {
        from,
        until: start,
        order: 'asc',
        limit: 500,
      })
      const fresh = page.filter((e) => !seen.has(e.id))
      for (const e of fresh) seen.add(e.id)
      entries.push(...fresh)
      if (page.length < 500 || fresh.length === 0) break
      from = key(page[page.length - 1] as MessageEntry)
    }
    const lines = entries.map((e) => summaryLine(e, input.render)).filter(Boolean)
    if (!lines.length) return previous
    try {
      const max = this.pack.memory?.summarization?.maxSummaryTokens ?? 4000
      const chunkTokens = Math.max(1000, Math.floor(this.budget * 0.5))
      const { text, usage } = await summarize(this.llm, previous?.text, lines, {
        maxOutputTokens: max,
        chunkTokens,
        signal: input.signal,
        // one log line per call, whether it completes or not (LLM-USAGE-004)
        onCall: (measure) =>
          this.logger.info(
            { conversationId, sessionId: session.id, purpose: 'summary', ...callLogFields(measure) },
            'model call'
          ),
      })
      const dims = {
        model: this.llm.id,
        agent: this.pack.metadata.id,
        conversation: conversationId,
        session: session.id,
        purpose: 'summary',
      }
      this.stats.emit('llm-input', usage.inputTokens, dims)
      this.stats.emit('llm-cached', usage.cachedTokens, dims)
      this.stats.emit('llm-cache-write', usage.cacheWriteTokens, dims)
      this.stats.emit('llm-output', usage.outputTokens, dims)
      this.logger.info(
        { model: this.llm.id, conversationId, summarized: entries.length, ...usage },
        'conversation summary made'
      )
      await this.memory.logShown(principal, session, entries)
      const content: SummaryContent = {
        text,
        until: start,
        count: (previous?.count ?? 0) + entries.length,
        from: previous?.from ?? entries[0]?.initiatedAt,
        to: entries[entries.length - 1]?.initiatedAt ?? previous?.to,
      }
      await this.saveSummary(conversationId, content)
      return content
    } catch (error) {
      // MEM-CTX-005: the turn runs within the budget without the new summary; the next step tries again
      this.logger.error({ err: error, conversationId }, 'the conversation summary could not be made')
      return previous
    }
  }
}
