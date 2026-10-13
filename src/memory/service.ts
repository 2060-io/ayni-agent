/**
 * Memory subsystem (architecture section 8): the long-term store of MessageEntries (sealed per entry),
 * working memory, authorize-before-retrieve, the token window, semantic recall, erasure cascade.
 */
import type { AgentPack } from '../config/packTypes.js'
import type {
  BackingIdentity,
  LifecycleState,
  MemoryAccessLog,
  MessageEntry,
  Principal,
  Session,
  Visibility,
  WorkingMemoryNote,
} from '../core/types.js'
import { SOURCE_TYPES, VISIBILITIES } from '../core/types.js'
import type { EmbeddingModel } from '../llm/types.js'
import type { EntryQuery, Store, StoredEntry } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { estimateTokens } from '../util/tokens.js'
import { type EntryCrypto, openJson, sealJson } from './crypto.js'
import { buildScope, EMPTY_SCOPE, type ScopeContext, type ScopePredicate } from './scope.js'

export interface NewEntry {
  sessionId: string
  principalId: string | null
  role: MessageEntry['role']
  sourceType: MessageEntry['sourceType']
  text: string
  completion?: MessageEntry['completion']
  attachments?: MessageEntry['attachments']
  language?: string
  visibility?: Visibility
  backingIdentity: BackingIdentity | null
  reactionPolicy?: MessageEntry['reactionPolicy']
  payload?: Record<string, unknown>
  externalId?: string
  initiatedAt?: string
  id?: string
}

interface SealedContent {
  text: string
  payload?: Record<string, unknown>
}

export class MemoryService {
  public constructor(
    private readonly store: Store,
    private readonly crypto: EntryCrypto,
    private readonly embeddings: EmbeddingModel,
    private readonly pack: AgentPack,
    private readonly logger: Logger
  ) {}

  // ---- scope ---------------------------------------------------------------------------------

  public scopeFor(principal: Principal | null, session: Session): ScopePredicate {
    if (!principal || session.state !== 'bound') return EMPTY_SCOPE
    return buildScope(this.scopeContext(principal, session))
  }

  public scopeContext(principal: Principal, session: Session): ScopeContext {
    const roles = this.pack.identity.roles ?? {}
    const widths: Record<string, number> = { 'own-sessions': 0, 'own-backing-identity': 1, all: 2 }
    const crossSession =
      principal.roles.map((r) => roles[r]?.crossSession ?? 'own-sessions').sort((a, b) => widths[b] - widths[a])[0] ??
      'own-sessions'
    return {
      principalId: principal.id,
      sessionId: session.id,
      backingIdentity: principal.backingIdentity,
      homeBackingIdentity: this.pack.identity.homeBackingIdentity,
      recognizedPartners: this.pack.identity.recognizedBackingIdentities
        .filter((r) => r.relation === 'partner')
        .map((r) => r.identity),
      crossSession,
    }
  }

  // ---- sealing -------------------------------------------------------------------------------

  private seal(entry: MessageEntry): StoredEntry {
    const { text, payload, ...rest } = entry
    if (!rest.encKeyRef) throw new Error('entry has no key')
    const { cipher, digest } = sealJson(this.crypto, rest.encKeyRef, { text, payload } satisfies SealedContent)
    return { ...rest, contentDigest: digest, cipher, textPreview: text.slice(0, 80) }
  }

  public open(stored: StoredEntry): MessageEntry {
    const { cipher, textPreview, ...rest } = stored
    if (!cipher || !rest.encKeyRef || rest.state === 'crypto-erased') {
      return { ...rest, text: rest.state === 'crypto-erased' ? '[erased]' : textPreview, payload: undefined }
    }
    try {
      const content = openJson<SealedContent>(this.crypto, rest.encKeyRef, cipher)
      return { ...rest, text: content.text, payload: content.payload }
    } catch (error) {
      this.logger.error({ err: error, entryId: rest.id }, 'entry cannot be opened')
      return { ...rest, text: '[unreadable]', payload: undefined }
    }
  }

  // ---- writes ----------------------------------------------------------------------------------

