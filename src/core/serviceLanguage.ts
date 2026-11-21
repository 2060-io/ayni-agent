/**
 * The service's own sentences in the person's language (decision 64; ayni-spec D94, INTX-AUTH-020..022, INTX-PREF-003).
 *
 * The code writes some messages itself, the email check's among them: the model never sees them. They are written in
 * English, finished (the numbers, the organization's name and the credential's label filled in), and shown in the
 * language the person reads:
 *
 * 1. That language is, in this order, the person's preference `language` (a BCP 47 tag the model stores when the person
 *    states one), the locale of the session (what the app sent when it opened it), the agent's default language.
 * 2. A sentence goes to the model with no context: a fixed instruction naming the target language and the parts to keep
 *    as written, and the sentence. No conversation, persona, platform rules, memory or preference; never anything the
 *    person typed. No call when the target is the sentence's own language (English: `en-US` and `en` alike).
 * 3. A translation is checked (every number of the sentence, every part to keep, as written), then kept by sentence and
 *    language in the store, so that a sentence costs one call per language, once.
 * 4. When a translation cannot be had (the space of the conversation does not allow the agent's model, an error, a time
 *    out, a check that fails), the message is in the agent's default language, itself the English sentence translated
 *    and kept; when even that cannot be had, it is in English, which the log says.
 */
import { createHash } from 'node:crypto'
import type { AgentPack } from '../config/packTypes.js'
import { callLogFields, measured } from '../llm/timing.js'
import type { ChatModel } from '../llm/types.js'
import type { StatsSink } from '../platform/stats.js'
import type { Store } from '../store/types.js'
import { nowIso } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { Principal, Session } from './types.js'

/** The preference that holds the language the person reads, a BCP 47 tag (INTX-PREF-003). */
export const LANGUAGE_PREFERENCE = 'language'
/** The language the code writes its sentences in. */
export const SOURCE_LANGUAGE = 'en'
/** How long a translation may take before the fallback is used. */
export const TRANSLATION_TIMEOUT_MS = 5000
/** The start of the instruction of a translation request: what the stub model recognizes. */
export const TRANSLATION_INSTRUCTION_HEAD = 'Translate the text of the user from English into the language'

/**
 * A BCP 47 tag in its canonical form (`es`, `pt-BR`), or undefined when the value is not one; its language is a code
 * of two or three letters (ISO 639), so that a word such as `Spanish` is not taken for one.
 */
export function languageTag(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/_/g, '-')
  if (!trimmed || trimmed.length > 35) return undefined
  try {
    const [tag] = Intl.getCanonicalLocales(trimmed)
    if (!tag || !/^[a-z]{2,3}$/.test(primaryOf(tag)) || primaryOf(tag) === 'und') return undefined
    return tag
  } catch {
    return undefined
  }
}

/** The primary language subtag of a tag, in lower case: `en` for `en-US`. */
export function primaryOf(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase()
}

/** Whether two tags name the same language, whatever their region or script. */
export function sameLanguage(a: string, b: string): boolean {
  return primaryOf(a) === primaryOf(b)
}

/** The instruction of a translation request: the target language and what to keep, and nothing of the conversation. */
export function translationInstruction(target: string, keep: string[]): string {
  const kept = keep.length ? ` Keep these exactly as written: ${keep.map((k) => `"${k}"`).join(', ')}.` : ''
  return `${TRANSLATION_INSTRUCTION_HEAD} whose BCP 47 tag is ${target}. It is a message a service shows to a person. Keep every number in digits.${kept} Answer with the translation only, with no quotes and no comment.`
}

/**
 * Whether a translation keeps what the sentence must keep: every sequence of digits, as many times, and every part to
 * keep, as written.
 */
export function keepsWhatItMust(source: string, translation: string, keep: string[]): boolean {
  if (!translation.trim()) return false
  const digits = (text: string) => (text.match(/\d+/g) ?? []).sort()
  const want = digits(source)
  const have = digits(translation)
  for (const sequence of new Set(want)) {
    if (have.filter((d) => d === sequence).length < want.filter((d) => d === sequence).length) return false
  }
  return keep.every((part) => !part || translation.includes(part))
}

/** A finished sentence of the code, with the parts of it that a translation must keep as written. */
export interface ServiceSentence {
  text: string
  keep?: string[]
}

export interface ServiceLanguageDeps {
  store: Store
  llm: ChatModel
  pack: AgentPack
  stats: StatsSink
  logger: Logger
  /** the person's preference `language`, read by the code, never shown to the model */
  preferredLanguage(principal: Principal, session: Session): Promise<string | undefined>
  /** whether the space of the session's conversation allows the agent's model (SPACE-CONV-004) */
  modelAllowed(principal: Principal, session: Session): Promise<boolean>
}

export class ServiceLanguage {
  /** the translations being made, by sentence and language: two messages at once make one call */
  private readonly pending = new Map<string, Promise<string | undefined>>()
  /** shorter for the tests */
  public timeoutMs = TRANSLATION_TIMEOUT_MS

  public constructor(private readonly deps: ServiceLanguageDeps) {}

  /** The agent's default language. */
  public get defaultLanguage(): string {
    return languageTag(this.deps.pack.language.agent) ?? SOURCE_LANGUAGE
  }

