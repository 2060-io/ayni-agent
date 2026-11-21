/** Native Anthropic adapter (LLM-PROV-001). */
import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import type { LlmConfig } from '../config/packTypes.js'
import {
  type ChatDelta,
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  LlmError,
  parseArguments,
} from './types.js'

/** The Messages API request of a request: the system parts joined, a tool's result in the user turn after the call. */
export function toAnthropic(
  messages: ChatMessage[],
  multimodal: boolean
): { system: string; messages: MessageParam[] } {
  const system = messages
    .filter((m): m is Extract<ChatMessage, { role: 'system' }> => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const out: MessageParam[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ role: 'user', content: m.content })
      else {
        out.push({
          role: 'user',
          content: m.content
            .filter((p) => multimodal || p.type === 'text')
            .map((p) =>
              p.type === 'text'
                ? { type: 'text' as const, text: p.text }
                : {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: p.mimeType as 'image/png',
                      data: p.data.toString('base64'),
                    },
                  }
            ),
        })
      }
    } else if (m.role === 'assistant') {
      const content: MessageParam['content'] = []
      if (m.content) (content as unknown[]).push({ type: 'text', text: m.content })
      for (const c of m.toolCalls ?? [])
        (content as unknown[]).push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] })
    } else if (m.role === 'tool') {
      const last = out[out.length - 1]
      const block = { type: 'tool_result' as const, tool_use_id: m.toolCallId, content: m.content }
      if (
        last &&
        last.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.some((b) => b.type === 'tool_result')
      ) {
        ;(last.content as unknown[]).push(block)
      } else out.push({ role: 'user', content: [block] })
    }
  }
  return { system, messages: out }
}

export class AnthropicChatModel implements ChatModel {
  public readonly id: string
  public readonly multimodal: boolean
  private readonly client: Anthropic
  private readonly model: string
  private readonly reasoningEffort?: string

  public constructor(config: LlmConfig, apiKey: string | undefined) {
    this.client = new Anthropic({ apiKey, baseURL: config.baseUrl })
    this.model = config.model
    this.multimodal = config.multimodal ?? false
    this.reasoningEffort = config.reasoningEffort
    this.id = `anthropic/${config.model}`
  }

  public async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
    const { system, messages } = toAnthropic(req.messages, this.multimodal)
    const tools: Tool[] | undefined = req.tools?.length
      ? req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Tool['input_schema'],
        }))
      : undefined
    let stream: ReturnType<typeof this.client.messages.stream>
    try {
      stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxOutputTokens ?? 1024,
          system: system || undefined,
          messages,
          tools,
          temperature: req.temperature,
          // the prefix is cached up to the last block, and read back by the next call that repeats it (LLM-CACHE-001,
          // LLM-CACHE-006); without it the Messages API caches nothing
          ...(req.cacheKey ? { cache_control: { type: 'ephemeral' as const, ttl: req.cacheTtl ?? '5m' } } : {}),
          ...(this.reasoningEffort && this.reasoningEffort !== 'minimal'
            ? {
                thinking: {
                  type: 'enabled' as const,
                  budget_tokens:
                    this.reasoningEffort === 'high' ? 8000 : this.reasoningEffort === 'medium' ? 4000 : 1024,
                },
              }
            : {}),
        },
        { signal: req.signal }
      )
    } catch (error) {
      throw new LlmError(error instanceof Error ? error.message : String(error), 'anthropic')
    }
    const pending = new Map<number, { id: string; name: string; args: string }>()
    let started = false
    // what the provider counted (LLM-USAGE-001, LLM-USAGE-005): `message_start` gives the input, `message_delta` the
    // output and, cumulative, any count it updates; reported once, at the end of the stream
    const counts = new AnthropicCounts()
    for await (const event of stream) {
      // the first block of the answer, of text, of thinking or of a tool call (LLM-USAGE-004)
      if (!started && event.type === 'content_block_start') {
        started = true
        yield { type: 'started' }
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        pending.set(event.index, { id: event.content_block.id, name: event.content_block.name, args: '' })
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text }
        else if (event.delta.type === 'input_json_delta') {
          const slot = pending.get(event.index)
          if (slot) slot.args += event.delta.partial_json
        }
      } else if (event.type === 'content_block_stop') {
        const slot = pending.get(event.index)
        if (slot) {
          yield { type: 'tool_call', call: { id: slot.id, name: slot.name, arguments: parseArguments(slot.args) } }
          pending.delete(event.index)
        }
      } else if (event.type === 'message_start') counts.add(event.message?.usage)
      else if (event.type === 'message_delta') {
        if (event.delta.stop_reason) yield { type: 'stop', reason: event.delta.stop_reason }
        counts.add(event.usage)
      }
    }
    const usage = counts.usage()
    if (usage) yield usage
  }
}

/** The counts of the Messages API, as `message_start` and `message_delta` carry them (each field may be absent or null). */
interface AnthropicUsageFields {
  input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  output_tokens?: number | null
}

/**
 * The usage of a call of the Messages API (LLM-USAGE-005). Its `input_tokens` counts only what was neither read from the
 * cache nor written to it: the input of the call is the sum of the three, and the cache parts are parts of it, as
 * every adapter reports them (LLM-USAGE-001). A later event's count replaces an earlier one: `message_delta`'s are
 * cumulative.
 */
export class AnthropicCounts {
  private seen = false
  private input = 0
  private cacheRead = 0
  private cacheWrite = 0
  private output = 0

  public add(fields: AnthropicUsageFields | null | undefined): void {
    if (!fields) return
    this.seen = true
    if (typeof fields.input_tokens === 'number') this.input = fields.input_tokens
    if (typeof fields.cache_read_input_tokens === 'number') this.cacheRead = fields.cache_read_input_tokens
    if (typeof fields.cache_creation_input_tokens === 'number') this.cacheWrite = fields.cache_creation_input_tokens
    if (typeof fields.output_tokens === 'number') this.output = fields.output_tokens
  }

  public usage(): Extract<ChatDelta, { type: 'usage' }> | undefined {
    if (!this.seen) return undefined
    return {
      type: 'usage',
      inputTokens: this.input + this.cacheRead + this.cacheWrite,
      cachedTokens: this.cacheRead,
      cacheWriteTokens: this.cacheWrite,
      outputTokens: this.output,
    }
  }
}
