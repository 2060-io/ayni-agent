/**
 * The authentication asked of a guest (D65, D66, D72; IDENT-RES-015/016): while a connection is unidentified,
 * the person, from their wallet or from a menu item, or the model, through its tool, has the agent ask the
 * wallet for the credential of the authentication schema. What comes back binds the connection by the rules of
 * IDENT-RES-013/014. A credential that is not accepted is asked again; a request declined or left unanswered
 * changes nothing (FLOW-SIGNIN-006). The agent does not insist: one request at a time on a connection, and
 * after a request that was declined or left unanswered the model waits; the person's own request is always
 * served.
 */
import { type AgentPack, connectionTypeOf, type PresentationEntry } from '../../config/packTypes.js'
import type { EvidenceInput } from '../../core/evidence.js'
import type { VerifiedFacts } from '../../core/principals.js'
import type { Principal, Session } from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import { type AuthenticationAttempt, asksAgain } from './identity.js'

/** What a request ends in. A status, never a value of the credential (D68). */
export type IdentityRequestOutcome =
  | 'identified'
  | 'already-identified'
  | 'not-presented'
  | 'another-identity'
  | 'pending'
  | 'wait'
  | 'unavailable'
  | 'not-offered'

export interface IdentityRequestDeps {
  /**
   * asks the wallet once and returns what the request ended in; `boundTo`, the actor identity of an identified
   * connection, refuses a presentation of another identity on the flow (IDENT-RES-019)
   */
  authenticate(
    connectionId: string,
    peerId: string,
    flowMode: boolean,
    userAgentVerified: boolean,
    boundTo?: string
  ): Promise<AuthenticationAttempt>
  isFlowCapable(connectionId: string): Promise<boolean>
  /** binds the connection by the rules of D66 */
  onIdentityPresented(connectionId: string, facts: VerifiedFacts): Promise<{ outcome: string }>
  /** asks the wallet for the credential of a catalog entry and returns what was verified */
  present?(
    connectionId: string,
    name: string,
    entry: PresentationEntry,
    flowMode: boolean,
    origin?: Session
  ): Promise<EvidenceInput | undefined>
  /** records what was verified as evidence of the Principal */
  record?(principal: Principal, evidence: EvidenceInput): Promise<unknown>
}

/** What a request for a catalog entry ends in. A status, never a value (D68, INTX-PRES-005/006). */
export type PresentationRequestOutcome =
  | 'verified'
  | 'not-presented'
  | 'pending'
  | 'wait'
  | 'unavailable'
  | 'not-offered'

export class IdentityRequests {
  private readonly pending = new Set<string>()
  private readonly unanswered = new Map<string, number>()

  public constructor(
    private readonly pack: AgentPack,
    private readonly deps: IdentityRequestDeps,
    private readonly logger: Logger,
    /** how long the model waits after a request that was declined or left unanswered (IDENT-RES-016) */
    private readonly waitMs = 10 * 60_000
  ) {}

  public async request(principal: Principal, by: 'model' | 'person'): Promise<IdentityRequestOutcome> {
    if (!this.pack.identity.authentication?.length) return 'not-offered'
    if (principal.identityCredentialRef) return 'already-identified'
    const connectionId = principal.capabilityChannelId
    if (!connectionId) return 'unavailable'
    if (this.pending.has(connectionId)) return 'pending'
    const since = this.unanswered.get(connectionId)
    if (by === 'model' && since !== undefined && Date.now() - since < this.waitMs) return 'wait'
    this.pending.add(connectionId)
    try {
      const flowMode = await this.deps.isFlowCapable(connectionId)
      let attempt: AuthenticationAttempt
      // a credential that is not accepted is asked again, as long as the person presents one (IDENT-RES-019);
      // a wallet without flows cannot be told why, and is asked once
      do {
        attempt = await this.deps.authenticate(
          connectionId,
          principal.actorIdentity,
          flowMode,
          principal.userAgentVerified
        )
      } while (asksAgain(attempt) && flowMode)
      if (attempt.outcome === 'not-accepted' && attempt.code === 'another-identity') return 'another-identity'
      if (attempt.outcome !== 'accepted') {
        this.unanswered.set(connectionId, Date.now())
        return 'not-presented'
      }
      this.unanswered.delete(connectionId)
      const { outcome } = await this.deps.onIdentityPresented(connectionId, attempt.facts)
      this.logger.info({ principalId: principal.id, by, outcome }, 'identity asked on demand')
      return outcome === 'identified' || outcome === 'refreshed' ? 'identified' : (outcome as IdentityRequestOutcome)
    } finally {
      this.pending.delete(connectionId)
    }
  }
  /**
   * An identified person is asked again for the authentication credential, to reveal an attribute its stored evidence
   * lacks: the email an invitation of its organization is compared with (SPACE-INV-004). What it presents is recorded and
   * binds as at a connection (`onIdentityPresented`); another identity is refused there.
   */
  public async reveal(principal: Principal): Promise<IdentityRequestOutcome> {
    if (!this.pack.identity.authentication?.length) return 'not-offered'
    const connectionId = principal.capabilityChannelId
    if (!connectionId) return 'unavailable'
    if (this.pending.has(connectionId)) return 'pending'
    this.pending.add(connectionId)
    try {
      const flowMode = await this.deps.isFlowCapable(connectionId)
      // the connection is identified: the identity is checked before the flow closes, and another one is refused on
      // it with no new request (IDENT-RES-014, IDENT-RES-019, FLOW-SIGNIN-004)
      const attempt = await this.deps.authenticate(
        connectionId,
        principal.actorIdentity,
        flowMode,
        principal.userAgentVerified,
        principal.identityCredentialRef ? principal.actorIdentity : undefined
      )
      if (attempt.outcome === 'not-accepted' && attempt.code === 'another-identity') {
        this.logger.info({ principalId: principal.id }, 'another identity presented to reveal the email: refused')
        return 'another-identity'
      }
      if (attempt.outcome !== 'accepted') return 'not-presented'
      const { outcome } = await this.deps.onIdentityPresented(connectionId, attempt.facts)
      this.logger.info({ principalId: principal.id, outcome }, 'authentication asked again to reveal the email')
      return outcome === 'identified' || outcome === 'refreshed' ? 'identified' : (outcome as IdentityRequestOutcome)
    } finally {
      this.pending.delete(connectionId)
    }
  }

