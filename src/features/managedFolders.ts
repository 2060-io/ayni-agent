/**
 * A team space's folder, made and kept by the agent (ayni-spec D145 to D150, architecture §10.13; TOOL-FEAT-024 to 034).
 *
 * When the owner adds Files in the managed mode, the agent makes the space's folder at the provider with the profile's
 * `team-roots` (`files_create_team_root`, with a `requestId` the space and the feature fix, so that a retry makes no
 * second one), sets it as the feature's location, one entry, and keeps its members in step with the space's people with
 * the tools of `share`: each active member whose roles give a tool of the provider, a guest only where the template's
 * entry says `guests: true`, each named by the email of their directory entry or of their invitation, `editor` when their
 * roles give a tool that writes or deletes that the space does not set `off`, `reader` otherwise, and the owner and the
 * successor `manager` where the store has managers. It calls these tools with the managing account only (the space
 * owner's own account, or the managing account `manage.apply` builds), outside any conversation, and never gives them to
 * a model (TOOL-FEAT-025).
 *
 * Each change of the members is kept until it is done: removals first; one that fails for a reason that passes is tried
 * again after 1, 5 and 30 minutes, then every hour for a day; one that fails for a reason that stays waits for a change of
 * what it depends on or for the owner's Try again; a removal is tried every hour until it is done (TOOL-FEAT-028). Every
 * six hours the agent reads the folder's members and name back (TOOL-FEAT-027, TOOL-FEAT-030). The agent records only the
 * memberships it made, and no address: an address is read from the directory or the invitation at each change.
 */
import type { AgentPack, TemplateFeature } from '../config/packTypes.js'
import type { ConnectionService } from '../core/connections.js'
import type { SpaceService } from '../core/spaces.js'
import { SpaceError } from '../core/spaces.js'
import {
  AGENT_ACTOR,
  type FolderAccessReason,
  type FolderMembershipRecord,
  type GovernanceNotice,
  type ManagedFolderRecord,
  type Principal,
  type Space,
  type SpaceToolRecord,
} from '../core/types.js'
import { resolveTier } from '../policy/rbac.js'
import type { Store } from '../store/types.js'
import type { CatalogSource, ToolCatalog } from '../tools/catalog.js'
import type { McpServerSource } from '../tools/mcp.js'
import type { CallAccountSecret } from '../tools/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { FILES_1_0 } from './profiles.js'
import { FeatureService } from './service.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** The waits before each new try of a change that failed for a reason that passes (TOOL-FEAT-028). */
const RETRY_MINUTES = [1, 5, 30]
/** How long a change that fails for a reason that passes is tried, from its first failure (TOOL-FEAT-028). */
const RETRY_SPAN = 24 * HOUR
/** How often the folder's members and name are read back (TOOL-FEAT-027, TOOL-FEAT-030). */
export const REREAD_EVERY = 6 * HOUR

/** The codes of the profile that pass: tried again (TOOL-FEAT-028). A failed connection is one of them. */
const PASSING = ['unavailable', 'rate-limited']

/** The reasons of a refused recipient that a member's access takes as its own (files §4.7). */
const REFUSED: readonly FolderAccessReason[] = ['no-account', 'not-allowed', 'too-many']

/** What a team root's name may be (files §1, §4.7): 1 to 100 characters, no `/`, no control character, not `.` or `..`. */
export function folderNameError(name: unknown): string | undefined {
  if (typeof name !== 'string') return 'a name is a text'
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 100) return 'a name is 1 to 100 characters'
  if (trimmed === '.' || trimmed === '..' || /[/\p{Cc}]/u.test(trimmed))
    return 'a name holds no / and no control character'
  return undefined
}

