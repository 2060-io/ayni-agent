/**
 * Credential issuance (D68, D70; INTX-ISSUE-001..014). The agent issues what the profiles of the agent-pack
 * describe, and every claim comes from a source the profile names: the model supplies no value, no recipient
 * and no connection. `requirements` tells, without any value, what a peer may receive and what is missing;
 * `issue` resolves the claims in code for the Principal of the session, issues nothing when one cannot be
 * resolved, and leaves a record built as evidence is.
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { AUTHENTICATION_ENTRY } from '../config/pack.js'
import type { ActionPolicy, AgentPack, ClaimSource, IssuanceProfile } from '../config/packTypes.js'
import { nowIso } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { EvidenceService } from './evidence.js'
import type { EvidenceRecord, Principal, Session } from './types.js'

/** The entry under which the issuances of a profile are recorded: never the name of a catalog entry. */
export const issuanceEntry = (profile: string) => `issuance:${profile}`

export type ClaimStatus = 'available' | 'missing' | 'expired' | 'not-revealed' | 'unavailable'

/** One action of a closed list that obtains what is missing (INTX-ISSUE-006). */
export type ClaimAction = { type: 'request_presentation'; entry: string } | { type: 'none'; note: string }

export interface ClaimRequirement {
  name: string
  status: ClaimStatus
  action?: ClaimAction
}

/** What a peer may receive, and what is missing: statuses and actions, never a value (INTX-ISSUE-005). */
export interface CredentialRequirements {
  credential: string
  label?: string
  state: 'held' | 'ready' | 'incomplete'
  trigger: NonNullable<IssuanceProfile['trigger']>
  claims: ClaimRequirement[]
}

export type IssuanceOutcome =
  | 'issued'
  | 'held'
  | 'incomplete'
  | 'not-offered'
  | 'challenge-failed'
  | 'declined'
  | 'unavailable'
  | 'not-ready'
  | 'failed'

export interface IssuanceDeps {
  /** offers the credential on the connection and waits for the wallet: the exchange it ended in */
  offer(input: {
    connectionId: string
    credentialDefinitionId: string
    claims: Record<string, string>
    title: string
  }): Promise<{ outcome: 'issued' | 'declined' | 'failed'; exchangeId?: string }>
  /** runs the challenge of the profile and tells whether it passed */
  challenge(
    principal: Principal,
    session: Session,
    policy: NonNullable<ActionPolicy['authChallenge']>,
    purpose: string
  ): Promise<boolean>
  /**
   * the credential definition of this agent for a schema, found or created; undefined while it cannot be
   * established (INTX-ISSUE-017)
   */
  definitionFor?(jsonSchemaCredentialId: string): Promise<string | undefined>
}

interface Resolution {
  status: ClaimStatus
  value?: string
  evidenceRef?: string
  action?: ClaimAction
}

const today = () => nowIso().slice(0, 10)

