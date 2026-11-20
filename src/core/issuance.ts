/**
 * Credential issuance (D68, D70; INTX-ISSUE-001..014). The agent issues what the profiles of the agent-pack
 * describe, and every claim comes from a source the profile names: the model supplies no value, no recipient
 * and no connection. `requirements` tells, without any value, what a peer may receive and what is missing;
 * `issue` resolves the claims in code for the Principal of the session, issues nothing when one cannot be
 * resolved, and leaves a record built as evidence is.
 *
 * Decision 61: a credential issued under a revocable definition takes a revocation registry and an index, which its
 * record keeps; a credential whose claims came from the user directory must be revocable, and its record names the
 * entry (IDENT-DIR-006) and a keyed index of the actor it will identify once presented (IDENT-ROLE-012).
 *
 * Decision 62 (ayni-spec D88, D89): a badge from the user directory. A claim may come from the person's entry
 * (`record: directory`, INTX-ISSUE-021), found from their evidence, `pending` while it does not exist; the challenges
 * of a profile are a list, a document read and an email code among them (IDENT-DIR-002). The email code is served in
 * the conversation by the code (INTX-AUTH-012): the issuing call ends the turn with the code's question, and the
 * issuance goes on by itself once the code is right (INTX-AUTH-015). `emailId` numbers a badge by the verified address
 * (INTX-ISSUE-020); `as: dateint` writes a date as the integer `YYYYMMDD` (IDENT-DIR-005).
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { AUTHENTICATION_ENTRY, DOCUMENT_ENTRY, EMAIL_ENTRY } from '../config/pack.js'
import {
  type AgentPack,
  type ClaimSource,
  challengesOf,
  challengeTypesOf,
  type IssuanceChallenge,
  type IssuanceProfile,
  mustBeRevocable,
} from '../config/packTypes.js'
import { nowIso } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { EvidenceService } from './evidence.js'
import type { EvidenceRecord, Principal, Session } from './types.js'

/** The entry under which the issuances of a profile are recorded: never the name of a catalog entry. */
export const issuanceEntry = (profile: string) => `issuance:${profile}`

/**
 * The status of a claim (INTX-ISSUE-005): `pending` is a claim of a system of record whose key comes from evidence that
 * does not exist yet (INTX-ISSUE-007, INTX-ISSUE-021).
 */
export type ClaimStatus = 'available' | 'missing' | 'expired' | 'not-revealed' | 'unavailable' | 'pending'

/** One action of a closed list that obtains what is missing (INTX-ISSUE-006). */
export type ClaimAction =
  | { type: 'request_presentation'; entry: string }
  /**
   * what the issuance itself obtains: the document read (INTX-AUTH-010) or the email code (INTX-AUTH-012) that a
   * challenge of the profile runs; the action names the issuing tool, the profile and the challenge
   */
  | { type: 'issue_credential'; profile: string; challenge: 'document' | 'email'; note: string }
  | { type: 'none'; note: string }

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
  /** an email check now waits in the conversation: the code asks the person, and issues once the code is right */
  | 'challenge-started'
  /** an email check of the person already waits, in this conversation or another: it is answered there */
  | 'challenge-waiting'
  | 'declined'
  | 'unanswered'
  | 'refused'
  | 'unavailable'
  | 'not-ready'
  | 'failed'

/** What an issuance ended in; with an email check started, the question the code asks in the conversation (INTX-AUTH-012). */
export interface IssuanceResult {
  outcome: IssuanceOutcome
  requirements?: CredentialRequirements
  reason?: string
  /** the email check waits in the conversation: the code's question, which ends the turn that started it */
  ask?: { text: string; challengeId: string }
}

/** Where an issued credential's status is kept, for its revocation (D91): a registry and an index in it. */
export interface RevocationSlot {
  registryDefinitionId: string
  index: number
}

