/**
 * Client of the Verifiable Trust v4-compliant DIDComm agent's Admin API (VS Agent 2.x). The Admin
 * API is unprotected and reachable only inside the deployment (reference profile). TOOL-HTTP-003.
 */
import type { Logger } from '../../util/logger.js'

export interface VsAgentInfo {
  did: string
  version: string
}

export interface OutOfBandInvitation {
  outOfBandId: string
  invitationId: string
  invitation: Record<string, unknown>
  url: string
  shortUrl?: string
}

export interface ConnectionRecord {
  id: string
  state: string
  theirDid?: string
  theirLabel?: string
  outOfBandId: string | null
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

export interface PresentationRecord {
  proofExchangeId: string
  state: string
  connectionId?: string
  claims: { name: string; value: string }[]
  verified: boolean
  threadId?: string
  errorMessage?: string
  requestedCredentials?: RequestedCredential[]
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

  public async ready(): Promise<boolean> {
    try {
      await this.request('GET', '/agent/health/ready')
      return true
    } catch {
      return false
    }
  }

  public createOutOfBandInvitation(body: {
    goal?: string
    goalCode?: string
    label?: string
    imageUrl?: string
    shortUrl?: boolean
  }): Promise<OutOfBandInvitation> {
    return this.request('POST', '/didcomm/out-of-band', body)
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

  public offerCall(
    connectionId: string,
    callType: 'audio' | 'video' | 'service',
    parameters: Record<string, unknown>,
    description?: string,
    offerExpirationTime?: string
  ): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/calls', {
      connectionId,
      callType,
      parameters,
      description,
      offerExpirationTime,
    })
  }

  public endCall(connectionId: string, threadId: string): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/calls/end', { connectionId, threadId })
  }

  public requestEmrtd(connectionId: string): Promise<{ id: string }> {
    return this.request('POST', '/didcomm/mrtd/request-emrtd', { connectionId })
  }

  public requestPresentation(
    connectionId: string,
    requestedCredentials: RequestedCredential[],
    requireNonRevocation = true
  ): Promise<{ proofExchangeId: string }> {
    return this.request('POST', '/didcomm/presentation-request', {
      connectionId,
      requestedCredentials,
      requireNonRevocation,
      autoAccept: true,
    })
  }

  public getPresentation(proofExchangeId: string): Promise<PresentationRecord> {
    return this.request('GET', `/didcomm/presentations/${encodeURIComponent(proofExchangeId)}`)
  }
}
