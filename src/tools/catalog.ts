/**
 * The tool catalog (ayni-spec D96 to D99, D101; TOOL-CAT, TOOL-AVAIL): every tool source of the agent-pack, an entry of
 * `tools.sources` (an MCP server, an HTTP tool or a bundled tool), with the answers it gives to the four questions: where
 * it is available, whose account its calls run with, who may use it (roles, through its `access`), and what a call needs
 * (the effect, the rule and the step-up of each of its tools). The layers below the pack (the owner of a space, the
 * person) only narrow these answers.
 */
import type {
  AgentPack,
  ApprovalRule,
  Availability,
  BundledSource,
  CallRule,
  McpSource,
  SourceAccount,
  SourceBinding,
  SpaceCallRule,
  StepUp,
  TemplateTool,
  ToolAccess,
  ToolDeclaration,
  ToolEffect,
} from '../config/packTypes.js'
import { BUNDLED_NAMES, BUNDLED_TOOLS, bundledSource } from '../config/packTypes.js'

export type SourceKind = 'mcp' | 'http' | 'bundled'

/** The MCP annotations of a tool, as its server lists them (they give defaults only, D99). */
export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
  idempotentHint?: boolean
  title?: string
}

/** A source of the catalog, with its defaults resolved. */
export interface CatalogSource {
  name: string
  kind: SourceKind
  /** what people read: the declared title, else the source's name */
  title: string
  /** the pack declared a title: a step label may name the source by it */
  titleDeclared: boolean
  description?: string
  account: SourceAccount
  availability: Availability
  /** an MCP server's offered tools, when it declares them */
  offer?: string[]
  bindings: SourceBinding[]
  /** what the source declares of its trust, if anything */
  untrusted?: boolean
  /** what the pack says of each of its tools, by name: title, effect, rule, trust, step-up (`tools.<name>`) */
  tools: Record<string, ToolDeclaration>
  /** the tier model that governs its tools: the source's own `access` */
  access?: ToolAccess
  transport?: McpSource['transport']
  method?: string
  /** an MCP server's or an HTTP tool's URL: a person's account is used at the same URL only (TOOL-CAT-015) */
  url?: string
}

/**
 * The source of a bundled tool (TOOL-CAT-001): the id of the source that names its bundled tool, else the bundled tool's
 * name (`workingMemory`), else, for a tool of no bundled name (`knowledge_search`), the tool's own name.
 */
export function bundledSourceOf(pack: Pick<AgentPack, 'tools'>, toolName: string): string {
  for (const name of BUNDLED_NAMES)
    if ((BUNDLED_TOOLS[name] as readonly string[]).includes(toolName)) return bundledSource(pack, name)?.[0] ?? name
  return toolName
}

const RULE_ORDER: Record<SpaceCallRule, number> = { none: 0, confirm: 1, approval: 2, off: 3 }

/** The strictest of two rules (TOOL-CALL-002). */
export function strictest<T extends SpaceCallRule>(a: T, b: T): T {
  return RULE_ORDER[a] >= RULE_ORDER[b] ? a : b
}

/** Whether `rule` is looser than `than` (TOOL-SPACE-006). */
export function looser(rule: SpaceCallRule, than: SpaceCallRule): boolean {
  return RULE_ORDER[rule] < RULE_ORDER[than]
}

/** The default rule of an effect (D99, TOOL-CAT-007). */
export function defaultRuleOf(effect: ToolEffect): CallRule {
  return effect === 'read' ? 'none' : effect === 'write' ? 'confirm' : 'approval'
}

/**
 * An MCP tool's effect from its annotations, an annotation it lacks taking the value MCP gives it by default
 * (`readOnlyHint` false, `destructiveHint` true, `openWorldHint` true): TOOL-CAT-006.
 */
export function effectFromAnnotations(annotations: ToolAnnotations | undefined): ToolEffect {
  const readOnly = annotations?.readOnlyHint ?? false
  const destructive = annotations?.destructiveHint ?? true
  const openWorld = annotations?.openWorldHint ?? true
  if (readOnly) return 'read'
  if (destructive) return 'delete'
  if (openWorld) return 'external'
  return 'write'
}

