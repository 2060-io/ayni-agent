/**
 * Spaces, memories per space and handover over the real agent (in-memory store, stub model), driven through the AG-UI
 * profile 3.3 (decision 60): SPACE-DEF-001..006, SPACE-MEMB-001..004/007/008, SPACE-CONV-001..004, SPACE-SHARE-001..003,
 * MEM-SPACE-001..007, PRIV-RETN-008, PROF-SPACE-001..007, PROF-MEM-001..003, PROF-CONV-010..012, PROF-STREAM-009/010,
 * PROF-HIST-011/012, PROF-RUN-014.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { personalSpaceId } from '../src/core/spaces.js'
import type { MessageEntry, Principal } from '../src/core/types.js'
import type { StubChatModel } from '../src/llm/stub.js'
import { parseSse, startTestAgent } from './helpers.js'

const client = { name: 'ayni-ui', version: '3.3.0', platform: 'web' }
let running: RunningAgent

interface Device {
  sessionId: string
  sessionToken: string
  principal: Principal
}

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

/** A device of a person, bound by the phone; `as` gives the person roles, a relation and a department. */
async function device(actor: string, as: Partial<Principal> = {}): Promise<Device> {
  const created = (
    await running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client, locale: 'en' } })
  ).json() as { sessionId: string; sessionToken: string }
  const session = await running.agent.sessions.get(created.sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const connectionId = `conn-${actor}`
  const { principal } = await running.agent.onPeerConnected(
    {
      connectionType: 'verifiable-user-agent',
      actorIdentity: actor,
      backingIdentity: null,
      claims: { userName: actor.split(':').pop() },
      userAgentVerified: false,
      identityCredentialRef: null,
    },
    connectionId,
    { name: 'Wallet', version: '2.5.0', platform: 'ios' }
  )
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  const updated = {
    ...principal,
    ...as,
    identityAttributes: { ...principal.identityAttributes, ...as.identityAttributes },
  }
  await running.agent.principals.save(updated)
  return { ...created, principal: updated }
}

/** Another session of the same person: a new conversation, in the space named. */
async function newConversation(d: Device, spaceId?: string) {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: { client, locale: 'en', newConversation: true, ...(spaceId ? { spaceId } : {}) },
  })
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown> & Device & { conversationId: string },
  }
}

