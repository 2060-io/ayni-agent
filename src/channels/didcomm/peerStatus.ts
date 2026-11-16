/**
 * Peer status (D71; IDENT-STAT-001..008, flow profile §4.1): the agent tells a peer where it stands with it. A
 * connection that completes says nothing of what its peer may do on it, and the agent's decision about the peer
 * is invisible from the peer's side. One message carries it: the rule by which the agent identifies the peer,
 * whether it is identified, and what is open to it on the connection. It is sent once the Principal is resolved,
 * before the request for a credential the agent requires, and again whenever a field changes.
 */
import { type AgentPack, authenticationModeOf } from '../../config/packTypes.js'
import type { ConnectionType, Principal } from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import { type PeerProfiles, supportsProtocol } from './peerProfiles.js'
import type { VsAgentClient } from './vsAgentClient.js'

export const PEER_STATUS_PROTOCOL = 'https://didcomm.org/peer-status/1.0'
/** What a status lists as open for the conversation channel, and what a session grant is for by default. */
export const AG_UI_ENDPOINT = 'ag-ui'

export type PeerStatusRefusalCode =
  | 'untrusted'
  | 'not-admitted'
  | 'authentication-declined'
  | 'authentication-unanswered'

export interface PeerStatus {
  authentication: {
    rule: 'none' | 'optional' | 'required'
    /** the credential that identifies the peer; absent with `none` */
    credential?: { jsonSchemaCredentialId: string }
    /** the organizations whose credentials are accepted, by organization key; absent when any issuer is */
    issuers?: string[]
    /** how the peer obtains the credential, in the operator's words; absent when the pack says nothing of it */
    obtain?: { text?: string; url?: string }
  }
  identified: boolean
  /** what the peer may use on the connection now */
  open: string[]
  refusal?: { code: string; comment?: string }
}

/** How long a DIDComm agent found without the protocol is taken at its word before it is asked again. */
const PROBE_EVERY_MS = 60_000

export class PeerStatusNotifier {
  /** the last status told on a connection, so that the same one is not told twice */
  private readonly told = new Map<string, string>()
  /** whether the DIDComm agent of this agent speaks the protocol: unknown until it answered */
  private capable: boolean | undefined
  private probedAt = 0
  private probing?: Promise<boolean>

  public constructor(
    private readonly pack: AgentPack,
    private readonly client: Pick<VsAgentClient, 'sendPeerStatus' | 'supportsPeerStatus'>,
    private readonly peers: Pick<PeerProfiles, 'get'>,
    private readonly logger: Logger
  ) {}

  /**
   * What the descriptor declares (PROF-DESC-007): true once the DIDComm agent is known to speak the protocol,
   * and never before. A client waits for the status of an agent that declares it, so an agent whose DIDComm
   * agent cannot send one must not declare it. A DIDComm agent found without the protocol is asked again from
   * time to time: it may be upgraded while this agent runs.
   */
  public get declared(): boolean {
    if (this.capable !== true && Date.now() - this.probedAt > PROBE_EVERY_MS) void this.supported()
    return this.capable === true
  }

  /** Whether the DIDComm agent speaks the protocol; asked once, and again while the answer is no. */
  public supported(): Promise<boolean> {
    if (this.capable === true) return Promise.resolve(true)
    if (this.probing) return this.probing
    if (this.capable === false && Date.now() - this.probedAt <= PROBE_EVERY_MS) return Promise.resolve(false)
    this.probing = this.client
      .supportsPeerStatus()
      .then((capable) => {
        if (capable !== this.capable)
          this.logger.info(
            { capable },
            capable ? 'peer status: served' : 'peer status: not served by the DIDComm agent'
          )
        this.capable = capable
        this.probedAt = Date.now()
        return capable
      })
      // out of reach: nothing is known, and the next call asks again
      .catch(() => false)
      .finally(() => {
        this.probing = undefined
      })
    return this.probing
  }

  /**
   * The rule follows from the agent-pack and from nothing else (IDENT-STAT-002): no authentication schema,
   * `none`; guests let in, `optional`; the credential required, `required`. With the rule go the organizations
   * accepted, when the pack lists any, and how the credential is obtained, when it says it. A service is
   * identified by its DID: nothing is asked of it (IDENT-STAT-007).
   */
  public authenticationFor(connectionType: ConnectionType): PeerStatus['authentication'] {
    const entry = connectionType === 'verifiable-user-agent' ? this.pack.identity.authentication?.[0] : undefined
    if (!entry) return { rule: 'none' }
    const organizations = entry.issuers?.organizations
    const obtain = entry.obtain
    return {
      rule: authenticationModeOf(entry) === 'required' ? 'required' : 'optional',
      credential: { jsonSchemaCredentialId: entry.credential.jsonSchemaCredentialId },
      ...(organizations?.length ? { issuers: [...organizations] } : {}),
      ...(obtain?.text || obtain?.url
        ? { obtain: { ...(obtain.text ? { text: obtain.text } : {}), ...(obtain.url ? { url: obtain.url } : {}) } }
        : {}),
    }
  }

