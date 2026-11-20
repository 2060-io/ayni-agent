/**
 * The tool catalog (ayni-spec D96 to D99; TOOL-CAT, TOOL-AVAIL): every tool source of the agent-pack, an MCP server, an
 * HTTP tool or a bundled tool, with the answers it gives to the four questions: where it is available, whose account its
 * calls run with, who may use it (roles, through its `toolAccess`), and what a call needs (the effect and the rule of each
 * of its tools). The layers below the pack (the owner of a space, the person) only narrow these answers.
 */
import type {
  AgentPack,
  ApprovalRule,
  Availability,
  BundledEntry,
  CallRule,
  McpServerDef,
  SourceAccount,
  SourceBinding,
  SpaceCallRule,
  TemplateTool,
  ToolAccess,
  ToolDeclaration,
  ToolEffect,
} from '../config/packTypes.js'

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
  /** what the pack says of each of its tools (an MCP server's `tools`; an HTTP tool's own effect and rule) */
  tools: Record<string, ToolDeclaration>
  /** the tier model that governs its tools (an MCP server's `toolAccess`, else `tools.access`) */
  access?: ToolAccess
  transport?: McpServerDef['transport']
  method?: string
}

/** The bundled tools of each key of `tools.bundled`; the bundled tools no key names are sources of their own name. */
export const BUNDLED_SOURCES: Record<string, string[]> = {
  statistics: ['statistics'],
  generateImage: ['generate_image'],
  principalCredentials: ['principal_credentials'],
  requestPresentation: ['request_presentation'],
  credentialIssuance: ['credential_requirements', 'issue_credential'],
  principalPreferences: ['principal_preferences'],
  workingMemory: ['working_memory'],
}

/** The source of a bundled tool: the key of `tools.bundled` that enables it, else the tool's own name. */
export function bundledSourceOf(toolName: string): string {
  for (const [key, tools] of Object.entries(BUNDLED_SOURCES)) if (tools.includes(toolName)) return key
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
  /** the `toolAccess.approval` entry that lists the tool, with its approvers and policy */
  approvalRule?: ApprovalRule
  /** where the rule comes from: an approval entry, a declaration, or the default of the tool's effect */
  from: 'approval-entry' | 'declared' | 'effect'
}

export class ToolCatalog {
  private readonly byName = new Map<string, CatalogSource>()

  public constructor(private readonly pack: AgentPack) {
    for (const server of pack.mcp?.servers ?? []) {
      this.byName.set(server.name, {
        name: server.name,
        kind: 'mcp',
        title: server.title ?? server.name,
        titleDeclared: !!server.title,
        description: server.description,
        account: server.account ?? { kind: 'agent' },
        availability: server.availability ?? 'agent',
        ...(server.offer ? { offer: server.offer } : {}),
        bindings: server.bindings ?? [],
        ...(server.untrusted !== undefined ? { untrusted: server.untrusted } : {}),
        tools: server.tools ?? {},
        access: server.toolAccess,
        transport: server.transport,
      })
    }
    for (const tool of pack.tools?.http ?? []) {
      this.byName.set(tool.name, {
        name: tool.name,
        kind: 'http',
        title: tool.title ?? tool.name,
        titleDeclared: !!tool.title,
        description: tool.description,
        account: tool.account ?? { kind: 'agent' },
        availability: tool.availability ?? 'agent',
        bindings: tool.bindings ?? [],
        ...(tool.untrusted !== undefined ? { untrusted: tool.untrusted } : {}),
        tools: {
          [tool.name]: {
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.effect ? { effect: tool.effect } : {}),
            ...(tool.call ? { call: tool.call } : {}),
          },
        },
        access: pack.tools?.access,
        method: tool.method,
      })
    }
    const bundled = (pack.tools?.bundled ?? {}) as Record<string, BundledEntry | undefined>
    for (const [key, tools] of Object.entries(BUNDLED_SOURCES)) {
      const entry = bundled[key]
      this.byName.set(key, this.bundledSource(key, tools, entry))
    }
  }

  private bundledSource(name: string, tools: string[], entry: BundledEntry | undefined): CatalogSource {
    return {
      name,
      kind: 'bundled',
      title: entry?.title ?? name,
      titleDeclared: !!entry?.title,
      account: { kind: 'none' },
      availability: entry?.availability ?? 'agent',
      bindings: [],
      tools: Object.fromEntries(tools.map((t) => [t, entry?.call ? { call: entry.call } : {}])),
      access: this.pack.tools?.access,
    }
  }

  /** Every source the pack declares, the bundled ones included. */
  public sources(): CatalogSource[] {
    return [...this.byName.values()]
  }

  /** A source by its name; a bundled tool that no key of `tools.bundled` names is a source of its own name. */
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
   * Whether a tool's results are content written outside the organization (TOOL-CAT-008): an MCP server's declaration for
   * the tool, else the source's, else untrusted unless `openWorldHint` is false; an HTTP tool or a bundled tool is trusted
   * unless declared.
   */
  public untrustedOf(source: CatalogSource, tool: string, annotations?: ToolAnnotations): boolean {
    if (source.kind === 'bundled') return false
    const perTool = source.kind === 'mcp' ? source.tools[tool]?.untrusted : undefined
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

  /** The step-up an action declares (TOOL-CALL-001), for the settings of a space. */
  public stepUpOf(tool: string): 'device' | 'face-match' | 'document' | null {
    return this.pack.actions?.[tool]?.authChallenge?.type ?? null
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
