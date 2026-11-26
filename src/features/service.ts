/**
 * Features with a contract and their providers (ayni-spec D120 to D123; TOOL-FEAT-010 to 022).
 *
 * A provider of a feature with a contract is an MCP server that declares the feature's profile. At its first connection
 * with an account, and again whenever what it declares changes, the agent reads the profile, the version and the
 * capabilities it declares and the tools it lists, and uses it with that account only when it conforms (TOOL-FEAT-011).
 * The model is given the profile's tools from the agent's own copy, never the server's (TOOL-FEAT-010).
 *
 * Every reference the model reads in a result carries the mark of the feature's provider in the space, and every reference
 * a call gives must carry the mark in force, which the code removes before the call (TOOL-FEAT-016); the location of a call
 * is set or checked by the code (TOOL-FEAT-014); a result is read as the profile's, its items outside the location dropped
 * (TOOL-FEAT-015), its references marked, and a content of bytes replaced by its text (TOOL-FEAT-020).
 */
import { randomInt } from 'node:crypto'
import type { AgentPack } from '../config/packTypes.js'
import { CredentialScanner } from '../core/credentials.js'
import type { SpaceToolList } from '../core/types.js'
import type { Store } from '../store/types.js'
import type { CatalogSource, ToolCatalog } from '../tools/catalog.js'
import type { ListedTool, McpServerSource, ServerDeclaration } from '../tools/mcp.js'
import type { CallAccountSecret, ToolResult, ToolSpec } from '../tools/types.js'
import { nowIso } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import {
  CODE_ONLY_CAPABILITIES,
  type FeatureProfile,
  hasProfilePrefix,
  inputSchemaOf,
  type JsonSchema,
  type ProfileTool,
  parseVersion,
  toolsInUse,
} from './profiles.js'

/** What the agent knows of a provider with one account (TOOL-FEAT-011, PROF-TOOL-033). */
export interface ProviderState {
  /** undefined before the first connection with the account; false when the server did not offer the profile */
  conformant?: boolean
  /** why it did not conform, in words the log carries */
  reason?: string
  /** the version the server declares */
  version?: string
  /** the optional capabilities in use: declared by the server, not left out by the source's `capabilities` */
  capabilities: string[]
  /** the server's own tools that the source offers (TOOL-CAT-003): given to the model as a category's */
  extras: ListedTool[]
}

/** Where a feature's calls may go in a conversation (TOOL-FEAT-014, TOOL-FEAT-022). */
export type LocationScope =
  /** the space's list: the code sets the location of a list of one, and checks it against a longer one */
  | { kind: 'list'; entries: { value: string; label: string }[] }
  /** Personal, or a space set to any value: the model names a location in each call, the account's rights bound it */
  | { kind: 'any' }

/** A call of a tool of a profile, as the code prepares it (TOOL-FEAT-014, TOOL-FEAT-016). */
export type PreparedCall =
  | { ok: true; args: Record<string, unknown>; location?: string; locationLabel?: string }
  | { ok: false; outcome: 'stale-reference' | 'outside-list'; text: string }

/** The characters of a mark: 62 of them, six drawn, about 35.7 bits (TOOL-FEAT-016 asks at least 32). */
const MARK_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const MARK_LENGTH = 6
/** What separates a mark from the reference it stands before (`k7QdXy~/Reports/Q3.md`). */
export const MARK_SEPARATOR = '~'

/** A new mark: a random value of at least 32 bits (TOOL-FEAT-016). */
export function newMark(): string {
  let out = ''
  for (let i = 0; i < MARK_LENGTH; i++) out += MARK_ALPHABET[randomInt(0, MARK_ALPHABET.length)]
  return out
}

/** A reference as the model reads it: the mark, `~` and the reference. */
export function marked(mark: string, reference: string): string {
  return `${mark}${MARK_SEPARATOR}${reference}`
}

