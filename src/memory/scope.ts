/**
 * The one centralized scope query-builder (D12, D15, PRIV-SCOPE-001..005). Every retrieval, memory
 * and RAG alike, is filtered by the predicate built here; stores only compile it.
 */
import type { BackingIdentity, Visibility } from '../core/types.js'

export type CrossSessionScope = 'own-sessions' | 'own-backing-identity' | 'all'

export interface ScopeContext {
  principalId: string
  sessionId: string
  backingIdentity: BackingIdentity | null
  homeBackingIdentity: string
  recognizedPartners: string[]
  crossSession: CrossSessionScope
}

/** One disjunct of the predicate: an entry matches when every present field equals. */
export interface ScopeTerm {
  visibility: Visibility
  sessionId?: string
  principalId?: string
  backingIdentityId?: string
}

export interface ScopePredicate {
  state: 'active'
  terms: ScopeTerm[]
}

export function buildScope(ctx: ScopeContext): ScopePredicate {
  const terms: ScopeTerm[] = [{ visibility: 'public' }]
  // session-private: this session; wider cross-session reads by role (RBAC-XSESS-001)
  if (ctx.crossSession === 'all') terms.push({ visibility: 'session-private' })
  else if (ctx.crossSession === 'own-backing-identity' && ctx.backingIdentity) {
    terms.push({ visibility: 'session-private', backingIdentityId: ctx.backingIdentity.id })
    terms.push({ visibility: 'session-private', sessionId: ctx.sessionId })
  } else terms.push({ visibility: 'session-private', sessionId: ctx.sessionId })
  terms.push({ visibility: 'principal-private', principalId: ctx.principalId })
  if (ctx.backingIdentity) {
    if (ctx.backingIdentity.id === ctx.homeBackingIdentity) {
      terms.push({ visibility: 'organization-shared', backingIdentityId: ctx.homeBackingIdentity })
    }
    if (ctx.recognizedPartners.includes(ctx.backingIdentity.id)) {
      terms.push({ visibility: 'partner-shared', backingIdentityId: ctx.backingIdentity.id })
    }
  }
  return { state: 'active', terms }
}

/** A provisional session has zero access (CHAN-BIND-004): no term matches anything. */
export const EMPTY_SCOPE: ScopePredicate = { state: 'active', terms: [] }

export interface Scoped {
  visibility: Visibility
  state: string
  sessionId?: string | null
  principalId?: string | null
  backingIdentity?: BackingIdentity | null
}

/** JS compilation of the predicate, used by the in-memory store and by tests. */
export function matchesScope(scope: ScopePredicate, row: Scoped): boolean {
  if (row.state !== scope.state) return false
  return scope.terms.some(
    (t) =>
      t.visibility === row.visibility &&
      (t.sessionId === undefined || t.sessionId === row.sessionId) &&
      (t.principalId === undefined || t.principalId === row.principalId) &&
      (t.backingIdentityId === undefined || t.backingIdentityId === row.backingIdentity?.id)
  )
}

/** SQL compilation: returns a WHERE fragment and its parameters (columns are indexed, PRIV-SCOPE-005). */
export function scopeToSql(
  scope: ScopePredicate,
  alias: string,
  startIndex: number
): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  let i = startIndex
  const next = (v: unknown) => {
    params.push(v)
    return `$${i++}`
  }
  if (scope.terms.length === 0) return { sql: 'false', params }
  const disjuncts = scope.terms.map((t) => {
    const parts = [`${alias}.visibility = ${next(t.visibility)}`]
    if (t.sessionId !== undefined) parts.push(`${alias}.session_id = ${next(t.sessionId)}`)
    if (t.principalId !== undefined) parts.push(`${alias}.principal_id = ${next(t.principalId)}`)
    if (t.backingIdentityId !== undefined) parts.push(`${alias}.backing_identity_id = ${next(t.backingIdentityId)}`)
    return `(${parts.join(' AND ')})`
  })
  return { sql: `${alias}.state = ${next(scope.state)} AND (${disjuncts.join(' OR ')})`, params }
}
