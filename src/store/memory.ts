/** In-memory store: tests and quick starts. Same semantics as the PostgreSQL store. */
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
import { matchesScope, type ScopePredicate } from '../memory/scope.js'
import { cosine, type EntryQuery, type Store, type StoredEntry, type VectorHit } from './types.js'

const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T))

export class MemoryStore implements Store {
  public readonly kind = 'memory' as const
  private principalRows = new Map<string, Principal>()
  private sessionRows = new Map<string, Session>()
  private conversationRows = new Map<string, Conversation>()
  private entryRows = new Map<string, StoredEntry>()
  private embeddings = new Map<string, number[]>()
  private noteRows = new Map<string, WorkingMemoryNote>()
  private prefRows = new Map<string, PrincipalPreference>()
  private credRows = new Map<string, CredentialPresentation>()
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
    listByPrincipal: async (principalId: string, states?: Conversation['state'][]) =>
      clone(
        [...this.conversationRows.values()]
          .filter((c) => c.principalId === principalId && (!states || states.includes(c.state)))
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      ),
  }

  private scoped(scope: ScopePredicate): StoredEntry[] {
    return [...this.entryRows.values()].filter((e) =>
      matchesScope(scope, {
        visibility: e.visibility,
        state: e.state,
        sessionId: e.sessionId,
        principalId: e.principalId,
        backingIdentity: e.backingIdentity,
      })
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
      if (q.sessionId) rows = rows.filter((e) => e.sessionId === q.sessionId)
      if (q.sessionIds) rows = rows.filter((e) => q.sessionIds?.includes(e.sessionId))
      if (q.sourceTypes) rows = rows.filter((e) => q.sourceTypes?.includes(e.sourceType))
      if (q.roles) rows = rows.filter((e) => q.roles?.includes(e.role))
      rows.sort((a, b) =>
        a.initiatedAt < b.initiatedAt ? 1 : a.initiatedAt > b.initiatedAt ? -1 : b.id.localeCompare(a.id)
      )
      if (q.before) {
        const pivot = this.entryRows.get(q.before)
        if (pivot)
          rows = rows.filter(
            (e) => e.initiatedAt < pivot.initiatedAt || (e.initiatedAt === pivot.initiatedAt && e.id < pivot.id)
          )
      }
      return clone(rows.slice(0, q.limit))
    },
    vectorSearch: async (scope: ScopePredicate, vector: number[], topK: number, excludeSessionId?: string) => {
      const hits: VectorHit<StoredEntry>[] = []
      for (const e of this.scoped(scope)) {
        if (excludeSessionId && e.sessionId === excludeSessionId) continue
        const v = this.embeddings.get(e.id)
        if (v) hits.push({ item: clone(e), score: cosine(vector, v) })
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, topK)
    },
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
  }

  public preferences = {
    list: async (principalId: string) =>
      clone([...this.prefRows.values()].filter((p) => p.principalId === principalId)),
    set: async (p: PrincipalPreference) => {
      this.prefRows.set(`${p.principalId}:${p.key}`, clone(p))
    },
  }

  public credentials = {
    list: async (principalId: string) =>
      clone([...this.credRows.values()].filter((c) => c.principalId === principalId)),
    get: async (id: string) => clone(this.credRows.get(id)),
    save: async (c: CredentialPresentation) => {
      this.credRows.set(c.id, clone(c))
    },
  }

  public approvals = {
    get: async (id: string) => clone(this.approvalRows.get(id)),
    save: async (r: ApprovalRecord) => {
      this.approvalRows.set(r.id, clone(r))
    },
    list: async (f: { status?: ApprovalRecord['status']; requesterId?: string; eligibleRole?: string }) =>
      clone(
        [...this.approvalRows.values()].filter(
          (r) =>
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
        if (!c.vector || !matchesScope(scope, { visibility: c.visibility, state: c.state })) continue
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
  }
}
