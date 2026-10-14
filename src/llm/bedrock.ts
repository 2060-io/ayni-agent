/** AWS Bedrock special-protocol adapter over the Converse API (LLM-PROV-003). */
import { BedrockRuntimeClient, ConverseStreamCommand, type Message, type Tool } from '@aws-sdk/client-bedrock-runtime'
import type { LlmConfig } from '../config/packTypes.js'
import {
  type ChatDelta,
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  LlmError,
  parseArguments,
} from './types.js'

export class BedrockChatModel implements ChatModel {
  public readonly id: string
  public readonly multimodal: boolean
  private readonly client: BedrockRuntimeClient
  private readonly model: string

  public constructor(config: LlmConfig, env: NodeJS.ProcessEnv = process.env) {
    const region = String(config.provider_options?.region ?? env.AWS_REGION ?? '')
    if (!region) throw new LlmError('provider_options.region or AWS_REGION is required', 'bedrock')
    this.client = new BedrockRuntimeClient({ region })
    this.model = config.model
    this.multimodal = config.multimodal ?? false
    this.id = `bedrock/${config.model}`
  }

  private toMessages(messages: ChatMessage[]): { system: string; messages: Message[] } {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => (m.role === 'system' ? m.content : ''))
      .join('\n\n')
    const out: Message[] = []
    for (const m of messages) {
      if (m.role === 'system') continue
      if (m.role === 'user') {
        const content =
          typeof m.content === 'string'
            ? [{ text: m.content }]
            : m.content
                .filter((p) => this.multimodal || p.type === 'text')
                .map((p) =>
                  p.type === 'text'
                    ? { text: p.text }
                    : { image: { format: p.mimeType.replace('image/', '') as 'png', source: { bytes: p.data } } }
                )
        out.push({ role: 'user', content })
      } else if (m.role === 'assistant') {
        const content: Message['content'] = []
        if (m.content) content.push({ text: m.content })
        for (const c of m.toolCalls ?? [])
          content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments as never } })
        out.push({ role: 'assistant', content: content.length ? content : [{ text: '' }] })
      } else {
        const block = { toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }] } }
        const last = out[out.length - 1]
        if (last?.role === 'user' && last.content?.some((b) => 'toolResult' in b)) last.content.push(block)
        else out.push({ role: 'user', content: [block] })
      }
    }
    return { system, messages: out }
  }

  public async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
    const { system, messages } = this.toMessages(req.messages)
    const tools: Tool[] | undefined = req.tools?.length
      ? req.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description,
            inputSchema: { json: t.parameters as Record<string, never> },
          },
        }))
      : undefined
    const response = await this.client.send(
      new ConverseStreamCommand({
        modelId: this.model,
        messages,
        system: system ? [{ text: system }] : undefined,
        toolConfig: tools ? { tools } : undefined,
        inferenceConfig: { temperature: req.temperature, maxTokens: req.maxOutputTokens },
      }),
      { abortSignal: req.signal }
    )
    const pending = new Map<number, { id: string; name: string; args: string }>()
    for await (const event of response.stream ?? []) {
      if (event.contentBlockStart?.start?.toolUse) {
        const idx = event.contentBlockStart.contentBlockIndex ?? 0
        pending.set(idx, {
          id: event.contentBlockStart.start.toolUse.toolUseId ?? `call_${idx}`,
          name: event.contentBlockStart.start.toolUse.name ?? '',
          args: '',
        })
      } else if (event.contentBlockDelta?.delta) {
        const idx = event.contentBlockDelta.contentBlockIndex ?? 0
        if (event.contentBlockDelta.delta.text) yield { type: 'text', text: event.contentBlockDelta.delta.text }
        if (event.contentBlockDelta.delta.toolUse?.input) {
          const slot = pending.get(idx)
          if (slot) slot.args += event.contentBlockDelta.delta.toolUse.input
        }
      } else if (event.contentBlockStop) {
        const slot = pending.get(event.contentBlockStop.contentBlockIndex ?? 0)
        if (slot) {
          yield { type: 'tool_call', call: { id: slot.id, name: slot.name, arguments: parseArguments(slot.args) } }
          pending.delete(event.contentBlockStop.contentBlockIndex ?? 0)
        }
      } else if (event.metadata?.usage) {
        yield {
          type: 'usage',
          inputTokens: event.metadata.usage.inputTokens ?? 0,
          outputTokens: event.metadata.usage.outputTokens ?? 0,
        }
      }
    }
  }
}
