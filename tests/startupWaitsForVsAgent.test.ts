/**
 * The agent recovers by itself when the DIDComm agent comes up after it (IDENT-SELF-001, INTX-ISSUE-017): on a deployment
 * that restarts both, the agent starts first and the VS Agent does not answer yet. The HTTP server serves at once; the
 * start-up steps that need the VS Agent (its DID, the AG-UI descriptor in its DID Document, the credential definitions
 * of the issuance profiles, the peer status) are tried again in the background with a growing delay until it answers;
 * a profile issues once its definition is established; the recovery of a step is logged once. The VS Agent is a fake
 * HTTP server of the test that answers 503 until it is "up".
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESCRIPTOR_PATH, DID_SERVICE_TYPE } from '@ayni.org/ayni-agui-profile'
import pino from 'pino'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { AgentPack, IssuanceProfile } from '../src/config/packTypes.js'
import { EvidenceService } from '../src/core/evidence.js'
import { IssuanceService, subjectIdKey } from '../src/core/issuance.js'
import { StartupSteps } from '../src/core/startupSteps.js'
import type { Principal, Session } from '../src/core/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'
import { testEnv } from './helpers.js'

const SCHEMA = 'https://ecs.example/vt/schemas-badge-jsc.json'
const root = mkdtempSync(join(tmpdir(), 'ayni-startup-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A logger that keeps what it writes, as pino writes it. */
function recordingLogger() {
  const lines: { level: number; msg?: string; step?: string; attempts?: number }[] = []
  const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(JSON.parse(line)) })
  return { lines, logger }
}

