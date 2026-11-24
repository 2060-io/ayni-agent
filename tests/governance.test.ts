/**
 * Space governance and approval policies per tool, over the real agent (in-memory store, a scripted model, a fake X, a
 * stubbed phone): ayni-spec D135 to D142. SPACE-DEF-008, SPACE-MEMB-009, SPACE-MEMB-012; TOOL-SPACE-018 to 021;
 * INTX-APPR-004, 005, 007, 020 to 027; PROF-TOOL-036 to 038.
 *
 * Communication is Jonas's; Ana, Ben and Marta are members, Gus a guest; Mia, a manager of the agent-pack, is no member.
 */
import { CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { ONE_CALL } from '../src/core/toolGate.js'
import type { ApprovalRecord, Principal } from '../src/core/types.js'
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

/** A person of the home organization with a browser bound by their phone, which takes flows. */
async function device(name: string, roles: string[]): Promise<Device> {
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
  await ph.flowCapable(connectionId)
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  const updated: Principal = { ...principal, roles, backingRelation: 'home' }
  await running.agent.principals.save(updated)
  return { ...created, principal: updated, connectionId }
}

async function open(d: Device, spaceId: string): Promise<Device> {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: { client: web, locale: 'en', newConversation: true, spaceId },
  })
  if (response.statusCode !== 201) throw new Error(`session ${response.statusCode}: ${response.body}`)
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
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Doc }
}

async function run(d: Pick<Device, 'sessionId' | 'sessionToken'>, text: string) {
  const response = await running.app.inject({
    method: 'POST',
    url: `/agui/v3/sessions/${d.sessionId}/runs`,
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: {
      threadId: d.sessionId,
      runId: `run-${Date.now()}-${Math.random()}`,
      messages: [{ id: `u-${Math.random()}`, role: 'user', content: text }],
      tools: [],
      context: [],
    },
  })
  return response.statusCode === 200 ? parseSse(response.body).map((e) => e.event) : []
}

const received = (sessionId: string) => {
  const chunks: string[] = []
  running.streams.attach(sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
  return parseSse(chunks.join('')).map((e) => e.event)
}

const toolAnswers = () =>
  (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))

async function newApproval(known: Set<string>): Promise<ApprovalRecord> {
  let found: ApprovalRecord | undefined
  await until(async () => {
    found = (await running.agent.store.approvals.list({})).find((r) => !known.has(r.id) && r.kind === 'sensitivity')
    return !!found
  })
  return found as ApprovalRecord
}

const known = async () => new Set((await running.agent.store.approvals.list({})).map((r) => r.id))

/** Ana asks for a post in her conversation of Communication; the approval it made, and the events of her run. */
let lastRun: Record<string, unknown>[] = []
async function anaPosts(text: string): Promise<ApprovalRecord> {
  const before = await known()
  model.script = [{ calls: [{ name: 'post_to_x', arguments: { text } }] }, { text: 'Asked.' }]
  lastRun = await run(anaAsks, `post: ${text}`)
  return newApproval(before)
}

/** The owner sets a change, and his phone confirms it; the text the phone read. */
async function confirmed(d: Device, request: () => Promise<{ status: number; body: Doc }>): Promise<string> {
  const asked = ph.callsOf('sendConfirmRequest').length
  const response = await request()
  expect(response.status).toBe(202)
  await until(() => ph.callsOf('sendConfirmRequest').length > asked)
  const text = String((ph.callsOf('sendConfirmRequest').at(-1)?.args[0] as Doc)?.request?.text ?? '')
  await ph.confirm(d.connectionId, true)
  return text
}

const policyOf = async (d: Device) =>
  ((await call(d, 'GET', `/spaces/${comms.id}/tools`)).body.tools as Doc[])
    .find((t) => t.source === 'post_to_x')
    ?.tools.find((t: Doc) => t.title === 'Post on X')?.approval
const setPolicy = (policy: Doc) =>
  call(jonas, 'PATCH', `/spaces/${comms.id}/tools/post_to_x`, { approvals: { post_to_x: policy } })

