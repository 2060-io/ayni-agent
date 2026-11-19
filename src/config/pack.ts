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
import type { AgentPack, AuthenticationEntry, EvidencePolicy, SpaceTemplate, ToolAccess } from './packTypes.js'
import {
  COMPUTED_FUNCTIONS,
  challengeTypesOf,
  DOCUMENT_ATTRIBUTES,
  EMAIL_ATTRIBUTES,
  featuresOf,
  PERSONAL_RETENTION_DAYS,
  providerNameOf,
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
    const props = (schema.properties ?? {}) as Record<string, Schema>
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

export function bundledToolNames(pack: AgentPack): string[] {
  const b = pack.tools?.bundled ?? {}
  const names: string[] = []
  if (b.statistics?.enabled) names.push('statistics')
  if (b.generateImage?.enabled) names.push('generate_image')
  if (b.principalCredentials?.enabled !== false) names.push('principal_credentials')
  const asksOnDemand = Object.values(pack.presentations ?? {}).some((e) => e.request === 'on-demand')
  if (b.requestPresentation?.enabled !== false && (pack.identity.authentication?.length || asksOnDemand))
    names.push('request_presentation')
  if (b.credentialIssuance?.enabled !== false && Object.keys(pack.issuance ?? {}).length) {
    names.push('credential_requirements')
    if (Object.values(pack.issuance ?? {}).some((p) => (p.trigger ?? 'model') === 'model'))
      names.push('issue_credential')
  }
  if (b.principalPreferences?.enabled !== false) names.push('principal_preferences')
  if (b.workingMemory?.enabled !== false) names.push('working_memory')
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
 * The email code belongs to the issuance profiles that take claims from the user directory and to no other action
 * (INTX-AUTH-011): an action that declares it is refused in words, before the schema, which would only name the value.
 */
export function emailChallengeActionErrors(doc: unknown): string[] {
  const actions = (doc as { actions?: Record<string, { authChallenge?: { type?: unknown } }> })?.actions
  if (!actions || typeof actions !== 'object') return []
  return Object.entries(actions)
    .filter(([, policy]) => policy?.authChallenge?.type === 'email')
    .map(
      ([tool]) =>
        `actions.${tool}.authChallenge: the email code is the challenge of an issuance profile that takes claims from the user directory, and of no other action (INTX-AUTH-011)`
    )
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
  const declaredTools = new Set<string>([...(pack.tools?.http ?? []).map((t) => t.name), ...bundledToolNames(pack)])
  const checkAccess = (access: ToolAccess | undefined, where: string, mcp: boolean) => {
    if (!access) return
    for (const [role, tools] of Object.entries(access.roles ?? {})) {
      check([role], `${where}.roles`)
      if (!mcp) {
        for (const t of tools) {
          if (t !== '*' && !declaredTools.has(t))
            errors.push(`rule 5: tool "${t}" in ${where}.roles.${role} is not declared`)
        }
      }
    }
    for (const rule of [...(access.approval ?? []), ...(access.elevation ?? [])]) {
      check(rule.approvers, where)
      for (const r of rule.approvers) {
        if (!identity.roles?.[r]?.canApprove) errors.push(`rule 3: approver role "${r}" in ${where} has no canApprove`)
      }
      if (!mcp)
        for (const t of rule.tools)
          if (!declaredTools.has(t)) errors.push(`rule 5: tool "${t}" in ${where} is not declared`)
    }
    for (const rule of access.elevation ?? []) {
      for (const p of rule.purposes)
        if (!purposeIds.has(p)) errors.push(`rule 4: purpose "${p}" in ${where}.elevation is not in purposes`)
    }
  }
  checkAccess(pack.tools?.access, 'tools.access', false)
  for (const s of pack.mcp?.servers ?? []) checkAccess(s.toolAccess, `mcp.servers.${s.name}.toolAccess`, true)

  const hasMcp = (pack.mcp?.servers ?? []).length > 0
  for (const [tool, policy] of Object.entries(pack.actions ?? {})) {
    if (!declaredTools.has(tool) && !hasMcp) errors.push(`rule 5: actions.${tool} refers to an undeclared tool`)
    if (policy.authChallenge?.type === 'face-match' && !pack.media?.faceVerification) {
      errors.push(`rule 6: actions.${tool}.authChallenge face-match requires media.faceVerification`)
    }
  }
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

  const gen = pack.tools?.bundled?.generateImage
  if (gen?.enabled && gen.provider && !pack.media?.imageGeneration?.providers.some((p) => p.name === gen.provider)) {
    errors.push(
      `rule 8: tools.bundled.generateImage.provider "${gen.provider}" is not a media.imageGeneration provider`
    )
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
  // INTX-AUTH-011: an action that declares the email code is refused in words, before the schema names the value
  const email = emailChallengeActionErrors(coerced)
  if (email.length)
    throw new PackError('agent-pack declares an email challenge outside a badge from the directory', email)
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true })
  addFormats.default(ajv)
  const validate = ajv.compile(schema)
  if (!validate(coerced)) {
    const details = (validate.errors ?? []).map((e) => {
      const extra = e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''
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
