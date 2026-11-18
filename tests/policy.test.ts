import { describe, expect, it } from 'vitest'
import type { AgentPack } from '../src/config/packTypes.js'
import { assignRoles, recognize, type VerifiedFacts } from '../src/core/principals.js'
import { buildScope, matchesScope, STORE_SHAPES, scopeToSql, storeShapeFaults } from '../src/memory/scope.js'
import { resolveTier } from '../src/policy/rbac.js'

const pack = {
  identity: {
    homeBackingIdentity: 'did:webvh:x:agent',
    organizations: [{ match: { countryCode: 'CO', registryId: 'partner' }, relation: 'partner' }],
    roles: { employee: {}, finance: {}, partner: {}, auditor: { auditor: true } },
    roleRules: [
      { when: { relation: 'home', claims: { department: ['Finance', 'Treasury'] } }, roles: ['employee', 'finance'] },
      { when: { relation: 'home' }, roles: ['employee'] },
      { when: { relation: 'partner', claims: { tier: 'gold' } }, roles: ['partner'] },
      { when: { relation: 'partner' }, roles: ['partner'] },
    ],
    perActorOverrides: [{ actor: 'did:example:auditor', roles: ['auditor'] }],
  },
} as unknown as AgentPack

const HOME = 'org:EE:home'
const PARTNER = 'org:CO:partner'
const organizationOf = (key: string) => {
  const [, countryCode, registryId] = key.split(':')
  return { key, attributes: { countryCode, registryId } }
}
/** Roles of the facts, their organization recognized as the agent whose own organization is HOME does. */
const rolesOf = (f: VerifiedFacts) =>
  assignRoles(pack, f, recognize(pack, f.backingIdentity ? organizationOf(f.backingIdentity.id) : null, HOME))

const facts = (over: Record<string, unknown>): VerifiedFacts => ({
  connectionType: 'verifiable-user-agent' as const,
  actorIdentity: 'did:example:alice',
  backingIdentity: { kind: 'org' as const, id: HOME },
  claims: {},
  userAgentVerified: true,
  identityCredentialRef: 'badge:1',
  ...over,
})

describe('role assignment (D34, IDENT-ROLE-001..006)', () => {
  it('maps verified facts through rules, first match wins', () => {
    expect(rolesOf(facts({ claims: { department: 'Treasury' } }))).toEqual(['employee', 'finance'])
    expect(rolesOf(facts({ claims: { department: 'Sales' } }))).toEqual(['employee'])
  })
  it('gives partners the baseline and unrecognized identities nothing', () => {
    expect(rolesOf(facts({ backingIdentity: { kind: 'org', id: PARTNER } }))).toEqual(['partner'])
    expect(rolesOf(facts({ backingIdentity: { kind: 'org', id: 'org:US:stranger' } }))).toEqual([])
    expect(recognize(pack, organizationOf('org:US:stranger'), HOME).relation).toBe('unrecognized')
  })
  it('never trusts a self-asserted role; overrides apply by actor', () => {
    expect(rolesOf(facts({ claims: { role: 'admin', department: 'Sales' } }))).toEqual(['employee'])
    expect(rolesOf(facts({ actorIdentity: 'did:example:auditor' }))).toEqual(['auditor'])
  })
})

describe('tool tiers (RBAC-TOOL-001..006)', () => {
  const access = {
    default: 'none' as const,
    roles: { employee: ['track'], finance: ['track', 'refund'], operator: ['*'] },
    approval: [{ tools: ['refund'], approvers: ['manager'] }],
    elevation: [{ tools: ['read_record'], purposes: ['audit'], approvers: ['security'] }],
  }
  it('resolves exactly one tier per (role set, tool)', () => {
    expect(resolveTier(access, ['employee'], 'track', false).tier).toBe('ALLOW')
    expect(resolveTier(access, ['finance'], 'refund', false).tier).toBe('APPROVAL')
    expect(resolveTier(access, ['employee'], 'read_record', false).tier).toBe('REQUESTABLE')
    expect(resolveTier(access, ['employee'], 'read_record', true).tier).toBe('ALLOW')
    expect(resolveTier(access, ['employee'], 'refund', false).tier).toBe('DENY')
    expect(resolveTier(access, ['employee'], 'unknown', false).tier).toBe('DENY')
    expect(resolveTier(access, ['operator'], 'anything', false).tier).toBe('ALLOW')
    expect(resolveTier(undefined, ['employee'], 'track', false).tier).toBe('DENY')
  })
})

