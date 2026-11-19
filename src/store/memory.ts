/** In-memory store: tests and quick starts. Same semantics as the PostgreSQL store. */
import type {
  ApprovalRecord,
  AuthChallengeRecord,
  Conversation,
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
import { matchesScope, type ScopePredicate, STORE_SHAPES } from '../memory/scope.js'
import {
  type AdminAuditRecord,
  cosine,
  type EntryQuery,
  type Store,
  type StoredEntry,
  type StoredEvidence,
  type VectorHit,
} from './types.js'

/** A copy that keeps the ciphertext a Buffer (a JSON clone would not). */
const copyEvidence = (e: StoredEvidence): StoredEvidence => {
  const { cipher, ...rest } = e
  return { ...structuredClone(rest), cipher: cipher ? Buffer.from(cipher) : null }
}

const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T))

export class MemoryStore implements Store {
  public readonly kind = 'memory' as const

  /** One process holds a store that lives in its own memory. */
  public async exclusive(): Promise<() => Promise<void>> {
    return async () => undefined
  }
  private principalRows = new Map<string, Principal>()
  private sessionRows = new Map<string, Session>()
  private conversationRows = new Map<string, Conversation>()
  private entryRows = new Map<string, StoredEntry>()
  private embeddings = new Map<string, number[]>()
  private noteRows = new Map<string, WorkingMemoryNote>()
  private prefRows = new Map<string, PrincipalPreference>()
  private evidenceRows = new Map<string, StoredEvidence>()
  private approvalRows = new Map<string, ApprovalRecord>()
  private grantRows = new Map<string, ElevationGrant>()
  private challengeRows = new Map<string, AuthChallengeRecord>()
  private logs: MemoryAccessLog[] = []
  private anchorRows = new Map<string, DigestAnchor>()
  private chunks = new Map<string, RagChunk & { vector: number[] | null }>()
  private sourceDigests = new Map<string, string>()
  private statRows: StatEvent[] = []
  private kvRows = new Map<string, string>()

  public async init(): Promise<void> {}
  public async close(): Promise<void> {}

  public principals = {
    get: async (id: string) => clone(this.principalRows.get(id)),
    findByActor: async (actor: string) =>
      clone([...this.principalRows.values()].find((p) => p.actorIdentity === actor)),
    findByCapabilityChannel: async (channelId: string) =>
      clone([...this.principalRows.values()].find((p) => p.capabilityChannelId === channelId)),
    save: async (p: Principal) => {
      this.principalRows.set(p.id, clone(p))
    },
    list: async () => clone([...this.principalRows.values()]),
  }

  public sessions = {
    get: async (id: string) => clone(this.sessionRows.get(id)),
    save: async (s: Session) => {
      this.sessionRows.set(s.id, clone(s))
    },
    findByTokenHash: async (hash: string) => clone([...this.sessionRows.values()].find((s) => s.tokenHash === hash)),
    findByNonce: async (nonce: string) => clone([...this.sessionRows.values()].find((s) => s.binding?.nonce === nonce)),
    findByOutOfBandId: async (oobId: string) =>
      clone([...this.sessionRows.values()].find((s) => s.binding?.outOfBandId === oobId)),
    findByQuestionThread: async (connectionId: string, threadId: string) =>
      clone(
        [...this.sessionRows.values()].find(
          (s) => s.binding?.connectionId === connectionId && s.binding?.questionThreadId === threadId
        )
      ),
    findByExternalRef: async (channelType: Session['channelType'], ref: string) =>
      clone(
        [...this.sessionRows.values()].find(
          (s) => s.channelType === channelType && s.externalRef === ref && s.state !== 'closed'
        )
      ),
    listByPrincipal: async (principalId: string, states?: Session['state'][]) =>
      clone(
        [...this.sessionRows.values()].filter(
          (s) => s.principalId === principalId && (!states || states.includes(s.state))
        )
      ),
    listByState: async (state: Session['state']) =>
      clone([...this.sessionRows.values()].filter((s) => s.state === state)),
    nextStreamCursor: async (id: string) => {
      const s = this.sessionRows.get(id)
      if (!s) throw new Error(`session ${id} not found`)
      s.streamCursor += 1
      return s.streamCursor
    },
  }

