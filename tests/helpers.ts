/** Builds a complete agent on the in-memory store with the stub model, no network. */
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { Env } from '../src/config/env.js'
import { createLogger } from '../src/util/logger.js'

export function testEnv(over: Partial<Env> = {}): Env {
  return {
    agentPackPath: 'agent-packs/dev',
    publicBaseUrl: 'http://agent.test',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
    vsAgentAdminUrl: 'http://127.0.0.1:1',
    devAllowUnidentifiedPrincipals: true,
    sessionTokenSecret: 'test-secret',
    aguiAllowedOrigins: ['http://ui.test'],
    store: 'memory',
    presignedUrlTtlSeconds: 300,
    entryEncryptionKey: Buffer.alloc(32, 7),
    retentionHistoryDays: 365,
    retentionMediaGraceDays: 30,
    anchoringEnabled: false,
    anchorBatchIntervalSeconds: 600,
    faceMatchTimeoutSeconds: 10,
    statsEnabled: false,
    statsSink: 'redis-stream',
    ...over,
  }
}

export async function startTestAgent(over: Partial<Env> = {}): Promise<RunningAgent> {
  return buildAgent(testEnv(over), createLogger('silent'))
}

/** Parses an SSE body into its events. */
export function parseSse(body: string): { id?: number; event: Record<string, unknown> }[] {
  const out: { id?: number; event: Record<string, unknown> }[] = []
  for (const block of body.split('\n\n')) {
    let id: number | undefined
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = Number(line.slice(4))
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (data) out.push({ id, event: JSON.parse(data) })
  }
  return out
}
