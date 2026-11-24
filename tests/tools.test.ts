/**
 * Tools, phase 1, over the real agent (in-memory store, a scripted model, fake MCP and HTTP servers, a stubbed phone),
 * driven through the AG-UI profile 3.4 (ayni-spec D96 to D100): RBAC-FILTER-004, TOOL-ACCESS-003..007, TOOL-AVAIL-001,
 * 004..006, TOOL-SPACE-001..011, TOOL-CALL-001..009, TOOL-PROV-001..006, INTX-APPR-004/005/012..015, SPACE-MEMB-008,
 * PROF-TOOL-001..013, PROF-SESS-016, PROF-DESC-009.
 */
import { ACTIVITY, CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, type RunningAgent } from '../src/app.js'
import { personalSpaceId } from '../src/core/spaces.js'
import { ONE_CALL } from '../src/core/toolGate.js'
import type { ApprovalRecord, MessageEntry, Principal } from '../src/core/types.js'
import { createEntryCrypto, openJson, sealJson } from '../src/memory/crypto.js'
import { buildAdmin } from '../src/platform/admin.js'
import type { McpServerSource } from '../src/tools/mcp.js'
import { parseSse, startTestAgent, testEnv } from './helpers.js'
import {
  crmTools,
  type Doc,
  type FakeHttp,
  type FakeMcp,
  fakeHttpTool,
  fakeMcpServer,
  type Phone,
  phone,
  type ScriptedModel,
  scripted,
  searchTools,
  toolsPack,
  until,
  X_ACCOUNT_FIELDS,
} from './toolFixtures.js'

const CRM_TOKEN = 'crmToken|0000000000000001'
const CRM_TOKEN_2 = 'crmToken|0000000000000002'
const CRM_TOKEN_3 = 'crmToken|0000000000000003'
const X_TOKEN = 'x-access-token-of-communication'

let running: RunningAgent
let crm: FakeMcp
let search: FakeMcp
let x: FakeHttp
let model: ScriptedModel
let ph: Phone
/** What the agent logs, at debug, over this whole file: no value of an account may be in it (TOOL-ACCESS-005). */
const logLines: string[] = []
/** The master key of the test agent (`testEnv`), to seal what an earlier version stored. */
const crypto = createEntryCrypto(Buffer.alloc(32, 7))

interface Device {
  sessionId: string
  sessionToken: string
  principal: Principal
  connectionId: string
}

const web = (profileVersion: string | null = '3.4') => ({
  name: 'ayni-ui',
  version: '3.4.0',
  platform: 'web',
  ...(profileVersion ? { profileVersion } : {}),
})

function mintLocally(agent: RunningAgent): void {
  const minter = agent.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
  minter.minter = {
    mint: async (id: string) => ({
      invitationId: `inv-${id}`,
      outOfBandId: `oob-${id}`,
      url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
    }),
  }
}

/** A person with a browser bound by their phone, which is flow-capable; `roles` are theirs. */
async function device(name: string, roles: string[], profileVersion: string | null = '3.4'): Promise<Device> {
  const created = (
    await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      payload: { client: web(profileVersion), locale: 'en' },
    })
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
  await ph.flowCapable(connectionId)
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  const updated = { ...principal, roles }
  await running.agent.principals.save(updated)
  return { ...created, principal: updated, connectionId }
}

/** Another session of the person: a new conversation in a space, or the same conversation on another device. */
async function open(
  d: Pick<Device, 'sessionToken' | 'principal' | 'connectionId'>,
  options: { spaceId?: string; conversationId?: string; profileVersion?: string | null }
): Promise<Device> {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: {
      client: web(options.profileVersion === undefined ? '3.4' : options.profileVersion),
      locale: 'en',
      ...(options.conversationId
        ? { conversationId: options.conversationId }
        : { newConversation: true, ...(options.spaceId ? { spaceId: options.spaceId } : {}) }),
    },
  })
  if (response.statusCode !== 201) throw new Error(`session ${response.statusCode}: ${response.body}`)
  const body = response.json() as { sessionId: string; sessionToken: string }
  return { ...body, principal: d.principal, connectionId: d.connectionId }
}

/** Another device of the person (a second browser, bound by their phone) on a conversation they have. */
async function otherDevice(d: Device, conversationId: string, profileVersion: string | null = '3.4'): Promise<Device> {
  const created = (
    await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      payload: { client: web(profileVersion), locale: 'en', conversationId },
    })
  ).json() as { sessionId: string; sessionToken: string }
  const session = await running.agent.sessions.get(created.sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, d.connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(d.connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, d.principal, confirm.binding.nonce)
  return { ...created, principal: d.principal, connectionId: d.connectionId }
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

function start(d: Pick<Device, 'sessionId' | 'sessionToken'>, text: string, ayni?: Record<string, unknown>) {
  return running.app
    .inject({
      method: 'POST',
      url: `/agui/v3/sessions/${d.sessionId}/runs`,
      headers: { authorization: `Bearer ${d.sessionToken}` },
      payload: {
        threadId: d.sessionId,
        runId: `run-${Date.now()}-${Math.random()}`,
        messages: text ? [{ id: `u-${Math.random()}`, role: 'user', content: text }] : [],
        tools: [],
        context: [],
        ...(ayni ? { forwardedProps: { ayni } } : {}),
      },
    })
    .then((response) => ({
      status: response.statusCode,
      events: response.statusCode === 200 ? parseSse(response.body).map((e) => e.event) : [],
      body: response.statusCode === 200 ? undefined : (response.json() as Record<string, unknown>),
    }))
}

const run = (d: Pick<Device, 'sessionId' | 'sessionToken'>, text: string, ayni?: Record<string, unknown>) =>
  start(d, text, ayni)

const decide = (
  d: Pick<Device, 'sessionId' | 'sessionToken'>,
  approvalId: string,
  decision: 'approve' | 'reject',
  scope?: 'once' | 'conversation'
) => run(d, '', { kind: 'approval.decide', approvalId, decision, ...(scope ? { scope } : {}) })

const textOf = (events: Record<string, unknown>[]) =>
  events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => e.delta)
    .join('')

