/**
 * The authentication on the phone (ayni-spec D125 to D131; IDENT-AUTH-001 to 017, IDENT-RES-019/020, IDENT-DIR-003/004;
 * flow profile §6.14, FLOW-SIGNIN-001 to 013): one `authenticate` flow, carried by authenticate/1.0 through the Ayni flow
 * plugin of the DIDComm agent (`@ayni.org/vs-agent-plugin-ayni-flow` 0.3.0).
 *
 * 1. The agent opens the flow, valid fifteen minutes, the time of every step, and sends the `request`: the purpose, the
 *    methods and the accepted combinations, those the phone can be offered (a face match only to a phone that disclosed
 *    `calls/1.0` as `callee`). The DIDComm agent keeps one `authenticate` flow at a time on a connection and answers 409
 *    to a second: the request is then `pending`.
 * 2. The person chooses a combination on the phone (`choice`), within five minutes, or the request is unanswered.
 * 3. The agent runs its methods, the identifying ones first in the order the combination lists them, then the confirming
 *    ones, each announced by a `step` and ended by a `step-result`: a credential (present-proof under the flow id), an
 *    email (the address, then a code), a document (mrtd under the flow id), a face match (the consent, then a call the
 *    face-verification service joins), an authenticator app's code, a passkey's assertion.
 *    A person who declines the consent of a face match ends that step `failed` `consent-declined` (D152, FLOW-SIGNIN-012):
 *    no call, no evidence, no refusal; the flow stays open and the person chooses, on the same request, a combination
 *    without the declined method, within five minutes of that step's result (the flow's fifteen minutes do not change).
 *    Every step of the new combination runs, a method that passed before included, numbered after the steps already
 *    used in the flow (O91).
 * 4. The methods must find one identity: an entry of the user directory, else the person of a credential of another
 *    organization, else the Principal a passkey was enrolled for; on an identified connection, the same one. The agent
 *    checks it before it closes the flow, so that a refused authentication never ends `completed`.
 * 5. Accepted, the flow closes `completed` and the caller binds what it found. Not accepted, the flow gets a problem
 *    report with the reason (§11), and the caller asks again except after `another-identity`.
 *
 * Nothing of a step is kept beyond it: the address and the code's hash live in this process for the step only; what was
 * verified becomes evidence only once the authentication is accepted (IDENT-RES-019).
 */
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { DOCUMENT_ENTRY, EMAIL_ENTRY, FACE_MATCH_ENTRY } from '../../config/pack.js'
import {
  type AgentPack,
  type AuthenticationMethod,
  CONFIRMING_METHOD_TYPES,
  type CredentialMethod,
  ENROLLABLE_METHOD_TYPES,
} from '../../config/packTypes.js'
import type { EnrolmentStore } from '../../core/authentication/enrolments.js'
import { base32Decode, matchTotp } from '../../core/authentication/totp.js'
import { verifyAssertion } from '../../core/authentication/webauthn.js'
import { nameOf } from '../../core/directory.js'
import { readDocument } from '../../core/document.js'
import type { EvidenceInput } from '../../core/evidence.js'
import type { FlowClosed, FlowService } from '../../core/flows.js'
import type { OrganizationFacts } from '../../core/organization.js'
import type { VerifiedFacts } from '../../core/principals.js'
import type { ServiceSentence } from '../../core/serviceLanguage.js'
import type { AuthenticationRecord, Principal, Session } from '../../core/types.js'
import { isEmailAddress, type Mailer } from '../../platform/mail.js'
import { Deferred } from '../../util/async.js'
import { nowIso } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'
import type { FaceOutcome, FaceSteps } from './faceSteps.js'
import type {
  AuthenticateExchange,
  AuthenticateMethodWire,
  AuthenticatePurpose,
  AuthenticateStepBody,
  PresentationRecord,
  RequestedCredential,
  VsAgentClient,
} from './vsAgentClient.js'
import { VsAgentError } from './vsAgentClient.js'

/** `expires_time` of an `authenticate` flow: fifteen minutes after its `open` (flow profile §6.14; the library's constant). */
export const AUTHENTICATE_FLOW_EXPIRY_MS = 15 * 60 * 1000
/** A `choice` that does not come within five minutes leaves the request unanswered (FLOW-SIGNIN-005, IDENT-RES-020). */
export const AUTHENTICATE_CHOICE_TIMEOUT_MS = 5 * 60 * 1000
/** The address of an email step, and each code it sends, are valid ten minutes (IDENT-AUTH-007). */
export const EMAIL_STEP_MS = 10 * 60 * 1000
/** Five tries of a code in all for an email step, whichever code they are for, and for an authenticator app's step. */
export const CODE_TRIES = 5
/** Three new codes at most in an email step, thirty seconds apart (IDENT-AUTH-008, FLOW-SIGNIN-011). */
export const NEW_CODES = 3
export const NEW_CODE_AFTER_MS = 30_000
/** How long an identified connection counts as recently authenticated for an enrolment (D129, IDENT-AUTH-014). */
export const ENROL_RECENT_MS = 10 * 60 * 1000

/**
 * Why an authentication is not accepted (flow profile §11, IDENT-RES-019): the first three for a `credential` step, the
 * next three for a step of another method, `different-identities` for the combination, `another-identity` for a
 * connection identified as someone else. All but the last are asked again.
 */
export type NotAcceptedCode =
  | 'issuer-not-accepted'
  | 'not-valid'
  | 'incomplete'
  | 'step-failed'
  | 'step-expired'
  | 'no-match'
  | 'different-identities'
  | 'another-identity'

export const NOT_ACCEPTED: Record<NotAcceptedCode, string> = {
  'issuer-not-accepted': 'This service does not accept credentials of this issuer.',
  'not-valid': 'This credential could not be verified, or is no longer valid.',
  incomplete: 'This service needs an attribute that was not shared.',
  'step-failed': 'A step of the authentication did not pass.',
  'step-expired': 'A step of the authentication took too long.',
  'no-match': 'This service does not know who this is.',
  'different-identities': 'The methods you used belong to different people.',
  'another-identity': 'This belongs to another identity than the one of this connection.',
}

/** What one `authenticate` flow ends in (D72). */
export type AuthenticationAttempt =
  | { outcome: 'accepted'; facts: VerifiedFacts }
  | { outcome: 'not-accepted'; code: NotAcceptedCode }
  | { outcome: 'declined' }
  | { outcome: 'unanswered' }
  /** an `authenticate` flow is already open on the connection: the DIDComm agent keeps one at a time (409) */
  | { outcome: 'pending' }

