/**
 * The admin interface's roles and who it lets in (ayni-spec D78, RBAC-XSESS-006 to 009, PRIV-ERASE-008, TOOL-PROV-005):
 * the roles `auditor` (reads) and `operator` (erases, holds) of a person the interface signed in, given by the user
 * directory; the break-glass token, each use recorded and flagged; every record naming the verified Principal, never a
 * name typed in the request. The person's sign-in with the phone and the badge is not built: these tests give the
 * interface the Principal it would have signed in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { loadPack, PackError, validatePackDocument } from '../src/config/pack.js'
import type { Principal } from '../src/core/types.js'
import { buildAdmin } from '../src/platform/admin.js'
import type { AdminAuditRecord } from '../src/store/types.js'
import { startTestAgent } from './helpers.js'

const BREAK_GLASS = 'break-glass-0001'
const person = (id: string, roles: string[]) => ({ id, roles }) as unknown as Principal
const jonas = person('prn_jonas', ['employee', 'auditor'])
const ana = person('prn_ana', ['employee', 'operator'])
const maria = person('prn_maria', ['employee', 'manager'])
const people = new Map([jonas, ana, maria].map((p) => [p.id, p]))

let running: RunningAgent
let admin: ReturnType<typeof buildAdmin>

beforeAll(async () => {
  running = await startTestAgent()
  admin = buildAdmin({
    store: running.agent.store,
    memory: running.agent.memory,
    evidence: running.agent.evidence,
    logger: running.agent.logger,
    breakGlassToken: BREAK_GLASS,
    // the Principal the phone's sign-in would give, by a header of the tests
    signedIn: async (request) => people.get(String(request.headers['x-test-signed-in'] ?? '')),
    announceErased: async () => undefined,
  })
}, 30_000)

afterAll(async () => {
  await admin?.close()
  await running?.stop()
})

const as = (who: Principal | 'break-glass' | undefined, reason = 'case 42') => ({
  ...(who === 'break-glass' ? { authorization: `Bearer ${BREAK_GLASS}` } : who ? { 'x-test-signed-in': who.id } : {}),
  ...(reason ? { 'x-ayni-reason': reason } : {}),
})
const latest = async (): Promise<AdminAuditRecord> =>
  (await running.agent.store.adminAudit.list(1))[0] as AdminAuditRecord

describe('who the admin interface lets in (RBAC-XSESS-006, RBAC-XSESS-009)', () => {
  it('refuses a call with neither a person signed in nor the break-glass token, and a wrong token', async () => {
    expect((await admin.inject({ method: 'GET', url: '/admin/audit/log', headers: as(undefined) })).statusCode).toBe(
      401
    )
    const wrong = await admin.inject({
      method: 'GET',
      url: '/admin/audit/log',
      headers: { authorization: 'Bearer not-the-token', 'x-ayni-reason': 'r' },
    })
    expect(wrong.statusCode).toBe(401)
    // the interface the agent builds has no sign-in yet, and no token in the tests: it lets nobody in
    const built = running.admin as NonNullable<RunningAgent['admin']>
    expect((await built.inject({ method: 'GET', url: '/admin/audit/log', headers: as(jonas) })).statusCode).toBe(401)
  })

  it('lets the break-glass token in, and records each of its calls flagged, with no Principal', async () => {
    const response = await admin.inject({ method: 'GET', url: '/admin/audit/log', headers: as('break-glass') })
    expect(response.statusCode).toBe(200)
    const record = await latest()
    expect(record).toMatchObject({ id: response.json().auditId, actor: 'break-glass', breakGlass: true })
    expect(record.principalId).toBeUndefined()
  })

  it('records the verified Principal, never a name typed in the request', async () => {
    const response = await admin.inject({
      method: 'POST',
      url: '/admin/legal-hold',
      headers: as(ana),
      payload: { operator: 'someone@else.example', reason: 'case 7', hold: true, entryIds: ['ent_none'] },
    })
    expect(response.statusCode).toBe(200)
    const record = await latest()
    expect(record).toMatchObject({ action: 'legal-hold', actor: ana.id, principalId: ana.id, reason: 'case 7' })
    expect(record.breakGlass).toBeUndefined()
    expect(JSON.stringify(record)).not.toContain('someone@else.example')
  })
})

describe('the roles auditor and operator (RBAC-XSESS-008, PRIV-ERASE-008, TOOL-PROV-005)', () => {
  const reads = ['/admin/audit/log', '/admin/audit/tool-calls', '/admin/audit/entries?principalId=prn_x']
  const writes = [
    { url: '/admin/erasure', payload: { reason: 'r', entryIds: ['ent_none'] } },
    { url: '/admin/legal-hold', payload: { reason: 'r', hold: true, entryIds: ['ent_none'] } },
  ]

  it('lets a holder of auditor read what the interface serves, and refuses them every write', async () => {
    for (const url of reads) {
      const response = await admin.inject({ method: 'GET', url, headers: as(jonas) })
      expect(response.statusCode).toBe(200)
      expect(await latest()).toMatchObject({ action: 'audit-read', principalId: jonas.id })
    }
    for (const { url, payload } of writes)
      expect((await admin.inject({ method: 'POST', url, headers: as(jonas), payload })).statusCode).toBe(403)
  })

  it('lets a holder of operator erase and hold, and refuses them the reads', async () => {
    for (const { url, payload } of writes)
      expect((await admin.inject({ method: 'POST', url, headers: as(ana), payload })).statusCode).toBe(200)
    expect(await latest()).toMatchObject({ principalId: ana.id })
    for (const url of reads) expect((await admin.inject({ method: 'GET', url, headers: as(ana) })).statusCode).toBe(403)
  })

  it('refuses a person who holds neither, whatever else they hold', async () => {
    for (const url of reads)
      expect((await admin.inject({ method: 'GET', url, headers: as(maria) })).statusCode).toBe(403)
    for (const { url, payload } of writes)
      expect((await admin.inject({ method: 'POST', url, headers: as(maria), payload })).statusCode).toBe(403)
  })

  it('asks a reason of every call', async () => {
    expect((await admin.inject({ method: 'GET', url: '/admin/audit/log', headers: as(jonas, '') })).statusCode).toBe(
      400
    )
  })
})

describe('the roles give nothing outside the admin interface (RBAC-XSESS-008)', () => {
  const env = { HOME_BACKING_IDENTITY: 'did:webvh:x:home' }
  /** What of the dev pack these tests change. */
  type DevPack = {
    identity: { roles: Record<string, { canApprove?: boolean }> }
    tools: {
      sources: Record<string, { access: { roles: Record<string, string[]>; approval: { approvers: string[] }[] } }>
    }
  }
  const refusal = (edit: (pack: DevPack) => void): string => {
    const pack = structuredClone(loadPack('agent-packs/dev', { ...process.env, ...env }).pack) as unknown as DevPack
    edit(pack)
    try {
      validatePackDocument(pack, env)
    } catch (error) {
      if (error instanceof PackError) return error.message
      throw error
    }
    return ''
  }

  it('declares them like any other role in the dev pack, and refuses them in a source, an approval or a template', () => {
    expect(refusal(() => undefined)).toBe('')
    const access = refusal((p) => (p.tools.sources.echo.access.roles.operator = ['echo']))
    expect(access).toContain('RBAC-XSESS-008: tools.sources.echo.access.roles names operator')
    const approvers = refusal((p) => (p.tools.sources.wire_money.access.approval[0].approvers = ['auditor']))
    expect(approvers).toContain('tools.sources.wire_money.access.approval[0].approvers names auditor')
    const canApprove = refusal((p) => (p.identity.roles.auditor.canApprove = true))
    expect(canApprove).toContain('identity.roles (canApprove) names auditor')
  })
})
