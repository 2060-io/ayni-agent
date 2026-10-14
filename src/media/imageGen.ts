/** Image generation (MEDIA-GEN-001..004): OpenAI image API or compatible; full image plus thumbnail. */
import sharp from 'sharp'
import type { AgentPack, ImageProviderDef } from '../config/packTypes.js'

export interface GeneratedImage {
  image: Buffer
  mimeType: string
  width?: number
  height?: number
  thumbnail: Buffer
}

export interface ImageGenerator {
  readonly name: string
  generate(prompt: string, size?: string): Promise<GeneratedImage>
}

export async function thumbnailOf(
  image: Buffer,
  px: number
): Promise<{ buffer: Buffer; width?: number; height?: number }> {
  const meta = await sharp(image).metadata()
  const buffer = await sharp(image)
    .resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()
  return { buffer, width: meta.width, height: meta.height }
}

export class OpenAiImageGenerator implements ImageGenerator {
  public readonly name: string
  private readonly url: string
  public constructor(
    private readonly def: ImageProviderDef,
    private readonly apiKey: string | undefined,
    private readonly thumbnailPx: number
  ) {
    this.name = def.name
    this.url = `${(def.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/images/generations`
  }

  public async generate(prompt: string, size?: string): Promise<GeneratedImage> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.def.model,
        prompt,
        n: 1,
        size: size ?? this.def.defaultSize ?? '1024x1024',
        ...(this.def.quality ? { quality: this.def.quality } : {}),
        ...(this.def.model.startsWith('dall-e')
          ? { response_format: 'b64_json' }
          : { output_format: this.def.outputFormat ?? 'png' }),
      }),
    })
    if (!response.ok)
      throw new Error(`image generation HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const json = (await response.json()) as { data: { b64_json?: string; url?: string }[] }
    const item = json.data[0]
    let image: Buffer
    if (item?.b64_json) image = Buffer.from(item.b64_json, 'base64')
    else if (item?.url) image = Buffer.from(await (await fetch(item.url)).arrayBuffer())
    else throw new Error('image generation returned no image')
    const format = this.def.outputFormat ?? 'png'
    const thumb = await thumbnailOf(image, this.thumbnailPx)
    return { image, mimeType: `image/${format}`, width: thumb.width, height: thumb.height, thumbnail: thumb.buffer }
  }
}

export class StubImageGenerator implements ImageGenerator {
  public readonly name = 'stub'
  public async generate(prompt: string): Promise<GeneratedImage> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#4b5563"/><text x="20" y="260" font-size="24" fill="white">${prompt.replace(/[<>&]/g, '').slice(0, 30)}</text></svg>`
    const image = await sharp(Buffer.from(svg)).png().toBuffer()
    const thumb = await thumbnailOf(image, 128)
    return { image, mimeType: 'image/png', width: 512, height: 512, thumbnail: thumb.buffer }
  }
}

export function createImageGenerators(
  pack: AgentPack,
  env: NodeJS.ProcessEnv = process.env
): Map<string, ImageGenerator> {
  const out = new Map<string, ImageGenerator>()
  const cfg = pack.media?.imageGeneration
  if (!cfg || cfg.enabled === false) return out
  for (const def of cfg.providers) {
    if (def.model === 'stub') out.set(def.name, new StubImageGenerator())
    else
      out.set(
        def.name,
        new OpenAiImageGenerator(
          def,
          env[def.apiKeyEnv ?? 'IMAGE_API_KEY'] ?? env.IMAGE_API_KEY,
          cfg.thumbnailPx ?? 256
        )
      )
  }
  return out
}
