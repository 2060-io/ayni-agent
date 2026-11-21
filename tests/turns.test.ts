/**
 * Usage, the context figure, caching and erasure over the real agent (in-memory store, stub model), driven through
 * the AG-UI profile and the admin interface: LLM-USAGE-001..003, LLM-CACHE-001/002, MEM-CTX-001, PLAT-STATS-004,
 * PROF-DESC-008, PROF-STREAM-007/008, PROF-HIST-010, PRIV-ERASE-005/007/008, RBAC-XSESS-006; decision 60 (a person
 * deletes their message within its window, with the reply to it and the memories taken from it; no conversation
 * erasure).
 */
import { DESCRIPTOR_PATH } from '@ayni.org/ayni-agui-profile'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { MessageEntry } from '../src/core/types.js'
import { OpenAiChatModel, usageOf } from '../src/llm/openai.js'
import type { StubChatModel } from '../src/llm/stub.js'
import type { ChatDelta } from '../src/llm/types.js'
import { parseSse, testEnv } from './helpers.js'

const client = { name: 'ayni-ui', version: '3.0.0', platform: 'web' }
const lines: Record<string, unknown>[] = []
let running: RunningAgent

async function createSession() {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    payload: { client, locale: 'en' },
  })
  return response.json() as { sessionId: string; sessionToken: string }
}

async function bindViaPhone(sessionId: string, actor: string) {
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
    { name: 'Wallet', version: '2.5.0', platform: 'ios' }
  )
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  return principal
}

/** A device of the person, bound by the phone: the second one continues the conversation of the first. */
async function device(actor: string) {
  const body = await createSession()
  const principal = await bindViaPhone(body.sessionId, actor)
  return { ...body, principal }
}

async function run(s: { sessionId: string; sessionToken: string }, text: string, messageId = `u-${Math.random()}`) {
  const response = await running.app.inject({
    method: 'POST',
    url: `/agui/v3/sessions/${s.sessionId}/runs`,
    headers: { authorization: `Bearer ${s.sessionToken}` },
    payload: {
      threadId: s.sessionId,
      runId: `run-${Date.now()}-${Math.random()}`,
      messages: [{ id: messageId, role: 'user', content: text }],
      tools: [],
      context: [],
    },
  })
  return parseSse(response.body).map((e) => e.event)
}

