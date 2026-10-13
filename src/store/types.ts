/**
 * Persistence interface. Two implementations: PostgreSQL (+pgvector) and in-memory (tests, quick
 * start). Entry text and payload are stored sealed (ciphertext); the MemoryService seals and opens.
 */
import type {
  ApprovalRecord,
  ApprovalStatus,
  AuthChallengeRecord,
  ChannelType,
  CredentialPresentation,
  DigestAnchor,
  ElevationGrant,
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

/** An entry as persisted: text and payload are sealed in `cipher` (null when crypto-erased). */
export type StoredEntry = Omit<MessageEntry, 'text' | 'payload'> & { cipher: Buffer | null; textPreview: string }

export interface EntryQuery {
  sessionId?: string
  sessionIds?: string[]
  before?: string
  limit: number
  sourceTypes?: string[]
  roles?: string[]
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
    excludeSessionId?: string
  ): Promise<VectorHit<StoredEntry>[]>
  setEmbedding(id: string, vector: number[] | null): Promise<void>
  listUnanchored(limit: number): Promise<StoredEntry[]>
  markAnchored(ids: string[], batchId: string): Promise<void>
  listOlderThan(cutoffIso: string, state: LifecycleState, limit: number): Promise<StoredEntry[]>
  setState(ids: string[], state: LifecycleState): Promise<void>
  listAttachmentKeys(): Promise<{ entryId: string; state: LifecycleState; bucketKey: string }[]>
}

export interface WorkingMemoryRepo {
  list(principalId: string): Promise<WorkingMemoryNote[]>
  save(note: WorkingMemoryNote): Promise<void>
  delete(id: string): Promise<void>
  flagByLineage(entryId: string): Promise<number>
}

export interface PreferenceRepo {
  list(principalId: string): Promise<PrincipalPreference[]>
  set(pref: PrincipalPreference): Promise<void>
}

export interface CredentialRepo {
  list(principalId: string): Promise<CredentialPresentation[]>
  get(id: string): Promise<CredentialPresentation | undefined>
  save(cred: CredentialPresentation): Promise<void>
}

export interface ApprovalRepo {
  get(id: string): Promise<ApprovalRecord | undefined>
  save(record: ApprovalRecord): Promise<void>
  list(filter: { status?: ApprovalStatus; requesterId?: string; eligibleRole?: string }): Promise<ApprovalRecord[]>
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
}

export interface Store {
  readonly kind: 'postgres' | 'memory'
  init(): Promise<void>
  close(): Promise<void>
  principals: PrincipalRepo
  sessions: SessionRepo
  entries: EntryRepo
  notes: WorkingMemoryRepo
  preferences: PreferenceRepo
  credentials: CredentialRepo
  approvals: ApprovalRepo
  grants: GrantRepo
  challenges: ChallengeRepo
  accessLog: AccessLogRepo
  anchors: AnchorRepo
  rag: RagRepo
  stats: StatsRepo
  kv: KvRepo
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
