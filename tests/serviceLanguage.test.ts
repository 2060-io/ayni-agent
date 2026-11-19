/**
 * The service's own sentences in the person's language (decision 64; ayni-spec D94, INTX-AUTH-020..022, INTX-PREF-003):
 * the language order, no call for the sentence's own language, a translation kept and reused (across a restart too),
 * the request with no context, the checks of a translation, the fallback chain, an agent whose default language is not
 * English, and the space that does not allow the agent's model. Then over the agent: an email check in Spanish, the
 * preference `language`, and no address or code in any translation request or kept translation.
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { AgentPack } from '../src/config/packTypes.js'
import {
  keepsWhatItMust,
  languageTag,
  ServiceLanguage,
  sameLanguage,
  TRANSLATION_INSTRUCTION_HEAD,
} from '../src/core/serviceLanguage.js'
import type { Principal, Session } from '../src/core/types.js'
import type { StubChatModel } from '../src/llm/stub.js'
import type { ChatDelta, ChatModel, ChatRequest } from '../src/llm/types.js'
import type { Mailer, MailMessage } from '../src/platform/mail.js'
import { MemoryStore } from '../src/store/memory.js'
import { createLogger } from '../src/util/logger.js'
import {
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
import { testEnv } from './helpers.js'

/** A model that answers translation requests as it is told to, and keeps every request. */
class FakeTranslator implements ChatModel {
  public readonly id = 'fake/translator'
  public readonly multimodal = false
  public readonly requests: ChatRequest[] = []
  /** what it answers for a target language: a text, an error, or nothing ever */
  public answer: (target: string, text: string) => string | Error | 'hang' = (target, text) => `[${target}] ${text}`

  public async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
    this.requests.push(req)
    const target = /whose BCP 47 tag is (\S+?)\. /.exec(String(req.messages[0]?.content))?.[1] ?? '?'
    const answer = this.answer(target, String(req.messages[1]?.content))
    if (answer instanceof Error) throw answer
    if (answer === 'hang') {
      await new Promise((resolve) => {
        req.signal?.addEventListener('abort', resolve)
      })
      return
    }
    yield { type: 'text', text: answer }
    yield { type: 'usage', inputTokens: 40, outputTokens: 20 }
  }
}

const warnings: string[] = []
const logger = {
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  warn: (_obj: unknown, msg?: string) => void warnings.push(msg ?? String(_obj)),
} as never

const PRINCIPAL = { id: 'prn-1' } as Principal
const session = (locale?: string) => ({ id: 'ses-1', locale }) as Session
const WRONG = { text: 'That code is not right. 4 tries are left.' }
const QUESTION = {
  text: 'To issue your Northwind badge, the agent checks your email address. Which email address does Northwind Logistics know you by?',
  keep: ['Northwind badge', 'Northwind Logistics'],
}

function service(
  options: {
    agentLanguage?: string
    preferred?: string
    allowed?: boolean
    store?: MemoryStore
    llm?: FakeTranslator
  } = {}
) {
  const llm = options.llm ?? new FakeTranslator()
  const store = options.store ?? new MemoryStore()
  const stats: { name: string; value: number; dims?: Record<string, string> }[] = []
  const language = new ServiceLanguage({
    store,
    llm,
    pack: { language: { agent: options.agentLanguage ?? 'en' }, metadata: { id: 'agent-test' } } as AgentPack,
    stats: { emit: (name, value, dims) => void stats.push({ name, value, dims }) },
    logger,
    preferredLanguage: async () => options.preferred,
    modelAllowed: async () => options.allowed ?? true,
  })
  return { language, llm, store, stats }
}

describe('language tags (INTX-PREF-003)', () => {
  it('takes a BCP 47 tag in its canonical form, and refuses a word or a tag with no language', () => {
    expect(languageTag('es')).toBe('es')
    expect(languageTag(' pt_br ')).toBe('pt-BR')
    expect(languageTag('EN-us')).toBe('en-US')
    expect(languageTag('zh-hant-tw')).toBe('zh-Hant-TW')
    for (const value of ['Spanish', 'und', 'x', '', 42, undefined]) expect(languageTag(value)).toBeUndefined()
    expect(sameLanguage('en-US', 'en')).toBe(true)
    expect(sameLanguage('pt-BR', 'es')).toBe(false)
  })

  it('checks that a translation keeps every number and every part to keep', () => {
    expect(keepsWhatItMust(WRONG.text, 'Ese código no es correcto. Quedan 4 intentos.', [])).toBe(true)
    expect(keepsWhatItMust(WRONG.text, 'Ese código no es correcto. Quedan cuatro intentos.', [])).toBe(false)
    expect(keepsWhatItMust('valid for 10 minutes', 'válido 1 0 minutos', [])).toBe(false)
    expect(
      keepsWhatItMust(
        QUESTION.text,
        'Para emitir su Northwind badge, ¿qué dirección conoce Northwind Logistics?',
        QUESTION.keep
      )
    ).toBe(true)
    expect(
      keepsWhatItMust(
        QUESTION.text,
        'Para emitir su credencial Northwind, ¿qué dirección conoce Northwind Logistics?',
        QUESTION.keep
      )
    ).toBe(false)
    expect(keepsWhatItMust(WRONG.text, '   ', [])).toBe(false)
  })
})

