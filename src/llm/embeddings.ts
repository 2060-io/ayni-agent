/** Pluggable embeddings (LLM-EMB-001/002): OpenAI-compatible endpoints, Cohere, a stub. */
import { createHash } from 'node:crypto'
import type { EmbeddingsConfig } from '../config/packTypes.js'
import { type EmbeddingModel, LlmError } from './types.js'

export class OpenAiCompatibleEmbeddings implements EmbeddingModel {
  public readonly id: string
  private readonly url: string
  private readonly model: string
  private readonly apiKey?: string
  private readonly dimensions?: number

  public constructor(config: EmbeddingsConfig, apiKey: string | undefined) {
    const base = (
      config.baseUrl ?? (config.provider === 'voyage' ? 'https://api.voyageai.com/v1' : 'https://api.openai.com/v1')
    ).replace(/\/+$/, '')
    this.url = `${base}/embeddings`
    this.model = config.model
    this.apiKey = apiKey
    this.dimensions = config.dimensions
    this.id = `${config.provider}/${config.model}`
  }

  public async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      }),
    })
    if (!response.ok) throw new LlmError(`embeddings HTTP ${response.status}`, this.id)
    const json = (await response.json()) as { data: { index: number; embedding: number[] }[] }
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
  }
}

export class CohereEmbeddings implements EmbeddingModel {
  public readonly id: string
  private readonly url: string
  private readonly model: string
  private readonly apiKey?: string

  public constructor(config: EmbeddingsConfig, apiKey: string | undefined) {
    this.url = `${(config.baseUrl ?? 'https://api.cohere.com/v2').replace(/\/+$/, '')}/embed`
    this.model = config.model
    this.apiKey = apiKey
    this.id = `cohere/${config.model}`
  }

  public async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey ?? ''}` },
      body: JSON.stringify({ model: this.model, texts, input_type: 'search_document', embedding_types: ['float'] }),
    })
    if (!response.ok) throw new LlmError(`embeddings HTTP ${response.status}`, this.id)
    const json = (await response.json()) as { embeddings: { float: number[][] } }
    return json.embeddings.float
  }
}

/** Hash-bag embedding: deterministic, offline, good enough for tests and the stub pack. */
export class StubEmbeddings implements EmbeddingModel {
  public readonly id = 'stub/hash-64'
  public async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(64).fill(0)
      for (const token of text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)) {
        const h = createHash('sha1').update(token).digest()
        v[h[0] % 64] += 1
        v[h[1] % 64] += 0.5
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
      return v.map((x) => x / norm)
    })
  }
}

export function createEmbeddings(config: EmbeddingsConfig, env: NodeJS.ProcessEnv = process.env): EmbeddingModel {
  const apiKey = env[config.apiKeyEnv ?? 'EMBEDDINGS_API_KEY']
  switch (config.provider) {
    case 'stub':
      return new StubEmbeddings()
    case 'cohere':
      return new CohereEmbeddings(config, apiKey)
    default:
      return new OpenAiCompatibleEmbeddings(config, apiKey)
  }
}
