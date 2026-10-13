/**
 * The unified session model (D4, D5, D6, D36; IDENT-SESS; CHAN-BIND; PROF-SESS/BIND):
 * provisional sessions with one-time binding nonces, binding on a yes answer, sibling sessions,
 * supersede and channel-level closures, idle and binding-window reapers, opaque session tokens.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AgentPack } from '../config/packTypes.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { ChannelType, ClientDescription, ClosureReason, Principal, Session } from './types.js'

export interface InvitationMinter {
  /** obtains an Out-of-Band invitation from the DIDComm agent (CHAN-BIND-008) */
  mint(
    sessionId: string,
    client: ClientDescription
  ): Promise<{ invitationId: string; outOfBandId: string; url: string }>
}

export interface SessionEvents {
  onBound(session: Session, principal: Principal): Promise<void>
  onClosed(session: Session, reason: ClosureReason): Promise<void>
  onBindingRefreshed(session: Session): Promise<void>
}

export class SessionError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | 'not-found'
      | 'closed'
      | 'not-bound'
      | 'conflict'
      | 'unauthorized'
      | 'forbidden'
      | 'pairing-expired'
      | 'pairing-invalid',
    public readonly reason?: ClosureReason
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

/** Two groups of two symbols derived from the nonce; shown on both ends (D5, PROF-BIND-001). */
export function bindingCodeOf(nonce: string, secret: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const mac = createHmac('sha256', secret).update(`binding:${nonce}`).digest()
  const pick = (i: number) => alphabet[mac[i] % alphabet.length]
  return `${pick(0)}${pick(1)}-${pick(2)}${pick(3)}`
}

export class SessionService {
  public readonly idleTimeoutSeconds: number
  public readonly bindingExpirySeconds: number
  private readonly siblingsAllowed: boolean

  public constructor(
    private readonly store: Store,
    readonly pack: AgentPack,
    private readonly secret: string,
    private readonly minter: InvitationMinter,
    private readonly events: SessionEvents,
    private readonly logger: Logger,
    overrides: { idleTimeoutSeconds?: number; bindingExpirySeconds?: number } = {}
  ) {
    this.idleTimeoutSeconds = overrides.idleTimeoutSeconds ?? pack.sessions?.idleTimeoutSeconds ?? 1800
    this.bindingExpirySeconds = overrides.bindingExpirySeconds ?? pack.sessions?.bindingExpirySeconds ?? 300
    this.siblingsAllowed = pack.sessions?.siblingSessions ?? true
    this.pairingSlidingDays = pack.sessions?.devicePairing?.slidingDays ?? 30
    this.pairingMaxDays = pack.sessions?.devicePairing?.maxDays ?? 90
  }

  /** Device pairing window (D51, IDENT-DEV-004); sliding 0 disables silent binding. */
  public readonly pairingSlidingDays: number
  public readonly pairingMaxDays: number

  // ---- device pairing (D51, IDENT-DEV) ---------------------------------------------------------

  private newDeviceSecret(): { secret: string; hash: string } {
    const secret = `dsk_${randomBytes(24).toString('base64url')}`
    return { secret, hash: this.hash(`device:${secret}`) }
  }