/** An HTTP tool's effect from its method (TOOL-CAT-006). */
export function effectFromMethod(method: string | undefined): ToolEffect {
  if (method === 'GET') return 'read'
  if (method === 'DELETE') return 'delete'
  return 'write'
}

/** A tool's title on a card: the declared one, else its name with dashes and underscores as spaces (TOOL-CALL-003). */
export function humanName(name: string): string {
  const spaced = name.replace(/[-_]+/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name
}

/** What the pack sets of a tool's rule, and the approval entry that sets it (TOOL-CAT-007). */
export interface PackRule {
  rule: CallRule
  /** the `access.approval` entry of its source that lists the tool, with its approvers and policy */
  approvalRule?: ApprovalRule
  /** where the rule comes from: an approval entry, a declaration, or the default of the tool's effect */
  from: 'approval-entry' | 'declared' | 'effect'
}

export class ToolCatalog {
  private readonly byName = new Map<string, CatalogSource>()

  public constructor(private readonly pack: AgentPack) {
    for (const [id, def] of Object.entries(pack.tools?.sources ?? {})) {
      if (def.type === 'bundled') continue
      this.byName.set(id, {
        name: id,
        kind: def.type,
        title: def.title ?? id,
        titleDeclared: !!def.title,
        description: def.description,
        account: def.account ?? { kind: 'agent' },
        availability: def.availability ?? 'agent',
        ...(def.type === 'mcp' && def.offer ? { offer: def.offer } : {}),
        bindings: def.bindings ?? [],
        ...(def.untrusted !== undefined ? { untrusted: def.untrusted } : {}),
        // an HTTP tool is one tool, named by its source's id (D101)
        tools: def.type === 'http' ? { [id]: def.tools?.[id] ?? {} } : (def.tools ?? {}),
        access: def.access,
        ...(def.type === 'mcp' ? { transport: def.transport } : { method: def.method }),
        ...(def.url ? { url: def.url } : {}),
      })
    }
    // every bundled tool is a source: the one that names it, else one of its own name with its defaults
    for (const name of BUNDLED_NAMES) {
      const declared = bundledSource(pack, name)
      const id = declared?.[0] ?? name
      this.byName.set(id, this.bundledSource(id, BUNDLED_TOOLS[name], declared?.[1]))
    }
  }

  private bundledSource(name: string, tools: readonly string[], entry: BundledSource | undefined): CatalogSource {
    return {
      name,
      kind: 'bundled',
      title: entry?.title ?? name,
      titleDeclared: !!entry?.title,
      ...(entry?.description ? { description: entry.description } : {}),
      account: { kind: 'none' },
      availability: entry?.availability ?? 'agent',
      bindings: [],
      tools: Object.fromEntries(tools.map((t) => [t, entry?.tools?.[t] ?? {}])),
      access: entry?.access,
    }
  }

  /** Every source the pack declares, the bundled ones included. */
  public sources(): CatalogSource[] {
    return [...this.byName.values()]
  }

  /** A source by its id; a bundled tool that no source names is a source of its bundled name. */
  public source(name: string): CatalogSource | undefined {
    return this.byName.get(name)
  }

  /** The source of a tool spec: the source it names, or a bundled source of its own name. */
  public sourceOf(sourceName: string, bundledTool?: string): CatalogSource {
    const known = this.byName.get(sourceName)
    if (known) return known
    const created = this.bundledSource(sourceName, bundledTool ? [bundledTool] : [], undefined)
    this.byName.set(sourceName, created)
    return created
  }

  /** A tool's effect (TOOL-CAT-006): declared, else from its annotations or its method; none for a bundled tool. */
  public effectOf(source: CatalogSource, tool: string, annotations?: ToolAnnotations): ToolEffect | undefined {
    if (source.kind === 'bundled') return undefined
    const declared = source.tools[tool]?.effect
    if (declared) return declared
    if (source.kind === 'http') return effectFromMethod(source.method)
    return effectFromAnnotations(annotations)
  }

  /** The rule the pack gives a tool (TOOL-CAT-007): an approval entry, else the declared rule, else its effect's default. */
  public packRuleOf(source: CatalogSource, tool: string, annotations?: ToolAnnotations): PackRule {
    const approvalRule = source.access?.approval?.find((r) => r.tools.includes(tool))
    if (approvalRule) return { rule: 'approval', approvalRule, from: 'approval-entry' }
    const declared = source.tools[tool]?.call
    if (declared) return { rule: declared, from: 'declared' }
    const effect = this.effectOf(source, tool, annotations)
    return { rule: effect ? defaultRuleOf(effect) : 'none', from: 'effect' }
  }

  /**
   * Whether a tool's results are content written outside the organization (TOOL-CAT-008): the declaration for the tool,
   * else the source's, else, for an MCP tool, untrusted unless `openWorldHint` is false; an HTTP tool is trusted unless
   * declared, and a bundled tool always is.
   */
  public untrustedOf(source: CatalogSource, tool: string, annotations?: ToolAnnotations): boolean {
    if (source.kind === 'bundled') return false
    const perTool = source.tools[tool]?.untrusted
    if (perTool !== undefined) return perTool
    if (source.untrusted !== undefined) return source.untrusted
    if (source.kind === 'mcp') return annotations?.openWorldHint !== false
    return false
  }

  /** A tool's title (TOOL-CALL-003): declared, else the server's annotation title, else its name made readable. */
  public toolTitle(source: CatalogSource, tool: string, annotations?: ToolAnnotations): string {
    return source.tools[tool]?.title ?? annotations?.title ?? (source.kind === 'http' ? source.title : humanName(tool))
  }

  /** The roles that approve a tool of the whole agent or of Personal (TOOL-CAT-009); empty when nobody can. */
  public approversOf(packRule: PackRule): string[] {
    return packRule.approvalRule?.approvers ?? this.pack.approvals?.approvers ?? []
  }

  /** The tools a template of spaces names, in its order (TOOL-AVAIL-002). */
  public templateTools(templateId: string | undefined): TemplateTool[] {
    if (!templateId) return []
    const template = (this.pack.spaces?.templates ?? []).find((t) => t.id === templateId)
    return (template?.tools ?? []).filter((t) => this.byName.get(t.source)?.availability === 'spaces')
  }

  /**
   * The step-up of a tool of a source (TOOL-CAT-010, TOOL-CALL-001): its source's `tools.<name>.stepUp`, so that a tool
   * of the same name in another source never takes it.
   */
  public stepUpOf(source: CatalogSource, tool: string): StepUp | undefined {
    return source.tools[tool]?.stepUp
  }

  /**
   * A tool's step-up, for the settings of a space (PROF-TOOL-001): the types of the methods a re-authentication asks
   * (`["face-match"]`, D127), else `device` for a device confirmation, else null.
   */
  public stepUpTypeOf(source: CatalogSource, tool: string): 'device' | string[] | null {
    const stepUp = this.stepUpOf(source, tool)
    const methods = this.pack.identity.authentication?.methods ?? {}
    if (stepUp?.authentication) return stepUp.authentication.methods.map((name) => methods[name]?.type ?? name)
    return stepUp?.authChallenge?.type ?? null
  }

  /** Whether some tool may ask before it runs: what the platform rules then tell the model (TOOL-CALL-010). */
  public mayAsk(): boolean {
    for (const source of this.sources()) {
      if (source.kind === 'bundled') {
        if (Object.values(source.tools).some((t) => t.call && t.call !== 'none')) return true
        continue
      }
      if (source.kind === 'http') {
        const tool = source.name
        if (this.packRuleOf(source, tool).rule !== 'none' || this.untrustedOf(source, tool)) return true
        continue
      }
      // an MCP server: its tools are known at discovery; only one whose every offered tool the pack declares read and
      // trusted, with no rule, asks nothing
      const names = source.offer ?? Object.keys(source.tools)
      if (!source.offer && !Object.keys(source.tools).length) return true
      if (!source.offer) return true
      for (const tool of names) {
        const declared = source.tools[tool]
        if (!declared?.effect) return true
        if (this.packRuleOf(source, tool).rule !== 'none') return true
        if (this.untrustedOf(source, tool, { openWorldHint: declared.untrusted === false ? false : undefined }))
          return true
      }
    }
    return false
  }
}