export interface IssuanceDeps {
  /** offers the credential on the connection and waits for the wallet: the exchange it ended in */
  offer(input: {
    connectionId: string
    credentialDefinitionId: string
    claims: Record<string, string>
    title: string
    /** under a revocable definition: the registry and the index the credential takes */
    revocation?: RevocationSlot
  }): Promise<{
    outcome: 'issued' | 'declined' | 'unanswered' | 'refused' | 'failed'
    /** why the wallet refused, when it did: the code of its problem report */
    reason?: string
    exchangeId?: string
  }>
  /** runs a challenge of the profile on the capability channel and tells whether it passed, and in words for the model why it did not */
  challenge(
    principal: Principal,
    session: Session,
    policy: IssuanceChallenge & { type: 'device' | 'face-match' | 'document' },
    purpose: string
  ): Promise<{ passed: boolean; reason?: string }>
  /**
   * the email code (D89): served by the code in the conversation of the session (INTX-AUTH-012). Without it, or when it
   * is not available, the claims it serves are `unavailable` (INTX-AUTH-011)
   */
  emailCheck?: EmailCheckPort
  /**
   * the credential definition of this agent for a schema, found or created, with revocation when `revocable` asks for
   * it; undefined while it cannot be established (INTX-ISSUE-017, decision 61)
   */
  definitionFor?(jsonSchemaCredentialId: string, options: { revocable: boolean }): Promise<string | undefined>
  /**
   * the registry and the index of the next credential issued under a definition; undefined when the definition does not
   * support revocation. Throws when it does and none can be had (decision 61)
   */
  allocateRevocation?(credentialDefinitionId: string): Promise<RevocationSlot | undefined>
  /**
   * the actor the issued credential identifies once presented, when it is the identity credential (the home
   * organization, the schema, the subject key: D59); its record keeps a keyed index of it (IDENT-ROLE-012)
   */
  holderOf?(profileName: string, profile: IssuanceProfile, claims: Record<string, string>): Promise<string | undefined>
  /** after the record of an issuance: a Principal that already is the actor of the credential holds its entry */
  issued?(principal: Principal, record: EvidenceRecord, holder: string | undefined): Promise<void>
  /**
   * a claim of a system of record (`{ from: record, record, field }`, INTX-ISSUE-002): the user directory, whose entry
   * is found from the Principal's evidence (INTX-ISSUE-021, IDENT-DIR-003/004; agent phase 2b). Its resolution names
   * the entry, which the record of the issuance keeps (IDENT-DIR-006). Without it such a claim is `unavailable`
   */
  record?(
    principal: Principal,
    profileName: string,
    profile: IssuanceProfile,
    source: RecordSource
  ): Promise<Resolution>
}

/** How an issuance asks for an email code (D89, INTX-AUTH-011/012). */
export interface EmailCheckPort {
  /** whether the check can be served now: an SMTP server is configured, and in this session's conversation */
  available(session?: Session): boolean
  /** starts the check in the conversation of the session: the question the code asks, or why it did not start */
  start(
    principal: Principal,
    session: Session,
    input: { profile: string; by: IssuanceTrigger; label: string }
  ): Promise<
    { started: true; question: string; challengeId: string } | { started: false; reason: 'waiting' | 'unavailable' }
  >
}

/** Who started an issuance: the model's tool, the person's menu item, or the agent by itself. */
export type IssuanceTrigger = 'model' | 'person' | 'agent'

/** A claim of a system of record (INTX-ISSUE-002, INTX-ISSUE-021): a field of the person's entry of the user directory. */
export type RecordSource = Extract<ClaimSource, { from: 'record' }>

/** How a claim resolved: its status, its value when available, and where it came from. */
export interface Resolution {
  status: ClaimStatus
  value?: string
  evidenceRef?: string
  action?: ClaimAction
  /** a claim taken from the user directory: the entry it came from (INTX-ISSUE-021, IDENT-DIR-006) */
  directoryEntryId?: string
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
  return identifier(key, `${profile}\u0000${principalId}`)
}

/**
 * An identifier of a document under a profile (INTX-ISSUE-019): the same digest, of the profile, the issuing
 * state and the number of the document. One document has one value, to whichever Principal reads it: a guest is
 * a new Principal at each connection, and a person who reads the same passport again is the same holder. Neither
 * the number nor the state can be read from it. A renewed document has another number, and another value.
 */
export function documentId(key: Buffer, profile: string, issuingState: string, documentNumber: string): string {
  return identifier(key, `document\u0000${profile}\u0000${issuingState}\u0000${documentNumber}`)
}

/**
 * An identifier of an email address under a profile (INTX-ISSUE-020): the same digest, of the profile and the address
 * written in lower case. One address has one value, to whichever Principal proves it; the address cannot be read from
 * it, and the values of two profiles cannot be linked without the key. An address that changes gives another value.
 */
