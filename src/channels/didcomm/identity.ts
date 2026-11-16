/**
 * Identity on DIDComm connect (D31, D38; IDENT-RES-001..006; IDENT-TRUST-002/004):
 * the ECS-UserAgent gate, then the ECS-Badge (persons) or ECS-Service plus Org/Persona (services),
 * requested through the DIDComm agent; the backing identity of a person is obtained by trust-resolving
 * the badge issuer through the Verifiable Trust resolution service (the indexer). On a flow-capable
 * wallet each request is a flow (`identify-ua` for the user-agent credential, `authenticate` for the badge,
 * D54, D72); a holder that answers `unsupported-kind` to `identify-ua` is treated as having no such credential
 * (IDENT-RES-003).
 *
 * The authentication (D72): one request is one attempt, and it ends accepted, not accepted with a reason,
 * declined or unanswered. A credential that is not accepted is asked again; what a decline or a silence does
 * follows from the mode of the agent-pack.
 */
import {
  type AgentPack,
  type AuthenticationEntry,
  authenticationModeOf,
  type CredentialRef,
  type PresentationEntry,
} from '../../config/packTypes.js'
import { AUTHENTICATION_ENTRY, type EvidenceInput } from '../../core/evidence.js'
import type { FlowService } from '../../core/flows.js'
import { type OrganizationFacts, organizationFrom } from '../../core/organization.js'
import type { LivenessChecker, VerifiedFacts } from '../../core/principals.js'
import type { BackingIdentity, ConnectionType, LivenessVerdict, Principal } from '../../core/types.js'
import { Deferred } from '../../util/async.js'
import { nowIso } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'
import type { PeerStatusRefusalCode } from './peerStatus.js'
import type { PresentationRecord, VsAgentClient } from './vsAgentClient.js'

export interface ResolveResult {
  did: string
  trusted: boolean
  ecsCredentials?: { ecsSchema: string; credentialSubject: Record<string, unknown>; ecosystemId?: number }[]
}

/** Verifiable Trust resolution, consumed as a dependency (IDENT-TRUST-004). */
export class TrustResolver implements LivenessChecker {
  private readonly cache = new Map<string, { at: number; result: ResolveResult }>()

  public constructor(
    private readonly indexerUrl: string | undefined,
    readonly _logger: Logger
  ) {}

