import { randomBytes, randomUUID } from 'node:crypto'

export const uuid = (): string => randomUUID()

/** Prefixed, URL-safe identifiers for the wire (ses_, msg_, apr_, att_, run_). */
export function prefixedId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`
}

export const nowIso = (): string => new Date().toISOString()

let lastStamp = 0
/**
 * Now, strictly after the time this function gave last in the process: two entries recorded one after the other in
 * the same millisecond keep their order, which (time, id) with a random id would not.
 */
export function monotonicIso(): string {
  const now = Date.now()
  lastStamp = now > lastStamp ? now : lastStamp + 1
  return new Date(lastStamp).toISOString()
}
