/**
 * Relying party: Principals from verified facts (D30..D34, IDENT-PRIN, IDENT-RES, IDENT-ROLE) and
 * the credential-liveness cache (D7, IDENT-LIVE). With a user directory (D79, D87), a Principal whose identity
 * credential this agent issued from an entry holds that entry, and the entry's roles, typed by hand, join those of
 * its verified facts (IDENT-ROLE-002, IDENT-ROLE-012); no rule over claims reads such a Principal (IDENT-ROLE-014).
 */
import type { AgentPack } from '../config/packTypes.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { type EvidenceInput, storedIdentityAttributes } from './evidence.js'
import { type HomeKeySource, matchOrganization, type OrganizationFacts } from './organization.js'
import type { BackingIdentity, ConnectionType, LivenessVerdict, Principal, Relation } from './types.js'

export interface VerifiedFacts {
  connectionType: ConnectionType
  actorIdentity: string
  backingIdentity: BackingIdentity | null
  /** the verified organization behind the actor: of the issuer of a person's identity credential, or a service's own (D64) */
  organization?: OrganizationFacts | null
  /** the actor identity this Principal had before the organization key (issuer attribute or subject alone): re-keyed when met again */
  legacyActorIdentity?: string
  /** the verification the facts come from, when it is a presented credential: recorded as evidence (D67) */
  evidence?: EvidenceInput
  /** verified claims: badge facts (userName, photo, title, department...) or ECS-Service attributes */
  claims: Record<string, unknown>
  userAgentVerified: boolean
  identityCredentialRef: string | null
}

export interface LivenessChecker {
  /** re-verify revocation status plus the issuer trust chain (IDENT-LIVE-002) */
  verify(principal: Principal, credentialRef: string): Promise<LivenessVerdict>
}

/** What the agent-pack makes of the organization behind an actor: its relation and the roles its pattern adds. */
export interface Recognition {
  relation: Relation
  roles: string[]
}

/**
 * The relation of an organization to this agent (D64). `home` is the agent's own organization and no
 * other, before any pattern is looked at (IDENT-ROLE-011); every other organization is recognized by the
 * first pattern that matches its verified attributes (IDENT-ROLE-008); no match is `unrecognized`.
 */
export function recognize(
  pack: AgentPack,
  organization: (Pick<OrganizationFacts, 'key'> & Partial<OrganizationFacts>) | null | undefined,
  homeKey: string | undefined
): Recognition {
  if (!organization) return { relation: 'unrecognized', roles: [] }
  if (homeKey && organization.key === homeKey) return { relation: 'home', roles: [] }
  const pattern = matchOrganization(pack.identity.organizations ?? [], organization.attributes ?? {})
  return pattern
    ? { relation: pattern.relation, roles: [...(pattern.roles ?? [])] }
    : { relation: 'unrecognized', roles: [] }
}

function claimMatches(expected: string | string[], actual: unknown): boolean {
  const values = Array.isArray(expected) ? expected : [expected]
  if (Array.isArray(actual)) return actual.some((a) => values.includes(String(a)))
  return actual !== undefined && values.includes(String(actual))
}

/**
 * Rules over verified facts, first match wins; overrides first; the roles of the organization's pattern
 * are added to those of the rule (D34, D64; IDENT-ROLE-001..006, IDENT-ROLE-010). A rule that names claims does not
 * match a Principal whose identity credential this agent issued from a directory entry: those claims are the entry's
 * fields, and the entry gives its roles by hand (IDENT-ROLE-014, D87).
 */
export function assignRoles(
  pack: AgentPack,
  facts: VerifiedFacts,
  recognition: Recognition,
  options: { issuedFromDirectory?: boolean } = {}
): string[] {
  const override = pack.identity.perActorOverrides?.find((o) => o.actor === facts.actorIdentity)
  if (override) return [...override.roles]
  let ruleRoles: string[] = []
  for (const rule of pack.identity.roleRules) {
    const w = rule.when
    if (w.claims && options.issuedFromDirectory) continue
    if (w.relation && w.relation !== recognition.relation) continue
    if (w.connectionType && w.connectionType !== facts.connectionType) continue
    if (w.userAgentVerified !== undefined && w.userAgentVerified !== facts.userAgentVerified) continue
    if (w.claims && !Object.entries(w.claims).every(([k, v]) => claimMatches(v, facts.claims[k]))) continue
    ruleRoles = [...rule.roles]
    break
  }
  return [...new Set([...recognition.roles, ...ruleRoles])]
}

/** The roles of a Principal: those of its verified facts and those of its directory entry (IDENT-ROLE-002). */
export const unionRoles = (facts: string[], entry: string[] = []): string[] => [...new Set([...facts, ...entry])]

/**
 * How the user directory reaches the Principals (IDENT-ROLE-012): the entry this agent issued a presented identity
 * credential from, and the roles an entry gives as the directory is loaded.
 */
export interface DirectoryLink {
  /** the entry this agent issued the identity credential of these facts from (IDENT-DIR-006), if any */
  entryOf(facts: VerifiedFacts): Promise<string | undefined>
  /** the roles of an entry, undefined when the directory does not hold it */
  rolesOf(entryId: string): string[] | undefined
}

export class PrincipalService {
  private readonly ttlSeconds: number
  /** the user directory, when the agent-pack names one (D79); set once the directory is loaded */
  public directory?: DirectoryLink

