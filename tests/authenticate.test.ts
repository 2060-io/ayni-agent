/**
 * The authentication on the phone over authenticate/1.0 (ayni-spec D125 to D131; IDENT-AUTH-001 to 017,
 * IDENT-RES-002/014/019/020, IDENT-DIR-003/004; flow profile §6.14, FLOW-SIGNIN-001 to 013): the request with its
 * methods and combinations, the choice, the steps of each method, their results, and what the agent accepts. The DIDComm
 * agent is a stub that records what the agent sends; the phone's messages arrive as the plugin's events. No email leaves:
 * the mailer is a stub that keeps what it would send.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticationAttempt, Authenticator, directoryActorOf } from '../src/channels/didcomm/authenticate.js'
import { IdentityFlow } from '../src/channels/didcomm/identity.js'
import { type AuthenticateExchange, VsAgentError } from '../src/channels/didcomm/vsAgentClient.js'
import type { AgentPack, PackAuthentication } from '../src/config/packTypes.js'
import { EnrolmentStore } from '../src/core/authentication/enrolments.js'
import { base32Encode, hotp, newTotpSecret, totpCounter } from '../src/core/authentication/totp.js'
import { verifyRegistration } from '../src/core/authentication/webauthn.js'
import { FlowService } from '../src/core/flows.js'
import type { Principal } from '../src/core/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import type { KvRepo } from '../src/store/types.js'
import { createLogger } from '../src/util/logger.js'
import { makePasskey } from './passkeyFixtures.js'

type Call = { method: string; args: unknown[]; result?: unknown }
const logger = createLogger('silent')
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms))
const HOME = { key: 'org:EE:1', name: 'Northwind Logistics', attributes: {} }
const RP = 'app.dev.ayni.org'
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'

function memoryKv(): KvRepo & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    get: async (k) => raw.get(k),
    set: async (k, v) => void raw.set(k, v),
    delete: async (k) => void raw.delete(k),
  }
}

const AUTHENTICATION: PackAuthentication = {
  request: 'on-connect',
  visitors: true,
  methods: {
    badge: { type: 'credential', credential: { jsonSchemaCredentialId: BADGE }, subjectKey: ['badgeNumber'] },
    email: { type: 'email' },
    passport: { type: 'document' },
    face: { type: 'face-match', reference: ['document', 'directory'] },
    otp: { type: 'authenticator-app' },
    key: { type: 'passkey' },
  },
  combinations: [
    ['badge'],
    ['email'],
    ['passport'],
    ['email', 'passport'],
    ['email', 'otp'],
    ['key'],
    ['email', 'face'],
  ],
}

const ENTRIES = [
  { id: 'p-1', firstName: 'Ana', lastName: 'Ríos', email: 'ana.rios@northwind.example' },
  { id: 'p-2', firstName: 'Ben', lastName: 'Okafor', email: 'ben.okafor@northwind.example' },
]

const documentFixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/document/${name}`, import.meta.url)))
function checkDigit(text: string): string {
  const value = (c: string) => (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55)
  return String([...text].reduce((sum, c, i) => sum + value(c) * [7, 3, 1][i % 3], 0) % 10)
}
/** The zone of the specimen, valid until the end of 2039. */
function dg1(): Buffer {
  const line1 = 'P<D<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<<<<<<<<<<'
  const number = 'C11T002JM4'
  const birth = '9608122'
  const expiry = `391231${checkDigit('391231')}`
  const personal = '<<<<<<<<<<<<<<<'
  const line2 = `${number}D<<${birth}F${expiry}${personal}`
  const zone = line1 + line2 + checkDigit(number + birth + expiry + personal)
  return Buffer.concat([Buffer.from([0x61, zone.length + 3, 0x5f, 0x1f, zone.length]), Buffer.from(zone, 'latin1')])
}
const chip = () => ({
  raw: { DG1: dg1().toString('base64'), DG2: documentFixture('DG2.bin').toString('base64') },
  verification: { authenticity: true, integrity: true },
})

