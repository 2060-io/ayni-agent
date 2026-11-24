/**
 * Auth challenges (D28, D32, INTX-AUTH-001..009): declared per action in the agent-pack (a tool's `stepUp`, D101), enforced by
 * the system, routed to the capability channel, result returned to the originating session only. On a
 * flow-capable wallet the device challenge is a `confirm` flow and the routed status carries its flow id
 * (D54, D58, INTX-FLOW-003).
 */
import type { AgentPack, IssuanceChallenge } from '../config/packTypes.js'
import type { Store } from '../store/types.js'
import { Deferred } from '../util/async.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { CapabilityRouter } from './channel.js'
import type { AuthChallengeRecord, ChallengeOutcome, ChallengeType, Principal, Session } from './types.js'

/** What the capability channel (DIDComm) must be able to do for challenges. */
export interface CapabilityChannelOps {
  /** question-answer with a per-challenge nonce; returns the thread id (INTX-AUTH-009) */
  askQuestion(connectionId: string, question: string, detail: string | undefined, answers: string[]): Promise<string>
  /**
   * The device challenge: a `confirm` flow (text, code, attested) on a flow-capable wallet, a question-answer
   * message carrying the purpose and a per-challenge nonce otherwise (INTX-AUTH-009); returns the request
   * thread id and, in flow mode, the flow id.
   */
  askConfirmation(
    connectionId: string,
    challenge: AuthChallengeRecord,
    purpose: string,
    originSession: Session,
    options?: ConfirmationOptions
  ): Promise<{ threadId: string; flowId?: string }>
  /** Closes the flow of a confirmation the agent withdrew (TOOL-SPACE-009). */
  cancelConfirmation?(flowId: string): Promise<void>
  /**
   * The document read: an `nfc-read` flow with one request for the data of the chip, of a peer that said it can
   * read one (INTX-AUTH-010); returns the request thread id and the flow id, and throws when the peer cannot.
   */
  requestDocument(
    connectionId: string,
    challenge: AuthChallengeRecord,
    purpose: string,
    originSession: Session
  ): Promise<{ threadId: string; flowId: string }>
}

/**
 * How a device confirmation is asked when it is not a step-up of an action: a change of a space's tools (TOOL-SPACE-008),
 * whose text is the change's summary as written, whose code is the one the screen shows, and which belongs to no
 * conversation and leaves no card in one.
 */
export interface ConfirmationOptions {
  /** the text as written, with no "Confirm:" before it */
  text?: string
  /** the code the screen shows */
  code?: string
  /** a card in the origin's conversation: none for a change of a space's tools */
  card?: boolean
  /** the origin names its session but no conversation */
  withoutConversation?: boolean
}

/** A device confirmation of a change of a space's tools, as `confirmChange` sends it (TOOL-SPACE-008). */
export interface ChangeConfirmation {
  principal: Principal
  originSession: Session
  /** the change's summary: the space, the source and every value but the token */
  text: string
  code: string
  expiresAt: string
  changeId: string
}

/** No capability channel can serve the confirmation of a change (`409 confirmation-unavailable`). */
export class ConfirmationUnavailable extends Error {
  public constructor() {
    super('no capability channel of the owner can serve the confirmation')
    this.name = 'ConfirmationUnavailable'
  }
}

/** The kind of a challenge that confirms a change of a space's tools (its `details.kind`). */
export const SPACE_TOOL_CHANGE = 'space-tool-change'

export interface ChallengeRequest {
  principal: Principal
  originSession: Session
  toolName: string
  /** a tool's `stepUp.authChallenge` (a device confirmation) or an issuance profile's challenge (also a document read) */
  policy: IssuanceChallenge
  purpose: string
}

/** How long a person has to read their document once asked (INTX-AUTH-010). */
export const DOCUMENT_READ_SECONDS = 300

export class ChallengeService {
  private readonly pending = new Map<string, Deferred<ChallengeOutcome>>()
  private ops?: CapabilityChannelOps

  public constructor(
    private readonly store: Store,
    readonly _pack: AgentPack,
    private readonly router: CapabilityRouter,
    private readonly logger: Logger,
    private readonly defaultTimeoutSeconds: number
  ) {}

  public setChannelOps(ops: CapabilityChannelOps): void {
    this.ops = ops
  }