describe('scope predicate (D12, D76, PRIV-SCOPE, PRIV-CLS-005)', () => {
  const ctx = {
    principalId: 'p1',
    conversationId: 'c1',
    backingIdentity: { kind: 'org' as const, id: HOME },
    relation: 'home' as const,
    crossSession: 'own-sessions' as const,
  }
  it('authorizes by construction: state active, visibility terms keyed on conversation, principal, backing identity', () => {
    const scope = buildScope(ctx)
    const row = (over: Record<string, unknown>) => ({
      visibility: 'public' as const,
      state: 'active',
      conversationId: 'c1',
      principalId: 'p1',
      backingIdentityId: HOME,
      ...over,
    })
    expect(matchesScope(scope, row({}))).toBe(true)
    expect(matchesScope(scope, row({ state: 'archived' }))).toBe(false)
    expect(matchesScope(scope, row({ visibility: 'conversation-private', conversationId: 'c2' }))).toBe(false)
    expect(matchesScope(scope, row({ visibility: 'conversation-private', conversationId: 'c1' }))).toBe(true)
    expect(matchesScope(scope, row({ visibility: 'principal-private', principalId: 'p2' }))).toBe(false)
    // organization-shared: what the home organization holds, visible to its Principals (PRIV-CLS-005)
    expect(
      matchesScope(scope, row({ visibility: 'organization-shared', principalId: 'p9', conversationId: 'c9' }))
    ).toBe(true)
    expect(matchesScope(scope, row({ visibility: 'partner-shared', backingIdentityId: PARTNER }))).toBe(false)
  })
  it('a partner sees partner-shared of its own backing identity only; an unrecognized identity sees public only', () => {
    const partner = buildScope({ ...ctx, backingIdentity: { kind: 'org', id: PARTNER }, relation: 'partner' })
    expect(partner.terms.some((t) => t.visibility === 'partner-shared' && t.backingIdentityId === PARTNER)).toBe(true)
    expect(partner.terms.some((t) => t.visibility === 'organization-shared')).toBe(false)
    const stranger = buildScope({ ...ctx, backingIdentity: null, relation: 'unrecognized' })
    expect(stranger.terms.map((t) => t.visibility)).toEqual(['public', 'conversation-private', 'principal-private'])
  })
  it('compiles to SQL over the indexed columns of a store, with parameters', () => {
    const { sql, params } = scopeToSql(buildScope(ctx), STORE_SHAPES.entries, 'e', 1)
    expect(sql).toMatch(/e\.state = \$\d+ AND/)
    expect(sql).toContain('e.visibility = $')
    expect(sql).toContain('e.conversation_id = $')
    expect(params).toContain('active')
    expect(params).toContain('c1')
    expect(scopeToSql({ state: 'active', terms: [] }, STORE_SHAPES.entries, 'e', 1).sql).toBe('false')
  })
  it('compiles for each store only what it holds, and never names a column the store lacks (PRIV-SCOPE-003)', () => {
    const scope = buildScope({ ...ctx, backingIdentity: { kind: 'org', id: PARTNER }, relation: 'partner' })
    const docs = scopeToSql(scope, STORE_SHAPES.documents, 'c', 1).sql
    expect(docs).not.toContain('conversation_id')
    expect(docs).not.toContain('principal_id')
    expect(docs).toContain('c.backing_identity_id = $')
    const notes = scopeToSql(scope, STORE_SHAPES.notes, 'n', 1).sql
    expect(notes).toContain('n.principal_id = $')
    expect(notes).not.toContain('conversation_id')
    expect(storeShapeFaults()).toEqual([])
  })
  it('refuses a store that holds a visibility without the column its terms compare (PRIV-SCOPE-003)', () => {
    const faults = storeShapeFaults([
      {
        name: 'broken',
        holds: ['conversation-private'],
        visibilityColumn: 'visibility',
        stateColumn: 'state',
        columns: {},
      },
    ])
    expect(faults.length).toBe(2)
    expect(faults[0]).toContain('store broken holds conversation-private but has no column for conversationId')
  })
})