interface World {
  calls: Call[]
  authenticator: Authenticator
  flows: FlowService
  enrolments: EnrolmentStore
  mails: { to: string; subject: string; text: string }[]
  principals: Map<string, Principal>
  /** what the directory finds for the document read */
  documentMatches: string[]
  /** whether the DIDComm agent answers 409 to the next authenticate flow */
  busy: boolean
}

function world(options: { takesCalls?: boolean; faces?: boolean } = {}): World {
  const calls: Call[] = []
  let n = 0
  const rec =
    (method: string, answer: (...args: unknown[]) => unknown = () => undefined) =>
    async (...args: unknown[]) => {
      const call: Call = { method, args }
      calls.push(call)
      call.result = await answer(...args)
      return call.result
    }
  const w = { calls, mails: [], principals: new Map(), documentMatches: ['p-1'], busy: false } as unknown as World
  const client = {
    openFlow: rec('openFlow', (body) => {
      if (w.busy) throw new VsAgentError(409, '/didcomm/ayni-flow/flows', 'an authenticate flow is open')
      const b = body as { connectionId: string; kind: string; expiresTime: string }
      return { ...b, flowId: `flow-${++n}`, state: 'pending', createdAt: new Date().toISOString() }
    }),
    closeFlow: rec('closeFlow', (flowId, body) => ({ flowId, state: (body as { outcome: string }).outcome })),
    flowProblemReport: rec('flowProblemReport', (flowId) => ({ flowId, state: 'failed' })),
    sendAuthenticateRequest: rec('sendAuthenticateRequest', (body) => {
      const b = body as { connectionId: string; flowId: string; request: AuthenticateExchange['request'] }
      return {
        threadId: `auth-${++n}`,
        flowId: b.flowId,
        connectionId: b.connectionId,
        role: 'requester',
        state: 'request-sent',
        request: b.request,
        steps: [],
        createdAt: new Date().toISOString(),
      }
    }),
    sendAuthenticateStep: rec('sendAuthenticateStep', (threadId) => ({ threadId })),
    sendAuthenticateStepResult: rec('sendAuthenticateStepResult', (threadId) => ({ threadId })),
    requestPresentation: rec('requestPresentation', () => ({ proofExchangeId: `pex-${++n}` })),
    requestEmrtd: rec('requestEmrtd', () => ({ id: `emrtd-${++n}` })),
  }
  const kv = memoryKv()
  const crypto = createEntryCrypto(Buffer.alloc(32, 9))
  w.flows = new FlowService(client as never, {} as never, {} as never, kv, logger)
  w.enrolments = new EnrolmentStore(kv, crypto)
  const pack = { metadata: { displayName: 'Northwind Support' }, identity: { authentication: AUTHENTICATION } }
  w.authenticator = new Authenticator(
    pack as unknown as AgentPack,
    {
      client: client as never,
      flows: w.flows,
      awaitPresentation: () => new Promise(() => undefined),
      credentialFacts: async () => 'not-valid',
      takesCalls: async () => options.takesCalls ?? false,
      directory: {
        byEmail: (address) => ENTRIES.find((e) => e.email === address.toLowerCase()),
        matchDocument: () => ({ ids: w.documentMatches }),
        entry: (id) => ENTRIES.find((e) => e.id === id),
      },
      home: async () => HOME,
      principals: {
        get: async (id) => w.principals.get(id),
        findByActor: async (actor) => [...w.principals.values()].find((p) => p.actorIdentity === actor),
      },
      enrolments: w.enrolments,
      // a call is never offered in these tests: one would be recorded, and fail the step
      ...(options.faces
        ? {
            faceSteps: {
              available: true,
              start: rec('startFaceCall', () => {
                throw new Error('no call in the tests')
              }),
            } as never,
          }
        : {}),
      mailer: {
        send: async (message: { to: string; subject: string; text: string }) => void w.mails.push(message),
      } as never,
      blindIndex: (value) => crypto.blindIndex(value),
      rpId: RP,
    },
    logger
  )
  return w
}

const exchangeOf = (w: World) =>
  w.calls.filter((c) => c.method === 'sendAuthenticateRequest').at(-1)?.result as AuthenticateExchange