/** A reference without the mark in force, or undefined when it carries another mark or none. */
export function unmarked(mark: string, value: string): string | undefined {
  const prefix = `${mark}${MARK_SEPARATOR}`
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * Whether the input schema a server lists for a core tool accepts the profile's required arguments (TOOL-FEAT-011): it has
 * each of them, where it lists its properties, and requires nothing the profile does not.
 */
export function acceptsRequired(schema: unknown, tool: ProfileTool): boolean {
  const required = tool.arguments.filter((a) => a.required && !a.capability).map((a) => a.name)
  if (!isObject(schema)) return true
  const properties = isObject(schema.properties) ? schema.properties : undefined
  if (properties && required.some((name) => !(name in properties))) return false
  const theirs = Array.isArray(schema.required) ? schema.required : []
  return theirs.every((name) => required.includes(String(name)))
}

/**
 * What the agent makes of a provider's declaration with one account (TOOL-FEAT-011): conformant when it declares the
 * feature's profile with the major version of the agent's copy, lists every core tool and each core tool's schema accepts
 * the profile's required arguments; the capabilities in use are those it declares, the source does not leave out, and
 * whose tools it lists.
 */
export function readDeclaration(
  profile: FeatureProfile,
  source: Pick<CatalogSource, 'capabilities' | 'offer'>,
  declaration: ServerDeclaration
): ProviderState {
  const refused = (reason: string): ProviderState => ({ conformant: false, reason, capabilities: [], extras: [] })
  const extension = declaration.extensions?.[profile.id]
  if (!isObject(extension)) return refused(`the server declares no ${profile.id}`)
  const version = parseVersion(extension.version)
  if (!version || version.major !== profile.major)
    return refused(`the server declares ${profile.id} ${String(extension.version)}, not ${profile.major}.x`)
  const listed = new Map(declaration.tools.map((t) => [t.name, t]))
  for (const tool of profile.tools.filter((t) => !t.capability)) {
    const found = listed.get(tool.name)
    if (!found) return refused(`the server lists no ${tool.name}, a core tool of ${profile.id}`)
    if (!acceptsRequired(found.inputSchema, tool))
      return refused(`the input schema of ${tool.name} does not take the arguments ${profile.id} requires`)
  }
  const declared = Array.isArray(extension.capabilities) ? extension.capabilities.map(String) : []
  const allowed = source.capabilities ?? profile.capabilities
  const capabilities = profile.capabilities.filter(
    (c) =>
      declared.includes(c) &&
      allowed.includes(c) &&
      // a capability is in use only with every tool of it listed (FEAT-CORE-002)
      profile.tools.filter((t) => t.capability === c).every((t) => listed.has(t.name))
  )
  const extras = declaration.tools.filter((t) => !hasProfilePrefix(profile, t.name) && source.offer?.includes(t.name))
  return {
    conformant: true,
    version: String(extension.version),
    capabilities,
    extras,
  }
}

/** The location of a call's result, a list of items or one item, at a member of the result (common §6). */
function itemLocation(item: unknown, argument: string): unknown {
  return isObject(item) ? item[argument] : undefined
}

/** Every reference of a result marked (TOOL-FEAT-016): the string values of the members that hold references. */
export function markReferences(value: unknown, mark: string, members: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => markReferences(v, mark, members))
  if (!isObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value))
    out[key] = members.includes(key) && typeof v === 'string' && v ? marked(mark, v) : markReferences(v, mark, members)
  return out
}

/** The JSON type of a value, as a result's shape names it. */
function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

export interface FeatureServiceDeps {
  pack: AgentPack
  store: Store
  catalog: ToolCatalog
  logger: Logger
  /** the MCP server of a source of the catalog */
  server: (sourceId: string) => McpServerSource | undefined
  /** the text the agent makes of bytes of a type, as of an attachment of that type; undefined when it makes none */
  textOf?: (bytes: Buffer, mediaType: string, name: string | undefined) => Promise<string | undefined>
}

/** The features with a contract, their providers' declarations, the marks, and what a call of a profile's tool goes through. */
export class FeatureService {
  /** what each provider declared with each account, and what the agent made of it */
  private readonly states = new Map<string, { declaration: ServerDeclaration; state: ProviderState }>()
  /** a provider that did not conform with an account is logged once for each reason (TOOL-FEAT-011) */
  private readonly logged = new Map<string, string>()
  private readonly scanner: CredentialScanner

  public constructor(private readonly deps: FeatureServiceDeps) {
    this.scanner = new CredentialScanner(deps.pack)
  }

  /** The key of what a provider declares with an account: a space's, a person's, or the agent's (TOOL-FEAT-011). */
  public static keyOf(account: Pick<CallAccountSecret, 'kind' | 'spaceId' | 'accountId'>): string {
    if (account.kind === 'space') return `space:${account.spaceId ?? ''}`
    if (account.kind === 'personal') return `account:${account.accountId ?? ''}`
    return 'agent'
  }

  /** The profile of a source's feature, when it has a contract. */
  public profileOf(source: Pick<CatalogSource, 'feature'>): FeatureProfile | undefined {
    return this.deps.catalog.profileOf(source)
  }

  // ---- what each provider declares (TOOL-FEAT-011) -------------------------------------------------------------------

