/**
 * Media (D22, D23, D45, MEDIA-*): uploads to text-first attachments, on-demand object access,
 * non-blocking image generation ordered by initiation time.
 */
import sharp from 'sharp'
import type { AgentPack } from '../config/packTypes.js'
import type { CapabilityRouter } from '../core/channel.js'
import type { MessageAttachment, MessageEntry, Principal, Session } from '../core/types.js'
import type { MemoryService } from '../memory/service.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { ImageGenerator } from './imageGen.js'
import type { ObjectStore } from './objectStore.js'
import type { Transcriber } from './stt.js'
import type { ImageDescriber } from './vision.js'

export interface PendingUpload {
  id: string
  sessionId: string
  attachment: MessageAttachment
  createdAt: string
}

export interface GeneratingState {
  entryId: string
  kind: 'image'
  startedAt: string
  sessionId: string
}

export function attachmentTypeOf(mimeType: string): MessageAttachment['type'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'voice'
  if (mimeType.startsWith('video/')) return 'video'
  return 'file'
}

export function mimeAllowed(mimeType: string, allowed: string[]): boolean {
  return allowed.some((pattern) =>
    pattern.endsWith('/*') ? mimeType.startsWith(pattern.slice(0, -1)) : pattern === mimeType
  )
}

export class MediaService {
  /** uploads waiting for the turn that references them (PROF-HIST-004) */
  private readonly pendingUploads = new Map<string, PendingUpload>()
  private readonly generating = new Map<string, GeneratingState>()

  public constructor(
    readonly _pack: AgentPack,
    private readonly store: Store,
    private readonly objects: ObjectStore,
    private readonly memory: MemoryService,
    private readonly router: CapabilityRouter,
    private readonly transcriber: Transcriber | undefined,
    private readonly describer: ImageDescriber | undefined,
    private readonly generators: Map<string, ImageGenerator>,
    private readonly logger: Logger
  ) {}

  /** Stores an uploaded object and computes its text representation once (MEM-ATT-002/003, MEDIA-STT-001). */
  public async ingest(
    session: Session,
    bytes: Buffer,
    mimeType: string,
    filename: string | undefined,
    language: string
  ): Promise<MessageAttachment> {
    const type = attachmentTypeOf(mimeType)
    const stored = await this.objects.put(`sessions/${session.id}`, bytes, mimeType)
    const attachment: MessageAttachment = {
      id: prefixedId('att'),
      type,
      bucketKey: stored.bucketKey,
      mimeType,
      size: stored.size,
      filename,
      textRepr: filename ? `[file ${filename}]` : `[${type}]`,
      objectKeyRef: stored.objectKeyRef,
      refDigest: stored.refDigest,
    }
    try {
      if (type === 'voice' && this.transcriber) {
        attachment.textRepr =
          (await this.transcriber.transcribe(bytes, mimeType, filename ?? 'voice-note', language)) ||
          '[voice note without words]'
      } else if (type === 'image') {
        const meta = await sharp(bytes)
          .metadata()
          .catch(() => undefined)
        attachment.width = meta?.width
        attachment.height = meta?.height
        if (this.describer) attachment.textRepr = await this.describer.describe(bytes, mimeType)
        const thumb = await sharp(bytes)
          .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer()
        const storedThumb = await this.objects.put(`sessions/${session.id}/thumbs`, thumb, 'image/webp')
        attachment.thumbnailBucketKey = storedThumb.bucketKey
        attachment.thumbnailId = `${attachment.id}.thumb`
        ;(attachment as MessageAttachment & { thumbnailKeyRef?: string }).thumbnailKeyRef = storedThumb.objectKeyRef
      }
    } catch (error) {
      this.logger.warn({ err: error, attachmentId: attachment.id }, 'media to text failed')
    }
    const pending: PendingUpload = { id: attachment.id, sessionId: session.id, attachment, createdAt: nowIso() }
    this.pendingUploads.set(attachment.id, pending)
    return attachment
  }

  public takeUploads(session: Session, ids: string[]): MessageAttachment[] {
    const out: MessageAttachment[] = []
    for (const id of ids) {
      const p = this.pendingUploads.get(id)
      if (p && p.sessionId === session.id) {
        out.push(p.attachment)
        this.pendingUploads.delete(id)
      }
    }
    return out
  }

