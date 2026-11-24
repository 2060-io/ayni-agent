/**
 * The admin interface (D78, PRIV-ERASE-008, RBAC-XSESS-006 to 009): erasure, legal hold and the auditor's reads, on a
 * listener of its own that the deployment never exposes (it listens on the loopback: reach it with a port-forward).
 * Two locks keep it closed, the network and the person: a call is let in for a person it signed in, whose roles of the
 * user directory say what they may do (`auditor` reads, `operator` erases and holds, RBAC-XSESS-008), or with the
 * break-glass token, each such call recorded and flagged. Every record names the verified Principal and the reason,
 * never a name typed in the request; what an auditor reads never reaches the model.
 *
 * The person's sign-in with the phone and the badge (RBAC-XSESS-009) is not built: `signedIn` is its place. Until it
 * is, only the break-glass token opens the interface.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AdminRole } from '../config/packTypes.js'
import type { EvidenceService } from '../core/evidence.js'
import type { MessageEntry, Principal } from '../core/types.js'
import type { MemoryService } from '../memory/service.js'
import type { AdminAuditRecord, Store, StoredEntry } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'

export interface AdminDeps {
  store: Store
  memory: MemoryService
  evidence: EvidenceService
  logger: Logger
  /**
   * the break-glass token (`ADMIN_TOKEN`, RBAC-XSESS-009): a call that carries it as a bearer token is let in when no
   * phone is available, and its record is flagged; unset, no call is let in that way
   */
  breakGlassToken?: string
  /**
   * the Principal the admin interface signed in with their phone and their badge (RBAC-XSESS-009), for a call; none
   * when it signed nobody in. Not built: without it, a call without the break-glass token is refused
   */
  signedIn?: (request: FastifyRequest) => Promise<Principal | undefined>
  /** erased messages are told to the devices of their conversation (PROF-STREAM-008) */
  announceErased(principalId: string, conversationId: string, messageIds: string[], clientIds: string[]): Promise<void>
}

const LIMIT = 100_000

