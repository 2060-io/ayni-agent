/**
 * Passkeys (ayni-spec D129, IDENT-AUTH-013, IDENT-AUTH-014; flow profile §6.4, §6.14; WebAuthn Level 2): what the agent
 * checks of a passkey's creation (the attestation of an `enrol-answer`) and of its use (the assertion of a step's
 * `answer`). The relying party is the network's app-link domain, which the Ayni app is associated with (CC-WEB-003); the
 * agent keeps the credential id and the public key, never a private key.
 *
 * The attestation statement is not verified: the agent trusts the phone that created the passkey as it trusts the
 * connection it came on (the `none` attestation the platforms give), and binds the key to the Principal that the
 * authentication before the enrolment identified. The origin of the client data is not compared: a native app writes
 * its own (an `android:apk-key-hash:` origin on Android), and the relying party's hash in the authenticator data is
 * what ties the key to the domain.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

/** A public key as a JSON web key: EC P-256, OKP Ed25519 or RSA. */
export interface PublicJwk {
  kty: string
  crv?: string
  x?: string
  y?: string
  n?: string
  e?: string
}

/** The algorithms of a passkey the agent takes, in the order it offers them: ES256, EdDSA, RS256. */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const

/** A passkey as the agent keeps it once enrolled. */
export interface StoredPasskey {
  /** base64url, the id the assertion names */
  credentialId: string
  publicKey: PublicJwk
  alg: number
  signCount: number
}

export type CheckResult<T> = ({ ok: true } & T) | { ok: false; reason: string }

const b64u = (text: string): Buffer => Buffer.from(text, 'base64url')
const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest()

// ---- CBOR, as much as a WebAuthn object holds (RFC 8949) ---------------------------------------------------------------

type Cbor = number | bigint | Buffer | string | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>

/** Decodes one CBOR item at `offset`; returns it and where the next one starts. */
export function decodeCbor(data: Buffer, offset = 0): { value: Cbor; next: number } {
  if (offset >= data.length) throw new Error('cbor: truncated')
  const initial = data[offset]
  const major = initial >> 5
  const info = initial & 0x1f
  let pos = offset + 1
  const readLength = (): number => {
    if (info < 24) return info
    if (info === 24) return data[pos++]
    if (info === 25) {
      const v = data.readUInt16BE(pos)
      pos += 2
      return v
    }
    if (info === 26) {
      const v = data.readUInt32BE(pos)
      pos += 4
      return v
    }
    if (info === 27) {
      const v = data.readBigUInt64BE(pos)
      pos += 8
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: length too large')
      return Number(v)
    }
    throw new Error('cbor: indefinite lengths are not taken')
  }
  switch (major) {
    case 0:
      return { value: readLength(), next: pos }
    case 1:
      return { value: -1 - readLength(), next: pos }
    case 2: {
      const length = readLength()
      if (pos + length > data.length) throw new Error('cbor: truncated')
      return { value: data.subarray(pos, pos + length), next: pos + length }
    }
    case 3: {
      const length = readLength()
      if (pos + length > data.length) throw new Error('cbor: truncated')
      return { value: data.subarray(pos, pos + length).toString('utf8'), next: pos + length }
    }
    case 4: {
      const length = readLength()
      const items: Cbor[] = []
      for (let i = 0; i < length; i++) {
        const item = decodeCbor(data, pos)
        items.push(item.value)
        pos = item.next
      }
      return { value: items, next: pos }
    }
    case 5: {
      const length = readLength()
      const map = new Map<Cbor, Cbor>()
      for (let i = 0; i < length; i++) {
        const key = decodeCbor(data, pos)
        const value = decodeCbor(data, key.next)
        map.set(key.value, value.value)
        pos = value.next
      }
      return { value: map, next: pos }
    }
    case 7:
      if (info === 20) return { value: false, next: pos }
      if (info === 21) return { value: true, next: pos }
      if (info === 22) return { value: null, next: pos }
      if (info === 23) return { value: undefined, next: pos }
      throw new Error('cbor: floats and other simple values are not taken')
    default:
      throw new Error('cbor: tags are not taken')
  }
}

// ---- the authenticator data (WebAuthn §6.1) ----------------------------------------------------------------------------

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

export interface AuthenticatorData {
  rpIdHash: Buffer
  flags: number
  signCount: number
  credential?: { id: Buffer; publicKey: Map<Cbor, Cbor> }
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) throw new Error('authenticator data too short')
  const flags = data[32]
  const out: AuthenticatorData = { rpIdHash: data.subarray(0, 32), flags, signCount: data.readUInt32BE(33) }
  if (flags & FLAG_AT) {
    let pos = 37 + 16
    const length = data.readUInt16BE(pos)
    pos += 2
    const id = data.subarray(pos, pos + length)
    pos += length
    const key = decodeCbor(data, pos).value
    if (!(key instanceof Map)) throw new Error('the credential public key is not a COSE key')
    out.credential = { id, publicKey: key }
  }
  return out
}

