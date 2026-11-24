/**
 * What a person enrolled with the agent (ayni-spec D129, IDENT-AUTH-012 to 014): at most one authenticator app and one
 * passkey per Principal, the new one replacing the earlier. The authenticator app's secret is kept sealed and never
 * returned after its enrolment; of a passkey the agent keeps its credential id, its public key and its counter, never a
 * private key. Both are removed by the person from the phone (`unenrol`) and erased with the Principal's entry when it
 * leaves the directory (IDENT-ROLE-013).
 *
 * Kept in the key-value store, sealed under a key of their own (D77): `enrol:<principal>` holds the record, and
 * `passkey:<keyed index of the credential id>` the Principal a passkey identifies (IDENT-AUTH-004), so that the store holds
 * neither id in the clear.
 */
import type { EnrollableMethodType } from '../../config/packTypes.js'
import { type EntryCrypto, openJson, sealJson } from '../../memory/crypto.js'
import type { KvRepo } from '../../store/types.js'
import { nowIso } from '../../util/ids.js'
import type { StoredPasskey } from './webauthn.js'

export interface EnrolledAuthenticatorApp {
  at: string
  /** base32 */
  secret: string
  /** the step of the last code taken: a code is taken once (IDENT-AUTH-012) */
  lastCounter?: number
}

export type EnrolledPasskey = StoredPasskey & { at: string }

export interface Enrolled {
  'authenticator-app'?: EnrolledAuthenticatorApp
  passkey?: EnrolledPasskey
}

const RECORD = 'enrol:'
const PASSKEY = 'passkey:'

export class EnrolmentStore {
  public constructor(
    private readonly kv: KvRepo,
    private readonly crypto: EntryCrypto
  ) {}

  public async get(principalId: string): Promise<Enrolled> {
    const raw = await this.kv.get(RECORD + principalId)
    if (!raw) return {}
    const { keyRef, cipher } = JSON.parse(raw) as { keyRef: string; cipher: string }
    return openJson<Enrolled>(this.crypto, keyRef, Buffer.from(cipher, 'base64'))
  }

  /** The types a Principal enrolled, in the order of the profile (`authentication.enrolled`, IDENT-STAT-002). */
  public async types(principalId: string): Promise<{ type: EnrollableMethodType; at: string }[]> {
    const enrolled = await this.get(principalId)
    return (['authenticator-app', 'passkey'] as const).flatMap((type) => {
      const at = enrolled[type]?.at
      return at ? [{ type, at }] : []
    })
  }

  public async setAuthenticatorApp(principalId: string, secret: string): Promise<void> {
    const enrolled = await this.get(principalId)
    await this.save(principalId, { ...enrolled, 'authenticator-app': { at: nowIso(), secret } })
  }

  public async setPasskey(principalId: string, passkey: StoredPasskey): Promise<void> {
    const enrolled = await this.get(principalId)
    if (enrolled.passkey) await this.kv.delete(this.passkeyKey(enrolled.passkey.credentialId))
    await this.save(principalId, { ...enrolled, passkey: { ...passkey, at: nowIso() } })
    await this.kv.set(this.passkeyKey(passkey.credentialId), principalId)
  }

  /** The step of a code just taken, so that it is not taken again. */
  public async usedCode(principalId: string, counter: number): Promise<void> {
    const enrolled = await this.get(principalId)
    const app = enrolled['authenticator-app']
    if (!app) return
    await this.save(principalId, { ...enrolled, 'authenticator-app': { ...app, lastCounter: counter } })
  }

  /** The counter of a passkey just used (IDENT-AUTH-013). */
  public async usedPasskey(principalId: string, signCount: number): Promise<void> {
    const enrolled = await this.get(principalId)
    if (!enrolled.passkey) return
    await this.save(principalId, { ...enrolled, passkey: { ...enrolled.passkey, signCount } })
  }

  /** The Principal a passkey was enrolled for, by its credential id. */
  public async principalOfPasskey(credentialId: string): Promise<string | undefined> {
    return (await this.kv.get(this.passkeyKey(credentialId))) || undefined
  }

  /** Removes one type (`unenrol`, flow profile §6.4); false when the Principal had not enrolled it. */
  public async remove(principalId: string, type: EnrollableMethodType): Promise<boolean> {
    const enrolled = await this.get(principalId)
    if (!enrolled[type]) return false
    if (type === 'passkey' && enrolled.passkey) await this.kv.delete(this.passkeyKey(enrolled.passkey.credentialId))
    const { [type]: _removed, ...rest } = enrolled
    await this.save(principalId, rest)
    return true
  }

  /** Erases both (IDENT-AUTH-014: they end with the Principal's entry). */
  public async erase(principalId: string): Promise<void> {
    const enrolled = await this.get(principalId)
    if (enrolled.passkey) await this.kv.delete(this.passkeyKey(enrolled.passkey.credentialId))
    await this.kv.delete(RECORD + principalId)
  }

  private passkeyKey(credentialId: string): string {
    return PASSKEY + this.crypto.blindIndex(`passkey\n${credentialId}`)
  }

  private async save(principalId: string, enrolled: Enrolled): Promise<void> {
    if (!enrolled['authenticator-app'] && !enrolled.passkey) {
      await this.kv.delete(RECORD + principalId)
      return
    }
    const keyRef = this.crypto.newWrappedKey()
    const { cipher } = sealJson(this.crypto, keyRef, enrolled)
    await this.kv.set(RECORD + principalId, JSON.stringify({ keyRef, cipher: cipher.toString('base64') }))
  }
}
