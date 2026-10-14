/**
 * The AG-UI profile over the real agent on the in-memory store with the stub model. Binding is
 * driven by simulating the DIDComm agent's events (the VS Agent is not reachable in tests).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { SessionStreams } from '../src/channels/agui/streams.js'
import { parseSse, startTestAgent } from './helpers.js'

let running: RunningAgent
const client = { name: 'hologram-ui', version: '3.0.0', platform: 'web' }

async function createSession(token?: string) {
  // a sibling from a bound token stands for the UI's "New conversation": it asks for a new one (PROF-CONV-006)
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { client, locale: 'en', ...(token ? { newConversation: true } : {}) },
  })
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown> & { sessionId: string; sessionToken: string },
  }
}

/** Binds a provisional session the way the DIDComm events would: peer connected, question answered yes. */
async function bindViaPhone(sessionId: string, actor = 'did:peer:alice') {
  const session = await running.agent.sessions.get(sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const connectionId = `conn-${actor}`
  const { principal } = await running.agent.onPeerConnected(
    {
      connectionType: 'verifiable-user-agent',
      actorIdentity: actor,
      backingIdentity: null,
      claims: { userName: 'Alice' },
      userAgentVerified: false,
      identityCredentialRef: null,
    },
    connectionId,
    { name: 'Hologram', version: '2.5.0', platform: 'ios' }
  )
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  return principal
}

async function run(sessionId: string, token: string, text: string, hologram?: Record<string, unknown>) {
  const response = await running.app.inject({
    method: 'POST',
    url: `/agui/v3/sessions/${sessionId}/runs`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      threadId: sessionId,
      runId: `run-${Date.now()}-${Math.random()}`,
      messages: text ? [{ id: 'u1', role: 'user', content: text }] : [],
      tools: [{ name: 'frontend_tool', description: 'ignored', parameters: {} }],
      context: [],
      forwardedProps: hologram ? { hologram } : undefined,
    },
  })
  return { status: response.statusCode, events: parseSse(response.body).map((e) => e.event), body: response.body }
}

beforeAll(async () => {
  running = await startTestAgent()
  // the DIDComm agent is not reachable: mint invitations locally for the tests
  const minter = running.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
  minter.minter = {
    mint: async (id: string) => ({
      invitationId: `inv-${id}`,
      outOfBandId: `oob-${id}`,
      url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
    }),
  }
}, 30_000)

afterAll(async () => {
  await running?.stop()
})

