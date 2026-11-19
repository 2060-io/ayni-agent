/**
 * The reference relational store (PostgreSQL with pgvector): what the in-memory store cannot prove. Runs when
 * PG_TEST_URL names a server (`pnpm test:postgres` starts one in Docker; CI runs it as a service), each run in a
 * database of its own, created and dropped here.
 *
 * MEM-RAG-005 (document search compiles for its store), PRIV-SCOPE-003 (every store through the predicate),
 * PRIV-ERASE-001 and D77 (no plaintext beside the ciphertext), MEM-ENTRY-004 and D76 (the migration to conversations).
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadPack } from '../src/config/pack.js'
import { sealedConversations } from '../src/core/conversationSeal.js'
import type { Principal, RagChunk, Session } from '../src/core/types.js'
import { createEmbeddings } from '../src/llm/embeddings.js'
import { createEntryCrypto, sealJson } from '../src/memory/crypto.js'
import { buildScope } from '../src/memory/scope.js'
import { MemoryService } from '../src/memory/service.js'
import { MIGRATIONS } from '../src/store/migrations.js'
import { PostgresStore } from '../src/store/postgres.js'
import { createLogger } from '../src/util/logger.js'

const serverUrl = process.env.PG_TEST_URL
const logger = createLogger('silent')
const crypto = createEntryCrypto(Buffer.alloc(32, 5))
const databases: string[] = []

/** A fresh database on the test server, dropped after the run. */
async function freshDatabase(): Promise<string> {
  const name = `ayni_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const admin = new pg.Client({ connectionString: serverUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  databases.push(name)
  const url = new URL(serverUrl as string)
  url.pathname = `/${name}`
  return url.toString()
}

const principal = (id: string, over: Partial<Principal> = {}): Principal =>
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
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as Principal

const session = (id: string, principalId: string, conversationId: string): Session =>
  ({
    id,
    principalId,
    channelType: 'ag-ui',
    externalRef: id,
    state: 'bound',
    conversationId,
    streamCursor: 0,
    lastActivityAt: new Date().toISOString(),
    client: { name: 'test', version: '1', platform: 'web' },
  }) as unknown as Session

describe.skipIf(!serverUrl)('the reference relational store', () => {
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: serverUrl })
    await admin.connect()
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end()
  })

  describe('the migration to conversations (D76, D77, MEM-ENTRY-004)', () => {
    let url: string
    beforeAll(async () => {
      url = await freshDatabase()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => m.version < '3.4.0')) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      // a store of the previous version: a session of a conversation, an entry kept session-private with a preview
      await client.query(
        `INSERT INTO sessions (id, principal_id, channel_type, external_ref, state, last_activity_at, data)
         VALUES ('ses_old', 'p1', 'ag-ui', 'ses_old', 'bound', now(), '{"id":"ses_old","conversationId":"conv_old"}')`
      )
      await client.query(
        `INSERT INTO entries (id, session_id, principal_id, role, source_type, visibility, state, language, content_digest,
           enc_key_ref, text_preview, initiated_at, created_at, data)
         VALUES ('msg_old', 'ses_old', 'p1', 'principal', 'text', 'session-private', 'active', 'en', 'd', 'k',
           'the secret preview', now(), now(), '{"id":"msg_old"}')`
      )
      await client.query(
        `INSERT INTO working_memory (id, principal_id, data) VALUES ('note_old', 'p1', '{"state":"active","visibility":"principal-private"}')`
      )
      await client.end()
    })

    it('carries every entry to its conversation, renames the visibility, and drops the preview', async () => {
      const store = new PostgresStore(url)
      await store.init()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const entry = (await client.query("SELECT * FROM entries WHERE id = 'msg_old'")).rows[0]
      expect(entry.conversation_id).toBe('conv_old')
      expect(entry.visibility).toBe('conversation-private')
      expect('text_preview' in entry).toBe(false)
      const note = (await client.query("SELECT visibility, state FROM working_memory WHERE id = 'note_old'")).rows[0]
      expect(note).toEqual({ visibility: 'principal-private', state: 'active' })
      await expect(
        client.query("UPDATE entries SET visibility = 'session-private' WHERE id = 'msg_old'")
      ).rejects.toThrow(/entries_visibility_check/)
      await client.end()
      await store.close()
    })
  })

  describe('working-memory notes and preferences, sealed (D77, PRIV-ERASE-009)', () => {
    let store: PostgresStore
    let url: string
    beforeAll(async () => {
      url = await freshDatabase()
      store = new PostgresStore(url)
      await store.init()
    })
    afterAll(async () => {
      await store.close()
    })

    it('keeps no plaintext of a note or a preference, and seals what an earlier version kept in the clear', async () => {
      const { pack } = loadPack('agent-packs/dev', { ...process.env })
      const memory = new MemoryService(
        store,
        crypto,
        createEmbeddings({ provider: 'stub', model: 'hash' }),
        pack,
        logger
      )
      const ana = principal('p9')
      await memory.addNote(ana, 'CANARY-NOTE-4412', ['msg_1'])
      await memory.setPreference(ana, 'CANARY-PREF-NAME-3021', 'CANARY-PREF-VALUE-8830')
      // rows as the previous version wrote them, in the clear
      await store.notes.save({
        id: 'note_legacy',
        principalId: 'p9',
        content: 'CANARY-LEGACY-NOTE-5517',
        visibility: 'principal-private',
        state: 'active',
        backingIdentity: null,
        lineageRefs: [],
        needsRevision: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await store.preferences.set({
        principalId: 'p9',
        key: 'CANARY-LEGACY-PREF-NAME-6604',
        value: 'CANARY-LEGACY-PREF-VALUE-7190',
        updatedAt: new Date().toISOString(),
      })
      expect(await memory.sealPlainNotesAndPreferences()).toEqual({ notes: 1, preferences: 1 })

      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const rows = [
        ...(await client.query('SELECT n::text AS row FROM working_memory n')).rows,
        ...(await client.query('SELECT p::text AS row FROM preferences p')).rows,
        ...(await client.query('SELECT l::text AS row FROM memory_access_log l')).rows,
      ]
      expect(rows.length).toBeGreaterThanOrEqual(4)
      for (const { row } of rows) expect(row).not.toMatch(/CANARY/)
      expect((await client.query('SELECT count(*)::int AS n FROM preferences')).rows[0].n).toBe(2)
      await client.end()

      const scopeSession = session('s9', 'p9', 'conv_9')
      expect((await memory.notes(ana, scopeSession)).map((n) => n.content).sort()).toEqual([
        'CANARY-LEGACY-NOTE-5517',
        'CANARY-NOTE-4412',
      ])
      expect((await memory.preferences(ana, scopeSession)).map((p) => `${p.key}=${p.value}`).sort()).toEqual([
        'CANARY-LEGACY-PREF-NAME-6604=CANARY-LEGACY-PREF-VALUE-7190',
        'CANARY-PREF-NAME-3021=CANARY-PREF-VALUE-8830',
      ])
      // the access log of those reads names neither
      const log = new pg.Client({ connectionString: url })
      await log.connect()
      for (const { row } of (await log.query('SELECT l::text AS row FROM memory_access_log l')).rows)
        expect(row).not.toMatch(/CANARY/)
      await log.end()
      expect(await memory.sealPlainNotesAndPreferences()).toEqual({ notes: 0, preferences: 0 })
    })
  })

  describe('reads, through the predicate compiled for each store', () => {
    let store: PostgresStore
    let url: string
    beforeAll(async () => {
      url = await freshDatabase()
      store = new PostgresStore(url)
      await store.init()
    })
    afterAll(async () => {
      await store.close()
    })

    it('finds the documents of each organization, and only them (MEM-RAG-005)', async () => {
      const chunk = (id: string, visibility: RagChunk['visibility'], partner?: string) => ({
        id,
        sourceId: id,
        uri: `file:${id}`,
        visibility,
        state: 'active' as const,
        chunkText: `text of ${id}`,
        position: 0,
        createdAt: new Date().toISOString(),
        vector: [0.1, 0.2, 0.3],
        ...(partner ? { partner } : {}),
      })
      await store.rag.replaceSource('pub', [chunk('pub', 'public')])
      await store.rag.replaceSource('org', [chunk('org', 'organization-shared')])
      await store.rag.replaceSource('ptn', [chunk('ptn', 'partner-shared', 'org:EE:14000000')])
      const search = async (ctx: Parameters<typeof buildScope>[0]) =>
        (await store.rag.vectorSearch(buildScope(ctx), [0.1, 0.2, 0.3], 10)).map((h) => h.item.id).sort()
      const base = { principalId: 'p1', conversationId: 'c1', crossSession: 'own-sessions' as const }
      expect(await search({ ...base, backingIdentity: { kind: 'org', id: 'org:CO:1' }, relation: 'home' })).toEqual([
        'org',
        'pub',
      ])
      expect(
        await search({ ...base, backingIdentity: { kind: 'org', id: 'org:EE:14000000' }, relation: 'partner' })
      ).toEqual(['ptn', 'pub'])
      expect(await search({ ...base, backingIdentity: { kind: 'org', id: 'org:DE:9' }, relation: 'partner' })).toEqual([
        'pub',
      ])
      expect(await search({ ...base, backingIdentity: null, relation: 'unrecognized' })).toEqual(['pub'])
    })

    it('reads working memory and preferences through the predicate (PRIV-SCOPE-003)', async () => {
      await store.notes.save({
        id: 'n1',
        principalId: 'p1',
        content: 'mine',
        visibility: 'principal-private',
        state: 'active',
        backingIdentity: null,
        lineageRefs: [],
        needsRevision: false,
        createdAt: '',
        updatedAt: '',
      })
      await store.notes.save({
        id: 'n2',
        principalId: 'p2',
        content: 'theirs',
        visibility: 'principal-private',
        state: 'active',
        backingIdentity: null,
        lineageRefs: [],
        needsRevision: false,
        createdAt: '',
        updatedAt: '',
      })
      await store.preferences.set({
        principalId: 'p1',
        key: 'tone',
        value: 'brief',
        updatedAt: new Date().toISOString(),
      })
      const scope = buildScope({
        principalId: 'p1',
        conversationId: 'c1',
        backingIdentity: null,
        relation: 'unrecognized',
        crossSession: 'own-sessions',
      })
      expect((await store.notes.query(scope)).map((n) => n.id)).toEqual(['n1'])
      expect((await store.preferences.query(scope)).map((p) => p.key)).toEqual(['tone'])
    })

    it('keeps no plaintext of a message or of a conversation beside the ciphertext (PRIV-ERASE-001, D77)', async () => {
      const { pack } = loadPack('agent-packs/dev', { ...process.env })
      const memory = new MemoryService(
        store,
        crypto,
        createEmbeddings({ provider: 'stub', model: 'hash' }),
        pack,
        logger
      )
      await store.sessions.save(session('s1', 'p1', 'conv_secret'))
      await memory.append({
        sessionId: 's1',
        principalId: 'p1',
        role: 'principal',
        sourceType: 'text',
        text: 'CANARY-MESSAGE-7781',
        backingIdentity: null,
      })
      const withFile = await memory.append({
        sessionId: 's1',
        principalId: 'p1',
        role: 'principal',
        sourceType: 'media',
        text: 'a file',
        backingIdentity: null,
        attachments: [
          {
            id: 'att_1',
            type: 'file',
            bucketKey: 'bucket/att_1',
            mimeType: 'application/pdf',
            filename: 'CANARY-FILENAME-6620.pdf',
            textRepr: 'CANARY-ATTACHMENT-TEXT-1187',
            objectKeyRef: 'wrapped',
            refDigest: 'digest',
          },
        ],
      })
      // an entry an earlier version wrote: the attachment's text in the clear beside the ciphertext
      const legacy = await memory.append({
        sessionId: 's1',
        principalId: 'p1',
        role: 'principal',
        sourceType: 'media',
        text: 'an older file',
        backingIdentity: null,
        attachments: [
          {
            id: 'att_2',
            type: 'file',
            bucketKey: 'b2',
            mimeType: 'text/plain',
            textRepr: 'x',
            objectKeyRef: 'w',
            refDigest: 'd',
          },
        ],
      })
      const raw = new pg.Client({ connectionString: url })
      await raw.connect()
      // the earlier format: the ciphertext held the text and the payload only
      const old = sealJson(crypto, legacy.encKeyRef as string, { text: 'an older file' })
      await raw.query(
        `UPDATE entries SET cipher = $2, data = jsonb_set(data, '{attachments,0,textRepr}', '"CANARY-LEGACY-TEXT-2240"') WHERE id = $1`,
        [legacy.id, old.cipher]
      )
      await raw.end()
      expect(await memory.sealPlainAttachments()).toBe(1)
      const conversations = sealedConversations(store.conversations, crypto)
      await conversations.save({
        id: 'conv_secret',
        principalId: 'p1',
        channelType: 'ag-ui',
        title: 'CANARY-TITLE-5521',
        lastPreview: 'CANARY-PREVIEW-3310',
        state: 'active',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        sessionIds: ['s1'],
      })
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const entries = (await client.query("SELECT e::text AS row FROM entries e WHERE conversation_id = 'conv_secret'"))
        .rows
      expect(entries).toHaveLength(3)
      for (const { row } of entries) {
        expect(row).not.toContain('CANARY-MESSAGE-7781')
        expect(row).not.toContain('CANARY-ATTACHMENT-TEXT-1187')
        expect(row).not.toContain('CANARY-FILENAME-6620')
        expect(row).not.toContain('CANARY-LEGACY-TEXT-2240')
      }
      const kept = (await client.query("SELECT c::text AS row FROM conversations c WHERE id = 'conv_secret'")).rows[0]
      expect(kept.row).not.toContain('CANARY-TITLE-5521')
      expect(kept.row).not.toContain('CANARY-PREVIEW-3310')
      await client.end()
      const conversation = await conversations.get('conv_secret')
      expect(conversation).toMatchObject({ title: 'CANARY-TITLE-5521', lastPreview: 'CANARY-PREVIEW-3310' })
      const history = await memory.history(principal('p1'), session('s1', 'p1', 'conv_secret'), { limit: 10 })
      expect(history.map((e) => e.text)).toContain('CANARY-MESSAGE-7781')
      const opened = history.find((e) => e.id === withFile.id)
      expect(opened?.attachments[0]).toMatchObject({
        textRepr: 'CANARY-ATTACHMENT-TEXT-1187',
        filename: 'CANARY-FILENAME-6620.pdf',
      })
      expect(history.find((e) => e.id === legacy.id)?.attachments[0]?.textRepr).toBe('CANARY-LEGACY-TEXT-2240')
    })

    it('reads a conversation in order, between two places, whatever its sessions (MEM-ENTRY-004)', async () => {
      const { pack } = loadPack('agent-packs/dev', { ...process.env })
      const memory = new MemoryService(
        store,
        crypto,
        createEmbeddings({ provider: 'stub', model: 'hash' }),
        pack,
        logger
      )
      const t0 = Date.parse('2026-11-18T09:00:00.000Z')
      for (let i = 0; i < 6; i++) {
        await store.sessions.save(session(`sx${i}`, 'p1', 'conv_order'))
        await memory.append({
          sessionId: `sx${i}`,
          principalId: 'p1',
          role: 'principal',
          sourceType: 'text',
          text: `m${i}`,
          backingIdentity: null,
          initiatedAt: new Date(t0 + i * 1000).toISOString(),
        })
      }
      const s = session('sx5', 'p1', 'conv_order')
      const all = await memory.conversationEntries(principal('p1'), s, { order: 'asc', limit: 100 })
      expect(all.map((e) => e.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
      const from = { initiatedAt: (all[2] as { initiatedAt: string }).initiatedAt, id: (all[2] as { id: string }).id }
      const until = { initiatedAt: (all[4] as { initiatedAt: string }).initiatedAt, id: (all[4] as { id: string }).id }
      const middle = await memory.conversationEntries(principal('p1'), s, { from, until, order: 'asc', limit: 100 })
      expect(middle.map((e) => e.text)).toEqual(['m2', 'm3'])
      const newest = await memory.conversationEntries(principal('p1'), s, { from, order: 'desc', limit: 2 })
      expect(newest.map((e) => e.text)).toEqual(['m5', 'm4'])
    })

    it('records admin calls, deletes from the key-value table, finds approvals by message', async () => {
      await store.adminAudit.insert({
        id: 'adm_1',
        ts: new Date().toISOString(),
        action: 'erasure',
        actor: 'ops',
        reason: 'test',
        detail: { erased: ['x'] },
      })
      expect((await store.adminAudit.list(10)).map((r) => r.id)).toEqual(['adm_1'])
      await store.kv.set('summary:c9', 'sealed')
      await store.kv.delete('summary:c9')
      expect(await store.kv.get('summary:c9')).toBeUndefined()
      await store.approvals.save({
        id: 'apr_9',
        inboundId: 'msg_9',
        requesterId: 'p1',
        eligibleRoles: [],
        status: 'PENDING',
      } as never)
      expect((await store.approvals.list({ inboundId: 'msg_9' })).map((a) => a.id)).toEqual(['apr_9'])
    })
  })
})
