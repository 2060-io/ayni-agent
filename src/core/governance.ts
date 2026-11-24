/**
 * The governance of a space (ayni-spec D135 to D142): whom the approval policy of each of its tools names, what that
 * policy decides, warns of and needs, and the notices of a space's governance.
 *
 * - **Who an entry names** (INTX-APPR-021): `owner`, the space's owner now; `person`, that member while they are an
 *   active member who is not a guest; `member`, every such member; `role` and `department`, every Principal of the home
 *   organization who holds the role, or whose directory entry carries the department, a member of the space or not.
 *   Never a guest, and never the requester but by their own confirmation (INTX-APPR-023).
 * - **A policy, as the owner sets it** (TOOL-SPACE-018, TOOL-SPACE-020, TOOL-SPACE-021): its checks and `422` codes, its
 *   warnings, and its attention.
 * - **In line with the people** (`review`): a successor who stopped being eligible is cleared (SPACE-MEMB-010); a space
 *   with no owner has its stewards told (SPACE-MEMB-012); a policy that needs attention has its owner told, and the
 *   approvals that can no longer be met expire (TOOL-SPACE-021, INTX-APPR-025). Idempotent: run when people change, a
 *   policy is saved, the owner changes, and at start.
 * - **A change of owner** (SPACE-MEMB-012): its members told, and the approvals that wait for the owner moved to the new
 *   one: closed on the former owner's phone, asked on the new owner's.
 */
import type { AgentPack } from '../config/packTypes.js'
import type { ApprovalService, SpacePolicyPort } from '../policy/approvals.js'
import {
  APPROVER_KINDS,
  attentionOf,
  defaultWhenApproverAsks,
  type EntryWords,
  entriesNaming,
  entryKey,
  everyoneNamed,
  type Named,
  type PolicyBounds,
  progressOf,
  warningsOf,
} from '../policy/spacePolicy.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { membershipFacts, type OwnerChanged, SpaceError, type SpaceService } from './spaces.js'
import type {
  ApprovalProgress,
  ApprovalRecord,
  ApproverEntry,
  GovernanceNotice,
  Principal,
  Space,
  SpaceApprovalPolicy,
} from './types.js'

/** A policy in force of a tool of a space whose rule is `approval`: the source, the tool and its title, its bounds. */
export interface PolicyInForce {
  sourceId: string
  tool: string
  title: string
  policy: SpaceApprovalPolicy
  bounds: PolicyBounds
}

/** The policies in force of a space's tools (the space's tools service). */
export interface SpacePolicies {
  policiesOf(space: Space): Promise<PolicyInForce[]>
}

/** An approver as a policy is read (PROF-TOOL-036): the owner's reading names who each entry names. */
export interface ApproverView {
  kind: ApproverEntry['kind']
  memberId?: string
  directoryId?: string
  name?: string
  role?: string
  department?: string
  required: boolean
}

export type PolicyWarning = { code: 'own-requests-blocked'; approvers: { name: string }[] } | { code: 'unreachable' }

/** A policy as the owner reads it (PROF-TOOL-036); a member reads its approvers and threshold only. */
export interface PolicyView {
  approvers: ApproverView[]
  threshold: number
  refusal?: SpaceApprovalPolicy['refusal']
  attested?: boolean
  whenApproverAsks?: SpaceApprovalPolicy['whenApproverAsks']
  state?: 'ok' | 'needs-attention'
  attention?: number[]
  warnings?: PolicyWarning[]
  bounds?: { minApprovals: number; kinds: ApproverEntry['kind'][]; roles: string[]; attested: 'optional' | 'required' }
}

const POLICY_FIELDS = ['approvers', 'threshold', 'refusal', 'attested', 'whenApproverAsks']

export interface GovernanceDeps {
  store: Store
  pack: AgentPack
  spaces: SpaceService
  approvals: ApprovalService
  /** a person as the agent names them to others: the directory's name, else the one the agent shows */
  nameOf: (principal: Principal) => string
  logger: Logger
}

