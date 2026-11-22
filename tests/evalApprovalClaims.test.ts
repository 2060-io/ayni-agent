/**
 * The code of the evaluation of TOOL-CALL-017 (ayni-spec D114), not the evaluation: the evaluation needs a real model and
 * runs on demand (`pnpm eval:approval-claims`). Here a model written for the test stands in, to check that the harness
 * plays each case through the agent's own code, passes a turn that calls the tool, and fails one that only says it
 * asked: the Dev Agent's reply of 21:52:26 on devnet, replayed, reports a failure.
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CASES, evaluate, markdown, sampleOf } from '../scripts/eval/approval-claims.js'
import { ONE_CALL } from '../src/core/toolGate.js'
import type { ChatDelta, ChatModel, ChatRequest } from '../src/llm/types.js'
import {
  crmTools,
  type FakeHttp,
  type FakeMcp,
  fakeHttpTool,
  fakeMcpServer,
  searchTools,
  toolsPack,
} from './toolFixtures.js'

let pack: string
let servers: { crm: FakeMcp; search: FakeMcp; x: FakeHttp }

/** A model that calls the posting tool when the person's latest message asks for a post, and only says so otherwise. */
class Calls implements ChatModel {
  public readonly id = 'test/calls'
  public readonly multimodal = false
  public readonly requests: ChatRequest[] = []
  public constructor(private readonly calls: boolean) {}
  public async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
    this.requests.push(req)
    const last = req.messages.at(-1)
    if (this.calls && last?.role === 'user' && /post/i.test(String(last.content)))
      yield { type: 'tool_call', call: { id: 'c1', name: 'post_to_x', arguments: { text: 'Join us on Thursday.' } } }
    else yield { type: 'text', text: 'I asked the owner to approve it.' }
    yield { type: 'usage', inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 }
  }
}

beforeAll(async () => {
  servers = {
    crm: await fakeMcpServer(crmTools()),
    search: await fakeMcpServer(searchTools()),
    x: await fakeHttpTool(),
  }
  pack = toolsPack({ crmUrl: servers.crm.url, searchUrl: servers.search.url, xUrl: servers.x.url })
})

afterAll(async () => {
  await servers.crm.close()
  await servers.search.close()
  await servers.x.close()
})

describe('the evaluation of requests without a call (TOOL-CALL-017)', () => {
  it('passes every case when the turn calls the tool, the history being what the agent wrote', async () => {
    const model = new Calls(true)
    const report = await evaluate({ packPath: pack, runs: 1, model })
    expect(report.cases.map((c) => c.id)).toEqual([...CASES])
    expect(report.cases.flatMap((c) => c.failures)).toEqual([])
    expect(report).toMatchObject({ passed: true, addon: expect.any(String) })
    // the devnet replay: the call that asked, its approval and its run are in the history of the last turn's request
    const first = model.requests[0]
    const wire = JSON.stringify(first?.messages)
    expect(wire).toContain('asked for the approval of the owner of the space, owner, shown to the person on a card')
    expect(wire).toContain('owner approved Post on X')
    expect(wire).toContain(ONE_CALL.replace(/"/g, '\\"'))
    expect(first?.tools?.map((t) => t.name)).toContain('post_to_x')
    expect(String(first?.messages[1]?.content)).toContain('Only a call of the tool asks')
  }, 120_000)

  it("fails a turn that says it asked without a call: the Dev Agent's reply of 21:52:26, replayed", async () => {
    const replay = JSON.parse(readFileSync('scripts/eval/fixtures/devnet-2026-11-21-215226.json', 'utf8'))
    const report = await evaluate({
      packPath: pack,
      runs: 2,
      cases: ['devnet-2026-11-21'],
      replay,
      model: new Calls(true),
    })
    expect(report.passed).toBe(false)
    expect(report.cases[0]?.failures).toHaveLength(2)
    expect(report.cases[0]?.failures[0]).toMatchObject({ calls: [], reply: replay.text })
    expect(markdown(report)).toContain(replay.text)
    // and a model that never calls fails every case
    const silent = await evaluate({ packPath: pack, runs: 1, cases: ['after-a-claim'], model: new Calls(false) })
    expect(silent.passed).toBe(false)
  }, 120_000)

  it('gives a stand-in value to each field of a space account from its pattern', () => {
    expect(sampleOf('^[0-9]{1,20}-[A-Za-z0-9]{10,64}$')).toMatch(/^[0-9]{1,20}-[A-Za-z0-9]{10,64}$/)
    expect(sampleOf('^@?[A-Za-z0-9_]{1,15}$')).toMatch(/^@?[A-Za-z0-9_]{1,15}$/)
    expect(() => sampleOf('^(a|b)$')).toThrow()
  })
})
