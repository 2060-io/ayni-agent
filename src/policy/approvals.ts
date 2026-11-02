/**
 * Approval workflow (D14, INTX-APPR-001..010): sensitivity approvals (in-role, per use) and
 * elevation approvals (out-of-role, purpose-declared) through one mechanism.
 */
import type { AgentPack, ApprovalPolicy, ApprovalRule, ElevationRule } from '../config/packTypes.js'
import type { ApprovalDecision, ApprovalRecord, ElevationGrant, Principal } from '../core/types.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'

export interface ApprovalEvents {
  /** a request was created, decided, cancelled or expired: notify approvers and the requester */
  onChange(record: ApprovalRecord, change: 'created' | 'decided' | 'cancelled' | 'expired'): Promise<void>
}

export class ApprovalError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | 'not-found'
      | 'not-eligible'
      | 'not-pending'
      | 'not-requester'
      | 'bad-purpose'
      | 'not-requestable'
  ) {
    super(message)
    this.name = 'ApprovalError'
  }
}

export class ApprovalService {
  public constructor(
    private readonly store: Store,
    private readonly pack: AgentPack,
    private readonly events: ApprovalEvents
  ) {}

  private policyOf(rule: ApprovalRule | ElevationRule): ApprovalRecord['policy'] {
    const p: ApprovalPolicy = rule.policy ?? this.pack.approvals?.policy ?? { type: 'count', value: 1 }
    return { type: p.type, value: p.value ?? (p.type === 'count' ? 1 : 100), vetoOnRefusal: p.vetoOnRefusal ?? false }
  }

  public isEligible(principal: Principal, record: ApprovalRecord): boolean {
    if (record.approverConnectionType && principal.connectionType !== record.approverConnectionType) return false
    return principal.roles.some((r) => record.eligibleRoles.includes(r) && this.pack.identity.roles?.[r]?.canApprove)
  }

  /** INTX-APPR-005: a requester who holds an approver role proceeds without a prompt. */
  public canSelfApprove(principal: Principal, rule: ApprovalRule | ElevationRule): boolean {
    if (this.pack.approvals?.selfApproval === false) return false
    return principal.roles.some((r) => rule.approvers.includes(r) && this.pack.identity.roles?.[r]?.canApprove)
  }