export class Governance implements SpacePolicyPort {
  /** the policies in force of a space's tools */
  public policies?: SpacePolicies
  /** a notice entered or was resolved: the person's sessions hear it (PROF-TOOL-038) */
  public noticeChanged?: (notice: GovernanceNotice) => Promise<void>
  /** the phones of the approvers of an approval that moved to a new owner (SPACE-MEMB-012) */
  public phones?: {
    open(record: ApprovalRecord, principalId: string): Promise<void>
    close(record: ApprovalRecord, principalId: string): Promise<void>
  }

  public constructor(private readonly deps: GovernanceDeps) {}

  // ---- who an entry names (INTX-APPR-021) -------------------------------------------------------------------------

  /**
   * For each entry of a policy, the people it names in a space now (INTX-APPR-021): never a guest; the requester only when
   * the policy counts their own confirmation (INTX-APPR-023).
   */
  public async namedIn(
    space: Space,
    policy: SpaceApprovalPolicy,
    requesterId?: string,
    principals?: Principal[]
  ): Promise<Named> {
    const people = principals ?? (await this.deps.store.principals.list())
    const members = new Set(await this.deps.spaces.activeMemberIds(space, people))
    const rows = await this.deps.spaces.memberRows(space.id)
    const home = people.filter((p) => p.backingRelation === 'home')
    const entries = policy.approvers.map((entry): string[] => {
      switch (entry.kind) {
        case 'owner':
          return space.ownerPrincipalId ? [space.ownerPrincipalId] : []
        case 'person': {
          if (entry.memberId) {
            const row = rows.find((m) => m.id === entry.memberId)
            return row?.principalId && row.state === 'active' && row.role !== 'guest' && members.has(row.principalId)
              ? [row.principalId]
              : []
          }
          return people.filter((p) => p.directoryEntryId === entry.directoryId && members.has(p.id)).map((p) => p.id)
        }
        case 'member':
          return [...members]
        case 'role':
          return home.filter((p) => !!entry.role && p.roles.includes(entry.role)).map((p) => p.id)
        case 'department':
          return home
            .filter((p) => membershipFacts(p, this.deps.spaces.directory).department === entry.department)
            .map((p) => p.id)
      }
      return []
    })
    const own = !!requesterId && policy.whenApproverAsks === 'own-confirmation'
    return {
      entries: requesterId && !own ? entries.map((ids) => ids.filter((id) => id !== requesterId)) : entries,
      ownerless: !space.ownerPrincipalId,
    }
  }

  /** The people an approval of a tool of a space names now, and who may still decide it (SpacePolicyPort). */
  public async named(record: ApprovalRecord): Promise<{ named: Named; pool: string[] }> {
    const policy = record.spacePolicy as SpaceApprovalPolicy
    const space = record.spaceId ? await this.deps.spaces.find(record.spaceId) : undefined
    if (!space) return { named: { entries: policy.approvers.map(() => []), ownerless: false }, pool: [] }
    const named = await this.namedIn(space, policy, record.requesterId)
    return { named, pool: [...everyoneNamed(named)] }
  }

  /** The name of the person a `person` entry names, even once they left. */
  private async personName(space: Space, entry: ApproverEntry, people: Principal[]): Promise<string | undefined> {
    if (entry.memberId) {
      const row = (await this.deps.spaces.memberRows(space.id)).find((m) => m.id === entry.memberId)
      const p = row?.principalId ? people.find((each) => each.id === row.principalId) : undefined
      return p ? this.deps.nameOf(p) : undefined
    }
    if (!entry.directoryId) return undefined
    const p = people.find((each) => each.directoryEntryId === entry.directoryId)
    return p ? this.deps.nameOf(p) : this.deps.spaces.people?.view(entry.directoryId)?.name
  }

