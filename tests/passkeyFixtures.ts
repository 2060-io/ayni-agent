/** A passkey of an authenticator, made in the test: its creation and its assertions (WebAuthn), no device involved. */
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

/** A CBOR encoder of what a WebAuthn object holds: maps, texts, bytes, small and negative integers. */
export function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255])
    const b = Buffer.alloc(5)
    b[0] = (major << 5) | 26
    b.writeUInt32BE(n, 1)
    return b
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (value instanceof Map)
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
  throw new Error('not encoded')
}

export const RP = 'app.dev.ayni.org'
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest()
const b64u = (data: Buffer | string) => Buffer.from(data).toString('base64url')

/** A passkey of an authenticator: a P-256 key, its credential id, and what it signs. */
export function makePasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const id = Buffer.from('credential-id-of-the-test')
  const cose = new Map<number, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ])
  const authData = (flags: number, count: number, rpId = RP, withCredential = false) => {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(count)
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), counter]
    if (withCredential) {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(id.length)
      parts.push(Buffer.alloc(16), length, id, cbor(cose))
    }
    return Buffer.concat(parts)
  }
  return {
    id: b64u(id),
    privateKey: privateKey as KeyObject,
    /** the `enrol-answer` of the passkey's creation (flow profile §6.4) */
    attestation(challenge: string, options: { rpId?: string; flags?: number; type?: string } = {}) {
      const clientData = JSON.stringify({
        type: options.type ?? 'webauthn.create',
        challenge,
        origin: 'android:apk-key-hash:x',
      })
      const object = cbor(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData(options.flags ?? 0x45, 0, options.rpId ?? RP, true)],
        ])
      )
      return { id: b64u(id), clientDataJson: b64u(clientData), attestationObject: b64u(object) }
    },
    /** a step's `answer` with the passkey's assertion (flow profile §6.14) */
    assertion(challenge: string, options: { rpId?: string; flags?: number; count?: number } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'ios:bundle-id:x' }))
      const data = authData(options.flags ?? 0x05, options.count ?? 1, options.rpId ?? RP)
      const signature = sign('sha256', Buffer.concat([data, sha256(clientData)]), {
        key: privateKey,
        dsaEncoding: 'der',
      })
      return {
        id: b64u(id),
        clientDataJson: b64u(clientData),
        authenticatorData: b64u(data),
        signature: b64u(signature),
        userHandle: null,
      }
    },
  }
}
