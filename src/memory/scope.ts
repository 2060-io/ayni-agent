/**
 * The one centralized scope query-builder (D12, D15, D76, PRIV-SCOPE-001..005). Every retrieval, memory, working
 * memory, preferences and RAG alike, is filtered by the predicate built here; each store declares the visibilities it
 * holds and the columns it filters on, and the predicate is compiled for that store (PRIV-SCOPE-003).
 */
import type { BackingIdentity, Relation, Visibility } from '../core/types.js'

/**
 * What a retrieval reads. No role widens it (RBAC-XSESS-001/007): a conversation is read only through the conversation itself;
 * the role-wide reads of every conversation of a backing identity (`own-backing-identity`) or of everyone (`all`) are
 * gone, and a pack that names them is refused. A space's members read a conversation its author shares with the space
 * through the space (src/core/spaces.ts), never through the model's retrieval; an auditor reads through the admin
 * interface (RBAC-XSESS-006).
 */
export interface ScopeContext {
  principalId: string
  /** the conversation of the session (D76): its `conversation-private` entries are readable */
  conversationId: string
  backingIdentity: BackingIdentity | null
  /** the relation of the backing identity to this agent: `home` is the agent's own organization only (D64) */
  relation: Relation
  /**
   * the space of the conversation (MEM-SPACE-001): a `principal-private` item of a space (a memory, an entry) is read
   * only in that space's conversations, in the stores that declare their items scoped by space
   */
  spaceId?: string
}

/** The dimensions a term may compare, besides visibility and lifecycle state. */
export type ScopeDimension = 'conversationId' | 'principalId' | 'backingIdentityId'

/** One disjunct of the predicate: an item matches when every present field equals. */
export interface ScopeTerm {
  visibility: Visibility
  conversationId?: string
  principalId?: string
  backingIdentityId?: string
}

export interface ScopePredicate {
  state: 'active'
  terms: ScopeTerm[]
  /** the space a `principal-private` item must belong to, in a store scoped by space (MEM-SPACE-001) */
  spaceId?: string
}

export function buildScope(ctx: ScopeContext): ScopePredicate {
  const terms: ScopeTerm[] = [{ visibility: 'public' }]
  // conversation-private: this conversation, and no other, whatever the role (RBAC-XSESS-001)
  terms.push({ visibility: 'conversation-private', conversationId: ctx.conversationId })
  terms.push({ visibility: 'principal-private', principalId: ctx.principalId })
  if (ctx.backingIdentity) {
    // organization-shared: the Principals of the agent's own organization, which `home` already means (PRIV-CLS-005)
    if (ctx.relation === 'home') terms.push({ visibility: 'organization-shared' })
    // partner-shared: what carries the organization key of this Principal's partner organization
    if (ctx.relation === 'partner') {
      terms.push({ visibility: 'partner-shared', backingIdentityId: ctx.backingIdentity.id })
    }
  }
  return { state: 'active', terms, ...(ctx.spaceId ? { spaceId: ctx.spaceId } : {}) }
}

/** A provisional session has zero access (CHAN-BIND-004): no term matches anything. */
export const EMPTY_SCOPE: ScopePredicate = { state: 'active', terms: [] }

/**
 * What a store holds (PRIV-SCOPE-003): the visibilities its items may carry and, for each dimension a term of those
 * visibilities may compare, its column. A term of a visibility the store does not hold matches nothing there and is
 * left out; a term of a visibility it holds needs every column it compares.
 */
export interface StoreShape {
  name: string
  holds: readonly Visibility[]
  visibilityColumn: string
  stateColumn: string
  columns: Partial<Record<ScopeDimension, string>>
  /**
   * the column of the space its `principal-private` items belong to (MEM-SPACE-001): a store that declares it is read,
   * for those items, in the space of the predicate only; one that does not (preferences) is read in every space
   */
  spaceColumn?: string
}

/** The dimensions the terms of each visibility may compare, whatever the role (buildScope above). */
export const DIMENSIONS_OF: Record<Visibility, readonly ScopeDimension[]> = {
  public: [],
  'conversation-private': ['conversationId'],
  'principal-private': ['principalId'],
  'organization-shared': [],
  'partner-shared': ['backingIdentityId'],
}

