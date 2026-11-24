/**
 * Working-memory notes and preferences, sealed (D77, PRIV-ERASE-009): the store holds a note's content, and a
 * preference's name and value, only as ciphertext; the memory service reads them in the clear; what an earlier version
 * kept in the clear is sealed at start; the access log names a preference by its index, never by its name.
 */
import { describe, expect, it } from 'vitest'
import { loadPack } from '../src/config/pack.js'
import type { Principal, Session } from '../src/core/types.js'
import { createEmbeddings } from '../src/llm/embeddings.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { preferenceIndex } from '../src/memory/sealedMemory.js'
import { MemoryService } from '../src/memory/service.js'
import { MemoryStore } from '../src/store/memory.js'
import { createLogger } from '../src/util/logger.js'

const logger = createLogger('silent')
const crypto = createEntryCrypto(Buffer.alloc(32, 9))

const principal = (id: string): Principal =>
  ({
    id,
    connectionType: 'verifiable-user-agent',
    actorIdentity: `did:peer:${id}`,
    backingIdentity: null,
    backingRelation: 'unrecognized',
    roles: [],
    identityAttributes: {},
    capabilityChannelId: null,
    identityCredentialRef: null,
    livenessCache: {},
    userAgentVerified: false,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
  }) as Principal

const session = (principalId: string): Session =>
  ({
    id: `ses_${principalId}`,
    principalId,
    channelType: 'ag-ui',
    state: 'bound',
    conversationId: 'c1',
  }) as unknown as Session

function rig(): { store: MemoryStore; memory: MemoryService } {
  const { pack } = loadPack('agent-packs/dev', { ...process.env })
  const store = new MemoryStore()
  const memory = new MemoryService(store, crypto, createEmbeddings({ provider: 'stub', model: 'hash' }), pack, logger)
  return { store, memory }
}

describe('working-memory notes, sealed (D77)', () => {
  it('keeps the content only as ciphertext and reads it back in the clear', async () => {
    const { store, memory } = rig()
    const ana = principal('p-ana')
    const note = await memory.addNote(ana, 'is allergic to penicillin', ['msg_1'])
    const [raw] = await store.notes.list(ana.id)
    expect(raw?.content).toBe('')
    expect(raw?.sealed?.keyRef).toBeTruthy()
    expect(JSON.stringify(raw)).not.toContain('penicillin')
    expect(raw?.lineageRefs).toEqual(['msg_1'])
    expect((await memory.notes(ana, session(ana.id))).map((n) => n.content)).toEqual(['is allergic to penicillin'])

    const keyRef = raw?.sealed?.keyRef
    expect((await memory.updateNote(ana, note.id, 'is allergic to amoxicillin'))?.id).toBe(note.id)
    const [updated] = await store.notes.list(ana.id)
    expect(updated?.sealed?.keyRef).toBe(keyRef)
    expect(JSON.stringify(updated)).not.toContain('amoxicillin')
    expect((await memory.notes(ana, session(ana.id)))[0]?.content).toBe('is allergic to amoxicillin')

    expect((await memory.removeNote(ana, note.id))?.id).toBe(note.id)
    expect(await store.notes.list(ana.id)).toEqual([])
  })
})

describe('preferences, sealed (D77)', () => {
  it('keeps the name and the value only as ciphertext, under a keyed index of the name', async () => {
    const { store, memory } = rig()
    const ana = principal('p-ana')
    await memory.setPreference(ana, 'health_condition', 'avoid mentioning the diagnosis')
    const [raw] = await store.preferences.list(ana.id)
    expect(raw?.key).toBe(preferenceIndex(crypto, ana.id, 'health_condition'))
    expect(raw?.value).toBe('')
    expect(JSON.stringify(raw)).not.toMatch(/health_condition|diagnosis/)
    const prefs = await memory.preferences(ana, session(ana.id))
    expect(prefs.map((p) => [p.key, p.value])).toEqual([['health_condition', 'avoid mentioning the diagnosis']])
  })

  it('replaces a preference of the same name, and does not link two people by the name', async () => {
    const { store, memory } = rig()
    const ana = principal('p-ana')
    const jonas = principal('p-jonas')
    await memory.setPreference(ana, 'language', 'es')
    await memory.setPreference(ana, 'language', 'fr')
    await memory.setPreference(jonas, 'language', 'de')
    expect(await store.preferences.list(ana.id)).toHaveLength(1)
    expect((await memory.preferences(ana, session(ana.id))).map((p) => p.value)).toEqual(['fr'])
    const [anaRow] = await store.preferences.list(ana.id)
    const [jonasRow] = await store.preferences.list(jonas.id)
    expect(anaRow?.key).not.toBe(jonasRow?.key)
  })

  it('names a preference in the access log by its index, never by its name', async () => {
    const { store, memory } = rig()
    const ana = principal('p-ana')
    await memory.setPreference(ana, 'health_condition', 'x')
    await memory.preferences(ana, session(ana.id))
    const log = store.accessLog.all().find((l) => l.matchedEntryIds.some((id) => id.startsWith('pref:')))
    expect(log?.matchedEntryIds).toEqual([`pref:${preferenceIndex(crypto, ana.id, 'health_condition')}`])
    expect(JSON.stringify(store.accessLog.all())).not.toContain('health_condition')
  })
})

describe('what an earlier version kept in the clear (no backward compatibility, ayni-spec PR #123)', () => {
  it('is not sealed at start: the agent has no such pass, every row being written sealed', () => {
    const { memory } = rig()
    expect('sealPlainNotesAndPreferences' in memory).toBe(false)
    expect('sealPlainAttachments' in memory).toBe(false)
  })
})

describe('the keyed index (EntryCrypto.blindIndex)', () => {
  it('is stable under one master key and different under another', () => {
    const other = createEntryCrypto(Buffer.alloc(32, 10))
    expect(crypto.blindIndex('language')).toBe(crypto.blindIndex('language'))
    expect(crypto.blindIndex('language')).not.toBe(crypto.blindIndex('style'))
    expect(crypto.blindIndex('language')).not.toBe(other.blindIndex('language'))
    expect(crypto.blindIndex('language')).toMatch(/^[0-9a-f]{64}$/)
  })
})