/** What a session's stream has received so far. */
const received = (sessionId: string) => {
  const chunks: string[] = []
  running.streams.attach(sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
  return parseSse(chunks.join('')).map((e) => e.event)
}

async function conversationOf(sessionId: string): Promise<string> {
  return (await running.agent.sessions.get(sessionId))?.conversationId as string
}

/** The confirmation that waits in a conversation, once its card is asked. */
async function pendingConfirmation(conversationId: string, after = 0): Promise<ApprovalRecord> {
  let found: ApprovalRecord | undefined
  await until(async () => {
    const pending = await running.agent.store.approvals.list({ status: 'PENDING' })
    found = pending
      .filter((r) => r.kind === 'confirmation' && r.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[after]
    return !!found
  })
  return found as ApprovalRecord
}

/** Waits until no turn runs or waits in a conversation: a message sent during a card is answered by a turn of its own. */
async function idle(conversationId: string): Promise<void> {
  await until(async () => {
    const session = (await running.agent.sessions.conversationById(conversationId))?.sessionIds[0]
    const waiting = session ? await running.agent.waitingOf({ id: session, conversationId }) : []
    return !running.agent.orchestrator.answeringIn(conversationId).size && !waiting.length
  }, 5000)
}

/** The tool messages of the model's last request: what the model read of its calls. */
const toolAnswers = () =>
  (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))

const toolNames = (index = -1) => (model.requests.at(index)?.tools ?? []).map((t) => t.name)

async function entries(conversationId: string): Promise<MessageEntry[]> {
  const rows = await running.agent.store.entries.listAll({ conversationId, limit: 1000 })
  return rows.map((r) => running.agent.memory.open(r))
}

const crmSource = () => running.agent.registry.sourceById('mcp:relaticle') as McpServerSource

let jonas: Device
let ana: Device
let salesEu: { id: string }

/** The owner sets a change, and his phone confirms it. */
async function confirmed(d: Device, request: () => Promise<{ status: number; body: Doc }>) {
  const asked = ph.callsOf('sendConfirmRequest').length
  const response = await request()
  expect(response.status).toBe(202)
  await until(() => ph.callsOf('sendConfirmRequest').length > asked)
  await ph.confirm(d.connectionId, true)
  return response
}

beforeAll(async () => {
  crm = await fakeMcpServer(crmTools())
  search = await fakeMcpServer(searchTools())
  x = await fakeHttpTool()
  const pack = toolsPack({ crmUrl: crm.url, searchUrl: search.url, xUrl: x.url })
  const logger = pino({ level: 'debug' }, { write: (line: string) => void logLines.push(line) })
  running = await buildAgent(testEnv({ agentPackPath: pack, logLevel: 'debug' }), logger, { drainMs: 200 })
  mintLocally(running)
  ph = phone(running)
  model = scripted(running)
  jonas = await device('jonas', ['employee', 'sales', 'manager', 'comms'])
  ana = await device('ana', ['employee', 'sales', 'comms'])
}, 30_000)

afterAll(async () => {
  await running?.stop()
  await crm?.close()
  await search?.close()
  await x?.close()
})

const addMember = async (spaceId: string, principalId: string, role: 'member' | 'guest' = 'member') => {
  const now = new Date().toISOString()
  await running.agent.store.spaceMembers.save({
    id: `mem_${spaceId}_${principalId}`,
    spaceId,
    principalId,
    state: 'active',
    role,
    createdAt: now,
    updatedAt: now,
  })
}

describe('the tools of a space (TOOL-SPACE-001..010, PROF-TOOL-001..006, TOOL-ACCESS-003..006)', () => {
  it('shows a new Sales space the CRM in setup to its owner, nothing to a member, and 404 to anyone else', async () => {
    const created = await call(jonas, 'POST', '/spaces', {
      templateId: 'sales',
      title: 'Sales EU',
      purpose: 'Sell in Europe',
    })
    expect(created.status).toBe(201)
    salesEu = created.body
    await addMember(salesEu.id, ana.principal.id)
    const owner = await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)
    expect(owner.status).toBe(200)
    const crmTool = owner.body.tools.find((t: { source: string }) => t.source === 'relaticle')
    expect(crmTool).toMatchObject({
      source: 'relaticle',
      title: 'Relaticle CRM',
      description: "The sales team's accounts, contacts and notes",
      state: 'setup',
      add: 'auto',
      guests: false,
      account: {
        kind: 'space',
        fields: [{ name: 'token', label: 'API token', pattern: '^[A-Za-z0-9|]{20,200}$' }],
        set: false,
        setAt: null,
        setBy: null,
      },
      bindings: [
        { name: 'workspace', label: 'Workspace', value: null, setBy: 'owner', pattern: '^[a-z0-9-]{1,64}$' },
        { name: 'region', label: 'Region', value: 'eu', setBy: 'pack', pattern: null },
      ],
      pending: null,
    })
    expect(crmTool.tools.find((t: { name: string }) => t.name === 'create-note')).toEqual({
      name: 'create-note',
      title: 'Add a note',
      effect: 'write',
      rule: 'confirm',
      packRule: 'confirm',
      stepUp: null,
    })
    // a tool without annotations is a delete, approved by the space's owner (TOOL-CAT-006/007)
    expect(crmTool.tools.find((t: { name: string }) => t.name === 'delete-note')).toMatchObject({
      effect: 'delete',
      rule: 'approval',
    })
    // the source of spaces the template offers, not added
    expect(owner.body.tools.find((t: { source: string }) => t.source === 'crm_status')).toMatchObject({
      state: 'available',
      add: 'owner',
    })
    expect((await call(ana, 'GET', `/spaces/${salesEu.id}/tools`)).body).toEqual({ tools: [] })
    expect((await call(jonas, 'GET', `/spaces/${personalSpaceId(jonas.principal.id)}/tools`)).body).toEqual({
      tools: [],
    })
    const bob = await device('bob', ['employee'])
    expect((await call(bob, 'GET', `/spaces/${salesEu.id}/tools`)).status).toBe(404)
    // a person who left the space reads its tools no more
    await addMember(salesEu.id, bob.principal.id)
    expect((await call(bob, 'GET', `/spaces/${salesEu.id}/tools`)).status).toBe(200)
    const row = await running.agent.store.spaceMembers.get(`mem_${salesEu.id}_${bob.principal.id}`)
    if (row) await running.agent.store.spaceMembers.save({ ...row, state: 'left' })
    expect((await call(bob, 'GET', `/spaces/${salesEu.id}/tools`)).status).toBe(404)
  })

  it('refuses a binding that does not match, one the pack sets, one not declared, and a member (TOOL-SPACE-004)', async () => {
    const bad = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, {
      bindings: { workspace: 'Sales EU' },
    })
    expect(bad).toMatchObject({ status: 422, body: { error: 'bad-binding', field: 'bindings.workspace' } })
    const pinned = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, { bindings: { region: 'us' } })
    expect(pinned).toMatchObject({ status: 422, body: { error: 'pinned-by-pack', field: 'bindings.region' } })
    const unknown = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, { bindings: { team: 'a' } })
    expect(unknown).toMatchObject({ status: 422, body: { error: 'bad-binding', field: 'bindings.team' } })
    expect(
      (await call(ana, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, { bindings: { workspace: 'x' } })).body
    ).toMatchObject({
      error: 'not-owner',
    })
    // a source the template does not name, and Personal's tools
    expect((await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/websearch`, { calls: {} })).status).toBe(404)
    const personal = await call(jonas, 'POST', `/spaces/${personalSpaceId(jonas.principal.id)}/tools`, {
      source: 'relaticle',
    })
    expect(personal).toMatchObject({ status: 409, body: { error: 'personal-space' } })
    // a source offered and not added takes no binding
    expect((await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/crm_status`, { calls: {} })).body).toMatchObject({
      error: 'not-added',
    })
    expect(ph.callsOf('sendConfirmRequest')).toHaveLength(0)
  })

  it('holds a binding until the phone confirms it with the code the screen shows; one change at a time (TOOL-SPACE-008/009/010)', async () => {
    const stream = received(jonas.sessionId).length
    const pending = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, {
      bindings: { workspace: 'sales-eu' },
    })
    expect(pending.status).toBe(202)
    const change = pending.body.tool.pending
    expect(change.code).toMatch(/^\d\d \d\d$/)
    expect(change.summary).toBe('Change Relaticle CRM in Sales EU: Workspace: sales-eu')
    // the settings in force stay until it is confirmed
    expect(pending.body.tool.bindings[0].value).toBeNull()
    // the phone: a `confirm` flow, attested, with the summary and the code, from the session and no conversation
    const open = ph.callsOf('openFlow').at(-1)?.args[0] as Doc
    expect(open).toMatchObject({ connectionId: jonas.connectionId, kind: 'confirm', title: change.summary })
    expect(open.origin.sessionId).toBe(jonas.sessionId)
    expect(open.origin.conversationId).toBeUndefined()
    const request = ph.callsOf('sendConfirmRequest').at(-1)?.args[0] as Doc
    expect(request.request).toEqual({ text: change.summary, code: change.code, attested: true })
    // a second granting change waits for the first
    const again = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, {
      bindings: { workspace: 'other' },
    })
    expect(again).toMatchObject({ status: 409, body: { error: 'change-pending' } })
    // a change that only narrows applies at once, whatever waits for the phone; the waiting change stays
    const confirms = ph.callsOf('sendConfirmRequest').length
    const narrower = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, {
      calls: { 'get-company': 'confirm' },
    })
    expect(narrower.status).toBe(200)
    expect(narrower.body.tool.tools.find((t: { name: string }) => t.name === 'get-company').rule).toBe('confirm')
    expect(narrower.body.tool.pending).toMatchObject({ changeId: change.changeId, code: change.code })
    expect(ph.callsOf('sendConfirmRequest').length).toBe(confirms)
    // making it looser again grants something: it waits for the change in progress
    const looser = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, {
      calls: { 'get-company': 'none' },
    })
    expect(looser).toMatchObject({ status: 409, body: { error: 'change-pending' } })
    await ph.confirm(jonas.connectionId, true)
    const after = (await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0]
    expect(after.bindings[0].value).toBe('sales-eu')
    expect(after.pending).toBeNull()
    // both hold: the binding the phone confirmed, and the rule that applied while it waited
    expect(after.tools.find((t: { name: string }) => t.name === 'get-company').rule).toBe('confirm')
    const changed = received(jonas.sessionId)
      .slice(stream)
      .filter((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.spaceToolsChanged)
    expect(changed.at(-1)?.value).toEqual({
      spaceId: salesEu.id,
      source: 'relaticle',
      state: 'setup',
      changeId: change.changeId,
      outcome: 'applied',
    })
    // the flow belongs to no conversation: no card in any of Jonas's
    const conversations = await running.agent.sessions.allConversations(jonas.principal.id)
    for (const c of conversations) expect((await entries(c.id)).some((e) => e.sourceType === 'flow')).toBe(false)
    const activity = await call(jonas, 'GET', `/spaces/${salesEu.id}/activity`)
    expect(activity.body.activity[0]).toMatchObject({
      kind: 'tool-changed',
      tool: { source: 'relaticle', title: 'Relaticle CRM' },
      by: { name: 'jonas' },
    })
  })

  it('takes the account through the settings only, sealed, used once the phone confirms; a declined one is kept nowhere (TOOL-SPACE-005, TOOL-ACCESS-003/004/006)', async () => {
    const url = `/spaces/${salesEu.id}/tools/relaticle/account`
    const bad = await call(jonas, 'PUT', url, { values: { token: 'a token with a space in it' } })
    expect(bad).toMatchObject({ status: 422, body: { error: 'bad-token', field: 'account.token' } })
    expect((await call(jonas, 'PUT', url, { values: { token: '' } })).body.error).toBe('bad-token')
    expect((await call(jonas, 'PUT', url, { values: { token: `${'A'.repeat(4097)}` } })).body.error).toBe('bad-token')
    expect(JSON.stringify(await running.agent.store.spaceTools.listAll())).not.toContain('a token with a space')
    expect(await running.agent.store.spaceAccounts.listAll()).toEqual([])
    // a source whose account is not the space's
    expect((await call(jonas, 'POST', `/spaces/${salesEu.id}/tools`, { source: 'crm_status' })).status).toBe(202)
    await ph.confirm(jonas.connectionId, true)
    expect(
      (await call(jonas, 'PUT', `/spaces/${salesEu.id}/tools/crm_status/account`, { values: { token: CRM_TOKEN } }))
        .body
    ).toMatchObject({
      error: 'no-space-account',
    })
    // declined: dropped, its token destroyed
    const set = await call(jonas, 'PUT', url, { values: { token: CRM_TOKEN } })
    expect(set.status).toBe(202)
    expect(set.body.tool.account.set).toBe(false)
    expect(JSON.stringify(set.body)).not.toContain(CRM_TOKEN)
    const before = received(jonas.sessionId).length
    await ph.confirm(jonas.connectionId, false)
    const told = received(jonas.sessionId)
      .slice(before)
      .find((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.spaceToolsChanged)?.value
    expect(told).toMatchObject({ source: 'relaticle', state: 'setup', outcome: 'declined' })
    const declined = (await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0]
    expect(declined).toMatchObject({ state: 'setup', account: { set: false }, pending: null })
    expect(await running.agent.store.spaceAccounts.listAll()).toEqual([])
    expect(JSON.stringify(await running.agent.store.spaceTools.listAll())).not.toContain('crmToken')
    // confirmed: ready, set by Jonas, and no character of it anywhere a client reads
    await confirmed(jonas, () => call(jonas, 'PUT', url, { values: { token: CRM_TOKEN } }))
    const ready = await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)
    expect(ready.body.tools[0]).toMatchObject({
      state: 'ready',
      account: { set: true, setBy: { name: 'jonas' } },
    })
    expect(Date.parse(ready.body.tools[0].account.setAt)).toBeGreaterThan(Date.now() - 60_000)
    const stored = await running.agent.store.spaceAccounts.listAll()
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(CRM_TOKEN)
    expect(JSON.stringify(stored)).not.toContain('0000000000000001')
    for (const text of [
      JSON.stringify(ready.body),
      JSON.stringify((await call(jonas, 'GET', `/spaces/${salesEu.id}/activity`)).body),
      JSON.stringify(received(jonas.sessionId)),
      JSON.stringify(await running.agent.store.challenges.listPending()),
    ])
      expect(text).not.toContain('0000000000000001')
    const activity = (await call(jonas, 'GET', `/spaces/${salesEu.id}/activity`)).body.activity
    expect(activity[0]).toMatchObject({ kind: 'account-set', tool: { source: 'relaticle' }, by: { name: 'jonas' } })
    // the member reads the ready source, without names, account status or pending (PROF-TOOL-001)
    const member = (await call(ana, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools
    expect(member.map((t: { source: string }) => t.source)).toEqual(['relaticle', 'crm_status'])
    expect(member[0]).toEqual({
      source: 'relaticle',
      title: 'Relaticle CRM',
      description: "The sales team's accounts, contacts and notes",
      state: 'ready',
      guests: false,
      account: { kind: 'space' },
      bindings: [
        { label: 'Workspace', value: 'sales-eu' },
        { label: 'Region', value: 'eu' },
      ],
      tools: expect.arrayContaining([{ title: 'Add a note', effect: 'write', rule: 'confirm', stepUp: null }]),
    })
    expect(member[0].tools.some((t: Record<string, unknown>) => 'name' in t)).toBe(false)
  })

  it('refuses a granting change with no phone to confirm it, and changes nothing (TOOL-SPACE-008)', async () => {
    const principal = (await running.agent.principals.get(jonas.principal.id)) as Principal
    await running.agent.principals.save({ ...principal, capabilityChannelId: null })
    const refused = await call(jonas, 'PUT', `/spaces/${salesEu.id}/tools/relaticle/account`, {
      values: { token: CRM_TOKEN_2 },
    })
    expect(refused).toMatchObject({ status: 409, body: { error: 'confirmation-unavailable' } })
    await running.agent.principals.save(principal)
    expect((await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0].pending).toBeNull()
  })
})

