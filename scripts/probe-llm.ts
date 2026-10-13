/**
 * Sends one request to the configured model and prints the streamed text, tool calls and usage.
 * Usage: npx tsx --env-file=.env scripts/probe-llm.ts [pack dir] [maxOutputTokens] [reasoningEffort]
 */
import { loadPack } from '../src/config/pack.js'
import { createChatModel } from '../src/llm/index.js'

const { pack } = loadPack(process.argv[2] ?? process.env.AGENT_PACK_PATH ?? 'agent-packs/dev')
process.stdout.write(
  `provider ${pack.llm.provider}, model ${pack.llm.model}, temperature ${pack.llm.temperature ?? 'unset'}\n`
)
const effort = process.argv[4] as typeof pack.llm.reasoningEffort | undefined
const model = createChatModel({ ...pack.llm, ...(effort ? { reasoningEffort: effort } : {}) })
let text = ''
const calls: unknown[] = []
const started = Date.now()
for await (const d of model.stream({
  messages: [
    { role: 'system', content: 'You are a terse assistant.' },
    {
      role: 'user',
      content: 'Answer in five words: what is a verifiable credential? Then call the tool ping with {"n": 3}.',
    },
  ],
  tools: [
    {
      name: 'ping',
      description: 'Pings n times',
      parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    },
  ],
  maxOutputTokens: Number(process.argv[3] ?? pack.llm.maxOutputTokens ?? 1024),
})) {
  if (d.type === 'text') text += d.text
  else if (d.type === 'tool_call') calls.push(d.call)
  else if (d.type === 'usage') process.stdout.write(`usage in ${d.inputTokens} out ${d.outputTokens}\n`)
}
process.stdout.write(
  `text: ${JSON.stringify(text.slice(0, 300))}\ntool calls: ${JSON.stringify(calls)}\nelapsed ${Date.now() - started} ms\n`
)
