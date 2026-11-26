/**
 * What the agent refuses to start on about features and their providers (ayni-spec D120 to D124, D145, D150; TOOL-FEAT-001
 * to 005, TOOL-FEAT-023, TOOL-AVAIL-002): the features of `tools.features`, the feature each source serves, at most one
 * provider of a feature in any space, the providers of a feature with a contract, and the features of each template.
 * Each refusal names the feature, the source or the template, and the field.
 */
import { hasProfilePrefix, KNOWN_PROFILES, knownProfile, parseVersion, profileTool } from '../features/profiles.js'
import type { AgentPack, ToolSourceDef } from './packTypes.js'

type Doc = Record<string, unknown>
const isObject = (value: unknown): value is Doc => !!value && typeof value === 'object' && !Array.isArray(value)

/** The members a feature's declaration of a tool of its profile may not hold: they are the profile's (TOOL-FEAT-005). */
const PROFILE_OWNED = ['effect', 'title', 'untrusted'] as const

/** A placeholder of the deployment's secrets, written whole (CORE-PACK-002): `${VAR}`. */
const WHOLE_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

/**
 * Before the schema, on the document as written (placeholders not yet resolved): a template's `tools`, withdrawn for its
 * `features` (D120), and a managing account whose values are not each a `${VAR}` of the deployment's secrets (D150,
 * TOOL-FEAT-023), refused in words.
 */
export function featureDocumentErrors(doc: unknown): string[] {
  const errors: string[] = []
  const templates = isObject(doc) && isObject(doc.spaces) ? doc.spaces.templates : undefined
  if (Array.isArray(templates))
    for (const template of templates)
      if (isObject(template) && template.tools !== undefined)
        errors.push(
          `spaces.templates.${String(template.id)}.tools is withdrawn: a template names its features, each with its providers (features: [{ feature, providers, default, add, guests }]) (D120, TOOL-AVAIL-002)`
        )
  const sources = isObject(doc) && isObject(doc.tools) && isObject(doc.tools.sources) ? doc.tools.sources : {}
  for (const [id, source] of Object.entries(sources)) {
    const manage = isObject(source) && isObject(source.manage) ? source.manage : undefined
    if (!manage || !Array.isArray(manage.apply)) continue
    for (const [i, header] of manage.apply.entries()) {
      const value = isObject(header) ? header.value : undefined
      if (typeof value !== 'string' || !WHOLE_PLACEHOLDER.test(value))
        errors.push(
          `tools.sources.${id}.manage.apply.${i}.value: the managing account comes from the deployment's secrets, each value one \${VAR} (D150, TOOL-FEAT-023)`
        )
    }
  }
  return errors
}

/** The feature of a source, and its definition, when the source names one the map holds. */
function featureOf(pack: AgentPack, source: ToolSourceDef) {
  return source.feature ? pack.tools?.features?.[source.feature] : undefined
}

/** Whether a source's feature has a contract the agent knows. */
function contractOf(pack: AgentPack, source: ToolSourceDef) {
  const profile = featureOf(pack, source)?.profile
  return profile ? knownProfile(profile.id, profile.version) : undefined
}

