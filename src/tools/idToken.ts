/**
 * The check of an account by the ID token of its sign-in (ayni-spec D118; TOOL-OAUTH-016): the token validated as OpenID
 * Connect Core 1.0 §3.1.3.7 says (its signature by a key of the issuer's `jwks_uri`, `iss`, `aud`, `exp`, `nonce`), then
 * the person it names checked against their directory entry (`email_verified`, `email`, and `hd` where the agent-pack names
 * the organization's domain). A failure of the token is `failed`; a token of someone else is `wrong-person`.
 *
 * Nothing here logs, and no answer carries, the token or a claim of it: a refusal is named by what failed only.
 */
import { createPublicKey, type JsonWebKeyInput, timingSafeEqual, verify } from 'node:crypto'

type JsonWebKey = JsonWebKeyInput['key']

/** The algorithms of an ID token the agent verifies: RSA and ECDSA with SHA-256; never `none`, never a shared secret. */
const ALGORITHMS: Record<string, { hash: string; kty: string; dsaEncoding?: 'ieee-p1363' }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  ES256: { hash: 'sha256', kty: 'EC', dsaEncoding: 'ieee-p1363' },
}

/** A key of a JSON Web Key Set (RFC 7517), as far as the agent reads it. */
export interface Jwk extends JsonWebKey {
  kid?: string
  use?: string
  alg?: string
  kty?: string
}

/** The claims the agent reads of a valid ID token. */
export interface IdTokenClaims {
  iss: string
  aud: string | string[]
  azp?: string
  exp: number
  nonce?: string
  email?: string
  email_verified?: boolean
  hd?: string
}

export type IdTokenCheck =
  | { ok: true; email: string }
  /** `why` names what failed, never a value of the token */
  | { ok: false; outcome: 'failed' | 'wrong-person'; why: string }

export interface IdTokenExpected {
  issuer: string
  clientId: string
  nonce: string
  /** the algorithms the issuer's metadata says it signs with, when it says */
  algorithms?: string[]
  /** the keys of the issuer's `jwks_uri`; `fresh` reads them again, for a key the cached set does not hold */
  keys: (fresh: boolean) => Promise<Jwk[]>
  now?: () => number
}

function decode(part: string | undefined): Record<string, unknown> | undefined {
  if (!part) return undefined
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The ID token validated as OpenID Connect Core §3.1.3.7 says (TOOL-OAUTH-016): signed with a key of the issuer's
 * `jwks_uri` by an algorithm it allows, `iss` the issuer exactly, `aud` the client alone (and `azp`, when present, the
 * client), `exp` not passed, `nonce` the attempt's. Any failure is `failed`.
 */
export async function validateIdToken(
  token: string,
  expected: IdTokenExpected
): Promise<{ ok: true; claims: IdTokenClaims } | { ok: false; outcome: 'failed'; why: string }> {
  const failed = (why: string) => ({ ok: false as const, outcome: 'failed' as const, why })
  const parts = token.split('.')
  if (parts.length !== 3) return failed('not a signed token')
  const header = decode(parts[0])
  const payload = decode(parts[1])
  if (!header || !payload) return failed('not a signed token')
  const alg = typeof header.alg === 'string' ? header.alg : ''
  const algorithm = ALGORITHMS[alg]
  if (!algorithm || (expected.algorithms && !expected.algorithms.includes(alg))) return failed('algorithm')
  const kid = typeof header.kid === 'string' ? header.kid : undefined
  const pick = (keys: Jwk[]) =>
    keys.filter(
      (k) =>
        k.kty === algorithm.kty &&
        (k.use === undefined || k.use === 'sig') &&
        (k.alg === undefined || k.alg === alg) &&
        (kid === undefined || k.kid === kid)
    )
  let candidates: Jwk[]
  try {
    candidates = pick(await expected.keys(false))
    // a key the issuer rotated in since the set was read: read it once more
    if (!candidates.length) candidates = pick(await expected.keys(true))
  } catch {
    return failed('keys')
  }
  if (!candidates.length || (kid === undefined && candidates.length > 1)) return failed('signature')
  const data = Buffer.from(`${parts[0]}.${parts[1]}`)
  const signature = Buffer.from(parts[2] as string, 'base64url')
  let signed = false
  try {
    const key = createPublicKey({ key: candidates[0] as JsonWebKey, format: 'jwk' })
    signed = verify(
      algorithm.hash,
      data,
      algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key,
      signature
    )
  } catch {
    signed = false
  }
  if (!signed) return failed('signature')
  const claims = payload as unknown as IdTokenClaims
  if (typeof claims.iss !== 'string' || claims.iss !== expected.issuer) return failed('issuer')
  // the client alone is the audience; another audience beside it is one the agent does not trust (§3.1.3.7, 3 to 5)
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (audiences.length !== 1 || audiences[0] !== expected.clientId) return failed('audience')
  if (claims.azp !== undefined && claims.azp !== expected.clientId) return failed('audience')
  const now = Math.floor((expected.now?.() ?? Date.now()) / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) return failed('expired')
  if (typeof claims.nonce !== 'string' || !sameText(claims.nonce, expected.nonce)) return failed('nonce')
  return { ok: true, claims }
}

/**
 * The person an ID token names, against their directory entry (TOOL-OAUTH-016): `email_verified` true and `email`, in
 * lower case, equal to the entry's; with the agent-pack's `hostedDomain`, `hd` equal to it. Otherwise `wrong-person`, as
 * for a person with no entry.
 */
export function checkPerson(
  claims: IdTokenClaims,
  person: { email: string | undefined; hostedDomain?: string }
): IdTokenCheck {
  const wrong = (why: string) => ({ ok: false as const, outcome: 'wrong-person' as const, why })
  if (!person.email) return wrong('no directory entry')
  if (claims.email_verified !== true) return wrong('email not verified')
  if (typeof claims.email !== 'string' || claims.email.toLowerCase() !== person.email.toLowerCase())
    return wrong('another email')
  if (person.hostedDomain !== undefined && claims.hd !== person.hostedDomain) return wrong('another domain')
  return { ok: true, email: claims.email.toLowerCase() }
}