  public conversations = {
    get: async (id: string) => clone(this.conversationRows.get(id)),
    save: async (c: Conversation) => {
      this.conversationRows.set(c.id, clone(c))
    },
    listAll: async () => clone([...this.conversationRows.values()]),
    listByPrincipal: async (principalId: string, states?: Conversation['state'][]) =>
      clone(
        [...this.conversationRows.values()]
          .filter((c) => c.principalId === principalId && (!states || states.includes(c.state)))
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      ),
  }

  private scoped(scope: ScopePredicate): StoredEntry[] {
    return [...this.entryRows.values()].filter((e) =>
      matchesScope(
        scope,
        {
          visibility: e.visibility,
          state: e.state,
          conversationId: e.conversationId,
          principalId: e.principalId,
          backingIdentityId: e.backingIdentity?.id ?? null,
        },
        STORE_SHAPES.entries
      )
    )
  }

  public entries = {
    insert: async (e: StoredEntry) => {
      this.entryRows.set(e.id, clone(e))
    },
    get: async (id: string) => clone(this.entryRows.get(id)),
    update: async (id: string, patch: Partial<StoredEntry>) => {
      const row = this.entryRows.get(id)
      if (row) this.entryRows.set(id, { ...row, ...clone(patch) })
    },
    findByExternalId: async (sessionId: string, externalId: string) =>
      clone([...this.entryRows.values()].find((e) => e.sessionId === sessionId && e.externalId === externalId)),
    query: async (scope: ScopePredicate, q: EntryQuery) => {
      let rows = this.scoped(scope)
      if (q.conversationId) rows = rows.filter((e) => e.conversationId === q.conversationId)
      if (q.sourceTypes) rows = rows.filter((e) => q.sourceTypes?.includes(e.sourceType))
      if (q.roles) rows = rows.filter((e) => q.roles?.includes(e.role))
      if (q.principalId) rows = rows.filter((e) => e.principalId === q.principalId)
      const key = (e: { initiatedAt: string; id: string }) => [Date.parse(e.initiatedAt), e.id] as const
      const cmp = (a: readonly [number, string], b: readonly [number, string]) =>
        a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
      if (q.before) {
        const pivot = this.entryRows.get(q.before)
        if (pivot) rows = rows.filter((e) => cmp(key(e), key(pivot)) < 0)
      }
      if (q.from) {
        const from = key(q.from)
        rows = rows.filter((e) => cmp(key(e), from) >= 0)
      }
      if (q.until) {
        const until = key(q.until)
        rows = rows.filter((e) => cmp(key(e), until) < 0)
      }
      rows.sort((a, b) => (q.order === 'asc' ? cmp(key(a), key(b)) : cmp(key(b), key(a))))
      return clone(rows.slice(0, q.limit))
    },
    vectorSearch: async (scope: ScopePredicate, vector: number[], topK: number, excludeIds?: string[]) => {
      const hits: VectorHit<StoredEntry>[] = []
      for (const e of this.scoped(scope)) {
        if (excludeIds?.includes(e.id)) continue
        const v = this.embeddings.get(e.id)
        if (v) hits.push({ item: clone(e), score: cosine(vector, v) })
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, topK)
    },
    listWithPlainAttachments: async (limit: number) =>
      clone(
        [...this.entryRows.values()]
          .filter((e) => e.attachments.some((a) => a.textRepr || a.filename !== undefined))
          .slice(0, limit)
      ),
    listAll: async (q: { conversationId?: string; principalId?: string; limit: number }) =>
      clone(
        [...this.entryRows.values()]
          .filter(
            (e) =>
              (!q.conversationId || e.conversationId === q.conversationId) &&
              (!q.principalId || e.principalId === q.principalId)
          )
          .sort((a, b) => Date.parse(a.initiatedAt) - Date.parse(b.initiatedAt) || a.id.localeCompare(b.id))
          .slice(0, q.limit)
      ),
    setEmbedding: async (id: string, vector: number[] | null) => {
      if (vector) this.embeddings.set(id, vector)
      else this.embeddings.delete(id)
    },
    listUnanchored: async (limit: number) =>
      clone(
        [...this.entryRows.values()]
          .filter((e) => !e.anchorBatchId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, limit)
      ),
    markAnchored: async (ids: string[], batchId: string) => {
      for (const id of ids) {
        const row = this.entryRows.get(id)
        if (row) row.anchorBatchId = batchId
      }
    },
    listOlderThan: async (cutoff: string, state: LifecycleState, limit: number) =>
      clone([...this.entryRows.values()].filter((e) => e.state === state && e.createdAt < cutoff).slice(0, limit)),
    reassign: async (sessionIds: string[], principalId: string) => {
      let moved = 0
      for (const row of this.entryRows.values()) {
        if (!row.sessionId || !sessionIds.includes(row.sessionId) || row.principalId === principalId) continue
        row.principalId = principalId
        moved++
      }
      return moved
    },
    setState: async (ids: string[], state: LifecycleState) => {
      for (const id of ids) {
        const row = this.entryRows.get(id)
        if (row) row.state = state
      }
    },
    listAttachmentKeys: async () =>
      [...this.entryRows.values()].flatMap((e) =>
        e.attachments.flatMap((a) => [
          { entryId: e.id, state: e.state, bucketKey: a.bucketKey },
          ...(a.thumbnailBucketKey ? [{ entryId: e.id, state: e.state, bucketKey: a.thumbnailBucketKey }] : []),
        ])
      ),
  }

