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
  /** the provider's cache key, for a provider that caches by prefix: the conversation (LLM-CACHE-001) */
  cacheKey?: string
  /** the lifetime of what the request writes to the provider's cache (LLM-CACHE-001) */
  cacheTtl?: '5m' | '1h'
}

export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCallRequest }
  /**
   * what the provider counted for the call (LLM-USAGE-001): the input (every token of it), the part of it served from
   * the provider's cache, the part written to it, and the output; the cache parts are parts of the input
   */
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number }
  /**
   * the provider began its answer (LLM-USAGE-004): its first token of text, of reasoning or of a tool call. Sent once,
   * by an adapter that receives a tool call in pieces or reasoning it does not pass on, so that the time to the first
   * token is not the time to the whole call.
   */
  | { type: 'started' }
  /** why the provider ended the call, in its own words (`stop`, `tool_calls`, `end_turn`, `length`...) (LLM-USAGE-004) */
  | { type: 'stop'; reason: string }

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