  /** How an entry reads (INTX-APPR-026): the name of the person it names, else its kind with its role or department. */
  private async words(space: Space | undefined, entry: ApproverEntry, people: Principal[]): Promise<EntryWords> {
    const base = { kind: entry.kind, required: entry.required }
    if (entry.kind === 'owner') {
      const owner = space?.ownerPrincipalId ? people.find((p) => p.id === space.ownerPrincipalId) : undefined
      return owner ? { ...base, name: this.deps.nameOf(owner) } : base
    }
    if (entry.kind === 'person') {
      const name = space ? await this.personName(space, entry, people) : undefined
      return name ? { ...base, name } : base
    }
    if (entry.kind === 'role') return { ...base, ...(entry.role ? { role: entry.role } : {}) }
    if (entry.kind === 'department') return { ...base, ...(entry.department ? { department: entry.department } : {}) }
    return base
  }

  /** Where an approval stands (SpacePolicyPort, INTX-APPR-026). */
  public async progress(record: ApprovalRecord, named: Named): Promise<ApprovalProgress> {
    const policy = record.spacePolicy as SpaceApprovalPolicy
    const space = record.spaceId ? await this.deps.spaces.find(record.spaceId) : undefined
    const people = await this.deps.store.principals.list()
    const words: EntryWords[] = []
    for (const entry of policy.approvers) words.push(await this.words(space, entry, people))
    return progressOf(policy, named, record.decisions, (_entry, i) => words[i] as EntryWords)
  }

  /**
   * The approvals an approver's `authorize` request carries (FLOW-AUTH-004, INTX-APPR-026): the threshold, whether the
   * approver decides their own request, and the other entries of the policy as they are when it is sent, each by the name
   * of the person it names, else by a label (a role, a department, any member, the owner of a space that has none), each
   * required or not. Undefined for an approval with no policy of a space.
   */
  public async approvalsFor(
    record: ApprovalRecord,
    approverId: string
  ): Promise<
    { threshold: number; own: boolean; others: { name?: string; label?: string; required: boolean }[] } | undefined
  > {
    const policy = record.spacePolicy
    if (!policy) return undefined
    const space = record.spaceId ? await this.deps.spaces.find(record.spaceId) : undefined
    const people = await this.deps.store.principals.list()
    const named = space ? await this.namedIn(space, policy, record.requesterId, people) : undefined
    const own = new Set(named ? entriesNaming(named, approverId) : [])
    const others: { name?: string; label?: string; required: boolean }[] = []
    for (const [i, entry] of policy.approvers.entries()) {
      if (own.has(i)) continue
      const words = await this.words(space, entry, people)
      if (words.name) others.push({ name: words.name, required: entry.required })
      else others.push({ label: labelOf(entry), required: entry.required })
    }
    return { threshold: policy.threshold, own: approverId === record.requesterId, others }
  }

  /** A policy's approvers as people read them: "Jonas Weber", "any member", "the role manager". */
  public async entryText(space: Space, entry: ApproverEntry): Promise<string> {
    const w = await this.words(space, entry, await this.deps.store.principals.list())
    if (w.name) return w.name
    if (entry.kind === 'owner') return 'the owner'
    if (entry.kind === 'member') return 'any member'
    if (entry.kind === 'role') return `the role ${entry.role}`
    if (entry.kind === 'department') return `the department ${entry.department}`
    return 'a member'
  }

  // ---- a policy, as the owner sets it (TOOL-SPACE-018, TOOL-SPACE-020, TOOL-SPACE-021) ---------------------------------

