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
import { knownProfile } from '../features/profiles.js'
import {
  type ApprovalTimeoutKind,
  boundsError,
  boundsOf,
  defaultPolicyOf,
  timeoutBoundsOf,
} from '../policy/spacePolicy.js'
import { fieldsNamedBy } from '../tools/accountValues.js'
import { declaresScopes, modelToolsOf, scopesOfTool } from '../tools/scopes.js'
import { featureDocumentErrors, featureErrors, featureWarnings } from './featureRules.js'
import type {
  AccountCheck,
  AccountOAuth,
  AgentPack,
  BundledName,
  EvidencePolicy,
  PackApprovalPolicy,
  PackAuthentication,
  SourceAccount,
  SpaceTemplate,
  StepUpAuthentication,
  ToolAccess,
  ToolApprovalBounds,
  ToolSourceDef,
} from './packTypes.js'
import {
  ACCOUNT_KINDS,
  ADMIN_ROLES,
  AGENT_SET_PARAMETERS,
  AUTHENTICATION_METHOD_TYPES,
  AVAILABILITIES,
  BUNDLED_NAMES,
  BUNDLED_TOOLS,
  bundledEnabled,
  bundledSource,
  CALL_RULES,
  CLIENT_REGISTRATIONS,
  COMPUTED_FUNCTIONS,
  challengeTypesOf,
  credentialMethodsOf,
  DOCUMENT_ATTRIBUTES,
  declaredAdminRoles,
  EMAIL_ATTRIBUTES,
  featuresOf,
  IDENTIFYING_METHOD_TYPES,
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
/** The entry under which a face match is kept as evidence, its audit fields only (D131, IDENT-AUTH-011). */
export const FACE_MATCH_ENTRY = 'face-match'
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
  if (on('requestPresentation') && (pack.identity.authentication?.combinations?.length || asksOnDemand))
    names.push('request_presentation')
  if (on('credentialIssuance') && Object.keys(pack.issuance ?? {}).length) {
    names.push('credential_requirements')
    if (Object.values(pack.issuance ?? {}).some((p) => (p.trigger ?? 'model') === 'model'))
      names.push('issue_credential')
  }
  if (on('principalPreferences')) names.push('principal_preferences')
  if (on('workingMemory')) names.push('working_memory')
  // the Connect card, while the agent-pack declares a source of each person's own account (D108, TOOL-CONN-011)
  if (on('connections') && hasPersonalSource(pack)) names.push('offer_connection')
  return names
}

