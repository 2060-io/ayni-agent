/**
 * Enrolling an authenticator app or a passkey, and removing one (ayni-spec D129; IDENT-AUTH-012 to 014,
 * FLOW-SIGNIN-014, IDENT-STAT-002/005; flow profile §6.4): only for an identified person, on a connection authenticated
 * within ten minutes by a combination that holds neither, else after an authentication of purpose `enrol`; the secret
 * handed once and kept sealed, a passkey's key kept; a status that lists what is enrolled.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AuthenticateOptions, AuthenticationAttempt } from '../src/channels/didcomm/authenticate.js'
import { EnrolService, recentlyAuthenticated } from '../src/channels/didcomm/enrol.js'
import { PeerStatusNotifier } from '../src/channels/didcomm/peerStatus.js'
import type { EnrolExchange } from '../src/channels/didcomm/vsAgentClient.js'
import type { AgentPack } from '../src/config/packTypes.js'
import { EnrolmentStore } from '../src/core/authentication/enrolments.js'
import { base32Decode, hotp, totpCounter } from '../src/core/authentication/totp.js'
import type { AuthenticationRecord, Principal } from '../src/core/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import type { KvRepo } from '../src/store/types.js'
import { createLogger } from '../src/util/logger.js'
import { makePasskey, RP } from './passkeyFixtures.js'

type Call = { method: string; args: unknown[] }
const logger = createLogger('silent')

const PACK = {
  metadata: { displayName: 'Northwind Support' },
  identity: {
    authentication: {
      request: 'on-connect',
      visitors: true,
      methods: { email: { type: 'email' }, otp: { type: 'authenticator-app' }, key: { type: 'passkey' } },
      combinations: [['email'], ['email', 'otp'], ['key']],
    },
  },
  channels: {},
} as unknown as AgentPack

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const ana = (over: Partial<Principal> = {}): Principal =>
  ({
    id: 'prn-ana',
    connectionType: 'verifiable-user-agent',
    actorIdentity: 'org:EE:1|directory|p-1',
    backingIdentity: { kind: 'org', id: 'org:EE:1' },
    backingRelation: 'home',
    roles: [],
    directoryEntryId: 'p-1',
    identityAttributes: { userName: 'Ana Ríos' },
    capabilityChannelId: 'conn-1',
    identityCredentialRef: 'entry:p-1',
    livenessCache: {},
    userAgentVerified: false,
    lastAuthentication: {
      at: minutesAgo(5),
      purpose: 'connection',
      combination: ['email'],
      types: ['email'],
      steps: [{ method: 'email', type: 'email', outcome: 'passed' }],
    },
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(5),
    ...over,
  }) as Principal

function memoryKv(): KvRepo & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    get: async (k) => raw.get(k),
    set: async (k, v) => void raw.set(k, v),
    delete: async (k) => void raw.delete(k),
  }
}

let calls: Call[]
let kv: ReturnType<typeof memoryKv>
let enrolments: EnrolmentStore
let principal: Principal | undefined
let authenticated: AuthenticateOptions[]
let attempt: AuthenticationAttempt
let told: string[]
let service: EnrolService

const _settle = () => new Promise((r) => setTimeout(r, 10))
const exchange = (over: Partial<EnrolExchange>): EnrolExchange => ({
  threadId: 'enrol-1',
  flowId: 'flow-enrol',
  connectionId: 'conn-1',
  role: 'requester',
  state: 'request-received',
  type: 'authenticator-app',
  challenges: 0,
  createdAt: new Date().toISOString(),
  ...over,
})
const challenges = () =>
  calls.filter((c) => c.method === 'sendEnrolChallenge').map((c) => c.args[1] as Record<string, unknown>)
const problems = () =>
  calls.filter((c) => c.method === 'flowProblemReport').map((c) => (c.args[1] as { code: string }).code)
const closes = () => calls.filter((c) => c.method === 'closeFlow').map((c) => c.args)

beforeEach(() => {
  calls = []
  kv = memoryKv()
  enrolments = new EnrolmentStore(kv, createEntryCrypto(Buffer.alloc(32, 5)))
  principal = ana()
  authenticated = []
  attempt = { outcome: 'declined' }
  told = []
  const rec =
    (method: string) =>
    async (...args: unknown[]) =>
      void calls.push({ method, args })
  service = new EnrolService({
    pack: PACK,
    client: {
      sendEnrolChallenge: rec('sendEnrolChallenge'),
      flowProblemReport: rec('flowProblemReport'),
      closeFlow: rec('closeFlow'),
    } as never,
    authenticator: {
      run: async (options) => {
        authenticated.push(options)
        return attempt
      },
    },
    principalOf: async () => principal,
    savePrincipal: async (p) => {
      principal = p
    },
    enrolments,
    statusChanged: async (connectionId) => void told.push(connectionId),
    rpId: RP,
    logger,
  })
})

describe('an authenticator app (IDENT-AUTH-012, IDENT-AUTH-014)', () => {
  it('hands the secret once, keeps it sealed once a code it gives is typed, and tells the person', async () => {
    await service.onExchange(exchange({}))
    const [challenge] = challenges()
    expect(challenge).toMatchObject({ type: 'authenticator-app', digits: 6, period: 30 })
    expect(String(challenge.otpauthUri)).toMatch(/^otpauth:\/\/totp\/Northwind%20Support:Ana%20R%C3%ADos\?/)
    expect(authenticated).toEqual([])
    const secret = base32Decode(String(challenge.secret))
    await service.onExchange(
      exchange({ state: 'answer-received', challenges: 1, answer: { code: hotp(secret, totpCounter(Date.now())) } })
    )
    expect(closes()).toEqual([['flow-enrol', { outcome: 'completed' }]])
    expect(told).toEqual(['conn-1'])
    expect(await enrolments.types('prn-ana')).toEqual([{ type: 'authenticator-app', at: expect.any(String) }])
    // sealed: the store holds no secret in the clear
    expect([...kv.raw.values()].join('\n')).not.toContain(String(challenge.secret))
  })

  it('answers a wrong code with the challenge again, three in all, then fails not-valid', async () => {
    await service.onExchange(exchange({}))
    for (const sent of [1, 2, 3])
      await service.onExchange(exchange({ state: 'answer-received', challenges: sent, answer: { code: '000000' } }))
    // the same secret each time: the person added it to their app already
    expect(new Set(challenges().map((c) => c.secret)).size).toBe(1)
    expect(challenges()).toHaveLength(3)
    // the first says nothing of codes; each after a wrong code says so and how many are left (D155, plugin 0.3.1)
    expect(challenges().map((c) => [c.error, c.triesLeft])).toEqual([
      [undefined, undefined],
      ['wrong-code', 2],
      ['wrong-code', 1],
    ])
    expect(problems()).toEqual(['not-valid'])
    expect(await enrolments.types('prn-ana')).toEqual([])
  })
})

describe('who may enrol (IDENT-AUTH-014, FLOW-SIGNIN-014)', () => {
  const LAST = ana().lastAuthentication as AuthenticationRecord
  it('refuses a visitor not-eligible, and a type the pack does not enable', async () => {
    principal = ana({ identityCredentialRef: null })
    await service.onExchange(exchange({}))
    expect(problems()).toEqual(['not-eligible'])
    principal = ana()
    const without = {
      ...PACK,
      identity: { authentication: { methods: { email: { type: 'email' } }, combinations: [['email']] } },
    }
    const other = new EnrolService({ ...(service as unknown as { deps: object }).deps, pack: without } as never)
    await other.onExchange(exchange({ threadId: 'enrol-2' }))
    expect(problems()).toEqual(['not-eligible', 'not-eligible'])
    expect(challenges()).toEqual([])
  })

  it('asks an authentication of purpose enrol first when the last one is old or used an enrollable method', async () => {
    expect(recentlyAuthenticated(ana())).toBe(true)
    expect(recentlyAuthenticated(ana({ lastAuthentication: { ...LAST, at: minutesAgo(20) } }))).toBe(false)
    expect(recentlyAuthenticated(ana({ lastAuthentication: { ...LAST, types: ['passkey'] } }))).toBe(false)
    principal = ana({ lastAuthentication: { ...LAST, at: minutesAgo(20) } })
    // not confirmed: not-eligible, and nothing handed
    await service.onExchange(exchange({}))
    expect(authenticated).toEqual([
      expect.objectContaining({ purpose: 'enrol', bound: expect.objectContaining({ id: 'prn-ana' }) }),
    ])
    expect(problems()).toEqual(['not-eligible'])
    expect(challenges()).toEqual([])
    // confirmed: the challenge follows, and the authentication is kept on the Principal
    const record = { ...LAST, at: new Date().toISOString(), purpose: 'enrol' as const }
    attempt = { outcome: 'accepted', facts: { authentication: record } as never }
    await service.onExchange(exchange({ threadId: 'enrol-3' }))
    expect(challenges()).toHaveLength(1)
    expect(principal?.lastAuthentication).toEqual(record)
  })
})

describe('a passkey (IDENT-AUTH-013, IDENT-AUTH-014)', () => {
  it('asks its creation for the app-link domain, keeps its key, and identifies the Principal by it', async () => {
    await service.onExchange(exchange({ type: 'passkey' }))
    const [challenge] = challenges()
    const options = challenge.publicKey as {
      rp: { id: string }
      user: { id: string; name: string }
      challenge: string
      pubKeyCredParams: { alg: number }[]
      authenticatorSelection: unknown
    }
    expect(options.rp.id).toBe(RP)
    expect(options.user.name).toBe('Ana Ríos')
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257])
    expect(options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' })
    const passkey = makePasskey()
    await service.onExchange(
      exchange({
        type: 'passkey',
        state: 'answer-received',
        challenges: 1,
        answer: { attestation: passkey.attestation(options.challenge) },
      })
    )
    expect(closes()).toHaveLength(1)
    expect(await enrolments.principalOfPasskey(passkey.id)).toBe('prn-ana')
    expect((await enrolments.get('prn-ana')).passkey).toMatchObject({ credentialId: passkey.id, alg: -7 })
  })

  it('refuses a creation that does not verify with not-valid', async () => {
    await service.onExchange(exchange({ type: 'passkey' }))
    await service.onExchange(
      exchange({
        type: 'passkey',
        state: 'answer-received',
        challenges: 1,
        answer: { attestation: makePasskey().attestation('another') },
      })
    )
    expect(problems()).toEqual(['not-valid'])
    expect(await enrolments.types('prn-ana')).toEqual([])
  })
})

describe('removing a method, and the status (FLOW-SIGNIN-014, IDENT-STAT-002)', () => {
  it('removes what the person unenrols and tells them', async () => {
    await enrolments.setAuthenticatorApp('prn-ana', 'GEZDGNBVGY3TQOJQ')
    await service.onUnenrol('conn-1', 'authenticator-app')
    expect(await enrolments.types('prn-ana')).toEqual([])
    expect(told).toEqual(['conn-1'])
  })

  it('tells an identified person what they may enrol and have enrolled, and a visitor neither', async () => {
    const notifier = new PeerStatusNotifier(PACK, {} as never, {} as never, logger)
    notifier.enrolledOf = async (p) => (await enrolments.types(p.id)).map((e) => e.type)
    await enrolments.setAuthenticatorApp('prn-ana', 'GEZDGNBVGY3TQOJQ')
    const status = await notifier.statusOf(ana())
    expect(status.authentication).toMatchObject({
      rule: 'optional',
      enrol: ['authenticator-app', 'passkey'],
      enrolled: ['authenticator-app'],
    })
    const visitor = await notifier.statusOf(ana({ identityCredentialRef: null }))
    expect(visitor.authentication.enrol).toBeUndefined()
    expect(visitor.authentication.enrolled).toBeUndefined()
  })
})