class AdminError extends Error {
  public constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** Who makes a call: a person the interface signed in, or the holder of the break-glass token (RBAC-XSESS-009). */
export type AdminCaller = { kind: 'principal'; principal: Principal } | { kind: 'break-glass' }

/**
 * Who makes the call, with the role it needs, and why (PRIV-ERASE-008, RBAC-XSESS-008/009): the verified Principal,
 * who holds the role, or the break-glass token; the reason from the body, or from the headers of a read. A name typed
 * in the request is not read.
 */
function callerOf(
  callers: WeakMap<FastifyRequest, AdminCaller>,
  request: FastifyRequest,
  role: AdminRole
): { caller: AdminCaller; reason: string } {
  const caller = callers.get(request)
  if (!caller) throw new AdminError(401, 'unauthorized')
  if (caller.kind === 'principal' && !caller.principal.roles.includes(role))
    throw new AdminError(403, `the admin interface's ${role} role is needed`)
  const body = (request.body ?? {}) as Record<string, unknown>
  const reason = String(body.reason ?? request.headers['x-ayni-reason'] ?? '').trim()
  if (!reason) throw new AdminError(400, 'reason is required')
  return { caller, reason }
}

/** What a call asked, as its record keeps it: what it names, never a name typed for who makes it (RBAC-XSESS-009). */
function asked(body: Record<string, unknown>): Record<string, unknown> {
  const { operator: _operator, auditor: _auditor, ...rest } = body
  return rest
}

/** What an auditor reads of an entry: its audit fields always, its content when its key still exists. */
function auditView(memory: MemoryService, stored: StoredEntry): Record<string, unknown> {
  const opened: MessageEntry = memory.open(stored)
  const { cipher: _c, encKeyRef: _k, ...audit } = stored
  return stored.state === 'crypto-erased' ? audit : { ...audit, text: opened.text, payload: opened.payload }
}

export function buildAdmin(deps: AdminDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  const { store, memory } = deps

  /** The record of a call: the verified Principal, or the break-glass token, flagged (RBAC-XSESS-009). */
  const record = async (
    caller: AdminCaller,
    r: Omit<AdminAuditRecord, 'id' | 'ts' | 'actor' | 'principalId' | 'breakGlass'>
  ): Promise<string> => {
    const full: AdminAuditRecord = {
      id: prefixedId('adm'),
      ts: nowIso(),
      ...r,
      ...(caller.kind === 'principal'
        ? { actor: caller.principal.id, principalId: caller.principal.id }
        : { actor: 'break-glass', breakGlass: true }),
    }
    await store.adminAudit.insert(full)
    const fields = { audit: full.id, action: full.action, actor: full.actor }
    if (full.breakGlass) deps.logger.warn(fields, 'admin call with the break-glass token')
    else deps.logger.info(fields, 'admin call')
    return full.id
  }

  // a call is let in for a person the interface signed in, or with the break-glass token; any other is refused
  const callers = new WeakMap<FastifyRequest, AdminCaller>()
  app.addHook('onRequest', async (request, reply) => {
    if (deps.breakGlassToken && request.headers.authorization === `Bearer ${deps.breakGlassToken}`) {
      callers.set(request, { kind: 'break-glass' })
      return
    }
    const principal = await deps.signedIn?.(request)
    if (principal) {
      callers.set(request, { kind: 'principal', principal })
      return
    }
    return reply.code(401).send({ error: 'unauthorized' })
  })
  app.setErrorHandler(async (error, _request, reply: FastifyReply) => {
    const status = error instanceof AdminError ? error.status : 500
    if (status === 500) deps.logger.error({ err: error }, 'admin call failed')
    await reply.code(status).send({ error: error instanceof AdminError ? error.message : 'internal' })
  })

  /** The entries a call names: by id, or every entry of a conversation or of a Principal. */
  const named = async (body: Record<string, unknown>): Promise<StoredEntry[]> => {
    const ids = Array.isArray(body.entryIds) ? body.entryIds.map(String) : []
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined
    const principalId = typeof body.principalId === 'string' ? body.principalId : undefined
    if (!ids.length && !conversationId && !principalId) {
      throw new AdminError(400, 'name entryIds, a conversationId or a principalId')
    }
    const rows: StoredEntry[] = []
    for (const id of ids) {
      const row = await store.entries.get(id)
      if (row) rows.push(row)
    }
    if (conversationId || principalId)
      rows.push(...(await store.entries.listAll({ conversationId, principalId, limit: LIMIT })))
    return [...new Map(rows.map((r) => [r.id, r])).values()]
  }

  app.get('/admin/health', async () => ({ status: 'ok' }))

  // PRIV-ERASE-008: erasure by a holder of the operator role, with its cascade; legal hold refuses it
  app.post('/admin/erasure', async (request) => {
    const { caller, reason } = callerOf(callers, request, 'operator')
    const body = (request.body ?? {}) as Record<string, unknown>
    const rows = await named(body)
    const missing = (Array.isArray(body.entryIds) ? body.entryIds.map(String) : []).filter(
      (id) => !rows.some((r) => r.id === id)
    )
    const erased: string[] = []
    const held: string[] = []
    const byConversation = new Map<string, { principalId: string | null; ids: string[]; clientIds: string[] }>()
    for (const row of rows) {
      if (row.state === 'crypto-erased') continue
      const result = await memory.erase(row.id)
      if (result.erased) {
        erased.push(row.id, ...result.cascaded)
        const group = byConversation.get(row.conversationId) ?? { principalId: row.principalId, ids: [], clientIds: [] }
        group.ids.push(row.id)
        // in the order of the ids, the empty string for an entry no client sent (PROF-STREAM-008)
        group.clientIds.push(row.externalId ?? '')
        byConversation.set(row.conversationId, group)
      } else if (result.reason === 'legal-hold') held.push(row.id)
    }
    for (const [conversationId, group] of byConversation) {
      if (group.principalId) await deps.announceErased(group.principalId, conversationId, group.ids, group.clientIds)
    }
    const auditId = await record(caller, {
      action: 'erasure',
      reason,
      detail: { request: asked(body), erased, held, notFound: missing },
    })
    return { erased, held, notFound: missing, auditId }
  })

  // PRIV-ERASE-004/008: legal hold set and released, by a holder of the operator role
  app.post('/admin/legal-hold', async (request) => {
    const { caller, reason } = callerOf(callers, request, 'operator')
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.hold !== 'boolean') throw new AdminError(400, 'hold must be true or false')
    const rows = await named(body)
    const { changed, skipped } = await memory.setLegalHold(
      rows.map((r) => r.id),
      body.hold
    )
    const auditId = await record(caller, {
      action: body.hold ? 'legal-hold' : 'legal-hold-release',
      reason,
      detail: { request: asked(body), changed, skipped },
    })
    return { changed, skipped, auditId }
  })