  /**
   * A whole policy the owner sends for a tool (TOOL-SPACE-018), checked: `400 bad-request` for a field or a value that is
   * not one of the policy's; `422` for an approver of a kind or a role the agent-pack does not allow, a person who is not
   * an active member or is a guest, an entry equal to an earlier one, a threshold below the pack's least number or below
   * the required entries, and attestation turned off where the pack requires it.
   */
  public async parsePolicy(
    space: Space,
    tool: string,
    raw: unknown,
    bounds: PolicyBounds
  ): Promise<SpaceApprovalPolicy> {
    const at = `approvals.${tool}`
    const bad = (what: string, field: string) => new SpaceError(what, 'bad-request', field)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('a policy is an object', at)
    const body = raw as Record<string, unknown>
    for (const key of Object.keys(body))
      if (!POLICY_FIELDS.includes(key)) throw bad(`${key} is not a field of a policy`, `${at}.${key}`)
    for (const key of ['approvers', 'threshold', 'refusal', 'attested'])
      if (body[key] === undefined) throw bad(`${key} is required`, `${at}.${key}`)
    if (!Array.isArray(body.approvers) || !body.approvers.length)
      throw bad('approvers is a list of at least one entry', `${at}.approvers`)
    const approvers: ApproverEntry[] = []
    for (const [i, value] of body.approvers.entries()) {
      const field = `${at}.approvers.${i}`
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('an approver is an object', field)
      const e = value as Record<string, unknown>
      if (!APPROVER_KINDS.includes(e.kind as ApproverEntry['kind'])) throw bad('an unknown kind of approver', field)
      if (typeof e.required !== 'boolean') throw bad('required is true or false', field)
      const kind = e.kind as ApproverEntry['kind']
      const own =
        kind === 'person'
          ? space.membership.mode === 'list'
            ? 'memberId'
            : 'directoryId'
          : kind === 'role'
            ? 'role'
            : kind === 'department'
              ? 'department'
              : undefined
      for (const key of Object.keys(e))
        if (key !== 'kind' && key !== 'required' && key !== own && key !== 'name')
          throw bad(`${key} is not a field of an approver ${kind}`, field)
      if (own && (typeof e[own] !== 'string' || !(e[own] as string).trim())) throw bad(`${own} is required`, field)
      approvers.push({ kind, ...(own ? { [own]: (e[own] as string).trim() } : {}), required: e.required })
    }
    if (typeof body.threshold !== 'number' || !Number.isInteger(body.threshold) || body.threshold < 1)
      throw bad('threshold is a whole number from 1', `${at}.threshold`)
    if (body.refusal !== 'any' && body.refusal !== 'required') throw bad('refusal is any or required', `${at}.refusal`)
    if (typeof body.attested !== 'boolean') throw bad('attested is true or false', `${at}.attested`)
    if (
      body.whenApproverAsks !== undefined &&
      body.whenApproverAsks !== 'another-approver' &&
      body.whenApproverAsks !== 'own-confirmation'
    )
      throw bad('whenApproverAsks is another-approver or own-confirmation', `${at}.whenApproverAsks`)
    const policy: SpaceApprovalPolicy = {
      approvers,
      threshold: body.threshold,
      refusal: body.refusal,
      attested: body.attested,
      whenApproverAsks:
        (body.whenApproverAsks as SpaceApprovalPolicy['whenApproverAsks'] | undefined) ??
        defaultWhenApproverAsks(approvers),
    }
    // the agent-pack's bounds and whom the entries name, entry by entry, in order
    const roles = this.deps.pack.identity.roles ?? {}
    const members = new Set(await this.deps.spaces.activeMemberIds(space))
    const rows = await this.deps.spaces.memberRows(space.id)
    const seen = new Set<string>()
    for (const [i, entry] of approvers.entries()) {
      const field = `${at}.approvers.${i}`
      const allowed =
        bounds.kinds.includes(entry.kind) &&
        (entry.kind !== 'role' ||
          (!!entry.role && bounds.roles.includes(entry.role) && !!roles[entry.role]?.canApprove))
      if (!allowed) throw new SpaceError('the agent-pack does not allow this approver', 'approver-not-allowed', field)
      if (entry.kind === 'person') {
        const eligible = entry.memberId
          ? rows.some(
              (m) =>
                m.id === entry.memberId &&
                m.state === 'active' &&
                m.role !== 'guest' &&
                !!m.principalId &&
                members.has(m.principalId)
            )
          : (await this.deps.spaces.holdersOf(entry.directoryId as string)).some((p) => members.has(p.id))
        if (!eligible)
          throw new SpaceError('an approver is an active member of the space who is not a guest', 'not-eligible', field)
      }
      const key = entryKey(entry)
      if (seen.has(key)) throw new SpaceError('this approver is named already', 'repeated-entry', field)
      seen.add(key)
    }
    if (policy.threshold < bounds.minApprovals)
      throw new SpaceError(
        `the agent-pack asks for ${bounds.minApprovals} approvals at least`,
        'below-pack-minimum',
        `${at}.threshold`
      )
    if (policy.threshold < approvers.filter((e) => e.required).length)
      throw new SpaceError(
        'the threshold counts every required approver',
        'threshold-below-required',
        `${at}.threshold`
      )
    if (bounds.attested === 'required' && !policy.attested)
      throw new SpaceError('the agent-pack requires decisions on the phone', 'attestation-required', `${at}.attested`)
    return policy
  }

