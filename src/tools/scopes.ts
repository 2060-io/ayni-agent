/**
 * The scopes of each tool (ayni-spec D118; TOOL-CAT-021, TOOL-OAUTH-012, TOOL-OAUTH-013): a tool of a source whose account
 * signs in with OAuth may say the scopes it needs; the sign-in asks those of the tools the model may be given, and the
 * model is given only the tools whose scopes were all granted. What the agent-pack says, read the same way at start and
 * at each turn.
 */
import type { ToolDeclaration } from '../config/packTypes.js'
import { CODE_ONLY_CAPABILITIES, type FeatureProfile, toolsInUse } from '../features/profiles.js'

/** What a source says that names the tools the model may be given of it. */
export interface ScopedSource {
  kind?: 'mcp' | 'http' | 'bundled'
  type?: 'mcp' | 'http' | 'bundled'
  offer?: string[]
  capabilities?: string[]
  tools?: Record<string, ToolDeclaration>
}

/** The scopes a tool declares, if it declares them. */
export function scopesOfTool(source: Pick<ScopedSource, 'tools'>, tool: string): string[] | undefined {
  return source.tools?.[tool]?.scopes
}

/** Whether one tool of a source declares its scopes: the source's sign-in then asks theirs (TOOL-CAT-021). */
export function declaresScopes(source: Pick<ScopedSource, 'tools'>): boolean {
  return Object.values(source.tools ?? {}).some((t) => t.scopes !== undefined)
}

/**
 * The tools of a source the model may be given, as far as the agent-pack names them (TOOL-CAT-003, TOOL-FEAT-010): for
 * the provider of a feature with a contract, the profile's core and the tools of every optional capability its
 * `capabilities` leaves in (all of them when absent), never those of `team-roots`, then the extras its `offer` names; for
 * an MCP server, its `offer`; for an HTTP tool, its one tool. Undefined for an MCP server that names no `offer`: its tools
 * are those it lists.
 */
export function modelToolsOf(id: string, source: ScopedSource, profile?: FeatureProfile): string[] | undefined {
  const kind = source.kind ?? source.type
  if (kind === 'http') return [id]
  if (profile) {
    const capabilities = (source.capabilities ?? profile.capabilities).filter(
      (c) => !CODE_ONLY_CAPABILITIES.includes(c)
    )
    return [...toolsInUse(profile, capabilities).map((t) => t.name), ...(source.offer ?? [])]
  }
  return source.offer ? [...source.offer] : undefined
}

/** Whether every scope a tool declares is granted: a tool that declares none, in a source that declares some, is not. */
export function toolGranted(source: Pick<ScopedSource, 'tools'>, tool: string, granted: readonly string[]): boolean {
  const needs = scopesOfTool(source, tool)
  if (!needs) return false
  return needs.every((s) => granted.includes(s))
}
