/** Native Ollama adapter over /api/chat (LLM-PROV-001). */
import type { LlmConfig } from '../config/packTypes.js'
import { type ChatDelta, type ChatMessage, type ChatModel, type ChatRequest, LlmError } from './types.js'

export class OllamaChatModel implements ChatModel {
  public readonly id: string
  public readonly multimodal: boolean
  private readonly baseUrl: string
  private readonly model: string

  public constructor(config: LlmConfig) {
    if (!config.baseUrl) throw new LlmError('baseUrl is required', 'ollama')
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.model = config.model
    this.multimodal = config.multimodal ?? false
    this.id = `ollama/${config.model}`
  }

  private toMessages(messages: ChatMessage[]): Record<string, unknown>[] {
    return messages.map((m) => {
      if (m.role === 'user') {
        if (typeof m.content === 'string') return { role: 'user', content: m.content }
        return {
          role: 'user',
          content: m.content
            .filter((p) => p.type === 'text')
            .map((p) => (p.type === 'text' ? p.text : ''))
            .join('\n'),
          ...(this.multimodal
            ? {
                images: m.content
                  .filter((p) => p.type === 'image')
                  .map((p) => (p.type === 'image' ? p.data.toString('base64') : '')),
              }
            : {}),
        }
      }
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }
            : {}),
        }
      }
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name }
      return { role: 'system', content: m.content }
    })
  }

  public async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
    const body = {
      model: this.model,
      messages: this.toMessages(req.messages),
      stream: true,
      options: { temperature: req.temperature, num_predict: req.maxOutputTokens },
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    }
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!response.ok || !response.body) throw new LlmError(`HTTP ${response.status}`, 'ollama')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let callIndex = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line) continue
        const json = JSON.parse(line) as {
          message?: {
            content?: string
            tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
          }
          prompt_eval_count?: number
          eval_count?: number
          done?: boolean
        }
        if (json.message?.content) yield { type: 'text', text: json.message.content }
        for (const tc of json.message?.tool_calls ?? []) {
          yield {
            type: 'tool_call',
            call: { id: `call_${callIndex++}`, name: tc.function.name, arguments: tc.function.arguments ?? {} },
          }
        }
        if (json.done)
          yield { type: 'usage', inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 }
      }
    }
  }
}
