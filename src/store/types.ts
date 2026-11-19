/**
 * Persistence interface. Two implementations: PostgreSQL (+pgvector) and in-memory (tests, quick
 * start). Entry text and payload are stored sealed (ciphertext); the MemoryService seals and opens.
 */
import type {
  ApprovalRecord,
  ApprovalStatus,
  AuthChallengeRecord,
  ChannelType,
  Conversation,
  ConversationState,
  DigestAnchor,
  ElevationGrant,
  EvidenceRecord,
  LifecycleState,
  MemoryAccessLog,
  MessageEntry,
  Principal,
  PrincipalPreference,
  RagChunk,
  Session,
  SessionState,
  StatEvent,
  WorkingMemoryNote,
} from '../core/types.js'
import type { ScopePredicate } from '../memory/scope.js'
import type { ProcessLockOptions } from './processLock.js'

/** An entry as persisted: text and payload are sealed in `cipher` (null when crypto-erased). */
/** what the store keeps of an entry: its content only as ciphertext, no preview (PRIV-ERASE-001, D77) */
export type StoredEntry = Omit<MessageEntry, 'text' | 'payload'> & { cipher: Buffer | null }

/** a place in a conversation's order: entries are ordered by (initiatedAt, id) */
export interface EntryKey {
  initiatedAt: string
  id: string
}

export interface EntryQuery {
  /** the entries of one conversation (MEM-ENTRY-004) */
  conversationId?: string
  /** the entries before this one, by its id (history paging) */
  before?: string
  /** the entries at or after this place (the window's first entry, MEM-CTX-003) */
  from?: EntryKey
  /** the entries before this place (what a summary covers) */
  until?: EntryKey
  /** newest first (the default), or oldest first */
  order?: 'desc' | 'asc'
  limit: number
  sourceTypes?: string[]
  roles?: string[]
  principalId?: string
}

export interface VectorHit<T> {
  item: T
  score: number
}

export interface PrincipalRepo {
  get(id: string): Promise<Principal | undefined>
  findByActor(actorIdentity: string): Promise<Principal | undefined>
  findByCapabilityChannel(channelId: string): Promise<Principal | undefined>
  save(principal: Principal): Promise<void>
  list(): Promise<Principal[]>
}

export interface SessionRepo {
  get(id: string): Promise<Session | undefined>
  save(session: Session): Promise<void>
  findByTokenHash(hash: string): Promise<Session | undefined>
  findByNonce(nonce: string): Promise<Session | undefined>
  findByOutOfBandId(outOfBandId: string): Promise<Session | undefined>
  findByQuestionThread(connectionId: string, threadId: string): Promise<Session | undefined>
  findByExternalRef(channelType: ChannelType, externalRef: string): Promise<Session | undefined>
  listByPrincipal(principalId: string, states?: SessionState[]): Promise<Session[]>
  listByState(state: SessionState): Promise<Session[]>
  nextStreamCursor(id: string): Promise<number>
}

export interface ConversationRepo {
  get(id: string): Promise<Conversation | undefined>
  save(conversation: Conversation): Promise<void>
  listByPrincipal(principalId: string, states?: ConversationState[]): Promise<Conversation[]>
  /** every conversation, for the start job that seals what an earlier version kept in the clear (D77) */
  listAll(): Promise<Conversation[]>
}

export interface EntryRepo {
  insert(entry: StoredEntry): Promise<void>
  get(id: string): Promise<StoredEntry | undefined>
  update(id: string, patch: Partial<StoredEntry>): Promise<void>
  findByExternalId(sessionId: string, externalId: string): Promise<StoredEntry | undefined>
  /** newest-first page within the scope (PRIV-SCOPE-001) */
  query(scope: ScopePredicate, q: EntryQuery): Promise<StoredEntry[]>
  vectorSearch(
    scope: ScopePredicate,
    vector: number[],
    topK: number,
    /** the entries the model already reads (the window, MEM-RET-007) */
    excludeIds?: string[]
  ): Promise<VectorHit<StoredEntry>[]>
  setEmbedding(id: string, vector: number[] | null): Promise<void>
  /**
   * Every entry of a conversation or of a Principal, in every lifecycle state, oldest first: for the erasure cascade
   * and the auditor's interface (RBAC-XSESS-006), never for the model
   */
  listAll(q: { conversationId?: string; principalId?: string; limit: number }): Promise<StoredEntry[]>
  /** entries an earlier version stored with an attachment's text or name in the clear (D77) */
  listWithPlainAttachments(limit: number): Promise<StoredEntry[]>
  listUnanchored(limit: number): Promise<StoredEntry[]>
  markAnchored(ids: string[], batchId: string): Promise<void>
  listOlderThan(cutoffIso: string, state: LifecycleState, limit: number): Promise<StoredEntry[]>
  setState(ids: string[], state: LifecycleState): Promise<void>
  /** the entries of the given sessions become those of another Principal (a visitor who identifies, IDENT-RES-013) */
  reassign(sessionIds: string[], principalId: string): Promise<number>
  listAttachmentKeys(): Promise<{ entryId: string; state: LifecycleState; bucketKey: string }[]>
}

