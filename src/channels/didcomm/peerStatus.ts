/**
 * Peer status (D71; IDENT-STAT-001..008, flow profile §4.1): the agent tells a peer where it stands with it. A
 * connection that completes says nothing of what its peer may do on it, and the agent's decision about the peer
 * is invisible from the peer's side. One message carries it: the rule by which the agent identifies the peer, the
 * methods and combinations it accepts (D125), what an identified person may enrol and has enrolled (D129), whether the
 * peer is identified, what is open to it on the connection, and the credentials an identified person may ask for again
 * when their wallet holds none (D156). It is sent once the Principal is resolved, before the
 * authentication the agent asks at connection, and again whenever a field changes.
 */

import { type AgentPack, authenticationModeOf, enrollableTypesOf } from '../../config/packTypes.js'
import { issuableAgain } from '../../core/issuance.js'
import type { ConnectionType, Principal } from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import { Authenticator } from './authenticate.js'
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
    /**
     * the methods the agent accepts, by name; a `credential` method with its schema and, when it accepts some
     * organizations only, their keys (`issuers`); absent with `none`
     */
    methods?: Record<string, { type: string; credential?: { jsonSchemaCredentialId: string }; issuers?: string[] }>
    /** the accepted combinations, each a list of method names; absent with `none` */
    combinations?: string[][]
    /** how the peer obtains what it lacks, in the operator's words; absent when the pack says nothing of it */
    obtain?: { text?: string; url?: string }
    /** the types an identified person may enrol (flow profile §6.4); to an identified receiver only */
    enrol?: string[]
    /** the types the identified person enrolled; to an identified receiver only */
    enrolled?: string[]
  }
  identified: boolean
  /** what the peer may use on the connection now */
  open: string[]
  /**
   * to an identified person: the credentials the agent issues to them again when their wallet holds none, by the JSON
   * schema credential of their schema, with the name a person reads (IDENT-STAT-009, INTX-ISSUE-022); absent when none
   */
  issuable?: { jsonSchemaCredentialId: string; label: string }[]
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

  /** the types a Principal enrolled (D129): what `authentication.enrolled` lists */
  public enrolledOf?: (principal: Principal) => Promise<string[]>

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
   * The rule follows from the agent-pack and from nothing else (IDENT-STAT-002): no accepted combination, `none`;
   * visitors let in, `optional`; the authentication required, `required`. With the rule go the methods enabled, a
   * `credential` method with the organizations it accepts when it lists any, the accepted combinations, and how what is
   * lacking is obtained, when the pack says it. A service is identified by its DID: nothing is asked of it
   * (IDENT-STAT-007).
   */
  public authenticationFor(connectionType: ConnectionType): PeerStatus['authentication'] {
    const authentication = connectionType === 'verifiable-user-agent' ? this.pack.identity.authentication : undefined
    const mode = authenticationModeOf(authentication)
    if (!authentication || !mode) return { rule: 'none' }
    const obtain = authentication.obtain
    return {
      rule: mode === 'required' ? 'required' : 'optional',
      methods: Object.fromEntries(
        Object.entries(authentication.methods).map(([name, method]) => [name, Authenticator.methodWire(method)])
      ),
      combinations: authentication.combinations.map((combination) => [...combination]),
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

  public async statusOf(principal: Principal): Promise<PeerStatus> {
    const authentication = this.authenticationFor(principal.connectionType)
    // a person is identified by an accepted authentication, a service by its trusted DID
    const person = principal.connectionType === 'verifiable-user-agent'
    const identified = person ? !!principal.identityCredentialRef : true
    // what an identified person may enrol, and has enrolled (IDENT-STAT-002, IDENT-AUTH-014)
    const enrol = person && identified && authentication.rule !== 'none' ? enrollableTypesOf(this.pack) : []
    if (enrol.length) {
      authentication.enrol = enrol
      authentication.enrolled = ((await this.enrolledOf?.(principal)) ?? []).filter((type) =>
        (enrol as string[]).includes(type)
      )
    }
    // what an identified person may ask for again when their wallet holds none (IDENT-STAT-009)
    const issuable = person && identified ? issuableAgain(this.pack, principal) : []
    return { authentication, identified, open: this.openFor(principal), ...(issuable.length ? { issuable } : {}) }
  }

  /**
   * A person connects to an agent that asks for the credential at connection, required or offered: nothing is
   * open until the request has an outcome, and the peer is told so before it is asked (IDENT-STAT-003).
   */
  public async identifying(connectionId: string): Promise<void> {
    const mode = authenticationModeOf(this.pack.identity.authentication)
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
    await this.tell(connectionId, await this.statusOf(principal), options.asked)
  }

  /**
   * The identity credential of a Principal no longer holds (IDENT-LIVE-004/005): it is identified no more, and
   * its sessions end with every pairing, so nothing is open to it (IDENT-STAT-005).
   */
  public async credentialInvalid(principal: Principal): Promise<void> {
    const connectionId = principal.capabilityChannelId
    if (!connectionId) return
    const { enrol: _enrol, enrolled: _enrolled, ...authentication } = (await this.statusOf(principal)).authentication
    await this.tell(connectionId, { authentication, identified: false, open: [] })
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
