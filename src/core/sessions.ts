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
import type { ChannelType, ClientDescription, ClosureReason, Conversation, Principal, Session } from './types.js'

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
  /** a conversation was renamed, archived, unarchived or closed for good: every device of the person learns it */
  onConversationChanged?(conversation: Conversation): Promise<void>
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
      | 'pairing-invalid'
      | 'grant-used'
      | 'grant-expired'
      | 'final',
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

/** A 3.0 client sends free text as platform: it becomes the description and the platform is `web` (PROF-SESS-014). */
export function normalizeClient(client: ClientDescription): ClientDescription {
  const platform = client.platform === 'ios' || client.platform === 'android' ? client.platform : 'web'
  const description =
    client.description ?? (client.platform !== platform && client.platform !== 'web' ? client.platform : undefined)
  return { ...client, platform, ...(description ? { description } : {}) }
}

/** A session grant (D56, CHAN-BIND-014): single use, sixty seconds, bound to a Principal and its connection. */
export interface SessionGrant {
  principalId: string
  connectionId: string
  client: ClientDescription
  conversationId?: string
  newConversation: boolean
  expiresAt: string
  used: boolean
}

/** how many sessions of its conversation a session reads besides its own, newest first */
const LINEAGE_LIMIT = 30
const GRANT_PREFIX = 'session-grant:'
const MAX_GRANT_SECONDS = 60

export class SessionService {
  public readonly idleTimeoutSeconds: number
  public readonly bindingExpirySeconds: number
  public readonly grantExpirySeconds: number
  private readonly siblingsAllowed: boolean

  public constructor(
    private readonly store: Store,
    readonly pack: AgentPack,
    private readonly secret: string,
    private readonly minter: InvitationMinter,
    private readonly events: SessionEvents,
    private readonly logger: Logger,
    overrides: { idleTimeoutSeconds?: number; bindingExpirySeconds?: number; grantExpirySeconds?: number } = {}
  ) {
    this.idleTimeoutSeconds = overrides.idleTimeoutSeconds ?? pack.sessions?.idleTimeoutSeconds ?? 1800
    this.bindingExpirySeconds = overrides.bindingExpirySeconds ?? pack.sessions?.bindingExpirySeconds ?? 300
    this.grantExpirySeconds = Math.min(
      MAX_GRANT_SECONDS,
      Math.max(1, overrides.grantExpirySeconds ?? MAX_GRANT_SECONDS)
    )
    this.siblingsAllowed = pack.sessions?.siblingSessions ?? true
    this.pairingSlidingDays = pack.sessions?.devicePairing?.slidingDays ?? 30
    this.pairingMaxDays = pack.sessions?.devicePairing?.maxDays ?? 90
  }

  /** Device pairing window (D51, IDENT-DEV-004); sliding 0 disables silent binding. */
  public readonly pairingSlidingDays: number
  public readonly pairingMaxDays: number

  // ---- session grant (D56, CHAN-BIND-014, PROF-SESS-013) ------------------------------------------

  /** Mints a grant for a resolved Principal on its capability channel; only the hash is kept. */
  public async issueGrant(
    input: Omit<SessionGrant, 'expiresAt' | 'used'>
  ): Promise<{ grant: string; expiresAt: string }> {
    const grant = `sg_${randomBytes(24).toString('base64url')}`
    const expiresAt = new Date(Date.now() + this.grantExpirySeconds * 1000).toISOString()
    const record: SessionGrant = { ...input, expiresAt, used: false }
    await this.store.kv.set(GRANT_PREFIX + this.hash(`grant:${grant}`), JSON.stringify(record))
    this.logger.info({ principalId: input.principalId, connectionId: input.connectionId }, 'session grant issued')
    return { grant, expiresAt }
  }

