/**
 * The re-authentication a tool's step-up asks before the call (ayni-spec D127, D128; IDENT-AUTH-015, TOOL-CAT-010,
 * TOOL-CALL-001, INTX-AUTH-001/004/006, FLOW-SIGNIN-006; flow profile §6.14).
 *
 * The tool names one set of the enabled methods (`stepUp.authentication.methods`). Before each run the agent asks it on
 * the person's phone, in an `authenticate` flow of purpose `step-up` on the identified connection, whose text names the
 * action and whose origin is the session the call was asked from; every method must find or confirm the Principal of the
 * connection (`another-identity` otherwise). It is not asked again while an authentication of the Principal that held
 * every method of the set completed within `maxAgeMinutes` (0 by default: before each run). Only the outcome reaches
 * the conversation and the model; the UIs get the routed status (`ayni.capability.routed`, kind `authentication`).
 */
import type { StepUpAuthentication } from '../config/packTypes.js'
import type { Principal, Session } from './types.js'

/** What a step-up's re-authentication ended in. */
export type ReauthenticationOutcome =
  /** every method of the set passed and found the Principal of the connection */
  | 'completed'
  /** the person cancelled it on the phone */
  | 'declined'
  /** nobody chose, or a step was not answered, in time */
  | 'expired'
  /** a step did not pass */
  | 'failed'
  /** a method found another person than the one of the connection (IDENT-RES-014) */
  | 'another-identity'
  /** the person is not identified: a re-authentication confirms an identified Principal (D127) */
  | 'not-identified'
  /** another authentication already waits on the phone: the DIDComm agent keeps one at a time (FLOW-SIGNIN-001) */
  | 'busy'
  /** no phone is connected, or it cannot do the methods of the set (a wallet that takes no flows, no calls) */
  | 'unavailable'

/** What the tool gate asks of the DIDComm side. */
export type Reauthenticate = (input: {
  principal: Principal
  /** the methods of the set, by their names in `identity.authentication.methods` */
  methods: string[]
  /** what the action is, as the phone shows it (flow profile §6.14) */
  text: string
  /** the session the call was asked from: the flow's origin, none outside a conversation of the AG-UI channel */
  origin?: Session
  /** the flow is open on the phone: its id and its expiry, for the routed status of the origin */
  onOpened?: (flowId: string, expiresAt: string) => void
}) => Promise<ReauthenticationOutcome>

/**
 * Whether an authentication of the Principal that held every method of the set completed within the step-up's
 * `maxAgeMinutes` (D127): then it is not asked again. 0, the default, asks before each run.
 */
export function recentlyAuthenticated(
  principal: Pick<Principal, 'lastAuthentication'>,
  stepUp: StepUpAuthentication,
  now = Date.now()
): boolean {
  const minutes = stepUp.maxAgeMinutes ?? 0
  const last = principal.lastAuthentication
  if (minutes <= 0 || !last) return false
  if (now - Date.parse(last.at) > minutes * 60_000) return false
  return stepUp.methods.every(
    (name) =>
      last.combination.includes(name) && last.steps.some((step) => step.method === name && step.outcome === 'passed')
  )
}

/** The words of the phone's sheet for a step-up: what the action is (flow profile §6.14). */
export function stepUpText(title: string): string {
  return `Confirm it's you: ${title}`
}

/** What the UIs are told of a re-authentication that ended (`ayni.capability.routed`, PROF-MAP-003). */
export function routedStatusOf(outcome: ReauthenticationOutcome): 'completed' | 'failed' | 'expired' | 'unavailable' {
  switch (outcome) {
    case 'completed':
      return 'completed'
    case 'expired':
      return 'expired'
    case 'declined':
    case 'failed':
    case 'another-identity':
      return 'failed'
    default:
      return 'unavailable'
  }
}

/** The words of the origin for a re-authentication that could not be asked (`message` of the routed status). */
export function unavailableMessage(outcome: ReauthenticationOutcome): string | undefined {
  switch (outcome) {
    case 'not-identified':
      return 'This action needs you to confirm who you are, and you are not authenticated with this service.'
    case 'busy':
      return 'Another request to confirm who you are is waiting on your phone.'
    case 'unavailable':
      return 'This action needs you to confirm who you are on your phone, which cannot do it now.'
    default:
      return undefined
  }
}

/**
 * What the model reads of a call a re-authentication stopped (TOOL-CALL-001, INTX-AUTH-003): the step and its outcome,
 * nothing of its mechanics (no method, no address, no code).
 */
export function stepUpForModel(title: string, outcome: Exclude<ReauthenticationOutcome, 'completed'>): string {
  const did = `${title} did not run: it needs the person to confirm who they are on their phone first`
  switch (outcome) {
    case 'declined':
      return `${did}, and they declined. Do not try it again unless they ask.`
    case 'expired':
      return `${did}, and they did not answer in time. They can ask again.`
    case 'failed':
      return `${did}, and the confirmation did not pass. They can ask again.`
    case 'another-identity':
      return `${did}, and the confirmation found another person than the one of this conversation. Do not try it again.`
    case 'not-identified':
      return `${did}, and they are not authenticated with this agent. They may authenticate first, then ask again.`
    case 'busy':
      return `${did}, and another request to confirm who they are is already waiting on their phone. They answer it, then ask again.`
    default:
      return `${did}, and their phone cannot be asked now (not connected, or it cannot do what this action needs).`
  }
}