  /** Persists one canonical entry (CORE-MSG-002..007, MEM-ENTRY-001). */
  public async append(input: NewEntry): Promise<MessageEntry> {
    if (!SOURCE_TYPES.includes(input.sourceType))
      throw new Error(`invalid sourceType ${input.sourceType} (CORE-MSG-003)`)
    if (!input.text?.trim()) throw new Error('an entry needs a text representation (CORE-MSG-004)')
    const visibility = input.visibility ?? 'session-private'
    if (!VISIBILITIES.includes(visibility)) throw new Error(`invalid visibility ${visibility} (PRIV-CLS-002)`)
    for (const a of input.attachments ?? []) {
      if ((a as { data?: unknown }).data) throw new Error('attachments carry references, never bytes (MEM-ATT-001)')
    }
    const now = nowIso()
    const entry: MessageEntry = {
      id: input.id ?? prefixedId('msg'),
      sessionId: input.sessionId,
      principalId: input.principalId,
      role: input.role,
      sourceType: input.sourceType,
      text: input.text,
      completion: input.completion ?? 'complete',
      attachments: input.attachments ?? [],
      language: input.language ?? this.pack.language.agent,
      visibility,
      backingIdentity: input.backingIdentity,
      state: 'active',
      contentDigest: '',
      encKeyRef: this.crypto.newWrappedKey(),
      reactionPolicy: input.reactionPolicy,
      payload: input.payload,
      externalId: input.externalId,
      initiatedAt: input.initiatedAt ?? now,
      createdAt: now,
    }
    const stored = this.seal(entry)
    entry.contentDigest = stored.contentDigest
    await this.store.entries.insert(stored)
    if (
      this.pack.features?.semanticRecall !== false &&
      (entry.sourceType === 'text' || entry.sourceType === 'voice' || entry.sourceType === 'media')
    ) {
      this.embed(entry).catch((err) => this.logger.warn({ err, entryId: entry.id }, 'embedding failed'))
    }
    return entry
  }

  /** Re-seals an entry whose text or payload changed (a cancelled turn, a late description). */
  public async rewrite(entry: MessageEntry): Promise<void> {
    const stored = this.seal(entry)
    await this.store.entries.update(entry.id, stored)
  }

  public async get(id: string): Promise<MessageEntry | undefined> {
    const stored = await this.store.entries.get(id)
    return stored ? this.open(stored) : undefined
  }

  public async findByExternalId(sessionId: string, externalId: string): Promise<MessageEntry | undefined> {
    const stored = await this.store.entries.findByExternalId(sessionId, externalId)
    return stored ? this.open(stored) : undefined
  }

  private async embed(entry: MessageEntry): Promise<void> {
    const [vector] = await this.embeddings.embed([entry.text.slice(0, 4000)])
    if (vector) await this.store.entries.setEmbedding(entry.id, vector)
  }

  // ---- reads (every path goes through the scope predicate, PRIV-SCOPE-001..003) --------------

  public async history(
    principal: Principal | null,
    session: Session,
    q: Omit<EntryQuery, 'sessionId'>
  ): Promise<MessageEntry[]> {
    const scope = this.scopeFor(principal, session)
    const rows = await this.store.entries.query(scope, { ...q, sessionId: session.id })
    const entries = rows.map((r) => this.open(r))
    if (principal) await this.log(principal, session, scope, entries, false)
    return entries
  }

  /** The token-bounded active window (MEM-RET-001), oldest first. */
  public async window(principal: Principal, session: Session, budgetTokens: number): Promise<MessageEntry[]> {
    const scope = this.scopeFor(principal, session)
    const rows = await this.store.entries.query(scope, { sessionId: session.id, limit: 200 })
    const picked: MessageEntry[] = []
    let used = 0
    for (const row of rows) {
      const entry = this.open(row)
      const cost = estimateTokens(entry.text) + 8
      if (used + cost > budgetTokens && picked.length > 0) break
      picked.push(entry)
      used += cost
    }
    picked.reverse()
    await this.log(principal, session, scope, picked, true)
    return picked
  }

  /** Semantic recall across the authorized subset, excluding the current session's window (MEM-RET-002..004). */
  public async recall(principal: Principal, session: Session, query: string, topK: number): Promise<MessageEntry[]> {
    const scope = this.scopeFor(principal, session)
    if (scope.terms.length === 0 || !query.trim()) return []
    const [vector] = await this.embeddings.embed([query.slice(0, 4000)])
    if (!vector) return []
    const hits = await this.store.entries.vectorSearch(scope, vector, topK, session.id)
    const entries = hits.filter((h) => h.score > 0.2).map((h) => this.open(h.item))
    if (entries.length) await this.log(principal, session, scope, entries, true)
    return entries
  }

