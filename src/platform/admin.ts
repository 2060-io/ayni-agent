/**
 * Admin access to the raw store (ayni-spec D78, D132 to D134; RBAC-XSESS-006 to 009, RBAC-ADMIN-005 to 008,
 * PRIV-ERASE-008, TOOL-PROV-005): what Audit reads and what Operations does, outside every retrieval of the model.
 *
 * Two callers reach it. A person whose roles hold `auditor` or `operator`, through the AG-UI profile while an admin
 * grant is open for their device (§3.14, `adminGrants.ts`): each record names their verified Principal and the grant.
 * And, only when the agent-pack enables it (`admin.internal.enabled`), the internal admin interface built here, on a
 * listener of its own on the loopback, which opens to the break-glass token `ADMIN_TOKEN` alone: each record is flagged.
 * Every call carries a reason, refused `400 reason-required` without one, and writes one record of the admin audit; a
 * name typed in the request is never read. Nothing Audit reads reaches a model.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { entryToMessages } from '../channels/agui/mapping.js'
import type { SealedConversations } from '../core/conversationSeal.js'
import { fold, type UserDirectory } from '../core/directory.js'
import type { EvidenceService } from '../core/evidence.js'
import { spaceIdOf } from '../core/spaces.js'
import type { MessageEntry, Principal } from '../core/types.js'
import type { MemoryService } from '../memory/service.js'
import type { AdminAuditRecord, Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'

/** At most this many rows of one read. */
const LIMIT = 100_000
/** At most this many people of one search of Audit. */
const PEOPLE_LIMIT = 20

/** A refusal of admin access, with the status and the code of the AG-UI profile (§3.14, §9). */
export class AdminError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code:
      | 'unauthorized'
      | 'bad-request'
      | 'reason-required'
      | 'forbidden'
      | 'admin-closed'
      | 'not-auditor'
      | 'not-operator'
      | 'not-found'
      | 'not-implemented',
    message: string,
    public readonly field?: string
  ) {
    super(message)
  }
}

/**
 * Who makes a call: a person through an open admin grant (RBAC-ADMIN-007), or the holder of the break-glass token of the
 * internal admin interface (RBAC-XSESS-009).
 */
export type AdminCaller = { kind: 'principal'; principal: Principal; grantId: string } | { kind: 'break-glass' }

/** The reason of a call, as the person typed it: at least one word (RBAC-ADMIN-006). */
export function reasonOf(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (!/[\p{L}\p{N}]/u.test(reason)) throw new AdminError(400, 'reason-required', 'say why you need this')
  return reason
}

const time = (name: string, value: string | undefined): string | undefined => {
  if (!value) return undefined
  if (Number.isNaN(Date.parse(value))) throw new AdminError(400, 'bad-request', `${name} is not a time`, name)
  return new Date(value).toISOString()
}

const limitOf = (value: string | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(Number(value) || fallback, 1), max)

export interface AdminServiceDeps {
  store: Store
  memory: MemoryService
  evidence: EvidenceService
  /** the conversations, their titles opened (D77) */
  conversations: SealedConversations
  /** the user directory, when the agent-pack names one: the names, departments and addresses of its entries */
  directory?: Pick<UserDirectory, 'view' | 'entry'>
  logger: Logger
  /** erased messages are told to the devices of their conversation (PROF-STREAM-008) */
  announceErased(principalId: string, conversationId: string, messageIds: string[], clientIds: string[]): Promise<void>
}

/** A conversation as Audit finds it (PROF-ADMIN-005). */
export interface AuditConversation {
  id: string
  principalId: string
  spaceId: string
  title: string
  state: string
  createdAt: string
  lastActivityAt: string
}

/** One person of a search of Audit: the Principal to find conversations by, never an address. */
export interface AuditPerson {
  principalId: string
  name: string
  department: string | null
}