/** A COSE key (RFC 9053) as a JSON web key, with its algorithm: EC2 P-256, OKP Ed25519 or RSA. */
export function coseToJwk(cose: Map<Cbor, Cbor>): { jwk: PublicJwk; alg: number } {
  const kty = cose.get(1)
  const alg = Number(cose.get(3))
  const bytes = (label: number): string => {
    const v = cose.get(label)
    if (!Buffer.isBuffer(v)) throw new Error(`COSE key: ${label} is missing`)
    return v.toString('base64url')
  }
  if (kty === 2 && cose.get(-1) === 1 && alg === -7)
    return { jwk: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) }, alg }
  if (kty === 1 && cose.get(-1) === 6 && alg === -8) return { jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) }, alg }
  if (kty === 3 && alg === -257) return { jwk: { kty: 'RSA', n: bytes(-1), e: bytes(-2) }, alg }
  throw new Error(`COSE key of type ${String(kty)} and algorithm ${alg} is not taken`)
}

interface ClientData {
  type?: string
  challenge?: string
  origin?: string
}

function clientDataOf(
  encoded: string,
  type: 'webauthn.create' | 'webauthn.get',
  challenge: string
): ClientData | string {
  let data: ClientData
  try {
    data = JSON.parse(b64u(encoded).toString('utf8')) as ClientData
  } catch {
    return 'the client data is not JSON'
  }
  if (data.type !== type) return `the client data is of type ${String(data.type)}, not ${type}`
  if (data.challenge !== challenge) return 'the client data signs another challenge'
  return data
}

function checkFlags(auth: AuthenticatorData, rpId: string): string | undefined {
  if (!auth.rpIdHash.equals(sha256(rpId))) return 'the authenticator data is for another relying party'
  if (!(auth.flags & FLAG_UP)) return 'the user was not present'
  if (!(auth.flags & FLAG_UV)) return 'the user was not verified'
  return undefined
}

/**
 * A passkey's creation, from the `enrol-answer` (flow profile §6.4): made for the challenge the agent sent, for the
 * relying party of the network's app-link domain, with the person present and verified. Gives what the agent keeps.
 */
export function verifyRegistration(input: {
  attestation: { id: string; clientDataJson: string; attestationObject: string }
  challenge: string
  rpId: string
}): CheckResult<{ passkey: StoredPasskey }> {
  try {
    const client = clientDataOf(input.attestation.clientDataJson, 'webauthn.create', input.challenge)
    if (typeof client === 'string') return { ok: false, reason: client }
    const object = decodeCbor(b64u(input.attestation.attestationObject)).value
    if (!(object instanceof Map)) return { ok: false, reason: 'the attestation object is not a map' }
    const authData = object.get('authData')
    if (!Buffer.isBuffer(authData)) return { ok: false, reason: 'the attestation object holds no authenticator data' }
    const auth = parseAuthenticatorData(authData)
    const flags = checkFlags(auth, input.rpId)
    if (flags) return { ok: false, reason: flags }
    if (!auth.credential) return { ok: false, reason: 'the authenticator data holds no credential' }
    const credentialId = auth.credential.id.toString('base64url')
    if (credentialId !== input.attestation.id) return { ok: false, reason: 'the id is not the credential created' }
    const { jwk, alg } = coseToJwk(auth.credential.publicKey)
    // the key must load: a key that does not is refused now, not at its first use
    createPublicKey({ key: { ...jwk }, format: 'jwk' })
    return { ok: true, passkey: { credentialId, publicKey: jwk, alg, signCount: auth.signCount } }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the attestation does not decode' }
  }
}

/**
 * A passkey's use, from a step's `answer` (IDENT-AUTH-013): signed by the key enrolled, over the challenge of the step,
 * for the relying party of the network's app-link domain, the person present and verified, and a signature counter that
 * does not go backwards when the authenticator counts. Gives the counter to keep.
 */
export function verifyAssertion(input: {
  passkey: StoredPasskey
  assertion: { id: string; clientDataJson: string; authenticatorData: string; signature: string }
  challenge: string
  rpId: string
}): CheckResult<{ signCount: number }> {
  try {
    if (input.assertion.id !== input.passkey.credentialId) return { ok: false, reason: 'another passkey' }
    const client = clientDataOf(input.assertion.clientDataJson, 'webauthn.get', input.challenge)
    if (typeof client === 'string') return { ok: false, reason: client }
    const authData = b64u(input.assertion.authenticatorData)
    const auth = parseAuthenticatorData(authData)
    const flags = checkFlags(auth, input.rpId)
    if (flags) return { ok: false, reason: flags }
    const signed = Buffer.concat([authData, sha256(b64u(input.assertion.clientDataJson))])
    const key = createPublicKey({ key: { ...input.passkey.publicKey }, format: 'jwk' })
    const signature = b64u(input.assertion.signature)
    const valid =
      input.passkey.alg === -8
        ? verify(null, signed, key, signature)
        : input.passkey.alg === -7
          ? verify('sha256', signed, { key, dsaEncoding: 'der' }, signature)
          : verify('sha256', signed, key, signature)
    if (!valid) return { ok: false, reason: 'the signature does not verify' }
    // a counter that does not count stays at zero; one that counts must go forward (WebAuthn §6.1.1)
    if ((auth.signCount !== 0 || input.passkey.signCount !== 0) && auth.signCount <= input.passkey.signCount)
      return { ok: false, reason: 'the signature counter went backwards: the passkey may be cloned' }
    return { ok: true, signCount: auth.signCount }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the assertion does not decode' }
  }
}
