/**
 * What one model call took (LLM-USAGE-004): the time to its first token, its whole duration, why it stopped and what the
 * provider counted. Never what the call carried: no prompt, no reply, no tool name, no argument.
 */
import type { ChatDelta, ChatModel, ChatRequest } from './types.js'

export interface CallMeasure {
  provider: string
  model: string
  /** from the request to the first token of text, of reasoning or of a tool call; none when nothing came */
  firstTokenMs?: number
  /** from the request to the end of the stream, or to its failure */
  durationMs: number
  /** the provider's own words, when it gave them */
  stopReason?: string
  /** what the provider counted, when it reported it (LLM-USAGE-001) */
  usage?: Extract<ChatDelta, { type: 'usage' }>
  /** how many tool calls the answer held: their number, never their names */
  toolCalls: number
  outcome: 'completed' | 'failed' | 'cancelled'
}

/** The provider and the model of a model's id (`<provider>/<model>`; a model's own name may hold a `/`). */
export function providerAndModel(id: string): { provider: string; model: string } {
  const at = id.indexOf('/')
  return at < 0 ? { provider: id, model: id } : { provider: id.slice(0, at), model: id.slice(at + 1) }
}

/**
 * The call's deltas, as the model streams them, measured: `done` is told once, when the stream ends, fails, or is
 * left by its reader (a cancelled turn).
 */
export async function* measured(
  llm: ChatModel,
  req: ChatRequest,
  done: (measure: CallMeasure) => void
): AsyncIterable<ChatDelta> {
  const start = performance.now()
  const elapsed = () => Math.round(performance.now() - start)
  const measure: CallMeasure = { ...providerAndModel(llm.id), durationMs: 0, toolCalls: 0, outcome: 'failed' }
  let finished = false
  try {
    for await (const delta of llm.stream(req)) {
      if (
        measure.firstTokenMs === undefined &&
        (delta.type === 'started' || delta.type === 'text' || delta.type === 'tool_call')
      )
        measure.firstTokenMs = elapsed()
      if (delta.type === 'tool_call') measure.toolCalls++
      else if (delta.type === 'usage') measure.usage = delta
      else if (delta.type === 'stop') measure.stopReason = delta.reason
      yield delta
    }
    finished = true
  } finally {
    measure.durationMs = elapsed()
    measure.outcome = finished ? 'completed' : req.signal?.aborted ? 'cancelled' : 'failed'
    done(measure)
  }
}

/** The fields of a call's log line (LLM-USAGE-004): numbers, names of the provider and the model, and nothing else. */
export function callLogFields(measure: CallMeasure): Record<string, string | number | boolean | undefined> {
  return {
    provider: measure.provider,
    model: measure.model,
    firstTokenMs: measure.firstTokenMs,
    durationMs: measure.durationMs,
    inputTokens: measure.usage?.inputTokens ?? 0,
    cachedTokens: measure.usage?.cachedTokens ?? 0,
    cacheWriteTokens: measure.usage?.cacheWriteTokens ?? 0,
    outputTokens: measure.usage?.outputTokens ?? 0,
    stopReason: measure.stopReason,
    toolCalls: measure.toolCalls,
    outcome: measure.outcome,
    reported: !!measure.usage,
  }
}