const stepsSent = (w: World) =>
  w.calls.filter((c) => c.method === 'sendAuthenticateStep').map((c) => c.args[1] as Record<string, unknown>)
const resultsSent = (w: World) =>
  w.calls.filter((c) => c.method === 'sendAuthenticateStepResult').map((c) => c.args[1] as Record<string, unknown>)
const problems = (w: World) =>
  w.calls.filter((c) => c.method === 'flowProblemReport').map((c) => (c.args[1] as { code: string }).code)
const closes = (w: World) =>
  w.calls.filter((c) => c.method === 'closeFlow').map((c) => (c.args[1] as { outcome: string }).outcome)

/** The phone's messages, as the plugin reports them (`didcomm.authenticate.state-changed`). */
function phone(w: World) {
  const event = (over: Partial<AuthenticateExchange>) =>
    w.authenticator.onExchange({ ...exchangeOf(w), role: 'requester', steps: [], ...over } as AuthenticateExchange)
  return {
    chooses: async (combination: string[]) => {
      event({ state: 'choice-received', combination })
      await settle()
    },
    answers: async (step: string, answer: Record<string, unknown>) => {
      event({
        state: 'answer-received',
        steps: [
          {
            step,
            method: '',
            type: '',
            prompt: { step, method: '', type: '' },
            answer: { step, ...answer },
            awaitingAnswer: false,
          },
        ],
      })
      await settle()
    },
  }
}

const ask = (w: World, over: Partial<Parameters<Authenticator['run']>[0]> = {}): Promise<AuthenticationAttempt> =>
  w.authenticator.run({
    connectionId: 'conn-1',
    peerId: 'did:peer:phone',
    purpose: 'connection',
    userAgentVerified: false,
    ...over,
  })

const codeIn = (mail: { text: string }) => /\b(\d{6})\b/.exec(mail.text)?.[1] as string

const ana = (): Principal =>
  ({
    id: 'prn-ana',
    connectionType: 'verifiable-user-agent',
    actorIdentity: directoryActorOf(HOME.key, 'p-1'),
    backingIdentity: { kind: 'org', id: HOME.key, name: HOME.name },
    backingRelation: 'home',
    roles: [],
    directoryEntryId: 'p-1',
    identityAttributes: { userName: 'Ana Ríos' },
    capabilityChannelId: 'conn-1',
    identityCredentialRef: 'entry:p-1',
    livenessCache: {},
    userAgentVerified: false,
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
  }) as Principal