  /** What the agent knows of a provider with an account, without connecting: before any connection, the core and the source's `capabilities`. */
  public known(source: CatalogSource, accountKey: string): ProviderState {
    const found = this.states.get(`${source.name}|${accountKey}`)
    if (found) return found.state
    const profile = this.profileOf(source)
    return {
      capabilities: (source.capabilities ?? []).filter((c) => profile?.capabilities.includes(c)),
      extras: [],
    }
  }

  /**
   * What the provider declares with an account, read at the first connection and again whenever its declaration changes
   * (TOOL-FEAT-011); a provider that cannot be reached keeps what was known.
   */
  public async declared(source: CatalogSource, account: CallAccountSecret, accountKey: string): Promise<ProviderState> {
    const profile = this.profileOf(source)
    const server = this.deps.server(source.name)
    if (!profile || !server) return this.known(source, accountKey)
    const key = `${source.name}|${accountKey}`
    let declaration: ServerDeclaration
    try {
      declaration = await server.declaration(account)
    } catch (error) {
      this.deps.logger.warn(
        { source: source.name, err: error instanceof Error ? error.message : String(error) },
        'the provider of a feature could not be reached to read what it declares'
      )
      return this.known(source, accountKey)
    }
    const found = this.states.get(key)
    if (found && found.declaration === declaration) return found.state
    const state = readDeclaration(profile, source, declaration)
    this.states.set(key, { declaration, state })
    if (state.conformant === false && this.logged.get(key) !== state.reason) {
      this.logged.set(key, state.reason ?? '')
      this.deps.logger.warn(
        { source: source.name, feature: source.feature, profile: profile.id, reason: state.reason },
        'a provider does not offer the profile of its feature: none of its tools is given with this account (TOOL-FEAT-011)'
      )
    }
    if (state.conformant) this.logged.delete(key)
    return state
  }

  // ---- the marks (TOOL-FEAT-016) ------------------------------------------------------------------------------------

  /** The mark of a feature's provider in a space or a Personal: made at its first use, renewed when the provider is another. */
  public async markOf(spaceId: string, featureId: string, sourceId: string): Promise<string> {
    const found = await this.deps.store.featureMarks.get(spaceId, featureId)
    if (found && found.sourceId === sourceId) return found.mark
    return this.renewMark(spaceId, featureId, sourceId)
  }

  /** A new mark of a feature's provider: every reference the model read before reaches no provider (TOOL-FEAT-016). */
  public async renewMark(spaceId: string, featureId: string, sourceId: string): Promise<string> {
    const mark = newMark()
    await this.deps.store.featureMarks.save({ spaceId, featureId, sourceId, mark, createdAt: nowIso() })
    return mark
  }

  // ---- the tools the model is given (TOOL-FEAT-010) -----------------------------------------------------------------