  /** Told when a challenge ends, whoever waits for it: the changes of a space's tools follow theirs (TOOL-SPACE-008). */
  public onSettled?: (record: AuthChallengeRecord) => Promise<void>

  /**
   * Sends the device confirmation of a change of a space's tools (TOOL-SPACE-008): a `confirm` flow (`attested`) on the
   * owner's capability channel, or its question-answer form, whose text is the change's summary and whose code is the
   * screen's; its origin is the requesting session, with no conversation, and it leaves no card in any (TOOL-SPACE-009).
   * The answer, the expiry or a withdrawal ends it through `onSettled`. Throws `ConfirmationUnavailable` with no channel.
   */
  public async confirmChange(req: ChangeConfirmation): Promise<AuthChallengeRecord> {
    const capability = await this.router.capabilitySession(req.principal)
    if (!capability || !this.ops) throw new ConfirmationUnavailable()
    const record: AuthChallengeRecord = {
      id: prefixedId('chl'),
      type: 'device',
      principalId: req.principal.id,
      originSessionId: req.originSession.id,
      toolName: SPACE_TOOL_CHANGE,
      token: prefixedId('tok', 24),
      outcome: 'pending',
      createdAt: nowIso(),
      expiresAt: req.expiresAt,
      details: { kind: SPACE_TOOL_CHANGE, changeId: req.changeId, silent: true },
    }
    await this.store.challenges.save(record)
    const connectionId = capability.externalRef
    try {
      const sent = await this.ops.askConfirmation(connectionId, record, req.text, req.originSession, {
        text: req.text,
        code: req.code,
        card: false,
        withoutConversation: true,
      })
      record.details = {
        ...(record.details ?? {}),
        threadId: sent.threadId,
        connectionId,
        ...(sent.flowId ? { flowId: sent.flowId } : {}),
      }
      await this.store.challenges.save(record)
    } catch (error) {
      record.outcome = 'unavailable'
      record.completedAt = nowIso()
      await this.store.challenges.save(record)
      this.logger.error({ err: error, challengeId: record.id }, 'the confirmation of a change could not be sent')
      throw new ConfirmationUnavailable()
    }
    const timer = setTimeout(
      () => void this.complete(record.id, 'expired'),
      Math.max(0, Date.parse(req.expiresAt) - Date.now())
    )
    timer.unref?.()
    return record
  }

  /** Withdraws a confirmation of a change (TOOL-SPACE-009): its flow closes as cancelled, and it ends as cancelled. */
  public async withdraw(challengeId: string): Promise<void> {
    const record = await this.store.challenges.get(challengeId)
    if (record?.outcome !== 'pending') return
    const flowId = record.details?.flowId
    await this.complete(challengeId, 'failed', { cancelled: true })
    if (typeof flowId === 'string')
      await this.ops
        ?.cancelConfirmation?.(flowId)
        .catch((err) => this.logger.warn({ err, challengeId }, 'the flow of a withdrawn confirmation did not close'))
  }