describe('the request (FLOW-SIGNIN-001, IDENT-AUTH-010, IDENT-RES-020)', () => {
  it('opens one authenticate flow valid fifteen minutes and asks the methods and combinations the phone can be offered', async () => {
    const w = world()
    void ask(w)
    await settle()
    const open = w.calls.find((c) => c.method === 'openFlow')?.args[0] as {
      kind: string
      expiresTime: string
      origin: unknown
    }
    expect(open.kind).toBe('authenticate')
    expect(open.origin).toEqual({ channel: 'none' })
    // an open carries no requires: the plugin 0.3.0 answers 400 to a body that holds it
    expect(open).not.toHaveProperty('requires')
    expect(Date.parse(open.expiresTime) - Date.now()).toBeGreaterThan(14.9 * 60_000)
    const request = exchangeOf(w).request
    // a face match only to a phone that takes calls (IDENT-AUTH-010): [email, face] is not offered, nor the face method
    expect(request.combinations).toEqual([
      ['badge'],
      ['email'],
      ['passport'],
      ['email', 'passport'],
      ['email', 'otp'],
      ['key'],
    ])
    expect(Object.keys(request.methods)).toEqual(['badge', 'email', 'passport', 'otp', 'key'])
    expect(request.methods.badge).toEqual({ type: 'credential', credential: { jsonSchemaCredentialId: BADGE } })
    expect(request.purpose).toBe('connection')
    // a phone that takes calls, with a face-verification service, is offered it
    const withCalls = world({ takesCalls: true, faces: true })
    expect(await withCalls.authenticator.combinationsFor({ connectionId: 'c', purpose: 'visitor' })).toContainEqual([
      'email',
      'face',
    ])
    // an enrolment's authentication holds neither an authenticator app nor a passkey (IDENT-AUTH-014)
    expect(await w.authenticator.combinationsFor({ connectionId: 'c', purpose: 'enrol' })).toEqual([
      ['badge'],
      ['email'],
      ['passport'],
      ['email', 'passport'],
    ])
  })

  it('keeps one authenticate flow at a time: a second is pending (FLOW-SIGNIN-001)', async () => {
    const w = world()
    w.busy = true
    expect(await ask(w)).toEqual({ outcome: 'pending' })
    expect(w.calls.filter((c) => c.method === 'sendAuthenticateRequest')).toEqual([])
  })

  it('a choice that does not come in time is unanswered, and the flow closes expired (IDENT-RES-020)', async () => {
    const w = world()
    w.authenticator.timings.choiceMs = 40
    expect(await ask(w)).toEqual({ outcome: 'unanswered' })
    expect(closes(w)).toEqual(['expired'])
  })

  it('the phone declines: a decline, nothing refused', async () => {
    const w = world()
    const asking = ask(w)
    await settle()
    await w.flows.onFlowEvent({ flowId: exchangeOf(w).flowId as string, state: 'declined', closedBy: 'peer' } as never)
    expect(await asking).toEqual({ outcome: 'declined' })
    expect(problems(w)).toEqual([])
  })

  it('refuses a choice that is not one of the combinations with malformed (FLOW-SIGNIN-008)', async () => {
    const w = world()
    const asking = ask(w)
    await settle()
    w.authenticator.onExchange({ ...exchangeOf(w), state: 'failed', errorCode: 'malformed' })
    expect(await asking).toEqual({ outcome: 'declined' })
    expect(problems(w)).toEqual(['malformed'])
  })
})

