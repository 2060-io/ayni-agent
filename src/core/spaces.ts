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
import type { SpaceMemberRepo, SpaceRepo, Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { DirectoryView } from './directory.js'
import type {
  Conversation,
  LawfulBasis,
  Principal,
  Space,
  SpaceActivity,
  SpaceMember,
  SpaceMembership,
  SpaceRole,
  SpaceRules,
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
  | 'not-implemented'

/** The status of each refusal (profile 3.3 §9); `ERROR_STATUS` of the profile package lists the same. */
export const SPACE_ERROR_STATUS: Record<SpaceErrorCode, number> = {
  'not-found': 404,
  'bad-request': 400,
  'not-creator': 403,
  'not-owner': 403,
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
  'not-implemented': 501,
}

export class SpaceError extends Error {
  public readonly status: number
  public constructor(
    message: string,
    public readonly code: SpaceErrorCode,
    /** the field a refusal names: the rule outside the bounds of the template */
    public readonly field?: string
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
    delete: (id) => repo.delete(id),
  }
}

/** What a template gives a new space and lets an owner change, its bounds resolved against the pack (SPACE-DEF-003). */
export interface ResolvedTemplate {
  template: SpaceTemplate
  retentionDays: { default: number; min?: number; max?: number }
  lawfulBasis: { default: LawfulBasis; allowed: LawfulBasis[] }
  allowedProviders: { default: string[]; allowed: string[] }
  handover: { default: boolean; allowed: boolean[] }
}

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

  public constructor(
    private readonly store: Store,
    private readonly pack: AgentPack,
    crypto: EntryCrypto,
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
    }
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
      ownerIds: [principal.id],
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
    if (row?.state === 'active') return { space, role: row.role, left: false, member: row }
    if (space.ownerIds.includes(principal.id))
      return { space, role: 'owner', left: false, ...(row ? { member: row } : {}) }
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
      },
      membership:
        template.membership.mode === 'list'
          ? { mode: 'list' }
          : { mode: 'rule', rule: { ...template.membership.rule } },
      ownerIds: [principal.id],
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
      for (const key of ['retentionDays', 'lawfulBasis', 'allowedProviders', 'handover'] as const)
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
   * `invited` until a Principal holds that entry, then `active`. A person of another organization, by its organization
   * key and email, comes with the invitations (agent phase 2b: 501 meanwhile).
   */
  public async addMember(principal: Principal, spaceId: string, body: Record<string, unknown>): Promise<SpaceMember> {
    const { space } = await this.owned(principal, spaceId)
    if (space.membership.mode === 'rule')
      throw new SpaceError('the members of this space are given by its rule', 'rule-membership')
    if (typeof body.directoryId === 'string' && body.directoryId)
      return this.addFromDirectory(principal, space, body.directoryId)
    if (body.organizationKey !== undefined || body.email !== undefined)
      throw new SpaceError('inviting a person of another organization comes with the invitations', 'not-implemented')
    throw new SpaceError('directoryId, or organizationKey and email, is required', 'bad-request')
  }

  private async addFromDirectory(principal: Principal, space: Space, directoryId: string): Promise<SpaceMember> {
    if (!this.people?.view(directoryId)) throw new SpaceError('person not found', 'not-found')
    const holders = await this.holdersOf(directoryId)
    if (holders.some((h) => space.ownerIds.includes(h.id)))
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
    return (await this.all()).some((s) => s.membership.mode === 'list' && s.ownerIds.includes(principal.id))
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
    if (row.role === 'owner' || (row.principalId && space.ownerIds.includes(row.principalId)))
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
    const left: SpaceMember = { ...row, state: 'left', updatedAt: nowIso() }
    await this.members.save(left)
    await this.record(spaceId, principal.id, 'removed', detail)
    return left
  }

  /**
   * An owner gives the space to another person (SPACE-MEMB-007, PROF-SPACE-006): in a list space an active member who is
   * not a guest, by `memberId`; in a rule space a person the rule matches who holds a Principal, by `directoryId`. The
   * former owner stays a member; any other target is not eligible.
   */
  public async transferOwner(
    principal: Principal,
    spaceId: string,
    target: { memberId?: unknown; directoryId?: unknown }
  ): Promise<Space> {
    const { space } = await this.owned(principal, spaceId)
    if (space.membership.mode === 'rule') {
      if (typeof target.directoryId !== 'string' || !target.directoryId)
        throw new SpaceError('a rule space is given to a person of the directory the rule matches', 'not-eligible')
      return this.transferToEntry(principal, space, target.directoryId)
    }
    if (typeof target.memberId !== 'string' || !target.memberId)
      throw new SpaceError('a list space is given to one of its active members', 'not-eligible')
    return this.transferToMember(principal, space, target.memberId)
  }

  private async transferToEntry(principal: Principal, space: Space, directoryId: string): Promise<Space> {
    const rule = (space.membership as Extract<SpaceMembership, { mode: 'rule' }>).rule
    const target = (await this.holdersOf(directoryId)).find((p) =>
      ruleMatches(rule, membershipFacts(p, this.directory))
    )
    if (!target)
      throw new SpaceError(
        'the space can be given to a person the rule matches who holds a badge from the directory',
        'not-eligible'
      )
    if (space.ownerIds.includes(target.id)) return space
    const rows = await this.members.listBySpace(space.id)
    const mine = rows.find((m) => m.principalId === principal.id && m.state === 'active')
    const theirs = rows.find((m) => m.principalId === target.id)
    const now = nowIso()
    const row: SpaceMember = {
      ...(theirs ?? { id: prefixedId('mem'), spaceId: space.id, createdAt: now }),
      principalId: target.id,
      directoryId,
      state: 'active',
      role: 'owner',
      updatedAt: now,
    }
    await this.members.save(row)
    if (mine) await this.members.save({ ...mine, role: 'member', updatedAt: now })
    const next: Space = {
      ...space,
      ownerIds: [...space.ownerIds.filter((id) => id !== principal.id && id !== target.id), target.id],
      updatedAt: now,
    }
    await this.spaces.save(next)
    await this.record(space.id, principal.id, 'owner-changed', { memberId: row.id, directoryId })
    return next
  }

  private async transferToMember(principal: Principal, space: Space, memberId: string): Promise<Space> {
    const spaceId = space.id
    const mine = (await this.members.listBySpace(spaceId)).find(
      (m) => m.principalId === principal.id && m.state === 'active'
    )
    const target = await this.members.get(memberId)
    if (
      !target ||
      target.spaceId !== spaceId ||
      target.state !== 'active' ||
      !target.principalId ||
      target.role === 'guest'
    )
      throw new SpaceError('the space can be given to an active member of the organization only', 'not-eligible')
    if (target.principalId === principal.id) return space
    const now = nowIso()
    await this.members.save({ ...target, role: 'owner', updatedAt: now })
    if (mine) await this.members.save({ ...mine, role: 'member', updatedAt: now })
    const ownerIds = [
      ...space.ownerIds.filter((id) => id !== principal.id && id !== target.principalId),
      target.principalId,
    ]
    const next: Space = { ...space, ownerIds, updatedAt: now }
    await this.spaces.save(next)
    await this.record(spaceId, principal.id, 'owner-changed', { memberId })
    return next
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
    detail: Pick<SpaceActivity, 'fields' | 'memberId' | 'conversationId' | 'principalId' | 'directoryId'>
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
        (p) => space.ownerIds.includes(p.id) || ruleMatches(rule, membershipFacts(p, this.directory))
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
   * PROF-SPACE-007).
   */
  public async readsHandovers(principal: Principal, spaceId: string): Promise<Space> {
    const access = await this.access(principal, spaceId)
    if (!access || access.left || isPersonalSpace(spaceId)) throw new SpaceError('space not found', 'not-found')
    if (!access.space.rules.handover) throw new SpaceError('this space takes no handover', 'handover-not-allowed')
    return access.space
  }
}