  public async requestSensitivity(opts: {
    principal: Principal
    role: string
    originSessionId: string
    toolName: string
    serverName?: string
    args: Record<string, unknown>
    rule: ApprovalRule
  }): Promise<ApprovalRecord> {
    const timeout = (opts.rule.timeoutMinutes ?? this.pack.approvals?.timeoutMinutes ?? 60) * 60_000
    const record: ApprovalRecord = {
      id: prefixedId('apr'),
      kind: 'sensitivity',
      serverName: opts.serverName,
      toolName: opts.toolName,
      actionArgs: opts.args,
      requesterId: opts.principal.id,
      requesterName: displayName(opts.principal),
      requesterRole: opts.role,
      originSessionId: opts.originSessionId,
      policy: this.policyOf(opts.rule),
      eligibleRoles: opts.rule.approvers,
      approverConnectionType: opts.rule.approverConnectionType,
      attested: opts.rule.attested === true,
      decisions: [],
      status: 'PENDING',
      vetoed: false,
      expiresAt: new Date(Date.now() + timeout).toISOString(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'created')
    return record
  }

  /** PRIV-ELEV-002/005/007: purpose from the governance list plus a justification, both human-supplied. */
  public async requestElevation(opts: {
    principal: Principal
    role: string
    originSessionId: string
    toolName: string
    serverName?: string
    rule: ElevationRule
    purposeId: string
    justification: string
  }): Promise<ApprovalRecord> {
    const purpose = this.pack.purposes?.find((p) => p.id === opts.purposeId)
    if (!purpose || !opts.rule.purposes.includes(opts.purposeId))
      throw new ApprovalError('purpose is not in the governance list for this tool', 'bad-purpose')
    if (purpose.permittedRoles && !opts.principal.roles.some((r) => purpose.permittedRoles?.includes(r))) {
      throw new ApprovalError('purpose is not permitted for the principal role', 'bad-purpose')
    }
    if (!opts.justification.trim()) throw new ApprovalError('justification is required', 'bad-purpose')
    const timeout = (opts.rule.timeoutMinutes ?? this.pack.approvals?.timeoutMinutes ?? 60) * 60_000
    const record: ApprovalRecord = {
      id: prefixedId('apr'),
      kind: 'elevation',
      attested: opts.rule.attested === true,
      serverName: opts.serverName,
      toolName: opts.toolName,
      requesterId: opts.principal.id,
      requesterName: displayName(opts.principal),
      requesterRole: opts.role,
      originSessionId: opts.originSessionId,
      policy: this.policyOf(opts.rule),
      eligibleRoles: opts.rule.approvers,
      purpose: opts.purposeId,
      justification: opts.justification,
      decisions: [],
      status: 'PENDING',
      vetoed: false,
      grantTtlMinutes: opts.rule.grantTtlMinutes ?? this.pack.approvals?.grantTtlMinutes ?? 480,
      expiresAt: new Date(Date.now() + timeout).toISOString(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    await this.store.approvals.save(record)
    if (this.canSelfApprove(opts.principal, opts.rule)) {
      return this.decide(record.id, opts.principal, 'approve', 'self-approval')
    }
    await this.events.onChange(record, 'created')
    return record
  }

  private async eligibleCount(record: ApprovalRecord): Promise<number> {
    const principals = await this.store.principals.list()
    return principals.filter((p) => this.isEligible(p, record)).length
  }

  /** Applies the policy: count (N distinct approvers) or percentage of eligible approvers; veto on refusal. */
  private async evaluate(record: ApprovalRecord): Promise<ApprovalRecord['status']> {
    const approvals = record.decisions.filter((d) => d.decision === 'approve').length
    const rejections = record.decisions.filter((d) => d.decision === 'reject').length
    if (record.policy.vetoOnRefusal && rejections > 0) {
      record.vetoed = true
      return 'REJECTED'
    }
    if (record.policy.type === 'count') {
      if (approvals >= record.policy.value) return 'APPROVED'
      const eligible = Math.max(await this.eligibleCount(record), 1)
      return rejections > eligible - record.policy.value ? 'REJECTED' : 'PENDING'
    }
    const eligible = Math.max(await this.eligibleCount(record), 1)
    const needed = Math.ceil((eligible * record.policy.value) / 100)
    if (approvals >= needed) return 'APPROVED'
    if (rejections > eligible - needed) return 'REJECTED'
    return 'PENDING'
  }

  public async decide(
    approvalId: string,
    approver: Principal,
    decision: 'approve' | 'reject',
    note?: string,
    attestation?: ApprovalDecision['attestation']
  ): Promise<ApprovalRecord> {
    const record = await this.store.approvals.get(approvalId)
    if (!record) throw new ApprovalError('approval not found', 'not-found')
    if (record.status !== 'PENDING') throw new ApprovalError(`approval is ${record.status}`, 'not-pending')
    if (!this.isEligible(approver, record))
      throw new ApprovalError('principal is not an eligible approver', 'not-eligible')
    if (record.decisions.some((d) => d.approverId === approver.id))
      throw new ApprovalError('already decided', 'not-eligible')
    const role = approver.roles.find((r) => record.eligibleRoles.includes(r)) ?? approver.roles[0] ?? ''
    record.decisions.push({
      approverId: approver.id,
      approverName: displayName(approver),
      role,
      decision,
      reason: note,
      ts: nowIso(),
      ...(attestation ? { attestation } : {}),
    })
    record.status = await this.evaluate(record)
    record.updatedAt = nowIso()
    if (record.status === 'APPROVED' && record.kind === 'elevation' && record.purpose) {
      record.grantExpiresAt = new Date(Date.now() + (record.grantTtlMinutes ?? 480) * 60_000).toISOString()
      const grant: ElevationGrant = {
        id: prefixedId('grt'),
        principalId: record.requesterId,
        serverName: record.serverName,
        toolName: record.toolName,
        purpose: record.purpose,
        justification: record.justification ?? '',
        approverId: approver.id,
        approvalId: record.id,
        grantedAt: nowIso(),
        expiresAt: record.grantExpiresAt,
      }
      await this.store.grants.save(grant)
    }
    await this.store.approvals.save(record)
    if (record.status !== 'PENDING') await this.events.onChange(record, 'decided')
    return record
  }

  /** INTX-APPR-010: the requester withdraws their own pending request. */
  public async cancel(approvalId: string, requester: Principal): Promise<ApprovalRecord> {
    const record = await this.store.approvals.get(approvalId)
    if (!record) throw new ApprovalError('approval not found', 'not-found')
    if (record.requesterId !== requester.id) throw new ApprovalError('only the requester may cancel', 'not-requester')
    if (record.status !== 'PENDING') throw new ApprovalError(`approval is ${record.status}`, 'not-pending')
    record.status = 'CANCELLED'
    record.updatedAt = nowIso()
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'cancelled')
    return record
  }

  /** INTX-APPR-007: unactioned requests expire at their timeout. */
  public async expirePending(): Promise<number> {
    const now = nowIso()
    let n = 0
    for (const record of await this.store.approvals.list({ status: 'PENDING' })) {
      if (record.expiresAt <= now) {
        record.status = 'EXPIRED'
        record.updatedAt = now
        await this.store.approvals.save(record)
        await this.events.onChange(record, 'expired')
        n++
      }
    }
    return n
  }

  public async pendingFor(principal: Principal): Promise<ApprovalRecord[]> {
    const pending = await this.store.approvals.list({ status: 'PENDING' })
    return pending.filter(
      (r) => this.isEligible(principal, r) && !r.decisions.some((d) => d.approverId === principal.id)
    )
  }

  public async ownRequests(principal: Principal): Promise<ApprovalRecord[]> {
    return this.store.approvals.list({ requesterId: principal.id })
  }

  public async activeGrants(principalId: string): Promise<ElevationGrant[]> {
    return this.store.grants.listActive(principalId, nowIso())
  }
}

export function displayName(principal: Principal): string {
  return principal.identityAttributes.userName ?? principal.actorIdentity
}
