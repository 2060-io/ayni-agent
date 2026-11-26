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
import { CODE_ONLY_CAPABILITIES, FILES_1_0, toolsInUse } from './profiles.js'
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

/**
 * What a call of a tool of the profile with the managing account answered: `not-connected` and `scope-missing` when the
 * managing account itself cannot act (not connected, refused by the store, or without a scope it needs).
 */
type Answer =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: string; reason?: string; retryAfterSeconds?: number }

/**
 * The tools a team space's folder is managed with (TOOL-FEAT-025): the agent's code calls them, never a model; the owner's
 * own account grants their scopes, which the owner's sign-in asks for in that space.
 */
export const MANAGING_TOOLS: readonly string[] = [
  'files_create_team_root',
  'files_rename_root',
  'files_shares',
  'files_share',
  'files_unshare',
]

/** The codes that say the managing account cannot act, whatever the call: not connected or refused, or a scope missing. */
function accountReason(code: string): 'not-connected' | 'scope-missing' | undefined {
  if (code === 'not-connected' || code === 'account-refused') return 'not-connected'
  return code === 'scope-missing' ? 'scope-missing' : undefined
}

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

/**
 * The address a store gives of a folder, kept only when it is an `https` one: the clients open it as a link, and what a
 * store answers is not trusted (TOOL-FEAT-017).
 */