/** Waits until a condition holds, or fails after a while. */
async function until(condition: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`the condition did not hold in time: ${condition.toString()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('a start-up step tried again until it is done', () => {
  it('runs at once, then again with a growing delay; logs the first failure and the recovery once', async () => {
    const { lines, logger } = recordingLogger()
    const steps = new StartupSteps(logger, { firstDelayMs: 5, maxDelayMs: 20 })
    let calls = 0
    const step = steps.run('the thing', async () => {
      calls++
      if (calls === 1) throw new Error('ECONNREFUSED')
      return calls >= 4
    })
    expect(await step.firstAttempt).toBe(false)
    await step.done
    expect(calls).toBe(4)
    const mine = lines.filter((l) => l.step === 'the thing')
    expect(mine.filter((l) => l.level === 40).map((l) => l.msg)).toEqual([
      'start-up step not done: the DIDComm agent did not answer; tried again until it does',
    ])
    expect(mine.filter((l) => l.level === 30)).toMatchObject([
      { msg: 'start-up step done: the DIDComm agent answered', attempts: 4 },
    ])
    expect(mine.filter((l) => l.level === 20)).toHaveLength(2)
  })

  it('logs nothing of a step done at once, and tries nothing again once the steps stop', async () => {
    const { lines, logger } = recordingLogger()
    const steps = new StartupSteps(logger, { firstDelayMs: 5, maxDelayMs: 5 })
    expect(await steps.run('at once', async () => true).firstAttempt).toBe(true)
    let calls = 0
    steps.run('never', async () => {
      calls++
      return false
    })
    await until(() => calls === 2)
    steps.stop()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(calls).toBe(2)
    expect(lines.filter((l) => l.step === 'at once')).toEqual([])
  })
})

describe('a profile issues once its definition is established (INTX-ISSUE-017)', () => {
  it('prepares the definitions again until the DIDComm agent answers, and the profile issues then', async () => {
    const profile: IssuanceProfile = {
      credential: { jsonSchemaCredentialId: SCHEMA },
      label: 'Badge',
      trigger: 'model',
      claims: { name: { from: 'computed', fn: 'constant', value: 'Ana' } },
    }
    const pack = { identity: { roleRules: [] }, issuance: { badge: profile } } as unknown as AgentPack
    const store = new MemoryStore()
    const silent = pino({ level: 'silent' })
    const evidence = new EvidenceService(store, pack, createEntryCrypto(Buffer.alloc(32, 7)), silent)
    let up = false
    const asked: string[] = []
    const service = new IssuanceService(
      pack,
      evidence,
      {
        offer: async () => ({ outcome: 'issued', exchangeId: 'cex-1' }),
        challenge: async () => ({ passed: true }),
        definitionFor: async (schema) => {
          asked.push(schema)
          return up ? 'def-badge' : undefined
        },
      },
      silent,
      subjectIdKey(Buffer.alloc(32, 7))
    )
    const principal = {
      id: 'prn-ana',
      connectionType: 'verifiable-user-agent',
      capabilityChannelId: 'conn-1',
      identityCredentialRef: 'badge:1',
      roles: [],
    } as unknown as Principal
    const session = { id: 'ses-1', channelType: 'didcomm', state: 'bound' } as Session
    const steps = new StartupSteps(silent, { firstDelayMs: 5, maxDelayMs: 10 })
    const step = steps.run('definitions', () => service.prepare())
    expect(await step.firstAttempt).toBe(false)
    expect((await service.issue(principal, session, 'badge', 'model')).outcome).toBe('not-ready')
    up = true
    await step.done
    expect((await service.issue(principal, session, 'badge', 'model')).outcome).toBe('issued')
    // a profile established is not asked again
    const before = asked.length
    expect(await service.prepare()).toBe(true)
    expect(asked.length).toBe(before)
    steps.stop()
  })
})

describe('the agent started before its DIDComm agent (IDENT-SELF-001)', () => {
  /** A VS Agent that answers 503 to everything until it is up. */
  function fakeVsAgent() {
    const state = {
      up: false,
      services: [] as { id: string; type: string; serviceEndpoint: unknown }[],
      definitions: [] as { id: string; relatedJsonSchemaCredentialId: string; supportRevocation: boolean }[],
      calls: [] as string[],
    }
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const path = (req.url ?? '').replace(/\?.*$/, '')
        state.calls.push(`${req.method} ${path}`)
        const send = (status: number, payload?: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(payload === undefined ? '' : JSON.stringify(payload))
        }
        if (!state.up) return send(503, { message: 'starting' })
        if (req.method === 'GET' && path === '/v2/agent/info')
          return send(200, { did: 'did:webvh:vs.test', version: '1.0' })
        if (req.method === 'GET' && path === '/v2/agent/health/ready') return send(200, { status: 'ok' })
        if (req.method === 'GET' && path === '/v2/vt/service-endpoints') return send(200, { items: state.services })
        if (req.method === 'POST' && path === '/v2/vt/service-endpoints') {
          const entry = JSON.parse(body)
          state.services.push(entry)
          return send(201, entry)
        }
        if (req.method === 'GET' && path === '/v2/anoncreds/credential-definitions')
          return send(200, { items: state.definitions, nextCursor: null })
        if (req.method === 'POST' && path === '/v2/anoncreds/credential-definitions') {
          const asked = JSON.parse(body)
          const created = {
            id: `def-${state.definitions.length + 1}`,
            relatedJsonSchemaCredentialId: asked.relatedJsonSchemaCredentialId,
            supportRevocation: asked.supportRevocation === true,
          }
          state.definitions.push(created)
          return send(201, created)
        }
        // the peer status: an empty query is refused as invalid by a VS Agent that speaks it
        if (req.method === 'POST' && path === '/v2/didcomm/peer-status/query') return send(400, { message: 'invalid' })
        return send(404, { message: 'not found' })
      })
    })
    return { server, state }
  }

  /** The dev agent-pack, with one profile that names a schema. */
  function packWithIssuance(): string {
    const dir = join(root, `pack-${Math.random().toString(36).slice(2)}`)
    cpSync('agent-packs/dev', dir, { recursive: true })
    const file = join(dir, 'agent-pack.yaml')
    const doc = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>
    doc.issuance = {
      badge: {
        credential: { jsonSchemaCredentialId: SCHEMA },
        label: 'Badge',
        trigger: 'model',
        claims: { name: { from: 'computed', fn: 'constant', value: 'Ana' } },
      },
    }
    writeFileSync(file, stringifyYaml(doc))
    return dir
  }

  it('serves at once, then declares its descriptor and establishes its definitions once the VS Agent answers', async () => {
    const { server, state } = fakeVsAgent()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const { lines, logger } = recordingLogger()
    let running: RunningAgent | undefined
    try {
      running = await buildAgent(testEnv({ vsAgentAdminUrl: url, agentPackPath: packWithIssuance() }), logger, {
        drainMs: 200,
        startupRetry: { firstDelayMs: 10, maxDelayMs: 40 },
      })
      const app = running.app
      // the VS Agent is down: the agent serves, degraded, and its DID is not known yet
      expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: DESCRIPTOR_PATH })).json().did).toBe('did:unknown')
      expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503)
      await until(() => state.calls.length >= 6)
      expect(state.services).toEqual([])
      // the VS Agent comes up: nobody restarts the agent
      state.up = true
      await until(() => state.services.length === 1 && state.definitions.length === 1)
      expect(state.services[0]).toMatchObject({
        type: DID_SERVICE_TYPE,
        serviceEndpoint: `http://agent.test${DESCRIPTOR_PATH}`,
      })
      expect(state.definitions[0]?.relatedJsonSchemaCredentialId).toBe(SCHEMA)
      expect((await app.inject({ method: 'GET', url: DESCRIPTOR_PATH })).json().did).toBe('did:webvh:vs.test')
      const ready = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(ready.statusCode).toBe(200)
      expect(ready.json().did).toBe('did:webvh:vs.test')
      await until(() => running?.agent.peerStatus?.declared === true)
      // each step that waited says once that it is done; the descriptor, started once the DID is known, did not wait
      await until(() => lines.filter((l) => l.msg === 'start-up step done: the DIDComm agent answered').length >= 3)
      const recovered = lines.filter((l) => l.msg === 'start-up step done: the DIDComm agent answered')
      expect(recovered.map((l) => l.step).sort()).toEqual([
        'the DID of the DIDComm agent',
        'the credential definitions of the issuance profiles',
        'the peer status of the DIDComm agent',
      ])
      expect(
        lines.filter((l) => l.msg === 'AG-UI descriptor declared in the DID Document (IDENT-SELF-005)')
      ).toHaveLength(1)
      // and nothing is declared or created twice
      const calls = state.calls.length
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(state.calls.filter((c) => c === 'POST /v2/vt/service-endpoints')).toHaveLength(1)
      expect(state.calls.slice(calls).filter((c) => c.startsWith('POST'))).toEqual([])
    } finally {
      await running?.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 20_000)
})
