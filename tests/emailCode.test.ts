/**
 * A badge from the user directory by email code, over the real agent (in-memory store, stub model), with a mocked
 * DIDComm agent and trust resolver and a mailer that keeps what it is given (decision 62; ayni-spec D88, D89):
 * INTX-AUTH-011..015, INTX-ISSUE-005/006/020/021, IDENT-DIR-004/005/006, IDENT-RES-017, MEM-RET-006, PROF-RUN-015,
 * PLAT-MAIL-001/002.
 *
 * The badge is offered to the mocked DIDComm agent and accepted by the test, as a wallet would: a real DIDComm agent and
 * a wallet are not part of these tests.
 */
import { rmSync } from 'node:fs'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, type RunningAgent } from '../src/app.js'
import { actorIdentityOf } from '../src/channels/didcomm/identity.js'
import { emailId, subjectIdKey } from '../src/core/issuance.js'
import type { AuthChallengeRecord, Principal } from '../src/core/types.js'
import type { StubChatModel } from '../src/llm/stub.js'
import type { Mailer, MailMessage } from '../src/platform/mail.js'
import { createLogger } from '../src/util/logger.js'
import {
  AGENT_DID,
  BADGE,
  directoryPack,
  guest,
  HOME,
  historyOf,
  type MockServices,
  mintLocally,
  mockServices,
  type Person,
  runText,
  textOf,
  until,
} from './directoryFixtures.js'
import { testEnv } from './helpers.js'

const ANA = {
  id: 'p-0042',
  firstName: 'Ana',
  lastName: 'Ríos',
  email: 'ana.rios@northwind.example',
  department: 'Depot Rotterdam',
  roles: [],
}
const JONAS = { id: 'p-0043', firstName: 'Jonas', lastName: 'Weber', email: 'jonas.weber@northwind.example' }
const ISSUE = '/call issue_credential {"credential":"badge"}'

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
const pending = async () =>
  (await running.agent.store.challenges.listPending()).filter((c: AuthChallengeRecord) => c.type === 'email')
const offers = () => services.calls.filter((c) => c.url === '/v2/didcomm/credential-offer')

/** Everything the store holds, as text: what an operator with the database would read. */
async function storeText(): Promise<string> {
  const store = running.agent.store as unknown as Record<string, unknown>
  return JSON.stringify(store, (_key, value) => (value instanceof Map ? [...value.entries()] : value))
}

