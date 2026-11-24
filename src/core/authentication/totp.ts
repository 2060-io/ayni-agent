/**
 * The one-time codes of an authenticator app (ayni-spec D129, IDENT-AUTH-012; RFC 6238, RFC 4226): six digits, a step of
 * thirty seconds, HMAC-SHA-1, the secret twenty random bytes written in base32 for the person's authenticator app.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const TOTP_DIGITS = 6
export const TOTP_PERIOD_SECONDS = 30
/** The steps around the current one whose code is still taken: the one before and the one after. */
export const TOTP_WINDOW = 1

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, without padding: how an authenticator app takes a secret. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('not a base32 text')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new secret: twenty bytes from a secure generator, the size of HMAC-SHA-1's output (RFC 4226 §4). */
export function newTotpSecret(): Buffer {
  return randomBytes(20)
}

/** The step of a time: the counter of RFC 6238. */
export function totpCounter(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS)
}

/** The code of a counter (RFC 4226 §5.3, dynamic truncation). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/**
 * The counter of the step whose code this is, at the current step or the one before or after, and after `lastCounter`,
 * the step of the last code taken: a code is taken once (IDENT-AUTH-012). Undefined when it is no such code.
 */
export function matchTotp(secret: Buffer, code: string, atMs: number, lastCounter?: number): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined
  const now = totpCounter(atMs)
  for (let counter = now - TOTP_WINDOW; counter <= now + TOTP_WINDOW; counter++) {
    if (lastCounter !== undefined && counter <= lastCounter) continue
    const expected = Buffer.from(hotp(secret, counter))
    if (timingSafeEqual(expected, Buffer.from(code))) return counter
  }
  return undefined
}

/**
 * The `otpauth://` link that opens the person's authenticator app on the phone (flow profile §6.4): the issuer is the
 * agent's name, the account the person's.
 */
export function otpauthUri(secret: Buffer, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const query = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${query.toString()}`
}