let jonas: Device
let ana: Device
let ben: Device
let marta: Device
let mia: Device
let gus: Device
let anaAsks: Device
let comms: { id: string }
const memberId = (d: Device) => `mem_${comms.id}_${d.principal.id}`
const OWNER = { kind: 'owner', required: true }
const X_TOKEN = 'x-access-token-of-communication'

beforeAll(async () => {
  crm = await fakeMcpServer(crmTools())
  search = await fakeMcpServer(searchTools())
  x = await fakeHttpTool()
  running = await startTestAgent({
    agentPackPath: toolsPack({ crmUrl: crm.url, searchUrl: search.url, xUrl: x.url }),
  })
  mintLocally(running)
  ph = phone(running)
  model = scripted(running)
  jonas = await device('jonas', ['employee', 'comms'])
  ana = await device('ana', ['employee', 'comms'])
  ben = await device('ben', ['employee', 'comms'])
  marta = await device('marta', ['employee', 'comms'])
  mia = await device('mia', ['employee', 'manager'])
  gus = await device('gus', ['guest'])
  comms = (await call(jonas, 'POST', '/spaces', { templateId: 'comms', title: 'Communication', purpose: 'Posts' }))
    .body as { id: string }
  const now = new Date().toISOString()
  for (const [member, role] of [
    [ana, 'member'],
    [ben, 'member'],
    [marta, 'member'],
    [gus, 'guest'],
  ] as const)
    await running.agent.store.spaceMembers.save({
      id: memberId(member),
      spaceId: comms.id,
      principalId: member.principal.id,
      state: 'active',
      role,
      createdAt: now,
      updatedAt: now,
    })
  await confirmed(jonas, () =>
    call(jonas, 'POST', `/spaces/${comms.id}/tools`, { source: 'post_to_x', bindings: { handle: '@verana' } })
  )
  await confirmed(jonas, () =>
    call(jonas, 'PUT', `/spaces/${comms.id}/tools/post_to_x/account`, { values: { token: X_TOKEN } })
  )
  anaAsks = await open(ana, comms.id)
}, 30_000)

afterAll(async () => {
  await running?.stop()
  await crm?.close()
  await search?.close()
  await x?.close()
})

describe('the default policy and the space rule of timeouts (TOOL-CAT-023, SPACE-DEF-008, PROF-TOOL-036)', () => {
  it('gives Post on X the owner, required, one approval, whole to the owner and as approvers and threshold to a member', async () => {
    expect(await policyOf(jonas)).toEqual({
      approvers: [{ kind: 'owner', name: 'jonas', required: true }],
      threshold: 1,
      refusal: 'any',
      attested: true,
      whenApproverAsks: 'own-confirmation',
      state: 'ok',
      attention: [],
      warnings: [],
      bounds: {
        minApprovals: 1,
        kinds: ['owner', 'person', 'member', 'role', 'department'],
        roles: ['manager'],
        attested: 'optional',
      },
    })
    expect(await policyOf(ana)).toEqual({ approvers: [{ kind: 'owner', name: 'jonas', required: true }], threshold: 1 })
  })

  it("holds the space's timeouts, set by the owner alone within the agent-pack's bounds", async () => {
    const space = (await call(jonas, 'GET', `/spaces/${comms.id}`)).body as Doc
    expect(space.rules.approvalTimeouts).toEqual({ 'tool-call': 60 })
    expect(space.successor).toBeNull()
    expect((await call(ana, 'GET', `/spaces/${comms.id}`)).body.successor).toBeUndefined()
    const wide = await call(jonas, 'PATCH', `/spaces/${comms.id}`, {
      rules: { approvalTimeouts: { 'tool-call': 20000 } },
    })
    expect(wide).toMatchObject({
      status: 422,
      body: { error: 'out-of-bounds', field: 'rules.approvalTimeouts.tool-call' },
    })
    const member = await call(ana, 'PATCH', `/spaces/${comms.id}`, { rules: { approvalTimeouts: { 'tool-call': 30 } } })
    expect(member).toMatchObject({ status: 403, body: { error: 'not-owner' } })
    const set = await call(jonas, 'PATCH', `/spaces/${comms.id}`, {
      rules: { approvalTimeouts: { 'tool-call': 1440 } },
    })
    expect(set.body.rules.approvalTimeouts).toEqual({ 'tool-call': 1440 })
    // the approvals asked afterwards wait a day
    const approval = await anaPosts('A day to decide.')
    const waits = Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)
    expect(Math.round(waits / 60_000)).toBe(1440)
    await running.agent.approvals.cancel(approval.id, ana.principal)
  })
})

