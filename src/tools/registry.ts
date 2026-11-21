/**
 * The tool registry: aggregates sources, resolves the tier of every (role set, tool) and builds the
 * per-principal tool list that reaches the model (RBAC-FILTER-001/002).
 */
import type { ElevationGrant, Principal } from '../core/types.js'
import type { ToolDefinition } from '../llm/types.js'
import { resolveTier, type TierResolution } from '../policy/rbac.js'
import type { Logger } from '../util/logger.js'
import type { HttpToolSource } from './http.js'
import type { CallAccountSecret, CheckRead, CheckResult, ToolSource, ToolSpec } from './types.js'

export interface VisibleTool {
  spec: ToolSpec
  resolution: TierResolution
}

/** Where a source is available, as far as the names of its tools go: two sources never in one turn share names freely. */
export type SourcePlace = 'agent' | 'personal' | 'spaces'

/** Whether the tools of two sources can be in one turn (D96): the whole agent's with any, Personal's or a space's alike. */
function together(a: SourcePlace, b: SourcePlace): boolean {
  return a === 'agent' || b === 'agent' || a === b
}

export class ToolRegistry {
  private readonly sources: ToolSource[] = []
  private lazyLoaded = new Set<string>()
  /** what the catalog says of each source before any discovery: where it is available, and the tools it offers */
  private catalog?: { place(source: string): SourcePlace; offers(): [string, string[]][] }

  public constructor(private readonly logger: Logger) {}

  /**
   * The catalog's answers, so that the name of a tool does not change once another server is discovered: a name two
   * sources offer is prefixed with the server's only where their tools can be in one turn (D96, D101).
   */
  public useCatalog(catalog: { place(source: string): SourcePlace; offers(): [string, string[]][] }): void {
    this.catalog = catalog
  }

  public add(source: ToolSource, eager = true): void {
    this.sources.push(source)
    if (!eager) this.lazyLoaded.add(source.id)
  }

  /** Every known tool; lazy MCP servers are discovered on the first call that needs the list (TOOL-MCP-003). */
  public async all(): Promise<ToolSpec[]> {
    const specs = (await Promise.all(this.sources.map((s) => s.list()))).flat()
    // model-facing names must be unique in a turn: prefix with the server when two servers whose tools can be in one turn
    // share a name, whether the other is discovered yet or only offers it, so that a name never changes later
    const holders = new Map<string, Set<string>>()
    const hold = (name: string, source: string) => holders.set(name, (holders.get(name) ?? new Set()).add(source))
    for (const s of specs) hold(s.name, s.source)
    for (const [source, names] of this.catalog?.offers() ?? []) for (const name of names) hold(name, source)
    const place = (source: string) => this.catalog?.place(source) ?? 'agent'
    const clashes = (spec: ToolSpec) =>
      [...(holders.get(spec.name) ?? [])].some(
        (other) => other !== spec.source && together(place(other), place(spec.source))
      )
    return specs.map((s) => (s.serverName && clashes(s) ? { ...s, name: `${s.serverName}__${s.name}` } : s))
  }

  public async find(name: string): Promise<ToolSpec | undefined> {
    return (await this.all()).find((s) => s.name === name)
  }

  public async resolve(spec: ToolSpec, roles: string[], grants: ElevationGrant[]): Promise<TierResolution> {
    const rawName = spec.key.split(':').pop() ?? spec.name
    const hasGrant = grants.some((g) => g.toolName === rawName && (!g.serverName || g.serverName === spec.serverName))
    return resolveTier(spec.access, roles, rawName, hasGrant)
  }

  /** Tools present in the model request: ALLOW and APPROVAL tiers only (RBAC-TOOL-002/003/004). */
  public async visible(roles: string[], grants: ElevationGrant[], principal?: Principal): Promise<VisibleTool[]> {
    const out: VisibleTool[] = []
    for (const spec of await this.all()) {
      // a tool that exists for some Principals only is absent for the others, not discouraged (RBAC-FILTER-002)
      if (spec.when && (!principal || !spec.when(principal))) continue
      const resolution = await this.resolve(spec, roles, grants)
      if (resolution.tier === 'ALLOW' || resolution.tier === 'APPROVAL') out.push({ spec, resolution })
    }
    return out
  }

  /**
   * The tools a turn gives the model (RBAC-FILTER-001, RBAC-TOOL-004, D112): those the roles reach, directly (ALLOW,
   * APPROVAL) or through an elevation the person may hold (REQUESTABLE), each resolved with the grants held now. A grant
   * that starts or ends changes the resolution, never the list, so that the start of the request stays the same; a call
   * of a tool reachable only through a grant is refused in code while none is held (`ToolGate`). DENY stays absent.
   */
  public async reachable(roles: string[], grants: ElevationGrant[], principal?: Principal): Promise<VisibleTool[]> {
    const out: VisibleTool[] = []
    for (const spec of await this.all()) {
      if (spec.when && (!principal || !spec.when(principal))) continue
      const resolution = await this.resolve(spec, roles, grants)
      if (resolution.tier !== 'DENY') out.push({ spec, resolution })
    }
    return out
  }

  /** REQUESTABLE tools the principal may ask an elevation for (RBAC-TOOL-004). */
  public async requestable(roles: string[], grants: ElevationGrant[]): Promise<VisibleTool[]> {
    const out: VisibleTool[] = []
    for (const spec of await this.all()) {
      const resolution = await this.resolve(spec, roles, grants)
      if (resolution.tier === 'REQUESTABLE') out.push({ spec, resolution })
    }
    return out
  }

  /** Discovers the tools of an MCP server of a space's account on that space's connection (TOOL-ACCESS-007). */
  public async discover(sourceName: string, account: CallAccountSecret): Promise<void> {
    await this.sources.find((s) => s.id === `mcp:${sourceName}`)?.discover?.(account)
  }

  /** Closes the connection a space's account opened to a server: the account ended or changed (TOOL-ACCESS-007). */
  public async closeAccount(sourceName: string, spaceId: string): Promise<void> {
    await this.sources.find((s) => s.id === `mcp:${sourceName}`)?.closeAccount?.(spaceId)
  }

  /** Closes the connection of a person's account, wherever a source opened it (TOOL-ACCESS-012). */
  public async closePersonal(accountId: string): Promise<void> {
    for (const s of this.sources) {
      const personal = s as { closePersonal?: (id: string) => Promise<void> }
      if (personal.closePersonal) {
        await personal.closePersonal(accountId)
        return
      }
    }
  }

  /** The check of a person's new account, on its source (TOOL-CONN-013). */
  public async checkRead(sourceName: string, read: CheckRead): Promise<CheckResult | undefined> {
    const mcp = this.sources.find((s) => s.id === `mcp:${sourceName}`)
    if (mcp?.checkRead) return mcp.checkRead(read)
    const http = this.sources.find((s) => s.id === 'http') as HttpToolSource | undefined
    return http?.checkReadOf(sourceName, read.headers)
  }

  /** A tool source by its id (`mcp:<server>`, `http`, `bundled`), for the tests. */
  public sourceById(id: string): ToolSource | undefined {
    return this.sources.find((s) => s.id === id)
  }

  public toDefinitions(tools: VisibleTool[]): ToolDefinition[] {
    return tools.map((t) => ({ name: t.spec.name, description: t.spec.description, parameters: t.spec.parameters }))
  }

  public async close(): Promise<void> {
    for (const s of this.sources)
      await s.close?.().catch((err) => this.logger.warn({ err }, 'tool source close failed'))
  }
}
