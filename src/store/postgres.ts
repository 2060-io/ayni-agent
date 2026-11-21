/** PostgreSQL store with pgvector (TOOL-HTTP-004, MEM-RET-002, PRIV-SCOPE-005). */
import pg from 'pg'
import type {
  ApprovalRecord,
  AuthChallengeRecord,
  Conversation,
  DigestAnchor,
  ElevationGrant,
  LifecycleState,
  MemoryAccessLog,
  OAuthAttemptRecord,
  OAuthClientRecord,
  PersonalAccountRecord,
  PersonKeyRecord,
  Principal,
  PrincipalPreference,
  RagChunk,
  Session,
  Space,
  SpaceAccountRecord,
  SpaceActivity,
  SpaceMember,
  SpaceToolRecord,
  StatEvent,
  ToolAllowance,
  ToolCallRecord,
  WorkingMemoryNote,
} from '../core/types.js'
import { type ScopePredicate, STORE_SHAPES, scopeToSql } from '../memory/scope.js'
import { MemoryStore } from './memory.js'
import { MIGRATIONS } from './migrations.js'
import { holdProcessLock, type ProcessLockOptions } from './processLock.js'
import type {
  AdminAuditRecord,
  EntryQuery,
  Store,
  StoredEntry,
  StoredEvidence,
  ToolCallQuery,
  TranslationRecord,
  VectorHit,
} from './types.js'

const vec = (v: number[]): string => `[${v.join(',')}]`

type Row = Record<string, unknown>

export class PostgresStore implements Store {
  public readonly kind = 'postgres' as const
  private readonly pool: pg.Pool

