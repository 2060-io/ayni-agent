/**
 * The authenticator app and the passkey as the agent checks them (ayni-spec D129; IDENT-AUTH-012, IDENT-AUTH-013;
 * RFC 6238, WebAuthn): a TOTP code of the secret enrolled, at the current step or the one before or after, each code
 * once; a passkey created for the challenge and the relying party, used with the person present and verified, its
 * counter never going backwards. The keys are made here; nothing is fetched.
 */
import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotp,
  otpauthUri,
  totpCounter,
} from '../src/core/authentication/totp.js'
import { verifyAssertion, verifyRegistration } from '../src/core/authentication/webauthn.js'
import { makePasskey, RP } from './passkeyFixtures.js'

describe('the codes of an authenticator app (IDENT-AUTH-012, RFC 6238)', () => {
  // the secret of RFC 6238's appendix B, for SHA-1
  const secret = Buffer.from('12345678901234567890')

  it('gives the codes of RFC 6238, six digits', () => {
    expect(hotp(secret, totpCounter(59_000))).toBe('287082')
    expect(hotp(secret, totpCounter(1_111_111_109_000))).toBe('081804')
    expect(hotp(secret, totpCounter(2_000_000_000_000))).toBe('279037')
  })

  it('takes the code of the current step, the one before and the one after, each once', () => {
    const now = 1_111_111_109_000
    const counter = totpCounter(now)
    expect(matchTotp(secret, hotp(secret, counter), now)).toBe(counter)
    expect(matchTotp(secret, hotp(secret, counter - 1), now)).toBe(counter - 1)
    expect(matchTotp(secret, hotp(secret, counter + 1), now)).toBe(counter + 1)
    expect(matchTotp(secret, hotp(secret, counter - 2), now)).toBeUndefined()
    // a code taken is not taken again, nor one before it
    expect(matchTotp(secret, hotp(secret, counter), now, counter)).toBeUndefined()
    expect(matchTotp(secret, hotp(secret, counter - 1), now, counter)).toBeUndefined()
    expect(matchTotp(secret, 'abcdef', now)).toBeUndefined()
  })

  it('writes the secret in base32 and the otpauth link that opens the app', () => {
    expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toEqual(secret)
    const uri = otpauthUri(secret, 'Ayni Dev Agent', 'Ana Ríos')
    expect(uri.startsWith('otpauth://totp/Ayni%20Dev%20Agent:Ana%20R%C3%ADos?')).toBe(true)
    expect(new URL(uri).searchParams.get('secret')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(new URL(uri).searchParams.get('digits')).toBe('6')
    expect(new URL(uri).searchParams.get('period')).toBe('30')
  })
})

describe('a passkey (IDENT-AUTH-013, flow profile §6.4)', () => {
  it('keeps the key of a passkey created for the challenge and the relying party, with the person verified', () => {
    const passkey = makePasskey()
    const made = verifyRegistration({ attestation: passkey.attestation('c-1'), challenge: 'c-1', rpId: RP })
    expect(made).toMatchObject({ ok: true, passkey: { credentialId: passkey.id, alg: -7, signCount: 0 } })
    // another challenge, another relying party, the person not verified, the wrong ceremony
    expect(verifyRegistration({ attestation: passkey.attestation('c-2'), challenge: 'c-1', rpId: RP }).ok).toBe(false)
    expect(
      verifyRegistration({
        attestation: passkey.attestation('c-1', { rpId: 'evil.example' }),
        challenge: 'c-1',
        rpId: RP,
      }).ok
    ).toBe(false)
    expect(
      verifyRegistration({ attestation: passkey.attestation('c-1', { flags: 0x41 }), challenge: 'c-1', rpId: RP }).ok
    ).toBe(false)
    expect(
      verifyRegistration({
        attestation: passkey.attestation('c-1', { type: 'webauthn.get' }),
        challenge: 'c-1',
        rpId: RP,
      }).ok
    ).toBe(false)
  })

  it('accepts an assertion of the key enrolled only over the challenge, for the relying party, its counter going on', () => {
    const passkey = makePasskey()
    const made = verifyRegistration({ attestation: passkey.attestation('c-1'), challenge: 'c-1', rpId: RP })
    if (!made.ok) throw new Error(made.reason)
    const stored = made.passkey
    expect(
      verifyAssertion({ passkey: stored, assertion: passkey.assertion('s-1'), challenge: 's-1', rpId: RP })
    ).toEqual({
      ok: true,
      signCount: 1,
    })
    // over another challenge, for another relying party, the person not verified
    expect(
      verifyAssertion({ passkey: stored, assertion: passkey.assertion('s-2'), challenge: 's-1', rpId: RP }).ok
    ).toBe(false)
    expect(
      verifyAssertion({
        passkey: stored,
        assertion: passkey.assertion('s-1', { rpId: 'app.ayni.org' }),
        challenge: 's-1',
        rpId: RP,
      }).ok
    ).toBe(false)
    expect(
      verifyAssertion({
        passkey: stored,
        assertion: passkey.assertion('s-1', { flags: 0x01 }),
        challenge: 's-1',
        rpId: RP,
      }).ok
    ).toBe(false)
    // a counter that goes backwards: a cloned authenticator
    const used = { ...stored, signCount: 5 }
    expect(
      verifyAssertion({ passkey: used, assertion: passkey.assertion('s-1', { count: 3 }), challenge: 's-1', rpId: RP })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/backwards/) })
    // another passkey's signature
    const other = makePasskey()
    const forged = { ...other.assertion('s-1'), id: passkey.id }
    expect(verifyAssertion({ passkey: stored, assertion: forged, challenge: 's-1', rpId: RP }).ok).toBe(false)
  })
})
