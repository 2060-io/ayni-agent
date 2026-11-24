/**
 * Approval workflow (D14, INTX-APPR-001..010): sensitivity approvals (in-role, per use) and
 * elevation approvals (out-of-role, purpose-declared) through one mechanism. Since D114 each approval names the approvers
 * it was asked of, and one whose decision must be attested is asked only of approvers a flow-capable phone reaches and is
 * decided only through its `authorize` flow (INTX-APPR-019).
 */
import type { AgentPack, ApprovalPolicy, ApprovalRule, ElevationRule } from '../config/packTypes.js'
import type {
  ApprovalDecision,
  ApprovalProgress,
  ApprovalRecord,
  ElevationGrant,
  Principal,
  SpaceApprovalPolicy,
} from '../core/types.js'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import type { ApprovalRepo, Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import { attestedFor, canStillMeet, entriesNaming, type Named, statusOf } from './spacePolicy.js'

/**
 * What became of an approval: made, decided by one approver while it still waits for others (`decision`), ended by a
 * decision (`decided`), withdrawn or cancelled, expired.
 */
export type ApprovalChange = 'created' | 'decision' | 'decided' | 'cancelled' | 'expired' | 'moved'

export interface ApprovalEvents {
  /** a request was created, decided, cancelled or expired: notify approvers and the requester */
  onChange(record: ApprovalRecord, change: ApprovalChange): Promise<void>
}

/**
 * The people an approval of a tool of a space names (INTX-APPR-021): for each entry of its policy, the people it names
 * now, the requester only by their own confirmation (INTX-APPR-023); who may still decide it; and where it stands.
 */
export interface SpacePolicyPort {
  named(record: ApprovalRecord): Promise<{ named: Named; pool: string[] }>
  progress(record: ApprovalRecord, named: Named): Promise<ApprovalProgress>
}

/** The answer of an approval refused at once for want of an approver (INTX-APPR-024). */
export const NO_APPROVER = 'no-approver'

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
      /** its decision must be attested: it is made on the phone (INTX-APPR-019) */
      | 'decide-on-phone'
      /** its decision must be attested and no approver has a flow-capable phone (INTX-APPR-019) */
      | 'no-approver'
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
   * The people the policy of a tool of a space names, as they are now: for a call of a tool of a space, its approvers are
   * those and nobody else (INTX-APPR-004, INTX-APPR-021). Set by the composition root.
   */
  public spacePolicies?: SpacePolicyPort

  /**
   * Whether a person can be asked on their phone: their capability channel is flow-capable (INTX-APPR-011). An approval to
   * attest is asked only of them (INTX-APPR-019). Set by the composition root; unset, nobody can.
   */
  public askable?: (principal: Principal) => Promise<boolean>

  /**
   * Who may decide: those whose role grants approval rights (INTX-APPR-004); for a tool of a space, its owner now and
   * nobody else; for a confirmation, nobody but the person, who decides it in the conversation (INTX-APPR-012).
   */
  public async isEligible(principal: Principal, record: ApprovalRecord): Promise<boolean> {
    if (record.kind === 'confirmation') return false
    if (record.spacePolicy) {
      if (!this.spacePolicies) return false
      const { named } = await this.spacePolicies.named(record)
      return entriesNaming(named, principal.id).length > 0
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
    record.closedAt = record.updatedAt
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'cancelled')
    return record
  }

  /** INTX-APPR-005: a requester who holds an approver role proceeds without a prompt. */
  public canSelfApprove(principal: Principal, rule: ApprovalRule | ElevationRule): boolean {
    if (this.pack.approvals?.selfApproval === false) return false
    return principal.roles.some((r) => rule.approvers.includes(r) && this.pack.identity.roles?.[r]?.canApprove)
  }

  /**
   * The people who may decide an approval now, the requester aside (INTX-APPR-004) but by their own confirmation of a
   * tool of a space (INTX-APPR-023).
   */
  public async approversOf(record: ApprovalRecord): Promise<Principal[]> {
    if (record.spacePolicy) {
      if (record.kind === 'confirmation' || !this.spacePolicies) return []
      const { pool } = await this.spacePolicies.named(record)
      return (await this.store.principals.list()).filter((p) => pool.includes(p.id))
    }
    const out: Principal[] = []
    for (const p of await this.store.principals.list())
      if (p.id !== record.requesterId && (await this.isEligible(p, record))) out.push(p)
    return out
  }

  /**
   * The approvers a new request is asked of (INTX-APPR-006, INTX-APPR-019): every eligible one, or, when its decision must
   * be attested, those a flow-capable phone reaches; none of those refuses the request (`no-approver`), and nothing is
   * recorded.
   */
  private async askedOf(record: ApprovalRecord): Promise<string[]> {
    const approvers = await this.approversOf(record)
    if (!record.attested) return approvers.map((p) => p.id)
    const reached: string[] = []
    for (const p of approvers) if (await this.askable?.(p)) reached.push(p.id)
    if (!reached.length) throw new ApprovalError('no approver can decide it on a phone now', 'no-approver')
    return reached
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
    /** a tool call's (D99): the action as its card shows it, its source, its conversation, its space */
    tool?: Pick<ApprovalRecord, 'action' | 'sourceId' | 'conversationId' | 'spaceId' | 'callId'>
    /**
     * a tool of a space's: the policy in force (D137) and the space's timeout of a call's approval, in minutes
     * (SPACE-DEF-008); the record is refused at once, `REJECTED` with `no-approver`, when nobody can meet it
     */
    space?: { policy: SpaceApprovalPolicy; timeoutMinutes: number }
  }): Promise<ApprovalRecord> {
    const timeout =
      (opts.space?.timeoutMinutes ?? opts.rule.timeoutMinutes ?? this.pack.approvals?.timeoutMinutes ?? 60) * 60_000
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
    if (opts.space) {
      const policy = opts.space.policy
      record.spacePolicy = policy
      record.attested = policy.attested
      record.eligibleRoles = []
      record.policy = { type: 'count', value: policy.threshold, vetoOnRefusal: policy.refusal === 'any' }
      return this.askSpace(record)
    }
    record.approverIds = await this.askedOf(record)
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'created')
    return record
  }

  /**
   * An approval of a tool of a space (INTX-APPR-021, INTX-APPR-024): asked of the people its policy names now, the
   * requester only by their own confirmation, and, for a decision to attest, only of those a flow-capable phone reaches
   * (INTX-APPR-019). When they cannot meet the policy, it is recorded `REJECTED` with `no-approver`, asks nobody, and is
   * returned as such: the caller ends its card and tells the owner.
   */
  private async askSpace(record: ApprovalRecord): Promise<ApprovalRecord> {
    const policy = record.spacePolicy as SpaceApprovalPolicy
    const { named, pool } = (await this.spacePolicies?.named(record)) ?? {
      named: { entries: policy.approvers.map(() => []), ownerless: false },
      pool: [],
    }
    const reached: string[] = []
    for (const id of pool) {
      if (!attestedFor(record, id)) {
        reached.push(id)
        continue
      }
      const p = await this.store.principals.get(id)
      if (p && (await this.askable?.(p))) reached.push(id)
    }
    const reachedNamed: Named = {
      ...named,
      entries: named.entries.map((ids) => ids.filter((id) => reached.includes(id))),
    }
    if (!canStillMeet(policy, reachedNamed, [], reached)) {
      record.status = 'REJECTED'
      record.reason = NO_APPROVER
      record.approverIds = []
      record.closedAt = record.updatedAt
      if (this.spacePolicies) record.progress = await this.spacePolicies.progress(record, named)
      await this.store.approvals.save(record)
      return record
    }
    record.approverIds = reached
    if (this.spacePolicies) record.progress = await this.spacePolicies.progress(record, named)
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
    if (this.canSelfApprove(opts.principal, opts.rule)) {
      await this.store.approvals.save(record)
      return this.decide(record.id, opts.principal, 'approve', 'self-approval', undefined, { self: true })
    }
    record.approverIds = await this.askedOf(record)
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'created')
    return record
  }

  private async eligibleCount(record: ApprovalRecord): Promise<number> {
    let n = 0
    for (const p of await this.store.principals.list()) if (await this.isEligible(p, record)) n++
    return n
  }

  /**
   * Applies the policy: for a tool of a space, its entries, threshold and refusal rule over the people they name now
   * (INTX-APPR-021); else count (N distinct approvers) or percentage of eligible approvers, veto on refusal.
   */
  private async evaluate(record: ApprovalRecord): Promise<ApprovalRecord['status']> {
    if (record.spacePolicy && this.spacePolicies) {
      const { named, pool } = await this.spacePolicies.named(record)
      record.progress = await this.spacePolicies.progress(record, named)
      return statusOf(record.spacePolicy, named, record.decisions, pool)
    }
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

  /**
   * An approver's decision. One whose decision must be attested takes it only with the attestation its `authorize` flow
   * returned, and never `none` (INTX-APPR-019, FLOW-AUTH-001); a requester who approves their own elevation (`self`)
   * needs none.
   */
  public async decide(
    approvalId: string,
    approver: Principal,
    decision: 'approve' | 'reject',
    note?: string,
    attestation?: ApprovalDecision['attestation'],
    options: { self?: boolean } = {}
  ): Promise<ApprovalRecord> {
    const record = await this.store.approvals.get(approvalId)
    if (!record) throw new ApprovalError('approval not found', 'not-found')
    if (record.status !== 'PENDING') throw new ApprovalError(`approval is ${record.status}`, 'not-pending')
    // a tool of a space's: the entries that name the approver now, which their decision keeps satisfying (INTX-APPR-021)
    const named = record.spacePolicy && this.spacePolicies ? (await this.spacePolicies.named(record)).named : undefined
    const satisfies = named ? entriesNaming(named, approver.id) : undefined
    const eligible = named ? !!satisfies?.length : await this.isEligible(approver, record)
    if (!options.self && !eligible) throw new ApprovalError('principal is not an eligible approver', 'not-eligible')
    if (record.decisions.some((d) => d.approverId === approver.id))
      throw new ApprovalError('already decided', 'not-pending')
    if (!options.self && attestedFor(record, approver.id) && (!attestation || attestation.method === 'none'))
      throw new ApprovalError('the decision of this approval is made on the phone', 'decide-on-phone')
    const role = approver.roles.find((r) => record.eligibleRoles.includes(r)) ?? approver.roles[0] ?? ''
    record.decisions.push({
      approverId: approver.id,
      approverName: displayName(approver),
      role,
      decision,
      reason: note,
      ts: nowIso(),
      ...(attestation ? { attestation } : {}),
      // the requester's own confirmation (INTX-APPR-023)
      ...(named && approver.id === record.requesterId ? { self: true } : {}),
      ...(satisfies ? { satisfies } : {}),
    })
    record.status = await this.evaluate(record)
    record.updatedAt = nowIso()
    if (record.status !== 'PENDING') record.closedAt = record.updatedAt
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
    await this.events.onChange(record, record.status === 'PENDING' ? 'decision' : 'decided')
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
    record.closedAt = record.updatedAt
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'cancelled')
    return record
  }

  /**
   * An approval of a tool of a space that the people still named can no longer meet, as when a person it was asked of
   * left (INTX-APPR-025): it ends `EXPIRED` at once. True when it did.
   */
  public async expireIfUnmeetable(approvalId: string): Promise<boolean> {
    const record = await this.store.approvals.get(approvalId)
    if (record?.status !== 'PENDING' || !record.spacePolicy || !this.spacePolicies) return false
    const { named, pool } = await this.spacePolicies.named(record)
    if (canStillMeet(record.spacePolicy, named, record.decisions, pool)) return false
    record.status = 'EXPIRED'
    record.updatedAt = nowIso()
    record.closedAt = record.updatedAt
    record.progress = await this.spacePolicies.progress(record, named)
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'expired')
    return true
  }

  /**
   * An approval of a tool of a space whose approvers changed without ending it, as when the space's owner changed
   * (SPACE-MEMB-012): the people it was asked of and where it stands, written again, and every view of it told.
   */
  public async moved(record: ApprovalRecord, askedOf: string[]): Promise<ApprovalRecord> {
    if (record.spacePolicy && this.spacePolicies) {
      const { named } = await this.spacePolicies.named(record)
      record.progress = await this.spacePolicies.progress(record, named)
    }
    record.approverIds = [...new Set([...(record.approverIds ?? []), ...askedOf])]
    record.updatedAt = nowIso()
    await this.store.approvals.save(record)
    await this.events.onChange(record, 'moved')
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
        record.closedAt = now
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