describe('the email step (IDENT-AUTH-006 to 009, FLOW-SIGNIN-010/011, IDENT-DIR-004)', () => {
  it('asks the address, sends a code to an entry only, takes a wrong code with the tries left, and identifies the entry', async () => {
    const w = world()
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['email'])
    expect(stepsSent(w)).toEqual([{ step: '1', method: 'email', type: 'email', ask: 'address' }])
    await p.answers('1', { address: 'Ana.Rios@Northwind.example', locale: 'es' })
    // one code, to the address in lower case
    expect(w.mails.map((m) => m.to)).toEqual(['ana.rios@northwind.example'])
    const code = codeIn(w.mails[0])
    expect(stepsSent(w)[1]).toMatchObject({ step: '1', ask: 'code', triesLeft: 5, newCodesLeft: 3 })
    expect(Date.parse(String(stepsSent(w)[1].expiresAt)) - Date.now()).toBeGreaterThan(9.9 * 60_000)
    await p.answers('1', { code: code === '000000' ? '111111' : '000000' })
    expect(stepsSent(w)[2]).toMatchObject({ ask: 'code', triesLeft: 4, error: 'wrong-code' })
    // a new code within thirty seconds is refused, and says why (`step.reason`)
    await p.answers('1', { newCode: true })
    expect(stepsSent(w)[3]).toMatchObject({ error: 'new-code-refused', reason: 'too-soon', newCodesLeft: 3 })
    expect(w.mails).toHaveLength(1)
    await p.answers('1', { code })
    const attempt = await asking
    expect(attempt).toMatchObject({
      outcome: 'accepted',
      facts: {
        actorIdentity: 'org:EE:1|directory|p-1',
        backingIdentity: { kind: 'org', id: 'org:EE:1' },
        directoryEntryId: 'p-1',
        identityCredentialRef: 'entry:p-1',
        claims: { userName: 'Ana Ríos' },
        moreEvidence: [{ kind: 'email', entry: 'email', values: { address: 'ana.rios@northwind.example' } }],
        authentication: { purpose: 'connection', combination: ['email'], types: ['email'], directoryEntryId: 'p-1' },
      },
    })
    expect(resultsSent(w)).toEqual([{ step: '1', outcome: 'passed' }])
    expect(closes(w)).toEqual(['completed'])
    expect(problems(w)).toEqual([])
  })

  it('answers an unknown address the same, sends nothing, and fails the step after five wrong codes', async () => {
    const w = world()
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['email'])
    await p.answers('1', { address: 'nobody@northwind.example', locale: 'en' })
    expect(w.mails).toEqual([])
    expect(stepsSent(w)[1]).toMatchObject({ step: '1', ask: 'code', triesLeft: 5, newCodesLeft: 3 })
    for (let i = 0; i < 5; i++) await p.answers('1', { code: '123456' })
    expect(await asking).toEqual({ outcome: 'not-accepted', code: 'step-failed' })
    expect(resultsSent(w)).toEqual([{ step: '1', outcome: 'failed', reason: 'step-failed' }])
    expect(problems(w)).toEqual(['step-failed'])
    expect(closes(w)).toEqual([])
  })

  it('sends three new codes at most, each replacing the one before (FLOW-SIGNIN-011)', async () => {
    const w = world()
    w.authenticator.timings.newCodeAfterMs = 0
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['email'])
    await p.answers('1', { address: 'ana.rios@northwind.example', locale: 'en' })
    for (let i = 0; i < 3; i++) await p.answers('1', { newCode: true })
    expect(w.mails).toHaveLength(4)
    expect(
      stepsSent(w)
        .map((s) => s.newCodesLeft)
        .filter((v) => v !== undefined)
    ).toEqual([3, 2, 1, 0])
    await p.answers('1', { newCode: true })
    expect(stepsSent(w).at(-1)).toMatchObject({ error: 'new-code-refused', reason: 'no-more' })
    // the first code no longer works; the last one does
    const first = codeIn(w.mails[0])
    const last = codeIn(w.mails[3])
    if (first !== last) {
      await p.answers('1', { code: first })
      expect(stepsSent(w).at(-1)).toMatchObject({ error: 'wrong-code' })
    }
    await p.answers('1', { code: last })
    expect(await asking).toMatchObject({ outcome: 'accepted' })
  })

  it('an address not given in time ends the step expired', async () => {
    const w = world()
    w.authenticator.timings.emailMs = 40
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['email'])
    expect(await asking).toEqual({ outcome: 'not-accepted', code: 'step-expired' })
    expect(resultsSent(w)).toEqual([{ step: '1', outcome: 'expired', reason: 'step-expired' }])
    expect(problems(w)).toEqual(['step-expired'])
  })

  it('on a connection identified as someone else, refuses another identity before the flow closes (IDENT-RES-014)', async () => {
    const w = world()
    const p = phone(w)
    const ben = { ...ana(), id: 'prn-ben', actorIdentity: directoryActorOf(HOME.key, 'p-2'), directoryEntryId: 'p-2' }
    const asking = ask(w, { purpose: 'visitor', bound: ben })
    await settle()
    await p.chooses(['email'])
    await p.answers('1', { address: 'ana.rios@northwind.example', locale: 'en' })
    await p.answers('1', { code: codeIn(w.mails[0]) })
    expect(await asking).toEqual({ outcome: 'not-accepted', code: 'another-identity' })
    expect(problems(w)).toEqual(['another-identity'])
    expect(closes(w)).toEqual([])
  })
})

