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
 * decision 62 (an invitation of another organization: the invitations of a person found by their keyed index, and the
 * invited email in the clear in no table), decision 64 (the service's sentences translated and kept: the migration to
 * 3.8.0, reused by a new process),
 * tools phase 1 (ayni-spec D97 to D100: the migration to 3.9.0, a space's account only as ciphertext and destroyed with its
 * row, the allowances of a conversation, the record of each call by space, source and period, the action of an approval
 * sealed), features and providers (ayni-spec D120 to D123: the migration to 3.15.0, the tools a space held kept by
 * their source, the mark of each feature's provider by space).
 */
import { rmSync } from 'node:fs'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent } from '../src/app.js'
import { loadPack } from '../src/config/pack.js'
import type { AgentPack } from '../src/config/packTypes.js'
import { EnrolmentStore } from '../src/core/authentication/enrolments.js'
import { sealedConversations } from '../src/core/conversationSeal.js'
import { ServiceLanguage } from '../src/core/serviceLanguage.js'
import { personalSpaceId, SpaceService, sealedMembers } from '../src/core/spaces.js'
import type { PersonalAccountRecord, Principal, RagChunk, Session } from '../src/core/types.js'
import { createEmbeddings } from '../src/llm/embeddings.js'
import type { ChatDelta, ChatModel, ChatRequest } from '../src/llm/types.js'
import { createEntryCrypto, newKeyUnder, openJson, openUnder, sealJson, sealUnder } from '../src/memory/crypto.js'
import { buildScope } from '../src/memory/scope.js'
import { MemoryService } from '../src/memory/service.js'
import { AdminService } from '../src/platform/admin.js'
import { AdminGrants, deviceOf } from '../src/platform/adminGrants.js'
import type { MailMessage } from '../src/platform/mail.js'
import { sealedApprovals } from '../src/policy/approvals.js'
import { MIGRATIONS } from '../src/store/migrations.js'
import { PostgresStore } from '../src/store/postgres.js'
import { createLogger } from '../src/util/logger.js'
import { directoryPack, mintLocally, mockServices, present } from './directoryFixtures.js'
import { parseSse, testEnv } from './helpers.js'

const serverUrl = process.env.PG_TEST_URL
const logger = createLogger('silent')
const crypto = createEntryCrypto(Buffer.alloc(32, 5))
const databases: string[] = []

