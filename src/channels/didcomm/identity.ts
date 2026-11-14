/**
 * Identity on DIDComm connect (D31, D38; IDENT-RES-001..006; IDENT-TRUST-002/004):
 * the ECS-UserAgent gate, then the ECS-Badge (persons) or ECS-Service plus Org/Persona (services),
 * requested through the DIDComm agent; the backing identity of a person is obtained by trust-resolving
 * the badge issuer through the Verifiable Trust resolution service (the indexer). On a flow-capable
 * wallet each request is a flow (`identify-ua` for the user-agent credential, `present` for the badge,
 * D54); a holder that answers `unsupported-kind` is treated as having no such credential (IDENT-RES-003).
 */
import type { AgentPack, AuthenticationEntry, CredentialRef } from '../../config/packTypes.js'
import { AUTHENTICATION_ENTRY } from '../../core/evidence.js'
import type { FlowService } from '../../core/flows.js'
import { type OrganizationFacts, organizationFrom } from '../../core/organization.js'
import type { LivenessChecker, VerifiedFacts } from '../../core/principals.js'
import type { BackingIdentity, ConnectionType, LivenessVerdict, Principal } from '../../core/types.js'
import { Deferred } from '../../util/async.js'
import { nowIso } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'
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
    flow: { kind: string; title: string }
  ): Promise<PresentationRecord> {
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
      const ok = first.record.verified && first.record.state !== 'declined' && first.record.state !== 'abandoned'
      await flows.close(handle.flowId, ok ? 'completed' : 'failed', {
        reason: ok ? undefined : (first.record.errorMessage ?? 'The presentation was not verified.'),
        references: ok ? [{ type: 'presentation', id: proofExchangeId }] : undefined,
      })
      return first.record
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
    }
  }

  /**
   * Establishes the verified facts of a peer, or returns undefined when it must be refused
   * (IDENT-TRUST-001). Services: public DID trust-resolved; persons: user-agent gate, then badge.
   */
  public async establish(
    connectionId: string,
    theirDid: string | undefined,
    options: { flowMode?: boolean } = {}
  ): Promise<VerifiedFacts | undefined> {
    const isService = !!theirDid && !theirDid.startsWith('did:peer:') && !theirDid.startsWith('did:key:')
    if (isService && theirDid) return this.establishService(connectionId, theirDid)
    return this.establishPerson(connectionId, theirDid ?? connectionId, options.flowMode === true)
  }

  private async establishService(connectionId: string, did: string): Promise<VerifiedFacts | undefined> {
    const result = await this.resolver.resolve(did)
    if (!result.trusted) {
      this.logger.warn({ connectionId, did }, 'service peer is not trusted: refused')
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
    flowMode: boolean
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
      return undefined
    }
    // the one schema that authenticates a person, asked as one credential by its ecosystem schema (IDENT-RES-010)
    const authentication = this.pack.identity.authentication?.[0]
    if (authentication) {
      const record = await this.request(
        connectionId,
        [
          {
            jsonSchemaCredentialId: authentication.credential.jsonSchemaCredentialId,
            ...(authentication.attributes ? { attributes: authentication.attributes } : {}),
          },
        ],
        undefined,
        flowMode ? { kind: 'present', title: `Prove your identity to ${name}` } : undefined
      ).catch((err) => {
        this.logger.warn({ err, connectionId }, 'identity presentation request failed')
        return undefined
      })
      if (record?.verified) {
        const facts = await this.factsFromIdentityCredential(peerId, record, authentication, userAgentVerified)
        if (facts) return facts
      } else {
        this.logger.warn(
          { connectionId, state: record?.state, error: record?.errorMessage },
          'identity credential not presented'
        )
      }
    }
    // the pack admits unidentified peers (D53, IDENT-RES-007), or the development flag does
    if (this.pack.identity.unidentifiedPeers === 'admit' || this.devAllowUnidentified) {
      if (this.pack.identity.unidentifiedPeers === 'admit')
        this.logger.info({ connectionId }, 'unidentified principal admitted (identity.unidentifiedPeers: admit)')
      else this.logger.warn({ connectionId }, 'DEV: unidentified principal admitted (no badge); development only')
      return {
        connectionType: 'verifiable-user-agent',
        actorIdentity: peerId,
        backingIdentity: null,
        claims: { userName: 'Unidentified peer' },
        userAgentVerified,
        identityCredentialRef: null,
      }
    }
    return undefined
  }

  /**
   * The verified facts of a presented identity credential, or undefined when it identifies nobody
   * (IDENT-RES-002/008/011/012): the issuer is the one the DIDComm agent verified in the proof, the
   * organization is the issuer's, and the subject key must be revealed.
   */
  private async factsFromIdentityCredential(
    peerId: string,
    record: PresentationRecord,
    authentication: AuthenticationEntry,
    userAgentVerified: boolean
  ): Promise<VerifiedFacts | undefined> {
    const where = { proofExchangeId: record.proofExchangeId }
    const presented = record.credentials?.[0]
    if (!presented?.issuerDid) {
      this.logger.warn(where, 'the presentation record reports no issuer: not an identity (IDENT-RES-008)')
      return undefined
    }
    const claims: Record<string, unknown> = {}
    for (const c of presented.claims ?? []) claims[c.name] = c.value
    const unrevealed = new Set(presented.unrevealed ?? [])
    const subject: string[] = []
    for (const attribute of authentication.subjectKey) {
      const value = claims[attribute]
      if (unrevealed.has(attribute) || value === undefined || value === null || String(value) === '') {
        this.logger.warn({ ...where, attribute }, 'subject key attribute not revealed: not an identity (IDENT-RES-012)')
        return undefined
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
      return undefined
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
export function actorIdentityOf(organizationKey: string, schema: string, subject: string[]): string {
  return [organizationKey, schema, ...subject.map((v) => encodeURIComponent(v))].join('|')
}

function backingOf(organization: OrganizationFacts | null): BackingIdentity | null {
  return organization ? { kind: 'org', id: organization.key, name: organization.name } : null
}
