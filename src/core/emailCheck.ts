/**
 * The email code (decision 62; ayni-spec D89, INTX-AUTH-011..015, PROF-RUN-015, MEM-RET-006, PLAT-MAIL-002).
 *
 * The code of the agent, not the model, checks that a person holds an address of the user directory:
 *
 * 1. The issuing tool of a badge from the directory starts the check in the conversation it was called from, and the
 *    turn ends with the code's question (`start`): which email address the organization knows the person by.
 * 2. While the check waits, a message of the person in that conversation, from any of their sessions, is taken by the
 *    code (`take`) when it carries what the step waits for (decision 63, INTX-AUTH-013): an email address, taken from
 *    the words around it, then a code of six digits, which may be split by spaces or dashes. Each taken message is
 *    recorded as an `auth-challenge` entry and starts no turn; its content never reaches the model, which reads a record
 *    in its place, and the clients are told so (`ayni.messages.withheld`, `modelVisible: false`; decision 65). The
 *    code's answers are `auth-challenge` entries too, in the person's language (decision 64), which the model reads as
 *    the agent's. Any other message is the model's, as when no check waits: it counts no try, and the check waits.
 * 3. The answer to the address is the same whether or not an entry holds it; a code is sent only to an address an entry
 *    holds, by email, in the background, so that neither the words nor the time of the answer tell which. The code has
 *    six digits from a secure generator, is kept as a keyed hash only, is valid ten minutes from its sending, is used
 *    once, with five tries in all.
 * 4. A right code records evidence of the kind `email`, whose one attribute is the address (INTX-AUTH-015), and the
 *    issuance that started the check goes on by itself (`passed`). An address not given in ten minutes, a code not
 *    given right in its validity, or a fifth wrong try end the check; the code says so, and the model is told the
 *    outcome only, as a record of the system: `passed`, `failed` or `expired`.
 *
 * 5. The model follows the check with its tool `email_check` (INTX-AUTH-016..018): where it stands (`status`), a new code
 *    to the same address (`resend`: the previous code stops working, the ten minutes start again, three times at most,
 *    thirty seconds apart, the same answer whether or not an entry holds the address), or its end (`cancel`). No answer
 *    of the tool holds the address or the code.
 *
 * At most one check waits per Principal. The address typed while the check waits is kept sealed in the challenge
 * record, and dropped when the check ends; nothing of the check is in the clear but its state and its times.
 */