/** Whether a refused authentication is asked again (FLOW-SIGNIN-004, IDENT-RES-019): all reasons but another identity. */
export function asksAgain(attempt: AuthenticationAttempt): boolean {
  return attempt.outcome === 'not-accepted' && attempt.code !== 'another-identity'
}

/** The order of a combination's steps (FLOW-SIGNIN-008): the identifying methods first, as listed, then the confirming. */
export function runOrder(methods: Record<string, AuthenticationMethod>, combination: string[]): string[] {
  const confirming = (name: string) => CONFIRMING_METHOD_TYPES.includes(methods[name]?.type)
  return [...combination.filter((n) => !confirming(n)), ...combination.filter(confirming)]
}

/** The identity a method found (IDENT-AUTH-004). */
type Found =
  | { kind: 'entry'; entryId: string; facts?: VerifiedFacts }
  | { kind: 'credential'; facts: VerifiedFacts }
  | { kind: 'principal'; principal: Principal }

/** Two methods found the same identity when they name the same entry, or the same person. */
function sameIdentity(a: Found, b: Found): boolean {
  return keyOf(a) === keyOf(b)
}

function keyOf(found: Found): string {
  if (found.kind === 'entry') return `entry:${found.entryId}`
  if (found.kind === 'principal')
    return found.principal.directoryEntryId
      ? `entry:${found.principal.directoryEntryId}`
      : `actor:${found.principal.actorIdentity}`
  return found.facts.directoryEntryId ? `entry:${found.facts.directoryEntryId}` : `actor:${found.facts.actorIdentity}`
}

/** The actor identity of a person of the user directory: the home organization, the directory, the entry (IDENT-RES-002). */
export function directoryActorOf(homeKey: string, entryId: string): string {
  return [homeKey, 'directory', encodeURIComponent(entryId)].join('|')
}

/** What the engine needs of the rest of the agent; a method whose port is missing fails its step, and says so. */
export interface AuthenticatePorts {
  client: Pick<
    VsAgentClient,
    | 'sendAuthenticateRequest'
    | 'sendAuthenticateStep'
    | 'sendAuthenticateStepResult'
    | 'requestPresentation'
    | 'requestEmrtd'
  >
  flows: Pick<FlowService, 'open' | 'close' | 'problemReport' | 'waitForClose'>
  /** a presentation request of the flow, and its record once final */
  awaitPresentation(proofExchangeId: string, timeoutMs: number): Promise<PresentationRecord>
  /** the facts of a verified presentation of a `credential` method, or why it is not accepted (IDENT-RES-008/012/018) */
  credentialFacts(
    peerId: string,
    record: PresentationRecord,
    method: CredentialMethod,
    userAgentVerified: boolean
  ): Promise<VerifiedFacts | 'issuer-not-accepted' | 'not-valid' | 'incomplete'>
  /** whether the phone disclosed `calls/1.0` as `callee` (IDENT-AUTH-010) */
  takesCalls?(connectionId: string): Promise<boolean>
  directory?: {
    byEmail(address: string): { id: string; firstName: string; lastName: string } | undefined
    matchDocument(document: { lastName: string; firstName: string; dateOfBirth: string; nationality: string }): {
      ids: string[]
    }
    entry(id: string): { id: string; firstName: string; lastName: string } | undefined
    photoOf?(id: string): { bytes: Buffer; mimeType: string } | undefined
  }
  /** the entry a credential this agent issued from the directory was issued from (IDENT-AUTH-004, IDENT-DIR-006) */
  entryOfCredential?(facts: VerifiedFacts): Promise<string | undefined>
  /** the agent's own organization: the backing identity of a person of the directory (IDENT-RES-002) */
  home(): Promise<OrganizationFacts | null>
  principals: {
    get(id: string): Promise<Principal | undefined>
    findByActor(actor: string): Promise<Principal | undefined>
    /** the organization of the issuer of the credential a Principal was identified by, for its relation (D64) */
    organizationOf?(principal: Principal): Promise<OrganizationFacts | null>
  }
  enrolments?: EnrolmentStore
  faceSteps?: FaceSteps
  mailer?: Mailer
  /** a finished sentence in the language of the phone's locale (INTX-AUTH-020) */
  renderIn?(sentence: ServiceSentence, locale: string | undefined): Promise<string>
  /** a keyed hash: the email code is kept as one (IDENT-AUTH-007) */
  blindIndex(value: string): string
  /** the relying party of a passkey: the network's app-link domain (FLOW-SIGNIN-013) */
  rpId: string
}

export interface AuthenticateOptions {
  connectionId: string
  /** the actor identity of the peer before it is identified: what a credential's facts name until then */
  peerId: string
  purpose: AuthenticatePurpose
  userAgentVerified: boolean
  /** the Principal of an identified connection: the authentication must find it (IDENT-RES-014, IDENT-AUTH-015) */
  bound?: Principal
  /** the combinations asked, in place of the pack's: the one set of a step-up or admin access, those of an enrolment */
  combinations?: string[][]
  /** what a step-up is for (flow profile §6.14) */
  text?: string
  /** the session a step-up or admin access was asked from: the flow's origin; none at connection and for a visitor */
  origin?: Session
}

/** The events of one exchange, as the DIDComm agent reports them, kept until they are read. */
class ExchangeEvents {
  private readonly queue: AuthenticateExchange[] = []
  private waiter?: Deferred<AuthenticateExchange>
  /** the exchange the DIDComm agent failed, whatever the agent waits for then */
  public readonly failed = new Deferred<AuthenticateExchange>()

  public push(exchange: AuthenticateExchange): void {
    if (exchange.state === 'failed') this.failed.resolve(exchange)
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w.resolve(exchange)
    } else this.queue.push(exchange)
  }

  public next(): Promise<AuthenticateExchange> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    this.waiter = new Deferred<AuthenticateExchange>()
    return this.waiter.promise
  }
}

/** The reason of the `step-result` of a face step whose consent the person declined: no refusal (D152, flow profile §11). */
export const CONSENT_DECLINED = 'consent-declined'

/**
 * What stops an authentication whatever it waits for: the flow closed by the holder or by its expiry, or the exchange
 * the DIDComm agent failed (a message of the phone that broke a rule of the profile, such as a second `choice` that is
 * not awaited, FLOW-SIGNIN-008), which the agent answers with the flow's problem report.
 */
