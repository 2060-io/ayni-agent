/**
 * Spaces (ayni-agent decision 60; ayni-spec D80 to D84, SPACE-DEF, SPACE-MEMB, SPACE-CONV, SPACE-SHARE). A space holds one piece of
 * work in one agent: a title, a purpose, a brief, a language and its rules (retention, lawful basis, the model
 * providers allowed to process it, handover). Every conversation belongs to exactly one; the default is the person's
 * Personal space, implicit, with the stable id `personal:<principalId>`.
 *
 * People who hold a role create spaces from the templates of the agent pack. Membership is by a rule over verified
 * facts (a department or a group of the person, or the whole organization) or by a list the owners keep. A member
 * list is a share, not a role: it gives nobody a reading of anyone's conversations. A conversation is read by its
 * author and, once its author shares it with its own space (handover), by the members of that space, read-only, while
 * the space takes handovers. Someone who leaves a space keeps reading their own conversations of it, and runs none.
 *
 * The store keeps a space's title, purpose and brief, and an invited person's email, only as ciphertext (D77); in the
 * clear stay what the lists and the membership need: the kind, the template, the language, the rules, the membership,
 * the owners, the dates.
 */
import { type AgentPack, PERSONAL_RETENTION_DAYS, providerNameOf, type SpaceTemplate } from '../config/packTypes.js'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import {
  APPROVAL_TIMEOUT_KINDS,
  type ApprovalTimeoutKind,
  defaultTimeouts,
  timeoutBoundsOf,
} from '../policy/spacePolicy.js'
import type { SpaceMemberRepo, SpaceRepo, Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { DirectoryView } from './directory.js'
import {
  type Conversation,
  DIRECTORY_ACTOR,
  type LawfulBasis,
  type OwnerChange,
  type Principal,
  type Space,
  type SpaceActivity,
  type SpaceMember,
  type SpaceMembership,
  type SpaceRole,
  type SpaceRules,
} from './types.js'

export const PERSONAL_PREFIX = 'personal:'
/** The Personal space of a Principal: implicit, never stored (SPACE-DEF-002). */
export const personalSpaceId = (principalId: string): string => `${PERSONAL_PREFIX}${principalId}`
export const isPersonalSpace = (spaceId: string): boolean => spaceId.startsWith(PERSONAL_PREFIX)
/** The space of a conversation: the one it names, else the Personal space of its Principal. */
export const spaceIdOf = (conversation: Pick<Conversation, 'spaceId' | 'principalId'>): string =>
  conversation.spaceId ?? personalSpaceId(conversation.principalId)

const LAWFUL_BASES: readonly LawfulBasis[] = ['consent', 'contract', 'legitimate-interest']
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const LIMITS = { title: 120, purpose: 1000, brief: 4000 }

/** The refusals of the space endpoints (AG-UI profile 3.3 §3.7) and of a run in a space. */
export type SpaceErrorCode =
  | 'not-found'
  | 'bad-request'
  | 'not-creator'
  | 'not-owner'
  /** a steward's request of a Principal who holds no steward role of the space's template (SPACE-MEMB-011) */
  | 'not-steward'
  | 'personal-space'
  | 'out-of-bounds'
  | 'rule-membership'
  | 'owner'
  | 'not-eligible'
  | 'has-messages'
  | 'handover-not-allowed'
  | 'final'
  | 'space-left'
  | 'already-member'
  | 'not-admin'
  | 'not-on-verana'
  | 'home-organization'
  | 'organization-not-accepted'
  | 'email-unavailable'
  // the tools of a space (profile 3.4 §3.10)
  | 'already-added'
  | 'not-added'
  | 'change-pending'
  | 'no-space-account'
  | 'confirmation-unavailable'
  | 'bad-binding'
  | 'pinned-by-pack'
  | 'looser-than-pack'
  | 'bad-token'
  // each person's own accounts (profile 3.5 §3.10, §3.11)
  | 'not-your-account'
  | 'not-oauth'
  | 'not-fields'
  | 'wrong-binding'
  | 'wrong-person'
  | 'source-unavailable'
  /** an approval that ended, or that the person decided, is sent to the phone no more (profile §3.12, D114) */
  | 'not-pending'
  // the approval policies of a space's tools (TOOL-SPACE-018)
  | 'not-approval'
  | 'approver-not-allowed'
  | 'repeated-entry'
  | 'below-pack-minimum'
  | 'threshold-below-required'
  | 'attestation-required'
  // features and providers (profile 3.5.8, agent D120 to D123)
  /** another provider of a feature that has one, sent with no `replaces` (TOOL-SPACE-003, PROF-TOOL-034) */
  | 'feature-has-provider'
  /** a provider the template allows for a feature that uses another provider in the space (TOOL-FEAT-006) */
  | 'provider-not-used'
  /** an entry of a feature's location that does not name the same place for every account (TOOL-FEAT-014) */
  | 'not-portable'
  | 'too-many-entries'
  | 'any-not-allowed'
  /** the choices of a location, read with the owner's own account, which is not connected (TOOL-SPACE-015) */
  | 'not-connected'
  /** the choices of a location, read with the space's account, which is not set (TOOL-SPACE-015) */
  | 'space-account-not-set'
  // a team space's managed folder (profile 3.5.9, agent D145 to D150)
  /** a mode of Files the template does not allow (PROF-TOOL-040) */
  | 'location-not-allowed'
  /** the managed mode with a provider the agent cannot manage a folder at (TOOL-FEAT-033) */
  | 'cannot-manage'
  /** a list of Files while its folder is managed (TOOL-FEAT-024) */
  | 'managed-location'
  /** `folder` on Files in the existing mode (PROF-TOOL-043) */
  | 'not-managed'
  /** a name of the managed folder the profile does not take (PROF-TOOL-043) */
  | 'bad-name'

/** The status of each refusal (profile 3.3 §9); `ERROR_STATUS` of the profile package lists the same. */
export const SPACE_ERROR_STATUS: Record<SpaceErrorCode, number> = {
  'not-found': 404,
  'bad-request': 400,
  'not-creator': 403,
  'not-owner': 403,
  'not-steward': 403,
  'personal-space': 409,
  'out-of-bounds': 422,
  'rule-membership': 409,
  owner: 409,
  'not-eligible': 422,
  'has-messages': 409,
  'handover-not-allowed': 409,
  final: 409,
  'space-left': 409,
  'already-member': 409,
  'not-admin': 403,
  'not-on-verana': 422,
  'home-organization': 422,
  'organization-not-accepted': 409,
  'email-unavailable': 503,
  'already-added': 409,
  'not-added': 409,
  'change-pending': 409,
  'no-space-account': 409,
  'confirmation-unavailable': 409,
  'bad-binding': 422,
  'pinned-by-pack': 422,
  'looser-than-pack': 422,
  'bad-token': 422,
  'not-your-account': 422,
  'not-oauth': 409,
  'not-fields': 409,
  'wrong-binding': 422,
  'wrong-person': 422,
  'source-unavailable': 502,
  'not-pending': 409,
  'not-approval': 422,
  'approver-not-allowed': 422,
  'repeated-entry': 422,
  'below-pack-minimum': 422,
  'threshold-below-required': 422,
  'attestation-required': 422,
  'feature-has-provider': 409,
  'provider-not-used': 409,
  'not-portable': 422,
  'too-many-entries': 422,
  'any-not-allowed': 422,
  'not-connected': 409,
  'space-account-not-set': 409,
  'location-not-allowed': 422,
  'cannot-manage': 409,
  'managed-location': 409,
  'not-managed': 409,
  'bad-name': 422,
}

export class SpaceError extends Error {
  public readonly status: number
  public constructor(
    message: string,
    public readonly code: SpaceErrorCode,
    /** the field a refusal names: the rule outside the bounds of the template */
    public readonly field?: string,
    /** what else the body carries: `expected` and `chosen` of a `wrong-binding` (profile 3.5 §3.11) */
    public readonly extra?: Record<string, string>
  ) {
    super(message)
    this.name = 'SpaceError'
    this.status = SPACE_ERROR_STATUS[code]
  }
}

/** What a Principal is to a space: its role, or that they left it (their own conversations stay readable). */
export interface SpaceAccess {
  space: Space
  role: SpaceRole | null
  left: boolean
  member?: SpaceMember
}

/**
 * The verified facts a membership rule reads (SPACE-MEMB-001): the department and the groups of the Principal's entry
 * of the user directory, as loaded, never a claim nor what the model says; and whether it is of the agent's own
 * organization (`relation: home`).
 */
export interface MembershipFacts {
  department?: string
  groups: string[]
  home: boolean
}

/** The department and groups of a Principal's directory entry (ayni-spec D79, IDENT-ROLE-012); none without one. */
export type DirectoryFacts = (principal: Principal) => { department?: string; groups?: string[] } | undefined

/** The people of the user directory as the spaces see them: a name, a department, groups (SPACE-MEMB-002/005). */
export interface DirectoryPeople {
  view(directoryId: string): DirectoryView | undefined
}

export function membershipFacts(principal: Principal, directory?: DirectoryFacts): MembershipFacts {
  const entry = directory?.(principal)
  const department = entry?.department?.trim()
  const groups = (entry?.groups ?? []).map((g) => g.trim()).filter(Boolean)
  return { ...(department ? { department } : {}), groups, home: principal.backingRelation === 'home' }
}

/** A rule names people of the agent's own organization only: the whole of it, a department, or a group. */
export function ruleMatches(rule: Extract<SpaceMembership, { mode: 'rule' }>['rule'], facts: MembershipFacts): boolean {
  if (!facts.home) return false
  if (rule.organization) return true
  if (rule.department) return facts.department === rule.department
  if (rule.group) return facts.groups.includes(rule.group)
  return false
}

interface SealedSpaceFields {
  title: string
  purpose: string
  brief: string
}

/** Spaces with their title, purpose and brief sealed under a key of the space (D77). */
export function sealedSpaces(repo: SpaceRepo, crypto: EntryCrypto): SpaceRepo {
  const open = (space: Space | undefined): Space | undefined => {
    if (!space?.sealed) return space
    const fields = openJson<SealedSpaceFields>(crypto, space.sealed.keyRef, Buffer.from(space.sealed.cipher, 'base64'))
    const { sealed: _sealed, ...rest } = space
    return { ...rest, ...fields }
  }
  const seal = (space: Space): Space => {
    const keyRef = space.sealed?.keyRef ?? crypto.newWrappedKey()
    const fields: SealedSpaceFields = { title: space.title, purpose: space.purpose, brief: space.brief }
    const { cipher } = sealJson(crypto, keyRef, fields)
    return { ...space, title: '', purpose: '', brief: '', sealed: { keyRef, cipher: cipher.toString('base64') } }
  }
  return {
    get: async (id) => open(await repo.get(id)),
    save: (space) => repo.save(seal(space)),
    list: async (agentId) => (await repo.list(agentId)).map((s) => open(s) as Space),
  }
}

/** The keyed index an invitation of another organization is found by: the organization key and the email. */
export function inviteeIndex(crypto: EntryCrypto, organizationKey: string, email: string): string {
  return crypto.blindIndex(`invitee\n${organizationKey}\n${email.trim().toLowerCase()}`)
}

/** Members with the email of an invited person sealed under a key of the row, found by its keyed index. */
export function sealedMembers(repo: SpaceMemberRepo, crypto: EntryCrypto): SpaceMemberRepo {
  const open = (m: SpaceMember | undefined): SpaceMember | undefined => {
    if (!m?.sealed) return m
    const { email } = openJson<{ email: string }>(crypto, m.sealed.keyRef, Buffer.from(m.sealed.cipher, 'base64'))
    const { sealed: _sealed, ...rest } = m
    return { ...rest, email }
  }
  const seal = (m: SpaceMember): SpaceMember => {
    if (!m.email) return m
    const keyRef = m.sealed?.keyRef ?? crypto.newWrappedKey()
    const { cipher } = sealJson(crypto, keyRef, { email: m.email })
    const { email: _email, ...rest } = m
    return {
      ...rest,
      ...(m.organizationKey ? { emailIndex: inviteeIndex(crypto, m.organizationKey, m.email) } : {}),
      sealed: { keyRef, cipher: cipher.toString('base64') },
    }
  }
  return {
    get: async (id) => open(await repo.get(id)),
    save: (m) => repo.save(seal(m)),
    listBySpace: async (spaceId) => (await repo.listBySpace(spaceId)).map((m) => open(m) as SpaceMember),
    listByPrincipal: async (principalId) =>
      (await repo.listByPrincipal(principalId)).map((m) => open(m) as SpaceMember),
    listByDirectoryId: async (directoryId) =>
      (await repo.listByDirectoryId(directoryId)).map((m) => open(m) as SpaceMember),
    listByInvitee: async (organizationKey, emailIndex) =>
      (await repo.listByInvitee(organizationKey, emailIndex)).map((m) => open(m) as SpaceMember),
    delete: (id) => repo.delete(id),
  }
}

/** How a person of another organization is invited to a list space (SPACE-INV-001..004, PROF-SPACE-005). */
export interface OutsiderInvitations {
  invite(principal: Principal, space: Space, input: { organizationKey: unknown; email: unknown }): Promise<SpaceMember>
}

/** What a template gives a new space and lets an owner change, its bounds resolved against the pack (SPACE-DEF-003). */
export interface ResolvedTemplate {
  template: SpaceTemplate
  retentionDays: { default: number; min?: number; max?: number }
  lawfulBasis: { default: LawfulBasis; allowed: LawfulBasis[] }
  allowedProviders: { default: string[]; allowed: string[] }
  handover: { default: boolean; allowed: boolean[] }
  /** per kind of approval, in minutes (SPACE-DEF-008): the agent-pack's, for every template */
  approvalTimeouts: Record<string, { default: number; min: number; max: number }>
}

/** A change of a space's owner, as its listeners hear it (SPACE-MEMB-012). */
export interface OwnerChanged {
  formerId?: string
  newId?: string
  how: OwnerChange | 'left'
  reason?: string
  actorId: string
}

/** Whom a request names: a member of a list space by `memberId`, a person of the directory of a rule space by `directoryId`. */
export interface PersonTarget {
  memberId?: unknown
  directoryId?: unknown
}

/** The longest reason a steward gives (SPACE-MEMB-011). */
export const STEWARD_REASON_MAX = 500

/** `POST {sessions}/spaces` (PROF-SPACE-002). */
export interface CreateSpaceInput {
  templateId: string
  title: string
  purpose: string
  brief?: string
}

export interface SpacePatchInput {
  title?: string
  purpose?: string
  brief?: string
  language?: string | null
  rules?: Partial<SpaceRules>
}

export class SpaceService {
  private readonly spaces: SpaceRepo
  private readonly members: SpaceMemberRepo
  /**
   * The directory entry of a Principal, for the rules over a department or a group (SPACE-MEMB-001): the agent wires it
   * to the user directory as loaded (decision 61). Without a directory such a rule matches its owner only, and
   * `organization: true` every Principal of `relation: home`.
   */
  public directory?: DirectoryFacts
  /** the people of the user directory, for adding them to a list and naming them (SPACE-MEMB-002); none without one */
  public people?: DirectoryPeople
  /** the invitations of people of other organizations (SPACE-INV); none without an SMTP server */
  public outsiders?: OutsiderInvitations
  /** a space was created: the sources its template adds by itself come with it (TOOL-SPACE-001) */
  public onCreated?: (space: Space) => Promise<void>
  /**
   * the owner of a space changed, or it has none any more (SPACE-MEMB-012): its tools stay and its pending changes are
   * dropped (TOOL-SPACE-011), its members are told, the approvals that wait for its owner move
   */
  public onOwnerChanged?: (space: Space, change: OwnerChanged) => Promise<void>
  /**
   * the people of a space changed (a member added, made active, removed or gone from the directory, a successor cleared):
   * what its policies name is read again, and its managed folder's members follow (D146)
   */
  public onMembersChanged?: (space: Space) => Promise<void>

  /** Tells the hook of the people of a space that they changed; a failure of what follows is logged, never thrown. */
  public async membersChanged(spaceId: string): Promise<void> {
    const space = await this.find(spaceId)
    if (!space) return
    await this.onMembersChanged?.(space).catch((err) =>
      this.logger.warn({ err, spaceId }, 'what follows the people of a space was not brought in line')
    )
  }

  public constructor(
    private readonly store: Store,
    private readonly pack: AgentPack,
    private readonly crypto: EntryCrypto,
    private readonly logger: Logger,
    /** the retention of Personal when `spaces.personal` gives none: the deployment's history days */
    private readonly personalRetentionDays = PERSONAL_RETENTION_DAYS
  ) {
    this.spaces = sealedSpaces(store.spaces, crypto)
    this.members = sealedMembers(store.spaceMembers, crypto)
  }

  public get agentId(): string {
    return this.pack.metadata.id
  }

  // ---- templates -----------------------------------------------------------------------------------

  public templates(): SpaceTemplate[] {
    return this.pack.spaces?.templates ?? []
  }

  /** A template's defaults and bounds; a rule without bounds keeps its default (the pack loader checked them). */
  public resolve(template: SpaceTemplate): ResolvedTemplate {
    const rules = template.rules ?? {}
    const conversation = this.conversationActivity()
    const lawful = rules.lawfulBasis?.default ?? conversation.lawfulBasis
    const providers = rules.allowedProviders?.default ?? [providerNameOf(this.pack)]
    const handover = rules.handover?.default ?? false
    return {
      template,
      retentionDays: {
        default: rules.retentionDays?.default ?? PERSONAL_RETENTION_DAYS,
        ...(rules.retentionDays?.min !== undefined ? { min: rules.retentionDays.min } : {}),
        ...(rules.retentionDays?.max !== undefined ? { max: rules.retentionDays.max } : {}),
      },
      lawfulBasis: { default: lawful, allowed: rules.lawfulBasis?.allowed ?? [lawful] },
      allowedProviders: { default: providers, allowed: rules.allowedProviders?.allowed ?? providers },
      handover: { default: handover, allowed: rules.handover?.allowed ?? [handover] },
      approvalTimeouts: Object.fromEntries(APPROVAL_TIMEOUT_KINDS.map((k) => [k, timeoutBoundsOf(this.pack, k)])),
    }
  }

  /**
   * At start: every space holds its approval timeouts among its rules (SPACE-DEF-008); a space made before them takes
   * the agent-pack's defaults.
   */
  public async alignRules(): Promise<number> {
    let n = 0
    for (const space of await this.all()) {
      const timeouts = { ...defaultTimeouts(this.pack), ...(space.rules.approvalTimeouts ?? {}) }
      if (JSON.stringify(timeouts) === JSON.stringify(space.rules.approvalTimeouts)) continue
      await this.spaces.save({ ...space, rules: { ...space.rules, approvalTimeouts: timeouts } })
      n++
    }
    if (n) this.logger.info({ spaces: n }, 'the approval timeouts of the spaces made before them set to the defaults')
    return n
  }

  /** The minutes an approval of a kind waits in a space (SPACE-DEF-008): its rule, else the agent-pack's default. */
  public approvalTimeout(space: Pick<Space, 'rules'>, kind: ApprovalTimeoutKind): number {
    return space.rules.approvalTimeouts?.[kind] ?? timeoutBoundsOf(this.pack, kind).default
  }

  /** The templates a Principal may create a space from: those naming one of its roles (SPACE-DEF-004). */
  public creatable(principal: Principal): SpaceTemplate[] {
    return this.templates().filter((t) => t.creators.some((r) => principal.roles.includes(r)))
  }

  // ---- the Personal space ----------------------------------------------------------------------------

  private conversationActivity(): { lawfulBasis: LawfulBasis } {
    const activity = this.pack.privacy.processingActivities.find((a) => a.id === 'conversation-memory')
    return { lawfulBasis: activity?.lawfulBasis ?? 'contract' }
  }

  /** The rules of every Personal space (SPACE-DEF-002, PRIV-RETN-009). */
  public personalRules(): SpaceRules {
    const rules = this.pack.spaces?.personal ?? {}
    return {
      retentionDays: rules.retentionDays ?? this.personalRetentionDays,
      lawfulBasis: rules.lawfulBasis ?? this.conversationActivity().lawfulBasis,
      allowedProviders: rules.allowedProviders ?? [providerNameOf(this.pack)],
      handover: false,
    }
  }

  /**
   * The Personal space of a Principal (SPACE-DEF-002): only theirs, never stored, its id `personal:<principalId>`. Its
   * rules are `spaces.personal`: 365 days by default (the deployment's history days when the pack gives none), the
   * lawful basis of the conversation memory, the agent's provider; it takes no handover.
   */
  public personal(principal: Pick<Principal, 'id' | 'createdAt'>): Space {
    return {
      id: personalSpaceId(principal.id),
      agentId: this.agentId,
      kind: 'personal',
      templateId: 'personal',
      title: 'Personal',
      purpose: '',
      brief: '',
      language: null,
      rules: this.personalRules(),
      membership: { mode: 'list' },
      ownerPrincipalId: principal.id,
      createdAt: principal.createdAt,
      updatedAt: principal.createdAt,
    }
  }

  // ---- access ----------------------------------------------------------------------------------------

  /** A stored space of this agent. */
  public async find(spaceId: string): Promise<Space | undefined> {
    if (isPersonalSpace(spaceId)) return undefined
    const space = await this.spaces.get(spaceId)
    return space && space.agentId === this.agentId ? space : undefined
  }

  /** Every stored space of this agent. */
  public async all(): Promise<Space[]> {
    return this.spaces.list(this.agentId)
  }

  private accessOf(
    principal: Principal,
    space: Space,
    rows: SpaceMember[],
    hasConversations: boolean
  ): SpaceAccess | undefined {
    const row = rows.find((m) => m.spaceId === space.id && this.isRowOf(principal, m))
    const owner = space.ownerPrincipalId === principal.id
    // the space's one owner is the one it names (D135): a row that was the owner's is a member's
    if (row?.state === 'active')
      return { space, role: owner ? 'owner' : row.role === 'owner' ? 'member' : row.role, left: false, member: row }
    if (owner) return { space, role: 'owner', left: false, ...(row ? { member: row } : {}) }
    if (
      space.membership.mode === 'rule' &&
      ruleMatches(space.membership.rule, membershipFacts(principal, this.directory))
    )
      return { space, role: 'member', left: false }
    // not a member (any more): a former member keeps reading their own conversations of it, and runs none
    if (row?.state === 'left' || hasConversations)
      return { space, role: null, left: true, ...(row ? { member: row } : {}) }
    return undefined
  }

  /** A row of a space is a Principal's when it names the Principal, or the directory entry the Principal holds. */
  private isRowOf(principal: Principal, m: SpaceMember): boolean {
    return (
      m.principalId === principal.id || (!!principal.directoryEntryId && m.directoryId === principal.directoryEntryId)
    )
  }

  /** What a Principal is to a space; undefined when they cannot see it (someone else's Personal space included). */
  public async access(principal: Principal, spaceId: string): Promise<SpaceAccess | undefined> {
    if (isPersonalSpace(spaceId))
      return spaceId === personalSpaceId(principal.id)
        ? { space: this.personal(principal), role: 'owner', left: false }
        : undefined
    const space = await this.find(spaceId)
    if (!space) return undefined
    const rows = (await this.members.listBySpace(space.id)).filter((m) => this.isRowOf(principal, m))
    // a member is one without reading their conversations: those are read only to tell a former member
    const member = this.accessOf(principal, space, rows, false)
    if (member) return member
    const own = await this.store.conversations.listByPrincipal(principal.id)
    return this.accessOf(
      principal,
      space,
      rows,
      own.some((c) => spaceIdOf(c) === space.id)
    )
  }

  /** The spaces a Principal sees: Personal first, then the others by creation; left ones they still have conversations in. */
  public async listFor(principal: Principal): Promise<SpaceAccess[]> {
    const rows = await this.members.listByPrincipal(principal.id)
    if (principal.directoryEntryId)
      for (const row of await this.members.listByDirectoryId(principal.directoryEntryId))
        if (!rows.some((r) => r.id === row.id)) rows.push(row)
    const own = new Set((await this.store.conversations.listByPrincipal(principal.id)).map(spaceIdOf))
    const out: SpaceAccess[] = [{ space: this.personal(principal), role: 'owner', left: false }]
    for (const space of await this.all()) {
      const access = this.accessOf(principal, space, rows, own.has(space.id))
      if (access) out.push(access)
    }
    return out
  }

  /**
   * The space a Principal may start a conversation in, or move one to: one in which it is an active member; any other,
   * one it left included, is not found (404, profile PROF-CONV-011).
   */
  public async usable(principal: Principal, spaceId: string): Promise<SpaceAccess> {
    const access = await this.access(principal, spaceId)
    if (!access || access.left) throw new SpaceError('space not found', 'not-found')
    return access
  }

  /** The space of a new conversation: the one asked when the Principal may use it, else their Personal space. */
  public async spaceForNewConversation(principal: Principal, requested: string | undefined): Promise<string> {
    if (!requested) return personalSpaceId(principal.id)
    try {
      return (await this.usable(principal, requested)).space.id
    } catch (error) {
      if (!(error instanceof SpaceError)) throw error
      this.logger.warn(
        { principalId: principal.id, spaceId: requested, reason: error.code },
        'space not open to this person: the conversation goes to Personal'
      )
      return personalSpaceId(principal.id)
    }
  }

  /**
   * A run on a conversation of a space its Principal left is refused before anything of it is recorded: `409
   * space-left` (SPACE-MEMB-004, PROF-RUN-014). Its history stays readable.
   */
  public async leftRefusal(
    principal: Principal,
    conversation: Pick<Conversation, 'spaceId' | 'principalId'>
  ): Promise<SpaceError | undefined> {
    const access = await this.access(principal, spaceIdOf(conversation))
    if (access && !access.left) return undefined
    return new SpaceError(
      'you are no longer a member of the space of this conversation: it stays readable, and takes no message',
      'space-left'
    )
  }

  /**
   * What the agent's code answers, with no model call, in a space that does not allow the model provider the agent is
   * configured with (SPACE-CONV-004, PROF-RUN-014); undefined when the space allows it.
   */
  public async providerRefusal(principal: Principal, spaceId: string): Promise<string | undefined> {
    const access = await this.access(principal, spaceId)
    const space = access?.space ?? (isPersonalSpace(spaceId) ? this.personal(principal) : undefined)
    if (!space) return undefined
    const provider = providerNameOf(this.pack)
    if (space.rules.allowedProviders.includes(provider)) return undefined
    const name = space.kind === 'personal' ? 'your Personal space' : `the space "${space.title}"`
    return `The rules of ${name} do not allow the model this agent uses (${provider}), so I cannot answer here. It allows ${space.rules.allowedProviders.join(', ')}.`
  }

  // ---- creation and settings -----------------------------------------------------------------------------

  private text(value: unknown, field: keyof typeof LIMITS, required: boolean): string {
    if (value === undefined && !required) return ''
    if (typeof value !== 'string') throw new SpaceError(`${field} must be a text`, 'bad-request')
    const trimmed = value.trim()
    if (required && !trimmed) throw new SpaceError(`${field} is required`, 'bad-request')
    if (trimmed.length > LIMITS[field])
      throw new SpaceError(`${field} is longer than ${LIMITS[field]} characters`, 'bad-request')
    return trimmed
  }

  private language(value: unknown): string | null {
    if (value === null || value === undefined) return null
    if (typeof value !== 'string' || !LANGUAGE.test(value))
      throw new SpaceError('language must be a BCP 47 tag, such as en or es-CO', 'bad-request')
    return value
  }

  /**
   * A space created from a template by a Principal who holds one of its `creators` roles; they own it (SPACE-DEF-004,
   * PROF-SPACE-002). Its kind, membership and rules are the template's; its language is set later, by its owner.
   */
  public async create(principal: Principal, input: CreateSpaceInput): Promise<Space> {
    const template = this.templates().find((t) => t.id === input.templateId)
    if (!template) throw new SpaceError('template not found', 'not-found')
    if (!template.creators.some((r) => principal.roles.includes(r)))
      throw new SpaceError('your roles do not let you create a space from this template', 'not-creator')
    const resolved = this.resolve(template)
    const now = nowIso()
    const space: Space = {
      id: prefixedId('spc'),
      agentId: this.agentId,
      kind: template.kind,
      templateId: template.id,
      title: this.text(input.title, 'title', true),
      purpose: this.text(input.purpose, 'purpose', true),
      brief: this.text(input.brief, 'brief', false),
      language: null,
      rules: {
        retentionDays: resolved.retentionDays.default,
        lawfulBasis: resolved.lawfulBasis.default,
        allowedProviders: [...resolved.allowedProviders.default],
        handover: resolved.handover.default,
        approvalTimeouts: defaultTimeouts(this.pack),
      },
      membership:
        template.membership.mode === 'list'
          ? { mode: 'list' }
          : { mode: 'rule', rule: { ...template.membership.rule } },
      ownerPrincipalId: principal.id,
      createdAt: now,
      updatedAt: now,
    }
    await this.spaces.save(space)
    const owner: SpaceMember = {
      id: prefixedId('mem'),
      spaceId: space.id,
      principalId: principal.id,
      state: 'active',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    }
    await this.members.save(owner)
    await this.record(space.id, principal.id, 'created', {})
    this.logger.info({ spaceId: space.id, templateId: template.id, principalId: principal.id }, 'space created')
    await this.onCreated?.(space)
    return space
  }

  /** The owner of a stored space, or a refusal: Personal has no settings, a member is not an owner. */
  public async owned(principal: Principal, spaceId: string): Promise<SpaceAccess> {
    if (isPersonalSpace(spaceId)) {
      if (spaceId !== personalSpaceId(principal.id)) throw new SpaceError('space not found', 'not-found')
      throw new SpaceError('the Personal space has no settings, members or owner', 'personal-space')
    }
    const access = await this.access(principal, spaceId)
    if (!access || access.left) throw new SpaceError('space not found', 'not-found')
    if (access.role !== 'owner') throw new SpaceError('only the owner of the space may do this', 'not-owner')
    return access
  }

  /** An owner changes the title, the purpose, the brief, the language and the rules, within the template's bounds. */
  public async update(principal: Principal, spaceId: string, patch: SpacePatchInput): Promise<Space> {
    const { space } = await this.owned(principal, spaceId)
    const template = this.templates().find((t) => t.id === space.templateId)
    const fields: string[] = []
    const next: Space = { ...space, rules: { ...space.rules } }
    if (patch.title !== undefined) next.title = this.text(patch.title, 'title', true)
    if (patch.purpose !== undefined) next.purpose = this.text(patch.purpose, 'purpose', true)
    if (patch.brief !== undefined) next.brief = this.text(patch.brief, 'brief', false)
    if (patch.language !== undefined) next.language = this.language(patch.language)
    for (const key of ['title', 'purpose', 'brief', 'language'] as const) if (next[key] !== space[key]) fields.push(key)
    const rules = patch.rules ?? {}
    if (Object.keys(rules).length) {
      // a template the pack no longer declares keeps every rule as it is
      const bounds = template ? this.resolve(template) : undefined
      const outside = (what: string) =>
        new SpaceError(`${what} is outside the bounds of the template`, 'out-of-bounds', `rules.${what}`)
      if (rules.retentionDays !== undefined) {
        const value = rules.retentionDays
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
          throw new SpaceError('retentionDays must be a whole number of days', 'bad-request')
        const b = bounds?.retentionDays
        const bounded = b && (b.min !== undefined || b.max !== undefined)
        const ok =
          b &&
          (bounded
            ? (b.min === undefined || value >= b.min) && (b.max === undefined || value <= b.max)
            : value === b.default)
        if (!ok) throw outside('retentionDays')
        next.rules.retentionDays = value
      }
      if (rules.lawfulBasis !== undefined) {
        if (!LAWFUL_BASES.includes(rules.lawfulBasis)) throw new SpaceError('lawfulBasis is unknown', 'bad-request')
        if (!bounds?.lawfulBasis.allowed.includes(rules.lawfulBasis)) throw outside('lawfulBasis')
        next.rules.lawfulBasis = rules.lawfulBasis
      }
      if (rules.allowedProviders !== undefined) {
        const list = rules.allowedProviders
        if (!Array.isArray(list) || !list.length || list.some((p) => typeof p !== 'string'))
          throw new SpaceError('allowedProviders is a list of at least one provider', 'bad-request')
        if (list.some((p) => !bounds?.allowedProviders.allowed.includes(p))) throw outside('allowedProviders')
        next.rules.allowedProviders = [...new Set(list)]
      }
      if (rules.handover !== undefined) {
        if (typeof rules.handover !== 'boolean') throw new SpaceError('handover is true or false', 'bad-request')
        if (!bounds?.handover.allowed.includes(rules.handover)) throw outside('handover')
        next.rules.handover = rules.handover
      }
      // the approval timeouts, per kind, within the agent-pack's bounds; a change applies to the approvals asked after it
      // (SPACE-DEF-008)
      if (rules.approvalTimeouts !== undefined) {
        const given = rules.approvalTimeouts as unknown
        if (!given || typeof given !== 'object' || Array.isArray(given))
          throw new SpaceError('approvalTimeouts is an object of minutes by kind of approval', 'bad-request')
        const timeouts = { ...defaultTimeouts(this.pack), ...(space.rules.approvalTimeouts ?? {}) }
        for (const [kind, minutes] of Object.entries(given as Record<string, unknown>)) {
          const field = `rules.approvalTimeouts.${kind}`
          if (!APPROVAL_TIMEOUT_KINDS.includes(kind as ApprovalTimeoutKind))
            throw new SpaceError(`${kind} is no kind of approval`, 'bad-request', field)
          if (typeof minutes !== 'number' || !Number.isInteger(minutes))
            throw new SpaceError(`${field} is a whole number of minutes`, 'bad-request', field)
          const b = timeoutBoundsOf(this.pack, kind as ApprovalTimeoutKind)
          if (minutes < b.min || minutes > b.max)
            throw new SpaceError(`${field} is outside ${b.min} to ${b.max} minutes`, 'out-of-bounds', field)
          timeouts[kind] = minutes
        }
        next.rules.approvalTimeouts = timeouts
      }
      for (const key of ['retentionDays', 'lawfulBasis', 'allowedProviders', 'handover', 'approvalTimeouts'] as const)
        if (JSON.stringify(next.rules[key]) !== JSON.stringify(space.rules[key])) fields.push(`rules.${key}`)
    }
    if (!fields.length) return space
    next.updatedAt = nowIso()
    await this.spaces.save(next)
    // the names of the fields, never what they say
    await this.record(space.id, principal.id, 'rules-changed', { fields })
    return next
  }

  // ---- members, owner, activity ----------------------------------------------------------------------------

  public async memberRows(spaceId: string): Promise<SpaceMember[]> {
    return this.members.listBySpace(spaceId)
  }

  /** The Principals that hold a directory entry: those whose identity credential this agent issued from it (IDENT-DIR-006). */
  public async holdersOf(directoryId: string): Promise<Principal[]> {
    return (await this.store.principals.list())
      .filter((p) => p.directoryEntryId === directoryId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Adds a person to a space's list (SPACE-MEMB-002, PROF-SPACE-005): a person of the user directory by its entry,
   * `invited` until a Principal holds that entry, then `active`; a person of another organization by its organization
   * key and email, invited by email and bound when their badge is presented (SPACE-INV-001..004, `outsiders`).
   */
  public async addMember(principal: Principal, spaceId: string, body: Record<string, unknown>): Promise<SpaceMember> {
    const { space } = await this.owned(principal, spaceId)
    if (space.membership.mode === 'rule')
      throw new SpaceError('the members of this space are given by its rule', 'rule-membership')
    if (typeof body.directoryId === 'string' && body.directoryId)
      return this.addFromDirectory(principal, space, body.directoryId)
    if (body.organizationKey !== undefined || body.email !== undefined) {
      if (!this.outsiders) throw new SpaceError('this agent sends no email: it invites nobody', 'email-unavailable')
      return this.outsiders.invite(principal, space, { organizationKey: body.organizationKey, email: body.email })
    }
    throw new SpaceError('directoryId, or organizationKey and email, is required', 'bad-request')
  }

  /** Writes a member row: its email sealed, with its keyed index (the invitations of another organization). */
  public async saveMember(row: SpaceMember): Promise<void> {
    await this.members.save(row)
  }

  /** The rows of an invited person of another organization, in every space, by organization key and email (SPACE-INV-003). */
  public async invitationsOf(organizationKey: string, email: string): Promise<SpaceMember[]> {
    return this.members.listByInvitee(organizationKey, inviteeIndex(this.crypto, organizationKey, email))
  }

  private async addFromDirectory(principal: Principal, space: Space, directoryId: string): Promise<SpaceMember> {
    if (!this.people?.view(directoryId)) throw new SpaceError('person not found', 'not-found')
    const holders = await this.holdersOf(directoryId)
    if (holders.some((h) => h.id === space.ownerPrincipalId))
      throw new SpaceError('this person owns the space', 'already-member')
    const rows = await this.members.listBySpace(space.id)
    const existing = rows.find(
      (m) => m.directoryId === directoryId || (!!m.principalId && holders.some((h) => h.id === m.principalId))
    )
    if (existing && existing.state !== 'left') throw new SpaceError('this person is a member already', 'already-member')
    const holder = holders[0]
    const now = nowIso()
    const row: SpaceMember = {
      ...(existing ?? { id: prefixedId('mem'), spaceId: space.id, createdAt: now }),
      principalId: holder?.id ?? null,
      directoryId,
      state: holder ? 'active' : 'invited',
      role: 'member',
      updatedAt: now,
    }
    await this.members.save(row)
    await this.record(space.id, principal.id, holder ? 'joined' : 'invited', { memberId: row.id, directoryId })
    if (holder) await this.membersChanged(space.id)
    this.logger.info(
      { spaceId: space.id, memberId: row.id, directoryId, state: row.state },
      'a person of the directory added to a space'
    )
    return row
  }

  /**
   * A Principal comes to hold a directory entry (its badge from the directory is presented): the lists it was added to
   * by that entry while `invited` make it `active` (SPACE-MEMB-002).
   */
  public async bindDirectoryMember(principal: Principal): Promise<number> {
    if (!principal.directoryEntryId) return 0
    let bound = 0
    for (const row of await this.members.listByDirectoryId(principal.directoryEntryId)) {
      if (row.state !== 'invited' || !(await this.find(row.spaceId))) continue
      await this.members.save({ ...row, principalId: principal.id, state: 'active', updatedAt: nowIso() })
      await this.record(row.spaceId, principal.id, 'joined', { memberId: row.id, directoryId: row.directoryId })
      await this.membersChanged(row.spaceId)
      bound++
    }
    if (bound) this.logger.info({ principalId: principal.id, spaces: bound }, 'invitations of the directory bound')
    return bound
  }

  /**
   * Who may search the user directory (SPACE-MEMB-005, PROF-DIR-001): a Principal who owns a list space or holds a
   * `creators` role of a list template.
   */
  public async mayPickPeople(principal: Principal): Promise<boolean> {
    if (
      this.templates().some((t) => t.membership.mode === 'list' && t.creators.some((r) => principal.roles.includes(r)))
    )
      return true
    return (await this.all()).some((s) => s.membership.mode === 'list' && s.ownerPrincipalId === principal.id)
  }

  /**
   * The owner removes a member of a list space (profile PROF-SPACE-005); the owner is not removed (they give the space
   * first), and a rule space's members follow its rule. The row of a member stays, as `left`: its person keeps reading
   * their own conversations of the space. A person removed while `invited` is removed (SPACE-MEMB-004).
   */
  public async removeMember(principal: Principal, spaceId: string, memberId: string): Promise<SpaceMember> {
    const { space } = await this.owned(principal, spaceId)
    if (space.membership.mode === 'rule')
      throw new SpaceError('the members of this space are given by its rule', 'rule-membership')
    const row = await this.members.get(memberId)
    if (!row || row.spaceId !== spaceId || row.state === 'left') throw new SpaceError('member not found', 'not-found')
    if (row.principalId && row.principalId === space.ownerPrincipalId)
      throw new SpaceError('the owner stays: give the space to a member first', 'owner')
    const detail = {
      memberId,
      ...(row.directoryId ? { directoryId: row.directoryId } : {}),
      ...(row.principalId ? { principalId: row.principalId } : {}),
    }
    if (row.state === 'invited') {
      await this.members.delete(row.id)
      await this.record(spaceId, principal.id, 'removed', detail)
      return row
    }
    const left: SpaceMember = { ...row, state: 'left', role: 'member', updatedAt: nowIso() }
    await this.members.save(left)
    await this.record(spaceId, principal.id, 'removed', detail)
    // a successor who left the space is one no more (SPACE-MEMB-010)
    const fresh = (await this.find(spaceId)) ?? space
    if (row.principalId && fresh.successorPrincipalId === row.principalId)
      await this.clearSuccessor(fresh, principal.id)
    await this.onMembersChanged?.((await this.find(spaceId)) ?? fresh)
    return left
  }

  // ---- the owner, the successor and the stewards (D135, D136; SPACE-MEMB-007, SPACE-MEMB-009 to 012) ----------------

  /**
   * The people of a space who may approve and own it (SPACE-MEMB-007, INTX-APPR-021): its active members who are not
   * guests, the owner among them. In a rule space, those its rule matches and those a row keeps a member (a former
   * owner); in a list space, its active rows.
   */
  public async activeMemberIds(space: Space, principals?: Principal[]): Promise<string[]> {
    const ids = new Set<string>()
    if (space.ownerPrincipalId) ids.add(space.ownerPrincipalId)
    for (const row of await this.members.listBySpace(space.id))
      if (row.state === 'active' && row.principalId && row.role !== 'guest') ids.add(row.principalId)
    if (space.membership.mode === 'rule') {
      const rule = space.membership.rule
      for (const p of principals ?? (await this.store.principals.list()))
        if (ruleMatches(rule, membershipFacts(p, this.directory))) ids.add(p.id)
    }
    return [...ids]
  }

  /**
   * The person a request names, if the space could be handed to them (SPACE-MEMB-007): in a list space an active member
   * who is not a guest, by `memberId`; in a rule space a person the rule matches who holds a Principal, by `directoryId`.
   */
  private async eligibleTarget(
    space: Space,
    target: PersonTarget
  ): Promise<{ principalId: string; memberId?: string; directoryId?: string }> {
    if (space.membership.mode === 'rule') {
      if (typeof target.directoryId !== 'string' || !target.directoryId)
        throw new SpaceError('in a rule space, a person of the directory the rule matches', 'not-eligible')
      const rule = space.membership.rule
      const holder = (await this.holdersOf(target.directoryId)).find((p) =>
        ruleMatches(rule, membershipFacts(p, this.directory))
      )
      if (!holder)
        throw new SpaceError('a person the rule matches who holds a badge from the directory', 'not-eligible')
      return { principalId: holder.id, directoryId: target.directoryId }
    }
    if (typeof target.memberId !== 'string' || !target.memberId)
      throw new SpaceError('in a list space, one of its active members', 'not-eligible')
    const row = await this.members.get(target.memberId)
    if (!row || row.spaceId !== space.id || row.state !== 'active' || !row.principalId || row.role === 'guest')
      throw new SpaceError('an active member of the organization only', 'not-eligible')
    return { principalId: row.principalId, memberId: row.id }
  }

  /** Whether a person could still be handed the space: the successor stays eligible while this holds (SPACE-MEMB-010). */
  public async stillEligible(space: Space, principalId: string): Promise<boolean> {
    if (space.membership.mode === 'rule') {
      const p = await this.store.principals.get(principalId)
      return !!p && !!p.directoryEntryId && ruleMatches(space.membership.rule, membershipFacts(p, this.directory))
    }
    return (await this.members.listBySpace(space.id)).some(
      (m) => m.principalId === principalId && m.state === 'active' && m.role !== 'guest'
    )
  }

  /**
   * An owner gives the space to another person (SPACE-MEMB-007, PROF-SPACE-006): in a list space an active member who is
   * not a guest, by `memberId`; in a rule space a person the rule matches who holds a Principal, by `directoryId`. The
   * former owner stays a member; any other target is not eligible.
   */
  public async transferOwner(principal: Principal, spaceId: string, target: PersonTarget): Promise<Space> {
    const { space } = await this.owned(principal, spaceId)
    const to = await this.eligibleTarget(space, target)
    if (to.principalId === principal.id) return space
    return this.changeOwner(space, to, 'handover', principal.id)
  }

  /**
   * The owner changes (SPACE-MEMB-012): the new owner's row says so, the former owner stays a member by theirs, the
   * successor is cleared, and the change is recorded with how and a steward's reason; its listeners move what waits.
   */
  private async changeOwner(
    space: Space,
    to: { principalId: string; memberId?: string; directoryId?: string },
    how: OwnerChange,
    actorId: string,
    reason?: string
  ): Promise<Space> {
    const rows = await this.members.listBySpace(space.id)
    const now = nowIso()
    const formerId = space.ownerPrincipalId
    const former = formerId ? rows.find((m) => m.principalId === formerId && m.state === 'active') : undefined
    if (former) await this.members.save({ ...former, role: 'member', updatedAt: now })
    const theirs = rows.find((m) => m.id === to.memberId) ?? rows.find((m) => m.principalId === to.principalId)
    const row: SpaceMember = {
      ...(theirs ?? { id: prefixedId('mem'), spaceId: space.id, createdAt: now }),
      principalId: to.principalId,
      ...(to.directoryId ? { directoryId: to.directoryId } : {}),
      state: 'active',
      role: 'owner',
      updatedAt: now,
    }
    await this.members.save(row)
    const { successorPrincipalId, ...rest } = space
    const next: Space = { ...rest, ownerPrincipalId: to.principalId, updatedAt: now }
    await this.spaces.save(next)
    await this.record(space.id, actorId, 'owner-changed', {
      memberId: row.id,
      ...(to.directoryId ? { directoryId: to.directoryId } : {}),
      how,
      ...(reason ? { reason } : {}),
    })
    // every change of owner clears the successor (SPACE-MEMB-010)
    if (successorPrincipalId)
      await this.record(space.id, actorId, 'successor-cleared', { principalId: successorPrincipalId })
    this.logger.info({ spaceId: space.id, how }, 'the owner of a space changed')
    await this.onOwnerChanged?.(next, { formerId, newId: to.principalId, how, ...(reason ? { reason } : {}), actorId })
    return next
  }

  /**
   * `PUT {sessions}/spaces/{id}/successor` (SPACE-MEMB-010, PROF-SPACE-008): the owner names the person who becomes the
   * owner when the owner's entry leaves the directory; anyone the space could be handed to, the owner excepted.
   */
  public async setSuccessor(principal: Principal, spaceId: string, target: PersonTarget): Promise<Space> {
    const { space } = await this.owned(principal, spaceId)
    const to = await this.eligibleTarget(space, target)
    if (to.principalId === principal.id) throw new SpaceError('the owner is not their own successor', 'not-eligible')
    if (space.successorPrincipalId === to.principalId) return space
    const next: Space = { ...space, successorPrincipalId: to.principalId, updatedAt: nowIso() }
    await this.spaces.save(next)
    await this.record(space.id, principal.id, 'successor-set', {
      principalId: to.principalId,
      ...(to.memberId ? { memberId: to.memberId } : {}),
      ...(to.directoryId ? { directoryId: to.directoryId } : {}),
    })
    return next
  }

  /** `DELETE {sessions}/spaces/{id}/successor` (SPACE-MEMB-010): the owner clears it. */
  public async removeSuccessor(principal: Principal, spaceId: string): Promise<Space> {
    const { space } = await this.owned(principal, spaceId)
    return this.clearSuccessor(space, principal.id)
  }

  private async clearSuccessor(space: Space, actorId: string): Promise<Space> {
    if (!space.successorPrincipalId) return space
    const { successorPrincipalId, ...rest } = space
    const next: Space = { ...rest, updatedAt: nowIso() }
    await this.spaces.save(next)
    await this.record(space.id, actorId, 'successor-cleared', { principalId: successorPrincipalId })
    return next
  }

  /** A successor who stopped being eligible is cleared (SPACE-MEMB-010); true when one was. */
  public async dropIneligibleSuccessor(space: Space): Promise<boolean> {
    if (!space.successorPrincipalId || (await this.stillEligible(space, space.successorPrincipalId))) return false
    await this.clearSuccessor(space, DIRECTORY_ACTOR)
    return true
  }

  /**
   * A person's entry left the directory (D91, D136): they are no member of any space any more, each by their row, and a
   * space they owned passes to its successor while the successor is eligible (SPACE-MEMB-010), or has no owner until a
   * steward names one (SPACE-MEMB-011); a space whose successor they were has none.
   */
  public async onEntryLeft(principal: Principal, entryId: string): Promise<void> {
    for (const space of await this.all()) {
      const now = nowIso()
      for (const row of await this.members.listBySpace(space.id)) {
        const theirs = row.principalId === principal.id || row.directoryId === entryId
        if (!theirs || row.state !== 'active') continue
        await this.members.save({ ...row, state: 'left', role: 'member', updatedAt: now })
        await this.record(space.id, DIRECTORY_ACTOR, 'left', {
          memberId: row.id,
          ...(row.principalId ? { principalId: row.principalId } : {}),
          ...(row.directoryId ? { directoryId: row.directoryId } : {}),
        })
        if (space.ownerPrincipalId !== principal.id) await this.membersChanged(space.id)
      }
      let current = (await this.find(space.id)) ?? space
      if (current.successorPrincipalId === principal.id) current = await this.clearSuccessor(current, DIRECTORY_ACTOR)
      if (current.ownerPrincipalId !== principal.id) continue
      const successor = current.successorPrincipalId
      if (successor && (await this.stillEligible(current, successor))) {
        const holder = await this.store.principals.get(successor)
        await this.changeOwner(
          current,
          {
            principalId: successor,
            ...(current.membership.mode === 'rule' && holder?.directoryEntryId
              ? { directoryId: holder.directoryEntryId }
              : {}),
          },
          'succession',
          DIRECTORY_ACTOR
        )
        continue
      }
      // no successor, or none eligible: the space has no owner, and what only an owner does waits (SPACE-MEMB-011)
      const { ownerPrincipalId: _gone, successorPrincipalId: _none, ...rest } = current
      const next: Space = { ...rest, updatedAt: now }
      await this.spaces.save(next)
      this.logger.info({ spaceId: space.id }, 'the owner of a space left the directory: it has no owner')
      await this.onOwnerChanged?.(next, { formerId: principal.id, how: 'left', actorId: DIRECTORY_ACTOR })
    }
  }

  /** The templates whose `stewards` roles a Principal holds (SPACE-MEMB-011). */
  public stewardTemplates(principal: Principal): SpaceTemplate[] {
    return this.templates().filter((t) => (t.stewards ?? []).some((r) => principal.roles.includes(r)))
  }

  /** Whether a Principal holds a steward role of the template of a space. */
  public isSteward(principal: Principal, space: Pick<Space, 'templateId'>): boolean {
    return this.stewardTemplates(principal).some((t) => t.id === space.templateId)
  }

  /** The holders of a steward role of a template: told when a space of it has no owner (SPACE-MEMB-012). */
  public async stewardsOf(templateId: string): Promise<Principal[]> {
    const roles = this.templates().find((t) => t.id === templateId)?.stewards ?? []
    if (!roles.length) return []
    return (await this.store.principals.list()).filter((p) => p.roles.some((r) => roles.includes(r)))
  }

  /** `GET {sessions}/stewardship` (SPACE-MEMB-011): the spaces of the templates a Principal stewards. */
  public async stewarded(principal: Principal): Promise<Space[]> {
    const templates = new Set(this.stewardTemplates(principal).map((t) => t.id))
    if (!templates.size) throw new SpaceError('you hold no steward role of a template of spaces', 'not-steward')
    return (await this.all()).filter((s) => templates.has(s.templateId))
  }

  /** A space a steward may act on: of a template they steward; any other Principal gets 403 `not-steward`. */
  private async stewardOf(principal: Principal, spaceId: string): Promise<Space> {
    const space = isPersonalSpace(spaceId) ? undefined : await this.find(spaceId)
    if (!space) {
      if (!this.stewardTemplates(principal).length)
        throw new SpaceError('you hold no steward role of a template of spaces', 'not-steward')
      throw new SpaceError('space not found', 'not-found')
    }
    if (!this.isSteward(principal, space))
      throw new SpaceError('you hold no steward role of the template of this space', 'not-steward')
    return space
  }

  /**
   * `GET {sessions}/spaces/{id}/owner/candidates` (SPACE-MEMB-011): who could own a space, by name and department, to a
   * steward of its template: its active members who are not guests (`memberId`) in a list space, the people its rule
   * matches who hold a Principal (`directoryId`) in a rule space.
   */
  public async candidates(
    principal: Principal,
    spaceId: string,
    nameOf: (p: Principal) => string
  ): Promise<{ memberId?: string; directoryId?: string; name: string; department: string | null }[]> {
    const space = await this.stewardOf(principal, spaceId)
    const department = (p: Principal) => membershipFacts(p, this.directory).department ?? null
    if (space.membership.mode === 'rule') {
      const rule = space.membership.rule
      const out: { directoryId: string; name: string; department: string | null }[] = []
      for (const p of await this.store.principals.list())
        if (p.directoryEntryId && ruleMatches(rule, membershipFacts(p, this.directory)))
          out.push({ directoryId: p.directoryEntryId, name: nameOf(p), department: department(p) })
      return out
    }
    const out: { memberId: string; name: string; department: string | null }[] = []
    for (const row of await this.members.listBySpace(space.id)) {
      if (row.state !== 'active' || !row.principalId || row.role === 'guest') continue
      const p = await this.store.principals.get(row.principalId)
      if (p) out.push({ memberId: row.id, name: nameOf(p), department: department(p) })
    }
    return out
  }

  /**
   * A steward names the owner of a space of their template (SPACE-MEMB-011, PROF-SPACE-009): when it has none, or on
   * request when it has one, the former owner staying a member; always with a reason of 1 to 500 characters.
   */
  public async stewardNames(
    principal: Principal,
    spaceId: string,
    target: PersonTarget,
    reason: unknown
  ): Promise<Space> {
    const space = await this.stewardOf(principal, spaceId)
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text || text.length > STEWARD_REASON_MAX)
      throw new SpaceError(`a reason of 1 to ${STEWARD_REASON_MAX} characters is required`, 'bad-request', 'reason')
    const to = await this.eligibleTarget(space, target)
    if (to.principalId === space.ownerPrincipalId) return space
    return this.changeOwner(space, to, 'steward', principal.id, text)
  }

  /** What was done in a space, newest first, a page at a time (`before` an activity id): for its owner. */
  public async activity(
    principal: Principal,
    spaceId: string,
    page: { before?: string; limit?: number } = {}
  ): Promise<{ items: SpaceActivity[]; nextBefore: string | null }> {
    await this.owned(principal, spaceId)
    const limit = Math.min(Math.max(1, page.limit ?? 50), 200)
    const all = await this.store.spaceActivity.list(spaceId, 10_000)
    const from = page.before ? all.findIndex((a) => a.id === page.before) + 1 : 0
    const items = from > 0 || !page.before ? all.slice(from, from + limit) : []
    const more = from + limit < all.length
    return { items, nextBefore: more && items.length ? (items[items.length - 1]?.id ?? null) : null }
  }

  public async record(
    spaceId: string,
    actorId: string,
    action: SpaceActivity['action'],
    detail: Pick<
      SpaceActivity,
      | 'fields'
      | 'memberId'
      | 'conversationId'
      | 'principalId'
      | 'directoryId'
      | 'sourceId'
      | 'featureId'
      | 'formerSourceId'
      | 'folderTitle'
      | 'how'
      | 'reason'
    >
  ): Promise<void> {
    await this.store.spaceActivity.insert({ id: prefixedId('act'), spaceId, at: nowIso(), actorId, action, ...detail })
  }

  /** How many people a space has: those its rule gives among the known Principals, or its listed members. */
  public memberCount(space: Space, rows: SpaceMember[], principals: Principal[]): number {
    if (isPersonalSpace(space.id)) return 1
    if (space.membership.mode === 'rule') {
      const rule = space.membership.rule
      // the owner is a member whatever the rule says (SPACE-MEMB-001)
      return principals.filter(
        (p) => p.id === space.ownerPrincipalId || ruleMatches(rule, membershipFacts(p, this.directory))
      ).length
    }
    return rows.filter((m) => m.spaceId === space.id && m.state !== 'left').length
  }

  // ---- handover ---------------------------------------------------------------------------------------------

  /**
   * The author of a conversation may share it with its own space (SPACE-SHARE-001, H1: only within the conversation's own
   * space) while they are a member of it and the space takes handovers.
   */
  public async mayShare(principal: Principal, conversation: Conversation): Promise<Space> {
    if (conversation.principalId !== principal.id) throw new SpaceError('conversation not found', 'not-found')
    if (conversation.state === 'final') throw new SpaceError('the conversation is closed for good', 'final')
    const spaceId = spaceIdOf(conversation)
    if (isPersonalSpace(spaceId))
      throw new SpaceError('a conversation of Personal is shared with nobody', 'handover-not-allowed')
    const access = await this.access(principal, spaceId)
    if (!access || access.left) throw new SpaceError('you are no longer a member of this space', 'space-left')
    if (!access.space.rules.handover) throw new SpaceError('this space takes no handover', 'handover-not-allowed')
    return access.space
  }

  /**
   * An active member reads the handovers of a space while it takes them; one who left reads none (404, profile
   * PROF-SPACE-007). A space that takes no handover has nothing shared: null, which lists nothing and reads 404.
   */
  public async readsHandovers(principal: Principal, spaceId: string): Promise<Space | null> {
    const access = await this.access(principal, spaceId)
    if (!access || access.left || isPersonalSpace(spaceId)) throw new SpaceError('space not found', 'not-found')
    return access.space.rules.handover ? access.space : null
  }
}
