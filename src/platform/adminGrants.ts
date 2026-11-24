/**
 * Admin grants (ayni-spec D132, RBAC-ADMIN-001 to 005; AG-UI profile §3.14): Show Admin, the phone's re-authentication,
 * and the time-boxed grant that opens Audit and Operations on the device that asked.
 *
 * - **Who:** a person whose roles hold `auditor` or `operator`, of those the agent-pack declares; anyone else is told
 *   nothing (`roles: []`) and refused a grant.
 * - **Show Admin** asks the person's phone to re-authenticate with the set of methods the agent-pack names
 *   (`admin.authentication.methods`): an `authenticate` flow of purpose `admin`. The request is answered at once; a second
 *   request of the same device while one waits answers the one that waits.
 * - **The grant** belongs to the device that asked and to the roles the person held at the confirmation. The device
 *   is its device handle; for the phone, whose every session made through a session grant gets a handle of its own, it
 *   is the phone's connection (`deviceOf`), so that the grant follows the phone to its next session, and to no other
 *   device and no other Principal. It lasts `admin.grantMinutes` (30 by default) from the confirmation: use never
 *   moves its end, and only a new confirmation opens a new one.
 * - **Its end:** its time, Hide Admin, a role it opened for lost, its device unlinked, the phone's connection closed.
 *   Each end, each opening and each request that opened none is told to every bound session of the device
 *   (`ayni.admin.changed`); the opening and the end are written to the admin audit.
 *
 * The grants are kept in the store (one key-value record), so that a restart neither ends nor extends them.
 */
