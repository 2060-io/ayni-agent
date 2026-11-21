/**
 * A space's account, field by field (ayni-spec D102, TOOL-CAT-002, TOOL-ACCESS-005): the agent-pack declares the fields
 * its owner fills and, in `apply`, the headers each call carries, a header's value naming fields as `{name}`. The values
 * are opened in memory for a call; the headers are built from them then, and never logged. An echo of a value, or of a
 * built header, in what a tool answers is replaced by `[account]` before anything records or reads it.
 */
import type { AccountField, SourceAccount } from '../config/packTypes.js'

/** What an echo of the account reads in a result (TOOL-ACCESS-005). */
export const ACCOUNT_MASK = '[account]'

/** A placeholder of a header's value: `{name}`, the value of the field of that name. */
export const FIELD_PLACEHOLDER = /\{([^{}]*)\}/g

/** The field names a header's value names, in order (`{api_key}:{api_secret}` names `api_key`, `api_secret`). */
export function fieldsNamedBy(value: string): string[] {
  return [...value.matchAll(FIELD_PLACEHOLDER)].map((m) => m[1] ?? '')
}

/** Whether sealed values fit the fields of an account: one text for every field, and no other (D102). */
export function fitsFields(fields: readonly AccountField[], values: unknown): values is Record<string, string> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false
  const record = values as Record<string, unknown>
  const names = Object.keys(record)
  return (
    names.length === fields.length &&
    fields.every((f) => typeof record[f.name] === 'string' && (record[f.name] as string).length > 0)
  )
}

/** The headers of a call: each `{name}` of each value of `apply` replaced by the value of that field (TOOL-ACCESS-005). */
export function buildAccountHeaders(account: SourceAccount, values: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const { header, value } of account.apply ?? [])
    headers[header] = value.replace(FIELD_PLACEHOLDER, (_m, name: string) => values[name] ?? '')
  return headers
}

/** Every value of the account and every header built from them, the longest first, as an echo is scrubbed of them. */
export function accountSecrets(values: Record<string, string>, headers: Record<string, string>): string[] {
  const all = new Set([...Object.values(values), ...Object.values(headers)].filter((s) => s.length > 0))
  return [...all].sort((a, b) => b.length - a.length)
}

/**
 * A value with every echo of the account replaced by `[account]`, in its text, its keys and its items (TOOL-ACCESS-005).
 * The longest come first, so that a built header goes whole before the values it is made of.
 */
export function scrubAccount<T>(value: T, secrets: readonly string[] | undefined): T {
  if (!secrets?.length) return value
  if (typeof value === 'string') {
    let text: string = value
    for (const secret of secrets) text = text.split(secret).join(ACCOUNT_MASK)
    return text as T
  }
  if (Array.isArray(value)) return value.map((item) => scrubAccount(item, secrets)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[scrubAccount(key, secrets)] = scrubAccount(item, secrets)
    return out as T
  }
  return value
}