  public constructor(private readonly databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 })
  }

  /** A connection of its own holds the lock for the life of the process: never one of the pool's. */
  public exclusive(options: ProcessLockOptions): Promise<() => Promise<void>> {
    const connection = new pg.Client({
      connectionString: this.databaseUrl,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    })
    return holdProcessLock(connection, options)
  }

  public async init(): Promise<void> {
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    )
    const applied = new Set(
      (await this.pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string)
    )
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
  }

  public async close(): Promise<void> {
    await this.pool.end()
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(sql, params)).rows as Row[]
  }

  private async one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const [row] = await this.rows(sql, params)
    return row ? (row.data as T) : undefined
  }

  private async many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.rows(sql, params)).map((r) => r.data as T)
  }

  public principals = {
    get: (id: string) => this.one<Principal>('SELECT data FROM principals WHERE id = $1', [id]),
    findByActor: (actor: string) =>
      this.one<Principal>('SELECT data FROM principals WHERE actor_identity = $1', [actor]),
    findByCapabilityChannel: (channelId: string) =>
      this.one<Principal>('SELECT data FROM principals WHERE capability_channel_id = $1', [channelId]),
    save: async (p: Principal) => {
      await this.pool.query(
        `INSERT INTO principals (id, actor_identity, capability_channel_id, data, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET actor_identity = $2, capability_channel_id = $3, data = $4, updated_at = now()`,
        [p.id, p.actorIdentity, p.capabilityChannelId, p]
      )
    },
    list: () => this.many<Principal>('SELECT data FROM principals ORDER BY updated_at DESC'),
  }

  public sessions = {
    get: (id: string) => this.one<Session>('SELECT data FROM sessions WHERE id = $1', [id]),
    save: async (s: Session) => {
      await this.pool.query(
        `INSERT INTO sessions (id, principal_id, channel_type, external_ref, state, token_hash, nonce, out_of_band_id,
           question_connection_id, question_thread_id, stream_cursor, last_activity_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET principal_id=$2, channel_type=$3, external_ref=$4, state=$5, token_hash=$6, nonce=$7,
           out_of_band_id=$8, question_connection_id=$9, question_thread_id=$10, stream_cursor=GREATEST(sessions.stream_cursor, $11),
           last_activity_at=$12, data=$13`,
        [
          s.id,
          s.principalId,
          s.channelType,
          s.externalRef,
          s.state,
          s.tokenHash ?? null,
          s.binding?.nonce ?? null,
          s.binding?.outOfBandId ?? null,
          s.binding?.connectionId ?? null,
          s.binding?.questionThreadId ?? null,
          s.streamCursor,
          s.lastActivityAt,
          s,
        ]
      )
    },
    findByTokenHash: (hash: string) => this.one<Session>('SELECT data FROM sessions WHERE token_hash = $1', [hash]),
    findByNonce: (nonce: string) => this.one<Session>('SELECT data FROM sessions WHERE nonce = $1', [nonce]),
    findByOutOfBandId: (oobId: string) =>
      this.one<Session>('SELECT data FROM sessions WHERE out_of_band_id = $1', [oobId]),
    findByQuestionThread: (connectionId: string, threadId: string) =>
      this.one<Session>('SELECT data FROM sessions WHERE question_connection_id = $1 AND question_thread_id = $2', [
        connectionId,
        threadId,
      ]),
    findByExternalRef: (channelType: Session['channelType'], ref: string) =>
      this.one<Session>(
        "SELECT data FROM sessions WHERE channel_type = $1 AND external_ref = $2 AND state <> 'closed' ORDER BY last_activity_at DESC LIMIT 1",
        [channelType, ref]
      ),
    listByPrincipal: (principalId: string, states?: Session['state'][]) =>
      states
        ? this.many<Session>('SELECT data FROM sessions WHERE principal_id = $1 AND state = ANY($2)', [
            principalId,
            states,
          ])
        : this.many<Session>('SELECT data FROM sessions WHERE principal_id = $1', [principalId]),
    listByState: (state: Session['state']) => this.many<Session>('SELECT data FROM sessions WHERE state = $1', [state]),
    nextStreamCursor: async (id: string) => {
      const [row] = await this.rows(
        `UPDATE sessions SET stream_cursor = stream_cursor + 1, data = jsonb_set(data, '{streamCursor}', to_jsonb(stream_cursor + 1))
         WHERE id = $1 RETURNING stream_cursor`,
        [id]
      )
      if (!row) throw new Error(`session ${id} not found`)
      return Number(row.stream_cursor)
    },
  }

  public conversations = {
    get: (id: string) => this.one<Conversation>('SELECT data FROM conversations WHERE id = $1', [id]),
    listAll: () => this.many<Conversation>('SELECT data FROM conversations'),
    save: async (c: Conversation) => {
      await this.pool.query(
        `INSERT INTO conversations (id, principal_id, state, last_activity_at, space_id, shared_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET principal_id=$2, state=$3, last_activity_at=$4, space_id=$5, shared_at=$6, data=$7`,
        [
          c.id,
          c.principalId,
          c.state,
          c.lastActivityAt,
          c.spaceId ?? `personal:${c.principalId}`,
          c.sharedAt ?? null,
          c,
        ]
      )
    },
    listBySpace: (spaceId: string, opts: { shared?: boolean } = {}) =>
      this.many<Conversation>(
        `SELECT data FROM conversations WHERE space_id = $1${opts.shared ? ' AND shared_at IS NOT NULL' : ''}
         ORDER BY last_activity_at DESC`,
        [spaceId]
      ),
    listByPrincipal: (principalId: string, states?: Conversation['state'][]) =>
      states
        ? this.many<Conversation>(
            'SELECT data FROM conversations WHERE principal_id = $1 AND state = ANY($2) ORDER BY last_activity_at DESC',
            [principalId, states]
          )
        : this.many<Conversation>(
            'SELECT data FROM conversations WHERE principal_id = $1 ORDER BY last_activity_at DESC',
            [principalId]
          ),
  }

  private entryFromRow(r: Row): StoredEntry {
    const data = r.data as StoredEntry
    const spaceId = (r.space_id as string | null) ?? data.spaceId
    return {
      ...data,
      conversationId: String(r.conversation_id ?? data.conversationId),
      ...(spaceId ? { spaceId } : {}),
      cipher: (r.cipher as Buffer | null) ?? null,
    }
  }

  private entryData(e: StoredEntry): Omit<StoredEntry, 'cipher'> {
    const { cipher: _c, ...data } = e
    return data
  }

  /** the WHERE of an entry query beyond its scope: its conversation, roles, author, and its place in the order */
  private entryFilters(q: EntryQuery, alias: string, params: unknown[]): string[] {
    const where: string[] = []
    const next = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    if (q.conversationId) where.push(`${alias}.conversation_id = ${next(q.conversationId)}`)
    if (q.sourceTypes) where.push(`${alias}.source_type = ANY(${next(q.sourceTypes)})`)
    if (q.roles) where.push(`${alias}.role = ANY(${next(q.roles)})`)
    if (q.principalId) where.push(`${alias}.principal_id = ${next(q.principalId)}`)
    if (q.before) {
      where.push(
        `(${alias}.initiated_at, ${alias}.id) < (SELECT initiated_at, id FROM entries WHERE id = ${next(q.before)})`
      )
    }
    if (q.from) {
      where.push(
        `(${alias}.initiated_at, ${alias}.id) >= (${next(q.from.initiatedAt)}::timestamptz, ${next(q.from.id)})`
      )
    }
    if (q.until) {
      where.push(
        `(${alias}.initiated_at, ${alias}.id) < (${next(q.until.initiatedAt)}::timestamptz, ${next(q.until.id)})`
      )
    }
    return where
  }

  public entries = {
    insert: async (e: StoredEntry) => {
      await this.pool.query(
        `INSERT INTO entries (id, session_id, conversation_id, principal_id, role, source_type, completion, visibility, state,
           backing_identity_id, language, content_digest, enc_key_ref, cipher, external_id, initiated_at, created_at,
           anchor_batch_id, data, space_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          e.id,
          e.sessionId,
          e.conversationId,
          e.principalId,
          e.role,
          e.sourceType,
          e.completion,
          e.visibility,
          e.state,
          e.backingIdentity?.id ?? null,
          e.language,
          e.contentDigest,
          e.encKeyRef,
          e.cipher,
          e.externalId ?? null,
          e.initiatedAt,
          e.createdAt,
          e.anchorBatchId ?? null,
          this.entryData(e),
          e.spaceId ?? (e.principalId ? `personal:${e.principalId}` : null),
        ]
      )
    },
    get: async (id: string) => {
      const [row] = await this.rows('SELECT * FROM entries WHERE id = $1', [id])
      return row ? this.entryFromRow(row) : undefined
    },
    update: async (id: string, patch: Partial<StoredEntry>) => {
      const current = await this.entries.get(id)
      if (!current) return
      const next = { ...current, ...patch }
      await this.pool.query(
        `UPDATE entries SET state=$2, completion=$3, enc_key_ref=$4, cipher=$5, content_digest=$6, anchor_batch_id=$7, external_id=$8, data=$9 WHERE id=$1`,
        [
          id,
          next.state,
          next.completion,
          next.encKeyRef,
          next.cipher,
          next.contentDigest,
          next.anchorBatchId ?? null,
          next.externalId ?? null,
          this.entryData(next),
        ]
      )
    },
    findByExternalId: async (sessionId: string, externalId: string) => {
      const [row] = await this.rows('SELECT * FROM entries WHERE session_id = $1 AND external_id = $2 LIMIT 1', [
        sessionId,
        externalId,
      ])
      return row ? this.entryFromRow(row) : undefined
    },
    query: async (scope: ScopePredicate, q: EntryQuery) => {
      const { sql: scopeSql, params } = scopeToSql(scope, STORE_SHAPES.entries, 'e', 1)
      const where = [scopeSql, ...this.entryFilters(q, 'e', params)]
      params.push(q.limit)
      const direction = q.order === 'asc' ? 'ASC' : 'DESC'
      const rows = await this.rows(
        `SELECT * FROM entries e WHERE ${where.join(' AND ')} ORDER BY e.initiated_at ${direction}, e.id ${direction} LIMIT $${params.length}`,
        params
      )
      return rows.map((r) => this.entryFromRow(r))
    },
    vectorSearch: async (scope: ScopePredicate, vector: number[], topK: number, excludeIds?: string[]) => {
      const { sql: scopeSql, params } = scopeToSql(scope, STORE_SHAPES.entries, 'e', 1)
      let extra = ''
      if (excludeIds?.length) {
        params.push(excludeIds)
        extra = ` AND NOT (e.id = ANY($${params.length}))`
      }
      params.push(vec(vector))
      const vIdx = params.length
      params.push(topK)
      const rows = await this.rows(
        `SELECT *, 1 - (e.embedding <=> $${vIdx}::vector) AS score FROM entries e
         WHERE ${scopeSql}${extra} AND e.embedding IS NOT NULL ORDER BY e.embedding <=> $${vIdx}::vector LIMIT $${params.length}`,
        params
      )
      return rows.map((r) => ({ item: this.entryFromRow(r), score: Number(r.score) }) as VectorHit<StoredEntry>)
    },
    listWithPlainAttachments: async (limit: number) => {
      const rows = await this.rows(
        `SELECT * FROM entries e WHERE EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'attachments', '[]'::jsonb)) a
           WHERE COALESCE(a->>'textRepr', '') <> '' OR a ? 'filename'
         ) LIMIT $1`,
        [limit]
      )
      return rows.map((r) => this.entryFromRow(r))
    },
    listAll: async (q: { conversationId?: string; principalId?: string; limit: number }) => {
      const where: string[] = ['true']
      const params: unknown[] = []
      if (q.conversationId) {
        params.push(q.conversationId)
        where.push(`conversation_id = $${params.length}`)
      }
      if (q.principalId) {
        params.push(q.principalId)
        where.push(`principal_id = $${params.length}`)
      }
      params.push(q.limit)
      const rows = await this.rows(
        `SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY initiated_at ASC, id ASC LIMIT $${params.length}`,
        params
      )
      return rows.map((r) => this.entryFromRow(r))
    },
    setEmbedding: async (id: string, vector: number[] | null) => {
      await this.pool.query('UPDATE entries SET embedding = $2::vector WHERE id = $1', [
        id,
        vector ? vec(vector) : null,
      ])
    },
    listUnanchored: async (limit: number) =>
      (
        await this.rows(
          'SELECT * FROM entries WHERE anchor_batch_id IS NULL ORDER BY created_at ASC, id ASC LIMIT $1',
          [limit]
        )
      ).map((r) => this.entryFromRow(r)),
    markAnchored: async (ids: string[], batchId: string) => {
      await this.pool.query(
        `UPDATE entries SET anchor_batch_id = $2, data = jsonb_set(data, '{anchorBatchId}', to_jsonb($2::text)) WHERE id = ANY($1)`,
        [ids, batchId]
      )
    },
    listOlderThan: async (
      cutoff: string,
      state: LifecycleState,
      limit: number,
      filter: { spaceId?: string; personal?: boolean } = {}
    ) => {
      const params: unknown[] = [state, cutoff]
      let space = ''
      if (filter.spaceId !== undefined) {
        params.push(filter.spaceId)
        space = ` AND space_id = $${params.length}`
      } else if (filter.personal) space = " AND (space_id IS NULL OR space_id LIKE 'personal:%')"
      params.push(limit)
      return (
        await this.rows(
          `SELECT * FROM entries WHERE state = $1 AND created_at < $2${space} ORDER BY created_at LIMIT $${params.length}`,
          params
        )
      ).map((r) => this.entryFromRow(r))
    },
    setSpace: async (conversationId: string, spaceId: string) => {
      await this.pool.query(
        `UPDATE entries SET space_id = $2, data = jsonb_set(data, '{spaceId}', to_jsonb($2::text)) WHERE conversation_id = $1`,
        [conversationId, spaceId]
      )
    },
    reassign: async (sessionIds: string[], principalId: string) => {
      // what was of the visitor's Personal space is of the identified Principal's (SPACE-DEF-002)
      const result = await this.pool.query(
        `UPDATE entries SET principal_id = $2,
           space_id = CASE WHEN space_id IS NULL OR space_id LIKE 'personal:%' THEN 'personal:' || $2 ELSE space_id END,
           data = jsonb_set(data, '{principalId}', to_jsonb($2::text))
         WHERE session_id = ANY($1) AND principal_id IS DISTINCT FROM $2`,
        [sessionIds, principalId]
      )
      return result.rowCount ?? 0
    },
    setState: async (ids: string[], state: LifecycleState) => {
      await this.pool.query(
        `UPDATE entries SET state = $2, data = jsonb_set(data, '{state}', to_jsonb($2::text)) WHERE id = ANY($1)`,
        [ids, state]
      )
    },
    listAttachmentKeys: async () => {
      const rows = await this.rows(
        `SELECT e.id, e.state, a->>'bucketKey' AS bucket_key, a->>'thumbnailBucketKey' AS thumb FROM entries e, jsonb_array_elements(e.data->'attachments') a`
      )
      return rows.flatMap((r) => [
        { entryId: String(r.id), state: r.state as LifecycleState, bucketKey: String(r.bucket_key) },
        ...(r.thumb ? [{ entryId: String(r.id), state: r.state as LifecycleState, bucketKey: String(r.thumb) }] : []),
      ])
    },
  }

  public notes = {
    query: (scope: ScopePredicate) => {
      const { sql, params } = scopeToSql(scope, STORE_SHAPES.notes, 'n', 1)
      return this.many<WorkingMemoryNote>(`SELECT data FROM working_memory n WHERE ${sql}`, params)
    },
    list: (principalId: string) =>
      this.many<WorkingMemoryNote>('SELECT data FROM working_memory WHERE principal_id = $1', [principalId]),
    save: async (n: WorkingMemoryNote) => {
      await this.pool.query(
        `INSERT INTO working_memory (id, principal_id, visibility, state, space_id, data) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET visibility = $3, state = $4, space_id = $5, data = $6`,
        [n.id, n.principalId, n.visibility, n.state, n.spaceId ?? `personal:${n.principalId}`, n]
      )
    },
    delete: async (id: string) => {
      await this.pool.query('DELETE FROM working_memory WHERE id = $1', [id])
    },
    flagByLineage: async (entryId: string) => {
      const result = await this.pool.query(
        `UPDATE working_memory SET data = jsonb_set(data, '{needsRevision}', 'true') WHERE data->'lineageRefs' ? $1`,
        [entryId]
      )
      return result.rowCount ?? 0
    },
    listAll: () => this.many<WorkingMemoryNote>('SELECT data FROM working_memory'),
  }

  private preferenceOf = (r: Row): PrincipalPreference => ({
    principalId: String(r.principal_id),
    key: String(r.key),
    value: String(r.value),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    ...(r.enc_key_ref && r.cipher
      ? { sealed: { keyRef: String(r.enc_key_ref), cipher: (r.cipher as Buffer).toString('base64') } }
      : {}),
  })

  public preferences = {
    query: async (scope: ScopePredicate) => {
      const { sql, params } = scopeToSql(scope, STORE_SHAPES.preferences, 'p', 1)
      return (await this.rows(`SELECT * FROM preferences p WHERE ${sql}`, params)).map(this.preferenceOf)
    },
    list: async (principalId: string) =>
      (await this.rows('SELECT * FROM preferences WHERE principal_id = $1', [principalId])).map(this.preferenceOf),
    set: async (p: PrincipalPreference) => {
      await this.pool.query(
        `INSERT INTO preferences (principal_id, key, value, updated_at, enc_key_ref, cipher) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (principal_id, key) DO UPDATE SET value = $3, updated_at = $4, enc_key_ref = $5, cipher = $6`,
        [
          p.principalId,
          p.key,
          p.value,
          p.updatedAt,
          p.sealed?.keyRef ?? null,
          p.sealed ? Buffer.from(p.sealed.cipher, 'base64') : null,
        ]
      )
    },
    delete: async (principalId: string, key: string) => {
      await this.pool.query('DELETE FROM preferences WHERE principal_id = $1 AND key = $2', [principalId, key])
    },
    listAll: async () => (await this.rows('SELECT * FROM preferences')).map(this.preferenceOf),
  }

  private evidenceOf = (r: Record<string, unknown>): StoredEvidence => ({
    ...(r.data as Omit<StoredEvidence, 'cipher'>),
    cipher: (r.cipher as Buffer | null) ?? null,
  })

  public evidence = {
    list: async (principalId: string) =>
      (
        await this.rows('SELECT data, cipher FROM evidence WHERE principal_id = $1 ORDER BY verified_at', [principalId])
      ).map(this.evidenceOf),
    get: async (id: string) => {
      const [row] = await this.rows('SELECT data, cipher FROM evidence WHERE id = $1', [id])
      return row ? this.evidenceOf(row) : undefined
    },
    save: async (e: StoredEvidence) => {
      const { cipher, ...data } = e
      await this.pool.query(
        `INSERT INTO evidence (id, principal_id, state, verified_at, expires_at, data, cipher, directory_entry_id, holder_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET principal_id = $2, state = $3, expires_at = $5, data = $6, cipher = $7,
           directory_entry_id = $8, holder_index = $9`,
        [
          e.id,
          e.principalId,
          e.state,
          e.verifiedAt,
          e.expiresAt ?? null,
          data,
          cipher,
          e.kind === 'issuance' ? (e.directoryEntryId ?? null) : null,
          e.kind === 'issuance' ? (e.holderIndex ?? null) : null,
        ]
      )
    },
    listExpired: async (nowIso: string) =>
      (
        await this.rows(
          "SELECT data, cipher FROM evidence WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= $1",
          [nowIso]
        )
      ).map(this.evidenceOf),
    listIssuedFromDirectory: async (directoryEntryId?: string) =>
      (directoryEntryId === undefined
        ? await this.rows(
            'SELECT data, cipher FROM evidence WHERE directory_entry_id IS NOT NULL ORDER BY verified_at, id'
          )
        : await this.rows('SELECT data, cipher FROM evidence WHERE directory_entry_id = $1 ORDER BY verified_at, id', [
            directoryEntryId,
          ])
      ).map(this.evidenceOf),
    listIssuedTo: async (holderIndex: string) =>
      (
        await this.rows(
          'SELECT data, cipher FROM evidence WHERE holder_index = $1 ORDER BY verified_at DESC, id DESC',
          [holderIndex]
        )
      ).map(this.evidenceOf),
  }

  public approvals = {
    get: (id: string) => this.one<ApprovalRecord>('SELECT data FROM approvals WHERE id = $1', [id]),
    save: async (r: ApprovalRecord) => {
      await this.pool.query(
        'INSERT INTO approvals (id, status, requester_id, eligible_roles, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET status=$2, requester_id=$3, eligible_roles=$4, data=$5',
        [r.id, r.status, r.requesterId, r.eligibleRoles, r]
      )
    },
    list: (f: {
      status?: ApprovalRecord['status']
      requesterId?: string
      eligibleRole?: string
      inboundId?: string
    }) => {
      const where: string[] = ['true']
      const params: unknown[] = []
      if (f.inboundId) {
        params.push(f.inboundId)
        where.push(`data->>'inboundId' = $${params.length}`)
      }
      if (f.status) {
        params.push(f.status)
        where.push(`status = $${params.length}`)
      }
      if (f.requesterId) {
        params.push(f.requesterId)
        where.push(`requester_id = $${params.length}`)
      }
      if (f.eligibleRole) {
        params.push(f.eligibleRole)
        where.push(`$${params.length} = ANY(eligible_roles)`)
      }
      return this.many<ApprovalRecord>(`SELECT data FROM approvals WHERE ${where.join(' AND ')}`, params)
    },
  }

  public grants = {
    listActive: (principalId: string, now: string) =>
      this.many<ElevationGrant>('SELECT data FROM elevation_grants WHERE principal_id = $1 AND expires_at > $2', [
        principalId,
        now,
      ]),
    save: async (g: ElevationGrant) => {
      await this.pool.query(
        'INSERT INTO elevation_grants (id, principal_id, expires_at, data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET expires_at=$3, data=$4',
        [g.id, g.principalId, g.expiresAt, g]
      )
    },
  }

  public challenges = {
    get: (id: string) => this.one<AuthChallengeRecord>('SELECT data FROM auth_challenges WHERE id = $1', [id]),
    findByToken: (token: string) =>
      this.one<AuthChallengeRecord>('SELECT data FROM auth_challenges WHERE token = $1', [token]),
    save: async (c: AuthChallengeRecord) => {
      await this.pool.query(
        'INSERT INTO auth_challenges (id, token, outcome, data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET outcome=$3, data=$4',
        [c.id, c.token, c.outcome, c]
      )
    },
    listPending: () => this.many<AuthChallengeRecord>("SELECT data FROM auth_challenges WHERE outcome = 'pending'"),
  }

  public accessLog = {
    insert: async (log: MemoryAccessLog) => {
      await this.pool.query('INSERT INTO memory_access_log (id, principal_id, ts, data) VALUES ($1,$2,$3,$4)', [
        log.id,
        log.principalId,
        log.ts,
        log,
      ])
    },
  }

  public anchors = {
    save: async (a: DigestAnchor) => {
      await this.pool.query(
        'INSERT INTO digest_anchors (batch_id, anchored_at, data) VALUES ($1,$2,$3) ON CONFLICT (batch_id) DO UPDATE SET anchored_at=$2, data=$3',
        [a.batchId, a.anchoredAt ?? null, a]
      )
    },
    listPending: () => this.many<DigestAnchor>('SELECT data FROM digest_anchors WHERE anchored_at IS NULL'),
    list: () => this.many<DigestAnchor>('SELECT data FROM digest_anchors ORDER BY batch_id'),
  }

  public rag = {
    replaceSource: async (sourceId: string, chunks: (RagChunk & { vector: number[] | null })[]) => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('DELETE FROM rag_chunks WHERE source_id = $1', [sourceId])
        for (const c of chunks) {
          const { vector, ...data } = c
          await client.query(
            'INSERT INTO rag_chunks (id, source_id, visibility, state, position, embedding, backing_identity_id, data) VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8)',
            [c.id, c.sourceId, c.visibility, c.state, c.position, vector ? vec(vector) : null, c.partner ?? null, data]
          )
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    vectorSearch: async (scope: ScopePredicate, vector: number[], topK: number) => {
      const { sql: scopeSql, params } = scopeToSql(scope, STORE_SHAPES.documents, 'c', 1)
      const vIdx = params.length + 1
      params.push(vec(vector), topK)
      const rows = await this.rows(
        `SELECT data, 1 - (c.embedding <=> $${vIdx}::vector) AS score FROM rag_chunks c WHERE ${scopeSql} AND c.embedding IS NOT NULL ORDER BY c.embedding <=> $${vIdx}::vector LIMIT $${vIdx + 1}`,
        params
      )
      return rows.map((r) => ({ item: r.data as RagChunk, score: Number(r.score) }))
    },
    sourceDigest: (sourceId: string) => this.kv.get(`rag:source:${sourceId}`),
    setSourceDigest: (sourceId: string, digest: string) => this.kv.set(`rag:source:${sourceId}`, digest),
  }

  public stats = {
    insert: async (events: StatEvent[]) => {
      for (const e of events) {
        await this.pool.query(
          'INSERT INTO stat_events (id, ts, stat_class, value, dimensions) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [e.id, e.ts, e.statClass, e.value, e.dimensions]
        )
      }
    },
    query: async (q: { from: string; to: string; statClass?: string; granularity: 'hour' | 'day' | 'month' }) => {
      const params: unknown[] = [q.granularity, q.from, q.to]
      let filter = ''
      if (q.statClass) {
        params.push(q.statClass)
        filter = ' AND stat_class = $4'
      }
      const rows = await this.rows(
        `SELECT date_trunc($1, ts) AS bucket, stat_class, count(*) AS count, sum(value) AS sum FROM stat_events
         WHERE ts >= $2 AND ts <= $3${filter} GROUP BY 1, 2 ORDER BY 1`,
        params
      )
      return rows.map((r) => ({
        bucket: new Date(r.bucket as string).toISOString(),
        statClass: String(r.stat_class),
        count: Number(r.count),
        sum: Number(r.sum),
      }))
    },
  }

  public kv = {
    get: async (key: string) => {
      const [row] = await this.rows('SELECT value FROM kv WHERE key = $1', [key])
      return row ? String(row.value) : undefined
    },
    set: async (key: string, value: string) => {
      await this.pool.query('INSERT INTO kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2', [
        key,
        value,
      ])
    },
    delete: async (key: string) => {
      await this.pool.query('DELETE FROM kv WHERE key = $1', [key])
    },
  }

  public translations = {
    get: async (digest: string, language: string) => {
      const [row] = await this.rows('SELECT data FROM translations WHERE digest = $1 AND language = $2', [
        digest,
        language,
      ])
      return row ? (row.data as TranslationRecord) : undefined
    },
    // the first translation kept for a sentence and a language stays (INTX-AUTH-021)
    set: async (r: TranslationRecord) => {
      await this.pool.query(
        'INSERT INTO translations (digest, language, created_at, data) VALUES ($1,$2,$3,$4) ON CONFLICT (digest, language) DO NOTHING',
        [r.digest, r.language, r.createdAt, r]
      )
    },
    list: () => this.many<TranslationRecord>('SELECT data FROM translations ORDER BY created_at, digest', []),
  }

  public adminAudit = {
    insert: async (r: AdminAuditRecord) => {
      await this.pool.query('INSERT INTO admin_audit (id, ts, action, actor, data) VALUES ($1,$2,$3,$4,$5)', [
        r.id,
        r.ts,
        r.action,
        r.actor,
        r,
      ])
    },
    // newest first; of two at the same time, the one written last first (seq)
    list: (limit: number, filter: { action?: AdminAuditRecord['action']; before?: string } = {}) => {
      const params: unknown[] = []
      const where: string[] = ['true']
      if (filter.action) {
        params.push(filter.action)
        where.push(`action = $${params.length}`)
      }
      if (filter.before) {
        params.push(filter.before)
        where.push(`(ts, seq) < (SELECT ts, seq FROM admin_audit WHERE id = $${params.length})`)
      }
      params.push(limit)
      return this.many<AdminAuditRecord>(
        `SELECT data FROM admin_audit WHERE ${where.join(' AND ')} ORDER BY ts DESC, seq DESC LIMIT $${params.length}`,
        params
      )
    },
  }

  public spaces = {
    get: (id: string) => this.one<Space>('SELECT data FROM spaces WHERE id = $1', [id]),
    save: async (space: Space) => {
      await this.pool.query(
        `INSERT INTO spaces (id, agent_id, kind, template_id, membership_mode, created_at, updated_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET kind = $3, template_id = $4, membership_mode = $5, updated_at = $7, data = $8`,
        [
          space.id,
          space.agentId,
          space.kind,
          space.templateId,
          space.membership.mode,
          space.createdAt,
          space.updatedAt,
          space,
        ]
      )
    },
    list: (agentId: string) =>
      this.many<Space>('SELECT data FROM spaces WHERE agent_id = $1 ORDER BY created_at, id', [agentId]),
  }

  public spaceMembers = {
    get: (id: string) => this.one<SpaceMember>('SELECT data FROM space_members WHERE id = $1', [id]),
    save: async (m: SpaceMember) => {
      await this.pool.query(
        `INSERT INTO space_members (id, space_id, principal_id, directory_id, organization_key, email_index, state, role,
           created_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET principal_id = $3, directory_id = $4, organization_key = $5, email_index = $6,
           state = $7, role = $8, data = $10`,
        [
          m.id,
          m.spaceId,
          m.principalId,
          m.directoryId ?? null,
          m.organizationKey ?? null,
          m.emailIndex ?? null,
          m.state,
          m.role,
          m.createdAt,
          m,
        ]
      )
    },
    listBySpace: (spaceId: string) =>
      this.many<SpaceMember>('SELECT data FROM space_members WHERE space_id = $1 ORDER BY created_at, id', [spaceId]),
    listByPrincipal: (principalId: string) =>
      this.many<SpaceMember>('SELECT data FROM space_members WHERE principal_id = $1', [principalId]),
    listByDirectoryId: (directoryId: string) =>
      this.many<SpaceMember>('SELECT data FROM space_members WHERE directory_id = $1 ORDER BY created_at, id', [
        directoryId,
      ]),
    // the index space_members_invitee (schema 3.6.0) serves it
    listByInvitee: (organizationKey: string, emailIndex: string) =>
      this.many<SpaceMember>(
        'SELECT data FROM space_members WHERE organization_key = $1 AND email_index = $2 ORDER BY created_at, id',
        [organizationKey, emailIndex]
      ),
    delete: async (id: string) => {
      await this.pool.query('DELETE FROM space_members WHERE id = $1', [id])
    },
  }

  public spaceTools = {
    get: (spaceId: string, sourceId: string) =>
      this.one<SpaceToolRecord>('SELECT data FROM space_tools WHERE space_id = $1 AND source_id = $2', [
        spaceId,
        sourceId,
      ]),
    save: async (r: SpaceToolRecord) => {
      await this.pool.query(
        'INSERT INTO space_tools (space_id, source_id, data) VALUES ($1,$2,$3) ON CONFLICT (space_id, source_id) DO UPDATE SET data=$3',
        [r.spaceId, r.sourceId, r]
      )
    },
    delete: async (spaceId: string, sourceId: string) => {
      await this.pool.query('DELETE FROM space_tools WHERE space_id = $1 AND source_id = $2', [spaceId, sourceId])
    },
    listBySpace: (spaceId: string) =>
      this.many<SpaceToolRecord>('SELECT data FROM space_tools WHERE space_id = $1 ORDER BY source_id', [spaceId]),
    listAll: () => this.many<SpaceToolRecord>('SELECT data FROM space_tools ORDER BY space_id, source_id', []),
  }

  /** the token only as ciphertext, its wrapped key beside it: deleting the row destroys the key (TOOL-ACCESS-004) */
  private accountFromRow(r: Row): SpaceAccountRecord {
    return {
      spaceId: String(r.space_id),
      sourceId: String(r.source_id),
      encKeyRef: String(r.enc_key_ref),
      cipher: (r.cipher as Buffer).toString('base64'),
      setAt: new Date(r.set_at as string).toISOString(),
      setByPrincipalId: String(r.set_by),
    }
  }

  public spaceAccounts = {
    get: async (spaceId: string, sourceId: string) => {
      const [row] = await this.rows('SELECT * FROM space_accounts WHERE space_id = $1 AND source_id = $2', [
        spaceId,
        sourceId,
      ])
      return row ? this.accountFromRow(row) : undefined
    },
    save: async (r: SpaceAccountRecord) => {
      await this.pool.query(
        `INSERT INTO space_accounts (space_id, source_id, enc_key_ref, cipher, set_at, set_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (space_id, source_id) DO UPDATE SET enc_key_ref=$3, cipher=$4, set_at=$5, set_by=$6`,
        [r.spaceId, r.sourceId, r.encKeyRef, Buffer.from(r.cipher, 'base64'), r.setAt, r.setByPrincipalId]
      )
    },
    delete: async (spaceId: string, sourceId: string) => {
      await this.pool.query('DELETE FROM space_accounts WHERE space_id = $1 AND source_id = $2', [spaceId, sourceId])
    },
    listAll: async () => (await this.rows('SELECT * FROM space_accounts', [])).map((r) => this.accountFromRow(r)),
  }

  public toolAllowances = {
    get: (approvalId: string) =>
      this.one<ToolAllowance>('SELECT data FROM tool_allowances WHERE approval_id = $1', [approvalId]),
    save: async (a: ToolAllowance) => {
      await this.pool.query(
        `INSERT INTO tool_allowances (approval_id, conversation_id, space_id, source_id, data) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (approval_id) DO UPDATE SET data=$5`,
        [a.approvalId, a.conversationId, a.spaceId ?? null, a.sourceId, a]
      )
    },
    listByConversation: (conversationId: string) =>
      this.many<ToolAllowance>('SELECT data FROM tool_allowances WHERE conversation_id = $1', [conversationId]),
    listBySpaceSource: (spaceId: string, sourceId: string) =>
      this.many<ToolAllowance>('SELECT data FROM tool_allowances WHERE space_id = $1 AND source_id = $2', [
        spaceId,
        sourceId,
      ]),
  }

  public toolCalls = {
    get: (id: string) => this.one<ToolCallRecord>('SELECT data FROM tool_calls WHERE id = $1', [id]),
    save: async (r: ToolCallRecord) => {
      await this.pool.query(
        `INSERT INTO tool_calls (id, at, principal_id, conversation_id, space_id, source_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET data=$7`,
        [r.id, r.at, r.principalId, r.conversationId, r.spaceId, r.sourceId, r]
      )
    },
    list: (q: ToolCallQuery) => {
      const where: string[] = ['true']
      const params: unknown[] = []
      const add = (column: string, op: string, value: unknown) => {
        params.push(value)
        where.push(`${column} ${op} $${params.length}`)
      }
      if (q.principalId) add('principal_id', '=', q.principalId)
      if (q.spaceId) add('space_id', '=', q.spaceId)
      if (q.conversationId) add('conversation_id', '=', q.conversationId)
      if (q.sourceId) add('source_id', '=', q.sourceId)
      if (q.from) add('at', '>=', q.from)
      if (q.to) add('at', '<', q.to)
      params.push(q.limit)
      return this.many<ToolCallRecord>(
        `SELECT data FROM tool_calls WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
        params
      )
    },
  }

  public spaceActivity = {
    insert: async (a: SpaceActivity) => {
      await this.pool.query('INSERT INTO space_activity (id, space_id, at, data) VALUES ($1,$2,$3,$4)', [
        a.id,
        a.spaceId,
        a.at,
        a,
      ])
    },
    list: (spaceId: string, limit: number) =>
      this.many<SpaceActivity>(
        'SELECT data FROM space_activity WHERE space_id = $1 ORDER BY at DESC, seq DESC LIMIT $2',
        [spaceId, limit]
      ),
  }

  public personKeys = {
    get: async (principalId: string) => {
      const [row] = await this.rows('SELECT * FROM person_keys WHERE principal_id = $1', [principalId])
      return row
        ? {
            principalId: String(row.principal_id),
            wrappedKey: String(row.wrapped_key),
            createdAt: new Date(row.created_at as string).toISOString(),
          }
        : undefined
    },
    // the first key of a person is kept: two connections at once give them one key (D106)
    saveIfAbsent: async (r: PersonKeyRecord) => {
      await this.pool.query(
        'INSERT INTO person_keys (principal_id, wrapped_key, created_at) VALUES ($1,$2,$3) ON CONFLICT (principal_id) DO NOTHING',
        [r.principalId, r.wrappedKey, r.createdAt]
      )
      return (await this.personKeys.get(r.principalId)) ?? r
    },
    delete: async (principalId: string) => {
      await this.pool.query('DELETE FROM person_keys WHERE principal_id = $1', [principalId])
    },
  }

  /** the tokens or values only as ciphertext, the account's key, wrapped by the person's, beside it (TOOL-ACCESS-009) */
  private personalAccountFromRow(r: Row): PersonalAccountRecord {
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined)
    return {
      id: String(r.id),
      principalId: String(r.principal_id),
      sourceId: String(r.source_id),
      ...(r.binding_value ? { bindingValue: String(r.binding_value) } : {}),
      ...(r.binding_label ? { bindingLabel: String(r.binding_label) } : {}),
      method: r.method as PersonalAccountRecord['method'],
      state: r.state as PersonalAccountRecord['state'],
      ...(r.reason ? { reason: r.reason as PersonalAccountRecord['reason'] } : {}),
      ...(r.more_access ? { moreAccess: true } : {}),
      cipher: (r.cipher as Buffer).toString('base64'),
      ...(r.label_cipher ? { labelCipher: (r.label_cipher as Buffer).toString('base64') } : {}),
      encKeyRef: String(r.enc_key_ref),
      packDigest: String(r.pack_digest),
      scopesDigest: String(r.scopes_digest),
      connectedAt: iso(r.connected_at) as string,
      ...(r.refreshed_at ? { refreshedAt: iso(r.refreshed_at) } : {}),
      ...(r.last_used_at ? { lastUsedAt: iso(r.last_used_at) } : {}),
    }
  }

  public personalAccounts = {
    get: async (id: string) => {
      const [row] = await this.rows('SELECT * FROM personal_accounts WHERE id = $1', [id])
      return row ? this.personalAccountFromRow(row) : undefined
    },
    find: async (principalId: string, sourceId: string, bindingValue?: string) => {
      const [row] = await this.rows(
        'SELECT * FROM personal_accounts WHERE principal_id = $1 AND source_id = $2 AND binding_value = $3',
        [principalId, sourceId, bindingValue ?? '']
      )
      return row ? this.personalAccountFromRow(row) : undefined
    },
    listByPrincipal: async (principalId: string) =>
      (
        await this.rows('SELECT * FROM personal_accounts WHERE principal_id = $1 ORDER BY connected_at, id', [
          principalId,
        ])
      ).map((r) => this.personalAccountFromRow(r)),
    listAll: async () =>
      (await this.rows('SELECT * FROM personal_accounts ORDER BY connected_at, id', [])).map((r) =>
        this.personalAccountFromRow(r)
      ),
    // one account per (principal, source, binding value): a new one replaces the row, and the key in it (TOOL-CONN-002)
    save: async (r: PersonalAccountRecord) => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          'DELETE FROM personal_accounts WHERE principal_id = $1 AND source_id = $2 AND binding_value = $3 AND id <> $4',
          [r.principalId, r.sourceId, r.bindingValue ?? '', r.id]
        )
        await client.query(
          `INSERT INTO personal_accounts (id, principal_id, source_id, binding_value, binding_label, method, state, reason,
             more_access, enc_key_ref, cipher, label_cipher, pack_digest, scopes_digest, connected_at, refreshed_at,
             last_used_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$17,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO UPDATE SET binding_label=$5, method=$6, state=$7, reason=$8, more_access=$9,
             enc_key_ref=$10, cipher=$11, label_cipher=$17, pack_digest=$12, scopes_digest=$13, connected_at=$14,
             refreshed_at=$15, last_used_at=$16`,
          [
            r.id,
            r.principalId,
            r.sourceId,
            r.bindingValue ?? '',
            r.bindingLabel ?? null,
            r.method,
            r.state,
            r.reason ?? null,
            r.moreAccess === true,
            r.encKeyRef,
            Buffer.from(r.cipher, 'base64'),
            r.packDigest,
            r.scopesDigest,
            r.connectedAt,
            r.refreshedAt ?? null,
            r.lastUsedAt ?? null,
            r.labelCipher ? Buffer.from(r.labelCipher, 'base64') : null,
          ]
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    update: async (r: PersonalAccountRecord) => {
      const result = await this.pool.query(
        `UPDATE personal_accounts SET binding_label=$2, state=$3, reason=$4, more_access=$5, enc_key_ref=$6, cipher=$7,
           label_cipher=$8, pack_digest=$9, scopes_digest=$10, refreshed_at=$11, last_used_at=$12
         WHERE id = $1`,
        [
          r.id,
          r.bindingLabel ?? null,
          r.state,
          r.reason ?? null,
          r.moreAccess === true,
          r.encKeyRef,
          Buffer.from(r.cipher, 'base64'),
          r.labelCipher ? Buffer.from(r.labelCipher, 'base64') : null,
          r.packDigest,
          r.scopesDigest,
          r.refreshedAt ?? null,
          r.lastUsedAt ?? null,
        ]
      )
      return (result.rowCount ?? 0) > 0
    },
    touch: async (id: string, lastUsedAt: string) => {
      await this.pool.query('UPDATE personal_accounts SET last_used_at = $2 WHERE id = $1', [id, lastUsedAt])
    },
    delete: async (id: string) => {
      await this.pool.query('DELETE FROM personal_accounts WHERE id = $1', [id])
    },
  }

  public oauthAttempts = {
    get: (id: string) => this.one<OAuthAttemptRecord>('SELECT data FROM oauth_attempts WHERE id = $1', [id]),
    findByStateHash: (stateHash: string) =>
      this.one<OAuthAttemptRecord>('SELECT data FROM oauth_attempts WHERE state_hash = $1', [stateHash]),
    listWaiting: () =>
      this.many<OAuthAttemptRecord>("SELECT data FROM oauth_attempts WHERE NOT (data ? 'outcome') ORDER BY id", []),
    save: async (r: OAuthAttemptRecord) => {
      await this.pool.query(
        `INSERT INTO oauth_attempts (id, principal_id, state_hash, data) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET data=$4`,
        [r.id, r.principalId, r.stateHash, r]
      )
    },
    // one use: only the request that finds it waiting takes it (TOOL-OAUTH-006)
    claim: async (id: string, outcome: OAuthAttemptRecord['outcome'], endedAt: string) => {
      const result = await this.pool.query(
        `UPDATE oauth_attempts SET data = data || jsonb_build_object('outcome', $2::text, 'endedAt', $3::text)
         WHERE id = $1 AND NOT (data ? 'outcome')`,
        [id, outcome, endedAt]
      )
      return (result.rowCount ?? 0) > 0
    },
    delete: async (id: string) => {
      await this.pool.query('DELETE FROM oauth_attempts WHERE id = $1', [id])
    },
  }

  public oauthClients = {
    get: (ref: string) => this.one<OAuthClientRecord>('SELECT data FROM oauth_clients WHERE ref = $1', [ref]),
    save: async (r: OAuthClientRecord) => {
      await this.pool.query(
        'INSERT INTO oauth_clients (ref, data) VALUES ($1,$2) ON CONFLICT (ref) DO UPDATE SET data=$2',
        [r.ref, r]
      )
    },
    delete: async (ref: string) => {
      await this.pool.query('DELETE FROM oauth_clients WHERE ref = $1', [ref])
    },
  }
}

export function createStore(kind: 'postgres' | 'memory', databaseUrl?: string): Store {
  if (kind === 'postgres') {
    if (!databaseUrl) throw new Error('DATABASE_URL is required for the postgres store')
    return new PostgresStore(databaseUrl)
  }
  return new MemoryStore()
}