  /**
   * The tools of a provider for a turn: the profile's core and the tools of the capabilities in use, from the agent's copy,
   * in the profile's order, then the offered extras as the server lists them. The tools of `team-roots` are never given; the
   * tool that lists locations is hidden while the feature is limited to a list (TOOL-FEAT-014).
   */
  public specsFor(source: CatalogSource, state: ProviderState, scope: LocationScope): ToolSpec[] {
    const profile = this.profileOf(source)
    const server = this.deps.server(source.name)
    if (!profile || !server || state.conformant === false) return []
    const capabilities = state.capabilities.filter((c) => !CODE_ONLY_CAPABILITIES.includes(c))
    const out: ToolSpec[] = []
    for (const tool of toolsInUse(profile, capabilities)) {
      if (tool.name === profile.location.listTool && scope.kind === 'list') continue
      out.push({
        key: `mcp:${source.name}:${tool.name}`,
        source: source.name,
        rawName: tool.name,
        name: tool.name,
        description: tool.description,
        parameters: inputSchemaOf(tool, capabilities),
        access: source.access,
        serverName: source.name,
        stepLabel: source.title ? `Using ${source.title}` : 'Working',
        invoke: (args, ctx) => server.callTool(tool.name, args, ctx),
      })
    }
    for (const extra of state.extras)
      out.push({
        key: `mcp:${source.name}:${extra.name}`,
        source: source.name,
        rawName: extra.name,
        name: extra.name,
        description: extra.description ?? source.tools[extra.name]?.title ?? extra.name,
        parameters: (extra.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        access: source.access,
        serverName: source.name,
        ...(extra.annotations ? { annotations: extra.annotations } : {}),
        stepLabel: source.title ? `Using ${source.title}` : 'Working',
        invoke: (args, ctx) => server.callTool(extra.name, args, ctx),
      })
    return out
  }

  /**
   * The input schema of a tool of a profile as the model receives it: the profile's, without the location a list of one
   * sets in code (TOOL-FEAT-014); a call is validated against the whole one.
   */
  public forModel(profile: FeatureProfile, schema: JsonSchema, scope: LocationScope): JsonSchema {
    const argument = profile.location.argument
    if (scope.kind !== 'list' || scope.entries.length !== 1) return schema
    const properties = { ...(schema.properties as Record<string, unknown>) }
    if (!(argument in properties)) return schema
    delete properties[argument]
    const required = (schema.required as string[] | undefined)?.filter((n) => n !== argument)
    const { required: _all, ...rest } = schema
    return { ...rest, properties, ...(required?.length ? { required } : {}) }
  }

  // ---- a call (TOOL-FEAT-013, 014, 016) ---------------------------------------------------------------------------

  /**
   * The call's arguments as the provider receives them: every reference without the mark in force, the location set by the
   * code or checked against the space's list. A reference that carries another mark, or none, stops the call before
   * anything else (`stale-reference`); a location outside the list stops it too (`outside-list`).
   */
  public prepare(
    profile: FeatureProfile,
    tool: ProfileTool,
    args: Record<string, unknown>,
    context: { mark: string; scope: LocationScope; featureTitle: string; providerTitle: string; personal: boolean }
  ): PreparedCall {
    const out = { ...args }
    const location = profile.location.argument
    const takesLocation = tool.arguments.some((a) => a.name === location)
    const one =
      context.scope.kind === 'list' && context.scope.entries.length === 1 ? context.scope.entries[0] : undefined
    // the location of a list of one is the code's: whatever the model wrote there is not read (TOOL-FEAT-014)
    if (one && takesLocation) delete out[location]
    for (const name of profile.referenceArguments) {
      const value = out[name]
      if (value === undefined || typeof value !== 'string') continue
      const reference = unmarked(context.mark, value)
      if (reference === undefined)
        return {
          ok: false,
          outcome: 'stale-reference',
          text: `stale-reference: this reference comes from a provider that ${context.personal ? 'you no longer use' : 'this space no longer uses'} for ${context.featureTitle}, or from none. ${context.featureTitle} are now provided by ${context.providerTitle}. Look the item up again.`,
        }
      out[name] = reference
    }
    if (!takesLocation) return { ok: true, args: out }
    if (one) return { ok: true, args: { ...out, [location]: one.value }, location: one.value, locationLabel: one.label }
    if (context.scope.kind === 'list') {
      const given = out[location]
      const entry = context.scope.entries.find((e) => e.value === given)
      if (!entry) {
        const labels = context.scope.entries.map((e) => e.label).join('; ')
        return {
          ok: false,
          outcome: 'outside-list',
          text: `outside-list: ${given === undefined ? 'this call names no' : `${String(args[location])} is not a`} ${profile.location.labels.one.toLowerCase()} of this space, whose ${profile.location.labels.list.toLowerCase()} are: ${labels}. Only the space's owner changes them.`,
        }
      }
      return { ok: true, args: out, location: entry.value, locationLabel: entry.label }
    }
    const given = out[location]
    return { ok: true, args: out, ...(typeof given === 'string' ? { location: given } : {}) }
  }

  /**
   * The addresses a call names outside the organization (TOOL-FEAT-013): those of the arguments the profile marks whose
   * domain, compared without regard to case, is none of `identity.organization.emailDomains`; with no list, every one.
   * A value the profile says is external (`audience: "anyone"`) counts too. Nothing the model writes but the arguments.
   */
  public outside(tool: ProfileTool, args: Record<string, unknown>): { external: boolean; addresses: string[] } {
    const domains = (this.deps.pack.identity.organization?.emailDomains ?? []).map((d) => d.toLowerCase())
    const addresses: string[] = []
    for (const { argument, member } of tool.externalWhen?.addresses ?? []) {
      const list = args[argument]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const address = member ? (isObject(item) ? item[member] : undefined) : item
        if (typeof address !== 'string') continue
        const at = address.lastIndexOf('@')
        const domain = at >= 0 ? address.slice(at + 1).toLowerCase() : ''
        if (!domains.includes(domain) && !addresses.includes(address)) addresses.push(address)
      }
    }
    const byValue = (tool.externalWhen?.values ?? []).some((v) => args[v.argument] === v.value)
    return { external: addresses.length > 0 || byValue, addresses }
  }

  // ---- a result (TOOL-FEAT-015, 016, 020) ---------------------------------------------------------------------------

