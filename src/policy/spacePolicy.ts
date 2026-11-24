/**
 * The approval policy of a tool of a space (ayni-spec D137 to D141; INTX-APPR-020 to 026, TOOL-SPACE-018 to 021,
 * TOOL-CAT-023): the agent-pack's default and bounds, and what a policy decides over the people its entries name.
 *
 * Nothing here reads the store: the caller gives, for each entry of the policy, the people it names now (`Named`), and
 * the decisions made. A person counts once whatever number of entries name them; a decision keeps satisfying the entries
 * that named its maker when it was made (`satisfies`), whatever becomes of that person since (INTX-APPR-025). An entry
 * `owner` of a space that has no owner counts as one person who can (SPACE-MEMB-012, INTX-APPR-024).
 */
import type { AgentPack, PackApprovalPolicy, PackApproverEntry, ToolApprovalBounds } from '../config/packTypes.js'
import type {
  ApprovalDecision,
  ApprovalProgress,
  ApprovalRecord,
  ApproverEntry,
  ApproverKind,
  SpaceApprovalPolicy,
} from '../core/types.js'

export const APPROVER_KINDS: readonly ApproverKind[] = ['owner', 'person', 'member', 'role', 'department']

/** The kinds of approval of a space, each with its timeout (SPACE-DEF-008): in this version the call of a tool. */
export const APPROVAL_TIMEOUT_KINDS = ['tool-call'] as const
export type ApprovalTimeoutKind = (typeof APPROVAL_TIMEOUT_KINDS)[number]

/** A timeout's default and bounds when the agent-pack sets none, in minutes (SPACE-DEF-008). */
export const TIMEOUT_DEFAULTS: Record<ApprovalTimeoutKind, { default: number; min: number; max: number }> = {
  'tool-call': { default: 60, min: 5, max: 10_080 },
}

/** With no `approvals.spaces.default`: the owner, required, one approval, any refusal, attested, own confirmation. */
export const PACK_DEFAULT_POLICY: SpaceApprovalPolicy = {
  approvers: [{ kind: 'owner', required: true }],
  threshold: 1,
  refusal: 'any',
  attested: true,
  whenApproverAsks: 'own-confirmation',
}

/** What the agent-pack lets an owner set for one tool (TOOL-CAT-023). */
export interface PolicyBounds {
  minApprovals: number
  kinds: ApproverKind[]
  roles: string[]
  attested: 'optional' | 'required'
}

/** The default and the bounds of a kind's timeout (SPACE-DEF-008). */
export function timeoutBoundsOf(
  pack: Pick<AgentPack, 'approvals'>,
  kind: ApprovalTimeoutKind
): { default: number; min: number; max: number } {
  const set = pack.approvals?.spaces?.timeouts?.[kind] ?? {}
  const fallback = TIMEOUT_DEFAULTS[kind]
  return { default: set.default ?? fallback.default, min: set.min ?? fallback.min, max: set.max ?? fallback.max }
}

/** Every kind's default timeout: the rule `approvalTimeouts` of a new space (SPACE-DEF-008). */
export function defaultTimeouts(pack: Pick<AgentPack, 'approvals'>): Record<string, number> {
  return Object.fromEntries(APPROVAL_TIMEOUT_KINDS.map((k) => [k, timeoutBoundsOf(pack, k).default]))
}

/** The roles a `role` entry may name by default: every declared role with `canApprove`. */
function approverRoles(pack: Pick<AgentPack, 'identity'>): string[] {
  return Object.entries(pack.identity.roles ?? {})
    .filter(([, r]) => r?.canApprove)
    .map(([name]) => name)
}

/** The bounds of a tool's policy: `approvals.spaces`, tightened by the tool's own `approval` (TOOL-CAT-023). */
export function boundsOf(pack: Pick<AgentPack, 'approvals' | 'identity'>, tool?: ToolApprovalBounds): PolicyBounds {
  const spaces = pack.approvals?.spaces
  const attested = spaces?.attested === 'required' || tool?.attested === 'required' ? 'required' : 'optional'
  return {
    minApprovals: Math.max(spaces?.minApprovals ?? 1, tool?.minApprovals ?? 1),
    kinds: [...(spaces?.allowedApprovers?.kinds ?? APPROVER_KINDS)],
    roles: [...(spaces?.allowedApprovers?.roles ?? approverRoles(pack))],
    attested,
  }
}

