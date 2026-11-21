/**
 * Agent-pack loader (CORE-PACK-001..004, docs/agent-pack.md "Loading"):
 * read, substitute ${VAR} placeholders, coerce by schema, validate, apply cross-field rules.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'
import { fieldsNamedBy } from '../tools/accountValues.js'
import type {
  AgentPack,
  AuthenticationEntry,
  BundledName,
  EvidencePolicy,
  SourceAccount,
  SpaceTemplate,
  ToolAccess,
  ToolSourceDef,
} from './packTypes.js'
import {
  ACCOUNT_KINDS,
  AVAILABILITIES,
  BUNDLED_NAMES,
  BUNDLED_TOOLS,
  bundledEnabled,
  bundledSource,
  CALL_RULES,
  COMPUTED_FUNCTIONS,
  challengeTypesOf,
  DOCUMENT_ATTRIBUTES,
  EMAIL_ATTRIBUTES,
  featuresOf,
  PERSONAL_RETENTION_DAYS,
  providerNameOf,
  RESERVED_ACCOUNT_KINDS,
  SOURCE_TYPES,
  TOOL_EFFECTS,
  takesClaimsFromDirectory,
} from './packTypes.js'

/** The entry of the credential that authenticates a person (D65): never the name of a catalog entry. */
export const AUTHENTICATION_ENTRY = 'authentication'
/** The entry under which a document read is kept as evidence: the `document` evidence kind (D73). */
export const DOCUMENT_ENTRY = 'document'
/** The entry under which an address verified by an email code is kept as evidence: the `email` evidence kind (D89). */
export const EMAIL_ENTRY = 'email'
/** The attributes of a document read the matching of a directory entry reads (IDENT-DIR-003). */
export const DIRECTORY_MATCH_ATTRIBUTES = ['lastName', 'firstName', 'dateOfBirth', 'nationality'] as const

export class PackError extends Error {
  public constructor(
    message: string,
    public readonly details: string[] = []
  ) {
    super(details.length ? `${message}\n  - ${details.join('\n  - ')}` : message)
    this.name = 'PackError'
  }
}

const PACK_FILES = ['agent-pack.yaml', 'agent-pack.yml', 'agent-pack.json']
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

export function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [
    join(here, '../../schemas/agent-pack.schema.json'),
    join(process.cwd(), 'schemas/agent-pack.schema.json'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new PackError('schemas/agent-pack.schema.json not found')
}

export function loadSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaPath(), 'utf8'))
}

/** Replaces ${VAR} and ${VAR:-default} in every string of the document (CORE-PACK-002). */
export function substitutePlaceholders(value: unknown, env: Record<string, string | undefined>, path = '$'): unknown {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_m, name: string, fallback: string | undefined) => {
      const found = env[name]
      if (found !== undefined && found !== '') return found
      if (fallback !== undefined) return fallback
      throw new PackError(`${path}: placeholder \${${name}} has no value and no default`)
    })
  }
  if (Array.isArray(value)) return value.map((item, i) => substitutePlaceholders(item, env, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitutePlaceholders(v, env, `${path}.${k}`)
    }
    return out
  }
  return value
}

type Schema = Record<string, unknown>

function resolveRef(root: Schema, ref: string): Schema {
  const parts = ref.replace(/^#\//, '').split('/')
  let node: unknown = root
  for (const part of parts) node = (node as Record<string, unknown>)?.[part]
  return (node ?? {}) as Schema
}

/**
 * The properties of the branches of `allOf` whose `if` the value meets, an `if` on constant properties only: those of a
 * source's type (`type: mcp`, D101), so that its connection is coerced too.
 */
function branchProperties(value: object, schema: Schema, root: Schema): Record<string, Schema> {
  const out: Record<string, Schema> = {}
  for (const branch of (schema.allOf ?? []) as Schema[]) {
    const test = (branch.if as Schema | undefined)?.properties as Record<string, Schema> | undefined
    if (!test || !branch.then) continue
    const meets = Object.entries(test).every(([k, s]) => (value as Record<string, unknown>)[k] === s.const)
    if (!meets) continue
    let then = branch.then as Schema
    if (then.$ref) then = resolveRef(root, then.$ref as string)
    Object.assign(out, (then.properties ?? {}) as Record<string, Schema>)
  }
  return out
}

/** Coerces strings into the number, boolean or list the schema expects (docs/agent-pack.md step 3). */
export function coerceBySchema(value: unknown, schema: Schema, root: Schema): unknown {
  if (schema.$ref) return coerceBySchema(value, resolveRef(root, schema.$ref as string), root)
  const types = ([] as unknown[]).concat(schema.type ?? [])
  const alternatives = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined
  if (alternatives && typeof value === 'string') {
    for (const alt of alternatives) {
      const coerced = coerceBySchema(value, alt, root)
      if (coerced !== value) return coerced
    }
  }
  if (typeof value === 'string') {
    if (types.includes('integer') || types.includes('number')) {
      const n = Number(value)
      if (value.trim() !== '' && Number.isFinite(n)) return n
    }
    if (types.includes('boolean')) {
      if (/^(true|yes|1)$/i.test(value)) return true
      if (/^(false|no|0)$/i.test(value)) return false
    }
    if (types.includes('array')) {
      const items = (schema.items ?? {}) as Schema
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => coerceBySchema(s, items, root))
    }
    return value
  }
  if (Array.isArray(value)) {
    const items = (schema.items ?? {}) as Schema
    return value.map((item) => coerceBySchema(item, items, root))
  }
  if (value && typeof value === 'object') {
    const props = { ...((schema.properties ?? {}) as Record<string, Schema>), ...branchProperties(value, schema, root) }
    const additional = schema.additionalProperties
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sub = props[k] ?? (additional && typeof additional === 'object' ? (additional as Schema) : undefined)
      out[k] = sub ? coerceBySchema(v, sub, root) : v
    }
    return out
  }
  return value
}

/** The bundled tools the model may be given, by their names (TOOL-HTTP-002): a source names each, or its default holds. */
export function bundledToolNames(pack: AgentPack): string[] {
  const on = (name: BundledName) => bundledEnabled(pack, name)
  const names: string[] = []
  if (on('statistics')) names.push('statistics')
  if (on('generateImage')) names.push('generate_image')
  if (on('principalCredentials')) names.push('principal_credentials')
  const asksOnDemand = Object.values(pack.presentations ?? {}).some((e) => e.request === 'on-demand')
  if (on('requestPresentation') && (pack.identity.authentication?.length || asksOnDemand))
    names.push('request_presentation')
  if (on('credentialIssuance') && Object.keys(pack.issuance ?? {}).length) {
    names.push('credential_requirements')
    if (Object.values(pack.issuance ?? {}).some((p) => (p.trigger ?? 'model') === 'model'))
      names.push('issue_credential')
  }
  if (on('principalPreferences')) names.push('principal_preferences')
  if (on('workingMemory')) names.push('working_memory')
  return names
}