export function emailId(key: Buffer, profile: string, address: string): string {
  return identifier(key, `email\u0000${profile}\u0000${address.trim().toLowerCase()}`)
}

/** A calendar date as the integer `YYYYMMDD` (`as: dateint`, IDENT-DIR-005); undefined for anything else. */
export function dateInt(value: string): string | undefined {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value.trim())
  return match ? `${match[1]}${match[2]}${match[3]}` : undefined
}

/** Whether a piece of evidence is too old for a profile, or past its own retention (INTX-ISSUE-013). */
export function evidenceTooOld(
  record: EvidenceRecord,
  profile: Pick<IssuanceProfile, 'evidenceMaxAgeMinutes'>
): boolean {
  if (record.expiresAt && record.expiresAt <= nowIso()) return true
  const minutes = profile.evidenceMaxAgeMinutes
  return minutes !== undefined && Date.now() - Date.parse(record.verifiedAt) > minutes * 60_000
}

function identifier(key: Buffer, of: string): string {
  const digest = createHmac('sha256', key).update(of).digest()
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
  /** the schemas whose definition must support revocation: those of a profile that must be revocable (decision 61) */
  private readonly revocableSchemas: Set<string>

  public constructor(
    private readonly pack: AgentPack,
    private readonly evidence: EvidenceService,
    private readonly deps: IssuanceDeps,
    private readonly logger: Logger,
    /** derives the identifiers of subjects (INTX-ISSUE-016); see `subjectIdKey` */
    private readonly idKey: Buffer
  ) {
    this.revocableSchemas = new Set(
      Object.values(pack.issuance ?? {})
        .filter((p) => mustBeRevocable(p) && p.credential.jsonSchemaCredentialId)
        .map((p) => p.credential.jsonSchemaCredentialId as string)
    )
  }

  /** The profiles a Principal may receive: a person, of a role the profile names when it names some. */
  public offered(principal: Principal): [string, IssuanceProfile][] {
    return offeredProfiles(this.pack, principal)
  }

  /** What the peer may receive and what is missing, without any value (INTX-ISSUE-005/006). */
  public async requirements(principal: Principal, only?: string): Promise<CredentialRequirements[]> {
    const out: CredentialRequirements[] = []
    for (const [name, profile] of this.offered(principal)) {
      if (only && name !== only) continue
      // a credential revoked since (its entry left the directory) is held no more (D91)
      const latest = await this.evidence.latest(principal.id, issuanceEntry(name))
      const held = !!latest && !latest.revocation?.revokedAt
      const claims: ClaimRequirement[] = []
      for (const [claim, source] of Object.entries(profile.claims)) {
        const { status, action } = await this.resolve(principal, name, profile, source)
        claims.push({ name: claim, status, ...(action ? { action } : {}) })
      }
      out.push({
        credential: name,
        ...(profile.label ? { label: profile.label } : {}),
        // what the document read of the profile will give is not missing: the issuance starts with that read
        state: held
          ? 'held'
          : claims.every((c) => c.status === 'available' || c.action?.type === 'issue_credential')
            ? 'ready'
            : 'incomplete',
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
    by: IssuanceTrigger
  ): Promise<IssuanceResult> {
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
      let [requirements] = await this.requirements(principal, name)
      if (requirements.state === 'held') return { outcome: 'held', requirements }
      if (requirements.state !== 'ready') return { outcome: 'incomplete', requirements }
      const label = profile.label ?? name
      // a profile that names a schema issues under the definition of this agent for it, or not at all
      const credentialDefinitionId = await this.definitionOf(profile)
      if (!credentialDefinitionId) return { outcome: 'not-ready' }
      // the challenges in their order (IDENT-DIR-002). What a challenge obtains and is still good is not asked again: a
      // person who declined the offer, or let it pass, is not sent back to their chip or their mailbox
      for (const policy of challengesOf(profile)) {
        const obtains = (c: ClaimRequirement) =>
          c.status !== 'available' && c.action?.type === 'issue_credential' && c.action.challenge === policy.type
        if (policy.type === 'email') {
          if (!requirements.claims.some(obtains)) continue
          // served in the conversation by the code, never by the model (INTX-AUTH-012): the turn ends with its question
          const check = this.deps.emailCheck
          const started = check?.available(session)
            ? await check.start(principal, session, { profile: name, by, label })
            : ({ started: false, reason: 'unavailable' } as const)
          if (started.started)
            return { outcome: 'challenge-started', ask: { text: started.question, challengeId: started.challengeId } }
          if (started.reason === 'waiting') return { outcome: 'challenge-waiting' }
          return {
            outcome: 'challenge-failed',
            reason:
              'the email check cannot be served here: this agent sends no email, or the check runs in a conversation of the Ayni app or the web, not in the wallet',
          }
        }
        if (policy.type === 'document' && !requirements.claims.some(obtains)) continue
        const challenge = await this.deps.challenge(
          principal,
          session,
          policy as IssuanceChallenge & { type: 'device' | 'face-match' | 'document' },
          label
        )
        if (!challenge.passed) return { outcome: 'challenge-failed', reason: challenge.reason }
        // what the read gave: a passport that matches no single person of the directory goes no further (IDENT-DIR-003)
        if (policy.type === 'document') {
          ;[requirements] = await this.requirements(principal, name)
          if (requirements.state !== 'ready') return { outcome: 'incomplete', requirements }
        }
      }
      // the claims are resolved now, by the code, from the sources the profile names and nothing else
      const claims: Record<string, string> = {}
      const evidenceRefs = new Set<string>()
      const entries = new Set<string>()
      for (const [claim, source] of Object.entries(profile.claims)) {
        const resolved = await this.resolve(principal, name, profile, source)
        if (resolved.status !== 'available' || resolved.value === undefined) {
          return { outcome: 'incomplete', requirements: (await this.requirements(principal, name))[0] }
        }
        claims[claim] = resolved.value
        if (resolved.evidenceRef) evidenceRefs.add(resolved.evidenceRef)
        if (resolved.directoryEntryId) entries.add(resolved.directoryEntryId)
      }
      // the claims of one credential come from one entry of the directory (IDENT-DIR-004)
      if (entries.size > 1) {
        this.logger.warn({ profile: name, entries: entries.size }, 'claims from several directory entries: not issued')
        return { outcome: 'incomplete', requirements: (await this.requirements(principal, name))[0] }
      }
      const directoryEntryId = [...entries][0]
      // under a revocable definition the credential takes a registry and an index; one that must be revocable is not
      // issued without them (D91, decision 61)
      let revocation: RevocationSlot | undefined
      try {
        revocation = await this.deps.allocateRevocation?.(credentialDefinitionId)
      } catch (error) {
        this.logger.warn({ err: error, profile: name }, 'no revocation registry for the credential: not issued')
        return { outcome: 'not-ready' }
      }
      if (!revocation && (mustBeRevocable(profile) || directoryEntryId)) {
        this.logger.error(
          { profile: name, credentialDefinitionId },
          'a credential from the user directory must be revocable, and its definition supports no revocation: not issued (IDENT-ROLE-013)'
        )
        return { outcome: 'not-ready' }
      }
      // the actor the credential identifies once presented: a badge from the directory that could never find its entry
      // again is not issued (IDENT-DIR-006)
      const holder = await this.deps.holderOf?.(name, profile, claims)
      if (directoryEntryId && !holder) {
        this.logger.error(
          { profile: name },
          'a badge from the directory must identify its holder (the home organization, the authentication schema, the subject key): not issued (IDENT-DIR-006)'
        )
        return { outcome: 'not-ready' }
      }
      const offer = await this.deps.offer({
        connectionId,
        credentialDefinitionId,
        claims,
        title: label,
        ...(revocation ? { revocation } : {}),
      })
      if (offer.outcome !== 'issued') return { outcome: offer.outcome, reason: offer.reason }
      // one record per issuance: audit fields always, the claims only when the profile keeps them (INTX-ISSUE-014); the
      // entry it came from, the actor it identifies (as a keyed index) and its registry and index, in the clear
      const record = await this.evidence.record(
        principal,
        {
          kind: 'issuance',
          entry: issuanceEntry(name),
          credentialDefinitionId,
          values: claims,
          requestRef: offer.exchangeId,
          connectionRef: connectionId,
          evidenceRefs: [...evidenceRefs],
          ...(directoryEntryId ? { directoryEntryId } : {}),
          ...(holder ? { holder } : {}),
          ...(revocation ? { revocation } : {}),
        },
        profile.record?.storeClaims
          ? { store: { attributes: Object.keys(claims), retention: profile.record.retention } }
          : {}
      )
      this.logger.info(
        {
          principalId: principal.id,
          profile: name,
          by,
          ...(directoryEntryId ? { directoryEntryId } : {}),
          revocable: !!revocation,
        },
        'credential issued'
      )
      await this.deps
        .issued?.(principal, record, holder)
        .catch((err) => this.logger.warn({ err, principalId: principal.id }, 'what follows an issuance failed'))
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
    if (source.from === 'record') {
      // a field of the person's entry, found from their evidence and never before it exists (INTX-ISSUE-007/021)
      return this.deps.record
        ? this.deps.record(principal, name, profile, source)
        : { status: 'unavailable', action: { type: 'none', note: `this agent reads no ${source.record}` } }
    }
    if (source.from === 'computed') {
      if (source.fn === 'subjectId') return { status: 'available', value: subjectId(this.idKey, name, principal.id) }
      if (source.fn === 'documentId') {
        // made of two attributes of the document read: missing, or too old, as they are
        const of = (attribute: string) =>
          this.resolve(principal, name, profile, { from: 'evidence', entry: DOCUMENT_ENTRY, attribute })
        const [state, number] = [await of('issuingState'), await of('documentNumber')]
        const gap = [state, number].find((r) => r.status !== 'available')
        if (gap || state.value === undefined || number.value === undefined)
          return { status: gap?.status ?? 'unavailable', action: gap?.action }
        return {
          status: 'available',
          value: documentId(this.idKey, name, state.value, number.value),
          evidenceRef: number.evidenceRef,
        }
      }
      if (source.fn === 'emailId') {
        // the verified address of an email code: missing without one (INTX-ISSUE-020)
        const address = await this.resolve(principal, name, profile, {
          from: 'evidence',
          entry: EMAIL_ENTRY,
          attribute: 'address',
        })
        if (address.status !== 'available' || address.value === undefined)
          return { status: address.status, action: address.action }
        return {
          status: 'available',
          value: emailId(this.idKey, name, address.value),
          evidenceRef: address.evidenceRef,
        }
      }
      if (source.fn === 'today') return { status: 'available', value: today() }
      if (source.fn === 'now') return { status: 'available', value: nowIso() }
      if (source.fn === 'constant') return { status: 'available', value: source.value ?? '' }
      const date = new Date(Date.now() + (source.days ?? 0) * 86_400_000).toISOString().slice(0, 10)
      return { status: 'available', value: date }
    }
    const action = this.actionFor(principal, source.entry, name, profile)
    const record = await this.evidence.latest(principal.id, source.entry)
    // an email check this agent cannot serve leaves what it would verify unavailable (INTX-AUTH-011)
    const unservable =
      source.entry === EMAIL_ENTRY && !this.deps.emailCheck?.available()
        ? ({
            status: 'unavailable',
            action: { type: 'none', note: 'this agent sends no email: it cannot check an address' },
          } as const)
        : undefined
    if (!record) return unservable ?? { status: 'missing', action }
    if (record.unrevealed.includes(source.attribute)) return { status: 'not-revealed', action }
    if (evidenceTooOld(record, profile) || record.state !== 'active') return unservable ?? { status: 'expired', action }
    const values = await this.evidence.values(principal.id, source.entry)
    const value = values?.[source.attribute]
    if (value === undefined) {
      // verified, but the value is not kept: nothing the person can do about it
      return { status: 'unavailable', action: { type: 'none', note: 'this agent does not keep the value' } }
    }
    if (source.as === 'dateint') {
      // a calendar date written as the integer YYYYMMDD (IDENT-DIR-005)
      const written = dateInt(value)
      if (written === undefined)
        return { status: 'unavailable', action: { type: 'none', note: 'the value is not a calendar date' } }
      return { status: 'available', value: written, evidenceRef: record.id }
    }
    return { status: 'available', value, evidenceRef: record.id }
  }

  /** The credential definition a profile issues under: the one it names, or the agent's for the schema it names. */
  private async definitionOf(profile: IssuanceProfile): Promise<string | undefined> {
    const { credentialDefinitionId, jsonSchemaCredentialId } = profile.credential
    if (credentialDefinitionId) return credentialDefinitionId
    if (!jsonSchemaCredentialId || !this.deps.definitionFor) return undefined
    return this.deps.definitionFor(jsonSchemaCredentialId, {
      revocable: this.revocableSchemas.has(jsonSchemaCredentialId),
    })
  }

  /** Establishes the definitions of the profiles that name a schema, ahead of the first issuance. */
  public async prepare(): Promise<void> {
    for (const [name, profile] of Object.entries(this.pack.issuance ?? {})) {
      if (profile.credential.credentialDefinitionId) continue
      const id = await this.definitionOf(profile)
      this.logger.info({ profile: name, credentialDefinitionId: id ?? null }, 'issuance profile by schema')
    }
  }

  /** What obtains the evidence of an entry: the request tool when the entry is asked on demand, else nothing to do. */
  private actionFor(principal: Principal, entry: string, name: string, profile: IssuanceProfile): ClaimAction {
    if (entry === DOCUMENT_ENTRY) return documentAction(name, profile)
    if (entry === EMAIL_ENTRY) return emailAction(name, profile)
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

/** What obtains a document read for a profile: its own challenge, when it declares one (INTX-AUTH-010). */
export function documentAction(name: string, profile: Pick<IssuanceProfile, 'authChallenge'>): ClaimAction {
  return challengeTypesOf(profile).includes('document')
    ? {
        type: 'issue_credential',
        profile: name,
        challenge: 'document',
        note: 'the person reads their passport or identity card on their phone when the issuance starts',
      }
    : { type: 'none', note: 'nothing reads a document for this credential' }
}

/** What obtains a verified address for a profile: its own email challenge, when it declares one (INTX-AUTH-012). */
export function emailAction(name: string, profile: Pick<IssuanceProfile, 'authChallenge'>): ClaimAction {
  return challengeTypesOf(profile).includes('email')
    ? {
        type: 'issue_credential',
        profile: name,
        challenge: 'email',
        note: 'when the issuance starts, the system asks the person in this conversation for the email address their organization knows them by, and for the code it sends there; you never see either',
      }
    : { type: 'none', note: 'nothing checks an email address for this credential' }
}

/** What the model is told of an issuance: a status, and what is missing when something is. */
export function issuanceOutcomeForModel(
  outcome: IssuanceOutcome,
  requirements?: CredentialRequirements,
  reason?: string
): string {
  const detail = requirements ? `\n${JSON.stringify(requirements)}` : ''
  switch (outcome) {
    case 'issued':
      return 'issued: the credential is in the wallet of the person.'
    case 'held':
      return 'already issued: this agent issued this credential to the person before.'
    case 'incomplete':
      return `not issued: something is missing. For each claim that is not available, do what its action says, then try again.${detail}`
    case 'challenge-failed':
      return reason
        ? `not issued, and nothing is on the phone of the person now: ${reason}. Tell them this; do not say that their phone will ask them.`
        : 'not issued: the identity check before the issuance did not pass.'
    case 'challenge-started':
      return 'not issued yet: the system now asks the person, in this conversation, for the email address their organization knows them by, then for the code it sends there; it issues the credential by itself once the code is right. You will not see the address or the code. Your turn ends here.'
    case 'challenge-waiting':
      return 'not issued: an email check of this person is already waiting, in this conversation or another of theirs with this agent. email_check tells where and at which step, sends a new code, or cancels it; do not call again while it waits.'
    case 'declined':
      return 'not issued: the person declined the offer in their wallet.'
    case 'unanswered':
      return 'not issued: the person did not answer the offer in their wallet in time. Nothing was refused; they can ask again.'
    case 'refused':
      return `not issued: the wallet of the person refused the offer by itself, before showing it to them${reason ? ` (${reason})` : ''}. The person did nothing; trying again will not help.`
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
export function issuanceOutcomeForPerson(
  outcome: IssuanceOutcome,
  requirements?: CredentialRequirements,
  reason?: string
): string {
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
      return reason ? `Nothing was issued: ${reason}.` : 'The identity check did not pass. Nothing was issued.'
    case 'challenge-waiting':
      return 'An email check is already waiting in one of your conversations with this agent: answer it there.'
    case 'declined':
      return 'You declined the offer. Nothing was issued.'
    case 'unanswered':
      return 'The offer was not answered in time. Nothing was issued; you can ask again.'
    case 'refused':
      return `Your wallet refused the offer by itself${reason ? ` (${reason})` : ''}. Nothing was issued.`
    default:
      return 'This credential cannot be issued right now.'
  }
}
