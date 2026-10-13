/**
 * Object store (D23, MEM-ATT-004/005, MEDIA-REF-001): objects are encrypted with a per-object key
 * before upload and addressed by bucket/key; the agent streams decrypted bytes on demand. The
 * per-object key is persisted with the attachment metadata (wrapped), never in the LLM context.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { Env } from '../config/env.js'
import { type EntryCrypto, sha256Hex } from '../memory/crypto.js'
import { prefixedId } from '../util/ids.js'

export interface StoredObject {
  bucketKey: string
  objectKeyRef: string
  refDigest: string
  size: number
}

export interface ObjectStore {
  put(prefix: string, bytes: Buffer, mimeType: string): Promise<StoredObject>
  get(bucketKey: string, objectKeyRef: string): Promise<Buffer>
  delete(bucketKey: string): Promise<void>
  list(prefix?: string): Promise<{ key: string; lastModified?: Date }[]>
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client
  private readonly bucket: string

  public constructor(
    config: NonNullable<Env['objectStore']>,
    private readonly crypto: EntryCrypto
  ) {
    this.bucket = config.bucket
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    })
  }

  /** Creates the bucket when it does not exist yet (local stacks). */
  public async init(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
    }
  }

  public async put(prefix: string, bytes: Buffer, mimeType: string): Promise<StoredObject> {
    const objectKeyRef = this.crypto.newWrappedKey()
    const sealed = this.crypto.encrypt(objectKeyRef, bytes)
    const key = `${prefix}/${prefixedId('obj', 16)}`
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: sealed,
        ContentType: 'application/octet-stream',
        Metadata: { 'plain-type': mimeType },
      })
    )
    return { bucketKey: `${this.bucket}/${key}`, objectKeyRef, refDigest: sha256Hex(bytes), size: bytes.length }
  }

  public async get(bucketKey: string, objectKeyRef: string): Promise<Buffer> {
    const key = bucketKey.slice(this.bucket.length + 1)
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    const sealed = Buffer.from((await response.Body?.transformToByteArray()) ?? new Uint8Array())
    return this.crypto.decrypt(objectKeyRef, sealed)
  }

  public async delete(bucketKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: bucketKey.slice(this.bucket.length + 1) })
    )
  }

  public async list(prefix?: string): Promise<{ key: string; lastModified?: Date }[]> {
    const out: { key: string; lastModified?: Date }[] = []
    let token: string | undefined
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      for (const o of page.Contents ?? [])
        if (o.Key) out.push({ key: `${this.bucket}/${o.Key}`, lastModified: o.LastModified })
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return out
  }
}

/** In-memory object store for tests and the quick start. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { sealed: Buffer; at: Date }>()
  public constructor(
    private readonly crypto: EntryCrypto,
    private readonly bucket = 'memory'
  ) {}
  public async put(prefix: string, bytes: Buffer): Promise<StoredObject> {
    const objectKeyRef = this.crypto.newWrappedKey()
    const key = `${this.bucket}/${prefix}/${prefixedId('obj', 16)}`
    this.objects.set(key, { sealed: this.crypto.encrypt(objectKeyRef, bytes), at: new Date() })
    return { bucketKey: key, objectKeyRef, refDigest: sha256Hex(bytes), size: bytes.length }
  }
  public async get(bucketKey: string, objectKeyRef: string): Promise<Buffer> {
    const o = this.objects.get(bucketKey)
    if (!o) throw new Error(`object ${bucketKey} not found`)
    return this.crypto.decrypt(objectKeyRef, o.sealed)
  }
  public async delete(bucketKey: string): Promise<void> {
    this.objects.delete(bucketKey)
  }
  public async list(prefix?: string) {
    return [...this.objects.entries()]
      .filter(([k]) => !prefix || k.startsWith(`${this.bucket}/${prefix}`))
      .map(([key, v]) => ({ key, lastModified: v.at }))
  }
}