describe('the tools a turn gives the model (RBAC-FILTER-004, TOOL-AVAIL-001/004/005/006, TOOL-CAT-003/004)', () => {
  let anaSales: Device

  it('gives a Sales conversation the CRM offered tools without the pinned argument, and Personal none of them', async () => {
    anaSales = await open(ana, { spaceId: salesEu.id })
    await run(anaSales, 'hello')
    const names = toolNames()
    for (const name of ['list-companies', 'get-company', 'create-note', 'delete-note', 'echo-auth', 'search'])
      expect(names).toContain(name)
    // not offered, or not listed by the server
    expect(names).not.toContain('admin-wipe')
    expect(names).not.toContain('ghost-tool')
    expect(names).not.toContain('fetch_page')
    const note = model.requests.at(-1)?.tools?.find((t) => t.name === 'create-note')
    expect(Object.keys((note?.parameters.properties ?? {}) as object)).toEqual(['company', 'note', 'tags'])
    expect(note?.parameters.required).toEqual(['company', 'note'])
    // two turns with nothing changed send the same tools, byte for byte (TOOL-AVAIL-006)
    await run(anaSales, 'again')
    expect(JSON.stringify(model.requests.at(-1)?.tools)).toBe(JSON.stringify(model.requests.at(-2)?.tools))
    await run(ana, 'in Personal')
    expect(toolNames()).toContain('search')
    expect(toolNames()).not.toContain('create-note')
  })

  it('answers a call of a tool that is not offered or not available as unknown, and records it (TOOL-CAT-003, TOOL-AVAIL-001)', async () => {
    const before = search.calls.length
    model.script = [{ calls: [{ name: 'fetch_page', arguments: {} }] }, { text: 'ok' }]
    await run(ana, 'fetch')
    expect(toolAnswers().at(-1)).toBe('Tool fetch_page is not available to this person.')
    expect(search.calls.length).toBe(before)
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'A', note: 'b' } }] }, { text: 'ok' }]
    await run(ana, 'note in Personal')
    expect(toolAnswers().at(-1)).toBe('Tool create-note is not available to this person.')
    const records = await running.agent.store.toolCalls.list({ principalId: ana.principal.id, limit: 5 })
    expect(records.slice(0, 2).map((r) => r.outcome)).toEqual(['not-available', 'not-available'])
  })

  it('pins the binding in code, whatever the model gives, and sends the space account (TOOL-CAT-004, TOOL-ACCESS-005)', async () => {
    model.script = [{ calls: [{ name: 'list-companies', arguments: { workspace_id: 'hr' } }] }, { text: 'ok' }]
    await run(anaSales, 'list')
    const last = crm.calls.at(-1)
    expect(last).toMatchObject({ name: 'list-companies', args: { workspace_id: 'sales-eu' } })
    expect(last?.authorization).toBe(`Bearer ${CRM_TOKEN}`)
  })

  it('replaces an echo of the account by [account] before anything records or reads it (TOOL-ACCESS-005)', async () => {
    model.script = [{ calls: [{ name: 'echo-auth', arguments: {} }] }, { text: 'ok' }]
    await run(anaSales, 'who am I')
    expect(crm.calls.at(-1)?.authorization).toBe(`Bearer ${CRM_TOKEN}`)
    // the header built from the token goes whole, as the token alone would (D102)
    expect(toolAnswers().at(-1)).toBe('you called with [account]')
    const conversation = await conversationOf(anaSales.sessionId)
    const stored = JSON.stringify(await entries(conversation))
    expect(stored).toContain('[account]')
    expect(stored).not.toContain(CRM_TOKEN)
    expect(JSON.stringify(model.requests)).not.toContain(CRM_TOKEN)
    expect(JSON.stringify(await running.agent.store.toolCalls.list({ limit: 1000 }))).not.toContain(CRM_TOKEN)
  })

  it('keeps one connection per space account: a second Sales space calls with its own token (TOOL-ACCESS-007)', async () => {
    const created = await call(jonas, 'POST', '/spaces', {
      templateId: 'sales',
      title: 'Sales US',
      purpose: 'Sell in the US',
    })
    const us = created.body.id as string
    await confirmed(jonas, () =>
      call(jonas, 'PATCH', `/spaces/${us}/tools/relaticle`, { bindings: { workspace: 'sales-us' } })
    )
    await confirmed(jonas, () =>
      call(jonas, 'PUT', `/spaces/${us}/tools/relaticle/account`, { values: { token: CRM_TOKEN_2 } })
    )
    const jonasUs = await open(jonas, { spaceId: us })
    model.script = [{ calls: [{ name: 'list-companies', arguments: {} }] }, { text: 'ok' }]
    await run(jonasUs, 'list')
    expect(crm.calls.at(-1)).toMatchObject({
      args: { workspace_id: 'sales-us' },
      authorization: `Bearer ${CRM_TOKEN_2}`,
    })
    model.script = [{ calls: [{ name: 'list-companies', arguments: {} }] }, { text: 'ok' }]
    await run(anaSales, 'list')
    expect(crm.calls.at(-1)).toMatchObject({ args: { workspace_id: 'sales-eu' }, authorization: `Bearer ${CRM_TOKEN}` })
    expect(crmSource().openAccounts).toBe(2)
  })

  it('gives a guest of the space none of the CRM tools, and a member whose roles do not list them none (TOOL-AVAIL-004/005)', async () => {
    const guest = await device('gina', ['sales'])
    await addMember(salesEu.id, guest.principal.id, 'guest')
    const guestSales = await open(guest, { spaceId: salesEu.id })
    await run(guestSales, 'hello')
    expect(toolNames()).not.toContain('create-note')
    const otto = await device('otto', ['employee'])
    await addMember(salesEu.id, otto.principal.id)
    const ottoSales = await open(otto, { spaceId: salesEu.id })
    await run(ottoSales, 'hello')
    expect(toolNames()).not.toContain('create-note')
    expect(toolNames()).toContain('search')
  })
})

