/**
 * The speed of a turn, over the real agent (in-memory store, the stub model, with a script where a test needs one),
 * driven through the AG-UI profile: a reply that only saves memories or preferences ends with its saves (MEM-CTX-008),
 * the history it leaves is one every provider takes; what the agent keeps of the person rides on the turn's message,
 * after the history, so that a memory changed leaves the start of the next request as it was (MEM-CTX-007, LLM-CACHE-
 * 002); each model call is logged with its time to the first token, its duration and its stop reason, and nothing it
 * carried (LLM-USAGE-004).
 */
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { MessageEntry } from '../src/core/types.js'
import { AnthropicChatModel, toAnthropic } from '../src/llm/anthropic.js'
import { BedrockChatModel, toBedrockMessages } from '../src/llm/bedrock.js'
import { OllamaChatModel, toOllamaMessages } from '../src/llm/ollama.js'
import { OpenAiChatModel, toOpenAiMessages } from '../src/llm/openai.js'
import { measured } from '../src/llm/timing.js'
import type { ChatDelta, ChatMessage, ChatModel, ChatRequest } from '../src/llm/types.js'
import { estimateTokens } from '../src/util/tokens.js'
import { parseSse, testEnv } from './helpers.js'
import { type ScriptedModel, scripted } from './toolFixtures.js'

const client = { name: 'ayni-ui', version: '3.0.0', platform: 'web' }
const lines: Record<string, unknown>[] = []
let running: RunningAgent
let model: ScriptedModel

async function device(actor: string) {
  const created = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    payload: { client, locale: 'en' },
  })
  const body = created.json() as { sessionId: string; sessionToken: string }
  const session = await running.agent.sessions.get(body.sessionId)
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
  const conversationId = (await running.agent.sessions.get(body.sessionId))?.conversationId as string
  return { ...body, principal, conversationId }
}

type Device = Awaited<ReturnType<typeof device>>

async function run(d: Device, text: string) {
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
  return parseSse(response.body).map((e) => e.event)
}

async function entries(conversationId: string): Promise<MessageEntry[]> {
  const rows = await running.agent.store.entries.listAll({ conversationId, limit: 1000 })
  return rows.map((r) => running.agent.memory.open(r))
}

/** The model calls of a conversation's turns, as logged since `from`. */
const callsOf = (conversationId: string, from: number) =>
  lines.slice(from).filter((l) => l.msg === 'model call' && l.conversationId === conversationId)

const lastReply = async (conversationId: string) =>
  (await entries(conversationId)).filter((e) => e.role === 'agent' && e.sourceType === 'text').pop()

beforeAll(async () => {
  const logger = pino(
    { level: 'info' },
    { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) }
  )
  running = await buildAgent(testEnv(), logger, { drainMs: 200 })
  const minter = running.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
  minter.minter = {
    mint: async (id: string) => ({
      invitationId: `inv-${id}`,
      outOfBandId: `oob-${id}`,
      url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
    }),
  }
  model = scripted(running)
}, 30_000)

afterAll(async () => {
  await running?.stop()
})