/** A model-visible attribute must be stored, and a stored attribute must be among those asked (PRIV-EVID-006). */
function evidencePolicyErrors(where: string, policy: EvidencePolicy, requested: string[] | undefined): string[] {
  const errors: string[] = []
  const stored = policy.store?.attributes ?? []
  const notStored = (policy.modelVisible ?? []).filter((a) => !stored.includes(a))
  if (notStored.length) {
    errors.push(`PRIV-EVID-006: ${where} makes [${notStored.join(', ')}] visible to the model without storing them`)
  }
  const notAsked = requested ? stored.filter((a) => !requested.includes(a)) : []
  if (notAsked.length) errors.push(`PRIV-EVID-006: ${where} stores [${notAsked.join(', ')}] without asking for them`)
  return errors
}

/**
 * What the pack leaves to the operator's judgment: a model-visible attribute enters the conversation, so a
 * shorter retention than conversation memory's cannot be honoured for it (PRIV-EVID-006).
 */
export function evidenceWarnings(pack: AgentPack): string[] {
  const conversation = pack.privacy.processingActivities.find((a) => a.id === 'conversation-memory')?.retention?.days
  const warnings: string[] = []
  const policies: [string, EvidencePolicy][] = [
    ...(pack.identity.authentication ?? []).map((e): [string, EvidencePolicy] => ['identity.authentication', e]),
    ...Object.entries(pack.presentations ?? {}).map(([n, e]): [string, EvidencePolicy] => [`presentations.${n}`, e]),
    ...(pack.evidence?.document ? [['evidence.document', pack.evidence.document] as [string, EvidencePolicy]] : []),
  ]
  for (const [where, entry] of policies) {
    const days = entry.store?.retention?.days
    if (!entry.modelVisible?.length || days === undefined) continue
    if (conversation === undefined || days < conversation) {
      const kept = conversation === undefined ? 'as long as it is kept' : `${conversation} days`
      warnings.push(
        `${where} keeps [${entry.modelVisible.join(', ')}] ${days} days but lets the model read them: what the model reads stays in the conversation for ${kept}`
      )
    }
  }
  return warnings
}

/**
 * What an authentication entry may not say (D72, IDENT-RES-010): `on-demand` lets guests in by itself; a list of
 * organizations is not empty and holds organization keys; how the credential is obtained is a text, an https
 * link, or both.
 */
export function authenticationErrors(entry: AuthenticationEntry): string[] {
  const errors: string[] = []
  if (entry.request === 'on-demand' && entry.guests === false)
    errors.push('rule 1: identity.authentication asked on-demand lets guests in: guests cannot be false')
  const organizations = entry.issuers?.organizations
  if (organizations !== undefined) {
    if (!organizations.length)
      errors.push(
        'rule 1: identity.authentication.issuers.organizations is empty: it would accept nobody; leave it out to accept any accredited issuer'
      )
    const unkeyed = organizations.filter((key) => !/^org:[A-Z]{2}:.+$/.test(key))
    if (unkeyed.length)
      errors.push(
        `rule 1: identity.authentication.issuers.organizations [${unkeyed.join(', ')}] must be organization keys, org:<country>:<register id>`
      )
  }
  if (entry.obtain) {
    if (!entry.obtain.text && !entry.obtain.url)
      errors.push('rule 1: identity.authentication.obtain says a text, a link, or both')
    if (entry.obtain.url && !entry.obtain.url.startsWith('https://'))
      errors.push('rule 1: identity.authentication.obtain.url must be an https link')
  }
  return errors
}

/**
 * What a role may no longer say (RBAC-XSESS-005, decision 60): a role carries no scope of conversation reads, so
 * `crossSession` is withdrawn, whatever its value. Said in words before the schema, which would only name the key.
 */
export function removedCrossSessionErrors(doc: unknown): string[] {
  const roles = (doc as { identity?: { roles?: Record<string, { crossSession?: unknown }> } })?.identity?.roles
  if (!roles || typeof roles !== 'object') return []
  return Object.entries(roles)
    .filter(([, role]) => role && typeof role === 'object' && role.crossSession !== undefined)
    .map(
      ([name, role]) =>
        `identity.roles.${name}.crossSession (${JSON.stringify(role.crossSession)}) is withdrawn: no role reads other people's conversations (RBAC-XSESS-005); remove it. A conversation is read by its author, by the active members of its space when its author shares it, and by an auditor through the admin interface (RBAC-XSESS-007)`
    )
}

/**
 * The people of the user directory are never written in the agent-pack (IDENT-ROLE-012, D79): the pack is versioned
 * with the deployment and its history would keep every former employee. A pack that lists people, under
 * `identity.directory` or beside it, is refused in words, before the schema, which would only name the key.
 */
export function inlineDirectoryErrors(doc: unknown): string[] {
  const identity = (doc as { identity?: Record<string, unknown> })?.identity
  if (!identity || typeof identity !== 'object') return []
  const fix =
    'the people of the user directory are never written in the agent-pack (IDENT-ROLE-012, D79): mount the list from a secret of the deployment and name its file with identity.directory.file'
  const errors: string[] = []
  const directory = identity.directory
  if (Array.isArray(directory)) errors.push(`identity.directory is a list of people: ${fix}`)
  else if (directory && typeof directory === 'object') {
    for (const [key, value] of Object.entries(directory as Record<string, unknown>))
      if (key !== 'file' && (Array.isArray(value) || key === 'people' || key === 'entries'))
        errors.push(`identity.directory.${key}: ${fix}`)
  }
  for (const key of ['people', 'users', 'employees'])
    if (identity[key] !== undefined) errors.push(`identity.${key}: ${fix}`)
  return errors
}

/**
 * What an issuance profile may say of its challenges and of the user directory (IDENT-DIR-002, INTX-AUTH-011,
 * INTX-ISSUE-019/020/021, D88, D89).
 */