/**
 * `whenApproverAsks` of a policy saved without it (INTX-APPR-023): own confirmation when its approvers are one entry that
 * names one person (`owner` or `person`), another approver otherwise.
 */
export function defaultWhenApproverAsks(
  approvers: Pick<ApproverEntry, 'kind'>[]
): SpaceApprovalPolicy['whenApproverAsks'] {
  const [only] = approvers
  return approvers.length === 1 && (only?.kind === 'owner' || only?.kind === 'person')
    ? 'own-confirmation'
    : 'another-approver'
}

function entryOfPack(entry: PackApproverEntry): ApproverEntry {
  return {
    kind: entry.kind,
    ...(entry.role ? { role: entry.role } : {}),
    ...(entry.department ? { department: entry.department } : {}),
    required: entry.required,
  }
}

/** The fields an agent-pack's policy gives over another (`default` of a tool over `approvals.spaces.default`). */
function over(base: SpaceApprovalPolicy, given: PackApprovalPolicy | undefined): SpaceApprovalPolicy {
  if (!given) return base
  const approvers = given.approvers ? given.approvers.map(entryOfPack) : base.approvers
  return {
    approvers,
    threshold: given.threshold ?? base.threshold,
    refusal: given.refusal ?? base.refusal,
    attested: given.attested ?? base.attested,
    whenApproverAsks:
      given.whenApproverAsks ?? (given.approvers ? defaultWhenApproverAsks(approvers) : base.whenApproverAsks),
  }
}

/** The policy a tool of a space takes until the owner sets one (TOOL-CAT-023, D140). */
export function defaultPolicyOf(pack: Pick<AgentPack, 'approvals'>, tool?: ToolApprovalBounds): SpaceApprovalPolicy {
  return over(over(PACK_DEFAULT_POLICY, pack.approvals?.spaces?.default), tool?.default)
}

/** What makes two entries the same (TOOL-SPACE-018 `repeated-entry`): their kind and whom they name. */
export function entryKey(
  entry: Pick<ApproverEntry, 'kind' | 'memberId' | 'directoryId' | 'role' | 'department'>
): string {
  return [entry.kind, entry.memberId ?? '', entry.directoryId ?? '', entry.role ?? '', entry.department ?? ''].join(
    '\u0000'
  )
}

/** Why a policy breaks its bounds, the first reason only, or nothing (TOOL-SPACE-018, TOOL-CAT-023). */
export function boundsError(
  policy: SpaceApprovalPolicy,
  bounds: PolicyBounds,
  declaredRoles: (role: string) => boolean
): { code: string; field: string } | undefined {
  const seen = new Set<string>()
  for (const [i, entry] of policy.approvers.entries()) {
    const field = `approvers.${i}`
    if (!bounds.kinds.includes(entry.kind)) return { code: 'approver-not-allowed', field }
    if (entry.kind === 'role' && (!entry.role || !bounds.roles.includes(entry.role) || !declaredRoles(entry.role)))
      return { code: 'approver-not-allowed', field }
    const key = entryKey(entry)
    if (seen.has(key)) return { code: 'repeated-entry', field }
    seen.add(key)
  }
  if (policy.threshold < bounds.minApprovals) return { code: 'below-pack-minimum', field: 'threshold' }
  if (policy.threshold < policy.approvers.filter((e) => e.required).length)
    return { code: 'threshold-below-required', field: 'threshold' }
  if (bounds.attested === 'required' && !policy.attested) return { code: 'attestation-required', field: 'attested' }
  return undefined
}

// ---- what a policy decides (INTX-APPR-021, INTX-APPR-024, INTX-APPR-025) ---------------------------------------------

/** For each entry of a policy, the people it names now; and whether the space has no owner (its `owner` entry can). */
export interface Named {
  entries: string[][]
  ownerless: boolean
}

/** The entries of a policy that name a person now. */
export function entriesNaming(named: Named, principalId: string): number[] {
  return named.entries.flatMap((ids, i) => (ids.includes(principalId) ? [i] : []))
}