export function httpsUrlOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return new URL(value).protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export class ManagedFolders {
  public hooks: ManagedFoldersHooks = {}
  /** each person's own accounts: the owner's, which manages a shared drive (D147) */
  public connections?: ConnectionService
  /** one change of a folder at a time: a tick, a request and a reload never act on one folder together */
  private readonly running = new Map<string, Promise<void>>()
  /** the managing account of `as: manager` changes only with the deployment's secrets, at a start */
  private readonly startedAt = nowIso()

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
    if (opened?.status !== 'connected') return undefined
    // an account that lacks a scope the tools of management declare cannot act (TOOL-FEAT-025, TOOL-OAUTH-013)
    if (await this.lacksScope(principal, source, space.id)) return undefined
    return opened.account
  }

  /**
   * Whether the owner's own account, connected, lacks a scope that the tools of management declare at the provider
   * (TOOL-FEAT-025): the folder then waits as `scope-missing`, and nothing is asked of the store.
   */
  private async lacksScope(principal: Principal, source: CatalogSource, spaceId: string): Promise<boolean> {
    const needs = MANAGING_TOOLS.flatMap((t) => source.tools[t]?.scopes ?? [])
    if (!needs.length) return false
    const granted = await this.connections?.grantedIn(principal, source, spaceId)
    return granted !== undefined && needs.some((s) => !granted.includes(s))
  }

  /** Whether the owner's own account is connected and lacks a scope of management, for the folder's line. */
  private async scopeMissing(space: Space, source: CatalogSource, managerId?: string): Promise<boolean> {
    if (source.manage?.as !== 'owner') return false
    const id = managerId ?? space.ownerPrincipalId
    const principal = id ? await this.deps.store.principals.get(id) : undefined
    if (!principal) return false
    if ((await this.connections?.open(principal, source, space.id, false))?.status !== 'connected') return false
    return this.lacksScope(principal, source, space.id)
  }

  /**
   * The tools whose scopes the Principal's sign-in of a provider asks in a space beside those of the model's tools: the
   * tools of management, for the Principal who manages the space's folder at that provider with their own account
   * (TOOL-FEAT-025, TOOL-OAUTH-012).
   */
  public async managingToolsFor(principal: Principal, source: CatalogSource, spaceId: string): Promise<string[]> {
    if (!this.managesAt(source) || source.manage?.as !== 'owner' || !source.feature) return []
    const folder = await this.folderOf(spaceId, source.feature)
    if (!folder || folder.sourceId !== source.name) return []
    const space = await this.deps.spaces.find(spaceId)
    return (folder.managerPrincipalId ?? space?.ownerPrincipalId) === principal.id ? [...MANAGING_TOOLS] : []
  }

  /**
   * What names the managing account as it is now (TOOL-FEAT-028): a change that failed because it cannot act waits until
   * this changes, a new sign-in of the owner or a start of the agent with the deployment's secrets.
   */
  private async managingKey(space: Space, source: CatalogSource, managerId?: string): Promise<string | undefined> {
    if (source.manage?.as === 'manager') return `manage:${source.name}@${this.startedAt}`
    const id = managerId ?? space.ownerPrincipalId
    const principal = id ? await this.deps.store.principals.get(id) : undefined
    if (!principal) return undefined
    const fingerprint = await this.connections?.fingerprintIn(principal, source, space.id)
    // a sign-in that grants more of the same account changes it too (TOOL-OAUTH-013)
    const granted = await this.connections?.grantedIn(principal, source, space.id)
    return fingerprint && granted ? `${fingerprint}|${granted.join(' ')}` : fingerprint
  }

  /**
   * The managing account a change of the folder runs with now: none while it is not connected, or while the store refused
   * it as it still is (TOOL-FEAT-025, TOOL-FEAT-028).
   */
  private async usableAccount(
    space: Space,
    folder: ManagedFolderRecord,
    source: CatalogSource
  ): Promise<CallAccountSecret | undefined> {
    if (
      folder.refusedAccount &&
      folder.refusedAccount === (await this.managingKey(space, source, folder.managerPrincipalId))
    )
      return undefined
    return this.accountOf(space, source, folder.managerPrincipalId)
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
      if (result.accountOutcome)
        return { ok: false, code: result.accountOutcome === 'more-access-needed' ? 'scope-missing' : 'not-connected' }
      if (!result.isError) return { ok: true, data }
      const error = isObject(data.error) ? data.error : {}
      return {
        ok: false,
        code: typeof error.code === 'string' ? error.code : 'unavailable',
        ...(typeof error.reason === 'string' ? { reason: error.reason } : {}),
        ...(typeof error.retryAfterSeconds === 'number' && error.retryAfterSeconds > 0
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
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

  /**
   * When a change that failed for a reason that passes is tried next, after 1, 5 and 30 minutes then every hour, or after
   * the store's `retryAfterSeconds`; none once it has been tried for a day (TOOL-FEAT-028).
   */
  private static nextTry(
    attempts: number,
    firstFailedAt: string | undefined,
    now: number,
    retryAfterSeconds?: number
  ): string | undefined {
    const first = firstFailedAt ? Date.parse(firstFailedAt) : now
    const wait = retryAfterSeconds ? retryAfterSeconds * 1000 : (RETRY_MINUTES[attempts - 1] ?? 60) * MINUTE
    if (now + wait - first > RETRY_SPAN) return undefined
    return new Date(now + wait).toISOString()
  }

  /**
   * Makes the folder with the managing account and the same `requestId` each time (TOOL-FEAT-024, TOOL-FEAT-025): while
   * that account is not connected, refused or without a scope, the folder stays `creating` with the reason, tried again
   * once the account changes; a failure that passes is tried again on the schedule of TOOL-FEAT-028; one the store
   * refuses leaves it `failed`.
   */
  private async create(space: Space, folder: ManagedFolderRecord, source: CatalogSource): Promise<void> {
    const account = await this.usableAccount(space, folder, source)
    if (!account) {
      const missing = await this.scopeMissing(space, source, folder.managerPrincipalId)
      await this.saveFolder(space, {
        ...folder,
        state: 'creating',
        reason: missing || folder.reason === 'scope-missing' ? 'scope-missing' : 'not-connected',
        nextAttemptAt: undefined,
      })
      return
    }
    const answer = await this.call(source, account, 'files_create_team_root', {
      name: folder.name,
      requestId: folder.requestId,
    })
    const now = Date.now()
    if (!answer.ok) {
      const cannot = accountReason(answer.code)
      if (cannot) {
        await this.saveFolder(space, {
          ...folder,
          state: 'creating',
          reason: cannot,
          nextAttemptAt: undefined,
          refusedAccount: await this.managingKey(space, source, folder.managerPrincipalId),
        })
        return
      }
      if (PASSING.includes(answer.code)) {
        const attempts = folder.attempts + 1
        const firstFailedAt = folder.firstFailedAt ?? new Date(now).toISOString()
        const nextAttemptAt = ManagedFolders.nextTry(attempts, firstFailedAt, now, answer.retryAfterSeconds)
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
      state: 'ready',
      reason: undefined,
      managers: declared.teamRootsManager === true,
      attempts: 0,
      firstFailedAt: undefined,
      nextAttemptAt: undefined,
      refusedAccount: undefined,
      lastReadAt: nowIso(),
    }
    // where a person opens it, when the store has such an address (PROF-TOOL-041)
    const got = await this.call(source, account, 'files_get', { root: root.ref, ref: root.ref })
    const item = got.ok && isObject(got.data.item) ? got.data.item : undefined
    const webUrl = httpsUrlOf(item?.webUrl)
    if (webUrl) made.webUrl = webUrl
    // what the store lists right after it is made is the account that made it (files §4.7): with the owner's own
    // account, the owner's membership; any other, no one's the agent added (D146)
    const shares = await this.call(source, account, 'files_shares', { root: root.ref, ref: root.ref })
    const listed = shares.ok && Array.isArray(shares.data.shares) ? shares.data.shares.filter(isObject) : []
    const owner = made.managedWith === 'owner' && made.managerPrincipalId ? made.managerPrincipalId : undefined
    const ownerPrincipal = owner ? await this.deps.store.principals.get(owner) : undefined
    const ownerShare = ownerPrincipal ? ManagedFolders.shareOf(listed, this.deps.emailOf(ownerPrincipal)) : undefined
    made.baseline = listed.flatMap((s) => (typeof s.id === 'string' && s !== ownerShare ? [s.id] : []))
    if (owner)
      await this.deps.store.folderMemberships.save({
        spaceId: space.id,
        featureId: folder.featureId,
        principalId: owner,
        role: made.managers ? 'manager' : 'editor',
        ...(typeof ownerShare?.id === 'string' ? { shareId: ownerShare.id } : {}),
        state: 'in-place',
        attempts: 0,
        updatedAt: nowIso(),
      })
    await this.saveFolder(space, made)
    await this.setLocation(space, made)
    await this.deps.spaces.record(space.id, space.ownerPrincipalId ?? AGENT_ACTOR, 'folder-created', {
      sourceId: source.name,
      featureId: folder.featureId,
    })
    this.deps.logger.info({ spaceId: space.id, source: source.name }, 'the folder of a space was made')
    await this.reconcileFolder(space, made, source)
  }

  /** The share of an address among those a store lists: the recipient's address, compared without case. */
  private static shareOf(
    shares: Record<string, unknown>[],
    address: string | undefined
  ): Record<string, unknown> | undefined {
    if (!address) return undefined
    const wanted = address.toLowerCase()
    return shares.find(
      (s) =>
        isObject(s.recipient) && typeof s.recipient.address === 'string' && s.recipient.address.toLowerCase() === wanted
    )
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
    const inUse = await this.toolsOfProvider(space, folder, source)
    const out = new Map<string, Wanted>()
    for (const person of await this.activePeople(space)) {
      if (person.role === 'guest' && entry?.guests !== true) continue
      const tools = inUse.filter(
        (t) => resolveTier(source.access, person.principal.roles, t.name, false).tier !== 'DENY'
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

  /**
   * The tools of the profile the provider gives in the space (TOOL-FEAT-010): the core, and the capabilities in use as
   * the server declares them for the managing account, the source's `capabilities` and the tools of the code's own left
   * out; the core alone while that account is not there to read it with.
   */
  private async toolsOfProvider(space: Space, folder: ManagedFolderRecord, source: CatalogSource) {
    const account = await this.accountOf(space, source, folder.managerPrincipalId)
    const state = account
      ? await this.deps.features.declared(source, account, FeatureService.keyOf(account))
      : { capabilities: [] as string[] }
    return toolsInUse(
      FILES_1_0,
      state.capabilities.filter((c) => !CODE_ONLY_CAPABILITIES.includes(c))
    )
  }

  private entryOf(space: Space, folder: ManagedFolderRecord): TemplateFeature | undefined {
    return this.deps.catalog.templateFeatures(space.templateId).find((e) => e.feature === folder.featureId)
  }

  /**
   * Brings the members of every folder of a space in step with its people, at once (TOOL-FEAT-027); a folder that needs a
   * manager is checked again at each change of the space (TOOL-FEAT-029).
   */
  public async reconcile(space: Space): Promise<void> {
    for (const folder of await this.foldersOf(space.id)) {
      const source = this.deps.catalog.source(folder.sourceId)
      if (!source) continue
      await this.serial(`${space.id}|${folder.featureId}`, async () => {
        if (folder.state === 'needs-manager') await this.rescue(space, folder, source)
        else await this.reconcileFolder(space, folder, source)
      })
    }
  }

  /** Every space's folders in step: after a reload of the directory, which changes roles and who a rule takes in. */
  public async reconcileAll(): Promise<void> {
    const spaceIds = new Set((await this.deps.store.managedFolders.listAll()).map((f) => f.spaceId))
    for (const id of spaceIds) {
      const space = await this.deps.spaces.find(id)
      if (space) await this.reconcile(space)
    }
  }

  private async foldersOf(spaceId: string): Promise<ManagedFolderRecord[]> {
    return (await this.deps.store.managedFolders.listAll()).filter((f) => f.spaceId === spaceId)
  }

  /** The address a member is named by at the store, read now: their directory entry's, or a guest's invitation's (D146). */
  private async addressOf(space: Space, principalId: string): Promise<string | undefined> {
    const principal = await this.deps.store.principals.get(principalId)
    if (!principal) return undefined
    const access = await this.deps.spaces.access(principal, space.id)
    if (access?.role !== 'guest') return this.deps.emailOf(principal)
    return (await this.deps.spaces.memberRows(space.id)).find((r) => r.principalId === principalId)?.email
  }

  /**
   * One folder's members in step (TOOL-FEAT-026, 027, 028): the memberships to end first, then those to make or to change,
   * each with the managing account, those that wait for their next try left as they are; with no managing account that
   * can act, no change is made with any other.
   */
  private async reconcileFolder(
    space: Space,
    given: ManagedFolderRecord,
    source: CatalogSource,
    options: { force?: boolean } = {}
  ): Promise<void> {
    let folder = (await this.deps.store.managedFolders.get(given.spaceId, given.featureId)) ?? given
    if (folder.state !== 'ready' || !folder.ref) return
    const ref = folder.ref
    const wanted = await this.wanted(space, folder, source)
    const memberships = await this.deps.store.folderMemberships.listByFolder(space.id, folder.featureId)
    let account = await this.usableAccount(space, folder, source)
    const now = Date.now()
    const due = (m: FolderMembershipRecord) => options.force || !m.nextAttemptAt || Date.parse(m.nextAttemptAt) <= now
    const touched = new Set<string>()
    // the store refused the managing account, or found a scope missing: nothing more is tried with it until it changes
    const refused = async () => {
      account = undefined
      folder = { ...folder, refusedAccount: await this.managingKey(space, source, folder.managerPrincipalId) }
      await this.saveFolder(space, folder)
    }
    // a membership ended goes first (TOOL-FEAT-027)
    for (const m of memberships) {
      if (wanted.has(m.principalId)) continue
      touched.add(m.principalId)
      // one never made at the store ends here
      if (m.state !== 'in-place' && m.state !== 'removing' && !m.shareId) {
        await this.deps.store.folderMemberships.delete(space.id, folder.featureId, m.principalId)
        await this.resolveNotice(space, m.principalId)
        continue
      }
      if (!due(m) || !account) {
        if (m.state !== 'removing') await this.saveMembership({ ...m, state: 'removing' })
        continue
      }
      const shareId = m.shareId ?? (await this.lookupShare(space, source, account, ref, m.principalId))
      const answer = shareId
        ? await this.call(source, account, 'files_unshare', { root: ref, ref, share: shareId })
        : ({ ok: false, code: 'not-found' } as const)
      if (answer.ok || answer.code === 'not-found') {
        if (!shareId)
          this.deps.logger.warn(
            { spaceId: space.id, source: source.name },
            'a membership of a managed folder had no share the store still lists: its record ends'
          )
        await this.deps.store.folderMemberships.delete(space.id, folder.featureId, m.principalId)
        await this.resolveNotice(space, m.principalId)
        continue
      }
      if (accountReason(answer.code)) await refused()
      // a removal is never given up: every hour until it is done (TOOL-FEAT-028)
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
      // one that failed for a reason that stays waits for a change of what it depends on (the member's address came, the
      // managing account can act again) or for the owner's Try again (TOOL-FEAT-028)
      if (m?.state === 'failed' && !changedRole && !options.force) {
        const changed = m.reason === 'no-address' || (m.reason === 'not-connected' && !!account)
        if (!changed) continue
      } else if (m && !changedRole && !due(m)) continue
      touched.add(principalId)
      const membership: FolderMembershipRecord = { ...(m ?? this.newMembership(folder, principalId)), role: want.role }
      if (!account) {
        await this.failed(space, folder, source, membership, 'not-connected', true)
        continue
      }
      const answer = await this.call(source, account, 'files_share', {
        root: ref,
        ref,
        role: want.role,
        recipients: [{ address: want.address }],
      })
      if (answer.ok) {
        const shares = Array.isArray(answer.data.shares) ? answer.data.shares.filter(isObject) : []
        const mine = ManagedFolders.shareOf(shares, want.address) ?? shares[0]
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
      if (accountReason(answer.code)) {
        await refused()
        await this.failed(space, folder, source, membership, 'not-connected', true)
      } else if (answer.code === 'recipient-refused')
        await this.failed(
          space,
          folder,
          source,
          membership,
          REFUSED.includes(answer.reason as FolderAccessReason) ? (answer.reason as FolderAccessReason) : 'no-account',
          true
        )
      else if (PASSING.includes(answer.code))
        await this.failed(space, folder, source, membership, 'unavailable', false, answer.retryAfterSeconds)
      else await this.failed(space, folder, source, membership, 'permission-denied', true)
    }
    // the managing account acted: a former refusal of it is over
    if (account && folder.refusedAccount) await this.saveFolder(space, { ...folder, refusedAccount: undefined })
    if (touched.size) await this.hooks.changed?.(space, folder.featureId, folder.sourceId, [...touched])
  }

  /** The share of a member the store lists, found by their address, for a membership recorded with no share id. */
  private async lookupShare(
    space: Space,
    source: CatalogSource,
    account: CallAccountSecret,
    ref: string,
    principalId: string
  ): Promise<string | undefined> {
    const address = await this.addressOf(space, principalId)
    if (!address) return undefined
    const listed = await this.call(source, account, 'files_shares', { root: ref, ref })
    const shares = listed.ok && Array.isArray(listed.data.shares) ? listed.data.shares.filter(isObject) : []
    const found = ManagedFolders.shareOf(shares, address)
    return typeof found?.id === 'string' ? found.id : undefined
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
    stays: boolean,
    retryAfterSeconds?: number
  ): Promise<void> {
    const now = Date.now()
    const attempts = m.attempts + 1
    const firstFailedAt = m.firstFailedAt ?? new Date(now).toISOString()
    const nextAttemptAt = stays ? undefined : ManagedFolders.nextTry(attempts, firstFailedAt, now, retryAfterSeconds)
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
        // the notices of the former owner end; the new owner is told of what still fails, at its next change
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
        const current = (await this.folderOf(space.id, folder.featureId)) ?? folder
        if (current.managedWith === 'manager') {
          await this.reconcileFolder(space, current, source)
          return
        }
        // a folder not made yet is made with the new owner's account
        if (current.state !== 'ready' && current.state !== 'needs-manager') {
          await this.saveFolder(space, { ...current, refusedAccount: undefined, managerPrincipalId: change.newId })
          return
        }
        await this.handOver(space, current, source, change)
      })
    }
  }

  private async handOver(
    space: Space,
    folder: ManagedFolderRecord,
    source: CatalogSource,
    change: { formerId?: string; newId?: string }
  ): Promise<void> {
    const managerId = folder.managerPrincipalId ?? change.formerId
    const formerAccount = folder.state === 'ready' ? await this.accountOf(space, source, managerId) : undefined
    const next = change.newId ? await this.deps.store.principals.get(change.newId) : undefined
    const address = next ? this.deps.emailOf(next) : undefined
    const role: FolderMembershipRecord['role'] = folder.managers ? 'manager' : 'editor'
    if (next && address && formerAccount && folder.ref) {
      const answer = await this.call(source, formerAccount, 'files_share', {
        root: folder.ref,
        ref: folder.ref,
        role,
        recipients: [{ address }],
      })
      if (answer.ok) {
        const shares = Array.isArray(answer.data.shares) ? answer.data.shares.filter(isObject) : []
        const mine = ManagedFolders.shareOf(shares, address) ?? shares[0]
        await this.saveMembership({
          spaceId: space.id,
          featureId: folder.featureId,
          principalId: next.id,
          role,
          ...(typeof mine?.id === 'string' ? { shareId: mine.id } : {}),
          state: 'in-place',
          attempts: 0,
          updatedAt: nowIso(),
        })
        await this.resolveNotice(space, next.id)
        // the former owner's role, or the end of their membership, while their account still manages it
        await this.reconcileFolder(space, { ...folder, managerPrincipalId: managerId }, source)
        await this.saveFolder(space, {
          ...((await this.folderOf(space.id, folder.featureId)) ?? folder),
          managerPrincipalId: next.id,
          refusedAccount: undefined,
        })
        this.deps.logger.info({ spaceId: space.id, source: source.name }, 'the new owner of a space manages its folder')
        return
      }
    }
    // the new owner may manage it already, made a manager at the store by an administrator (D147)
    if (await this.rescue(space, folder, source, next)) return
    if (folder.state !== 'needs-manager') {
      await this.saveFolder(space, { ...folder, state: 'needs-manager', reason: 'manager-gone', lastReadAt: nowIso() })
      await this.deps.spaces.record(space.id, AGENT_ACTOR, 'manager-needed', {
        sourceId: source.name,
        featureId: folder.featureId,
      })
      this.deps.logger.warn(
        { spaceId: space.id, source: source.name },
        'no account the agent holds manages the folder of a space'
      )
    }
  }

  /**
   * A folder whose manager is gone, checked again (TOOL-FEAT-029): when the owner's own account manages it now, made a
   * manager at the store by an administrator, it is `ready` again and managed with that account; true when it is.
   */
  private async rescue(
    space: Space,
    folder: ManagedFolderRecord,
    source: CatalogSource,
    given?: Principal
  ): Promise<boolean> {
    const owner =
      given ?? (space.ownerPrincipalId ? await this.deps.store.principals.get(space.ownerPrincipalId) : undefined)
    const share = owner ? await this.managerShare(space, folder, source, owner) : undefined
    const current = (await this.folderOf(space.id, folder.featureId)) ?? folder
    if (!owner || !share) {
      if (current.state === 'needs-manager') await this.saveFolder(space, { ...current, lastReadAt: nowIso() })
      return false
    }
    await this.saveMembership({
      spaceId: space.id,
      featureId: folder.featureId,
      principalId: owner.id,
      role: 'manager',
      ...(typeof share.id === 'string' ? { shareId: share.id } : {}),
      state: 'in-place',
      attempts: 0,
      updatedAt: nowIso(),
    })
    const ready: ManagedFolderRecord = {
      ...current,
      state: 'ready',
      reason: undefined,
      managerPrincipalId: owner.id,
      refusedAccount: undefined,
    }
    await this.saveFolder(space, ready)
    this.deps.logger.info({ spaceId: space.id, source: source.name }, 'the owner of a space manages its folder again')
    await this.reconcileFolder(space, ready, source)
    return true
  }

  /** A person's own share of the folder when it is a manager's: their account manages it now (D147). */
  private async managerShare(
    space: Space,
    folder: ManagedFolderRecord,
    source: CatalogSource,
    person: Principal
  ): Promise<Record<string, unknown> | undefined> {
    const account = await this.accountOf(space, source, person.id)
    const address = this.deps.emailOf(person)
    if (!account || !address || !folder.ref) return undefined
    const answer = await this.call(source, account, 'files_shares', { root: folder.ref, ref: folder.ref })
    if (!answer.ok || !Array.isArray(answer.data.shares)) return undefined
    const share = ManagedFolders.shareOf(answer.data.shares.filter(isObject), address)
    return share?.role === 'manager' ? share : undefined
  }

  // ---- what the owner does of it (TOOL-FEAT-030, PROF-TOOL-043) --------------------------------------------------------

  /** The owner renames the folder, at once, with the managing account (TOOL-FEAT-030). */
  public async rename(space: Space, folder: ManagedFolderRecord, title: unknown, actorId: string): Promise<void> {
    const error = folderNameError(title)
    if (error) throw new SpaceError(error, 'bad-name', 'folder.title')
    const source = this.deps.catalog.source(folder.sourceId)
    if (!source || !folder.ref || folder.state === 'creating' || folder.state === 'failed')
      throw new SpaceError('the folder is not made yet', 'not-managed')
    const name = (title as string).trim()
    await this.serial(`${space.id}|${folder.featureId}`, async () => {
      const current = (await this.folderOf(space.id, folder.featureId)) ?? folder
      const account = current.state === 'ready' ? await this.usableAccount(space, current, source) : undefined
      if (!account)
        throw new SpaceError(`${source.title} cannot be reached with the account that manages it`, 'source-unavailable')
      const answer = await this.call(source, account, 'files_rename_root', { root: current.ref, name })
      if (!answer.ok) {
        if (answer.code === 'invalid-argument')
          throw new SpaceError(`${source.title} does not take this name`, 'bad-name', 'folder.title')
        throw new SpaceError(`${source.title} did not rename the folder`, 'source-unavailable')
      }
      const root = isObject(answer.data.root) ? answer.data.root : {}
      const renamed = { ...current, name: typeof root.title === 'string' && root.title ? root.title : name }
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
   * whose access failed, at once, the managing account tried again whatever it answered before.
   */
  public async check(space: Space, folder: ManagedFolderRecord): Promise<void> {
    const source = this.deps.catalog.source(folder.sourceId)
    if (!source) return
    await this.serial(`${space.id}|${folder.featureId}`, async () => {
      const current = { ...((await this.folderOf(space.id, folder.featureId)) ?? folder), refusedAccount: undefined }
      if (current.state === 'creating' || current.state === 'failed') {
        await this.create(space, { ...current, state: 'creating', attempts: 0, firstFailedAt: undefined }, source)
        return
      }
      if (current.state === 'needs-manager') {
        await this.rescue(space, current, source)
        return
      }
      await this.saveFolder(space, current)
      await this.reread(space, current, source)
      await this.reconcileFolder(space, current, source, { force: true })
    })
  }

  /**
   * Every six hours (TOOL-FEAT-027, TOOL-FEAT-030): the folder's members read back, each membership of the agent's own the
   * store no longer holds as recorded made again, the people the agent did not add counted by their names, and the name
   * the store gives the folder kept.
   */
  private async reread(space: Space, given: ManagedFolderRecord, source: CatalogSource): Promise<void> {
    const folder = (await this.folderOf(space.id, given.featureId)) ?? given
    if (!folder.ref || folder.state !== 'ready') return
    const account = await this.usableAccount(space, folder, source)
    if (!account) return
    const listed = await this.call(source, account, 'files_shares', { root: folder.ref, ref: folder.ref })
    const next: ManagedFolderRecord = { ...folder, lastReadAt: nowIso() }
    if (listed.ok && Array.isArray(listed.data.shares)) {
      const shares = listed.data.shares.filter(isObject)
      const memberships = await this.deps.store.folderMemberships.listByFolder(space.id, folder.featureId)
      const ours = new Set<string>()
      for (const m of memberships) {
        const held =
          shares.find((s) => !!m.shareId && s.id === m.shareId) ??
          ManagedFolders.shareOf(shares, await this.addressOf(space, m.principalId))
        if (typeof held?.id === 'string') ours.add(held.id)
        if (m.state !== 'in-place') continue
        if (!held || held.role !== m.role)
          // made again now: the store no longer holds it as the agent made it
          await this.saveMembership({ ...m, state: 'pending', nextAttemptAt: undefined, attempts: 0 })
        else if (m.shareId !== held.id && typeof held.id === 'string')
          await this.saveMembership({ ...m, shareId: held.id })
      }
      const baseline = new Set(folder.baseline ?? [])
      next.addedOutside = shares
        .filter((s) => typeof s.id === 'string' && !ours.has(s.id) && !baseline.has(s.id) && s.inherited !== true)
        .map((s) => ({
          name:
            isObject(s.recipient) && typeof s.recipient.name === 'string' && s.recipient.name
              ? s.recipient.name
              : typeof s.audience === 'string'
                ? s.audience
                : 'a person',
        }))
    }
    const got = await this.call(source, account, 'files_get', { root: folder.ref, ref: folder.ref })
    const item = got.ok && isObject(got.data.item) ? got.data.item : undefined
    if (item && typeof item.name === 'string' && item.name) next.name = item.name
    const webUrl = httpsUrlOf(item?.webUrl)
    if (webUrl) next.webUrl = webUrl
    await this.saveFolder(space, next)
    if (next.name !== folder.name) await this.setLocation(space, next)
    if (next.addedOutside.length !== folder.addedOutside.length)
      await this.hooks.changed?.(space, folder.featureId, folder.sourceId, [])
  }

  /**
   * The schedule of the agent, every minute (TOOL-FEAT-027, 028, 029): a folder still to make tried when it is due or its
   * managing account changed; every folder's members in step, each change when it is due; every six hours the members and
   * the name read back, and a folder that needs a manager checked again.
   */
  public async tick(now = Date.now()): Promise<void> {
    for (const listed of await this.deps.store.managedFolders.listAll()) {
      const space = await this.deps.spaces.find(listed.spaceId)
      const source = this.deps.catalog.source(listed.sourceId)
      if (!space || !source) continue
      await this.serial(`${space.id}|${listed.featureId}`, async () => {
        const folder = (await this.folderOf(listed.spaceId, listed.featureId)) ?? listed
        const stale = !folder.lastReadAt || now - Date.parse(folder.lastReadAt) >= REREAD_EVERY
        if (folder.state === 'creating') {
          if (!folder.nextAttemptAt || Date.parse(folder.nextAttemptAt) <= now) await this.create(space, folder, source)
          return
        }
        if (folder.state === 'needs-manager') {
          if (stale) await this.rescue(space, folder, source)
          return
        }
        if (folder.state !== 'ready') return
        if (stale) await this.reread(space, folder, source)
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
