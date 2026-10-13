/** Provider-agnostic chat model interface (D35, LLM-PROV-001). Adapters stream deltas. */

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: Buffer }

export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxOutputTokens?: number
  signal?: AbortSignal
}

export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCallRequest }
  | { type: 'usage'; inputTokens: number; outputTokens: number }

export interface ChatModel {
  readonly id: string
  readonly multimodal: boolean
  stream(req: ChatRequest): AsyncIterable<ChatDelta>
}

export interface EmbeddingModel {
  readonly id: string
  embed(texts: string[]): Promise<number[][]>
}

export class LlmError extends Error {
  public constructor(
    message: string,
    public readonly provider: string
  ) {
    super(`${provider}: ${message}`)
    this.name = 'LlmError'
  }
}

export function parseArguments(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Collects a stream into text and tool calls (used by non-streaming callers). */
export async function collect(
  stream: AsyncIterable<ChatDelta>
): Promise<{ text: string; toolCalls: ToolCallRequest[] }> {
  let text = ''
  const toolCalls: ToolCallRequest[] = []
  for await (const d of stream) {
    if (d.type === 'text') text += d.text
    else if (d.type === 'tool_call') toolCalls.push(d.call)
  }
  return { text, toolCalls }
}