export function issuanceChallengeErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const document = pack.evidence?.document
  const email = pack.evidence?.email
  for (const [name, profile] of Object.entries(pack.issuance ?? {})) {
    const where = `issuance.${name}`
    const types = challengeTypesOf(profile)
    const fromDirectory = takesClaimsFromDirectory(profile)
    const sources = Object.values(profile.claims)
    if (fromDirectory) {
      // IDENT-DIR-002: a document read, an email code, or both, in this order
      const allowed = ['document', 'email', 'document,email']
      if (!allowed.includes(types.join(',')))
        errors.push(
          `IDENT-DIR-002: ${where} takes claims from the user directory: its challenges are [document], [email] or [document, email], in this order (it declares [${types.join(', ')}])`
        )
      if (!pack.identity.directory)
        errors.push(
          `IDENT-DIR-002: ${where} takes claims from the user directory, and identity.directory names no file`
        )
      if (types.includes('document')) {
        const unkept = DIRECTORY_MATCH_ATTRIBUTES.filter((a) => !document?.store?.attributes.includes(a))
        if (unkept.length)
          errors.push(
            `IDENT-DIR-003: ${where} finds the entry of a passport: evidence.document must store [${unkept.join(', ')}]`
          )
      }
    } else {
      if (types.includes('email'))
        errors.push(
          `INTX-AUTH-011: ${where} declares an email challenge and takes no claim from the user directory: the email code belongs to a badge from the directory only`
        )
      if (types.length > 1)
        errors.push(`INTX-ISSUE-010: ${where} declares several challenges: only a badge from the directory does`)
    }
    if (types.includes('email')) {
      if (!email?.store?.attributes.includes('address'))
        errors.push(
          `INTX-AUTH-015: ${where} declares an email challenge: evidence.email must store [address], from which the entry and the badge number are found`
        )
      // the model is told the outcome of the check, never the address (INTX-AUTH-015)
      if (profile.trigger === 'automatic')
        errors.push(
          `INTX-AUTH-012: ${where} declares an email challenge and is automatic: the email check is served in a conversation the person started`
        )
    }
    const usesEmail = sources.some(
      (s) => (s.from === 'computed' && s.fn === 'emailId') || (s.from === 'evidence' && s.entry === EMAIL_ENTRY)
    )
    if (usesEmail && !types.includes('email'))
      errors.push(
        `INTX-ISSUE-020: ${where} takes a claim from a verified address and declares no email challenge: nothing would verify it`
      )
    for (const [claim, source] of Object.entries(profile.claims)) {
      if (source.from === 'evidence' && source.as === 'dateint' && source.entry === DOCUMENT_ENTRY) {
        if (!['dateOfBirth', 'dateOfExpiry'].includes(source.attribute))
          errors.push(
            `IDENT-DIR-005: ${where}.claims.${claim} writes ${source.attribute} as a dateint, and it is not a date of the document`
          )
      }
    }
  }
  if (email?.modelVisible?.length)
    errors.push('INTX-AUTH-015: evidence.email.modelVisible: the model is never told the verified address')
  if (email) {
    const outside = (email.store?.attributes ?? []).filter((a) => !(EMAIL_ATTRIBUTES as readonly string[]).includes(a))
    if (outside.length)
      errors.push(
        `INTX-AUTH-015: evidence.email stores [${outside.join(', ')}]: an email check has one attribute, address`
      )
  }
  return errors
}

type Doc = Record<string, unknown>

const isObject = (value: unknown): value is Doc => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The keys a pack may no longer use (D101, TOOL-CAT-011): every source is one entry of `tools.sources`, its tier model is
 * its `access`, and a tool's step-up is in its own source. Each is refused in words before the schema, which would only
 * name the key, with the key that replaces it.
 */
export function withdrawnToolKeyErrors(doc: unknown): string[] {
  const d = isObject(doc) ? doc : {}
  const errors: string[] = []
  const named = (list: unknown, key: string): string[] =>
    Array.isArray(list)
      ? list.map((item, i) => (isObject(item) && typeof item[key] === 'string' ? (item[key] as string) : `#${i}`))
      : []
  if (d.mcp !== undefined) {
    const servers = named(isObject(d.mcp) ? d.mcp.servers : undefined, 'name')
    const fix =
      'declare each MCP server as an entry of tools.sources keyed by its name, with type: mcp, and its toolAccess as access (D101, TOOL-CAT-011)'
    if (servers.length) for (const name of servers) errors.push(`mcp.servers.${name} is withdrawn: ${fix}`)
    else errors.push(`mcp is withdrawn: ${fix}`)
  }
  const tools = isObject(d.tools) ? d.tools : {}
  if (tools.http !== undefined) {
    const fix =
      'declare each HTTP tool as an entry of tools.sources keyed by its name, with type: http (D101, TOOL-CAT-011)'
    const names = named(tools.http, 'name')
    if (names.length) for (const name of names) errors.push(`tools.http.${name} is withdrawn: ${fix}`)
    else errors.push(`tools.http is withdrawn: ${fix}`)
  }
  if (tools.bundled !== undefined) {
    const keys = isObject(tools.bundled) ? Object.keys(tools.bundled) : []
    const fix = (key: string) =>
      `declare it as an entry of tools.sources with type: bundled and bundled: ${key} (D101, TOOL-CAT-011)`
    if (keys.length) for (const key of keys) errors.push(`tools.bundled.${key} is withdrawn: ${fix(key)}`)
    else errors.push(`tools.bundled is withdrawn: ${fix('<its name>')}`)
  }
  if (tools.access !== undefined)
    errors.push(
      'tools.access is withdrawn: each source declares the tier model of its own tools in tools.sources.<id>.access (D101, TOOL-CAT-011)'
    )
  if (d.actions !== undefined) {
    const entries = isObject(d.actions) ? Object.keys(d.actions) : []
    if (entries.length)
      for (const tool of entries)
        errors.push(
          `actions.${tool} is withdrawn: declare its step-up in the source of the tool, as tools.sources.<id>.tools.${tool}.stepUp (D101, TOOL-CAT-011)`
        )
    else
      errors.push(
        "actions is withdrawn: a tool's step-up is tools.sources.<id>.tools.<tool>.stepUp (D101, TOOL-CAT-011)"
      )
  }
  return errors
}

/** Every source of a pack document before the schema: an entry of `tools.sources`, where it is written (TOOL-CAT-001). */
function docSources(doc: unknown): { where: string; name: string; type: unknown; body: Doc }[] {
  const tools = isObject(doc) && isObject(doc.tools) ? doc.tools : {}
  const sources = isObject(tools.sources) ? tools.sources : {}
  return Object.entries(sources).map(([name, value]) => {
    const body = isObject(value) ? value : {}
    return { where: `tools.sources.${name}`, name, type: body.type, body }
  })
}

/**
 * The email code belongs to the issuance profiles that take claims from the user directory and to no tool
 * (INTX-AUTH-011): a step-up that declares it is refused in words, before the schema, which would only name the value.
 */
export function emailChallengeStepUpErrors(doc: unknown): string[] {
  const errors: string[] = []
  for (const { where, body } of docSources(doc)) {
    if (!isObject(body.tools)) continue
    for (const [tool, decl] of Object.entries(body.tools)) {
      const challenge = isObject(decl) && isObject(decl.stepUp) ? decl.stepUp.authChallenge : undefined
      if (isObject(challenge) && challenge.type === 'email')
        errors.push(
          `${where}.tools.${tool}.stepUp.authChallenge: the email code is the challenge of an issuance profile that takes claims from the user directory, and of no tool (INTX-AUTH-011)`
        )
    }
  }
  return errors
}

/** A text as the agent-pack would write it in a flow mapping: quoted when YAML would read it otherwise. */
function yamlText(value: unknown): string {
  const text = String(value)
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(text) ? text : JSON.stringify(text)
}

