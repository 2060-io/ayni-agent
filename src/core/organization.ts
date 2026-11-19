/**
 * Organizations behind actors (D64): the organization key, the patterns that recognize an organization,
 * and the agent's own organization, which alone is `home` (IDENT-RES-009, IDENT-ROLE-008, IDENT-ROLE-011).
 */
import type { OrganizationPattern } from '../config/packTypes.js'
import type { Logger } from '../util/logger.js'

/** What trust resolution verified about the organization behind a DID. */
export interface OrganizationFacts {
  /** the organization key: the same for every DID of one organization */
  key: string
  name?: string
  /** the attributes of the verified ECS Organization credential a pattern may match */
  attributes: Record<string, string>
}

/** The attributes of the ECS Organization credential (Verifiable Trust v4) a pattern may match. */
export const PATTERN_ATTRIBUTES = ['countryCode', 'registryId', 'legalJurisdiction', 'organizationKind', 'lei'] as const
export type PatternAttribute = (typeof PATTERN_ATTRIBUTES)[number]

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

/**
 * The one place that computes an organization key (IDENT-RES-009). Verifiable Trust v4: the country of
 * registration and the identifier in its register. The v5 Organization schema brings its own key; the
 * migration changes this function and the attributes above, nothing else.
 */
export function organizationKey(subject: Record<string, unknown>): string | undefined {
  const country = text(subject.countryCode).trim().toUpperCase()
  const registry = text(subject.registryId).trim()
  if (!country || !registry) return undefined
  return `org:${country}:${registry}`
}

/** The organization a verified ECS Organization credential subject describes, when it carries a key. */
export function organizationFrom(subject: Record<string, unknown>): OrganizationFacts | null {
  const key = organizationKey(subject)
  if (!key) return null
  const attributes: Record<string, string> = {}
  for (const name of PATTERN_ATTRIBUTES) {
    const value = text(subject[name]).trim()
    if (value) attributes[name] = name === 'countryCode' ? value.toUpperCase() : value
  }
  const name = text(subject.name).trim()
  return { key, name: name || undefined, attributes }
}

/** The first pattern every one of whose attributes the organization carries (a list matches any of its values). */
export function matchOrganization(
  patterns: OrganizationPattern[],
  attributes: Record<string, string>
): OrganizationPattern | undefined {
  return patterns.find((pattern) => {
    const entries = Object.entries(pattern.match)
    if (!entries.length) return false
    return entries.every(([name, expected]) => {
      const actual = attributes[name]
      if (actual === undefined) return false
      const values = (Array.isArray(expected) ? expected : [expected]).map((v) =>
        name === 'countryCode' ? String(v).trim().toUpperCase() : String(v).trim()
      )
      return values.includes(actual)
    })
  })
}

/** Where the key of the agent's own organization comes from (IDENT-ROLE-011). */
export interface HomeKeySource {
  key(): Promise<string | undefined>
}

/**
 * The agent's own organization, from its own ECS Organization credential. The key is looked up again
 * after a while, and soon after a failure: an agent that is not onboarded yet has no key, and then
 * nobody is `home`.
 */
export class HomeOrganization implements HomeKeySource {
  private known?: { key: string; name?: string; at: number }
  private failedAt = 0

  public constructor(
    private readonly lookup: () => Promise<OrganizationFacts | null>,
    private readonly logger: Logger,
    private readonly ttlMs = 10 * 60_000,
    private readonly retryMs = 60_000
  ) {}

  public async key(): Promise<string | undefined> {
    const now = Date.now()
    if (this.known && now - this.known.at < this.ttlMs) return this.known.key
    if (!this.known && now - this.failedAt < this.retryMs) return undefined
    try {
      const organization = await this.lookup()
      if (organization) {
        if (this.known?.key !== organization.key)
          this.logger.info({ organization: organization.key }, 'own organization established: its people are home')
        this.known = { key: organization.key, name: organization.name, at: now }
        return organization.key
      }
      this.logger.warn('the agent has no verified Organization credential yet: no peer is home (IDENT-ROLE-011)')
    } catch (error) {
      this.logger.warn({ err: error }, 'own organization could not be resolved: no peer is home until it can')
    }
    // a key established earlier stays in use while the lookup fails
    if (this.known) return this.known.key
    this.failedAt = now
    return undefined
  }

  /** The name of the agent's own organization, as its Organization credential gives it; none while it is not established. */
  public async name(): Promise<string | undefined> {
    await this.key()
    return this.known?.name
  }
}
