/**
 * Deterministic stub model for development and tests: echoes the last user text word by word;
 * a user text of the form `/call <tool> <json>` triggers one tool call, and the stub then summarizes
 * the tool result; words before `/call` are said first, as a model that announces what it is about to do.
 * A summary request (the summarizer's instruction) is answered with the lines it was given, shortened.
 * Usage is reported as a provider does (LLM-USAGE-001): the input is the estimate of the whole request, and with a
 * cache key the part of it that repeats the start of the key's previous request is "served from cache".
 * No network, no key.
 */
import { SUMMARY_INSTRUCTION_HEAD } from '../memory/summary.js'
import { estimateRequestTokens, estimateTokens } from '../util/tokens.js'
import type { ChatDelta, ChatModel, ChatRequest } from './types.js'

/** What the stub's cache keeps, as Kimi does: the start of the requests it saw, by cache key. */
const MIN_CACHED_CHARS = 1024

export class StubChatModel implements ChatModel {
  public readonly id = 'stub/echo'
  public readonly multimodal = false
  private readonly prefixes = new Map<string, string>()
  /** every request it received, for the tests that read what the model was given */
  public readonly requests: ChatRequest[] = []

  private usage(req: ChatRequest, output: string): Extract<ChatDelta, { type: 'usage' }> {
    const input = estimateRequestTokens(req.messages, req.tools)
    let cached = 0
    if (req.cacheKey) {
      const wire = JSON.stringify({ tools: req.tools ?? [], messages: req.messages })
      const previous = this.prefixes.get(req.cacheKey) ?? ''
      let common = 0
      const max = Math.min(previous.length, wire.length)
      while (common < max && previous.charCodeAt(common) === wire.charCodeAt(common)) common++
      cached = common >= MIN_CACHED_CHARS ? Math.min(input, estimateTokens(wire.slice(0, common))) : 0
      this.prefixes.set(req.cacheKey, wire)
    }
    return {
      type: 'usage',
      inputTokens: input,
      outputTokens: estimateTokens(output),
      cachedTokens: cached,
      cacheWriteTokens: req.cacheKey ? input - cached : 0,
    }
  }

  public async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
    this.requests.push(req)
    if (this.requests.length > 50) this.requests.shift()
    const instruction = req.messages.find((m) => m.role === 'system')
    if (instruction?.role === 'system' && instruction.content.startsWith(SUMMARY_INSTRUCTION_HEAD)) {
      const asked = req.messages[req.messages.length - 1]
      const body = asked && typeof asked.content === 'string' ? asked.content : ''
      const [previous = '', added = ''] = body.split('\n\nMessages to add, oldest first:\n')
      const kept = previous.replace(/^Previous summary:\n/, '').trim()
      const lines = added
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 160))
      const summary = [kept && kept !== '(none)' ? kept : '', ...lines].filter(Boolean).join(' | ')
      yield { type: 'text', text: summary }
      yield this.usage(req, summary)
      return
    }
    const last = [...req.messages].reverse().find((m) => m.role === 'user' || m.role === 'tool')
    if (!last) return
    if (last.role === 'tool') {
      const summary = `Tool ${last.name} answered: ${last.content.slice(0, 400)}`
      for (const word of summary.split(' ')) {
        if (req.signal?.aborted) return
        yield { type: 'text', text: `${word} ` }
      }
      yield this.usage(req, summary)
      return
    }
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ')
    // what retrieval added before the person's words is not part of what they said
    const said = text.replace(/^\[system record[\s\S]*?\]\n\n/, '')
    const asked = /^(.*?)\/call\s+(\S+)\s*(\{.*\})?\s*$/s.exec(said.trim())
    const call = asked ? [asked[0], asked[2], asked[3]] : null
    if (asked && call && req.tools?.some((t) => t.name === call[1])) {
      let args: Record<string, unknown> = {}
      try {
        args = call[2] ? (JSON.parse(call[2]) as Record<string, unknown>) : {}
      } catch {
        args = {}
      }
      if (asked[1]?.trim()) yield { type: 'text', text: asked[1].trim() }
      yield { type: 'tool_call', call: { id: `call_${Date.now()}`, name: call[1] as string, arguments: args } }
      yield this.usage(req, asked[1] ?? '')
      return
    }
    if (call) {
      const refusal = `I cannot use "${call[1]}" here.`
      yield { type: 'text', text: refusal }
      yield this.usage(req, refusal)
      return
    }
    const reply = `You said: ${said}`
    for (const word of reply.split(' ')) {
      if (req.signal?.aborted) return
      await new Promise((r) => setTimeout(r, 15))
      yield { type: 'text', text: `${word} ` }
    }
    yield this.usage(req, reply)
  }
}