describe('a reply that only saves memories or preferences ends with its saves (MEM-CTX-008)', () => {
  it('makes one model call, keeps the note, and still shows the memory line', async () => {
    const d = await device('did:peer:speed-one')
    const from = lines.length
    const events = await run(
      d,
      'Noted, I will keep it. /call working_memory {"action":"add","content":"likes green tea"}'
    )
    // one call: the answer held the reply and only a save (two before this change)
    expect(callsOf(d.conversationId, from)).toHaveLength(1)
    const reply = await lastReply(d.conversationId)
    expect(reply?.text).toBe('Noted, I will keep it.')
    expect((reply?.payload?.usage as { calls: number } | undefined)?.calls).toBe(1)
    // the note is kept, and the line of the memory is sent live and kept in history (MEM-SPACE-005)
    const notes = await running.agent.memory.notes(
      d.principal,
      (await running.agent.sessions.get(d.sessionId)) as never
    )
    expect(notes.map((n) => n.content)).toEqual(['likes green tea'])
    const live = events.find((e) => e.type === 'CUSTOM' && e.name === 'ayni.memory.updated')
    expect(live?.value).toMatchObject({ memoryId: notes[0]?.id, action: 'added' })
    const line = (await entries(d.conversationId)).find((e) => e.sourceType === 'state-update')
    expect(line?.payload).toMatchObject({ kind: 'memory', memoryId: notes[0]?.id, action: 'added' })
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
  })

  it('ends after a note and a preference saved together in one answer', async () => {
    const d = await device('did:peer:speed-two')
    const from = lines.length
    const requests = model.requests.length
    model.script = [
      {
        say: 'Got it: green tea, and short answers.',
        calls: [
          { name: 'working_memory', arguments: { action: 'add', content: 'drinks green tea' } },
          { name: 'principal_preferences', arguments: { action: 'set', key: 'tone', value: 'brief' } },
        ],
      },
    ]
    await run(d, 'I drink green tea, and keep it short.')
    expect(model.requests.length).toBe(requests + 1)
    expect(callsOf(d.conversationId, from)).toHaveLength(1)
    expect((await lastReply(d.conversationId))?.text).toBe('Got it: green tea, and short answers.')
    const session = (await running.agent.sessions.get(d.sessionId)) as never
    expect((await running.agent.memory.preferences(d.principal, session)).map((p) => [p.key, p.value])).toContainEqual([
      'tone',
      'brief',
    ])
  })

  it('goes on as before when the answer asks for anything else, has no reply, or a save fails', async () => {
    const cases: [string, string][] = [
      // a read of the preferences: the model reads its result
      ['reads', 'Let me look. /call principal_preferences {"action":"get"}'],
      // a save with no reply yet: the reply comes after it
      ['no reply', '/call working_memory {"action":"add","content":"has a dog"}'],
      // a save that fails: the model reads why
      ['fails', 'Changed. /call working_memory {"action":"update","id":"wm_missing","content":"x"}'],
    ]
    for (const [what, text] of cases) {
      const d = await device(`did:peer:speed-${what.replace(' ', '-')}`)
      const from = lines.length
      await run(d, text)
      expect(callsOf(d.conversationId, from), what).toHaveLength(2)
    }
    // a save beside a tool whose result the model reads
    const d = await device('did:peer:speed-mixed')
    const from = lines.length
    model.script = [
      {
        say: 'Noted; checking your credentials.',
        calls: [
          { name: 'working_memory', arguments: { action: 'add', content: 'asked about credentials' } },
          { name: 'principal_credentials', arguments: {} },
        ],
      },
      { text: 'Nothing was presented yet.' },
    ]
    await run(d, 'What do you know about me?')
    expect(callsOf(d.conversationId, from)).toHaveLength(2)
  })
})

// ---- the history the next turn sends, as each provider's adapter writes it ---------------------------------------------

/** Every tool call answered by the next messages, before anything else (OpenAI chat completions, Kimi). */
function assertOpenAi(messages: ChatMessage[]): void {
  const wire = toOpenAiMessages(messages, false)
  expect(wire.filter((m) => m.role === 'system')).toHaveLength(1)
  expect(wire[0]?.role).toBe('system')
  for (let i = 0; i < wire.length; i++) {
    const m = wire[i] as { role: string; tool_calls?: { id: string }[] }
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue
    const answers = wire.slice(i + 1, i + 1 + m.tool_calls.length) as { role: string; tool_call_id?: string }[]
    expect(answers.map((a) => a.role)).toEqual(m.tool_calls.map(() => 'tool'))
    expect(answers.map((a) => a.tool_call_id)).toEqual(m.tool_calls.map((c) => c.id))
  }
  expect(wire.at(-1)?.role).toBe('user')
}

/**
 * User and assistant alternate, from a user message to the last, a user one; every tool use is answered in the next
 * message (Anthropic: no dangling tool_use; Bedrock Converse refuses two consecutive messages of one role).
 */
function assertAlternating(
  wire: { role: string; content: unknown }[],
  uses: (content: unknown) => string[],
  results: (content: unknown) => string[]
): void {
  expect(wire[0]?.role).toBe('user')
  expect(wire.at(-1)?.role).toBe('user')
  for (let i = 1; i < wire.length; i++) expect(wire[i]?.role, `message ${i}`).not.toBe(wire[i - 1]?.role)
  for (let i = 0; i < wire.length; i++) {
    const asked = uses(wire[i]?.content)
    if (asked.length) expect(results(wire[i + 1]?.content)).toEqual(asked)
  }
}