/** The `requestId` of a space's folder: fixed by the space and the feature, so that a retry makes no second one. */
export function requestIdOf(spaceId: string, featureId: string): string {
  return `ayni-${spaceId}-${featureId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128)
}

/** A member the folder should hold, and as what (D146). */
interface Wanted {
  principal: Principal
  role: FolderMembershipRecord['role']
  /** read at each change from the directory or the invitation; never kept */
  address?: string
}

/** What a call of a tool of the profile with the managing account answered. */
type Answer = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; reason?: string }

export interface ManagedFoldersDeps {
  store: Store
  pack: AgentPack
  catalog: ToolCatalog
  spaces: SpaceService
  features: FeatureService
  logger: Logger
  /** the MCP server of a source of the catalog */
  server: (sourceId: string) => McpServerSource | undefined
  /** the email of a person's directory entry; none without one (D146) */
  emailOf: (principal: Principal) => string | undefined
  /** a person's name, as the owner reads it */
  nameOf: (principal: Principal) => string
}

export interface ManagedFoldersHooks {
  /**
   * the folder or a member's access changed: `ayni.space.tools.changed` to the owner's sessions and to that member's
   * (PROF-TOOL-041)
   */
  changed?: (space: Space, featureId: string, sourceId: string, principalIds: string[]) => Promise<void>
  /** a notice of a member's access entered, changed or was resolved (PROF-TOOL-042) */
  noticeChanged?: (notice: GovernanceNotice) => Promise<void>
}

/** What the owner reads of a managed folder, and a member (PROF-TOOL-041). */
export interface FolderView {
  title: string
  state?: ManagedFolderRecord['state']
  reason?: ManagedFolderRecord['reason'] | null
  managedWith?: ManagedFolderRecord['managedWith']
  webUrl?: string
  access?: { inPlace: number; pending: number; failed: number }
  addedOutside?: number
  myAccess?: 'in-place' | 'pending' | 'failed'
}

/** A member's access, as the owner reads it in the member list (PROF-SPACE-003). */
export interface MemberFolderAccess {
  state: 'in-place' | 'pending' | 'failed' | 'none'
  role?: FolderMembershipRecord['role']
  reason?: FolderAccessReason
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export class ManagedFolders {
  public hooks: ManagedFoldersHooks = {}
  /** each person's own accounts: the owner's, which manages a shared drive (D147) */
  public connections?: ConnectionService
  /** one change of a folder at a time: a tick, a request and a reload never act on one folder together */
  private readonly running = new Map<string, Promise<void>>()

  public constructor(private readonly deps: ManagedFoldersDeps) {}

  // ---- what the template and the provider allow (TOOL-FEAT-023, TOOL-FEAT-033) -------------------------------------

  /** Whether a source is a provider of Files that declares how its folders are managed. */
  public managesAt(source: CatalogSource): boolean {
    return !!source.manage && this.deps.catalog.profileOf(source)?.id === FILES_1_0.id
  }

  /** The modes of Files the template's entry allows (TOOL-FEAT-023): `either` when it says none. */
  public static allowed(entry: TemplateFeature, space: Pick<Space, 'kind'>): ('managed' | 'existing')[] {
    if (space.kind === 'organization') return ['existing']
    const mode = entry.location ?? 'either'
    return mode === 'either' ? ['managed', 'existing'] : [mode]
  }

  /**
   * The modes the owner is offered for a provider (PROF-TOOL-040): those the entry allows, `existing` alone for a provider
   * with no `manage`, or one whose server does not declare `team-roots` and `share` with the managing account
   * (TOOL-FEAT-033), as far as the agent knows it now.
   */
  public async locationsOf(
    space: Space,
    entry: TemplateFeature,
    source: CatalogSource
  ): Promise<('managed' | 'existing')[] | undefined> {
    if (this.deps.catalog.profileOf(source)?.id !== FILES_1_0.id) return undefined
    const allowed = ManagedFolders.allowed(entry, space)
    const manages = this.managesAt(source) && (await this.mayManage(space, source)) !== false
    const out = allowed.filter((mode) => mode === 'existing' || manages)
    return out.length ? out : ['existing']
  }

  /**
   * Whether the server declares `team-roots` and `share` with the managing account (TOOL-FEAT-033): undefined while that
   * account is not there to read it with.
   */
  public async mayManage(space: Space, source: CatalogSource, managerId?: string): Promise<boolean | undefined> {
    const account = await this.accountOf(space, source, managerId)
    if (!account) return undefined
    const state = await this.deps.features.declared(source, account, FeatureService.keyOf(account))
    if (state.conformant === undefined) return undefined
    if (!state.conformant) return false
    return !!state.declared?.includes('team-roots') && state.declared.includes('share')
  }

  /**
   * The managing account (D147, D150): `as: owner`, the own account of the Principal who manages the folder (its owner),
   * while it is connected; `as: manager`, the account `manage.apply` builds from the deployment's secrets.
   */
  private async accountOf(
    space: Space,
    source: CatalogSource,
    managerId?: string
  ): Promise<CallAccountSecret | undefined> {
    const manage = source.manage
    if (!manage) return undefined
    if (manage.as === 'manager') {
      const headers: Record<string, string> = {}
      for (const { header, value } of manage.apply ?? []) headers[header] = value
      return {
        kind: 'personal',
        accountId: `manage:${source.name}`,
        headers,
        secrets: Object.values(headers).sort((a, b) => b.length - a.length),
      }
    }
    const id = managerId ?? space.ownerPrincipalId
    const principal = id ? await this.deps.store.principals.get(id) : undefined
    if (!principal) return undefined
    const opened = await this.connections?.open(principal, source, space.id, false)
    return opened?.status === 'connected' ? opened.account : undefined
  }

  /** A call of a tool of the profile with the managing account, outside any conversation and with no record (TOOL-FEAT-025). */
  private async call(
    source: CatalogSource,
    account: CallAccountSecret,
    name: string,
    args: Record<string, unknown>
  ): Promise<Answer> {
    const server = this.deps.server(source.name)
    if (!server) return { ok: false, code: 'unavailable' }
    try {
      const result = await server.callTool(name, args, {
        account,
        logger: this.deps.logger,
        language: this.deps.pack.language.agent,
      } as never)
      const data = isObject(result.data) ? result.data : {}
      if (!result.isError) return { ok: true, data }
      const error = isObject(data.error) ? data.error : {}
      return {
        ok: false,
        code: typeof error.code === 'string' ? error.code : 'unavailable',
        ...(typeof error.reason === 'string' ? { reason: error.reason } : {}),
      }
    } catch {
      // the error may echo the request: the source is named, nothing of the account (TOOL-ACCESS-005)
      this.deps.logger.warn(
        { source: source.name, tool: name },
        'a call of a managed folder failed to reach its provider'
      )
      return { ok: false, code: 'unavailable' }
    }
  }

  // ---- the folder (TOOL-FEAT-024, TOOL-FEAT-025) -------------------------------------------------------------------

  /** The folder of a space's feature, if the agent manages one. */
  public async folderOf(spaceId: string, featureId: string): Promise<ManagedFolderRecord | undefined> {
    return this.deps.store.managedFolders.get(spaceId, featureId)
  }

  /** One change of a folder at a time. */
  private async serial(key: string, work: () => Promise<void>): Promise<void> {
    const before = this.running.get(key) ?? Promise.resolve()
    const next = before.catch(() => undefined).then(work)
    this.running.set(key, next)
    try {
      await next
    } finally {
      if (this.running.get(key) === next) this.running.delete(key)
    }
  }

  /**
   * The owner's change that adds Files in the managed mode applied (TOOL-FEAT-024): the folder is recorded `creating`,
   * named after the space's title, and made at once when the managing account is there.
   */
  public async start(space: Space, featureId: string, source: CatalogSource): Promise<void> {
    const now = nowIso()
    const folder: ManagedFolderRecord = {
      spaceId: space.id,
      featureId,
      sourceId: source.name,
      name: space.title.slice(0, 100),
      requestId: requestIdOf(space.id, featureId),
      state: 'creating',
      managedWith: source.manage?.as === 'manager' ? 'manager' : 'owner',
      ...(source.manage?.as === 'owner' && space.ownerPrincipalId
        ? { managerPrincipalId: space.ownerPrincipalId }
        : {}),
      addedOutside: [],
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.store.managedFolders.save(folder)
    await this.serial(`${space.id}|${featureId}`, () => this.create(space, folder, source))
  }

  /** When a change that failed for a reason that passes is tried next; none once it has been tried for a day. */
  private static nextTry(attempts: number, firstFailedAt: string | undefined, now: number): string | undefined {
    const first = firstFailedAt ? Date.parse(firstFailedAt) : now
    const wait = (RETRY_MINUTES[attempts - 1] ?? 60) * MINUTE
    if (now + wait - first > RETRY_SPAN) return undefined
    return new Date(now + wait).toISOString()
  }

  /** Makes the folder with the managing account and the same `requestId` each time (TOOL-FEAT-024, TOOL-FEAT-025). */
  private async create(space: Space, folder: ManagedFolderRecord, source: CatalogSource): Promise<void> {
    const account = await this.accountOf(space, source, folder.managerPrincipalId)
    if (!account) {
      await this.saveFolder(space, { ...folder, state: 'creating', reason: 'not-connected' })
      return
    }
    const answer = await this.call(source, account, 'files_create_team_root', {
      name: folder.name,
      requestId: folder.requestId,
    })
    const now = Date.now()
    if (!answer.ok) {
      if (PASSING.includes(answer.code)) {
        const attempts = folder.attempts + 1
        const firstFailedAt = folder.firstFailedAt ?? new Date(now).toISOString()
        const nextAttemptAt = ManagedFolders.nextTry(attempts, firstFailedAt, now)
        await this.saveFolder(space, {
          ...folder,
          attempts,
          firstFailedAt,
          ...(nextAttemptAt
            ? { state: 'creating', reason: 'unavailable', nextAttemptAt }
            : { state: 'failed', reason: 'unavailable', nextAttemptAt: undefined }),
        })
        return
      }
      await this.saveFolder(space, {
        ...folder,
        state: 'failed',
        reason: 'permission-denied',
        nextAttemptAt: undefined,
      })
      this.deps.logger.warn(
        { spaceId: space.id, source: source.name, code: answer.code },
        'the provider did not let the agent make the folder of a space'
      )
      return
    }
    const root = isObject(answer.data.root) ? answer.data.root : {}
    if (typeof root.ref !== 'string' || !root.ref) {
      await this.saveFolder(space, { ...folder, state: 'failed', reason: 'unavailable' })
      return
    }
    const declared = await this.deps.features.declared(source, account, FeatureService.keyOf(account))
    const made: ManagedFolderRecord = {
      ...folder,
      ref: root.ref,
      name: typeof root.title === 'string' && root.title ? root.title : folder.name,
      ...(typeof root.webUrl === 'string' ? { webUrl: root.webUrl } : {}),
      state: 'ready',
      reason: undefined,
      managers: declared.teamRootsManager === true,
      attempts: 0,
      firstFailedAt: undefined,
      nextAttemptAt: undefined,
    }
    // the account that made it is its first member (files §4.7): the owner, for a folder of the owner's own account
    if (made.managedWith === 'owner' && made.managerPrincipalId)
      await this.deps.store.folderMemberships.save({
        spaceId: space.id,
        featureId: folder.featureId,
        principalId: made.managerPrincipalId,
        role: made.managers ? 'manager' : 'editor',
        state: 'in-place',
        attempts: 0,
        updatedAt: nowIso(),
      })
    // what the store lists right after it is made is no one's the agent added later (D146)
    const shares = await this.call(source, account, 'files_shares', { root: root.ref, ref: root.ref })
    if (shares.ok && Array.isArray(shares.data.shares))
      made.baseline = shares.data.shares.flatMap((s) => (isObject(s) && typeof s.id === 'string' ? [s.id] : []))
    await this.saveFolder(space, made)
    await this.setLocation(space, made)
    await this.deps.spaces.record(space.id, space.ownerPrincipalId ?? AGENT_ACTOR, 'folder-created', {
      sourceId: source.name,
      featureId: folder.featureId,
    })
    this.deps.logger.info({ spaceId: space.id, source: source.name }, 'the folder of a space was made')
    await this.reconcileFolder(space, made, source)
  }

  /** The folder is the feature's location, one entry, which the owner does not change while it is managed (TOOL-FEAT-024). */
  private async setLocation(space: Space, folder: ManagedFolderRecord): Promise<void> {
    const record = await this.deps.store.spaceTools.get(space.id, folder.sourceId)
    if (!record?.added || !folder.ref) return
    const next: SpaceToolRecord = {
      ...record,
      list: { entries: [{ values: { [FILES_1_0.location.argument]: folder.ref }, label: folder.name }] },
      updatedAt: nowIso(),
    }
    await this.deps.store.spaceTools.save(next)
  }

  private async saveFolder(space: Space, folder: ManagedFolderRecord): Promise<void> {
    const before = await this.deps.store.managedFolders.get(folder.spaceId, folder.featureId)
    const saved = { ...folder, updatedAt: nowIso() }
    await this.deps.store.managedFolders.save(saved)
    if (before && (before.state !== saved.state || before.reason !== saved.reason || before.name !== saved.name))
      await this.hooks.changed?.(space, folder.featureId, folder.sourceId, [])
  }

  // ---- its members (TOOL-FEAT-026 to 028) --------------------------------------------------------------------------

  /** The people of a space who are active in it: its owner, its listed members, the people its rule takes in. */
  private async activePeople(space: Space): Promise<{ principal: Principal; role: string; address?: string }[]> {
    const rows = await this.deps.spaces.memberRows(space.id)
    const ids = new Set<string>()
    if (space.ownerPrincipalId) ids.add(space.ownerPrincipalId)
    for (const row of rows) if (row.principalId && row.state === 'active') ids.add(row.principalId)
    const candidates =
      space.membership.mode === 'rule'
        ? await this.deps.store.principals.list()
        : (await Promise.all([...ids].map((id) => this.deps.store.principals.get(id)))).filter(
            (p): p is Principal => !!p
          )
    const out: { principal: Principal; role: string; address?: string }[] = []
    for (const principal of candidates) {
      const access = await this.deps.spaces.access(principal, space.id)
      if (!access?.role || access.left) continue
      // a guest is named by the email of their invitation, a person of the organization by their directory entry's
      const row = rows.find((r) => r.principalId === principal.id && r.state === 'active')
      const address = access.role === 'guest' ? row?.email : this.deps.emailOf(principal)
      out.push({ principal, role: access.role, ...(address ? { address } : {}) })
    }
    return out
  }

  /**
   * The members the folder should hold, and as what (TOOL-FEAT-026): an active member whose roles give a tool of the
   * provider, a guest only with `guests: true`; `editor` with a tool that writes or deletes that the space does not set
   * `off`, `reader` otherwise; the owner and the successor `manager` where the store has managers.
   */
  private async wanted(space: Space, folder: ManagedFolderRecord, source: CatalogSource): Promise<Map<string, Wanted>> {
    const entry = this.entryOf(space, folder)
    const record = await this.deps.store.spaceTools.get(space.id, source.name)
    const out = new Map<string, Wanted>()
    for (const person of await this.activePeople(space)) {
      if (person.role === 'guest' && entry?.guests !== true) continue
      const tools = FILES_1_0.tools.filter(
        (t) =>
          t.capability !== 'team-roots' &&
          resolveTier(source.access, person.principal.roles, t.name, false).tier !== 'DENY'
      )
      if (!tools.length) continue
      const writes = tools.some(
        (t) => (t.effect === 'write' || t.effect === 'delete') && record?.calls[t.name] !== 'off'
      )
      const isOwner = person.principal.id === space.ownerPrincipalId
      const isSuccessor = person.principal.id === space.successorPrincipalId
      const role: Wanted['role'] =
        folder.managers && (isOwner || (folder.managedWith === 'owner' && isSuccessor))
          ? 'manager'
          : writes
            ? 'editor'
            : 'reader'
      out.set(person.principal.id, {
        principal: person.principal,
        role,
        ...(person.address ? { address: person.address } : {}),
      })
    }
    return out
  }

  private entryOf(space: Space, folder: ManagedFolderRecord): TemplateFeature | undefined {
    return this.deps.catalog.templateFeatures(space.templateId).find((e) => e.feature === folder.featureId)
  }

  /** Brings the members of every folder of a space in step with its people, at once (TOOL-FEAT-027). */
  public async reconcile(space: Space): Promise<void> {
    for (const folder of await this.foldersOf(space.id)) {
      const source = this.deps.catalog.source(folder.sourceId)
      if (source)
        await this.serial(`${space.id}|${folder.featureId}`, () => this.reconcileFolder(space, folder, source))
    }
  }

  private async foldersOf(spaceId: string): Promise<ManagedFolderRecord[]> {
    return (await this.deps.store.managedFolders.listAll()).filter((f) => f.spaceId === spaceId)
  }

  /**
   * One folder's members in step (TOOL-FEAT-026, 027, 028): the memberships to end first, then those to make or to change,
   * each with the managing account, those that wait for their next try left as they are; with no managing account, no
   * change is made with any other.
   */
  private async reconcileFolder(
    space: Space,
    given: ManagedFolderRecord,
    source: CatalogSource,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const folder = (await this.deps.store.managedFolders.get(given.spaceId, given.featureId)) ?? given
    if (folder.state !== 'ready' || !folder.ref) return
    const wanted = await this.wanted(space, folder, source)
    const memberships = await this.deps.store.folderMemberships.listByFolder(space.id, folder.featureId)
    const account = await this.accountOf(space, source, folder.managerPrincipalId)
    const now = Date.now()
    const due = (m: FolderMembershipRecord) => options.force || !m.nextAttemptAt || Date.parse(m.nextAttemptAt) <= now
    const touched = new Set<string>()
    // a membership ended goes first (TOOL-FEAT-027)
    for (const m of memberships) {
      if (wanted.has(m.principalId)) continue
      touched.add(m.principalId)
      if (!m.shareId) {
        await this.deps.store.folderMemberships.delete(space.id, folder.featureId, m.principalId)
        await this.resolveNotice(space, m.principalId)
        continue
      }
      if (!due(m) || !account) {
        if (m.state !== 'removing') await this.saveMembership({ ...m, state: 'removing' })
        continue
      }
      const answer = await this.call(source, account, 'files_unshare', {
        root: folder.ref,
        ref: folder.ref,
        share: m.shareId,
      })
      if (answer.ok || answer.code === 'not-found') {
        await this.deps.store.folderMemberships.delete(space.id, folder.featureId, m.principalId)
        await this.resolveNotice(space, m.principalId)
      }
      // a removal is never given up: every hour until it is done (TOOL-FEAT-028)
      else
        await this.saveMembership({
          ...m,
          state: 'removing',
          attempts: m.attempts + 1,
          nextAttemptAt: new Date(now + HOUR).toISOString(),
        })
    }
    // then those to make, or to give another role
    for (const [principalId, want] of wanted) {
      const m = memberships.find((each) => each.principalId === principalId)
      if (m?.state === 'in-place' && m.role === want.role) continue
      // a member with no email has no access, for the reason no-address (TOOL-FEAT-026)
      if (!want.address) {
        if (m?.reason !== 'no-address' || m.role !== want.role) {
          touched.add(principalId)
          await this.failed(
            space,
            folder,
            source,
            { ...(m ?? this.newMembership(folder, principalId)), role: want.role },
            'no-address',
            true
          )
        }
        continue
      }
      const changedRole = !!m && m.role !== want.role
      // one that failed for a reason that stays waits for a change it depends on, or the owner's Try again
      if (m?.state === 'failed' && !changedRole && !options.force && m.reason !== 'not-connected') continue
      if (m?.state === 'failed' && m.reason === 'not-connected' && !account) continue
      if (m && !changedRole && !due(m)) continue
      touched.add(principalId)
      const membership: FolderMembershipRecord = { ...(m ?? this.newMembership(folder, principalId)), role: want.role }
      if (!account) {
        await this.failed(space, folder, source, membership, 'not-connected', true)
        continue
      }
      const answer = await this.call(source, account, 'files_share', {
        root: folder.ref,
        ref: folder.ref,
        role: want.role,
        recipients: [{ address: want.address }],
      })
      if (answer.ok) {
        const address = want.address.toLowerCase()
        const shares = Array.isArray(answer.data.shares) ? answer.data.shares.filter(isObject) : []
        const mine =
          shares.find(
            (s) =>
              isObject(s.recipient) &&
              typeof s.recipient.address === 'string' &&
              s.recipient.address.toLowerCase() === address
          ) ?? shares[0]
        await this.saveMembership({
          ...membership,
          ...(typeof mine?.id === 'string' ? { shareId: mine.id } : {}),
          state: 'in-place',
          reason: undefined,
          attempts: 0,
          firstFailedAt: undefined,
          nextAttemptAt: undefined,
        })
        await this.resolveNotice(space, principalId)
        continue
      }
      if (answer.code === 'recipient-refused')
        await this.failed(
          space,
          folder,
          source,
          membership,
          REFUSED.includes(answer.reason as FolderAccessReason) ? (answer.reason as FolderAccessReason) : 'no-account',
          true
        )
      else if (PASSING.includes(answer.code)) await this.failed(space, folder, source, membership, 'unavailable', false)
      else await this.failed(space, folder, source, membership, 'permission-denied', true)
    }
    if (touched.size) await this.hooks.changed?.(space, folder.featureId, folder.sourceId, [...touched])
  }

  private newMembership(folder: ManagedFolderRecord, principalId: string): FolderMembershipRecord {
    return {
      spaceId: folder.spaceId,
      featureId: folder.featureId,
      principalId,
      role: 'reader',
      state: 'pending',
      attempts: 0,
      updatedAt: nowIso(),
    }
  }

  private async saveMembership(m: FolderMembershipRecord): Promise<void> {
    await this.deps.store.folderMemberships.save({ ...m, updatedAt: nowIso() })
  }

  /**
   * A change of a member that failed (TOOL-FEAT-028): kept, `failed` at once for a reason that stays, tried again for a
   * day for one that passes, then `failed`; the owner told by the activity and one notice of the space's Notifications.
   */
  private async failed(
    space: Space,
    folder: ManagedFolderRecord,
    source: CatalogSource,
    m: FolderMembershipRecord,
    reason: FolderAccessReason,
    stays: boolean
  ): Promise<void> {
    const now = Date.now()
    const attempts = m.attempts + 1
    const firstFailedAt = m.firstFailedAt ?? new Date(now).toISOString()
    const nextAttemptAt = stays ? undefined : ManagedFolders.nextTry(attempts, firstFailedAt, now)
    const state: FolderMembershipRecord['state'] = stays || !nextAttemptAt ? 'failed' : 'pending'
    const first = m.reason !== reason || m.state === 'in-place' || m.attempts === 0
    await this.saveMembership({ ...m, state, reason, attempts, firstFailedAt, nextAttemptAt })
    if (first) {
      await this.deps.spaces.record(space.id, AGENT_ACTOR, 'access-failed', {
        sourceId: source.name,
        featureId: folder.featureId,
        principalId: m.principalId,
        reason,
      })
      await this.notice(space, folder, source, m.principalId, reason)
    }
  }

  // ---- the notices of the owner (PROF-TOOL-042) ----------------------------------------------------------------------

  private async notice(
    space: Space,
    folder: ManagedFolderRecord,
    source: CatalogSource,
    principalId: string,
    reason: FolderAccessReason
  ): Promise<void> {
    if (!space.ownerPrincipalId) return
    const member = await this.deps.store.principals.get(principalId)
    const feature = this.deps.catalog.feature(folder.featureId)
    const open = (
      await this.deps.store.governanceNotices.list({ spaceId: space.id, kind: 'folder-access', open: true })
    ).find((n) => n.subject.memberPrincipalId === principalId && n.principalId === space.ownerPrincipalId)
    const subject: GovernanceNotice['subject'] = {
      space: { id: space.id, title: space.title },
      member: { name: member ? this.deps.nameOf(member) : principalId },
      feature: { id: folder.featureId, title: feature?.title ?? folder.featureId },
      source: { id: source.name, title: source.title },
      folder: { title: folder.name },
      folderReason: reason,
      memberPrincipalId: principalId,
    }
    const notice: GovernanceNotice = open
      ? { ...open, subject }
      : {
          id: prefixedId('ntc'),
          principalId: space.ownerPrincipalId,
          spaceId: space.id,
          kind: 'folder-access',
          at: nowIso(),
          subject,
        }
    await this.deps.store.governanceNotices.save(notice)
    await this.hooks.noticeChanged?.(notice)
  }

  /** A member's access in place, or no longer needed: the owner's notice of it ends (PROF-TOOL-042). */
  private async resolveNotice(space: Space, principalId: string): Promise<void> {
    for (const n of await this.deps.store.governanceNotices.list({
      spaceId: space.id,
      kind: 'folder-access',
      open: true,
    }))
      if (n.subject.memberPrincipalId === principalId) {
        const resolved = { ...n, resolvedAt: nowIso() }
        await this.deps.store.governanceNotices.save(resolved)
        await this.hooks.noticeChanged?.(resolved)
      }
  }

  // ---- a change of owner (TOOL-FEAT-029) ------------------------------------------------------------------------------

  /**
   * The owner of a space changed (TOOL-FEAT-029, D147). For a folder managed with the owner's own account, before anything
   * ends the former owner's accounts: the new owner made a `manager` with the account that still manages it, then the
   * former owner's role set from their membership or ended, then the new owner's account manages it. With no account that
   * still manages it, the folder is `needs-manager`: the members keep their access, and no member is changed. A folder of
   * the managing account changes only its members' roles.
   */
  public async ownerChanged(space: Space, change: { formerId?: string; newId?: string }): Promise<void> {
    for (const folder of await this.foldersOf(space.id)) {
      const source = this.deps.catalog.source(folder.sourceId)
      if (!source) continue
      await this.serial(`${space.id}|${folder.featureId}`, async () => {
        // the notices of the former owner end; the new owner is told of what still fails
        for (const n of await this.deps.store.governanceNotices.list({
          spaceId: space.id,
          kind: 'folder-access',
          open: true,
        }))
          if (n.principalId !== space.ownerPrincipalId) {
            const resolved = { ...n, resolvedAt: nowIso() }
            await this.deps.store.governanceNotices.save(resolved)
            await this.hooks.noticeChanged?.(resolved)
          }
        if (folder.managedWith === 'manager' || folder.state === 'creating' || folder.state === 'failed') {
          if (folder.managedWith === 'owner' && change.newId)
            await this.saveFolder(space, { ...folder, managerPrincipalId: change.newId })
          await this.reconcileFolder(space, folder, source)
          return
        }
        await this.handOver(space, folder, source, change)
      })
    }
  }

  private async handOver(
    space: Space,
    folder: ManagedFolderRecord,
    source: CatalogSource,
    change: { formerId?: string; newId?: string }
  ): Promise<void> {
    const formerAccount = await this.accountOf(space, source, folder.managerPrincipalId ?? change.formerId)
    const next = change.newId ? await this.deps.store.principals.get(change.newId) : undefined
    const address = next ? this.deps.emailOf(next) : undefined
    if (next && address && formerAccount && folder.ref) {
      const answer = await this.call(source, formerAccount, 'files_share', {
        root: folder.ref,
        ref: folder.ref,
        role: folder.managers ? 'manager' : 'editor',
        recipients: [{ address }],
      })
      if (answer.ok) {
        const shares = Array.isArray(answer.data.shares) ? answer.data.shares.filter(isObject) : []
        const mine =
          shares.find(
            (s) =>
              isObject(s.recipient) &&
              typeof s.recipient.address === 'string' &&
              s.recipient.address.toLowerCase() === address.toLowerCase()
          ) ?? shares[0]
        await this.saveMembership({
          spaceId: space.id,
          featureId: folder.featureId,
          principalId: next.id,
          role: folder.managers ? 'manager' : 'editor',
          ...(typeof mine?.id === 'string' ? { shareId: mine.id } : {}),
          state: 'in-place',
          attempts: 0,
          updatedAt: nowIso(),
        })
        // the former owner's role, or the end of their membership, while their account still manages it
        const handed = { ...folder, managerPrincipalId: folder.managerPrincipalId ?? change.formerId }
        await this.reconcileFolder(space, handed, source)
        await this.saveFolder(space, {
          ...((await this.folderOf(space.id, folder.featureId)) ?? folder),
          managerPrincipalId: next.id,
        })
        this.deps.logger.info({ spaceId: space.id, source: source.name }, 'the new owner of a space manages its folder')
        return
      }
    }
    // the new owner may manage it already, made a manager at the store by an administrator (D147)
    if (next && (await this.manages(space, folder, source, next))) {
      await this.saveFolder(space, {
        ...folder,
        managerPrincipalId: next.id,
        ...(folder.state === 'needs-manager' ? { state: 'ready', reason: undefined } : {}),
      })
      await this.reconcileFolder(space, { ...folder, state: 'ready', managerPrincipalId: next.id }, source)
      return
    }
    await this.saveFolder(space, {
      ...folder,
      state: 'needs-manager',
      reason: 'manager-gone',
      ...(next ? { managerPrincipalId: next.id } : {}),
    })
    await this.deps.spaces.record(space.id, AGENT_ACTOR, 'manager-needed', {
      sourceId: source.name,
      featureId: folder.featureId,
    })
    this.deps.logger.warn(
      { spaceId: space.id, source: source.name },
      'no account the agent holds manages the folder of a space'
    )
  }

  /** Whether a person's own account manages the folder now: their share of it is a manager's (D147). */
  private async manages(
    space: Space,
    folder: ManagedFolderRecord,
    source: CatalogSource,
    person: Principal
  ): Promise<boolean> {
    const account = await this.accountOf(space, source, person.id)
    const address = this.deps.emailOf(person)
    if (!account || !address || !folder.ref) return false
    const answer = await this.call(source, account, 'files_shares', { root: folder.ref, ref: folder.ref })
    if (!answer.ok || !Array.isArray(answer.data.shares)) return false
    return answer.data.shares.some(
      (s) =>
        isObject(s) &&
        s.role === 'manager' &&
        isObject(s.recipient) &&
        typeof s.recipient.address === 'string' &&
        s.recipient.address.toLowerCase() === address.toLowerCase()
    )
  }

  // ---- what the owner does of it (TOOL-FEAT-030, PROF-TOOL-043) --------------------------------------------------------

  /** The owner renames the folder, at once, with the managing account (TOOL-FEAT-030). */
  public async rename(space: Space, folder: ManagedFolderRecord, title: unknown, actorId: string): Promise<void> {
    const error = folderNameError(title)
    if (error) throw new SpaceError(error, 'bad-name', 'folder.title')
    const source = this.deps.catalog.source(folder.sourceId)
    if (!source || !folder.ref || folder.state === 'creating')
      throw new SpaceError('the folder is not made yet', 'source-unavailable')
    const name = (title as string).trim()
    await this.serial(`${space.id}|${folder.featureId}`, async () => {
      const account = await this.accountOf(space, source, folder.managerPrincipalId)
      if (!account)
        throw new SpaceError(`${source.title} cannot be reached with the account that manages it`, 'source-unavailable')
      const answer = await this.call(source, account, 'files_rename_root', { root: folder.ref, name })
      if (!answer.ok) {
        if (answer.code === 'invalid-argument')
          throw new SpaceError(`${source.title} does not take this name`, 'bad-name', 'folder.title')
        throw new SpaceError(`${source.title} did not rename the folder`, 'source-unavailable')
      }
      const root = isObject(answer.data.root) ? answer.data.root : {}
      const renamed = { ...folder, name: typeof root.title === 'string' && root.title ? root.title : name }
      await this.saveFolder(space, renamed)
      await this.setLocation(space, renamed)
      await this.deps.spaces.record(space.id, actorId, 'folder-renamed', {
        sourceId: source.name,
        featureId: folder.featureId,
      })
    })
  }

  /**
   * Check again (PROF-TOOL-043): a folder that waits for its managing account, failed or needs a manager, and every member
   * whose access failed, at once.
   */
  public async check(space: Space, folder: ManagedFolderRecord): Promise<void> {
    const source = this.deps.catalog.source(folder.sourceId)
    if (!source) return
    await this.serial(`${space.id}|${folder.featureId}`, async () => {
      const current = (await this.folderOf(space.id, folder.featureId)) ?? folder
      if (current.state === 'creating' || current.state === 'failed') {
        await this.create(space, { ...current, state: 'creating', attempts: 0, firstFailedAt: undefined }, source)
        return
      }
      if (current.state === 'needs-manager') {
        const owner = space.ownerPrincipalId ? await this.deps.store.principals.get(space.ownerPrincipalId) : undefined
        if (!owner || !(await this.manages(space, current, source, owner))) return
        await this.saveFolder(space, { ...current, state: 'ready', reason: undefined, managerPrincipalId: owner.id })
      }
      await this.reread(space, source)
      await this.reconcileFolder(space, current, source, { force: true })
    })
  }

  /**
   * Every six hours (TOOL-FEAT-027, TOOL-FEAT-030): the folder's members read back, each membership of the agent's own the
   * store no longer holds as recorded made again, the people the agent did not add counted by their names, and the name
   * the store gives the folder kept.
   */
  private async reread(space: Space, source: CatalogSource): Promise<void> {
    const folder = (await this.foldersOf(space.id)).find((f) => f.sourceId === source.name)
    if (!folder?.ref || folder.state !== 'ready') return
    const account = await this.accountOf(space, source, folder.managerPrincipalId)
    if (!account) return
    const listed = await this.call(source, account, 'files_shares', { root: folder.ref, ref: folder.ref })
    const next: ManagedFolderRecord = { ...folder, lastReadAt: nowIso() }
    if (listed.ok && Array.isArray(listed.data.shares)) {
      const shares = listed.data.shares.filter(isObject)
      const memberships = await this.deps.store.folderMemberships.listByFolder(space.id, folder.featureId)
      const wanted = await this.wanted(space, folder, source)
      const ours = new Set<string>()
      for (const m of memberships) {
        const address = wanted.get(m.principalId)?.address?.toLowerCase()
        const held = shares.find(
          (s) =>
            (m.shareId && s.id === m.shareId) ||
            (!!address && isObject(s.recipient) && String(s.recipient.address ?? '').toLowerCase() === address)
        )
        if (held && typeof held.id === 'string') ours.add(held.id)
        if (m.state !== 'in-place') continue
        if (!held || held.role !== m.role)
          // made again at the next change: the store no longer holds it as the agent made it
          await this.saveMembership({ ...m, state: 'pending', nextAttemptAt: undefined, attempts: 0 })
        else if (!m.shareId && typeof held.id === 'string') await this.saveMembership({ ...m, shareId: held.id })
      }
      const baseline = new Set(folder.baseline ?? [])
      next.addedOutside = shares
        .filter((s) => typeof s.id === 'string' && !ours.has(s.id) && !baseline.has(s.id) && s.inherited !== true)
        .map((s) => ({
          name:
            isObject(s.recipient) && typeof s.recipient.name === 'string' && s.recipient.name
              ? s.recipient.name
              : 'someone of the store',
        }))
    }
    const got = await this.call(source, account, 'files_get', { root: folder.ref, ref: folder.ref })
    const item = got.ok && isObject(got.data.item) ? got.data.item : undefined
    if (item && typeof item.name === 'string' && item.name) next.name = item.name
    if (item && typeof item.webUrl === 'string') next.webUrl = item.webUrl
    await this.saveFolder(space, next)
    if (next.name !== folder.name) await this.setLocation(space, next)
  }

  /**
   * The schedule of the agent, every minute (TOOL-FEAT-027, 028, 029): a folder still to make tried when it is due or its
   * managing account came; every folder's members in step, each change when it is due; every six hours the members and
   * the name read back, and a folder that needs a manager checked again.
   */
  public async tick(now = Date.now()): Promise<void> {
    for (const folder of await this.deps.store.managedFolders.listAll()) {
      const space = await this.deps.spaces.find(folder.spaceId)
      const source = this.deps.catalog.source(folder.sourceId)
      if (!space || !source) continue
      const stale = !folder.lastReadAt || now - Date.parse(folder.lastReadAt) >= REREAD_EVERY
      await this.serial(`${space.id}|${folder.featureId}`, async () => {
        if (folder.state === 'creating' && (!folder.nextAttemptAt || Date.parse(folder.nextAttemptAt) <= now)) {
          await this.create(space, folder, source)
          return
        }
        if (folder.state === 'needs-manager') {
          if (!stale) return
          const owner = space.ownerPrincipalId
            ? await this.deps.store.principals.get(space.ownerPrincipalId)
            : undefined
          if (owner && (await this.manages(space, folder, source, owner)))
            await this.saveFolder(space, { ...folder, state: 'ready', reason: undefined, managerPrincipalId: owner.id })
          else await this.saveFolder(space, { ...folder, lastReadAt: nowIso() })
          return
        }
        if (folder.state !== 'ready') return
        if (stale) await this.reread(space, source)
        await this.reconcileFolder(space, folder, source)
      })
    }
  }

  // ---- releasing it (TOOL-FEAT-032) -----------------------------------------------------------------------------------

  /**
   * Files removed, or its provider changed: the agent stops managing the folder and makes no call to the store for it; the
   * folder, its members and its files stay as they are (TOOL-FEAT-032).
   */
  public async release(space: Space, featureId: string, actorId: string): Promise<void> {
    const folder = await this.folderOf(space.id, featureId)
    if (!folder) return
    await this.serial(`${space.id}|${featureId}`, async () => {
      await this.deps.store.managedFolders.delete(space.id, featureId)
      await this.deps.store.folderMemberships.deleteByFolder(space.id, featureId)
      for (const n of await this.deps.store.governanceNotices.list({
        spaceId: space.id,
        kind: 'folder-access',
        open: true,
      })) {
        const resolved = { ...n, resolvedAt: nowIso() }
        await this.deps.store.governanceNotices.save(resolved)
        await this.hooks.noticeChanged?.(resolved)
      }
      await this.deps.spaces.record(space.id, actorId, 'folder-released', { sourceId: folder.sourceId, featureId })
      this.deps.logger.info(
        { spaceId: space.id, source: folder.sourceId },
        'the agent stopped managing the folder of a space'
      )
    })
  }

  // ---- what people read of it (PROF-TOOL-041, PROF-SPACE-003, TOOL-FEAT-028) -----------------------------------------

  /** A member's access to the folder of a space's feature: what the gate and the member's Files read (TOOL-FEAT-028). */
  public async accessOf(
    spaceId: string,
    featureId: string,
    principalId: string
  ): Promise<'in-place' | 'pending' | 'failed'> {
    const m = (await this.deps.store.folderMemberships.listByFolder(spaceId, featureId)).find(
      (each) => each.principalId === principalId
    )
    if (m?.state === 'in-place') return 'in-place'
    return m?.state === 'failed' ? 'failed' : 'pending'
  }

  /** The folder as the owner, or a member, reads it on the item of Files (PROF-TOOL-041). */
  public async view(space: Space, folder: ManagedFolderRecord, owner: boolean, readerId?: string): Promise<FolderView> {
    if (!owner)
      return {
        title: folder.name,
        ...(folder.webUrl ? { webUrl: folder.webUrl } : {}),
        myAccess: readerId ? await this.accessOf(space.id, folder.featureId, readerId) : 'pending',
      }
    const access = { inPlace: 0, pending: 0, failed: 0 }
    const source = this.deps.catalog.source(folder.sourceId)
    if (source && folder.state === 'ready') {
      const wanted = await this.wanted(space, folder, source)
      const memberships = await this.deps.store.folderMemberships.listByFolder(space.id, folder.featureId)
      for (const id of wanted.keys()) {
        const m = memberships.find((each) => each.principalId === id)
        if (m?.state === 'in-place') access.inPlace++
        else if (m?.state === 'failed') access.failed++
        else access.pending++
      }
    }
    return {
      title: folder.name,
      state: folder.state,
      reason: folder.reason ?? null,
      managedWith: folder.managedWith,
      ...(folder.webUrl ? { webUrl: folder.webUrl } : {}),
      access,
      addedOutside: folder.addedOutside.length,
    }
  }

  /** Each member's access, by Principal, and the people added outside, for the owner's member list (PROF-SPACE-003). */
  public async members(
    space: Space
  ): Promise<{ access: Map<string, MemberFolderAccess>; addedOutside: { name: string }[] } | undefined> {
    const folder = (await this.foldersOf(space.id))[0]
    const source = folder ? this.deps.catalog.source(folder.sourceId) : undefined
    if (!folder || !source) return undefined
    const wanted = folder.state === 'ready' ? await this.wanted(space, folder, source) : new Map<string, Wanted>()
    const memberships = await this.deps.store.folderMemberships.listByFolder(space.id, folder.featureId)
    const access = new Map<string, MemberFolderAccess>()
    for (const person of await this.activePeople(space)) {
      const want = wanted.get(person.principal.id)
      const m = memberships.find((each) => each.principalId === person.principal.id)
      if (!want) access.set(person.principal.id, { state: 'none' })
      else
        access.set(person.principal.id, {
          state: m?.state === 'in-place' ? 'in-place' : m?.state === 'failed' ? 'failed' : 'pending',
          role: want.role,
          ...(m?.reason && m.state !== 'in-place' ? { reason: m.reason } : {}),
        })
    }
    return { access, addedOutside: folder.addedOutside }
  }
}
