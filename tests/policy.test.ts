import { describe, expect, it } from 'vitest'
import type { AgentPack } from '../src/config/packTypes.js'
import { assignRoles, relationOf } from '../src/core/principals.js'
import { buildScope, matchesScope, scopeToSql } from '../src/memory/scope.js'
import { resolveTier } from '../src/policy/rbac.js'

const pack = {
  identity: {
    homeBackingIdentity: 'did:webvh:x:home',
    recognizedBackingIdentities: [
      { identity: 'did:webvh:x:home', relation: 'home' },
      { identity: 'did:webvh:x:partner', relation: 'partner' },
    ],
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

const facts = (over: Record<string, unknown>) => ({
  connectionType: 'verifiable-user-agent' as const,
  actorIdentity: 'did:example:alice',
  backingIdentity: { kind: 'org' as const, id: 'did:webvh:x:home' },
  claims: {},
  userAgentVerified: true,
  identityCredentialRef: 'badge:1',
  ...over,
})

describe('role assignment (D34, IDENT-ROLE-001..006)', () => {
  it('maps verified facts through rules, first match wins', () => {
    expect(assignRoles(pack, facts({ claims: { department: 'Treasury' } }))).toEqual(['employee', 'finance'])
    expect(assignRoles(pack, facts({ claims: { department: 'Sales' } }))).toEqual(['employee'])
  })
  it('gives partners the baseline and unrecognized identities nothing', () => {
    expect(assignRoles(pack, facts({ backingIdentity: { kind: 'org', id: 'did:webvh:x:partner' } }))).toEqual([
      'partner',
    ])
    expect(assignRoles(pack, facts({ backingIdentity: { kind: 'org', id: 'did:webvh:x:stranger' } }))).toEqual([])
    expect(relationOf(pack, { kind: 'org', id: 'did:webvh:x:stranger' })).toBe('unrecognized')
  })
  it('never trusts a self-asserted role; overrides apply by actor', () => {
    expect(assignRoles(pack, facts({ claims: { role: 'admin', department: 'Sales' } }))).toEqual(['employee'])
    expect(assignRoles(pack, facts({ actorIdentity: 'did:example:auditor' }))).toEqual(['auditor'])
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

describe('scope predicate (D12, PRIV-SCOPE, PRIV-CLS-005)', () => {
  const ctx = {
    principalId: 'p1',
    sessionIds: ['s1', 's0'],
    backingIdentity: { kind: 'org' as const, id: 'did:webvh:x:home' },
    homeBackingIdentity: 'did:webvh:x:home',
    recognizedPartners: ['did:webvh:x:partner'],
    crossSession: 'own-sessions' as const,
  }
  it('authorizes by construction: state active, visibility terms keyed on session, principal, backing identity', () => {
    const scope = buildScope(ctx)
    const row = (over: Record<string, unknown>) => ({
      visibility: 'public' as const,
      state: 'active',
      sessionId: 's1',
      principalId: 'p1',
      backingIdentity: ctx.backingIdentity,
      ...over,
    })
    expect(matchesScope(scope, row({}))).toBe(true)
    expect(matchesScope(scope, row({ state: 'archived' }))).toBe(false)
    expect(matchesScope(scope, row({ visibility: 'session-private', sessionId: 's2' }))).toBe(false)
    expect(matchesScope(scope, row({ visibility: 'session-private', sessionId: 's0' }))).toBe(true)
    expect(matchesScope(scope, row({ visibility: 'principal-private', principalId: 'p2' }))).toBe(false)
    expect(matchesScope(scope, row({ visibility: 'organization-shared', principalId: 'p9', sessionId: 's9' }))).toBe(
      true
    )
    expect(
      matchesScope(
        scope,
        row({ visibility: 'partner-shared', backingIdentity: { kind: 'org', id: 'did:webvh:x:partner' } })
      )
    ).toBe(false)
  })
  it('a partner sees partner-shared of its own backing identity only; an unrecognized identity sees public only', () => {
    const partner = buildScope({ ...ctx, backingIdentity: { kind: 'org', id: 'did:webvh:x:partner' } })
    expect(
      partner.terms.some((t) => t.visibility === 'partner-shared' && t.backingIdentityId === 'did:webvh:x:partner')
    ).toBe(true)
    expect(partner.terms.some((t) => t.visibility === 'organization-shared')).toBe(false)
    const stranger = buildScope({ ...ctx, backingIdentity: null })
    expect(stranger.terms.map((t) => t.visibility)).toEqual(['public', 'session-private', 'principal-private'])
  })
  it('compiles to SQL over indexed columns with parameters', () => {
    const { sql, params } = scopeToSql(buildScope(ctx), 'e', 1)
    expect(sql).toMatch(/e\.state = \$\d+ AND/)
    expect(sql).toContain('e.visibility = $')
    expect(params).toContain('active')
    expect(params).toContain('did:webvh:x:home')
    expect(scopeToSql({ state: 'active', terms: [] }, 'e', 1).sql).toBe('false')
  })
})