/**
 * The keys of an account that named fields replaced (D102, TOOL-CAT-012): `label` and `pattern`, now each field's, and
 * `apply` as one header with its `prefix`, now a list of headers built from the fields. Each is refused in words before
 * the schema, which would only name the key, with the form that replaces it, written from what the account declares.
 */
export function withdrawnAccountKeyErrors(doc: unknown): string[] {
  const errors: string[] = []
  for (const { where, body } of docSources(doc)) {
    if (!isObject(body.account)) continue
    const account = body.account
    const apply = isObject(account.apply) ? account.apply : undefined
    if (account.label === undefined && account.pattern === undefined && !apply) continue
    const label = account.label !== undefined ? yamlText(account.label) : 'API token'
    const pattern = account.pattern !== undefined ? `, pattern: ${JSON.stringify(String(account.pattern))}` : ''
    const fields = `fields: [{ name: token, label: ${label}${pattern} }]`
    if (account.label !== undefined)
      errors.push(
        `${where}.account.label is withdrawn: a space account declares the fields its owner fills, each with its own label, as account.${fields} (D102, TOOL-CAT-012)`
      )
    if (account.pattern !== undefined)
      errors.push(
        `${where}.account.pattern is withdrawn: each field carries the pattern of its own value, as account.${fields} (D102, TOOL-CAT-012)`
      )
    if (apply) {
      const header = typeof apply.header === 'string' ? apply.header : 'Authorization'
      const prefix = typeof apply.prefix === 'string' ? apply.prefix : ''
      errors.push(
        `${where}.account.apply as one header with its prefix is withdrawn: account.apply is a list of headers, each a header and a value that names the fields as {name}, as apply: [{ header: ${header}, value: ${JSON.stringify(`${prefix}{token}`)} }] with ${fields} (D102, TOOL-CAT-012)`
      )
    }
  }
  return errors
}

/**
 * The kinds of account of the later phases (TOOL-CAT-002, O28, O29): a source that declares `personal` or `organization`
 * is refused in words, before the schema, which would only name the value.
 */
export function reservedAccountErrors(doc: unknown): string[] {
  const errors: string[] = []
  for (const { where, body } of docSources(doc)) {
    const kind = isObject(body.account) ? body.account.kind : undefined
    if (kind === 'personal')
      errors.push(
        `${where}.account.kind: personal is not available in this version: each person's own accounts come in phase 2 of the tools (TOOL-CAT-002, O28); use none, agent or space`
      )
    else if (kind === 'organization')
      errors.push(
        `${where}.account.kind: organization is not available in this version: the accounts the organization opens come in phase 3 of the tools (TOOL-CAT-002, O29); use none, agent or space`
      )
  }
  return errors
}

/**
 * What a source of the catalog may say, in words before the schema (TOOL-CAT-001/002, D101): a known type and a known
 * value for each of its answers; for an HTTP tool, declarations of its one tool only, named by the source's id; for a
 * bundled tool, a bundled tool no other source names, no account, and declarations of its own tools, with no effect and no
 * trust. Each refusal names the source and the field.
 */
export function catalogValueErrors(doc: unknown): string[] {
  const errors: string[] = []
  const one = (where: string, field: string, value: unknown, allowed: readonly string[]) => {
    if (value !== undefined && !allowed.includes(value as string))
      errors.push(`${where}.${field}: ${JSON.stringify(value)} is not one of ${allowed.join(', ')} (TOOL-CAT-001)`)
  }
  const bundledBy = new Map<string, string>()
  for (const { where, name, type, body } of docSources(doc)) {
    if (type === undefined) {
      errors.push(`${where}.type: a source says its type: mcp, http or bundled (TOOL-CAT-001)`)
      continue
    }
    if (!(SOURCE_TYPES as readonly unknown[]).includes(type)) {
      one(where, 'type', type, SOURCE_TYPES)
      continue
    }
    one(where, 'availability', body.availability, AVAILABILITIES)
    const declared = isObject(body.tools) ? body.tools : {}
    for (const [tool, decl] of Object.entries(declared)) {
      const d = isObject(decl) ? decl : {}
      one(where, `tools.${tool}.effect`, d.effect, TOOL_EFFECTS)
      one(where, `tools.${tool}.call`, d.call, CALL_RULES)
    }
    if (type === 'bundled') {
      const bundled = body.bundled
      if (bundled === undefined) {
        errors.push(`${where}.bundled: a bundled source names its bundled tool: ${BUNDLED_NAMES.join(', ')}`)
        continue
      }
      one(where, 'bundled', bundled, BUNDLED_NAMES)
      if (!(BUNDLED_NAMES as readonly unknown[]).includes(bundled)) continue
      const other = bundledBy.get(bundled as string)
      if (other)
        errors.push(`${where}.bundled: ${String(bundled)} is also named by ${other}: one source per bundled tool`)
      else bundledBy.set(bundled as string, where)
      if (body.account !== undefined)
        errors.push(`${where}.account: a bundled tool's account is none and is not declared (TOOL-CAT-002)`)
      const own: readonly string[] = BUNDLED_TOOLS[bundled as BundledName]
      for (const [tool, decl] of Object.entries(declared)) {
        if (!own.includes(tool))
          errors.push(
            `${where}.tools.${tool}: ${String(bundled)} gives the model ${own.join(' and ')}, not ${tool} (TOOL-CAT-001)`
          )
        const d = isObject(decl) ? decl : {}
        if (d.effect !== undefined)
          errors.push(`${where}.tools.${tool}.effect: a bundled tool has no effect (TOOL-CAT-006)`)
        if (d.untrusted !== undefined)
          errors.push(`${where}.tools.${tool}.untrusted: a bundled tool is trusted (TOOL-CAT-008)`)
      }
      continue
    }
    const account = isObject(body.account) ? body.account : undefined
    if (account && !(RESERVED_ACCOUNT_KINDS as readonly unknown[]).includes(account.kind))
      one(where, 'account.kind', account.kind, ACCOUNT_KINDS)
    if (type === 'http')
      for (const tool of Object.keys(declared))
        if (tool !== name)
          errors.push(
            `${where}.tools.${tool}: an HTTP tool is one tool, named by its source's id: tools declares ${name} only (TOOL-CAT-001)`
          )
  }
  const templates = isObject(doc) && isObject(doc.spaces) ? doc.spaces.templates : undefined
  if (Array.isArray(templates))
    for (const template of templates) {
      const t = isObject(template) ? template : {}
      if (!Array.isArray(t.tools)) continue
      for (const [i, entry] of (t.tools as Doc[]).entries())
        one(`spaces.templates.${String(t.id)}.tools[${i}]`, 'add', entry?.add, ['auto', 'owner'])
    }
  return errors
}