  public notes = {
    query: async (scope: ScopePredicate) =>
      clone(
        [...this.noteRows.values()].filter((n) =>
          matchesScope(
            scope,
            { visibility: n.visibility, state: n.state, principalId: n.principalId },
            STORE_SHAPES.notes
          )
        )
      ),
    list: async (principalId: string) =>
      clone([...this.noteRows.values()].filter((n) => n.principalId === principalId)),
    save: async (n: WorkingMemoryNote) => {
      this.noteRows.set(n.id, clone(n))
    },
    delete: async (id: string) => {
      this.noteRows.delete(id)
    },
    flagByLineage: async (entryId: string) => {
      let n = 0
      for (const note of this.noteRows.values()) {
        if (note.lineageRefs.includes(entryId)) {
          note.needsRevision = true
          n++
        }
      }
      return n
    },
    listAll: async () => clone([...this.noteRows.values()]),
  }

  public preferences = {
    query: async (scope: ScopePredicate) =>
      clone(
        [...this.prefRows.values()].filter((p) =>
          matchesScope(
            scope,
            { visibility: 'principal-private', state: 'active', principalId: p.principalId },
            STORE_SHAPES.preferences
          )
        )
      ),
    list: async (principalId: string) =>
      clone([...this.prefRows.values()].filter((p) => p.principalId === principalId)),
    set: async (p: PrincipalPreference) => {
      this.prefRows.set(`${p.principalId}:${p.key}`, clone(p))
    },
    delete: async (principalId: string, key: string) => {
      this.prefRows.delete(`${principalId}:${key}`)
    },
    listAll: async () => clone([...this.prefRows.values()]),
  }

  public evidence = {
    list: async (principalId: string) =>
      [...this.evidenceRows.values()]
        .filter((e) => e.principalId === principalId)
        .sort((a, b) => a.verifiedAt.localeCompare(b.verifiedAt))
        .map(copyEvidence),
    get: async (id: string) => {
      const row = this.evidenceRows.get(id)
      return row ? copyEvidence(row) : undefined
    },
    save: async (e: StoredEvidence) => {
      this.evidenceRows.set(e.id, copyEvidence(e))
    },
    listExpired: async (nowIso: string) =>
      [...this.evidenceRows.values()]
        .filter((e) => e.state === 'active' && !!e.expiresAt && e.expiresAt <= nowIso)
        .map(copyEvidence),
  }

