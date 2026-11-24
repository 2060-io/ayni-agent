/**
 * Admin access from the agent's card (ayni-spec D132 to D134; RBAC-ADMIN-001 to 008, RBAC-XSESS-008/009; AG-UI profile
 * §3.14, PROF-DESC-013, PROF-ADMIN-001 to 007), over the real agent (in-memory store, stub model), driven through the
 * AG-UI profile. The phone's re-authentication is the agent's `authenticate` flow of purpose `admin`; these tests stand
 * in for the phone at `IdentityFlow.authenticate` and check what the agent asks of it.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { AuthenticationAttempt } from '../src/channels/didcomm/authenticate.js'
import { IdentityFlow } from '../src/channels/didcomm/identity.js'
import { loadPack, PackError } from '../src/config/pack.js'
import type { VerifiedFacts } from '../src/core/principals.js'
import type { Principal } from '../src/core/types.js'
import { AdminGrants } from '../src/platform/adminGrants.js'
import type { AdminAuditRecord } from '../src/store/types.js'
import { Deferred } from '../src/util/async.js'
import { mintLocally, runText, until, webClient } from './directoryFixtures.js'
import { badgeAuthentication, parseSse, testEnv } from './helpers.js'
import type { Doc } from './toolFixtures.js'

const BREAK_GLASS = 'break-glass-of-the-admin-tests'
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'

/** The dev pack with an authentication by badge, the two admin roles and admin access; `edit` changes it further. */
function adminPack(edit: (doc: Doc) => void = () => undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'ayni-admin-'))
  cpSync('agent-packs/dev/knowledge', join(dir, 'knowledge'), { recursive: true })
  const doc = parseYaml(readFileSync('agent-packs/dev/agent-pack.yaml', 'utf8')) as Doc
  doc.identity.authentication = {
    ...badgeAuthentication({
      credential: { jsonSchemaCredentialId: BADGE },
      subjectKey: ['badgeNumber'],
      request: 'on-demand',
      visitors: true,
    }),
  }
  doc.identity.authentication.methods.otp = { type: 'authenticator-app' }
  doc.identity.roles = {
    ...doc.identity.roles,
    auditor: { description: 'Reads what Audit serves.' },
    operator: { description: 'Erases, holds, rotates.' },
  }
  doc.admin = { authentication: { methods: ['otp'] }, internal: { enabled: true } }
  edit(doc)
  writeFileSync(join(dir, 'agent-pack.yaml'), stringifyYaml(doc))
  return dir
}

let running: RunningAgent
const authenticate = vi.spyOn(IdentityFlow.prototype, 'authenticate')

interface Device {
  sessionId: string
  sessionToken: string
  principal: Principal
  connectionId: string
}

/** A person whose phone is connected, with a browser it bound; `roles` are theirs. */
async function person(name: string, roles: string[]): Promise<Device> {
  const created = (
    await running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client: webClient, locale: 'en' } })
  ).json() as { sessionId: string; sessionToken: string }
  const session = await running.agent.sessions.get(created.sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const connectionId = `conn-${name}`
  const { principal } = await running.agent.onPeerConnected(
    {
      connectionType: 'verifiable-user-agent',
      actorIdentity: `did:peer:${name}`,
      backingIdentity: null,
      claims: { userName: name },
      userAgentVerified: false,
      identityCredentialRef: null,
    },
    connectionId,
    { name: 'Ayni', version: '1.0.0', platform: 'ios' }
  )
  const updated = { ...principal, roles }
  await running.agent.principals.save(updated)
  return { ...(await bind(updated, connectionId)), principal: updated, connectionId }
}

/** A browser the phone binds: a device of its own. */
async function bind(principal: Principal, connectionId: string): Promise<{ sessionId: string; sessionToken: string }> {
  const created = (
    await running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client: webClient, locale: 'en' } })
  ).json() as { sessionId: string; sessionToken: string }
  const session = await running.agent.sessions.get(created.sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  return created
}

/** Another session of the same browser: a sibling, on the same device. */
async function sibling(d: Device): Promise<Device> {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: { client: webClient, locale: 'en', newConversation: true },
  })
  if (response.statusCode !== 201) throw new Error(`sibling ${response.statusCode}: ${response.body}`)
  return {
    ...(response.json() as { sessionId: string; sessionToken: string }),
    principal: d.principal,
    connectionId: d.connectionId,
  }
}

