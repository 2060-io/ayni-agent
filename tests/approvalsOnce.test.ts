/**
 * Approvals reach each person once, and only a call asks (ayni-spec D114, found on devnet on 2026-11-21 with the Dev
 * Agent 0.29.0): INTX-APPR-006, 008, 010, 011, 013, 015 to 019; TOOL-CALL-009, 010, 015, 016; LLM-CACHE-004; PROF-TOOL-009,
 * 024 to 027; PROF-DESC-011; PROF-LINK-005; FLOW-AUTH-003.
 *
 * The incident: a member asked for a post on X in a space; the approval's card was written into each of the owner's five
 * bound sessions (four conversations) and into the member's other conversation, at the request and again at the
 * decision: 13 entries, and four requests on the owner's phone. Then the model said three times that approval was
 * requested, with no tool call. Over the real agent (in-memory store, a scripted model, a fake X, a stubbed phone).
 */
import { ACTIVITY, CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { APPROVAL_RESEND_INTERVAL_MS } from '../src/core/agent.js'
import { ONE_CALL } from '../src/core/toolGate.js'
import type { ApprovalRecord, MessageEntry, Principal } from '../src/core/types.js'
import { parseSse, startTestAgent } from './helpers.js'
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
} from './toolFixtures.js'

const X_TOKEN = 'x-access-token-of-communication'

let running: RunningAgent
let crm: FakeMcp
let search: FakeMcp
let x: FakeHttp
let model: ScriptedModel
let ph: Phone

interface Device {
  sessionId: string
  sessionToken: string
  principal: Principal
  connectionId: string
}

const web = { name: 'ayni-ui', version: '3.5.0', platform: 'web', profileVersion: '3.5' }

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

/** A person with a browser bound by their phone; the phone takes flows unless `flows` is false. */
async function device(name: string, roles: string[], flows = true): Promise<Device> {
  const created = (
    await running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client: web, locale: 'en' } })
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
    { name: 'Ayni', version: '1.0.0', platform: 'android' }
  )
  if (flows) await ph.flowCapable(connectionId)
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
async function open(d: Device, options: { spaceId?: string; conversationId?: string }): Promise<Device> {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: {
      client: web,
      locale: 'en',
      ...(options.conversationId
        ? { conversationId: options.conversationId }
        : { newConversation: true, ...(options.spaceId ? { spaceId: options.spaceId } : {}) }),
    },
  })
  if (response.statusCode !== 201) throw new Error(`session ${response.statusCode}: ${response.body}`)
  return {
    ...(response.json() as { sessionId: string; sessionToken: string }),
    principal: d.principal,
    connectionId: d.connectionId,
  }
}