  /**
   * What is open to a Principal on its connection (IDENT-STAT-004): the conversation channel for a person,
   * when the agent serves it. What a service may open is deferred (O20).
   */
  public openFor(principal: Principal): string[] {
    const serves = this.pack.channels?.agui?.enabled !== false
    return serves && principal.connectionType === 'verifiable-user-agent' ? [AG_UI_ENDPOINT] : []
  }

  public statusOf(principal: Principal): PeerStatus {
    return {
      authentication: this.authenticationFor(principal.connectionType),
      // a person is identified by an accepted credential, a service by its trusted DID
      identified: principal.connectionType === 'verifiable-user-agent' ? !!principal.identityCredentialRef : true,
      open: this.openFor(principal),
    }
  }

  /**
   * A person connects to an agent that asks for the credential at connection, required or offered: nothing is
   * open until the request has an outcome, and the peer is told so before it is asked (IDENT-STAT-003).
   */
  public async identifying(connectionId: string): Promise<void> {
    const mode = authenticationModeOf(this.pack.identity.authentication?.[0])
    if (mode !== 'required' && mode !== 'offered') return
    await this.tell(connectionId, {
      authentication: this.authenticationFor('verifiable-user-agent'),
      identified: false,
      open: [],
    })
  }

  /**
   * The Principal of a connection is resolved, or changed: the peer is told where it stands (IDENT-STAT-001/005).
   * `asked` answers a query of the peer (IDENT-STAT-008): the status is sent even when it was told before, and
   * to a peer that asked without having disclosed the protocol.
   */
  public async resolved(connectionId: string, principal: Principal, options: { asked?: boolean } = {}): Promise<void> {
    await this.tell(connectionId, this.statusOf(principal), options.asked)
  }

  /**
   * The identity credential of a Principal no longer holds (IDENT-LIVE-004/005): it is identified no more, and
   * its sessions end with every pairing, so nothing is open to it (IDENT-STAT-005).
   */
  public async credentialInvalid(principal: Principal): Promise<void> {
    const connectionId = principal.capabilityChannelId
    if (!connectionId) return
    await this.tell(connectionId, { ...this.statusOf(principal), identified: false, open: [] })
  }

  /** The agent does not serve the peer: it is told why before the connection ends (IDENT-STAT-006). */
  public async refused(
    connectionId: string,
    connectionType: ConnectionType,
    code: PeerStatusRefusalCode,
    comment?: string
  ): Promise<void> {
    await this.tell(connectionId, {
      authentication: this.authenticationFor(connectionType),
      identified: false,
      open: [],
      refusal: { code, ...(comment ? { comment } : {}) },
    })
  }

  /** A connection that ended takes its status with it. */
  public forget(connectionId: string): void {
    this.told.delete(connectionId)
  }

  /** Whether the peer of a connection takes a status: it disclosed the protocol, as a receiver. */
  public async listens(connectionId: string): Promise<boolean> {
    const profile = await this.peers.get(connectionId)
    if (!profile || !supportsProtocol(profile, PEER_STATUS_PROTOCOL)) return false
    const id = profile.protocols.find(
      (p) => p === PEER_STATUS_PROTOCOL || p.startsWith('https://didcomm.org/peer-status/1.')
    )
    const roles = id ? profile.roles[id] : undefined
    return !roles || roles.includes('receiver')
  }

  private async tell(connectionId: string, status: PeerStatus, asked = false): Promise<void> {
    if (!(await this.supported())) return
    if (!asked && !(await this.listens(connectionId))) return
    const key = JSON.stringify(status)
    if (!asked && this.told.get(connectionId) === key) return
    try {
      await this.client.sendPeerStatus(connectionId, status)
      this.told.set(connectionId, key)
      this.logger.info(
        {
          connectionId,
          rule: status.authentication.rule,
          identified: status.identified,
          open: status.open,
          refusal: status.refusal?.code,
        },
        'peer told where it stands (IDENT-STAT-001)'
      )
    } catch (err) {
      this.logger.warn({ err, connectionId }, 'peer status not sent')
    }
  }
}