/** The key the identifiers of subjects are derived with: its own key, from the secret of the deployment. */
export function subjectIdKey(deploymentSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', deploymentSecret, Buffer.alloc(0), 'ayni-agent/issuance/subject-id', 32))
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * An identifier of the subject under a profile (INTX-ISSUE-016): 80 bits of a keyed digest of the profile
 * and the Principal, as 16 characters without the letters that read as digits. The same Principal has the
 * same value under the same profile at every issuance; nothing of the Principal can be read from it, and
 * the values of two profiles cannot be linked without the key.
 */
export function subjectId(key: Buffer, profile: string, principalId: string): string {
  const digest = createHmac('sha256', key).update(`${profile}\u0000${principalId}`).digest()
  let bits = 0n
  for (const byte of digest.subarray(0, 10)) bits = (bits << 8n) | BigInt(byte)
  let out = ''
  for (let shift = 75n; shift >= 0n; shift -= 5n) out += CROCKFORD[Number((bits >> shift) & 31n)]
  return out
}

/** The profiles a Principal may receive: a person, of a role the profile names when it names some. */
export function offeredProfiles(pack: AgentPack, principal: Principal): [string, IssuanceProfile][] {
  if (principal.connectionType !== 'verifiable-user-agent') return []
  return Object.entries(pack.issuance ?? {}).filter(
    ([, profile]) => !profile.roles?.length || profile.roles.some((r) => principal.roles.includes(r))
  )
}

export class IssuanceService {
  /** one issuance at a time for a Principal and a profile */
  private readonly running = new Set<string>()

  public constructor(
    private readonly pack: AgentPack,
    private readonly evidence: EvidenceService,
    private readonly deps: IssuanceDeps,
    private readonly logger: Logger,
    /** derives the identifiers of subjects (INTX-ISSUE-016); see `subjectIdKey` */
    private readonly idKey: Buffer
  ) {}

  /** The profiles a Principal may receive: a person, of a role the profile names when it names some. */
  public offered(principal: Principal): [string, IssuanceProfile][] {
    return offeredProfiles(this.pack, principal)
  }

  /** What the peer may receive and what is missing, without any value (INTX-ISSUE-005/006). */
  public async requirements(principal: Principal, only?: string): Promise<CredentialRequirements[]> {
    const out: CredentialRequirements[] = []
    for (const [name, profile] of this.offered(principal)) {
      if (only && name !== only) continue
      const held = !!(await this.evidence.latest(principal.id, issuanceEntry(name)))
      const claims: ClaimRequirement[] = []
      for (const [claim, source] of Object.entries(profile.claims)) {
        const { status, action } = await this.resolve(principal, name, profile, source)
        claims.push({ name: claim, status, ...(action ? { action } : {}) })
      }
      out.push({
        credential: name,
        ...(profile.label ? { label: profile.label } : {}),
        state: held ? 'held' : claims.every((c) => c.status === 'available') ? 'ready' : 'incomplete',
        trigger: profile.trigger ?? 'model',
        claims,
      })
    }
    return out
  }

  /**
   * Issues a credential of a profile to the Principal of the session (INTX-ISSUE-003/004/008..010). Nothing
   * is issued when a claim cannot be resolved, when the profile is not started this way, or when the
   * credential is already held.
   */
  public async issue(
    principal: Principal,
    session: Session,
    name: string,
    by: 'model' | 'person' | 'agent'
  ): Promise<{ outcome: IssuanceOutcome; requirements?: CredentialRequirements }> {
    const profile = this.offered(principal).find(([n]) => n === name)?.[1]
    if (!profile) return { outcome: 'not-offered' }
    const trigger = profile.trigger ?? 'model'
    const allowed = { model: trigger === 'model', person: trigger === 'request', agent: trigger === 'automatic' }[by]
    if (!allowed) return { outcome: 'not-offered' }
    const connectionId = principal.capabilityChannelId
    if (!connectionId) return { outcome: 'unavailable' }
    const key = `${principal.id}|${name}`
    if (this.running.has(key)) return { outcome: 'unavailable' }
    this.running.add(key)
    try {
      const [requirements] = await this.requirements(principal, name)
      if (requirements.state === 'held') return { outcome: 'held', requirements }
      if (requirements.state !== 'ready') return { outcome: 'incomplete', requirements }
      const label = profile.label ?? name
      // a profile that names a schema issues under the definition of this agent for it, or not at all
      const credentialDefinitionId = await this.definitionOf(profile)
      if (!credentialDefinitionId) return { outcome: 'not-ready' }
      if (profile.authChallenge && !(await this.deps.challenge(principal, session, profile.authChallenge, label)))
        return { outcome: 'challenge-failed' }
      // the claims are resolved now, by the code, from the sources the profile names and nothing else
      const claims: Record<string, string> = {}
      const evidenceRefs = new Set<string>()
      for (const [claim, source] of Object.entries(profile.claims)) {
        const resolved = await this.resolve(principal, name, profile, source)
        if (resolved.status !== 'available' || resolved.value === undefined) {
          return { outcome: 'incomplete', requirements: (await this.requirements(principal, name))[0] }
        }
        claims[claim] = resolved.value
        if (resolved.evidenceRef) evidenceRefs.add(resolved.evidenceRef)
      }
      const offer = await this.deps.offer({
        connectionId,
        credentialDefinitionId,
        claims,
        title: label,
      })
      if (offer.outcome !== 'issued') return { outcome: offer.outcome }
      // one record per issuance: audit fields always, the claims only when the profile keeps them (INTX-ISSUE-014)
      await this.evidence.record(
        principal,
        {
          kind: 'issuance',
          entry: issuanceEntry(name),
          credentialDefinitionId,
          values: claims,
          requestRef: offer.exchangeId,
          connectionRef: connectionId,
          evidenceRefs: [...evidenceRefs],
        },
        profile.record?.storeClaims
          ? { store: { attributes: Object.keys(claims), retention: profile.record.retention } }
          : {}
      )
      this.logger.info({ principalId: principal.id, profile: name, by }, 'credential issued')
      return { outcome: 'issued' }
    } finally {
      this.running.delete(key)
    }
  }

  /** The profiles the agent issues by itself, as soon as every claim resolves (trigger `automatic`). */
  public async automatic(principal: Principal, session: Session): Promise<void> {
    for (const [name, profile] of this.offered(principal)) {
      if (profile.trigger !== 'automatic') continue
      const [requirements] = await this.requirements(principal, name)
      if (requirements.state !== 'ready') continue
      const { outcome } = await this.issue(principal, session, name, 'agent')
      this.logger.info({ principalId: principal.id, profile: name, outcome }, 'automatic issuance')
    }
  }

  private async resolve(
    principal: Principal,
    name: string,
    profile: IssuanceProfile,
    source: ClaimSource
  ): Promise<Resolution> {
    if (source.from === 'computed') {
      if (source.fn === 'subjectId') return { status: 'available', value: subjectId(this.idKey, name, principal.id) }
      if (source.fn === 'today') return { status: 'available', value: today() }
      if (source.fn === 'now') return { status: 'available', value: nowIso() }
      if (source.fn === 'constant') return { status: 'available', value: source.value ?? '' }
      const date = new Date(Date.now() + (source.days ?? 0) * 86_400_000).toISOString().slice(0, 10)
      return { status: 'available', value: date }
    }
    const action = this.actionFor(principal, source.entry)
    const record = await this.evidence.latest(principal.id, source.entry)
    if (!record) return { status: 'missing', action }
    if (record.unrevealed.includes(source.attribute)) return { status: 'not-revealed', action }
    if (this.tooOld(record, profile) || record.state !== 'active') return { status: 'expired', action }
    const values = await this.evidence.values(principal.id, source.entry)
    const value = values?.[source.attribute]
    if (value === undefined) {
      // verified, but the value is not kept: nothing the person can do about it
      return { status: 'unavailable', action: { type: 'none', note: 'this agent does not keep the value' } }
    }
    return { status: 'available', value, evidenceRef: record.id }
  }

  /** The credential definition a profile issues under: the one it names, or the agent's for the schema it names. */
  private async definitionOf(profile: IssuanceProfile): Promise<string | undefined> {
    const { credentialDefinitionId, jsonSchemaCredentialId } = profile.credential
    if (credentialDefinitionId) return credentialDefinitionId
    if (!jsonSchemaCredentialId || !this.deps.definitionFor) return undefined
    return this.deps.definitionFor(jsonSchemaCredentialId)
  }

  /** Establishes the definitions of the profiles that name a schema, ahead of the first issuance. */
  public async prepare(): Promise<void> {
    for (const [name, profile] of Object.entries(this.pack.issuance ?? {})) {
      if (profile.credential.credentialDefinitionId) continue
      const id = await this.definitionOf(profile)
      this.logger.info({ profile: name, credentialDefinitionId: id ?? null }, 'issuance profile by schema')
    }
  }

  private tooOld(record: EvidenceRecord, profile: IssuanceProfile): boolean {
    if (record.expiresAt && record.expiresAt <= nowIso()) return true
    const minutes = profile.evidenceMaxAgeMinutes
    return minutes !== undefined && Date.now() - Date.parse(record.verifiedAt) > minutes * 60_000
  }

  /** What obtains the evidence of an entry: the request tool when the entry is asked on demand, else nothing to do. */
  private actionFor(principal: Principal, entry: string): ClaimAction {
    if (entry === AUTHENTICATION_ENTRY) {
      return principal.identityCredentialRef
        ? { type: 'none', note: 'the identity credential is asked when the connection is established' }
        : { type: 'request_presentation', entry }
    }
    return this.pack.presentations?.[entry]?.request === 'on-demand'
      ? { type: 'request_presentation', entry }
      : { type: 'none', note: 'this credential is asked when the connection is established' }
  }
}

/** What the model is told of an issuance: a status, and what is missing when something is. */
export function issuanceOutcomeForModel(outcome: IssuanceOutcome, requirements?: CredentialRequirements): string {
  const detail = requirements ? `\n${JSON.stringify(requirements)}` : ''
  switch (outcome) {
    case 'issued':
      return 'issued: the credential is in the wallet of the person.'
    case 'held':
      return 'already issued: this agent issued this credential to the person before.'
    case 'incomplete':
      return `not issued: something is missing. For each claim that is not available, do what its action says, then try again.${detail}`
    case 'challenge-failed':
      return 'not issued: the identity check before the issuance did not pass.'
    case 'declined':
      return 'not issued: the offer was declined or left unanswered in the wallet.'
    case 'unavailable':
      return 'not issued: the wallet cannot be reached right now, or an issuance is already under way.'
    case 'not-ready':
      return 'not issued: this agent cannot issue this credential yet. It is not something the person can fix; they can try again later.'
    case 'failed':
      return 'not issued: the offer could not be sent.'
    default:
      return 'not issued: this credential is not one you can issue to this peer.'
  }
}

/** What the person is told after asking for a credential from the menu. */
export function issuanceOutcomeForPerson(outcome: IssuanceOutcome, requirements?: CredentialRequirements): string {
  switch (outcome) {
    case 'issued':
      return 'The credential is in your wallet.'
    case 'held':
      return 'You already received this credential.'
    case 'incomplete': {
      const missing = (requirements?.claims ?? []).filter((c) => c.status !== 'available').map((c) => c.name)
      return `Something is missing before this credential can be issued${missing.length ? `: ${missing.join(', ')}` : ''}.`
    }
    case 'challenge-failed':
      return 'The identity check did not pass. Nothing was issued.'
    case 'declined':
      return 'The offer was not accepted. Nothing was issued.'
    default:
      return 'This credential cannot be issued right now.'
  }
}