/** Every store a retrieval reads, declared once (D76). */
export const STORE_SHAPES = {
  entries: {
    name: 'entries',
    holds: ['conversation-private', 'principal-private', 'organization-shared', 'partner-shared', 'public'],
    visibilityColumn: 'visibility',
    stateColumn: 'state',
    columns: {
      conversationId: 'conversation_id',
      principalId: 'principal_id',
      backingIdentityId: 'backing_identity_id',
    },
    spaceColumn: 'space_id',
  },
  // a memory is read in the conversations of its space only (MEM-SPACE-001)
  notes: {
    name: 'working_memory',
    holds: ['principal-private'],
    visibilityColumn: 'visibility',
    stateColumn: 'state',
    columns: { principalId: 'principal_id' },
    spaceColumn: 'space_id',
  },
  // a preference carries no space and is read in every one (MEM-SPACE-001)
  preferences: {
    name: 'preferences',
    holds: ['principal-private'],
    visibilityColumn: 'visibility',
    stateColumn: 'state',
    columns: { principalId: 'principal_id' },
  },
  documents: {
    name: 'rag_chunks',
    holds: ['organization-shared', 'partner-shared', 'public'],
    visibilityColumn: 'visibility',
    stateColumn: 'state',
    columns: { backingIdentityId: 'backing_identity_id' },
  },
} as const satisfies Record<string, StoreShape>

/**
 * The start check (PRIV-SCOPE-003): a store that holds a visibility without a column its terms compare is refused.
 * Returns the faults, empty when every store is sound.
 */
export function storeShapeFaults(shapes: readonly StoreShape[] = Object.values(STORE_SHAPES)): string[] {
  const faults: string[] = []
  for (const shape of shapes) {
    for (const visibility of shape.holds) {
      for (const dimension of DIMENSIONS_OF[visibility]) {
        if (!shape.columns[dimension]) {
          faults.push(`store ${shape.name} holds ${visibility} but has no column for ${dimension} (PRIV-SCOPE-003)`)
        }
      }
    }
  }
  return faults
}

/** The terms of a predicate that can match in a store: those of the visibilities it holds. */
export function termsFor(scope: ScopePredicate, shape: StoreShape): ScopeTerm[] {
  return scope.terms.filter((t) => shape.holds.includes(t.visibility))
}

export interface Scoped {
  visibility: Visibility
  state: string
  conversationId?: string | null
  principalId?: string | null
  backingIdentityId?: string | null
  /** the space of the item, in a store scoped by space */
  spaceId?: string | null
}

/** A term compares the space of the item: a `principal-private` term of a predicate with a space, in a store with one. */
function spaced(scope: ScopePredicate, shape: StoreShape, term: ScopeTerm): string | undefined {
  return term.visibility === 'principal-private' && shape.spaceColumn ? scope.spaceId : undefined
}

/** JS compilation of the predicate for a store, used by the in-memory store and by tests. */
export function matchesScope(scope: ScopePredicate, row: Scoped, shape: StoreShape = STORE_SHAPES.entries): boolean {
  if (row.state !== scope.state) return false
  return termsFor(scope, shape).some((t) => {
    const space = spaced(scope, shape, t)
    return (
      t.visibility === row.visibility &&
      (t.conversationId === undefined || t.conversationId === row.conversationId) &&
      (t.principalId === undefined || t.principalId === row.principalId) &&
      (t.backingIdentityId === undefined || t.backingIdentityId === row.backingIdentityId) &&
      (space === undefined || space === row.spaceId)
    )
  })
}

/**
 * SQL compilation for a store: a WHERE fragment and its parameters, naming only the store's own columns (indexed,
 * PRIV-SCOPE-005). A term that compares a dimension the store has no column for is a programming fault: it throws.
 */
export function scopeToSql(
  scope: ScopePredicate,
  shape: StoreShape,
  alias: string,
  startIndex: number
): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  let i = startIndex
  const next = (v: unknown) => {
    params.push(v)
    return `$${i++}`
  }
  const terms = termsFor(scope, shape)
  if (terms.length === 0) return { sql: 'false', params }
  const column = (dimension: ScopeDimension): string => {
    const name = shape.columns[dimension]
    if (!name) throw new Error(`store ${shape.name} has no column for ${dimension} (PRIV-SCOPE-003)`)
    return `${alias}.${name}`
  }
  const disjuncts = terms.map((t) => {
    const parts = [`${alias}.${shape.visibilityColumn} = ${next(t.visibility)}`]
    if (t.conversationId !== undefined) parts.push(`${column('conversationId')} = ${next(t.conversationId)}`)
    if (t.principalId !== undefined) parts.push(`${column('principalId')} = ${next(t.principalId)}`)
    if (t.backingIdentityId !== undefined) parts.push(`${column('backingIdentityId')} = ${next(t.backingIdentityId)}`)
    const space = spaced(scope, shape, t)
    if (space !== undefined) parts.push(`${alias}.${shape.spaceColumn} = ${next(space)}`)
    return `(${parts.join(' AND ')})`
  })
  return { sql: `${alias}.${shape.stateColumn} = ${next(scope.state)} AND (${disjuncts.join(' OR ')})`, params }
}