/** Whether a text is a regular expression the agent can use. */
function regexError(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined
  try {
    new RegExp(pattern)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The fields of a space account and the headers built from them (D102, TOOL-CAT-002): a name unique in the account, a
 * pattern that is a regular expression, a header declared once, a value that names declared fields only, and every field
 * named by at least one value.
 */
function accountFieldErrors(where: string, account: SourceAccount): string[] {
  const errors: string[] = []
  const names = new Set<string>()
  for (const field of account.fields ?? []) {
    const at = `${where}.account.fields.${field.name}`
    if (names.has(field.name)) errors.push(`${at}: a field's name is unique in its account (TOOL-CAT-002)`)
    names.add(field.name)
    const bad = regexError(field.pattern)
    if (bad) errors.push(`${at}.pattern is not a regular expression: ${bad}`)
  }
  const used = new Set<string>()
  const headers = new Set<string>()
  for (const [i, entry] of (account.apply ?? []).entries()) {
    const at = `${where}.account.apply[${i}]`
    const header = entry.header.toLowerCase()
    if (headers.has(header)) errors.push(`${at}.header: ${entry.header} is declared twice (TOOL-CAT-002)`)
    headers.add(header)
    for (const name of fieldsNamedBy(entry.value)) {
      if (names.has(name)) used.add(name)
      else
        errors.push(
          `${at}.value names {${name}}, which is not a field of the account: declare it in account.fields, or name one of ${[...names].join(', ') || 'its fields'} (TOOL-CAT-002)`
        )
    }
  }
  for (const name of names)
    if (!used.has(name))
      errors.push(
        `${where}.account.fields.${name}: no header of account.apply names {${name}}: every field is sent (TOOL-CAT-002)`
      )
  return errors
}

/** The account, availability and bindings of one source (TOOL-CAT-002/004/005, TOOL-AVAIL-003). */
function sourceErrors(where: string, source: ToolSourceDef): string[] {
  const errors: string[] = []
  const account = source.account
  const availability = source.availability ?? 'agent'
  if (account?.kind === 'space') {
    if (!account.fields?.length)
      errors.push(
        `${where}.account.fields: a space account declares the fields its owner fills, one or more (TOOL-CAT-002)`
      )
    if (!account.apply?.length)
      errors.push(
        `${where}.account.apply: a space account declares the headers its calls carry, built from its fields (TOOL-CAT-002)`
      )
    errors.push(...accountFieldErrors(where, account))
    if (availability !== 'spaces')
      errors.push(
        `${where}.availability: a source whose account is space is of availability spaces, not ${availability} (TOOL-AVAIL-003)`
      )
    if (source.type === 'mcp' && source.transport === 'stdio')
      errors.push(
        `${where}.transport: a space account reaches a remote MCP server (sse or streamable-http), never a stdio one (TOOL-AVAIL-003)`
      )
  } else if (account && (account.fields || account.apply))
    errors.push(`${where}.account: fields and apply belong to a space account only (TOOL-CAT-002)`)
  const names = new Set<string>()
  for (const binding of source.type === 'bundled' ? [] : (source.bindings ?? [])) {
    const at = `${where}.bindings.${binding.name}`
    if (names.has(binding.name)) errors.push(`${at}: a binding's name is unique in its source (TOOL-CAT-004)`)
    names.add(binding.name)
    const wrong = regexError(binding.pattern)
    if (wrong) errors.push(`${at}.pattern is not a regular expression: ${wrong}`)
    else if (binding.value !== undefined && binding.pattern && !new RegExp(binding.pattern).test(binding.value))
      errors.push(`${at}.value does not match its pattern (TOOL-CAT-004)`)
    if (availability !== 'spaces' && binding.value === undefined)
      errors.push(
        `${at}.value: a source of availability ${availability} takes the value of every binding from the agent-pack (TOOL-CAT-005)`
      )
  }
  return errors
}

/** The tools of a source the pack can name before any discovery: an HTTP tool's own, a bundled tool's; none for MCP. */
export function declaredToolsOf(id: string, source: ToolSourceDef): readonly string[] | undefined {
  if (source.type === 'http') return [id]
  if (source.type === 'bundled') return BUNDLED_TOOLS[source.bundled]
  return undefined
}

/**
 * The catalog of tool sources (TOOL-CAT, TOOL-AVAIL, D96 to D99, D101): accounts, availability, bindings, the templates
 * that offer the sources of spaces, the approvers of a rule `approval`.
 */
export function catalogErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const availabilityOf = new Map<string, string>()
  for (const [id, source] of Object.entries(pack.tools?.sources ?? {})) {
    const where = `tools.sources.${id}`
    errors.push(...sourceErrors(where, source))
    availabilityOf.set(id, source.availability ?? 'agent')
    if (source.type === 'mcp' && source.offer && new Set(source.offer).size !== source.offer.length)
      errors.push(`${where}.offer names a tool twice (TOOL-CAT-003)`)
    // a tool of the spaces is approved by the space's owner, never by roles (TOOL-CAT-009)
    if (source.availability === 'spaces')
      for (const entry of source.access?.approval ?? [])
        errors.push(
          `${where}.access.approval names [${entry.tools.join(', ')}], tools of availability spaces: a space's owner approves them (TOOL-CAT-009)`
        )
  }
  // the templates name sources of spaces only (TOOL-AVAIL-002)
  for (const template of pack.spaces?.templates ?? []) {
    const named = new Set<string>()
    for (const [i, entry] of (template.tools ?? []).entries()) {
      const where = `spaces.templates.${template.id}.tools[${i}]`
      const availability = availabilityOf.get(entry.source)
      if (availability === undefined)
        errors.push(`${where}.source: ${entry.source} is not a key of tools.sources (TOOL-AVAIL-002)`)
      else if (availability !== 'spaces')
        errors.push(
          `${where}.source: ${entry.source} is of availability ${availability}: a template names sources of availability spaces only (TOOL-AVAIL-002)`
        )
      if (named.has(entry.source)) errors.push(`${where}.source: ${entry.source} is named twice in the template`)
      named.add(entry.source)
    }
  }
  // the roles that approve a tool of the whole agent or of Personal (TOOL-CAT-009)
  const roles = pack.identity.roles ?? {}
  for (const role of pack.approvals?.approvers ?? []) {
    if (!roles[role]) errors.push(`rule 2: role "${role}" in approvals.approvers is not declared in identity.roles`)
    else if (!roles[role]?.canApprove)
      errors.push(`rule 3: approver role "${role}" in approvals.approvers has no canApprove`)
  }
  return errors
}

/**
 * What the catalog leaves to the operator's judgment (TOOL-AVAIL-002, TOOL-CAT-009): a source of spaces that no template
 * names, and a tool whose rule the agent-pack sets to approval with no approver, whose calls are refused (`no-approver`).
 */
export function catalogWarnings(pack: AgentPack): string[] {
  const warnings: string[] = []
  const named = new Set((pack.spaces?.templates ?? []).flatMap((t) => (t.tools ?? []).map((e) => e.source)))
  const sources = Object.entries(pack.tools?.sources ?? {})
  for (const [id, source] of sources)
    if (source.type !== 'bundled' && source.availability === 'spaces' && !named.has(id))
      warnings.push(
        `tools.sources.${id}: a source of availability spaces that no template of spaces names: no space can use it (TOOL-AVAIL-002)`
      )
  const fallback = pack.approvals?.approvers ?? []
  const noApprover = (where: string, tool: string) =>
    warnings.push(
      `${where}: the rule of ${tool} is approval and no role approves it (no access.approval entry of its source lists it, approvals.approvers is empty): its calls are refused as no-approver (TOOL-CAT-009)`
    )
  for (const [id, source] of sources) {
    if (source.type === 'bundled' || (source.availability ?? 'agent') === 'spaces' || fallback.length) continue
    const listed = (tool: string) => source.access?.approval?.some((r) => r.tools.includes(tool))
    if (source.type === 'http') {
      if (listed(id)) continue
      const decl = source.tools?.[id]
      const effect =
        decl?.effect ?? (source.method === 'GET' ? 'read' : source.method === 'DELETE' ? 'delete' : 'write')
      const rule = decl?.call ?? (effect === 'read' ? 'none' : effect === 'write' ? 'confirm' : 'approval')
      if (rule === 'approval') noApprover(`tools.sources.${id}`, id)
      continue
    }
    for (const [tool, decl] of Object.entries(source.tools ?? {})) {
      if (listed(tool)) continue
      const rule = decl.call ?? (decl.effect === 'delete' || decl.effect === 'external' ? 'approval' : undefined)
      if (rule === 'approval') noApprover(`tools.sources.${id}.tools.${tool}`, tool)
    }
  }
  return warnings
}

/** What a space template may not say (SPACE-DEF-003): its defaults lie within its bounds. */
export function spaceTemplateErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const template of pack.spaces?.templates ?? []) {
    const where = `spaces.templates.${template.id}`
    if (seen.has(template.id)) errors.push(`rule 12: ${where} is declared twice`)
    seen.add(template.id)
    // a space of the whole organization has every person of it as a member (SPACE-DEF-003)
    const m = template.membership
    if (template.kind === 'organization' && !(m.mode === 'rule' && m.rule.organization))
      errors.push(`rule 12: ${where} is of kind organization: its membership is the rule organization: true`)
    errors.push(...templateBoundsErrors(pack, template, where))
  }
  return errors
}