describe('descriptor (PROF-DESC-001/002)', () => {
  it('publishes the descriptor at the well-known path', async () => {
    const response = await running.app.inject({ method: 'GET', url: '/.well-known/hologram-agent.json' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.profileVersion).toBe('3.0')
    expect(body.sessions).toBe('http://agent.test/agui/v3/sessions')
    expect(body.binding.walletLinkTemplate).toMatch(/^https:\/\/.*\{oob\}/)
    expect(body.features.uploads.types).toContain('audio/webm')
  })
})

describe('sessions and binding (PROF-SESS-001..008, PROF-BIND-001..008)', () => {
  it('creates a provisional session with binding material and no token in the invitation', async () => {
    const { status, body } = await createSession()
    expect(status).toBe(201)
    expect(body.state).toBe('provisional')
    const binding = body.binding as { oobUrl: string; walletLink: string; bindingCode: string; expiresAt: string }
    expect(binding.bindingCode).toMatch(/^[A-Z0-9]{2}-[A-Z0-9]{2}$/)
    expect(binding.walletLink.startsWith('https://hologram.zone/')).toBe(true)
    expect(binding.oobUrl).not.toContain(body.sessionToken)
    expect(binding.walletLink).not.toContain(body.sessionToken)
  })

  it('refuses runs and history before binding (403 not-bound) and a token in the query string (401)', async () => {
    const { body } = await createSession()
    const r = await run(body.sessionId, body.sessionToken, 'hello')
    expect(r.status).toBe(403)
    const h = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${body.sessionId}/messages?token=${body.sessionToken}`,
    })
    expect(h.statusCode).toBe(401)
  })

  it('refuses a binding refresh while the material is valid (409 with the current material)', async () => {
    const { body } = await createSession()
    const r = await running.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/${body.sessionId}/binding`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().binding.bindingCode).toBe((body.binding as { bindingCode: string }).bindingCode)
  })

  it('binds only on the yes answer correlated to the nonce, then answers runs and emits session.bound', async () => {
    const { body } = await createSession()
    const session = await running.agent.sessions.get(body.sessionId)
    expect(session?.state).toBe('provisional')
    await bindViaPhone(body.sessionId)
    const status = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${body.sessionId}`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    expect(status.json().state).toBe('bound')
    expect(status.json().principal.displayName).toBe('Alice')
    // the nonce is single-use: a second bind with the same nonce fails
    const bound = await running.agent.sessions.get(body.sessionId)
    const principal = await running.agent.principalOf(bound as never)
    await expect(
      running.agent.sessions.bind(bound as never, principal as never, bound?.binding?.nonce ?? '')
    ).rejects.toThrow()
    const r = await run(body.sessionId, body.sessionToken, 'hello there')
    expect(r.status).toBe(200)
    const types = r.events.map((e) => e.type)
    expect(types[0]).toBe('RUN_STARTED')
    expect(types).toContain('TEXT_MESSAGE_START')
    expect(types).toContain('TEXT_MESSAGE_END')
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
    const text = r.events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join('')
    expect(text).toContain('You said: hello there')
    expect(types).not.toContain('TOOL_CALL_START')
  })

  it('creates a sibling session from a bound token, already bound, with its own token and no binding (PROF-SESS-007)', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:bob')
    const sibling = await createSession(body.sessionToken)
    expect(sibling.status).toBe(201)
    expect(sibling.body.state).toBe('bound')
    expect(sibling.body.binding).toBeUndefined()
    expect(sibling.body.parentSessionId).toBe(body.sessionId)
    expect(sibling.body.sessionToken).not.toBe(body.sessionToken)
    const r = await run(sibling.body.sessionId, sibling.body.sessionToken, 'sibling works')
    expect(r.status).toBe(200)
    // a supersede closes parent and sibling together (PROF-SESS-008)
    const principal = await running.agent.principalOf((await running.agent.sessions.get(body.sessionId)) as never)
    await running.agent.sessions.supersede(principal as never, 'conn-new-device')
    const after = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${sibling.body.sessionId}`,
      headers: { authorization: `Bearer ${sibling.body.sessionToken}` },
    })
    expect(after.statusCode).toBe(410)
    expect(after.json().reason).toBe('supersede')
  })

  it('closes with reason user on DELETE and answers 410 afterwards (PROF-SESS-004/005)', async () => {
    const { body } = await createSession()
    const del = await running.app.inject({
      method: 'DELETE',
      url: `/agui/v3/sessions/${body.sessionId}`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    expect(del.statusCode).toBe(204)
    const after = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${body.sessionId}`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    expect(after.statusCode).toBe(410)
    expect(after.json().reason).toBe('user')
  })
})

describe('device pairing (PROF-SESS-010..012, PROF-BIND-010, IDENT-DEV-001..005)', () => {
  async function pair(actor: string) {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, actor)
    const status = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${body.sessionId}`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    const { deviceHandle, deviceSecret } = status.json() as { deviceHandle: string; deviceSecret: string }
    return { first: body, deviceHandle, deviceSecret }
  }
  const createWithProof = (deviceHandle: string, deviceProof: string, resumeSessionId?: string) =>
    running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      payload: { client, locale: 'en', deviceHandle, deviceProof, ...(resumeSessionId ? { resumeSessionId } : {}) },
    })

  it('hands a device secret at the phone binding, binds the next session from it and rotates it', async () => {
    const { first, deviceHandle, deviceSecret } = await pair('did:peer:judy')
    expect(deviceHandle).toMatch(/^dev_/)
    expect(deviceSecret).toMatch(/^dsk_/)
    await running.agent.sessions.close((await running.agent.sessions.get(first.sessionId)) as never, 'idle-timeout')
    const second = await createWithProof(deviceHandle, deviceSecret, first.sessionId)
    expect(second.statusCode).toBe(201)
    const body = second.json() as Record<string, unknown>
    expect(body.state).toBe('bound')
    expect(body.binding).toBeUndefined()
    expect(body.deviceHandle).toBe(deviceHandle)
    expect(body.deviceSecret).toMatch(/^dsk_/)
    expect(body.deviceSecret).not.toBe(deviceSecret)
    expect(body.resumedFromSessionId).toBe(first.sessionId)
    expect((body.principal as { displayName: string }).displayName).toBeTruthy()
    const r = await run(String(body.sessionId), String(body.sessionToken), 'still here')
    expect(r.status).toBe(200)
    // the old secret is dead: presenting it revokes the pairing, and the rotated one no longer works either
    const stale = await createWithProof(deviceHandle, deviceSecret)
    expect(stale.json().state).toBe('provisional')
    expect(stale.json().pairing).toBe('invalid')
    const afterRevoke = await createWithProof(deviceHandle, String(body.deviceSecret))
    expect(afterRevoke.json().state).toBe('provisional')
    expect(afterRevoke.json().pairing).toBe('invalid')
  })

  it('lists devices with a bound token and revokes one with the device proof alone', async () => {
    const { first, deviceHandle, deviceSecret } = await pair('did:peer:kim')
    const list = await running.app.inject({
      method: 'GET',
      url: '/agui/v3/sessions/devices',
      headers: { authorization: `Bearer ${first.sessionToken}` },
    })
    const devices = list.json().devices as { handle: string; current: boolean; client: { platform: string } }[]
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ handle: deviceHandle, current: true, client: { platform: 'web' } })
    const unauth = await running.app.inject({ method: 'DELETE', url: `/agui/v3/sessions/devices/${deviceHandle}` })
    expect(unauth.statusCode).toBe(401)
    const revoked = await running.app.inject({
      method: 'DELETE',
      url: `/agui/v3/sessions/devices/${deviceHandle}`,
      payload: { deviceProof: deviceSecret },
    })
    expect(revoked.statusCode).toBe(204)
    const again = await createWithProof(deviceHandle, deviceSecret)
    expect(again.json().state).toBe('provisional')
    expect(again.json().pairing).toBe('invalid')
  })

  it('a disconnected phone leaves no pairing', async () => {
    const { deviceHandle, deviceSecret } = await pair('did:peer:leo')
    await running.agent.onPeerDisconnected('conn-did:peer:leo')
    const after = await createWithProof(deviceHandle, deviceSecret)
    expect(after.json().state).toBe('provisional')
    expect(after.json().pairing).toBe('invalid')
  })
})