  /**
   * A catalog entry asked on demand (D69, INTX-PRES-003..007): of a peer of the subject kind of its schema,
   * on the connection of the Principal. What comes back is evidence of that Principal; it binds nobody.
   */
  public async present(
    principal: Principal,
    name: string,
    by: 'model' | 'person' | 'connect',
    /** the conversation session the request was made from, which the flow names as its origin (INTX-FLOW-001) */
    origin?: Session
  ): Promise<PresentationRequestOutcome> {
    const entry = this.pack.presentations?.[name]
    if (!entry || !this.deps.present || !this.deps.record) return 'not-offered'
    if (principal.connectionType !== connectionTypeOf(entry.subjectKind)) return 'not-offered'
    if (by === 'model' && entry.request !== 'on-demand') return 'not-offered'
    const connectionId = principal.capabilityChannelId
    if (!connectionId) return 'unavailable'
    if (this.pending.has(connectionId)) return 'pending'
    const key = `${connectionId}|${name}`
    const since = this.unanswered.get(key)
    if (by === 'model' && since !== undefined && Date.now() - since < this.waitMs) return 'wait'
    this.pending.add(connectionId)
    try {
      const flowMode = await this.deps.isFlowCapable(connectionId)
      const evidence = await this.deps.present(connectionId, name, entry, flowMode, origin)
      if (!evidence) {
        this.unanswered.set(key, Date.now())
        return 'not-presented'
      }
      this.unanswered.delete(key)
      await this.deps.record(principal, { ...evidence, connectionRef: connectionId })
      return 'verified'
    } finally {
      this.pending.delete(connectionId)
    }
  }

  /** The entries asked when the capability channel is established, one after the other (INTX-PRES-002). */
  public async onConnect(principal: Principal): Promise<void> {
    for (const [name, entry] of Object.entries(this.pack.presentations ?? {})) {
      if (entry.request !== 'on-connect') continue
      const outcome = await this.present(principal, name, 'connect')
      this.logger.info({ principalId: principal.id, entry: name, outcome }, 'presentation asked on connect')
    }
  }
}

/** What the model is told: a status and what to do with it, never a value (D68, INTX-PRES-005/006). */
export function identityOutcomeForModel(outcome: IdentityRequestOutcome): string {
  switch (outcome) {
    case 'identified':
      return 'identified: the person presented a valid identity credential. From their next message the conversation continues under their identity; principal_credentials then tells what you may read of it.'
    case 'already-identified':
      return 'already identified: nothing to ask.'
    case 'not-presented':
      return 'not presented: the request was declined or left unanswered. This says nothing about whether the person holds the credential. Do not ask again unless they tell you they are ready; they can also identify from the menu.'
    case 'wait':
      return 'not asked: a request was declined or left unanswered a moment ago. The person can identify from the menu when they wish.'
    case 'pending':
      return 'not asked: a request is already waiting for an answer in the wallet.'
    case 'another-identity':
      return 'refused: the credential presented belongs to another identity than the one this connection is bound to. Nothing changed.'
    case 'unavailable':
      return 'not asked: the wallet of this person cannot be reached right now.'
    default:
      return 'not asked: this agent asks for no identity credential.'
  }
}

/** What the model is told of a request for a catalog entry. */
export function presentationOutcomeForModel(outcome: PresentationRequestOutcome): string {
  switch (outcome) {
    case 'verified':
      return 'verified: the credential was presented and verified. principal_credentials tells what you may read of it.'
    case 'not-presented':
      return 'not presented: the request was declined or left unanswered. This says nothing about whether the credential is held. Do not ask again unless you are told they are ready.'
    case 'wait':
      return 'not asked: a request for it was declined or left unanswered a moment ago.'
    case 'pending':
      return 'not asked: a request is already waiting for an answer.'
    case 'unavailable':
      return 'not asked: the wallet cannot be reached right now.'
    default:
      return 'not asked: this credential is not one this agent asks of this peer.'
  }
}

/** What the person is told after asking from the menu. */
export function identityOutcomeForPerson(outcome: IdentityRequestOutcome): string {
  switch (outcome) {
    case 'identified':
      return 'You are authenticated.'
    case 'already-identified':
      return 'You are already authenticated.'
    case 'not-presented':
      return 'No credential was presented.'
    case 'pending':
      return 'A request is already waiting in your wallet.'
    case 'another-identity':
      return 'This credential belongs to another identity than the one of this connection. Nothing changed.'
    case 'unavailable':
      return 'Your wallet cannot be reached right now.'
    default:
      return 'This agent asks for no identity credential.'
  }
}