import { randomInt, timingSafeEqual } from 'node:crypto'
import { CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import { EMAIL_ENTRY } from '../config/pack.js'
import type { AgentPack } from '../config/packTypes.js'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import type { MemoryService } from '../memory/service.js'
import { isEmailAddress, type Mailer } from '../platform/mail.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { conversationOf } from './conversationOf.js'
import type { EvidenceService } from './evidence.js'
import type { IssuanceTrigger } from './issuance.js'
import type { TurnInput, TurnResult, TurnSink } from './orchestrator.js'
import type { ServiceLanguage, ServiceSentence } from './serviceLanguage.js'
import type { AuthChallengeRecord, MessageEntry, Principal, Session } from './types.js'

/** How long the address may wait after the question, and the code after its sending (INTX-AUTH-014). */
export const EMAIL_CHECK_MINUTES = 10
/** How many tries of the code, in all, whichever code they are for (INTX-AUTH-014). */
export const EMAIL_CODE_TRIES = 5
/** How many new codes a check may send, and how long after the previous sending (INTX-AUTH-017). */
export const EMAIL_CODE_RESENDS = 3
export const EMAIL_RESEND_AFTER_SECONDS = 30
/** The words that stop the check: the person's way out before the ten minutes. */
const STOP_WORDS = new Set(['cancel', 'stop', 'annuler', 'cancelar', 'parar', 'abbrechen'])

/** The payload of the entries of a check: what the person typed and what the code answered (MEM-RET-006). */
export const EMAIL_CHECK_KIND = 'email-check'
/** The CUSTOM event that names a message of the person the model never receives (PROF-STREAM-011). */
export const MESSAGES_WITHHELD = CUSTOM_EVENT.messagesWithheld

/** What the store keeps of a check beyond the challenge record: its state and times in the clear, the address sealed. */
interface EmailCheckDetails {
  conversationId: string
  /** the issuance profile that started it, and who started it: what goes on once it passes */
  profile: string
  by: IssuanceTrigger
  label: string
  step: 'address' | 'code'
  tries: number
  askedAt: string
  codeSentAt?: string
  /** the keyed hash of the code; none when the address is in no entry, so that no try can be right */
  codeHash?: string
  /** the address, sealed under a key of the record */
  sealed?: { keyRef: string; cipher: string }
  /** the session the last message of the check came from: where the code answers an expiry */
  lastSessionId?: string
  /** how many new codes the model had sent (INTX-AUTH-017) */
  resends?: number
}

/** Where a check stands, as the model's tool tells it: never the address, never the code (INTX-AUTH-016). */
export type EmailCheckStatus =
  | { waiting: false }
  | {
      waiting: true
      /** whether the check waits in the conversation the tool was called from, or in another of the person's */
      conversation: 'this' | 'another'
      credential: string
      step: 'address' | 'code'
      secondsLeft: number
      triesLeft: number
      resendsLeft: number
      /** at the code step: how long before a new code may be sent */
      resendInSeconds?: number
    }

/** What became of the model's `resend` (INTX-AUTH-017); `sent` whether or not an entry holds the address. */
export type EmailResendOutcome =
  | { outcome: 'sent'; conversation: 'this' | 'another'; resendsLeft: number; minutes: number }
  | { outcome: 'none' | 'no-address' | 'limit' }
  | { outcome: 'too-soon'; seconds: number }

/** What a message carries for the step of a check (INTX-AUTH-013); undefined: nothing, the message is the model's. */
export type CarriedByMessage =
  | { kind: 'stop' }
  | { kind: 'address'; address: string }
  | { kind: 'code'; code: string }
  /** more than one address, or more than one code: the code asks for one, and counts no try */
  | { kind: 'several' }

export interface EmailCheckDeps {
  store: Store
  memory: MemoryService
  evidence: EvidenceService
  crypto: EntryCrypto
  pack: AgentPack
  /** the user directory: does an entry hold this address (IDENT-DIR-004) */
  directory?: { byEmail(address: string): unknown | undefined }
  /** the SMTP server of the deployment; without it the check is not available (INTX-AUTH-011) */
  mailer?: Mailer
  /** the name of the agent's own organization, as the question names it */
  organizationName(): Promise<string | undefined>
  /**
   * the messages of the check in the language the person reads, translated with no context and kept (decision 64,
   * INTX-AUTH-020..022); without it they are in English
   */
  language?: Pick<ServiceLanguage, 'render'>
  /** a message of the code written outside a run (an expiry), shown in the conversation of the session */
  deliver(sessionId: string, entry: MessageEntry): Promise<void>
  /** the check passed: the action that started it goes on, without a turn of the model (INTX-AUTH-015) */
  passed(record: AuthChallengeRecord): Promise<void>
  logger: Logger
}

/** The outcome of a check, as the model is told it (INTX-AUTH-015). */
const OUTCOME_WORD: Record<string, string> = { completed: 'passed', failed: 'failed', expired: 'expired' }

export class EmailChecks {
  /** the check that waits for each Principal, by its id: one at a time (INTX-AUTH-012) */
  private readonly waiting = new Map<string, string>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** the messages of one Principal's check are taken one after the other */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** shorter times for the tests */
  public minutes = EMAIL_CHECK_MINUTES

  public constructor(private readonly deps: EmailCheckDeps) {}

  /** Whether the check can be served: an SMTP server, and a conversation that is not the capability channel. */
  public available(session?: Pick<Session, 'channelType'>): boolean {
    if (!this.deps.mailer || !this.deps.directory) return false
    // never on the capability channel (INTX-AUTH-012): a DIDComm chat is the wallet's own connection
    return session?.channelType !== 'didcomm'
  }

  /** The checks a restart left waiting: those past their time end, the others wait again. */
  public async resume(): Promise<void> {
    for (const record of await this.deps.store.challenges.listPending()) {
      if (record.type !== 'email') continue
      if (Date.parse(record.expiresAt) <= Date.now()) await this.expire(record.id)
      else {
        this.waiting.set(record.principalId, record.id)
        this.schedule(record)
      }
    }
  }

  public stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * Starts a check in the conversation of the session (INTX-AUTH-012): the question the code asks, which ends the turn
   * that called the issuing tool. A check of the Principal that waits already, here or elsewhere, starts none.
   */
  public async start(
    principal: Principal,
    session: Session,
    input: { profile: string; by: IssuanceTrigger; label: string }
  ): Promise<
    { started: true; question: string; challengeId: string } | { started: false; reason: 'waiting' | 'unavailable' }
  > {
    if (!this.available(session)) return { started: false, reason: 'unavailable' }
    const current = await this.current(principal.id)
    if (current) return { started: false, reason: 'waiting' }
    const now = nowIso()
    const details: EmailCheckDetails = {
      conversationId: conversationOf(session),
      profile: input.profile,
      by: input.by,
      label: input.label,
      step: 'address',
      tries: 0,
      askedAt: now,
      lastSessionId: session.id,
    }
    const record: AuthChallengeRecord = {
      id: prefixedId('chl'),
      type: 'email',
      principalId: principal.id,
      originSessionId: session.id,
      toolName: 'issue_credential',
      token: prefixedId('tok', 24),
      outcome: 'pending',
      details: details as unknown as Record<string, unknown>,
      createdAt: now,
      expiresAt: this.deadline(now),
    }
    await this.deps.store.challenges.save(record)
    this.waiting.set(principal.id, record.id)
    this.schedule(record)
    this.deps.logger.info(
      { challengeId: record.id, principalId: principal.id, profile: input.profile },
      'email check started (INTX-AUTH-012)'
    )
    const organization = await this.deps.organizationName()
    const question = await this.text(principal, session, {
      text: `To issue your ${input.label}, the agent checks your email address. Which email address does ${organization ?? 'your organization'} know you by? Type it in your next message: the agent's own code reads it, not the AI. Type cancel to stop.`,
      keep: [input.label, organization ?? ''],
    })
    return { started: true, challengeId: record.id, question }
  }

  /** Whether a check of the Principal waits, in any of its conversations: what every message is first compared with. */
  public waitsFor(principalId: string): boolean {
    return this.waiting.has(principalId)
  }

  /** The check that waits in a conversation for a Principal, if any. */
  public async waitingIn(principalId: string, conversationId: string): Promise<AuthChallengeRecord | undefined> {
    const record = await this.current(principalId)
    return record && detailsOf(record).conversationId === conversationId ? record : undefined
  }

  /**
   * A message of the Principal in a conversation where its check waits (INTX-AUTH-013): when it carries what the step
   * waits for, taken by the code, recorded with the code's answer as `auth-challenge` entries, answered in the run that
   * carried it, with no turn of the model. Undefined when no check waits there, or when the message carries nothing
   * for it: the message is the model's, counts no try, and the check keeps waiting.
   */
  public async take(
    session: Session,
    principal: Principal,
    input: TurnInput,
    sink: TurnSink
  ): Promise<TurnResult | undefined> {
    if (!this.waiting.has(principal.id)) return undefined
    return this.serial(principal.id, async () => {
      const record = await this.waitingIn(principal.id, conversationOf(session))
      if (!record) return undefined
      const details = detailsOf(record)
      const step = details.step
      // only what the step waits for is the code's: "Resend the email" is the model's (decision 63)
      const carried = carriedBy(input.entry.text ?? '', step)
      if (!carried) return undefined
      // `carried` names what the person typed, never its content: the record the model reads in its place (decision 65)
      const inbound = await this.deps.memory.append({
        ...input.entry,
        sourceType: 'auth-challenge',
        payload: { kind: EMAIL_CHECK_KIND, challengeId: record.id, step, carried: carried.kind },
      })
      await sink.emit({ type: 'inbound', entry: inbound })
      // the model never receives it: every bound session of the conversation draws it apart, at once (decision 65,
      // INTX-AUTH-023, PROF-STREAM-011)
      await sink.emit({
        type: 'custom',
        name: MESSAGES_WITHHELD,
        value: {
          conversationId: conversationOf(session),
          messageIds: [inbound.id],
          ...(inbound.externalId ? { clientIds: [inbound.externalId] } : {}),
        },
      })
      details.lastSessionId = session.id
      // the code's answers are finished English sentences, shown in the person's language (decision 64)
      let answer: ServiceSentence
      let ended: AuthChallengeRecord['outcome'] | undefined
      if (carried.kind === 'stop') {
        answer = { text: 'The email check is stopped. Nothing was issued.' }
        ended = 'failed'
      } else if (carried.kind === 'several') {
        const organization = await this.deps.organizationName()
        answer =
          step === 'address'
            ? {
                text: `That message holds more than one email address. Type the one address ${organization ?? 'your organization'} knows you by, or cancel.`,
                keep: [organization ?? ''],
              }
            : { text: 'That message holds more than one code. Type the code of the last email only, or cancel.' }
      } else if (carried.kind === 'address') {
        answer = await this.takeAddress(record, details, carried.address)
      } else {
        const outcome = this.takeCode(record, details, carried.code)
        if (outcome === 'right') {
          await this.deps.evidence.record(principal, {
            kind: 'email',
            entry: EMAIL_ENTRY,
            values: { address: this.address(details) ?? '' },
            requestRef: record.id,
            connectionRef: session.id,
          })
          answer = {
            text: `Your email address is verified. Your ${details.label} is now offered to your wallet: accept it there.`,
            keep: [details.label],
          }
          ended = 'completed'
        } else if (outcome === 'expired') {
          answer = { text: 'This code has expired. Nothing was issued; ask again when you are ready.' }
          ended = 'expired'
        } else if (outcome === 'last') {
          answer = {
            text: 'That code is not right, and that was the last try: the email check has ended. Nothing was issued.',
          }
          ended = 'failed'
        } else {
          const left = EMAIL_CODE_TRIES - details.tries
          answer = { text: `That code is not right. ${left} ${left === 1 ? 'try is' : 'tries are'} left.` }
        }
      }
      record.details = details as unknown as Record<string, unknown>
      if (!ended) await this.deps.store.challenges.save(record)
      const reply = await this.say(
        session,
        principal,
        record,
        await this.text(principal, session, answer),
        sink,
        inbound.id
      )
      if (ended) await this.end(record, ended, session)
      if (ended === 'completed')
        void this.deps
          .passed(record)
          .catch((err) =>
            this.deps.logger.error({ err, challengeId: record.id }, 'the issuance after the email check failed')
          )
      return { cancelled: false, inbound, reply, replies: [reply], inbounds: [inbound] }
    })
  }

  /** Where the check of the Principal stands, for the model's tool: never the address, never the code (INTX-AUTH-016). */
  public async status(principalId: string, conversationId: string): Promise<EmailCheckStatus> {
    return this.serial(principalId, async () => {
      const record = await this.current(principalId)
      if (!record) return { waiting: false }
      const details = detailsOf(record)
      return {
        waiting: true,
        conversation: details.conversationId === conversationId ? 'this' : 'another',
        credential: details.label,
        step: details.step,
        secondsLeft: secondsUntil(record.expiresAt),
        triesLeft: EMAIL_CODE_TRIES - details.tries,
        resendsLeft: EMAIL_CODE_RESENDS - (details.resends ?? 0),
        ...(details.step === 'code' ? { resendInSeconds: this.resendIn(details) } : {}),
      }
    })
  }

  /**
   * A new code to the address the check took, at the model's call (INTX-AUTH-017): the previous code is no longer right,
   * the ten minutes start again, the tries used still count. Refused before an address, after three resends, and within
   * thirty seconds of the previous sending; the answer and the limits are the same whether or not an entry holds the
   * address, to which alone a code goes.
   */
  public async resend(principalId: string, conversationId: string): Promise<EmailResendOutcome> {
    return this.serial(principalId, async () => {
      const record = await this.current(principalId)
      if (!record) return { outcome: 'none' } as const
      const details = detailsOf(record)
      const address = this.address(details)
      if (details.step !== 'code' || !address) return { outcome: 'no-address' } as const
      const resends = details.resends ?? 0
      if (resends >= EMAIL_CODE_RESENDS) return { outcome: 'limit' } as const
      const wait = this.resendIn(details)
      if (wait > 0) return { outcome: 'too-soon', seconds: wait } as const
      const now = nowIso()
      details.resends = resends + 1
      details.codeSentAt = now
      record.expiresAt = this.deadline(now)
      this.sendCode(record, details, address)
      record.details = details as unknown as Record<string, unknown>
      await this.deps.store.challenges.save(record)
      this.schedule(record)
      this.deps.logger.info(
        { challengeId: record.id, principalId, resends: details.resends },
        'email code sent again (INTX-AUTH-017)'
      )
      return {
        outcome: 'sent',
        conversation: details.conversationId === conversationId ? 'this' : 'another',
        resendsLeft: EMAIL_CODE_RESENDS - details.resends,
        minutes: this.minutes,
      } as const
    })
  }

  /**
   * Ends the check of the Principal at the model's call, as the person's `cancel` does (INTX-AUTH-018): failed, nothing
   * issued, the model told the outcome as a record of the system. False when none waits.
   */
  public async cancel(principalId: string): Promise<boolean> {
    return this.serial(principalId, async () => {
      const record = await this.current(principalId)
      if (!record) return false
      await this.end(record, 'failed')
      return true
    })
  }

  /** The seconds before a new code may be sent (INTX-AUTH-017). */
  private resendIn(details: EmailCheckDetails): number {
    if (!details.codeSentAt) return 0
    return secondsUntil(new Date(Date.parse(details.codeSentAt) + EMAIL_RESEND_AFTER_SECONDS * 1000).toISOString())
  }

  /** The address: the same answer whether or not an entry holds it; a code only to one that an entry holds. */
  private async takeAddress(
    record: AuthChallengeRecord,
    details: EmailCheckDetails,
    address: string
  ): Promise<ServiceSentence> {
    const now = nowIso()
    const keyRef = this.deps.crypto.newWrappedKey()
    details.sealed = { keyRef, cipher: sealJson(this.deps.crypto, keyRef, { address }).cipher.toString('base64') }
    details.step = 'code'
    details.tries = 0
    details.codeSentAt = now
    record.expiresAt = this.deadline(now)
    this.sendCode(record, details, address)
    this.schedule(record)
    const organization = await this.deps.organizationName()
    return {
      text: `If this address is on the list of ${organization ?? 'your organization'}, a six-digit code was just sent to it. Type the code here: it is valid for ${this.minutes} minutes. If it does not arrive, say so: a new one can be sent.`,
      keep: [organization ?? ''],
    }
  }

  /**
   * A new code, to an address an entry holds only, and in the background: a slow or failing server changes neither the
   * answer nor its time (INTX-AUTH-014). The hash of the previous code goes: it is no longer right (INTX-AUTH-017).
   */
  private sendCode(record: AuthChallengeRecord, details: EmailCheckDetails, address: string): void {
    details.codeHash = undefined
    if (!this.deps.directory?.byEmail(address)) return
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    details.codeHash = this.hash(record.id, code)
    void this.send(record.id, address, code)
  }

  /** A try of the code, six digits: right, wrong, the last wrong one, or past its validity. */
  private takeCode(
    record: AuthChallengeRecord,
    details: EmailCheckDetails,
    digits: string
  ): 'right' | 'wrong' | 'last' | 'expired' {
    if (Date.parse(record.expiresAt) <= Date.now()) return 'expired'
    if (details.codeHash && /^\d{6}$/.test(digits)) {
      const a = Buffer.from(details.codeHash, 'hex')
      const b = Buffer.from(this.hash(record.id, digits), 'hex')
      if (a.length === b.length && timingSafeEqual(a, b)) return 'right'
    }
    details.tries += 1
    return details.tries >= EMAIL_CODE_TRIES ? 'last' : 'wrong'
  }

  private async send(challengeId: string, address: string, code: string): Promise<void> {
    const agent = this.deps.pack.metadata.displayName
    try {
      await this.deps.mailer?.send({
        to: address,
        subject: `Your code for ${agent}`,
        // what an email code carries, and nothing else (PLAT-MAIL-002)
        text: `Your code for ${agent} is ${code}.\n\nIt is valid for ${this.minutes} minutes. Type it in your conversation with ${agent}.\n\nIf you did not ask for it, ignore this email.\n`,
      })
      this.deps.logger.info({ challengeId }, 'email code sent')
    } catch (error) {
      // the person was answered as anyone is; the failure is the operator's to see (INTX-AUTH-014)
      this.deps.logger.error({ err: error, challengeId }, 'the email code could not be sent')
    }
  }

  /**
   * A finished sentence of the code in the language the person reads (decision 64): translated with no context and kept,
   * never with anything the person typed in it.
   */
  private async text(principal: Principal | undefined, session: Session | undefined, sentence: ServiceSentence) {
    if (!this.deps.language) return sentence.text
    return this.deps.language.render(sentence, principal, session).catch((err) => {
      this.deps.logger.warn({ err }, 'a message of the email check is shown in English')
      return sentence.text
    })
  }

  /** A message of the code in the conversation: an `auth-challenge` entry, streamed in the run that carried the message. */
  private async say(
    session: Session,
    principal: Principal,
    record: AuthChallengeRecord,
    text: string,
    sink: TurnSink,
    inboundId?: string
  ): Promise<MessageEntry> {
    const id = prefixedId('msg')
    await sink.emit({ type: 'text-start', messageId: id })
    await sink.emit({ type: 'text-delta', messageId: id, delta: text })
    await sink.emit({ type: 'text-end', messageId: id })
    return this.deps.memory.append({
      id,
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'auth-challenge',
      text,
      backingIdentity: principal.backingIdentity,
      payload: {
        kind: EMAIL_CHECK_KIND,
        challengeId: record.id,
        step: 'answer',
        ...(inboundId ? { inboundId, inboundIds: [inboundId] } : {}),
      },
    })
  }

  /**
   * Ends a check: its record says how, the address and the hash of the code are dropped, and the model is told the
   * outcome as a record of the system, never the address or the code (INTX-AUTH-015).
   */
  private async end(
    record: AuthChallengeRecord,
    outcome: AuthChallengeRecord['outcome'],
    session?: Session
  ): Promise<void> {
    const details = detailsOf(record)
    const { sealed: _sealed, codeHash: _hash, ...kept } = details
    record.outcome = outcome
    record.completedAt = nowIso()
    record.details = kept as unknown as Record<string, unknown>
    await this.deps.store.challenges.save(record)
    if (this.waiting.get(record.principalId) === record.id) this.waiting.delete(record.principalId)
    const timer = this.timers.get(record.id)
    if (timer) clearTimeout(timer)
    this.timers.delete(record.id)
    const principal = await this.deps.store.principals.get(record.principalId)
    const sessionId = session?.id ?? details.lastSessionId ?? record.originSessionId
    const word = OUTCOME_WORD[outcome] ?? outcome
    await this.deps.memory.append({
      sessionId,
      conversationId: details.conversationId,
      principalId: record.principalId,
      role: 'system',
      sourceType: 'auth-challenge',
      text: `Identity check (email) for issue_credential: ${word}`,
      backingIdentity: principal?.backingIdentity ?? null,
      payload: {
        type: 'email',
        outcome,
        challengeId: record.id,
        toolName: 'issue_credential',
        profile: details.profile,
      },
    })
    this.deps.logger.info(
      { challengeId: record.id, principalId: record.principalId, outcome: word },
      'email check ended'
    )
  }

  /** A check whose time is over: ended as expired, which the code says in the conversation. */
  private async expire(challengeId: string): Promise<void> {
    const record = await this.deps.store.challenges.get(challengeId)
    if (record?.outcome !== 'pending' || Date.parse(record.expiresAt) > Date.now()) return
    const details = detailsOf(record)
    await this.end(record, 'expired')
    const principal = await this.deps.store.principals.get(record.principalId)
    const sessionId = details.lastSessionId ?? record.originSessionId
    const text = await this.text(principal, await this.deps.store.sessions.get(sessionId), {
      text:
        details.step === 'address'
          ? 'No address was given in time: the email check has ended. Nothing was issued; ask again when you are ready.'
          : 'The code was not given in time: the email check has ended. Nothing was issued; ask again when you are ready.',
    })
    const entry = await this.deps.memory.append({
      sessionId,
      conversationId: details.conversationId,
      principalId: record.principalId,
      role: 'agent',
      sourceType: 'auth-challenge',
      text,
      backingIdentity: principal?.backingIdentity ?? null,
      payload: { kind: EMAIL_CHECK_KIND, challengeId: record.id, step: 'answer' },
    })
    await this.deps
      .deliver(sessionId, entry)
      .catch((err) => this.deps.logger.warn({ err, challengeId }, 'the end of an email check was not shown'))
  }

  private schedule(record: AuthChallengeRecord): void {
    const previous = this.timers.get(record.id)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(
      () => {
        void this.serial(record.principalId, () => this.expire(record.id)).catch((err) =>
          this.deps.logger.error({ err, challengeId: record.id }, 'an email check did not expire')
        )
      },
      Math.max(0, Date.parse(record.expiresAt) - Date.now()) + 50
    )
    timer.unref()
    this.timers.set(record.id, timer)
  }

  /** The check of a Principal that waits, if any; one past its time is ended now. */
  private async current(principalId: string): Promise<AuthChallengeRecord | undefined> {
    const id = this.waiting.get(principalId)
    if (!id) return undefined
    const record = await this.deps.store.challenges.get(id)
    if (record?.outcome !== 'pending') {
      this.waiting.delete(principalId)
      return undefined
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.expire(record.id)
      return undefined
    }
    return record
  }

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.catch(() => undefined)
    this.chains.set(key, settled)
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key)
    })
    return next
  }

  private deadline(from: string): string {
    return new Date(Date.parse(from) + this.minutes * 60_000).toISOString()
  }

  /** The keyed hash of a code: of the check and the digits, never the digits alone (INTX-AUTH-014). */
  private hash(challengeId: string, code: string): string {
    return this.deps.crypto.blindIndex(`email-code\n${challengeId}\n${code}`)
  }

  private address(details: EmailCheckDetails): string | undefined {
    if (!details.sealed) return undefined
    return openJson<{ address: string }>(
      this.deps.crypto,
      details.sealed.keyRef,
      Buffer.from(details.sealed.cipher, 'base64')
    ).address
  }
}