/** One key of Operations (PROF-ADMIN-006): its versions, how many keys each wraps, a rotation in progress. */
export interface KeyInfo {
  key: 'master' | 'index'
  versions: { version: number; current: boolean; wraps: number | null }[]
  rotation: { from: number; to: number; done: number; total: number } | null
  rotatable: boolean
}

/** The fields of a record of the admin audit that a call gives; `record` adds who made it. */
type RecordInput = Omit<AdminAuditRecord, 'id' | 'ts' | 'actor' | 'principalId' | 'breakGlass' | 'grantId'>

/** What Audit reads and Operations does, each call recorded with its caller and its reason (RBAC-ADMIN-006/007). */
export class AdminService {
  public constructor(private readonly deps: AdminServiceDeps) {}

  /** One record of the admin audit: the verified Principal and the grant, or the break-glass token, flagged. */
  public async record(caller: AdminCaller, r: RecordInput): Promise<string> {
    const full: AdminAuditRecord = {
      id: prefixedId('adm'),
      ts: nowIso(),
      ...r,
      ...(caller.kind === 'principal'
        ? { actor: caller.principal.id, principalId: caller.principal.id, grantId: caller.grantId }
        : { actor: 'break-glass', breakGlass: true }),
    }
    await this.deps.store.adminAudit.insert(full)
    const fields = { audit: full.id, action: full.action, actor: full.actor }
    if (full.breakGlass) this.deps.logger.warn(fields, 'admin call with the break-glass token')
    else this.deps.logger.info(fields, 'admin call')
    return full.id
  }

  // ---- Audit (RBAC-ADMIN-008, PROF-ADMIN-005): reads only -------------------------------------------------------------