describe('the confirmation of a call (TOOL-CALL-003..008, PROF-TOOL-007/008/012, INTX-APPR-012)', () => {
  let web1: Device
  let web2: Device
  let conversationId: string
  const longNote = `Called Marta: renewal in March. ${'x'.repeat(1170)}`

  it('asks the card in the run and on every other device, decided from any of them, the first decision counting', async () => {
    web1 = await open(ana, { spaceId: salesEu.id })
    conversationId = await conversationOf(web1.sessionId)
    web2 = await otherDevice(ana, conversationId)
    const before = received(web2.sessionId).length
    model.script = [
      {
        say: 'I will add the note.',
        calls: [
          {
            name: 'create-note',
            arguments: { company: 'Acme Logistics', note: longNote, tags: ['renewal', 'q1'], workspace_id: 'hr' },
          },
        ],
      },
      { text: 'The note is added.' },
    ]
    const running1 = start(web1, 'add a note')
    const pending = await pendingConfirmation(conversationId)
    // no step while the card waits, and the card on the other device, with the exact action
    await until(() =>
      received(web2.sessionId)
        .slice(before)
        .some((e) => e.type === 'ACTIVITY_SNAPSHOT')
    )
    const mirrored = received(web2.sessionId).slice(before)
    expect(mirrored.some((e) => e.type === 'STEP_STARTED')).toBe(false)
    const card = mirrored.find((e) => e.type === 'ACTIVITY_SNAPSHOT' && e.activityType === ACTIVITY.approval)
      ?.content as Doc
    expect(card).toMatchObject({
      approvalId: pending.id,
      kind: 'confirmation',
      status: 'PENDING',
      requester: { displayName: 'ana' },
      tool: 'create-note',
      allowForConversation: true,
      action: {
        title: 'Add a note',
        source: { id: 'relaticle', title: 'Relaticle CRM' },
        account: { kind: 'space', space: { id: salesEu.id, title: 'Sales EU' } },
      },
    })
    expect(card.action.fields).toEqual([
      { label: 'Workspace', value: 'sales-eu', pinned: true },
      { label: 'Region', value: 'eu', pinned: true },
      { label: 'Company', value: 'Acme Logistics' },
      { label: 'Note', value: longNote },
      { label: 'tags', value: JSON.stringify(['renewal', 'q1'], null, 2) },
    ])
    expect(card.untrusted).toBeUndefined()
    // never an approval request, never counted among pending approvals (INTX-APPR-012)
    expect(
      (await running.agent.ayniState((await running.agent.sessions.get(web1.sessionId)) as never)).pendingApprovals
    ).toBe(0)
    // decided on the other device: no turn of its own
    const decision = await decide(web2, pending.id, 'approve', 'once')
    expect(decision.events[0]).toMatchObject({ type: 'RUN_STARTED', noTurn: 'decision' })
    expect(decision.events.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      outcome: { type: 'decision', approvalId: pending.id, status: 'APPROVED' },
    })
    const result = await running1
    expect(crm.calls.at(-1)).toMatchObject({ name: 'create-note', args: { workspace_id: 'sales-eu', note: longNote } })
    // the reply goes on as a new message after the card (TOOL-CALL-007, CORE-MSG-011)
    const starts = result.events.filter((e) => e.type === 'TEXT_MESSAGE_START')
    expect(starts).toHaveLength(2)
    expect(textOf(result.events)).toContain('The note is added.')
    // a later decision gets the status already decided
    const late = await decide(web1, pending.id, 'reject')
    expect(late.events.at(-1)).toMatchObject({ outcome: { type: 'decision', status: 'APPROVED' } })
    expect((await running.agent.store.approvals.get(pending.id))?.scope).toBe('once')
    // history gives the card in its current status (PROF-HIST-006, §8)
    const history = (await call(web1, 'GET', `/${web1.sessionId}/messages?limit=100`)).body.messages
    const inHistory = history.find((m: { activityType?: string }) => m.activityType === ACTIVITY.approval)
    expect(inHistory.content).toMatchObject({ kind: 'confirmation', status: 'APPROVED', scope: 'once' })
    // the model reads the card as it was asked, and the decision as a record of its own after it, once: what it read of
    // the history never changes (LLM-CACHE-004)
    const recorded = await entries(conversationId)
    const asked = recorded.find((e) => e.sourceType === 'approval' && e.payload?.approvalId === pending.id)
    expect(asked?.text).toBe(`The person was asked to confirm Add a note (${pending.id}) on a card`)
    const decided = recorded.filter(
      (e) => e.sourceType === 'state-update' && e.payload?.kind === 'card-state' && e.payload.approvalId === pending.id
    )
    expect(decided.map((e) => e.text)).toEqual([`The person allowed Add a note (${pending.id})`])
    expect(history.some((m: { content?: unknown }) => String(m.content).includes('The person allowed'))).toBe(false)
  })

  it('tells the model the person refused, and not to try again; leaves a record (TOOL-CALL-004, TOOL-PROV-004)', async () => {
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'n' } }] }, { text: 'ok' }]
    const turn = start(web1, 'note')
    const pending = await pendingConfirmation(conversationId)
    await decide(web1, pending.id, 'reject')
    await turn
    expect(toolAnswers().at(-1)).toBe(
      `The person refused Add a note: it did not run. Do not try it again unless the person asks for it.\n\n${ONE_CALL}`
    )
    const [record] = await running.agent.store.toolCalls.list({ conversationId, limit: 1 })
    expect(record).toMatchObject({
      outcome: 'refused',
      rule: 'confirm',
      confirmation: { approvalId: pending.id, status: 'REJECTED' },
    })
  })

  it('ends a card unanswered in time as expired (TOOL-CALL-004)', async () => {
    const confirmation = running.agent.pack.approvals?.confirmation as { timeoutSeconds: number }
    confirmation.timeoutSeconds = 0.3
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'n' } }] }, { text: 'ok' }]
    await run(web1, 'note')
    confirmation.timeoutSeconds = 300
    expect(toolAnswers().at(-1)).toBe(
      `The person did not answer the confirmation of Add a note in time: it did not run.\n\n${ONE_CALL}`
    )
    const [record] = await running.agent.store.toolCalls.list({ conversationId, limit: 1 })
    expect(record?.outcome).toBe('expired')
  })

  it('ends the card as cancelled when the person writes instead, and answers that message next (TOOL-CALL-004)', async () => {
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'n' } }] }, { text: 'ok' }]
    const turn = start(web1, 'note')
    const pending = await pendingConfirmation(conversationId)
    const waiting = await run(web2, 'no, call it Q4 review')
    expect(waiting.events[0]).toMatchObject({ type: 'RUN_STARTED', noTurn: 'waiting' })
    await turn
    expect((await running.agent.store.approvals.get(pending.id))?.status).toBe('CANCELLED')
    await until(() => model.requests.some((r) => JSON.stringify(r.messages).includes('Q4 review')))
    await idle(conversationId)
    const record = (await running.agent.store.toolCalls.list({ conversationId, limit: 5 })).find(
      (r) => r.confirmation && 'approvalId' in r.confirmation && r.confirmation.approvalId === pending.id
    )
    expect(record?.outcome).toBe('cancelled')
  })

  it('asks no card for arguments that do not validate (TOOL-CALL-003)', async () => {
    const before = (await running.agent.store.approvals.list({})).length
    model.script = [{ calls: [{ name: 'create-note', arguments: { note: 'no company' } }] }, { text: 'ok' }]
    await run(web1, 'note')
    expect(toolAnswers().at(-1)).toContain('The arguments of Add a note are not valid')
    expect((await running.agent.store.approvals.list({})).length).toBe(before)
  })

  it('asks the card of every bound AG-UI session of the conversation, whatever its client declares, and none of a service (TOOL-CALL-005)', async () => {
    // a client that declares no profile version is asked the card: there is no run-time test of a version any more
    const unversioned = await open(ana, { spaceId: salesEu.id, profileVersion: null })
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'n' } }] }, { text: 'ok' }]
    const before = crm.calls.length
    const turn = start(unversioned, 'note')
    const pending = await pendingConfirmation(await conversationOf(unversioned.sessionId))
    expect(pending.kind).toBe('confirmation')
    await decide(unversioned, pending.id, 'reject')
    await turn
    expect(crm.calls.length).toBe(before)
    // a service peer is asked no card: its call does not run (TOOL-CALL-005)
    const service = await device('svc', ['sales'])
    await addMember(salesEu.id, service.principal.id)
    await running.agent.principals.save({ ...service.principal, connectionType: 'verifiable-service' })
    const serviceSales = await open(service, { spaceId: salesEu.id })
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'n' } }] }, { text: 'ok' }]
    await run(serviceSales, 'note')
    expect(toolAnswers().at(-1)).toBe(
      `Add a note needs the person's confirmation, which could not be asked here: it did not run.\n\n${ONE_CALL}`
    )
  })

  it('allows the later calls of the conversation without a card while the allowance lasts, and stops it (TOOL-CALL-006, PROF-TOOL-012)', async () => {
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'first' } }] }, { text: 'ok' }]
    const turn = start(web1, 'note')
    const pending = await pendingConfirmation(conversationId)
    await decide(web1, pending.id, 'approve', 'conversation')
    await turn
    expect((await running.agent.store.approvals.get(pending.id))?.scope).toBe('conversation')
    // the second note: no card, a record that names the allowance
    const asked = (await running.agent.store.approvals.list({})).length
    model.script = [
      { calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'second' } }] },
      { text: 'ok' },
    ]
    await run(web1, 'another')
    expect(crm.calls.at(-1)).toMatchObject({ name: 'create-note', args: { note: 'second' } })
    expect((await running.agent.store.approvals.list({})).length).toBe(asked)
    const [record] = await running.agent.store.toolCalls.list({ conversationId, limit: 1 })
    expect(record).toMatchObject({ outcome: 'completed', confirmation: { allowanceApprovalId: pending.id } })
    // in another conversation the card shows again
    const other = await open(ana, { spaceId: salesEu.id })
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'n' } }] }, { text: 'ok' }]
    const elsewhere = start(other, 'note')
    const card = await pendingConfirmation(await conversationOf(other.sessionId))
    await decide(other, card.id, 'reject')
    await elsewhere
    // stopped from a card: 204, again 204, told to every session, and the next call asks again
    expect(
      (await call(web1, 'DELETE', `/conversations/${await conversationOf(other.sessionId)}/allowances/${pending.id}`))
        .status
    ).toBe(404)
    const stream = received(web2.sessionId).length
    expect((await call(web1, 'DELETE', `/conversations/${conversationId}/allowances/${pending.id}`)).status).toBe(204)
    expect((await call(web1, 'DELETE', `/conversations/${conversationId}/allowances/${pending.id}`)).status).toBe(204)
    expect(
      received(web2.sessionId)
        .slice(stream)
        .find((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.approvalUpdate)?.value
    ).toEqual({ approvalId: pending.id, status: 'APPROVED', scope: 'conversation', allowanceEnded: true })
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'third' } }] }, { text: 'ok' }]
    const third = start(web1, 'third')
    const again = await pendingConfirmation(conversationId)
    await decide(web1, again.id, 'approve', 'conversation')
    await third
    // the owner replaces the account: the allowance ends
    await confirmed(jonas, () =>
      call(jonas, 'PUT', `/spaces/${salesEu.id}/tools/relaticle/account`, { values: { token: CRM_TOKEN_3 } })
    )
    await until(async () => !!(await running.agent.store.toolAllowances.get(again.id))?.endedAt)
    model.script = [
      { calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'fourth' } }] },
      { text: 'ok' },
    ]
    const fourth = start(web1, 'fourth')
    const asksAgain = await pendingConfirmation(conversationId)
    await decide(web1, asksAgain.id, 'approve', 'conversation')
    await fourth
    expect(crm.calls.at(-1)?.authorization).toBe(`Bearer ${CRM_TOKEN_3}`)
  })

  it('asks a card naming the untrusted sources, with no allowance, after a turn read one (TOOL-CALL-008, PROF-TOOL-008)', async () => {
    // create-note is allowed for the conversation: without the search, it runs at once
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'plain' } }] }, { text: 'ok' }]
    const asked = (await running.agent.store.approvals.list({})).length
    await run(web1, 'plain')
    expect((await running.agent.store.approvals.list({})).length).toBe(asked)
    model.script = [
      { calls: [{ name: 'search', arguments: { q: 'acme' } }] },
      { calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'from the web' } }] },
      { text: 'ok' },
    ]
    const turn = start(web1, 'search then note')
    const pending = await pendingConfirmation(conversationId)
    expect(pending).toMatchObject({ allowForConversation: false, untrustedSources: ['Web search'] })
    // scope conversation on such a card is taken as once
    await decide(web1, pending.id, 'approve', 'conversation')
    const result = await turn
    const card = result.events.find((e) => e.type === 'ACTIVITY_SNAPSHOT' && e.activityType === ACTIVITY.approval)
      ?.content as Record<string, unknown>
    expect(card).toMatchObject({ untrusted: { sources: ['Web search'] }, allowForConversation: false })
    expect((await running.agent.store.approvals.get(pending.id))?.scope).toBe('once')
    expect(await running.agent.store.toolAllowances.get(pending.id)).toBeUndefined()
    const [record] = await running.agent.store.toolCalls.list({ conversationId, limit: 1 })
    expect(record).toMatchObject({ raisedByUntrusted: true, outcome: 'completed' })
  })

  it('takes the calls asked together one at a time, each with its card (TOOL-CALL-007)', async () => {
    const fresh = await open(ana, { spaceId: salesEu.id })
    const id = await conversationOf(fresh.sessionId)
    model.script = [
      {
        calls: [
          { name: 'create-note', arguments: { company: 'A', note: 'one' } },
          { name: 'create-note', arguments: { company: 'B', note: 'two' } },
        ],
      },
      { text: 'both' },
    ]
    const turn = start(fresh, 'two notes')
    const first = await pendingConfirmation(id)
    expect(
      (await running.agent.store.approvals.list({ status: 'PENDING' })).filter((r) => r.conversationId === id)
    ).toHaveLength(1)
    await decide(fresh, first.id, 'approve')
    const second = await pendingConfirmation(id)
    expect(second.id).not.toBe(first.id)
    await decide(fresh, second.id, 'approve')
    await turn
    expect(crm.calls.slice(-2).map((c) => c.args.note)).toEqual(['one', 'two'])
  })
})

