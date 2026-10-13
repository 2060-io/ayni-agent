/**
 * Relying party: Principals from verified facts (D30..D34, IDENT-PRIN, IDENT-RES, IDENT-ROLE) and
 * the credential-liveness cache (D7, IDENT-LIVE).
 */
import type { AgentPack } from '../config/packTypes.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { BackingIdentity, ConnectionType, LivenessVerdict, Principal, Relation } from './types.js'

export interface VerifiedFacts {
  connectionType: ConnectionType
  actorIdentity: string
  backingIdentity: BackingIdentity | null
  /** verified claims: badge facts (userName, photo, title, department...) or ECS-Service attributes */
  claims: Record<string, unknown>
  userAgentVerified: boolean
  identityCredentialRef: string | null
}

export interface LivenessChecker {
  /** re-verify revocation status plus the issuer trust chain (IDENT-LIVE-002) */
  verify(principal: Principal, credentialRef: string): Promise<LivenessVerdict>
}

export function relationOf(pack: AgentPack, backing: BackingIdentity | null): Relation {
  if (!backing) return 'unrecognized'
  const entry = pack.identity.recognizedBackingIdentities.find((r) => r.identity === backing.id)
  return entry?.relation ?? 'unrecognized'
}

function claimMatches(expected: string | string[], actual: unknown): boolean {
  const values = Array.isArray(expected) ? expected : [expected]
  if (Array.isArray(actual)) return actual.some((a) => values.includes(String(a)))
  return actual !== undefined && values.includes(String(actual))
}

/** Rules over verified facts, first match wins; overrides first; no match = no roles (D34, IDENT-ROLE-001..006). */
export function assignRoles(pack: AgentPack, facts: VerifiedFacts): string[] {
  const override = pack.identity.perActorOverrides?.find((o) => o.actor === facts.actorIdentity)
  if (override) return [...override.roles]
  const relation = relationOf(pack, facts.backingIdentity)
  for (const rule of pack.identity.roleRules) {
    const w = rule.when
    if (w.relation && w.relation !== relation) continue
    if (w.connectionType && w.connectionType !== facts.connectionType) continue
    if (w.userAgentVerified !== undefined && w.userAgentVerified !== facts.userAgentVerified) continue
    if (w.claims && !Object.entries(w.claims).every(([k, v]) => claimMatches(v, facts.claims[k]))) continue
    return [...rule.roles]
  }
  return []
}

export class PrincipalService {
  private readonly ttlSeconds: number

  public constructor(
    private readonly store: Store,
    private readonly pack: AgentPack,
    private readonly liveness: LivenessChecker,
    private readonly logger: Logger,
    ttlSeconds?: number
  ) {
    this.ttlSeconds = ttlSeconds ?? pack.sessions?.credentialCheckTtlSeconds ?? 300
  }

  /** Resolves (or refreshes) the Principal behind verified facts (IDENT-PRIN-001/005). */
  public async resolve(facts: VerifiedFacts): Promise<Principal> {
    const relation = relationOf(this.pack, facts.backingIdentity)
    // unrecognized backing identity: authenticated, no backing identity, public only (IDENT-ROLE-005)
    const backing = relation === 'unrecognized' ? null : facts.backingIdentity
    const existing = await this.store.principals.findByActor(facts.actorIdentity)
    const { id: _id, ...attributes } = facts.claims as Record<string, unknown>
    const now = nowIso()
    const principal: Principal = {
      id: existing?.id ?? prefixedId('prn'),
      connectionType: facts.connectionType,
      actorIdentity: facts.actorIdentity,
      backingIdentity: backing,
      backingRelation: relation,
      roles: assignRoles(this.pack, facts),
      identityAttributes: { ...(existing?.identityAttributes ?? {}), ...attributes },
      capabilityChannelId: existing?.capabilityChannelId ?? null,
      identityCredentialRef: facts.identityCredentialRef ?? existing?.identityCredentialRef ?? null,
      livenessCache: existing?.livenessCache ?? {},
      userAgentVerified: facts.userAgentVerified,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (facts.identityCredentialRef) principal.livenessCache[facts.identityCredentialRef] = { ok: true, checkedAt: now }
    await this.store.principals.save(principal)
    this.logger.info(
      { principalId: principal.id, relation, roles: principal.roles, connectionType: facts.connectionType },
      'principal resolved'
    )
    return principal
  }

  public async get(id: string): Promise<Principal | undefined> {
    return this.store.principals.get(id)
  }

  public async save(principal: Principal): Promise<void> {
    principal.updatedAt = nowIso()
    await this.store.principals.save(principal)
  }

  /**
   * TTL-bounded re-verification (IDENT-LIVE-002/003/010/011/012): at most one check per TTL per
   * Principal unless an action declares a stricter maxCredentialAge (0 = always).
   */
  public async ensureLive(principal: Principal, maxAgeSeconds?: number): Promise<LivenessVerdict> {
    const ref = principal.identityCredentialRef
    if (!ref) return { ok: true, checkedAt: nowIso(), reason: 'no-identity-credential' }
    const maxAge = (maxAgeSeconds ?? this.ttlSeconds) * 1000
    const cached = principal.livenessCache[ref]
    if (cached && Date.now() - Date.parse(cached.checkedAt) <= maxAge) return cached
    let verdict: LivenessVerdict
    try {
      verdict = await this.liveness.verify(principal, ref)
    } catch (error) {
      // the check cannot be performed: gated actions fail closed, ungated conversation continues on the
      // cached verdict until it ages past N (D26, IDENT-LIVE-012)
      this.logger.warn({ err: error, principalId: principal.id }, 'liveness check unavailable')
      if (cached && Date.now() - Date.parse(cached.checkedAt) <= this.ttlSeconds * 1000 && maxAgeSeconds === undefined)
        return cached
      return { ok: false, checkedAt: nowIso(), reason: 'unavailable' }
    }
    principal.livenessCache[ref] = verdict
    await this.save(principal)
    return verdict
  }
}