/** The features, the providers and the templates' entries (TOOL-FEAT-001 to 005, TOOL-FEAT-023, TOOL-AVAIL-002). */
export function featureErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const features = pack.tools?.features ?? {}
  const sources = Object.entries(pack.tools?.sources ?? {})
  const known = KNOWN_PROFILES.map((p) => `${p.id} ${p.major}.x`).join(', ')

  // TOOL-FEAT-001: each feature's profile is one the agent knows, by its id and major version, and names it alone
  const profileOwner = new Map<string, string>()
  for (const [id, feature] of Object.entries(features)) {
    const where = `tools.features.${id}`
    if (!feature.profile) {
      // a category's tools are its provider's own (D120): the rules of its tools are declared on the source
      if (feature.tools && Object.keys(feature.tools).length)
        errors.push(
          `${where}.tools: ${id} is a category, its provider's tools its own: declare them on the source (TOOL-FEAT-005)`
        )
      continue
    }
    const profile = knownProfile(feature.profile.id, feature.profile.version)
    if (!profile) {
      const parsed = parseVersion(feature.profile.version)
      errors.push(
        `${where}.profile: ${feature.profile.id} ${feature.profile.version} is no feature profile this agent knows${parsed ? '' : ' (a version is major.minor)'}; it knows ${known} (TOOL-FEAT-001)`
      )
      continue
    }
    const other = profileOwner.get(profile.id)
    if (other) errors.push(`${where}.profile: ${profile.id} is also the profile of ${other}: one feature per profile`)
    else profileOwner.set(profile.id, id)
    // TOOL-FEAT-005: a tool of the profile, its rule and step-up only
    for (const [tool, decl] of Object.entries(feature.tools ?? {})) {
      const at = `${where}.tools.${tool}`
      if (!profileTool(profile, tool)) {
        errors.push(`${at}: ${tool} is no tool of ${profile.id} ${profile.version} (TOOL-FEAT-005)`)
        continue
      }
      for (const member of PROFILE_OWNED)
        if ((decl as Record<string, unknown>)[member] !== undefined)
          errors.push(
            `${at}.${member}: the ${member} of a tool of a profile is the profile's, the same for every provider (TOOL-FEAT-005)`
          )
    }
  }

  // TOOL-FEAT-002: every MCP server and HTTP tool names the feature it serves; a bundled tool none
  for (const [id, source] of sources) {
    const where = `tools.sources.${id}`
    if (source.type === 'bundled') {
      if (source.feature !== undefined)
        errors.push(`${where}.feature: a bundled tool is the agent's own and serves no feature (TOOL-FEAT-002)`)
      continue
    }
    if (source.feature === undefined) {
      errors.push(
        `${where}.feature: every MCP server and HTTP tool names the feature it serves, a key of tools.features (TOOL-FEAT-002)`
      )
      continue
    }
    if (!features[source.feature]) {
      errors.push(`${where}.feature: ${source.feature} is not a key of tools.features (TOOL-FEAT-002)`)
      continue
    }
    const availability = source.availability ?? 'agent'
    const profile = contractOf(pack, source)
    if (!profile) {
      for (const key of ['capabilities', 'manage'] as const)
        if (source.type === 'mcp' && source[key] !== undefined)
          errors.push(
            `${where}.${key}: ${source.feature} has no contract: ${key} is for a provider of a feature profile (TOOL-FEAT-004, TOOL-FEAT-023)`
          )
      continue
    }
    // TOOL-FEAT-004: a provider of a feature with a contract is an MCP server of spaces or of Personal
    if (source.type !== 'mcp') {
      errors.push(
        `${where}.type: a provider of ${source.feature}, a feature with a contract, is an MCP server that speaks ${profile.id}, not an HTTP tool (TOOL-FEAT-004)`
      )
      continue
    }
    if (availability === 'agent')
      errors.push(
        `${where}.availability: a provider of ${source.feature}, a feature with a contract, is of availability spaces or personal, not agent (TOOL-FEAT-004)`
      )
    for (const capability of source.capabilities ?? [])
      if (!profile.capabilities.includes(capability))
        errors.push(
          `${where}.capabilities: ${capability} is no capability of ${profile.id} ${profile.version}; it has ${profile.capabilities.join(', ')} (TOOL-FEAT-004)`
        )
    for (const name of source.offer ?? [])
      if (hasProfilePrefix(profile, name))
        errors.push(
          `${where}.offer: ${name} has the prefix of ${profile.id}: the profile's tools are given by the profile, offer names the provider's extras (TOOL-FEAT-004)`
        )
    for (const [tool, decl] of Object.entries(source.tools ?? {})) {
      if (!hasProfilePrefix(profile, tool)) continue
      const members = Object.keys(decl ?? {})
      if (members.length)
        errors.push(
          `${where}.tools.${tool}.${members[0]}: what is said of a tool of ${profile.id} is said once, on the feature ${source.feature} (TOOL-FEAT-004, TOOL-FEAT-005)`
        )
    }
    const location = profile.location.argument
    for (const binding of source.bindings ?? [])
      if (binding.name === location || binding.argument === location)
        errors.push(
          `${where}.bindings.${binding.name}: ${location} is the location of ${profile.id}, bound as a list the owner picks, never a binding (TOOL-FEAT-004, TOOL-FEAT-014)`
        )
    // TOOL-FEAT-023: who may manage a team space's folder, with which account
    if (source.manage) {
      const at = `${where}.manage`
      if (profile.id !== 'org.ayni/files')
        errors.push(
          `${at}: the agent manages a team space's folder of Files only, not of ${source.feature} (TOOL-FEAT-023)`
        )
      if (availability !== 'spaces')
        errors.push(`${at}: a folder is managed for a team space: the source is of availability spaces (TOOL-FEAT-023)`)
      if (source.account?.kind !== 'personal')
        errors.push(
          `${at}: a folder is managed for the members' own accounts: the source's account is personal (TOOL-FEAT-023)`
        )
      if (source.manage.as === 'manager' && !source.manage.apply?.length)
        errors.push(`${at}.apply: as: manager builds the managing account's headers in apply (D150, TOOL-FEAT-023)`)
      if (source.manage.as === 'owner') {
        if (source.manage.apply)
          errors.push(`${at}.apply: as: owner manages with the space owner's own account, which builds nothing here`)
        const declaring = source.account?.from
          ? Object.entries(pack.tools?.sources ?? {}).find(([sid]) => sid === source.account?.from)?.[1]
          : source
        if (!declaring?.account?.oauth)
          errors.push(
            `${at}.as: owner manages with the owner's own account of an OAuth sign-in, which the source's account does not declare (TOOL-FEAT-023)`
          )
      }
    }
  }

  // TOOL-FEAT-003: at most one provider of a feature in any space, Personal included
  const everywhere = new Map<string, string[]>()
  for (const [id, source] of sources) {
    if (source.type === 'bundled' || !source.feature) continue
    const availability = source.availability ?? 'agent'
    if (availability === 'agent' || availability === 'personal')
      everywhere.set(source.feature, [...(everywhere.get(source.feature) ?? []), id])
  }
  const agentWide = new Map<string, string>()
  for (const [feature, ids] of everywhere) {
    if (ids.length > 1)
      errors.push(
        `tools.features.${feature}: ${ids.join(' and ')} would both be providers of ${feature} in Personal: a space uses one provider of a feature (TOOL-FEAT-003)`
      )
    const agentOne = ids.find((id) => (pack.tools?.sources?.[id]?.availability ?? 'agent') === 'agent')
    if (agentOne) agentWide.set(feature, agentOne)
  }

  // TOOL-AVAIL-002: the features of each template, each with providers of spaces that serve it
  for (const template of pack.spaces?.templates ?? []) {
    const named = new Set<string>()
    for (const [i, entry] of (template.features ?? []).entries()) {
      const where = `spaces.templates.${template.id}.features[${i}]`
      const feature = features[entry.feature]
      if (!feature) {
        errors.push(`${where}.feature: ${entry.feature} is not a key of tools.features (TOOL-AVAIL-002)`)
        continue
      }
      if (named.has(entry.feature))
        errors.push(
          `${where}.feature: ${entry.feature} is named twice in the template: a space uses one provider of a feature (TOOL-FEAT-003)`
        )
      named.add(entry.feature)
      const agentOne = agentWide.get(entry.feature)
      if (agentOne)
        errors.push(
          `${where}: ${agentOne}, of availability agent, already provides ${entry.feature} in every space: a space of ${template.id} would hold two providers of it (TOOL-FEAT-003)`
        )
      for (const provider of entry.providers) {
        const source = pack.tools?.sources?.[provider]
        if (!source) errors.push(`${where}.providers: ${provider} is not a key of tools.sources (TOOL-AVAIL-002)`)
        else if (source.type === 'bundled' || (source.availability ?? 'agent') !== 'spaces')
          errors.push(
            `${where}.providers: ${provider} is not of availability spaces: a template names providers of spaces only (TOOL-AVAIL-002)`
          )
        else if (source.feature !== entry.feature)
          errors.push(
            `${where}.providers: ${provider} serves ${source.feature ?? 'no feature'}, not ${entry.feature} (TOOL-AVAIL-002)`
          )
      }
      if (entry.default !== undefined && !entry.providers.includes(entry.default))
        errors.push(`${where}.default: ${entry.default} is not among its providers (TOOL-AVAIL-002)`)
      if (entry.add === 'auto' && entry.providers.length > 1 && entry.default === undefined)
        errors.push(
          `${where}.default: an entry added by itself with several providers names its default (TOOL-AVAIL-002)`
        )
      const profile = feature.profile ? knownProfile(feature.profile.id, feature.profile.version) : undefined
      // any value in place of a list: a provider of each member's own account, of a feature with a contract (TOOL-AVAIL-002)
      if (entry.any) {
        const takes = !!profile && entry.providers.some((p) => pack.tools?.sources?.[p]?.account?.kind === 'personal')
        if (!takes)
          errors.push(
            `${where}.any: no provider of the entry can take any value: one used with each person's own account, of a feature with a contract (TOOL-AVAIL-002, TOOL-SPACE-014)`
          )
      }
      // TOOL-FEAT-023: the modes of Files a template's spaces may use
      if (entry.location !== undefined) {
        if (profile?.id !== 'org.ayni/files')
          errors.push(`${where}.location: the mode of a location is for Files only (TOOL-FEAT-023)`)
        else if (template.kind === 'organization' && entry.location !== 'existing')
          errors.push(
            `${where}.location: a space of the whole organization uses a folder that exists: location is existing (TOOL-FEAT-023)`
          )
        else if (
          entry.location === 'managed' &&
          !entry.providers.some((p) => (pack.tools?.sources?.[p] as { manage?: unknown } | undefined)?.manage)
        )
          errors.push(`${where}.location: managed, and no provider of the entry declares manage (TOOL-FEAT-023)`)
      }
    }
  }
  return errors
}

/**
 * What the agent leaves to the operator's judgment about features (TOOL-AVAIL-002): a source of spaces that no template
 * names as a provider.
 */
export function featureWarnings(pack: AgentPack): string[] {
  const warnings: string[] = []
  const named = new Set((pack.spaces?.templates ?? []).flatMap((t) => (t.features ?? []).flatMap((e) => e.providers)))
  for (const [id, source] of Object.entries(pack.tools?.sources ?? {})) {
    if (source.type === 'bundled') continue
    if (source.availability === 'spaces' && !named.has(id))
      warnings.push(
        `tools.sources.${id}: a source of availability spaces that no template names as a provider of its feature: no space can use it (TOOL-AVAIL-002)`
      )
  }
  return warnings
}
