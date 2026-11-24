/**
 * Enrolling an authenticator app or a passkey (ayni-spec D129; IDENT-AUTH-012 to 014, FLOW-SIGNIN-014; flow profile §6.4).
 *
 * The phone opens an `enrol` flow, from the service's menu, and sends `enrol-request` with the type; the DIDComm agent
 * reports it (`didcomm.authenticate.enrol-state-changed`, `request-received`). The agent enrols only a type the pack
 * enables, for an identified person, on a connection identified within the last ten minutes by a combination that holds
 * neither an authenticator app nor a passkey; otherwise it first opens an `authenticate` flow of purpose `enrol` with the
 * combinations that hold neither, and refuses the enrolment `not-eligible` when that does not complete. Then:
 *
 * - **Authenticator app:** a new secret, handed to the phone once (`secret`, `otpauth_uri`, 6 digits, 30 seconds) and
 *   kept sealed once the person types a code it gives. Three codes in all (D155, FLOW-SIGNIN-014): a first and a second
 *   wrong code are answered with a new challenge carrying the same secret, the third fails the enrolment `not-valid`.
 *   The spec's `error: "wrong-code"` and `tries_left` on that challenge wait for the plugin to take them: 0.3.0
 *   refuses a field its challenge does not declare.
 * - **Passkey:** the creation options for the relying party of the network's app-link domain; the attestation's key is
 *   kept, never a private key; one that does not verify fails the enrolment `not-valid`.
 *
 * Completed, the flow closes `completed` and the person is sent a status whose `enrolled` lists the type. An `unenrol`,
 * outside any flow, removes it and is answered by a status that no longer lists it. The secret of a pending enrolment
 * lives in this process only: a restart drops the enrolment, which the person starts again.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  type AgentPack,
  ENROLLABLE_METHOD_TYPES,
  type EnrollableMethodType,
  enrollableTypesOf,
} from '../../config/packTypes.js'
import type { EnrolmentStore } from '../../core/authentication/enrolments.js'
import {
  base32Encode,
  matchTotp,
  newTotpSecret,
  otpauthUri,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from '../../core/authentication/totp.js'
import { PASSKEY_ALGORITHMS, verifyRegistration } from '../../core/authentication/webauthn.js'
import type { Principal } from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import { type Authenticator, ENROL_RECENT_MS } from './authenticate.js'
import type { EnrolChallengeBody, EnrolExchange, VsAgentClient } from './vsAgentClient.js'

/**
 * The codes an authenticator app's enrolment takes in all (D155; the library's `ENROL_AUTHENTICATOR_APP_ATTEMPTS`,
 * mirrored: the agent does not depend on Credo): a challenge for each, the first then one after each wrong code; the
 * plugin refuses a fourth challenge.
 */
export const ENROL_AUTHENTICATOR_APP_ATTEMPTS = 3

export interface EnrolDeps {
  pack: AgentPack
  client: Pick<VsAgentClient, 'sendEnrolChallenge' | 'flowProblemReport' | 'closeFlow'>
  authenticator: Pick<Authenticator, 'run'>
  /** the Principal of a connection, once it is resolved */
  principalOf(connectionId: string): Promise<Principal | undefined>
  savePrincipal(principal: Principal): Promise<void>
  enrolments: EnrolmentStore
  /** the person is told what changed: a status whose `enrolled` says it (FLOW-STAT-003, IDENT-STAT-005) */
  statusChanged(connectionId: string, principal: Principal): Promise<void>
  /** the relying party of a passkey: the network's app-link domain (FLOW-SIGNIN-013) */
  rpId: string
  logger: Logger
}

interface Pending {
  connectionId: string
  flowId: string
  principalId: string
  type: EnrollableMethodType
  /** an authenticator app's secret, base32, or a passkey's challenge, base64url */
  secret?: string
  challenge?: string
}

/** Whether a Principal authenticated recently enough to enrol, by a combination that holds no enrollable method (D129). */
export function recentlyAuthenticated(principal: Principal, now = Date.now()): boolean {
  const last = principal.lastAuthentication
  if (!last) return false
  if (now - Date.parse(last.at) > ENROL_RECENT_MS) return false
  return !last.types.some((type) => (ENROLLABLE_METHOD_TYPES as readonly string[]).includes(type))
}

