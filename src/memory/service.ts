/**
 * Memory subsystem (architecture section 8): the long-term store of MessageEntries (sealed per entry), working
 * memory, authorize-before-retrieve, the conversation's entries, semantic recall, erasure and its cascade.
 */
import type { AgentPack } from '../config/packTypes.js'
import { conversationOf } from '../core/conversationOf.js'
import { personalSpaceId, spaceIdOf } from '../core/spaces.js'
import type {
  BackingIdentity,
  LifecycleState,
  MemoryAccessLog,
  MessageAttachment,
  MessageEntry,
  Principal,
  PrincipalPreference,
  Session,
  Visibility,
  WorkingMemoryNote,
} from '../core/types.js'
import { SOURCE_TYPES, VISIBILITIES } from '../core/types.js'
import type { EmbeddingModel } from '../llm/types.js'
import type { EntryKey, EntryQuery, Store, StoredEntry } from '../store/types.js'
import { monotonicIso, nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { type EntryCrypto, openJson, sealJson } from './crypto.js'
import { buildScope, EMPTY_SCOPE, type ScopeContext, type ScopePredicate } from './scope.js'
import {
  preferenceIndex,
  type SealedNotes,
  type SealedPreferences,
  sealedNotes,
  sealedPreferences,
} from './sealedMemory.js'

export interface NewEntry {
  sessionId: string
  /** the conversation it belongs to; the session's conversation when absent (MEM-ENTRY-004) */
  conversationId?: string
  /** the space of the conversation; read from the conversation when absent (SPACE-CONV-001) */
  spaceId?: string
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

/** What of an attachment is content: sealed with the entry, never beside it (PRIV-ERASE-001, D77). */
interface SealedAttachment {
  id: string
  textRepr: string
  filename?: string
}

interface SealedContent {
  text: string
  payload?: Record<string, unknown>
  attachments?: SealedAttachment[]
}

/** An attachment as the store keeps it beside the ciphertext: its reference and measures, none of its content. */
function skeleton(a: MessageAttachment): MessageAttachment {
  const { filename: _filename, ...rest } = a
  return { ...rest, textRepr: '' }
}

/** A recalled entry and where it comes from (MEM-RET-007). */
export interface Recalled {
  entry: MessageEntry
  origin: 'this-conversation' | 'another-conversation'
}

/** What an erasure did (PRIV-ERASE-002..005). */
export interface ErasureResult {
  erased: boolean
  reason?: 'not-found' | 'legal-hold'
  /** the entries erased with it: the tool calls of the turn that answered it */
  cascaded: string[]
  conversationId?: string
}

/** What the rest of the agent does when a conversation loses an entry: its summary, its last text (PRIV-ERASE-005). */
export interface ErasureHooks {
  conversationErased?(conversationId: string): Promise<void>
}

/**
 * What a person's deletion of their message did (PRIV-ERASE-011/012): the message, the agent's reply to it (its messages, the
 * tool calls and the memory lines of the turn) and the memories taken from it, gone at once.
 */
export interface TurnErasure {
  outcome: 'erased' | 'not-found' | 'legal-hold'
  conversationId?: string
  /** every entry erased, the message first */
  erased: StoredEntry[]
  /** the person's memories deleted with them */
  memoryIds: string[]
}

/** The entry answered the message: the turn that answered it names it (inboundId, inboundIds). */
export function answers(payload: Record<string, unknown> | undefined, messageId: string): boolean {
  if (!payload) return false
  if (payload.inboundId === messageId) return true
  return Array.isArray(payload.inboundIds) && payload.inboundIds.includes(messageId)
}

/** What the scope of internal work (the erasure cascade) reads: every visibility, active entries only. */
const SYSTEM_SCOPE: ScopePredicate = { state: 'active', terms: VISIBILITIES.map((visibility) => ({ visibility })) }

export class MemoryService {
  public hooks: ErasureHooks = {}
  /** notes and preferences go through these: the store keeps them sealed (D77, PRIV-ERASE-009) */
  private readonly notesRepo: SealedNotes
  private readonly prefsRepo: SealedPreferences

  public constructor(
    private readonly store: Store,
    private readonly crypto: EntryCrypto,
    private readonly embeddings: EmbeddingModel,
    private readonly pack: AgentPack,
    private readonly logger: Logger
  ) {
    this.notesRepo = sealedNotes(store.notes, crypto)
    this.prefsRepo = sealedPreferences(store.preferences, crypto)
  }

  // ---- scope ---------------------------------------------------------------------------------

  /**
   * What a retrieval of the session reads (PRIV-SCOPE-001); with a space, its `principal-private` items are those of that
   * space only (MEM-SPACE-001).
   */
  public scopeFor(principal: Principal | null, session: Session, spaceId?: string): ScopePredicate {
    if (!principal || session.state !== 'bound') return EMPTY_SCOPE
    return buildScope(this.scopeContext(principal, session, spaceId))
  }

  /** What a retrieval of the session reads; no role widens it (RBAC-XSESS-001). */
  public scopeContext(principal: Principal, session: Session, spaceId?: string): ScopeContext {
    return {
      principalId: principal.id,
      conversationId: conversationOf(session),
      backingIdentity: principal.backingIdentity,
      relation: principal.backingRelation,
      ...(spaceId ? { spaceId } : {}),
    }
  }

  // ---- sealing -------------------------------------------------------------------------------

  private seal(entry: MessageEntry): StoredEntry {
    const { text, payload, attachments, ...rest } = entry
    if (!rest.encKeyRef) throw new Error('entry has no key')
    // the content lives only as ciphertext, an attachment's text and name with it: nothing of it beside the
    // ciphertext (PRIV-ERASE-001, D77)
    const sealed: SealedContent = {
      text,
      payload,
      attachments: attachments.map((a) => ({ id: a.id, textRepr: a.textRepr, filename: a.filename })),
    }
    const { cipher, digest } = sealJson(this.crypto, rest.encKeyRef, sealed)
    return { ...rest, attachments: attachments.map(skeleton), contentDigest: digest, cipher }
  }

  public open(stored: StoredEntry): MessageEntry {
    const { cipher, ...rest } = stored
    if (rest.state === 'crypto-erased' || !rest.encKeyRef) return { ...rest, text: '[erased]', payload: undefined }
    if (!cipher) return { ...rest, text: '[unreadable]', payload: undefined }
    try {
      const content = openJson<SealedContent>(this.crypto, rest.encKeyRef, cipher)
      const sealed = new Map((content.attachments ?? []).map((a) => [a.id, a]))
      const attachments = rest.attachments.map((a) => {
        const inside = sealed.get(a.id)
        return inside
          ? { ...a, textRepr: inside.textRepr, ...(inside.filename ? { filename: inside.filename } : {}) }
          : a
      })
      return { ...rest, attachments, text: content.text, payload: content.payload }
    } catch (error) {
      this.logger.error({ err: error, entryId: rest.id }, 'entry cannot be opened')
      return { ...rest, text: '[unreadable]', payload: undefined }
    }
  }

  // ---- writes ----------------------------------------------------------------------------------

  /** Persists one canonical entry (CORE-MSG-002..007, MEM-ENTRY-001, MEM-ENTRY-004). */
  public async append(input: NewEntry): Promise<MessageEntry> {
    if (!SOURCE_TYPES.includes(input.sourceType))
      throw new Error(`invalid sourceType ${input.sourceType} (CORE-MSG-003)`)
    if (!input.text?.trim()) throw new Error('an entry needs a text representation (CORE-MSG-004)')
    const visibility = input.visibility ?? 'conversation-private'
    if (!VISIBILITIES.includes(visibility)) throw new Error(`invalid visibility ${visibility} (PRIV-CLS-002)`)
    for (const a of input.attachments ?? []) {
      if ((a as { data?: unknown }).data) throw new Error('attachments carry references, never bytes (MEM-ATT-001)')
    }
    const conversationId = input.conversationId ?? (await this.conversationOfSession(input.sessionId))
    const spaceId = input.spaceId ?? (await this.spaceOfConversation(conversationId, input.principalId))
    // strictly after the entry recorded before it: what is recorded in order is read in order (CORE-MSG-010)
    const now = monotonicIso()
    const entry: MessageEntry = {
      id: input.id ?? prefixedId('msg'),
      sessionId: input.sessionId,
      conversationId,
      ...(spaceId ? { spaceId } : {}),
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

  private async conversationOfSession(sessionId: string): Promise<string> {
    const session = await this.store.sessions.get(sessionId)
    return session ? conversationOf(session) : sessionId
  }

  /** The space of a conversation (SPACE-CONV-001): the one it names, else the Personal space of its Principal. */
  private async spaceOfConversation(conversationId: string, principalId: string | null): Promise<string | undefined> {
    const conversation = await this.store.conversations.get(conversationId)
    if (conversation) return spaceIdOf(conversation)
    return principalId ? personalSpaceId(principalId) : undefined
  }

  /** Re-seals an entry whose text or payload changed (a cancelled turn, a late description). */
  public async rewrite(entry: MessageEntry): Promise<void> {
    if (entry.state === 'crypto-erased' || !entry.encKeyRef) return
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

  /** The conversation's history as a UI reads it, newest first (PROF-HIST). */
  public async history(
    principal: Principal | null,
    session: Session,
    q: Omit<EntryQuery, 'conversationId'>
  ): Promise<MessageEntry[]> {
    const scope = this.scopeFor(principal, session)
    const rows = await this.store.entries.query(scope, { ...q, conversationId: conversationOf(session) })
    const entries = rows.map((r) => this.open(r))
    if (principal) await this.log(principal, scope, 'entries', entries, false)
    return entries
  }

  /**
   * The entries of the session's conversation in an interval of its order, for the context of a turn (MEM-CTX-003):
   * oldest first, or newest first. Not logged here: the context logs what it gives the model (logShown).
   */
  public async conversationEntries(
    principal: Principal,
    session: Session,
    q: { from?: EntryKey; until?: EntryKey; limit: number; order?: 'asc' | 'desc' }
  ): Promise<MessageEntry[]> {
    const scope = this.scopeFor(principal, session)
    const rows = await this.store.entries.query(scope, { ...q, conversationId: conversationOf(session) })
    return rows.map((r) => this.open(r))
  }

  /** Records that these entries were given to the model (PRIV-SCOPE-006). */
  public async logShown(principal: Principal, session: Session, entries: MessageEntry[]): Promise<void> {
    if (!entries.length) return
    await this.log(principal, this.scopeFor(principal, session), 'entries', entries, true)
  }

  /**
   * Semantic recall within the authorized subset (MEM-RET-002..004), never an entry the window already gives the
   * model (MEM-RET-007); each says whether it comes from this conversation or another.
   */
  public async recall(
    principal: Principal,
    session: Session,
    query: string,
    topK: number,
    excludeIds: string[],
    /** the space of the conversation: what is `principal-private` of another space is not recalled (MEM-SPACE-001) */
    spaceId?: string
  ): Promise<Recalled[]> {
    const scope = this.scopeFor(principal, session, spaceId)
    if (scope.terms.length === 0 || !query.trim()) return []
    const [vector] = await this.embeddings.embed([query.slice(0, 4000)])
    if (!vector) return []
    const hits = await this.store.entries.vectorSearch(scope, vector, topK, excludeIds)
    const here = conversationOf(session)
    const recalled = hits
      .filter((h) => h.score > 0.2)
      .map((h) => {
        const entry = this.open(h.item)
        return {
          entry,
          origin: entry.conversationId === here ? ('this-conversation' as const) : ('another-conversation' as const),
        }
      })
    if (recalled.length)
      await this.log(
        principal,
        scope,
        'entries',
        recalled.map((r) => r.entry),
        true
      )
    return recalled
  }

  /**
   * The entries of a conversation its author shares with its space, read by a member of the space (handover, decision
   * 60): through the predicate of that conversation alone, logged under the reader. Never given to the model.
   */
  public async sharedHistory(
    reader: Principal,
    conversation: { id: string; principalId: string },
    scope: ScopePredicate,
    q: Omit<EntryQuery, 'conversationId'>
  ): Promise<MessageEntry[]> {
    const rows = await this.store.entries.query(scope, { ...q, conversationId: conversation.id })
    const entries = rows.map((r) => this.open(r))
    await this.log(reader, scope, 'entries', entries, false)
    return entries
  }

  private async log(
    principal: Principal,
    scope: ScopePredicate,
    store: string,
    items: { id: string; sessionId?: string }[],
    shownToLlm: boolean
  ): Promise<void> {
    const grants = await this.store.grants.listActive(principal.id, nowIso())
    const log: MemoryAccessLog = {
      id: prefixedId('log'),
      principalId: principal.id,
      roles: principal.roles,
      activeGrantId: grants[0]?.id,
      scopePredicate: scope as unknown as Record<string, unknown>,
      store,
      matchedEntryIds: items.map((e) => e.id),
      fromSessionIds: [...new Set(items.flatMap((e) => (e.sessionId ? [e.sessionId] : [])))],
      shownToLlm,
      influencedToolCall: false,
      ts: nowIso(),
    }
    await this.store.accessLog.insert(log).catch((err) => this.logger.warn({ err }, 'access log failed'))
  }

  /** The Principal's preferences, through the scope predicate, logged (PRIV-SCOPE-003/006). */
  public async preferences(principal: Principal, session: Session): Promise<PrincipalPreference[]> {
    const scope = this.scopeFor(principal, session)
    if (scope.terms.length === 0) return []
    const prefs = await this.prefsRepo.query(scope)
    if (prefs.length) {
      // the log names a preference by its index: its name stays sealed (D77)
      const ids = prefs.map((p) => ({ id: `pref:${preferenceIndex(this.crypto, p.principalId, p.key)}` }))
      await this.log(principal, scope, 'preferences', ids, true)
    }
    return prefs
  }

  /** Stores a preference of the Principal, sealed (D77). */
  public async setPreference(principal: Principal, key: string, value: string): Promise<void> {
    await this.prefsRepo.set({ principalId: principal.id, key, value, updatedAt: nowIso() })
  }

  /** The person reads their own preferences (MEM-SPACE-003): logged, not shown to the model. */
  public async ownPreferences(principal: Principal, session: Session): Promise<PrincipalPreference[]> {
    const scope = this.scopeFor(principal, session)
    if (scope.terms.length === 0) return []
    const prefs = await this.prefsRepo.query(scope)
    if (prefs.length) {
      const ids = prefs.map((p) => ({ id: `pref:${preferenceIndex(this.crypto, p.principalId, p.key)}` }))
      await this.log(principal, scope, 'preferences', ids, false)
    }
    return prefs.sort((a, b) => a.key.localeCompare(b.key))
  }

  /** The person deletes one of their preferences by its name (MEM-SPACE-004); false when they have none of it. */
  public async deletePreference(principal: Principal, key: string): Promise<boolean> {
    const found = (await this.prefsRepo.list(principal.id)).some((p) => p.key === key)
    if (!found) return false
    await this.prefsRepo.delete(principal.id, key)
    this.logger.info({ principalId: principal.id }, 'preference deleted by the person')
    return true
  }

  /** Seals the notes and preferences an earlier version kept in the clear (D77); at start. */
  public async sealPlainNotesAndPreferences(): Promise<{ notes: number; preferences: number }> {
    return { notes: await this.notesRepo.sealPlain(), preferences: await this.prefsRepo.sealPlain() }
  }

  // ---- working memory (D10, MEM-TIER-003) ---------------------------------------------------------

  /**
   * The Principal's working memory of one space, through the scope predicate, logged (PRIV-SCOPE-003/006): the model
   * reads the notes of the space of its conversation only (MEM-SPACE-001), Personal when none is named.
   */
  public async notes(principal: Principal, session: Session, spaceId?: string): Promise<WorkingMemoryNote[]> {
    const scope = this.scopeFor(principal, session, spaceId ?? personalSpaceId(principal.id))
    if (scope.terms.length === 0) return []
    const notes = await this.notesRepo.query(scope)
    if (notes.length) await this.log(principal, scope, 'working_memory', notes, true)
    return notes
  }

  /** The person reads their own memories, of one space or of every space (MEM-SPACE-003): logged, not shown to the model. */
  public async ownNotes(principal: Principal, session: Session, spaceId?: string): Promise<WorkingMemoryNote[]> {
    const scope = this.scopeFor(principal, session, spaceId)
    if (scope.terms.length === 0) return []
    const notes = await this.notesRepo.query(scope)
    if (notes.length) await this.log(principal, scope, 'working_memory', notes, false)
    return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** The space a note belongs to: the one it names, else Personal. */
  public static spaceOfNote(note: Pick<WorkingMemoryNote, 'spaceId' | 'principalId'>): string {
    return note.spaceId ?? personalSpaceId(note.principalId)
  }

  private async activeNotes(principal: Principal, spaceId: string): Promise<WorkingMemoryNote[]> {
    return (await this.notesRepo.list(principal.id)).filter(
      (n) => n.state === 'active' && MemoryService.spaceOfNote(n) === spaceId
    )
  }

  /** A note of a space, by its id: the model curates the notes of the space of its conversation only. */
  private async noteOf(principal: Principal, id: string, spaceId?: string): Promise<WorkingMemoryNote | undefined> {
    const note = (await this.notesRepo.list(principal.id)).find((n) => n.id === id)
    if (!note || (spaceId !== undefined && MemoryService.spaceOfNote(note) !== spaceId)) return undefined
    return note
  }

  /** A note taken from a message, in the space of its conversation (MEM-SPACE-001); at most `maxNotes` per space. */
  public async addNote(
    principal: Principal,
    content: string,
    lineageRefs: string[],
    spaceId: string = personalSpaceId(principal.id)
  ): Promise<WorkingMemoryNote> {
    const max = this.pack.memory?.workingMemory?.maxNotes ?? 200
    const maxChars = this.pack.memory?.workingMemory?.maxNoteChars ?? 500
    const existing = await this.activeNotes(principal, spaceId)
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
      spaceId,
    }
    await this.notesRepo.save(note)
    return note
  }

  /**
   * A note changed from what the person said: the message it was changed from joins its lineage, so that deleting that
   * message within its window deletes the note too (PRIV-ERASE-012).
   */
  public async updateNote(
    principal: Principal,
    id: string,
    content: string,
    opts: { spaceId?: string; from?: string } = {}
  ): Promise<WorkingMemoryNote | undefined> {
    const note = await this.noteOf(principal, id, opts.spaceId)
    if (!note) return undefined
    note.content = content.slice(0, this.pack.memory?.workingMemory?.maxNoteChars ?? 500)
    note.needsRevision = false
    note.updatedAt = nowIso()
    if (opts.from && !note.lineageRefs.includes(opts.from)) note.lineageRefs = [...note.lineageRefs, opts.from]
    await this.notesRepo.save(note)
    return note
  }

  public async removeNote(
    principal: Principal,
    id: string,
    opts: { spaceId?: string } = {}
  ): Promise<WorkingMemoryNote | undefined> {
    const note = await this.noteOf(principal, id, opts.spaceId)
    if (!note) return undefined
    await this.notesRepo.delete(id)
    return note
  }

  // ---- lifecycle (D19, D20, PRIV-ERASE, PRIV-RETN) -------------------------------------------------

  /**
   * Crypto-erasure with its cascade (PRIV-ERASE-002..006): the key destroyed, the ciphertext and digest kept; the
   * embedding deleted; the notes citing it flagged; the tool calls of the turn that answered it erased, and the
   * arguments of their approvals; the conversation's summary and last text left to the hooks. Refused on legal hold.
   */
  public async erase(entryId: string): Promise<ErasureResult> {
    const stored = await this.store.entries.get(entryId)
    if (!stored) return { erased: false, reason: 'not-found', cascaded: [] }
    if (stored.state === 'legal-hold') {
      return { erased: false, reason: 'legal-hold', cascaded: [], conversationId: stored.conversationId }
    }
    if (stored.state === 'crypto-erased') return { erased: true, cascaded: [], conversationId: stored.conversationId }
    await this.destroy(stored)
    const cascaded: string[] = []
    // the turn that answered it: its tool calls carry the message they answered (inboundId)
    const turn = await this.store.entries.query(SYSTEM_SCOPE, {
      conversationId: stored.conversationId,
      sourceTypes: ['tool-call'],
      limit: 10_000,
    })
    for (const row of turn) {
      const call = this.open(row)
      if ((call.payload as { inboundId?: string } | undefined)?.inboundId !== entryId) continue
      await this.destroy(row)
      cascaded.push(row.id)
    }
    for (const approval of await this.store.approvals.list({ inboundId: entryId })) {
      await this.store.approvals.save({ ...approval, actionArgs: undefined, argsErased: true })
    }
    this.logger.info({ entryId, cascaded: cascaded.length }, 'entry crypto-erased')
    await this.hooks.conversationErased?.(stored.conversationId)
    return { erased: true, cascaded, conversationId: stored.conversationId }
  }

  /**
   * A person deletes a message of theirs within its window (PRIV-ERASE-007, PRIV-ERASE-011/012): the message, the agent's reply to it (the
   * agent's messages, the tool calls and the memory lines of the turn that answered it, which name it) and the memories
   * taken from any of them are gone at once: the keys destroyed, the notes deleted, not flagged. The arguments of the
   * turn's approvals go too. The caller checked whose message it is and its window; a message on legal hold is refused,
   * and an entry of the turn on legal hold stays.
   */
  public async eraseTurn(entryId: string): Promise<TurnErasure> {
    const stored = await this.store.entries.get(entryId)
    if (!stored) return { outcome: 'not-found', erased: [], memoryIds: [] }
    if (stored.state === 'legal-hold')
      return { outcome: 'legal-hold', conversationId: stored.conversationId, erased: [], memoryIds: [] }
    if (stored.state === 'crypto-erased')
      return { outcome: 'erased', conversationId: stored.conversationId, erased: [], memoryIds: [] }
    // the turn that answered it comes after it in the conversation, from the same millisecond on, and names it
    const after = await this.store.entries.query(SYSTEM_SCOPE, {
      conversationId: stored.conversationId,
      from: { initiatedAt: stored.initiatedAt, id: '' },
      order: 'asc',
      roles: ['agent', 'system'],
      // the reply to a message of an email check is the code's answer, an `auth-challenge` entry that names it; the
      // flow, approval and auth-challenge entries of a turn of the model stay (PRIV-ERASE-011)
      sourceTypes: [
        'text',
        'voice',
        'media',
        'tool-call',
        'state-update',
        'refusal',
        ...(stored.sourceType === 'auth-challenge' ? (['auth-challenge'] as const) : []),
      ],
      limit: 2000,
    })
    const turn = after.filter((row) => row.id !== stored.id && answers(this.open(row).payload, entryId))
    const erased = [stored, ...turn]
    const ids = new Set(erased.map((e) => e.id))
    // the memories taken from the message or from its turn are deleted (decision 8 of the design)
    const memoryIds: string[] = []
    if (stored.principalId) {
      for (const note of await this.notesRepo.list(stored.principalId)) {
        if (!note.lineageRefs.some((ref) => ids.has(ref))) continue
        await this.notesRepo.delete(note.id)
        memoryIds.push(note.id)
      }
    }
    for (const row of erased) await this.destroy(row)
    for (const approval of await this.store.approvals.list({ inboundId: entryId })) {
      await this.store.approvals.save({ ...approval, actionArgs: undefined, argsErased: true })
    }
    this.logger.info(
      { entryId, cascaded: turn.length, memories: memoryIds.length },
      'message deleted by its author, with its reply'
    )
    await this.hooks.conversationErased?.(stored.conversationId)
    return { outcome: 'erased', conversationId: stored.conversationId, erased, memoryIds }
  }

  private async destroy(stored: StoredEntry): Promise<void> {
    await this.store.entries.update(stored.id, { encKeyRef: null, state: 'crypto-erased' })
    await this.store.entries.setEmbedding(stored.id, null)
    const flagged = await this.store.notes.flagByLineage(stored.id)
    if (flagged) this.logger.info({ entryId: stored.id, flaggedNotes: flagged }, 'notes citing an erased entry flagged')
  }

  /**
   * Seals what an earlier version kept in the clear beside an entry: an attachment's text and name (D77). An erased
   * entry, which has no key any more, loses them. Run at start; returns how many entries it changed.
   */
  public async sealPlainAttachments(): Promise<number> {
    let changed = 0
    for (;;) {
      const rows = await this.store.entries.listWithPlainAttachments(200)
      if (!rows.length) return changed
      for (const row of rows) {
        if (row.state === 'crypto-erased' || !row.encKeyRef) {
          await this.store.entries.update(row.id, { attachments: row.attachments.map(skeleton) })
        } else await this.rewrite(this.open(row))
        changed++
      }
    }
  }

  /** Legal hold set or released (PRIV-ERASE-004, PRIV-ERASE-008): an erased entry stays erased. */
  public async setLegalHold(entryIds: string[], hold: boolean): Promise<{ changed: string[]; skipped: string[] }> {
    const changed: string[] = []
    const skipped: string[] = []
    for (const id of entryIds) {
      const stored = await this.store.entries.get(id)
      const allowed = hold
        ? stored && (stored.state === 'active' || stored.state === 'archived')
        : stored?.state === 'legal-hold'
      if (!stored || !allowed) {
        skipped.push(id)
        continue
      }
      await this.store.entries.setState([id], hold ? 'legal-hold' : 'active')
      changed.push(id)
    }
    return { changed, skipped }
  }

  public async setState(entryIds: string[], state: LifecycleState): Promise<void> {
    await this.store.entries.setState(entryIds, state)
  }

  /**
   * The entries of a space older than its retention are archived, never deleted (PRIV-RETN-002, PRIV-RETN-008): one
   * space, or every Personal space; an entry on legal hold is not active and stays as it is. Returns how many.
   */
  public async archiveSpaceOlderThan(
    days: number,
    filter: { spaceId: string } | { personal: true },
    now = Date.now(),
    batch = 1000
  ): Promise<number> {
    const cutoff = new Date(now - days * 86_400_000).toISOString()
    let archived = 0
    for (let round = 0; round < 100; round++) {
      const rows = await this.store.entries.listOlderThan(cutoff, 'active', batch, filter)
      if (!rows.length) break
      await this.store.entries.setState(
        rows.map((r) => r.id),
        'archived'
      )
      archived += rows.length
      if (rows.length < batch) break
    }
    return archived
  }
}
