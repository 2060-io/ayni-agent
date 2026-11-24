/**
 * Client of the Verifiable Trust v4-compliant DIDComm agent's Admin API (VS Agent 2.x). The Admin
 * API is unprotected and reachable only inside the deployment (reference profile). TOOL-HTTP-003.
 */
import type { Logger } from '../../util/logger.js'
import type { PeerStatus } from './peerStatus.js'

export interface VsAgentInfo {
  did: string
  version: string
}

/**
 * A standalone invitation record (`POST /v2/didcomm/invitations`, vs-agent#804). Its id is the id of the Out-of-Band
 * record it wraps; a connection the invitation produces carries that id as `invitationId`, a handshake reuse names it
 * as `outOfBandId` (CHAN-BIND-017).
 */
export interface InvitationRecordCreated {
  id: string
  invitation: Record<string, unknown>
  shortUrl: string
}

export interface ConnectionRecord {
  id: string
  state: string
  theirDid?: string
  theirLabel?: string
  /** the invitation record that produced the connection, null for any other connection (vs-agent#804) */
  invitationId: string | null
  parentConnectionId: string | null
  invitationDid?: string
  didcommVersion?: 'v1' | 'v2'
  createdAt: string
}

export interface RequestedCredential {
  jsonSchemaCredentialId?: string
  credentialDefinitionId?: string
  attributes?: string[]
}

/** What the DIDComm agent verified of one requested credential (CC-VSA-011): the issuer comes from the proof. */
export interface PresentedCredential {
  credentialDefinitionId: string
  issuerDid: string
  credentialSchemaId?: number
  ecosystemDid?: string
  jsonSchemaCredentialId?: string
  /** the claims of this credential alone */
  claims: { name: string; value: string }[]
  /** the requested attributes the holder left unrevealed */
  unrevealed: string[]
}

export interface PresentationRecord {
  proofExchangeId: string
  state: string
  connectionId?: string
  claims: { name: string; value: string }[]
  /** one entry per requested credential, in the order of the request, once the trust decision succeeded */
  credentials?: PresentedCredential[]
  /** true only once the proof verified and the trust decision on the issuer completed */
  verified: boolean
  threadId?: string
  errorMessage?: string
  requestedCredentials?: RequestedCredential[]
}

/** A credential exchange, as the DIDComm agent reports it when its state changes. */
export interface CredentialExchangeRecord {
  credentialExchangeId: string
  state: string
  connectionId?: string
  threadId?: string
  errorMessage?: string
}

// ---- Ayni flow profile (plugin @ayni.org/vs-agent-plugin-ayni-flow, CC-VSA-005) ----------------------

export interface FlowOrigin {
  channel: 'ag-ui' | 'none'
  agentDid?: string
  sessionId?: string
  conversationId?: string
  client?: { description: string; platform: 'web' | 'ios' | 'android' }
}

/** `FlowDto` of the plugin: the flow as the DIDComm agent holds it. */
export interface FlowRecord {
  flowId: string
  connectionId: string
  role: 'holder' | 'service'
  openedByMe: boolean
  state: 'pending' | 'active' | 'completed' | 'declined' | 'cancelled' | 'failed' | 'expired'
  kind: string
  title: string
  description?: string
  origin: FlowOrigin
  expiresTime: string
  requires?: string[]
  reason?: string
  references?: { type: string; id: string }[]
  errorCode?: string
  closedAt?: string
  closedBy?: 'me' | 'peer' | 'expiry'
  createdAt: string
}

/** `CarrierExchangeDto` of the plugin: one request/response exchange of a carrier protocol. */
export interface CarrierExchange {
  threadId: string
  flowId?: string
  connectionId: string
  role: string
  state: string
  request: Record<string, unknown>
  response?: Record<string, unknown>
  errorCode?: string
  errorDescription?: string
  createdAt: string
}

// ---- authenticate/1.0 (flow profile §6.14, §6.4; the plugin's authenticate routes, credo-ts-ayni-flow 0.2.1) -------------

/** Why the service asks a person to authenticate (flow profile §6.14). */
export type AuthenticatePurpose = 'connection' | 'visitor' | 'step-up' | 'admin' | 'enrol'

/** One method of a request, as in the peer status (flow profile §4.1); the API writes it in camelCase. */
export interface AuthenticateMethodWire {
  type: string
  credential?: { jsonSchemaCredentialId: string }
  issuers?: string[]
}

/** The `request` body (FLOW-SIGNIN-001). */
export interface AuthenticateRequestBody {
  purpose: AuthenticatePurpose
  methods: Record<string, AuthenticateMethodWire>
  combinations: string[][]
  text?: string
}