beforeAll(async () => {
  services = await mockServices()
  const fixture = directoryPack([ANA, JONAS], { badge: 'email' })
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

describe('the email code of a badge from the directory (D89)', () => {
  it('reports the claims of the directory pending, the email code being the action that obtains them (INTX-ISSUE-006/021)', async () => {
    ana = await guest(running, 'ana-wallet')
    const [badge] = (await running.agent.issuance?.requirements(ana.principal)) ?? []
    const byEmail = {
      type: 'issue_credential',
      profile: 'badge',
      challenge: 'email',
      note: expect.stringContaining('email address'),
    }
    expect(badge).toMatchObject({ credential: 'badge', state: 'ready' })
    expect(badge?.claims).toEqual([
      { name: 'badgeNumber', status: 'missing', action: byEmail },
      { name: 'name', status: 'pending', action: byEmail },
      { name: 'email', status: 'pending', action: byEmail },
      { name: 'department', status: 'pending', action: byEmail },
      { name: 'birthDate', status: 'available' },
      { name: 'photo', status: 'available' },
      { name: 'phoneNumber', status: 'available' },
    ])
  })

  it('ends the turn of the issuing tool with the code question in the conversation, nothing on the phone (INTX-AUTH-012)', async () => {
    const before = services.calls.length
    const calls = model().requests.length
    const events = await runText(running, ana, ISSUE)
    expect(textOf(events)).toMatch(
      /^To issue your Northwind badge, the agent checks your email address\. Which email address does Northwind Logistics know you by\?/
    )
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
    // nothing went to the capability channel: no flow, no request, no read, no message
    const toThePhone = services.calls
      .slice(before)
      .filter((c) => c.url.startsWith('/v2/didcomm/') && c.url !== '/v2/didcomm/peer-status/query')
    expect(toThePhone).toEqual([])
    // the model was called once, and never after the tool; its platform rules tell it the system runs the check
    expect(model().requests.length).toBe(calls + 1)
    expect(String(model().requests.at(-1)?.messages[1]?.content)).toContain(
      'An email check is run by the system in the conversation: never ask the person for an email address or a code yourself'
    )
    const history = await historyOf(running, ana)
    expect(history.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('Which email address'),
      metadata: { sourceType: 'auth-challenge' },
    })
    expect(await pending()).toHaveLength(1)
  })

  it('starts no second check while one waits (INTX-AUTH-012)', async () => {
    const session = await running.agent.sessions.get(ana.sessionId)
    const again = await running.agent.issuance?.issue(ana.principal, session as never, 'badge', 'model')
    expect(again?.outcome).toBe('challenge-waiting')
    expect(await pending()).toHaveLength(1)
  })

  it('answers a listed and an unlisted address the same, and sends a code to the listed one only (INTX-AUTH-014)', async () => {
    stranger = await guest(running, 'stranger-wallet')
    await runText(running, stranger, ISSUE)
    const toStranger = textOf(await runText(running, stranger, 'nobody@northwind.example'))
    const toAna = textOf(await runText(running, ana, 'Ana.Rios@Northwind.example'))
    expect(toAna).toBe(toStranger)
    expect(toAna).toMatch(
      /^If this address is on the list of Northwind Logistics, a six-digit code was just sent to it\./
    )
    await until(() => sent.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('ana.rios@northwind.example')
    // what an email code carries, and nothing else (PLAT-MAIL-002)
    const agent = running.agent.pack.metadata.displayName
    expect(sent[0]?.subject).toBe(`Your code for ${agent}`)
    expect(sent[0]?.text).toMatch(
      new RegExp(`^Your code for ${agent.replace(/[()]/g, '\\$&')} is \\d{6}\\.\n\nIt is valid for 10 minutes\\.`)
    )
    expect(sent[0]?.text).not.toMatch(/https?:/)
  })

  it('gives five tries in all, then lets the next message reach the model (INTX-AUTH-014)', async () => {
    const answers: string[] = []
    for (let i = 0; i < 5; i++) answers.push(textOf(await runText(running, stranger, '123456')))
    expect(answers.slice(0, 4)).toEqual([
      'That code is not right. 4 tries are left.',
      'That code is not right. 3 tries are left.',
      'That code is not right. 2 tries are left.',
      'That code is not right. 1 try is left.',
    ])
    expect(answers[4]).toBe(
      'That code is not right, and that was the last try: the email check has ended. Nothing was issued.'
    )
    const after = await runText(running, stranger, 'what now?')
    expect(textOf(after)).toMatch(/^You said:/)
    expect(JSON.stringify(model().requests.at(-1)?.messages)).toContain(
      'Identity check (email) for issue_credential: failed'
    )
  })

  it('takes a wrong try, then the right code: evidence of the address, and the badge offered with no turn of the model (INTX-AUTH-015)', async () => {
    const code = codeOf(sent[0])
    const wrong = code === '000000' ? '111111' : '000000'
    expect(textOf(await runText(running, ana, wrong))).toBe('That code is not right. 4 tries are left.')
    const calls = model().requests.length
    const answer = textOf(await runText(running, ana, ` ${code} `))
    expect(answer).toBe(
      'Your email address is verified. Your Northwind badge is now offered to your wallet: accept it there.'
    )
    // the issuance goes on by itself: the offer reaches the wallet's DIDComm agent
    await until(() => offers().length === 1)
    expect(model().requests.length).toBe(calls)
    const offer = offers()[0]?.body as {
      connectionId: string
      claims: { name: string; value: string }[]
      revocationRegistryDefinitionId?: string
      revocationRegistryIndex?: number
    }
    expect(offer.connectionId).toBe(ana.connectionId)
    const claims = Object.fromEntries(offer.claims.map((c) => [c.name, c.value]))
    // the entry's name, address and department; empty birth date, photo and phone; the number of the address (IDENT-DIR-005)
    expect(claims).toEqual({
      badgeNumber: emailId(subjectIdKey(Buffer.alloc(32, 7)), 'badge', 'ana.rios@northwind.example'),
      name: 'Ana Ríos',
      email: 'ana.rios@northwind.example',
      department: 'Depot Rotterdam',
      birthDate: '',
      photo: '',
      phoneNumber: '',
    })
    // a badge from the directory must be revocable: its definition is, and the offer names its registry and index
    expect(services.definitions).toEqual([
      expect.objectContaining({ relatedJsonSchemaCredentialId: expect.any(String), supportRevocation: true }),
    ])
    expect(offer.revocationRegistryDefinitionId).toMatch(/revreg-1$/)
    expect(offer.revocationRegistryIndex).toBe(0)
    // the wallet accepts it
    running.agent.credentialOffers?.onExchange({ credentialExchangeId: 'cex-1', state: 'done' } as never)
    await until(async () =>
      (await historyOf(running, ana)).some((m) => m.content === 'The credential is in your wallet.')
    )
    const records = await running.agent.evidence.list(ana.principal.id)
    const email = records.find((r) => r.kind === 'email')
    expect(email).toMatchObject({ entry: 'email', outcome: 'verified', stored: ['address'], revealed: ['address'] })
    const issuance = records.find((r) => r.kind === 'issuance')
    // the record names the entry (IDENT-DIR-006), its registry and index, and the evidence it came from
    expect(issuance).toMatchObject({
      entry: 'issuance:badge',
      directoryEntryId: 'p-0042',
      revocation: { registryDefinitionId: offer.revocationRegistryDefinitionId, index: 0 },
      evidenceRefs: [email?.id],
    })
    expect(await pending()).toHaveLength(0)
  })

  it('leaves the guest unidentified, and asks them to present the badge just issued (IDENT-RES-017)', async () => {
    const principal = (await running.agent.principals.get(ana.principal.id)) as Principal
    expect(principal.identityCredentialRef).toBeNull()
    expect(principal.directoryEntryId).toBeUndefined()
    await until(() =>
      services.calls.some(
        (c) => c.url === '/v2/didcomm/presentation-request' && c.body.connectionId === ana.connectionId
      )
    )
  })

  it('identifies the guest who presents the badge, with its entry, what was verified and the badge held (IDENT-DIR-006)', async () => {
    const offer = offers()[0]?.body as { claims: { name: string; value: string }[] }
    const claims = Object.fromEntries(offer.claims.map((c) => [c.name, c.value]))
    const { outcome, principal } = await running.agent.onIdentityPresented(ana.connectionId, {
      connectionType: 'verifiable-user-agent',
      actorIdentity: actorIdentityOf(HOME, BADGE, [claims.badgeNumber as string]),
      backingIdentity: { kind: 'org', id: HOME, name: 'Northwind Logistics' },
      organization: {
        key: HOME,
        name: 'Northwind Logistics',
        attributes: { countryCode: 'NL', registryId: '12345678' },
      },
      claims: { ...claims, userName: claims.name },
      userAgentVerified: true,
      identityCredentialRef: 'badge:pex-ana',
      evidence: {
        kind: 'presentation',
        entry: 'authentication',
        schema: BADGE,
        credentialDefinitionId: services.definitions[0]?.id,
        issuerDid: AGENT_DID,
        issuerOrganization: { key: HOME, name: 'Northwind Logistics' },
        values: claims,
      },
    })
    expect(outcome).toBe('identified')
    expect(principal?.id).not.toBe(ana.principal.id)
    expect(principal?.directoryEntryId).toBe('p-0042')
    // the guest's verified address and the badge issued to them are the identified person's
    const records = await running.agent.evidence.list(principal?.id as string)
    expect(records.map((r) => r.kind).sort()).toEqual(['email', 'issuance', 'presentation'])
    expect(await running.agent.evidence.list(ana.principal.id)).toEqual([])
    const [badge] = (await running.agent.issuance?.requirements(principal as Principal)) ?? []
    expect(badge?.state).toBe('held')
    // its web session goes on under the identified person: its conversation and its history with it
    const about = await running.app.inject({
      method: 'GET',
      url: '/agui/v3/sessions/about-me',
      headers: { authorization: `Bearer ${ana.sessionToken}` },
    })
    expect(
      about
        .json()
        .verified.map((v: { label: string; source: string }) => [v.label, v.source])
        .sort()
    ).toEqual([
      ['authentication', 'Northwind Logistics'],
      ['email', 'email'],
    ])
  })

  it("shows the messages of the check in history as auth-challenge; the model reads the code's, never the person's (INTX-AUTH-013, PROF-RUN-015, D95)", async () => {
    const code = codeOf(sent[0])
    const history = await historyOf(running, ana)
    const check = history.filter((m) => m.metadata.sourceType === 'auth-challenge' && m.role !== 'activity')
    expect(check.map((m) => [m.role, String(m.content).slice(0, 24)])).toEqual([
      ['assistant', 'To issue your Northwind b'.slice(0, 24)],
      ['user', 'Ana.Rios@Northwind.examp'],
      ['assistant', 'If this address is on th'],
      ['user', code === '000000' ? '111111' : '000000'],
      ['assistant', 'That code is not right. '],
      // the run's text, as the route takes it
      ['user', code],
      ['assistant', 'Your email address is ve'],
    ])
    // the person's messages the code took are marked as ones the model never received; the code's are not (PROF-HIST-013)
    expect(check.map((m) => m.metadata.modelVisible)).toEqual([
      undefined,
      false,
      undefined,
      false,
      undefined,
      false,
      undefined,
    ])
    // the outcome is a record for the model: the code's message told the person; no capability card (profile §6)
    expect(history.filter((m) => m.role === 'activity' && m.metadata.sourceType === 'auth-challenge')).toEqual([])
    const events = await runText(running, ana, 'thanks, what did you check?')
    expect(textOf(events)).toMatch(/^You said:/)
    const messages = model().requests.at(-1)?.messages ?? []
    const request = JSON.stringify(messages)
    expect(request).toContain('Identity check (email) for issue_credential: passed')
    for (const secret of [code, 'ana.rios', 'Ana.Rios']) expect(request).not.toContain(secret)
    // the code's messages are the agent's; a record stands in the place of each message the code took (decision 65)
    const said = (start: string) => messages.find((m) => typeof m.content === 'string' && m.content.startsWith(start))
    expect(said('To issue your Northwind badge')?.role).toBe('assistant')
    expect(said('If this address is on the list')?.role).toBe('assistant')
    expect(said('Your email address is verified')?.role).toBe('assistant')
    const records = messages
      .filter((m) => m.role === 'user' && String(m.content).includes('the code of the service took it'))
      .map((m) => m.content)
    expect(records).toEqual([
      '[system record, written by the system, not by the person and not by you: the person typed their email address here; the code of the service took it for the email check, and it is not shown to you]',
      '[system record, written by the system, not by the person and not by you: the person typed a code here; the code of the service took it for the email check, and it is not shown to you]',
      '[system record, written by the system, not by the person and not by you: the person typed a code here; the code of the service took it for the email check, and it is not shown to you]',
    ])
    // in the order they happened: the question, the record of the address, the answer to it
    const at = (m: unknown) => messages.indexOf(m as never)
    expect(at(said('To issue your'))).toBeLessThan(at(messages.find((m) => m.content === records[0])))
    expect(at(messages.find((m) => m.content === records[0]))).toBeLessThan(at(said('If this address')))
  })

  it("lets the person delete what they typed in the check within the window, with the code's answer to it (PROF-HIST-010)", async () => {
    const before = await historyOf(running, ana)
    const typed = before.find((m) => m.role === 'user' && String(m.content) === 'Ana.Rios@Northwind.example')
    const answer = before.find(
      (m) => m.role === 'assistant' && String(m.content).startsWith('If this address is on th')
    )
    if (!typed || !answer) throw new Error('the check is not in history')
    const response = await running.app.inject({
      method: 'DELETE',
      url: `/agui/v3/sessions/${ana.sessionId}/messages/${typed.id}`,
      headers: { authorization: `Bearer ${ana.sessionToken}` },
    })
    expect(response.statusCode).toBe(204)
    const after = (await historyOf(running, ana)).map((m) => m.id)
    expect(after).not.toContain(typed.id)
    expect(after).not.toContain(answer.id)
    // the rest of the check stays, and so does what it verified
    expect((await historyOf(running, ana)).some((m) => String(m.content).startsWith('Your email address is ve'))).toBe(
      true
    )
    expect(
      (
        await running.agent.evidence.list((await running.agent.sessions.get(ana.sessionId))?.principalId as string)
      ).some((r) => r.kind === 'email')
    ).toBe(true)
  })

  it('keeps neither the code nor the address in the clear in the store (INTX-AUTH-014)', async () => {
    const text = await storeText()
    expect(text).not.toContain(codeOf(sent[0]))
    expect(text.toLowerCase()).not.toContain('ana.rios@northwind.example')
    expect(text).not.toContain('nobody@northwind.example')
  })

  it('ends a check whose time is over, which the code says, and a right code too late reaches the model (INTX-AUTH-014)', async () => {
    const jonas = await guest(running, 'jonas-wallet')
    await runText(running, jonas, ISSUE)
    await runText(running, jonas, 'jonas.weber@northwind.example')
    await until(() => sent.length === 2)
    const code = codeOf(sent[1])
    // eleven minutes later: the timer of the process has not run (a restart, say), the check is past its time
    const [record] = await pending()
    if (!record) throw new Error('no check')
    running.agent.emailChecks?.stop()
    await running.agent.store.challenges.save({ ...record, expiresAt: new Date(Date.now() - 60_000).toISOString() })
    const late = await runText(running, jonas, code)
    expect(textOf(late)).toMatch(/^You said:/)
    expect(offers()).toHaveLength(1)
    const history = await historyOf(running, jonas)
    expect(history.map((m) => m.content)).toContain(
      'The code was not given in time: the email check has ended. Nothing was issued; ask again when you are ready.'
    )
    expect(JSON.stringify(model().requests.at(-1)?.messages)).toContain(
      'Identity check (email) for issue_credential: expired'
    )
  })

  it('ends a check whose address is not given in time, by its own timer (INTX-AUTH-014)', async () => {
    const checks = running.agent.emailChecks
    if (!checks) throw new Error('no email checks')
    checks.minutes = 0.004
    const late = await guest(running, 'late-wallet')
    await runText(running, late, ISSUE)
    await until(async () =>
      (await historyOf(running, late)).some(
        (m) =>
          m.content ===
          'No address was given in time: the email check has ended. Nothing was issued; ask again when you are ready.'
      )
    )
    expect(await pending()).toHaveLength(0)
    checks.minutes = 10
  })

  it('stops when the person types cancel; a text with no address reaches the model, and the check waits (decision 63)', async () => {
    const quick = await guest(running, 'quick-wallet')
    await runText(running, quick, ISSUE)
    expect(textOf(await runText(running, quick, 'my mail is ana'))).toMatch(/^You said: my mail is ana/)
    expect(await pending()).toHaveLength(1)
    expect(textOf(await runText(running, quick, 'Cancel'))).toBe('The email check is stopped. Nothing was issued.')
    expect(textOf(await runText(running, quick, 'hello'))).toMatch(/^You said:/)
  })
})

describe('without an SMTP server (INTX-AUTH-011, PLAT-MAIL-001)', () => {
  it('says so at start, naming the profile, and reports the claims of the email check unavailable', async () => {
    const lines: { msg?: string }[] = []
    const fixture = directoryPack([ANA], { badge: 'email' })
    const logger = pino({ level: 'warn' }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) })
    const quiet = await buildAgent(
      testEnv({
        agentPackPath: fixture.pack,
        vsAgentAdminUrl: services.url,
        veranaApiUrl: services.url,
        directoryPollSeconds: 0,
      }),
      logger,
      { drainMs: 200 }
    )
    try {
      expect(lines.some((l) => /email code is disabled for the issuance profiles \[badge\]/.test(l.msg ?? ''))).toBe(
        true
      )
      mintLocally(quiet)
      const person = await guest(quiet, 'no-smtp')
      const [badge] = (await quiet.agent.issuance?.requirements(person.principal)) ?? []
      expect(badge?.state).toBe('incomplete')
      expect(badge?.claims.filter((c) => c.status === 'unavailable').map((c) => c.name)).toEqual([
        'badgeNumber',
        'name',
        'email',
        'department',
      ])
    } finally {
      await quiet.stop()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
