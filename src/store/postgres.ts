/** PostgreSQL store with pgvector (TOOL-HTTP-004, MEM-RET-002, PRIV-SCOPE-005). */
import pg from 'pg'
import type {
  ApprovalRecord,
  AuthChallengeRecord,
  Conversation,
  CredentialPresentation,
  DigestAnchor,
  ElevationGrant,
  LifecycleState,
  MemoryAccessLog,
  Principal,
  PrincipalPreference,
  RagChunk,
  Session,
  StatEvent,
  WorkingMemoryNote,
} from '../core/types.js'
import { type ScopePredicate, scopeToSql } from '../memory/scope.js'
import { MemoryStore } from './memory.js'
import { MIGRATIONS } from './migrations.js'
import type { EntryQuery, Store, StoredEntry, VectorHit } from './types.js'

const vec = (v: number[]): string => `[${v.join(',')}]`

type Row = Record<string, unknown>

export class PostgresStore implements Store {
  public readonly kind = 'postgres' as const
  private readonly pool: pg.Pool

  public constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 })
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
    save: async (c: Conversation) => {
      await this.pool.query(
        `INSERT INTO conversations (id, principal_id, state, last_activity_at, data) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET principal_id=$2, state=$3, last_activity_at=$4, data=$5`,
        [c.id, c.principalId, c.state, c.lastActivityAt, c]
      )
    },
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
    return { ...data, cipher: (r.cipher as Buffer | null) ?? null, textPreview: String(r.text_preview ?? '') }
  }

  private entryData(e: StoredEntry): Omit<StoredEntry, 'cipher' | 'textPreview'> {
    const { cipher: _c, textPreview: _t, ...data } = e
    return data
  }

  public entries = {
    insert: async (e: StoredEntry) => {
      await this.pool.query(
        `INSERT INTO entries (id, session_id, principal_id, role, source_type, completion, visibility, state, backing_identity_id,
           language, content_digest, enc_key_ref, cipher, text_preview, external_id, initiated_at, created_at, anchor_batch_id, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          e.id,
          e.sessionId,
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
          e.textPreview,
          e.externalId ?? null,
          e.initiatedAt,
          e.createdAt,
          e.anchorBatchId ?? null,
          this.entryData(e),
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
        `UPDATE entries SET state=$2, completion=$3, enc_key_ref=$4, cipher=$5, text_preview=$6, content_digest=$7, anchor_batch_id=$8, external_id=$9, data=$10 WHERE id=$1`,
        [
          id,
          next.state,
          next.completion,
          next.encKeyRef,
          next.cipher,
          next.textPreview,
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
      const { sql: scopeSql, params } = scopeToSql(scope, 'e', 1)
      const where = [scopeSql]
      let i = params.length + 1
      if (q.sessionId) {
        where.push(`e.session_id = $${i++}`)
        params.push(q.sessionId)
      }
      if (q.sessionIds) {
        where.push(`e.session_id = ANY($${i++})`)
        params.push(q.sessionIds)
      }
      if (q.sourceTypes) {
        where.push(`e.source_type = ANY($${i++})`)
        params.push(q.sourceTypes)
      }
      if (q.roles) {
        where.push(`e.role = ANY($${i++})`)
        params.push(q.roles)
      }
      if (q.before) {
        where.push(`(e.initiated_at, e.id) < (SELECT initiated_at, id FROM entries WHERE id = $${i++})`)
        params.push(q.before)
      }
      params.push(q.limit)
      const rows = await this.rows(
        `SELECT * FROM entries e WHERE ${where.join(' AND ')} ORDER BY e.initiated_at DESC, e.id DESC LIMIT $${i}`,
        params
      )
      return rows.map((r) => this.entryFromRow(r))
    },
    vectorSearch: async (scope: ScopePredicate, vector: number[], topK: number, excludeSessionId?: string) => {
      const { sql: scopeSql, params } = scopeToSql(scope, 'e', 1)
      let i = params.length + 1
      const extra = excludeSessionId ? ` AND e.session_id <> $${i++}` : ''
      if (excludeSessionId) params.push(excludeSessionId)
      const vIdx = i++
      params.push(vec(vector))
      params.push(topK)
      const rows = await this.rows(
        `SELECT *, 1 - (e.embedding <=> $${vIdx}::vector) AS score FROM entries e
         WHERE ${scopeSql}${extra} AND e.embedding IS NOT NULL ORDER BY e.embedding <=> $${vIdx}::vector LIMIT $${i}`,
        params
      )
      return rows.map((r) => ({ item: this.entryFromRow(r), score: Number(r.score) }) as VectorHit<StoredEntry>)
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
    listOlderThan: async (cutoff: string, state: LifecycleState, limit: number) =>
      (
        await this.rows('SELECT * FROM entries WHERE state = $1 AND created_at < $2 ORDER BY created_at LIMIT $3', [
          state,
          cutoff,
          limit,
        ])
      ).map((r) => this.entryFromRow(r)),
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
    list: (principalId: string) =>
      this.many<WorkingMemoryNote>('SELECT data FROM working_memory WHERE principal_id = $1', [principalId]),
    save: async (n: WorkingMemoryNote) => {
      await this.pool.query(
        'INSERT INTO working_memory (id, principal_id, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data = $3',
        [n.id, n.principalId, n]
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
  }

  public preferences = {
    list: async (principalId: string) =>
      (await this.rows('SELECT * FROM preferences WHERE principal_id = $1', [principalId])).map((r) => ({
        principalId: String(r.principal_id),
        key: String(r.key),
        value: String(r.value),
        updatedAt: new Date(r.updated_at as string).toISOString(),
      })) as PrincipalPreference[],
    set: async (p: PrincipalPreference) => {
      await this.pool.query(
        'INSERT INTO preferences (principal_id, key, value, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (principal_id, key) DO UPDATE SET value = $3, updated_at = $4',
        [p.principalId, p.key, p.value, p.updatedAt]
      )
    },
  }

  public credentials = {
    list: (principalId: string) =>
      this.many<CredentialPresentation>('SELECT data FROM credential_presentations WHERE principal_id = $1', [
        principalId,
      ]),
    get: (id: string) =>
      this.one<CredentialPresentation>('SELECT data FROM credential_presentations WHERE id = $1', [id]),
    save: async (c: CredentialPresentation) => {
      await this.pool.query(
        'INSERT INTO credential_presentations (id, principal_id, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data = $3',
        [c.id, c.principalId, c]
      )
    },
  }

  public approvals = {
    get: (id: string) => this.one<ApprovalRecord>('SELECT data FROM approvals WHERE id = $1', [id]),
    save: async (r: ApprovalRecord) => {
      await this.pool.query(
        'INSERT INTO approvals (id, status, requester_id, eligible_roles, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET status=$2, requester_id=$3, eligible_roles=$4, data=$5',
        [r.id, r.status, r.requesterId, r.eligibleRoles, r]
      )
    },
    list: (f: { status?: ApprovalRecord['status']; requesterId?: string; eligibleRole?: string }) => {
      const where: string[] = ['true']
      const params: unknown[] = []
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
            'INSERT INTO rag_chunks (id, source_id, visibility, state, position, embedding, data) VALUES ($1,$2,$3,$4,$5,$6::vector,$7)',
            [c.id, c.sourceId, c.visibility, c.state, c.position, vector ? vec(vector) : null, data]
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
      const { sql: scopeSql, params } = scopeToSql(scope, 'c', 1)
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
  }
}

export function createStore(kind: 'postgres' | 'memory', databaseUrl?: string): Store {
  if (kind === 'postgres') {
    if (!databaseUrl) throw new Error('DATABASE_URL is required for the postgres store')
    return new PostgresStore(databaseUrl)
  }
  return new MemoryStore()
}
