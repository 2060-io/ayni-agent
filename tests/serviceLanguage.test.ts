import { describe, expect, it } from 'vitest'
import type { AgentPack } from '../src/config/packTypes.js'
import {
  keepsWhatItMust,
  languageTag,
  ServiceLanguage,
  sameLanguage,
  TRANSLATION_INSTRUCTION_HEAD,
} from '../src/core/serviceLanguage.js'
import type { Principal, Session } from '../src/core/types.js'
import type { ChatDelta, ChatModel, ChatRequest } from '../src/llm/types.js'
import { MemoryStore } from '../src/store/memory.js'

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
