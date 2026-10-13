/** Speech-to-text, cloud or self-hosted, OpenAI-compatible /audio/transcriptions (MEDIA-STT-001/002/004). */
import type { AgentPack } from '../config/packTypes.js'

export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string, filename: string, languageHint?: string): Promise<string>
}

export class OpenAiCompatibleTranscriber implements Transcriber {
  private readonly url: string
  public constructor(
    private readonly model: string,
    baseUrl: string | undefined,
    private readonly apiKey: string | undefined,
    private readonly languageHint?: string
  ) {
    this.url = `${(baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/audio/transcriptions`
  }

  public async transcribe(audio: Buffer, mimeType: string, filename: string, languageHint?: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename)
    form.append('model', this.model)
    form.append('response_format', 'json')
    const lang = languageHint ?? this.languageHint
    if (lang) form.append('language', lang.slice(0, 2))
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      body: form,
    })
    if (!response.ok)
      throw new Error(`speech-to-text HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const json = (await response.json()) as { text?: string }
    return (json.text ?? '').trim()
  }
}

export class StubTranscriber implements Transcriber {
  public async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    return `[voice note, ${mimeType}, ${audio.length} bytes]`
  }
}

export function createTranscriber(pack: AgentPack, env: NodeJS.ProcessEnv = process.env): Transcriber | undefined {
  const cfg = pack.media?.speechToText
  if (!cfg || cfg.enabled === false) return undefined
  if (cfg.model === 'stub') return new StubTranscriber()
  const apiKey = env[cfg.apiKeyEnv ?? 'STT_API_KEY'] ?? env.STT_API_KEY
  return new OpenAiCompatibleTranscriber(cfg.model, cfg.baseUrl ?? env.STT_BASE_URL, apiKey, cfg.languageHint)
}