const received = (sessionId: string) => {
  const chunks: string[] = []
  running.streams.attach(sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
  return parseSse(chunks.join('')).map((e) => e.event)
}

const history = async (s: { sessionId: string; sessionToken: string }) =>
  (
    await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${s.sessionId}/messages?limit=100`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
    })
  ).json().messages as { id: string; role: string; content: unknown; metadata: Record<string, unknown> }[]

async function conversationOfSession(sessionId: string): Promise<string> {
  return (await running.agent.sessions.get(sessionId))?.conversationId as string
}

async function entries(conversationId: string): Promise<MessageEntry[]> {
  const rows = await running.agent.store.entries.listAll({ conversationId, limit: 1000 })
  return rows.map((r) => running.agent.memory.open(r))
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

beforeAll(async () => {
  const logger = pino(
    { level: 'info' },
    { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) }
  )
  running = await buildAgent(testEnv({ statsEnabled: true }), logger, { drainMs: 200 })
  mintLocally(running)
}, 30_000)

afterAll(async () => {
  await running?.stop()
})

describe('the generic adapter with Kimi (LLM-USAGE-001, LLM-CACHE-001)', () => {
  it('reads the four counts of the final usage, the cache parts as parts of the input', () => {
    expect(
      usageOf({
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 } as never,
      })
    ).toEqual({ type: 'usage', inputTokens: 1200, outputTokens: 80, cachedTokens: 1000, cacheWriteTokens: 150 })
    expect(
      usageOf({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 4 } as never).cachedTokens
    ).toBe(4)
  })

  it('sends the conversation as prompt_cache_key and the lifetime as prompt_cache_options.ttl', async () => {
    const model = new OpenAiChatModel(
      { provider: 'openai-compatible', model: 'kimi-k3', baseUrl: 'https://kimi.test/v1' },
      'test-key'
    )
    let params: Record<string, unknown> = {}
    ;(model as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (p: Record<string, unknown>) => {
            params = p
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
              yield {
                choices: [],
                usage: {
                  prompt_tokens: 300,
                  completion_tokens: 1,
                  prompt_tokens_details: { cached_tokens: 256, cache_write_tokens: 44 },
                },
              }
            })()
          },
        },
      },
    }
    const deltas: ChatDelta[] = []
    for await (const d of model.stream({
      messages: [{ role: 'user', content: 'hi' }],
      cacheKey: 'conv_1',
      cacheTtl: '1h',
    }))
      deltas.push(d)
    expect(params.prompt_cache_key).toBe('conv_1')
    expect(params.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '1h' })
    expect(params.stream_options).toEqual({ include_usage: true })
    expect(deltas.find((d) => d.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 300,
      outputTokens: 1,
      cachedTokens: 256,
      cacheWriteTokens: 44,
    })
  })
})

describe('a turn measured (LLM-USAGE-002/003, PLAT-STATS-004, PROF-STREAM-007, PROF-DESC-008)', () => {
  it('keeps the usage with the reply, publishes the figure to every device, logs and counts each call', async () => {
    const laptop = await device('did:peer:usage')
    const phone = await device('did:peer:usage')
    const conversationId = await conversationOfSession(laptop.sessionId)
    expect(await conversationOfSession(phone.sessionId)).toBe(conversationId)
    const before = lines.length
    await run(laptop, 'Hello, how are you?')
    const reply = (await entries(conversationId)).filter((e) => e.role === 'agent' && e.sourceType === 'text').pop()
    const usage = reply?.payload?.usage as Record<string, number>
    expect(usage.calls).toBe(1)
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.contextTokens).toBe(usage.inputTokens)
    // the figure, the same on the other device (PROF-STREAM-007)
    const phoneSession = await running.agent.sessions.get(phone.sessionId)
    const state = await running.agent.ayniState(phoneSession as never)
    expect(state.context).toMatchObject({ used: usage.contextTokens, cached: usage.contextCached, max: 4000 })
    const snapshots = received(phone.sessionId).filter((e) => e.type === 'STATE_SNAPSHOT')
    const last = snapshots[snapshots.length - 1]?.snapshot as { ayni: { context?: { used: number } } }
    expect(last.ayni.context?.used).toBe(usage.contextTokens)
    // one log line per call (LLM-USAGE-002)
    const calls = lines.slice(before).filter((l) => l.msg === 'model call' && l.conversationId === conversationId)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ round: 0, inputTokens: usage.inputTokens, reported: true })
    // the statistics classes (PLAT-STATS-004)
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const statClass of ['llm-input', 'llm-cached', 'llm-cache-write', 'llm-output']) {
      const rows = (
        await running.app.inject({
          method: 'GET',
          url: `/stats?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z&statClass=${statClass}`,
        })
      ).json() as { count: number }[]
      expect(rows.reduce((n, r) => n + r.count, 0)).toBeGreaterThan(0)
    }
  })

  it('adds up the two calls of a turn that uses a tool, and logs two lines', async () => {
    const d = await device('did:peer:tools')
    const conversationId = await conversationOfSession(d.sessionId)
    const before = lines.length
    // a tool whose result the model reads (a reply that only saves a memory is one call, MEM-CTX-008)
    await run(d, 'let me look /call principal_credentials {}')
    const reply = (await entries(conversationId)).filter((e) => e.role === 'agent' && e.sourceType === 'text').pop()
    const usage = reply?.payload?.usage as Record<string, number>
    expect(usage.calls).toBe(2)
    const calls = lines.slice(before).filter((l) => l.msg === 'model call' && l.conversationId === conversationId)
    expect(calls.map((c) => c.round)).toEqual([0, 1])
    expect(usage.inputTokens).toBe((calls[0]?.inputTokens as number) + (calls[1]?.inputTokens as number))
  })
})

describe('a request that keeps its start (MEM-CTX-001, LLM-CACHE-001/002)', () => {
  it('begins the second turn with every message of the first but its last, sends tools sorted, and is cached', async () => {
    const d = await device('did:peer:prefix')
    const conversationId = await conversationOfSession(d.sessionId)
    const stub = running.agent.llm as StubChatModel
    await run(d, 'First question about the shipment to Lyon.')
    const first = stub.requests[stub.requests.length - 1]
    await run(d, 'And a second question.')
    const second = stub.requests[stub.requests.length - 1]
    expect(first?.cacheKey).toBe(conversationId)
    expect(second?.cacheKey).toBe(conversationId)
    expect(first?.cacheTtl).toBe('5m')
    const before = (first?.messages ?? []).slice(0, -1)
    expect(JSON.stringify(second?.messages.slice(0, before.length))).toBe(JSON.stringify(before))
    const names = (second?.tools ?? []).map((t) => t.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    const reply = (await entries(conversationId)).filter((e) => e.role === 'agent' && e.sourceType === 'text').pop()
    expect(((reply?.payload?.usage ?? {}) as Record<string, number>).cachedTokens).toBeGreaterThan(0)
  })
})

describe('the descriptor (PROF-DESC-008, decision 60)', () => {
  it('declares context and the deletion window', async () => {
    const descriptor = await running.app.inject({ method: 'GET', url: DESCRIPTOR_PATH })
    expect(descriptor.statusCode).toBe(200)
    expect(descriptor.json().features).toMatchObject({ context: true, erasure: { windowSeconds: 600 } })
  })
})

describe('a person deletes a message of theirs within its window (PRIV-ERASE-007/010..012, PROF-HIST-010, PROF-STREAM-008)', () => {
  const erase = (s: { sessionId: string; sessionToken: string }, id: string) =>
    running.app.inject({
      method: 'DELETE',
      url: `/agui/v3/sessions/${s.sessionId}/messages/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
    })
  const erasedEvents = (sessionId: string, from: number) =>
    received(sessionId)
      .slice(from)
      .filter((e) => e.type === 'CUSTOM' && e.name === 'ayni.messages.erased')

  it('deletes it by the client id with the reply to it, tells every device, and refuses a message of the agent', async () => {
    const laptop = await device('did:peer:erase')
    const phone = await device('did:peer:erase')
    const conversationId = await conversationOfSession(laptop.sessionId)
    await run(laptop, 'My door code is 4412.', 'u-door')
    const all = await entries(conversationId)
    const own = all.find((e) => e.text === 'My door code is 4412.') as MessageEntry
    // the reply names the message it answers
    const reply = all.find((e) => e.role === 'agent' && e.payload?.inboundId === own.id) as MessageEntry
    expect(reply.text).toContain('4412')
    const seen = received(phone.sessionId).length
    expect((await erase(laptop, reply.id)).statusCode).toBe(404)
    expect((await erase(laptop, 'msg_unknown')).statusCode).toBe(404)
    expect((await erase(laptop, 'u-door')).statusCode).toBe(204)
    for (const id of [own.id, reply.id]) {
      const stored = await running.agent.store.entries.get(id)
      expect(stored?.state).toBe('crypto-erased')
      expect(running.agent.memory.open(stored as never).text).toBe('[erased]')
    }
    const left = await history(phone)
    expect(left.some((m) => m.id === own.id || m.id === reply.id)).toBe(false)
    const told = erasedEvents(phone.sessionId, seen)
    expect(told).toHaveLength(1)
    expect(told[0]?.value).toEqual({ conversationId, messageIds: [own.id, reply.id], clientIds: ['u-door'] })
    // a second deletion, from another device, finds it deleted already and tells nobody again
    expect((await erase(phone, own.id)).statusCode).toBe(204)
    expect(erasedEvents(phone.sessionId, seen)).toHaveLength(1)
  })

  it("deletes with it the turn's tool calls, its memory line and the memory taken from it (not flagged)", async () => {
    const d = await device('did:peer:cascade')
    const conversationId = await conversationOfSession(d.sessionId)
    await run(d, 'remember /call working_memory {"action":"add","content":"lives in Lyon"}', 'u-note')
    const all = await entries(conversationId)
    const message = all.find((e) => e.role === 'principal' && e.text.includes('remember')) as MessageEntry
    const call = all.find((e) => e.sourceType === 'tool-call') as MessageEntry
    expect((call.payload as { inboundId?: string }).inboundId).toBe(message.id)
    const line = all.find((e) => e.sourceType === 'state-update' && e.payload?.kind === 'memory') as MessageEntry
    expect(line.payload).toMatchObject({ action: 'added', inboundId: message.id })
    // the store holds the note sealed (D77): found by its lineage, its content only in the ciphertext
    const note = (await running.agent.store.notes.list(d.principal.id)).find((n) => n.lineageRefs.includes(message.id))
    expect(note?.lineageRefs).toEqual([message.id])
    expect(note?.content).toBe('')
    expect(JSON.stringify(note)).not.toContain('Lyon')
    const seen = received(d.sessionId).length
    expect((await erase(d, message.id)).statusCode).toBe(204)
    for (const id of [message.id, call.id, line.id])
      expect((await running.agent.store.entries.get(id))?.state).toBe('crypto-erased')
    const replies = all.filter(
      (e) => e.role === 'agent' && e.sourceType === 'text' && e.payload?.inboundId === message.id
    )
    expect(replies.length).toBeGreaterThan(0)
    for (const r of replies) expect((await running.agent.store.entries.get(r.id))?.state).toBe('crypto-erased')
    // the memory is gone, not flagged (decision 60; the operator's erasure flags, PRIV-ERASE-005)
    expect((await running.agent.store.notes.list(d.principal.id)).some((n) => n.id === note?.id)).toBe(false)
    const told = erasedEvents(d.sessionId, seen)
    // the memory goes without a line of its own (PRIV-ERASE-012); the announcement names the messages (PROF-STREAM-008)
    expect(Object.keys(told[0]?.value as object).sort()).toEqual(['clientIds', 'conversationId', 'messageIds'])
    expect((told[0]?.value as { messageIds?: string[] } | undefined)?.messageIds).toEqual(
      expect.arrayContaining([message.id, call.id, line.id])
    )
  })

  it('refuses a message older than the window (409 window-passed) and leaves it as it is', async () => {
    const d = await device('did:peer:window')
    const conversationId = await conversationOfSession(d.sessionId)
    await run(d, 'an old message', 'u-old')
    const own = (await entries(conversationId)).find((e) => e.text === 'an old message') as MessageEntry
    await running.agent.store.entries.update(own.id, { createdAt: new Date(Date.now() - 601_000).toISOString() })
    const response = await erase(d, 'u-old')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'window-passed' })
    expect((await running.agent.store.entries.get(own.id))?.state).toBe('active')
  })

  it('cancels the turn that is writing its reply, then deletes the message and what the turn recorded', async () => {
    const d = await device('did:peer:busy')
    const conversationId = await conversationOfSession(d.sessionId)
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const pending = run(d, long, 'u-busy')
    let own: MessageEntry | undefined
    for (let i = 0; i < 100 && !own; i++) {
      await new Promise((r) => setTimeout(r, 10))
      own = (await entries(conversationId)).find((e) => e.role === 'principal' && e.text === long)
    }
    expect(own).toBeDefined()
    const seen = received(d.sessionId).length
    const response = await erase(d, 'u-busy')
    expect(response.statusCode).toBe(204)
    const events = await pending
    expect(events.some((e) => e.type === 'RUN_ERROR' && e.code === 'cancelled')).toBe(true)
    // the interrupted reply is erased with the message, and both are named in the announcement (PROF-STREAM-008)
    expect((await running.agent.store.entries.get(own?.id as string))?.state).toBe('crypto-erased')
    const told = erasedEvents(d.sessionId, seen)
    const ids = (told[0]?.value as { messageIds?: string[] } | undefined)?.messageIds ?? []
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(own?.id)
    const reply = await running.agent.store.entries.get(ids[1] as string)
    expect(reply).toMatchObject({ role: 'agent', completion: 'interrupted', state: 'crypto-erased' })
  })

  it('takes a message that waits for its turn off the list: nothing answers it', async () => {
    const d = await device('did:peer:waits')
    const conversationId = await conversationOfSession(d.sessionId)
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
    const first = run(d, long, 'u-first')
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 10))
      if ((await entries(conversationId)).some((e) => e.role === 'principal' && e.text === long)) break
    }
    await run(d, 'never mind this one', 'u-waits')
    const waiting = (await entries(conversationId)).find((e) => e.text === 'never mind this one') as MessageEntry
    expect(waiting).toBeDefined()
    expect((await erase(d, 'u-waits')).statusCode).toBe(204)
    await first
    await new Promise((r) => setTimeout(r, 100))
    const after = await entries(conversationId)
    expect(after.some((e) => e.role === 'agent' && e.payload?.inboundId === waiting.id)).toBe(false)
    const session = await running.agent.sessions.get(d.sessionId)
    expect(await running.agent.waitingOf(session as never)).toEqual([])
  })

  it('with a window of 0, declares no erasure (PRIV-ERASE-010, PROF-DESC-008)', async () => {
    process.env.MESSAGE_DELETION_WINDOW_SECONDS = '0'
    const none = await buildAgent(testEnv(), pino({ level: 'silent' }), { drainMs: 100 })
    delete process.env.MESSAGE_DELETION_WINDOW_SECONDS
    try {
      const descriptor = await none.app.inject({ method: 'GET', url: DESCRIPTOR_PATH })
      expect(descriptor.json().features.erasure).toBeUndefined()
      expect(none.agent.pack.conversations?.messageDeletionWindowSeconds).toBe(0)
    } finally {
      await none.stop()
    }
  })

  it('cannot erase a whole conversation any more: an operator does, through the admin interface', async () => {
    const d = await device('did:peer:whole')
    const conversationId = await conversationOfSession(d.sessionId)
    await run(d, 'one')
    const response = await running.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/conversations/${conversationId}/erasure`,
      headers: { authorization: `Bearer ${d.sessionToken}` },
    })
    expect(response.statusCode).toBe(404)
    expect((await history(d)).some((m) => m.role === 'user')).toBe(true)
  })
})

describe('the admin interface (PRIV-ERASE-008, RBAC-XSESS-006)', () => {
  const admin = () => running.admin as NonNullable<RunningAgent['admin']>

  it('requires an operator and a reason', async () => {
    const response = await admin().inject({ method: 'POST', url: '/admin/erasure', payload: { entryIds: ['x'] } })
    expect(response.statusCode).toBe(400)
  })

  it('holds, refuses the erasure on hold, releases, erases, and records every call', async () => {
    const d = await device('did:peer:hold')
    const conversationId = await conversationOfSession(d.sessionId)
    await run(d, 'Keep this for the court case.', 'u-court')
    const message = (await entries(conversationId)).find(
      (e) => e.text === 'Keep this for the court case.'
    ) as MessageEntry
    const held = await admin().inject({
      method: 'POST',
      url: '/admin/legal-hold',
      payload: { operator: 'ops@example.org', reason: 'case 42', hold: true, entryIds: [message.id] },
    })
    expect(held.json().changed).toEqual([message.id])
    // the person's erasure is refused on hold (PROF-HIST-010), and counted held for the conversation (PROF-CONV-009)
    const refused = await running.app.inject({
      method: 'DELETE',
      url: `/agui/v3/sessions/${d.sessionId}/messages/u-court`,
      headers: { authorization: `Bearer ${d.sessionToken}` },
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toEqual({ error: 'legal-hold' })
    const byOperator = await admin().inject({
      method: 'POST',
      url: '/admin/erasure',
      payload: { operator: 'ops@example.org', reason: 'request 7', entryIds: [message.id] },
    })
    expect(byOperator.json()).toMatchObject({ erased: [], held: [message.id] })
    await admin().inject({
      method: 'POST',
      url: '/admin/legal-hold',
      payload: { operator: 'ops@example.org', reason: 'case closed', hold: false, conversationId },
    })
    const erased = await admin().inject({
      method: 'POST',
      url: '/admin/erasure',
      payload: { operator: 'ops@example.org', reason: 'request 7', entryIds: [message.id] },
    })
    expect(erased.json().erased).toContain(message.id)
    // the auditor reads the conversation: the erased message keeps its audit fields, not its text
    const read = await admin().inject({
      method: 'GET',
      url: `/admin/audit/entries?conversationId=${conversationId}`,
      headers: { 'x-ayni-auditor': 'auditor@example.org', 'x-ayni-reason': 'quarterly audit' },
    })
    const view = (read.json().entries as Record<string, unknown>[]).find((e) => e.id === message.id)
    expect(view).toMatchObject({ state: 'crypto-erased', sourceType: 'text' })
    expect(view?.text).toBeUndefined()
    const log = await admin().inject({
      method: 'GET',
      url: '/admin/audit/log',
      headers: { 'x-ayni-auditor': 'auditor@example.org', 'x-ayni-reason': 'quarterly audit' },
    })
    const records = log.json().records as { action: string; actor: string; reason: string }[]
    for (const action of ['legal-hold', 'legal-hold-release', 'erasure', 'audit-read'])
      expect(records.some((r) => r.action === action && r.actor && r.reason)).toBe(true)
  })

  it('erases with the tool calls of its turn and flags the note that cites it, deletes no note (PRIV-ERASE-005)', async () => {
    const d = await device('did:peer:operator-flags')
    const conversationId = await conversationOfSession(d.sessionId)
    await run(d, 'remember /call working_memory {"action":"add","content":"lives in Lyon"}', 'u-op-note')
    const all = await entries(conversationId)
    const message = all.find((e) => e.role === 'principal' && e.text.includes('remember')) as MessageEntry
    const call = all.find((e) => e.sourceType === 'tool-call') as MessageEntry
    // older than the window: the person may not delete it any more, an operator may
    await running.agent.store.entries.update(message.id, { createdAt: new Date(Date.now() - 3_600_000).toISOString() })
    const response = await admin().inject({
      method: 'POST',
      url: '/admin/erasure',
      payload: { operator: 'ops@example.org', reason: 'request 12', entryIds: [message.id] },
    })
    expect(response.json().erased).toEqual(expect.arrayContaining([message.id, call.id]))
    const note = (await running.agent.store.notes.list(d.principal.id)).find((n) => n.lineageRefs.includes(message.id))
    expect(note?.needsRevision).toBe(true)
  })

  it('recomputes the last text of a conversation when its newest messages are erased (PRIV-ERASE-005, D77)', async () => {
    const d = await device('did:peer:preview')
    const conversationId = await conversationOfSession(d.sessionId)
    await run(d, 'first words')
    await run(d, 'words to forget')
    const list = async () =>
      (
        (
          await running.app.inject({
            method: 'GET',
            url: '/agui/v3/sessions/conversations',
            headers: { authorization: `Bearer ${d.sessionToken}` },
          })
        ).json().conversations as { id: string; lastPreview?: string }[]
      ).find((c) => c.id === conversationId)
    expect((await list())?.lastPreview).toContain('words to forget')
    const newest = (await entries(conversationId)).filter((e) => e.text.includes('words to forget')).map((e) => e.id)
    const erased = await admin().inject({
      method: 'POST',
      url: '/admin/erasure',
      payload: { operator: 'ops@example.org', reason: 'request 9', entryIds: newest },
    })
    expect(erased.json().erased).toEqual(expect.arrayContaining(newest))
    expect((await list())?.lastPreview).toContain('first words')
  })

  it('asks for the bearer token when one is set', async () => {
    const guarded = await buildAgent(testEnv({ adminToken: 'secret-token' }), pino({ level: 'silent' }), {
      drainMs: 100,
    })
    try {
      const guard = guarded.admin as NonNullable<RunningAgent['admin']>
      expect((await guard.inject({ method: 'GET', url: '/admin/health' })).statusCode).toBe(401)
      const ok = await guard.inject({
        method: 'GET',
        url: '/admin/health',
        headers: { authorization: 'Bearer secret-token' },
      })
      expect(ok.statusCode).toBe(200)
    } finally {
      await guarded.stop()
    }
  })
})