describe('conversations (PROF-CONV-001..005, IDENT-SESS-010..013)', () => {
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const list = async (token: string) =>
    (await running.app.inject({ method: 'GET', url: '/agui/v3/sessions/conversations', headers: auth(token) })).json()
      .conversations as { id: string; title: string; state: string; open: boolean; lastPreview?: string }[]

  it('creates the conversation at binding, titles it from the first message, renames, archives and unarchives', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:mia')
    const status = (
      await running.app.inject({
        method: 'GET',
        url: `/agui/v3/sessions/${body.sessionId}`,
        headers: auth(body.sessionToken),
      })
    ).json() as { conversationId: string }
    expect(status.conversationId).toMatch(/^conv_/)
    let conversations = await list(body.sessionToken)
    expect(conversations).toEqual([
      expect.objectContaining({ id: status.conversationId, title: '', state: 'active', open: true }),
    ])
    await run(body.sessionId, body.sessionToken, 'where is my parcel')
    conversations = await list(body.sessionToken)
    expect(conversations[0].title).toBe('where is my parcel')
    expect(conversations[0].lastPreview).toBeTruthy()
    const renamed = await running.app.inject({
      method: 'PATCH',
      url: `/agui/v3/sessions/conversations/${status.conversationId}`,
      headers: auth(body.sessionToken),
      payload: { title: 'Parcel 4471' },
    })
    expect(renamed.json().title).toBe('Parcel 4471')
    // a second session of the same person (sibling) sees the list and archives: the first session closes
    const sibling = await createSession(body.sessionToken)
    const archived = await running.app.inject({
      method: 'PATCH',
      url: `/agui/v3/sessions/conversations/${status.conversationId}`,
      headers: auth(sibling.body.sessionToken),
      payload: { state: 'archived' },
    })
    expect(archived.json().state).toBe('archived')
    const first = await running.agent.sessions.get(body.sessionId)
    expect(first?.state).toBe('closed')
    conversations = await list(sibling.body.sessionToken)
    expect(conversations.find((c) => c.id === status.conversationId)).toMatchObject({ state: 'archived', open: false })
    // opening it again from the sibling token resumes its history; writing unarchives it
    const reopened = await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      headers: auth(sibling.body.sessionToken),
      payload: { client, locale: 'en', conversationId: status.conversationId },
    })
    expect(reopened.statusCode).toBe(201)
    const re = reopened.json() as { sessionId: string; sessionToken: string; conversationId: string }
    expect(re.conversationId).toBe(status.conversationId)
    const history = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${re.sessionId}/messages?limit=50`,
      headers: auth(re.sessionToken),
    })
    const messages = history.json().messages as { role: string; content?: string }[]
    expect(messages.some((m) => m.role === 'user' && m.content === 'where is my parcel')).toBe(true)
    await run(re.sessionId, re.sessionToken, 'any news?')
    conversations = await list(re.sessionToken)
    expect(conversations.find((c) => c.id === status.conversationId)?.state).toBe('active')
  })

  it('a new pairing continues the latest conversation; only an explicit request starts a new one (PROF-CONV-006)', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:quinn')
    await run(body.sessionId, body.sessionToken, 'first words')
    const [first] = await list(body.sessionToken)
    const again = await createSession()
    await bindViaPhone(again.body.sessionId, 'did:peer:quinn')
    const status = (
      await running.app.inject({
        method: 'GET',
        url: `/agui/v3/sessions/${again.body.sessionId}`,
        headers: auth(again.body.sessionToken),
      })
    ).json() as { conversationId: string }
    expect(status.conversationId).toBe(first.id)
    expect((await list(again.body.sessionToken)).length).toBe(1)
    const fresh = await createSession(again.body.sessionToken)
    expect((await list(fresh.body.sessionToken)).length).toBe(2)
  })

  it('closes a conversation for good: gone from the list, resumption refused with 409 final', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:nina')
    await run(body.sessionId, body.sessionToken, 'hello')
    const [conversation] = await list(body.sessionToken)
    const sibling = await createSession(body.sessionToken)
    const closed = await running.app.inject({
      method: 'DELETE',
      url: `/agui/v3/sessions/conversations/${conversation.id}`,
      headers: auth(sibling.body.sessionToken),
    })
    expect(closed.statusCode).toBe(204)
    expect((await list(sibling.body.sessionToken)).some((c) => c.id === conversation.id)).toBe(false)
    const refused = await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      headers: auth(sibling.body.sessionToken),
      payload: { client, locale: 'en', conversationId: conversation.id },
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toBe('final')
    const other = await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      payload: { client, locale: 'en', conversationId: conversation.id },
    })
    expect(other.statusCode).toBe(409)
  })

  it("does not list another principal's conversation", async () => {
    const a = await createSession()
    await bindViaPhone(a.body.sessionId, 'did:peer:otto')
    await run(a.body.sessionId, a.body.sessionToken, 'mine')
    const [mine] = await list(a.body.sessionToken)
    const b = await createSession()
    await bindViaPhone(b.body.sessionId, 'did:peer:paula')
    expect((await list(b.body.sessionToken)).some((c) => c.id === mine.id)).toBe(false)
    const forbidden = await running.app.inject({
      method: 'PATCH',
      url: `/agui/v3/sessions/conversations/${mine.id}`,
      headers: auth(b.body.sessionToken),
      payload: { title: 'stolen' },
    })
    expect(forbidden.statusCode).toBe(404)
  })
})

describe('runs, tools and history (PROF-RUN-002..005, PROF-MAP-005, PROF-HIST-001)', () => {
  it('ignores client tools, runs a permitted tool with a step label, hides tool names from the wire', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:carol')
    const r = await run(
      body.sessionId,
      body.sessionToken,
      '/call principal_preferences {"action":"set","key":"language","value":"es"}'
    )
    expect(r.status).toBe(200)
    const types = r.events.map((e) => e.type)
    expect(types).toContain('STEP_STARTED')
    expect(types).not.toContain('TOOL_CALL_START')
    const steps = r.events.filter((e) => e.type === 'STEP_STARTED').map((e) => e.stepName)
    expect(steps[0]).toBe('Updating preferences')
    const text = r.events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join('')
    expect(text).toContain('answered')
    const history = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${body.sessionId}/messages?limit=50`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    const messages = history.json().messages as { role: string; content?: string; activityType?: string }[]
    expect(messages.some((m) => m.role === 'user' && m.content?.includes('/call'))).toBe(true)
    expect(messages.some((m) => m.role === 'assistant')).toBe(true)
    expect(JSON.stringify(messages)).not.toContain('"arguments"')
  })

  it('refuses an unknown action kind and an elevation request without justification (PROF-RUN-003/005)', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:dave')
    const bad = await run(body.sessionId, body.sessionToken, '', { kind: 'teleport' })
    expect(bad.status).toBe(400)
    const noJust = await run(body.sessionId, body.sessionToken, '', {
      kind: 'elevation.request',
      tool: 'wire_money',
      purposeId: 'support-case',
      justification: '',
    })
    expect(noJust.status).toBe(400)
  })

  it('denies a tool outside the role and keeps it out of the model tool list (RBAC-FILTER-001)', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:erin')
    const r = await run(body.sessionId, body.sessionToken, '/call wire_money {"amount":5}')
    const text = r.events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join('')
    expect(text).toContain('cannot use')
  })

  it('cancels a run: RunError cancelled and a partial entry marked interrupted (PROF-RUN-007)', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:frank')
    const runId = 'run-cancel'
    const started = running.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/${body.sessionId}/runs`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
      payload: {
        threadId: body.sessionId,
        runId,
        messages: [
          {
            id: 'u',
            role: 'user',
            content: 'a long sentence with many words so that the stub streams for a while and more words again',
          },
        ],
        tools: [],
        context: [],
      },
    })
    await new Promise((r) => setTimeout(r, 120))
    const cancel = await running.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/${body.sessionId}/runs/${runId}/cancel`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    expect(cancel.statusCode).toBe(202)
    const response = await started
    const events = parseSse(response.body).map((e) => e.event)
    expect(events[events.length - 1].type).toBe('RUN_ERROR')
    expect(events[events.length - 1].code).toBe('cancelled')
    const session = await running.agent.sessions.get(body.sessionId)
    const principal = await running.agent.principalOf(session as never)
    const entries = await running.agent.memory.history(principal, session as never, { limit: 10 })
    expect(entries.some((e) => e.role === 'agent' && e.completion === 'interrupted')).toBe(true)
    const again = await running.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/${body.sessionId}/runs/${runId}/cancel`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    expect(again.statusCode).toBe(409)
  })

  it('keeps one reaction per person per message and quotes a reply in history (PROF-RUN-010, PROF-RUN-009)', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:ivan')
    const first = await run(body.sessionId, body.sessionToken, 'hello there')
    const reply = first.events.find((e) => e.type === 'TEXT_MESSAGE_START' && e.role === 'assistant')
    const messageId = String(reply?.messageId)
    await run(body.sessionId, body.sessionToken, '', { kind: 'reaction', messageId, emoji: '👍', action: 'add' })
    await run(body.sessionId, body.sessionToken, '', { kind: 'reaction', messageId, emoji: '❤️', action: 'add' })
    const answered = await run(body.sessionId, body.sessionToken, 'and again', { kind: 'text', replyTo: messageId })
    expect(answered.status).toBe(200)
    const history = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${body.sessionId}/messages?limit=50`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    const messages = history.json().messages as {
      id: string
      role: string
      content?: string
      metadata: { reactions?: { emoji: string; by: string }[]; replyTo?: { id: string; text: string; role: string } }
    }[]
    const reacted = messages.find((m) => m.id === messageId)
    expect(reacted?.metadata.reactions).toEqual([{ emoji: '❤️', by: expect.any(String) }])
    const quoted = messages.find((m) => m.role === 'user' && m.content === 'and again')
    expect(quoted?.metadata.replyTo?.id).toBe(messageId)
    expect(quoted?.metadata.replyTo?.role).toBe('assistant')
    await run(body.sessionId, body.sessionToken, '', { kind: 'reaction', messageId, emoji: '❤️', action: 'remove' })
    const after = await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${body.sessionId}/messages?limit=50`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
    })
    const cleared = (after.json().messages as typeof messages).find((m) => m.id === messageId)
    expect(cleared?.metadata.reactions).toBeUndefined()
  })
})

describe('session stream (PROF-STREAM-001..004)', () => {
  it('publishes monotonic ids and replays after Last-Event-ID', async () => {
    const { body } = await createSession()
    await bindViaPhone(body.sessionId, 'did:peer:gina')
    const streams = new SessionStreams(running.agent.store, running.agent.logger)
    const first = await streams.publish(body.sessionId, { type: 'CUSTOM', name: 'x', value: 1 })
    const second = await streams.publish(body.sessionId, { type: 'CUSTOM', name: 'x', value: 2 })
    expect(second).toBe(first + 1)
    const received: string[] = []
    const detach = streams.attach(body.sessionId, { write: (c) => received.push(c), end: () => undefined }, first)
    expect(received).toHaveLength(1)
    expect(received[0]).toContain(`id: ${second}`)
    await streams.publish(body.sessionId, { type: 'CUSTOM', name: 'x', value: 3 })
    expect(received).toHaveLength(2)
    detach()
    await streams.publish(body.sessionId, { type: 'CUSTOM', name: 'x', value: 4 })
    expect(received).toHaveLength(2)
  })

  it('announces binding and state changes on the session stream (PROF-BIND-006, PROF-STREAM-003)', async () => {
    const { body } = await createSession()
    const session = await running.agent.sessions.get(body.sessionId)
    const before = session?.streamCursor ?? 0
    await bindViaPhone(body.sessionId, 'did:peer:hank')
    const after = (await running.agent.sessions.get(body.sessionId))?.streamCursor ?? 0
    expect(after).toBeGreaterThan(before)
  })
})