  /** The warnings of a policy as the people its entries name now could act (TOOL-SPACE-020). */
  public async warnings(space: Space, policy: SpaceApprovalPolicy): Promise<PolicyWarning[]> {
    const people = await this.deps.store.principals.list()
    const named = await this.namedIn(space, policy, undefined, people)
    return warningsOf(policy, named).map((w) =>
      w.code === 'unreachable'
        ? w
        : {
            code: w.code,
            approvers: w.approvers.map((id) => {
              const p = people.find((each) => each.id === id)
              return { name: p ? this.deps.nameOf(p) : id }
            }),
          }
    )
  }

  /** The required entries of a policy that name nobody now (TOOL-SPACE-021). */
  public async attention(space: Space, policy: SpaceApprovalPolicy): Promise<number[]> {
    return attentionOf(policy, await this.namedIn(space, policy))
  }

  /** A policy as a member reads it, on a card and in the Notifications: its approvers and threshold (§3.12). */
  public async memberView(space: Space, policy: SpaceApprovalPolicy): Promise<PolicyView> {
    return this.view(space, policy, { minApprovals: 1, kinds: [], roles: [], attested: 'optional' }, false)
  }

  /**
   * A policy as its reader may read it (PROF-TOOL-036): to the owner whole, with its state, attention, warnings and the
   * agent-pack's bounds; to a member its approvers, by name, role or department, and its threshold.
   */
  public async view(
    space: Space,
    policy: SpaceApprovalPolicy,
    bounds: PolicyBounds,
    owner: boolean,
    warnings?: PolicyWarning[]
  ): Promise<PolicyView> {
    const people = await this.deps.store.principals.list()
    const approvers: ApproverView[] = []
    for (const entry of policy.approvers) {
      const w = await this.words(space, entry, people)
      approvers.push({
        kind: entry.kind,
        ...(owner && entry.memberId ? { memberId: entry.memberId } : {}),
        ...(owner && entry.directoryId ? { directoryId: entry.directoryId } : {}),
        ...(w.name ? { name: w.name } : {}),
        ...(entry.role ? { role: entry.role } : {}),
        ...(entry.department ? { department: entry.department } : {}),
        required: entry.required,
      })
    }
    if (!owner) return { approvers, threshold: policy.threshold }
    const attention = await this.attention(space, policy)
    return {
      approvers,
      threshold: policy.threshold,
      refusal: policy.refusal,
      attested: policy.attested,
      whenApproverAsks: policy.whenApproverAsks,
      state: attention.length ? 'needs-attention' : 'ok',
      attention,
      warnings: warnings ?? (await this.warnings(space, policy)),
      bounds: { ...bounds, kinds: [...bounds.kinds], roles: [...bounds.roles] },
    }
  }

  // ---- notices (INTX-APPR-027) -------------------------------------------------------------------------------------

  private async notice(
    principalId: string,
    space: Space,
    kind: GovernanceNotice['kind'],
    subject: Omit<GovernanceNotice['subject'], 'space'>
  ): Promise<GovernanceNotice> {
    const notice: GovernanceNotice = {
      id: prefixedId('ntc'),
      principalId,
      spaceId: space.id,
      kind,
      at: nowIso(),
      subject: { space: { id: space.id, title: space.title }, ...subject },
    }
    await this.deps.store.governanceNotices.save(notice)
    await this.told(notice)
    return notice
  }