  /** Consumes a grant; a reused or expired one is refused (PROF-SESS-013). */
  public async redeemGrant(grant: string): Promise<SessionGrant> {
    const key = GRANT_PREFIX + this.hash(`grant:${grant}`)
    const stored = await this.store.kv.get(key)
    if (!stored) throw new SessionError('unknown grant', 'grant-expired')
    const record = JSON.parse(stored) as SessionGrant
    if (record.used) throw new SessionError('grant already used', 'grant-used')
    if (Date.parse(record.expiresAt) < Date.now()) throw new SessionError('grant expired', 'grant-expired')
    record.used = true
    await this.store.kv.set(key, JSON.stringify(record))
    return record
  }

  /**
   * A session bound at creation from a grant: the Principal and capability channel of the connection that received
   * the grant, a device handle and a fresh secret, nothing asked on the channel (D56).
   */
  public async createFromGrant(
    client: ClientDescription,
    locale: string | undefined,
    principal: Principal,
    grant: SessionGrant,
    conversationId?: string,
    newConversation = false,
    resumeSessionId?: string
  ): Promise<{ session: Session; token: string }> {
    const { token, hash } = this.newToken()
    const id = prefixedId('ses')
    const session: Session = {
      id,
      principalId: principal.id,
      channelType: 'ag-ui',
      externalRef: id,
      state: 'bound',
      client,
      locale,
      conversationId: conversationId ?? grant.conversationId,
      newConversation: newConversation || grant.newConversation,
      resumedFromSessionId: resumeSessionId,
      tokenHash: hash,
      boundAt: nowIso(),
      lastActivityAt: nowIso(),
      createdAt: nowIso(),
      streamCursor: 0,
    }
    await this.applyResume(session, principal)
    await this.attachConversation(session, principal)
    this.rotateDevice(session, principal)
    await this.store.principals.save(principal)
    await this.store.sessions.save(session)
    this.logger.info({ sessionId: session.id, principalId: principal.id }, 'session bound from a grant')
    await this.events.onBound(session, principal)
    return { session, token }
  }

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
    await this.attachConversation(session, principal)
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
    resumeSessionId?: string,
    conversationId?: string,
    newConversation = false
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
      conversationId,
      newConversation,
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
    if (!old || old.principalId !== principal.id) {
      this.logger.warn({ sessionId: session.id, resume: wanted }, 'resume refused: not a session of this principal')
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
    resumeSessionId?: string,
    conversationId?: string,
    newConversation = false
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
      conversationId,
      newConversation,
      resumedFromSessionId: resumeSessionId,
      tokenHash: hash,
      boundAt: nowIso(),
      lastActivityAt: nowIso(),
      createdAt: nowIso(),
      streamCursor: 0,
    }
    await this.applyResume(session, principal)
    await this.attachConversation(session, principal)
    await this.store.sessions.save(session)
    await this.events.onBound(session, principal)
    return { session, token }
  }

  // ---- conversations (D52, IDENT-SESS-010..013) -------------------------------------------------

  /**
   * Every AG-UI session serves one conversation of its Principal: the one it names, the one of the
   * session it resumes, or a new one. The conversation's earlier sessions become the lineage.
   */
  private async attachConversation(session: Session, principal: Principal): Promise<void> {
    if (session.channelType !== 'ag-ui') return
    let wanted = session.conversationId
    if (!wanted && session.resumedFromSessionId) {
      wanted = (await this.store.sessions.get(session.resumedFromSessionId))?.conversationId
    }
    let conversation = wanted ? await this.store.conversations.get(wanted) : undefined
    if (conversation && (conversation.principalId !== principal.id || conversation.state === 'final')) {
      this.logger.warn({ sessionId: session.id, conversationId: wanted }, 'conversation not open to this session')
      conversation = undefined
      session.resumedFromSessionId = undefined
      session.lineage = undefined
    }
    // nothing named and no new conversation asked: a pairing continues the latest active one (PROF-CONV-006)
    if (!conversation && !wanted && !session.newConversation) {
      const latest = (await this.store.conversations.listByPrincipal(principal.id, ['active']))[0]
      if (latest) conversation = latest
    }
    const now = nowIso()
    if (!conversation) {
      conversation = {
        id: prefixedId('conv'),
        principalId: principal.id,
        channelType: session.channelType,
        title: '',
        state: 'active',
        createdAt: now,
        lastActivityAt: now,
        sessionIds: [],
      }
    }
    // one open session per device per conversation (IDENT-SESS-014): the newer one supersedes the older
    if (session.deviceHandle) {
      for (const id of conversation.sessionIds) {
        if (id === session.id) continue
        const other = await this.store.sessions.get(id)
        if (other?.state === 'bound' && other.deviceHandle === session.deviceHandle)
          await this.close(other, 'supersede')
      }
    }
    session.conversationId = conversation.id
    const earlier = conversation.sessionIds.filter((id) => id !== session.id)
    if (earlier.length) session.lineage = earlier.slice(0, LINEAGE_LIMIT)
    // one transcript for every session of the conversation (IDENT-SESS-016): the sessions already open on it,
    // those of the person's other devices, read what this one will carry as this one reads what they carried
    for (const id of earlier) {
      const other = await this.store.sessions.get(id)
      if (other?.state !== 'bound' || other.lineage?.includes(session.id)) continue
      other.lineage = [session.id, ...(other.lineage ?? [])].slice(0, LINEAGE_LIMIT)
      await this.store.sessions.save(other)
    }
    conversation.sessionIds = [session.id, ...earlier]
    // opening a conversation is not activity in it: its time and its place in the person's lists move with a
    // message (IDENT-SESS-013), where a device that merely opened one sent it to the top on every other device
    await this.store.conversations.save(conversation)
  }

  /**
   * The other sessions showing the conversation of this one: the person's other devices on it (IDENT-SESS-016).
   * What this session adds to the conversation is sent to them as it happens (PROF-STREAM-005).
   */
  public async conversationPeers(session: Session): Promise<Session[]> {
    if (session.channelType !== 'ag-ui' || !session.conversationId || !session.principalId) return []
    const open = await this.store.sessions.listByPrincipal(session.principalId, ['bound'])
    return open.filter(
      (s) => s.id !== session.id && s.channelType === 'ag-ui' && s.conversationId === session.conversationId
    )
  }

  /** The Principal's conversations, active and archived, newest activity first (PROF-CONV-001). */
  public async listConversations(principalId: string): Promise<(Conversation & { open: boolean })[]> {
    const open = new Set((await this.store.sessions.listByPrincipal(principalId, ['bound'])).map((s) => s.id))
    const list = await this.store.conversations.listByPrincipal(principalId, ['active', 'archived'])
    return list.map((c) => ({ ...c, open: c.sessionIds.some((id) => open.has(id)) }))
  }

  public async conversationOf(principal: Principal, id: string): Promise<Conversation> {
    const conversation = await this.store.conversations.get(id)
    if (!conversation || conversation.principalId !== principal.id)
      throw new SessionError('conversation not found', 'not-found')
    return conversation
  }

  /** Refuses a request that names a conversation this agent cannot open (final, PROF-CONV-004). */
  public async requireOpenable(conversationId?: string, resumeSessionId?: string): Promise<string | undefined> {
    let id = conversationId
    if (!id && resumeSessionId) id = (await this.store.sessions.get(resumeSessionId))?.conversationId
    if (!id) return undefined
    const conversation = await this.store.conversations.get(id)
    if (!conversation) throw new SessionError('conversation not found', 'not-found')
    if (conversation.state === 'final') throw new SessionError('conversation is final', 'final')
    return id
  }

  public async renameConversation(conversation: Conversation, title: string): Promise<Conversation> {
    conversation.title = title.trim().slice(0, 120)
    await this.store.conversations.save(conversation)
    await this.conversationChanged(conversation)
    return conversation
  }

  /** Tells the Principal's sessions that their list of conversations changed (PROF-CONV-007); never fails a call. */
  private async conversationChanged(conversation: Conversation): Promise<void> {
    await this.events
      .onConversationChanged?.(conversation)
      .catch((err) => this.logger.warn({ err, conversationId: conversation.id }, 'conversation change not announced'))
  }

  /** Archiving closes the conversation's open sessions (PROF-CONV-003); unarchiving only flips the state. */
  public async setConversationState(conversation: Conversation, state: 'active' | 'archived'): Promise<Conversation> {
    if (conversation.state === 'final') throw new SessionError('conversation is final', 'final')
    conversation.state = state
    await this.store.conversations.save(conversation)
    // announced before its sessions close, so the devices that had it open learn why
    await this.conversationChanged(conversation)
    if (state === 'archived') await this.closeConversationSessions(conversation)
    return conversation
  }

  /** Close for good (PROF-CONV-004): final, sessions closed, never listed or resumed again. */
  public async finalizeConversation(conversation: Conversation): Promise<Conversation> {
    conversation.state = 'final'
    await this.store.conversations.save(conversation)
    await this.conversationChanged(conversation)
    await this.closeConversationSessions(conversation)
    this.logger.info({ conversationId: conversation.id }, 'conversation closed for good')
    return conversation
  }

  private async closeConversationSessions(conversation: Conversation): Promise<void> {
    for (const id of conversation.sessionIds) {
      const s = await this.store.sessions.get(id)
      if (s && s.state !== 'closed') await this.close(s, 'user')
    }
  }

  /** A turn on a conversation keeps its title, preview and activity current (IDENT-SESS-013). */
  public async noteActivity(session: Session, text: string, opts: { title?: boolean } = {}): Promise<void> {
    if (!session.conversationId) return
    const conversation = await this.store.conversations.get(session.conversationId)
    if (!conversation || conversation.state === 'final') return
    const before = { title: conversation.title, state: conversation.state }
    if (conversation.state === 'archived') conversation.state = 'active' // writing unarchives (UI-SESS-012)
    if (opts.title && !conversation.title) conversation.title = text.trim().slice(0, 60)
    if (text.trim()) conversation.lastPreview = text.trim().slice(0, 120)
    conversation.lastActivityAt = nowIso()
    await this.store.conversations.save(conversation)
    // the first message names the conversation, a message unarchives it: the other devices' lists follow
    if (conversation.title !== before.title || conversation.state !== before.state)
      await this.conversationChanged(conversation)
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
  public async markConfirmationSent(
    session: Session,
    connectionId: string,
    questionThreadId: string,
    flowId?: string
  ): Promise<void> {
    if (!session.binding) return
    session.binding.connectionId = connectionId
    session.binding.questionThreadId = questionThreadId
    if (flowId) session.binding.flowId = flowId
    session.lastActivityAt = nowIso()
    await this.store.sessions.save(session)
  }

  /**
   * Provisional sessions whose binding question went to the connection in its question-answer form (no flow)
   * and is still open: unused, unexpired binding material.
   */
  public async listAwaitingConfirmation(connectionId: string): Promise<Session[]> {
    const now = Date.now()
    return (await this.store.sessions.listByState('provisional')).filter(
      (s) =>
        !!s.binding &&
        s.binding.connectionId === connectionId &&
        !!s.binding.questionThreadId &&
        !s.binding.flowId &&
        !s.binding.used &&
        Date.parse(s.binding.expiresAt) > now
    )
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
    await this.attachConversation(session, principal)
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
  public async closeAll(
    principalId: string,
    reason: ClosureReason,
    except?: string,
    states: ('provisional' | 'bound')[] = ['provisional', 'bound']
  ): Promise<number> {
    let n = 0
    for (const session of await this.store.sessions.listByPrincipal(principalId, states)) {
      if (session.id === except) continue
      await this.close(session, reason)
      n++
    }
    return n
  }

  /** Supersede: a new capability channel for an actor that already has one closes the old one and its sessions (IDENT-SESS-003). */
  public async supersede(principal: Principal, newChannelId: string): Promise<number> {
    if (principal.capabilityChannelId && principal.capabilityChannelId !== newChannelId) {
      // only sessions that depend on the old channel close; a provisional session is waiting to bind to the new one
      const closed = await this.closeAll(principal.id, 'supersede', undefined, ['bound'])
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