/** The `step` body (flow profile §6.14): a step announced, or sent again after a wrong code or a refused new code. */
export interface AuthenticateStepBody {
  step: string
  method: string
  type: string
  ask?: 'address' | 'code' | 'consent' | 'assertion'
  text?: string
  expiresAt?: string
  triesLeft?: number
  newCodesLeft?: number
  challenge?: string
  rpId?: string
  error?: 'wrong-code' | 'new-code-refused'
  reason?: 'too-soon' | 'no-more'
}

/** The `answer` body: what the person gave for a step's `ask`. */
export interface AuthenticateAnswerBody {
  step: string
  address?: string
  locale?: string
  code?: string
  newCode?: boolean
  consent?: boolean
  assertion?: {
    id: string
    clientDataJson: string
    authenticatorData: string
    signature: string
    userHandle: string | null
  }
}

/** One step of the combination chosen, as it stands on the DIDComm agent's record. */
export interface AuthenticateStepEntry {
  step: string
  method: string
  type: string
  prompt: AuthenticateStepBody
  answer?: AuthenticateAnswerBody
  awaitingAnswer: boolean
  result?: { step: string; outcome: 'passed' | 'failed' | 'expired'; reason?: string }
}

/** `AuthenticateExchangeDto` of the plugin: one authentication, as the routes return it and the events carry it. */
export interface AuthenticateExchange {
  threadId: string
  flowId?: string
  connectionId: string
  role: string
  state: string
  request: AuthenticateRequestBody
  combination?: string[]
  steps: AuthenticateStepEntry[]
  errorCode?: string
  errorDescription?: string
  createdAt: string
}

/** The `enrol-challenge` body (flow profile §6.4): a passkey's creation options, or an authenticator app's secret. */
export interface EnrolChallengeBody {
  type: 'authenticator-app' | 'passkey'
  publicKey?: {
    rp: { id: string; name?: string }
    user: { id: string; name: string; displayName: string }
    challenge: string
    pubKeyCredParams: { type: string; alg: number }[]
    authenticatorSelection?: { residentKey?: string; userVerification?: string }
  }
  secret?: string
  otpauthUri?: string
  digits?: number
  period?: number
}

/** `EnrolExchangeDto` of the plugin: one enrolment; an authenticator app's secret is never on it. */
export interface EnrolExchange {
  threadId: string
  flowId?: string
  connectionId: string
  role: string
  state: string
  type: 'authenticator-app' | 'passkey'
  challenge?: Record<string, unknown>
  challenges: number
  answer?: {
    attestation?: { id: string; clientDataJson: string; attestationObject: string }
    code?: string
  }
  errorCode?: string
  errorDescription?: string
  createdAt: string
}

/**
 * The approvals an `authorize` request is one of (flow profile §6.5, FLOW-AUTH-004): the approvals needed in total, the
 * other approvers asked (a person by `name`, a role or a department by `label`), and whether the person decides their
 * own request.
 */
/** Another approver of an `authorize` request: a person by `name`, or a role or a department by `label`; one of the two. */
export interface AuthorizeApprover {
  name?: string
  label?: string
  required: boolean
}

export interface AuthorizeApprovals {
  threshold: number
  own: boolean
  others: AuthorizeApprover[]
}

export class VsAgentError extends Error {
  public constructor(
    public readonly status: number,
    public readonly path: string,
    body: string
  ) {
    super(`VS Agent ${path} failed: HTTP ${status} ${body.slice(0, 300)}`)
    this.name = 'VsAgentError'
  }
}

export interface ServiceEndpointEntry {
  id: string
  type: string
  serviceEndpoint: unknown
}