/** Whether a schema version comes before another, by its numbers: 3.9.0 before 3.10.0. */
function olderThan(version: string, than: string): boolean {
  const a = version.split('.').map(Number)
  const b = than.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

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
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.4.0'))) {
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

    it('keeps no plaintext of a note or a preference', async () => {
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

      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const rows = [
        ...(await client.query('SELECT n::text AS row FROM working_memory n')).rows,
        ...(await client.query('SELECT p::text AS row FROM preferences p')).rows,
        ...(await client.query('SELECT l::text AS row FROM memory_access_log l')).rows,
      ]
      expect(rows.length).toBeGreaterThanOrEqual(2)
      for (const { row } of rows) expect(row).not.toMatch(/CANARY/)
      expect((await client.query('SELECT count(*)::int AS n FROM preferences')).rows[0].n).toBe(1)
      await client.end()

      const scopeSession = session('s9', 'p9', 'conv_9')
      expect((await memory.notes(ana, scopeSession)).map((n) => n.content)).toEqual(['CANARY-NOTE-4412'])
      expect((await memory.preferences(ana, scopeSession)).map((p) => `${p.key}=${p.value}`)).toEqual([
        'CANARY-PREF-NAME-3021=CANARY-PREF-VALUE-8830',
      ])
      // the access log of those reads names neither
      const log = new pg.Client({ connectionString: url })
      await log.connect()
      for (const { row } of (await log.query('SELECT l::text AS row FROM memory_access_log l')).rows)
        expect(row).not.toMatch(/CANARY/)
      await log.end()
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
      expect(entries).toHaveLength(2)
      for (const { row } of entries) {
        expect(row).not.toContain('CANARY-MESSAGE-7781')
        expect(row).not.toContain('CANARY-ATTACHMENT-TEXT-1187')
        expect(row).not.toContain('CANARY-FILENAME-6620')
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
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.6.0'))) {
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
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.7.0'))) {
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

  describe('an invitation, served from PostgreSQL (decision 62)', () => {
    it('finds the invitations of a person by their keyed index, and keeps no invited email in the clear', async () => {
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
      const fixture = directoryPack([canary], { authenticationStores: ['name', 'email'] })
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
            // the invited email, in no table, in no form but sealed or keyed
            expect(row, table).not.toMatch(/canary\.invite|7720@/)
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
    it('keeps a translation for the next process, which reuses it with no call', async () => {
      const url = await freshDatabase()
      const sentence = { text: 'Your code for Fleet support is ######.', keep: ['Fleet support', '######'] }
      const person = { id: 'prn-lang' } as Principal
      const session = { id: 'ses-lang', locale: 'es' } as Session
      const translator = () => {
        const requests: ChatRequest[] = []
        const llm: ChatModel = {
          id: 'fake/translator',
          multimodal: false,
          async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
            requests.push(req)
            yield { type: 'text', text: `[es] ${String(req.messages[1]?.content)}` }
          },
        }
        return { llm, requests }
      }
      const start = async () => {
        const store = new PostgresStore(url)
        await store.init()
        const { llm, requests } = translator()
        const language = new ServiceLanguage({
          store,
          llm,
          pack: { language: { agent: 'en' }, metadata: { id: 'agent-test' } } as AgentPack,
          stats: { emit: () => undefined },
          logger,
          preferredLanguage: async () => undefined,
          modelAllowed: async () => true,
        })
        return { store, language, requests }
      }
      const first = await start()
      try {
        expect(await first.language.render(sentence, person, session)).toBe(`[es] ${sentence.text}`)
        expect(first.requests).toHaveLength(1)
      } finally {
        await first.store.close()
      }
      // a new process over the same database: the sentence is kept, and costs no call
      const again = await start()
      try {
        expect(await again.language.render(sentence, person, session)).toBe(`[es] ${sentence.text}`)
        expect(again.requests).toHaveLength(0)
        const raw = new pg.Client({ connectionString: url })
        await raw.connect()
        const rows = (await raw.query('SELECT t::text AS row FROM translations t')).rows.map((r) => String(r.row))
        expect(rows).toHaveLength(1)
        await raw.end()
      } finally {
        await again.store.close()
      }
    })
  })

  describe('tools, phase 1, in the store (ayni-spec D97 to D100, schema 3.9.0)', () => {
    let url: string
    let store: PostgresStore
    beforeAll(async () => {
      url = await freshDatabase()
      // a store of the previous version, then this one
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.9.0'))) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      await client.end()
      store = new PostgresStore(url)
      await store.init()
    })
    afterAll(async () => {
      await store?.close()
    })

    it('adds the tables of the tools of the spaces, the accounts, the allowances and the call records', async () => {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const tables = (
        await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name IN ('space_tools', 'space_accounts', 'tool_allowances', 'tool_calls') ORDER BY 1"
        )
      ).rows.map((r) => r.table_name)
      expect(tables).toEqual(['space_accounts', 'space_tools', 'tool_allowances', 'tool_calls'])
      const versions = (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
      expect(versions).toContain('3.9.0')
      await client.end()
    })

    it('keeps a space account only as ciphertext, its fields sealed together, and its key goes with the row it replaces or clears (TOOL-ACCESS-004, D102)', async () => {
      // the four keys of an X account, sealed together as one record under one key
      const keys = {
        api_key: 'canaryKey0001',
        api_secret: 'canarySecret00000000000001',
        access_token: '1234-canaryAccess01',
        access_token_secret: 'canaryTokenSecret0000000001',
      }
      const seal = (values: Record<string, string>) => {
        const keyRef = crypto.newWrappedKey()
        return { keyRef, cipher: sealJson(crypto, keyRef, { values }).cipher.toString('base64') }
      }
      const first = seal(keys)
      await store.spaceAccounts.save({
        spaceId: 'spc_1',
        sourceId: 'relaticle',
        cipher: first.cipher,
        encKeyRef: first.keyRef,
        setAt: '2026-11-20T10:00:00.000Z',
        setByPrincipalId: 'p-jonas',
      })
      const raw = new pg.Client({ connectionString: url })
      await raw.connect()
      const rows = async () =>
        (await raw.query("SELECT t::text AS row, encode(cipher, 'escape') AS bytes FROM space_accounts t")).rows
      for (const row of await rows()) {
        expect(row.row).not.toContain('canary')
        expect(row.bytes).not.toContain('canary')
      }
      const got = await store.spaceAccounts.get('spc_1', 'relaticle')
      if (!got) throw new Error('no account')
      expect(openJson(crypto, got.encKeyRef, Buffer.from(got.cipher, 'base64'))).toEqual({ values: keys })
      expect(got).toMatchObject({
        sourceId: 'relaticle',
        setByPrincipalId: 'p-jonas',
        setAt: '2026-11-20T10:00:00.000Z',
      })
      // replaced: the former key is nowhere any more
      const second = seal({ ...keys, access_token: '1234-another0001' })
      await store.spaceAccounts.save({ ...got, cipher: second.cipher, encKeyRef: second.keyRef })
      expect(JSON.stringify(await rows())).not.toContain(first.keyRef)
      await store.spaceAccounts.delete('spc_1', 'relaticle')
      expect(await rows()).toEqual([])
      await raw.end()
    })

    it('keeps the tools of a space, the allowances of a conversation, and the call records by space, source and period', async () => {
      await store.spaceTools.save({
        spaceId: 'spc_1',
        sourceId: 'relaticle',
        added: true,
        bindings: { workspace: 'sales-eu' },
        calls: { 'create-note': 'approval' },
        updatedAt: '2026-11-20T10:00:00.000Z',
      })
      expect(await store.spaceTools.get('spc_1', 'relaticle')).toMatchObject({ bindings: { workspace: 'sales-eu' } })
      expect((await store.spaceTools.listBySpace('spc_1')).map((r) => r.sourceId)).toEqual(['relaticle'])
      await store.toolAllowances.save({
        approvalId: 'apr_1',
        conversationId: 'conv_1',
        sourceId: 'relaticle',
        toolName: 'create-note',
        spaceId: 'spc_1',
        fingerprint: 'f',
        since: '2026-11-20T10:00:00.000Z',
      })
      const allowance = await store.toolAllowances.get('apr_1')
      if (!allowance) throw new Error('no allowance')
      await store.toolAllowances.save({ ...allowance, endedAt: '2026-11-20T11:00:00.000Z' })
      expect(await store.toolAllowances.listByConversation('conv_1')).toEqual([
        expect.objectContaining({ approvalId: 'apr_1', endedAt: '2026-11-20T11:00:00.000Z' }),
      ])
      expect(await store.toolAllowances.listBySpaceSource('spc_1', 'relaticle')).toHaveLength(1)
      const call = (id: string, at: string, sourceId = 'relaticle') => ({
        id,
        at,
        principalId: 'p-ana',
        conversationId: 'conv_1',
        spaceId: 'spc_1',
        sourceId,
        toolName: 'create-note',
        account: { kind: 'space' as const, spaceId: 'spc_1' },
        rule: 'confirm' as const,
        raisedByUntrusted: false,
        outcome: 'completed' as const,
        updatedAt: at,
      })
      await store.toolCalls.save(call('tcl_1', '2026-11-18T10:00:00.000Z'))
      await store.toolCalls.save(call('tcl_2', '2026-11-20T10:00:00.000Z'))
      await store.toolCalls.save(call('tcl_3', '2026-11-20T11:00:00.000Z', 'websearch'))
      await store.toolCalls.save({ ...call('tcl_2', '2026-11-20T10:00:00.000Z'), outcome: 'refused' })
      const week = await store.toolCalls.list({
        spaceId: 'spc_1',
        sourceId: 'relaticle',
        from: '2026-11-19T00:00:00.000Z',
        to: '2026-11-21T00:00:00.000Z',
        limit: 10,
      })
      expect(week.map((r) => [r.id, r.outcome])).toEqual([['tcl_2', 'refused']])
      expect((await store.toolCalls.list({ principalId: 'p-ana', limit: 10 })).map((r) => r.id)).toEqual([
        'tcl_3',
        'tcl_2',
        'tcl_1',
      ])
    })

    it('keeps the arguments and the action of an approval only as ciphertext (INTX-APPR-014, D77)', async () => {
      const approvals = sealedApprovals(store.approvals, crypto)
      await approvals.save({
        id: 'apr_tool',
        kind: 'sensitivity',
        toolName: 'post_to_x',
        actionArgs: { text: 'canary post 5521' },
        action: {
          title: 'Post on X',
          source: { id: 'post_to_x', title: 'Post on X' },
          account: { kind: 'space', space: { id: 'spc_1', title: 'Communication' } },
          fields: [{ label: 'Post', value: 'canary post 5521' }],
        },
        requesterId: 'p-ana',
        requesterName: 'Ana',
        requesterRole: 'comms',
        originSessionId: 'ses_1',
        policy: { type: 'count', value: 1, vetoOnRefusal: false },
        eligibleRoles: [],
        decisions: [],
        status: 'PENDING',
        vetoed: false,
        expiresAt: '2026-11-20T11:00:00.000Z',
        createdAt: '2026-11-20T10:00:00.000Z',
        updatedAt: '2026-11-20T10:00:00.000Z',
      })
      const raw = new pg.Client({ connectionString: url })
      await raw.connect()
      const row = (await raw.query("SELECT t::text AS row FROM approvals t WHERE id = 'apr_tool'")).rows[0]?.row
      expect(row).not.toContain('canary post')
      expect(row).not.toContain('Communication')
      await raw.end()
      expect((await approvals.get('apr_tool'))?.action?.fields[0]?.value).toBe('canary post 5521')
      expect((await approvals.list({ requesterId: 'p-ana' }))[0]?.actionArgs).toEqual({ text: 'canary post 5521' })
    })
  })

  describe('tools, phase 2, in the store (ayni-spec D104 to D110, schema 3.10.0)', () => {
    let url: string
    let store: PostgresStore
    beforeAll(async () => {
      url = await freshDatabase()
      // a store of the previous version, then this one
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.10.0'))) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      await client.end()
      store = new PostgresStore(url)
      await store.init()
    })
    afterAll(async () => {
      await store?.close()
    })

    const account = (over: Partial<PersonalAccountRecord> = {}): PersonalAccountRecord => ({
      id: 'acc_1',
      principalId: 'p-ana',
      sourceId: 'relaticle',
      bindingValue: 'ws-1',
      bindingLabel: 'ayni-dev-agent',
      method: 'oauth',
      state: 'connected',
      cipher: '',
      encKeyRef: '',
      packDigest: 'pack',
      scopesDigest: 'scopes',
      connectedAt: '2026-11-21T10:00:00.000Z',
      ...over,
    })

    it('adds the tables of the person keys, the accounts, the attempts and the clients', async () => {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      const tables = (
        await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name IN ('person_keys', 'personal_accounts', 'oauth_attempts', 'oauth_clients') ORDER BY 1"
        )
      ).rows.map((r) => r.table_name)
      expect(tables).toEqual(['oauth_attempts', 'oauth_clients', 'person_keys', 'personal_accounts'])
      const versions = (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
      expect(versions).toContain('3.10.0')
      await client.end()
    })

    it("keeps a person's account only as ciphertext under a key wrapped by the person's, which its deletion destroys", async () => {
      const person = await store.personKeys.saveIfAbsent({
        principalId: 'p-ana',
        wrappedKey: crypto.newWrappedKey(),
        createdAt: '2026-11-21T10:00:00.000Z',
      })
      // a second key of the same person keeps the first (D106)
      expect(
        (
          await store.personKeys.saveIfAbsent({
            principalId: 'p-ana',
            wrappedKey: 'other',
            createdAt: '2026-11-21T10:00:00.000Z',
          })
        ).wrappedKey
      ).toBe(person.wrappedKey)
      const keyRef = newKeyUnder(crypto, person.wrappedKey)
      const secret = { tokens: { accessToken: 'canaryAccess0001', refreshToken: 'canaryRefresh0001' } }
      await store.personalAccounts.save(
        account({
          cipher: sealUnder(crypto, person.wrappedKey, keyRef, secret).toString('base64'),
          labelCipher: sealUnder(crypto, person.wrappedKey, keyRef, { label: 'canary label' }).toString('base64'),
          encKeyRef: keyRef,
        })
      )
      const raw = new pg.Client({ connectionString: url })
      await raw.connect()
      const rows = async () =>
        (
          await raw.query(
            "SELECT t::text AS row, encode(cipher, 'escape') AS bytes, encode(label_cipher, 'escape') AS label FROM personal_accounts t"
          )
        ).rows
      for (const row of await rows()) for (const v of Object.values(row)) expect(String(v)).not.toContain('canary')
      const got = await store.personalAccounts.find('p-ana', 'relaticle', 'ws-1')
      expect(got).toMatchObject({ bindingValue: 'ws-1', bindingLabel: 'ayni-dev-agent', state: 'connected' })
      expect(
        openUnder(crypto, person.wrappedKey, got?.encKeyRef as string, Buffer.from(got?.cipher as string, 'base64'))
      ).toEqual(secret)
      // the master key alone opens nothing of it
      expect(() => crypto.decrypt(got?.encKeyRef as string, Buffer.from(got?.cipher as string, 'base64'))).toThrow()
      // a new account for the same value replaces the row, and its key with it (TOOL-CONN-002)
      await store.personalAccounts.save(account({ id: 'acc_2', cipher: 'AA==', encKeyRef: 'second' }))
      expect((await rows()).map((r) => r.row).join()).not.toContain(keyRef)
      expect(await store.personalAccounts.get('acc_1')).toBeUndefined()
      // a write of an account that is gone brings nothing back; a use is written alone
      expect(await store.personalAccounts.update(account({ id: 'acc_1' }))).toBe(false)
      expect(
        await store.personalAccounts.update(
          account({ id: 'acc_2', state: 'reconnect', reason: 'revoked', cipher: '', encKeyRef: '' })
        )
      ).toBe(true)
      await store.personalAccounts.touch('acc_2', '2026-11-21T11:00:00.000Z')
      expect(await store.personalAccounts.get('acc_2')).toMatchObject({
        state: 'reconnect',
        reason: 'revoked',
        lastUsedAt: '2026-11-21T11:00:00.000Z',
      })
      expect((await store.personalAccounts.listByPrincipal('p-ana')).map((a) => a.id)).toEqual(['acc_2'])
      await store.personKeys.delete('p-ana')
      expect(await store.personKeys.get('p-ana')).toBeUndefined()
      await store.personalAccounts.delete('acc_2')
      expect(await rows()).toEqual([])
      await raw.end()
    })

    it('finds an attempt by the digest of its state, for one use only (TOOL-OAUTH-006)', async () => {
      await store.oauthAttempts.save({
        id: 'att_1',
        principalId: 'p-ana',
        originSessionId: 'ses_1',
        sourceId: 'github',
        stateHash: 'hash-1',
        issuer: 'https://github.com/login/oauth',
        issParameterSupported: false,
        resource: 'https://api.githubcopilot.com/mcp/',
        scopes: [],
        clientRef: 'pre-registered|https://github.com/login/oauth|Iv1',
        verifierCipher: 'AA==',
        encKeyRef: 'k',
        createdAt: '2026-11-21T10:00:00.000Z',
        expiresAt: '2026-11-21T10:10:00.000Z',
      })
      expect((await store.oauthAttempts.findByStateHash('hash-1'))?.id).toBe('att_1')
      expect((await store.oauthAttempts.listWaiting()).map((a) => a.id)).toEqual(['att_1'])
      const [first, second] = await Promise.all([
        store.oauthAttempts.claim('att_1', 'failed', '2026-11-21T10:01:00.000Z'),
        store.oauthAttempts.claim('att_1', 'failed', '2026-11-21T10:01:00.000Z'),
      ])
      expect([first, second].sort()).toEqual([false, true])
      expect(await store.oauthAttempts.listWaiting()).toEqual([])
      expect((await store.oauthAttempts.get('att_1'))?.outcome).toBe('failed')
      await store.oauthClients.save({
        ref: 'dynamic|https://crm.2060.io',
        issuer: 'https://crm.2060.io',
        registration: 'dynamic',
        clientId: 'client_1',
        redirectUri: 'https://dev-agent.dev.ayni.org/tools/oauth/callback',
        registeredAt: '2026-11-21T10:00:00.000Z',
      })
      expect((await store.oauthClients.get('dynamic|https://crm.2060.io'))?.clientId).toBe('client_1')
    })

    it('keeps the attempt of an account several sources use: no resource, its sources, its sealed nonce (D118)', async () => {
      const attempt = {
        id: 'att_g1',
        principalId: 'p-ana',
        originSessionId: 'ses_1',
        sourceId: 'google',
        allow: ['drive'],
        stateHash: 'hash-g1',
        issuer: 'https://accounts.google.com',
        issParameterSupported: false,
        scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'],
        clientRef: 'pre-registered|https://accounts.google.com|client-of-the-tests',
        verifierCipher: 'AA==',
        nonceCipher: 'AQ==',
        encKeyRef: 'k',
        createdAt: '2026-11-25T10:00:00.000Z',
        expiresAt: '2026-11-25T10:10:00.000Z',
      }
      await store.oauthAttempts.save(attempt)
      const kept = await store.oauthAttempts.findByStateHash('hash-g1')
      expect(kept).toEqual(attempt)
      expect(kept?.resource).toBeUndefined()
    })
  })

  describe('the device secrets an earlier version kept are erased (D51, IDENT-DEV-001, schema 3.11.0)', () => {
    it('leaves no plaintext device secret on any session record, and the rest of the record as it was', async () => {
      const url = await freshDatabase()
      // a store of the previous version, whose sessions kept the secret their client had collected
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.11.0'))) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      const session = (id: string, over: Partial<Session> = {}) =>
        ({
          id,
          principalId: 'p-ana',
          channelType: 'ag-ui',
          externalRef: id,
          state: 'bound',
          client: { name: 'ayni-ui', version: '0.22.0', platform: 'web' },
          deviceHandle: 'dev_1',
          lastActivityAt: '2026-11-22T10:00:00.000Z',
          createdAt: '2026-11-22T10:00:00.000Z',
          streamCursor: 0,
          ...over,
        }) as Session
      for (const s of [session('ses_kept', { deviceSecret: 'dsk_canary0001' }), session('ses_none')])
        await client.query(
          `INSERT INTO sessions (id, principal_id, channel_type, external_ref, state, last_activity_at, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [s.id, s.principalId, s.channelType, s.externalRef, s.state, s.lastActivityAt, JSON.stringify(s)]
        )
      await client.end()
      const store = new PostgresStore(url)
      await store.init()
      const raw = new pg.Client({ connectionString: url })
      await raw.connect()
      const rows = (await raw.query('SELECT id, data::text AS data FROM sessions ORDER BY id')).rows
      const versions = (await raw.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
      await raw.end()
      expect(versions).toContain('3.11.0')
      expect(rows.map((r) => r.id)).toEqual(['ses_kept', 'ses_none'])
      expect(rows.map((r) => r.data).join('')).not.toContain('dsk_canary0001')
      expect(rows.map((r) => r.data).join('')).not.toContain('deviceSecret')
      expect(await store.sessions.get('ses_kept')).toMatchObject({ deviceHandle: 'dev_1', state: 'bound' })
      await store.close()
    })
  })

  describe('one owner of a space, approval policies and the notices of governance (D135 to D142, schema 3.12.0)', () => {
    it('keeps the first owner of a space and gives a waiting approval of the owner the policy it was asked under', async () => {
      const url = await freshDatabase()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.12.0'))) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      const at = '2026-11-23T10:00:00.000Z'
      const space = {
        id: 'spc_1',
        agentId: 'ayni-dev',
        kind: 'team',
        templateId: 'comms',
        title: '',
        purpose: '',
        brief: '',
        language: null,
        rules: { retentionDays: 365, lawfulBasis: 'contract', allowedProviders: ['stub'], handover: false },
        membership: { mode: 'list' },
        ownerIds: ['p-jonas', 'p-ana'],
        createdAt: at,
        updatedAt: at,
      }
      await client.query(
        `INSERT INTO spaces (id, agent_id, kind, template_id, membership_mode, created_at, updated_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [space.id, space.agentId, space.kind, space.templateId, 'list', at, at, JSON.stringify(space)]
      )
      const approval = (id: string, ownerApproval: boolean) => ({
        id,
        kind: 'sensitivity',
        toolName: 'post_to_x',
        requesterId: 'p-ana',
        requesterName: 'ana',
        requesterRole: 'comms',
        originSessionId: 'ses_1',
        policy: { type: 'count', value: 1, vetoOnRefusal: false },
        eligibleRoles: [],
        decisions: [],
        status: 'PENDING',
        vetoed: false,
        expiresAt: at,
        createdAt: at,
        updatedAt: at,
        ...(ownerApproval ? { ownerApproval: true, spaceId: 'spc_1' } : {}),
      })
      for (const [id, owner] of [
        ['apr_owner', true],
        ['apr_roles', false],
      ] as const)
        await client.query(
          'INSERT INTO approvals (id, status, requester_id, eligible_roles, data) VALUES ($1,$2,$3,$4,$5)',
          [id, 'PENDING', 'p-ana', [], JSON.stringify(approval(id, owner))]
        )
      await client.end()
      const store = new PostgresStore(url)
      await store.init()
      const migrated = await store.spaces.get('spc_1')
      expect(migrated?.ownerPrincipalId).toBe('p-jonas')
      expect(migrated).not.toHaveProperty('ownerIds')
      expect(await store.approvals.get('apr_owner')).toMatchObject({
        spaceId: 'spc_1',
        spacePolicy: {
          approvers: [{ kind: 'owner', required: true }],
          threshold: 1,
          refusal: 'any',
          attested: true,
          whenApproverAsks: 'own-confirmation',
        },
      })
      expect(await store.approvals.get('apr_owner')).not.toHaveProperty('ownerApproval')
      expect(await store.approvals.get('apr_roles')).not.toHaveProperty('spacePolicy')
      // a notice of governance: one person's, open until resolved
      const notice = {
        id: 'ntc_1',
        principalId: 'p-jonas',
        spaceId: 'spc_1',
        kind: 'policy-attention' as const,
        at,
        subject: { space: { id: 'spc_1', title: 'Communication' } },
      }
      await store.governanceNotices.save(notice)
      expect(await store.governanceNotices.list({ principalId: 'p-jonas', open: true })).toEqual([notice])
      await store.governanceNotices.save({ ...notice, resolvedAt: '2026-11-23T11:00:00.000Z' })
      expect(await store.governanceNotices.list({ spaceId: 'spc_1', open: true })).toEqual([])
      expect((await store.governanceNotices.get('ntc_1'))?.resolvedAt).toBe('2026-11-23T11:00:00.000Z')
      await store.close()
    })
  })

  describe('the credentials issued to a person (IDENT-AUTH-016, INTX-ISSUE-022, D156, schema 3.14.0)', () => {
    it('drops the column of the connection, and finds the issuances by the Principal, on any connection', async () => {
      const url = await freshDatabase()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.14.0'))) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      const issued = (id: string, principalId: string, at: string, over: Record<string, unknown> = {}) => ({
        id,
        principalId,
        kind: 'issuance',
        entry: 'issuance:badge',
        outcome: 'verified',
        revealed: [],
        unrevealed: [],
        stored: [],
        connectionRef: 'conn-1',
        verifiedAt: at,
        state: 'active',
        contentDigest: '',
        encKeyRef: null,
        ...over,
      })
      // a badge issued while the column was read
      await client.query(
        'INSERT INTO evidence (id, principal_id, state, verified_at, data, issued_on) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          'evd_old',
          'p-ana',
          'active',
          '2026-11-20T10:00:00.000Z',
          JSON.stringify(issued('evd_old', 'p-ana', '2026-11-20T10:00:00.000Z')),
          'conn-1',
        ]
      )
      await client.end()
      const store = new PostgresStore(url)
      await store.init()
      await store.evidence.save({
        ...issued('evd_new', 'p-ana', '2026-11-21T10:00:00.000Z', {
          connectionRef: 'conn-2',
          validUntil: '2026-12-31',
        }),
        cipher: null,
      } as never)
      await store.evidence.save({
        ...issued('evd_other', 'p-jonas', '2026-11-22T10:00:00.000Z'),
        cipher: null,
      } as never)
      expect((await store.evidence.list('p-ana')).map((r) => [r.id, r.connectionRef])).toEqual([
        ['evd_old', 'conn-1'],
        ['evd_new', 'conn-2'],
      ])
      expect((await store.evidence.get('evd_new'))?.validUntil).toBe('2026-12-31')
      const check = new pg.Client({ connectionString: url })
      await check.connect()
      const { rows } = await check.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'evidence' AND column_name = 'issued_on'"
      )
      await check.end()
      expect(rows).toEqual([])
      await store.close()
    })
  })

  describe('features and providers in the store (ayni-spec D120 to D123, TOOL-FEAT-006, TOOL-FEAT-016, schema 3.15.0)', () => {
    it("keeps the tools a space held before features, and the mark of each feature's provider, renewed in place", async () => {
      const url = await freshDatabase()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.15.0'))) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      // a source a space held before features: kept by its source, the provider of its feature (TOOL-FEAT-006)
      const held = {
        spaceId: 'spc_sales',
        sourceId: 'relaticle',
        added: true,
        bindings: { workspace: 'sales-eu' },
        calls: { 'create-note': 'approval' },
        updatedAt: '2026-11-20T10:00:00.000Z',
      }
      await client.query('INSERT INTO space_tools (space_id, source_id, data) VALUES ($1,$2,$3)', [
        held.spaceId,
        held.sourceId,
        JSON.stringify(held),
      ])
      await client.end()
      const store = new PostgresStore(url)
      await store.init()
      expect(await store.spaceTools.get('spc_sales', 'relaticle')).toEqual(held)
      // the location list of a feature with a contract, in the record of its provider
      const files = {
        spaceId: 'spc_alpha',
        sourceId: 'nextcloud',
        added: true,
        bindings: {},
        calls: {},
        list: { entries: [{ values: { root: '48213' }, label: '/Projects/Alpha' }] },
        updatedAt: '2026-11-25T10:00:00.000Z',
      }
      await store.spaceTools.save(files)
      expect(await store.spaceTools.get('spc_alpha', 'nextcloud')).toEqual(files)
      // one mark per space and feature: a new provider overwrites it (TOOL-FEAT-016)
      expect(await store.featureMarks.get('spc_alpha', 'files')).toBeUndefined()
      const at = '2026-11-25T10:00:00.000Z'
      await store.featureMarks.save({
        spaceId: 'spc_alpha',
        featureId: 'files',
        sourceId: 'nextcloud',
        mark: 'k7QdXy',
        createdAt: at,
      })
      await store.featureMarks.save({
        spaceId: personalSpaceId('prn-ana'),
        featureId: 'files',
        sourceId: 'my-drive',
        mark: 'Pq4Rs9',
        createdAt: at,
      })
      await store.featureMarks.save({
        spaceId: 'spc_alpha',
        featureId: 'files',
        sourceId: 'drive',
        mark: 'Zz81Bc',
        createdAt: at,
      })
      expect(await store.featureMarks.get('spc_alpha', 'files')).toEqual({
        spaceId: 'spc_alpha',
        featureId: 'files',
        sourceId: 'drive',
        mark: 'Zz81Bc',
        createdAt: at,
      })
      expect((await store.featureMarks.get(personalSpaceId('prn-ana'), 'files'))?.mark).toBe('Pq4Rs9')
      await store.featureMarks.delete('spc_alpha', 'files')
      expect(await store.featureMarks.get('spc_alpha', 'files')).toBeUndefined()
      const check = new pg.Client({ connectionString: url })
      await check.connect()
      const { rows } = await check.query('SELECT version FROM schema_migrations ORDER BY applied_at, version')
      await check.end()
      expect(rows.map((r) => r.version)).toContain('3.15.0')
      await store.close()
    })
  })

  describe("a team space's managed folder in the store (ayni-spec D145 to D150, TOOL-FEAT-034, PROF-TOOL-042, schema 3.16.0)", () => {
    it('keeps each folder and each membership the agent made, with no address, and the notices of the owner', async () => {
      const url = await freshDatabase()
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(
        'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      for (const m of MIGRATIONS.filter((m) => olderThan(m.version, '3.16.0'))) {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
      }
      // before 3.16.0 a notice of a member's access is refused by the kinds the table takes
      await expect(
        client.query(
          "INSERT INTO governance_notices (id, principal_id, space_id, kind, at, data) VALUES ('ntc_0', 'p-jonas', 'spc_alpha', 'folder-access', now(), '{}')"
        )
      ).rejects.toThrow()
      await client.end()
      const store = new PostgresStore(url)
      await store.init()
      const at = '2026-11-25T10:00:00.000Z'
      expect(await store.managedFolders.get('spc_alpha', 'files')).toBeUndefined()
      const folder = {
        spaceId: 'spc_alpha',
        featureId: 'files',
        sourceId: 'cloud-team',
        ref: 'team-1',
        name: 'Project Alpha',
        requestId: 'ayni-spc_alpha-files',
        state: 'ready' as const,
        managedWith: 'manager' as const,
        managers: false,
        webUrl: 'https://cloud.example.org/f/team-1',
        addedOutside: [{ name: 'Boss' }],
        baseline: ['sh-1-0'],
        attempts: 0,
        lastReadAt: at,
        createdAt: at,
        updatedAt: at,
      }
      await store.managedFolders.save(folder)
      await store.managedFolders.save({ ...folder, spaceId: 'spc_beta', state: 'creating', reason: 'not-connected' })
      expect(await store.managedFolders.get('spc_alpha', 'files')).toEqual(folder)
      await store.managedFolders.save({ ...folder, name: 'Alpha Files' })
      expect((await store.managedFolders.get('spc_alpha', 'files'))?.name).toBe('Alpha Files')
      expect((await store.managedFolders.listAll()).map((f) => f.spaceId)).toEqual(['spc_alpha', 'spc_beta'])
      const ana = {
        spaceId: 'spc_alpha',
        featureId: 'files',
        principalId: 'p-ana',
        role: 'editor' as const,
        shareId: 'sh-2',
        state: 'in-place' as const,
        attempts: 0,
        updatedAt: at,
      }
      const piet = {
        ...ana,
        principalId: 'p-piet',
        state: 'failed' as const,
        reason: 'not-allowed' as const,
        attempts: 1,
        firstFailedAt: at,
      }
      await store.folderMemberships.save(ana)
      await store.folderMemberships.save(piet)
      await store.folderMemberships.save({ ...ana, spaceId: 'spc_beta' })
      expect(await store.folderMemberships.listByFolder('spc_alpha', 'files')).toEqual([ana, piet])
      await store.folderMemberships.save({ ...ana, role: 'reader' })
      expect((await store.folderMemberships.listByFolder('spc_alpha', 'files'))[0]?.role).toBe('reader')
      await store.folderMemberships.delete('spc_alpha', 'files', 'p-piet')
      expect(await store.folderMemberships.listByFolder('spc_alpha', 'files')).toHaveLength(1)
      // the notice of a member whose access failed, to the owner, waiting until resolved (PROF-TOOL-042)
      const notice = {
        id: 'ntc_folder',
        principalId: 'p-jonas',
        spaceId: 'spc_alpha',
        kind: 'folder-access' as const,
        at,
        subject: {
          space: { id: 'spc_alpha', title: 'Project Alpha' },
          member: { name: 'Piet' },
          feature: { id: 'files', title: 'Files' },
          source: { id: 'cloud-team', title: 'Nextcloud' },
          folder: { title: 'Alpha Files' },
          folderReason: 'not-allowed' as const,
          memberPrincipalId: 'p-piet',
        },
      }
      await store.governanceNotices.save(notice)
      expect(await store.governanceNotices.list({ spaceId: 'spc_alpha', kind: 'folder-access', open: true })).toEqual([
        notice,
      ])
      // released: the folder and its memberships leave the store; the other space's stay
      await store.managedFolders.delete('spc_alpha', 'files')
      await store.folderMemberships.deleteByFolder('spc_alpha', 'files')
      expect(await store.managedFolders.get('spc_alpha', 'files')).toBeUndefined()
      expect(await store.folderMemberships.listByFolder('spc_alpha', 'files')).toEqual([])
      expect(await store.folderMemberships.listByFolder('spc_beta', 'files')).toHaveLength(1)
      const check = new pg.Client({ connectionString: url })
      await check.connect()
      const { rows } = await check.query(
        'SELECT data FROM folder_memberships UNION ALL SELECT data FROM managed_folders'
      )
      const versions = await check.query('SELECT version FROM schema_migrations')
      await check.end()
      expect(JSON.stringify(rows)).not.toContain('@')
      expect(versions.rows.map((r) => r.version)).toContain('3.16.0')
      await store.close()
    })
  })

  it('keeps what a person enrolled sealed, a passkey found by a keyed index of its id (IDENT-AUTH-014)', async () => {
    const url = await freshDatabase()
    const store = new PostgresStore(url)
    await store.init()
    const enrolments = new EnrolmentStore(store.kv, crypto)
    await enrolments.setAuthenticatorApp('prn-ana', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    const passkey = {
      credentialId: 'cred-1',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      alg: -7,
      signCount: 0,
    }
    await enrolments.setPasskey('prn-ana', passkey)
    expect(await enrolments.principalOfPasskey('cred-1')).toBe('prn-ana')
    expect((await enrolments.types('prn-ana')).map((e) => e.type)).toEqual(['authenticator-app', 'passkey'])
    // neither the secret nor the credential id is in the clear
    const pool = new pg.Client({ connectionString: url })
    await pool.connect()
    const rows = (await pool.query('SELECT key, value FROM kv')).rows as { key: string; value: string }[]
    await pool.end()
    expect(JSON.stringify(rows)).not.toContain('GEZDGNBVGY3TQOJQ')
    expect(JSON.stringify(rows)).not.toContain('cred-1')
    // a new passkey replaces the earlier one; unenrol and erase remove them
    await enrolments.setPasskey('prn-ana', { ...passkey, credentialId: 'cred-2' })
    expect(await enrolments.principalOfPasskey('cred-1')).toBeUndefined()
    expect(await enrolments.remove('prn-ana', 'authenticator-app')).toBe(true)
    await enrolments.erase('prn-ana')
    expect(await enrolments.types('prn-ana')).toEqual([])
    expect(await enrolments.principalOfPasskey('cred-2')).toBeUndefined()
    await store.close()
  })

  it('keeps an admin grant across a restart with its end, and records it with its grant (RBAC-ADMIN-003/007)', async () => {
    const url = await freshDatabase()
    const jonas = { id: 'prn-jonas', roles: ['auditor'], actorIdentity: 'did:peer:jonas' } as unknown as Principal
    const browser = { id: 'ses-1', deviceHandle: 'dev-1', client: { name: 'ui', version: '1', platform: 'web' } }
    const pack = { identity: { roles: { auditor: {} } }, admin: { authentication: { methods: ['otp'] } } } as never
    const grantsOn = (store: PostgresStore) =>
      new AdminGrants(
        pack,
        store.kv,
        new AdminService({ store, logger } as never),
        {
          reauthenticate: async () => 'accepted',
          principal: async (id) => (id === jonas.id ? jonas : undefined),
          announce: async () => undefined,
        },
        logger,
        { requestMs: 60_000 }
      )
    const first = new PostgresStore(url)
    await first.init()
    const grants = grantsOn(first)
    await grants.request(jonas, browser as unknown as Session)
    await grants.waitFor(browser)
    const state = await grants.state(jonas, browser as unknown as Session)
    expect(state).toEqual({ roles: ['auditor'], grant: { open: true, expiresAt: expect.any(String) } })
    const [opened] = await first.adminAudit.list(1)
    expect(opened).toMatchObject({ action: 'admin-grant-opened', principalId: jonas.id, grantId: expect.any(String) })
    grants.stop()
    await first.close()
    // the next process reads the grant, its end unchanged, and ends it on Hide Admin
    const second = new PostgresStore(url)
    await second.init()
    const again = grantsOn(second)
    expect(await again.state(jonas, browser as unknown as Session)).toEqual(state)
    await again.hide(jonas, browser as unknown as Session)
    expect(await again.state(jonas, browser as unknown as Session)).toEqual({ roles: ['auditor'], grant: null })
    expect((await second.adminAudit.list(1))[0]).toMatchObject({
      action: 'admin-grant-ended',
      grantId: opened?.grantId,
      reason: 'hidden',
    })
    expect(deviceOf(browser)).toBe('dev-1')
    again.stop()
    await second.close()
  })

  it("keeps the phone's connection on a session made through a session grant: its admin grant is the phone's (RBAC-ADMIN-003)", async () => {
    const url = await freshDatabase()
    const store = new PostgresStore(url)
    await store.init()
    await store.sessions.save({
      ...session('ses-phone', 'p1', 'conv_phone'),
      deviceHandle: 'dev-9',
      grantConnectionId: 'conn-1',
    })
    const [read] = await store.sessions.listByPrincipal('p1')
    expect(read).toMatchObject({ deviceHandle: 'dev-9', grantConnectionId: 'conn-1' })
    expect(deviceOf(read as Session)).toBe('phone:conn-1')
    await store.close()
  })
})