async function call(
  d: Pick<Device, 'sessionToken'>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown
) {
  const response = await running.app.inject({
    method,
    url: `/agui/v3/sessions${url}`,
    headers: { authorization: `Bearer ${d.sessionToken}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
  return { status: response.statusCode, body: response.body ? response.json() : undefined }
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
    body: response.statusCode === 200 ? undefined : (response.json() as Record<string, unknown>),
  }
}

const history = async (d: Pick<Device, 'sessionId' | 'sessionToken'>) =>
  (await call(d, 'GET', `/${d.sessionId}/messages?limit=100`)).body.messages as {
    id: string
    role: string
    activityType?: string
    content: unknown
    metadata: Record<string, unknown>
  }[]

async function conversationOf(sessionId: string): Promise<string> {
  return (await running.agent.sessions.get(sessionId))?.conversationId as string
}

async function entries(conversationId: string): Promise<MessageEntry[]> {
  const rows = await running.agent.store.entries.listAll({ conversationId, limit: 1000 })
  return rows.map((r) => running.agent.memory.open(r))
}

/** What a session's stream has received so far. */
const received = (sessionId: string) => {
  const chunks: string[] = []
  running.streams.attach(sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
  return parseSse(chunks.join('')).map((e) => e.event)
}

const stub = () => running.agent.llm as StubChatModel
const lastSystem = () => {
  const request = stub().requests[stub().requests.length - 1]
  return (request?.messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content))
    .join('\n')
}

beforeAll(async () => {
  running = await startTestAgent()
  mintLocally(running)
}, 30_000)

afterAll(async () => {
  await running?.stop()
})

describe('spaces and their templates (SPACE-DEF-001..006, PROF-SPACE-001..004)', () => {
  it('lists Personal first and the templates the person may create from', async () => {
    const ana = await device('did:peer:ana-list')
    const { status, body } = await call(ana, 'GET', '/spaces')
    expect(status).toBe(200)
    expect(body.spaces).toHaveLength(1)
    expect(body.spaces[0]).toMatchObject({
      id: personalSpaceId(ana.principal.id),
      kind: 'personal',
      templateId: null,
      language: null,
      role: 'owner',
      state: 'active',
      owner: { name: 'ana-list' },
      membership: { mode: 'list', memberCount: 1 },
      // spaces.personal: 365 days, the conversation memory's basis, the agent's provider, no handover (SPACE-DEF-002)
      rules: { handover: false, allowedProviders: ['stub'], lawfulBasis: 'contract', retentionDays: 365 },
    })
    // a guest of the dev pack may create a project, not a department or the organization
    expect(body.templates.map((t: { id: string }) => t.id)).toEqual(['project'])
    expect(body.templates[0]).toMatchObject({
      title: 'Project',
      kind: 'team',
      membership: 'list',
      rules: {
        retentionDays: { default: 365, min: 1, max: 3650 },
        handover: { default: true, allowed: [true, false] },
      },
    })
  })

  it('creates a space from a template, owned by its creator, with the rules of the template', async () => {
    const ana = await device('did:peer:ana-create')
    const created = await call(ana, 'POST', '/spaces', {
      templateId: 'project',
      title: 'Truck 14 recall',
      purpose: 'Coordinate the recall of truck 14',
      brief: 'Parts, dates, the garage.',
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      kind: 'team',
      templateId: 'project',
      title: 'Truck 14 recall',
      purpose: 'Coordinate the recall of truck 14',
      brief: 'Parts, dates, the garage.',
      language: null,
      role: 'owner',
      state: 'active',
      owner: { name: 'ana-create' },
      rules: {
        retentionDays: 365,
        lawfulBasis: 'contract',
        allowedProviders: ['stub', 'openai-compatible'],
        handover: true,
      },
      membership: { mode: 'list', memberCount: 1 },
      members: [{ name: 'ana-create', state: 'active', role: 'owner' }],
    })
    expect(created.body.members[0].memberId).toMatch(/^mem_/)
    // the store keeps no title, purpose or brief in the clear (D77)
    const raw = JSON.stringify(await running.agent.store.spaces.get(created.body.id))
    expect(raw).not.toMatch(/Truck 14|recall|garage/)
    // the refusals of creation (PROF-SPACE-002)
    const notCreator = await call(ana, 'POST', '/spaces', { templateId: 'sales', title: 'x', purpose: 'y' })
    expect(notCreator).toMatchObject({ status: 403, body: { error: 'not-creator' } })
    expect((await call(ana, 'POST', '/spaces', { templateId: 'nope', title: 'x', purpose: 'y' })).status).toBe(404)
    expect((await call(ana, 'POST', '/spaces', { templateId: 'project', title: ' ', purpose: 'y' })).status).toBe(400)
    expect((await call(ana, 'POST', '/spaces', { templateId: 'project', title: 't' })).status).toBe(400)
  })

  it('shows a space to its members only, and nobody but its owner sees a Personal space (PROF-SPACE-003)', async () => {
    const ana = await device('did:peer:ana-see')
    const bob = await device('did:peer:bob-see')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Private', purpose: 'p' })).body
    expect((await call(ana, 'GET', `/spaces/${space.id}`)).status).toBe(200)
    expect((await call(bob, 'GET', `/spaces/${space.id}`)).status).toBe(404)
    expect((await call(ana, 'GET', `/spaces/${personalSpaceId(ana.principal.id)}`)).body).toMatchObject({
      kind: 'personal',
    })
    expect((await call(bob, 'GET', `/spaces/${personalSpaceId(ana.principal.id)}`)).status).toBe(404)
    expect((await call(bob, 'GET', '/spaces')).body.spaces).toHaveLength(1)
  })

  it('lets its owner change it within the bounds of its template, and records the names of what changed', async () => {
    const ana = await device('did:peer:ana-patch')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Depot plan', purpose: 'p' }))
      .body
    const ok = await call(ana, 'PATCH', `/spaces/${space.id}`, {
      title: 'Depot plan 2027',
      language: 'es',
      rules: { retentionDays: 30, lawfulBasis: 'consent', handover: false, allowedProviders: ['stub', 'anthropic'] },
    })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({
      title: 'Depot plan 2027',
      language: 'es',
      rules: { retentionDays: 30, lawfulBasis: 'consent', handover: false, allowedProviders: ['stub', 'anthropic'] },
    })
    for (const [rules, field] of [
      [{ retentionDays: 5000 }, 'rules.retentionDays'],
      [{ allowedProviders: ['bedrock'] }, 'rules.allowedProviders'],
    ] as const) {
      const out = await call(ana, 'PATCH', `/spaces/${space.id}`, { rules })
      expect(out).toMatchObject({ status: 422, body: { error: 'out-of-bounds', field } })
    }
    for (const body of [
      { rules: { allowedProviders: [] } },
      { rules: { retentionDays: null } },
      { language: 'Spanish' },
    ])
      expect((await call(ana, 'PATCH', `/spaces/${space.id}`, body)).body.error).toBe('bad-request')
    const personal = await call(ana, 'PATCH', `/spaces/${personalSpaceId(ana.principal.id)}`, { title: 'x' })
    expect(personal).toMatchObject({ status: 409, body: { error: 'personal-space' } })
    const activity = await call(ana, 'GET', `/spaces/${space.id}/activity`)
    expect(activity.body.activity.map((a: { kind: string }) => a.kind)).toEqual(['rules-changed', 'created'])
    expect(activity.body.activity[0].fields).toEqual(
      expect.arrayContaining(['title', 'language', 'rules.retentionDays', 'rules.lawfulBasis', 'rules.handover'])
    )
    expect(activity.body.activity[1]).toMatchObject({ by: { name: 'ana-patch' } })
    expect(activity.body.nextBefore).toBeNull()
    // the activity names fields, never what they say
    expect(JSON.stringify(activity.body)).not.toContain('Depot plan')
    // a page at a time, newest first (PROF-SPACE-006)
    const first = await call(ana, 'GET', `/spaces/${space.id}/activity?limit=1`)
    expect(first.body.activity).toHaveLength(1)
    const second = await call(ana, 'GET', `/spaces/${space.id}/activity?limit=1&before=${first.body.nextBefore}`)
    expect(second.body.activity.map((a: { kind: string }) => a.kind)).toEqual(['created'])
  })

  it('answers 501 for members in phase 1, keeps its owner, and is given to an active member (SPACE-MEMB-007)', async () => {
    const ana = await device('did:peer:ana-owner')
    const bob = await device('did:peer:bob-owner')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Handoff', purpose: 'p' })).body
    expect((await call(ana, 'POST', `/spaces/${space.id}/members`, { directoryId: 'emp-1' })).status).toBe(501)
    const outsider = await call(ana, 'POST', `/spaces/${space.id}/members`, {
      organizationKey: 'org:EE:1',
      email: 'x@example.org',
    })
    expect(outsider).toMatchObject({ status: 501, body: { error: 'not-implemented' } })
    const ownerRow = space.members[0].memberId as string
    expect((await call(ana, 'DELETE', `/spaces/${space.id}/members/${ownerRow}`)).body.error).toBe('owner')
    // a person of the employee list for a rule space comes with the list; a member who is none is not eligible
    expect((await call(ana, 'POST', `/spaces/${space.id}/owner`, { directoryId: 'emp-1' })).status).toBe(501)
    const nobody = await call(ana, 'POST', `/spaces/${space.id}/owner`, { memberId: 'mem_nobody' })
    expect(nobody).toMatchObject({ status: 422, body: { error: 'not-eligible' } })
    // a listed member, as the employee list will add one (phase 2)
    const now = new Date().toISOString()
    await running.agent.store.spaceMembers.save({
      id: 'mem_bob',
      spaceId: space.id,
      principalId: bob.principal.id,
      state: 'active',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    })
    expect((await call(bob, 'GET', `/spaces/${space.id}`)).body).toMatchObject({ role: 'member' })
    expect((await call(bob, 'PATCH', `/spaces/${space.id}`, { title: 'mine' })).body.error).toBe('not-owner')
    expect((await call(bob, 'GET', `/spaces/${space.id}/activity`)).body.error).toBe('not-owner')
    expect((await call(bob, 'DELETE', `/spaces/${space.id}/members/${ownerRow}`)).status).toBe(403)
    const given = await call(ana, 'POST', `/spaces/${space.id}/owner`, { memberId: 'mem_bob' })
    expect(given.status).toBe(200)
    expect(given.body.owner).toEqual({ name: 'bob-owner' })
    expect((await call(ana, 'GET', `/spaces/${space.id}`)).body.role).toBe('member')
    expect((await call(bob, 'GET', `/spaces/${space.id}`)).body.role).toBe('owner')
    // the new owner removes the former one, who becomes `left` (SPACE-MEMB-004)
    expect((await call(bob, 'DELETE', `/spaces/${space.id}/members/${ownerRow}`)).status).toBe(204)
    const listed = (await call(ana, 'GET', '/spaces')).body.spaces as { id: string; state: string }[]
    expect(listed.find((s) => s.id === space.id)?.state).toBe('left')
    expect((await call(ana, 'GET', `/spaces/${space.id}`)).body.members).toBeUndefined()
    const activity = (await call(bob, 'GET', `/spaces/${space.id}/activity`)).body.activity
    expect(activity.slice(0, 2).map((a: { kind: string }) => a.kind)).toEqual(['removed', 'owner-changed'])
    expect(activity[0]).toMatchObject({ by: { name: 'bob-owner' }, member: { name: 'ana-owner' } })
  })
})

describe('a conversation belongs to a space (SPACE-CONV-001..003, PROF-CONV-010/011, PROF-STREAM-009)', () => {
  it('starts in the space asked, names it in state.ayni.space, and lists by space', async () => {
    const ana = await device('did:peer:ana-conv')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Fleet audit', purpose: 'p' }))
      .body
    const inSpace = await newConversation(ana, space.id)
    expect(inSpace.status).toBe(201)
    const conversationId = inSpace.body.conversationId
    const state = await running.agent.ayniState((await running.agent.sessions.get(inSpace.body.sessionId)) as never)
    expect(state.space).toEqual({ id: space.id, title: 'Fleet audit', kind: 'team' })
    const personal = await running.agent.ayniState((await running.agent.sessions.get(ana.sessionId)) as never)
    expect(personal.space).toEqual({ id: personalSpaceId(ana.principal.id), title: 'Personal', kind: 'personal' })
    const listed = (await call(ana, 'GET', `/conversations?spaceId=${space.id}`)).body.conversations
    expect(listed.map((c: { id: string }) => c.id)).toEqual([conversationId])
    expect(listed[0]).toMatchObject({ spaceId: space.id, shared: false })
    const all = (await call(ana, 'GET', '/conversations')).body.conversations
    expect(all.find((c: { id: string }) => c.id === conversationId)?.spaceId).toBe(space.id)
    // the title of its space changes: the header of each device follows
    const seen = received(inSpace.body.sessionId).length
    await call(ana, 'PATCH', `/spaces/${space.id}`, { title: 'Fleet audit 2027' })
    const snapshot = received(inSpace.body.sessionId)
      .slice(seen)
      .filter((e) => e.type === 'STATE_SNAPSHOT')
      .pop() as { snapshot: { ayni: { space?: { title: string } } } } | undefined
    expect(snapshot?.snapshot.ayni.space?.title).toBe('Fleet audit 2027')
    // a space the person is not a member of is not found; without a space the conversation is Personal
    const bob = await device('did:peer:bob-conv')
    expect((await newConversation(bob, space.id)).status).toBe(404)
    const plain = await newConversation(bob)
    expect((await running.agent.sessions.conversationById(plain.body.conversationId))?.spaceId).toBe(
      personalSpaceId(bob.principal.id)
    )
  })

  it('binds a session the phone confirms into the space asked, or into Personal when the space is not theirs', async () => {
    const ana = await device('did:peer:ana-bind')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Bind', purpose: 'p' })).body
    const bindInto = async (actor: string, spaceId: string) => {
      const created = (
        await running.app.inject({
          method: 'POST',
          url: '/agui/v3/sessions',
          payload: { client, locale: 'en', newConversation: true, spaceId },
        })
      ).json() as { sessionId: string }
      const session = await running.agent.sessions.get(created.sessionId)
      const principal = (await running.agent.store.principals.findByActor(actor)) as Principal
      const connectionId = `conn-${actor}`
      const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
      await running.agent.sessions.markConfirmationSent(session as never, connectionId, thread)
      const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
      const bound = await running.agent.sessions.bind(confirm as never, principal, confirm?.binding?.nonce as string)
      return running.agent.sessions.conversationById(bound.conversationId as string)
    }
    expect((await bindInto('did:peer:ana-bind', space.id))?.spaceId).toBe(space.id)
    const bob = await device('did:peer:bob-bind')
    expect((await bindInto('did:peer:bob-bind', space.id))?.spaceId).toBe(personalSpaceId(bob.principal.id))
  })

  it('changes space only before its first message, its entries with it (SPACE-CONV-002)', async () => {
    const ana = await device('did:peer:ana-move')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Moves', purpose: 'p' })).body
    const fresh = await newConversation(ana)
    const conversationId = fresh.body.conversationId
    const moved = await call(ana, 'PATCH', `/conversations/${conversationId}`, { spaceId: space.id })
    expect(moved).toMatchObject({ status: 200, body: { spaceId: space.id } })
    // the greeting it holds follows it
    expect((await entries(conversationId)).every((e) => e.spaceId === space.id)).toBe(true)
    expect((await call(ana, 'PATCH', `/conversations/${conversationId}`, { spaceId: 'spc_nope' })).status).toBe(404)
    const back = await call(ana, 'PATCH', `/conversations/${conversationId}`, {
      spaceId: personalSpaceId(ana.principal.id),
    })
    expect(back.body.spaceId).toBe(personalSpaceId(ana.principal.id))
    await run(fresh.body, 'first words')
    const late = await call(ana, 'PATCH', `/conversations/${conversationId}`, { spaceId: space.id })
    expect(late).toMatchObject({ status: 409, body: { error: 'has-messages' } })
  })
})

describe('memories per space, preferences global (MEM-SPACE-001..007, PROF-MEM-001..003)', () => {
  it('gives the model the notes of the space of its conversation only, and every preference', async () => {
    const ana = await device('did:peer:ana-mem')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Truck 14', purpose: 'p' })).body
    const work = (await newConversation(ana, space.id)).body
    const live = await run(work, 'note /call working_memory {"action":"add","content":"garage is Weber Motors"}')
    await run(work, 'style /call principal_preferences {"action":"set","key":"tone","value":"brief"}')
    // the live line of the memory, and the line in history, never with its content (PROF-STREAM-010, PROF-HIST-012)
    const updated = live.events.find((e) => e.type === 'CUSTOM' && e.name === 'ayni.memory.updated')
    expect(updated?.value).toMatchObject({ conversationId: work.conversationId, spaceId: space.id, action: 'added' })
    const memoryId = (updated?.value as { memoryId?: string } | undefined)?.memoryId
    const line = (await history(work)).find((m) => m.activityType === 'ayni.memory-update')
    expect(line?.content).toEqual({ memoryId, spaceId: space.id, action: 'added' })
    expect(JSON.stringify(line)).not.toContain('Weber')

    await run(work, 'what do you know?')
    expect(lastSystem()).toContain('garage is Weber Motors')
    expect(lastSystem()).toContain('tone=brief')
    // the Personal conversation does not see the note of the space; the preference is global
    await run(ana, 'and here?')
    expect(lastSystem()).not.toContain('Weber Motors')
    expect(lastSystem()).toContain('tone=brief')

    // the reply carries what it was given, in the person's own history only, with no live field (PROF-HIST-011)
    const answered = await run(work, 'once more')
    const start = answered.events.find((e) => e.type === 'TEXT_MESSAGE_START')
    expect(start?.metadata).toBeUndefined()
    const all = await history(work)
    const replies = all.filter((m) => m.role === 'assistant')
    expect(replies[replies.length - 1]?.metadata).toMatchObject({ usedMemories: [memoryId], usedPreferences: ['tone'] })
    // a message of the agent outside a turn carries empty lists
    expect(replies[0]?.metadata).toMatchObject({ usedMemories: [], usedPreferences: [] })
    // the memory line is after the reply of its turn, with its entry id (PROF-HIST-012, MEM-SPACE-005)
    const at = all.findIndex((m) => m.activityType === 'ayni.memory-update')
    expect(all[at - 1]?.role).toBe('assistant')
    expect(all[at]?.metadata).toMatchObject({ entryId: (updated?.value as { entryId?: string } | undefined)?.entryId })
    // a memory changed by the person's word is `changed`
    const changed = await run(
      work,
      `fix /call working_memory {"action":"update","id":"${memoryId}","content":"garage is Weber"}`
    )
    const event = changed.events.find((e) => e.type === 'CUSTOM' && e.name === 'ayni.memory.updated')
    expect(event?.value).toMatchObject({ memoryId, action: 'changed' })
  })

  it('lets the person see and delete their memories and preferences, and says what the agent keeps', async () => {
    const ana = await device('did:peer:ana-own')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Rotterdam', purpose: 'p' })).body
    const work = (await newConversation(ana, space.id)).body
    await run(work, 'x /call working_memory {"action":"add","content":"works nights"}')
    await run(ana, 'y /call working_memory {"action":"add","content":"has a dog"}')
    await run(ana, 'z /call principal_preferences {"action":"set","key":"language","value":"es"}')
    const inSpace = (await call(ana, 'GET', `/memories?spaceId=${space.id}`)).body
    expect(inSpace.memories.map((m: { content: string }) => m.content)).toEqual(['works nights'])
    expect(inSpace.memories[0]).toMatchObject({ spaceId: space.id, source: { conversationId: work.conversationId } })
    expect(inSpace.preferences).toEqual([expect.objectContaining({ key: 'language', value: 'es' })])
    const every = (await call(ana, 'GET', '/memories')).body.memories.map((m: { content: string }) => m.content)
    expect(every.sort()).toEqual(['has a dog', 'works nights'])

    const about = (await call(ana, 'GET', '/about-me')).body
    expect(about.preferences.map((p: { key: string }) => p.key)).toEqual(['language'])
    expect(about.memoriesBySpace).toEqual(
      expect.arrayContaining([
        { spaceId: space.id, title: 'Rotterdam', count: 1 },
        { spaceId: personalSpaceId(ana.principal.id), title: 'Personal', count: 1 },
      ])
    )
    expect(about.conversations).toEqual(
      expect.arrayContaining([{ spaceId: space.id, title: 'Rotterdam', count: 1, retentionDays: 365 }])
    )
    expect(about.verified).toEqual([])

    const id = inSpace.memories[0].id as string
    expect((await call(ana, 'DELETE', `/memories/${id}`)).status).toBe(204)
    expect((await call(ana, 'DELETE', `/memories/${id}`)).status).toBe(404)
    expect((await call(ana, 'GET', `/memories?spaceId=${space.id}`)).body.memories).toEqual([])
    expect((await call(ana, 'DELETE', '/preferences/language')).status).toBe(204)
    expect((await call(ana, 'DELETE', '/preferences/language')).status).toBe(404)
    // nobody deletes another's memory
    const bob = await device('did:peer:bob-own')
    const theirs = (await call(ana, 'GET', '/memories')).body.memories[0].id as string
    expect((await call(bob, 'DELETE', `/memories/${theirs}`)).status).toBe(404)
  })

  it('keeps the model to the notes of its space when it updates or removes one (MEM-SPACE-002)', async () => {
    const ana = await device('did:peer:ana-scope')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Scoped', purpose: 'p' })).body
    await run(ana, 'a /call working_memory {"action":"add","content":"personal fact"}')
    const personalNote = (await call(ana, 'GET', `/memories?spaceId=${personalSpaceId(ana.principal.id)}`)).body
      .memories[0].id as string
    const work = (await newConversation(ana, space.id)).body
    await run(work, `b /call working_memory {"action":"remove","id":"${personalNote}"}`)
    expect((await call(ana, 'GET', '/memories')).body.memories.map((m: { id: string }) => m.id)).toContain(personalNote)
  })
})

describe('membership by rule, and leaving a space (SPACE-MEMB-001/003/004, PROF-RUN-014)', () => {
  it("gives a department's space to its people and none other; who leaves keeps reading, and runs nothing", async () => {
    const home = { backingRelation: 'home' as const }
    // the department of each person comes from their directory entry, never from a claim (SPACE-MEMB-001)
    const departments = new Map<string, string>()
    running.agent.spaces.directory = (p) => (departments.has(p.id) ? { department: departments.get(p.id) } : undefined)
    const lead = await device('did:peer:lead-rule', { ...home, roles: ['employee', 'manager'] })
    const mia = await device('did:peer:mia-rule', {
      ...home,
      roles: ['employee'],
      // a claim of a department makes nobody a member
      identityAttributes: { department: 'Sales' },
    })
    const otto = await device('did:peer:otto-rule', { ...home, roles: ['employee'] })
    departments.set(lead.principal.id, 'Sales')
    departments.set(otto.principal.id, 'Ops')
    const created = await call(lead, 'POST', '/spaces', { templateId: 'sales', title: 'Sales desk', purpose: 'p' })
    expect(created.status).toBe(201)
    expect(created.body.membership).toEqual({ mode: 'rule', rule: { department: 'Sales' }, memberCount: 1 })
    // a role is no membership: holding the employee role makes Otto no member, and no creator (SPACE-MEMB-003)
    expect((await call(otto, 'POST', '/spaces', { templateId: 'sales', title: 'x', purpose: 'p' })).body.error).toBe(
      'not-creator'
    )
    const id = created.body.id as string
    // Mia's claim is no directory entry: she is no member until her entry says Sales
    expect((await call(mia, 'GET', `/spaces/${id}`)).status).toBe(404)
    departments.set(mia.principal.id, 'Sales')
    // the members of a rule space follow its rule (SPACE-MEMB-002)
    expect((await call(lead, 'POST', `/spaces/${id}/members`, { directoryId: 'e' })).body.error).toBe('rule-membership')
    expect((await call(mia, 'GET', `/spaces/${id}`)).body).toMatchObject({ role: 'member', state: 'active' })
    expect((await call(otto, 'GET', `/spaces/${id}`)).status).toBe(404)

    const conversation = (await newConversation(mia, id)).body
    expect((await run(conversation, 'hello sales')).status).toBe(200)
    // the directory moves Mia to Ops: she keeps reading her conversation of Sales, and it takes no message
    departments.set(mia.principal.id, 'Ops')
    const listed = (await call(mia, 'GET', '/spaces')).body.spaces.find((s: { id: string }) => s.id === id)
    expect(listed).toMatchObject({ state: 'left' })
    expect((await call(mia, 'GET', `/spaces/${id}`)).body.members).toBeUndefined()
    const refused = await run(conversation, 'still there?')
    expect(refused).toMatchObject({ status: 409, body: { error: 'space-left' } })
    // nothing of the refused run is recorded (PROF-RUN-014)
    expect((await entries(conversation.conversationId)).some((e) => e.text === 'still there?')).toBe(false)
    expect((await history(conversation)).some((m) => m.content === 'hello sales')).toBe(true)
    // a receipt still goes: reading is not writing
    expect((await run(conversation, '', { kind: 'receipt', messageIds: [], state: 'viewed' })).status).toBe(200)
    // no new conversation in it
    expect((await newConversation(mia, id)).status).toBe(404)
    // back in Sales: active again (SPACE-MEMB-004)
    departments.set(mia.principal.id, 'Sales')
    expect((await run(conversation, 'back again')).status).toBe(200)
    running.agent.spaces.directory = undefined
  })

  it('makes every person of the organization a member of its space, and nobody else (SPACE-MEMB-001)', async () => {
    const lead = await device('did:peer:lead-org', { backingRelation: 'home', roles: ['employee', 'manager'] })
    const colleague = await device('did:peer:colleague-org', { backingRelation: 'home', roles: ['employee'] })
    const partner = await device('did:peer:partner-org', { backingRelation: 'partner', roles: ['employee'] })
    const created = await call(lead, 'POST', '/spaces', {
      templateId: 'organization',
      title: 'Northwind',
      purpose: 'p',
    })
    expect(created.body).toMatchObject({
      kind: 'organization',
      membership: { mode: 'rule', rule: { organization: true } },
    })
    expect((await call(colleague, 'GET', `/spaces/${created.body.id}`)).body).toMatchObject({ role: 'member' })
    expect((await call(partner, 'GET', `/spaces/${created.body.id}`)).status).toBe(404)
  })
})

describe('handover: the author shares a conversation with its own space (SPACE-SHARE-001..003, PROF-SPACE-007)', () => {
  it('lets its active members read it, live and read-only, while the space takes handovers', async () => {
    const ana = await device('did:peer:ana-share')
    const bob = await device('did:peer:bob-share')
    const eve = await device('did:peer:eve-share')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Handover', purpose: 'p' })).body
    const now = new Date().toISOString()
    await running.agent.store.spaceMembers.save({
      id: 'mem_bob_share',
      spaceId: space.id,
      principalId: bob.principal.id,
      state: 'active',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    })
    const work = (await newConversation(ana, space.id)).body
    await run(work, 'note /call working_memory {"action":"add","content":"private to ana"}')
    await run(work, 'The brake pads arrive Tuesday.')
    // Personal shares with nobody; only the author shares (PROF-CONV-012)
    const personalConversation = await conversationOf(ana.sessionId)
    expect((await call(ana, 'POST', `/conversations/${personalConversation}/share`)).body.error).toBe(
      'handover-not-allowed'
    )
    expect((await call(bob, 'POST', `/conversations/${work.conversationId}/share`)).status).toBe(404)
    const shared = await call(ana, 'POST', `/conversations/${work.conversationId}/share`)
    expect(shared).toMatchObject({ status: 200, body: { shared: true } })
    expect(typeof shared.body.sharedAt).toBe('string')

    const list = await call(bob, 'GET', `/spaces/${space.id}/shared`)
    expect(list.body.conversations).toEqual([
      expect.objectContaining({ id: work.conversationId, author: { name: 'ana-share' } }),
    ])
    expect((await call(eve, 'GET', `/spaces/${space.id}/shared`)).status).toBe(404)
    const read = await call(bob, 'GET', `/spaces/${space.id}/shared/${work.conversationId}/messages`)
    expect(read.status).toBe(200)
    const text = JSON.stringify(read.body.messages)
    expect(text).toContain('The brake pads arrive Tuesday.')
    // the author's memories stay theirs: no memory line, no list of what a reply used (SPACE-SHARE-003)
    expect(text).not.toContain('usedMemories')
    expect(text).not.toContain('ayni.memory-update')
    // live: what the author writes next is in the member's next read
    await run(work, 'Garage confirmed.')
    const again = await call(bob, 'GET', `/spaces/${space.id}/shared/${work.conversationId}/messages`)
    expect(JSON.stringify(again.body.messages)).toContain('Garage confirmed.')
    // not through another space, and no attachment that is not the conversation's
    const other = (await call(bob, 'POST', '/spaces', { templateId: 'project', title: 'Other', purpose: 'p' })).body
    expect((await call(bob, 'GET', `/spaces/${other.id}/shared/${work.conversationId}/messages`)).status).toBe(404)
    const missing = `/spaces/${space.id}/shared/${work.conversationId}/attachments/att_none`
    expect((await call(bob, 'GET', missing)).status).toBe(404)
    expect((await call(eve, 'GET', missing)).status).toBe(404)

    // the space stops taking handovers: nothing is readable; the author stops sharing: nothing is listed
    await call(ana, 'PATCH', `/spaces/${space.id}`, { rules: { handover: false } })
    expect((await call(bob, 'GET', `/spaces/${space.id}/shared`)).body.error).toBe('handover-not-allowed')
    await call(ana, 'PATCH', `/spaces/${space.id}`, { rules: { handover: true } })
    expect((await call(ana, 'DELETE', `/conversations/${work.conversationId}/share`)).status).toBe(204)
    expect((await call(bob, 'GET', `/spaces/${space.id}/shared`)).body.conversations).toEqual([])
    expect((await call(bob, 'GET', `/spaces/${space.id}/shared/${work.conversationId}/messages`)).status).toBe(404)
    const kinds = (await call(ana, 'GET', `/spaces/${space.id}/activity`)).body.activity.map(
      (a: { kind: string }) => a.kind
    )
    expect(kinds).toEqual(expect.arrayContaining(['shared', 'unshared']))
    // a conversation closed for good is not shared (PROF-CONV-012)
    expect((await call(ana, 'DELETE', `/conversations/${work.conversationId}`)).status).toBe(204)
    expect((await call(ana, 'POST', `/conversations/${work.conversationId}/share`)).body.error).toBe('final')
  })

  it('serves the attachments of a shared conversation to its members (PROF-SPACE-007)', async () => {
    const ana = await device('did:peer:ana-attach')
    const bob = await device('did:peer:bob-attach')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Photos', purpose: 'p' })).body
    const now = new Date().toISOString()
    await running.agent.store.spaceMembers.save({
      id: 'mem_bob_attach',
      spaceId: space.id,
      principalId: bob.principal.id,
      state: 'active',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    })
    const work = (await newConversation(ana, space.id)).body
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } })
      .png()
      .toBuffer()
    const boundary = '----ayni-test'
    const upload = await running.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/${work.sessionId}/attachments`,
      headers: {
        authorization: `Bearer ${work.sessionToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="truck.png"\r\nContent-Type: image/png\r\n\r\n`
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    })
    expect(upload.statusCode).toBe(201)
    const attachmentId = upload.json().attachmentId as string
    await run(work, '', { kind: 'attachments', attachmentIds: [attachmentId] })
    await call(ana, 'POST', `/conversations/${work.conversationId}/share`)
    const served = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/spaces/${space.id}/shared/${work.conversationId}/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${bob.sessionToken}` },
    })
    expect(served.statusCode).toBe(200)
    expect(served.headers['content-type']).toBe('image/png')
    expect(Buffer.compare(served.rawPayload, png)).toBe(0)
  })
})

describe('the model providers a space allows (SPACE-CONV-004, PROF-RUN-014)', () => {
  it("answers in the code's words, with no model call, in a space that does not allow the agent's model", async () => {
    const ana = await device('did:peer:ana-provider')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'EU only', purpose: 'p' })).body
    const work = (await newConversation(ana, space.id)).body
    expect((await run(work, 'allowed')).status).toBe(200)
    await call(ana, 'PATCH', `/spaces/${space.id}`, { rules: { allowedProviders: ['anthropic'] } })
    const calls = stub().requests.length
    const refused = await run(work, 'not any more')
    expect(refused.status).toBe(200)
    expect(stub().requests.length).toBe(calls)
    const said = refused.events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join('')
    expect(said).toContain('do not allow the model this agent uses (stub)')
    // the person's message is kept; the answer is a refusal of the code, in history
    const stored = await entries(work.conversationId)
    expect(stored.some((e) => e.text === 'not any more' && e.role === 'principal')).toBe(true)
    const last = (await history(work)).filter((m) => m.role === 'assistant').pop()
    expect(last?.metadata).toMatchObject({ sourceType: 'refusal', usedMemories: [], usedPreferences: [] })
    expect(String(last?.content)).toContain('EU only')
    // deleting the message takes the refusal with it (PRIV-ERASE-011)
    const own = stored.find((e) => e.text === 'not any more') as MessageEntry
    const refusal = stored.find((e) => e.sourceType === 'refusal') as MessageEntry
    expect((await call(work, 'DELETE', `/${work.sessionId}/messages/${own.id}`)).status).toBe(204)
    expect((await running.agent.store.entries.get(refusal.id))?.state).toBe('crypto-erased')
  })
})

describe('the retention of a space (PRIV-RETN-008)', () => {
  it('archives the entries older than the retention of their space, never one on legal hold; Personal by its own', async () => {
    const ana = await device('did:peer:ana-retain')
    const space = (await call(ana, 'POST', '/spaces', { templateId: 'project', title: 'Short-lived', purpose: 'p' }))
      .body
    await call(ana, 'PATCH', `/spaces/${space.id}`, { rules: { retentionDays: 1 } })
    const work = (await newConversation(ana, space.id)).body
    await run(work, 'old words')
    await run(work, 'kept for the court')
    await run(ana, 'personal old words')
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const inSpace = await entries(work.conversationId)
    const personal = await entries(await conversationOf(ana.sessionId))
    // every entry carries the space of its conversation (SPACE-CONV-001)
    expect(inSpace.every((e) => e.spaceId === space.id)).toBe(true)
    expect(personal.every((e) => e.spaceId === personalSpaceId(ana.principal.id))).toBe(true)
    for (const e of [...inSpace, ...personal]) await running.agent.store.entries.update(e.id, { createdAt: old })
    const held = inSpace.find((e) => e.text === 'kept for the court') as MessageEntry
    await running.agent.memory.setLegalHold([held.id], true)
    await run(work, 'new words')
    const archived = await running.retention.archiveSpaces()
    expect(archived).toBe(inSpace.length - 1)
    for (const e of inSpace) {
      const stored = await running.agent.store.entries.get(e.id)
      expect(stored?.state).toBe(e.id === held.id ? 'legal-hold' : 'archived')
      // archived, not erased: the key stays (PRIV-RETN-002)
      expect(stored?.encKeyRef).toBeTruthy()
    }
    const after = await entries(work.conversationId)
    expect(after.some((e) => e.text === 'new words' && e.state === 'active')).toBe(true)
    // Personal keeps them 365 days (spaces.personal)
    for (const e of personal) expect((await running.agent.store.entries.get(e.id))?.state).toBe('active')
  })
})