  /** Attachments are reachable only through the session, by streaming decrypted bytes (PROF-HIST-003). */
  public async open(
    session: Session,
    attachmentId: string
  ): Promise<{ bytes: Buffer; mimeType: string; filename?: string } | undefined> {
    const wantThumb = attachmentId.endsWith('.thumb')
    const baseId = wantThumb ? attachmentId.slice(0, -6) : attachmentId
    const pending = this.pendingUploads.get(baseId)
    let attachment = pending && pending.sessionId === session.id ? pending.attachment : undefined
    if (!attachment) {
      const principal = session.principalId ? await this.store.principals.get(session.principalId) : null
      const entries = await this.memory.history(principal ?? null, session, { limit: 500 })
      attachment = entries.flatMap((e) => e.attachments).find((a) => a.id === baseId)
      if (!attachment && principal?.identityAttributes.photoRef === baseId) {
        const photo = (principal.identityAttributes as { photo?: MessageAttachment }).photo
        if (photo) attachment = photo
      }
    }
    if (!attachment) return undefined
    if (wantThumb) {
      const keyRef = (attachment as MessageAttachment & { thumbnailKeyRef?: string }).thumbnailKeyRef
      if (!attachment.thumbnailBucketKey || !keyRef) return undefined
      return { bytes: await this.objects.get(attachment.thumbnailBucketKey, keyRef), mimeType: 'image/webp' }
    }
    return {
      bytes: await this.objects.get(attachment.bucketKey, attachment.objectKeyRef),
      mimeType: attachment.mimeType,
      filename: attachment.filename,
    }
  }

  public generatingFor(sessionId: string): GeneratingState[] {
    return [...this.generating.values()].filter((g) => g.sessionId === sessionId)
  }

  /** Event-driven, non-blocking generation; the artifact lands at its initiation time (MEDIA-GEN-001..004). */
  public startImageGeneration(
    principal: Principal,
    session: Session,
    prompt: string,
    providerName?: string
  ): { entryId: string } | { error: string } {
    const generator = providerName ? this.generators.get(providerName) : [...this.generators.values()][0]
    if (!generator) return { error: 'no image generation provider is configured' }
    const entryId = prefixedId('msg')
    const initiatedAt = nowIso()
    this.generating.set(entryId, { entryId, kind: 'image', startedAt: initiatedAt, sessionId: session.id })
    void this.router.deliver(session, { kind: 'generating', entryId, kindOf: 'image', startedAt: initiatedAt })
    void (async () => {
      try {
        const result = await generator.generate(prompt)
        const full = await this.objects.put(`sessions/${session.id}/generated`, result.image, result.mimeType)
        const thumb = await this.objects.put(`sessions/${session.id}/thumbs`, result.thumbnail, 'image/webp')
        const attachment: MessageAttachment & { thumbnailKeyRef?: string } = {
          id: prefixedId('att'),
          type: 'image',
          bucketKey: full.bucketKey,
          mimeType: result.mimeType,
          size: full.size,
          width: result.width,
          height: result.height,
          textRepr: prompt,
          objectKeyRef: full.objectKeyRef,
          refDigest: full.refDigest,
          thumbnailBucketKey: thumb.bucketKey,
          thumbnailId: `${prefixedId('att')}.thumb`,
          thumbnailKeyRef: thumb.objectKeyRef,
        }
        attachment.thumbnailId = `${attachment.id}.thumb`
        const entry = await this.memory.append({
          id: entryId,
          sessionId: session.id,
          principalId: principal.id,
          role: 'agent',
          sourceType: 'media',
          text: `Generated image: ${prompt}`,
          attachments: [attachment],
          backingIdentity: principal.backingIdentity,
          payload: { prompt, provider: generator.name },
          initiatedAt,
        })
        this.generating.delete(entryId)
        await this.router.deliver(session, { kind: 'media', entry })
      } catch (error) {
        this.generating.delete(entryId)
        this.logger.error({ err: error, sessionId: session.id }, 'image generation failed')
        const entry: MessageEntry = await this.memory.append({
          id: entryId,
          sessionId: session.id,
          principalId: principal.id,
          role: 'agent',
          sourceType: 'text',
          text: 'The image could not be generated.',
          backingIdentity: principal.backingIdentity,
          initiatedAt,
        })
        await this.router.deliver(session, { kind: 'text', entry })
      }
    })()
    return { entryId }
  }
}