describe('the rules of the owner, and the approval of a tool of a space (TOOL-SPACE-006, TOOL-CALL-002/009, INTX-APPR-004/005/013/014)', () => {
  it('applies a stricter rule at once, refuses a looser one than the pack, holds a looser one for the phone', async () => {
    const asked = ph.callsOf('sendConfirmRequest').length
    const stricter = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, {
      calls: { 'create-note': 'approval' },
    })
    expect(stricter.status).toBe(200)
    expect(stricter.body.tool.tools.find((t: { name: string }) => t.name === 'create-note')).toMatchObject({
      rule: 'approval',
      packRule: 'confirm',
    })
    expect(ph.callsOf('sendConfirmRequest').length).toBe(asked)
    const looser = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, {
      calls: { 'create-note': 'none' },
    })
    expect(looser).toMatchObject({ status: 422, body: { error: 'looser-than-pack', field: 'calls.create-note' } })
    // the owner's approval: a member's call waits for Jonas, by name (TOOL-CALL-009)
    const anaSales = await open(ana, { spaceId: salesEu.id })
    model.script = [
      { calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'needs Jonas' } }] },
      { text: 'ok' },
    ]
    await run(anaSales, 'note')
    expect(toolAnswers().at(-1)).toBe(
      `Add a note needs the approval of the owner of the space, jonas. The request is pending: the action runs once approved, and its outcome will be told in this conversation.\n\n${ONE_CALL}`
    )
    const pending = (await running.agent.store.approvals.list({ status: 'PENDING' })).find((r) => r.spacePolicy)
    expect(pending).toMatchObject({ spaceId: salesEu.id, sourceId: 'relaticle', kind: 'sensitivity' })
    // a manager of the pack who is not the owner is no approver (INTX-APPR-004)
    const mia = await device('mia', ['employee', 'manager'])
    expect(await running.agent.approvals.pendingFor(mia.principal)).toHaveLength(0)
    expect((await running.agent.approvals.pendingFor(jonas.principal)).map((r) => r.id)).toContain(pending?.id)
    // an owner's approval is decided on the phone (INTX-APPR-019)
    expect((await decide(jonas, pending?.id as string, 'reject')).events.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      code: 'decide-on-phone',
    })
    await ph.authorize(jonas.connectionId, 'rejected', { approvalId: pending?.id })
    const [record] = await running.agent.store.toolCalls.list({ principalId: ana.principal.id, limit: 1 })
    expect(record).toMatchObject({
      outcome: 'not-approved',
      rule: 'approval',
      approval: { status: 'REJECTED', decidedBy: ['jonas'] },
    })
    // the owner asking a call of his own space, its one approver under the default policy, confirms it on his phone,
    // attested, a self-approval; no card in the conversation asks it (INTX-APPR-005, INTX-APPR-023)
    const jonasSales = await open(jonas, { spaceId: salesEu.id })
    model.script = [{ calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'mine' } }] }, { text: 'ok' }]
    const phoneBefore = ph.authorizeRequests(jonas.connectionId).length
    await run(jonasSales, 'note')
    const own = (await running.agent.store.approvals.list({ status: 'PENDING' })).find(
      (r) => r.requesterId === jonas.principal.id && r.spaceId === salesEu.id
    ) as ApprovalRecord
    expect(own).toMatchObject({ approverIds: [jonas.principal.id], kind: 'sensitivity' })
    const request = ph.authorizeRequests(jonas.connectionId).slice(phoneBefore)
    expect(request).toHaveLength(1)
    expect(request[0]?.request).toMatchObject({ attested: true })
    await ph.authorize(jonas.connectionId, 'approved', { approvalId: own.id })
    await until(() => crm.calls.at(-1)?.args.note === 'mine')
    const decided = await running.agent.store.approvals.get(own.id)
    expect(decided).toMatchObject({ status: 'APPROVED' })
    expect(decided?.decisions[0]).toMatchObject({ approverId: jonas.principal.id, self: true })
    // back to the pack's rule: looser than the one in force, so it waits for the phone
    await confirmed(jonas, () =>
      call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, { calls: { 'create-note': 'confirm' } })
    )
    // `off`: out of the next turn's tools
    expect(
      (await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, { calls: { 'get-company': 'off' } })).status
    ).toBe(200)
    await run(anaSales, 'hello')
    expect(toolNames()).not.toContain('get-company')
    expect(toolNames()).toContain('list-companies')
    // a member reads only the tools members can use; the owner reads it, off (PROF-TOOL-001)
    const memberTools = (await call(ana, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0].tools
    expect(memberTools.map((t: { title: string }) => t.title)).not.toContain('Get company')
    expect(memberTools.map((t: { title: string }) => t.title)).toContain('List companies')
    const ownerTools = (await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0].tools
    expect(ownerTools.find((t: { name: string }) => t.name === 'get-company')).toMatchObject({ rule: 'off' })
  })

  let comms: { id: string }
  let anaComms: Device
  const post = `Our spring offer is out. ${'All details on the site. '.repeat(20)}`

  it('lets the owner add an offered source, bind it and set its account; refuses a member and a second add (TOOL-SPACE-003)', async () => {
    comms = (await call(jonas, 'POST', '/spaces', { templateId: 'comms', title: 'Communication', purpose: 'Posts' }))
      .body
    await addMember(comms.id, ana.principal.id)
    const listed = (await call(jonas, 'GET', `/spaces/${comms.id}/tools`)).body.tools
    expect(listed[0]).toMatchObject({ source: 'post_to_x', state: 'available', add: 'owner' })
    expect((await call(ana, 'POST', `/spaces/${comms.id}/tools`, { source: 'post_to_x' })).body.error).toBe('not-owner')
    expect((await call(jonas, 'POST', `/spaces/${comms.id}/tools`, { source: 'relaticle' })).status).toBe(404)
    await confirmed(jonas, () =>
      call(jonas, 'POST', `/spaces/${comms.id}/tools`, { source: 'post_to_x', bindings: { handle: '@acme' } })
    )
    expect((await call(jonas, 'POST', `/spaces/${comms.id}/tools`, { source: 'post_to_x' })).body).toMatchObject({
      error: 'already-added',
    })
    await confirmed(jonas, () =>
      call(jonas, 'PUT', `/spaces/${comms.id}/tools/post_to_x/account`, { values: { token: X_TOKEN } })
    )
    expect((await call(jonas, 'GET', `/spaces/${comms.id}/tools`)).body.tools[0]).toMatchObject({ state: 'ready' })
    const activity = (await call(jonas, 'GET', `/spaces/${comms.id}/activity`)).body.activity.map(
      (a: { kind: string }) => a.kind
    )
    expect(activity.slice(0, 2)).toEqual(['account-set', 'tool-added'])
  })

  it("routes a member's post to the owner, with the exact call, on his phone and in his Notifications; approved, it runs (INTX-APPR-013/014)", async () => {
    anaComms = await open(ana, { spaceId: comms.id })
    const jonasStream = received(jonas.sessionId).length
    model.script = [{ calls: [{ name: 'post_to_x', arguments: { text: post } }] }, { text: 'asked' }]
    await run(anaComms, 'post it')
    expect(toolAnswers().at(-1)).toContain('Post on X needs the approval of the owner of the space, jonas.')
    const pending = (await running.agent.store.approvals.list({ status: 'PENDING' })).find(
      (r) => r.spaceId === comms.id
    )
    if (!pending) throw new Error('no approval')
    // no card and no request in any session of his: his Notifications changed (D114, PROF-TOOL-025)
    await until(() =>
      received(jonas.sessionId)
        .slice(jonasStream)
        .some((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.spaceNotificationsChanged)
    )
    const toJonas = received(jonas.sessionId).slice(jonasStream)
    expect(toJonas.some((e) => e.type === 'ACTIVITY_SNAPSHOT' && e.activityType === ACTIVITY.approval)).toBe(false)
    expect(
      toJonas.find((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.spaceNotificationsChanged)?.value
    ).toEqual({ spaceId: comms.id, id: pending.id, kind: 'approval', waiting: true, count: 1 })
    const listed = (await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
    expect(listed.waiting).toBe(1)
    expect(listed.notifications[0]).toMatchObject({
      id: pending.id,
      kind: 'approval',
      waiting: true,
      approval: {
        approvalId: pending.id,
        kind: 'sensitivity',
        status: 'PENDING',
        canDecide: true,
        own: false,
        attested: true,
        myDecision: null,
        space: { id: comms.id, title: 'Communication' },
        action: {
          title: 'Post on X',
          source: { id: 'post_to_x', title: 'Post on X' },
          account: { kind: 'space', space: { id: comms.id, title: 'Communication' } },
          fields: [
            { label: 'X account', value: '@acme', pinned: true },
            { label: 'Post', value: post },
          ],
        },
      },
    })
    // his phone: an attested authorize flow whose justification is the exact call, linked to the space's Notifications
    const authorize = ph.callsOf('sendAuthorizeRequest').at(-1)?.args[0] as Doc
    expect(authorize.connectionId).toBe(jonas.connectionId)
    expect(authorize.request).toMatchObject({
      purpose: { id: 'tool-call', label: 'Post on X' },
      justification: `Post on X, with the account of Communication\nX account: @acme\nPost: ${post}`,
      scope: ['tool:post_to_x.post_to_x', `space:${comms.id}`],
      attested: true,
    })
    const opened = ph.callsOf('openFlow').find((c) => (c.result as Doc).flowId === authorize.flowId)?.args[0] as Doc
    expect(opened.origin).toEqual({ channel: 'none' })
    expect(opened.link).toBe(
      `https://app.ayni.org/app/service/${running.agent.did}/spaces/${comms.id}/notifications?approval=${pending.id}`
    )
    // Ana's own card shows the same action, in her history (PROF-TOOL-009)
    const anaHistory = (await call(anaComms, 'GET', `/${anaComms.sessionId}/messages?limit=100`)).body.messages
    const anaCard = anaHistory.find(
      (m: { activityType?: string; content: { approvalId?: string } }) =>
        m.activityType === ACTIVITY.approval && m.content.approvalId === pending.id
    )
    expect(anaCard.content).toMatchObject({
      status: 'PENDING',
      own: true,
      canDecide: false,
      space: { id: comms.id, title: 'Communication' },
      action: { title: 'Post on X', fields: [{ label: 'X account' }, { label: 'Post', value: post }] },
    })
    // in his browser it is decided on the phone only (INTX-APPR-019); Decide on your phone sends it again
    const fromBrowser = await decide(jonas, pending.id, 'approve')
    expect(fromBrowser.events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'decide-on-phone' })
    expect((await running.agent.store.approvals.get(pending.id))?.status).toBe('PENDING')
    const resent = await call(jonas, 'POST', `/approvals/${pending.id}/resend`)
    expect(resent).toMatchObject({ status: 202, body: { expiresAt: pending.expiresAt } })
    expect(ph.callsOf('closeFlow').some((c) => c.args[0] === authorize.flowId)).toBe(true)
    const again = ph.authorizeRequests(jonas.connectionId).at(-1) as Doc
    expect(again.flowId).not.toBe(authorize.flowId)
    // decided on his phone: it runs with the text Ana's card showed, and her conversation is told
    await ph.authorize(jonas.connectionId, 'approved', { approvalId: pending.id })
    await until(() => x.requests.some((r) => r.url === '/2/tweets'))
    const sent = x.requests.find((r) => r.url === '/2/tweets')
    expect(sent).toMatchObject({ method: 'POST', authorization: `Bearer ${X_TOKEN}`, body: { text: post } })
    const anaConversation = await conversationOf(anaComms.sessionId)
    await until(async () =>
      (await entries(anaConversation)).some((e) => e.text.startsWith('The approved action Post on X ran.'))
    )
    const told = (await entries(anaConversation)).find((e) => e.text.startsWith('The approved action Post on X ran.'))
    expect(told?.sources).toEqual([{ sourceId: 'post_to_x', accountKind: 'space', spaceId: comms.id }])
    // the outcome, and no result: the result is in the tool call the model reads (TOOL-PROV-006)
    expect(told?.text).toBe('The approved action Post on X ran.')
    const result = (await entries(anaConversation)).find((e) => e.sourceType === 'tool-call')
    expect(JSON.stringify(result?.payload)).toContain('[account]')
    expect(JSON.stringify(result?.payload)).not.toContain(X_TOKEN)
    const [record] = await running.agent.store.toolCalls.list({ conversationId: anaConversation, limit: 1 })
    expect(record).toMatchObject({
      outcome: 'completed',
      sourceId: 'post_to_x',
      account: { kind: 'space', spaceId: comms.id },
      approval: { approvalId: pending.id, status: 'APPROVED', decidedBy: ['jonas'] },
    })
    expect((await running.agent.store.approvals.get(pending.id))?.decisions[0]?.attestation?.method).toBe('biometric')
    // his Notifications keep it, decided (INTX-APPR-017)
    const after = (await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
    expect(after.waiting).toBe(0)
    expect(after.notifications[0]).toMatchObject({
      waiting: false,
      approval: {
        status: 'APPROVED',
        canDecide: false,
        decisions: [{ by: { displayName: 'jonas' }, decision: 'approve' }],
      },
    })
  })

  it('cancels a pending approval and erases the fields of the cards when the message is deleted (INTX-APPR-015)', async () => {
    model.script = [{ calls: [{ name: 'post_to_x', arguments: { text: 'a post to delete' } }] }, { text: 'asked' }]
    const asked = await run(anaComms, 'post another')
    const pending = (await running.agent.store.approvals.list({ status: 'PENDING' })).find(
      (r) => r.spaceId === comms.id
    )
    if (!pending?.inboundId) throw new Error('no approval')
    void asked
    const flowId = (ph.authorizeRequests(jonas.connectionId).at(-1) as Doc).flowId
    const deleted = await call(anaComms, 'DELETE', `/${anaComms.sessionId}/messages/${pending.inboundId}`)
    expect(deleted.status).toBe(204)
    const after = await running.agent.store.approvals.get(pending.id)
    expect(after).toMatchObject({
      status: 'CANCELLED',
      argsErased: true,
      action: { fields: [], erased: true, title: 'Post on X' },
    })
    expect(after?.actionArgs).toBeUndefined()
    // the card stays in the requester's history, with no field
    const history = (await call(anaComms, 'GET', `/${anaComms.sessionId}/messages?limit=100`)).body.messages
    const cards = history.filter(
      (m: { activityType?: string; content: { approvalId?: string } }) =>
        m.activityType === ACTIVITY.approval && m.content.approvalId === pending.id
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].content).toMatchObject({ status: 'CANCELLED', action: { fields: [], erased: true } })
    expect(JSON.stringify(history)).not.toContain('a post to delete')
    // his phone's request closes, and his Notifications keep the title and Withdrawn (INTX-APPR-015)
    expect(ph.callsOf('closeFlow').some((c) => c.args[0] === flowId)).toBe(true)
    const item = ((await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc).notifications.find(
      (n: Doc) => n.id === pending.id
    )
    expect(item.approval).toMatchObject({
      status: 'CANCELLED',
      action: { title: 'Post on X', fields: [], erased: true },
    })
    expect(JSON.stringify(item)).not.toContain('a post to delete')
  })
})

describe('provenance and the record of each call (TOOL-PROV-001..006, PROF-TOOL-010/011/013)', () => {
  let anaSales: Device
  let conversationId: string

  it('records the sources of a reply, gives them in history, and the conversation lists them with their counts', async () => {
    anaSales = await open(ana, { spaceId: salesEu.id })
    conversationId = await conversationOf(anaSales.sessionId)
    // a turn that ran a bundled tool only: its reply has no sources (TOOL-PROV-002)
    model.script = [{ calls: [{ name: 'knowledge_search', arguments: { query: 'acme' } }] }, { text: 'searched notes' }]
    await run(anaSales, 'zero')
    const bundledOnly = (await call(anaSales, 'GET', `/${anaSales.sessionId}/messages?limit=100`)).body.messages
    const bundledReply = bundledOnly.filter((m: { role: string }) => m.role === 'assistant').at(-1)
    expect(bundledReply.content).toBe('searched notes')
    expect(bundledReply.metadata.sources).toBeUndefined()
    // a bundled tool and the CRM in one turn: the CRM only
    model.script = [
      {
        calls: [
          { name: 'knowledge_search', arguments: { query: 'acme' } },
          { name: 'list-companies', arguments: {} },
        ],
      },
      { text: 'listed' },
    ]
    await run(anaSales, 'first')
    const firstReply = (await call(anaSales, 'GET', `/${anaSales.sessionId}/messages?limit=100`)).body.messages
      .filter((m: { role: string }) => m.role === 'assistant')
      .at(-1)
    expect(firstReply.metadata.sources).toEqual([{ source: 'relaticle', title: 'Relaticle CRM', account: 'space' }])
    model.script = [{ calls: [{ name: 'list-companies', arguments: {} }] }, { text: 'listed' }]
    await run(anaSales, 'second')
    model.script = [
      { calls: [{ name: 'search', arguments: { q: 'acme' } }] },
      { calls: [{ name: 'list-companies', arguments: {} }] },
      { text: 'searched' },
    ]
    const third = await run(anaSales, 'third')
    // no tool name in the step labels of the turn (PROF-TOOL-013)
    const labels = third.events.filter((e) => e.type === 'STEP_STARTED').map((e) => String(e.stepName))
    expect(labels).toEqual(['Using Web search', 'Using Relaticle CRM'])
    const history = (await call(anaSales, 'GET', `/${anaSales.sessionId}/messages?limit=100`)).body.messages
    const replies = history.filter((m: { role: string }) => m.role === 'assistant')
    expect(replies.at(-1).metadata.sources).toEqual([
      { source: 'websearch', title: 'Web search', account: 'agent' },
      { source: 'relaticle', title: 'Relaticle CRM', account: 'space' },
    ])
    expect(JSON.stringify(history)).not.toContain('list-companies')
    const sources = await call(anaSales, 'GET', `/conversations/${conversationId}/sources`)
    expect(sources.status).toBe(200)
    expect(sources.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'relaticle',
          title: 'Relaticle CRM',
          account: { kind: 'space', space: { id: salesEu.id, title: 'Sales EU' } },
          results: 3,
        }),
        expect.objectContaining({ source: 'websearch', title: 'Web search', account: { kind: 'agent' }, results: 1 }),
      ])
    )
    // the knowledge search ran twice, and is no source of the conversation (TOOL-PROV-003)
    expect(sources.body.sources).toHaveLength(2)
    expect((await call(jonas, 'GET', `/conversations/${conversationId}/sources`)).status).toBe(404)
    // the stored entry: the provenance in the clear, the arguments and result only in the ciphertext (TOOL-PROV-001)
    const rows = await running.agent.store.entries.listAll({ conversationId, limit: 1000 })
    const row = rows.find((r) => r.sourceType === 'tool-call' && r.provenance?.toolName === 'list-companies')
    expect(row?.provenance).toMatchObject({
      sourceId: 'relaticle',
      toolName: 'list-companies',
      account: { kind: 'space', spaceId: salesEu.id },
      untrusted: false,
    })
    const { cipher: _c, ...clear } = row as unknown as Record<string, unknown>
    expect(JSON.stringify(clear)).not.toContain('Acme')
  })

  it('reads a shared conversation with the same sources (TOOL-PROV-002)', async () => {
    expect((await call(anaSales, 'POST', `/conversations/${conversationId}/share`)).status).toBe(200)
    const shared = await call(jonas, 'GET', `/spaces/${salesEu.id}/shared/${conversationId}/messages?limit=100`)
    const replies = shared.body.messages.filter((m: { role: string }) => m.role === 'assistant')
    expect(replies.at(-1).metadata.sources).toEqual([
      { source: 'websearch', title: 'Web search', account: 'agent' },
      { source: 'relaticle', title: 'Relaticle CRM', account: 'space' },
    ])
  })

  it('counts no result erased with a deleted message, and keeps the call records (TOOL-PROV-003/004)', async () => {
    const records = (await running.agent.store.toolCalls.list({ conversationId, limit: 100 })).length
    const history = (await call(anaSales, 'GET', `/${anaSales.sessionId}/messages?limit=100`)).body.messages
    const third = history.filter((m: { role: string }) => m.role === 'user').at(-1)
    expect((await call(anaSales, 'DELETE', `/${anaSales.sessionId}/messages/${third.id}`)).status).toBe(204)
    const sources = (await call(anaSales, 'GET', `/conversations/${conversationId}/sources`)).body.sources
    expect(sources).toEqual([expect.objectContaining({ source: 'relaticle', results: 2 })])
    expect((await running.agent.store.toolCalls.list({ conversationId, limit: 100 })).length).toBe(records)
  })

  it('lets an auditor read the call records through the admin interface only, each read recorded (TOOL-PROV-005)', async () => {
    // the person the admin interface signed in, whose entry of the directory holds the auditor role (RBAC-XSESS-008/009)
    const jonas = { id: 'prn_jonas_auditor', roles: ['auditor'] } as unknown as Principal
    const admin = buildAdmin({
      store: running.agent.store,
      memory: running.agent.memory,
      evidence: running.agent.evidence,
      logger: running.agent.logger,
      signedIn: async (request) => (request.headers['x-test-signed-in'] === jonas.id ? jonas : undefined),
      announceErased: async () => undefined,
    })
    const from = new Date(Date.now() - 3600_000).toISOString()
    const read = await admin.inject({
      method: 'GET',
      url: `/admin/audit/tool-calls?spaceId=${salesEu.id}&sourceId=relaticle&from=${encodeURIComponent(from)}`,
      headers: { 'x-test-signed-in': jonas.id, 'x-ayni-reason': 'weekly review' },
    })
    expect(read.statusCode).toBe(200)
    const body = read.json() as { calls: Record<string, unknown>[]; auditId: string }
    expect(body.calls.length).toBeGreaterThan(3)
    expect(body.calls.every((c) => c.spaceId === salesEu.id && c.sourceId === 'relaticle')).toBe(true)
    // no argument, no result, no account value (TOOL-PROV-004)
    expect(JSON.stringify(body.calls)).not.toContain('Acme')
    expect(JSON.stringify(body.calls)).not.toContain('crmToken')
    const log = await running.agent.store.adminAudit.list(5, { action: 'audit-read' })
    expect(log[0]).toMatchObject({
      id: body.auditId,
      actor: jonas.id,
      principalId: jonas.id,
      reason: 'weekly review',
      detail: { what: 'tool-calls' },
    })
    expect(log[0]?.breakGlass).toBeUndefined()
    const anonymous = await admin.inject({ method: 'GET', url: '/admin/audit/tool-calls' })
    expect(anonymous.statusCode).toBe(401)
    const noReason = await admin.inject({
      method: 'GET',
      url: '/admin/audit/tool-calls',
      headers: { 'x-test-signed-in': jonas.id },
    })
    expect(noReason.statusCode).toBe(400)
    await admin.close()
    // no endpoint of the AG-UI profile serves them
    expect((await call(anaSales, 'GET', '/admin/audit/tool-calls')).status).toBe(404)
  })
})

