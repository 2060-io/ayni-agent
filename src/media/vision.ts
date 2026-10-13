/** Inbound image to text, computed once (D45, MEDIA-STT-003, MEM-ATT-003). */
import type { AgentPack } from '../config/packTypes.js'
import { OpenAiChatModel } from '../llm/openai.js'
import { type ChatModel, collect } from '../llm/types.js'

export interface ImageDescriber {
  describe(image: Buffer, mimeType: string): Promise<string>
}

const DEFAULT_PROMPT =
  'Describe this image precisely in two or three sentences, including any readable text. Answer in the language of the surrounding conversation when known, else in English.'

export class LlmImageDescriber implements ImageDescriber {
  public constructor(
    private readonly model: ChatModel,
    private readonly prompt: string,
    private readonly maxOutputTokens: number
  ) {}
  public async describe(image: Buffer, mimeType: string): Promise<string> {
    const { text } = await collect(
      this.model.stream({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: this.prompt },
              { type: 'image', mimeType, data: image },
            ],
          },
        ],
        maxOutputTokens: this.maxOutputTokens,
        temperature: 0,
      })
    )
    return text.trim() || '[image without description]'
  }
}

export class StubImageDescriber implements ImageDescriber {
  public async describe(image: Buffer, mimeType: string): Promise<string> {
    return `[image, ${mimeType}, ${image.length} bytes]`
  }
}

export function createImageDescriber(
  pack: AgentPack,
  llm: ChatModel,
  env: NodeJS.ProcessEnv = process.env
): ImageDescriber | undefined {
  const cfg = pack.media?.vision
  if (!cfg || cfg.enabled === false) return undefined
  if (cfg.model === 'stub') return new StubImageDescriber()
  const prompt = cfg.prompt ?? DEFAULT_PROMPT
  const maxTokens = cfg.maxOutputTokens ?? 300
  if (cfg.provider === 'llm') {
    if (!llm.multimodal)
      return new LlmImageDescriber({ ...llm, multimodal: true, stream: llm.stream.bind(llm) }, prompt, maxTokens)
    return new LlmImageDescriber(llm, prompt, maxTokens)
  }
  const apiKey = env[cfg.apiKeyEnv ?? 'VISION_API_KEY'] ?? env.LLM_API_KEY
  const model = new OpenAiChatModel(
    { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, multimodal: true },
    apiKey,
    env
  )
  return new LlmImageDescriber(model, prompt, maxTokens)
}