describe('setting a policy (TOOL-SPACE-018, TOOL-SPACE-019, TOOL-SPACE-020)', () => {
  it('refuses what is not a policy or breaks its bounds, changing nothing', async () => {
    const field = (r: { body: Doc }) => [r.body.error, r.body.field]
    const base = { threshold: 1, refusal: 'any', attested: true }
    expect(
      field(
        await setPolicy({ ...base, approvers: [OWNER, { kind: 'person', memberId: memberId(gus), required: false }] })
      )
    ).toEqual(['not-eligible', 'approvals.post_to_x.approvers.1'])
    expect(
      field(await setPolicy({ ...base, approvers: [{ kind: 'role', role: 'employee', required: false }] }))
    ).toEqual(['approver-not-allowed', 'approvals.post_to_x.approvers.0'])
    expect(field(await setPolicy({ ...base, approvers: [OWNER, OWNER] }))).toEqual([
      'repeated-entry',
      'approvals.post_to_x.approvers.1',
    ])
    expect(
      field(
        await setPolicy({ ...base, approvers: [OWNER, { kind: 'person', memberId: memberId(marta), required: true }] })
      )
    ).toEqual(['threshold-below-required', 'approvals.post_to_x.threshold'])
    expect(field(await setPolicy({ ...base, approvers: [OWNER], timeoutMinutes: 30 }))).toEqual([
      'bad-request',
      'approvals.post_to_x.timeoutMinutes',
    ])
    expect(
      field(
        await call(jonas, 'PATCH', `/spaces/${comms.id}/tools/post_to_x`, {
          calls: { post_to_x: 'off' },
          approvals: { post_to_x: { ...base, approvers: [OWNER] } },
        })
      )
    ).toEqual(['not-approval', 'approvals.post_to_x'])
    // the agent-pack's least number and its attestation (D140)
    const spaces = running.agent.pack.approvals as Doc
    spaces.spaces = { minApprovals: 2, attested: 'required' }
    expect(field(await setPolicy({ ...base, approvers: [OWNER, { kind: 'member', required: false }] }))).toEqual([
      'below-pack-minimum',
      'approvals.post_to_x.threshold',
    ])
    expect(
      field(
        await setPolicy({
          ...base,
          threshold: 2,
          attested: false,
          approvers: [OWNER, { kind: 'member', required: false }],
        })
      )
    ).toEqual(['attestation-required', 'approvals.post_to_x.attested'])
    spaces.spaces = undefined
    // a member sets nothing
    const member = await call(ana, 'PATCH', `/spaces/${comms.id}/tools/post_to_x`, {
      approvals: { post_to_x: { ...base, approvers: [OWNER] } },
    })
    expect(member).toMatchObject({ status: 403, body: { error: 'not-owner' } })
    expect((await policyOf(jonas)).approvers).toEqual([{ kind: 'owner', name: 'jonas', required: true }])
  })

  it('holds a looser policy for the phone, naming it as people read it, and applies a stricter one at once with its warnings', async () => {
    const marta1 = { kind: 'person', memberId: memberId(marta), required: false }
    const text = await confirmed(jonas, () =>
      setPolicy({ approvers: [OWNER, marta1], threshold: 1, refusal: 'any', attested: true })
    )
    expect(text).toBe(
      'Change who approves Post on X in Communication: from jonas (required), 1 approval, to jonas (required), marta, 1 approval'
    )
    await until(async () => (await policyOf(jonas)).approvers.length === 2)
    expect((await policyOf(jonas)).whenApproverAsks).toBe('another-approver')
    // the threshold raised: stricter, at once, with no phone; both approvers' own requests can no longer be approved
    const asked = ph.callsOf('sendConfirmRequest').length
    const stricter = await setPolicy({ approvers: [OWNER, marta1], threshold: 2, refusal: 'any', attested: true })
    expect(stricter.status).toBe(200)
    expect(ph.callsOf('sendConfirmRequest').length).toBe(asked)
    const approval = (stricter.body.tool.tools as Doc[]).find((t) => t.title === 'Post on X')?.approval
    expect(approval).toMatchObject({
      threshold: 2,
      warnings: [{ code: 'own-requests-blocked', approvers: [{ name: 'jonas' }, { name: 'marta' }] }],
    })
    const activity = (await call(jonas, 'GET', `/spaces/${comms.id}/activity`)).body.activity as Doc[]
    expect(activity[0]).toMatchObject({ kind: 'tool-changed', tool: { source: 'post_to_x' } })
  })
})