  public approvals = {
    get: async (id: string) => clone(this.approvalRows.get(id)),
    save: async (r: ApprovalRecord) => {
      this.approvalRows.set(r.id, clone(r))
    },
    list: async (f: {
      status?: ApprovalRecord['status']
      requesterId?: string
      eligibleRole?: string
      inboundId?: string
    }) =>
      clone(
        [...this.approvalRows.values()].filter(
          (r) =>
            (!f.inboundId || r.inboundId === f.inboundId) &&
            (!f.status || r.status === f.status) &&
            (!f.requesterId || r.requesterId === f.requesterId) &&
            (!f.eligibleRole || r.eligibleRoles.includes(f.eligibleRole))
        )
      ),
  }

  public grants = {
    listActive: async (principalId: string, now: string) =>
      clone([...this.grantRows.values()].filter((g) => g.principalId === principalId && g.expiresAt > now)),
    save: async (g: ElevationGrant) => {
      this.grantRows.set(g.id, clone(g))
    },
  }

  public challenges = {
    get: async (id: string) => clone(this.challengeRows.get(id)),
    findByToken: async (token: string) => clone([...this.challengeRows.values()].find((c) => c.token === token)),
    save: async (c: AuthChallengeRecord) => {
      this.challengeRows.set(c.id, clone(c))
    },
    listPending: async () => clone([...this.challengeRows.values()].filter((c) => c.outcome === 'pending')),
  }

  public accessLog = {
    insert: async (log: MemoryAccessLog) => {
      this.logs.push(clone(log))
    },
    all: () => clone(this.logs),
  }

  public anchors = {
    save: async (a: DigestAnchor) => {
      this.anchorRows.set(a.batchId, clone(a))
    },
    listPending: async () => clone([...this.anchorRows.values()].filter((a) => !a.anchoredAt)),
    list: async () => clone([...this.anchorRows.values()]),
  }

  public rag = {
    replaceSource: async (sourceId: string, chunks: (RagChunk & { vector: number[] | null })[]) => {
      for (const [id, c] of this.chunks) if (c.sourceId === sourceId) this.chunks.delete(id)
      for (const c of chunks) this.chunks.set(c.id, clone(c))
    },
    vectorSearch: async (scope: ScopePredicate, vector: number[], topK: number) => {
      const hits: VectorHit<RagChunk>[] = []
      for (const c of this.chunks.values()) {
        if (
          !c.vector ||
          !matchesScope(
            scope,
            { visibility: c.visibility, state: c.state, backingIdentityId: c.partner ?? null },
            STORE_SHAPES.documents
          )
        )
          continue
        const { vector: _v, ...item } = c
        hits.push({ item: clone(item), score: cosine(vector, c.vector) })
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, topK)
    },
    sourceDigest: async (sourceId: string) => this.sourceDigests.get(sourceId),
    setSourceDigest: async (sourceId: string, digest: string) => {
      this.sourceDigests.set(sourceId, digest)
    },
  }

  public stats = {
    insert: async (events: StatEvent[]) => {
      this.statRows.push(...clone(events))
    },
    query: async (q: { from: string; to: string; statClass?: string; granularity: 'hour' | 'day' | 'month' }) => {
      const buckets = new Map<string, { bucket: string; statClass: string; count: number; sum: number }>()
      for (const e of this.statRows) {
        if (e.ts < q.from || e.ts > q.to || (q.statClass && e.statClass !== q.statClass)) continue
        const bucket =
          q.granularity === 'hour' ? e.ts.slice(0, 13) : q.granularity === 'day' ? e.ts.slice(0, 10) : e.ts.slice(0, 7)
        const key = `${bucket}|${e.statClass}`
        const row = buckets.get(key) ?? { bucket, statClass: e.statClass, count: 0, sum: 0 }
        row.count += 1
        row.sum += e.value
        buckets.set(key, row)
      }
      return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
    },
  }

  public kv = {
    get: async (key: string) => this.kvRows.get(key),
    set: async (key: string, value: string) => {
      this.kvRows.set(key, value)
    },
    delete: async (key: string) => {
      this.kvRows.delete(key)
    },
  }

  private readonly auditRows: AdminAuditRecord[] = []
  public adminAudit = {
    insert: async (r: AdminAuditRecord) => {
      this.auditRows.push(clone(r))
    },
    list: async (limit: number) => clone([...this.auditRows].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit)),
  }
}