  public async resolve(did: string, maxAgeMs = 60_000): Promise<ResolveResult> {
    const cached = this.cache.get(did)
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.result
    if (!this.indexerUrl) throw new Error('VERANA_API_URL is not configured: trust resolution unavailable')
    const response = await fetch(`${this.indexerUrl}/v4/verifiable-trust/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did, ecsCredentials: true }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 404) return { did, trusted: false }
    if (!response.ok) throw new Error(`trust resolution HTTP ${response.status}`)
    const result = (await response.json()) as ResolveResult
    this.cache.set(did, { at: Date.now(), result })
    return result
  }

  /**
   * The organization a trusted DID is backed by, from its verified ECS Organization credential (D64).
   * A DID backed by a Persona, or by an Organization credential that carries no key, has none in this
   * version (IDENT-RES-011).
   */
  public organizationOf(result: ResolveResult): OrganizationFacts | null {
    if (!result.trusted) return null
    const org = result.ecsCredentials?.find((c) => c.ecsSchema === 'OrganizationCredential')
    return org ? organizationFrom(org.credentialSubject) : null
  }

  /** Re-walk of the issuer trust chain on liveness checks (IDENT-LIVE-002). */
  public async verify(principal: Principal, credentialRef: string): Promise<LivenessVerdict> {
    const issuer = (principal.identityAttributes as { issuerDid?: string }).issuerDid
    if (!issuer) return { ok: true, checkedAt: nowIso(), reason: 'no-issuer' }
    const result = await this.resolve(issuer, 0)
    void credentialRef
    return { ok: result.trusted, checkedAt: nowIso(), reason: result.trusted ? undefined : 'issuer-untrusted' }
  }
}

interface PendingProof {
  deferred: Deferred<PresentationRecord>
  timer: NodeJS.Timeout
}

/** How long a request for the identity credential is valid (IDENT-RES-020). */
export const AUTHENTICATION_VALID_MS = 5 * 60_000

/** Why a verified presentation is not accepted as the identity of a person (flow profile §6.14). */
export type NotAcceptedCode = 'issuer-not-accepted' | 'not-valid' | 'incomplete'

const NOT_ACCEPTED: Record<NotAcceptedCode, string> = {
  'issuer-not-accepted': 'This service does not accept credentials of this issuer.',
  'not-valid': 'This credential could not be verified, or is no longer valid.',
  incomplete: 'This service needs an attribute that was not shared.',
}

/** What one request for the identity credential ends in (D72). */
export type AuthenticationAttempt =
  | { outcome: 'accepted'; facts: VerifiedFacts }
  | { outcome: 'not-accepted'; code: NotAcceptedCode }
  | { outcome: 'declined' }
  | { outcome: 'unanswered' }

/** A presentation record, with how the holder closed its flow when the holder closed it first. */
type FlowPresentation = PresentationRecord & { flowClosed?: string }

/**
 * Whether a presentation record says that the holder declined. A wallet that declines sends the problem report
 * of present-proof, which the DIDComm agent reports as a record `abandoned` with the wallet's words ("Request
 * declined"), and then closes the flow: the record comes first. It is a refusal of the person, not a
 * presentation that came and did not verify.
 */
export function declinedByHolder(record: Pick<PresentationRecord, 'state' | 'errorMessage'>): boolean {
  return record.state === 'declined' || /declin/i.test(record.errorMessage ?? '')
}

export class IdentityFlow {
  private readonly pending = new Map<string, PendingProof>()
  private flows?: FlowService

  public constructor(
    private readonly pack: AgentPack,
    private readonly client: VsAgentClient,
    private readonly resolver: TrustResolver,
    private readonly devAllowUnidentified: boolean,
    private readonly logger: Logger
  ) {}

  public setFlows(flows: FlowService): void {
    this.flows = flows
  }

  /** Called by the webhook when a presentation record reaches a final state. */
  public onPresentation(record: PresentationRecord): void {
    const pending = this.pending.get(record.proofExchangeId)
    if (!pending) return
    if (['done', 'abandoned', 'declined'].includes(record.state) || record.verified || record.errorMessage) {
      clearTimeout(pending.timer)
      this.pending.delete(record.proofExchangeId)
      pending.deferred.resolve(record)
    }
  }

  private async request(
    connectionId: string,
    credentials: CredentialRef[],
    timeoutMs = 120_000,
    flow?: { kind: string; title: string }
  ): Promise<PresentationRecord> {
    if (flow && this.flows) return this.requestInFlow(connectionId, credentials, timeoutMs, flow)
    const { proofExchangeId } = await this.client.requestPresentation(connectionId, credentials)
    return this.awaitPresentation(proofExchangeId, timeoutMs)
  }

  private awaitPresentation(proofExchangeId: string, timeoutMs: number): Promise<PresentationRecord> {
    const deferred = new Deferred<PresentationRecord>()
    const timer = setTimeout(() => {
      this.pending.delete(proofExchangeId)
      deferred.resolve({ proofExchangeId, state: 'abandoned', claims: [], verified: false, errorMessage: 'timeout' })
    }, timeoutMs)
    this.pending.set(proofExchangeId, { deferred, timer })
    return deferred.promise
  }

  /**
   * The request as a flow (origin `none`, FLOW-CORE-001): `open`, then `request-presentation` with the flow id as
   * parent thread; whichever ends first settles it, the presentation (the agent closes the flow) or the holder's
   * close or problem report (the presentation is abandoned with the flow's code as error).
   */
  private async requestInFlow(
    connectionId: string,
    credentials: CredentialRef[],
    timeoutMs: number,
    flow: { kind: string; title: string },
    /**
     * the agent's own decision on a presentation that verified: a reason not to accept it, or nothing. With it
     * the flow fails with that reason's code, and a presentation that does not verify fails with `not-valid`
     */
    decide?: (record: PresentationRecord) => Promise<NotAcceptedCode | undefined>
  ): Promise<FlowPresentation> {
    const flows = this.flows as FlowService
    const handle = await flows.open({ connectionId, kind: flow.kind, title: flow.title, expiresInMs: timeoutMs })
    let proofExchangeId: string
    try {
      proofExchangeId = (await this.client.requestPresentation(connectionId, credentials, true, handle.flowId))
        .proofExchangeId
    } catch (error) {
      await flows.close(handle.flowId, 'failed', { reason: 'The presentation request could not be sent.' })
      throw error
    }
    const presentation = this.awaitPresentation(proofExchangeId, timeoutMs)
    const closed = flows.waitForClose(handle.flowId).then((c) => ({ closed: c }))
    const first = await Promise.race([presentation.then((record) => ({ record })), closed])
    if ('record' in first) {
      const record = first.record
      const ok = record.verified && record.state !== 'declined' && record.state !== 'abandoned'
      // a presentation that came and does not verify is not a silence: the holder is told why
      const came = !ok && !declinedByHolder(record) && record.errorMessage !== 'timeout'
      const code = ok ? await decide?.(record) : decide && came ? ('not-valid' as const) : undefined
      if (code) await flows.problemReport(handle.flowId, code, NOT_ACCEPTED[code])
      else
        await flows.close(handle.flowId, ok ? 'completed' : 'failed', {
          reason: ok ? undefined : (record.errorMessage ?? 'The presentation was not verified.'),
          references: ok ? [{ type: 'presentation', id: proofExchangeId }] : undefined,
        })
      return record
    }
    // the holder closed first: declined, expired, or a problem report (unsupported-kind for a deferred kind)
    const pending = this.pending.get(proofExchangeId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pending.delete(proofExchangeId)
    }
    const c = first.closed
    return {
      proofExchangeId,
      state: c.outcome === 'declined' ? 'declined' : 'abandoned',
      claims: [],
      verified: false,
      errorMessage: c.errorCode ?? c.outcome,
      flowClosed: c.outcome,
    }
  }

  /**
   * Establishes the verified facts of a peer, or returns undefined when it must be refused
   * (IDENT-TRUST-001). Services: public DID trust-resolved; persons: user-agent gate, then badge.
   */
  public async establish(
    connectionId: string,
    theirDid: string | undefined,
    options: { flowMode?: boolean; onRefused?: (code: PeerStatusRefusalCode) => void } = {}
  ): Promise<VerifiedFacts | undefined> {
    if (isServicePeer(theirDid) && theirDid) return this.establishService(connectionId, theirDid, options.onRefused)
    return this.establishPerson(connectionId, theirDid ?? connectionId, options.flowMode === true, options.onRefused)
  }

  private async establishService(
    connectionId: string,
    did: string,
    onRefused?: (code: PeerStatusRefusalCode) => void
  ): Promise<VerifiedFacts | undefined> {
    const result = await this.resolver.resolve(did)
    if (!result.trusted) {
      this.logger.warn({ connectionId, did }, 'service peer is not trusted: refused')
      onRefused?.('untrusted')
      return undefined
    }
    const service = result.ecsCredentials?.find((c) => c.ecsSchema === 'ServiceCredential')
    const claims: Record<string, unknown> = {
      ...(service?.credentialSubject ?? {}),
      userName: String(service?.credentialSubject.name ?? did),
    }
    // a service is its own DID, behind its own organization (IDENT-RES-001); none when a Persona backs it
    const organization = this.resolver.organizationOf(result)
    return {
      connectionType: 'verifiable-service',
      actorIdentity: did,
      backingIdentity: backingOf(organization),
      organization,
      claims,
      userAgentVerified: true,
      identityCredentialRef: `ecs-service:${did}`,
    }
  }

  private async establishPerson(
    connectionId: string,
    peerId: string,
    flowMode: boolean,
    onRefused?: (code: PeerStatusRefusalCode) => void
  ): Promise<VerifiedFacts | undefined> {
    const creds = this.pack.identity.credentials
    const gate = this.pack.identity.userAgentGate ?? 'required'
    const name = this.pack.metadata?.displayName ?? 'The agent'
    let userAgentVerified = false
    if (creds?.userAgent) {
      const record = await this.request(
        connectionId,
        [creds.userAgent],
        undefined,
        flowMode ? { kind: 'identify-ua', title: `${name} checks your wallet` } : undefined
      ).catch((err) => {
        this.logger.warn({ err, connectionId }, 'user-agent presentation request failed')
        return undefined
      })
      userAgentVerified = record?.verified === true
      // a flow-capable holder that does not implement the kind has no such credential (IDENT-RES-003)
      if (record?.errorMessage === 'unsupported-kind')
        this.logger.info({ connectionId }, 'user-agent credential not supported by the wallet: treated as absent')
    }
    if (!userAgentVerified && gate === 'required' && creds?.userAgent) {
      this.logger.warn({ connectionId }, 'user-agent gate failed: refused (IDENT-RES-003)')
      onRefused?.('not-admitted')
      return undefined
    }
    // asked at connection (D72): required, a person is authenticated or refused; offered, authenticated or a
    // guest. A credential that is not accepted is asked again, as long as the person presents one
    const mode = authenticationModeOf(this.pack.identity.authentication?.[0])
    while (mode === 'required' || mode === 'offered') {
      const attempt = await this.authenticate(connectionId, peerId, flowMode, userAgentVerified)
      if (attempt.outcome === 'accepted') return attempt.facts
      // a wallet without flows cannot be told why: it is asked once
      if (attempt.outcome === 'not-accepted' && flowMode) continue
      // no answer in time ends the connection in both modes (IDENT-RES-020)
      if (attempt.outcome !== 'unanswered' && mode === 'offered') break
      if (this.devAllowUnidentified) {
        this.logger.warn({ connectionId }, 'DEV: unidentified principal admitted (no badge); development only')
        break
      }
      onRefused?.(attempt.outcome === 'unanswered' ? 'authentication-unanswered' : 'authentication-declined')
      return undefined
    }
    // no authentication schema, guests let in, or one asked on request: the person enters unidentified (D53,
    // D72, IDENT-RES-007)
    return {
      connectionType: 'verifiable-user-agent',
      actorIdentity: peerId,
      backingIdentity: null,
      claims: { userName: 'Unidentified peer' },
      userAgentVerified,
      identityCredentialRef: null,
    }
  }

  /**
   * One request for the credential of the authentication schema, as one credential by its ecosystem schema
   * (IDENT-RES-010), in an `authenticate` flow for a wallet that speaks flows (FLOW-SIGNIN-001), and what it ends
   * in. Used at connection, and later when a guest asks or the model does (IDENT-RES-015).
   */
  public async authenticate(
    connectionId: string,
    peerId: string,
    flowMode: boolean,
    userAgentVerified: boolean
  ): Promise<AuthenticationAttempt> {
    const authentication = this.pack.identity.authentication?.[0]
    if (!authentication) return { outcome: 'declined' }
    const name = this.pack.metadata?.displayName ?? 'The agent'
    const credentials: CredentialRef[] = [
      {
        jsonSchemaCredentialId: authentication.credential.jsonSchemaCredentialId,
        ...(authentication.attributes ? { attributes: authentication.attributes } : {}),
      },
    ]
    let verdict: VerifiedFacts | NotAcceptedCode | undefined
    const decide = async (verified: PresentationRecord) => {
      verdict = await this.factsFromIdentityCredential(peerId, verified, authentication, userAgentVerified)
      return typeof verdict === 'string' ? verdict : undefined
    }
    let record: FlowPresentation
    try {
      if (flowMode && this.flows) {
        record = await this.requestInFlow(
          connectionId,
          credentials,
          AUTHENTICATION_VALID_MS,
          { kind: 'authenticate', title: `Authenticate to ${name}` },
          decide
        )
      } else {
        record = await this.request(connectionId, credentials, AUTHENTICATION_VALID_MS)
        if (record.verified) await decide(record)
      }
    } catch (err) {
      this.logger.warn({ err, connectionId }, 'identity presentation request failed')
      return { outcome: 'unanswered' }
    }
    if (verdict !== undefined)
      return typeof verdict === 'string'
        ? { outcome: 'not-accepted', code: verdict }
        : { outcome: 'accepted', facts: verdict }
    this.logger.warn(
      { connectionId, state: record.state, error: record.errorMessage, flow: record.flowClosed },
      'identity credential not presented'
    )
    // the holder closed the flow first: its time ran out, or the person, or the wallet, would not answer
    if (record.flowClosed) return { outcome: record.flowClosed === 'expired' ? 'unanswered' : 'declined' }
    if (declinedByHolder(record)) return { outcome: 'declined' }
    if (record.errorMessage === 'timeout') return { outcome: 'unanswered' }
    // a presentation that came and did not verify
    return { outcome: 'not-accepted', code: 'not-valid' }
  }

  /**
   * Asks the wallet of a connection for the credential of a catalog entry, as one credential by its ecosystem
   * schema, and returns what was verified, for the evidence record, or undefined when nothing verified came
   * back (D69, INTX-PRES-005). The issuer is the one the DIDComm agent verified in the proof (IDENT-RES-008).
   */
  public async present(
    connectionId: string,
    name: string,
    entry: PresentationEntry,
    flowMode: boolean
  ): Promise<EvidenceInput | undefined> {
    const record = await this.request(
      connectionId,
      [
        {
          jsonSchemaCredentialId: entry.credential.jsonSchemaCredentialId,
          ...(entry.attributes ? { attributes: entry.attributes } : {}),
        },
      ],
      undefined,
      // the purpose of the entry is what the person reads before answering (INTX-PRES-008)
      flowMode ? { kind: 'present', title: entry.purpose } : undefined
    ).catch((err) => {
      this.logger.warn({ err, connectionId, entry: name }, 'presentation request failed')
      return undefined
    })
    if (!record?.verified) return undefined
    const presented = record.credentials?.[0]
    if (!presented?.issuerDid) {
      this.logger.warn({ entry: name }, 'the presentation record reports no issuer: not evidence (IDENT-RES-008)')
      return undefined
    }
    let organization: OrganizationFacts | null = null
    try {
      organization = this.resolver.organizationOf(await this.resolver.resolve(presented.issuerDid))
    } catch (error) {
      this.logger.warn({ err: error, issuerDid: presented.issuerDid }, 'issuer trust resolution failed')
    }
    return {
      kind: 'presentation',
      entry: name,
      schema: entry.credential.jsonSchemaCredentialId,
      credentialDefinitionId: presented.credentialDefinitionId,
      issuerDid: presented.issuerDid,
      issuerOrganization: organization ? { key: organization.key, name: organization.name } : undefined,
      values: Object.fromEntries((presented.claims ?? []).map((c) => [c.name, String(c.value)])),
      unrevealed: [...(presented.unrevealed ?? [])],
      requestRef: record.proofExchangeId,
    }
  }

  /**
   * The verified facts of a presented identity credential, or why it is not accepted as an identity
   * (IDENT-RES-002/008/011/012): the issuer is the one the DIDComm agent verified in the proof, the
   * organization is the issuer's, and the subject key must be revealed.
   */
  private async factsFromIdentityCredential(
    peerId: string,
    record: PresentationRecord,
    authentication: AuthenticationEntry,
    userAgentVerified: boolean
  ): Promise<VerifiedFacts | NotAcceptedCode> {
    const where = { proofExchangeId: record.proofExchangeId }
    const presented = record.credentials?.[0]
    if (!presented?.issuerDid) {
      this.logger.warn(where, 'the presentation record reports no issuer: not an identity (IDENT-RES-008)')
      return 'not-valid'
    }
    const claims: Record<string, unknown> = {}
    for (const c of presented.claims ?? []) claims[c.name] = c.value
    const unrevealed = new Set(presented.unrevealed ?? [])
    const subject: string[] = []
    for (const attribute of authentication.subjectKey) {
      const value = claims[attribute]
      if (unrevealed.has(attribute) || value === undefined || value === null || String(value) === '') {
        this.logger.warn({ ...where, attribute }, 'subject key attribute not revealed: not an identity (IDENT-RES-012)')
        return 'incomplete'
      }
      subject.push(String(value))
    }
    let organization: OrganizationFacts | null = null
    try {
      organization = this.resolver.organizationOf(await this.resolver.resolve(presented.issuerDid))
    } catch (error) {
      this.logger.warn({ err: error, issuerDid: presented.issuerDid }, 'issuer trust resolution failed (IDENT-RES-004)')
    }
    if (!organization) {
      // an issuer that is not trusted, or that no organization backs (a Persona, deferred): no identity (IDENT-RES-011)
      this.logger.warn(
        { ...where, issuerDid: presented.issuerDid },
        'the issuer has no organization key: not an identity'
      )
      return 'issuer-not-accepted'
    }
    // the organizations whose credentials are accepted, when the pack lists any (IDENT-RES-018): decided here,
    // on the issuer the proof verified, whatever the wallet offered
    const accepted = authentication.issuers?.organizations
    if (accepted?.length && !accepted.includes(organization.key)) {
      this.logger.warn(
        { ...where, organization: organization.key },
        'the organization of the issuer is not one this agent accepts: not an identity (IDENT-RES-018)'
      )
      return 'issuer-not-accepted'
    }
    const schema = authentication.credential.jsonSchemaCredentialId
    const actorIdentity = actorIdentityOf(organization.key, schema, subject)
    // the issuer and the name never come from an attribute that says so (IDENT-RES-004)
    const { issuerDid: _claimedIssuer, issuer: _claimedIssuerAlias, ...facts } = claims
    return {
      connectionType: 'verifiable-user-agent' as ConnectionType,
      actorIdentity,
      backingIdentity: backingOf(organization),
      organization,
      // what the earlier key was made of: the subject attribute alone
      legacyActorIdentity: String(claims.id ?? claims.subject ?? `${peerId}#badge`),
      claims: {
        ...facts,
        issuerDid: presented.issuerDid,
        userName: claims.userName ?? claims.name ?? subject.join(' '),
      },
      userAgentVerified,
      identityCredentialRef: `badge:${record.proofExchangeId}`,
      // what was verified, for the evidence record: the pack decides which values are kept (D67)
      evidence: {
        kind: 'presentation',
        entry: AUTHENTICATION_ENTRY,
        schema,
        credentialDefinitionId: presented.credentialDefinitionId,
        issuerDid: presented.issuerDid,
        issuerOrganization: { key: organization.key, name: organization.name },
        values: Object.fromEntries(Object.entries(facts).map(([name, value]) => [name, String(value)])),
        unrevealed: [...(presented.unrevealed ?? [])],
        requestRef: record.proofExchangeId,
      },
    }
  }
}

/** The actor identity of a person: the organization of the issuer, the schema and the subject key (D59). */
/** A peer with a public DID is a service; a wallet connects with a DID of its own making (IDENT-TRUST-001). */
export function isServicePeer(theirDid: string | undefined): boolean {
  return !!theirDid && !theirDid.startsWith('did:peer:') && !theirDid.startsWith('did:key:')
}

export function actorIdentityOf(organizationKey: string, schema: string, subject: string[]): string {
  return [organizationKey, schema, ...subject.map((v) => encodeURIComponent(v))].join('|')
}

function backingOf(organization: OrganizationFacts | null): BackingIdentity | null {
  return organization ? { kind: 'org', id: organization.key, name: organization.name } : null
}
