/**
 * The organizations of the trust graph (decision 62; ayni-spec D90, SPACE-INV-001, PROF-DIR-002): the Verana Graph search
 * (`POST {VERANA_GRAPH_URL}/v4/graph/search`, verana-spec v4/verana-graph TG-FCT-1..9), as the UIs use it for their
 * directory. An organization is the operator of the trusted DIDs it runs: the `Did` surface, its operator of kind
 * `Organization`, read through the `operator` snippet group (the verified OrganizationCredential: name, country code,
 * register id). Its key is the agent's own (IDENT-RES-009): `org:<country>:<register id>`. One organization runs several
 * DIDs, and so comes back as several hits: the first, the best scored, names it.
 *
 * The graph's default gates apply (TG-FCT-2): trusted DIDs only, none past their trust. An organization that is not
 * found there is not on Verana, and cannot be invited.
 */
import type { Logger } from '../util/logger.js'
import { fold } from './directory.js'
import { organizationKey } from './organization.js'

/** One organization of the trust graph, as the search of PROF-DIR-002 answers it. */
export interface GraphOrganization {
  organizationKey: string
  name: string
  country: string
}

interface SearchHit {
  snippet?: {
    trusted?: boolean
    isTrustExpired?: boolean
    operator?: { kind?: string; name?: string; countryCode?: string; registryId?: string } | null
  }
}

/** How many hits a search reads: an organization comes back once per DID it runs. */
const HITS = 50

export class TrustGraph {
  public constructor(
    /** the Verana Graph; none: no organization is found */
    private readonly baseUrl: string | undefined,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 8000
  ) {}

  public get configured(): boolean {
    return !!this.baseUrl
  }

  /** The organizations whose name contains `q`, folded for case and marks, at most `limit`, the best scored first. */
  public async search(q: string, limit = 20): Promise<GraphOrganization[]> {
    const needle = fold(q.trim())
    if (needle.length < 2 || !this.baseUrl) return []
    const found = await this.query({ 'Did.operatorKind': 'Organization' }, q.trim())
    return found.filter((o) => fold(o.name).includes(needle)).slice(0, limit)
  }

  /** The organization of a key, when the trust graph holds it trusted; undefined otherwise. Throws when it cannot be asked. */
  public async find(key: string): Promise<GraphOrganization | undefined> {
    const match = /^org:([A-Z]{2}):(.+)$/.exec(key)
    if (!match || !this.baseUrl) return undefined
    const found = await this.query({
      'Did.operatorKind': 'Organization',
      'OrganizationCredential.countryCode': match[1],
      'OrganizationCredential.registryId': match[2],
    })
    return found.find((o) => o.organizationKey === key)
  }

  private async query(filters: Record<string, string>, freeText?: string): Promise<GraphOrganization[]> {
    const url = `${(this.baseUrl ?? '').replace(/\/+$/, '')}/v4/graph/search`
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        surface: 'Did',
        filters,
        ...(freeText ? { freeText } : {}),
        snippet: { operator: true },
        limit: HITS,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`the trust graph answered ${response.status}`)
    const body = (await response.json()) as { hits?: SearchHit[] }
    const out: GraphOrganization[] = []
    const seen = new Set<string>()
    for (const hit of body.hits ?? []) {
      const operator = hit.snippet?.operator
      if (operator?.kind !== 'Organization') continue
      if (hit.snippet?.trusted === false || hit.snippet?.isTrustExpired === true) continue
      const key = organizationKey({ countryCode: operator.countryCode, registryId: operator.registryId })
      const name = (operator.name ?? '').trim()
      if (!key || !name || seen.has(key)) continue
      seen.add(key)
      out.push({ organizationKey: key, name, country: (operator.countryCode ?? '').toUpperCase() })
    }
    this.logger.debug({ filters: Object.keys(filters), found: out.length }, 'trust graph searched')
    return out
  }
}
