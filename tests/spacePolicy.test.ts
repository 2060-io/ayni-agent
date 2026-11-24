/**
 * What an approval policy of a tool of a space decides, over the people its entries name (ayni-spec D137 to D140):
 * INTX-APPR-020, 021, 023, 024, 026; TOOL-SPACE-019, 020, 021; TOOL-CAT-023. Pure: no store, no agent.
 */
import { describe, expect, it } from 'vitest'
import type { ApprovalDecision, SpaceApprovalPolicy } from '../src/core/types.js'
import {
  attentionOf,
  boundsError,
  boundsOf,
  canStillMeet,
  defaultPolicyOf,
  defaultWhenApproverAsks,
  isLooser,
  type Named,
  PACK_DEFAULT_POLICY,
  policyWords,
  progressOf,
  statusOf,
  warningsOf,
} from '../src/policy/spacePolicy.js'

const policy = (p: Partial<SpaceApprovalPolicy>): SpaceApprovalPolicy => ({ ...PACK_DEFAULT_POLICY, ...p })
const approve = (approverId: string, satisfies?: number[]): ApprovalDecision => ({
  approverId,
  approverName: approverId,
  role: '',
  decision: 'approve',
  ts: '2026-11-24T10:00:00.000Z',
  ...(satisfies ? { satisfies } : {}),
})
const reject = (approverId: string, satisfies?: number[]): ApprovalDecision => ({
  ...approve(approverId, satisfies),
  decision: 'reject',
})

// Jonas, the owner, required; every member (Jonas, Ben, Marta), optional; threshold 2
const ownerAndMembers = policy({
  approvers: [
    { kind: 'owner', required: true },
    { kind: 'member', required: false },
  ],
  threshold: 2,
  whenApproverAsks: 'another-approver',
})
const named: Named = { entries: [['jonas'], ['jonas', 'ben', 'marta']], ownerless: false }
const everyone = ['jonas', 'ben', 'marta']

describe('a policy decides over the people it names (INTX-APPR-021)', () => {
  it('approves once every required entry is satisfied and the approvals reach the threshold, a person counting once', () => {
    expect(statusOf(ownerAndMembers, named, [approve('ben'), approve('jonas')], everyone)).toBe('APPROVED')
    expect(statusOf(ownerAndMembers, named, [approve('ben'), approve('marta')], everyone)).toBe('PENDING')
    // Jonas, the owner and a member, counts once: one approval of two
    expect(statusOf(ownerAndMembers, named, [approve('jonas')], everyone)).toBe('PENDING')
  })

  it('rejects at a refusal the refusal rule counts, and counts any other for nothing', () => {
    const required = { ...ownerAndMembers, refusal: 'required' as const }
    expect(statusOf(required, named, [reject('marta', [1])], everyone)).toBe('PENDING')
    expect(statusOf(required, named, [reject('jonas', [0, 1])], everyone)).toBe('REJECTED')
    expect(statusOf(ownerAndMembers, named, [reject('marta', [1])], everyone)).toBe('REJECTED')
  })

  it('rejects as soon as the people who have not decided can no longer bring it to approved', () => {
    const two = policy({
      approvers: [
        { kind: 'person', memberId: 'm-marta', required: true },
        { kind: 'person', memberId: 'm-ben', required: false },
      ],
      threshold: 2,
      refusal: 'required',
    })
    const both: Named = { entries: [['marta'], ['ben']], ownerless: false }
    // Ben's refusal counts for nothing under `required`, and two approvals can no longer be had
    expect(statusOf(two, both, [reject('ben', [1])], ['marta', 'ben'])).toBe('REJECTED')
  })

  it('keeps a decision counted for the entries that named its maker, whoever they name now (INTX-APPR-025)', () => {
    const gone: Named = { entries: [[], ['ben', 'marta']], ownerless: false }
    expect(statusOf(ownerAndMembers, gone, [approve('jonas', [0, 1]), approve('ben', [1])], ['ben', 'marta'])).toBe(
      'APPROVED'
    )
  })

  it('counts an owner a steward will name as one who can, while a space has no owner (SPACE-MEMB-012)', () => {
    const ownerless: Named = { entries: [[], ['ben', 'marta']], ownerless: true }
    expect(canStillMeet(ownerAndMembers, ownerless, [], ['ben', 'marta'])).toBe(true)
    expect(canStillMeet(ownerAndMembers, { ...ownerless, ownerless: false }, [], ['ben', 'marta'])).toBe(false)
    expect(attentionOf(ownerAndMembers, ownerless)).toEqual([])
  })

  it('gives the progress: the threshold, the approvals, the entries not satisfied, required first (INTX-APPR-026)', () => {
    const marta = policy({
      approvers: [
        { kind: 'person', memberId: 'm-marta', required: false },
        { kind: 'owner', required: true },
      ],
      threshold: 2,
    })
    const people: Named = { entries: [['marta'], ['jonas']], ownerless: false }
    const progress = progressOf(marta, people, [approve('marta', [0])], (e) => ({
      kind: e.kind,
      name: e.kind === 'owner' ? 'Jonas Weber' : 'Marta Kova',
      required: e.required,
    }))
    expect(progress).toEqual({
      threshold: 2,
      approvals: 1,
      waitingFor: [{ kind: 'owner', name: 'Jonas Weber', required: true }],
    })
  })
})

