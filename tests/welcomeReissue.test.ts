/**
 * Welcome to Ayni v4 and the restore path (CC-WEL-002/003, PROF-LINK-001, INTX-FLOW-006): the Welcome pack sends
 * people to the app's destinations with app links only; the platform rules name the allowed paths when an app-link
 * base is configured; a holder's `reissue` request is answered with `unknown-reference` by an agent that issues nothing.
 */
import { describe, expect, it } from 'vitest'
import { DidcommEvents } from '../src/channels/didcomm/events.js'
import { PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'
import { loadPack } from '../src/config/pack.js'
import { FlowService } from '../src/core/flows.js'
import { APP_LINK_PATHS, renderPromptAddon } from '../src/core/promptAddon.js'
import { createLogger } from '../src/util/logger.js'
import { startTestAgent } from './helpers.js'

const features = {
  approvals: false,
  elevation: false,
  reactions: false,
  receipts: false,
  history: true,
  workingMemory: false,
  preferences: false,
  credentialTool: false,
  semanticRecall: false,
  rag: false,
  imageGeneration: false,
  voiceNotes: false,
  inboundImages: false,
} as never

describe('Welcome to Ayni pack (CC-WEL-002/003)', () => {
  const env = {
    ...process.env,
    APP_LINK_BASE: 'https://app.dev.ayni.org/app/',
    HOME_BACKING_IDENTITY: 'did:webvh:x:home',
    LLM_API_KEY: 'x',
  }
  const { pack } = loadPack('agent-packs/welcome', env)

  it('admits unidentified wallets and runs the user-agent gate as optional', () => {
    expect(pack.identity.unidentifiedPeers).toBe('admit')
    expect(pack.identity.userAgentGate).toBe('optional')
  })

  it('links only to destinations of the app on the app-link domain, and to nothing that needs a credential', () => {
    const urls = (pack.persona.menu ?? [])
      .map((item) => item.action)
      .filter((a): a is { type: 'url'; url: string } => a.type === 'url')
      .map((a) => a.url)
    expect(urls).toEqual([
      'https://app.dev.ayni.org/app/explore',
      'https://app.dev.ayni.org/app/scan',
      'https://app.dev.ayni.org/app/wallet',
      'https://app.dev.ayni.org/app/settings/backup',
    ])
    expect(pack.channels?.agui?.appLinkBase).toBe('https://app.dev.ayni.org/app/')
    expect(pack.channels?.agui?.walletLinkTemplate).toMatch(/^https:\/\/app\.ayni\.org\/app\/connect\?oob=\{oob\}$/)
    expect(pack.persona.systemPrompt).not.toMatch(/https?:\/\//)
    expect(pack.tools?.access?.roles?.visitor).toEqual([])
  })
})

describe('app links in the platform rules (PROF-LINK-001)', () => {
  it('names the base and the allowed paths when configured, nothing otherwise', () => {
    const base = {
      features,
      agentLanguage: 'en',
      hasTools: false,
      hasRequestableTools: false,
      challengesConfigured: false,
    }
    const without = renderPromptAddon(base)
    expect(without).not.toContain('App links')
    const withLinks = renderPromptAddon({ ...base, appLinkBase: 'https://app.dev.ayni.org/app/' })
    expect(withLinks).toContain('https://app.dev.ayni.org/app/<path>')
    for (const path of APP_LINK_PATHS) expect(withLinks).toContain(path)
    expect(withLinks).toContain('Never write any other link')
  })
})

describe('reissue after a restore (INTX-FLOW-006, FLOW-REISSUE-001)', () => {
  it('answers a reference it never issued with unknown-reference and marks the request answered', async () => {
    const running = await startTestAgent()
    try {
      const calls: { method: string; args: unknown[] }[] = []
      const rec = (method: string, answer: unknown) => {
        return async (...args: unknown[]) => {
          calls.push({ method, args })
          return answer
        }
      }
      const client = {
        flowProblemReport: rec('flowProblemReport', { state: 'failed' }),
        markReissueAnswered: rec('markReissueAnswered', { state: 'answered' }),
      }
      const logger = createLogger('silent')
      const flows = new FlowService(
        client as never,
        running.agent.memory,
        running.agent.router,
        running.agent.store.kv,
        logger
      )
      Object.assign(running.agent, { flows })
      const peers = new PeerProfiles(running.agent.store.kv, logger)
      const events = new DidcommEvents(
        running.agent,
        client as never,
        {} as never,
        {} as never,
        peers,
        undefined,
        logger,
        100
      )
      await events.handle({
        id: 'evt-1',
        type: 'didcomm.reissue.state-changed',
        timestamp: new Date().toISOString(),
        data: {
          threadId: 'reissue-1',
          flowId: 'holder-flow-1',
          connectionId: 'conn-restored',
          state: 'request-received',
          request: {
            reference: {
              credentialId: 'cred-1',
              schemaId: 'schema-1',
              credDefId: 'cd-1',
              issuedAt: '2026-03-02T10:00:00Z',
            },
            reason: 'restore',
          },
        },
      })
      expect(calls.map((c) => c.method)).toEqual(['flowProblemReport', 'markReissueAnswered'])
      expect(calls[0].args[0]).toBe('holder-flow-1')
      expect((calls[0].args[1] as { code: string }).code).toBe('unknown-reference')
      expect(calls[1].args[0]).toBe('reissue-1')
    } finally {
      await running.stop()
    }
  })
})
