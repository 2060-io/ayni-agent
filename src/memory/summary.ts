/**
 * The conversation summary (D10, D75, MEM-CTX-004): what a step of the window drops, compressed with the previous
 * summary by the configured model. Derived, never an entry; sealed where it is kept (MEM-TIER-004).
 */
import type { ChatModel } from '../llm/types.js'
import { estimateTokens } from '../util/tokens.js'

/** The first words of the summarizer's instruction: the stub model recognizes a summary request by them. */
export const SUMMARY_INSTRUCTION_HEAD = 'You write the summary of the earlier part of a conversation'

export const SUMMARY_INSTRUCTION = `${SUMMARY_INSTRUCTION_HEAD} between a person and an AI agent. The agent reads it later in place of those messages, so keep everything it may need: every fact, figure, name, date and decision; what the person asked and wanted; what the agent answered, did and promised (the tools it used, the requests it showed and what became of them); what is still open. Leave out greetings and repetition. Write in the language of the conversation, in short plain sentences, oldest first. Invent nothing; address nobody; no preamble. When a previous summary is given, return one summary that holds the previous one and the new messages.`

export interface SummaryUsage {
  calls: number
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/**
 * The previous summary and the new lines, folded into one summary. Lines that do not fit one call (`chunkTokens`)
 * are folded in several calls, each summary the previous one of the next.
 */
export async function summarize(
  llm: ChatModel,
  previous: string | undefined,
  lines: string[],
  opts: { maxOutputTokens: number; chunkTokens: number; signal?: AbortSignal }
): Promise<{ text: string; usage: SummaryUsage }> {
  const usage: SummaryUsage = { calls: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  let summary = previous
  const chunks: string[][] = [[]]
  let size = 0
  for (const line of lines) {
    const cost = estimateTokens(line)
    const current = chunks[chunks.length - 1] as string[]
    if (current.length && size + cost > opts.chunkTokens) {
      chunks.push([line])
      size = cost
    } else {
      current.push(line)
      size += cost
    }
  }
  for (const chunk of chunks) {
    if (!chunk.length) continue
    let text = ''
    for await (const delta of llm.stream({
      messages: [
        { role: 'system', content: SUMMARY_INSTRUCTION },
        {
          role: 'user',
          content: `Previous summary:\n${summary?.trim() || '(none)'}\n\nMessages to add, oldest first:\n${chunk.join('\n')}`,
        },
      ],
      maxOutputTokens: opts.maxOutputTokens,
      signal: opts.signal,
    })) {
      if (delta.type === 'text') text += delta.text
      else if (delta.type === 'usage') {
        usage.inputTokens += delta.inputTokens
        usage.outputTokens += delta.outputTokens
        usage.cachedTokens += delta.cachedTokens ?? 0
        usage.cacheWriteTokens += delta.cacheWriteTokens ?? 0
      }
    }
    usage.calls++
    if (!text.trim()) throw new Error('the model returned an empty summary')
    summary = text.trim()
  }
  return { text: summary ?? '', usage }
}