  /** Runs one challenge end to end and returns its outcome; fallback policy applies without a servable channel (CHAN-PROF-003/004). */
  public async run(req: ChallengeRequest): Promise<{ outcome: ChallengeOutcome; record?: AuthChallengeRecord }> {
    const capability = await this.router.capabilitySession(req.principal)
    const fallback = req.policy.onChannelUnavailable ?? 'fail'
    if (!capability || !this.ops) {
      const outcome: ChallengeOutcome = fallback === 'degrade' ? 'degraded' : 'unavailable'
      this.logger.warn(
        { principalId: req.principal.id, tool: req.toolName, outcome },
        'no capability channel for the challenge'
      )
      await this.router.notifyOrigin(req.originSession.id, {
        kind: 'routed',
        trustBound: 'auth-challenge',
        challengeType: req.policy.type,
        status: outcome,
        originSessionId: req.originSession.id,
        message:
          fallback === 'degrade'
            ? 'The identity check was skipped: your phone is not connected.'
            : 'The identity check needs your phone, which is not connected.',
      })
      return { outcome }
    }
    // a document read takes a person longer than a confirmation: five minutes unless the action says otherwise
    const timeoutSeconds =
      req.policy.timeoutSeconds ?? (req.policy.type === 'document' ? DOCUMENT_READ_SECONDS : this.defaultTimeoutSeconds)
    const record: AuthChallengeRecord = {
      id: prefixedId('chl'),
      type: req.policy.type,
      principalId: req.principal.id,
      originSessionId: req.originSession.id,
      toolName: req.toolName,
      token: prefixedId('tok', 24),
      outcome: 'pending',
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
    }
    await this.store.challenges.save(record)
    const deferred = new Deferred<ChallengeOutcome>()
    this.pending.set(record.id, deferred)
    await this.router.notifyOrigin(req.originSession.id, {
      kind: 'routed',
      trustBound: 'auth-challenge',
      challengeType: req.policy.type,
      status: 'pending',
      originSessionId: req.originSession.id,
      expiresAt: record.expiresAt,
    })
    const connectionId = capability.externalRef
    try {
      if (req.policy.type === 'device') {
        const sent = await this.ops.askConfirmation(connectionId, record, req.purpose, req.originSession)
        record.details = { threadId: sent.threadId, connectionId, ...(sent.flowId ? { flowId: sent.flowId } : {}) }
        // the routed status names the flow once it exists (INTX-FLOW-003)
        if (sent.flowId) await this.router.notifyOrigin(req.originSession.id, routed(record, 'pending'))
      } else {
        const sent = await this.ops.requestDocument(connectionId, record, req.purpose, req.originSession)
        record.details = { threadId: sent.threadId, connectionId, flowId: sent.flowId }
        await this.router.notifyOrigin(req.originSession.id, routed(record, 'pending'))
      }
      await this.store.challenges.save(record)
    } catch (error) {
      this.pending.delete(record.id)
      record.outcome = 'unavailable'
      record.completedAt = nowIso()
      await this.store.challenges.save(record)
      this.logger.error({ err: error, challengeId: record.id }, 'challenge could not be sent')
      await this.router.notifyOrigin(req.originSession.id, routed(record, 'unavailable'))
      return { outcome: fallback === 'degrade' ? 'degraded' : 'unavailable', record }
    }
    const timer = setTimeout(() => this.complete(record.id, 'expired'), timeoutSeconds * 1000)
    const outcome = await deferred.promise
    clearTimeout(timer)
    return { outcome, record: (await this.store.challenges.get(record.id)) ?? record }
  }

  /** Called by the DIDComm events when an answer, a call result or a document arrives. */
  public async complete(
    challengeId: string,
    outcome: ChallengeOutcome,
    details?: Record<string, unknown>
  ): Promise<void> {
    const record = await this.store.challenges.get(challengeId)
    if (record?.outcome !== 'pending') return
    record.outcome = outcome
    record.completedAt = nowIso()
    record.details = { ...(record.details ?? {}), ...(details ?? {}) }
    await this.store.challenges.save(record)
    this.pending.get(challengeId)?.resolve(outcome)
    this.pending.delete(challengeId)
    // a confirmation of a change of a space's tools is told to no conversation (TOOL-SPACE-009)
    if (record.details?.silent !== true) await this.router.notifyOrigin(record.originSessionId, routed(record, outcome))
    await this.onSettled?.(record).catch((err) =>
      this.logger.error({ err, challengeId }, 'what follows a challenge did not run')
    )
  }

  public async findPendingByThread(connectionId: string, threadId: string): Promise<AuthChallengeRecord | undefined> {
    return (await this.store.challenges.listPending()).find(
      (c) => c.details?.connectionId === connectionId && c.details?.threadId === threadId
    )
  }
}

export function routed(record: AuthChallengeRecord, status: ChallengeOutcome) {
  const flowId = record.details?.flowId
  return {
    kind: 'routed' as const,
    trustBound: 'auth-challenge' as const,
    challengeType: record.type as ChallengeType,
    status,
    originSessionId: record.originSessionId,
    expiresAt: record.expiresAt,
    ...(typeof flowId === 'string' ? { flowId } : {}),
  }
}

/** The question text of a device challenge, shared by the flow and the question-answer forms. */
export function confirmationText(purpose: string): string {
  return `Confirm: ${purpose}`
}

/** The short code the device shows for a challenge, derived from its token (INTX-AUTH-009). */
export function challengeCode(record: AuthChallengeRecord): string {
  return record.token.slice(-6).toUpperCase()
}