const blocks = (content: unknown) => (Array.isArray(content) ? (content as Record<string, unknown>[]) : [])

describe('the history a reply that ended with its saves leaves (MEM-CTX-008)', () => {
  it('is taken by every adapter at the next turn: each call answered, no dangling call, no two user messages', async () => {
    const d = await device('did:peer:speed-history')
    model.script = [
      {
        say: 'Noted.',
        calls: [
          { name: 'working_memory', arguments: { action: 'add', content: 'works nights' } },
          { name: 'principal_preferences', arguments: { action: 'set', key: 'tone', value: 'brief' } },
        ],
      },
    ]
    await run(d, 'I work nights; be brief.')
    await run(d, 'Remind me what you know.')
    const next = model.requests.at(-1) as ChatRequest
    // the two saves, each a call and its result, then the reply, then the new message
    const tail = next.messages.filter((m) => m.role !== 'system').slice(-6)
    expect(tail.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant', 'user'])

    assertOpenAi(next.messages)
    const anthropic = toAnthropic(next.messages, false)
    assertAlternating(
      anthropic.messages,
      (c) => blocks(c).flatMap((b) => (b.type === 'tool_use' ? [String(b.id)] : [])),
      (c) => blocks(c).flatMap((b) => (b.type === 'tool_result' ? [String(b.tool_use_id)] : []))
    )
    const bedrock = toBedrockMessages(next.messages, false)
    assertAlternating(
      bedrock.messages as { role: string; content: unknown }[],
      (c) => blocks(c).flatMap((b) => (b.toolUse ? [String((b.toolUse as { toolUseId: string }).toolUseId)] : [])),
      (c) => blocks(c).flatMap((b) => (b.toolResult ? [String((b.toolResult as { toolUseId: string }).toolUseId)] : []))
    )
    // Ollama names a result by its tool, in the order of the calls
    const ollama = toOllamaMessages(next.messages, false) as { role: string; tool_calls?: unknown[] }[]
    ollama.forEach((m, i) => {
      if (m.role === 'assistant' && m.tool_calls?.length)
        expect(ollama.slice(i + 1, i + 1 + m.tool_calls.length).map((r) => r.role)).toEqual(
          m.tool_calls.map(() => 'tool')
        )
    })
    expect(ollama.at(-1)?.role).toBe('user')
  })
})

// ---- what the agent keeps of the person, after the history ----------------------------------------------------------

describe('what the agent keeps of the person rides on the turn, after the history (MEM-CTX-007, LLM-CACHE-002)', () => {
  const prefix = (req: ChatRequest | undefined, length: number) => JSON.stringify(req?.messages.slice(0, length))

  it('leaves the start of the next request as it was, to the end of the history, when a memory changes', async () => {
    const d = await device('did:peer:speed-prefix')
    await run(d, 'Hello.')
    await run(d, 'A question about the shipment to Lyon.')
    // a request with a history: the first turn
    const first = model.requests.at(-1) as ChatRequest
    // a memory and a preference change in the turn between
    model.script = [
      {
        say: 'Noted.',
        calls: [
          { name: 'working_memory', arguments: { action: 'add', content: 'ships to Lyon every week' } },
          { name: 'principal_preferences', arguments: { action: 'set', key: 'tone', value: 'brief' } },
        ],
      },
    ]
    await run(d, 'I ship to Lyon every week; keep it short.')
    await run(d, 'And a third question.')
    const third = model.requests.at(-1) as ChatRequest
    // byte for byte: every system part and every message of the history of the first request
    const history = first.messages.length - 1
    expect(first.messages.slice(0, history).some((m) => m.role === 'assistant')).toBe(true)
    expect(prefix(third, history)).toBe(prefix(first, history))
    expect(JSON.stringify(third.tools)).toBe(JSON.stringify(first.tools))
    // what it keeps is on the turn's message, as a record of the system, and in no system part
    const turn = third.messages.at(-1)
    expect(turn?.role).toBe('user')
    const said = String(turn?.content)
    // after the record of who the person is (MEM-CTX-008), which opens the message
    expect(said).toMatch(
      /^\[system record, written by the system, not by the person and not by you: who the person is, as it stands at this message:\n[^\]]*\]\n\n\[system record, written by the system, not by the person and not by you: what you keep about the person, as it stands at this message:\nPreferences of the person: tone=brief\nWorking memory notes:\n- \[\S+\] ships to Lyon every week\]\n\n/
    )
    expect(said.endsWith('\n\nAnd a third question.')).toBe(true)
    const system = JSON.stringify(third.messages.filter((m) => m.role === 'system'))
    expect(system).not.toContain('Lyon every week')
    expect(system).not.toContain('tone=brief')
    // the person's earlier message in the history carries no copy of it
    expect(JSON.stringify(third.messages.slice(0, -1))).not.toContain('what you keep about the person')
  })

  it('is served from the cache to the end of the history (the stub caches by prefix, as Kimi does)', async () => {
    const d = await device('did:peer:speed-cache')
    await run(d, 'A first question, about the shipment to Lyon and its papers.')
    await run(d, 'Keep it. /call working_memory {"action":"add","content":"the shipment goes to Lyon"}')
    const from = lines.length
    await run(d, 'And now?')
    const [call] = callsOf(d.conversationId, from) as { cachedTokens: number }[]
    // the third turn's call is served from the cache for all the second sent before its message (the tools, the system
    // parts, the first turn), although a note was added between them: the stub caches the common start, as Kimi does
    const third = model.requests.at(-1) as ChatRequest
    const second = third.messages.findIndex((m) => m.role === 'user' && String(m.content).startsWith('Keep it.'))
    const before = JSON.stringify({ tools: third.tools ?? [], messages: third.messages.slice(0, second) })
    expect(call?.cachedTokens).toBeGreaterThanOrEqual(estimateTokens(before.slice(0, -2)))
  })
})