function templateBoundsErrors(pack: AgentPack, template: SpaceTemplate, where: string): string[] {
  const errors: string[] = []
  const rules = template.rules ?? {}
  const retention = rules.retentionDays
  if (retention) {
    if (retention.min !== undefined && retention.max !== undefined && retention.min > retention.max)
      errors.push(`rule 12: ${where}.rules.retentionDays min is above max`)
    const value = retention.default ?? PERSONAL_RETENTION_DAYS
    if (retention.min !== undefined && value < retention.min)
      errors.push(`rule 12: ${where}.rules.retentionDays default is below min`)
    if (retention.max !== undefined && value > retention.max)
      errors.push(`rule 12: ${where}.rules.retentionDays default is above max`)
  }
  const conversation = pack.privacy.processingActivities.find((a) => a.id === 'conversation-memory')
  const lawful = rules.lawfulBasis?.default ?? conversation?.lawfulBasis ?? 'contract'
  if (rules.lawfulBasis?.allowed && !rules.lawfulBasis.allowed.includes(lawful))
    errors.push(`rule 12: ${where}.rules.lawfulBasis default is not among the allowed`)
  const handover = rules.handover?.default ?? false
  if (rules.handover?.allowed && !rules.handover.allowed.includes(handover))
    errors.push(`rule 12: ${where}.rules.handover default is not among the allowed`)
  const providers = rules.allowedProviders
  const defaults = providers?.default ?? [providerNameOf(pack)]
  if (providers?.allowed) {
    const outside = defaults.filter((p) => !providers.allowed?.includes(p))
    if (outside.length)
      errors.push(`rule 12: ${where}.rules.allowedProviders default [${outside.join(', ')}] is not among the allowed`)
  }
  return errors
}