  public constructor(
    private readonly store: Store,
    private readonly pack: AgentPack,
    private readonly liveness: LivenessChecker,
    private readonly logger: Logger,
    ttlSeconds?: number,
    /** the agent's own organization; without it nobody is home (IDENT-ROLE-011) */
    private readonly home?: HomeKeySource
  ) {
    this.ttlSeconds = ttlSeconds ?? pack.sessions?.credentialCheckTtlSeconds ?? 300
  }

  /** Resolves (or refreshes) the Principal behind verified facts (IDENT-PRIN-001/005). */
  public async resolve(facts: VerifiedFacts): Promise<Principal> {
    const organization =
      facts.organization ?? (facts.backingIdentity ? { key: facts.backingIdentity.id, attributes: {} } : null)
    const recognition = recognize(this.pack, organization, organization ? await this.home?.key() : undefined)
    const relation = recognition.relation
    // unrecognized backing identity: authenticated, no backing identity, public only (IDENT-ROLE-005)
    const backing = relation === 'unrecognized' ? null : facts.backingIdentity
    let existing = await this.store.principals.findByActor(facts.actorIdentity)
    if (!existing && facts.legacyActorIdentity && facts.legacyActorIdentity !== facts.actorIdentity) {
      // a Principal keyed before the organization key keeps its conversations and data under the new key (D59)
      existing = await this.store.principals.findByActor(facts.legacyActorIdentity)
      if (existing)
        this.logger.info({ principalId: existing.id }, 'principal re-keyed on the organization of its issuer')
    }
    const { id: _id, ...attributes } = facts.claims as Record<string, unknown>
    // of a presented credential a Principal keeps what the pack stores and nothing else (PRIV-EVID-004/009);
    // the attributes of a service come from its public credentials and are kept as they are
    const identityAttributes = facts.evidence
      ? storedIdentityAttributes(this.pack, { ...facts.evidence.values, issuerDid: facts.evidence.issuerDid })
      : { ...(existing?.identityAttributes ?? {}), ...attributes }
    const now = nowIso()
    // the entry this agent issued the presented credential from: its roles join those of the facts (IDENT-ROLE-012)
    const issuedFrom = facts.evidence ? await this.directory?.entryOf(facts) : undefined
    const factRoles = assignRoles(this.pack, facts, recognition, { issuedFromDirectory: issuedFrom !== undefined })
    const entryRoles = issuedFrom ? this.directory?.rolesOf(issuedFrom) : undefined
    const principal: Principal = {
      id: existing?.id ?? prefixedId('prn'),
      connectionType: facts.connectionType,
      actorIdentity: facts.actorIdentity,
      backingIdentity: backing,
      backingRelation: relation,
      roles: unionRoles(factRoles, entryRoles),
      factRoles,
      // held while the directory holds the entry; a Principal with no entry receives no role from it
      ...(issuedFrom && entryRoles ? { directoryEntryId: issuedFrom } : {}),
      identityAttributes,
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
      {
        principalId: principal.id,
        relation,
        roles: principal.roles,
        connectionType: facts.connectionType,
        ...(principal.directoryEntryId ? { directoryEntryId: principal.directoryEntryId } : {}),
      },
      'principal resolved'
    )
    return principal
  }

  /**
   * A Principal holds a directory entry: it was issued its identity credential from it and holds that credential
   * (IDENT-DIR-006). Its roles are those of its facts and of the entry (IDENT-ROLE-002).
   */
  public async holdEntry(principal: Principal, entryId: string, entryRoles: string[]): Promise<Principal> {
    principal.factRoles ??= [...principal.roles]
    principal.directoryEntryId = entryId
    principal.roles = unionRoles(principal.factRoles, entryRoles)
    await this.save(principal)
    return principal
  }

  /**
   * The roles of a Principal that holds an entry, after a reload of the directory changed them: they hold from its next
   * turn, which reads the Principal again (IDENT-ROLE-013). Returns whether they changed.
   */
  public async applyEntryRoles(principal: Principal, entryRoles: string[]): Promise<boolean> {
    const next = unionRoles(principal.factRoles ?? principal.roles, entryRoles)
    if ([...next].sort().join('\n') === [...principal.roles].sort().join('\n')) return false
    principal.roles = next
    await this.save(principal)
    return true
  }

  /**
   * A Principal of an agent whose pack names no user directory any more holds no entry: the roles its entry gave are
   * gone, and nothing else changes (IDENT-ROLE-012: a Principal with no entry receives no role from the directory).
   */
  public async forgetEntry(principal: Principal): Promise<Principal> {
    principal.roles = [...(principal.factRoles ?? principal.roles)]
    principal.directoryEntryId = undefined
    await this.save(principal)
    return principal
  }

  /**
   * A Principal whose entry left the directory loses it and the roles it gave (IDENT-ROLE-013), and its identity
   * credential, revoked, is invalid from now on: the cached verdict says so, whatever the liveness interval.
   */
  public async releaseEntry(principal: Principal): Promise<Principal> {
    principal.roles = [...(principal.factRoles ?? [])]
    principal.directoryEntryId = undefined
    if (principal.identityCredentialRef)
      principal.livenessCache[principal.identityCredentialRef] = { ok: false, checkedAt: nowIso(), reason: 'revoked' }
    await this.save(principal)
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