// ---- each call, measured ----------------------------------------------------------------------------------------------

describe('each model call is logged with its time, its stop reason and none of its content (LLM-USAGE-004)', () => {
  it('logs one line per call: provider, model, where, time to the first token, duration, counts, stop reason', async () => {
    const d = await device('did:peer:speed-log')
    const from = lines.length
    await run(d, 'Tell me about zanzibar-7781. /call working_memory {"action":"add","content":"kumquat-4412"}')
    await run(d, 'And about quokka-5530?')
    const calls = callsOf(d.conversationId, from)
    expect(calls).toHaveLength(2)
    for (const [round, line] of calls.entries()) {
      expect(line).toMatchObject({
        level: 30,
        provider: 'stub',
        model: 'echo',
        conversationId: d.conversationId,
        sessionId: d.sessionId,
        round: 0,
        outcome: 'completed',
        reported: true,
        stopReason: round === 0 ? 'tool_calls' : 'stop',
        toolCalls: round === 0 ? 1 : 0,
      })
      expect(line.firstTokenMs).toBeTypeOf('number')
      expect(line.durationMs as number).toBeGreaterThanOrEqual(line.firstTokenMs as number)
      for (const count of ['inputTokens', 'cachedTokens', 'cacheWriteTokens', 'outputTokens'])
        expect(line[count]).toBeTypeOf('number')
      expect(line.inputTokens as number).toBeGreaterThan(0)
    }
    // the stub writes word by word, 15 ms apart: the first token comes before the end
    expect((calls[1]?.durationMs as number) - (calls[1]?.firstTokenMs as number)).toBeGreaterThan(0)
    // nothing the calls carried, in any line of those turns: no words of the person or of the reply, no note, no tool
    const logged = JSON.stringify(lines.slice(from))
    for (const secret of ['zanzibar-7781', 'quokka-5530', 'kumquat-4412', 'working_memory', 'You said'])
      expect(logged).not.toContain(secret)
  })

  const fake = (deltas: ChatDelta[], opts: { pause?: number; fail?: boolean } = {}): ChatModel => ({
    id: 'openai-compatible/moonshotai/kimi-k3',
    multimodal: false,
    async *stream() {
      for (const delta of deltas) {
        if (opts.pause) await new Promise((resolve) => setTimeout(resolve, opts.pause))
        yield delta
      }
      if (opts.fail) throw new Error('provider down')
    },
  })

  it('measures the first token at the first sign of an answer, the end at the end, and why it stopped', async () => {
    let measure: Parameters<Parameters<typeof measured>[2]>[0] | undefined
    const deltas: ChatDelta[] = [
      { type: 'started' },
      { type: 'tool_call', call: { id: 'c1', name: 'working_memory', arguments: {} } },
      { type: 'stop', reason: 'tool_calls' },
      { type: 'usage', inputTokens: 6000, outputTokens: 40, cachedTokens: 5600, cacheWriteTokens: 0 },
    ]
    for await (const _ of measured(fake(deltas, { pause: 20 }), { messages: [] }, (m) => (measure = m))) {
      // read to the end
    }
    expect(measure).toMatchObject({
      provider: 'openai-compatible',
      model: 'moonshotai/kimi-k3',
      stopReason: 'tool_calls',
      toolCalls: 1,
      outcome: 'completed',
      usage: { inputTokens: 6000, cachedTokens: 5600 },
    })
    expect(measure?.firstTokenMs).toBeGreaterThanOrEqual(15)
    expect(measure?.durationMs).toBeGreaterThanOrEqual(75)
  })

  it('tells a failed call and a cancelled one, once each', async () => {
    const seen: string[] = []
    await expect(async () => {
      for await (const _ of measured(fake([{ type: 'text', text: 'a' }], { fail: true }), { messages: [] }, (m) =>
        seen.push(m.outcome)
      )) {
        // read
      }
    }).rejects.toThrow('provider down')
    const controller = new AbortController()
    for await (const _ of measured(
      fake([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
      { messages: [], signal: controller.signal },
      (m) => seen.push(m.outcome)
    )) {
      controller.abort()
      break
    }
    expect(seen).toEqual(['failed', 'cancelled'])
  })

  /** What an adapter streams, by type, for what its provider sent. */
  const kinds = async (llm: ChatModel) => {
    const out: string[] = []
    for await (const d of llm.stream({ messages: [{ role: 'user', content: 'hi' }] }))
      out.push(d.type === 'stop' ? `stop:${d.reason}` : d.type)
    return out
  }

  it('has each adapter tell when the answer began, before a tool call it passes on whole, and why it stopped', async () => {
    const kimi = new OpenAiChatModel(
      { provider: 'openai-compatible', model: 'kimi-k3', baseUrl: 'https://kimi.test/v1' },
      'test-key'
    )
    ;(kimi as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { choices: [{ delta: { role: 'assistant', content: '' } }] }
              yield { choices: [{ delta: { reasoning_content: 'the person wants' } }] }
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: 0, id: 'c1', function: { name: 'working_memory', arguments: '{' } }],
                    },
                  },
                ],
              }
              yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }
              yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
              yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }
            })(),
        },
      },
    }
    expect(await kinds(kimi)).toEqual(['started', 'tool_call', 'stop:tool_calls', 'usage'])

    const claude = new AnthropicChatModel({ provider: 'anthropic', model: 'claude' }, 'test-key')
    ;(claude as unknown as { client: unknown }).client = {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: 'message_start', message: {} }
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }
            yield { type: 'content_block_stop', index: 0 }
            yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
          })(),
      },
    }
    expect(await kinds(claude)).toEqual(['started', 'text', 'stop:end_turn', 'usage'])

    const bedrock = new BedrockChatModel({ provider: 'bedrock', model: 'm', provider_options: { region: 'eu-west-1' } })
    ;(bedrock as unknown as { client: unknown }).client = {
      send: async () => ({
        stream: (async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi' } } }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { messageStop: { stopReason: 'end_turn' } }
          yield { metadata: { usage: { inputTokens: 5, outputTokens: 1 } } }
        })(),
      }),
    }
    expect(await kinds(bedrock)).toEqual(['started', 'text', 'stop:end_turn', 'usage'])

    const ollama = new OllamaChatModel({ provider: 'ollama', model: 'm', baseUrl: 'http://ollama.test' })
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        [
          { message: { role: 'assistant', content: '', thinking: 'hm' } },
          { message: { role: 'assistant', content: 'Hi' } },
          {
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 5,
            eval_count: 1,
          },
        ]
          // NDJSON: every line ends with a line break
          .map((l) => `${JSON.stringify(l)}\n`)
          .join('')
      )) as typeof fetch
    try {
      expect(await kinds(ollama)).toEqual(['started', 'text', 'stop:stop', 'usage'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
