/**
 * Per-entry keys wrapped by the deployment master key (D19, PRIV-ERASE-001/002).
 * Digest = SHA-256 over ciphertext. Crypto-erasure destroys the wrapped key only.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'

export interface EntryCrypto {
  /** returns the wrapped key reference to persist with the record */
  newWrappedKey(): string
  encrypt(wrappedKey: string, plaintext: Buffer): Buffer
  decrypt(wrappedKey: string, ciphertext: Buffer): Buffer
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function seal(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALG, key, iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

function open(key: Buffer, sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, 12)
  const tag = sealed.subarray(12, 28)
  const body = sealed.subarray(28)
  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export function createEntryCrypto(masterKey: Buffer): EntryCrypto {
  if (masterKey.length !== 32) throw new Error('master key must be 32 bytes')
  return {
    newWrappedKey: () => seal(masterKey, randomBytes(32)).toString('base64'),
    encrypt: (wrappedKey, plaintext) => seal(open(masterKey, Buffer.from(wrappedKey, 'base64')), plaintext),
    decrypt: (wrappedKey, ciphertext) => open(open(masterKey, Buffer.from(wrappedKey, 'base64')), ciphertext),
  }
}

export interface SealedPayload {
  cipher: Buffer
  digest: string
}

export function sealJson(crypto: EntryCrypto, wrappedKey: string, value: unknown): SealedPayload {
  const cipher = crypto.encrypt(wrappedKey, Buffer.from(JSON.stringify(value), 'utf8'))
  return { cipher, digest: sha256Hex(cipher) }
}

export function openJson<T>(crypto: EntryCrypto, wrappedKey: string, cipher: Buffer): T {
  return JSON.parse(crypto.decrypt(wrappedKey, cipher).toString('utf8')) as T
}
