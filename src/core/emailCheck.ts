/**
 * The email code (decision 62; ayni-spec D89, INTX-AUTH-011..015, PROF-RUN-015, MEM-RET-006, PLAT-MAIL-002).
 *
 * The code of the agent, not the model, checks that a person holds an address of the user directory:
 *
 * 1. The issuing tool of a badge from the directory starts the check in the conversation it was called from, and the
 *    turn ends with the code's question (`start`): which email address the organization knows the person by.
 * 2. While the check waits, the person's next messages in that conversation, from any of their sessions, are taken by
 *    the code (`take`): the first as the address, the next ones as tries of the code. Each is recorded as an
 *    `auth-challenge` entry, starts no turn and never reaches the model, and so are the code's answers.
 * 3. The answer to the address is the same whether or not an entry holds it; a code is sent only to an address an entry
 *    holds, by email, in the background, so that neither the words nor the time of the answer tell which. The code has
 *    six digits from a secure generator, is kept as a keyed hash only, is valid ten minutes from its sending, is used
 *    once, with five tries in all.
 * 4. A right code records evidence of the kind `email`, whose one attribute is the address (INTX-AUTH-015), and the
 *    issuance that started the check goes on by itself (`passed`). An address not given in ten minutes, a code not
 *    given right in its validity, or a fifth wrong try end the check; the code says so, and the model is told the
 *    outcome only, as a record of the system: `passed`, `failed` or `expired`.
 *
 * At most one check waits per Principal. The address typed while the check waits is kept sealed in the challenge
 * record, and dropped when the check ends; nothing of the check is in the clear but its state and its times.
 */
import { randomInt, timingSafeEqual } from 'node:crypto'
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
import type { AuthChallengeRecord, MessageEntry, Principal, Session } from './types.js'

/** How long the address may wait after the question, and the code after its sending (INTX-AUTH-014). */
export const EMAIL_CHECK_MINUTES = 10
/** How many tries of the code, in all (INTX-AUTH-014). */
export const EMAIL_CODE_TRIES = 5
/** The words that stop the check: the person's way out before the ten minutes. */
const STOP_WORDS = new Set(['cancel', 'stop', 'annuler', 'cancelar', 'parar', 'abbrechen'])

/** The payload of the entries of a check: what the person typed and what the code answered (MEM-RET-006). */
export const EMAIL_CHECK_KIND = 'email-check'

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
}

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
    const organization = (await this.deps.organizationName()) ?? 'your organization'
    return {
      started: true,
      challengeId: record.id,
      question: `To issue your ${input.label}, the agent checks your email address. Which email address does ${organization} know you by? Type it in your next message: the agent's own code reads it, not the AI. Type cancel to stop.`,
    }
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
   * A message of the Principal in a conversation where its check waits (INTX-AUTH-013): taken by the code, recorded with
   * the code's answer as `auth-challenge` entries, answered in the run that carried it, with no turn of the model.
   * Undefined when no check waits there: the message is the model's.
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
      const inbound = await this.deps.memory.append({
        ...input.entry,
        sourceType: 'auth-challenge',
        payload: { kind: EMAIL_CHECK_KIND, challengeId: record.id, step },
      })
      await sink.emit({ type: 'inbound', entry: inbound })
      details.lastSessionId = session.id
      const typed = inbound.text.trim()
      let answer: string
      let ended: AuthChallengeRecord['outcome'] | undefined
      if (STOP_WORDS.has(typed.toLowerCase())) {
        answer = 'The email check is stopped. Nothing was issued.'
        ended = 'failed'
      } else if (step === 'address') {
        if (!isEmailAddress(typed)) {
          answer = `That is not an email address. Type the address ${(await this.deps.organizationName()) ?? 'your organization'} gave you, for example name@company.example, or cancel.`
        } else {
          answer = await this.takeAddress(record, details, typed.toLowerCase())
        }
      } else {
        const outcome = this.takeCode(record, details, typed)
        if (outcome === 'right') {
          await this.deps.evidence.record(principal, {
            kind: 'email',
            entry: EMAIL_ENTRY,
            values: { address: this.address(details) ?? '' },
            requestRef: record.id,
            connectionRef: session.id,
          })
          answer = `Your email address is verified. Your ${details.label} is now offered to your wallet: accept it there.`
          ended = 'completed'
        } else if (outcome === 'expired') {
          answer = 'This code has expired. Nothing was issued; ask again when you are ready.'
          ended = 'expired'
        } else if (outcome === 'last') {
          answer = 'That code is not right, and that was the last try: the email check has ended. Nothing was issued.'
          ended = 'failed'
        } else {
          const left = EMAIL_CODE_TRIES - details.tries
          answer = `That code is not right. ${left} ${left === 1 ? 'try is' : 'tries are'} left.`
        }
      }
      record.details = details as unknown as Record<string, unknown>
      if (!ended) await this.deps.store.challenges.save(record)
      const reply = await this.say(session, principal, record, answer, sink, inbound.id)
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

  /** The address: the same answer whether or not an entry holds it; a code only to one that an entry holds. */
  private async takeAddress(record: AuthChallengeRecord, details: EmailCheckDetails, address: string): Promise<string> {
    const now = nowIso()
    const keyRef = this.deps.crypto.newWrappedKey()
    details.sealed = { keyRef, cipher: sealJson(this.deps.crypto, keyRef, { address }).cipher.toString('base64') }
    details.step = 'code'
    details.tries = 0
    details.codeSentAt = now
    details.codeHash = undefined
    record.expiresAt = this.deadline(now)
    if (this.deps.directory?.byEmail(address)) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      details.codeHash = this.hash(record.id, code)
      // in the background: a slow or failing server changes neither the answer nor its time (INTX-AUTH-014)
      void this.send(record.id, address, code)
    }
    this.schedule(record)
    const organization = (await this.deps.organizationName()) ?? 'your organization'
    return `If this address is on the list of ${organization}, a six-digit code was just sent to it. Type the code here: it is valid for ${this.minutes} minutes.`
  }

  /** A try of the code: right, wrong, the last wrong one, or past its validity. */
  private takeCode(
    record: AuthChallengeRecord,
    details: EmailCheckDetails,
    typed: string
  ): 'right' | 'wrong' | 'last' | 'expired' {
    if (Date.parse(record.expiresAt) <= Date.now()) return 'expired'
    const digits = typed.replace(/\s+/g, '')
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
    const text =
      details.step === 'address'
        ? 'No address was given in time: the email check has ended. Nothing was issued; ask again when you are ready.'
        : 'The code was not given in time: the email check has ended. Nothing was issued; ask again when you are ready.'
    const sessionId = details.lastSessionId ?? record.originSessionId
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

/** Whether an entry is a message of an email check: what the person typed or what the code answered (MEM-RET-006). */
export function isEmailCheckMessage(entry: Pick<MessageEntry, 'sourceType' | 'payload'>): boolean {
  return entry.sourceType === 'auth-challenge' && entry.payload?.kind === EMAIL_CHECK_KIND
}
