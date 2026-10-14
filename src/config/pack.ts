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
import type { AgentPack, ToolAccess } from './packTypes.js'
import { featuresOf } from './packTypes.js'

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
  if (b.principalPreferences?.enabled !== false) names.push('principal_preferences')
  if (b.workingMemory?.enabled !== false) names.push('working_memory')
  return names
}

/** Cross-field rules 1 to 9 of docs/agent-pack.md plus PRIV-RETN-006. */
export function crossFieldErrors(pack: AgentPack): string[] {
  const errors: string[] = []
  const identity = pack.identity
  const homes = identity.recognizedBackingIdentities.filter((e) => e.relation === 'home')
  if (homes.length !== 1) errors.push('rule 1: exactly one recognizedBackingIdentities entry must have relation home')
  else if (homes[0].identity !== identity.homeBackingIdentity) {
    errors.push('rule 1: identity.homeBackingIdentity must be the entry with relation home')
  }

  const declaredRoles = new Set(Object.keys(identity.roles ?? {}))
  const check = (roles: string[] | undefined, where: string) => {
    for (const role of roles ?? []) {
      if (!declaredRoles.has(role)) errors.push(`rule 2: role "${role}" in ${where} is not declared in identity.roles`)
    }
  }
  for (const [i, rule] of identity.roleRules.entries()) check(rule.roles, `identity.roleRules[${i}]`)
  for (const [i, o] of (identity.perActorOverrides ?? []).entries()) check(o.roles, `identity.perActorOverrides[${i}]`)
  for (const p of pack.purposes ?? []) check(p.permittedRoles, `purposes.${p.id}.permittedRoles`)
  for (const m of pack.persona.menu ?? []) check(m.roles, `persona.menu.${m.id}.roles`)

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
