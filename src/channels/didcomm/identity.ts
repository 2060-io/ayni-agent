/**
 * Identity on DIDComm connect (D31, D38; IDENT-RES-001..006; IDENT-TRUST-002/004):
 * the ECS-UserAgent gate, then the ECS-Badge (persons) or ECS-Service plus Org/Persona (services),
 * requested through the DIDComm agent; the backing identity of a person is obtained by trust-resolving
 * the badge issuer through the Verifiable Trust resolution service (the indexer).
 */
import type { AgentPack, CredentialRef } from '../../config/packTypes.js'
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

  /** The Org or Persona a DID is backed by, from its ECS credentials. */
  public backingOf(result: ResolveResult): BackingIdentity | null {
    if (!result.trusted) return null
    const org = result.ecsCredentials?.find((c) => c.ecsSchema === 'OrganizationCredential')
    if (org) return { kind: 'org', id: result.did, name: String(org.credentialSubject.name ?? result.did) }
    const persona = result.ecsCredentials?.find((c) => c.ecsSchema === 'PersonaCredential')
    if (persona) return { kind: 'persona', id: result.did, name: String(persona.credentialSubject.name ?? result.did) }
    return null
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

  public constructor(
    private readonly pack: AgentPack,
    private readonly client: VsAgentClient,
    private readonly resolver: TrustResolver,
    private readonly devAllowUnidentified: boolean,
    private readonly logger: Logger
  ) {}

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
    timeoutMs = 120_000
  ): Promise<PresentationRecord> {
    const { proofExchangeId } = await this.client.requestPresentation(connectionId, credentials)
    const deferred = new Deferred<PresentationRecord>()
    const timer = setTimeout(() => {
      this.pending.delete(proofExchangeId)
      deferred.resolve({ proofExchangeId, state: 'abandoned', claims: [], verified: false, errorMessage: 'timeout' })
    }, timeoutMs)
    this.pending.set(proofExchangeId, { deferred, timer })
    return deferred.promise
  }

  /**
   * Establishes the verified facts of a peer, or returns undefined when it must be refused
   * (IDENT-TRUST-001). Services: public DID trust-resolved; persons: user-agent gate, then badge.
   */
  public async establish(connectionId: string, theirDid: string | undefined): Promise<VerifiedFacts | undefined> {
    const isService = !!theirDid && !theirDid.startsWith('did:peer:') && !theirDid.startsWith('did:key:')
    if (isService && theirDid) return this.establishService(connectionId, theirDid)
    return this.establishPerson(connectionId, theirDid ?? connectionId)
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
    return {
      connectionType: 'verifiable-service',
      actorIdentity: did,
      backingIdentity: this.resolver.backingOf(result),
      claims,
      userAgentVerified: true,
      identityCredentialRef: `ecs-service:${did}`,
    }
  }

  private async establishPerson(connectionId: string, peerId: string): Promise<VerifiedFacts | undefined> {
    const creds = this.pack.identity.credentials
    const gate = this.pack.identity.userAgentGate ?? 'required'
    let userAgentVerified = false
    if (creds?.userAgent) {
      const record = await this.request(connectionId, [creds.userAgent]).catch((err) => {
        this.logger.warn({ err, connectionId }, 'user-agent presentation request failed')
        return undefined
      })
      userAgentVerified = record?.verified === true
    }
    if (!userAgentVerified && gate === 'required' && creds?.userAgent) {
      this.logger.warn({ connectionId }, 'user-agent gate failed: refused (IDENT-RES-003)')
      return undefined
    }
    if (creds?.badge?.length) {
      const record = await this.request(connectionId, creds.badge).catch((err) => {
        this.logger.warn({ err, connectionId }, 'badge presentation request failed')
        return undefined
      })
      if (record?.verified) return this.factsFromBadge(connectionId, peerId, record, userAgentVerified)
      this.logger.warn({ connectionId, state: record?.state, error: record?.errorMessage }, 'badge not presented')
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

  private async factsFromBadge(
    connectionId: string,
    peerId: string,
    record: PresentationRecord,
    userAgentVerified: boolean
  ): Promise<VerifiedFacts> {
    const claims: Record<string, unknown> = {}
    for (const c of record.claims) claims[c.name] = c.value
    const issuerDid = String(claims.issuerDid ?? claims.issuer ?? '')
    let backing: BackingIdentity | null = null
    if (issuerDid) {
      try {
        backing = this.resolver.backingOf(await this.resolver.resolve(issuerDid))
      } catch (error) {
        this.logger.warn(
          { err: error, issuerDid },
          'badge issuer trust resolution failed: no backing identity (IDENT-RES-004)'
        )
      }
    }
    const subject = String(claims.id ?? claims.subject ?? `${peerId}#badge`)
    return {
      connectionType: 'verifiable-user-agent' as ConnectionType,
      actorIdentity: subject,
      backingIdentity: backing,
      claims: { ...claims, issuerDid, userName: claims.userName ?? claims.name ?? subject },
      userAgentVerified,
      identityCredentialRef: `badge:${record.proofExchangeId}`,
    }
  }
}