  private async resolve(notice: GovernanceNotice): Promise<void> {
    if (notice.resolvedAt) return
    const resolved = { ...notice, resolvedAt: nowIso() }
    await this.deps.store.governanceNotices.save(resolved)
    await this.told(resolved)
  }

  private async told(notice: GovernanceNotice): Promise<void> {
    await this.noticeChanged?.(notice).catch((err) =>
      this.deps.logger.warn({ err, noticeId: notice.id }, 'a notice of a space was not announced')
    )
  }

  /** A call refused at once for want of an approver: the space's owner is told (INTX-APPR-024). */
  public async noApprover(record: ApprovalRecord, toolTitle: string): Promise<void> {
    const space = record.spaceId ? await this.deps.spaces.find(record.spaceId) : undefined
    if (!space?.ownerPrincipalId) return
    await this.notice(space.ownerPrincipalId, space, 'no-approver', {
      tool: { source: record.sourceId ?? '', name: record.toolName, title: toolTitle },
      requester: { displayName: record.requesterName },
    })
  }

  // ---- a change of owner (SPACE-MEMB-012) ---------------------------------------------------------------------------

  /**
   * The owner of a space changed, or it has none any more: its members are told who owns it now, the stewards of its
   * template that it has none; the approvals that wait for an entry `owner` and that the former owner had not decided
   * move to the new owner, closed on the former owner's phone and asked on the new owner's (a decision the former owner
   * made stays counted); then the space is brought in line.
   */
  public async ownerChanged(space: Space, change: OwnerChanged): Promise<void> {
    const people = await this.deps.store.principals.list()
    const name = (id: string | undefined) => {
      const p = id ? people.find((each) => each.id === id) : undefined
      return p ? { name: this.deps.nameOf(p) } : null
    }
    if (change.how === 'left') {
      // the former owner's phone holds them no more; the stewards hear of it in `review`, which keeps their notices in
      // line with the stewards there are
      await this.moveApprovals(space, change, people)
      await this.review(space)
      return
    }
    for (const n of await this.deps.store.governanceNotices.list({ spaceId: space.id, open: true }))
      if (
        n.kind === 'space-without-owner' ||
        (n.kind === 'policy-attention' && n.principalId !== space.ownerPrincipalId)
      )
        await this.resolve(n)
    const to = name(change.newId)
    for (const id of await this.deps.spaces.activeMemberIds(space, people))
      await this.notice(id, space, 'owner-changed', {
        how: change.how,
        from: name(change.formerId),
        ...(to ? { to } : {}),
        ...(change.reason ? { reason: change.reason } : {}),
      })
    await this.moveApprovals(space, change, people)
    await this.review(space)
  }

  private async moveApprovals(space: Space, change: OwnerChanged, people: Principal[]): Promise<void> {
    for (const record of await this.deps.store.approvals.list({ status: 'PENDING' })) {
      const policy = record.spacePolicy
      if (record.spaceId !== space.id || !policy?.approvers.some((e) => e.kind === 'owner')) continue
      const named = await this.namedIn(space, policy, record.requesterId, people)
      const decided = (id: string) => record.decisions.some((d) => d.approverId === id)
      const former = change.formerId
      if (former && !decided(former) && !entriesNaming(named, former).length) await this.phones?.close(record, former)
      const asked: string[] = []
      const next = change.newId
      if (next && !decided(next) && entriesNaming(named, next).length) {
        asked.push(next)
        if (!record.approverIds?.includes(next)) await this.phones?.open(record, next)
      }
      await this.deps.approvals.moved(record, asked)
    }
  }

  // ---- in line with the people (TOOL-SPACE-021, INTX-APPR-025, SPACE-MEMB-010, SPACE-MEMB-012) -----------------------

  /** Brings one space, or every space, in line with its people (idempotent). */
  public async review(only?: Space): Promise<void> {
    const spaces = only ? [(await this.deps.spaces.find(only.id)) ?? only] : await this.deps.spaces.all()
    for (const space of spaces)
      await this.reviewSpace(space).catch((err) =>
        this.deps.logger.error({ err, spaceId: space.id }, 'the governance of a space was not brought in line')
      )
  }