  private async log(
    principal: Principal,
    session: Session,
    scope: ScopePredicate,
    entries: MessageEntry[],
    shownToLlm: boolean
  ): Promise<void> {
    const grants = await this.store.grants.listActive(principal.id, nowIso())
    const log: MemoryAccessLog = {
      id: prefixedId('log'),
      principalId: principal.id,
      roles: principal.roles,
      activeGrantId: grants[0]?.id,
      scopePredicate: scope as unknown as Record<string, unknown>,
      matchedEntryIds: entries.map((e) => e.id),
      fromSessionIds: [...new Set(entries.map((e) => e.sessionId))],
      shownToLlm,
      influencedToolCall: false,
      ts: nowIso(),
    }
    await this.store.accessLog.insert(log).catch((err) => this.logger.warn({ err }, 'access log failed'))
    void session
  }

  public async preferences(principal: Principal) {
    return this.store.preferences.list(principal.id)
  }

  // ---- working memory (D10, MEM-TIER-003) ---------------------------------------------------------

  public async notes(principal: Principal): Promise<WorkingMemoryNote[]> {
    return (await this.store.notes.list(principal.id)).filter((n) => n.state === 'active')
  }

  public async addNote(principal: Principal, content: string, lineageRefs: string[]): Promise<WorkingMemoryNote> {
    const max = this.pack.memory?.workingMemory?.maxNotes ?? 200
    const maxChars = this.pack.memory?.workingMemory?.maxNoteChars ?? 500
    const existing = await this.notes(principal)
    if (existing.length >= max) throw new Error(`working memory is full (${max} notes); remove or merge notes first`)
    const note: WorkingMemoryNote = {
      id: prefixedId('note'),
      principalId: principal.id,
      content: content.slice(0, maxChars),
      visibility: 'principal-private',
      state: 'active',
      backingIdentity: principal.backingIdentity,
      lineageRefs,
      needsRevision: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    await this.store.notes.save(note)
    return note
  }

  public async updateNote(principal: Principal, id: string, content: string): Promise<boolean> {
    const note = (await this.store.notes.list(principal.id)).find((n) => n.id === id)
    if (!note) return false
    note.content = content.slice(0, this.pack.memory?.workingMemory?.maxNoteChars ?? 500)
    note.needsRevision = false
    note.updatedAt = nowIso()
    await this.store.notes.save(note)
    return true
  }

  public async removeNote(principal: Principal, id: string): Promise<boolean> {
    const note = (await this.store.notes.list(principal.id)).find((n) => n.id === id)
    if (!note) return false
    await this.store.notes.delete(id)
    return true
  }

  // ---- lifecycle (D19, D20, PRIV-ERASE, PRIV-RETN) -------------------------------------------------

  /** Crypto-erasure with lineage cascade (PRIV-ERASE-002..006). */
  public async erase(entryId: string): Promise<{ erased: boolean; reason?: string }> {
    const stored = await this.store.entries.get(entryId)
    if (!stored) return { erased: false, reason: 'not-found' }
    if (stored.state === 'legal-hold') return { erased: false, reason: 'legal-hold' }
    if (stored.state === 'crypto-erased') return { erased: true }
    await this.store.entries.update(entryId, { encKeyRef: null, state: 'crypto-erased', textPreview: '' })
    await this.store.entries.setEmbedding(entryId, null)
    const flagged = await this.store.notes.flagByLineage(entryId)
    this.logger.info({ entryId, flaggedNotes: flagged }, 'entry crypto-erased')
    return { erased: true }
  }

  public async setState(entryIds: string[], state: LifecycleState): Promise<void> {
    await this.store.entries.setState(entryIds, state)
  }

  /** Session histories past retention are archived, never deleted (PRIV-RETN-002). */
  public async archiveOlderThan(days: number, limit = 1000): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    const rows = await this.store.entries.listOlderThan(cutoff, 'active', limit)
    if (rows.length)
      await this.store.entries.setState(
        rows.map((r) => r.id),
        'archived'
      )
    return rows.length
  }
}
