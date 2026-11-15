/**
 * Deterministic stub model for development and tests: echoes the last user text word by word;
 * a user text of the form `/call <tool> <json>` triggers one tool call, and the stub then summarizes
 * the tool result; words before `/call` are said first, as a model that announces what it is about to do.
 * No network, no key.
 */
import type { ChatDelta, ChatModel, ChatRequest } from './types.js'

export class StubChatModel implements ChatModel {
  public readonly id = 'stub/echo'
  public readonly multimodal = false

  public async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user' || m.role === 'tool')
    if (!last) return
    if (last.role === 'tool') {
      const summary = `Tool ${last.name} answered: ${last.content.slice(0, 400)}`
      for (const word of summary.split(' ')) {
        if (req.signal?.aborted) return
        yield { type: 'text', text: `${word} ` }
      }
      yield { type: 'usage', inputTokens: 10, outputTokens: 10 }
      return
    }
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ')
    const asked = /^(.*?)\/call\s+(\S+)\s*(\{.*\})?\s*$/s.exec(text.trim())
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
      return
    }
    if (call) {
      yield { type: 'text', text: `I cannot use "${call[1]}" here.` }
      return
    }
    const reply = `You said: ${text}`
    for (const word of reply.split(' ')) {
      if (req.signal?.aborted) return
      await new Promise((r) => setTimeout(r, 15))
      yield { type: 'text', text: `${word} ` }
    }
    yield { type: 'usage', inputTokens: Math.ceil(text.length / 4), outputTokens: Math.ceil(reply.length / 4) }
  }
}