describe('an approval of several approvers (INTX-APPR-021, INTX-APPR-026, PROF-TOOL-037)', () => {
  it('asks each approver once and shows the progress on the card, on its updates and in the Notifications', async () => {
    const jonasBefore = ph.authorizeRequests(jonas.connectionId).length
    const martaBefore = ph.authorizeRequests(marta.connectionId).length
    const approval = await anaPosts('Two eyes.')
    expect(approval.approverIds).toEqual([jonas.principal.id, marta.principal.id])
    expect(ph.authorizeRequests(jonas.connectionId).slice(jonasBefore)).toHaveLength(1)
    expect(ph.authorizeRequests(marta.connectionId).slice(martaBefore)).toHaveLength(1)
    // each phone's request names the approvals needed and the other approvers, as they are when it is sent
    // (FLOW-AUTH-004, INTX-APPR-026)
    expect(ph.authorizeRequests(jonas.connectionId).at(-1)?.request.approvals).toEqual({
      threshold: 2,
      own: false,
      others: [{ name: 'marta', required: false }],
    })
    expect(ph.authorizeRequests(marta.connectionId).at(-1)?.request.approvals).toEqual({
      threshold: 2,
      own: false,
      others: [{ name: 'jonas', required: true }],
    })
    expect(toolAnswers().at(-1)).toBe(
      `Post on X needs the approval of 2 approvers among jonas (required), marta. The request is pending: the action runs once approved, and its outcome will be told in this conversation.\n\n${ONE_CALL}`
    )
    const card = lastRun.find((e) => e.type === 'ACTIVITY_SNAPSHOT' && (e.content as Doc).approvalId === approval.id)
      ?.content as Doc
    expect(card).toMatchObject({
      own: true,
      space: { id: comms.id, title: 'Communication' },
      policy: {
        approvers: [
          { kind: 'owner', name: 'jonas', required: true },
          { kind: 'person', name: 'marta', required: false },
        ],
        threshold: 2,
      },
      progress: {
        threshold: 2,
        approvals: 0,
        waitingFor: [
          { kind: 'owner', name: 'jonas', required: true },
          { kind: 'person', name: 'marta', required: false },
        ],
      },
    })
    // Marta approves: one of two, waiting for Jonas, required
    const before = received(anaAsks.sessionId).length
    await ph.authorize(marta.connectionId, 'approved', { approvalId: approval.id })
    const progress = { threshold: 2, approvals: 1, waitingFor: [{ kind: 'owner', name: 'jonas', required: true }] }
    await until(() =>
      received(anaAsks.sessionId)
        .slice(before)
        .some((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.approvalUpdate && (e.value as Doc).progress)
    )
    const update = received(anaAsks.sessionId)
      .slice(before)
      .find((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.approvalUpdate)?.value as Doc
    expect(update).toMatchObject({ approvalId: approval.id, status: 'PENDING', progress })
    const item = ((await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body.notifications as Doc[]).find(
      (n) => n.id === approval.id
    )
    expect(item).toMatchObject({ waiting: true, approval: { progress, canDecide: true } })
    // Jonas approves: it runs
    const tweets = x.requests.filter((r) => r.url === '/2/tweets').length
    await ph.authorize(jonas.connectionId, 'approved', { approvalId: approval.id })
    await until(() => x.requests.filter((r) => r.url === '/2/tweets').length > tweets)
    expect(await running.agent.store.approvals.get(approval.id)).toMatchObject({ status: 'APPROVED' })
  })

  it('refuses at once a request nobody else can decide, its card ended so and the owner told (INTX-APPR-024)', async () => {
    const jonasAsks = await open(jonas, comms.id)
    const before = await known()
    const phones = ph.callsOf('sendAuthorizeRequest').length
    model.script = [{ calls: [{ name: 'post_to_x', arguments: { text: 'My own.' } }] }, { text: 'Refused.' }]
    await run(jonasAsks, 'post: My own.')
    const refused = await newApproval(before)
    expect(refused).toMatchObject({ status: 'REJECTED', reason: 'no-approver', approverIds: [] })
    expect(ph.callsOf('sendAuthorizeRequest').length).toBe(phones)
    expect(toolAnswers().at(-1)).toBe(
      `Post on X needs the approval of 2 approvers among jonas (required), marta, and no other approver can decide it now: nothing was asked and it did not run.\n\n${ONE_CALL}`
    )
    const listed = (await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
    const notice = (listed.notifications as Doc[]).find((n) => n.kind === 'no-approver')
    expect(notice).toMatchObject({
      waiting: false,
      notice: {
        space: { title: 'Communication' },
        tool: { source: 'post_to_x', title: 'Post on X' },
        requester: { displayName: 'jonas' },
      },
    })
    expect(listed.waiting, JSON.stringify(listed.notifications.filter((n: Doc) => n.waiting))).toBe(0)
  })
})

describe('an approver who is no member (INTX-APPR-022)', () => {
  it('finds the request in the agent Notifications with the space title, and reads nothing else of the space', async () => {
    await confirmed(jonas, () =>
      setPolicy({
        approvers: [{ kind: 'role', role: 'manager', required: true }],
        threshold: 1,
        refusal: 'any',
        attested: true,
      })
    )
    await until(async () => (await policyOf(jonas)).approvers[0]?.kind === 'role')
    const before = ph.authorizeRequests(mia.connectionId).length
    const approval = await anaPosts('For the manager.')
    expect(approval.approverIds).toEqual([mia.principal.id])
    expect(ph.authorizeRequests(mia.connectionId).slice(before)).toHaveLength(1)
    const flowId = ph.authorizeRequests(mia.connectionId).at(-1)?.flowId
    const opened = ph.callsOf('openFlow').find((c) => (c.result as Doc).flowId === flowId)?.args[0] as Doc
    expect(opened.link).toBe(
      `https://app.ayni.org/app/service/${running.agent.did}/notifications?approval=${approval.id}`
    )
    const agentList = (await call(mia, 'GET', '/notifications')).body as Doc
    expect(agentList.notifications[0]).toMatchObject({
      id: approval.id,
      waiting: true,
      approval: { space: { title: 'Communication' }, canDecide: true },
    })
    expect((await call(mia, 'GET', `/spaces/${comms.id}`)).status).toBe(404)
    expect((await call(mia, 'GET', `/spaces/${comms.id}/notifications`)).status).toBe(404)
    await ph.authorize(mia.connectionId, 'approved', { approvalId: approval.id })
    await until(async () => (await running.agent.store.approvals.get(approval.id))?.status === 'APPROVED')
  })
})

describe('a required approver who leaves (TOOL-SPACE-021, INTX-APPR-025, INTX-APPR-027)', () => {
  it('marks the policy needs attention, tells the owner, and expires what waited for that person', async () => {
    const martaRequired = { kind: 'person', memberId: memberId(marta), required: true }
    await confirmed(jonas, () =>
      setPolicy({ approvers: [martaRequired], threshold: 1, refusal: 'any', attested: true })
    )
    await until(async () => (await policyOf(jonas)).approvers[0]?.kind === 'person')
    const approval = await anaPosts('Waits for Marta.')
    expect(approval.approverIds).toEqual([marta.principal.id])
    expect((await call(jonas, 'DELETE', `/spaces/${comms.id}/members/${memberId(marta)}`)).status).toBe(204)
    await until(async () => (await running.agent.store.approvals.get(approval.id))?.status === 'EXPIRED')
    expect(await policyOf(jonas)).toMatchObject({ state: 'needs-attention', attention: [0] })
    const listed = (await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
    const notice = (listed.notifications as Doc[]).find((n) => n.kind === 'policy-attention')
    expect(notice).toMatchObject({
      waiting: true,
      notice: {
        tool: { source: 'post_to_x', title: 'Post on X' },
        entries: [{ kind: 'person', name: 'marta', required: true }],
      },
    })
    expect(listed.waiting).toBe(1)
    // the owner saves a policy that names someone: the notice ends
    await confirmed(jonas, () => setPolicy({ approvers: [OWNER], threshold: 1, refusal: 'any', attested: true }))
    await until(async () => {
      const after = (await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
      return after.waiting === 0
    })
    const after = ((await call(jonas, 'GET', `/spaces/${comms.id}/notifications`)).body.notifications as Doc[]).find(
      (n) => n.id === notice?.id
    )
    expect(after?.notice.resolvedAt).toBeDefined()
  })
})

describe('a change of owner (SPACE-MEMB-012, INTX-APPR-027, PROF-TOOL-038)', () => {
  it('moves the approval that waits for the owner to the new one, and tells every member', async () => {
    const approval = await anaPosts('Moves to Ben.')
    expect(approval.approverIds).toEqual([jonas.principal.id])
    const jonasFlow = ph.authorizeRequests(jonas.connectionId).at(-1)?.flowId
    const benBefore = ph.authorizeRequests(ben.connectionId).length
    const anaStream = received(ana.sessionId).length
    const handed = await call(jonas, 'POST', `/spaces/${comms.id}/owner`, { memberId: memberId(ben) })
    expect(handed).toMatchObject({ status: 200, body: { owner: { name: 'ben' } } })
    // closed on Jonas's phone, asked on Ben's
    expect(ph.callsOf('closeFlow').some((c) => c.args[0] === jonasFlow)).toBe(true)
    expect(ph.authorizeRequests(ben.connectionId).slice(benBefore)).toHaveLength(1)
    const moved = await running.agent.store.approvals.get(approval.id)
    expect(moved?.approverIds).toContain(ben.principal.id)
    expect(moved?.progress?.waitingFor).toEqual([{ kind: 'owner', name: 'ben', required: true }])
    // every member reads who owns it now, with no badge
    const listed = (await call(ana, 'GET', `/spaces/${comms.id}/notifications`)).body as Doc
    expect((listed.notifications as Doc[]).find((n) => n.kind === 'owner-changed')).toMatchObject({
      waiting: false,
      notice: { how: 'handover', from: { name: 'jonas' }, to: { name: 'ben' } },
    })
    expect(
      received(ana.sessionId)
        .slice(anaStream)
        .some(
          (e) =>
            e.type === 'CUSTOM' &&
            e.name === CUSTOM_EVENT.spaceNotificationsChanged &&
            (e.value as Doc).kind === 'owner-changed' &&
            (e.value as Doc).waiting === false
        )
    ).toBe(true)
    const activity = (await call(ben, 'GET', `/spaces/${comms.id}/activity`)).body.activity as Doc[]
    expect(activity[0]).toMatchObject({ kind: 'owner-changed', how: 'handover', member: { name: 'ben' } })
    // the new owner decides it
    await ph.authorize(ben.connectionId, 'approved', { approvalId: approval.id })
    await until(async () => (await running.agent.store.approvals.get(approval.id))?.status === 'APPROVED')
  })
})