  // RBAC-XSESS-006/008: what a holder of the auditor role reads, outside every retrieval of the model, each read recorded
  app.get('/admin/audit/entries', async (request) => {
    const { caller, reason } = callerOf(callers, request, 'auditor')
    const q = request.query as { conversationId?: string; principalId?: string; limit?: string }
    if (!q.conversationId && !q.principalId) throw new AdminError(400, 'name a conversationId or a principalId')
    const limit = Math.min(Number(q.limit) || 1000, LIMIT)
    const rows = await store.entries.listAll({ conversationId: q.conversationId, principalId: q.principalId, limit })
    const auditId = await record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'entries', conversationId: q.conversationId, principalId: q.principalId, count: rows.length },
    })
    return { entries: rows.map((r) => auditView(memory, r)), auditId }
  })

  app.get('/admin/audit/evidence/:id', async (request) => {
    const { caller, reason } = callerOf(callers, request, 'auditor')
    const { id } = request.params as { id: string }
    const found = await deps.evidence.audit(id)
    const auditId = await record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'evidence', id, found: !!found },
    })
    if (!found) throw new AdminError(404, 'not-found')
    return { ...found, auditId }
  })

  // TOOL-PROV-005: the record of each call the model asked for, by Principal, space, conversation, source and period; no
  // argument, no result, no account value is in it, and the read is recorded with its auditor's Principal and reason
  app.get('/admin/audit/tool-calls', async (request) => {
    const { caller, reason } = callerOf(callers, request, 'auditor')
    const q = request.query as {
      principalId?: string
      spaceId?: string
      conversationId?: string
      sourceId?: string
      from?: string
      to?: string
      limit?: string
    }
    for (const [name, value] of [
      ['from', q.from],
      ['to', q.to],
    ] as const)
      if (value !== undefined && Number.isNaN(Date.parse(value))) throw new AdminError(400, `${name} is not a time`)
    const filter = {
      principalId: q.principalId || undefined,
      spaceId: q.spaceId || undefined,
      conversationId: q.conversationId || undefined,
      sourceId: q.sourceId || undefined,
      from: q.from ? new Date(q.from).toISOString() : undefined,
      to: q.to ? new Date(q.to).toISOString() : undefined,
    }
    const calls = await store.toolCalls.list({ ...filter, limit: Math.min(Number(q.limit) || 1000, LIMIT) })
    const auditId = await record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'tool-calls', ...filter, count: calls.length },
    })
    return { calls, auditId }
  })

  app.get('/admin/audit/log', async (request) => {
    const { caller, reason } = callerOf(callers, request, 'auditor')
    const q = request.query as { limit?: string }
    const records = await store.adminAudit.list(Math.min(Number(q.limit) || 100, 1000))
    const auditId = await record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'admin-log', count: records.length },
    })
    return { records, auditId }
  })

  return app
}