describe('the language the person reads (INTX-PREF-003)', () => {
  it('is their preference, else the locale of the session, else the agent default language', async () => {
    expect(await service({ preferred: 'es' }).language.languageOf(PRINCIPAL, session('fr'))).toBe('es')
    expect(await service({ preferred: 'Spanish' }).language.languageOf(PRINCIPAL, session('fr-CA'))).toBe('fr-CA')
    expect(await service().language.languageOf(PRINCIPAL, session('fr'))).toBe('fr')
    expect(await service({ agentLanguage: 'de' }).language.languageOf(PRINCIPAL, session())).toBe('de')
    expect(await service({ agentLanguage: 'de' }).language.languageOf(undefined, undefined)).toBe('de')
  })
})

describe('a sentence of the service in the person language (INTX-AUTH-020..022)', () => {
  it('makes no call when the person reads the language of the sentence, whatever the region', async () => {
    const { language, llm } = service({ preferred: 'en-GB' })
    expect(await language.render(WRONG, PRINCIPAL, session('es'))).toBe(WRONG.text)
    expect(llm.requests).toHaveLength(0)
  })

  it('asks the model with no context: a fixed instruction with the language and the parts to keep, and the sentence', async () => {
    const { language, llm, stats } = service({ preferred: 'es' })
    expect(await language.render(QUESTION, PRINCIPAL, session())).toBe(`[es] ${QUESTION.text}`)
    expect(llm.requests).toHaveLength(1)
    const [request] = llm.requests
    expect(request?.tools).toBeUndefined()
    expect(request?.cacheKey).toBeUndefined()
    expect(request?.messages).toEqual([
      {
        role: 'system',
        content: `${TRANSLATION_INSTRUCTION_HEAD} whose BCP 47 tag is es. It is a message a service shows to a person. Keep every number in digits. Keep these exactly as written: "Northwind badge", "Northwind Logistics". Answer with the translation only, with no quotes and no comment.`,
      },
      { role: 'user', content: QUESTION.text },
    ])
    // its usage is counted with a purpose of its own, outside any conversation
    expect(stats.map((s) => [s.name, s.dims?.purpose, s.dims?.conversation])).toContainEqual([
      'llm-input',
      'translation',
      undefined,
    ])
  })

  it('keeps a translation by sentence and language: no second call, nor after a restart', async () => {
    const { language, llm, store } = service({ preferred: 'es' })
    await language.render(WRONG, PRINCIPAL, session())
    await language.render(WRONG, PRINCIPAL, session())
    expect(llm.requests).toHaveLength(1)
    // a new process over the same store
    const again = service({ preferred: 'es', store })
    expect(await again.language.render(WRONG, PRINCIPAL, session())).toBe(`[es] ${WRONG.text}`)
    expect(again.llm.requests).toHaveLength(0)
    // another language, another sentence: one call each
    await service({ preferred: 'fr', store, llm }).language.render(WRONG, PRINCIPAL, session())
    await language.render({ text: 'That code is not right. 3 tries are left.' }, PRINCIPAL, session())
    expect(llm.requests).toHaveLength(3)
    expect((await store.translations.list()).map((t) => [t.language, t.text])).toEqual([
      ['es', `[es] ${WRONG.text}`],
      ['fr', `[fr] ${WRONG.text}`],
      ['es', '[es] That code is not right. 3 tries are left.'],
    ])
  })

  it('falls back to English, keeping nothing, when the translation fails and the default language is English', async () => {
    for (const failure of [new Error('provider down'), 'Quedan cuatro intentos.', 'hang'] as const) {
      const { language, llm, store } = service({ preferred: 'es' })
      language.timeoutMs = 50
      llm.answer = () => failure
      expect(await language.render(WRONG, PRINCIPAL, session())).toBe(WRONG.text)
      expect(await store.translations.list()).toEqual([])
    }
  })

  it('falls back to the default language, itself translated and kept, then to English with a warning', async () => {
    const { language, llm, store } = service({ agentLanguage: 'fr', preferred: 'es' })
    llm.answer = (target, text) => (target === 'es' ? new Error('no Spanish today') : `[${target}] ${text}`)
    expect(await language.render(WRONG, PRINCIPAL, session())).toBe(`[fr] ${WRONG.text}`)
    expect((await store.translations.list()).map((t) => t.language)).toEqual(['fr'])
    // neither can be had
    warnings.length = 0
    const none = service({ agentLanguage: 'fr', preferred: 'es' })
    none.llm.answer = () => new Error('down')
    expect(await none.language.render(WRONG, PRINCIPAL, session())).toBe(WRONG.text)
    expect(warnings.some((w) => /shown in English/.test(w))).toBe(true)
  })

  it('writes in the agent default language when it is not English and the person names no other', async () => {
    const { language, llm } = service({ agentLanguage: 'es' })
    expect(await language.render(WRONG, PRINCIPAL, session())).toBe(`[es] ${WRONG.text}`)
    expect(llm.requests).toHaveLength(1)
    // a person who reads English gets the sentence as written
    expect(await language.render(WRONG, PRINCIPAL, session('en-US'))).toBe(WRONG.text)
    expect(llm.requests).toHaveLength(1)
  })

  it('makes no call in a space that does not allow the agent model: a kept translation, else the fallback', async () => {
    const store = new MemoryStore()
    const refused = service({ agentLanguage: 'fr', preferred: 'es', allowed: false, store })
    expect(await refused.language.render(WRONG, PRINCIPAL, session())).toBe(WRONG.text)
    expect(refused.llm.requests).toHaveLength(0)
    // kept elsewhere, where the model is allowed: then used here with no call
    await service({ preferred: 'es', store }).language.render(WRONG, PRINCIPAL, session())
    expect(await refused.language.render(WRONG, PRINCIPAL, session())).toBe(`[es] ${WRONG.text}`)
    expect(refused.llm.requests).toHaveLength(0)
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
const isTranslation = (r: ChatRequest) =>
  r.messages[0]?.role === 'system' && String(r.messages[0].content).startsWith(TRANSLATION_INSTRUCTION_HEAD)

beforeAll(async () => {
  services = await mockServices()
  const fixture = directoryPack([ANA], { badge: 'email' })
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

describe('an email check in the language of the person, over the agent (decision 64)', () => {
  it('asks and answers in the language of the session, as messages of the service the model never sees', async () => {
    ana = await guest(running, 'ana-es', 'es')
    const question = textOf(await runText(running, ana, ISSUE))
    expect(question).toMatch(/^\[es\] To issue your Northwind badge, the agent checks your email address\./)
    expect(textOf(await runText(running, ana, 'mi correo es ana.rios@northwind.example'))).toMatch(
      /^\[es\] If this address is on the list of Northwind Logistics, a six-digit code was just sent to it\./
    )
    await until(() => sent.length === 1)
    const code = codeOf(sent[0])
    const wrong = code === '000000' ? '111111' : '000000'
    expect(textOf(await runText(running, ana, wrong))).toBe('[es] That code is not right. 4 tries are left.')
    // the same entries as before: the service's messages, with their source type
    const history = await historyOf(running, ana)
    expect(history.find((m) => String(m.content).startsWith('[es] That code'))?.metadata.sourceType).toBe(
      'auth-challenge'
    )
    // the model reads them as the agent's, in the language they were shown in; what the code took, as a record (D95)
    await runText(running, ana, 'gracias, ¿y ahora?')
    const conversation =
      model()
        .requests.filter((r) => !isTranslation(r))
        .at(-1)?.messages ?? []
    const assistant = conversation.filter((m) => m.role === 'assistant').map((m) => String(m.content))
    expect(assistant).toContain('[es] That code is not right. 4 tries are left.')
    expect(assistant.some((t) => t.startsWith('[es] If this address is on the list'))).toBe(true)
    expect(JSON.stringify(conversation)).not.toContain('ana.rios')
    expect(JSON.stringify(conversation)).not.toContain(wrong)
  })

  it('reuses a kept translation: the same sentence for another person costs no call', async () => {
    const before = model().requests.filter(isTranslation).length
    const other = await guest(running, 'other-es', 'es-MX')
    await runText(running, other, ISSUE)
    // es-MX is another tag than es: one call for it, then none for a third person who reads es-MX
    const third = await guest(running, 'third-es', 'es-MX')
    await runText(running, third, ISSUE)
    expect(model().requests.filter(isTranslation).length).toBe(before + 1)
    await runText(running, other, 'cancel')
  })

  it('follows the preference language before the locale, and the model stores it as a tag', async () => {
    const refused = textOf(
      await runText(running, ana, '/call principal_preferences {"action":"set","key":"language","value":"French"}')
    )
    expect(refused).toContain('must be a BCP 47 language tag')
    await runText(running, ana, '/call principal_preferences {"action":"set","key":"Language","value":"fr_ca"}')
    // sealed in the store (D77): read as the person reads them
    const own = await running.agent.memory.ownPreferences(
      ana.principal,
      (await running.agent.sessions.get(ana.sessionId)) as Session
    )
    expect(own.map((p) => [p.key, p.value])).toEqual([['language', 'fr-CA']])
    const code = codeOf(sent[0])
    const wrong = code === '222222' ? '333333' : '222222'
    expect(textOf(await runText(running, ana, wrong))).toBe('[fr-CA] That code is not right. 3 tries are left.')
  })

  it('never puts the address or a code typed in a check in a translation request or a kept translation', async () => {
    const code = codeOf(sent[0])
    expect(textOf(await runText(running, ana, code))).toMatch(/^\[fr-CA\] Your email address is verified\./)
    const translations = JSON.stringify(model().requests.filter(isTranslation))
    const kept = JSON.stringify(await running.agent.store.translations.list())
    expect(translations.length).toBeGreaterThan(0)
    for (const secret of [code, '000000', '111111', '222222', '333333', 'ana.rios', 'mi correo'])
      for (const text of [translations, kept]) expect(text).not.toContain(secret)
  })
})