  /**
   * The people Audit can find conversations of, by name (Fabrice, 2026-11-24): the Principals the agent knows that have
   * a name, those that hold a directory entry and the people an authentication identified, whose name, or address when
   * the agent knows one, contains `q`, compared without regard to case or marks; at most twenty, by name. A visitor
   * (named by nobody) and a service are not people. The address is matched and never answered.
   */
  public async people(
    caller: AdminCaller,
    reason: string,
    q: string | undefined
  ): Promise<{ people: AuditPerson[]; auditId: string }> {
    const needle = fold((q ?? '').trim())
    if (!needle) throw new AdminError(400, 'bad-request', 'type part of a name or an address', 'q')
    const directory = this.deps.directory
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined
    const found: (AuditPerson & { key: string })[] = []
    for (const p of await this.deps.store.principals.list()) {
      if (p.connectionType !== 'verifiable-user-agent') continue
      const view = p.directoryEntryId ? directory?.view(p.directoryEntryId) : undefined
      // a person who holds an entry, or whom an authentication identified; a visitor is nobody's name
      if (!view && !p.identityCredentialRef) continue
      const name = view?.name ?? text(p.identityAttributes.userName)
      if (!name) continue
      const email =
        (p.directoryEntryId ? directory?.entry(p.directoryEntryId)?.email : undefined) ??
        text(p.identityAttributes.email)
      if (!fold(name).includes(needle) && !(email && fold(email).includes(needle))) continue
      const department = view?.department ?? text(p.identityAttributes.department) ?? null
      found.push({ principalId: p.id, name, department, key: fold(name) })
    }
    const people = found
      .sort((a, b) => a.key.localeCompare(b.key) || a.principalId.localeCompare(b.principalId))
      .slice(0, PEOPLE_LIMIT)
      .map(({ key: _key, ...person }) => person)
    const auditId = await this.record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'people', q: q?.trim(), count: people.length },
    })
    return { people, auditId }
  }

  /** The conversations found by Principal, space and period (active within it), newest activity first. */
  public async conversations(
    caller: AdminCaller,
    reason: string,
    q: { principal?: string; space?: string; from?: string; to?: string }
  ): Promise<{ conversations: AuditConversation[]; auditId: string }> {
    const from = time('from', q.from)
    const to = time('to', q.to)
    const { conversations } = this.deps
    const found = q.principal
      ? await conversations.listByPrincipal(q.principal, ['active', 'archived', 'final'])
      : q.space
        ? await conversations.listBySpace(q.space)
        : await conversations.listAll()
    const rows = found
      .filter((c) => !q.space || spaceIdOf(c) === q.space)
      .filter((c) => (!from || c.lastActivityAt >= from) && (!to || c.createdAt <= to))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map(
        (c): AuditConversation => ({
          id: c.id,
          principalId: c.principalId,
          spaceId: spaceIdOf(c),
          title: c.title,
          state: c.state,
          createdAt: c.createdAt,
          lastActivityAt: c.lastActivityAt,
        })
      )
    const auditId = await this.record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'conversations', principal: q.principal, space: q.space, from, to, count: rows.length },
    })
    return { conversations: rows, auditId }
  }

  /**
   * The entries of a conversation, decrypted: the newest page first, as the history serves them (§8); an erased entry
   * reads `[erased]`.
   */
  public async messages(
    caller: AdminCaller,
    reason: string,
    conversationId: string,
    q: { before?: string; limit?: string }
  ): Promise<{ entries: MessageEntry[]; nextBefore: string | null; auditId: string }> {
    const conversation = await this.deps.conversations.get(conversationId)
    if (!conversation) throw new AdminError(404, 'not-found', 'no such conversation')
    const limit = limitOf(q.limit, 50, 200)
    // newest first
    const all = (await this.deps.store.entries.listAll({ conversationId, limit: LIMIT })).reverse()
    const start = q.before ? all.findIndex((e) => e.id === q.before) + 1 : 0
    const page = q.before && start === 0 ? [] : all.slice(start, start + limit)
    const more = start + page.length < all.length
    const auditId = await this.record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'messages', conversationId, principalId: conversation.principalId, count: page.length },
    })
    return {
      entries: page.map((e) => this.deps.memory.open(e)),
      nextBefore: more && page.length ? (page.at(-1)?.id ?? null) : null,
      auditId,
    }
  }

  /** The evidence records of a Principal: their audit fields and the values stored. */
  public async evidence(
    caller: AdminCaller,
    reason: string,
    principalId: string | undefined
  ): Promise<{ evidence: { record: unknown; values: Record<string, string> }[]; auditId: string }> {
    if (!principalId) throw new AdminError(400, 'bad-request', 'name a principal', 'principal')
    const out: { record: unknown; values: Record<string, string> }[] = []
    for (const stored of await this.deps.store.evidence.list(principalId)) {
      const found = await this.deps.evidence.audit(stored.id)
      if (found) out.push(found)
    }
    const auditId = await this.record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'evidence', principalId, count: out.length },
    })
    return { evidence: out, auditId }
  }

  /**
   * The record of each call the model asked for, by Principal, space, conversation, source and period (TOOL-PROV-005):
   * no argument, no result and no account value is in it.
   */
  public async toolCalls(
    caller: AdminCaller,
    reason: string,
    q: {
      principal?: string
      space?: string
      conversation?: string
      source?: string
      from?: string
      to?: string
      limit?: string
    }
  ): Promise<{ calls: unknown[]; auditId: string }> {
    const filter = {
      principalId: q.principal || undefined,
      spaceId: q.space || undefined,
      conversationId: q.conversation || undefined,
      sourceId: q.source || undefined,
      from: time('from', q.from),
      to: time('to', q.to),
    }
    const calls = await this.deps.store.toolCalls.list({ ...filter, limit: limitOf(q.limit, 1000, LIMIT) })
    const auditId = await this.record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'tool-calls', ...filter, count: calls.length },
    })
    return { calls, auditId }
  }

  /** The admin audit, newest first, by pages; the read is itself recorded once the page is read. */
  public async log(
    caller: AdminCaller,
    reason: string,
    q: { before?: string; limit?: string }
  ): Promise<{ records: AdminAuditRecord[]; nextBefore: string | null; auditId: string }> {
    const limit = limitOf(q.limit, 100, 1000)
    const rows = await this.deps.store.adminAudit.list(limit + 1, q.before ? { before: q.before } : undefined)
    const records = rows.slice(0, limit)
    const auditId = await this.record(caller, {
      action: 'audit-read',
      reason,
      detail: { what: 'admin-log', before: q.before, count: records.length },
    })
    return { records, nextBefore: rows.length > limit ? (records.at(-1)?.id ?? null) : null, auditId }
  }

  // ---- Operations (PRIV-ERASE-008, PROF-ADMIN-006) --------------------------------------------------------------------

  /** Erases entries, with their cascade; legal hold refuses it. The devices of their conversations are told. */
  public async erase(
    caller: AdminCaller,
    reason: string,
    entryIds: unknown
  ): Promise<{ erased: string[]; held: string[]; notFound: string[]; auditId: string }> {
    if (!Array.isArray(entryIds) || !entryIds.length)
      throw new AdminError(400, 'bad-request', 'name the entries to erase', 'entryIds')
    const ids = [...new Set(entryIds.map(String))]
    const erased: string[] = []
    const held: string[] = []
    const notFound: string[] = []
    const byConversation = new Map<string, { principalId: string | null; ids: string[]; clientIds: string[] }>()
    for (const id of ids) {
      const row = await this.deps.store.entries.get(id)
      if (!row) {
        notFound.push(id)
        continue
      }
      if (row.state === 'crypto-erased') continue
      const result = await this.deps.memory.erase(row.id)
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
      if (group.principalId)
        await this.deps.announceErased(group.principalId, conversationId, group.ids, group.clientIds)
    }
    const auditId = await this.record(caller, {
      action: 'erasure',
      reason,
      detail: { entryIds: ids, erased, held, notFound },
    })
    return { erased, held, notFound, auditId }
  }

  /** Sets or releases legal hold on entries, or on every entry of a conversation (PRIV-ERASE-004). */
  public async legalHold(
    caller: AdminCaller,
    reason: string,
    body: { entryIds?: unknown; conversationId?: unknown; hold?: unknown }
  ): Promise<{ changed: string[]; skipped: string[]; auditId: string }> {
    if (typeof body.hold !== 'boolean') throw new AdminError(400, 'bad-request', 'hold must be true or false', 'hold')
    const entryIds = Array.isArray(body.entryIds) ? [...new Set(body.entryIds.map(String))] : []
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined
    if (!entryIds.length && !conversationId)
      throw new AdminError(400, 'bad-request', 'name entryIds or a conversationId', 'entryIds')
    const ids = [...entryIds]
    if (conversationId)
      ids.push(...(await this.deps.store.entries.listAll({ conversationId, limit: LIMIT })).map((r) => r.id))
    const { changed, skipped } = await this.deps.memory.setLegalHold([...new Set(ids)], body.hold)
    const auditId = await this.record(caller, {
      action: body.hold ? 'legal-hold' : 'legal-hold-release',
      reason,
      detail: { entryIds, conversationId, changed, skipped },
    })
    return { changed, skipped, auditId }
  }

  /**
   * The keys' versions (PRIV-KEY-008). The key store is not built: the master key is the deployment's
   * `ENTRY_ENCRYPTION_KEY` and the index key is derived from it, each in its one version, and neither can be rotated.
   */
  public async keys(
    caller: AdminCaller,
    reason: string
  ): Promise<{ keys: KeyInfo[]; keyService: null; auditId: string }> {
    const keys: KeyInfo[] = [
      { key: 'master', versions: [{ version: 1, current: true, wraps: null }], rotation: null, rotatable: false },
      { key: 'index', versions: [{ version: 1, current: true, wraps: null }], rotation: null, rotatable: false },
    ]
    const auditId = await this.record(caller, { action: 'audit-read', reason, detail: { what: 'keys' } })
    return { keys, keyService: null, auditId }
  }

  /** A rotation of the master key or of the index key needs the key store, which is not built (PRIV-KEY-008). */
  public async rotate(_caller: AdminCaller, _reason: string, key: string): Promise<never> {
    if (key !== 'master' && key !== 'index') throw new AdminError(404, 'not-found', 'no such key')
    throw new AdminError(501, 'not-implemented', `the ${key} key cannot be rotated: the key store is not built`)
  }
}

