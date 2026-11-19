/**
 * Working-memory notes and preferences, sealed (D77, PRIV-ERASE-009): the store keeps a note's content, and a
 * preference's name and value, only as ciphertext under a key of their own. In the clear stay what the scope
 * predicate and the erasure cascade compare: the owner, the visibility, the state, the lineage of a note, the dates.
 * A preference is found by a keyed index of its name (EntryCrypto.blindIndex), never by the name itself. The memory
 * service reads and writes both in the clear through these repositories.
 */
import type { PrincipalPreference, WorkingMemoryNote } from '../core/types.js'
import type { PreferenceRepo, WorkingMemoryRepo } from '../store/types.js'
import { type EntryCrypto, openJson, sealJson } from './crypto.js'

interface SealedPreference {
  key: string
  value: string
}

export interface SealedNotes extends WorkingMemoryRepo {
  /** Seals what an earlier version kept in the clear; returns how many it sealed. */
  sealPlain(): Promise<number>
}

export interface SealedPreferences extends PreferenceRepo {
  /** Seals what an earlier version kept in the clear; returns how many it sealed. */
  sealPlain(): Promise<number>
}

export function sealedNotes(repo: WorkingMemoryRepo, crypto: EntryCrypto): SealedNotes {
  const open = (n: WorkingMemoryNote): WorkingMemoryNote => {
    if (!n.sealed) return n
    const content = openJson<string>(crypto, n.sealed.keyRef, Buffer.from(n.sealed.cipher, 'base64'))
    return { ...n, content }
  }
  const seal = (n: WorkingMemoryNote): WorkingMemoryNote => {
    const keyRef = n.sealed?.keyRef ?? crypto.newWrappedKey()
    const { cipher } = sealJson(crypto, keyRef, n.content)
    return { ...n, content: '', sealed: { keyRef, cipher: cipher.toString('base64') } }
  }
  return {
    query: async (scope) => (await repo.query(scope)).map(open),
    list: async (principalId) => (await repo.list(principalId)).map(open),
    save: async (note) => repo.save(seal(note)),
    delete: (id) => repo.delete(id),
    flagByLineage: (entryId) => repo.flagByLineage(entryId),
    listAll: async () => (await repo.listAll()).map(open),
    sealPlain: async () => {
      let sealed = 0
      for (const note of await repo.listAll()) {
        if (note.sealed) continue
        await repo.save(seal(note))
        sealed++
      }
      return sealed
    },
  }
}

/**
 * What a preference is stored and logged under: a keyed index of its name, which names the owner too, so that two
 * people's preferences of the same name are not linked by their index.
 */
export function preferenceIndex(crypto: EntryCrypto, principalId: string, key: string): string {
  return crypto.blindIndex(`${principalId}\n${key}`)
}

export function sealedPreferences(repo: PreferenceRepo, crypto: EntryCrypto): SealedPreferences {
  const indexOf = (principalId: string, key: string): string => preferenceIndex(crypto, principalId, key)
  const open = (p: PrincipalPreference): PrincipalPreference => {
    if (!p.sealed) return p
    const { key, value } = openJson<SealedPreference>(crypto, p.sealed.keyRef, Buffer.from(p.sealed.cipher, 'base64'))
    const { sealed: _sealed, ...rest } = p
    return { ...rest, key, value }
  }
  const seal = (p: PrincipalPreference): PrincipalPreference => {
    // a new key at every write: the one the previous value was sealed under goes with the row it replaces
    const keyRef = crypto.newWrappedKey()
    const { cipher } = sealJson(crypto, keyRef, { key: p.key, value: p.value } satisfies SealedPreference)
    return {
      principalId: p.principalId,
      key: indexOf(p.principalId, p.key),
      value: '',
      updatedAt: p.updatedAt,
      sealed: { keyRef, cipher: cipher.toString('base64') },
    }
  }
  return {
    query: async (scope) => (await repo.query(scope)).map(open),
    list: async (principalId) => (await repo.list(principalId)).map(open),
    set: (pref) => repo.set(seal(pref)),
    delete: (principalId, key) => repo.delete(principalId, indexOf(principalId, key)),
    listAll: async () => (await repo.listAll()).map(open),
    sealPlain: async () => {
      let sealed = 0
      for (const pref of await repo.listAll()) {
        if (pref.sealed) continue
        // stored under its name in the clear: stored again under the index of its name, then the plain row goes
        await repo.set(seal(pref))
        await repo.delete(pref.principalId, pref.key)
        sealed++
      }
      return sealed
    },
  }
}
