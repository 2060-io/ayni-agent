/**
 * Native OpenAI adapter and the generic chat-completions adapter (openai-compatible endpoints,
 * gateways, Azure OpenAI, Vertex AI's OpenAI-compatible endpoint). LLM-PROV-001..003.
 */
import OpenAI, { AzureOpenAI } from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type { LlmConfig } from '../config/packTypes.js'
import {
  type ChatDelta,
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  LlmError,
  parseArguments,
} from './types.js'

export function toOpenAiMessages(messages: ChatMessage[], multimodal: boolean): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content }
      case 'user':
        if (typeof m.content === 'string') return { role: 'user', content: m.content }
        return {
          role: 'user',
          content: m.content
            .filter((p) => multimodal || p.type === 'text')
            .map((p) =>
              p.type === 'text'
                ? { type: 'text' as const, text: p.text }
                : {
                    type: 'image_url' as const,
                    image_url: { url: `data:${p.mimeType};base64,${p.data.toString('base64')}` },
                  }
            ),
        }
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                })),
              }
            : {}),
        }
      default:
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
  })
}

export class OpenAiChatModel implements ChatModel {
  public readonly id: string
  public readonly multimodal: boolean
  private readonly client: OpenAI
  private readonly model: string
  private readonly provider: string
  private readonly reasoningEffort?: string

  public constructor(config: LlmConfig, apiKey: string | undefined, extraEnv: NodeJS.ProcessEnv = process.env) {
    this.provider = config.provider
    this.model = config.model
    this.multimodal = config.multimodal ?? false
    this.reasoningEffort = config.reasoningEffort
    this.id = `${config.provider}/${config.model}`
    const options = config.provider_options ?? {}
    if (config.provider === 'azure-openai') {
      const endpoint = String(options.endpoint ?? extraEnv.AZURE_OPENAI_ENDPOINT ?? '')
      if (!endpoint)
        throw new LlmError('azure-openai needs provider_options.endpoint or AZURE_OPENAI_ENDPOINT', 'azure-openai')
      this.client = new AzureOpenAI({
        endpoint,
        apiKey: apiKey ?? extraEnv.AZURE_OPENAI_API_KEY,
        apiVersion: String(options.apiVersion ?? extraEnv.AZURE_OPENAI_API_VERSION ?? '2024-10-21'),
        deployment: String(options.deployment ?? config.model),
      })
      return
    }
    if (config.provider === 'vertex') {
      const project = String(options.project ?? extraEnv.GOOGLE_CLOUD_PROJECT ?? '')
      const region = String(options.region ?? extraEnv.GOOGLE_CLOUD_REGION ?? 'us-central1')
      if (!project) throw new LlmError('vertex needs provider_options.project or GOOGLE_CLOUD_PROJECT', 'vertex')
      const baseURL =
        config.baseUrl ??
        `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/endpoints/openapi`
      this.client = new OpenAI({ baseURL, apiKey: apiKey ?? extraEnv.GOOGLE_ACCESS_TOKEN ?? 'missing' })
      return
    }
    if ((config.provider === 'openai-compatible' || config.provider === 'ollama') && !config.baseUrl) {
      throw new LlmError('baseUrl is required', config.provider)
    }
    this.client = new OpenAI({ baseURL: config.baseUrl, apiKey: apiKey ?? 'not-needed' })
  }

  public async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
    const tools: ChatCompletionTool[] | undefined = req.tools?.length
      ? req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined
    let stream: Awaited<ReturnType<typeof this.client.chat.completions.create>>
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAiMessages(req.messages, this.multimodal),
          tools,
          temperature: req.temperature,
          max_completion_tokens: req.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort as 'low' } : {}),
        },
        { signal: req.signal }
      )
    } catch (error) {
      throw new LlmError(error instanceof Error ? error.message : String(error), this.provider)
    }
    const pending = new Map<number, { id: string; name: string; args: string }>()
    for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (delta?.content) yield { type: 'text', text: delta.content }
      for (const tc of delta?.tool_calls ?? []) {
        const slot = pending.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: '', args: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
        pending.set(tc.index, slot)
      }
      if (choice?.finish_reason) {
        for (const slot of pending.values()) {
          yield { type: 'tool_call', call: { id: slot.id, name: slot.name, arguments: parseArguments(slot.args) } }
        }
        pending.clear()
      }
      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }
    }
    for (const slot of pending.values()) {
      yield { type: 'tool_call', call: { id: slot.id, name: slot.name, arguments: parseArguments(slot.args) } }
    }
  }
}