  /**
   * A result as the model and the record read it: the profile's shape or an error in its place; every item outside the
   * location of the call dropped; every reference marked; a content of bytes replaced by the text the agent makes of it,
   * with the item's name, type and size, and kept in no store.
   */
  public async read(
    profile: FeatureProfile,
    tool: ProfileTool,
    location: string | undefined,
    mark: string,
    result: Pick<ToolResult, 'content' | 'data' | 'isError'>
  ): Promise<{ content: string; data?: unknown; isError: boolean }> {
    const label = `${profile.id} ${profile.version}`
    if (result.isError) {
      const error = isObject(result.data) && isObject(result.data.error) ? result.data : undefined
      const body = error ?? { error: { code: 'unavailable', message: result.content.slice(0, 500) } }
      return { content: JSON.stringify(body), data: body, isError: true }
    }
    const notProfile = (why: string) => {
      const body = { error: { code: 'unavailable', message: `The provider's answer is not ${label}'s: ${why}.` } }
      return { content: JSON.stringify(body), data: body, isError: true }
    }
    if (!isObject(result.data)) return notProfile('it holds no structured content')
    const data: Record<string, unknown> = { ...result.data }
    for (const [member, type] of Object.entries(tool.result.members))
      if (typeOf(data[member]) !== type)
        return notProfile(`${member} is not ${type === 'array' ? 'a list' : `a ${type}`}`)
    const argument = profile.location.argument
    if (location !== undefined) {
      for (const member of tool.result.located?.single ?? [])
        if (itemLocation(data[member], argument) !== location)
          return notProfile(`its ${member} is not inside the ${profile.location.labels.one.toLowerCase()} of the call`)
      for (const member of tool.result.located?.lists ?? [])
        data[member] = (data[member] as unknown[]).filter((item) => itemLocation(item, argument) === location)
    }
    if (tool.bytes && isObject(data.content) && data.content.kind === 'bytes')
      data.content = await this.textOfBytes(data.content, data.item)
    const out = markReferences(data, mark, profile.referenceMembers)
    return { content: JSON.stringify(out), data: out, isError: false }
  }

  /** The text of a content of bytes, its credentials masked, with its name, type and size; never the bytes (TOOL-FEAT-020). */
  private async textOfBytes(content: Record<string, unknown>, item: unknown): Promise<Record<string, unknown>> {
    const mediaType = typeof content.mediaType === 'string' ? content.mediaType : 'application/octet-stream'
    const bytes = typeof content.base64 === 'string' ? Buffer.from(content.base64, 'base64') : Buffer.alloc(0)
    const name = isObject(item) && typeof item.name === 'string' ? item.name : undefined
    let text: string | undefined
    try {
      text = bytes.length ? await this.deps.textOf?.(bytes, mediaType, name) : undefined
    } catch (error) {
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error), mediaType },
        'no text was made of a file'
      )
    }
    const shown = text ? (this.scanner.scan(text)?.text ?? text) : undefined
    return {
      kind: 'text-of-bytes',
      ...(name ? { name } : {}),
      mediaType,
      sizeBytes: bytes.length,
      ...(shown
        ? { text: shown }
        : { note: 'The agent makes no text of a file of this type: only its name, type and size are given.' }),
    }
  }

  // ---- what the model reads of a feature in a conversation (TOOL-FEAT-021) -------------------------------------------

  /** One line of the limits of a space's tools for a feature: its id, title, provider and locations, or any value. */
  public limitsLine(
    featureId: string,
    featureTitle: string,
    providerTitle: string,
    profile: FeatureProfile,
    scope: LocationScope | undefined,
    mark: string
  ): string {
    const head = `- ${featureId}: ${featureTitle}, provided by ${providerTitle}`
    if (!scope || scope.kind === 'any') return scope ? `${head}, ${profile.location.labels.any.toLowerCase()}` : head
    if (scope.entries.length === 1) return `${head}, only ${scope.entries[0]?.label}`
    // with several, the model names one of them: each with its reference as the calls take it
    return `${head}, only ${scope.entries.map((e) => `${e.label} (${profile.location.argument}: ${marked(mark, e.value)})`).join('; ')}`
  }

  /** The scope of a feature's calls in a space, from its list (TOOL-FEAT-014); none limits a list without entries. */
  public static scopeOf(profile: FeatureProfile, list: SpaceToolList | undefined): LocationScope | undefined {
    if (list?.any) return { kind: 'any' }
    const entries = (list?.entries ?? []).flatMap((e) => {
      const value = e.values[profile.location.argument]
      return value ? [{ value, label: e.label }] : []
    })
    return entries.length ? { kind: 'list', entries } : undefined
  }
}
