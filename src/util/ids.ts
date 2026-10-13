import { randomBytes, randomUUID } from 'node:crypto'

export const uuid = (): string => randomUUID()

/** Prefixed, URL-safe identifiers for the wire (ses_, msg_, apr_, att_, run_). */
export function prefixedId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`
}

export const nowIso = (): string => new Date().toISOString()