  /** The language the person reads (INTX-PREF-003): their preference, else the session's locale, else the default. */
  public async languageOf(principal: Principal | undefined, session: Session | undefined): Promise<string> {
    if (principal && session) {
      const preferred = languageTag(
        await this.deps.preferredLanguage(principal, session).catch((err) => {
          this.deps.logger.warn({ err, principalId: principal.id }, 'the language preference could not be read')
          return undefined
        })
      )
      if (preferred) return preferred
    }
    return languageTag(session?.locale) ?? this.defaultLanguage
  }

  /**
   * A finished sentence in the language the person reads (INTX-AUTH-020..022): kept, or translated with no context and
   * kept, or in the agent's default language, or in English.
   */
  public async render(
    sentence: ServiceSentence,
    principal: Principal | undefined,
    session: Session | undefined
  ): Promise<string> {
    const target = await this.languageOf(principal, session)
    if (sameLanguage(target, SOURCE_LANGUAGE)) return sentence.text
    const allowed = principal && session ? await this.allowed(principal, session) : false
    const translated = await this.translation(sentence, target, allowed)
    if (translated !== undefined) return translated
    // the default language, itself a translation of the English sentence
    const fallback = this.defaultLanguage
    if (!sameLanguage(fallback, target)) {
      if (sameLanguage(fallback, SOURCE_LANGUAGE)) return sentence.text
      const inDefault = await this.translation(sentence, fallback, allowed)
      if (inDefault !== undefined) return inDefault
    }
    this.deps.logger.warn(
      { language: target, defaultLanguage: fallback },
      'a message of the service is shown in English: no translation into the language of the person or the default language could be had'
    )
    return sentence.text
  }

  private async allowed(principal: Principal, session: Session): Promise<boolean> {
    try {
      return await this.deps.modelAllowed(principal, session)
    } catch (err) {
      this.deps.logger.warn({ err }, 'whether the space allows the model could not be told: no translation')
      return false
    }
  }

  /** A kept translation, or a new one when a call is allowed; undefined when none can be had. */
  private async translation(sentence: ServiceSentence, target: string, mayCall: boolean): Promise<string | undefined> {
    const digest = sentenceDigest(sentence.text)
    const kept = await this.deps.store.translations.get(digest, target).catch((err) => {
      this.deps.logger.warn({ err }, 'a kept translation could not be read')
      return undefined
    })
    if (kept) return kept.text
    if (!mayCall) return undefined
    const key = `${digest}\n${target}`
    const running = this.pending.get(key)
    if (running) return running
    const made = this.translate(sentence, target, digest).finally(() => this.pending.delete(key))
    this.pending.set(key, made)
    return made
  }

  /** One call to the model, with no context; the translation is checked, and kept only when it holds. */
  private async translate(sentence: ServiceSentence, target: string, digest: string): Promise<string | undefined> {
    const keep = (sentence.keep ?? []).filter(Boolean)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref()
    let text = ''
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }
    try {
      const call = (async () => {
        const request = {
          messages: [
            { role: 'system' as const, content: translationInstruction(target, keep) },
            { role: 'user' as const, content: sentence.text },
          ],
          temperature: 0,
          maxOutputTokens: 400,
          signal: controller.signal,
        }
        // one log line per call, whether it completes, fails or is cut by the time limit (LLM-USAGE-004)
        const logCall = (measure: Parameters<typeof callLogFields>[0]) =>
          this.deps.logger.info({ purpose: 'translation', language: target, ...callLogFields(measure) }, 'model call')
        for await (const delta of measured(this.deps.llm, request, logCall)) {
          if (controller.signal.aborted) break
          if (delta.type === 'text') text += delta.text
          else if (delta.type === 'usage')
            usage = {
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
              cachedTokens: delta.cachedTokens ?? 0,
              cacheWriteTokens: delta.cacheWriteTokens ?? 0,
            }
        }
      })()
      // a call cut by the time limit may still fail after it: nothing waits for it any more
      call.catch(() => undefined)
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('the translation took too long')))
      )
      await Promise.race([call, aborted])
    } catch (err) {
      this.deps.logger.warn({ err, language: target }, 'a message of the service could not be translated')
      return undefined
    } finally {
      clearTimeout(timer)
    }
    this.account(target, usage)
    const translated = text.trim()
    if (!keepsWhatItMust(sentence.text, translated, keep)) {
      this.deps.logger.warn(
        { language: target },
        'a translation of a message of the service did not keep its numbers or names: not used'
      )
      return undefined
    }
    await this.deps.store.translations
      .set({
        digest,
        language: target,
        source: sentence.text,
        text: translated,
        model: this.deps.llm.id,
        createdAt: nowIso(),
      })
      .catch((err) => this.deps.logger.warn({ err }, 'a translation could not be kept'))
    return translated
  }

  /** The call's usage, counted with its own purpose: it is no part of a conversation (LLM-USAGE-001). */
  private account(
    language: string,
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number }
  ): void {
    const dims = { model: this.deps.llm.id, agent: this.deps.pack.metadata.id, purpose: 'translation' }
    this.deps.stats.emit('llm-input', usage.inputTokens, dims)
    this.deps.stats.emit('llm-cached', usage.cachedTokens, dims)
    this.deps.stats.emit('llm-cache-write', usage.cacheWriteTokens, dims)
    this.deps.stats.emit('llm-output', usage.outputTokens, dims)
  }
}

/** The key of a sentence among the kept translations. */
export function sentenceDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