import { type AuthenticationAttempt, sameActor } from '../channels/didcomm/authenticate.js'
import { type AdminRole, type AgentPack, adminGrantMinutes, adminRolesOf } from '../config/packTypes.js'
import type { Principal, Session } from '../core/types.js'
import type { KvRepo } from '../store/types.js'
import { prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { type AdminCaller, AdminError, type AdminService } from './admin.js'

/** The key of the open grants in the store's key-value records. */
const GRANTS_KEY = 'admin-grants'

/** An open admin grant (RBAC-ADMIN-003). */
export interface AdminGrant {
  id: string
  principalId: string
  /** the device it belongs to: `deviceOf` the session that asked */
  device: string
  /** the admin roles the person held at the confirmation */
  roles: AdminRole[]
  openedAt: string
  expiresAt: string
}

/** What became of a request or of a grant, as `ayni.admin.changed` says it (§5, PROF-ADMIN-004). */
export type AdminOutcome = 'opened' | 'declined' | 'failed' | 'expired' | 'ended'

/** The value of `ayni.admin.changed`. */
export interface AdminChanged {
  roles: AdminRole[]
  grant: { open: true; expiresAt: string } | null
  outcome?: AdminOutcome
}

/** What `GET {sessions}/admin` answers (PROF-ADMIN-001): nothing but `roles: []` to a person without an admin role. */
export type AdminState = { roles: [] } | { roles: AdminRole[]; grant: { open: true; expiresAt: string } | null }

/** What the phone's re-authentication ended in, as the request's outcome names it. */
export type ReauthenticationOutcome = 'accepted' | 'declined' | 'failed' | 'expired'

/** Why a grant ended. */
export type GrantEnd = 'expired' | 'hidden' | 'role-lost' | 'device-unlinked' | 'channel-closed'

export interface AdminGrantPorts {
  /**
   * Asks the person's phone to re-authenticate with the set of admin access, on their identified connection, for the
   * session that asked: an `authenticate` flow of purpose `admin` (IDENT-AUTH-015, RBAC-ADMIN-002)
   */
  reauthenticate(principal: Principal, session: Session, methods: string[]): Promise<ReauthenticationOutcome>
  /** the Principal as it is now: its roles follow the user directory */
  principal(id: string): Promise<Principal | undefined>
  /** `ayni.admin.changed` to every bound session of the device (PROF-ADMIN-004) */
  announce(principalId: string, device: string, value: AdminChanged): Promise<void>
  /**
   * The devices (`deviceOf`) of the Principal's sessions that carried a device handle: the handle itself, and the phone
   * when the handle was minted for one of its sessions, so that unlinking that handle ends the phone's grant too
   */
  devicesOfHandle?(principalId: string, handle: string): Promise<string[]>
}

/**
 * What an authentication of purpose `admin` ended in, for Show Admin: accepted only when it named the Principal of the
 * connection (IDENT-AUTH-015); a refusal is `failed`, a phone that did not answer in time `expired`, an authentication
 * already open on the connection `failed` too.
 */
export function reauthenticationOutcome(
  principal: Pick<Principal, 'actorIdentity'>,
  attempt: AuthenticationAttempt
): ReauthenticationOutcome {
  if (attempt.outcome === 'accepted') return sameActor(principal, attempt.facts) ? 'accepted' : 'failed'
  if (attempt.outcome === 'declined') return 'declined'
  if (attempt.outcome === 'unanswered') return 'expired'
  return 'failed'
}

/**
 * The device a session belongs to (RBAC-ADMIN-003): the phone, by its connection, for a session made through a session
 * grant or a sibling of one, since each of these gets a device handle of its own (`createFromGrant`); else its device
 * handle, or the session itself when it has none. A browser bound by the phone, or by a device secret, never carries
 * the connection: it is a device of its own.
 */
export function deviceOf(session: Pick<Session, 'id' | 'deviceHandle' | 'grantConnectionId'>): string {
  if (session.grantConnectionId) return `phone:${session.grantConnectionId}`
  return session.deviceHandle ?? `session:${session.id}`
}

export class AdminGrants {
  /** the open grants, by device */
  private readonly grants = new Map<string, AdminGrant>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** the request that waits for the phone, by device */
  private readonly pending = new Map<string, { requestId: string; expiresAt: string; done: Promise<void> }>()
  private loaded?: Promise<void>
  /** how long a request waits for the phone: the fifteen minutes of an `authenticate` flow (flow profile §6.14) */
  public requestMs: number

  public constructor(
    private readonly pack: Pick<AgentPack, 'identity' | 'admin'>,
    private readonly kv: KvRepo,
    private readonly service: AdminService,
    private readonly ports: AdminGrantPorts,
    private readonly logger: Logger,
    options: { requestMs: number }
  ) {
    this.requestMs = options.requestMs
  }

  /** The set of methods of the re-authentication (RBAC-ADMIN-002). */
  private get methods(): string[] {
    return this.pack.admin?.authentication?.methods ?? []
  }

  /** The admin roles a Principal holds now (RBAC-ADMIN-001). */
  public rolesOf(principal: Pick<Principal, 'roles'>): AdminRole[] {
    return adminRolesOf(this.pack, principal.roles)
  }

  // ---- the store ---------------------------------------------------------------------------------------------------

  /** Reads the grants kept before a restart: those still open get their end again, the others end now. */
  public restore(): Promise<void> {
    this.loaded ??= (async () => {
      const raw = await this.kv.get(GRANTS_KEY)
      const kept = raw ? (JSON.parse(raw) as AdminGrant[]) : []
      for (const grant of kept) this.grants.set(grant.device, grant)
      for (const grant of kept) this.arm(grant)
    })()
    return this.loaded
  }

  private async save(): Promise<void> {
    await this.kv.set(GRANTS_KEY, JSON.stringify([...this.grants.values()]))
  }

  /** Ends the grant at its time, by its own clock (RBAC-ADMIN-004). */
  private arm(grant: AdminGrant): void {
    clearTimeout(this.timers.get(grant.device))
    const ms = Date.parse(grant.expiresAt) - Date.now()
    const timer = setTimeout(
      () => {
        void this.end(grant.device, 'expired', grant.id).catch((err) =>
          this.logger.error({ err, grant: grant.id }, 'the end of an admin grant was not recorded')
        )
      },
      Math.max(ms, 0)
    )
    timer.unref?.()
    this.timers.set(grant.device, timer)
  }

  /** Stops the timers: the grants stay in the store, and the next process arms them again. */
  public stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  // ---- the state, Show Admin and Hide Admin (PROF-ADMIN-001 to 003) ------------------------------------------------

  /** The open grant of a device, of this Principal, that has not reached its end. */
  private async openGrant(principal: Principal, device: string): Promise<AdminGrant | undefined> {
    await this.restore()
    const grant = this.grants.get(device)
    if (!grant || grant.principalId !== principal.id) return undefined
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      await this.end(device, 'expired', grant.id)
      return undefined
    }
    return grant
  }

  /** What the person may do and whether the device holds an open grant (PROF-ADMIN-001). */
  public async state(principal: Principal, session: Session): Promise<AdminState> {
    const roles = this.rolesOf(principal)
    if (!roles.length) return { roles: [] }
    const grant = await this.openGrant(principal, deviceOf(session))
    if (grant?.roles.some((r) => !roles.includes(r))) {
      await this.end(grant.device, 'role-lost', grant.id)
      return { roles, grant: null }
    }
    return { roles, grant: grant ? { open: true, expiresAt: grant.expiresAt } : null }
  }

  /**
   * Show Admin (PROF-ADMIN-002, RBAC-ADMIN-002): asks the phone, and answers at once with the request; the outcome reaches
   * the device's sessions as `ayni.admin.changed`.
   */
  public async request(principal: Principal, session: Session): Promise<{ requestId: string; expiresAt: string }> {
    if (!this.rolesOf(principal).length)
      throw new AdminError(403, 'forbidden', 'admin access needs auditor or operator')
    await this.restore()
    const device = deviceOf(session)
    const waiting = this.pending.get(device)
    if (waiting) return { requestId: waiting.requestId, expiresAt: waiting.expiresAt }
    const requestId = prefixedId('admreq')
    const expiresAt = new Date(Date.now() + this.requestMs).toISOString()
    const done = this.confirm(principal, session, device, requestId).finally(() => {
      if (this.pending.get(device)?.requestId === requestId) this.pending.delete(device)
    })
    this.pending.set(device, { requestId, expiresAt, done })
    this.logger.info({ principalId: principal.id, requestId }, 'Show Admin: the phone is asked to re-authenticate')
    return { requestId, expiresAt }
  }

  /** The request that waits for a device, for the tests: resolves once it has ended. */
  public waitFor(session: Pick<Session, 'id' | 'deviceHandle' | 'grantConnectionId'>): Promise<void> {
    return this.pending.get(deviceOf(session))?.done ?? Promise.resolve()
  }

  /** The phone's answer, then the grant, counted from the confirmation (RBAC-ADMIN-003). */
  private async confirm(principal: Principal, session: Session, device: string, requestId: string): Promise<void> {
    let outcome: ReauthenticationOutcome
    try {
      outcome = await this.ports.reauthenticate(principal, session, this.methods)
    } catch (err) {
      this.logger.warn({ err, principalId: principal.id, requestId }, 'the re-authentication for admin access failed')
      outcome = 'failed'
    }
    // the roles the person holds at the confirmation, as the directory gives them now
    const now = await this.ports.principal(principal.id)
    const roles = now ? this.rolesOf(now) : []
    if (outcome !== 'accepted' || !now || !roles.length) {
      const said: AdminOutcome = outcome === 'accepted' ? 'failed' : outcome
      this.logger.info({ principalId: principal.id, requestId, outcome: said }, 'Show Admin opened no grant')
      const open = now ? await this.openGrant(now, device) : undefined
      await this.ports.announce(principal.id, device, {
        roles,
        grant: open ? { open: true, expiresAt: open.expiresAt } : null,
        outcome: said,
      })
      return
    }
    const confirmedAt = Date.now()
    const grant: AdminGrant = {
      id: prefixedId('admgrant'),
      principalId: now.id,
      device,
      roles,
      openedAt: new Date(confirmedAt).toISOString(),
      expiresAt: new Date(confirmedAt + adminGrantMinutes(this.pack) * 60_000).toISOString(),
    }
    // a new confirmation replaces the device's grant: its end is the new one's (RBAC-ADMIN-003)
    this.grants.set(device, grant)
    await this.save()
    this.arm(grant)
    await this.service.record(
      { kind: 'principal', principal: now, grantId: grant.id },
      {
        action: 'admin-grant-opened',
        reason: 'Show Admin',
        detail: { requestId, roles, methods: this.methods, expiresAt: grant.expiresAt, client: session.client },
      }
    )
    await this.ports.announce(now.id, device, {
      roles,
      grant: { open: true, expiresAt: grant.expiresAt },
      outcome: 'opened',
    })
  }

  /** Hide Admin (PROF-ADMIN-003): the device's grant ends at once; nothing to end is no error. */
  public async hide(principal: Principal, session: Session): Promise<void> {
    const grant = await this.openGrant(principal, deviceOf(session))
    if (grant) await this.end(grant.device, 'hidden', grant.id)
  }

  /**
   * Ends a device's grant and says so (RBAC-ADMIN-004): to its sessions (`ended`) and in the admin audit. `grantId`, when
   * given, ends that grant only, not one a new confirmation opened since.
   */
  public async end(device: string, why: GrantEnd, grantId?: string): Promise<void> {
    await this.restore()
    const grant = this.grants.get(device)
    if (!grant || (grantId && grant.id !== grantId)) return
    this.grants.delete(device)
    clearTimeout(this.timers.get(device))
    this.timers.delete(device)
    await this.save()
    const principal = await this.ports.principal(grant.principalId)
    // a Principal gone from the store is still the one the record names
    const caller = principal ?? ({ id: grant.principalId } as Principal)
    await this.service.record(
      { kind: 'principal', principal: caller, grantId: grant.id },
      { action: 'admin-grant-ended', reason: why, detail: { roles: grant.roles, openedAt: grant.openedAt, why } }
    )
    this.logger.info({ principalId: grant.principalId, grant: grant.id, why }, 'admin grant ended')
    await this.ports.announce(grant.principalId, device, {
      roles: principal ? this.rolesOf(principal) : [],
      grant: null,
      outcome: 'ended',
    })
  }

  /** Every grant of a Principal ends: its phone's connection closed (RBAC-ADMIN-004). */
  public async endForPrincipal(principalId: string, why: GrantEnd): Promise<void> {
    await this.restore()
    for (const grant of [...this.grants.values()])
      if (grant.principalId === principalId) await this.end(grant.device, why, grant.id)
  }

  /**
   * The grant of a device unlinked ends (IDENT-DEV-005): the handle's, and the phone's when the handle was one of its
   * sessions'; every device of the Principal when none is named.
   */
  public async deviceUnlinked(principalId: string, handle?: string): Promise<void> {
    if (handle === undefined) return this.endForPrincipal(principalId, 'device-unlinked')
    await this.restore()
    const devices = new Set([handle, ...((await this.ports.devicesOfHandle?.(principalId, handle)) ?? [])])
    for (const device of devices) {
      const grant = this.grants.get(device)
      if (grant?.principalId === principalId) await this.end(device, 'device-unlinked', grant.id)
    }
  }

  /** After a reload of the user directory: a grant whose Principal lost a role it opened for ends (RBAC-ADMIN-004). */
  public async review(): Promise<void> {
    await this.restore()
    for (const grant of [...this.grants.values()]) {
      const principal = await this.ports.principal(grant.principalId)
      const roles = principal ? this.rolesOf(principal) : []
      if (grant.roles.some((r) => !roles.includes(r))) await this.end(grant.device, 'role-lost', grant.id)
    }
  }

  // ---- Audit and Operations (RBAC-ADMIN-005) -----------------------------------------------------------------------

  /**
   * The caller of a call of Audit (`auditor`) or Operations (`operator`): `403 admin-closed` without an open grant for
   * the device, `403 not-auditor` or `not-operator` without the role, now or at the confirmation. A role lost ends the
   * grant.
   */
  public async require(principal: Principal, session: Session, role: AdminRole): Promise<AdminCaller> {
    const grant = await this.openGrant(principal, deviceOf(session))
    if (!grant) throw new AdminError(403, 'admin-closed', 'admin access is not open on this device')
    const roles = this.rolesOf(principal)
    const lost = grant.roles.some((r) => !roles.includes(r))
    if (lost) await this.end(grant.device, 'role-lost', grant.id)
    if (!roles.includes(role) || !grant.roles.includes(role))
      throw new AdminError(403, role === 'auditor' ? 'not-auditor' : 'not-operator', `the ${role} role is needed`)
    if (lost) throw new AdminError(403, 'admin-closed', 'admin access ended')
    return { kind: 'principal', principal, grantId: grant.id }
  }
}