export interface WorkingMemoryRepo {
  /** a retrieval: through the scope predicate (PRIV-SCOPE-003) */
  query(scope: ScopePredicate): Promise<WorkingMemoryNote[]>
  /** the Principal's notes, for the writes of the working-memory tool */
  list(principalId: string): Promise<WorkingMemoryNote[]>
  save(note: WorkingMemoryNote): Promise<void>
  delete(id: string): Promise<void>
  flagByLineage(entryId: string): Promise<number>
  /** every note, for sealing what an earlier version kept in the clear (D77) */
  listAll(): Promise<WorkingMemoryNote[]>
}

export interface PreferenceRepo {
  /** a retrieval: through the scope predicate (PRIV-SCOPE-003) */
  query(scope: ScopePredicate): Promise<PrincipalPreference[]>
  list(principalId: string): Promise<PrincipalPreference[]>
  set(pref: PrincipalPreference): Promise<void>
  /** removes one preference by the key it is stored under */
  delete(principalId: string, key: string): Promise<void>
  /** every preference, for sealing what an earlier version kept in the clear (D77) */
  listAll(): Promise<PrincipalPreference[]>
}

/** An evidence record with the ciphertext of its stored values (null when none were stored, or once erased). */
export type StoredEvidence = EvidenceRecord & { cipher: Buffer | null }

export interface EvidenceRepo {
  list(principalId: string): Promise<StoredEvidence[]>
  get(id: string): Promise<StoredEvidence | undefined>
  save(record: StoredEvidence): Promise<void>
  /** active records whose retention ended at or before the given time */
  listExpired(nowIso: string): Promise<StoredEvidence[]>
}

export interface ApprovalRepo {
  get(id: string): Promise<ApprovalRecord | undefined>
  save(record: ApprovalRecord): Promise<void>
  list(filter: {
    status?: ApprovalStatus
    requesterId?: string
    eligibleRole?: string
    /** the approvals asked in the turn that answered this message (PRIV-ERASE-005) */
    inboundId?: string
  }): Promise<ApprovalRecord[]>
}

export interface GrantRepo {
  listActive(principalId: string, nowIso: string): Promise<ElevationGrant[]>
  save(grant: ElevationGrant): Promise<void>
}

export interface ChallengeRepo {
  get(id: string): Promise<AuthChallengeRecord | undefined>
  findByToken(token: string): Promise<AuthChallengeRecord | undefined>
  save(record: AuthChallengeRecord): Promise<void>
  listPending(): Promise<AuthChallengeRecord[]>
}

export interface AccessLogRepo {
  insert(log: MemoryAccessLog): Promise<void>
}

export interface AnchorRepo {
  save(anchor: DigestAnchor): Promise<void>
  listPending(): Promise<DigestAnchor[]>
  list(): Promise<DigestAnchor[]>
}

export interface RagRepo {
  replaceSource(sourceId: string, chunks: (RagChunk & { vector: number[] | null })[]): Promise<void>
  vectorSearch(scope: ScopePredicate, vector: number[], topK: number): Promise<VectorHit<RagChunk>[]>
  sourceDigest(sourceId: string): Promise<string | undefined>
  setSourceDigest(sourceId: string, digest: string): Promise<void>
}

export interface StatsRepo {
  insert(events: StatEvent[]): Promise<void>
  query(q: {
    from: string
    to: string
    statClass?: string
    granularity: 'hour' | 'day' | 'month'
  }): Promise<{ bucket: string; statClass: string; count: number; sum: number }[]>
}

export interface KvRepo {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** A call to the admin interface (D78, PRIV-ERASE-008, RBAC-XSESS-006): who made it, why, and what it touched. */
export interface AdminAuditRecord {
  id: string
  ts: string
  action: 'erasure' | 'legal-hold' | 'legal-hold-release' | 'audit-read'
  actor: string
  reason: string
  /** what it named and what came of it: entry ids, a conversation, a Principal, an evidence record, counts */
  detail: Record<string, unknown>
}

export interface AdminAuditRepo {
  insert(record: AdminAuditRecord): Promise<void>
  list(limit: number): Promise<AdminAuditRecord[]>
}

export interface Store {
  readonly kind: 'postgres' | 'memory'
  /**
   * Makes this process the one that serves the store (PLAT-DEPLOY-004): waits for as long as another holds it,
   * and resolves with the way to give it back. Called before `init`, given back before `close`.
   */
  exclusive(options: ProcessLockOptions): Promise<() => Promise<void>>
  init(): Promise<void>
  close(): Promise<void>
  principals: PrincipalRepo
  sessions: SessionRepo
  conversations: ConversationRepo
  entries: EntryRepo
  notes: WorkingMemoryRepo
  preferences: PreferenceRepo
  evidence: EvidenceRepo
  approvals: ApprovalRepo
  grants: GrantRepo
  challenges: ChallengeRepo
  accessLog: AccessLogRepo
  anchors: AnchorRepo
  rag: RagRepo
  stats: StatsRepo
  kv: KvRepo
  adminAudit: AdminAuditRepo
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}
