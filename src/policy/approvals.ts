/**
 * Approval workflow (D14, INTX-APPR-001..010): sensitivity approvals (in-role, per use) and
 * elevation approvals (out-of-role, purpose-declared) through one mechanism.
 */
import type { AgentPack, ApprovalPolicy, ApprovalRule, ElevationRule } from '../config/packTypes.js'
import type { ApprovalDecision, ApprovalRecord, ElevationGrant, Principal } from '../core/types.js'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import type { ApprovalRepo, Store } from '../store/types.js'
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

  /**
   * The owners of a space, as they are now: for a call of a tool of a space, the eligible approver is its owner at the time
   * of the decision, and nobody else (INTX-APPR-004). Set by the composition root.
   */
  public spaceOwners?: (spaceId: string) => Promise<string[]>

  /**
   * Who may decide: those whose role grants approval rights (INTX-APPR-004); for a tool of a space, its owner now and
   * nobody else; for a confirmation, nobody but the person, who decides it in the conversation (INTX-APPR-012).
   */
  public async isEligible(principal: Principal, record: ApprovalRecord): Promise<boolean> {
    if (record.kind === 'confirmation') return false
    if (record.ownerApproval && record.spaceId) {
      const owners = (await this.spaceOwners?.(record.spaceId)) ?? []
      return owners.includes(principal.id)
    }
    if (record.approverConnectionType && principal.connectionType !== record.approverConnectionType) return false
    return principal.roles.some((r) => record.eligibleRoles.includes(r) && this.pack.identity.roles?.[r]?.canApprove)
  }

  /** A record as it is stored (sealed by the repository). */
  public async get(id: string): Promise<ApprovalRecord | undefined> {
    return this.store.approvals.get(id)
  }

  public async save(record: ApprovalRecord): Promise<void> {
    await this.store.approvals.save(record)
  }

  /** The agent withdraws a pending request (the message whose turn asked it was deleted, INTX-APPR-015). */
  public async cancelBySystem(approvalId: string): Promise<ApprovalRecord | undefined> {
    const record = await this.store.approvals.get(approvalId)
    if (record?.status !== 'PENDING') return record
    record.status = 'CANCELLED'
    record.updatedAt = nowIso()
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'cancelled')
    return record
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
    /** the person's message whose turn asks for it: an erasure of that message erases the arguments (PRIV-ERASE-005) */
    inboundId?: string
    /** a tool call's (D99): the action as its card shows it, its source, its conversation, the space whose owner approves */
    tool?: Pick<ApprovalRecord, 'action' | 'sourceId' | 'conversationId' | 'spaceId' | 'ownerApproval' | 'callId'>
  }): Promise<ApprovalRecord> {
    const timeout = (opts.rule.timeoutMinutes ?? this.pack.approvals?.timeoutMinutes ?? 60) * 60_000
    const record: ApprovalRecord = {
      id: prefixedId('apr'),
      kind: 'sensitivity',
      serverName: opts.serverName,
      toolName: opts.toolName,
      actionArgs: opts.args,
      inboundId: opts.inboundId,
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
      ...(opts.tool ?? {}),
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
    let n = 0
    for (const p of await this.store.principals.list()) if (await this.isEligible(p, record)) n++
    return n
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
    if (!(await this.isEligible(approver, record)))
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
    const out: ApprovalRecord[] = []
    for (const r of await this.store.approvals.list({ status: 'PENDING' }))
      if ((await this.isEligible(principal, r)) && !r.decisions.some((d) => d.approverId === principal.id)) out.push(r)
    return out
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

interface SealedApprovalFields {
  actionArgs?: Record<string, unknown>
  action?: ApprovalRecord['action']
}

/**
 * Approval records with the arguments of their action, and the action as its card shows it, sealed under a key of the
 * record (INTX-APPR-014, D77): in the clear stay the tool, the source, the people, the status and the dates. A record
 * whose arguments were erased (INTX-APPR-015) keeps the action's title, source and account, sealed under a new key, and
 * the key of the arguments is destroyed.
 */
export function sealedApprovals(repo: ApprovalRepo, crypto: EntryCrypto): ApprovalRepo {
  const open = (record: ApprovalRecord | undefined): ApprovalRecord | undefined => {
    if (!record?.sealed) return record
    const fields = openJson<SealedApprovalFields>(
      crypto,
      record.sealed.keyRef,
      Buffer.from(record.sealed.cipher, 'base64')
    )
    const { sealed: _sealed, ...rest } = record
    return {
      ...rest,
      ...(fields.actionArgs ? { actionArgs: fields.actionArgs } : {}),
      ...(fields.action ? { action: fields.action } : {}),
    }
  }
  const seal = (record: ApprovalRecord): ApprovalRecord => {
    const { actionArgs, action, sealed: _previous, ...rest } = record
    if (!actionArgs && !action) return rest
    // a new key at each save: the former one, which could open erased arguments, is gone with the row it was in
    const keyRef = crypto.newWrappedKey()
    const { cipher } = sealJson(crypto, keyRef, { actionArgs, action } satisfies SealedApprovalFields)
    return { ...rest, sealed: { keyRef, cipher: cipher.toString('base64') } }
  }
  return {
    get: async (id) => open(await repo.get(id)),
    save: (record) => repo.save(seal(record)),
    list: async (filter) => (await repo.list(filter)).map((r) => open(r) as ApprovalRecord),
  }
}