function detailsOf(record: AuthChallengeRecord): EmailCheckDetails {
  return { ...(record.details as unknown as EmailCheckDetails) }
}

function secondsUntil(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1000))
}

/** The digits of a text, as runs of groups split by single spaces or dashes; not a part of a decimal number. */
const DIGIT_RUN = /(?<![\d.,])\d+(?:[\s\-\u2010-\u2015]\d+)*(?![.,]?\d)/g
/** What may be an address in a text: anything around an `@` up to a space or a sign no address holds. */
const ADDRESS_CANDIDATE = /[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+/g

/** The email addresses a text holds, in lower case, each once: "my address is Ana@X.example." gives `ana@x.example`. */
export function addressesIn(text: string): string[] {
  const found = new Set<string>()
  for (const [candidate] of text.matchAll(ADDRESS_CANDIDATE)) {
    // the signs a sentence, a quote or markdown put around it are not the address's
    const address = candidate.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')
    if (isEmailAddress(address)) found.add(address.toLowerCase())
  }
  return [...found]
}

/**
 * The codes a text holds, as six digits, each once (INTX-AUTH-013): a run of six digits, which may be split by spaces or
 * dashes ("it is 482 913" gives `482913`), or a run of groups of six ("482913 123456" gives both). A longer number, a
 * phone number or a date gives none.
 */
export function codesIn(text: string): string[] {
  const found = new Set<string>()
  for (const [run] of text.matchAll(DIGIT_RUN)) {
    const groups = run.split(/[\s\-\u2010-\u2015]/)
    if (groups.join('').length === 6) found.add(groups.join(''))
    else if (groups.every((group) => group.length === 6)) for (const group of groups) found.add(group)
  }
  return [...found]
}

/**
 * What a message carries for the step of a check (INTX-AUTH-013): only a word that stops it, an address at the address
 * step, a code at the code step, or more than one of them. Undefined when it carries none: the message is the model's.
 */
export function carriedBy(text: string, step: 'address' | 'code'): CarriedByMessage | undefined {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
  if (STOP_WORDS.has(word)) return { kind: 'stop' }
  if (step === 'address') {
    const addresses = addressesIn(text)
    if (addresses.length > 1) return { kind: 'several' }
    return addresses[0] ? { kind: 'address', address: addresses[0] } : undefined
  }
  const codes = codesIn(text)
  if (codes.length > 1) return { kind: 'several' }
  return codes[0] ? { kind: 'code', code: codes[0] } : undefined
}

/** What the model's tool answers of where a check stands (INTX-AUTH-016): no address, no code. */
export function emailStatusForModel(status: EmailCheckStatus): string {
  if (!status.waiting) return 'No email check is waiting for this person.'
  return JSON.stringify(status)
}

/** What the model's tool answers of a `resend` (INTX-AUTH-017): the same words whether or not an entry holds the address. */
export function emailResendForModel(result: EmailResendOutcome): string {
  switch (result.outcome) {
    case 'sent': {
      const where =
        result.conversation === 'this' ? 'in this conversation' : 'in the conversation where the check was asked'
      const left = `${result.resendsLeft} more ${result.resendsLeft === 1 ? 'resend is' : 'resends are'} possible.`
      return `A new code was sent to the address the person gave, if it is on the list of the organization; the previous code no longer works. The person types the new one ${where}; it is valid for ${result.minutes} minutes. ${left}`
    }
    case 'none':
      return 'Nothing was sent: no email check is waiting for this person. issue_credential starts one when a credential needs it.'
    case 'no-address':
      return 'Nothing was sent: the person has not given an address yet. The system waits for it in the conversation of the check and sends a code once they type it there.'
    case 'limit':
      return `Refused: ${EMAIL_CODE_RESENDS} new codes were already sent in this check. The person can cancel it and ask again later.`
    case 'too-soon':
      return `Refused: the last code was sent less than ${EMAIL_RESEND_AFTER_SECONDS} seconds ago. A new one can be sent in ${result.seconds} seconds.`
  }
}

/** What the model's tool answers of a `cancel` (INTX-AUTH-018). */
export function emailCancelForModel(cancelled: boolean): string {
  return cancelled
    ? 'The email check is cancelled: nothing was issued. To check another address, call issue_credential again.'
    : 'No email check is waiting for this person: there is nothing to cancel.'
}

/** Whether an entry is a message of an email check: what the person typed or what the code answered (MEM-RET-006). */
export function isEmailCheckMessage(entry: Pick<MessageEntry, 'sourceType' | 'payload'>): boolean {
  return entry.sourceType === 'auth-challenge' && entry.payload?.kind === EMAIL_CHECK_KIND
}

/**
 * Whether an entry is a message of the person the model never receives (decision 65, INTX-AUTH-023): what the code of
 * an email check took. The code's own messages are the agent's, which the model reads.
 */
export function isWithheldMessage(entry: Pick<MessageEntry, 'sourceType' | 'payload' | 'role'>): boolean {
  return isEmailCheckMessage(entry) && entry.role !== 'agent'
}

/** What the person typed, as the model is told it in the place of a message it never receives (decision 65). */
const WITHHELD_WORDS: Record<string, string> = {
  address: 'their email address',
  code: 'a code',
  'several-address': 'more than one email address',
  'several-code': 'more than one code',
  stop: 'a word that stops the email check',
}

/**
 * The record the model reads in the place of a message of the person the code took (decision 65, INTX-AUTH-013): what
 * was typed there and that the code took it, never its content.
 */
export function withheldRecordText(entry: Pick<MessageEntry, 'payload'>): string {
  const carried = String(entry.payload?.carried ?? entry.payload?.step ?? '')
  const step = String(entry.payload?.step ?? '')
  const what = WITHHELD_WORDS[carried === 'several' ? `several-${step}` : carried] ?? 'a message for the email check'
  return `the person typed ${what} here; the code of the service took it for the email check, and it is not shown to you`
}
