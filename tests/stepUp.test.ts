/**
 * A step-up's re-authentication on the DIDComm side (ayni-spec D127, D128; IDENT-AUTH-015, IDENT-RES-014, FLOW-SIGNIN-006,
 * O69): the one set of methods a tool names, asked in an `authenticate` flow of purpose `step-up` on the identified
 * connection, with the action's text, the session the call came from as origin and the Principal of the connection as the
 * identity every method must find or confirm; what each attempt ends in; and when an earlier authentication stands for
 * it (`maxAgeMinutes`). The flow itself is tested in tests/authenticate.test.ts, the gate in tests/tools.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { AuthenticateAsk, AuthenticationAttempt } from '../src/channels/didcomm/identity.js'
import { IdentityRequests } from '../src/channels/didcomm/identityRequests.js'
import type { AgentPack } from '../src/config/packTypes.js'
import type { VerifiedFacts } from '../src/core/principals.js'
import { recentlyAuthenticated, stepUpForModel } from '../src/core/stepUp.js'
import type { Principal, Session } from '../src/core/types.js'
import { createLogger } from '../src/util/logger.js'

const pack = {
  identity: {
    authentication: {
      methods: {
        badge: { type: 'credential', credential: { jsonSchemaCredentialId: 'https://ecs.example/badge' } },
        email: { type: 'email' },
        face: { type: 'face-match', reference: ['directory'] },
      },
      combinations: [['badge'], ['email', 'face']],
    },
  },
} as unknown as AgentPack

const ana = {
  id: 'prn-ana',
  actorIdentity: 'org:EE:1|directory|p-1',
  capabilityChannelId: 'conn-1',
  identityCredentialRef: 'entry:p-1',
  userAgentVerified: true,
} as unknown as Principal
const origin = { id: 'ses-web', channelType: 'ag-ui' } as Session

function requests(options: { flows?: boolean; offered?: boolean; attempt?: AuthenticationAttempt; bound?: string }) {
  const asked: { connectionId: string; peerId: string; flowMode: boolean; ask: AuthenticateAsk }[] = []
  const presented: VerifiedFacts[] = []
  const service = new IdentityRequests(
    pack,
    {
      authenticate: async (connectionId, peerId, flowMode, _verified, ask) => {
        asked.push({ connectionId, peerId, flowMode, ask })
        ask.onOpened?.('flow-1', '2026-11-24T12:15:00.000Z')
        return options.attempt ?? { outcome: 'accepted', facts: { actorIdentity: ana.actorIdentity } as VerifiedFacts }
      },
      isFlowCapable: async () => options.flows ?? true,
      onIdentityPresented: async (_connectionId, facts) => {
        presented.push(facts)
        return { outcome: options.bound ?? 'refreshed' }
      },
      canOffer: async () => options.offered ?? true,
    },
    createLogger('silent')
  )
  return { service, asked, presented }
}

describe("a step-up's re-authentication (IDENT-AUTH-015)", () => {
  it('asks the set as the one combination of a step-up flow, bound to the Principal of the connection', async () => {
    const { service, asked, presented } = requests({})
    const opened: string[] = []
    const outcome = await service.stepUp(ana, {
      methods: ['email', 'face'],
      text: "Confirm it's you: Send a payment",
      origin,
      onOpened: (flowId) => void opened.push(flowId),
    })
    expect(outcome).toBe('completed')
    expect(asked).toEqual([
      {
        connectionId: 'conn-1',
        peerId: ana.actorIdentity,
        flowMode: true,
        ask: expect.objectContaining({
          purpose: 'step-up',
          combinations: [['email', 'face']],
          text: "Confirm it's you: Send a payment",
          bound: ana,
          origin,
        }),
      },
    ])
    expect(opened).toEqual(['flow-1'])
    // what it verified is recorded as at a connection: its evidence and the latest authentication (PRIV-EVID-001)
    expect(presented).toHaveLength(1)
  })

  it('tells each end apart: declined, unanswered, a step that failed, another identity, another flow open', async () => {
    const ends: [AuthenticationAttempt, string][] = [
      [{ outcome: 'declined' }, 'declined'],
      [{ outcome: 'unanswered' }, 'expired'],
      [{ outcome: 'not-accepted', code: 'step-failed' }, 'failed'],
      [{ outcome: 'not-accepted', code: 'another-identity' }, 'another-identity'],
      [{ outcome: 'pending' }, 'busy'],
    ]
    for (const [attempt, outcome] of ends) {
      const { service, presented } = requests({ attempt })
      expect(await service.stepUp(ana, { methods: ['badge'], text: 't' })).toBe(outcome)
      // nothing of an authentication that was not accepted is recorded (IDENT-RES-019)
      expect(presented).toEqual([])
    }
  })

  it('asks nothing of a visitor, of a person with no phone, or a set of methods the pack does not enable', async () => {
    const { service, asked } = requests({})
    expect(await service.stepUp({ ...ana, identityCredentialRef: null }, { methods: ['badge'], text: 't' })).toBe(
      'not-identified'
    )
    expect(await service.stepUp({ ...ana, capabilityChannelId: null }, { methods: ['badge'], text: 't' })).toBe(
      'unavailable'
    )
    expect(await service.stepUp(ana, { methods: ['otp'], text: 't' })).toBe('unavailable')
    expect(asked).toEqual([])
  })

  it('asks a wallet that takes no flows a credential alone, and nothing else; a phone that cannot do the set nothing (D128)', async () => {
    const hologram = requests({ flows: false })
    expect(await hologram.service.stepUp(ana, { methods: ['email', 'face'], text: 't' })).toBe('unavailable')
    expect(hologram.asked).toEqual([])
    expect(await hologram.service.stepUp(ana, { methods: ['badge'], text: 't' })).toBe('completed')
    expect(hologram.asked[0]).toMatchObject({ flowMode: false, ask: { purpose: 'step-up', combinations: [['badge']] } })
    // a face match on a phone that takes no calls (IDENT-AUTH-010)
    const noCalls = requests({ offered: false })
    expect(await noCalls.service.stepUp(ana, { methods: ['email', 'face'], text: 't' })).toBe('unavailable')
    expect(noCalls.asked).toEqual([])
  })

  it('keeps one authentication at a time on a connection: a second waits for none, it is busy', async () => {
    let release: () => void = () => undefined
    const { service } = requests({})
    const slow = new IdentityRequests(
      pack,
      {
        authenticate: () =>
          new Promise((resolve) => {
            release = () => resolve({ outcome: 'declined' })
          }),
        isFlowCapable: async () => true,
        onIdentityPresented: async () => ({ outcome: 'refreshed' }),
      },
      createLogger('silent')
    )
    const first = slow.stepUp(ana, { methods: ['badge'], text: 't' })
    await new Promise((r) => setTimeout(r, 5))
    expect(await slow.stepUp(ana, { methods: ['badge'], text: 't' })).toBe('busy')
    release()
    expect(await first).toBe('declined')
    expect(await service.stepUp(ana, { methods: ['badge'], text: 't' })).toBe('completed')
  })
})

describe('maxAgeMinutes (D127)', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  const last = (minutesAgo: number, combination: string[], outcome: 'passed' | 'failed' = 'passed') => ({
    lastAuthentication: {
      at: new Date(now - minutesAgo * 60_000).toISOString(),
      purpose: 'connection' as const,
      combination,
      types: [],
      steps: combination.map((method) => ({ method, type: 'x', outcome })),
    },
  })

  it('lets an authentication that held every method of the set stand for it within its minutes, and nothing else', () => {
    const set = { methods: ['face'], maxAgeMinutes: 10 }
    expect(recentlyAuthenticated(last(5, ['email', 'face']), set, now)).toBe(true)
    expect(recentlyAuthenticated(last(11, ['email', 'face']), set, now)).toBe(false)
    expect(recentlyAuthenticated(last(5, ['email']), set, now)).toBe(false)
    expect(recentlyAuthenticated(last(5, ['face'], 'failed'), set, now)).toBe(false)
    expect(recentlyAuthenticated({}, set, now)).toBe(false)
    // 0, the default: before each run
    expect(recentlyAuthenticated(last(0, ['face']), { methods: ['face'] }, now)).toBe(false)
  })
})

describe('what the model reads of a call a re-authentication stopped (TOOL-CALL-001, INTX-AUTH-003)', () => {
  it('names the step and its outcome, never a method', () => {
    for (const outcome of [
      'declined',
      'expired',
      'failed',
      'another-identity',
      'not-identified',
      'busy',
      'unavailable',
    ] as const) {
      const text = stepUpForModel('Send a payment', outcome)
      expect(text).toMatch(
        /^Send a payment did not run: it needs the person to confirm who they are on their phone first/
      )
      expect(text).not.toMatch(/email|face|passkey|code|badge/i)
    }
  })
})
