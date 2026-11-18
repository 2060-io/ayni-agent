/**
 * The context of a turn (D74, D75, D76, MEM-CTX, MEM-TIER-004, MEM-RET-007, MEM-ENTRY-004) on the in-memory store,
 * with the stub model: the window moves in steps, the summary covers what is older than the window, an erasure makes
 * it again, a summarizer failure leaves the turn within the budget, recall excludes the window and says where an entry
 * comes from, and every session of a conversation reads all of it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { crossFieldErrors, loadPack } from '../src/config/pack.js'
import type { AgentPack } from '../src/config/packTypes.js'
import { type ContextAssembler as Assembler, ContextAssembler, summaryRecord } from '../src/core/context.js'
import { conversationOf } from '../src/core/conversationOf.js'
import type { MessageEntry, Principal, Session } from '../src/core/types.js'
import { createEmbeddings } from '../src/llm/embeddings.js'
import { StubChatModel } from '../src/llm/stub.js'
import type { ChatDelta, ChatMessage, ChatModel, ChatRequest } from '../src/llm/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryService } from '../src/memory/service.js'
import { NoopStats } from '../src/platform/stats.js'
import { MemoryStore } from '../src/store/memory.js'
import { createLogger } from '../src/util/logger.js'

const logger = createLogger('silent')

function packWith(memory: AgentPack['memory']): AgentPack {
  const { pack } = loadPack('agent-packs/dev', { ...process.env })
  return { ...pack, memory: { ...pack.memory, ...memory } }
}

const principal: Principal = {
  id: 'p1',
  connectionType: 'verifiable-user-agent',
  actorIdentity: 'did:peer:alice',
  backingIdentity: null,
  backingRelation: 'unrecognized',
  roles: [],
  identityAttributes: { userName: 'Alice' },
  capabilityChannelId: null,
  identityCredentialRef: null,
  livenessCache: {},
  userAgentVerified: false,
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
} as Principal

function session(id: string, conversationId?: string, rootSessionId?: string): Session {
  return {
    id,
    principalId: 'p1',
    channelType: 'ag-ui',
    state: 'bound',
    conversationId,
    rootSessionId,
  } as unknown as Session
}

interface Rig {
  store: MemoryStore
  memory: MemoryService
  context: Assembler
  llm: StubChatModel
  pack: AgentPack
}

async function rig(memoryConfig: AgentPack['memory'], llm: ChatModel = new StubChatModel()): Promise<Rig> {
  const pack = packWith(memoryConfig)
  const store = new MemoryStore()
  const crypto = createEntryCrypto(Buffer.alloc(32, 9))
  const memory = new MemoryService(store, crypto, createEmbeddings({ provider: 'stub', model: 'hash' }), pack, logger)
  const context = new ContextAssembler(pack, llm, memory, store.kv, crypto, new NoopStats(), logger)
  memory.hooks.conversationErased = (conversationId) => context.discardSummary(conversationId)
  await store.principals.save(principal)
  return { store, memory, context, llm: llm as StubChatModel, pack }
}

const render = (entry: MessageEntry): ChatMessage[] => [
  entry.role === 'agent' ? { role: 'assistant', content: entry.text } : { role: 'user', content: entry.text },
]

async function say(r: Rig, s: Session, text: string, role: 'principal' | 'agent' = 'principal', at?: number) {
  return r.memory.append({
    sessionId: s.id,
    principalId: 'p1',
    role,
    sourceType: 'text',
    text,
    backingIdentity: null,
    initiatedAt: at ? new Date(at).toISOString() : undefined,
  })
}

async function assemble(r: Rig, s: Session, text = 'next') {
  return r.context.assemble({
    principal,
    session: s,
    system: [{ role: 'system', content: 'You are a test agent.' }],
    tools: [],
    userTurn: { role: 'user', content: text },
    exclude: new Set(),
    render,
    retrievedReserve: 0,
  })
}

const base = Date.parse('2026-11-18T08:00:00.000Z')

describe('the window moves in steps (MEM-CTX-003)', () => {
  let r: Rig
  const s = session('s1', 'conv_a')
  beforeEach(async () => {
    r = await rig({ contextWindowTokens: 1200, summarization: { enabled: false }, window: { keepRatio: 0.5 } })
    await r.store.sessions.save(s)
  })

  it('keeps its first entry while the context fits, and drops the oldest in one step when it would not', async () => {
    const firsts: string[] = []
    let steps = 0
    for (let turn = 0; turn < 20; turn++) {
      await say(r, s, `message ${turn} ${'x'.repeat(400)}`, 'principal', base + turn * 2000)
      await say(r, s, `reply ${turn} ${'y'.repeat(400)}`, 'agent', base + turn * 2000 + 1000)
      const ctx = await assemble(r, s)
      if (ctx.stepped) steps++
      firsts.push((ctx.window[0] as MessageEntry).text.slice(0, 12))
    }
    // the first entry changes only at a step: never more often than there are steps
    const changes = firsts.filter((f, i) => i > 0 && f !== firsts[i - 1]).length
    expect(steps).toBeGreaterThan(1)
    expect(changes).toBeLessThanOrEqual(steps)
    expect(steps).toBeLessThan(20)
  })

  it('without summarization a step only drops: no summary record reaches the model', async () => {
    for (let turn = 0; turn < 12; turn++)
      await say(r, s, `fact ${turn} ${'z'.repeat(500)}`, 'principal', base + turn * 1000)
    const ctx = await assemble(r, s)
    expect(ctx.stepped).toBe(true)
    expect(
      ctx.messages.some((m) => typeof m.content === 'string' && m.content.includes('summary of the earlier part'))
    ).toBe(false)
  })

  it('drops by the same step the entries beyond the number the window reads', async () => {
    const few = await rig({
      contextWindowTokens: 100_000,
      summarization: { enabled: false },
      window: { maxEntries: 10, keepRatio: 0.5 },
    })
    await few.store.sessions.save(s)
    for (let i = 0; i < 14; i++) await say(few, s, `short ${i}`, 'principal', base + i * 1000)
    const ctx = await assemble(few, s)
    expect(ctx.stepped).toBe(true)
    expect(ctx.window.length).toBeLessThanOrEqual(5)
  })
})

describe('the conversation summary (MEM-CTX-004, MEM-CTX-005, MEM-TIER-004)', () => {
  const s = session('s1', 'conv_b')

  it('a fact stated only in a dropped entry is in the summary the model receives, after the system parts', async () => {
    const r = await rig({ contextWindowTokens: 1200, window: { keepRatio: 0.5 } })
    await r.store.sessions.save(s)
    await say(r, s, 'My order number is AX-4471 and it ships to Lyon.', 'principal', base)
    for (let i = 1; i < 10; i++) await say(r, s, `filler ${i} ${'f'.repeat(500)}`, 'principal', base + i * 1000)
    const ctx = await assemble(r, s)
    expect(ctx.window.some((e) => e.text.includes('AX-4471'))).toBe(false)
    const record = ctx.messages[1]
    expect(record?.role).toBe('user')
    expect(record?.content).toContain('summary of the earlier part of this conversation')
    expect(record?.content).toContain('AX-4471')
    // sealed apart from the entries, never an entry (MEM-TIER-004)
    const kept = await r.store.kv.get('summary:conv_b')
    expect(kept).toBeDefined()
    expect(kept).not.toContain('AX-4471')
    const rows = await r.store.entries.listAll({ conversationId: 'conv_b', limit: 1000 })
    expect(rows.every((row) => row.sourceType === 'text')).toBe(true)
  })

  it('after an erasure the next summary is rebuilt without the erased entry', async () => {
    const r = await rig({ contextWindowTokens: 1200, window: { keepRatio: 0.5 } })
    await r.store.sessions.save(s)
    const secret = await say(r, s, 'The door code is 9137.', 'principal', base)
    await say(r, s, 'The meeting is on Friday.', 'principal', base + 500)
    for (let i = 1; i < 10; i++) await say(r, s, `filler ${i} ${'f'.repeat(500)}`, 'principal', base + i * 1000)
    const first = await assemble(r, s)
    expect(first.messages[1]?.content).toContain('9137')
    await r.memory.erase(secret.id)
    expect(await r.store.kv.get('summary:conv_b')).toBeUndefined()
    const again = await assemble(r, s)
    expect(again.messages[1]?.content).not.toContain('9137')
    expect(again.messages[1]?.content).toContain('Friday')
  })

  it('a summarizer error leaves the turn within the budget, and the next step tries again', async () => {
    let fail = true
    const flaky: ChatModel = {
      id: 'flaky',
      multimodal: false,
      async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
        if (fail) throw new Error('model down')
        yield* new StubChatModel().stream(req)
      },
    }
    const r = await rig({ contextWindowTokens: 1200, window: { keepRatio: 0.5 } }, flaky)
    await r.store.sessions.save(s)
    await say(r, s, 'The parcel weighs 12 kg.', 'principal', base)
    for (let i = 1; i < 10; i++) await say(r, s, `filler ${i} ${'f'.repeat(500)}`, 'principal', base + i * 1000)
    const ctx = await assemble(r, s)
    expect(ctx.stepped).toBe(true)
    expect(
      ctx.messages.some((m) => typeof m.content === 'string' && m.content.includes('summary of the earlier'))
    ).toBe(false)
    const estimate = ctx.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length / 4 : 0), 0)
    expect(estimate).toBeLessThan(1200)
    fail = false
    const retried = await assemble(r, s)
    expect(retried.messages[1]?.content).toContain('12 kg')
  })

  it('tells the summary as a record of the system, with its span', () => {
    const text = summaryRecord({
      text: 'They asked for X.',
      count: 4,
      from: '2026-11-01T10:00:00Z',
      to: '2026-11-02T10:00:00Z',
    })
    expect(text.startsWith('[system record, written by the system, not by the person and not by you:')).toBe(true)
    expect(text).toContain('4 messages, 2026-11-01 to 2026-11-02')
  })
})

describe('the estimate is scaled by what the provider reported (MEM-CTX-002)', () => {
  it('keeps the ratio of the last call, within bounds', async () => {
    const r = await rig({ contextWindowTokens: 8000 })
    await r.context.calibrate('conv_c', 1500, 1000)
    expect(await r.context.factor('conv_c')).toBeCloseTo(1.5)
    await r.context.calibrate('conv_c', 9000, 1000)
    expect(await r.context.factor('conv_c')).toBe(3)
    expect(await r.context.factor('conv_unknown')).toBe(1)
  })
})

describe('a conversation is read whole, whatever its sessions (MEM-ENTRY-004, D76)', () => {
  it('a conversation served by forty sessions shows every one of its entries', async () => {
    const r = await rig({})
    const sessions = Array.from({ length: 40 }, (_, i) => session(`s${i}`, 'conv_many'))
    for (const s of sessions) await r.store.sessions.save(s)
    for (const [i, s] of sessions.entries()) await say(r, s, `from session ${i}`, 'principal', base + i * 1000)
    const history = await r.memory.history(principal, sessions[39] as Session, { limit: 200 })
    expect(history.length).toBe(40)
    expect(history.map((e) => e.text)).toContain('from session 0')
  })

  it('an entry of a session resumed twice carries the conversation of the first session', async () => {
    const r = await rig({})
    const first = session('d1')
    const second = { ...session('d2'), rootSessionId: 'd1' } as Session
    const third = { ...session('d3'), rootSessionId: 'd1' } as Session
    for (const s of [first, second, third]) await r.store.sessions.save(s)
    const entry = await say(r, third, 'hello again')
    expect(entry.conversationId).toBe('d1')
    expect(conversationOf(third)).toBe('d1')
    const history = await r.memory.history(principal, first, { limit: 10 })
    expect(history.map((e) => e.text)).toEqual(['hello again'])
  })
})

describe('recall (MEM-RET-007)', () => {
  it('never returns an entry of the window, and says where each entry comes from', async () => {
    const r = await rig({})
    const here = session('s1', 'conv_here')
    const there = session('s2', 'conv_there')
    for (const s of [here, there]) await r.store.sessions.save(s)
    const inWindow = await say(r, here, 'the invoice for the blue chairs')
    const older = await say(r, here, 'the invoice for the blue chairs, first draft')
    await r.memory.append({
      sessionId: there.id,
      principalId: 'p1',
      role: 'principal',
      sourceType: 'text',
      text: 'the invoice for the blue chairs, as I wrote elsewhere',
      backingIdentity: null,
      visibility: 'principal-private',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const recalled = await r.memory.recall(principal, here, 'the invoice for the blue chairs', 8, [inWindow.id])
    expect(recalled.some((x) => x.entry.id === inWindow.id)).toBe(false)
    expect(recalled.find((x) => x.entry.id === older.id)?.origin).toBe('this-conversation')
    expect(recalled.find((x) => x.entry.text.includes('elsewhere'))?.origin).toBe('another-conversation')
  })
})

describe('working memory and preferences go through the predicate, logged (PRIV-SCOPE-003/006)', () => {
  it('each read leaves one record naming its store', async () => {
    const r = await rig({})
    const s = session('s1', 'conv_n')
    await r.store.sessions.save(s)
    await r.memory.addNote(principal, 'prefers short answers', [])
    await r.store.preferences.set({
      principalId: 'p1',
      key: 'language',
      value: 'fr',
      updatedAt: new Date().toISOString(),
    })
    await r.store.notes.save({
      id: 'note_other',
      principalId: 'p2',
      content: 'someone else',
      visibility: 'principal-private',
      state: 'active',
      backingIdentity: null,
      lineageRefs: [],
      needsRevision: false,
      createdAt: '',
      updatedAt: '',
    })
    const notes = await r.memory.notes(principal, s)
    const prefs = await r.memory.preferences(principal, s)
    expect(notes.map((n) => n.content)).toEqual(['prefers short answers'])
    expect(prefs.map((p) => p.key)).toEqual(['language'])
    const logs = r.store.accessLog.all()
    expect(logs.filter((l) => l.store === 'working_memory').length).toBe(1)
    expect(logs.filter((l) => l.store === 'preferences').length).toBe(1)
    // a provisional session reads nothing
    expect(await r.memory.notes(principal, { ...s, state: 'provisional' } as Session)).toEqual([])
  })
})

describe('the model input limit (MEM-CTX-006)', () => {
  it('refuses a pack whose window budget plus output limit exceeds it, naming the three values', () => {
    const pack = packWith({ contextWindowTokens: 100_000 })
    const errors = crossFieldErrors({ ...pack, llm: { ...pack.llm, maxOutputTokens: 2048, maxInputTokens: 50_000 } })
    const rule = errors.find((e) => e.startsWith('rule 10'))
    expect(rule).toContain('100000')
    expect(rule).toContain('2048')
    expect(rule).toContain('50000')
    expect(
      crossFieldErrors({ ...pack, llm: { ...pack.llm, maxInputTokens: 1_000_000 } }).some((e) =>
        e.startsWith('rule 10')
      )
    ).toBe(false)
  })
})

describe('the erasure reaches the approvals of the turn (PRIV-ERASE-005)', () => {
  it('erases the arguments of an approval its turn asked for, and keeps its audit metadata', async () => {
    const r = await rig({})
    const s = session('s1', 'conv_apr')
    await r.store.sessions.save(s)
    const message = await say(r, s, 'refund order 77 to my card')
    await r.store.approvals.save({
      id: 'apr_1',
      kind: 'sensitivity',
      toolName: 'refund',
      actionArgs: { order: 77, card: '4111' },
      inboundId: message.id,
      requesterId: 'p1',
      requesterName: 'Alice',
      requesterRole: 'customer',
      originSessionId: 's1',
      policy: { type: 'count', value: 1, vetoOnRefusal: false },
      eligibleRoles: ['manager'],
      decisions: [],
      status: 'PENDING',
      vetoed: false,
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    } as never)
    await r.memory.erase(message.id)
    const approval = await r.store.approvals.get('apr_1')
    expect(approval?.actionArgs).toBeUndefined()
    expect(approval?.argsErased).toBe(true)
    expect(approval?.toolName).toBe('refund')
    expect(approval?.requesterId).toBe('p1')
  })
})