export class EnrolService {
  private readonly pending = new Map<string, Pending>()

  public constructor(private readonly deps: EnrolDeps) {}

  /** `didcomm.authenticate.enrol-state-changed`: a request, an answer, or an exchange the DIDComm agent failed. */
  public async onExchange(exchange: EnrolExchange): Promise<void> {
    if (exchange.role !== 'requester') return
    if (exchange.state === 'request-received') return this.begin(exchange)
    if (exchange.state === 'answer-received') return this.answered(exchange)
    if (exchange.state === 'failed') {
      const pending = this.pending.get(exchange.threadId)
      this.pending.delete(exchange.threadId)
      const flowId = exchange.flowId ?? pending?.flowId
      if (flowId)
        await this.refuse(flowId, 'malformed', exchange.errorDescription ?? 'The enrolment was not understood.')
    }
  }

  /** `didcomm.authenticate.unenrol-received`: the type goes, and the person is told (FLOW-SIGNIN-014). */
  public async onUnenrol(connectionId: string, type: string): Promise<void> {
    const principal = await this.deps.principalOf(connectionId)
    if (!principal || !(ENROLLABLE_METHOD_TYPES as readonly string[]).includes(type)) return
    const removed = await this.deps.enrolments.remove(principal.id, type as EnrollableMethodType)
    this.deps.logger.info({ principalId: principal.id, type, removed }, 'a method removed by the person (unenrol)')
    // answered with a status whose `enrolled` no longer lists it, whether or not it did before
    await this.deps.statusChanged(connectionId, principal)
  }

  private async begin(exchange: EnrolExchange): Promise<void> {
    const flowId = exchange.flowId
    if (!flowId) return
    const type = exchange.type
    let principal = await this.deps.principalOf(exchange.connectionId)
    // a type the pack enables, for an identified person (FLOW-SIGNIN-014): a visitor is refused `not-eligible`
    if (
      principal?.connectionType !== 'verifiable-user-agent' ||
      !principal.identityCredentialRef ||
      !enrollableTypesOf(this.deps.pack).includes(type)
    ) {
      this.deps.logger.info({ connectionId: exchange.connectionId, type }, 'an enrolment refused: not eligible')
      return this.refuse(flowId, 'not-eligible', 'This service does not enrol this method for you.')
    }
    if (!recentlyAuthenticated(principal)) {
      // an authentication first, by a combination that holds neither an authenticator app nor a passkey (IDENT-AUTH-014)
      const attempt = await this.deps.authenticator
        .run({
          connectionId: exchange.connectionId,
          peerId: principal.actorIdentity,
          purpose: 'enrol',
          userAgentVerified: principal.userAgentVerified,
          bound: principal,
        })
        .catch((err) => {
          this.deps.logger.warn(
            { err, connectionId: exchange.connectionId },
            'the authentication of an enrolment failed'
          )
          return { outcome: 'unanswered' as const }
        })
      if (attempt.outcome !== 'accepted' || !attempt.facts.authentication) {
        this.deps.logger.info(
          { principalId: principal.id, outcome: attempt.outcome },
          'an enrolment refused: not authenticated'
        )
        return this.refuse(flowId, 'not-eligible', 'You did not confirm who you are.')
      }
      principal = { ...principal, lastAuthentication: attempt.facts.authentication }
      await this.deps.savePrincipal(principal)
    }
    const pending: Pending = {
      connectionId: exchange.connectionId,
      flowId,
      principalId: principal.id,
      type,
    }
    const challenge = this.challengeOf(pending, principal)
    this.pending.set(exchange.threadId, pending)
    try {
      await this.deps.client.sendEnrolChallenge(exchange.threadId, challenge)
    } catch (err) {
      this.pending.delete(exchange.threadId)
      this.deps.logger.warn({ err, flowId }, 'the enrolment challenge could not be sent')
      await this.refuse(flowId, 'not-valid', 'The enrolment could not go on.')
    }
  }

