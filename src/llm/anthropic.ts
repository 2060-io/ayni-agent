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

function toAnthropic(messages: ChatMessage[], multimodal: boolean): { system: string; messages: MessageParam[] } {
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
    for await (const event of stream) {
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
      } else if (event.type === 'message_delta' && event.usage) {
        yield { type: 'usage', inputTokens: 0, outputTokens: event.usage.output_tokens ?? 0 }
      }
    }
  }
}