type Stop =
  | { outcome: 'closed'; closed: FlowClosed }
  | { outcome: 'exchange-failed'; code: string; description?: string }

/** How a wait ends: what was awaited, a stop, or the step's own time. */
type Waited<T> = { value: T } | { stop: Stop } | { timeout: true }

/** What a step ends in. */
type StepEnd =
  | { outcome: 'passed'; found?: Found; evidence?: EvidenceInput; portrait?: string }
  | { outcome: 'failed' | 'expired'; reason: NotAcceptedCode }
  /** a face step whose consent the person declined: the person chooses another combination (D152) */
  | { outcome: 'consent-declined' }
  | Stop

interface Run {
  options: AuthenticateOptions
  flowId: string
  threadId: string
  expiresAt: number
  closed: Promise<FlowClosed>
  events: ExchangeEvents
  methods: Record<string, AuthenticationMethod>
  /** the methods whose consent the person declined in this flow: a new choice holds none of them (D152) */
  declined: Set<string>
  /** the identity the identifying steps found */
  found?: Found
  /** the portrait of a document read in this flow: the reference of a face match (D131) */
  portrait?: string
  evidence: EvidenceInput[]
  steps: AuthenticationRecord['steps']
}

export class Authenticator {
  /** the exchanges running, by thread id; events of an exchange not yet registered wait a moment for it */
  private readonly exchanges = new Map<string, ExchangeEvents>()
  private readonly early = new Map<string, { at: number; events: AuthenticateExchange[] }>()
  /** the times of the profile and of IDENT-AUTH-007/008; shorter for the tests */
  public timings = {
    flowMs: AUTHENTICATE_FLOW_EXPIRY_MS,
    choiceMs: AUTHENTICATE_CHOICE_TIMEOUT_MS,
    emailMs: EMAIL_STEP_MS,
    newCodeAfterMs: NEW_CODE_AFTER_MS,
  }
  /** mrtd and calls answers, by connection and thread */
  private readonly documents = new Map<string, Deferred<{ received: boolean; data: Record<string, unknown> }>>()

  public constructor(
    private readonly pack: AgentPack,
    private ports: AuthenticatePorts,
    private readonly logger: Logger
  ) {}

  /** Adds ports the agent builds later than this engine (the directory, the mailer, the enrolments). */
  public extend(ports: Partial<AuthenticatePorts>): void {
    this.ports = { ...this.ports, ...ports }
  }

  // ---- events (CC-VSA-005, CC-VSA-013) -------------------------------------------------------------------------------

  /** `didcomm.authenticate.state-changed`: a `choice`, an `answer`, a failure the DIDComm agent recorded. */
  public onExchange(exchange: AuthenticateExchange): void {
    if (exchange.role !== 'requester') return
    const events = this.exchanges.get(exchange.threadId)
    if (events) {
      events.push(exchange)
      return
    }
    // the event of an exchange whose request is still being answered by the route: kept a minute
    const now = Date.now()
    for (const [id, e] of this.early) if (now - e.at > 60_000) this.early.delete(id)
    const kept = this.early.get(exchange.threadId) ?? { at: now, events: [] }
    kept.events.push(exchange)
    this.early.set(exchange.threadId, kept)
  }

  /** The data of a document's chip, or the phone's word that sends none: true when a step of this engine took it. */
  public onDocument(connectionId: string, threadId: string, received: boolean, data: Record<string, unknown>): boolean {
    const waiting = this.documents.get(`${connectionId}|${threadId}`)
    if (!waiting) return false
    this.documents.delete(`${connectionId}|${threadId}`)
    waiting.resolve({ received, data })
    return true
  }

  // ---- the request ---------------------------------------------------------------------------------------------------

  /**
   * The combinations a request offers (IDENT-AUTH-010, IDENT-AUTH-014): those given or the pack's, without a face match
   * for a phone that takes no calls, and without an enrollable method for an enrolment.
   */
  public async combinationsFor(options: Pick<AuthenticateOptions, 'connectionId' | 'purpose' | 'combinations'>) {
    const methods = this.pack.identity.authentication?.methods ?? {}
    const takesCalls = (await this.ports.takesCalls?.(options.connectionId)) ?? false
    return (options.combinations ?? this.pack.identity.authentication?.combinations ?? []).filter((combination) => {
      const types = combination.map((name) => methods[name]?.type)
      if (types.some((t) => t === undefined)) return false
      if (types.includes('face-match') && (!takesCalls || !this.ports.faceSteps?.available)) return false
      if (options.purpose === 'enrol' && types.some((t) => (ENROLLABLE_METHOD_TYPES as readonly string[]).includes(t)))
        return false
      return true
    })
  }

  /** The methods of a request as the profile writes them (flow profile §4.1): a credential method with its issuers. */
  public static methodWire(method: AuthenticationMethod): AuthenticateMethodWire {
    return {
      type: method.type,
      ...(method.type === 'credential' && method.credential
        ? { credential: { jsonSchemaCredentialId: method.credential.jsonSchemaCredentialId } }
        : {}),
      ...(method.type === 'credential' && method.issuers?.organizations?.length
        ? { issuers: [...method.issuers.organizations] }
        : {}),
    }
  }

  private titleOf(purpose: AuthenticatePurpose): string {
    const name = this.pack.metadata?.displayName ?? 'The agent'
    if (purpose === 'enrol') return `Confirm it's you to ${name}`
    if (purpose === 'step-up' || purpose === 'admin') return `Confirm it's you to ${name}`
    return `Authenticate to ${name}`
  }