export class VsAgentClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/v2${path}`, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    if (!response.ok) {
      this.logger.warn({ method, path, status: response.status }, 'vs-agent call failed')
      throw new VsAgentError(response.status, path, text)
    }
    return (text ? JSON.parse(text) : undefined) as T
  }

  public info(): Promise<VsAgentInfo> {
    return this.request('GET', '/agent/info')
  }

  // ---- DID Document services (VS Agent admin API, vt/service-endpoints) ----------------------

  public listServiceEndpoints(): Promise<{ items: ServiceEndpointEntry[] }> {
    return this.request('GET', '/vt/service-endpoints')
  }

  public addServiceEndpoint(body: {
    type: string
    serviceEndpoint: unknown
    id?: string
  }): Promise<ServiceEndpointEntry> {
    return this.request('POST', '/vt/service-endpoints', body)
  }

  public updateServiceEndpoint(
    id: string,
    body: { type?: string; serviceEndpoint?: unknown }
  ): Promise<ServiceEndpointEntry> {
    return this.request('PATCH', `/vt/service-endpoints/${encodeURIComponent(id)}`, body)
  }

  public async ready(): Promise<boolean> {
    try {
      await this.request('GET', '/agent/health/ready')
      return true
    } catch {
      return false
    }
  }

  /** A standalone invitation record: the only invitation whose new connections the DIDComm agent names (vs-agent#804). */
  public createInvitation(body: {
    goal?: string
    goalCode?: string
    reusable?: boolean
    didcommVersion?: 'v1' | 'v2'
  }): Promise<InvitationRecordCreated> {
    return this.request('POST', '/didcomm/invitations', body)
  }

  public getConnection(connectionId: string): Promise<ConnectionRecord> {
    return this.request('GET', `/didcomm/connections/${encodeURIComponent(connectionId)}`)
  }

  public deleteConnection(connectionId: string): Promise<void> {
    return this.request('DELETE', `/didcomm/connections/${encodeURIComponent(connectionId)}`)
  }

  public sendText(connectionId: string, content: string): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/basic-messages', { connectionId, content })
  }

  public sendQuestion(
    connectionId: string,
    question: string,
    validResponses: string[],
    detail?: string
  ): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/question-answer', {
      connectionId,
      question,
      detail,
      validResponses: validResponses.map((text) => ({ text })),
    })
  }

  public sendActionMenu(
    connectionId: string,
    title: string,
    description: string,
    options: { name: string; title: string; description: string }[]
  ): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/action-menu', { connectionId, menu: { title, description, options } })
  }

  public shareMedia(
    connectionId: string,
    items: {
      uri: string
      mimeType: string
      fileName?: string
      description?: string
      byteCount?: number
      ciphering?: { algorithm: string; parameters: Record<string, unknown> }
    }[],
    description?: string
  ): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/media-sharing', { connectionId, description, items })
  }

  public sendReactions(
    connectionId: string,
    reactions: { messageId: string; emoji: string; action: 'add' | 'remove' }[]
  ): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/reactions', { connectionId, reactions })
  }

  public sendReceipts(
    connectionId: string,
    receipts: { messageId: string; state: string; timestamp?: string }[]
  ): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/receipts', { connectionId, receipts })
  }

  public sendProfile(
    connectionId: string,
    profile: {
      displayName?: string
      description?: string
      preferredLanguage?: string
      displayPicture?: { links?: string[] }
    }
  ): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/user-profile/send', { connectionId, profile })
  }

  /** `parentThreadId` makes the call a step of a flow: the face step of an `authenticate` flow (CC-VSA-006). */
  public offerCall(
    connectionId: string,
    callType: 'audio' | 'video' | 'service',
    parameters: Record<string, unknown>,
    description?: string,
    offerExpirationTime?: string,
    parentThreadId?: string
  ): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/calls', {
      connectionId,
      callType,
      parameters,
      description,
      offerExpirationTime,
      ...(parentThreadId ? { parentThreadId } : {}),
    })
  }

  public endCall(connectionId: string, threadId: string): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/calls/end', { connectionId, threadId })
  }

  /** Asks for the data of a document's chip; `parentThreadId` is the flow the request belongs to (CC-VSA-014). */
  public requestEmrtd(connectionId: string, parentThreadId?: string): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/mrtd/request-emrtd', {
      connectionId,
      ...(parentThreadId ? { parentThreadId } : {}),
    })
  }

  /** `parentThreadId` makes the request a step of a flow (`~thread.pthid` = flow id, FLOW-CORE-001). */
  public requestPresentation(
    connectionId: string,
    requestedCredentials: RequestedCredential[],
    requireNonRevocation = true,
    parentThreadId?: string
  ): Promise<{ proofExchangeId: string }> {
    return this.request('POST', '/didcomm/presentation-request', {
      connectionId,
      requestedCredentials,
      requireNonRevocation,
      autoAccept: true,
      ...(parentThreadId ? { parentThreadId } : {}),
    })
  }

  /** The credential definitions this DIDComm agent created, a page at a time; each says whether it supports revocation. */
  public listCredentialDefinitions(cursor?: string): Promise<{
    items: { id: string; relatedJsonSchemaCredentialId?: string; supportRevocation?: boolean }[]
    nextCursor?: string | null
  }> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    return this.request('GET', `/anoncreds/credential-definitions${query}`)
  }

  /**
   * Creates the credential definition of this DIDComm agent for a schema of an ecosystem; with `supportRevocation` the
   * credentials issued under it can be revoked, and each offer then names a revocation registry and an index.
   */
  public createCredentialDefinition(body: {
    relatedJsonSchemaCredentialId: string
    supportRevocation?: boolean
  }): Promise<{ id: string; supportRevocation?: boolean }> {
    return this.request('POST', '/anoncreds/credential-definitions', body)
  }

  /**
   * Offers an AnonCreds credential on a connection; `autoAccept` issues it once the holder asks for it. Under a revocable
   * definition the caller names the registry and the index the credential takes (VSA-ADM-DC-CE-OFFER); the DIDComm agent
   * does not choose them.
   */
  public offerCredential(body: {
    connectionId: string
    credentialDefinitionId: string
    claims: { name: string; value: string }[]
    autoAccept?: boolean
    parentThreadId?: string
    revocationRegistryDefinitionId?: string
    revocationRegistryIndex?: number
  }): Promise<{ credentialExchangeId: string }> {
    return this.request('POST', '/didcomm/credential-offer', body)
  }

  /** Creates a revocation registry, and its first status list, for a revocable credential definition (VSA-ADM-AC-RR-CREATE). */
  public createRevocationRegistry(body: {
    credentialDefinitionId: string
    maximumCredentialNumber?: number
  }): Promise<{ revocationRegistryDefinitionId: string }> {
    return this.request('POST', '/anoncreds/revocation-registries', body)
  }

  /**
   * Revokes one credential, by its registry and its index, and publishes the new status list (VSA-ADM-AC-CR-REVOKE). It
   * sends nothing to the holder: the agent notifies it (`sendRevocationNotification`).
   */
  public revokeCredential(body: {
    revocationRegistryDefinitionId: string
    revocationRegistryIndex: number
  }): Promise<{ revocationRegistryDefinitionId: string; revocationRegistryIndex: number; revokedAt: string }> {
    return this.request('POST', '/anoncreds/revoke-credential', body)
  }

  /**
   * `revocation_notification/2.0/revoke` to the holder (flow profile §6.12, FLOW-REVOKE-001, INTX-FLOW-007), through the
   * plugin of the flow profile: `revocationId` is `<registry>::<index>` for AnonCreds.
   */
  public sendRevocationNotification(body: {
    connectionId: string
    revocationId: string
    revocationFormat?: string
    comment?: string
  }): Promise<{ sent: true }> {
    return this.request('POST', '/didcomm/revocation-notification', body)
  }

  public getPresentation(proofExchangeId: string): Promise<PresentationRecord> {
    return this.request('GET', `/didcomm/presentations/${encodeURIComponent(proofExchangeId)}`)
  }

  // ---- flows (flow profile §5, plugin routes) ---------------------------------------------------------

  public openFlow(body: {
    connectionId: string
    kind: string
    title: string
    description?: string
    origin: FlowOrigin
    expiresTime: string
    requires?: string[]
    /** the `open`'s app link, offered on the holder's sheet (flow profile §5.1, FLOW-CORE-011) */
    link?: string
  }): Promise<FlowRecord> {
    return this.request('POST', '/didcomm/ayni-flow/flows', body)
  }

  public closeFlow(
    flowId: string,
    body: {
      outcome: 'completed' | 'declined' | 'cancelled' | 'failed' | 'expired'
      reason?: string
      references?: { type: string; id: string }[]
    }
  ): Promise<FlowRecord> {
    return this.request('POST', `/didcomm/ayni-flow/flows/${encodeURIComponent(flowId)}/close`, body)
  }

  public flowProblemReport(flowId: string, body: { code: string; description?: string }): Promise<FlowRecord> {
    return this.request('POST', `/didcomm/ayni-flow/flows/${encodeURIComponent(flowId)}/problem-report`, body)
  }

  public getFlow(flowId: string): Promise<FlowRecord> {
    return this.request('GET', `/didcomm/ayni-flow/flows/${encodeURIComponent(flowId)}`)
  }

  /** `confirm/1.0/request` inside a flow (flow profile §6.6, INTX-AUTH-009). */
  public sendConfirmRequest(body: {
    connectionId: string
    flowId: string
    request: { text: string; code: string; attested: boolean }
  }): Promise<CarrierExchange> {
    return this.request('POST', '/didcomm/confirm', body)
  }

  /** `authorize/1.0/request` inside a flow (flow profile §6.5, INTX-APPR-011). */
  public sendAuthorizeRequest(body: {
    connectionId: string
    flowId: string
    request: {
      requester: { name: string; role?: string | null; did?: string | null }
      purpose: { id: string; label: string }
      justification: string
      scope: string[]
      expiresAt: string
      attested: boolean
      /** present when the request is one of several decisions (FLOW-AUTH-004) */
      approvals?: AuthorizeApprovals
    }
  }): Promise<CarrierExchange> {
    return this.request('POST', '/didcomm/authorize', body)
  }

  // ---- authenticate/1.0 (flow profile §6.14, §6.4; CC-VSA-013) ---------------------------------------------------

  /**
   * `authenticate/1.0/request` inside an `authenticate` flow (FLOW-SIGNIN-001): the purpose, the methods and the accepted
   * combinations. Returns the exchange, whose `threadId` the later calls name.
   */
  public sendAuthenticateRequest(body: {
    connectionId: string
    flowId: string
    request: AuthenticateRequestBody
  }): Promise<AuthenticateExchange> {
    return this.request('POST', '/didcomm/authenticate', body)
  }

  /** A step of the combination chosen, or the current one sent again (FLOW-SIGNIN-008, FLOW-SIGNIN-010). */
  public sendAuthenticateStep(threadId: string, step: AuthenticateStepBody): Promise<AuthenticateExchange> {
    return this.request('POST', `/didcomm/authenticate/${encodeURIComponent(threadId)}/step`, { step })
  }

  /** The end of the current step: `passed`, `failed` or `expired`, with a reason of §11 when it did not pass. */
  public sendAuthenticateStepResult(
    threadId: string,
    result: { step: string; outcome: 'passed' | 'failed' | 'expired'; reason?: string }
  ): Promise<AuthenticateExchange> {
    return this.request('POST', `/didcomm/authenticate/${encodeURIComponent(threadId)}/step-result`, { result })
  }

  /** `enrol-challenge` (flow profile §6.4): the first, or a new one after a wrong code. The secret is sent, never kept. */
  public sendEnrolChallenge(threadId: string, challenge: EnrolChallengeBody): Promise<EnrolExchange> {
    return this.request('POST', `/didcomm/authenticate-enrol/${encodeURIComponent(threadId)}/challenge`, { challenge })
  }

  /** `notify/1.0/notification`: a wake-up, never for a flow (flow profile §6.10, INTX-NOTIFY-001). */
  public sendNotification(body: {
    connectionId: string
    notification: {
      conversationId: string
      sessionId?: string | null
      title: string
      preview?: string | null
      collapseKey: string
      priority: 'normal' | 'low'
    }
  }): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/notify', body)
  }

  /** Records that a holder's `reissue/1.0/request` was answered (by an issue flow or a flow problem report). */
  public markReissueAnswered(threadId: string): Promise<CarrierExchange> {
    return this.request('POST', `/didcomm/reissue/${encodeURIComponent(threadId)}/answered`)
  }

  /** `session-grant/1.0/grant`: the answer to a holder's request (flow profile §6.8, CHAN-BIND-014). */
  public grantSession(
    threadId: string,
    grant: { grant: string; sessionsUrl: string; expiresAt: string }
  ): Promise<CarrierExchange> {
    return this.request('POST', `/didcomm/session-grant/${encodeURIComponent(threadId)}/grant`, { grant })
  }

  /**
   * `peer-status/1.0/status`: where this agent stands with the peer of a connection (flow profile §4.1,
   * IDENT-STAT-001). It replaces the status sent before on the connection.
   */
  public sendPeerStatus(connectionId: string, status: PeerStatus): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/peer-status', { connectionId, status })
  }

  /**
   * Whether the DIDComm agent speaks `peer-status/1.0` (CC-VSA-012). Asked with a call that sends nothing: a
   * query with no connection, which a DIDComm agent with the protocol refuses as invalid and one without it
   * does not know. Throws when the DIDComm agent is out of reach or answers anything else.
   */
  public async supportsPeerStatus(): Promise<boolean> {
    const path = '/didcomm/peer-status/query'
    const response = await fetch(`${this.baseUrl}/v2${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{}',
    })
    if (response.status === 400) return true
    if (response.status === 404) return false
    throw new VsAgentError(response.status, path, await response.text())
  }

  /** `link-session/1.0/request` inside a flow (flow profile §6.7, CHAN-BIND-009/012). */
  public sendLinkSessionRequest(body: {
    connectionId: string
    flowId: string
    request: {
      agent: { did: string; name: string }
      browser: { description: string; platform: 'web' | 'ios' | 'android' }
      webOrigin: string
      startedAt: string
      invitationId: string
      codes?: string[] | null
    }
  }): Promise<CarrierExchange> {
    return this.request('POST', '/didcomm/link-session', body)
  }
}
