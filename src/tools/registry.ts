/**
 * The tool registry: aggregates sources, resolves the tier of every (role set, tool) and builds the
 * per-principal tool list that reaches the model (RBAC-FILTER-001/002).
 */
import type { ElevationGrant } from '../core/types.js'
import type { ToolDefinition } from '../llm/types.js'
import { resolveTier, type TierResolution } from '../policy/rbac.js'
import type { Logger } from '../util/logger.js'
import type { ToolSource, ToolSpec } from './types.js'

export interface VisibleTool {
  spec: ToolSpec
  resolution: TierResolution
}

export class ToolRegistry {
  private readonly sources: ToolSource[] = []
  private lazyLoaded = new Set<string>()

  public constructor(private readonly logger: Logger) {}

  public add(source: ToolSource, eager = true): void {
    this.sources.push(source)
    if (!eager) this.lazyLoaded.add(source.id)
  }

  /** Every known tool; lazy MCP servers are discovered on the first call that needs the list (TOOL-MCP-003). */
  public async all(): Promise<ToolSpec[]> {
    const specs = (await Promise.all(this.sources.map((s) => s.list()))).flat()
    // model-facing names must be unique: prefix with the server when two servers share a name
    const counts = new Map<string, number>()
    for (const s of specs) counts.set(s.name, (counts.get(s.name) ?? 0) + 1)
    return specs.map((s) =>
      (counts.get(s.name) ?? 0) > 1 && s.serverName ? { ...s, name: `${s.serverName}__${s.name}` } : s
    )
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
  public async visible(roles: string[], grants: ElevationGrant[]): Promise<VisibleTool[]> {
    const out: VisibleTool[] = []
    for (const spec of await this.all()) {
      const resolution = await this.resolve(spec, roles, grants)
      if (resolution.tier === 'ALLOW' || resolution.tier === 'APPROVAL') out.push({ spec, resolution })
    }
    return out
  }

  /** REQUESTABLE tools the principal may ask an elevation for (hidden from the model, RBAC-TOOL-004). */
  public async requestable(roles: string[], grants: ElevationGrant[]): Promise<VisibleTool[]> {
    const out: VisibleTool[] = []
    for (const spec of await this.all()) {
      const resolution = await this.resolve(spec, roles, grants)
      if (resolution.tier === 'REQUESTABLE') out.push({ spec, resolution })
    }
    return out
  }

  public toDefinitions(tools: VisibleTool[]): ToolDefinition[] {
    return tools.map((t) => ({ name: t.spec.name, description: t.spec.description, parameters: t.spec.parameters }))
  }

  public async close(): Promise<void> {
    for (const s of this.sources)
      await s.close?.().catch((err) => this.logger.warn({ err }, 'tool source close failed'))
  }
}