  /** Runs one `authenticate` flow and says what it ended in. */
  public async run(options: AuthenticateOptions): Promise<AuthenticationAttempt> {
    const all = this.pack.identity.authentication?.methods ?? {}
    const combinations = await this.combinationsFor(options)
    if (!combinations.length) {
      this.logger.info(
        { connectionId: options.connectionId, purpose: options.purpose },
        'no accepted combination can be offered to this phone: the authentication is not asked'
      )
      return { outcome: 'declined' }
    }
    const used = new Set(combinations.flat())
    const methods = Object.fromEntries(Object.entries(all).filter(([name]) => used.has(name)))
    let flowId: string
    try {
      flowId = (
        await this.ports.flows.open({
          connectionId: options.connectionId,
          kind: 'authenticate',
          title: this.titleOf(options.purpose),
          expiresInMs: this.timings.flowMs,
          ...(options.origin ? { origin: options.origin, card: false } : {}),
        })
      ).flowId
    } catch (error) {
      // one authenticate flow at a time on a connection (FLOW-SIGNIN-001): the DIDComm agent answers 409 to a second
      if (error instanceof VsAgentError && error.status === 409) {
        this.logger.info(
          { connectionId: options.connectionId },
          'an authenticate flow is already open: not asked again'
        )
        return { outcome: 'pending' }
      }
      throw error
    }
    const expiresAt = Date.now() + this.timings.flowMs
    const closed = this.ports.flows.waitForClose(flowId)
    let exchange: AuthenticateExchange
    try {
      exchange = await this.ports.client.sendAuthenticateRequest({
        connectionId: options.connectionId,
        flowId,
        request: {
          purpose: options.purpose,
          methods: Object.fromEntries(Object.entries(methods).map(([n, m]) => [n, Authenticator.methodWire(m)])),
          combinations,
          ...(options.text ? { text: options.text } : {}),
        },
      })
    } catch (error) {
      await this.ports.flows.close(flowId, 'failed', { reason: 'The authentication request could not be sent.' })
      throw error
    }
    const events = new ExchangeEvents()
    this.exchanges.set(exchange.threadId, events)
    for (const early of this.early.get(exchange.threadId)?.events ?? []) events.push(early)
    this.early.delete(exchange.threadId)
    const run: Run = {
      options,
      flowId,
      threadId: exchange.threadId,
      expiresAt,
      closed,
      events,
      methods,
      declined: new Set(),
      evidence: [],
      steps: [],
    }
    try {
      return await this.drive(run)
    } finally {
      this.exchanges.delete(exchange.threadId)
    }
  }

  private async drive(run: Run): Promise<AuthenticationAttempt> {
    // the choice, within five minutes of the request (FLOW-SIGNIN-005)
    let chosen = await this.choice(run)
    // the step numbers of the flow: those of a new combination follow the ones already used (D152, O91)
    let next = 1
    for (;;) {
      if ('attempt' in chosen) return chosen.attempt
      const combination = chosen.combination
      // every step of the combination runs, a method that passed under a combination left before included (O91)
      run.found = undefined
      run.portrait = undefined
      run.evidence = []
      let declined = false
      for (const name of runOrder(run.methods, combination)) {
        const step = String(next++)
        const method = run.methods[name]
        const end = await this.step(run, step, name, method)
        if (end.outcome === 'closed' || end.outcome === 'exchange-failed') return this.stopped(run, end)
        if (end.outcome === 'consent-declined') {
          // no refusal: the person chooses another combination on the same request (D152, FLOW-SIGNIN-012)
          run.steps.push({ method: name, type: method.type, outcome: 'failed', reason: CONSENT_DECLINED })
          run.declined.add(name)
          declined = true
          break
        }
        run.steps.push({ method: name, type: method.type, outcome: end.outcome })
        if (end.outcome !== 'passed') return this.refuse(run, end.reason)
        if (end.evidence) run.evidence.push(end.evidence)
        if (end.portrait) run.portrait = end.portrait
        if (end.found) {
          // the methods of a combination find one identity (IDENT-DIR-004)
          if (run.found && !sameIdentity(run.found, end.found)) return this.refuse(run, 'different-identities')
          // of the same entry, what a credential presented is kept: its facts and its evidence
          const withFacts = end.found.kind === 'entry' && !!end.found.facts
          if (!run.found || (withFacts && run.found.kind === 'entry' && !run.found.facts)) run.found = end.found
        }
      }
      if (!declined) {
        const facts = await this.factsOf(run, combination)
        if (typeof facts === 'string') return this.refuse(run, facts)
        // the identity is checked before the flow closes: another one never ends completed (IDENT-RES-014, FLOW-SIGNIN-004)
        const bound = run.options.bound
        if (bound?.identityCredentialRef && !sameActor(bound, facts)) {
          this.logger.warn(
            { connectionId: run.options.connectionId },
            'another identity authenticated on an identified connection: refused'
          )
          return this.refuse(run, 'another-identity')
        }
        await this.ports.flows.close(run.flowId, 'completed')
        return { outcome: 'accepted', facts }
      }
      // a new choice, within five minutes of the step result that ended the declined step (D152); the flow keeps its
      // fifteen minutes
      chosen = await this.choice(run)
    }
  }

  /**
   * The person's choice, within five minutes of the request or of a step that ended `consent-declined`, and never
   * later than the flow's expiry (FLOW-SIGNIN-005, FLOW-SIGNIN-012): unanswered otherwise, and the flow closes `expired`.
   */
  private async choice(run: Run): Promise<{ combination: string[] } | { attempt: AuthenticationAttempt }> {
    const waited = await this.wait(
      run,
      async () => {
        for (;;) {
          const e = await run.events.next()
          if (e.state === 'choice-received' && e.combination) return e.combination
        }
      },
      Math.min(this.timings.choiceMs, this.left(run))
    )
    if ('stop' in waited) return { attempt: await this.stopped(run, waited.stop) }
    if ('timeout' in waited) {
      await this.ports.flows.close(run.flowId, 'expired', { reason: 'No choice came in time.' })
      return { attempt: { outcome: 'unanswered' } }
    }
    // a choice that holds a method whose consent the person declined is malformed (FLOW-SIGNIN-012); the DIDComm agent
    // refuses it first
    const declined = waited.value.filter((name) => run.declined.has(name))
    if (declined.length)
      return {
        attempt: await this.stopped(run, {
          outcome: 'exchange-failed',
          code: 'malformed',
          description: `The choice holds ${declined.join(', ')}, whose consent was declined.`,
        }),
      }
    return { combination: waited.value }
  }

  /**
   * The holder closed the flow or it expired (a decline, or no answer); or the DIDComm agent failed the exchange on a
   * message of the phone that broke a rule of the profile (a choice that is not one of the combinations, a second
   * choice that is not awaited, FLOW-SIGNIN-008): refused with the flow's problem report, and not asked again.
   */
  private async stopped(run: Run, stop: Stop): Promise<AuthenticationAttempt> {
    if (stop.outcome === 'closed') return this.closedBy(stop.closed)
    await this.ports.flows.problemReport(run.flowId, stop.code, stop.description)
    return { outcome: 'declined' }
  }

