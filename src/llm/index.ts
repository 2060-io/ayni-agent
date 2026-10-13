import type { LlmConfig } from '../config/packTypes.js'
import { AnthropicChatModel } from './anthropic.js'
import { BedrockChatModel } from './bedrock.js'
import { OllamaChatModel } from './ollama.js'
import { OpenAiChatModel } from './openai.js'
import { StubChatModel } from './stub.js'
import type { ChatModel } from './types.js'

export { createEmbeddings } from './embeddings.js'
export * from './types.js'

/** Three adapter tiers (LLM-PROV-001): native, generic chat-completions, special-protocol. */
export function createChatModel(config: LlmConfig, env: NodeJS.ProcessEnv = process.env): ChatModel {
  const apiKey = env[config.apiKeyEnv ?? 'LLM_API_KEY']
  switch (config.provider) {
    case 'stub':
      return new StubChatModel()
    case 'anthropic':
      return new AnthropicChatModel(config, apiKey)
    case 'ollama':
      return new OllamaChatModel(config)
    case 'bedrock':
      return new BedrockChatModel(config, env)
    default:
      return new OpenAiChatModel(config, apiKey, env)
  }
}
