/**
 * The messages of a person while an email check waits, and the model's tool on the check (decision 63; ayni-spec D89
 * amended): INTX-AUTH-013 (only a message that carries an address or a code is the code's), INTX-AUTH-016 to 019 (the
 * tool `email_check`: status, resend, cancel; the platform rule). Over the real agent (in-memory store, stub model), with
 * a mocked DIDComm agent and a mailer that keeps what it is given, as in tests/emailCode.test.ts.
 *
 * Found by Fabrice on devnet with 0.24.0: the email never arrived, he typed "Resend the email", and the code took it as
 * a wrong try of the code. Only `cancel` got him out.
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { AgentPack } from '../src/config/packTypes.js'
import { addressesIn, carriedBy, codesIn } from '../src/core/emailCheck.js'
import { renderPromptAddon } from '../src/core/promptAddon.js'
import type { AuthChallengeRecord } from '../src/core/types.js'
import type { StubChatModel } from '../src/llm/stub.js'
import type { Mailer, MailMessage } from '../src/platform/mail.js'
import { BundledToolSource } from '../src/tools/bundled.js'
import { createLogger } from '../src/util/logger.js'
import {
  bindWeb,
  directoryPack,
  guest,
  historyOf,
  type MockServices,
  mintLocally,
  mockServices,
  type Person,
  runText,
  textOf,
  until,
} from './directoryFixtures.js'
import { parseSse, testEnv } from './helpers.js'

describe('what a message carries for an email check (INTX-AUTH-013)', () => {
  it('takes the address from the words around it, in lower case, and none from a text without one', () => {
    expect(addressesIn('my email is Ana.Rios@Northwind.example.')).toEqual(['ana.rios@northwind.example'])
    expect(addressesIn('**ana.rios@northwind.example**')).toEqual(['ana.rios@northwind.example'])
    expect(addressesIn('<mailto:ana.rios@northwind.example>, thanks!')).toEqual(['ana.rios@northwind.example'])
    expect(addressesIn('"ana.rios@northwind.example"')).toEqual(['ana.rios@northwind.example'])
    expect(addressesIn('Ana.Rios@northwind.example or ana.rios@NORTHWIND.example')).toEqual([
      'ana.rios@northwind.example',
    ])
    expect(addressesIn('ana@northwind.example or ana.rios@northwind.example')).toHaveLength(2)
    for (const text of ['Resend the email', 'my mail is ana', 'ana@northwind', '@northwind.example', ''])
      expect(addressesIn(text)).toEqual([])
  })

  it('takes six digits, side by side or split by spaces or dashes, and no longer number', () => {
    expect(codesIn('482913')).toEqual(['482913'])
    expect(codesIn('the code is 482 913.')).toEqual(['482913'])
    expect(codesIn('482-913')).toEqual(['482913'])
    expect(codesIn('4 8 2 9 1 3')).toEqual(['482913'])
    expect(codesIn('482913 482913')).toEqual(['482913'])
    expect(codesIn('482913 or 123456?')).toEqual(['482913', '123456'])
    expect(codesIn('482913 123456')).toEqual(['482913', '123456'])
    expect(codesIn('my code: 482913.')).toEqual(['482913'])
    // a longer number, a phone number, a date, an amount, a decimal: no code
    const none = ['12345678', '+33 6 12 34 56 78', '2026-11-19', '123,456', '3.141592', '12345', 'Resend the email']
    for (const text of none) expect(codesIn(text)).toEqual([])
  })

  it('reads a message for its step only: an address is no code, a code no address; cancel stops either', () => {
    expect(carriedBy('my email is ana.rios@northwind.example', 'address')).toEqual({
      kind: 'address',
      address: 'ana.rios@northwind.example',
    })
    expect(carriedBy('482 913', 'code')).toEqual({ kind: 'code', code: '482913' })
    expect(carriedBy('482913', 'address')).toBeUndefined()
    expect(carriedBy('ana.rios@northwind.example', 'code')).toBeUndefined()
    expect(carriedBy('Resend the email', 'code')).toBeUndefined()
    expect(carriedBy('Resend the email', 'address')).toBeUndefined()
    expect(carriedBy('a@x.example b@x.example', 'address')).toEqual({ kind: 'several' })
    expect(carriedBy('123456 654321', 'code')).toEqual({ kind: 'several' })
    expect(carriedBy(' Cancel. ', 'code')).toEqual({ kind: 'stop' })
    expect(carriedBy('cancel the check please', 'code')).toBeUndefined()
  })
})

describe('the email_check tool and its platform rule (INTX-AUTH-016, INTX-AUTH-019)', () => {
  const profile = (type: 'email' | 'document') => ({
    credential: { jsonSchemaCredentialId: 'schema' },
    trigger: 'model',
    authChallenge: [{ type }],
    claims: {},
  })
  const names = async (type: 'email' | 'document') => {
    const pack = { identity: {}, issuance: { badge: profile(type) } } as unknown as AgentPack
    const source = new BundledToolSource({ pack } as never)
    return (await source.list()).map((spec) => spec.name)
  }

  it('is given to the model only when an issuance profile declares an email challenge', async () => {
    expect(await names('email')).toContain('email_check')
    expect(await names('document')).not.toContain('email_check')
  })

  it('is named by the platform rules only then, which say the code asks for the address and the code', () => {
    const base = {
      features: {} as never,
      agentLanguage: 'en',
      hasTools: true,
      hasRequestableTools: false,
      challengesConfigured: false,
    }
    const rules = renderPromptAddon({ ...base, emailChecks: true })
    expect(rules).toContain('never ask the person for an email address or a code yourself')
    expect(rules).toContain('While one waits, email_check tells its step, sends a new code or cancels it.')
    const without = renderPromptAddon({ ...base, emailChecks: false })
    expect(without).not.toContain('email_check')
    expect(without).not.toContain('email address')
  })
})

const ANA = {
  id: 'p-0042',
  firstName: 'Ana',
  lastName: 'Ríos',
  email: 'ana.rios@northwind.example',
  department: 'Depot Rotterdam',
  roles: [],
}
const ISSUE = '/call issue_credential {"credential":"badge"}'
const STATUS = '/call email_check {"action":"status"}'
const RESEND = '/call email_check {"action":"resend"}'
const CANCEL = '/call email_check {"action":"cancel"}'

let services: MockServices
let running: RunningAgent
let root: string
const sent: MailMessage[] = []
const mailer: Mailer = {
  from: 'Fleet support <fleet@northwind.example>',
  send: async (message) => {
    sent.push(message)
    return `mail-${sent.length}`
  },
}

const model = () => running.agent.llm as unknown as StubChatModel
const codeOf = (message: MailMessage | undefined) => /\b(\d{6})\b/.exec(message?.text ?? '')?.[1] as string
const offers = () => services.calls.filter((c) => c.url === '/v2/didcomm/credential-offer')
const checkOf = async (person: Person) =>
  (await running.agent.store.challenges.listPending()).find(
    (c: AuthChallengeRecord) => c.type === 'email' && c.principalId === person.principal.id
  )
/** The check's last code as sent more than thirty seconds ago, as if the person had waited for it. */
async function waited(person: Person): Promise<void> {
  const record = await checkOf(person)
  if (!record) throw new Error('no check')
  const codeSentAt = new Date(Date.now() - 31_000).toISOString()
  await running.agent.store.challenges.save({ ...record, details: { ...record.details, codeSentAt } })
}

