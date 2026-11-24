/**
 * Admin access through the AG-UI profile (§3.14; ayni-spec D132, D133; PROF-ADMIN-001 to 007): the admin state, Show
 * Admin and Hide Admin, and the pages Audit and Operations, for the token of any bound session of a device.
 *
 * Every call of Audit and Operations is refused `403 admin-closed` while the device holds no open grant, `403
 * not-auditor` or `not-operator` without the role, `400 reason-required` without a reason, and then changes nothing and
 * returns nothing of the store. A read takes its reason in the query, an action in the body.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AdminRole } from '../../config/packTypes.js'
import type { Principal, Session } from '../../core/types.js'
import { type AdminCaller, AdminError, type AdminService, adminErrorBody, reasonOf } from '../../platform/admin.js'
import type { AdminGrants } from '../../platform/adminGrants.js'
import { entryToMessages } from './mapping.js'

export interface AdminRouteDeps {
  grants: AdminGrants
  service: AdminService
  /** a bound session and its Principal, or the answer that refuses the request */
  bound(request: FastifyRequest, reply: FastifyReply): Promise<{ session: Session; principal: Principal } | undefined>
  sendError(reply: FastifyReply, error: unknown): void
  /** the title of a tool source, for the shapes of §8 */
  titleOf(sourceId: string): string
}

type Query = Record<string, string | undefined>

export function registerAdminAccess(app: FastifyInstance, base: string, deps: AdminRouteDeps): void {
  const { grants, service } = deps
  const handle =
    (
      work: (bound: { session: Session; principal: Principal }, request: FastifyRequest, reply: FastifyReply) => unknown
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bound = await deps.bound(request, reply)
      if (!bound) return
      try {
        return await work(bound, request, reply)
      } catch (error) {
        if (error instanceof AdminError) return reply.code(error.status).send(adminErrorBody(error))
        return deps.sendError(reply, error)
      }
    }
  /** A call of Audit or Operations: the open grant and the role first, then the reason (PROF-ADMIN-007). */
  const as = (
    role: AdminRole,
    work: (caller: AdminCaller, reason: string, request: FastifyRequest, query: Query) => Promise<unknown>
  ) =>
    handle(async ({ session, principal }, request) => {
      const caller = await grants.require(principal, session, role)
      const query = (request.query ?? {}) as Query
      const body = (request.body ?? {}) as Record<string, unknown>
      const reason = reasonOf(request.method === 'GET' ? query.reason : body.reason)
      return work(caller, reason, request, query)
    })

  // PROF-ADMIN-001: the person's admin roles and the device's grant; `{ roles: [] }` and nothing else without a role
  app.get(
    `${base}/admin`,
    handle(({ session, principal }) => grants.state(principal, session))
  )
  // PROF-ADMIN-002: Show Admin, answered at once; the outcome comes as `ayni.admin.changed`
  app.post(
    `${base}/admin/grant`,
    handle(async ({ session, principal }, _request, reply) =>
      reply.code(202).send(await grants.request(principal, session))
    )
  )
  // PROF-ADMIN-003: Hide Admin
  app.delete(
    `${base}/admin/grant`,
    handle(async ({ session, principal }, _request, reply) => {
      await grants.hide(principal, session)
      return reply.code(204).send()
    })
  )

  // PROF-ADMIN-005: Audit, for `auditor`, each read with its reason
  app.get(
    `${base}/admin/audit/conversations`,
    as('auditor', (caller, reason, _request, q) => service.conversations(caller, reason, q))
  )
  app.get(
    `${base}/admin/audit/conversations/:conversationId/messages`,
    as('auditor', async (caller, reason, request, q) => {
      const { conversationId } = request.params as { conversationId: string }
      const { entries, nextBefore, auditId } = await service.messages(caller, reason, conversationId, q)
      // as the history serves them (§8): each page oldest first
      const messages = [...entries].reverse().flatMap((e) => entryToMessages(e, deps.titleOf))
      return { messages, nextBefore, auditId }
    })
  )
  app.get(
    `${base}/admin/audit/evidence`,
    as('auditor', (caller, reason, _request, q) => service.evidence(caller, reason, q.principal))
  )
  app.get(
    `${base}/admin/audit/tool-calls`,
    as('auditor', (caller, reason, _request, q) => service.toolCalls(caller, reason, q))
  )
  app.get(
    `${base}/admin/audit/log`,
    as('auditor', (caller, reason, _request, q) => service.log(caller, reason, q))
  )

  // PROF-ADMIN-006: Operations, for `operator`, each action with its reason
  app.post(
    `${base}/admin/operations/erase`,
    as('operator', (caller, reason, request) =>
      service.erase(caller, reason, ((request.body ?? {}) as Record<string, unknown>).entryIds)
    )
  )
  app.post(
    `${base}/admin/operations/legal-hold`,
    as('operator', (caller, reason, request) =>
      service.legalHold(caller, reason, (request.body ?? {}) as Record<string, unknown>)
    )
  )
  app.get(
    `${base}/admin/operations/keys`,
    as('operator', (caller, reason) => service.keys(caller, reason))
  )
  app.post(
    `${base}/admin/operations/keys/:key/rotate`,
    as('operator', (caller, reason, request) => service.rotate(caller, reason, (request.params as { key: string }).key))
  )
}