describe('the life of the tools of a space (TOOL-SPACE-007/011, TOOL-CALL-001)', () => {
  it('clears the account at once, removes a source to off and adds it back from scratch (TOOL-SPACE-005/007)', async () => {
    const us = (await call(jonas, 'POST', '/spaces', { templateId: 'sales', title: 'Sales APAC', purpose: 'APAC' }))
      .body.id as string
    await confirmed(jonas, () =>
      call(jonas, 'PATCH', `/spaces/${us}/tools/relaticle`, { bindings: { workspace: 'apac' } })
    )
    await confirmed(jonas, () =>
      call(jonas, 'PUT', `/spaces/${us}/tools/relaticle/account`, { values: { token: CRM_TOKEN_2 } })
    )
    const cleared = await call(jonas, 'DELETE', `/spaces/${us}/tools/relaticle/account`)
    expect(cleared).toMatchObject({ status: 200, body: { tool: { state: 'setup', account: { set: false } } } })
    expect(await running.agent.store.spaceAccounts.get(us, 'relaticle')).toBeUndefined()
    await confirmed(jonas, () =>
      call(jonas, 'PUT', `/spaces/${us}/tools/relaticle/account`, { values: { token: CRM_TOKEN_2 } })
    )
    const removed = await call(jonas, 'DELETE', `/spaces/${us}/tools/relaticle`)
    expect(removed.body.tool).toMatchObject({ state: 'off', account: { set: false } })
    expect(removed.body.tool.bindings[0].value).toBeNull()
    expect(await running.agent.store.spaceAccounts.get(us, 'relaticle')).toBeUndefined()
    await confirmed(jonas, () => call(jonas, 'POST', `/spaces/${us}/tools`, { source: 'relaticle' }))
    expect((await call(jonas, 'GET', `/spaces/${us}/tools`)).body.tools[0]).toMatchObject({
      state: 'setup',
      account: { set: false },
    })
    const kinds = (await call(jonas, 'GET', `/spaces/${us}/activity`)).body.activity.map(
      (a: { kind: string }) => a.kind
    )
    expect(kinds.slice(0, 4)).toEqual(['tool-added', 'tool-removed', 'account-set', 'account-cleared'])
  })

  it('withdraws a pending change, closing its flow as cancelled (TOOL-SPACE-009, PROF-TOOL-005)', async () => {
    const pending = await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, {
      calls: { 'get-company': 'none' },
    })
    expect(pending.status).toBe(202)
    const flowId = (ph.callsOf('sendConfirmRequest').at(-1)?.args[0] as { flowId: string } | undefined)?.flowId
    expect((await call(jonas, 'DELETE', `/spaces/${salesEu.id}/tools/relaticle/pending`)).status).toBe(204)
    expect((await call(jonas, 'DELETE', `/spaces/${salesEu.id}/tools/relaticle/pending`)).status).toBe(404)
    expect(
      ph
        .callsOf('closeFlow')
        .some((c) => c.args[0] === flowId && (c.args[1] as { outcome: string }).outcome === 'cancelled')
    ).toBe(true)
    expect((await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0].pending).toBeNull()
  })

  it('keeps the tools when the space changes owner, dropping a pending change; a source no longer named leaves (TOOL-SPACE-011)', async () => {
    const team = (await call(jonas, 'POST', '/spaces', { templateId: 'sales', title: 'Sales LATAM', purpose: 'LATAM' }))
      .body
    await confirmed(jonas, () =>
      call(jonas, 'PATCH', `/spaces/${team.id}/tools/relaticle`, { bindings: { workspace: 'latam' } })
    )
    await confirmed(jonas, () =>
      call(jonas, 'PUT', `/spaces/${team.id}/tools/relaticle/account`, { values: { token: CRM_TOKEN_2 } })
    )
    await addMember(team.id, ana.principal.id)
    expect(
      (await call(jonas, 'PATCH', `/spaces/${team.id}/tools/relaticle`, { bindings: { workspace: 'latam-two' } }))
        .status
    ).toBe(202)
    const memberId = (await call(jonas, 'GET', `/spaces/${team.id}`)).body.members.find(
      (m: { name: string }) => m.name === 'ana'
    ).memberId
    expect((await call(jonas, 'POST', `/spaces/${team.id}/owner`, { memberId })).status).toBe(200)
    const tool = (await call(ana, 'GET', `/spaces/${team.id}/tools`)).body.tools[0]
    expect(tool).toMatchObject({ state: 'ready', pending: null, account: { set: true } })
    expect(
      (await call(ana, 'PATCH', `/spaces/${team.id}/tools/relaticle`, { calls: { 'get-company': 'approval' } })).status
    ).toBe(200)
  })

  it('asks the card, then the step-up on the phone, then runs; a refused card asks nothing of the phone (TOOL-CALL-001)', async () => {
    // the step-up of create-note of the CRM, in its own source (TOOL-CAT-010)
    const note = running.agent.pack.tools?.sources?.relaticle?.tools?.['create-note']
    if (!note) throw new Error('create-note is not declared')
    note.stepUp = { authChallenge: { type: 'device', onChannelUnavailable: 'fail' } }
    const fresh = await open(ana, { spaceId: salesEu.id })
    const id = await conversationOf(fresh.sessionId)
    const confirms = ph.callsOf('sendConfirmRequest').length
    model.script = [
      { calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'refused' } }] },
      { text: 'ok' },
    ]
    const refused = start(fresh, 'note')
    await decide(fresh, (await pendingConfirmation(id)).id, 'reject')
    await refused
    expect(ph.callsOf('sendConfirmRequest').length).toBe(confirms)
    model.script = [
      { calls: [{ name: 'create-note', arguments: { company: 'Acme', note: 'stepped up' } }] },
      { text: 'ok' },
    ]
    const turn = start(fresh, 'note')
    await decide(fresh, (await pendingConfirmation(id)).id, 'approve')
    await until(() => ph.callsOf('sendConfirmRequest').length > confirms)
    await ph.confirm(ana.connectionId, true)
    await turn
    expect(crm.calls.at(-1)).toMatchObject({ name: 'create-note', args: { note: 'stepped up' } })
    const [record] = await running.agent.store.toolCalls.list({ conversationId: id, limit: 1 })
    expect(record).toMatchObject({ outcome: 'completed', stepUp: { type: 'device', outcome: 'completed' } })
    note.stepUp = undefined
  })
})

