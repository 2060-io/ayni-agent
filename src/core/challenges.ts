/**
 * Auth challenges (D28, D32, INTX-AUTH-001..009): declared per action in the agent-pack, enforced by
 * the system, routed to the capability channel, result returned to the originating session only. On a
 * flow-capable wallet the device challenge is a `confirm` flow and the routed status carries its flow id
 * (D54, D58, INTX-FLOW-003).
 */
import type { ActionPolicy, AgentPack } from '../config/packTypes.js'
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
    originSession: Session
  ): Promise<{ threadId: string; flowId?: string }>
  /** call offer whose room the face-verification service joins (INTX-AUTH-007); returns the call thread id */
  offerFaceMatchCall(connectionId: string, challenge: AuthChallengeRecord, description: string): Promise<string>
  /** NFC document read request (INTX-AUTH-001) */
  requestDocument(connectionId: string): Promise<string>
}

export interface ChallengeRequest {
  principal: Principal
  originSession: Session
  toolName: string
  policy: NonNullable<ActionPolicy['authChallenge']>
  purpose: string
}

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
    const timeoutSeconds = req.policy.timeoutSeconds ?? this.defaultTimeoutSeconds
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
      } else if (req.policy.type === 'face-match') {
        const threadId = await this.ops.offerFaceMatchCall(connectionId, record, `Face check for: ${req.purpose}`)
        record.details = { ...(record.details ?? {}), threadId, connectionId }
      } else {
        const threadId = await this.ops.requestDocument(connectionId)
        record.details = { threadId, connectionId }
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
    await this.router.notifyOrigin(record.originSessionId, routed(record, outcome))
  }

  public async findByToken(token: string): Promise<AuthChallengeRecord | undefined> {
    return this.store.challenges.findByToken(token)
  }

  public async findPendingByThread(connectionId: string, threadId: string): Promise<AuthChallengeRecord | undefined> {
    return (await this.store.challenges.listPending()).find(
      (c) => c.details?.connectionId === connectionId && c.details?.threadId === threadId
    )
  }

  public async findPendingByPeer(peerId: string): Promise<AuthChallengeRecord | undefined> {
    return (await this.store.challenges.listPending()).find((c) => c.details?.peerId === peerId)
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