  private challengeOf(pending: Pending, principal: Principal): EnrolChallengeBody {
    const agent = this.deps.pack.metadata?.displayName ?? 'Ayni agent'
    const account = String(principal.identityAttributes.userName ?? 'you')
    if (pending.type === 'authenticator-app') {
      const secret = pending.secret ? Buffer.from(pending.secret, 'base64url') : newTotpSecret()
      pending.secret = secret.toString('base64url')
      return {
        type: 'authenticator-app',
        secret: base32Encode(secret),
        otpauthUri: otpauthUri(secret, agent, account),
        digits: TOTP_DIGITS,
        period: TOTP_PERIOD_SECONDS,
      }
    }
    pending.challenge = randomBytes(32).toString('base64url')
    return {
      type: 'passkey',
      publicKey: {
        rp: { id: this.deps.rpId, name: agent },
        // an opaque id of the Principal, the same at every enrolment: one passkey per agent and person (D129)
        user: {
          id: createHash('sha256').update(`ayni-passkey-user\n${principal.id}`).digest().toString('base64url'),
          name: account,
          displayName: account,
        },
        challenge: pending.challenge,
        pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      },
    }
  }

  private async answered(exchange: EnrolExchange): Promise<void> {
    const pending = this.pending.get(exchange.threadId)
    if (!pending) return
    const principal = await this.deps.principalOf(pending.connectionId)
    if (!principal || principal.id !== pending.principalId) {
      this.pending.delete(exchange.threadId)
      return this.refuse(pending.flowId, 'not-eligible', 'This connection changed hands.')
    }
    if (pending.type === 'authenticator-app') {
      const secret = Buffer.from(pending.secret ?? '', 'base64url')
      const counter = matchTotp(secret, String(exchange.answer?.code ?? ''), Date.now())
      if (counter === undefined) {
        // a wrong code: a new challenge with the same secret, three codes in all, the third failing the enrolment
        // `not-valid` (flow profile §6.4, FLOW-SIGNIN-014)
        if (exchange.challenges >= ENROL_AUTHENTICATOR_APP_ATTEMPTS) {
          this.pending.delete(exchange.threadId)
          return this.refuse(pending.flowId, 'not-valid', 'The code was not right.')
        }
        await this.deps.client.sendEnrolChallenge(exchange.threadId, this.challengeOf(pending, principal))
        return
      }
      this.pending.delete(exchange.threadId)
      await this.deps.enrolments.setAuthenticatorApp(principal.id, base32Encode(secret))
      await this.deps.enrolments.usedCode(principal.id, counter)
      return this.completed(pending, principal)
    }
    this.pending.delete(exchange.threadId)
    const attestation = exchange.answer?.attestation
    const checked = attestation
      ? verifyRegistration({ attestation, challenge: pending.challenge ?? '', rpId: this.deps.rpId })
      : ({ ok: false, reason: 'no attestation' } as const)
    if (!checked.ok) {
      this.deps.logger.warn(
        { principalId: principal.id, reason: checked.reason },
        'a passkey enrolment does not verify'
      )
      return this.refuse(pending.flowId, 'not-valid', 'The passkey could not be verified.')
    }
    await this.deps.enrolments.setPasskey(principal.id, checked.passkey)
    return this.completed(pending, principal)
  }

  private async completed(pending: Pending, principal: Principal): Promise<void> {
    this.deps.logger.info({ principalId: principal.id, type: pending.type }, 'a method enrolled (D129)')
    await this.deps.client
      .closeFlow(pending.flowId, { outcome: 'completed' })
      .catch((err) => this.deps.logger.warn({ err, flowId: pending.flowId }, 'the enrol flow could not be closed'))
    await this.deps.statusChanged(pending.connectionId, principal)
  }

  private async refuse(flowId: string, code: string, description: string): Promise<void> {
    await this.deps.client
      .flowProblemReport(flowId, { code, description })
      .catch((err) => this.deps.logger.warn({ err, flowId, code }, 'the enrolment refusal could not be sent'))
  }
}