/** Cross-field rules 1 to 9 of docs/agent-pack.md plus PRIV-RETN-006. */
export function crossFieldErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const identity = pack.identity
  // rule 1: one authentication schema, whose subject key is among the attributes asked (D65, IDENT-RES-010/012)
  const authentication = identity.authentication ?? []
  if (authentication.length > 1) errors.push('rule 1: identity.authentication must hold exactly one entry')
  for (const entry of authentication) {
    const hidden = entry.attributes ? entry.subjectKey.filter((a) => !entry.attributes?.includes(a)) : []
    if (hidden.length) {
      errors.push(
        `rule 1: identity.authentication subjectKey [${hidden.join(', ')}] must be among the attributes asked, or the credential can never bind`
      )
    }
  }
  // rule 1, the mode (D72): who enters, who is accepted and how the credential is obtained
  for (const entry of authentication) errors.push(...authenticationErrors(entry))
  // what is read by the model is stored, what is stored is asked (PRIV-EVID-006)
  for (const entry of authentication)
    errors.push(...evidencePolicyErrors('identity.authentication', entry, entry.attributes))
  for (const [name, entry] of Object.entries(pack.presentations ?? {})) {
    if (name === AUTHENTICATION_ENTRY)
      errors.push('presentations: the name authentication is the entry of identity.authentication')
    if (name === DOCUMENT_ENTRY) errors.push('presentations: the name document is the entry of evidence.document')
    if (name === EMAIL_ENTRY) errors.push('presentations: the name email is the entry of evidence.email')
    errors.push(...evidencePolicyErrors(`presentations.${name}`, entry, entry.attributes))
  }
  // a document read gives a closed list of attributes: only those can be stored (PRIV-EVID-012)
  const document = pack.evidence?.document
  if (document) errors.push(...evidencePolicyErrors('evidence.document', document, [...DOCUMENT_ATTRIBUTES]))
  if (pack.evidence?.email)
    errors.push(...evidencePolicyErrors('evidence.email', pack.evidence.email, [...EMAIL_ATTRIBUTES]))
  // every claim of an issued credential has a source the agent can resolve (INTX-ISSUE-001/002)
  for (const [name, profile] of Object.entries(pack.issuance ?? {})) {
    // what a profile takes from a document is read by its own challenge, or by nothing (INTX-AUTH-010)
    const readsDocument = Object.values(profile.claims).some((s) =>
      s.from === 'computed' ? s.fn === 'documentId' : s.from === 'evidence' && s.entry === DOCUMENT_ENTRY
    )
    if (readsDocument && profile.trigger === 'automatic')
      errors.push(
        `INTX-AUTH-010: issuance.${name} takes claims from a document and is automatic: a person must ask before their document is read`
      )
    if (readsDocument && !challengeTypesOf(profile).includes('document'))
      errors.push(
        `INTX-AUTH-010: issuance.${name} takes claims from a document and declares no document challenge: nothing would read it`
      )
    const named = [profile.credential.credentialDefinitionId, profile.credential.jsonSchemaCredentialId].filter(Boolean)
    if (named.length !== 1)
      errors.push(
        `INTX-ISSUE-017: issuance.${name}.credential names one of credentialDefinitionId and jsonSchemaCredentialId`
      )
    for (const [claim, source] of Object.entries(profile.claims)) {
      // a field of the directory entry: the loader of the schema checked the field (INTX-ISSUE-021)
      if (source.from === 'record') continue
      if (source.from === 'computed') {
        if (!COMPUTED_FUNCTIONS.includes(source.fn))
          errors.push(`INTX-ISSUE-015: issuance.${name}.claims.${claim} names the unknown function ${source.fn}`)
        if (source.fn === 'addDays' && source.days === undefined)
          errors.push(`INTX-ISSUE-001: issuance.${name}.claims.${claim} addDays needs days`)
        if (source.fn === 'constant' && source.value === undefined)
          errors.push(`INTX-ISSUE-001: issuance.${name}.claims.${claim} constant needs a value`)
        // the identifier of a document is made of two of its attributes, which must be kept to make it
        const unkept = ['documentNumber', 'issuingState'].filter((a) => !document?.store?.attributes.includes(a))
        if (source.fn === 'documentId' && unkept.length)
          errors.push(
            `INTX-ISSUE-019: issuance.${name}.claims.${claim} documentId needs evidence.document to store [${unkept.join(', ')}]`
          )
        continue
      }
      const stored =
        source.entry === AUTHENTICATION_ENTRY
          ? identity.authentication?.[0]?.store?.attributes
          : source.entry === DOCUMENT_ENTRY
            ? document?.store?.attributes
            : source.entry === EMAIL_ENTRY
              ? pack.evidence?.email?.store?.attributes
              : pack.presentations?.[source.entry]?.store?.attributes
      const known =
        source.entry === AUTHENTICATION_ENTRY
          ? authentication.length > 0
          : source.entry === DOCUMENT_ENTRY
            ? !!document
            : source.entry === EMAIL_ENTRY
              ? !!pack.evidence?.email
              : !!pack.presentations?.[source.entry]
      if (!known)
        errors.push(`INTX-ISSUE-001: issuance.${name}.claims.${claim} names the unknown entry ${source.entry}`)
      else if (!stored?.includes(source.attribute))
        errors.push(
          `INTX-ISSUE-001: issuance.${name}.claims.${claim} reads ${source.entry}.${source.attribute}, which that entry does not store`
        )
    }
  }
  // the challenges of the profiles and the badge from the directory (IDENT-DIR-002, INTX-AUTH-011)
  errors.push(...issuanceChallengeErrors(pack))
  // home is the agent's own organization and no other: a pattern cannot give it (IDENT-ROLE-011)
  for (const [i, pattern] of (identity.organizations ?? []).entries()) {
    if ((pattern.relation as string) === 'home') {
      errors.push(`rule 1: identity.organizations[${i}] sets relation home; home is the agent's own organization only`)
    }
  }

  const declaredRoles = new Set(Object.keys(identity.roles ?? {}))
  const check = (roles: string[] | undefined, where: string) => {
    for (const role of roles ?? []) {
      if (!declaredRoles.has(role)) errors.push(`rule 2: role "${role}" in ${where} is not declared in identity.roles`)
    }
  }
  for (const [i, rule] of identity.roleRules.entries()) check(rule.roles, `identity.roleRules[${i}]`)
  for (const [name, profile] of Object.entries(pack.issuance ?? {})) check(profile.roles, `issuance.${name}`)
  for (const [i, p] of (identity.organizations ?? []).entries()) check(p.roles, `identity.organizations[${i}]`)
  for (const [i, o] of (identity.perActorOverrides ?? []).entries()) check(o.roles, `identity.perActorOverrides[${i}]`)
  for (const p of pack.purposes ?? []) check(p.permittedRoles, `purposes.${p.id}.permittedRoles`)
  for (const m of pack.persona.menu ?? []) check(m.roles, `persona.menu.${m.id}.roles`)
  for (const t of pack.spaces?.templates ?? []) check(t.creators, `spaces.templates.${t.id}.creators`)
  // rule 12: the defaults of a space template lie within its bounds (SPACE-DEF-003)
  errors.push(...spaceTemplateErrors(pack))

  const purposeIds = new Set((pack.purposes ?? []).map((p) => p.id))
  const sources = Object.entries(pack.tools?.sources ?? {})
  // the tools a menu item may name: the HTTP tools and the bundled tools the model may be given
  const declaredTools = new Set<string>([
    ...sources.filter(([, s]) => s.type === 'http').map(([id]) => id),
    ...bundledToolNames(pack),
  ])
  // the tier model of each source names its own tools, roles declared, approvers that approve, known purposes (D101)
  const checkAccess = (access: ToolAccess | undefined, where: string, own: readonly string[] | undefined) => {
    if (!access) return
    for (const [role, tools] of Object.entries(access.roles ?? {})) {
      check([role], `${where}.roles`)
      for (const t of tools)
        if (own && t !== '*' && !own.includes(t))
          errors.push(`rule 5: tool "${t}" in ${where}.roles.${role} is not a tool of the source`)
    }
    for (const rule of [...(access.approval ?? []), ...(access.elevation ?? [])]) {
      check(rule.approvers, where)
      for (const r of rule.approvers) {
        if (!identity.roles?.[r]?.canApprove) errors.push(`rule 3: approver role "${r}" in ${where} has no canApprove`)
      }
      for (const t of rule.tools)
        if (own && !own.includes(t)) errors.push(`rule 5: tool "${t}" in ${where} is not a tool of the source`)
    }
    for (const rule of access.elevation ?? []) {
      for (const p of rule.purposes)
        if (!purposeIds.has(p)) errors.push(`rule 4: purpose "${p}" in ${where}.elevation is not in purposes`)
    }
  }
  for (const [id, source] of sources) {
    checkAccess(source.access, `tools.sources.${id}.access`, declaredToolsOf(id, source))
    // a tool's step-up (TOOL-CAT-010): a face match needs the face-verification service
    for (const [tool, decl] of Object.entries(source.tools ?? {}))
      if (decl.stepUp?.authChallenge?.type === 'face-match' && !pack.media?.faceVerification)
        errors.push(
          `rule 6: tools.sources.${id}.tools.${tool}.stepUp.authChallenge face-match requires media.faceVerification`
        )
  }

  const hasMcp = sources.some(([, s]) => s.type === 'mcp')
  for (const m of pack.persona.menu ?? []) {
    if (m.action.type === 'tool' && m.action.tool && !declaredTools.has(m.action.tool) && !hasMcp) {
      errors.push(`rule 5: persona.menu.${m.id} refers to undeclared tool "${m.action.tool}"`)
    }
  }

  const features = featuresOf(pack)
  if (features.rag && !pack.rag) errors.push('rule 7: features.rag requires rag')
  if (features.voiceNotes && !pack.media?.speechToText)
    errors.push('rule 7: features.voiceNotes requires media.speechToText')
  if (features.inboundImages && !pack.media?.vision) errors.push('rule 7: features.inboundImages requires media.vision')
  if (features.imageGeneration && !pack.media?.imageGeneration) {
    errors.push('rule 7: features.imageGeneration requires media.imageGeneration')
  }

  const gen = bundledSource(pack, 'generateImage')
  if (gen && gen[1].enabled !== false && gen[1].provider) {
    const provider = gen[1].provider
    if (!pack.media?.imageGeneration?.providers.some((p) => p.name === provider))
      errors.push(`rule 8: tools.sources.${gen[0]}.provider "${provider}" is not a media.imageGeneration provider`)
  }
  const template = pack.channels?.agui?.walletLinkTemplate
  if (template && (!template.startsWith('https://') || !template.includes('{oob}'))) {
    errors.push('rule 9: channels.agui.walletLinkTemplate must start with https:// and contain {oob}')
  }
  // rule 10: the window budget and the output limit fit in the model's input limit (MEM-CTX-006)
  const limit = pack.llm?.maxInputTokens
  if (limit !== undefined) {
    const budget = pack.memory?.contextWindowTokens ?? 12000
    const output = pack.llm?.maxOutputTokens ?? 1024
    if (budget + output > limit) {
      errors.push(
        `rule 10: memory.contextWindowTokens (${budget}) plus llm.maxOutputTokens (${output}) exceeds llm.maxInputTokens (${limit}) (MEM-CTX-006)`
      )
    }
  }
  // rule 11: a partner-shared source names its partner, and only it (MEM-RAG-005)
  for (const source of pack.rag?.sources ?? []) {
    if (source.visibility === 'partner-shared' && !source.partner) {
      errors.push(`rule 11: rag source "${source.id}" is partner-shared and names no partner (MEM-RAG-005)`)
    }
    if (source.partner && source.visibility !== 'partner-shared') {
      errors.push(`rule 11: rag source "${source.id}" names a partner but is not partner-shared (MEM-RAG-005)`)
    }
  }
  const activities = new Set(pack.privacy.processingActivities.map((a) => a.id))
  const needed: [boolean, string][] = [
    [true, 'conversation-memory'],
    [features.workingMemory, 'working-memory'],
    [features.rag, 'rag-corpus'],
    [features.voiceNotes || features.inboundImages || features.imageGeneration, 'media-objects'],
    [true, 'credential-presentations'],
    [features.approvals || features.elevation, 'approvals'],
    [pack.statistics?.enabled === true, 'statistics'],
  ]
  for (const [enabled, id] of needed) {
    if (enabled && !activities.has(id as never)) {
      errors.push(`PRIV-RETN-006: processing activity "${id}" is enabled but declares no lawful basis`)
    }
  }
  // the tool catalog: accounts, availability, bindings, templates, approvers (TOOL-CAT, TOOL-AVAIL, D96 to D99)
  errors.push(...catalogErrors(pack))
  return errors
}