  private async refuse(run: Run, code: NotAcceptedCode): Promise<AuthenticationAttempt> {
    await this.ports.flows.problemReport(run.flowId, code, NOT_ACCEPTED[code])
    return { outcome: 'not-accepted', code }
  }

  /** The holder closed the flow, or it expired (FLOW-SIGNIN-005/006): a decline, or no answer. */
  private closedBy(closed: FlowClosed): AuthenticationAttempt {
    return closed.outcome === 'expired' ? { outcome: 'unanswered' } : { outcome: 'declined' }
  }

  /** Waits for `what`, the close of the flow, the failure of the exchange or `ms`, whichever comes first. */
  private async wait<T>(run: Run, what: () => Promise<T>, ms: number): Promise<Waited<T>> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<{ timeout: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), Math.max(0, ms))
    })
    try {
      return await Promise.race<Waited<T>>([
        what().then((value) => ({ value })),
        run.closed.then((closed) => ({ stop: { outcome: 'closed' as const, closed } })),
        run.events.failed.promise.then((failed) => ({
          stop: {
            outcome: 'exchange-failed' as const,
            code: failed.errorCode ?? 'malformed',
            description: failed.errorDescription,
          },
        })),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The next answer to a step (`answer-received`); the failure of the exchange stops the wait (`wait`). */
  private async answer(run: Run, step: string, ms: number) {
    return this.wait(
      run,
      async () => {
        for (;;) {
          const e = await run.events.next()
          if (e.state !== 'answer-received') continue
          const entry = e.steps.find((s) => s.step === step)
          if (entry?.answer) return entry.answer
        }
      },
      ms
    )
  }

  private async send(run: Run, step: AuthenticateStepBody): Promise<void> {
    await this.ports.client.sendAuthenticateStep(run.threadId, step)
  }

  private async result(
    run: Run,
    step: string,
    outcome: 'passed' | 'failed' | 'expired',
    reason?: NotAcceptedCode | typeof CONSENT_DECLINED
  ): Promise<void> {
    await this.ports.client.sendAuthenticateStepResult(run.threadId, {
      step,
      outcome,
      ...(outcome === 'passed' ? {} : { reason }),
    })
  }

  /** Ends a step that did not pass, with its step-result. */
  private async ended(
    run: Run,
    step: string,
    outcome: 'failed' | 'expired',
    reason: NotAcceptedCode
  ): Promise<StepEnd> {
    await this.result(run, step, outcome, reason)
    return { outcome, reason }
  }

  private left(run: Run): number {
    return run.expiresAt - Date.now()
  }

  private async step(run: Run, step: string, name: string, method: AuthenticationMethod): Promise<StepEnd> {
    switch (method.type) {
      case 'credential':
        return this.credentialStep(run, step, name, method as CredentialMethod)
      case 'email':
        return this.emailStep(run, step, name)
      case 'document':
        return this.documentStep(run, step, name)
      case 'face-match':
        return this.faceStep(run, step, name, method)
      case 'authenticator-app':
        return this.codeStep(run, step, name)
      case 'passkey':
        return this.passkeyStep(run, step, name)
    }
  }

  // ---- credential: present-proof under the flow id (IDENT-RES-008/012/018) -------------------------------------------

  private async credentialStep(run: Run, step: string, name: string, method: CredentialMethod): Promise<StepEnd> {
    await this.send(run, { step, method: name, type: 'credential' })
    const requested: RequestedCredential = {
      jsonSchemaCredentialId: method.credential.jsonSchemaCredentialId,
      ...(method.attributes ? { attributes: method.attributes } : {}),
    }
    const { proofExchangeId } = await this.ports.client.requestPresentation(
      run.options.connectionId,
      [requested],
      true,
      run.flowId
    )
    const waited = await this.wait(
      run,
      () => this.ports.awaitPresentation(proofExchangeId, Math.max(0, this.left(run))),
      this.left(run)
    )
    if ('stop' in waited) return waited.stop
    if ('timeout' in waited) return this.ended(run, step, 'expired', 'step-expired')
    const record = waited.value
    const ok = record.verified && record.state !== 'declined' && record.state !== 'abandoned'
    if (!ok) {
      // a person who declines: the wallet's problem report comes first, then the close of the flow (IDENT-RES-019)
      if (record.state === 'declined' || /declin/i.test(record.errorMessage ?? '')) {
        const closed = await this.wait(run, () => run.closed, 5_000)
        if ('stop' in closed) return closed.stop
        if ('value' in closed) return { outcome: 'closed', closed: closed.value }
      }
      if (record.errorMessage === 'timeout') return this.ended(run, step, 'expired', 'step-expired')
      return this.ended(run, step, 'failed', 'not-valid')
    }
    const facts = await this.ports.credentialFacts(run.options.peerId, record, method, run.options.userAgentVerified)
    if (typeof facts === 'string') return this.ended(run, step, 'failed', facts)
    // a badge this agent issued from the directory finds the entry it was issued from (IDENT-AUTH-004)
    const entryId = await this.ports.entryOfCredential?.(facts)
    await this.result(run, step, 'passed')
    return {
      outcome: 'passed',
      found: entryId ? { kind: 'entry', entryId, facts } : { kind: 'credential', facts },
    }
  }

  // ---- email: the address, then a code (IDENT-AUTH-006 to 009, FLOW-SIGNIN-010/011) ----------------------------------

  private async emailStep(run: Run, step: string, name: string): Promise<StepEnd> {
    await this.send(run, { step, method: name, type: 'email', ask: 'address' })
    const given = await this.answer(run, step, Math.min(this.timings.emailMs, this.left(run)))
    if ('stop' in given) return given.stop
    if ('timeout' in given) return this.ended(run, step, 'expired', 'step-expired')
    const address = String(given.value?.address ?? '')
      .trim()
      .toLowerCase()
    if (!given.value || !isEmailAddress(address)) return this.ended(run, step, 'failed', 'step-failed')
    const locale = given.value.locale
    // the same answer whether or not an entry holds the address; a code only to one that does (IDENT-AUTH-006)
    const entry = this.ports.directory?.byEmail(address)
    let codeHash: string | undefined
    let sentAt = Date.now()
    let expiresAt = sentAt + this.timings.emailMs
    let tries = CODE_TRIES
    let newCodes = NEW_CODES
    const sendCode = () => {
      codeHash = undefined
      sentAt = Date.now()
      expiresAt = sentAt + this.timings.emailMs
      if (!entry) return
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      codeHash = this.ports.blindIndex(`authenticate-email\n${run.threadId}\n${step}\n${code}`)
      void this.mail(address, code, locale, run.flowId)
    }
    sendCode()
    const prompt = (extra: Partial<AuthenticateStepBody> = {}): AuthenticateStepBody => ({
      step,
      method: name,
      type: 'email',
      ask: 'code',
      expiresAt: new Date(expiresAt).toISOString(),
      triesLeft: tries,
      newCodesLeft: newCodes,
      ...extra,
    })
    await this.send(run, prompt())
    for (;;) {
      const answered = await this.answer(run, step, Math.min(expiresAt - Date.now(), this.left(run)))
      if ('stop' in answered) return answered.stop
      if ('timeout' in answered) return this.ended(run, step, 'expired', 'step-expired')
      const answer = answered.value
      if (!answer) return this.ended(run, step, 'failed', 'step-failed')
      if (answer.newCode) {
        // refused within thirty seconds of the last code and after three, with why (FLOW-SIGNIN-011); the step's
        // `reason` carries why, as the library writes it
        if (newCodes <= 0) {
          await this.send(run, prompt({ error: 'new-code-refused', reason: 'no-more' }))
          continue
        }
        if (Date.now() - sentAt < this.timings.newCodeAfterMs) {
          await this.send(run, prompt({ error: 'new-code-refused', reason: 'too-soon' }))
          continue
        }
        newCodes -= 1
        sendCode()
        await this.send(run, prompt())
        continue
      }
      if (Date.now() > expiresAt) return this.ended(run, step, 'expired', 'step-expired')
      const code = String(answer.code ?? '')
      if (codeHash && /^\d{6}$/.test(code)) {
        const a = Buffer.from(codeHash)
        const b = Buffer.from(this.ports.blindIndex(`authenticate-email\n${run.threadId}\n${step}\n${code}`))
        if (a.length === b.length && timingSafeEqual(a, b)) {
          codeHash = undefined
          await this.result(run, step, 'passed')
          // what a right code proved: the address, recorded once the authentication is accepted (IDENT-AUTH-009)
          return {
            outcome: 'passed',
            found: { kind: 'entry', entryId: (entry as { id: string }).id },
            evidence: { kind: 'email', entry: EMAIL_ENTRY, values: { address }, requestRef: run.threadId },
          }
        }
      }
      tries -= 1
      if (tries <= 0) return this.ended(run, step, 'failed', 'step-failed')
      await this.send(run, prompt({ error: 'wrong-code' }))
    }
  }

  /**
   * The email that carries a code (IDENT-AUTH-006, INTX-AUTH-020): in the language of the phone's locale, each sentence
   * translated with the code replaced by a mark, so that no model reads it. A failure to send changes no answer.
   */
  private async mail(address: string, code: string, locale: string | undefined, flowId: string): Promise<void> {
    const mailer = this.ports.mailer
    if (!mailer) {
      this.logger.error(
        { flowId },
        'an email step reached an agent with no SMTP server: no code is sent (PLAT-MAIL-001)'
      )
      return
    }
    const agent = this.pack.metadata?.displayName ?? 'The agent'
    const MARK = '######'
    const minutes = Math.round(EMAIL_STEP_MS / 60_000)
    const say = async (text: string, keep: string[]) =>
      this.ports.renderIn ? await this.ports.renderIn({ text, keep }, locale).catch(() => text) : text
    try {
      const subject = await say(`Your code for ${agent}`, [agent])
      const lines = [
        (await say(`Your code for ${agent} is ${MARK}.`, [agent, MARK])).replace(MARK, code),
        await say(`It is valid for ${minutes} minutes. Type it on your phone, where ${agent} asks for it.`, [agent]),
        await say('If you did not ask for it, ignore this email.', []),
      ]
      await mailer.send({ to: address, subject, text: `${lines[0]}\n\n${lines[1]}\n\n${lines[2]}\n` })
      this.logger.info({ flowId }, 'the code of an email step was sent')
    } catch (error) {
      this.logger.error({ err: error, flowId }, 'the code of an email step could not be sent')
    }
  }

  // ---- document: the chip, matched to one entry (IDENT-DIR-003, IDENT-AUTH-017) --------------------------------------

  private async documentStep(run: Run, step: string, name: string): Promise<StepEnd> {
    await this.send(run, { step, method: name, type: 'document' })
    const { id: threadId } = await this.ports.client.requestEmrtd(run.options.connectionId, run.flowId)
    const key = `${run.options.connectionId}|${threadId}`
    const deferred = new Deferred<{ received: boolean; data: Record<string, unknown> }>()
    this.documents.set(key, deferred)
    const waited = await this.wait(run, () => deferred.promise, this.left(run))
    this.documents.delete(key)
    if ('stop' in waited) return waited.stop
    if ('timeout' in waited) return this.ended(run, step, 'expired', 'step-expired')
    if (!waited.value.received) {
      // the person refused, or the phone gave up on the chip: a refusal closes the flow, a failure fails the step
      if (/refus/.test(String(waited.value.data.reason ?? ''))) {
        const closed = await this.wait(run, () => run.closed, 5_000)
        if ('stop' in closed) return closed.stop
      }
      return this.ended(run, step, 'failed', 'step-failed')
    }
    const read = await readDocument(waited.value.data.dataGroups, nowIso().slice(0, 10))
    if (!read.ok) {
      this.logger.warn({ connectionId: run.options.connectionId, reason: read.reason }, 'document read not accepted')
      return this.ended(run, step, 'failed', 'step-failed')
    }
    const directory = this.ports.directory
    const { ids } = directory?.matchDocument({
      lastName: read.values.lastName ?? '',
      firstName: read.values.firstName ?? '',
      dateOfBirth: read.values.dateOfBirth ?? '',
      nationality: read.values.nationality ?? '',
    }) ?? { ids: [] }
    // exactly one entry, or nobody: the reason is logged, never a value (IDENT-DIR-003)
    if (ids.length !== 1) {
      this.logger.info(
        { connectionId: run.options.connectionId, entries: ids.length },
        'a document read matches no single entry'
      )
      return this.ended(run, step, 'failed', 'no-match')
    }
    await this.result(run, step, 'passed')
    return {
      outcome: 'passed',
      found: { kind: 'entry', entryId: ids[0] },
      evidence: { kind: 'document', entry: DOCUMENT_ENTRY, values: read.values, requestRef: threadId },
      portrait: read.values.portrait,
    }
  }

  // ---- face-match: the consent, then the call, or a consent declined (IDENT-AUTH-010/011, FLOW-SIGNIN-012, D152) ----

  private async faceStep(run: Run, step: string, name: string, method: AuthenticationMethod): Promise<StepEnd> {
    const agent = this.pack.metadata?.displayName ?? 'The agent'
    await this.send(run, {
      step,
      method: name,
      type: 'face-match',
      ask: 'consent',
      text: `${agent} compares your live face with your reference picture, to confirm it's you. Nothing of your face is kept.`,
    })
    const consent = await this.answer(run, step, this.left(run))
    if ('stop' in consent) return consent.stop
    if ('timeout' in consent) return this.ended(run, step, 'expired', 'step-expired')
    if (consent.value?.consent === false) {
      // declined: no call, nothing recorded, no refusal; the step ends `consent-declined` and the person chooses
      // another combination on the same request (D152, IDENT-AUTH-011, FLOW-SIGNIN-012)
      await this.result(run, step, 'failed', CONSENT_DECLINED)
      return { outcome: 'consent-declined' }
    }
    if (consent.value?.consent !== true) return this.ended(run, step, 'failed', 'step-failed')
    const reference = await this.referenceOf(run, method)
    if (!reference) return this.ended(run, step, 'failed', 'no-match')
    const faces = this.ports.faceSteps
    if (!faces?.available) return this.ended(run, step, 'failed', 'step-failed')
    let outcome: Promise<FaceOutcome>
    try {
      ;({ outcome } = await faces.start({
        connectionId: run.options.connectionId,
        flowId: run.flowId,
        reference,
        expiresAt: new Date(run.expiresAt).toISOString(),
        description: `Face check for ${agent}`,
      }))
    } catch (error) {
      this.logger.error(
        { err: error, flowId: run.flowId },
        'the call of a face step could not be offered: the DIDComm agent must take parentThreadId on calls (CC-VSA-006)'
      )
      return this.ended(run, step, 'failed', 'step-failed')
    }
    const waited = await this.wait(run, () => outcome, this.left(run))
    if ('stop' in waited) return waited.stop
    if ('timeout' in waited || waited.value === 'expired') return this.ended(run, step, 'expired', 'step-expired')
    if (waited.value !== 'passed') return this.ended(run, step, 'failed', 'step-failed')
    await this.result(run, step, 'passed')
    // the audit fields only: no image, no template, no score (IDENT-AUTH-011)
    return {
      outcome: 'passed',
      evidence: {
        kind: 'face-match',
        entry: FACE_MATCH_ENTRY,
        values: {},
        requestRef: run.flowId,
        reference: reference.source,
      },
    }
  }

  /** The reference picture, in the method's order (D131): a passport read in this flow, the entry's photo. */
  private async referenceOf(
    run: Run,
    method: AuthenticationMethod
  ): Promise<{ bytes: Buffer; mimeType: string; source: string } | undefined> {
    for (const source of method.reference ?? []) {
      if (source === 'document' && run.portrait) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(run.portrait)
        if (match) return { bytes: Buffer.from(match[2], 'base64'), mimeType: match[1], source }
      }
      if (source === 'directory') {
        const entryId = await this.entryIdOf(run)
        const photo = entryId ? this.ports.directory?.photoOf?.(entryId) : undefined
        if (photo) return { ...photo, source }
      }
    }
    return undefined
  }

  // ---- authenticator app: a TOTP code of the secret enrolled (IDENT-AUTH-012) -----------------------------------------

  private async codeStep(run: Run, step: string, name: string): Promise<StepEnd> {
    let tries = CODE_TRIES
    // it confirms the Principal the identifying methods found, or that of the connection for a re-authentication
    const principal = await this.subjectOf(run)
    const secret = principal ? (await this.ports.enrolments?.get(principal.id))?.['authenticator-app'] : undefined
    await this.send(run, { step, method: name, type: 'authenticator-app', ask: 'code', triesLeft: tries })
    for (;;) {
      const answered = await this.answer(run, step, this.left(run))
      if ('stop' in answered) return answered.stop
      if ('timeout' in answered) return this.ended(run, step, 'expired', 'step-expired')
      if (!answered.value) return this.ended(run, step, 'failed', 'step-failed')
      const code = String(answered.value.code ?? '')
      if (principal && secret) {
        const counter = matchTotp(base32Decode(secret.secret), code, Date.now(), secret.lastCounter)
        if (counter !== undefined) {
          await this.ports.enrolments?.usedCode(principal.id, counter)
          await this.result(run, step, 'passed')
          return { outcome: 'passed', ...(run.found ? {} : { found: { kind: 'principal', principal } }) }
        }
      }
      tries -= 1
      if (tries <= 0) return this.ended(run, step, 'failed', 'step-failed')
      await this.send(run, {
        step,
        method: name,
        type: 'authenticator-app',
        ask: 'code',
        triesLeft: tries,
        error: 'wrong-code',
      })
    }
  }

  // ---- passkey: an assertion of the key enrolled (IDENT-AUTH-013, FLOW-SIGNIN-013) ------------------------------------

  private async passkeyStep(run: Run, step: string, name: string): Promise<StepEnd> {
    const challenge = randomBytes(32).toString('base64url')
    await this.send(run, { step, method: name, type: 'passkey', ask: 'assertion', challenge, rpId: this.ports.rpId })
    const answered = await this.answer(run, step, this.left(run))
    if ('stop' in answered) return answered.stop
    if ('timeout' in answered) return this.ended(run, step, 'expired', 'step-expired')
    const assertion = answered.value?.assertion
    if (!assertion) return this.ended(run, step, 'failed', 'step-failed')
    const principalId = await this.ports.enrolments?.principalOfPasskey(assertion.id)
    const principal = principalId ? await this.ports.principals.get(principalId) : undefined
    const passkey = principal ? (await this.ports.enrolments?.get(principal.id))?.passkey : undefined
    if (!principal || !passkey) return this.ended(run, step, 'failed', 'no-match')
    const checked = verifyAssertion({ passkey, assertion, challenge, rpId: this.ports.rpId })
    if (!checked.ok) {
      this.logger.warn(
        { connectionId: run.options.connectionId, reason: checked.reason },
        'a passkey assertion is refused'
      )
      return this.ended(run, step, 'failed', 'step-failed')
    }
    await this.ports.enrolments?.usedPasskey(principal.id, checked.signCount)
    await this.result(run, step, 'passed')
    return { outcome: 'passed', found: { kind: 'principal', principal } }
  }

  // ---- the identity (IDENT-AUTH-002/003/004, IDENT-RES-002) ---------------------------------------------------------

  /** The entry the identity found so far is, or the connection's for a re-authentication. */
  private async entryIdOf(run: Run): Promise<string | undefined> {
    const found = run.found
    if (found?.kind === 'entry') return found.entryId
    if (found?.kind === 'principal') return found.principal.directoryEntryId
    if (found?.kind === 'credential') return found.facts.directoryEntryId
    return run.options.bound?.directoryEntryId
  }

  /** The Principal of the identity found so far: an entry's, a passkey's, a credential's; else the connection's. */
  private async subjectOf(run: Run): Promise<Principal | undefined> {
    const found = run.found
    if (!found) return run.options.bound?.identityCredentialRef ? run.options.bound : undefined
    if (found.kind === 'principal') return found.principal
    if (found.kind === 'credential') return this.ports.principals.findByActor(found.facts.actorIdentity)
    const home = await this.ports.home()
    return home ? this.ports.principals.findByActor(directoryActorOf(home.key, found.entryId)) : undefined
  }

  /** The verified facts of what the steps found, or why it identifies nobody. */
  private async factsOf(run: Run, combination: string[]): Promise<VerifiedFacts | NotAcceptedCode> {
    const record: AuthenticationRecord = {
      at: nowIso(),
      purpose: run.options.purpose,
      combination: [...combination],
      types: combination.map((n) => run.methods[n].type),
      steps: run.steps,
    }
    const found = run.found
    const evidence = run.evidence
    if (!found) {
      // a re-authentication by confirming methods only confirms the Principal of the connection (D127)
      const bound = run.options.bound
      if (!bound?.identityCredentialRef) return 'no-match'
      return this.factsOfPrincipal(bound, run, record)
    }
    if (found.kind === 'credential') return { ...found.facts, moreEvidence: evidence, authentication: record }
    if (found.kind === 'principal') return this.factsOfPrincipal(found.principal, run, record)
    return this.entryFacts(found.entryId, found.facts, evidence, record, run.options.userAgentVerified)
  }

  /**
   * The facts of a person of the user directory (IDENT-RES-002, IDENT-AUTH-003): keyed by the home organization, the
   * directory and the entry, whichever methods identified them, with the home organization as backing identity. A
   * credential that found the entry gives its claims and its evidence, and the key it had before (D59).
   */
  private async entryFacts(
    entryId: string,
    credential: VerifiedFacts | undefined,
    evidence: EvidenceInput[],
    record: AuthenticationRecord,
    userAgentVerified: boolean
  ): Promise<VerifiedFacts | 'no-match'> {
    const home = await this.ports.home()
    const entry = this.ports.directory?.entry(entryId)
    if (!home || !entry) {
      this.logger.warn(
        { home: !!home, entry: !!entry },
        'an entry was found, and the agent has no verified organization or no such entry any more: nobody is identified'
      )
      return 'no-match'
    }
    return {
      connectionType: 'verifiable-user-agent',
      actorIdentity: directoryActorOf(home.key, entry.id),
      backingIdentity: { kind: 'org', id: home.key, ...(home.name ? { name: home.name } : {}) },
      organization: home,
      directoryEntryId: entry.id,
      // a Principal keyed by its badge before keeps its conversations under the entry (D59, IDENT-AUTH-003)
      ...(credential ? { legacyActorIdentity: credential.actorIdentity } : {}),
      claims: { ...(credential?.claims ?? {}), userName: nameOf(entry) },
      userAgentVerified,
      identityCredentialRef: credential?.identityCredentialRef ?? `entry:${entry.id}`,
      ...(credential?.evidence ? { evidence: credential.evidence } : {}),
      moreEvidence: evidence,
      authentication: { ...record, directoryEntryId: entry.id },
    }
  }

  /**
   * The identity of a credential presented outside a flow (a wallet that takes no flows, IDENT-AUTH-005): the entry this
   * agent issued it from when there is one, else the person of the credential (IDENT-AUTH-004).
   */
  public async credentialIdentity(
    facts: VerifiedFacts,
    userAgentVerified: boolean,
    purpose: AuthenticatePurpose
  ): Promise<VerifiedFacts> {
    const record: AuthenticationRecord = {
      at: nowIso(),
      purpose,
      combination: [],
      types: ['credential'],
      steps: [{ method: 'credential', type: 'credential', outcome: 'passed' }],
    }
    const entryId = await this.ports.entryOfCredential?.(facts)
    const byEntry = entryId ? await this.entryFacts(entryId, facts, [], record, userAgentVerified) : undefined
    return byEntry && typeof byEntry !== 'string' ? byEntry : { ...facts, authentication: record }
  }

  private async factsOfPrincipal(principal: Principal, run: Run, record: AuthenticationRecord): Promise<VerifiedFacts> {
    const organization =
      principal.backingRelation === 'home'
        ? await this.ports.home()
        : ((await this.ports.principals.organizationOf?.(principal)) ?? null)
    return {
      connectionType: 'verifiable-user-agent',
      actorIdentity: principal.actorIdentity,
      backingIdentity: principal.backingIdentity,
      organization,
      ...(principal.directoryEntryId ? { directoryEntryId: principal.directoryEntryId } : {}),
      claims: { ...principal.identityAttributes },
      userAgentVerified: run.options.userAgentVerified,
      identityCredentialRef: principal.identityCredentialRef ?? `principal:${principal.id}`,
      moreEvidence: run.evidence,
      authentication: {
        ...record,
        ...(principal.directoryEntryId ? { directoryEntryId: principal.directoryEntryId } : {}),
      },
    }
  }
}

/** Whether facts identify the Principal of a connection: under its key, or under the key it had before (D59). */
export function sameActor(principal: Pick<Principal, 'actorIdentity'>, facts: VerifiedFacts): boolean {
  return facts.actorIdentity === principal.actorIdentity || facts.legacyActorIdentity === principal.actorIdentity
}
