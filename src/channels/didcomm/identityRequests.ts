/**
 * The authentication asked on demand (D65, D66; IDENT-RES-015/016): while a connection is unidentified,
 * the model, through its tool, or the person, from the menu, has the agent ask the wallet for the
 * credential of the authentication schema. What comes back binds the connection by the rules of
 * IDENT-RES-013/014. The agent does not insist: one request at a time on a connection, and after a request
 * that was declined or left unanswered the model waits; the person's own request is always served.
 */
import type { AgentPack } from '../../config/packTypes.js'
import type { VerifiedFacts } from '../../core/principals.js'
import type { Principal } from '../../core/types.js'
import type { Logger } from '../../util/logger.js'

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
  /** asks the wallet and returns the verified facts, or undefined when nothing that identifies was presented */
  identify(
    connectionId: string,
    peerId: string,
    flowMode: boolean,
    userAgentVerified: boolean
  ): Promise<VerifiedFacts | undefined>
  isFlowCapable(connectionId: string): Promise<boolean>
  /** binds the connection by the rules of D66 */
  onIdentityPresented(connectionId: string, facts: VerifiedFacts): Promise<{ outcome: string }>
}

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
      const facts = await this.deps.identify(
        connectionId,
        principal.actorIdentity,
        await this.deps.isFlowCapable(connectionId),
        principal.userAgentVerified
      )
      if (!facts) {
        this.unanswered.set(connectionId, Date.now())
        return 'not-presented'
      }
      this.unanswered.delete(connectionId)
      const { outcome } = await this.deps.onIdentityPresented(connectionId, facts)
      this.logger.info({ principalId: principal.id, by, outcome }, 'identity asked on demand')
      return outcome === 'identified' || outcome === 'refreshed' ? 'identified' : (outcome as IdentityRequestOutcome)
    } finally {
      this.pending.delete(connectionId)
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

/** What the person is told after asking from the menu. */
export function identityOutcomeForPerson(outcome: IdentityRequestOutcome): string {
  switch (outcome) {
    case 'identified':
      return 'You are identified.'
    case 'already-identified':
      return 'You are already identified.'
    case 'not-presented':
      return 'No identity credential was presented.'
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