/** Another device of the person (a second browser, bound by their phone) on a conversation they have. */
async function otherDevice(d: Device, conversationId: string): Promise<Device> {
  const created = (
    await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      payload: { client: web, locale: 'en', conversationId },
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
  return { status: response.statusCode, body: response.body ? (response.json() as Doc) : undefined }
}

async function run(d: Pick<Device, 'sessionId' | 'sessionToken'>, text: string, ayni?: Record<string, unknown>) {
  const response = await running.app.inject({
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
  return {
    status: response.statusCode,
    events: response.statusCode === 200 ? parseSse(response.body).map((e) => e.event) : [],
  }
}

const decide = (d: Device, approvalId: string, decision: 'approve' | 'reject') =>
  run(d, '', { kind: 'approval.decide', approvalId, decision })

/** What a session's stream has received so far. */
const received = (sessionId: string) => {
  const chunks: string[] = []
  running.streams.attach(sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
  return parseSse(chunks.join('')).map((e) => e.event)
}

const approvalActivities = (events: Record<string, unknown>[], approvalId?: string) =>
  events.filter(
    (e) =>
      e.type === 'ACTIVITY_SNAPSHOT' &&
      e.activityType === ACTIVITY.approval &&
      (!approvalId || (e.content as Doc).approvalId === approvalId)
  )

async function conversationOf(sessionId: string): Promise<string> {
  return (await running.agent.sessions.get(sessionId))?.conversationId as string
}

async function entries(conversationId: string): Promise<MessageEntry[]> {
  const rows = await running.agent.store.entries.listAll({ conversationId, limit: 1000 })
  return rows.map((r) => running.agent.memory.open(r))
}

/** The entries of an approval in a conversation: its card, and the records of what became of it. */
async function approvalEntries(conversationId: string, approvalId?: string): Promise<MessageEntry[]> {
  return (await entries(conversationId)).filter(
    (e) =>
      (e.sourceType === 'approval' || e.sourceType === 'refusal') &&
      (!approvalId || e.payload?.approvalId === approvalId)
  )
}

const toolAnswers = () =>
  (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))

async function pendingOf(filter: (r: ApprovalRecord) => boolean): Promise<ApprovalRecord> {
  let found: ApprovalRecord | undefined
  await until(async () => {
    found = (await running.agent.store.approvals.list({ status: 'PENDING' })).filter(filter).at(-1)
    return !!found
  })
  return found as ApprovalRecord
}

/** The owner sets a change, and his phone confirms it. */
async function confirmed(d: Device, request: () => Promise<{ status: number; body?: Doc }>) {
  const asked = ph.callsOf('sendConfirmRequest').length
  const response = await request()
  expect(response.status).toBe(202)
  await until(() => ph.callsOf('sendConfirmRequest').length > asked)
  await ph.confirm(d.connectionId, true)
}

let jonas: Device
let ana: Device
let ben: Device
let mia: Device
let max: Device
let gus: Device
let comms: { id: string }
/** Jonas's five sessions, in four conversations */
let jonasSessions: Device[]
/** Ana asks in the first; the second is open on her other device; the third is another conversation of the space */
let anaAsks: Device
let anaOther: Device
let anaSecond: Device
const post = 'Verana Social is live: trust, verifiable.'

beforeAll(async () => {
  crm = await fakeMcpServer(crmTools())
  search = await fakeMcpServer(searchTools())
  x = await fakeHttpTool()
  const pack = toolsPack({
    crmUrl: crm.url,
    searchUrl: search.url,
    xUrl: x.url,
    edit: (p) => {
      // a tool reached only through an elevation, decided by a manager (D14)
      p.tools.features.payments = { title: 'Payments' }
      p.tools.sources.wire = {
        type: 'http',
        feature: 'payments',
        title: 'Wire money',
        description: 'Wires money.',
        method: 'POST',
        url: `${x.url}/wire`,
        parameters: { type: 'object', properties: { amount: { type: 'number' } } },
        access: {
          roles: { support: ['*'] },
          elevation: [{ tools: ['wire'], purposes: ['support-case'], approvers: ['manager'], grantTtlMinutes: 60 }],
        },
      }
    },
  })
  running = await startTestAgent({ agentPackPath: pack })
  mintLocally(running)
  ph = phone(running)
  model = scripted(running)
  jonas = await device('jonas', ['employee', 'comms'])
  ana = await device('ana', ['employee', 'comms'])
  ben = await device('ben', ['employee', 'comms'])
  mia = await device('mia', ['employee', 'manager'])
  // a manager whose wallet takes no flows: no request on a phone, the Notifications and the menu of the wallet only
  max = await device('max', ['employee', 'manager'], false)
  gus = await device('gus', ['guest'])
  comms = (await call(jonas, 'POST', '/spaces', { templateId: 'comms', title: 'Verana Social', purpose: 'Posts' }))
    .body as { id: string }
  const now = new Date().toISOString()
  for (const member of [ana, ben])
    await running.agent.store.spaceMembers.save({
      id: `mem_${comms.id}_${member.principal.id}`,
      spaceId: comms.id,
      principalId: member.principal.id,
      state: 'active',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    })
  await confirmed(jonas, () =>
    call(jonas, 'POST', `/spaces/${comms.id}/tools`, { source: 'post_to_x', bindings: { handle: '@verana' } })
  )
  await confirmed(jonas, () =>
    call(jonas, 'PUT', `/spaces/${comms.id}/tools/post_to_x/account`, { values: { token: X_TOKEN } })
  )
  // Jonas: five bound sessions in four conversations, none of them Ana's (as on devnet)
  const personal2 = await open(jonas, {})
  const space1 = await open(jonas, { spaceId: comms.id })
  const space2 = await open(jonas, { spaceId: comms.id })
  const space2b = await otherDevice(jonas, await conversationOf(space2.sessionId))
  jonasSessions = [jonas, personal2, space1, space2, space2b]
  // Ana: the conversation she asks in, open on two devices, and another conversation of the space
  anaAsks = await open(ana, { spaceId: comms.id })
  anaOther = await otherDevice(ana, await conversationOf(anaAsks.sessionId))
  anaSecond = await open(ana, { spaceId: comms.id })
}, 30_000)

afterAll(async () => {
  await running?.stop()
  await crm?.close()
  await search?.close()
  await x?.close()
})

describe('the devnet incident of 2026-11-21: one post, one request (INTX-APPR-006, INTX-APPR-016)', () => {
  let approval: ApprovalRecord
  let conversations: { jonas: string[]; anaAsks: string; anaSecond: string }
  const streamsBefore = new Map<string, number>()

  it('gives the owner, with five sessions open in four conversations, one request on his phone and one item in the space Notifications, and no card anywhere', async () => {
    conversations = {
      jonas: [...new Set(await Promise.all(jonasSessions.map((s) => conversationOf(s.sessionId))))],
      anaAsks: await conversationOf(anaAsks.sessionId),
      anaSecond: await conversationOf(anaSecond.sessionId),
    }
    expect(conversations.jonas).toHaveLength(4)
    for (const s of [...jonasSessions, anaAsks, anaOther, anaSecond])
      streamsBefore.set(s.sessionId, received(s.sessionId).length)
    const phoneBefore = ph.authorizeRequests(jonas.connectionId).length
    model.script = [{ calls: [{ name: 'post_to_x', arguments: { text: post } }] }, { text: 'I asked Jonas.' }]
    const asked = await run(anaAsks, 'post it on X')
    approval = await pendingOf((r) => r.spaceId === comms.id)
    expect(approval).toMatchObject({
      spacePolicy: { approvers: [{ kind: 'owner', required: true }], threshold: 1, attested: true },
      approverIds: [jonas.principal.id],
    })
    expect(approval.cardEntryIds).toBeUndefined()
    // one request on his phone, attested, linked to the space's Notifications, naming no conversation (FLOW-AUTH-003)
    const requests = ph.authorizeRequests(jonas.connectionId).slice(phoneBefore)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.request).toMatchObject({ attested: true, purpose: { id: 'tool-call', label: 'Post on X' } })
    const open = ph.callsOf('openFlow').find((c) => (c.result as Doc).flowId === requests[0]?.flowId)?.args[0] as Doc
    expect(open).toMatchObject({
      kind: 'authorize',
      origin: { channel: 'none' },
      link: `https://app.ayni.org/app/service/${running.agent.did}/spaces/${comms.id}/notifications?approval=${approval.id}`,
    })
    // no card, no entry, in any of his conversations, and none on any of his sessions (INTX-APPR-006)
    for (const id of conversations.jonas) expect(await approvalEntries(id)).toHaveLength(0)
    for (const s of jonasSessions) {
      const events = received(s.sessionId).slice(streamsBefore.get(s.sessionId))
      expect(approvalActivities(events)).toHaveLength(0)
      expect(events.some((e) => e.type === 'CUSTOM' && e.name === 'ayni.approval.request')).toBe(false)
      // every session of his hears that the space's Notifications changed, once, whichever conversation it serves
      const changed = events.filter((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.spaceNotificationsChanged)
      expect(changed.map((e) => e.value)).toEqual([
        { spaceId: comms.id, id: approval.id, kind: 'approval', waiting: true, count: 1 },
      ])
    }
    // one item in the space's Notifications, and the badge of the space's row (PROF-TOOL-024, PROF-TOOL-025)
    const listed = (await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
    expect(listed.waiting).toBe(1)
    expect(listed.notifications).toHaveLength(1)
    expect(listed.notifications[0]).toMatchObject({ id: approval.id, waiting: true, approval: { canDecide: true } })
    const spaces = (await call(jonas, 'GET', '/spaces')).body?.spaces as Doc[]
    expect(spaces.find((s) => s.id === comms.id)?.notificationsWaiting).toBe(1)
    expect(spaces.find((s) => s.kind === 'personal')?.notificationsWaiting).toBe(0)
    expect((await call(jonas, 'GET', '/notifications')).body).toMatchObject({ notifications: [], waiting: 0 })
    // the mark of what waits for him, the same on every session; no Approvals item in an AG-UI menu (PROF-TOOL-025)
    for (const s of jonasSessions) {
      const state = await running.agent.ayniState((await running.agent.sessions.get(s.sessionId)) as never)
      expect(state.pendingApprovals).toBe(1)
      expect(state.contextualMenu.items.map((i) => i.id)).not.toContain('ayni.approvals')
    }
    // Ana: one card, in the conversation where she asked, on both devices; her other conversation has none
    expect(approvalActivities(asked.events, approval.id)).toHaveLength(1)
    expect(approvalActivities(asked.events, approval.id)[0]?.content).toMatchObject({ own: true, canDecide: false })
    await until(
      () =>
        approvalActivities(received(anaOther.sessionId).slice(streamsBefore.get(anaOther.sessionId)), approval.id)
          .length === 1
    )
    const cards = await approvalEntries(conversations.anaAsks, approval.id)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.id).toBe(approval.entryId)
    expect(await approvalEntries(conversations.anaSecond)).toHaveLength(0)
    expect(
      approvalActivities(received(anaSecond.sessionId).slice(streamsBefore.get(anaSecond.sessionId)))
    ).toHaveLength(0)
  })

  it('lets the owner decide on his phone only: the request closes, his item reads decided, and the one card turns to Approved in place', async () => {
    const before = new Map([anaAsks, anaOther, anaSecond].map((s) => [s.sessionId, received(s.sessionId).length]))
    await ph.authorize(jonas.connectionId, 'approved', { approvalId: approval.id })
    await until(() => x.requests.some((r) => r.url === '/2/tweets'))
    await until(async () =>
      (await entries(conversations.anaAsks)).some((e) => e.text === 'The approved action Post on X ran.')
    )
    // the request on his phone closed; the item of his Notifications reads decided, with nothing waiting
    const flowId = ph.authorizeRequests(jonas.connectionId).at(-1)?.flowId
    expect(ph.callsOf('closeFlow').filter((c) => c.args[0] === flowId)).toHaveLength(1)
    const listed = (await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
    expect(listed).toMatchObject({ waiting: 0 })
    expect(listed.notifications[0]).toMatchObject({
      waiting: false,
      approval: { status: 'APPROVED', decisions: [{ by: { displayName: 'jonas' }, decision: 'approve' }] },
    })
    expect(listed.notifications[0].approval.closedAt).toBeDefined()
    // still no entry in any conversation of his; one card in Ana's, never a second
    for (const id of conversations.jonas) expect(await approvalEntries(id)).toHaveLength(0)
    expect(await approvalEntries(conversations.anaSecond)).toHaveLength(0)
    for (const s of [anaAsks, anaOther]) {
      await until(() =>
        approvalActivities(received(s.sessionId).slice(before.get(s.sessionId)), approval.id).some(
          (e) => (e.content as Doc).status === 'APPROVED'
        )
      )
      const events = received(s.sessionId).slice(before.get(s.sessionId))
      // replaced in place, under the card's message id, with its update
      expect(approvalActivities(events, approval.id).every((e) => e.messageId === approval.entryId)).toBe(true)
      expect(
        events.some(
          (e) =>
            e.type === 'CUSTOM' &&
            e.name === CUSTOM_EVENT.approvalUpdate &&
            (e.value as Doc).approvalId === approval.id &&
            (e.value as Doc).status === 'APPROVED'
        )
      ).toBe(true)
    }
    expect(approvalActivities(received(anaSecond.sessionId).slice(before.get(anaSecond.sessionId)))).toHaveLength(0)
    const history = (await call(anaAsks, 'GET', `/${anaAsks.sessionId}/messages?limit=200`)).body?.messages as Doc[]
    const shown = history.filter((m) => m.activityType === ACTIVITY.approval && m.content.approvalId === approval.id)
    expect(shown).toHaveLength(1)
    expect(shown[0]?.content).toMatchObject({ status: 'APPROVED', decidedBy: 'jonas', own: true })
    // what the model reads of the card stays as written; what became of it is a record of its own (LLM-CACHE-004)
    const recorded = await approvalEntries(conversations.anaAsks, approval.id)
    expect(recorded.map((e) => e.text)).toEqual([
      `The call of Post on X (${approval.id}) asked for the approval of the owner of the space, jonas, shown to the person on a card`,
      `jonas approved Post on X (${approval.id}): the action runs now. ${ONE_CALL}`,
    ])
    expect(recorded[1]?.payload).toMatchObject({ kind: 'card-state', entryId: approval.entryId, status: 'APPROVED' })
    expect(history.some((m) => String(m.content).includes('jonas approved'))).toBe(false)
    const stored = await running.agent.store.approvals.get(approval.id)
    expect(stored?.decisions[0]?.attestation?.method).toBe('biometric')
    expect(stored?.cardEntryIds).toBeUndefined()
  })

  it('tells the model, in the next request, that the post ran for that call only (TOOL-CALL-015)', async () => {
    model.script = [{ text: 'Glad it is out.' }]
    await run(anaAsks, 'thanks')
    const messages = model.requests.at(-1)?.messages ?? []
    const result = messages.find((m) => m.role === 'tool' && String(m.content).includes('post-'))
    expect(String(result?.content)).toMatch(new RegExp(`\\n\\n${ONE_CALL.replace(/[.,]/g, '\\$&')}$`))
    expect(messages.some((m) => m.role === 'user' && String(m.content).includes(`jonas approved Post on X`))).toBe(true)
  })

  it('asks again, with a new call, for the next post: the answer of a pending call says it is for that call only', async () => {
    model.script = [{ calls: [{ name: 'post_to_x', arguments: { text: 'A second post.' } }] }, { text: 'Asked again.' }]
    await run(anaAsks, 'and post: A second post.')
    expect(toolAnswers().at(-1)).toBe(
      `Post on X needs the approval of the owner of the space, jonas. The request is pending: the action runs once approved, and its outcome will be told in this conversation.\n\n${ONE_CALL}`
    )
    const second = await pendingOf((r) => r.spaceId === comms.id)
    expect(second.id).not.toBe(approval.id)
    // refused on the phone: the record of the refusal says the same (TOOL-CALL-015)
    await ph.authorize(jonas.connectionId, 'rejected', { approvalId: second.id })
    await until(async () => (await approvalEntries(conversations.anaAsks, second.id)).length === 2)
    const [, refused] = await approvalEntries(conversations.anaAsks, second.id)
    expect(refused).toMatchObject({ sourceType: 'refusal', payload: { kind: 'card-state', status: 'REJECTED' } })
    expect(refused?.text).toBe(
      `jonas rejected Post on X (${second.id}): it did not run. Do not try it again unless the person asks for it. ${ONE_CALL}`
    )
    expect((await running.agent.store.toolCalls.get(second.callId as string))?.outcome).toBe('not-approved')
    // expired: the same (INTX-APPR-007)
    model.script = [{ calls: [{ name: 'post_to_x', arguments: { text: 'A third post.' } }] }, { text: 'Asked.' }]
    await run(anaAsks, 'post: A third post.')
    const third = await pendingOf((r) => r.spaceId === comms.id)
    const flowId = ph.authorizeRequests(jonas.connectionId).at(-1)?.flowId
    await running.agent.store.approvals.save({ ...third, expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(await running.agent.approvals.expirePending()).toBe(1)
    await until(async () => (await approvalEntries(conversations.anaAsks, third.id)).length === 2)
    expect((await approvalEntries(conversations.anaAsks, third.id))[1]?.text).toBe(
      `Nobody decided Post on X (${third.id}) in time: it did not run. ${ONE_CALL}`
    )
    expect((await running.agent.store.toolCalls.get(third.callId as string))?.outcome).toBe('expired')
    expect(ph.callsOf('closeFlow').some((c) => c.args[0] === flowId)).toBe(true)
    // no conversation of Jonas holds any of them
    for (const id of conversations.jonas) expect(await approvalEntries(id)).toHaveLength(0)
  })

  it('shows nothing waiting when the model says it asked without a call (TOOL-CALL-016, PROF-TOOL-027)', async () => {
    const approvals = (await running.agent.store.approvals.list({})).length
    const calls = (await running.agent.store.toolCalls.list({ conversationId: conversations.anaAsks, limit: 100 }))
      .length
    const phoneBefore = ph.callsOf('sendAuthorizeRequest').length
    const jonasBefore = received(jonas.sessionId).length
    model.script = [{ text: 'I asked Jonas for approval: your post waits for him.' }]
    const claimed = await run(anaAsks, 'post: A fourth post.')
    expect(claimed.events.some((e) => e.type === 'ACTIVITY_SNAPSHOT')).toBe(false)
    expect(claimed.events.some((e) => e.type === 'STEP_STARTED')).toBe(false)
    expect(claimed.events.some((e) => e.type === 'CUSTOM' && String(e.name).startsWith('ayni.approval'))).toBe(false)
    expect((await running.agent.store.approvals.list({})).length).toBe(approvals)
    expect(
      (await running.agent.store.toolCalls.list({ conversationId: conversations.anaAsks, limit: 100 })).length
    ).toBe(calls)
    expect(ph.callsOf('sendAuthorizeRequest').length).toBe(phoneBefore)
    const toJonas = received(jonas.sessionId).slice(jonasBefore)
    expect(toJonas.some((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.spaceNotificationsChanged)).toBe(false)
    const state = await running.agent.ayniState((await running.agent.sessions.get(anaAsks.sessionId)) as never)
    expect(state.pendingApprovals).toBe(0)
    expect(((await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc).waiting).toBe(0)
    // the transcript shows the reply and no card
    const history = (await call(anaAsks, 'GET', `/${anaAsks.sessionId}/messages?limit=200`)).body?.messages as Doc[]
    expect(history.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'I asked Jonas for approval: your post waits for him.',
    })
    expect(history.at(-2)).toMatchObject({ role: 'user' })
  })

  it("lists Ana's requests to her as Sent by you, read-only, and nothing to another member; 404 outside the space (INTX-APPR-017)", async () => {
    const mine = (await call(ana, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
    expect(mine.waiting).toBe(0)
    expect(mine.notifications.map((n: Doc) => n.approval.status)).toEqual(['EXPIRED', 'REJECTED', 'APPROVED'])
    expect(mine.notifications[2]).toMatchObject({
      id: approval.id,
      waiting: false,
      approval: { own: true, canDecide: false, requester: { displayName: 'ana' } },
    })
    // the page: newest first, paged by `before`
    const first = (await call(ana, 'GET', `/spaces/${comms.id}/notifications?limit=2`)).body as Doc
    expect(first.notifications).toHaveLength(2)
    const next = (await call(ana, 'GET', `/spaces/${comms.id}/notifications?limit=2&before=${first.nextBefore}`))
      .body as Doc
    expect(next).toMatchObject({ nextBefore: null })
    expect(next.notifications.map((n: Doc) => n.id)).toEqual([approval.id])
    expect((await call(ben, 'GET', `/spaces/${comms.id}/notifications`)).body).toMatchObject({
      notifications: [],
      waiting: 0,
    })
    expect((await call(mia, 'GET', `/spaces/${comms.id}/notifications`)).status).toBe(404)
    // the descriptor declares them (PROF-DESC-011)
    const descriptor = (await running.app.inject({ method: 'GET', url: '/.well-known/ayni-agent.json' })).json() as Doc
    expect(descriptor.features.notifications).toBe(true)
  })
})

describe('approvals not tied to a space: the agent Notifications (INTX-APPR-017, INTX-APPR-018, PROF-TOOL-026)', () => {
  let purge: ApprovalRecord

  it("asks every manager's phone of a delete of the whole agent, not attested, and lists it in the agent Notifications", async () => {
    const before = ph.authorizeRequests(mia.connectionId).length
    model.script = [{ calls: [{ name: 'purge', arguments: {} }] }, { text: 'Asked a manager.' }]
    await run(gus, 'purge the cache')
    purge = await pendingOf((r) => r.toolName === 'purge')
    expect(purge.approverIds?.sort()).toEqual([mia.principal.id, max.principal.id].sort())
    // Mia's phone: one request, attested as the policy sets it, linked to the agent's Notifications
    const requests = ph.authorizeRequests(mia.connectionId).slice(before)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.request.attested).toBe(false)
    const open = ph.callsOf('openFlow').find((c) => (c.result as Doc).flowId === requests[0]?.flowId)?.args[0] as Doc
    expect(open.link).toBe(`https://app.ayni.org/app/service/${running.agent.did}/notifications?approval=${purge.id}`)
    // Max's wallet takes no flows: nothing on it but the item and badge of its menu (INTX-APPR-006)
    expect(ph.authorizeRequests(max.connectionId)).toHaveLength(0)
    const maxPhone = (await running.agent.didcommSession(max.connectionId))?.session
    if (!maxPhone) throw new Error('no capability session')
    const maxMenu = (await running.agent.ayniState(maxPhone)).contextualMenu.items
    expect(maxMenu.find((i) => i.id === 'ayni.approvals')).toMatchObject({ badge: 1 })
    for (const manager of [mia, max]) {
      const listed = (await call(manager, 'GET', '/notifications')).body as Doc
      expect(listed.waiting).toBe(1)
      expect(listed.notifications[0]).toMatchObject({
        id: purge.id,
        waiting: true,
        approval: { canDecide: true, attested: false, action: { title: 'Purge', account: { kind: 'agent' } } },
      })
    }
    expect(((await call(ben, 'GET', '/notifications')).body as Doc).notifications).toHaveLength(0)
    expect(((await call(gus, 'GET', '/notifications')).body as Doc).notifications[0]).toMatchObject({
      id: purge.id,
      approval: { own: true, canDecide: false },
    })
  })

  it('sends it again to the phone once for ten Decide on your phone in a row, closing the one the phone held (PROF-TOOL-026)', async () => {
    // found by Fabrice on devnet, 2026-11-22: ten resends in 22 seconds opened ten flows and closed nine, and his
    // phone, away from its mediator, took the thirty messages at once
    const sent = () => ph.authorizeRequests(mia.connectionId)
    const closes = () => ph.callsOf('closeFlow').map((c) => c.args[0])
    const held = sent().at(-1)?.flowId
    const [requestsBefore, closesBefore] = [sent().length, closes().length]
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => call(mia, 'POST', `/approvals/${purge.id}/resend`))
    )
    for (const answer of answers) expect(answer).toMatchObject({ status: 202, body: { expiresAt: purge.expiresAt } })
    expect(sent()).toHaveLength(requestsBefore + 1)
    expect(closes().slice(closesBefore)).toEqual([held])
    // and again a moment later: nothing new within 30 seconds
    expect(await call(mia, 'POST', `/approvals/${purge.id}/resend`)).toMatchObject({ status: 202 })
    expect(sent()).toHaveLength(requestsBefore + 1)
    // 30 seconds later it goes again, closing the request sent last
    const resent = (running.agent as unknown as { resentAt: Map<string, number> }).resentAt
    resent.set(`${purge.id}:${mia.principal.id}`, Date.now() - APPROVAL_RESEND_INTERVAL_MS)
    const last = sent().at(-1)?.flowId
    expect(await call(mia, 'POST', `/approvals/${purge.id}/resend`)).toMatchObject({ status: 202 })
    expect(sent()).toHaveLength(requestsBefore + 2)
    expect(closes().slice(closesBefore)).toEqual([held, last])
  })

  it('lets a manager decide it in the browser: no turn, nothing added to his conversation, his phone request closed', async () => {
    // Decide on your phone is refused to a wallet that takes no flows
    expect(await call(max, 'POST', `/approvals/${purge.id}/resend`)).toMatchObject({
      status: 409,
      body: { error: 'confirmation-unavailable' },
    })
    expect((await call(ben, 'POST', `/approvals/${purge.id}/resend`)).status).toBe(404)
    expect((await decide(ben, purge.id, 'approve')).events.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      code: 'not-eligible',
    })
    const miaConversation = await conversationOf(mia.sessionId)
    const miaEntries = (await entries(miaConversation)).length
    const decided = await decide(mia, purge.id, 'approve')
    expect(decided.events[0]).toMatchObject({ type: 'RUN_STARTED', noTurn: 'decision' })
    expect(decided.events.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      outcome: { type: 'decision', approvalId: purge.id, status: 'APPROVED' },
    })
    expect(decided.events.some((e) => e.type === 'TEXT_MESSAGE_START')).toBe(false)
    expect((await entries(miaConversation)).length).toBe(miaEntries)
    await until(() => x.requests.some((r) => r.url === '/purge'))
    // her phone request closed; Approve sent twice answers the status already decided
    const flowId = ph.authorizeRequests(mia.connectionId).at(-1)?.flowId
    expect(ph.callsOf('closeFlow').some((c) => c.args[0] === flowId)).toBe(true)
    expect((await decide(mia, purge.id, 'reject')).events.at(-1)).toMatchObject({
      outcome: { type: 'decision', status: 'APPROVED' },
    })
    expect(await call(mia, 'POST', `/approvals/${purge.id}/resend`)).toMatchObject({
      status: 409,
      body: { error: 'not-pending' },
    })
    // the requester's card turned to Approved, in his conversation
    const gusConversation = await conversationOf(gus.sessionId)
    const [card, state] = await approvalEntries(gusConversation, purge.id)
    expect(card?.payload?.card).toMatchObject({ status: 'APPROVED', decidedBy: 'mia' })
    expect(state?.text).toBe(`mia approved Purge (${purge.id}): the action runs now. ${ONE_CALL}`)
  })

  it('lets the requester withdraw a request from its card: no turn, the phones closed, Withdrawn in the lists (INTX-APPR-010)', async () => {
    model.script = [{ calls: [{ name: 'purge', arguments: {} }] }, { text: 'Asked again.' }]
    await run(gus, 'purge again')
    const again = await pendingOf((r) => r.toolName === 'purge')
    const flowId = ph.authorizeRequests(mia.connectionId).at(-1)?.flowId
    expect((await run(mia, '', { kind: 'approval.cancel', approvalId: again.id })).events.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      code: 'not-eligible',
    })
    const withdrawn = await run(gus, '', { kind: 'approval.cancel', approvalId: again.id })
    expect(withdrawn.events[0]).toMatchObject({ type: 'RUN_STARTED', noTurn: 'decision' })
    expect(withdrawn.events.at(-1)).toMatchObject({ outcome: { type: 'decision', status: 'CANCELLED' } })
    expect(ph.callsOf('closeFlow').some((c) => c.args[0] === flowId)).toBe(true)
    const item = ((await call(mia, 'GET', '/notifications')).body as Doc).notifications.find(
      (n: Doc) => n.id === again.id
    )
    expect(item).toMatchObject({ waiting: false, approval: { status: 'CANCELLED' } })
    expect((await approvalEntries(await conversationOf(gus.sessionId), again.id))[1]?.text).toBe(
      `The request for Purge (${again.id}) was withdrawn: it did not run. ${ONE_CALL}`
    )
  })

  it("routes an elevation request to the managers' phones and lists it with its purpose and justification", async () => {
    const before = ph.authorizeRequests(mia.connectionId).length
    const requested = await run(gus, '', {
      kind: 'elevation.request',
      tool: 'wire',
      purposeId: 'support-case',
      justification: 'Case 42 needs a refund.',
    })
    const elevation = await pendingOf((r) => r.kind === 'elevation')
    // the requester's card, in the run of the request
    expect(approvalActivities(requested.events, elevation.id)[0]?.content).toMatchObject({
      kind: 'elevation',
      own: true,
      purpose: { id: 'support-case', label: 'Support case handling' },
      justification: 'Case 42 needs a refund.',
    })
    const sent = ph.authorizeRequests(mia.connectionId).slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.request).toMatchObject({
      purpose: { id: 'support-case', label: 'Support case handling' },
      justification: 'Case 42 needs a refund.',
      attested: false,
    })
    const listed = ((await call(mia, 'GET', '/notifications')).body as Doc).notifications[0]
    expect(listed).toMatchObject({
      id: elevation.id,
      approval: {
        kind: 'elevation',
        purpose: { id: 'support-case', label: 'Support case handling' },
        justification: 'Case 42 needs a refund.',
      },
    })
    await ph.authorize(mia.connectionId, 'approved', { approvalId: elevation.id })
    await until(async () => (await running.agent.store.approvals.get(elevation.id))?.status === 'APPROVED')
    expect(await running.agent.approvals.activeGrants(gus.principal.id)).toHaveLength(1)
    const [card] = await approvalEntries(await conversationOf(gus.sessionId), elevation.id)
    expect(card?.payload?.card).toMatchObject({ status: 'APPROVED', kind: 'elevation' })
  })
})

describe('an approval to attest that no phone can decide (INTX-APPR-019, INTX-APPR-024)', () => {
  it('runs nothing, ends its card refused for want of an approver and tells the model no-approver when the owner has no phone that takes flows', async () => {
    const owner = (await running.agent.principals.get(jonas.principal.id)) as Principal
    const channel = owner.capabilityChannelId
    await running.agent.principals.save({ ...owner, capabilityChannelId: null })
    const approvals = (await running.agent.store.approvals.list({})).length
    model.script = [{ calls: [{ name: 'post_to_x', arguments: { text: 'No phone.' } }] }, { text: 'Sorry.' }]
    await run(anaSecond, 'post: No phone.')
    await running.agent.principals.save({ ...owner, capabilityChannelId: channel })
    expect(toolAnswers().at(-1)).toBe(
      `Post on X needs the approval of the owner of the space, jonas, and no other approver can decide it now: nothing was asked and it did not run.\n\n${ONE_CALL}`
    )
    // recorded refused at once, asked of nobody, its card ended so in the requester's conversation (INTX-APPR-024)
    const all = await running.agent.store.approvals.list({})
    expect(all.length).toBe(approvals + 1)
    const refused = all.find((r) => r.reason === 'no-approver') as ApprovalRecord
    expect(refused).toMatchObject({ status: 'REJECTED', approverIds: [] })
    const card = (await approvalEntries(await conversationOf(anaSecond.sessionId), refused.id))[0]
    expect(card?.payload?.card).toMatchObject({ status: 'REJECTED', reason: 'no-approver', own: true })
    const [record] = await running.agent.store.toolCalls.list({
      conversationId: await conversationOf(anaSecond.sessionId),
      limit: 1,
    })
    expect(record?.outcome).toBe('no-approver')
  })
})