describe('approvals of the whole agent (TOOL-CAT-009, INTX-APPR-005)', () => {
  it('asks the roles of approvals.approvers for a delete of the whole agent, and lets a manager run it himself', async () => {
    const guest = await device('gus', ['guest'])
    model.script = [{ calls: [{ name: 'purge', arguments: {} }] }, { text: 'ok' }]
    await run(guest, 'purge')
    expect(toolAnswers().at(-1)).toBe(
      `Purge needs the approval of manager. The request is pending: the action runs once approved, and its outcome will be told in this conversation.\n\n${ONE_CALL}`
    )
    const pending = (await running.agent.store.approvals.list({ status: 'PENDING' })).find(
      (r) => r.toolName === 'purge'
    )
    expect(pending).toMatchObject({
      eligibleRoles: ['manager'],
      action: { title: 'Purge', account: { kind: 'agent' } },
    })
    const manager = await device('max', ['employee', 'manager'])
    const before = x.requests.length
    model.script = [{ calls: [{ name: 'purge', arguments: {} }] }, { text: 'ok' }]
    await run(manager, 'purge')
    expect(x.requests.length).toBe(before + 1)
  })
})

describe("a space's account in named fields (D102, TOOL-SPACE-005, TOOL-ACCESS-004..006, PROF-TOOL-001/004)", () => {
  // the four keys of an X account
  const keys = {
    api_key: 'xKey000000001',
    api_secret: 'xSecret00000000000000000001',
    access_token: '987654-xAccess0000000001',
    access_token_secret: 'xTokenSecret000000000000001',
  }
  const joined = `${keys.api_key}:${keys.api_secret}:${keys.access_token}:${keys.access_token_secret}`
  /** what the owner sent and the agent refused: kept nowhere, logged nowhere */
  const refusedValues = ['xKey00 0000001', '987654xAccess0000000001', 'xSecret0000']
  let desk: { id: string }
  let url: string
  const xTool = async () =>
    (await call(jonas, 'GET', `/spaces/${desk.id}/tools`)).body.tools.find(
      (t: { source: string }) => t.source === 'x_mentions'
    )

  it('shows the owner the fields of the account in the order of the agent-pack, and no value (PROF-TOOL-001)', async () => {
    desk = (await call(jonas, 'POST', '/spaces', { templateId: 'comms', title: 'X desk', purpose: 'Mentions' })).body
    await confirmed(jonas, () => call(jonas, 'POST', `/spaces/${desk.id}/tools`, { source: 'x_mentions' }))
    url = `/spaces/${desk.id}/tools/x_mentions/account`
    const tool = await xTool()
    expect(tool).toMatchObject({ state: 'setup', account: { kind: 'space', set: false, setAt: null, setBy: null } })
    expect(tool.account.fields).toEqual(X_ACCOUNT_FIELDS)
    expect(Object.keys(tool.account)).not.toContain('label')
    expect(Object.keys(tool.account)).not.toContain('pattern')
  })

  it('answers 400 at the field for a field missing or a name the account does not declare, and for the former body', async () => {
    const { api_secret: _left, ...three } = keys
    expect(await call(jonas, 'PUT', url, { values: three })).toMatchObject({
      status: 400,
      body: { error: 'bad-request', field: 'account.api_secret' },
    })
    expect(await call(jonas, 'PUT', url, { values: { ...keys, api_kye: 'xKey000000002' } })).toMatchObject({
      status: 400,
      body: { error: 'bad-request', field: 'account.api_kye' },
    })
    // the single token of the former form
    expect(await call(jonas, 'PUT', url, { token: joined })).toMatchObject({
      status: 400,
      body: { error: 'bad-request', field: 'values' },
    })
    expect(await call(jonas, 'PUT', url, { values: [joined] })).toMatchObject({
      status: 400,
      body: { field: 'values' },
    })
  })

  it('answers 422 bad-token at the field for a value off its pattern, or with a line break, a space or a control character inside', async () => {
    const refusedAt = async (values: Record<string, unknown>) => {
      const answer = await call(jonas, 'PUT', url, { values })
      expect(answer).toMatchObject({ status: 422, body: { error: 'bad-token' } })
      for (const value of [...Object.values(keys), ...refusedValues])
        expect(JSON.stringify(answer.body)).not.toContain(value)
      return answer.body.field
    }
    // the access token without its dash
    expect(await refusedAt({ ...keys, access_token: '987654xAccess0000000001' })).toBe('account.access_token')
    // a line break or a space inside, whatever the pattern
    expect(await refusedAt({ ...keys, api_secret: 'xSecret0000\r\n0000000000000001' })).toBe('account.api_secret')
    expect(await refusedAt({ ...keys, api_secret: 'xSecret0000\n0000000000000001' })).toBe('account.api_secret')
    expect(await refusedAt({ ...keys, api_key: 'xKey00 0000001' })).toBe('account.api_key')
    expect(await refusedAt({ ...keys, access_token_secret: 'xTokenSecret\u00070000000000001' })).toBe(
      'account.access_token_secret'
    )
    // empty once trimmed, too long, not a text
    expect(await refusedAt({ ...keys, api_key: ' \n ' })).toBe('account.api_key')
    expect(await refusedAt({ ...keys, api_key: 'A'.repeat(4097) })).toBe('account.api_key')
    expect(await refusedAt({ ...keys, api_key: 7 })).toBe('account.api_key')
    // the first refused, in the agent-pack's order
    expect(await refusedAt({ ...keys, access_token_secret: 'short', api_key: 'short' })).toBe('account.api_key')
    // nothing of them is kept, and nothing waits for the phone
    expect(await running.agent.store.spaceAccounts.get(desk.id, 'x_mentions')).toBeUndefined()
    expect((await xTool()).pending).toBeNull()
    for (const value of refusedValues)
      expect(JSON.stringify(await running.agent.store.spaceTools.listAll())).not.toContain(value)
  })

  it('takes each value trimmed of what a paste adds, and waits for the phone as before (TOOL-SPACE-005/008)', async () => {
    const asked = ph.callsOf('sendConfirmRequest').length
    // a space before the key, a line break after the access token
    const set = await call(jonas, 'PUT', url, {
      values: { ...keys, api_key: ` ${keys.api_key}`, access_token: `${keys.access_token}\n` },
    })
    expect(set.status).toBe(202)
    // the confirmation on the device is the one of a single token: a code, the words of the change, no value
    expect(set.body.tool.pending).toMatchObject({
      summary: 'Set the account of X mentions in X desk',
      code: expect.stringMatching(/^\d\d \d\d$/),
    })
    expect(set.body.tool.account.set).toBe(false)
    await until(() => ph.callsOf('sendConfirmRequest').length > asked)
    const request = JSON.stringify(ph.callsOf('sendConfirmRequest').at(-1)?.args)
    expect(request).toContain('Set the account of X mentions in X desk')
    expect(request).toContain(set.body.tool.pending.code)
    for (const value of [...Object.values(keys), joined]) {
      expect(JSON.stringify(set.body)).not.toContain(value)
      expect(request).not.toContain(value)
      expect(JSON.stringify(await running.agent.store.spaceTools.listAll())).not.toContain(value)
    }
    await ph.confirm(jonas.connectionId, true)
    expect(await xTool()).toMatchObject({ state: 'ready', account: { set: true, setBy: { name: 'jonas' } } })
    // one record: the four values sealed together, as trimmed, under one key; none in the clear
    const stored = await running.agent.store.spaceAccounts.get(desk.id, 'x_mentions')
    if (!stored) throw new Error('no account')
    for (const value of Object.values(keys)) expect(JSON.stringify(stored)).not.toContain(value)
    expect(openJson(crypto, stored.encKeyRef, Buffer.from(stored.cipher, 'base64'))).toEqual({ values: keys })
  })

  it('builds the header at the call from the four values, and scrubs an echo of the header and of each value (TOOL-ACCESS-005)', async () => {
    const jonasDesk = await open(jonas, { spaceId: desk.id })
    const before = x.requests.length
    model.script = [{ calls: [{ name: 'x_mentions', arguments: {} }] }, { text: 'ok' }]
    await run(jonasDesk, 'any mentions?')
    const sent = x.requests.slice(before).find((r) => r.url === '/echo/mentions')
    // four fields, one header, in the order its value names them
    expect(sent?.headers['x-account']).toBe(joined)
    const answer = toolAnswers().at(-1) ?? ''
    expect(answer).toContain('"x-account":"[account]"')
    expect(answer).toContain('"parts":["[account]","[account]","[account]","[account]"]')
    const stored = JSON.stringify(await entries(await conversationOf(jonasDesk.sessionId)))
    expect(stored).toContain('[account]')
    const records = JSON.stringify(await running.agent.store.toolCalls.list({ limit: 1000 }))
    for (const value of [...Object.values(keys), joined]) {
      expect(answer).not.toContain(value)
      expect(stored).not.toContain(value)
      expect(JSON.stringify(model.requests)).not.toContain(value)
      expect(records).not.toContain(value)
    }
  })

  it('drops at start an account sealed in the former form, one token: its owner sets it again (D102)', async () => {
    // what 0.27.0 sealed for a space's account: one token
    const keyRef = crypto.newWrappedKey()
    await running.agent.store.spaceAccounts.save({
      spaceId: desk.id,
      sourceId: 'x_mentions',
      cipher: sealJson(crypto, keyRef, { token: joined }).cipher.toString('base64'),
      encKeyRef: keyRef,
      setAt: new Date().toISOString(),
      setByPrincipalId: jonas.principal.id,
    })
    // until the next start, the call runs with no account rather than with a header of nothing
    const jonasDesk = await open(jonas, { spaceId: desk.id })
    const before = x.requests.length
    model.script = [{ calls: [{ name: 'x_mentions', arguments: {} }] }, { text: 'ok' }]
    await run(jonasDesk, 'mentions again')
    expect(x.requests.slice(before).some((r) => r.url === '/echo/mentions')).toBe(false)
    expect(toolAnswers().at(-1)).toContain('The account of this space is not set.')
    // what the next start does with what is stored
    await running.agent.spaceTools?.align()
    expect(await running.agent.store.spaceAccounts.get(desk.id, 'x_mentions')).toBeUndefined()
    expect(await xTool()).toMatchObject({ state: 'setup', account: { set: false } })
    expect(
      logLines.some((l) => l.includes('a space account that does not fit the fields of its source was dropped'))
    ).toBe(true)
  })

  it('leaves no value of any account in the log, at debug, over every test of this file (TOOL-ACCESS-005)', () => {
    const log = logLines.join('')
    expect(log).toContain('a change of a space tool applied')
    for (const value of [
      ...Object.values(keys),
      joined,
      ...refusedValues,
      CRM_TOKEN,
      CRM_TOKEN_2,
      CRM_TOKEN_3,
      X_TOKEN,
    ])
      expect(log).not.toContain(value)
  })
})

