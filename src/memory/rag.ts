/** Retrieval-augmented generation over configured documents (D42, MEM-RAG-001..005). */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentPack, RagSource } from '../config/packTypes.js'
import type { Principal, RagChunk, Session } from '../core/types.js'
import type { EmbeddingModel } from '../llm/types.js'
import type { Store } from '../store/types.js'
import { nowIso } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { MemoryService } from './service.js'

export function chunkText(text: string, size: number, overlap: number): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size)
    if (end < clean.length) {
      const cut = clean.lastIndexOf('\n', end)
      if (cut > start + size / 2) end = cut
    }
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks.filter(Boolean)
}

function readLocal(path: string): { uri: string; text: string }[] {
  const stat = statSync(path)
  if (stat.isFile()) return [{ uri: path, text: readFileSync(path, 'utf8') }]
  const out: { uri: string; text: string }[] = []
  for (const name of readdirSync(path)) {
    const p = join(path, name)
    if (statSync(p).isDirectory()) out.push(...readLocal(p))
    else if (/\.(md|txt|markdown|csv|json|html?)$/i.test(name)) out.push({ uri: p, text: readFileSync(p, 'utf8') })
  }
  return out
}

export class RagService {
  private readonly size: number
  private readonly overlap: number

  public constructor(
    private readonly pack: AgentPack,
    private readonly packDir: string,
    private readonly store: Store,
    private readonly embeddings: EmbeddingModel,
    private readonly memory: MemoryService,
    private readonly logger: Logger
  ) {
    this.size = pack.rag?.chunkSize ?? pack.memory?.retrieval?.chunkSize ?? 1000
    this.overlap = pack.rag?.chunkOverlap ?? pack.memory?.retrieval?.chunkOverlap ?? 150
  }

  private async load(source: RagSource): Promise<{ uri: string; text: string }[]> {
    if (source.type === 'local') {
      const path = resolve(this.packDir, source.path ?? '')
      try {
        return readLocal(path)
      } catch (error) {
        this.logger.warn({ err: error, source: source.id, path }, 'rag source unreadable')
        return []
      }
    }
    if (!source.url) return []
    const response = await fetch(source.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return [{ uri: source.url, text: await response.text() }]
  }

  /** Ingests every source whose content changed since the last run (chunk, embed, replace). */
  public async ingestAll(force = false): Promise<void> {
    for (const source of this.pack.rag?.sources ?? []) {
      try {
        const docs = await this.load(source)
        const digest = createHash('sha256')
          .update(docs.map((d) => `${d.uri}\n${d.text}`).join('\n\0'))
          .digest('hex')
        if (!force && (await this.store.rag.sourceDigest(source.id)) === digest) continue
        const chunks: (RagChunk & { vector: number[] | null })[] = []
        for (const doc of docs) {
          const pieces = chunkText(doc.text, this.size, this.overlap)
          const vectors = await this.embeddings.embed(pieces)
          for (const [i, chunkText] of pieces.entries()) {
            chunks.push({
              id: `${source.id}:${createHash('sha1').update(doc.uri).digest('hex').slice(0, 8)}:${i}`,
              sourceId: source.id,
              uri: doc.uri,
              visibility: source.visibility ?? 'public',
              state: 'active',
              chunkText,
              position: i,
              createdAt: nowIso(),
              vector: vectors[i] ?? null,
            })
          }
        }
        await this.store.rag.replaceSource(source.id, chunks)
        await this.store.rag.setSourceDigest(source.id, digest)
        this.logger.info({ source: source.id, chunks: chunks.length }, 'rag source ingested')
      } catch (error) {
        this.logger.error({ err: error, source: source.id }, 'rag ingestion failed')
      }
    }
  }

  /** Chunks are retrieved through the same scope predicate as memory (MEM-RAG-005). */
  public async search(principal: Principal, session: Session, query: string): Promise<RagChunk[]> {
    const scope = this.memory.scopeFor(principal, session)
    if (!query.trim() || scope.terms.length === 0) return []
    const [vector] = await this.embeddings.embed([query])
    if (!vector) return []
    const hits = await this.store.rag.vectorSearch(scope, vector, this.pack.memory?.retrieval?.topK ?? 8)
    return hits.map((h) => h.item)
  }

  public refreshIntervalMs(): number | undefined {
    const hours = (this.pack.rag?.sources ?? [])
      .map((s) => s.refreshHours)
      .filter((h): h is number => typeof h === 'number')
    return hours.length ? Math.min(...hours) * 3_600_000 : undefined
  }
}