/** Whether the agent-pack declares a source of each person's own account (D104). */
export function hasPersonalSource(pack: Pick<AgentPack, 'tools'>): boolean {
  return Object.values(pack.tools?.sources ?? {}).some((s) => s.type !== 'bundled' && s.account?.kind === 'personal')
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
    ...credentialMethodsOf(pack).map(([n, e]): [string, EvidencePolicy] => [`identity.authentication.methods.${n}`, e]),
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
 * The evidence policy of the `authentication` entry: what is kept of a presentation of a `credential` method, and what
 * the model may read of it (D67). Each method says it for its own presentations; the entry the rest of the agent reads
 * (a claim's source, the model's view) takes all of them together.
 */
export function authenticationEvidencePolicy(pack: Pick<AgentPack, 'identity'>): EvidencePolicy {
  const methods = credentialMethodsOf(pack).map(([, m]) => m)
  const stored = [...new Set(methods.flatMap((m) => m.store?.attributes ?? []))]
  const visible = [...new Set(methods.flatMap((m) => m.modelVisible ?? []))]
  const retention = methods.find((m) => m.store?.retention)?.store?.retention
  return {
    ...(stored.length ? { store: { attributes: stored, ...(retention ? { retention } : {}) } } : {}),
    ...(visible.length ? { modelVisible: visible } : {}),
  }
}

/**
 * What `identity.authentication` may not say (D72, D125, D126; IDENT-RES-010, IDENT-AUTH-001): `on-demand` lets visitors
 * in by itself; a type the agent does not know; a combination that names a method not enabled, names one twice, is
 * listed twice or holds no identifying method; a `credential` method without its schema or subject key, whose subject
 * key is not among the attributes it asks, or whose list of organizations is empty or not of organization keys; a field
 * of one type on a method of another; how a person obtains what they lack as neither a text nor an https link. What a
 * method needs of the deployment (an SMTP server, a face-verification service) is checked when the agent starts.
 */
export function authenticationErrors(
  authentication: PackAuthentication,
  pack?: Pick<AgentPack, 'privacy' | 'media'>
): string[] {
  const errors: string[] = []
  const at = 'identity.authentication'
  if (authentication.request === 'on-demand' && authentication.visitors === false)
    errors.push(`rule 1: ${at} asked on-demand lets visitors in: visitors cannot be false`)
  const methods = authentication.methods ?? {}
  for (const [name, method] of Object.entries(methods)) {
    const where = `${at}.methods.${name}`
    if (!(AUTHENTICATION_METHOD_TYPES as readonly string[]).includes(method.type)) {
      errors.push(
        `rule 1: ${where} has the type ${method.type}, which this agent does not know (${AUTHENTICATION_METHOD_TYPES.join(', ')})`
      )
      continue
    }
    if (method.type === 'credential') {
      if (!method.credential?.jsonSchemaCredentialId)
        errors.push(`rule 1: ${where} is a credential method without its schema (credential.jsonSchemaCredentialId)`)
      if (!method.subjectKey?.length)
        errors.push(`rule 1: ${where} is a credential method without a subject key (subjectKey)`)
      const hidden = method.attributes ? (method.subjectKey ?? []).filter((a) => !method.attributes?.includes(a)) : []
      if (hidden.length)
        errors.push(
          `rule 1: ${where}.subjectKey [${hidden.join(', ')}] must be among the attributes asked, or the credential can never identify`
        )
      const organizations = method.issuers?.organizations
      if (organizations !== undefined) {
        if (!organizations.length)
          errors.push(
            `rule 1: ${where}.issuers.organizations is empty: it would accept nobody; leave it out to accept any accredited issuer`
          )
        const unkeyed = organizations.filter((key) => !/^org:[A-Z]{2}:.+$/.test(key))
        if (unkeyed.length)
          errors.push(
            `rule 1: ${where}.issuers.organizations [${unkeyed.join(', ')}] must be organization keys, org:<country>:<register id>`
          )
      }
      errors.push(...evidencePolicyErrors(where, method, method.attributes))
    } else {
      const foreign = (['credential', 'subjectKey', 'attributes', 'issuers', 'store', 'modelVisible'] as const).filter(
        (field) => method[field] !== undefined
      )
      if (foreign.length)
        errors.push(`rule 1: ${where} is of type ${method.type}: [${foreign.join(', ')}] belong to a credential method`)
    }
    if (method.type === 'face-match') {
      if (!method.reference?.length)
        errors.push(`rule 1: ${where} names no reference picture (reference: document, directory)`)
      // consent is the one lawful basis of a face match (D131, IDENT-AUTH-011)
      const activity = pack?.privacy.processingActivities.find((a) => (a.id as string) === 'biometric-matching')
      if (pack && activity?.lawfulBasis !== 'consent')
        errors.push(
          activity
            ? `IDENT-AUTH-011: ${where} needs the processing activity biometric-matching with the lawful basis consent, not ${activity.lawfulBasis}`
            : `IDENT-AUTH-011: ${where} needs the processing activity biometric-matching, with the lawful basis consent`
        )
      if (pack && !pack.media?.faceVerification)
        errors.push(`IDENT-AUTH-001: ${where} needs a face-verification service (media.faceVerification)`)
    } else if (method.reference !== undefined) {
      errors.push(`rule 1: ${where} is of type ${method.type}: reference belongs to a face-match method`)
    }
  }
  const seen = new Set<string>()
  for (const [i, combination] of (authentication.combinations ?? []).entries()) {
    const where = `${at}.combinations[${i}] [${combination.join(', ')}]`
    const unknown = combination.filter((name) => !methods[name])
    if (unknown.length) {
      errors.push(`rule 1: ${where} names [${unknown.join(', ')}], which no method enables`)
      continue
    }
    if (new Set(combination).size !== combination.length) errors.push(`rule 1: ${where} names a method twice`)
    const key = [...combination].sort().join('\u0000')
    if (seen.has(key)) errors.push(`rule 1: ${where} is listed twice`)
    seen.add(key)
    if (!combination.some((name) => IDENTIFYING_METHOD_TYPES.includes(methods[name].type)))
      errors.push(
        `rule 1: ${where} holds no identifying method (${IDENTIFYING_METHOD_TYPES.join(', ')}): it would identify nobody`
      )
  }
  if (authentication.obtain) {
    if (!authentication.obtain.text && !authentication.obtain.url)
      errors.push(`rule 1: ${at}.obtain says a text, a link, or both`)
    if (authentication.obtain.url && !authentication.obtain.url.startsWith('https://'))
      errors.push(`rule 1: ${at}.obtain.url must be an https link`)
  }
  return errors
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
 * What an issuance profile may say of its challenge, of the user directory and of a verified address (INTX-ISSUE-010,
 * INTX-ISSUE-020/021, IDENT-DIR-005, D130).
 */
export function issuanceChallengeErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const document = pack.evidence?.document
  const email = pack.evidence?.email
  const emailMethod = Object.values(pack.identity.authentication?.methods ?? {}).some((m) => m.type === 'email')
  for (const [name, profile] of Object.entries(pack.issuance ?? {})) {
    const where = `issuance.${name}`
    const types = challengeTypesOf(profile)
    const sources = Object.values(profile.claims)
    if (types.length > 1) errors.push(`INTX-ISSUE-010: ${where} declares several challenges: a profile declares one`)
    if (takesClaimsFromDirectory(profile)) {
      if (!pack.identity.directory)
        errors.push(
          `INTX-ISSUE-021: ${where} takes claims from the user directory, and identity.directory names no file`
        )
      // a claim of the document comes from the passport of the entry read when the person authenticated, which the
      // matching finds to be the entry's (IDENT-DIR-003, IDENT-DIR-005)
      const read = sources.flatMap((s) => (s.from === 'evidence' && s.entry === DOCUMENT_ENTRY ? [s.attribute] : []))
      if (read.length) {
        const unkept = [...new Set([...DIRECTORY_MATCH_ATTRIBUTES, ...read])].filter(
          (a) => !document?.store?.attributes.includes(a)
        )
        if (unkept.length)
          errors.push(
            `IDENT-DIR-005: ${where} takes claims from the passport read when the person authenticated: evidence.document must store [${unkept.join(', ')}]`
          )
      }
    }
    // the address an `email` method of the authentication verified (INTX-ISSUE-020, IDENT-AUTH-009)
    const usesEmail = sources.some(
      (s) => (s.from === 'computed' && s.fn === 'emailId') || (s.from === 'evidence' && s.entry === EMAIL_ENTRY)
    )
    if (usesEmail && !emailMethod)
      errors.push(
        `INTX-ISSUE-020: ${where} takes a claim from a verified address, and identity.authentication enables no email method: nothing would verify it`
      )
    if (usesEmail && !email?.store?.attributes.includes('address'))
      errors.push(`INTX-ISSUE-020: ${where} takes a claim from a verified address: evidence.email must store [address]`)
    // the claim of the last day of validity is one of the profile's (INTX-ISSUE-023)
    if (profile.validUntilClaim !== undefined && !(profile.validUntilClaim in profile.claims))
      errors.push(
        `INTX-ISSUE-023: ${where}.validUntilClaim names ${profile.validUntilClaim}, which is no claim of the profile`
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
    errors.push('IDENT-AUTH-009: evidence.email.modelVisible: the model is never told the verified address')
  if (email) {
    const outside = (email.store?.attributes ?? []).filter((a) => !(EMAIL_ATTRIBUTES as readonly string[]).includes(a))
    if (outside.length)
      errors.push(
        `IDENT-AUTH-009: evidence.email stores [${outside.join(', ')}]: an email method's evidence has one attribute, address`
      )
  }
  return errors
}

type Doc = Record<string, unknown>

const isObject = (value: unknown): value is Doc => !!value && typeof value === 'object' && !Array.isArray(value)

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
 * The challenges an action may declare, refused in words before the schema, which would only name the value: a tool's
 * step-up asks a device confirmation (`stepUp.authChallenge`, TOOL-CAT-010), an issuance profile a device confirmation or
 * a document read (INTX-ISSUE-010). An email code, a face match and a passport that identifies a person are methods of
 * the authentication, asked in a re-authentication (`stepUp.authentication`, D126, D127), never as challenges.
 */
export function challengeTypeErrors(doc: unknown): string[] {
  const errors: string[] = []
  const asMethod = 'an email code, a face match or a document read is asked as a method: stepUp.authentication'
  for (const { where, body } of docSources(doc)) {
    if (!isObject(body.tools)) continue
    for (const [tool, decl] of Object.entries(body.tools)) {
      const challenge = isObject(decl) && isObject(decl.stepUp) ? decl.stepUp.authChallenge : undefined
      if (isObject(challenge) && challenge.type !== undefined && challenge.type !== 'device')
        errors.push(
          `TOOL-CAT-010: ${where}.tools.${tool}.stepUp.authChallenge has the type ${String(challenge.type)}: a tool's challenge is a device confirmation; ${asMethod}`
        )
    }
  }
  const issuance = isObject(doc) && isObject(doc.issuance) ? doc.issuance : {}
  for (const [name, profile] of Object.entries(issuance)) {
    const declared = isObject(profile) ? profile.authChallenge : undefined
    for (const challenge of ([] as unknown[]).concat(declared ?? []))
      if (
        isObject(challenge) &&
        challenge.type !== undefined &&
        !['device', 'document'].includes(String(challenge.type))
      )
        errors.push(
          `INTX-ISSUE-010: issuance.${name}.authChallenge has the type ${String(challenge.type)}: an issuance's challenge is a device confirmation or a document read; a badge from the user directory takes its claims from the entry the authentication identified (D130)`
        )
  }
  return errors
}

/**
 * The set of methods a step-up's re-authentication names (TOOL-CAT-010, IDENT-AUTH-015, D127): enabled methods, each once.
 * Unlike a combination it may hold confirming methods only, since it confirms the Principal of an identified connection;
 * a pack that identifies nobody (no accepted combination) can never confirm one.
 */
export function stepUpAuthenticationErrors(
  pack: Pick<AgentPack, 'identity'>,
  where: string,
  authentication: StepUpAuthentication | undefined
): string[] {
  if (!authentication) return []
  const errors: string[] = []
  const at = `${where}.stepUp.authentication`
  const enabled = pack.identity.authentication?.methods ?? {}
  const methods = authentication.methods ?? []
  if (!methods.length) errors.push(`TOOL-CAT-010: ${at} names no method`)
  const unknown = methods.filter((name) => !enabled[name])
  if (unknown.length)
    errors.push(
      `TOOL-CAT-010: ${at} names [${unknown.join(', ')}], which identity.authentication.methods does not enable`
    )
  if (new Set(methods).size !== methods.length) errors.push(`TOOL-CAT-010: ${at} names a method twice`)
  if (!pack.identity.authentication?.combinations?.length)
    errors.push(
      `IDENT-AUTH-015: ${at} re-authenticates an identified person, and identity.authentication lists no combination: nobody is ever identified`
    )
  return errors
}

/**
 * The kind of account of the later phase (TOOL-CAT-002, O29): a source that declares `organization` is refused in words,
 * before the schema, which would only name the value.
 */
export function reservedAccountErrors(doc: unknown): string[] {
  const errors: string[] = []
  for (const { where, body } of docSources(doc)) {
    const kind = isObject(body.account) ? body.account.kind : undefined
    if (kind === 'organization')
      errors.push(
        `${where}.account.kind: organization is not available in this version: the accounts the organization opens come in phase 3 of the tools (TOOL-CAT-002, O29); use none, agent, space or personal`
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
    // how the agent obtains its client at the authorization server of a person's own account (TOOL-CAT-014)
    const oauth = account && isObject(account.oauth) ? account.oauth : undefined
    const client = oauth && isObject(oauth.client) ? oauth.client : undefined
    if (client) one(where, 'account.oauth.client.registration', client.registration, CLIENT_REGISTRATIONS)
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
      if (!Array.isArray(t.features)) continue
      for (const [i, entry] of (t.features as Doc[]).entries())
        one(`spaces.templates.${String(t.id)}.features[${i}]`, 'add', entry?.add, ['auto', 'owner'])
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
  } else if (account?.kind === 'personal') errors.push(...personalSourceErrors(where, source, account))
  else if (account && (account.fields || account.apply))
    errors.push(`${where}.account: fields and apply belong to a space's or a person's account only (TOOL-CAT-002)`)
  if (account && account.kind !== 'personal')
    for (const key of ['oauth', 'from', 'binding', 'check'] as const)
      if (account[key] !== undefined)
        errors.push(`${where}.account.${key}: belongs to a person's own account only, of kind personal (TOOL-CAT-013)`)
  if (account?.tokenPatterns && account.kind !== 'space' && account.kind !== 'personal')
    errors.push(`${where}.account.tokenPatterns: belongs to a space's or a person's account only (TOOL-CAT-016)`)
  for (const pattern of account?.tokenPatterns ?? []) {
    const bad = regexError(pattern)
    if (bad)
      errors.push(`${where}.account.tokenPatterns: ${JSON.stringify(pattern)} is not a regular expression: ${bad}`)
  }
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

/** Whether a text is a JSON pointer (RFC 6901): empty, or `/`-separated tokens where `~` is followed by 0 or 1 only. */
export function isJsonPointer(text: string): boolean {
  return text === '' || /^(\/([^~/]|~[01])*)+$/.test(text)
}

/** The JSON pointers a label template names as `{/pointer}` (D110, TOOL-CAT-017). */
export function pointersOfLabel(template: string): string[] {
  return [...template.matchAll(/\{(\/[^{}]*)\}/g)].map((m) => m[1] ?? '')
}

/**
 * A person's own account (D104, TOOL-CAT-013, TOOL-CAT-014, TOOL-AVAIL-007): exactly one of `oauth`, `fields` and `apply`,
 * or `from`; OAuth only for an MCP server reached remotely, without an `Authorization` of its own; a `pre-registered`
 * client with its issuer and id, the other registrations with neither; a `bindingRequest` only with a `binding`; a remote
 * source, never a stdio server.
 */
function personalSourceErrors(where: string, source: ToolSourceDef, account: SourceAccount): string[] {
  const errors: string[] = []
  const declares = [
    account.oauth !== undefined ? 'oauth' : undefined,
    account.fields !== undefined || account.apply !== undefined ? 'fields' : undefined,
    account.from !== undefined ? 'from' : undefined,
  ].filter((d): d is string => !!d)
  if (declares.length !== 1)
    errors.push(
      `${where}.account: a person's own account declares exactly one of oauth, fields and apply, or from, not ${declares.length ? declares.join(' and ') : 'none of them'} (TOOL-CAT-013)`
    )
  if (source.type === 'mcp' && source.transport === 'stdio')
    errors.push(
      `${where}.transport: a person's own account reaches a remote MCP server (sse or streamable-http), never a stdio one (TOOL-AVAIL-007)`
    )
  if (account.oauth) {
    if (source.type !== 'mcp')
      errors.push(`${where}.account.oauth: OAuth is for an MCP server only, not an HTTP tool (TOOL-CAT-013)`)
    const auth =
      source.type === 'mcp'
        ? Object.keys(source.headers ?? {}).find((h) => h.toLowerCase() === 'authorization')
        : undefined
    if (auth)
      errors.push(
        `${where}.headers.${auth}: a source of OAuth sends each person's own token and no Authorization of its own (TOOL-CAT-013)`
      )
    errors.push(...oauthErrors(`${where}.account.oauth`, account.oauth, !!account.binding))
    if (account.oauth.resource !== undefined)
      errors.push(
        `${where}.account.oauth.resource: false is for an account of tools.accounts alone, whose authorization server issues tokens for its own interfaces; a source's sign-in names its server as the resource (TOOL-CAT-021)`
      )
  }
  if (account.fields !== undefined || account.apply !== undefined) {
    if (!account.fields?.length)
      errors.push(`${where}.account.fields: a person's account of fields declares them, one or more (TOOL-CAT-013)`)
    if (!account.apply?.length)
      errors.push(
        `${where}.account.apply: a person's account of fields declares the headers its calls carry, built from them (TOOL-CAT-013)`
      )
    errors.push(...accountFieldErrors(where, account))
  }
  if (account.from !== undefined)
    for (const key of ['binding', 'check'] as const)
      if (account[key] !== undefined)
        errors.push(
          `${where}.account.${key}: an account of from is the account of the source it names, which declares it (TOOL-CAT-015)`
        )
  // the binding each account is for, and the read after each connection (TOOL-CAT-017)
  const bindings = source.type === 'bundled' ? [] : (source.bindings ?? [])
  if (account.binding !== undefined) {
    if (!bindings.some((b) => b.name === account.binding))
      errors.push(`${where}.account.binding: ${account.binding} is not a binding of the source (TOOL-CAT-017)`)
    if (!account.check?.binding)
      errors.push(
        `${where}.account.check.binding: an account for one value of a binding reads that value after each connection (TOOL-CAT-017)`
      )
  }
  const check = account.check
  if (check) {
    errors.push(...checkErrors(`${where}.account.check`, check, !!account.binding))
    const tool = check.tool
    if (tool !== undefined) {
      // an HTTP tool is one tool, named by its source's id; an MCP server offers its `offer`, or every tool it lists
      const offered =
        source.type === 'http'
          ? tool === sourceIdOf(where)
          : source.type === 'mcp' && (!source.offer || source.offer.includes(tool))
      if (!offered) errors.push(`${where}.account.check.tool: ${tool} is not a tool the source offers (TOOL-CAT-017)`)
      const declared = source.tools?.[tool]?.effect
      const effect = declared ?? (source.type === 'http' ? (source.method === 'GET' ? 'read' : 'write') : undefined)
      if (effect !== undefined && effect !== 'read')
        errors.push(
          `${where}.account.check.tool: ${tool} is of effect ${effect}: the check reads, with a tool of effect read (TOOL-CAT-017)`
        )
    }
    if (check.idToken && !account.oauth)
      errors.push(
        `${where}.account.check.idToken: the ID token is that of an OAuth sign-in, which the account does not declare (TOOL-CAT-021)`
      )
  }
  return errors
}

/**
 * The sign-in of a person's own account, of a source or of `tools.accounts` (TOOL-CAT-014, TOOL-CAT-021), `at` being
 * where its `oauth` is written: a `pre-registered` client with its issuer and id, the other registrations with neither;
 * a `bindingRequest` only with a binding; no parameter of the agent's own among the agent-pack's.
 */
function oauthErrors(at: string, oauth: AccountOAuth, hasBinding: boolean): string[] {
  const errors: string[] = []
  const client = oauth.client
  if (client.registration === 'pre-registered') {
    for (const key of ['issuer', 'id'] as const)
      if (!client[key]?.trim())
        errors.push(
          `${at}.client.${key}: a pre-registered client declares its ${key === 'id' ? 'id' : 'issuer'}, from the deployment's secrets, and it is empty (TOOL-CAT-014)`
        )
  } else
    for (const key of ['issuer', 'id', 'secret'] as const)
      if (client[key] !== undefined)
        errors.push(
          `${at}.client.${key}: only a pre-registered client declares it, not one of ${client.registration} (TOOL-CAT-014)`
        )
  const request = oauth.bindingRequest
  if (request && !hasBinding)
    errors.push(
      `${at}.bindingRequest: the account declares no binding whose value the sign-in could ask for (TOOL-CAT-014)`
    )
  if (request?.resource !== undefined && !request.resource.includes('{value}'))
    errors.push(`${at}.bindingRequest.resource: the resource names the value as {value} (TOOL-CAT-014)`)
  for (const name of Object.keys(oauth.parameters ?? {}))
    if (AGENT_SET_PARAMETERS.includes(name.toLowerCase()))
      errors.push(
        `${at}.parameters.${name}: the agent sets ${name} itself; the agent-pack adds parameters of its own only (TOOL-CAT-021)`
      )
  return errors
}

/**
 * The check of a person's own account (TOOL-CAT-017, TOOL-CAT-021), `at` being where it is written: a tool's read or the
 * ID token, one of the two; JSON pointers that are pointers, into the tool's result only; a binding read only for an
 * account that has one.
 */
function checkErrors(at: string, check: AccountCheck, hasBinding: boolean): string[] {
  const errors: string[] = []
  if (check.tool !== undefined && check.idToken !== undefined)
    errors.push(`${at}.idToken: the ID token stands in place of check.tool, not beside it (TOOL-CAT-021)`)
  if (check.tool === undefined && check.idToken === undefined)
    errors.push(
      `${at}: a check reads a tool (tool) or the ID token of the sign-in (idToken) (TOOL-CAT-017, TOOL-CAT-021)`
    )
  const pointers: [string, string | undefined][] = [
    ['binding.value', check.binding?.value],
    ['binding.label', check.binding?.label],
    ['email', check.email],
  ]
  for (const [field, pointer] of pointers) {
    if (pointer === undefined) continue
    if (!isJsonPointer(pointer))
      errors.push(`${at}.${field}: ${JSON.stringify(pointer)} is not a JSON pointer (TOOL-CAT-017)`)
    else if (check.idToken)
      errors.push(
        `${at}.${field}: a pointer into the result of check.tool, which the ID token replaces: idToken checks the email itself (TOOL-CAT-021)`
      )
  }
  for (const pointer of check.label ? pointersOfLabel(check.label) : [])
    if (!isJsonPointer(pointer)) errors.push(`${at}.label: {${pointer}} is not a JSON pointer (TOOL-CAT-017)`)
  if (check.binding && !hasBinding)
    errors.push(`${at}.binding: the account declares no binding whose value the check would read (TOOL-CAT-017)`)
  return errors
}

/** The id of a source from where it is written (`tools.sources.<id>`). */
function sourceIdOf(where: string): string {
  return where.slice('tools.sources.'.length)
}

/**
 * The sources whose account is another's (`account.from`, TOOL-CAT-015): a source of a person's own account of OAuth or
 * fields, of the same type and at the same URL, that is not itself of `from` or of a binding; and a check of the email
 * only in an agent whose directory is configured (TOOL-CAT-017).
 */
function personalAccountErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const sources = pack.tools?.sources ?? {}
  const accounts = pack.tools?.accounts ?? {}
  for (const [id, source] of Object.entries(sources)) {
    if (source.type === 'bundled' || source.account?.kind !== 'personal') continue
    const where = `tools.sources.${id}`
    const account = source.account
    errors.push(...directoryCheckErrors(`${where}.account.check`, account.check, pack))
    if (account.from === undefined) continue
    // an account of tools.accounts: the source says kind and from, and nothing else (TOOL-CAT-020)
    if (accounts[account.from]) {
      if (source.type !== 'mcp')
        errors.push(
          `${where}.type: ${id} uses the account ${account.from} of tools.accounts, whose sources are MCP servers (TOOL-CAT-020)`
        )
      for (const key of Object.keys(account))
        if (key !== 'kind' && key !== 'from')
          errors.push(
            `${where}.account.${key}: a source of the account ${account.from} of tools.accounts declares kind and from only (TOOL-CAT-020)`
          )
      continue
    }
    const named = sources[account.from]
    const refuse = (why: string) => errors.push(`${where}.account.from: ${account.from} ${why} (TOOL-CAT-015)`)
    if (!named) refuse('is not a key of tools.sources or of tools.accounts')
    else if (named.type === 'bundled' || named.account?.kind !== 'personal')
      refuse("is not a source of a person's own account")
    else if (named.account.from !== undefined || named.account.binding !== undefined)
      refuse(
        named.account.from !== undefined
          ? 'itself uses the account of another source'
          : 'declares a binding: each of its accounts is for one value'
      )
    else if (!named.account.oauth && !named.account.fields) refuse('declares neither oauth nor fields')
    else if (named.type !== source.type || named.url !== source.url)
      refuse(
        `is ${named.type !== source.type ? `of type ${named.type}` : `at another URL, ${named.url}`}: an account is used at the same server only`
      )
  }
  return errors
}

/** An email checked against the person's directory entry needs a directory (TOOL-CAT-017, TOOL-CAT-021, IDENT-DIR-001). */
function directoryCheckErrors(at: string, check: AccountCheck | undefined, pack: AgentPack): string[] {
  if (pack.identity.directory?.file) return []
  const errors: string[] = []
  if (check?.email !== undefined)
    errors.push(
      `${at}.email: the email of an account is compared with the person's entry of the user directory, and this agent has none (TOOL-CAT-017, IDENT-DIR-001)`
    )
  if (check?.idToken?.email)
    errors.push(
      `${at}.idToken.email: the email of the ID token is compared with the person's entry of the user directory, and this agent has none (TOOL-CAT-021, IDENT-DIR-001)`
    )
  return errors
}

/**
 * The accounts of `tools.accounts` (D118, TOOL-CAT-020): an id no source has, used by at least one source, with a client
 * the operator registered; its check by the ID token, never by a tool, since an account offers none.
 */
function toolAccountErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const sources = pack.tools?.sources ?? {}
  for (const [id, account] of Object.entries(pack.tools?.accounts ?? {})) {
    const where = `tools.accounts.${id}`
    if (sources[id])
      errors.push(
        `${where}: ${id} is also the id of a source: an account of tools.accounts has an id of its own (TOOL-CAT-020)`
      )
    const users = Object.entries(sources).filter(
      ([, s]) => s.type !== 'bundled' && s.account?.kind === 'personal' && s.account.from === id
    )
    if (!users.length)
      errors.push(
        `${where}: no source uses it: a source names it with account: { kind: personal, from: ${id} } (TOOL-CAT-020)`
      )
    if (account.oauth.client.registration !== 'pre-registered')
      errors.push(
        `${where}.oauth.client.registration: the client of an account of tools.accounts is pre-registered, the operator's own, not ${account.oauth.client.registration} (TOOL-CAT-020)`
      )
    errors.push(...oauthErrors(`${where}.oauth`, account.oauth, false))
    if (account.check) {
      errors.push(...checkErrors(`${where}.check`, account.check, false))
      if (account.check.tool !== undefined)
        errors.push(
          `${where}.check.tool: an account of tools.accounts offers no tool to read: its check is the ID token of the sign-in (idToken) (TOOL-CAT-017, TOOL-CAT-020)`
        )
    }
    errors.push(...directoryCheckErrors(`${where}.check`, account.check, pack))
  }
  return errors
}

/**
 * The scopes of each tool (D118, TOOL-CAT-021): only on a source whose account signs in with OAuth, directly or through
 * `from`; then on every tool the model may be given of it, as far as the agent-pack names them, and never beside the
 * account's own `oauth.scopes`.
 */
function scopeErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const sources = pack.tools?.sources ?? {}
  const accounts = pack.tools?.accounts ?? {}
  /** where the OAuth of a source's account is written, and the scopes it asks itself */
  const oauthOf = (source: ToolSourceDef): { at: string; oauth: AccountOAuth } | undefined => {
    if (source.type === 'bundled' || source.account?.kind !== 'personal') return undefined
    const from = source.account.from
    if (from === undefined) return source.account.oauth ? { at: '', oauth: source.account.oauth } : undefined
    if (accounts[from]) return { at: `tools.accounts.${from}.oauth`, oauth: accounts[from].oauth }
    const named = sources[from]
    return named && named.type !== 'bundled' && named.account?.oauth
      ? { at: `tools.sources.${from}.account.oauth`, oauth: named.account.oauth }
      : undefined
  }
  const asked = new Set<string>()
  for (const [id, source] of Object.entries(sources)) {
    if (source.type === 'bundled' || !declaresScopes(source)) continue
    const where = `tools.sources.${id}`
    const signIn = oauthOf(source)
    if (!signIn) {
      for (const [tool, decl] of Object.entries(source.tools ?? {}))
        if (decl.scopes !== undefined)
          errors.push(
            `${where}.tools.${tool}.scopes: a tool says the scopes of an OAuth sign-in, and the source's account has none (TOOL-CAT-021)`
          )
      continue
    }
    const at = signIn.at || `${where}.account.oauth`
    if (signIn.oauth.scopes !== undefined && !asked.has(at)) {
      asked.add(at)
      errors.push(
        `${at}.scopes: the tools of ${id} declare the scopes they need, and the sign-in asks theirs: the account declares none of its own (TOOL-CAT-021)`
      )
    }
    const feature = source.feature ? pack.tools?.features?.[source.feature]?.profile : undefined
    const profile = feature ? knownProfile(feature.id, feature.version) : undefined
    for (const tool of modelToolsOf(id, source, profile) ?? [])
      if (scopesOfTool(source, tool) === undefined)
        errors.push(
          `${where}.tools.${tool}.scopes: ${tool} is given to the model, and the source's other tools declare their scopes: it declares its own too (TOOL-CAT-021)`
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
  for (const [id, source] of Object.entries(pack.tools?.sources ?? {})) {
    const where = `tools.sources.${id}`
    errors.push(...sourceErrors(where, source))
    if (source.type === 'mcp' && source.offer && new Set(source.offer).size !== source.offer.length)
      errors.push(`${where}.offer names a tool twice (TOOL-CAT-003)`)
    // a tool of the spaces is approved by the space's owner, never by roles (TOOL-CAT-009)
    if (source.availability === 'spaces')
      for (const entry of source.access?.approval ?? [])
        errors.push(
          `${where}.access.approval names [${entry.tools.join(', ')}], tools of availability spaces: their approval policy in each space approves them (TOOL-CAT-009)`
        )
  }
  // the accounts of other sources, and the check of the email (TOOL-CAT-015, TOOL-CAT-017)
  errors.push(...personalAccountErrors(pack))
  // the accounts several sources use, and the scopes of each tool (TOOL-CAT-020, TOOL-CAT-021)
  errors.push(...toolAccountErrors(pack))
  errors.push(...scopeErrors(pack))
  // the features, the feature each source serves, one provider of a feature in a space, the templates' features
  // (TOOL-FEAT-001 to 005, TOOL-FEAT-023, TOOL-AVAIL-002)
  errors.push(...featureErrors(pack))
  // the policies of the tools of spaces, their bounds and the timeouts of a space (TOOL-CAT-023)
  errors.push(...spaceApprovalErrors(pack))
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
 * The approval policies of the tools of spaces as the agent-pack bounds them (TOOL-CAT-023, D140): every default within
 * its bounds, no `person` entry anywhere (the agent-pack names no person), a role declared with `canApprove`, and each
 * timeout's default within its `min` and `max`. Each error names its field.
 */
export function spaceApprovalErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const roles = pack.identity.roles ?? {}
  const spaces = pack.approvals?.spaces
  const roleErrors = (where: string, role: string | undefined) => {
    if (!role) errors.push(`TOOL-CAT-023: ${where} names no role`)
    else if (!roles[role]) errors.push(`TOOL-CAT-023: ${where}: role "${role}" is not declared in identity.roles`)
    else if (!roles[role]?.canApprove) errors.push(`TOOL-CAT-023: ${where}: role "${role}" has no canApprove`)
  }
  const entries = (where: string, policy: PackApprovalPolicy | undefined) => {
    for (const [i, entry] of (policy?.approvers ?? []).entries()) {
      const at = `${where}.approvers.${i}`
      if (entry.kind === 'person') errors.push(`TOOL-CAT-023: ${at}: an agent-pack names no person`)
      if (entry.kind === 'role') roleErrors(at, entry.role)
      if (entry.kind === 'department' && !entry.department) errors.push(`TOOL-CAT-023: ${at} names no department`)
    }
  }
  for (const [i, role] of (spaces?.allowedApprovers?.roles ?? []).entries())
    roleErrors(`approvals.spaces.allowedApprovers.roles.${i}`, role)
  entries('approvals.spaces.default', spaces?.default)
  const declared = (role: string) => !!roles[role]?.canApprove
  const check = (where: string, tool?: ToolApprovalBounds) => {
    const policy = defaultPolicyOf(pack, tool)
    if (policy.approvers.some((e) => e.kind === 'person')) return
    const broken = boundsError(policy, boundsOf(pack, tool), declared)
    if (broken)
      errors.push(
        `TOOL-CAT-023: ${where} is outside its bounds (${broken.code} at ${broken.field}): give the tool a default within them`
      )
  }
  check('approvals.spaces.default')
  for (const kind of Object.keys(spaces?.timeouts ?? {})) {
    const resolved = timeoutBoundsOf(pack, kind as ApprovalTimeoutKind)
    const where = `approvals.spaces.timeouts.${kind}`
    if (resolved.min > resolved.max) errors.push(`TOOL-CAT-023: ${where} min is above max`)
    else if (resolved.default < resolved.min || resolved.default > resolved.max)
      errors.push(`TOOL-CAT-023: ${where}.default is outside its min and max`)
  }
  for (const [id, source] of Object.entries(pack.tools?.sources ?? {}))
    for (const [tool, decl] of Object.entries(source.tools ?? {})) {
      if (!decl.approval) continue
      const where = `tools.sources.${id}.tools.${tool}.approval`
      entries(`${where}.default`, decl.approval.default)
      check(`${where}.default`, decl.approval)
    }
  // a tool of a feature profile is bounded once, on its feature (TOOL-FEAT-005)
  for (const [id, feature] of Object.entries(pack.tools?.features ?? {}))
    for (const [tool, decl] of Object.entries(feature.tools ?? {})) {
      if (!decl.approval) continue
      const where = `tools.features.${id}.tools.${tool}.approval`
      entries(`${where}.default`, decl.approval.default)
      check(`${where}.default`, decl.approval)
    }
  return errors
}

/**
 * What the catalog leaves to the operator's judgment (TOOL-AVAIL-002, TOOL-CAT-009): a source of spaces that no template
 * names, and a tool whose rule the agent-pack sets to approval with no approver, whose calls are refused (`no-approver`).
 */
export function catalogWarnings(pack: AgentPack): string[] {
  // a source of spaces no template names as a provider, a managed mode not built (TOOL-AVAIL-002, TOOL-FEAT-023)
  const warnings: string[] = featureWarnings(pack)
  const sources = Object.entries(pack.tools?.sources ?? {})
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
  // rule 1: the methods and the accepted combinations (D125, D126; IDENT-RES-010, IDENT-AUTH-001), what is read by the
  // model is stored and what is stored is asked (PRIV-EVID-006)
  if (identity.authentication) errors.push(...authenticationErrors(identity.authentication, pack))
  // an email, a document and a directory photo find or picture an entry of the user directory (IDENT-DIR-003/004/010)
  for (const [name, method] of Object.entries(identity.authentication?.methods ?? {})) {
    const needsDirectory =
      method.type === 'email' ||
      method.type === 'document' ||
      (method.type === 'face-match' && method.reference?.includes('directory'))
    if (needsDirectory && !identity.directory)
      errors.push(
        `rule 1: identity.authentication.methods.${name} (${method.type}) finds a person in the user directory: identity.directory names none`
      )
  }
  const authenticationStore = authenticationEvidencePolicy(pack).store?.attributes
  for (const [name, entry] of Object.entries(pack.presentations ?? {})) {
    if (name === AUTHENTICATION_ENTRY)
      errors.push('presentations: the name authentication is the entry of identity.authentication')
    if (name === DOCUMENT_ENTRY) errors.push('presentations: the name document is the entry of evidence.document')
    if (name === EMAIL_ENTRY) errors.push('presentations: the name email is the entry of evidence.email')
    if (name === FACE_MATCH_ENTRY) errors.push('presentations: the name face-match is the entry of a face match')
    errors.push(...evidencePolicyErrors(`presentations.${name}`, entry, entry.attributes))
  }
  // a document read gives a closed list of attributes: only those can be stored (PRIV-EVID-012)
  const document = pack.evidence?.document
  if (document) errors.push(...evidencePolicyErrors('evidence.document', document, [...DOCUMENT_ATTRIBUTES]))
  if (pack.evidence?.email)
    errors.push(...evidencePolicyErrors('evidence.email', pack.evidence.email, [...EMAIL_ATTRIBUTES]))
  // every claim of an issued credential has a source the agent can resolve (INTX-ISSUE-001/002)
  for (const [name, profile] of Object.entries(pack.issuance ?? {})) {
    // what a profile takes from a document is read by its own challenge, or by nothing (INTX-AUTH-010); a badge from the
    // directory takes it from the passport read when the person authenticated, empty without one (IDENT-DIR-005)
    const fromAuthentication = takesClaimsFromDirectory(profile)
    const readsDocument = Object.values(profile.claims).some((s) =>
      s.from === 'computed'
        ? s.fn === 'documentId'
        : s.from === 'evidence' && s.entry === DOCUMENT_ENTRY && !fromAuthentication
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
          ? authenticationStore
          : source.entry === DOCUMENT_ENTRY
            ? document?.store?.attributes
            : source.entry === EMAIL_ENTRY
              ? pack.evidence?.email?.store?.attributes
              : pack.presentations?.[source.entry]?.store?.attributes
      const known =
        source.entry === AUTHENTICATION_ENTRY
          ? credentialMethodsOf(pack).length > 0
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
  // the stewards of a template are declared roles (SPACE-MEMB-011)
  for (const t of pack.spaces?.templates ?? []) check(t.stewards, `spaces.templates.${t.id}.stewards`)
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
    // a tool's step-up (TOOL-CAT-010, IDENT-AUTH-015): the set of a re-authentication names enabled methods
    for (const [tool, decl] of Object.entries(source.tools ?? {}))
      errors.push(...stepUpAuthenticationErrors(pack, `tools.sources.${id}.tools.${tool}`, decl.stepUp?.authentication))
  }
  // the step-up of a tool of a feature profile, declared once on its feature (TOOL-FEAT-005)
  for (const [id, feature] of Object.entries(pack.tools?.features ?? {}))
    for (const [tool, decl] of Object.entries(feature.tools ?? {}))
      errors.push(
        ...stepUpAuthenticationErrors(pack, `tools.features.${id}.tools.${tool}`, decl.stepUp?.authentication)
      )

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
  // the admin interface's roles give nothing elsewhere (RBAC-XSESS-008)
  errors.push(...adminRoleErrors(pack))
  errors.push(...adminAccessErrors(pack))
  return errors
}

/**
 * What admin access needs (D127, D132, RBAC-ADMIN-002): a pack that declares `auditor` or `operator` names the set of
 * methods Show Admin asks on the phone, and every method of it is one `identity.authentication.methods` enables.
 */
export function adminAccessErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const declared = declaredAdminRoles(pack)
  const set = pack.admin?.authentication?.methods
  if (declared.length && !set?.length)
    errors.push(
      `RBAC-ADMIN-002: identity.roles declares [${declared.join(', ')}]: admin.authentication.methods must name the set of methods Show Admin asks on the phone`
    )
  const enabled = pack.identity.authentication?.methods ?? {}
  const unknown = (set ?? []).filter((name) => !enabled[name])
  if (unknown.length)
    errors.push(
      `RBAC-ADMIN-002: admin.authentication.methods names [${unknown.join(', ')}], which identity.authentication.methods does not enable`
    )
  return errors
}

/**
 * The admin interface's roles, `auditor` and `operator`, give nothing in conversations, spaces, memories or tools
 * (RBAC-XSESS-008): a pack that names one in a source's access, among the approvers, with `canApprove`, among the
 * creators of a template's spaces or among the roles a purpose permits is refused.
 */
export function adminRoleErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const refuse = (roles: Iterable<string> | undefined, where: string) => {
    for (const role of roles ?? [])
      if ((ADMIN_ROLES as readonly string[]).includes(role))
        errors.push(
          `RBAC-XSESS-008: ${where} names ${role}, a role of the admin interface, which gives nothing in conversations, spaces, memories or tools`
        )
  }
  for (const [id, source] of Object.entries(pack.tools?.sources ?? {})) {
    const access = source.access
    refuse(Object.keys(access?.roles ?? {}), `tools.sources.${id}.access.roles`)
    for (const [i, rule] of (access?.approval ?? []).entries())
      refuse(rule.approvers, `tools.sources.${id}.access.approval[${i}].approvers`)
    for (const [i, rule] of (access?.elevation ?? []).entries())
      refuse(rule.approvers, `tools.sources.${id}.access.elevation[${i}].approvers`)
  }
  refuse(pack.approvals?.approvers, 'approvals.approvers')
  refuse(
    Object.entries(pack.identity.roles ?? {})
      .filter(([, role]) => role.canApprove)
      .map(([name]) => name),
    'identity.roles (canApprove)'
  )
  for (const template of pack.spaces?.templates ?? [])
    refuse(template.creators, `spaces.templates.${template.id}.creators`)
  for (const purpose of pack.purposes ?? []) refuse(purpose.permittedRoles, `purposes.${purpose.id}.permittedRoles`)
  return errors
}

export interface LoadedPack {
  pack: AgentPack
  dir: string
  file: string
}

export function validatePackDocument(doc: unknown, env: Record<string, string | undefined>): AgentPack {
  // D120, TOOL-FEAT-023: a template's withdrawn `tools`, and a managing account not read from the deployment's secrets,
  // refused in words on the document as written, before its placeholders are resolved
  const written = featureDocumentErrors(doc)
  if (written.length) throw new PackError('agent-pack declares its features in a form this version refuses', written)
  const schema = loadSchema()
  const substituted = substitutePlaceholders(doc, env)
  const coerced = coerceBySchema(substituted, schema, schema) as Record<string, unknown>
  const version = String(coerced.schemaVersion ?? '')
  if (!/^3\.\d+$/.test(version)) {
    throw new PackError(`schemaVersion "${version}" is not supported (CORE-PACK-004, major 3 required)`)
  }
  // IDENT-ROLE-012: the people of the user directory are refused in words, before the schema names the key
  const inline = inlineDirectoryErrors(coerced)
  if (inline.length) throw new PackError('agent-pack writes the people of the user directory inline', inline)
  // TOOL-CAT-010, INTX-ISSUE-010: a challenge of a type that is a method of the authentication, refused in words
  const challenges = challengeTypeErrors(coerced)
  if (challenges.length)
    throw new PackError('agent-pack declares as a challenge what is a method of the authentication', challenges)
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