  public proofMatches(device: { secretHash?: string }, proof: string): boolean {
    if (!device.secretHash) return false
    const a = Buffer.from(device.secretHash, 'hex')
    const b = Buffer.from(this.hash(`device:${proof}`), 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Why a pairing cannot bind silently, or undefined when it can. */
  public pairingState(device: { createdAt: string; lastUsedAt?: string; secretHash?: string }): 'expired' | undefined {
    if (this.pairingSlidingDays <= 0 || !device.secretHash) return 'expired'
    const day = 86_400_000
    const now = Date.now()
    if (now - Date.parse(device.lastUsedAt ?? device.createdAt) > this.pairingSlidingDays * day) return 'expired'
    if (now - Date.parse(device.createdAt) > this.pairingMaxDays * day) return 'expired'
    return undefined
  }

  /** Mints or rotates the device's secret; the session carries the plaintext until the client takes it. */
  private rotateDevice(session: Session, principal: Principal): void {
    const now = nowIso()
    let device = principal.devices?.find((d) => d.handle === session.deviceHandle)
    if (!device) {
      session.deviceHandle = prefixedId('dev', 24)
      device = { handle: session.deviceHandle, client: session.client, createdAt: now }
      principal.devices = [...(principal.devices ?? []).slice(-19), device]
    }
    const { secret, hash } = this.newDeviceSecret()
    device.secretHash = hash
    device.lastUsedAt = now
    device.client = session.client
    session.deviceSecret = secret
  }

  /** Binds a new session from a device proof, no phone round trip (IDENT-DEV-002/003). */
  public async bindWithProof(session: Session, principal: Principal, proof: string): Promise<Session> {
    if (session.state !== 'provisional') throw new SessionError('session is not provisional', 'conflict')
    const device = principal.devices?.find((d) => d.handle === session.deviceHandle)
    if (!device) throw new SessionError('unknown device', 'pairing-invalid')
    if (!this.proofMatches(device, proof)) {
      // a stale or copied secret: the pairing ends here, loudly (IDENT-DEV-003)
      principal.devices = (principal.devices ?? []).filter((d) => d.handle !== device.handle)
      await this.store.principals.save(principal)
      this.logger.warn({ principalId: principal.id, device: device.handle }, 'device proof mismatch, pairing revoked')
      throw new SessionError('device proof invalid', 'pairing-invalid')
    }
    const state = this.pairingState(device)
    if (state) throw new SessionError('pairing expired', 'pairing-expired')
    session.binding = undefined
    session.principalId = principal.id
    session.state = 'bound'
    session.boundAt = nowIso()
    session.lastActivityAt = nowIso()
    await this.applyResume(session, principal)
    this.rotateDevice(session, principal)
    // older sessions of this device must not hand out the superseded secret through their status
    for (const other of await this.store.sessions.listByPrincipal(principal.id, ['bound'])) {
      if (other.deviceHandle === session.deviceHandle && other.deviceSecret) {
        other.deviceSecret = undefined
        await this.store.sessions.save(other)
      }
    }
    await this.store.principals.save(principal)
    await this.store.sessions.save(session)
    this.logger.info(
      { sessionId: session.id, principalId: principal.id, device: session.deviceHandle },
      'session bound from device proof'
    )
    await this.events.onBound(session, principal)
    return session
  }

  public async revokeDevice(principal: Principal, handle: string): Promise<boolean> {
    const before = principal.devices?.length ?? 0
    principal.devices = (principal.devices ?? []).filter((d) => d.handle !== handle)
    if (principal.devices.length === before) return false
    await this.store.principals.save(principal)
    this.logger.info({ principalId: principal.id, device: handle }, 'device pairing revoked')
    return true
  }

  public async revokeAllDevices(principal: Principal): Promise<void> {
    if (!principal.devices?.length) return
    principal.devices = []
    await this.store.principals.save(principal)
    this.logger.info({ principalId: principal.id }, 'all device pairings revoked')
  }

  // ---- tokens (PROF-SESS-002/004) ---------------------------------------------------------------

  private hash(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('hex')
  }

  public newToken(): { token: string; hash: string } {
    const token = `hst_${randomBytes(32).toString('base64url')}`
    return { token, hash: this.hash(token) }
  }

  public async authenticate(token: string | undefined): Promise<Session> {
    if (!token) throw new SessionError('missing token', 'unauthorized')
    const session = await this.store.sessions.findByTokenHash(this.hash(token))
    if (!session?.tokenHash || !timingSafeEqual(Buffer.from(session.tokenHash), Buffer.from(this.hash(token)))) {
      throw new SessionError('invalid token', 'unauthorized')
    }
    if (session.state === 'closed') throw new SessionError('session closed', 'closed', session.closedReason)
    return session
  }

  public requireBound(session: Session): asserts session is Session & { principalId: string } {
    if (session.state !== 'bound' || !session.principalId) throw new SessionError('session is not bound', 'not-bound')
  }

  // ---- creation ---------------------------------------------------------------------------------

  /** Channel-first: a provisional session with fresh binding material (CHAN-BIND-002/003/008). */
  public async createProvisional(
    channelType: ChannelType,
    client: ClientDescription,
    locale?: string,
    deviceHandle?: string,
    resumeSessionId?: string
  ): Promise<{ session: Session; token: string }> {
    const { token, hash } = this.newToken()
    const id = prefixedId('ses')
    const session: Session = {
      id,
      principalId: null,
      channelType,
      externalRef: id,
      state: 'provisional',
      client,
      locale,
      deviceHandle,
      resumedFromSessionId: resumeSessionId,
      tokenHash: hash,
      lastActivityAt: nowIso(),
      createdAt: nowIso(),
      streamCursor: 0,
    }
    session.binding = await this.mintBinding(session)
    await this.store.sessions.save(session)
    return { session, token }
  }

  private async mintBinding(session: Session): Promise<Session['binding']> {
    const minted = await this.minter.mint(session.id, session.client)
    return {
      nonce: minted.invitationId,
      outOfBandId: minted.outOfBandId,
      oobUrl: minted.url,
      bindingCode: bindingCodeOf(minted.invitationId, this.secret),
      expiresAt: new Date(Date.now() + this.bindingExpirySeconds * 1000).toISOString(),
      used: false,
    }
  }

  /** PROF-BIND-007: fresh material only once the current material expired. */
  public async refreshBinding(session: Session): Promise<Session> {
    if (session.state !== 'provisional') throw new SessionError('session is not provisional', 'conflict')
    if (session.binding && !session.binding.used && Date.parse(session.binding.expiresAt) > Date.now()) {
      throw new SessionError('binding material still valid', 'conflict')
    }
    session.binding = await this.mintBinding(session)
    session.lastActivityAt = nowIso()
    await this.store.sessions.save(session)
    await this.events.onBindingRefreshed(session)
    return session
  }

  /** DIDComm-first (CHAN-BIND-001) and A2A: a session opened already bound to a resolved Principal. */
  public async createBound(
    channelType: ChannelType,
    externalRef: string,
    principal: Principal,
    client: ClientDescription,
    withToken = false
  ): Promise<{ session: Session; token?: string }> {
    const minted = withToken ? this.newToken() : undefined
    const session: Session = {
      id: prefixedId('ses'),
      principalId: principal.id,
      channelType,
      externalRef,
      state: 'bound',
      client,
      tokenHash: minted?.hash,
      boundAt: nowIso(),
      lastActivityAt: nowIso(),
      createdAt: nowIso(),
      streamCursor: 0,
    }
    await this.store.sessions.save(session)
    return { session, token: minted?.token }
  }

  /**
   * A session may resume a closed session of the same Principal (IDENT-SESS-009): the closed
   * session's entries become readable here. A session of another Principal is never resumed.
   */
  private async applyResume(session: Session, principal: Principal): Promise<void> {
    const wanted = session.resumedFromSessionId
    if (!wanted) return
    const old = await this.store.sessions.get(wanted)
    if (old?.state !== 'closed' || old.principalId !== principal.id) {
      this.logger.warn(
        { sessionId: session.id, resume: wanted },
        'resume refused: not a closed session of this principal'
      )
      session.resumedFromSessionId = undefined
      return
    }
    session.lineage = [old.id, ...(old.lineage ?? [])].slice(0, 10)
    if (!session.client.name && old.client.name) session.client = old.client
  }

  /** Sibling session from a bound token (CHAN-BIND-010, PROF-SESS-007/008). */
  public async createSibling(
    parent: Session,
    client: ClientDescription,
    locale?: string,
    resumeSessionId?: string
  ): Promise<{ session: Session; token: string }> {
    this.requireBound(parent)
    if (!this.siblingsAllowed) throw new SessionError('sibling sessions are disabled', 'forbidden')
    const principal = await this.store.principals.get(parent.principalId)
    if (!principal) throw new SessionError('principal missing', 'not-bound')
    const { token, hash } = this.newToken()
    const id = prefixedId('ses')
    const session: Session = {
      id,
      principalId: principal.id,
      channelType: parent.channelType,
      externalRef: id,
      state: 'bound',
      client,
      locale: locale ?? parent.locale,
      parentSessionId: parent.id,
      deviceHandle: parent.deviceHandle,
      resumedFromSessionId: resumeSessionId,
      tokenHash: hash,
      boundAt: nowIso(),
      lastActivityAt: nowIso(),
      createdAt: nowIso(),
      streamCursor: 0,
    }
    await this.applyResume(session, principal)
    await this.store.sessions.save(session)
    await this.events.onBound(session, principal)
    return { session, token }
  }

  // ---- binding (D5, CHAN-BIND-003/009, PROF-BIND-002/004) ---------------------------------------

  public async findProvisionalByOutOfBandId(outOfBandId: string): Promise<Session | undefined> {
    const session = await this.store.sessions.findByOutOfBandId(outOfBandId)
    return session && session.state === 'provisional' ? session : undefined
  }

  /** Manual pairing from the capability channel: the person types the code shown on the screen. */
  public async findProvisionalByCode(code: string): Promise<Session | undefined> {
    const wanted = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (wanted.length !== 4) return undefined
    const now = Date.now()
    return (await this.store.sessions.listByState('provisional')).find(
      (s) =>
        s.binding &&
        !s.binding.used &&
        Date.parse(s.binding.expiresAt) > now &&
        s.binding.bindingCode.replace('-', '') === wanted
    )
  }

  public async findProvisionalByNonce(nonce: string): Promise<Session | undefined> {
    const session = await this.store.sessions.findByNonce(nonce)
    return session && session.state === 'provisional' ? session : undefined
  }

  /** Records that the invitation was accepted on a connection and the confirmation question was sent. */
  public async markConfirmationSent(session: Session, connectionId: string, questionThreadId: string): Promise<void> {
    if (!session.binding) return
    session.binding.connectionId = connectionId
    session.binding.questionThreadId = questionThreadId
    session.lastActivityAt = nowIso()
    await this.store.sessions.save(session)
  }

  public async findByConfirmation(connectionId: string, threadId: string): Promise<Session | undefined> {
    return this.store.sessions.findByQuestionThread(connectionId, threadId)
  }

  /** Binds on the yes answer correlated to the exact nonce; a used, expired or wrong nonce is refused. */
  public async bind(session: Session, principal: Principal, nonce: string): Promise<Session> {
    if (session.state !== 'provisional' || !session.binding)
      throw new SessionError('session is not provisional', 'conflict')
    const b = session.binding
    if (b.used || b.nonce !== nonce) throw new SessionError('nonce mismatch or reused', 'conflict')
    if (Date.parse(b.expiresAt) < Date.now()) throw new SessionError('binding material expired', 'conflict')
    b.used = true
    session.principalId = principal.id
    session.state = 'bound'
    session.boundAt = nowIso()
    session.lastActivityAt = nowIso()
    await this.applyResume(session, principal)
    // the phone confirmed this device: it becomes a paired device with a fresh secret (D48, D51)
    this.rotateDevice(session, principal)
    await this.store.principals.save(principal)
    await this.store.sessions.save(session)
    this.logger.info({ sessionId: session.id, principalId: principal.id }, 'session bound')
    await this.events.onBound(session, principal)
    return session
  }

  // ---- lifecycle (D6, IDENT-SESS-002..006) ----------------------------------------------------

  public async touch(session: Session): Promise<void> {
    session.lastActivityAt = nowIso()
    await this.store.sessions.save(session)
  }

  public async close(session: Session, reason: ClosureReason): Promise<Session> {
    if (session.state === 'closed') return session
    session.state = 'closed'
    session.closedAt = nowIso()
    session.closedReason = reason
    // the token stays known so that later calls answer 410 with the reason (PROF-SESS-004)
    await this.store.sessions.save(session)
    this.logger.info({ sessionId: session.id, reason }, 'session closed')
    await this.events.onClosed(session, reason)
    return session
  }

  /** Closes every session of a Principal (supersede, channel closure, identity failure). */
  public async closeAll(principalId: string, reason: ClosureReason, except?: string): Promise<number> {
    let n = 0
    for (const session of await this.store.sessions.listByPrincipal(principalId, ['provisional', 'bound'])) {
      if (session.id === except) continue
      await this.close(session, reason)
      n++
    }
    return n
  }

  /** Supersede: a new capability channel for an actor that already has one closes the old one and its sessions (IDENT-SESS-003). */
  public async supersede(principal: Principal, newChannelId: string): Promise<number> {
    if (principal.capabilityChannelId && principal.capabilityChannelId !== newChannelId) {
      const closed = await this.closeAll(principal.id, 'supersede')
      this.logger.info({ principalId: principal.id, closed }, 'capability channel superseded')
      return closed
    }
    return 0
  }

  public async reap(): Promise<{ idle: number; expired: number }> {
    const now = Date.now()
    let idle = 0
    let expired = 0
    for (const session of await this.store.sessions.listByState('bound')) {
      if (session.channelType === 'didcomm') continue // the capability channel lives as long as the connection
      if (now - Date.parse(session.lastActivityAt) > this.idleTimeoutSeconds * 1000) {
        await this.close(session, 'idle-timeout')
        idle++
      }
    }
    for (const session of await this.store.sessions.listByState('provisional')) {
      // a provisional session never bound within its window closes with reason expired (IDENT-SESS, profile section 5)
      const windowMs = this.bindingExpirySeconds * 1000 * 3
      if (now - Date.parse(session.createdAt) > windowMs) {
        await this.close(session, 'expired')
        expired++
      }
    }
    return { idle, expired }
  }

  public async get(id: string): Promise<Session | undefined> {
    return this.store.sessions.get(id)
  }

  public async listOpen(principalId: string): Promise<Session[]> {
    return this.store.sessions.listByPrincipal(principalId, ['bound'])
  }
}