/** The answer of a refusal, as the AG-UI profile writes it (§9). */
export function adminErrorBody(error: AdminError): Record<string, unknown> {
  return { error: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }
}

export interface InternalAdminDeps {
  service: AdminService
  logger: Logger
  /** the break-glass token (`ADMIN_TOKEN`): the only way in (RBAC-XSESS-009) */
  breakGlassToken: string
}

/**
 * The internal admin interface (D134, RBAC-XSESS-009), built only when the agent-pack enables it: what Audit and
 * Operations serve, at the paths of the AG-UI profile (§3.14) under `/admin`, for a call that carries the break-glass
 * token as a bearer token; any other call, the health probe included, is `401`. A read takes its reason in the query, an
 * action in the body. Each call is recorded and flagged.
 */
export function buildAdmin(deps: InternalAdminDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  const { service } = deps
  const caller: AdminCaller = { kind: 'break-glass' }

  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${deps.breakGlassToken}`)
      return reply.code(401).send({ error: 'unauthorized' })
  })
  app.setErrorHandler(async (error, _request, reply: FastifyReply) => {
    if (error instanceof AdminError) return reply.code(error.status).send(adminErrorBody(error))
    deps.logger.error({ err: error }, 'admin call failed')
    return reply.code(500).send({ error: 'internal' })
  })

  type Query = Record<string, string | undefined>
  const query = (request: FastifyRequest) => (request.query ?? {}) as Query
  const body = (request: FastifyRequest) => (request.body ?? {}) as Record<string, unknown>

  app.get('/admin/health', async () => ({ status: 'ok' }))
  app.get('/admin/audit/conversations', async (request) => {
    const q = query(request)
    return service.conversations(caller, reasonOf(q.reason), q)
  })
  app.get('/admin/audit/conversations/:id/messages', async (request) => {
    const q = query(request)
    const { id } = request.params as { id: string }
    const { entries, nextBefore, auditId } = await service.messages(caller, reasonOf(q.reason), id, q)
    return { messages: [...entries].reverse().flatMap((e) => entryToMessages(e)), nextBefore, auditId }
  })
  app.get('/admin/audit/people', async (request) => {
    const q = query(request)
    return service.people(caller, reasonOf(q.reason), q.q)
  })
  app.get('/admin/audit/evidence', async (request) => {
    const q = query(request)
    return service.evidence(caller, reasonOf(q.reason), q.principal)
  })
  app.get('/admin/audit/tool-calls', async (request) => {
    const q = query(request)
    return service.toolCalls(caller, reasonOf(q.reason), q)
  })
  app.get('/admin/audit/log', async (request) => {
    const q = query(request)
    return service.log(caller, reasonOf(q.reason), q)
  })
  app.post('/admin/operations/erase', async (request) => {
    const b = body(request)
    return service.erase(caller, reasonOf(b.reason), b.entryIds)
  })
  app.post('/admin/operations/legal-hold', async (request) => {
    const b = body(request)
    return service.legalHold(caller, reasonOf(b.reason), b)
  })
  app.get('/admin/operations/keys', async (request) => service.keys(caller, reasonOf(query(request).reason)))
  app.post('/admin/operations/keys/:key/rotate', async (request) => {
    const { key } = request.params as { key: string }
    return service.rotate(caller, reasonOf(body(request).reason), key)
  })
  return app
}