describe('no approver (TOOL-CAT-009)', () => {
  let second: RunningAgent
  let fakes: { crm: FakeMcp; search: FakeMcp; x: FakeHttp }
  beforeAll(async () => {
    fakes = {
      crm: await fakeMcpServer(crmTools()),
      search: await fakeMcpServer(searchTools()),
      x: await fakeHttpTool(),
    }
    const pack = toolsPack({
      crmUrl: fakes.crm.url,
      searchUrl: fakes.search.url,
      xUrl: fakes.x.url,
      edit: (p) => {
        p.approvals = { ...p.approvals, approvers: undefined }
      },
    })
    second = await startTestAgent({ agentPackPath: pack })
  }, 30_000)
  afterAll(async () => {
    await second?.stop()
    await fakes?.crm.close()
    await fakes?.search.close()
    await fakes?.x.close()
  })

  it('refuses the calls of a tool whose rule is approval when nobody can approve it', async () => {
    const m = scripted(second)
    mintLocally(second)
    const created = (
      await second.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client: web(), locale: 'en' } })
    ).json() as { sessionId: string; sessionToken: string }
    const session = await second.agent.sessions.get(created.sessionId)
    if (!session?.binding) throw new Error('no binding')
    const { principal } = await second.agent.onPeerConnected(
      {
        connectionType: 'verifiable-user-agent',
        actorIdentity: 'did:peer:lone',
        backingIdentity: null,
        claims: { userName: 'lone' },
        userAgentVerified: false,
        identityCredentialRef: null,
      },
      'conn-lone',
      { name: 'Ayni', version: '1.0.0', platform: 'ios' }
    )
    await second.agent.sessions.markConfirmationSent(session, 'conn-lone', 'thread-lone')
    const confirm = await second.agent.sessions.findByConfirmation('conn-lone', 'thread-lone')
    if (!confirm?.binding) throw new Error('no confirmation')
    await second.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
    m.script = [{ calls: [{ name: 'purge', arguments: {} }] }, { text: 'ok' }]
    await second.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/${created.sessionId}/runs`,
      headers: { authorization: `Bearer ${created.sessionToken}` },
      payload: {
        threadId: created.sessionId,
        runId: 'r-1',
        messages: [{ id: 'u', role: 'user', content: 'purge' }],
        tools: [],
        context: [],
      },
    })
    const answers = (m.requests.at(-1)?.messages ?? []).filter((x) => x.role === 'tool').map((x) => String(x.content))
    expect(answers.at(-1)).toBe(
      `Purge needs an approval, and nobody can approve it here: it did not run.\n\n${ONE_CALL}`
    )
    const [record] = await second.agent.store.toolCalls.list({ principalId: principal.id, limit: 1 })
    expect(record?.outcome).toBe('no-approver')
    expect(fakes.x.requests).toHaveLength(0)
  })
})

describe('a source the template no longer names (TOOL-SPACE-011)', () => {
  it('leaves every space of the template at the next start, its account key destroyed', async () => {
    expect(await running.agent.store.spaceAccounts.get(salesEu.id, 'relaticle')).toBeDefined()
    const sales = running.agent.pack.spaces?.templates?.find((t) => t.id === 'sales')
    if (!sales) throw new Error('no sales template')
    sales.tools = (sales.tools ?? []).filter((t) => t.source !== 'relaticle')
    // what the next start does with the pack it reads
    await running.agent.spaceTools?.align()
    expect(await running.agent.store.spaceAccounts.get(salesEu.id, 'relaticle')).toBeUndefined()
    expect(await running.agent.store.spaceTools.get(salesEu.id, 'relaticle')).toBeUndefined()
    expect((await running.agent.store.spaceAccounts.listAll()).some((a) => a.sourceId === 'relaticle')).toBe(false)
    // the source that stays stays
    expect(await running.agent.store.spaceTools.get(salesEu.id, 'crm_status')).toBeDefined()
  })
})