export interface LoadedPack {
  pack: AgentPack
  dir: string
  file: string
}

export function validatePackDocument(doc: unknown, env: Record<string, string | undefined>): AgentPack {
  const schema = loadSchema()
  const substituted = substitutePlaceholders(doc, env)
  const coerced = coerceBySchema(substituted, schema, schema) as Record<string, unknown>
  const version = String(coerced.schemaVersion ?? '')
  if (!/^3\.\d+$/.test(version)) {
    throw new PackError(`schemaVersion "${version}" is not supported (CORE-PACK-004, major 3 required)`)
  }
  // RBAC-XSESS-005: a role that declares crossSession is refused in words, before the schema names the key
  const removed = removedCrossSessionErrors(coerced)
  if (removed.length) throw new PackError('agent-pack names a cross-session scope that was removed', removed)
  // IDENT-ROLE-012: the people of the user directory are refused in words, before the schema names the key
  const inline = inlineDirectoryErrors(coerced)
  if (inline.length) throw new PackError('agent-pack writes the people of the user directory inline', inline)
  // TOOL-CAT-011: the keys one map replaced are refused in words, with the key that replaces each (D101)
  const withdrawn = withdrawnToolKeyErrors(coerced)
  if (withdrawn.length)
    throw new PackError('agent-pack declares tools under keys that tools.sources replaced (D101)', withdrawn)
  // TOOL-CAT-012: the keys of an account that named fields replaced are refused in words, with their new form (D102)
  const accountKeys = withdrawnAccountKeyErrors(coerced)
  if (accountKeys.length)
    throw new PackError('agent-pack declares a space account in the form that its fields replaced (D102)', accountKeys)
  // INTX-AUTH-011: a step-up that declares the email code is refused in words, before the schema names the value
  const email = emailChallengeStepUpErrors(coerced)
  if (email.length)
    throw new PackError('agent-pack declares an email challenge outside a badge from the directory', email)
  // TOOL-CAT-002: the kinds of account of the later phases are refused in words, before the schema names the value
  const reserved = reservedAccountErrors(coerced)
  if (reserved.length)
    throw new PackError('agent-pack names a kind of tool account this version does not offer', reserved)
  // TOOL-CAT-001: each source answers with known values and a name of its own, named in words
  const catalog = catalogValueErrors(coerced)
  if (catalog.length) throw new PackError('agent-pack declares a tool source the catalog refuses', catalog)
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true })
  addFormats.default(ajv)
  const validate = ajv.compile(schema)
  if (!validate(coerced)) {
    const details = (validate.errors ?? []).map((e) => {
      const extra =
        e.params && 'additionalProperty' in e.params
          ? ` (${String(e.params.additionalProperty)})`
          : e.params && 'unevaluatedProperty' in e.params
            ? ` (${String(e.params.unevaluatedProperty)})`
            : ''
      return `${e.instancePath || '$'} ${e.message ?? ''}${extra}`
    })
    throw new PackError('agent-pack fails schema validation (CORE-PACK-003)', details)
  }
  const pack = coerced as unknown as AgentPack
  const errors = crossFieldErrors(pack)
  if (errors.length) throw new PackError('agent-pack fails cross-field rules', errors)
  return pack
}

export function loadPack(packPath: string, env: Record<string, string | undefined> = process.env): LoadedPack {
  const target = resolve(packPath)
  const file = /\.(ya?ml|json)$/.test(target)
    ? target
    : PACK_FILES.map((f) => join(target, f)).find((f) => existsSync(f))
  if (!file || !existsSync(file)) throw new PackError(`no agent-pack.yaml in ${target} (CORE-PACK-001)`)
  const raw = readFileSync(file, 'utf8')
  const doc = file.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)
  return { pack: validatePackDocument(doc, env), dir: dirname(file), file }
}