async function call(d: Pick<Device, 'sessionToken'>, method: string, url: string, payload?: unknown) {
  const response = await running.app.inject({
    method: method as 'GET',
    url: `/agui/v3/sessions${url}`,
    headers: { authorization: `Bearer ${d.sessionToken}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
  return { status: response.statusCode, body: response.body ? response.json() : undefined }
}

/** The `ayni.admin.changed` events a session's stream has received so far. */
const adminEvents = (sessionId: string): Record<string, unknown>[] => {
  const chunks: string[] = []
  running.streams.attach(sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
  return parseSse(chunks.join(''))
    .map((e) => e.event)
    .filter((e) => e.name === CUSTOM_EVENT.adminChanged)
    .map((e) => e.value as Record<string, unknown>)
}

const accepted = (d: Device): AuthenticationAttempt => ({
  outcome: 'accepted',
  facts: { actorIdentity: d.principal.actorIdentity } as VerifiedFacts,
})

const grants = () => running.agent.adminGrants as AdminGrants
const auditLog = () => running.agent.store.adminAudit.list(1000)
const latest = async (): Promise<AdminAuditRecord> => (await auditLog())[0] as AdminAuditRecord

/** Show Admin, confirmed on the phone with `answer`. */
async function showAdmin(d: Device, answer: AuthenticationAttempt = accepted(d)) {
  authenticate.mockResolvedValueOnce(answer)
  const response = await call(d, 'POST', '/admin/grant')
  expect(response.status).toBe(202)
  await grants().waitFor(await sessionOf(d))
  return response.body as { requestId: string; expiresAt: string }
}

const sessionOf = async (d: Device) => {
  const s = await running.agent.sessions.get(d.sessionId)
  if (!s) throw new Error('no session')
  return s
}

beforeAll(async () => {
  running = await buildAgent(
    testEnv({ agentPackPath: adminPack(), adminToken: BREAK_GLASS }),
    pino({ level: 'silent' }),
    { drainMs: 100 }
  )
  mintLocally(running)
}, 30_000)

afterEach(() => {
  authenticate.mockReset()
})

afterAll(async () => {
  authenticate.mockRestore()
  await running?.stop()
})

describe('the admin state and the descriptor (PROF-DESC-013, PROF-ADMIN-001, RBAC-ADMIN-001)', () => {
  it('declares features.admin while the agent-pack declares an admin role, and not otherwise', async () => {
    const descriptor = (await running.app.inject({ method: 'GET', url: '/.well-known/ayni-agent.json' })).json()
    expect(descriptor.features.admin).toBe(true)
    const none = await buildAgent(testEnv(), pino({ level: 'silent' }), { drainMs: 100 })
    try {
      const plain = (await none.app.inject({ method: 'GET', url: '/.well-known/ayni-agent.json' })).json()
      expect(plain.features.admin).toBeUndefined()
      expect(none.agent.adminGrants).toBeUndefined()
    } finally {
      await none.stop()
    }
  })

  it('tells an auditor their roles and no grant, and a person with neither role nothing but roles: []', async () => {
    const jonas = await person('jonas-state', ['employee', 'auditor'])
    const ben = await person('ben-state', ['employee', 'manager'])
    expect((await call(jonas, 'GET', '/admin')).body).toEqual({ roles: ['auditor'], grant: null })
    expect((await call(ben, 'GET', '/admin')).body).toEqual({ roles: [] })
    const both = await person('both-state', ['auditor', 'operator'])
    expect((await call(both, 'GET', '/admin')).body).toEqual({ roles: ['auditor', 'operator'], grant: null })
  })
})

describe('Show Admin: the phone re-authenticates and a grant opens (PROF-ADMIN-002, RBAC-ADMIN-002/003)', () => {
  it('answers at once, asks the phone once with the set of the agent-pack, and opens a grant for that device', async () => {
    const jonas = await person('jonas-show', ['employee', 'auditor'])
    const tab = await sibling(jonas)
    const laptop = {
      ...(await bind(jonas.principal, jonas.connectionId)),
      principal: jonas.principal,
      connectionId: jonas.connectionId,
    }
    const phone = new Deferred<AuthenticationAttempt>()
    authenticate.mockImplementationOnce(() => phone.promise)
    const first = await call(jonas, 'POST', '/admin/grant')
    expect(first.status).toBe(202)
    expect(first.body).toEqual({ requestId: expect.stringMatching(/^admreq_/), expiresAt: expect.any(String) })
    // Show Admin pressed twice brings one sheet to the phone
    const second = await call(tab, 'POST', '/admin/grant')
    expect(second.body).toEqual(first.body)
    expect(authenticate).toHaveBeenCalledTimes(1)
    const [connectionId, peerId, , , ask] = authenticate.mock.calls[0] as Parameters<IdentityFlow['authenticate']>
    expect(connectionId).toBe(jonas.connectionId)
    expect(peerId).toBe(jonas.principal.actorIdentity)
    expect(ask).toMatchObject({ purpose: 'admin', combinations: [['otp']], text: 'Show Admin' })
    expect(ask?.bound?.id).toBe(jonas.principal.id)
    expect(ask?.origin?.id).toBe(jonas.sessionId)
    // nothing opens before the phone confirms
    expect((await call(jonas, 'GET', '/admin')).body).toEqual({ roles: ['auditor'], grant: null })
    const confirmedAt = Date.now()
    phone.resolve(accepted(jonas))
    await grants().waitFor(await sessionOf(jonas))
    const state = (await call(jonas, 'GET', '/admin')).body
    expect(state.grant.open).toBe(true)
    // 30 minutes from the confirmation (admin.grantMinutes by default)
    const end = Date.parse(state.grant.expiresAt)
    expect(end - confirmedAt).toBeGreaterThanOrEqual(30 * 60_000 - 1000)
    expect(end - confirmedAt).toBeLessThanOrEqual(30 * 60_000 + 1000)
    // both sessions of the device are told; the other device of the same person holds no grant and hears nothing
    for (const s of [jonas, tab])
      expect(adminEvents(s.sessionId).at(-1)).toEqual({
        roles: ['auditor'],
        grant: { open: true, expiresAt: state.grant.expiresAt },
        outcome: 'opened',
      })
    expect(adminEvents(laptop.sessionId)).toEqual([])
    expect((await call(laptop, 'GET', '/admin')).body).toEqual({ roles: ['auditor'], grant: null })
    expect(await latest()).toMatchObject({
      action: 'admin-grant-opened',
      principalId: jonas.principal.id,
      grantId: expect.stringMatching(/^admgrant_/),
      detail: { methods: ['otp'], roles: ['auditor'] },
    })
  })

  it('refuses a person without an admin role, and asks their phone nothing', async () => {
    const ben = await person('ben-show', ['employee'])
    const response = await call(ben, 'POST', '/admin/grant')
    expect(response).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('opens nothing when the phone declines, does not answer, or authenticates another identity', async () => {
    const jonas = await person('jonas-refused', ['auditor'])
    const answers: [AuthenticationAttempt, string][] = [
      [{ outcome: 'declined' }, 'declined'],
      [{ outcome: 'unanswered' }, 'expired'],
      [{ outcome: 'not-accepted', code: 'another-identity' }, 'failed'],
      [{ outcome: 'accepted', facts: { actorIdentity: 'did:peer:someone-else' } as VerifiedFacts }, 'failed'],
      [{ outcome: 'pending' }, 'failed'],
    ]
    for (const [answer, outcome] of answers) {
      await showAdmin(jonas, answer)
      expect(adminEvents(jonas.sessionId).at(-1)).toEqual({ roles: ['auditor'], grant: null, outcome })
      expect((await call(jonas, 'GET', '/admin')).body.grant).toBeNull()
    }
    expect(
      (await auditLog()).some((r) => r.action === 'admin-grant-opened' && r.principalId === jonas.principal.id)
    ).toBe(false)
  })

  it('asks nothing of a person whose phone is not connected', async () => {
    const jonas = await person('jonas-nophone', ['auditor'])
    await running.agent.principals.save({ ...jonas.principal, capabilityChannelId: null })
    await call(jonas, 'POST', '/admin/grant')
    await grants().waitFor(await sessionOf(jonas))
    expect(authenticate).not.toHaveBeenCalled()
    expect(adminEvents(jonas.sessionId).at(-1)).toMatchObject({ grant: null, outcome: 'failed' })
  })
})

describe('Audit (PROF-ADMIN-005, RBAC-ADMIN-005/006/008)', () => {
  it('refuses every read without an open grant, without the role and without a reason, recording nothing', async () => {
    const jonas = await person('jonas-refusals', ['auditor'])
    const ana = await person('ana-refusals', ['operator'])
    const before = (await auditLog()).length
    const reads = [
      '/admin/audit/conversations?reason=case%201',
      '/admin/audit/conversations/cnv_x/messages?reason=case%201',
      '/admin/audit/evidence?principal=prn_x&reason=case%201',
      '/admin/audit/tool-calls?reason=case%201',
      '/admin/audit/log?reason=case%201',
    ]
    for (const url of reads)
      expect(await call(jonas, 'GET', url)).toEqual({
        status: 403,
        body: expect.objectContaining({ error: 'admin-closed' }),
      })
    await showAdmin(ana)
    for (const url of reads)
      expect(await call(ana, 'GET', url)).toEqual({
        status: 403,
        body: expect.objectContaining({ error: 'not-auditor' }),
      })
    await showAdmin(jonas)
    const opened = (await auditLog()).length
    expect(await call(jonas, 'GET', '/admin/audit/log')).toEqual({
      status: 400,
      body: expect.objectContaining({ error: 'reason-required' }),
    })
    expect(await call(jonas, 'GET', '/admin/audit/log?reason=%20%2C%20')).toMatchObject({ status: 400 })
    expect((await auditLog()).length).toBe(opened)
    // the grants' openings are the only records written
    expect(opened - before).toBe(2)
  })

  it('finds the conversations of a person, reads one decrypted, the evidence and the call records, each read recorded', async () => {
    const ana = await person('ana-audited', ['employee'])
    await runText(running, ana, 'The shipment to Rotterdam is late.')
    const jonas = await person('jonas-audit', ['employee', 'auditor'])
    await showAdmin(jonas)
    const grantId = (await latest()).grantId
    const found = await call(
      jonas,
      'GET',
      `/admin/audit/conversations?principal=${ana.principal.id}&reason=Complaint%204411`
    )
    expect(found.status).toBe(200)
    const conversation = found.body.conversations[0]
    expect(conversation).toMatchObject({
      principalId: ana.principal.id,
      spaceId: expect.any(String),
      title: expect.any(String),
    })
    const read = await call(
      jonas,
      'GET',
      `/admin/audit/conversations/${conversation.id}/messages?reason=Complaint%204411`
    )
    expect(read.status).toBe(200)
    expect(JSON.stringify(read.body.messages)).toContain('The shipment to Rotterdam is late.')
    expect(read.body.messages.find((m: { role: string }) => m.role === 'user')).toBeTruthy()
    // a period that ends before the conversation finds nothing
    const earlier = await call(
      jonas,
      'GET',
      `/admin/audit/conversations?principal=${ana.principal.id}&to=2020-01-01&reason=x`
    )
    expect(earlier.body.conversations).toEqual([])
    expect(
      (await call(jonas, 'GET', `/admin/audit/evidence?principal=${ana.principal.id}&reason=Complaint%204411`)).status
    ).toBe(200)
    expect((await call(jonas, 'GET', '/admin/audit/evidence?reason=x')).body).toMatchObject({
      error: 'bad-request',
      field: 'principal',
    })
    expect(
      (await call(jonas, 'GET', `/admin/audit/tool-calls?principal=${ana.principal.id}&reason=x`)).body.calls
    ).toEqual([])
    const log = await call(jonas, 'GET', '/admin/audit/log?limit=5&reason=Complaint%204411')
    const reads = (log.body.records as AdminAuditRecord[]).filter((r) => r.action === 'audit-read')
    expect(reads[0]).toMatchObject({ principalId: jonas.principal.id, actor: jonas.principal.id, grantId, reason: 'x' })
    expect(reads.find((r) => r.detail.what === 'messages')).toMatchObject({
      principalId: jonas.principal.id,
      grantId,
      reason: 'Complaint 4411',
      detail: { conversationId: conversation.id, principalId: ana.principal.id },
    })
    expect(log.body.nextBefore).toEqual(expect.any(String))
    // nothing Audit reads is written by Audit: the read of the log is itself the newest record
    expect((await latest()).id).toBe(log.body.auditId)
    // Operations stay closed to an auditor
    expect((await call(jonas, 'POST', '/admin/operations/erase', { entryIds: ['x'], reason: 'r' })).body).toMatchObject(
      { error: 'not-operator' }
    )
  })
})

describe('Operations (PROF-ADMIN-006, PRIV-ERASE-008, PRIV-KEY-008)', () => {
  it('lets an operator hold, release and erase entries with a reason, and tells the conversation; no key rotates yet', async () => {
    const owner = await person('owner-ops', ['employee'])
    await runText(running, owner, 'Erase me later.')
    const conversationId = (await running.agent.sessions.get(owner.sessionId))?.conversationId as string
    const entry = (await running.agent.store.entries.listAll({ conversationId, limit: 100 })).find(
      (e) => e.role === 'principal'
    )
    if (!entry) throw new Error('no entry')
    const ana = await person('ana-ops', ['operator'])
    await showAdmin(ana)
    expect(await call(ana, 'POST', '/admin/operations/erase', { entryIds: [entry.id] })).toMatchObject({
      status: 400,
      body: { error: 'reason-required' },
    })
    const held = await call(ana, 'POST', '/admin/operations/legal-hold', {
      conversationId,
      hold: true,
      reason: 'case 7',
    })
    expect(held.body.changed).toContain(entry.id)
    const refused = await call(ana, 'POST', '/admin/operations/erase', { entryIds: [entry.id], reason: 'request 9' })
    expect(refused.body).toMatchObject({ erased: [], held: [entry.id] })
    await call(ana, 'POST', '/admin/operations/legal-hold', { entryIds: [entry.id], hold: false, reason: 'closed' })
    const erased = await call(ana, 'POST', '/admin/operations/erase', {
      entryIds: [entry.id, 'msg_none'],
      reason: 'request 9',
    })
    expect(erased.body).toMatchObject({ erased: expect.arrayContaining([entry.id]), notFound: ['msg_none'] })
    expect((await running.agent.store.entries.get(entry.id))?.state).toBe('crypto-erased')
    // the conversation's sessions are told (PROF-STREAM-008)
    const chunks: string[] = []
    running.streams.attach(owner.sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
    expect(chunks.join('')).toContain(CUSTOM_EVENT.messagesErased)
    expect(await latest()).toMatchObject({ action: 'erasure', principalId: ana.principal.id, reason: 'request 9' })
    const keys = await call(ana, 'GET', '/admin/operations/keys?reason=review')
    expect(keys.body.keys.map((k: { key: string }) => k.key)).toEqual(['master', 'index'])
    expect(await call(ana, 'POST', '/admin/operations/keys/master/rotate', { reason: 'yearly' })).toMatchObject({
      status: 501,
      body: { error: 'not-implemented' },
    })
    expect((await call(ana, 'GET', '/admin/audit/log?reason=x')).body).toMatchObject({ error: 'not-auditor' })
  })
})

describe('the end of a grant (PROF-ADMIN-003/004, RBAC-ADMIN-003/004)', () => {
  it('counts from the confirmation and never moves with use', async () => {
    const jonas = await person('jonas-time', ['auditor'])
    await showAdmin(jonas)
    const { expiresAt } = (await call(jonas, 'GET', '/admin')).body.grant
    const real = Date.now
    try {
      // a read at minute 29 leaves the end where it was
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) - 60_000)
      expect((await call(jonas, 'GET', '/admin/audit/log?limit=1&reason=x')).status).toBe(200)
      expect((await call(jonas, 'GET', '/admin')).body.grant.expiresAt).toBe(expiresAt)
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) + 1)
      expect((await call(jonas, 'GET', '/admin/audit/log?reason=x')).body).toMatchObject({ error: 'admin-closed' })
    } finally {
      vi.spyOn(Date, 'now').mockImplementation(real)
      vi.mocked(Date.now).mockRestore()
    }
    expect(adminEvents(jonas.sessionId).at(-1)).toEqual({ roles: ['auditor'], grant: null, outcome: 'ended' })
    expect(await latest()).toMatchObject({
      action: 'admin-grant-ended',
      reason: 'expired',
      principalId: jonas.principal.id,
    })
  })

  it('ends at its time by itself, and only a new confirmation opens another', async () => {
    const jonas = await person('jonas-timer', ['auditor'])
    // the timers only: the records keep the clock's time
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await showAdmin(jonas)
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 10)
    } finally {
      vi.useRealTimers()
    }
    await until(async () => adminEvents(jonas.sessionId).at(-1)?.outcome === 'ended')
    expect(await latest()).toMatchObject({ action: 'admin-grant-ended', reason: 'expired' })
    expect((await call(jonas, 'GET', '/admin')).body.grant).toBeNull()
    await showAdmin(jonas)
    expect((await call(jonas, 'GET', '/admin')).body.grant.open).toBe(true)
  })

  it('ends on Hide Admin at once, and Hide Admin with no grant is no error', async () => {
    const jonas = await person('jonas-hide', ['auditor'])
    await showAdmin(jonas)
    expect((await call(jonas, 'DELETE', '/admin/grant')).status).toBe(204)
    expect((await call(jonas, 'GET', '/admin/audit/log?reason=x')).body).toMatchObject({ error: 'admin-closed' })
    expect(adminEvents(jonas.sessionId).at(-1)).toEqual({ roles: ['auditor'], grant: null, outcome: 'ended' })
    expect(await latest()).toMatchObject({ action: 'admin-grant-ended', reason: 'hidden' })
    expect((await call(jonas, 'DELETE', '/admin/grant')).status).toBe(204)
  })

  it('ends when the person loses the role it opened for: at the next call, and after a reload of the directory', async () => {
    const jonas = await person('jonas-role', ['auditor'])
    await showAdmin(jonas)
    await running.agent.principals.save({ ...jonas.principal, roles: ['employee'] })
    expect((await call(jonas, 'GET', '/admin/audit/log?reason=x')).body).toMatchObject({ error: 'not-auditor' })
    expect(adminEvents(jonas.sessionId).at(-1)).toEqual({ roles: [], grant: null, outcome: 'ended' })
    expect(await latest()).toMatchObject({ action: 'admin-grant-ended', reason: 'role-lost' })
    const both = await person('both-role', ['auditor', 'operator'])
    await showAdmin(both)
    await running.agent.principals.save({ ...both.principal, roles: ['operator'] })
    await grants().review()
    expect(adminEvents(both.sessionId).at(-1)).toEqual({ roles: ['operator'], grant: null, outcome: 'ended' })
  })

  it('ends when its device is unlinked, and when the phone disconnects', async () => {
    const jonas = await person('jonas-unlink', ['auditor'])
    const laptop = {
      ...(await bind(jonas.principal, jonas.connectionId)),
      principal: jonas.principal,
      connectionId: jonas.connectionId,
    }
    await showAdmin(jonas)
    const handle = (await sessionOf(jonas)).deviceHandle as string
    expect((await call(laptop, 'DELETE', `/devices/${handle}`)).status).toBe(204)
    expect(await latest()).toMatchObject({ action: 'admin-grant-ended', reason: 'device-unlinked' })
    const ana = await person('ana-disconnect', ['operator'])
    await showAdmin(ana)
    await running.agent.onPeerDisconnected(ana.connectionId)
    expect(await latest()).toMatchObject({
      action: 'admin-grant-ended',
      reason: 'channel-closed',
      principalId: ana.principal.id,
    })
  })

  it('survives a restart of the agent, keeping its end', async () => {
    const jonas = await person('jonas-restart', ['auditor'])
    await showAdmin(jonas)
    const { expiresAt } = (await call(jonas, 'GET', '/admin')).body.grant
    const g = grants() as unknown as { pack: never; kv: never; service: never; ports: never; logger: never }
    const next = new AdminGrants(g.pack, g.kv, g.service, g.ports, g.logger, { requestMs: 1000 })
    try {
      expect(await next.state(jonas.principal, await sessionOf(jonas))).toEqual({
        roles: ['auditor'],
        grant: { open: true, expiresAt },
      })
    } finally {
      next.stop()
    }
  })
})

describe('the internal admin interface (D134, RBAC-XSESS-009)', () => {
  it('opens to the break-glass token alone, asks a reason, and flags every record', async () => {
    const internal = running.admin as NonNullable<RunningAgent['admin']>
    expect((await internal.inject({ method: 'GET', url: '/admin/health' })).statusCode).toBe(401)
    const wrong = await internal.inject({
      method: 'GET',
      url: '/admin/audit/log?reason=x',
      headers: { authorization: 'Bearer not-the-token' },
    })
    expect(wrong.statusCode).toBe(401)
    const glass = { authorization: `Bearer ${BREAK_GLASS}` }
    expect((await internal.inject({ method: 'GET', url: '/admin/audit/log', headers: glass })).json()).toMatchObject({
      error: 'reason-required',
    })
    const read = await internal.inject({ method: 'GET', url: '/admin/audit/log?reason=no%20phone', headers: glass })
    expect(read.statusCode).toBe(200)
    const record = await latest()
    expect(record).toMatchObject({
      id: read.json().auditId,
      actor: 'break-glass',
      breakGlass: true,
      reason: 'no phone',
    })
    expect(record.principalId).toBeUndefined()
    // a name typed in the request is never read nor kept
    const held = await internal.inject({
      method: 'POST',
      url: '/admin/operations/legal-hold',
      headers: glass,
      payload: { operator: 'someone@else.example', reason: 'case 7', hold: true, entryIds: ['msg_none'] },
    })
    expect(held.statusCode).toBe(200)
    expect(JSON.stringify(await latest())).not.toContain('someone@else.example')
  })

  it('does not exist unless the agent-pack enables it, whatever ADMIN_TOKEN says', async () => {
    const off = await buildAgent(
      testEnv({ agentPackPath: adminPack((doc) => (doc.admin.internal = undefined)), adminToken: BREAK_GLASS }),
      pino({ level: 'silent' }),
      { drainMs: 100 }
    )
    try {
      expect(off.admin).toBeUndefined()
      expect(off.agent.adminGrants).toBeDefined()
    } finally {
      await off.stop()
    }
    await expect(
      buildAgent(testEnv({ agentPackPath: adminPack() }), pino({ level: 'silent' }), { drainMs: 100 })
    ).rejects.toThrow(/ADMIN_TOKEN/)
  })
})

describe('the agent-pack (RBAC-ADMIN-002, RBAC-XSESS-008)', () => {
  const env = { HOME_BACKING_IDENTITY: 'did:webvh:x:home' }
  const refusal = (edit: (doc: Doc) => void): string => {
    try {
      loadPack(adminPack(edit), { ...process.env, ...env })
    } catch (error) {
      if (error instanceof PackError) return error.message
      throw error
    }
    return ''
  }

  it('takes the set, the minutes and the internal flag, with their defaults', () => {
    expect(refusal(() => undefined)).toBe('')
    const pack = loadPack(
      adminPack((doc) => (doc.admin = { authentication: { methods: ['badge', 'otp'] } })),
      {
        ...process.env,
        ...env,
      }
    ).pack
    expect(pack.admin?.authentication?.methods).toEqual(['badge', 'otp'])
    expect(pack.admin?.grantMinutes).toBe(30)
    expect(refusal((doc) => (doc.admin.grantMinutes = 0))).toContain('grantMinutes')
  })

  it('refuses an admin role without the set of methods, and a set that names a method not enabled', () => {
    expect(refusal((doc) => (doc.admin = undefined))).toContain(
      'RBAC-ADMIN-002: identity.roles declares [auditor, operator]: admin.authentication.methods must name'
    )
    expect(refusal((doc) => (doc.admin.authentication.methods = ['passkey']))).toContain(
      'admin.authentication.methods names [passkey], which identity.authentication.methods does not enable'
    )
    expect(refusal((doc) => (doc.admin.authentication.methods = ['otp', 'otp']))).toContain('duplicate')
  })

  it('refuses the admin roles where a role grants something', () => {
    const access = refusal((doc) => (doc.tools.sources.echo.access.roles.operator = ['echo']))
    expect(access).toContain('RBAC-XSESS-008: tools.sources.echo.access.roles names operator')
    const approvers = refusal((doc) => (doc.tools.sources.wire_money.access.approval[0].approvers = ['auditor']))
    expect(approvers).toContain('tools.sources.wire_money.access.approval[0].approvers names auditor')
    const canApprove = refusal((doc) => (doc.identity.roles.auditor.canApprove = true))
    expect(canApprove).toContain('identity.roles (canApprove) names auditor')
  })
})