  private async reviewSpace(given: Space): Promise<void> {
    await this.deps.spaces.dropIneligibleSuccessor(given)
    const space = (await this.deps.spaces.find(given.id)) ?? given
    const open = await this.deps.store.governanceNotices.list({ spaceId: space.id, open: true })
    // a space with no owner: every steward of its template is told, once; an owner named, the notices end
    if (!space.ownerPrincipalId) {
      const stewards = await this.deps.spaces.stewardsOf(space.templateId)
      const told = new Set(open.filter((n) => n.kind === 'space-without-owner').map((n) => n.principalId))
      const formerOwner = await this.formerOwnerOf(space)
      const template = this.deps.spaces.templates().find((t) => t.id === space.templateId)
      for (const steward of stewards)
        if (!told.has(steward.id))
          await this.notice(steward.id, space, 'space-without-owner', {
            template: { id: space.templateId, title: template?.title ?? space.templateId },
            formerOwner,
          })
    } else for (const n of open) if (n.kind === 'space-without-owner') await this.resolve(n)
    // the policies that need attention: their owner is told, once; resolved once each entry names someone again
    const policies = (await this.policies?.policiesOf(space)) ?? []
    const people = await this.deps.store.principals.list()
    const key = (sourceId: string, tool: string) => `${sourceId}\u0000${tool}`
    const needing = new Map<string, { p: PolicyInForce; attention: number[] }>()
    for (const p of policies) {
      const attention = attentionOf(p.policy, await this.namedIn(space, p.policy, undefined, people))
      if (attention.length) needing.set(key(p.sourceId, p.tool), { p, attention })
    }
    const openAttention = open.filter((n) => n.kind === 'policy-attention')
    for (const n of openAttention) {
      const k = key(n.subject.tool?.source ?? '', n.subject.tool?.name ?? '')
      if (!needing.has(k) || n.principalId !== space.ownerPrincipalId) await this.resolve(n)
    }
    if (space.ownerPrincipalId)
      for (const [k, { p, attention }] of needing) {
        const already = openAttention.some(
          (n) =>
            n.principalId === space.ownerPrincipalId &&
            key(n.subject.tool?.source ?? '', n.subject.tool?.name ?? '') === k
        )
        if (already) continue
        const entries: EntryWords[] = []
        for (const i of attention) entries.push(await this.words(space, p.policy.approvers[i] as ApproverEntry, people))
        await this.notice(space.ownerPrincipalId, space, 'policy-attention', {
          tool: { source: p.sourceId, name: p.tool, title: p.title },
          entries,
        })
      }
    // the approvals that wait and can no longer be met end at once (INTX-APPR-025)
    for (const record of await this.deps.store.approvals.list({ status: 'PENDING' }))
      if (record.spaceId === space.id && record.spacePolicy) await this.deps.approvals.expireIfUnmeetable(record.id)
  }

  /** Who owned a space that has none: the last `owner-changed` or creation names them. */
  private async formerOwnerOf(space: Space): Promise<{ name: string } | null> {
    const activity = await this.deps.store.spaceActivity.list(space.id, 500)
    const last = activity.find((a) => a.action === 'owner-changed' || a.action === 'created')
    if (!last) return null
    let id: string | undefined = last.action === 'created' ? last.actorId : undefined
    if (last.action === 'owner-changed' && last.memberId)
      id = (await this.deps.store.spaceMembers.get(last.memberId))?.principalId ?? undefined
    const p = id ? await this.deps.store.principals.get(id) : undefined
    return p ? { name: this.deps.nameOf(p) } : null
  }
}

/** How an entry that names no one person reads on an approver's phone (FLOW-AUTH-004): its kind, its role or department. */
function labelOf(entry: ApproverEntry): string {
  if (entry.kind === 'role') return `The role ${entry.role ?? ''}`.trim()
  if (entry.kind === 'department') return `The department ${entry.department ?? ''}`.trim()
  if (entry.kind === 'member') return 'Any member of the space'
  if (entry.kind === 'owner') return 'The owner of the space'
  return 'A member of the space'
}