/** The entries the approvals given satisfy. */
export function satisfiedBy(decisions: ApprovalDecision[], named: Named): Set<number> {
  const out = new Set<number>()
  for (const d of decisions) {
    if (d.decision !== 'approve') continue
    for (const i of d.satisfies ?? entriesNaming(named, d.approverId)) out.add(i)
  }
  return out
}

/** How many approvals count: one per person, whatever number of entries name them. */
export function approvalsCounted(decisions: ApprovalDecision[]): number {
  return new Set(decisions.filter((d) => d.decision === 'approve').map((d) => d.approverId)).size
}

/**
 * Whether the people who have not decided (`pool`, those who may still decide) can still bring the approval to its
 * threshold with every required entry satisfied. Taking them all is the best they can do.
 */
export function canStillMeet(
  policy: SpaceApprovalPolicy,
  named: Named,
  decisions: ApprovalDecision[],
  pool: Iterable<string>
): boolean {
  const decided = new Set(decisions.map((d) => d.approverId))
  const remaining = new Set([...pool].filter((id) => !decided.has(id)))
  const satisfied = satisfiedBy(decisions, named)
  // an owner a steward will name: one person more, who satisfies the `owner` entries
  const phantom = named.ownerless && policy.approvers.some((e, i) => e.kind === 'owner' && !satisfied.has(i))
  for (const [i, entry] of policy.approvers.entries()) {
    if (!entry.required || satisfied.has(i)) continue
    if (entry.kind === 'owner' && named.ownerless) continue
    if (!(named.entries[i] ?? []).some((id) => remaining.has(id))) return false
  }
  return approvalsCounted(decisions) + remaining.size + (phantom ? 1 : 0) >= policy.threshold
}

/**
 * The status the decisions give (INTX-APPR-021): approved once every required entry is satisfied and the approvals reach
 * the threshold; rejected at a refusal the refusal rule counts (any refusal, or a required approver's; a requester's
 * refusal of their own confirmation always), or as soon as the people who may still decide (`pool`) can no longer bring
 * it there. A refusal that rejects nothing counts for nothing.
 */
export function statusOf(
  policy: SpaceApprovalPolicy,
  named: Named,
  decisions: ApprovalDecision[],
  pool: Iterable<string>
): 'APPROVED' | 'REJECTED' | 'PENDING' {
  const satisfied = satisfiedBy(decisions, named)
  const required = policy.approvers.flatMap((e, i) => (e.required ? [i] : []))
  if (required.every((i) => satisfied.has(i)) && approvalsCounted(decisions) >= policy.threshold) return 'APPROVED'
  for (const d of decisions) {
    if (d.decision !== 'reject') continue
    if (d.self || policy.refusal === 'any') return 'REJECTED'
    const entries = d.satisfies ?? entriesNaming(named, d.approverId)
    if (entries.some((i) => policy.approvers[i]?.required)) return 'REJECTED'
  }
  return canStillMeet(policy, named, decisions, pool) ? 'PENDING' : 'REJECTED'
}

/** Every person some entry names now. */
export function everyoneNamed(named: Named): Set<string> {
  return new Set(named.entries.flat())
}

/**
 * The warnings of a policy as the people its entries name now could act (TOOL-SPACE-020): nobody's requests could ever
 * be approved (`unreachable`); or, under another approver, the approvers whose own requests the others could never
 * approve (`own-requests-blocked`). A warning refuses nothing.
 */
export function warningsOf(
  policy: SpaceApprovalPolicy,
  named: Named
): ({ code: 'unreachable' } | { code: 'own-requests-blocked'; approvers: string[] })[] {
  const everyone = everyoneNamed(named)
  if (!canStillMeet(policy, named, [], everyone)) return [{ code: 'unreachable' }]
  if (policy.whenApproverAsks === 'own-confirmation') return []
  const blocked = [...everyone].filter(
    (id) =>
      !canStillMeet(
        policy,
        { ...named, entries: named.entries.map((ids) => ids.filter((x) => x !== id)) },
        [],
        [...everyone].filter((x) => x !== id)
      )
  )
  return blocked.length ? [{ code: 'own-requests-blocked', approvers: blocked }] : []
}