describe('what a policy warns of and needs (TOOL-SPACE-020, TOOL-SPACE-021)', () => {
  const jonasAndMarta = policy({
    approvers: [
      { kind: 'owner', required: true },
      { kind: 'person', memberId: 'm-marta', required: false },
    ],
    threshold: 2,
    whenApproverAsks: 'another-approver',
  })
  const people: Named = { entries: [['jonas'], ['marta']], ownerless: false }

  it('warns own-requests-blocked for each approver the others cannot approve without, under another approver', () => {
    expect(warningsOf(jonasAndMarta, people)).toEqual([{ code: 'own-requests-blocked', approvers: ['jonas', 'marta'] }])
    expect(warningsOf({ ...jonasAndMarta, whenApproverAsks: 'own-confirmation' }, people)).toEqual([])
    expect(warningsOf({ ...jonasAndMarta, threshold: 3 }, people)).toEqual([{ code: 'unreachable' }])
  })

  it('needs attention while a required entry names nobody', () => {
    const marta = policy({ approvers: [{ kind: 'person', memberId: 'm-marta', required: true }] })
    expect(attentionOf(marta, { entries: [[]], ownerless: false })).toEqual([0])
    expect(attentionOf(marta, { entries: [['marta']], ownerless: false })).toEqual([])
  })
})

describe('looser and stricter (TOOL-SPACE-019)', () => {
  const owner = PACK_DEFAULT_POLICY
  const marta = { kind: 'person' as const, memberId: 'm-marta' }

  it('takes as looser what could let decisions approve that the policy in force would not accept', () => {
    expect(isLooser(owner, { ...owner, approvers: [...owner.approvers, { ...marta, required: false }] })).toBe(true)
    expect(isLooser(owner, { ...owner, approvers: [{ kind: 'owner', required: false }] })).toBe(true)
    expect(isLooser({ ...owner, threshold: 2 }, owner)).toBe(true)
    expect(isLooser(owner, { ...owner, refusal: 'required' })).toBe(true)
    expect(isLooser(owner, { ...owner, attested: false })).toBe(true)
    expect(isLooser({ ...owner, whenApproverAsks: 'another-approver' }, owner)).toBe(true)
  })

  it('takes anything else as stricter', () => {
    const withMarta = { ...owner, approvers: [...owner.approvers, { ...marta, required: false }] }
    expect(isLooser(withMarta, owner)).toBe(false)
    expect(
      isLooser(owner, { ...owner, approvers: [...owner.approvers, { ...marta, required: true }], threshold: 2 })
    ).toBe(false)
    expect(isLooser(owner, { ...owner, threshold: 2 })).toBe(false)
    expect(isLooser({ ...owner, refusal: 'required' }, owner)).toBe(false)
    expect(isLooser(owner, { ...owner, whenApproverAsks: 'another-approver' })).toBe(false)
  })

  it('reads a policy as people do', () => {
    const words = policyWords(
      { ...owner, approvers: [...owner.approvers, { ...marta, required: false }], threshold: 2 },
      (e) => (e.kind === 'owner' ? 'Jonas Weber' : 'Marta Kova')
    )
    expect(words).toBe('Jonas Weber (required), Marta Kova, 2 approvals')
    expect(
      policyWords(
        {
          ...owner,
          approvers: [
            { kind: 'owner', required: false },
            { ...marta, required: false },
          ],
        },
        (e) => (e.kind === 'owner' ? 'Jonas Weber' : 'Marta Kova')
      )
    ).toBe('Jonas Weber or Marta Kova, 1 approval')
  })
})

describe("the agent-pack's default and bounds (TOOL-CAT-023, INTX-APPR-023)", () => {
  const roles = { manager: { description: 'm', canApprove: true }, intern: { description: 'i' } }
  const pack = (spaces?: Record<string, unknown>) =>
    ({ identity: { roles }, approvals: spaces ? { spaces } : undefined }) as never

  it('defaults to the owner, required, one approval, any refusal, attested, own confirmation', () => {
    expect(defaultPolicyOf(pack())).toEqual(PACK_DEFAULT_POLICY)
    expect(boundsOf(pack())).toEqual({
      minApprovals: 1,
      kinds: ['owner', 'person', 'member', 'role', 'department'],
      roles: ['manager'],
      attested: 'optional',
    })
  })

  it("takes a tool's fields over the pack's default, and its bounds over the pack's", () => {
    const tool = { minApprovals: 2, attested: 'required' as const, default: { threshold: 2 } }
    const merged = defaultPolicyOf(pack(), tool)
    expect(merged).toMatchObject({ approvers: [{ kind: 'owner', required: true }], threshold: 2 })
    expect(boundsOf(pack(), tool)).toMatchObject({ minApprovals: 2, attested: 'required' })
    expect(
      boundsError(defaultPolicyOf(pack(), { minApprovals: 2 }), boundsOf(pack(), { minApprovals: 2 }), () => true)
    ).toEqual({ code: 'below-pack-minimum', field: 'threshold' })
  })

  it('saves own confirmation with one entry naming one person, another approver otherwise', () => {
    expect(defaultWhenApproverAsks([{ kind: 'owner' }])).toBe('own-confirmation')
    expect(defaultWhenApproverAsks([{ kind: 'person' }])).toBe('own-confirmation')
    expect(defaultWhenApproverAsks([{ kind: 'role' }])).toBe('another-approver')
    expect(defaultWhenApproverAsks([{ kind: 'owner' }, { kind: 'person' }])).toBe('another-approver')
  })
})
