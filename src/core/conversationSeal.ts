/**
 * A conversation's title and last text, sealed (D77, PRIV-ERASE-001): the store keeps them only as ciphertext under a
 * key of the conversation; the service reads and writes them in the clear through this repository.
 */
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import type { ConversationRepo } from '../store/types.js'
import type { Conversation } from './types.js'

interface SealedFields {
  title: string
  lastPreview?: string
}

export interface SealedConversations extends ConversationRepo {
  /** Seals what an earlier version kept in the clear; returns how many it sealed. */
  sealPlain(): Promise<number>
}

export function sealedConversations(repo: ConversationRepo, crypto: EntryCrypto): SealedConversations {
  const open = (c: Conversation | undefined): Conversation | undefined => {
    if (!c?.sealed) return c
    const fields = openJson<SealedFields>(crypto, c.sealed.keyRef, Buffer.from(c.sealed.cipher, 'base64'))
    return { ...c, title: fields.title, lastPreview: fields.lastPreview }
  }
  const seal = (c: Conversation): Conversation => {
    const keyRef = c.sealed?.keyRef ?? crypto.newWrappedKey()
    const { cipher } = sealJson(crypto, keyRef, { title: c.title, lastPreview: c.lastPreview } satisfies SealedFields)
    const { lastPreview: _preview, ...rest } = c
    return { ...rest, title: '', sealed: { keyRef, cipher: cipher.toString('base64') } }
  }
  const sealedRepo: SealedConversations = {
    get: async (id) => open(await repo.get(id)),
    save: async (c) => repo.save(seal(c)),
    listByPrincipal: async (principalId, states) =>
      (await repo.listByPrincipal(principalId, states)).map((c) => open(c) as Conversation),
    listAll: async () => (await repo.listAll()).map((c) => open(c) as Conversation),
    listBySpace: async (spaceId, opts) => (await repo.listBySpace(spaceId, opts)).map((c) => open(c) as Conversation),
    sealPlain: async () => {
      let sealed = 0
      for (const c of await repo.listAll()) {
        if (c.sealed || (!c.title && !c.lastPreview)) continue
        await repo.save(seal(c))
        sealed++
      }
      return sealed
    },
  }
  return sealedRepo
}
