/**
 * The face step of an `authenticate` flow (ayni-spec D131; IDENT-AUTH-010, IDENT-AUTH-011, FLOW-SIGNIN-012): once the
 * person consented on the phone, the agent offers a call (calls 1.0, purpose `face-match`) under the flow id, whose room
 * the deployment's face-verification service joins with the reference picture; the service decides liveness and the
 * match and answers through callbacks keyed by a token of the step, never by a session token. Nothing of the face is
 * kept: the reference lives here for the step only, and the outcome is all that leaves.
 */
import { randomBytes } from 'node:crypto'
import { Deferred } from '../../util/async.js'
import { prefixedId } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'
import type { VsAgentClient } from './vsAgentClient.js'

export type FaceOutcome = 'passed' | 'failed' | 'expired'

export interface FaceStep {
  /** the step's token: the key of the face-verification service's callbacks */
  token: string
  /** the id the phone joins the room with */
  peerId: string
  roomId: string
  wsUrl: string
  connectionId: string
  flowId: string
  threadId?: string
  reference: { bytes: Buffer; mimeType: string }
}

interface Running {
  step: FaceStep
  done: Deferred<FaceOutcome>
  timer: NodeJS.Timeout
}

export class FaceSteps {
  private readonly running = new Map<string, Running>()

  public constructor(
    private readonly client: Pick<VsAgentClient, 'offerCall'>,
    private readonly webrtcServerUrl: string | undefined,
    private readonly publicBaseUrl: string,
    private readonly logger: Logger
  ) {}

  /** Whether a face step can be offered: the deployment names a WebRTC server. */
  public get available(): boolean {
    return !!this.webrtcServerUrl
  }

  /**
   * Opens the room and offers the call under the flow id; resolves with the outcome the face-verification service
   * gives, `failed` when the phone rejects the call, `expired` at `expiresAt`.
   */
  public async start(input: {
    connectionId: string
    flowId: string
    reference: { bytes: Buffer; mimeType: string }
    expiresAt: string
    description: string
  }): Promise<{ outcome: Promise<FaceOutcome> }> {
    if (!this.webrtcServerUrl) throw new Error('WEBRTC_SERVER_URL is not configured')
    const response = await fetch(`${this.webrtcServerUrl.replace(/\/+$/, '')}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventNotificationUri: `${this.publicBaseUrl}/webrtc/call-event`, maxPeerCount: 50 }),
    })
    if (!response.ok) throw new Error(`webrtc room creation HTTP ${response.status}`)
    const room = (await response.json()) as { wsUrl: string; roomId: string }
    const step: FaceStep = {
      token: prefixedId('fst', 24),
      peerId: randomBytes(12).toString('hex'),
      roomId: room.roomId,
      wsUrl: room.wsUrl,
      connectionId: input.connectionId,
      flowId: input.flowId,
      reference: input.reference,
    }
    const done = new Deferred<FaceOutcome>()
    const timer = setTimeout(
      () => this.settle(step.token, 'expired'),
      Math.max(0, Date.parse(input.expiresAt) - Date.now())
    )
    this.running.set(step.token, { step, done, timer })
    try {
      // the call of the sheet: purpose face-match, under the flow id; the phone neither rings nor shows a call screen
      const { id } = await this.client.offerCall(
        input.connectionId,
        'service',
        { ...room, peerId: step.peerId, protocol: '2060-mediasoup-v1', purpose: 'face-match' },
        input.description,
        input.expiresAt,
        input.flowId
      )
      step.threadId = id
    } catch (error) {
      clearTimeout(timer)
      this.running.delete(step.token)
      throw error
    }
    return { outcome: done.promise }
  }

  public byToken(token: string): FaceStep | undefined {
    return this.running.get(token)?.step
  }

  public byPeer(peerId: string): FaceStep | undefined {
    return [...this.running.values()].find((r) => r.step.peerId === peerId)?.step
  }

  /** The call of a face step that the phone rejected or ended before a verdict. */
  public byCall(connectionId: string, threadId: string): FaceStep | undefined {
    return [...this.running.values()].find((r) => r.step.connectionId === connectionId && r.step.threadId === threadId)
      ?.step
  }

  /** The verdict of the face-verification service, or the end of the step; the reference goes with it. */
  public settle(token: string, outcome: FaceOutcome): boolean {
    const running = this.running.get(token)
    if (!running) return false
    clearTimeout(running.timer)
    this.running.delete(token)
    this.logger.info({ flowId: running.step.flowId, outcome }, 'face step settled')
    running.done.resolve(outcome)
    return true
  }
}
