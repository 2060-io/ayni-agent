/**
 * The reference relational store (PostgreSQL with pgvector): what the in-memory store cannot prove. Runs when
 * PG_TEST_URL names a server (`pnpm test:postgres` starts one in Docker; CI runs it as a service), each run in a
 * database of its own, created and dropped here.
 *
 * MEM-RAG-005 (document search compiles for its store), PRIV-SCOPE-003 (every store through the predicate),
 * PRIV-ERASE-001 and D77 (no plaintext beside the ciphertext), MEM-ENTRY-004 and D76 (the migration to conversations),
 * decision 60 (spaces: the migration to 3.6.0, the stores, no plaintext of a space, the agent served from PostgreSQL),
 * decision 61 (the user directory: the migration to 3.7.0, the issuances of an entry and of a holder, the members of an
 * entry, the changes newest first, nothing of a person of the directory in the clear but its id and audited name),
 * decision 62 (a badge by email code and an invitation of another organization: the invitations of a person found by
 * their keyed index, and neither the address, the code nor the invited email in the clear in any table), decision 64
 * (the service's sentences translated and kept: the migration to 3.8.0, reused by a new process, no address or code).
 */
import { rmSync } from 'node:fs'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent } from '../src/app.js'
import { loadPack } from '../src/config/pack.js'
import { sealedConversations } from '../src/core/conversationSeal.js'
import { TRANSLATION_INSTRUCTION_HEAD } from '../src/core/serviceLanguage.js'
import { personalSpaceId, SpaceService, sealedMembers } from '../src/core/spaces.js'
import type { Principal, RagChunk, Session } from '../src/core/types.js'
import { createEmbeddings } from '../src/llm/embeddings.js'
import type { StubChatModel } from '../src/llm/stub.js'
import { createEntryCrypto, sealJson } from '../src/memory/crypto.js'
import { buildScope } from '../src/memory/scope.js'
import { MemoryService } from '../src/memory/service.js'
import type { MailMessage } from '../src/platform/mail.js'
import { MIGRATIONS } from '../src/store/migrations.js'
import { PostgresStore } from '../src/store/postgres.js'
import { createLogger } from '../src/util/logger.js'
import {
  directoryPack,
  guest,
  mintLocally,
  mockServices,
  present,
  runText,
  textOf,
  until,
} from './directoryFixtures.js'
import { parseSse, testEnv } from './helpers.js'

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
      const base = { principalId: 'p1', conversationId: 'c1' }
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

  describe('the migration to spaces (decision 60, schema 3.6.0)', () => {
    let url: string
    beforeAll(async () => {
      url = await freshDatabase()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => m.version < '3.6.0')) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      // a conversation, an entry of it, an entry of no conversation and a note of the previous version: no space
      await client.query(
        `INSERT INTO conversations (id, principal_id, state, last_activity_at, data)
         VALUES ('conv_v35', 'p7', 'active', now(), '{"id":"conv_v35","principalId":"p7","sessionIds":[]}')`
      )
      for (const [id, conversation, visibility] of [
        ['msg_v35', 'conv_v35', 'conversation-private'],
        ['msg_didcomm', 'ses_didcomm', 'principal-private'],
      ])
        await client.query(
          `INSERT INTO entries (id, session_id, conversation_id, principal_id, role, source_type, visibility, state, language,
             content_digest, enc_key_ref, initiated_at, created_at, data)
           VALUES ($1, 's', $2, 'p7', 'principal', 'text', $3, 'active', 'en', 'd', 'k', now(), now(),
             jsonb_build_object('id', $1::text))`,
          [id, conversation, visibility]
        )
      await client.query(
        `INSERT INTO working_memory (id, principal_id, visibility, state, data)
         VALUES ('note_v35', 'p7', 'principal-private', 'active', '{"id":"note_v35","principalId":"p7","state":"active","visibility":"principal-private","lineageRefs":[]}')`
      )
      await client.end()
    })

    it('puts every conversation and every note of an earlier version in the Personal space of its Principal', async () => {
      const store = new PostgresStore(url)
      await store.init()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const conversation = (
        await client.query("SELECT space_id, shared_at, data FROM conversations WHERE id = 'conv_v35'")
      ).rows[0]
      expect(conversation.space_id).toBe('personal:p7')
      expect(conversation.shared_at).toBeNull()
      expect(conversation.data.spaceId).toBe('personal:p7')
      const note = (await client.query("SELECT space_id, data FROM working_memory WHERE id = 'note_v35'")).rows[0]
      expect(note.space_id).toBe('personal:p7')
      expect(note.data.spaceId).toBe('personal:p7')
      for (const table of ['spaces', 'space_members', 'space_activity'])
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0)
      // every entry carries the space of its conversation, Personal when it has none (SPACE-CONV-001)
      const spaces = (await client.query('SELECT id, space_id FROM entries ORDER BY id')).rows
      expect(spaces).toEqual([
        { id: 'msg_didcomm', space_id: 'personal:p7' },
        { id: 'msg_v35', space_id: 'personal:p7' },
      ])
      await client.end()
      expect((await store.conversations.listBySpace('personal:p7')).map((c) => c.id)).toEqual(['conv_v35'])
      const scope = buildScope({
        principalId: 'p7',
        conversationId: 'c',
        backingIdentity: null,
        relation: 'unrecognized',
      })
      // the predicate names the space of the notes it reads (MEM-SPACE-001), compiled on the store's space column
      expect((await store.notes.query({ ...scope, spaceId: 'personal:p7' })).map((n) => n.id)).toEqual(['note_v35'])
      expect(await store.notes.query({ ...scope, spaceId: 'spc_other' })).toEqual([])
      expect((await store.notes.query(scope)).map((n) => n.id)).toEqual(['note_v35'])
      // a principal-private entry is read in the conversations of its space only
      const read = async (spaceId: string) =>
        (await store.entries.query({ ...scope, spaceId }, { limit: 10 })).map((e) => [e.id, e.spaceId])
      expect(await read('personal:p7')).toEqual([['msg_didcomm', 'personal:p7']])
      expect(await read('spc_other')).toEqual([])
      await store.close()
    })
  })

  describe('spaces in the store (decision 60)', () => {
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

    it('keeps no plaintext of a space or of an invited email, and reads them back in the clear', async () => {
      const { pack } = loadPack('agent-packs/dev', { ...process.env })
      const spaces = new SpaceService(store, pack, crypto, logger)
      const ana = principal('p_ana', { roles: ['employee'] })
      const space = await spaces.create(ana, {
        templateId: 'project',
        title: 'CANARY-SPACE-TITLE-9140',
        purpose: 'CANARY-SPACE-PURPOSE-2275',
        brief: 'CANARY-SPACE-BRIEF-6618',
      })
      await spaces.update(ana, space.id, { title: 'CANARY-SPACE-TITLE-NEW-3309', rules: { retentionDays: 30 } })
      const members = sealedMembers(store.spaceMembers, crypto)
      const now = new Date().toISOString()
      await members.save({
        id: 'mbr_guest',
        spaceId: space.id,
        principalId: null,
        organizationKey: 'org:EE:14000000',
        email: 'CANARY-EMAIL-4410@example.org',
        state: 'invited',
        role: 'guest',
        createdAt: now,
        updatedAt: now,
      })
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const rows = [
        ...(await client.query('SELECT s::text AS row FROM spaces s')).rows,
        ...(await client.query('SELECT m::text AS row FROM space_members m')).rows,
        ...(await client.query('SELECT a::text AS row FROM space_activity a')).rows,
      ]
      expect(rows.length).toBe(5)
      for (const { row } of rows) expect(row).not.toMatch(/CANARY/)
      // what the lists and the membership need stays in the clear
      const kept = (await client.query('SELECT kind, template_id, membership_mode, data FROM spaces')).rows[0]
      expect(kept).toMatchObject({ kind: 'team', template_id: 'project', membership_mode: 'list' })
      expect(kept.data.rules.retentionDays).toBe(30)
      const invited = (
        await client.query("SELECT email_index, organization_key FROM space_members WHERE id = 'mbr_guest'")
      ).rows[0]
      expect(invited.organization_key).toBe('org:EE:14000000')
      expect(invited.email_index).toMatch(/^[0-9a-f]{64}$/)
      await client.end()

      expect(await spaces.find(space.id)).toMatchObject({
        title: 'CANARY-SPACE-TITLE-NEW-3309',
        purpose: 'CANARY-SPACE-PURPOSE-2275',
        brief: 'CANARY-SPACE-BRIEF-6618',
      })
      expect((await members.get('mbr_guest'))?.email).toBe('CANARY-EMAIL-4410@example.org')
      expect((await spaces.listFor(ana)).map((a) => a.space.id)).toEqual([personalSpaceId('p_ana'), space.id])
      const activity = await store.spaceActivity.list(space.id, 10)
      expect(activity.map((a) => a.action)).toEqual(['rules-changed', 'created'])
      expect(activity[0]?.fields).toEqual(['title', 'rules.retentionDays'])
    })

    it('lists the conversations of a space, and those shared with it', async () => {
      const conversations = sealedConversations(store.conversations, crypto)
      const base = {
        principalId: 'p_ana',
        channelType: 'ag-ui' as const,
        title: 't',
        state: 'active' as const,
        createdAt: new Date().toISOString(),
        sessionIds: [],
      }
      await conversations.save({ ...base, id: 'c_a', spaceId: 'spc_x', lastActivityAt: '2026-11-18T10:00:00.000Z' })
      await conversations.save({
        ...base,
        id: 'c_b',
        spaceId: 'spc_x',
        sharedAt: '2026-11-18T11:00:00.000Z',
        lastActivityAt: '2026-11-18T11:00:00.000Z',
      })
      await conversations.save({ ...base, id: 'c_c', lastActivityAt: '2026-11-18T12:00:00.000Z' })
      expect((await store.conversations.listBySpace('spc_x')).map((c) => c.id)).toEqual(['c_b', 'c_a'])
      expect((await store.conversations.listBySpace('spc_x', { shared: true })).map((c) => c.id)).toEqual(['c_b'])
      expect((await store.conversations.listBySpace(personalSpaceId('p_ana'))).map((c) => c.id)).toEqual(['c_c'])
    })
  })

  describe('the agent served from PostgreSQL (decision 60)', () => {
    it('serves spaces, memories per space and the deletion of a message, with no plaintext of a space', async () => {
      const url = await freshDatabase()
      const running = await buildAgent(testEnv({ store: 'postgres', databaseUrl: url }), logger, { drainMs: 200 })
      try {
        const minter = running.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
        minter.minter = {
          mint: async (id: string) => ({
            invitationId: `inv-${id}`,
            outOfBandId: `oob-${id}`,
            url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
          }),
        }
        const client = { name: 'ayni-ui', version: '3.3.0', platform: 'web' }
        const created = (
          await running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client } })
        ).json() as { sessionId: string; sessionToken: string }
        const provisional = await running.agent.sessions.get(created.sessionId)
        const { principal } = await running.agent.onPeerConnected(
          {
            connectionType: 'verifiable-user-agent',
            actorIdentity: 'did:peer:pg-ana',
            backingIdentity: null,
            claims: { userName: 'Ana' },
            userAgentVerified: false,
            identityCredentialRef: null,
          },
          'conn-pg',
          { name: 'Wallet', version: '1', platform: 'ios' }
        )
        await running.agent.sessions.markConfirmationSent(provisional as Session, 'conn-pg', 'thread-pg')
        const confirm = (await running.agent.sessions.findByConfirmation('conn-pg', 'thread-pg')) as Session
        await running.agent.sessions.bind(confirm, principal, confirm.binding?.nonce as string)
        const auth = { authorization: `Bearer ${created.sessionToken}` }
        const space = (
          await running.app.inject({
            method: 'POST',
            url: '/agui/v3/sessions/spaces',
            headers: auth,
            payload: {
              templateId: 'project',
              title: 'CANARY-PG-TITLE-5150',
              purpose: 'CANARY-PG-PURPOSE-7311',
              brief: 'CANARY-PG-BRIEF-2208',
            },
          })
        ).json() as { id: string }
        const sibling = (
          await running.app.inject({
            method: 'POST',
            url: '/agui/v3/sessions',
            headers: auth,
            payload: { client, newConversation: true, spaceId: space.id },
          })
        ).json() as { sessionId: string; sessionToken: string; conversationId: string }
        const run = async (text: string, id: string) =>
          parseSse(
            (
              await running.app.inject({
                method: 'POST',
                url: `/agui/v3/sessions/${sibling.sessionId}/runs`,
                headers: { authorization: `Bearer ${sibling.sessionToken}` },
                payload: {
                  threadId: sibling.sessionId,
                  runId: `run-${id}`,
                  messages: [{ id, role: 'user', content: text }],
                },
              })
            ).body
          ).map((e) => e.event)
        await run('keep /call working_memory {"action":"add","content":"CANARY-PG-NOTE-8121"}', 'u-pg-1')
        const memories = (
          await running.app.inject({
            method: 'GET',
            url: `/agui/v3/sessions/memories?spaceId=${space.id}`,
            headers: auth,
          })
        ).json() as { memories: { content: string; spaceId: string }[] }
        expect(memories.memories).toEqual([
          expect.objectContaining({ content: 'CANARY-PG-NOTE-8121', spaceId: space.id }),
        ])
        const listed = (
          await running.app.inject({
            method: 'GET',
            url: `/agui/v3/sessions/conversations?spaceId=${space.id}`,
            headers: auth,
          })
        ).json() as { conversations: { id: string; spaceId: string }[] }
        expect(listed.conversations.map((c) => c.id)).toEqual([sibling.conversationId])

        const deleted = await running.app.inject({
          method: 'DELETE',
          url: `/agui/v3/sessions/${sibling.sessionId}/messages/u-pg-1`,
          headers: { authorization: `Bearer ${sibling.sessionToken}` },
        })
        expect(deleted.statusCode).toBe(204)
        const after = (
          await running.app.inject({ method: 'GET', url: '/agui/v3/sessions/memories', headers: auth })
        ).json() as { memories: unknown[] }
        expect(after.memories).toEqual([])

        const raw = new pg.Client({ connectionString: url })
        await raw.connect()
        const tables = (
          await raw.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
          )
        ).rows.map((r) => String(r.table_name))
        expect(tables).toEqual(expect.arrayContaining(['spaces', 'space_members', 'space_activity']))
        for (const table of tables) {
          for (const { row } of (await raw.query(`SELECT t::text AS row FROM ${table} t`)).rows)
            expect(row, table).not.toMatch(/CANARY-PG/)
        }
        await raw.end()
      } finally {
        await running.stop()
      }
    }, 30_000)
  })
  describe('the migration to the user directory (decision 61, schema 3.7.0)', () => {
    let url: string
    beforeAll(async () => {
      url = await freshDatabase()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => m.version < '3.7.0')) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      // two records of the admin audit at one time, and an evidence record, of the previous version
      for (const id of ['adm_first', 'adm_second'])
        await client.query(
          `INSERT INTO admin_audit (id, ts, action, actor, data) VALUES ($1, '2026-11-18T10:00:00Z', 'erasure', 'op',
             jsonb_build_object('id', $1::text, 'ts', '2026-11-18T10:00:00Z', 'action', 'erasure', 'actor', 'op'))`,
          [id]
        )
      await client.query(
        `INSERT INTO evidence (id, principal_id, state, verified_at, data)
         VALUES ('evd_old', 'p1', 'active', now(), '{"id":"evd_old","kind":"issuance","entry":"issuance:badge"}')`
      )
      await client.end()
    })

    it('adds the columns of the entry and the holder, and keeps the order the audit was written in', async () => {
      const store = new PostgresStore(url)
      await store.init()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const columns = (
        await client.query(
          "SELECT table_name, column_name FROM information_schema.columns WHERE column_name IN ('directory_entry_id', 'holder_index', 'seq') ORDER BY 1, 2"
        )
      ).rows.map((r) => `${r.table_name}.${r.column_name}`)
      expect(columns).toEqual(
        expect.arrayContaining(['admin_audit.seq', 'evidence.directory_entry_id', 'evidence.holder_index'])
      )
      const old = (await client.query("SELECT directory_entry_id, holder_index FROM evidence WHERE id = 'evd_old'"))
        .rows[0]
      expect(old).toEqual({ directory_entry_id: null, holder_index: null })
      await client.end()
      // of two records at one time, the one written last first
      expect((await store.adminAudit.list(10)).map((r) => r.id)).toEqual(['adm_second', 'adm_first'])
      expect(await store.evidence.listIssuedFromDirectory()).toEqual([])
      await store.close()
    })
  })

  describe('the user directory in the store (decision 61)', () => {
    let store: PostgresStore
    beforeAll(async () => {
      store = new PostgresStore(await freshDatabase())
      await store.init()
    })
    afterAll(async () => {
      await store.close()
    })

    it('finds the issuances of an entry and of a holder, the members of an entry, and the changes newest first', async () => {
      const issued = (id: string, at: string, over: Record<string, unknown>) => ({
        id,
        principalId: 'p1',
        kind: 'issuance' as const,
        entry: 'issuance:badge',
        outcome: 'verified' as const,
        revealed: [],
        unrevealed: [],
        stored: [],
        verifiedAt: at,
        state: 'active' as const,
        contentDigest: '',
        encKeyRef: null,
        cipher: null,
        ...over,
      })
      await store.evidence.save(
        issued('evd_1', '2026-11-19T01:00:00.000Z', {
          directoryEntryId: 'p-0042',
          holderIndex: 'h-ana',
          revocation: { registryDefinitionId: 'rr', index: 0 },
        })
      )
      await store.evidence.save(
        issued('evd_2', '2026-11-19T02:00:00.000Z', { directoryEntryId: 'p-0043', holderIndex: 'h-jonas' })
      )
      await store.evidence.save(
        issued('evd_3', '2026-11-19T03:00:00.000Z', { directoryEntryId: 'p-0042', holderIndex: 'h-ana' })
      )
      // a presentation never names an entry in its columns
      await store.evidence.save({
        ...issued('evd_4', '2026-11-19T04:00:00.000Z', { directoryEntryId: 'p-0042' }),
        kind: 'presentation',
      })
      expect((await store.evidence.listIssuedFromDirectory()).map((r) => r.id)).toEqual(['evd_1', 'evd_2', 'evd_3'])
      expect((await store.evidence.listIssuedFromDirectory('p-0042')).map((r) => r.id)).toEqual(['evd_1', 'evd_3'])
      expect((await store.evidence.listIssuedTo('h-ana')).map((r) => r.id)).toEqual(['evd_3', 'evd_1'])
      expect((await store.evidence.get('evd_1'))?.revocation).toEqual({ registryDefinitionId: 'rr', index: 0 })

      const now = new Date().toISOString()
      for (const [id, directoryId] of [
        ['mem_1', 'p-0044'],
        ['mem_2', 'p-0044'],
        ['mem_3', 'p-0045'],
      ])
        await store.spaceMembers.save({
          id,
          spaceId: `spc_${id}`,
          principalId: null,
          directoryId,
          state: 'invited',
          role: 'member',
          createdAt: now,
          updatedAt: now,
        })
      expect((await store.spaceMembers.listByDirectoryId('p-0044')).map((m) => m.id)).toEqual(['mem_1', 'mem_2'])
      await store.spaceMembers.delete('mem_1')
      expect((await store.spaceMembers.listByDirectoryId('p-0044')).map((m) => m.id)).toEqual(['mem_2'])

      for (const [id, action] of [
        ['adm_a', 'directory-change'],
        ['adm_b', 'erasure'],
        ['adm_c', 'directory-change'],
        ['adm_d', 'directory-change'],
      ] as const)
        await store.adminAudit.insert({
          id,
          ts: '2026-11-19T05:00:00.000Z',
          action,
          actor: 'directory',
          reason: 'reload',
          detail: {},
        })
      const changes = await store.adminAudit.list(2, { action: 'directory-change' })
      expect(changes.map((r) => r.id)).toEqual(['adm_d', 'adm_c'])
      expect(
        (await store.adminAudit.list(10, { action: 'directory-change', before: 'adm_c' })).map((r) => r.id)
      ).toEqual(['adm_a'])
    })
  })

  describe('the agent and its user directory, served from PostgreSQL (decision 61)', () => {
    it('keeps nothing of a person of the directory in the clear but the id, and the name the admin audit holds', async () => {
      const services = await mockServices()
      const canary = {
        id: 'p-canary',
        firstName: 'Canaryfirst',
        lastName: 'Canarylast',
        email: 'canary.mail.4471@northwind.example',
        birthDate: '19770412',
        nationality: 'QQX',
        department: 'CANARY-DEPT-5821',
        groups: ['canary-group-9930'],
        roles: ['dispatcher'],
      }
      const other = { id: 'p-other', firstName: 'Ana', lastName: 'Ríos', email: 'ana@northwind.example', roles: [] }
      const fixture = directoryPack([canary, other])
      const url = await freshDatabase()
      const running = await buildAgent(
        testEnv({
          store: 'postgres',
          databaseUrl: url,
          agentPackPath: fixture.pack,
          vsAgentAdminUrl: services.url,
          veranaApiUrl: services.url,
          directoryPollSeconds: 0,
        }),
        logger,
        { drainMs: 200 }
      )
      try {
        mintLocally(running)
        // the badge's own name, which the pack stores, is not the directory's
        const person = await present(running, 'BN-CANARY', 'Badge Holder', { entry: 'p-canary' })
        expect(person.principal.directoryEntryId).toBe('p-canary')
        expect(person.principal.roles).toContain('dispatcher')
        // a change, then the removal: the admin audit, the revocation, the sessions closed
        fixture.swap([{ ...canary, department: 'CANARY-DEPT-NEW-1170' }, other])
        await running.agent.people?.directory?.check()
        fixture.swap([other])
        await running.agent.people?.directory?.check()
        const record = (await running.agent.evidence.issuedFromDirectory('p-canary'))[0]
        expect(record?.revocation?.revokedAt).toBeDefined()
        const sessions = await running.agent.store.sessions.listByPrincipal(person.principal.id)
        expect(sessions.every((s) => s.state === 'closed' && s.closedReason === 'credential-invalid')).toBe(true)

        const raw = new pg.Client({ connectionString: url })
        await raw.connect()
        const tables = (
          await raw.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
          )
        ).rows.map((r) => String(r.table_name))
        const named: string[] = []
        for (const table of tables) {
          for (const { row } of (await raw.query(`SELECT t::text AS row FROM ${table} t`)).rows) {
            // never an email, a birthdate, a nationality, a department or a group (IDENT-DIR-007)
            expect(row, table).not.toMatch(/canary\.mail|4471|19770412|1977-04-12|QQX|CANARY-DEPT|canary-group/)
            if (/Canaryfirst|Canarylast/.test(row)) named.push(table)
          }
        }
        // the name is in the records of the admin audit (IDENT-DIR-009), and nowhere else
        expect([...new Set(named)]).toEqual(['admin_audit'])
        await raw.end()
      } finally {
        await running.stop()
        await services.app.close()
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }, 30_000)
  })

  describe('a badge by email code and an invitation, served from PostgreSQL (decision 62)', () => {
    it('finds the invitations of a person by their keyed index, and keeps no address, code or invited email in the clear', async () => {
      const services = await mockServices()
      services.organizations.push({ name: 'Acme Freight', countryCode: 'FR', registryId: '111' })
      const canary = {
        id: 'p-canary',
        firstName: 'Ana',
        lastName: 'Ríos',
        email: 'canary.code.6631@northwind.example',
        department: 'Depot',
        roles: ['manager'],
      }
      const fixture = directoryPack([canary], { badge: 'email', authenticationStores: ['name', 'email'] })
      const url = await freshDatabase()
      const sent: MailMessage[] = []
      const running = await buildAgent(
        testEnv({
          store: 'postgres',
          databaseUrl: url,
          agentPackPath: fixture.pack,
          vsAgentAdminUrl: services.url,
          veranaApiUrl: services.url,
          veranaGraphUrl: services.url,
          directoryPollSeconds: 0,
        }),
        logger,
        {
          drainMs: 200,
          mailer: {
            from: 'Fleet <fleet@northwind.example>',
            send: async (message) => {
              sent.push(message)
              return 'id'
            },
          },
        }
      )
      try {
        mintLocally(running)
        // a guest proves the address of the directory with the code sent to it
        const ana = await guest(running, 'canary-wallet')
        await runText(running, ana, '/call issue_credential {"credential":"badge"}')
        await runText(running, ana, canary.email)
        await until(() => sent.length === 1)
        const code = /\b(\d{6})\b/.exec(sent[0]?.text ?? '')?.[1] as string
        expect(textOf(await runText(running, ana, code))).toMatch(/^Your email address is verified\./)
        await until(() => services.calls.some((c) => c.url === '/v2/didcomm/credential-offer'))
        // a manager of the directory invites a person of another organization
        const jonas = await present(running, 'BN-CANARY', 'Ana Ríos', { entry: 'p-canary' })
        const space = (
          await running.app.inject({
            method: 'POST',
            url: '/agui/v3/sessions/spaces',
            headers: { authorization: `Bearer ${jonas.sessionToken}` },
            payload: { templateId: 'project', title: 'Handoff', purpose: 'p' },
          })
        ).json() as { id: string }
        const invited = await running.app.inject({
          method: 'POST',
          url: `/agui/v3/sessions/spaces/${space.id}/members`,
          headers: { authorization: `Bearer ${jonas.sessionToken}` },
          payload: { organizationKey: 'org:FR:111', email: 'canary.invite.7720@acme.example' },
        })
        expect(invited.statusCode).toBe(201)
        expect(
          (await running.agent.spaces.invitationsOf('org:FR:111', 'CANARY.invite.7720@acme.example')).map(
            (m) => m.state
          )
        ).toEqual(['invited'])
        expect(await running.agent.spaces.invitationsOf('org:FR:111', 'someone.else@acme.example')).toEqual([])

        const raw = new pg.Client({ connectionString: url })
        await raw.connect()
        const tables = (
          await raw.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
          )
        ).rows.map((r) => String(r.table_name))
        let rows = 0
        for (const table of tables) {
          for (const { row } of (await raw.query(`SELECT t::text AS row FROM ${table} t`)).rows) {
            rows++
            // the address, the code and the invited email, in no table, in no form but sealed or keyed (INTX-AUTH-014)
            expect(row, table).not.toMatch(/canary\.code|6631@|canary\.invite|7720@/)
            expect(row, table).not.toContain(code)
          }
        }
        expect(rows).toBeGreaterThan(20)
        await raw.end()
      } finally {
        await running.stop()
        await services.app.close()
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }, 30_000)
  })

  describe('the sentences of the service, translated and kept in PostgreSQL (decision 64, schema 3.8.0)', () => {
    it('keeps a translation for the next process, in an agent whose default language is Spanish, with no address or code', async () => {
      const services = await mockServices()
      const canary = { id: 'p-canary', firstName: 'Ana', lastName: 'Ríos', email: 'canary.lang.4417@northwind.example' }
      const fixture = directoryPack([canary], { badge: 'email', language: 'es' })
      const url = await freshDatabase()
      const sent: MailMessage[] = []
      const start = () =>
        buildAgent(
          testEnv({
            store: 'postgres',
            databaseUrl: url,
            agentPackPath: fixture.pack,
            vsAgentAdminUrl: services.url,
            veranaApiUrl: services.url,
            directoryPollSeconds: 0,
          }),
          logger,
          {
            drainMs: 200,
            mailer: {
              from: 'Fleet <fleet@northwind.example>',
              send: async (message) => {
                sent.push(message)
                return 'id'
              },
            },
          }
        )
      const translations = (running: Awaited<ReturnType<typeof start>>) =>
        (running.agent.llm as unknown as StubChatModel).requests.filter((r) =>
          String(r.messages[0]?.content).startsWith(TRANSLATION_INSTRUCTION_HEAD)
        )
      let running = await start()
      try {
        mintLocally(running)
        // no locale: the agent's default language
        const ana = await guest(running, 'lang-wallet', '')
        expect(textOf(await runText(running, ana, '/call issue_credential {"credential":"badge"}'))).toMatch(
          /^\[es\] To issue your Northwind badge/
        )
        await runText(running, ana, canary.email)
        await until(() => sent.length === 1)
        const code = /\b(\d{6})\b/.exec(sent[0]?.text ?? '')?.[1] as string
        const wrong = code === '000000' ? '111111' : '000000'
        expect(textOf(await runText(running, ana, wrong))).toBe('[es] That code is not right. 4 tries are left.')
        expect(translations(running)).toHaveLength(3)
        await running.stop()

        // a new process: the question it asks again is kept, and costs no call
        running = await start()
        mintLocally(running)
        const jonas = await guest(running, 'lang-wallet-2', '')
        expect(textOf(await runText(running, jonas, '/call issue_credential {"credential":"badge"}'))).toMatch(
          /^\[es\] To issue your Northwind badge/
        )
        expect(translations(running)).toHaveLength(0)

        const raw = new pg.Client({ connectionString: url })
        await raw.connect()
        const rows = (await raw.query('SELECT t::text AS row FROM translations t')).rows.map((r) => String(r.row))
        expect(rows).toHaveLength(3)
        for (const row of rows) {
          expect(row).not.toMatch(/canary\.lang|4417@/)
          expect(row).not.toContain(code)
          expect(row).not.toContain(wrong)
        }
        await raw.end()
      } finally {
        await running.stop()
        await services.app.close()
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }, 30_000)
  })
})
