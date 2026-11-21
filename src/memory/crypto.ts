/**
 * Per-entry keys wrapped by the deployment master key (D19, PRIV-ERASE-001/002).
 * Digest = SHA-256 over ciphertext. Crypto-erasure destroys the wrapped key only.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'

export interface EntryCrypto {
  /** returns the wrapped key reference to persist with the record */
  newWrappedKey(): string
  encrypt(wrappedKey: string, plaintext: Buffer): Buffer
  decrypt(wrappedKey: string, ciphertext: Buffer): Buffer
  /**
   * A keyed index of a value, under a key derived from the master key: the store finds a record by it without
   * holding the value (a preference by its name, D77). Equal values give equal indexes; without the master key an
   * index tells nothing of the value, not even of a short or common one.
   */
  blindIndex(value: string): string
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
  const indexKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'ayni-agent blind index', 32))
  return {
    blindIndex: (value) => createHmac('sha256', indexKey).update(value, 'utf8').digest('hex'),
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

/**
 * A key of its own under another key (D106, PRIV-ERASE-013): each person's key, wrapped by the master key, wraps the key of
 * each of their accounts. The account's key is 32 random bytes sealed under the person's key; destroying the person's
 * key makes every key it wraps, and so every account of theirs, unreadable at once, with or without the master key.
 */
export function newKeyUnder(crypto: EntryCrypto, parentWrapped: string): string {
  return crypto.encrypt(parentWrapped, randomBytes(32)).toString('base64')
}

/** Seals a value under a key wrapped by another key (D106): the person's key opens the account's, which seals the value. */
export function sealUnder(crypto: EntryCrypto, parentWrapped: string, childWrapped: string, value: unknown): Buffer {
  const key = crypto.decrypt(parentWrapped, Buffer.from(childWrapped, 'base64'))
  return seal(key, Buffer.from(JSON.stringify(value), 'utf8'))
}

/** Opens what `sealUnder` sealed: throws when either key is gone or wrong. */
export function openUnder<T>(crypto: EntryCrypto, parentWrapped: string, childWrapped: string, cipher: Buffer): T {
  const key = crypto.decrypt(parentWrapped, Buffer.from(childWrapped, 'base64'))
  return JSON.parse(open(key, cipher).toString('utf8')) as T
}
