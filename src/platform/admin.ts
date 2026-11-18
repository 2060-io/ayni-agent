/**
 * The admin interface (D78, PRIV-ERASE-008, RBAC-XSESS-006): erasure, legal hold and the auditor's reads, on a
 * listener of its own that the deployment never exposes (it listens on the loopback: reach it with a port-forward).
 * Every call names who makes it and why, and leaves a record; what an auditor reads never reaches the model.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { EvidenceService } from '../core/evidence.js'
import type { MessageEntry } from '../core/types.js'
import type { MemoryService } from '../memory/service.js'
import type { AdminAuditRecord, Store, StoredEntry } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'

export interface AdminDeps {
  store: Store
  memory: MemoryService
  evidence: EvidenceService
  logger: Logger
  /** when set, every call carries it as a bearer token */
  token?: string
  /** erased messages are told to the devices of their conversation (PROF-STREAM-008) */
  announceErased(principalId: string, conversationId: string, messageIds: string[]): Promise<void>
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

/** Who makes the call and why (PRIV-ERASE-008): from the body, or from the headers of a read. */
function actorOf(request: FastifyRequest, role: 'operator' | 'auditor'): { actor: string; reason: string } {
  const body = (request.body ?? {}) as Record<string, unknown>
  const headers = request.headers
  const actor = String(body[role] ?? headers[`x-ayni-${role}`] ?? '').trim()
  const reason = String(body.reason ?? headers['x-ayni-reason'] ?? '').trim()
  if (!actor) throw new AdminError(400, `${role} is required`)
  if (!reason) throw new AdminError(400, 'reason is required')
  return { actor, reason }
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

  const record = async (r: Omit<AdminAuditRecord, 'id' | 'ts'>): Promise<string> => {
    const full: AdminAuditRecord = { id: prefixedId('adm'), ts: nowIso(), ...r }
    await store.adminAudit.insert(full)
    deps.logger.info({ audit: full.id, action: full.action, actor: full.actor }, 'admin call')
    return full.id
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!deps.token) return
    if (request.headers.authorization !== `Bearer ${deps.token}`) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
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

  // PRIV-ERASE-008: erasure by an operator, with its cascade; legal hold refuses it
  app.post('/admin/erasure', async (request) => {
    const { actor, reason } = actorOf(request, 'operator')
    const body = (request.body ?? {}) as Record<string, unknown>
    const rows = await named(body)
    const missing = (Array.isArray(body.entryIds) ? body.entryIds.map(String) : []).filter(
      (id) => !rows.some((r) => r.id === id)
    )
    const erased: string[] = []
    const held: string[] = []
    const byConversation = new Map<string, { principalId: string | null; ids: string[] }>()
    for (const row of rows) {
      if (row.state === 'crypto-erased') continue
      const result = await memory.erase(row.id)
      if (result.erased) {
        erased.push(row.id, ...result.cascaded)
        const group = byConversation.get(row.conversationId) ?? { principalId: row.principalId, ids: [] }
        group.ids.push(row.id)
        byConversation.set(row.conversationId, group)
      } else if (result.reason === 'legal-hold') held.push(row.id)
    }
    for (const [conversationId, group] of byConversation) {
      if (group.principalId) await deps.announceErased(group.principalId, conversationId, group.ids)
    }
    const auditId = await record({
      action: 'erasure',
      actor,
      reason,
      detail: { request: body, erased, held, notFound: missing },
    })
    return { erased, held, notFound: missing, auditId }
  })

  // PRIV-ERASE-004/008: legal hold set and released
  app.post('/admin/legal-hold', async (request) => {
    const { actor, reason } = actorOf(request, 'operator')
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.hold !== 'boolean') throw new AdminError(400, 'hold must be true or false')
    const rows = await named(body)
    const { changed, skipped } = await memory.setLegalHold(
      rows.map((r) => r.id),
      body.hold
    )
    const auditId = await record({
      action: body.hold ? 'legal-hold' : 'legal-hold-release',
      actor,
      reason,
      detail: { request: body, changed, skipped },
    })
    return { changed, skipped, auditId }
  })

  // RBAC-XSESS-002/006: what an auditor reads, outside every retrieval of the model, each read recorded
  app.get('/admin/audit/entries', async (request) => {
    const { actor, reason } = actorOf(request, 'auditor')
    const q = request.query as { conversationId?: string; principalId?: string; limit?: string }
    if (!q.conversationId && !q.principalId) throw new AdminError(400, 'name a conversationId or a principalId')
    const limit = Math.min(Number(q.limit) || 1000, LIMIT)
    const rows = await store.entries.listAll({ conversationId: q.conversationId, principalId: q.principalId, limit })
    const auditId = await record({
      action: 'audit-read',
      actor,
      reason,
      detail: { what: 'entries', conversationId: q.conversationId, principalId: q.principalId, count: rows.length },
    })
    return { entries: rows.map((r) => auditView(memory, r)), auditId }
  })

  app.get('/admin/audit/evidence/:id', async (request) => {
    const { actor, reason } = actorOf(request, 'auditor')
    const { id } = request.params as { id: string }
    const found = await deps.evidence.audit(id)
    const auditId = await record({
      action: 'audit-read',
      actor,
      reason,
      detail: { what: 'evidence', id, found: !!found },
    })
    if (!found) throw new AdminError(404, 'not-found')
    return { ...found, auditId }
  })

  app.get('/admin/audit/log', async (request) => {
    const { actor, reason } = actorOf(request, 'auditor')
    const q = request.query as { limit?: string }
    const records = await store.adminAudit.list(Math.min(Number(q.limit) || 100, 1000))
    const auditId = await record({
      action: 'audit-read',
      actor,
      reason,
      detail: { what: 'admin-log', count: records.length },
    })
    return { records, auditId }
  })

  return app
}