describe('the document step (IDENT-DIR-003, IDENT-AUTH-017)', () => {
  const read = async (w: World) => {
    const request = w.calls.filter((c) => c.method === 'requestEmrtd').at(-1) as Call
    expect(request.args).toEqual(['conn-1', exchangeOf(w).flowId])
    const results = resultsSent(w).length
    expect(
      w.authenticator.onDocument('conn-1', (request.result as { id: string }).id, true, { dataGroups: chip() })
    ).toBe(true)
    // the chip's portrait takes a moment to decode
    for (let i = 0; i < 100 && resultsSent(w).length === results; i++) await settle(20)
    await settle()
  }

  it('the passport alone identifies the one entry it matches, with no face match', async () => {
    const w = world()
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['passport'])
    expect(stepsSent(w)).toEqual([{ step: '1', method: 'passport', type: 'document' }])
    await read(w)
    expect(await asking).toMatchObject({
      outcome: 'accepted',
      facts: { actorIdentity: 'org:EE:1|directory|p-1', moreEvidence: [{ kind: 'document', entry: 'document' }] },
    })
  })

  it('a passport that matches no single entry ends no-match', async () => {
    const w = world()
    w.documentMatches = ['p-1', 'p-2']
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['passport'])
    await read(w)
    expect(await asking).toEqual({ outcome: 'not-accepted', code: 'no-match' })
    expect(resultsSent(w)).toEqual([{ step: '1', outcome: 'failed', reason: 'no-match' }])
  })

  it('an address and a passport of two people end different-identities', async () => {
    const w = world()
    w.documentMatches = ['p-2']
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['passport', 'email'])
    // the identifying methods run in the order the combination lists them
    expect(stepsSent(w)[0]).toMatchObject({ step: '1', method: 'passport' })
    await read(w)
    expect(stepsSent(w)[1]).toMatchObject({ step: '2', method: 'email', ask: 'address' })
    await p.answers('2', { address: 'ana.rios@northwind.example', locale: 'en' })
    await p.answers('2', { code: codeIn(w.mails[0]) })
    expect(await asking).toEqual({ outcome: 'not-accepted', code: 'different-identities' })
    expect(problems(w)).toEqual(['different-identities'])
  })
})

describe('the authenticator app and the passkey (IDENT-AUTH-012, IDENT-AUTH-013)', () => {
  let w: World
  beforeEach(() => {
    w = world()
    w.principals.set('prn-ana', ana())
  })

  it('confirms the entry the email found with a code of the secret that Principal enrolled', async () => {
    const secret = newTotpSecret()
    await w.enrolments.setAuthenticatorApp('prn-ana', base32Encode(secret))
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['otp', 'email'])
    // the confirming method runs after the identifying one, whatever the order of the choice
    expect(stepsSent(w)[0]).toMatchObject({ method: 'email' })
    await p.answers('1', { address: 'ana.rios@northwind.example', locale: 'en' })
    await p.answers('1', { code: codeIn(w.mails[0]) })
    expect(stepsSent(w).at(-1)).toEqual({
      step: '2',
      method: 'otp',
      type: 'authenticator-app',
      ask: 'code',
      triesLeft: 5,
    })
    // a code of another secret is wrong
    await p.answers('2', { code: hotp(newTotpSecret(), totpCounter(Date.now())) })
    expect(stepsSent(w).at(-1)).toMatchObject({ step: '2', triesLeft: 4, error: 'wrong-code' })
    const counter = totpCounter(Date.now())
    await p.answers('2', { code: hotp(secret, counter) })
    expect(await asking).toMatchObject({
      outcome: 'accepted',
      facts: { actorIdentity: 'org:EE:1|directory|p-1', authentication: { types: ['authenticator-app', 'email'] } },
    })
    // the code is taken once
    expect((await w.enrolments.get('prn-ana'))['authenticator-app']?.lastCounter).toBe(counter)
  })

  it('identifies the Principal a passkey was enrolled for, by an assertion over the challenge for the app-link domain', async () => {
    const passkey = makePasskey()
    const made = verifyRegistration({ attestation: passkey.attestation('c'), challenge: 'c', rpId: RP })
    if (!made.ok) throw new Error(made.reason)
    await w.enrolments.setPasskey('prn-ana', made.passkey)
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['key'])
    const step = stepsSent(w)[0]
    expect(step).toMatchObject({ step: '1', method: 'key', type: 'passkey', ask: 'assertion', rpId: RP })
    expect(Buffer.from(String(step.challenge), 'base64url')).toHaveLength(32)
    await p.answers('1', { assertion: passkey.assertion(String(step.challenge)) })
    expect(await asking).toMatchObject({
      outcome: 'accepted',
      facts: { actorIdentity: 'org:EE:1|directory|p-1', directoryEntryId: 'p-1', backingIdentity: { id: 'org:EE:1' } },
    })
    expect((await w.enrolments.get('prn-ana')).passkey?.signCount).toBe(1)
    // an assertion for another relying party fails the step
    const again = ask(w)
    await settle()
    await p.chooses(['key'])
    const next = stepsSent(w).at(-1)
    await p.answers('1', { assertion: passkey.assertion(String(next?.challenge), { rpId: 'app.ayni.org', count: 2 }) })
    expect(await again).toEqual({ outcome: 'not-accepted', code: 'step-failed' })
  })

  it('a passkey nobody enrolled finds nobody', async () => {
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['key'])
    await p.answers('1', { assertion: makePasskey().assertion(String(stepsSent(w)[0].challenge)) })
    expect(await asking).toEqual({ outcome: 'not-accepted', code: 'no-match' })
  })
})