beforeAll(async () => {
  services = await mockServices()
  // the last test reads the check's messages in the window: a budget that keeps the whole check in it, with the tool
  // reachable through an elevation and the record of the person that every request now carries (D112)
  const fixture = directoryPack([ANA], { badge: 'email', contextWindowTokens: 6000 })
  root = fixture.root
  running = await buildAgent(
    testEnv({
      agentPackPath: fixture.pack,
      vsAgentAdminUrl: services.url,
      veranaApiUrl: services.url,
      directoryPollSeconds: 0,
    }),
    createLogger('silent'),
    { drainMs: 200, mailer }
  )
  mintLocally(running)
}, 30_000)

afterAll(async () => {
  await running?.stop()
  await services?.app.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

let ana: Person
let stranger: Person
let resent = ''

describe('messages while an email check waits, and the model on the check (decision 63)', () => {
  it('gives a message with no address to the model at the address step, then takes the address from a sentence (INTX-AUTH-013)', async () => {
    ana = await guest(running, 'ana-wallet')
    await runText(running, ana, ISSUE)
    expect(
      model()
        .requests.at(-1)
        ?.tools?.map((t) => t.name)
    ).toContain('email_check')
    expect(textOf(await runText(running, ana, 'Hi, what is this about?'))).toMatch(/^You said: Hi, what is this/)
    const status = textOf(await runText(running, ana, STATUS))
    expect(status).toContain('"waiting":true')
    expect(status).toContain('"conversation":"this"')
    expect(status).toContain('"step":"address"')
    // a second device of the person, on the same conversation
    const phone = await bindWeb(running, ana.principal, ana.connectionId)
    const sessionOf = async (id: string) => (await running.agent.sessions.get(id))?.conversationId
    expect(await sessionOf(phone.sessionId)).toBe(await sessionOf(ana.sessionId))
    const run = await runText(running, ana, 'Sure, my email is **Ana.Rios@Northwind.example**.', 'u-address')
    const answer = textOf(run)
    expect(answer).toMatch(/^If this address is on the list of Northwind Logistics, a six-digit code was just sent/)
    // named at once as a message the model never receives, in the run and on the other device (PROF-STREAM-011)
    const address = (await historyOf(running, ana)).find((m) => m.metadata.externalId === 'u-address')
    const withheld = {
      type: 'CUSTOM',
      timestamp: expect.any(Number),
      name: 'ayni.messages.withheld',
      value: { conversationId: await sessionOf(ana.sessionId), messageIds: [address?.id], clientIds: ['u-address'] },
    }
    expect(run.filter((e) => e.name === 'ayni.messages.withheld')).toEqual([withheld])
    const onThePhone: string[] = []
    running.streams.attach(phone.sessionId, { write: (c) => onThePhone.push(c), end: () => undefined }, 0)()
    const phoneEvents = parseSse(onThePhone.join('')).map((e) => e.event)
    expect(phoneEvents.filter((e) => e.name === 'ayni.messages.withheld')).toEqual([withheld])
    expect(address?.metadata.modelVisible).toBe(false)
    expect(answer).toContain('If it does not arrive, say so: a new one can be sent.')
    await until(() => sent.length === 1)
    expect(sent[0]?.to).toBe('ana.rios@northwind.example')
    // the person's message the model answered is an ordinary one; the address is the check's
    const history = await historyOf(running, ana)
    const hello = history.find((m) => m.content === 'Hi, what is this about?')
    expect(hello?.metadata.sourceType).toBe('text')
    expect(hello?.metadata.modelVisible).toBeUndefined()
    // an ordinary message is named by no such event
    expect(phoneEvents.filter((e) => e.name === 'ayni.messages.withheld')).toHaveLength(1)
    expect(history.find((m) => String(m.content).startsWith('Sure, my email is'))?.metadata.sourceType).toBe(
      'auth-challenge'
    )
  })

  it('gives "Resend the email" to the model at the code step, and counts no try (INTX-AUTH-013)', async () => {
    const reply = await runText(running, ana, 'Resend the email')
    expect(textOf(reply)).toMatch(/^You said: Resend the email/)
    const history = await historyOf(running, ana)
    expect(history.find((m) => m.content === 'Resend the email')?.metadata.sourceType).toBe('text')
    const status = textOf(await runText(running, ana, STATUS))
    expect(status).toContain('"step":"code"')
    expect(status).toContain('"triesLeft":5')
    expect(status).toContain('"resendsLeft":3')
    // asked from another conversation, the check is said to wait there
    const elsewhere = await running.agent.emailChecks?.status(ana.principal.id, 'conv-elsewhere')
    expect(elsewhere).toMatchObject({ waiting: true, conversation: 'another', step: 'code' })
  })

  it('refuses a resend within thirty seconds, then sends a new code, and the first one is a wrong try (INTX-AUTH-017)', async () => {
    expect(textOf(await runText(running, ana, RESEND))).toContain(
      'Refused: the last code was sent less than 30 seconds ago. A new one can be sent in'
    )
    expect(sent).toHaveLength(1)
    await waited(ana)
    resent = textOf(await runText(running, ana, RESEND))
    expect(resent).toContain(
      'A new code was sent to the address the person gave, if it is on the list of the organization; the previous code no longer works. The person types the new one in this conversation; it is valid for 10 minutes. 2 more resends are possible.'
    )
    await until(() => sent.length === 2)
    expect(sent[1]?.to).toBe('ana.rios@northwind.example')
    // the ten minutes start again from the new sending
    const record = await checkOf(ana)
    expect(Date.parse(record?.expiresAt as string) - Date.now()).toBeGreaterThan(9.9 * 60_000)
    expect(textOf(await runText(running, ana, codeOf(sent[0])))).toBe('That code is not right. 4 tries are left.')
  })

  it('takes the new code split by a space within a sentence, and offers the badge (INTX-AUTH-013, INTX-AUTH-015)', async () => {
    const code = codeOf(sent[1])
    const answer = textOf(await runText(running, ana, `ok it is ${code.slice(0, 3)} ${code.slice(3)}`))
    expect(answer).toBe(
      'Your email address is verified. Your Northwind badge is now offered to your wallet: accept it there.'
    )
    await until(() => offers().length === 1)
    expect(await checkOf(ana)).toBeUndefined()
    expect(textOf(await runText(running, ana, STATUS))).toContain('No email check is waiting for this person.')
  })

  it("never gives the model the address or a code typed for the check, nor in a tool answer, and gives it the code's messages (INTX-AUTH-013, INTX-AUTH-016, D95)", async () => {
    await runText(running, ana, 'thanks!')
    const requests = JSON.stringify(model().requests)
    expect(requests).toContain('Identity check (email) for issue_credential: passed')
    const [first, second] = [codeOf(sent[0]), codeOf(sent[1])]
    for (const secret of [first, second, `${second.slice(0, 3)} ${second.slice(3)}`, 'ana.rios', 'Ana.Rios'])
      expect(requests).not.toContain(secret)
    // the code's messages are the agent's in the model's conversation; what the code took is a record there
    const last = model().requests.at(-1)?.messages ?? []
    const assistant = last.filter((m) => m.role === 'assistant').map((m) => String(m.content))
    expect(assistant).toContain('That code is not right. 4 tries are left.')
    expect(assistant.some((t) => t.startsWith('If this address is on the list of Northwind Logistics'))).toBe(true)
    expect(JSON.stringify(last)).toContain('the person typed their email address here; the code of the service took it')
  })

  it('answers a resend for an unlisted address as for a listed one, sends nothing, and refuses a fourth (INTX-AUTH-017)', async () => {
    stranger = await guest(running, 'stranger-wallet')
    await runText(running, stranger, ISSUE)
    expect(textOf(await runText(running, stranger, RESEND))).toContain(
      'Nothing was sent: the person has not given an address yet.'
    )
    await runText(running, stranger, 'nobody@northwind.example')
    const before = sent.length
    const answers: string[] = []
    for (let i = 0; i < 3; i++) {
      await waited(stranger)
      answers.push(textOf(await runText(running, stranger, RESEND)))
    }
    expect(answers[0]).toBe(resent)
    expect(answers[2]).toContain('0 more resends are possible.')
    await waited(stranger)
    expect(textOf(await runText(running, stranger, RESEND))).toContain(
      'Refused: 3 new codes were already sent in this check.'
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(before)
  })

  it('keeps the resends of a check that a restart left waiting (resume)', async () => {
    // a new process knows nothing of the check but what the store holds
    const checks = running.agent.emailChecks as unknown as {
      waiting: Map<string, string>
      stop(): void
      resume(): Promise<void>
    }
    checks.stop()
    checks.waiting.clear()
    await checks.resume()
    const status = textOf(await runText(running, stranger, STATUS))
    expect(status).toContain('"step":"code"')
    expect(status).toContain('"resendsLeft":0')
  })

  it('asks for one code when a message holds two, and counts no try (INTX-AUTH-013)', async () => {
    expect(textOf(await runText(running, stranger, '123456 or 654321?'))).toBe(
      'That message holds more than one code. Type the code of the last email only, or cancel.'
    )
    expect(textOf(await runText(running, stranger, STATUS))).toContain('"triesLeft":5')
  })

  it("cancels the check at the model's call: a code then reaches the model, which reads the check failed (INTX-AUTH-018)", async () => {
    expect(textOf(await runText(running, stranger, CANCEL))).toContain(
      'The email check is cancelled: nothing was issued.'
    )
    expect(await checkOf(stranger)).toBeUndefined()
    expect(textOf(await runText(running, stranger, '123456'))).toMatch(/^You said: 123456/)
    expect(JSON.stringify(model().requests.at(-1)?.messages)).toContain(
      'Identity check (email) for issue_credential: failed'
    )
    expect(textOf(await runText(running, stranger, CANCEL))).toContain('there is nothing to cancel')
    // a new check can start at once
    expect(textOf(await runText(running, stranger, ISSUE))).toMatch(/^To issue your Northwind badge/)
  })
})