/**
 * The required entries that name nobody (TOOL-SPACE-021): a person who is no longer an active member, a role or a
 * department nobody eligible holds. An `owner` entry of a space that has no owner waits for the owner a steward names.
 */
export function attentionOf(policy: SpaceApprovalPolicy, named: Named): number[] {
  return policy.approvers.flatMap((e, i) =>
    e.required && !(e.kind === 'owner' && named.ownerless) && !(named.entries[i] ?? []).length ? [i] : []
  )
}

/** How a person reads an entry: the name of the person it names (`owner`, `person`), else its kind, role, department. */
export type EntryWords = ApprovalProgress['waitingFor'][number]

/** Where an approval stands (INTX-APPR-026): the threshold, the approvals counted, the entries not satisfied, required first. */
export function progressOf(
  policy: SpaceApprovalPolicy,
  named: Named,
  decisions: ApprovalDecision[],
  words: (entry: ApproverEntry, index: number) => EntryWords
): ApprovalProgress {
  const satisfied = satisfiedBy(decisions, named)
  const open = policy.approvers.flatMap((e, i) => (satisfied.has(i) ? [] : [{ e, i }]))
  open.sort((a, b) => Number(b.e.required) - Number(a.e.required) || a.i - b.i)
  return {
    threshold: policy.threshold,
    approvals: approvalsCounted(decisions),
    waitingFor: open.map(({ e, i }) => words(e, i)),
  }
}

// ---- looser or stricter (TOOL-SPACE-019, D140) ----------------------------------------------------------------------

/**
 * Whether a change of policy could let a call be approved by decisions the policy in force would not accept: an optional
 * approver added, a required approver made optional or removed, the threshold lowered, `refusal` from `any` to
 * `required`, `attested` turned off, `own-confirmation` chosen. Anything else only narrows.
 */
export function isLooser(before: SpaceApprovalPolicy, after: SpaceApprovalPolicy): boolean {
  const was = new Map(before.approvers.map((e) => [entryKey(e), e.required]))
  const is = new Map(after.approvers.map((e) => [entryKey(e), e.required]))
  for (const [key, required] of is) if (!required && was.get(key) !== false) return true
  for (const [key, required] of was) if (required && is.get(key) !== true) return true
  if (after.threshold < before.threshold) return true
  if (before.refusal === 'any' && after.refusal === 'required') return true
  if (before.attested && !after.attested) return true
  return before.whenApproverAsks !== 'own-confirmation' && after.whenApproverAsks === 'own-confirmation'
}

/** Whether two policies are the same. */
export function samePolicy(a: SpaceApprovalPolicy, b: SpaceApprovalPolicy): boolean {
  const entries = (p: SpaceApprovalPolicy) =>
    p.approvers
      .map((e) => `${entryKey(e)}\u0001${e.required}`)
      .sort()
      .join('\u0002')
  return (
    entries(a) === entries(b) &&
    a.threshold === b.threshold &&
    a.refusal === b.refusal &&
    a.attested === b.attested &&
    a.whenApproverAsks === b.whenApproverAsks
  )
}

/** A policy as people read it: "Jonas Weber (required), Marta Kova, 2 approvals" (TOOL-SPACE-019). */
export function policyWords(policy: SpaceApprovalPolicy, nameOf: (entry: ApproverEntry) => string): string {
  const anyRequired = policy.approvers.some((e) => e.required)
  const names = policy.approvers.map((e) => (e.required ? `${nameOf(e)} (required)` : nameOf(e)))
  const who = anyRequired ? names.join(', ') : names.join(' or ')
  return `${who}, ${policy.threshold} approval${policy.threshold === 1 ? '' : 's'}`
}

/** Whether an approval's decision of a person must be attested: the policy says so, or it is their own (INTX-APPR-023). */
export function attestedFor(
  record: Pick<ApprovalRecord, 'attested' | 'spacePolicy' | 'requesterId'>,
  approverId: string
): boolean {
  if (record.spacePolicy) return record.spacePolicy.attested || approverId === record.requesterId
  return record.attested === true
}