describe('a declined face-match consent (D152, IDENT-AUTH-011, FLOW-SIGNIN-008/012, O91)', () => {
  /** Ana chooses [email, face], passes the email step, and declines the consent of the face step (step 2). */
  const declineFace = async (w: World, p: ReturnType<typeof phone>) => {
    await p.chooses(['email', 'face'])
    await p.answers('1', { address: 'ana.rios@northwind.example', locale: 'en' })
    await p.answers('1', { code: codeIn(w.mails[0]) })
    expect(stepsSent(w).at(-1)).toMatchObject({ step: '2', method: 'face', type: 'face-match', ask: 'consent' })
    await p.answers('2', { consent: false })
  }

  it('ends the face step consent-declined with no call and no refusal, and runs the new combination in the same flow', async () => {
    const w = world({ takesCalls: true, faces: true })
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await declineFace(w, p)
    // the only result of a declined consent: failed, consent-declined; no call offered, no problem report, open flow
    expect(resultsSent(w)).toEqual([
      { step: '1', outcome: 'passed' },
      { step: '2', outcome: 'failed', reason: 'consent-declined' },
    ])
    expect(w.calls.filter((c) => c.method === 'startFaceCall')).toEqual([])
    expect(problems(w)).toEqual([])
    expect(closes(w)).toEqual([])
    // the new choice on the same request: every step runs again, the email that passed included, numbered on from 3
    await p.chooses(['email'])
    expect(stepsSent(w).at(-1)).toEqual({ step: '3', method: 'email', type: 'email', ask: 'address' })
    await p.answers('3', { address: 'ana.rios@northwind.example', locale: 'en' })
    expect(w.mails).toHaveLength(2)
    expect(stepsSent(w).at(-1)).toMatchObject({ step: '3', ask: 'code' })
    await p.answers('3', { code: codeIn(w.mails[1]) })
    const attempt = await asking
    expect(attempt).toMatchObject({
      outcome: 'accepted',
      facts: {
        actorIdentity: 'org:EE:1|directory|p-1',
        authentication: {
          combination: ['email'],
          types: ['email'],
          // the combination left stays in the steps, its face step failed consent-declined (agent §5.10)
          steps: [
            { method: 'email', type: 'email', outcome: 'passed' },
            { method: 'face', type: 'face-match', outcome: 'failed', reason: 'consent-declined' },
            { method: 'email', type: 'email', outcome: 'passed' },
          ],
        },
      },
    })
    // what the new combination proved, once: nothing of the face, the address of the step that ran last
    if (attempt.outcome !== 'accepted') throw new Error(attempt.outcome)
    expect(attempt.facts.moreEvidence).toHaveLength(1)
    expect(attempt.facts.moreEvidence?.[0]).toMatchObject({ kind: 'email', requestRef: exchangeOf(w).threadId })
    expect(resultsSent(w).at(-1)).toEqual({ step: '3', outcome: 'passed' })
    expect(closes(w)).toEqual(['completed'])
    expect(problems(w)).toEqual([])
  })

  it('gives the new choice five minutes of its own from the step result that ended the declined step', async () => {
    const w = world({ takesCalls: true, faces: true })
    w.authenticator.timings.choiceMs = 400
    const p = phone(w)
    const started = Date.now()
    const asking = ask(w)
    await settle()
    // the choice comes in time, and the steps take longer than the choice's time from the request
    await p.chooses(['email', 'face'])
    await p.answers('1', { address: 'ana.rios@northwind.example', locale: 'en' })
    await settle(300)
    await p.answers('1', { code: codeIn(w.mails[0]) })
    await settle(150)
    await p.answers('2', { consent: false })
    expect(Date.now() - started).toBeGreaterThan(400)
    // within the choice's time from the decline, but after it from the request: taken
    await settle(150)
    await p.chooses(['email'])
    expect(stepsSent(w).at(-1)).toMatchObject({ step: '3', method: 'email', ask: 'address' })
    expect(closes(w)).toEqual([])
    await p.answers('3', { address: 'ana.rios@northwind.example', locale: 'en' })
    await p.answers('3', { code: codeIn(w.mails[1]) })
    expect(await asking).toMatchObject({ outcome: 'accepted' })
  })

  it('leaves the request unanswered when no new choice comes in time, and closes the flow expired', async () => {
    const w = world({ takesCalls: true, faces: true })
    w.authenticator.timings.choiceMs = 150
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await declineFace(w, p)
    const declinedAt = Date.now()
    expect(await asking).toEqual({ outcome: 'unanswered' })
    // the time counts from the step result, not from the request
    expect(Date.now() - declinedAt).toBeGreaterThanOrEqual(100)
    expect(closes(w)).toEqual(['expired'])
    expect(problems(w)).toEqual([])
  })

  it('keeps the fifteen minutes of the flow: a new choice gets no more than the flow has left', async () => {
    const w = world({ takesCalls: true, faces: true })
    w.authenticator.timings.flowMs = 500
    w.authenticator.timings.choiceMs = 60_000
    const p = phone(w)
    const started = Date.now()
    const asking = ask(w)
    await settle()
    await declineFace(w, p)
    expect(await asking).toEqual({ outcome: 'unanswered' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(closes(w)).toEqual(['expired'])
  })

  it('refuses with malformed a new choice that holds the declined method', async () => {
    const w = world({ takesCalls: true, faces: true })
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await declineFace(w, p)
    // the DIDComm agent fails such a choice; the agent refuses it too when it is reported as chosen
    await p.chooses(['email', 'face'])
    expect(await asking).toEqual({ outcome: 'declined' })
    expect(problems(w)).toEqual(['malformed'])
    expect(stepsSent(w)).toHaveLength(3)
  })

  it('answers malformed to an exchange the DIDComm agent failed on a second choice that is not awaited (FLOW-SIGNIN-008)', async () => {
    const w = world({ takesCalls: true, faces: true })
    const p = phone(w)
    const asking = ask(w)
    await settle()
    await p.chooses(['email'])
    expect(stepsSent(w)).toEqual([{ step: '1', method: 'email', type: 'email', ask: 'address' }])
    // a second choice while the email step runs: the plugin fails the exchange malformed
    w.authenticator.onExchange({
      ...exchangeOf(w),
      state: 'failed',
      errorCode: 'malformed',
      errorDescription: 'the choice [email] comes while no choice is awaited',
    })
    expect(await asking).toEqual({ outcome: 'declined' })
    expect(problems(w)).toEqual(['malformed'])
    // the step is not ended on an exchange that failed: the problem report ends the flow
    expect(resultsSent(w)).toEqual([])
  })
})

describe('a wallet that takes no flows (IDENT-AUTH-005, O69)', () => {
  it('is asked a credential alone and nothing else', async () => {
    const calls: unknown[][] = []
    const client = { requestPresentation: async (...args: unknown[]) => void calls.push(args) }
    const pack = {
      metadata: { displayName: 'Northwind Support' },
      identity: { authentication: { ...AUTHENTICATION, combinations: [['email'], ['passport']] } },
    } as unknown as AgentPack
    const flow = new IdentityFlow(pack, client as never, {} as never, false, logger)
    expect(await flow.authenticate('conn-1', 'did:peer:x', false, false)).toEqual({ outcome: 'declined' })
    expect(calls).toEqual([])
  })
})
