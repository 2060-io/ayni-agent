/**
 * Token estimates for the window budget (MEM-RET-001, MEM-CTX-002). Characters / 4, counted over what the model
 * receives: every message as rendered, tool calls and results, the tool definitions, a fixed cost per image. The
 * provider's tokenizer differs: the context scales the estimate by the ratio the provider last reported (D74).
 */
import type { ChatMessage, ToolDefinition } from '../llm/types.js'

/** A rough token count of a text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** What an image costs in the estimate, whatever its size. */
export const IMAGE_TOKENS = 1000

/** What a message costs beyond its content: its role and framing on the wire. */
export const MESSAGE_OVERHEAD_TOKENS = 4

/** The estimated cost of one message, as the model receives it. */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS
  if (message.role === 'user' && typeof message.content !== 'string') {
    for (const part of message.content) tokens += part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKENS
  } else tokens += estimateTokens(message.content as string)
  if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? []) tokens += estimateTokens(call.name + JSON.stringify(call.arguments))
  }
  if (message.role === 'tool') tokens += estimateTokens(message.name)
  return tokens
}

/** The estimated cost of the tool definitions sent with a request. */
export function estimateToolTokens(tools: ToolDefinition[] | undefined): number {
  return (tools ?? []).reduce((n, t) => n + estimateTokens(t.name + t.description + JSON.stringify(t.parameters)), 0)
}

/** The estimated input of a whole request (MEM-CTX-002). */
export function estimateRequestTokens(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  return messages.reduce((n, m) => n + estimateMessageTokens(m), 0) + estimateToolTokens(tools)
}
