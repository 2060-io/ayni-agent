/**
 * What a call needs, and the record of each call (ayni-spec D96, D99, D100; RBAC-FILTER-004, TOOL-AVAIL, TOOL-CALL,
 * TOOL-PROV, INTX-APPR-012..015).
 *
 * A turn takes its tools once, at its start (TOOL-AVAIL-006): those the Principal's roles and grants permit, of the
 * sources available in the conversation's space, a source of a space only when it is `ready` there, with no tool its
 * owner set `off`, for a guest only what the template opens to guests, and with every pinned argument out of the input
 * schemas (RBAC-FILTER-004). Each call then goes through, in order: the person's confirmation, the approval, the
 * credential's liveness, the step-up check, and the call, with the pinned arguments set in code and the account opened
 * for it (TOOL-CALL-001). A turn that read content from an untrusted source asks the person before any call that is not
 * a read (TOOL-CALL-008). Every call the model asks for leaves one record, with no argument, result or account value
 * (TOOL-PROV-004); every result records its source and whose account read it (TOOL-PROV-001).
 */
import { ACTIVITY, CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { AgentPack, CallRule, SpaceCallRule, ToolEffect } from '../config/packTypes.js'
import { confirmationTimeoutSeconds } from '../config/packTypes.js'
import type { ToolCallRequest, ToolDefinition } from '../llm/types.js'
import type { MemoryService } from '../memory/service.js'
import type { StatsSink } from '../platform/stats.js'
import { type ApprovalService, displayName } from '../policy/approvals.js'
import type { TierResolution } from '../policy/rbac.js'
import type { Store } from '../store/types.js'
import { type CatalogSource, type PackRule, strictest, type ToolCatalog } from '../tools/catalog.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { CallAccountSecret, ToolContext, ToolSpec } from '../tools/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { ChallengeService } from './challenges.js'
import type { TurnSink } from './orchestrator.js'
import type { PrincipalService } from './principals.js'
import { isPersonalSpace, type SpaceService } from './spaces.js'
import type { ReadySource, SpaceToolService } from './spaceTools.js'
import type {
  ApprovalRecord,
  ApprovalStatus,
  CallAccount,
  ElevationGrant,
  MessageEntry,
  Principal,
  Session,
  Space,
  ToolAction,
  ToolAllowance,
  ToolCallOutcome,
  ToolCallRecord,
  TurnSource,
} from './types.js'

/** A tool as a turn gives it to the model, with what its calls need. */
export interface TurnTool {
  /** the name the model calls it by */
  name: string
  spec: ToolSpec
  source: CatalogSource
  resolution: TierResolution
  /** none for a bundled tool */
  effect?: ToolEffect
  packRule: PackRule
  /** the strictest of the pack's rule and, for a tool of a space, its owner's (TOOL-CALL-002) */
  rule: CallRule
  untrusted: boolean
  /** a source of availability `spaces`: its owner approves, its bindings and account are the space's */
  spaceTool: boolean
  /** the binding values in force at the turn's start */
  bindings: Record<string, string>
  /** when the space's account was set, for an allowance's fingerprint */
  accountSetAt?: string
  /** what the model receives: the input schema without the pinned arguments (TOOL-CAT-004) */
  definition: ToolDefinition
}

/** What a turn keeps of its calls (TOOL-CALL-008, TOOL-PROV-002). */
export interface TurnToolState {
  conversationId: string
  spaceId: string
  /** the space of the conversation, unless it is Personal */
  space?: Space
  /** the untrusted sources a tool of which returned a result in this turn, by name, with their titles */
  untrustedRead: Map<string, string>
  /** the sources whose tools ran in this turn, with whose account */
  sources: Map<string, TurnSource>
  /** a card waited: the reply goes on as a new message (CORE-MSG-011) */
  newMessage: boolean
  signal: AbortSignal
}

export interface CallContext {
  session: Session
  principal: Principal
  inbound?: MessageEntry
  toolCtx: ToolContext
  sink: TurnSink
}

export interface ToolGateHooks {
  /** an approval is pending for a tool call started in this session: its card goes to the session */
  onApprovalPending?: (
    session: Session,
    principal: Principal,
    record: ApprovalRecord,
    entry: MessageEntry
  ) => Promise<void>
  /** the Principal's identity credential failed re-verification */
  onCredentialInvalid?: (principal: Principal) => Promise<void>
  /** events to every bound session of a conversation, outside a turn (an allowance ended, a card expired) */
  toConversation?: (conversationId: string, events: { name: string; value: Record<string, unknown> }[]) => Promise<void>
  /** the sessions of a conversation that can show a confirmation card: a client of profile 3.4 or later (TOOL-CALL-005) */
  cardSessions?: (conversationId: string) => Promise<Session[]>
  /** a message of the agent to a conversation, outside a turn: the outcome of an approved action */
  deliver?: (session: Session, entry: MessageEntry) => Promise<void>
}

export interface ToolGateDeps {
  pack: AgentPack
  store: Store
  catalog: ToolCatalog
  registry: ToolRegistry
  spaces: SpaceService
  spaceTools: SpaceToolService
  approvals: ApprovalService
  memory: MemoryService
  principals: PrincipalService
  challenges: ChallengeService
  stats: StatsSink
  logger: Logger
}

/** The value of a field on a card: a string as it is, a number or a boolean as written, the rest as indented JSON. */
export function fieldValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return String(value)
  return JSON.stringify(value, null, 2)
}

/** A profile version is 3.4 or later (PROF-SESS-016). */
export function cardCapable(profileVersion: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(profileVersion ?? '')
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 3 || (major === 3 && minor >= 4)
}

/** Replaces every echo of a space's token in a text by `[account]` (TOOL-ACCESS-005). */
export function scrubToken<T>(value: T, token: string | undefined): T {
  if (!token) return value
  if (typeof value === 'string') return value.split(token).join('[account]') as T
  if (Array.isArray(value)) return value.map((item) => scrubToken(item, token)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[scrubToken(key, token)] = scrubToken(item, token)
    return out as T
  }
  return value
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats.default(ajv)

interface Waiter {
  conversationId: string
  resolve: (record: ApprovalRecord, reason?: 'message' | 'stopped') => void
}

export class ToolGate {
  public hooks: ToolGateHooks = {}
  /** the confirmations a turn waits for, by approval id (TOOL-CALL-003) */
  private readonly waiters = new Map<string, Waiter>()
  private readonly validators = new Map<string, ReturnType<typeof ajv.compile> | null>()
  /** the tools whose rule is approval with nobody to approve them, warned of once (TOOL-CAT-009) */
  private readonly warnedNoApprover = new Set<string>()

  public constructor(private readonly deps: ToolGateDeps) {}

  private get store(): Store {
    return this.deps.store
  }

  // ---- the tools of a turn (RBAC-FILTER-004, TOOL-AVAIL-001..006) -------------------------------------------------

  /** The tools a turn gives the model, in a fixed order: the same tools, byte for byte, while nothing changed. */
  public async toolsFor(principal: Principal, spaceId: string, grants: ElevationGrant[]): Promise<TurnTool[]> {
    const { catalog, spaceTools, registry } = this.deps
    const personal = isPersonalSpace(spaceId)
    const access = personal ? undefined : await this.deps.spaces.access(principal, spaceId)
    const space = access && !access.left ? access.space : undefined
    const guest = access?.role === 'guest'
    const ready = new Map<string, ReadySource>()
    if (space) for (const r of await spaceTools.readyIn(space)) ready.set(r.source.name, r)
    // a server of a space's account is discovered on that space's connection, on the first turn that needs it
    for (const r of ready.values())
      if (r.source.kind === 'mcp' && r.source.account.kind === 'space') {
        const account = await spaceTools.openAccount(spaceId, r.source.name)
        if (account?.token) await registry.discover(r.source.name, account)
      }
    const out: TurnTool[] = []
    for (const visible of await registry.visible(principal.roles, grants, principal)) {
      const spec = visible.spec
      const source = catalog.sourceOf(spec.source, spec.rawName)
      let bindings: Record<string, string> = {}
      let ownerRule: SpaceCallRule | undefined
      let accountSetAt: string | undefined
      if (source.availability === 'personal' && !personal) continue
      if (source.availability === 'spaces') {
        const r = ready.get(source.name)
        if (!r) continue
        // a guest uses a source of the template only where the template opens it to guests (TOOL-AVAIL-004)
        if (guest && r.entry.guests !== true) continue
        ownerRule = r.record.calls[spec.rawName]
        if (ownerRule === 'off') continue
        bindings = r.bindings
        accountSetAt = r.accountSetAt
      } else bindings = spaceTools.bindingValues(source, undefined)
      const packRule = catalog.packRuleOf(source, spec.rawName, spec.annotations)
      const rule = (ownerRule ? strictest<SpaceCallRule>(packRule.rule, ownerRule) : packRule.rule) as CallRule
      // a rule of approval the annotations give, with nobody to approve it: warned at discovery (TOOL-CAT-009)
      if (
        packRule.rule === 'approval' &&
        source.availability !== 'spaces' &&
        !catalog.approversOf(packRule).length &&
        !this.warnedNoApprover.has(spec.key)
      ) {
        this.warnedNoApprover.add(spec.key)
        this.deps.logger.warn(
          { source: source.name, tool: spec.rawName },
          'the rule of this tool is approval and no role approves it: its calls are refused as no-approver (TOOL-CAT-009)'
        )
      }
      out.push({
        name: spec.name,
        spec,
        source,
        resolution: visible.resolution,
        effect: catalog.effectOf(source, spec.rawName, spec.annotations),
        packRule,
        rule,
        untrusted: catalog.untrustedOf(source, spec.rawName, spec.annotations),
        spaceTool: source.availability === 'spaces',
        bindings,
        ...(accountSetAt ? { accountSetAt } : {}),
        definition: {
          name: spec.name,
          description: spec.description,
          parameters: withoutPinned(spec.parameters, source),
        },
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ---- one call (TOOL-CALL-001) --------------------------------------------------------------------------------------

  /** One call the model asked for, through every step its rule asks; returns what the model reads of it. */
  public async execute(
    call: ToolCallRequest,
    tools: TurnTool[],
    state: TurnToolState,
    ctx: CallContext
  ): Promise<string> {
    const tool = tools.find((t) => t.name === call.name)
    const record = this.newRecord(ctx.principal, state, tool, call.name)
    if (!tool) {
      // not offered, not available here, or not the Principal's: unknown (TOOL-CAT-003, TOOL-AVAIL-001)
      await this.finish(record, 'not-available')
      return `Tool ${call.name} is not available to this person.`
    }
    const title = this.deps.catalog.toolTitle(tool.source, tool.spec.rawName, tool.spec.annotations)
    const args = this.pinned(tool, call.arguments ?? {}, tool.bindings)
    // a call that is not a read, in a turn that read untrusted content, asks the person (TOOL-CALL-008)
    const raised = !!tool.effect && tool.effect !== 'read' && state.untrustedRead.size > 0
    record.raisedByUntrusted = raised
    let rule = tool.rule
    // the owner asks a call of a tool of their own space: the approval is their own confirmation (INTX-APPR-005)
    const ownerSelf = rule === 'approval' && tool.spaceTool && !!state.space?.ownerIds.includes(ctx.principal.id)
    // a requester who holds an approver role runs it without a prompt (INTX-APPR-005)
    let selfApproved = false
    if (rule === 'approval' && !tool.spaceTool) {
      const approvers = this.deps.catalog.approversOf(tool.packRule)
      if (!approvers.length) {
        await this.finish(record, 'no-approver')
        return `${title} needs an approval, and nobody can approve it here: it did not run.`
      }
      selfApproved =
        this.deps.pack.approvals?.selfApproval !== false &&
        ctx.principal.roles.some((r) => approvers.includes(r) && this.deps.pack.identity.roles?.[r]?.canApprove)
    }
    // 1. the person's confirmation
    const needsCard = rule === 'confirm' || raised || ownerSelf
    if (needsCard) {
      const allowance = rule === 'confirm' && !raised ? await this.allowanceFor(tool, state) : undefined
      if (allowance) record.confirmation = { allowanceApprovalId: allowance.approvalId }
      else {
        const invalid = this.invalid(tool, args)
        if (invalid) {
          await this.finish(record, 'failed')
          return `The arguments of ${title} are not valid (${invalid}): nothing was asked and nothing ran.`
        }
        const outcome = await this.confirm(tool, title, args, state, ctx, record, {
          allowForConversation: rule === 'confirm' && !raised && !ownerSelf,
          raised,
        })
        if (outcome) return outcome
        // the owner's own confirmation stands for the approval (INTX-APPR-005)
        if (ownerSelf) rule = 'confirm'
      }
    }
    // 2. the approval
    if (rule === 'approval' && !selfApproved) {
      const invalid = this.invalid(tool, args)
      if (invalid) {
        await this.finish(record, 'failed')
        return `The arguments of ${title} are not valid (${invalid}): nothing was asked and nothing ran.`
      }
      return this.askApproval(tool, title, args, state, ctx, record)
    }
    record.rule = tool.rule
    return this.run(tool, title, args, state, ctx, record)
  }

  /** Steps 3 to 5: the credential's liveness, the step-up, the call (TOOL-CALL-001). */
  private async run(
    tool: TurnTool,
    title: string,
    args: Record<string, unknown>,
    state: Pick<TurnToolState, 'conversationId' | 'spaceId' | 'untrustedRead' | 'sources'>,
    ctx: CallContext,
    record: ToolCallRecord,
    approvalId?: string
  ): Promise<string> {
    const { principals, challenges, memory } = this.deps
    const policy = this.deps.pack.actions?.[tool.spec.rawName]
    // 3. the credential's liveness (IDENT-LIVE-011, INTX-CRED-002)
    if (policy?.maxCredentialAge !== undefined) {
      const verdict = await principals.ensureLive(ctx.principal, policy.maxCredentialAge)
      if (!verdict.ok) {
        if (verdict.reason !== 'unavailable') await this.hooks.onCredentialInvalid?.(ctx.principal)
        await this.finish(record, 'failed')
        return `${title} did not run: the person's identity credential could not be verified.`
      }
    }
    // 4. the step-up the action declares (INTX-AUTH-002/003/006)
    if (policy?.authChallenge) {
      await ctx.sink.emit({ type: 'step-started', label: 'Waiting for your confirmation on your phone' })
      const { outcome, record: challenge } = await challenges.run({
        principal: ctx.principal,
        originSession: ctx.session,
        toolName: tool.spec.rawName,
        policy: policy.authChallenge,
        purpose: title,
      })
      await ctx.sink.emit({ type: 'step-finished', label: 'Waiting for your confirmation on your phone' })
      record.stepUp = { type: policy.authChallenge.type, outcome }
      await memory.append({
        sessionId: ctx.session.id,
        principalId: ctx.principal.id,
        role: 'system',
        sourceType: 'auth-challenge',
        text: `Identity check (${policy.authChallenge.type}) for ${title}: ${outcome}`,
        backingIdentity: ctx.principal.backingIdentity,
        payload: {
          challengeId: challenge?.id,
          type: policy.authChallenge.type,
          outcome,
          toolName: tool.spec.rawName,
          ...(typeof challenge?.details?.flowId === 'string' ? { flowId: challenge.details.flowId } : {}),
        },
      })
      if (outcome !== 'completed' && outcome !== 'degraded') {
        await this.finish(record, 'failed')
        return `${title} did not run: the identity check ${outcome === 'failed' ? 'failed' : outcome === 'expired' ? 'timed out' : 'was not possible'}.`
      }
    }
    // 5. the call: the pinned arguments set in code, the account opened for it (TOOL-ACCESS-005)
    const account: CallAccountSecret =
      tool.source.account.kind === 'space'
        ? ((await this.deps.spaceTools.openAccount(state.spaceId, tool.source.name)) ?? {
            kind: 'space',
            spaceId: state.spaceId,
          })
        : { kind: tool.source.account.kind }
    const label = tool.spec.stepLabel ?? 'Working'
    await ctx.sink.emit({ type: 'step-started', label })
    let content: string
    let data: unknown
    let isError = false
    try {
      // a tool call already executing completes even if the turn is cancelled (D47): no run signal here
      const result = await tool.spec.invoke(args, { ...ctx.toolCtx, account })
      content = scrubToken(result.content, account.token)
      data = scrubToken(result.data, account.token)
      isError = result.isError === true
      if (result.endTurn) ctx.toolCtx.turnEnded?.(result.endTurn)
    } catch (error) {
      content = scrubToken(`tool failed: ${error instanceof Error ? error.message : String(error)}`, account.token)
      isError = true
    }
    await ctx.sink.emit({ type: 'step-finished', label })
    this.deps.stats.emit('tool-call', 1, { tool: tool.spec.rawName, error: String(isError) })
    const callAccount: CallAccount =
      account.kind === 'space' ? { kind: 'space', spaceId: state.spaceId } : { kind: account.kind }
    const confirmationId =
      record.confirmation && 'approvalId' in record.confirmation
        ? record.confirmation.approvalId
        : record.confirmation?.allowanceApprovalId
    await memory.append({
      sessionId: ctx.session.id,
      principalId: ctx.principal.id,
      role: 'agent',
      sourceType: 'tool-call',
      // what the model reads of it in history names the action by its title, never more (PROF-TOOL-013)
      text: `Used ${title}${isError ? ' (failed)' : ''}: ${content.slice(0, 200)}`,
      backingIdentity: ctx.principal.backingIdentity,
      payload: {
        name: tool.name,
        server: tool.spec.serverName,
        arguments: args,
        result: content.slice(0, 20000),
        ...(data !== undefined ? { data } : {}),
        isError,
        inboundId: ctx.inbound?.id,
        ...(ctx.toolCtx.inboundIds?.length ? { inboundIds: ctx.toolCtx.inboundIds } : {}),
      },
      // in the clear, beside the sealed arguments and result (TOOL-PROV-001)
      provenance: {
        sourceId: tool.source.name,
        toolName: tool.spec.rawName,
        account: callAccount,
        untrusted: tool.untrusted,
        ...((approvalId ?? confirmationId) ? { approvalId: approvalId ?? confirmationId } : {}),
        callId: record.id,
      },
    })
    if (tool.untrusted) state.untrustedRead.set(tool.source.name, tool.source.title)
    const key = `${tool.source.name}|${callAccount.kind}|${callAccount.spaceId ?? ''}`
    state.sources.set(key, {
      sourceId: tool.source.name,
      accountKind: callAccount.kind,
      ...(callAccount.spaceId ? { spaceId: callAccount.spaceId } : {}),
    })
    await this.finish(record, isError ? 'failed' : 'completed')
    return content.slice(0, 20000)
  }

  /** The arguments with every pinned one set in code, in place of what the model gave (TOOL-CAT-004). */
  private pinned(
    tool: Pick<TurnTool, 'source' | 'spec'>,
    args: Record<string, unknown>,
    values: Record<string, string>
  ): Record<string, unknown> {
    const out = { ...args }
    const properties = (tool.spec.parameters.properties ?? {}) as Record<string, unknown>
    for (const binding of tool.source.bindings) {
      if (!binding.argument) continue
      delete out[binding.argument]
      const value = values[binding.name]
      if (value === undefined) continue
      // an MCP tool takes it where its input schema has it; an HTTP tool in its URL or body
      if (tool.source.kind === 'http' || binding.argument in properties) out[binding.argument] = value
    }
    return out
  }

  /** Why arguments do not validate against the tool's input schema, if they do not (TOOL-CALL-003). */
  private invalid(tool: TurnTool, args: Record<string, unknown>): string | undefined {
    let validate = this.validators.get(tool.spec.key)
    if (validate === undefined) {
      try {
        // a server's draft-07 schema validates as 2020-12 for what a call's arguments use
        const { $schema: _draft, ...schema } = tool.spec.parameters
        validate = ajv.compile(schema)
      } catch {
        validate = null
      }
      this.validators.set(tool.spec.key, validate)
    }
    if (!validate || validate(args)) return undefined
    return ajv.errorsText(validate.errors)
  }

  // ---- the card (TOOL-CALL-003..008, INTX-APPR-012) -----------------------------------------------------------------

  /** The action as its card shows it: the source, whose account, every argument whole, the pinned ones first. */
  public async actionOf(
    tool: Pick<TurnTool, 'source' | 'spec'>,
    title: string,
    args: Record<string, unknown>,
    spaceId: string
  ): Promise<ToolAction> {
    const fields: ToolAction['fields'] = []
    const pinnedArgs = new Set<string>()
    for (const binding of tool.source.bindings) {
      if (binding.argument) pinnedArgs.add(binding.argument)
      const value = binding.argument ? args[binding.argument] : undefined
      if (binding.argument && value === undefined) continue
      // a binding without argument is a label: shown, enforced by the account's own scope (TOOL-CAT-004)
      const shown = binding.argument
        ? value
        : (binding.value ?? (await this.bindingOfSpace(spaceId, tool.source.name, binding.name)))
      if (shown === undefined) continue
      fields.push({ label: binding.label, value: fieldValue(shown), pinned: true })
    }
    const properties = (tool.spec.parameters.properties ?? {}) as Record<string, { title?: string }>
    const order = [...Object.keys(properties), ...Object.keys(args).filter((k) => !(k in properties))]
    for (const name of order) {
      if (pinnedArgs.has(name) || !(name in args)) continue
      fields.push({ label: properties[name]?.title ?? name, value: fieldValue(args[name]) })
    }
    const kind = tool.source.account.kind
    const space = kind === 'space' ? await this.deps.spaces.find(spaceId) : undefined
    return {
      title,
      source: { id: tool.source.name, title: tool.source.title },
      account: { kind, ...(space ? { space: { id: space.id, title: space.title } } : {}) },
      fields,
    }
  }

  private async bindingOfSpace(spaceId: string, sourceId: string, name: string): Promise<string | undefined> {
    if (isPersonalSpace(spaceId)) return undefined
    return (await this.store.spaceTools.get(spaceId, sourceId))?.bindings[name]
  }

  /** The card of a confirmation, as the activity and history carry it (PROF-TOOL-007). */
  public cardOf(record: ApprovalRecord): Record<string, unknown> {
    return {
      approvalId: record.id,
      kind: 'confirmation',
      status: record.status,
      expiresAt: record.expiresAt,
      requester: { displayName: record.requesterName, name: record.requesterName },
      tool: record.toolName,
      ...(record.action ? { action: record.action } : {}),
      ...(record.untrustedSources?.length ? { untrusted: { sources: record.untrustedSources } } : {}),
      allowForConversation: record.allowForConversation === true,
      ...(record.scope ? { scope: record.scope } : {}),
      ...(record.allowanceEndedAt ? { allowanceEnded: true } : {}),
      own: true,
      canDecide: record.status === 'PENDING',
    }
  }

  /**
   * Asks the person's confirmation and waits for it, in the turn (TOOL-CALL-003..007); returns what the model reads when
   * the call does not go on, nothing when it does.
   */
  private async confirm(
    tool: TurnTool,
    title: string,
    args: Record<string, unknown>,
    state: TurnToolState,
    ctx: CallContext,
    record: ToolCallRecord,
    options: { allowForConversation: boolean; raised: boolean }
  ): Promise<string | undefined> {
    // a card is asked only of a session that can show it (TOOL-CALL-005)
    const sessions = (await this.hooks.cardSessions?.(state.conversationId)) ?? []
    if (ctx.principal.connectionType === 'verifiable-service' || !sessions.length) {
      await this.finish(record, 'unavailable')
      return `${title} needs the person's confirmation, which could not be asked here: it did not run.`
    }
    const action = await this.actionOf(tool, title, args, state.spaceId)
    const timeout = confirmationTimeoutSeconds(this.deps.pack) * 1000
    const approval: ApprovalRecord = {
      id: prefixedId('apr'),
      kind: 'confirmation',
      serverName: tool.spec.serverName,
      toolName: tool.spec.rawName,
      actionArgs: args,
      action,
      sourceId: tool.source.name,
      conversationId: state.conversationId,
      ...(tool.spaceTool ? { spaceId: state.spaceId } : {}),
      inboundId: ctx.inbound?.id,
      requesterId: ctx.principal.id,
      requesterName: displayName(ctx.principal),
      requesterRole: ctx.principal.roles[0] ?? '',
      originSessionId: ctx.session.id,
      policy: { type: 'count', value: 1, vetoOnRefusal: false },
      // the person is the only decider: nobody's pending approvals count it (INTX-APPR-012)
      eligibleRoles: [],
      decisions: [],
      status: 'PENDING',
      vetoed: false,
      allowForConversation: options.allowForConversation,
      ...(options.raised ? { untrustedSources: [...state.untrustedRead.values()] } : {}),
      callId: record.id,
      expiresAt: new Date(Date.now() + timeout).toISOString(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    const entry = await this.deps.memory.append({
      sessionId: ctx.session.id,
      principalId: ctx.principal.id,
      role: 'system',
      sourceType: 'approval',
      text: `The person was asked to confirm ${title} (${approval.id}): PENDING`,
      backingIdentity: ctx.principal.backingIdentity,
      payload: { approvalId: approval.id, kind: 'confirmation', toolName: approval.toolName, status: 'PENDING' },
    })
    approval.entryId = entry.id
    await this.deps.approvals.save(approval)
    await this.writeCard(entry, approval, title)
    record.confirmation = { approvalId: approval.id, status: 'PENDING' }
    await this.store.toolCalls.save(record)
    // in the turn's run and on every other session of the conversation; no step while it waits (PROF-TOOL-007)
    await ctx.sink.emit({
      type: 'activity',
      messageId: entry.id,
      activityType: ACTIVITY.approval,
      content: this.cardOf(approval),
    })
    const { decided, reason } = await this.wait(approval, state.signal)
    state.newMessage = true
    await this.writeCard(entry, decided, title)
    await ctx.sink.emit({
      type: 'activity',
      messageId: entry.id,
      activityType: ACTIVITY.approval,
      content: this.cardOf(decided),
    })
    await ctx.sink.emit({
      type: 'custom',
      name: CUSTOM_EVENT.approvalUpdate,
      value: {
        approvalId: decided.id,
        status: decided.status,
        ...(decided.decisions[0] ? { decidedBy: decided.decisions[0].approverName } : {}),
        ...(decided.scope ? { scope: decided.scope } : {}),
      },
    })
    const decision = decided.decisions[0]
    record.confirmation = {
      approvalId: decided.id,
      status: decided.status,
      ...(decision ? { decidedBy: decision.approverName, at: decision.ts } : {}),
    }
    if (decided.status === 'APPROVED') {
      if (decided.scope === 'conversation' && decided.allowForConversation)
        await this.store.toolAllowances.save({
          approvalId: decided.id,
          conversationId: state.conversationId,
          sourceId: tool.source.name,
          toolName: tool.spec.rawName,
          ...(tool.spaceTool ? { spaceId: state.spaceId } : {}),
          fingerprint: this.fingerprint(tool),
          since: nowIso(),
        })
      return undefined
    }
    if (decided.status === 'REJECTED') {
      await this.finish(record, 'refused')
      return `The person refused ${title}: it did not run. Do not try it again unless the person asks for it.`
    }
    if (decided.status === 'EXPIRED') {
      await this.finish(record, 'expired')
      return `The person did not answer the confirmation of ${title} in time: it did not run.`
    }
    await this.finish(record, 'cancelled')
    if (reason === 'message')
      return `The person wrote a new message instead of answering the confirmation of ${title}: it did not run. Their message is answered next.`
    return `The confirmation of ${title} was cancelled: it did not run.`
  }

  /** The card's entry: what the model reads of it, and what history gives the devices (PROF-HIST-006). */
  private async writeCard(entry: MessageEntry, record: ApprovalRecord, title: string): Promise<void> {
    const current = await this.deps.memory.get(entry.id)
    if (!current) return
    await this.deps.memory.rewrite({
      ...current,
      text: `The person was asked to confirm ${title} (${record.id}): ${record.status}${record.scope === 'conversation' ? ', for this conversation' : ''}`,
      payload: {
        ...(current.payload ?? {}),
        approvalId: record.id,
        kind: record.kind,
        toolName: record.toolName,
        status: record.status,
        card: this.cardOf(record),
      },
    })
  }

  /** Waits for the first decision, the expiry, the stop of the reply or a new message of the person (TOOL-CALL-004). */
  private wait(
    record: ApprovalRecord,
    signal: AbortSignal
  ): Promise<{ decided: ApprovalRecord; reason?: 'message' | 'stopped' }> {
    return new Promise((resolve) => {
      const done = (decided: ApprovalRecord, reason?: 'message' | 'stopped') => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.waiters.delete(record.id)
        resolve({ decided, reason })
      }
      const onAbort = () => void this.close(record.id, 'CANCELLED', 'stopped')
      const timer = setTimeout(
        () => void this.close(record.id, 'EXPIRED'),
        Math.max(0, Date.parse(record.expiresAt) - Date.now())
      )
      timer.unref?.()
      this.waiters.set(record.id, { conversationId: record.conversationId ?? '', resolve: done })
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Ends a waiting confirmation without a decision of the person: expired, or cancelled. */
  private async close(
    approvalId: string,
    status: 'EXPIRED' | 'CANCELLED',
    reason?: 'message' | 'stopped'
  ): Promise<void> {
    const waiter = this.waiters.get(approvalId)
    if (!waiter) return
    this.waiters.delete(approvalId)
    const record = await this.deps.approvals.get(approvalId)
    if (!record) return
    if (record.status === 'PENDING') {
      record.status = status
      record.updatedAt = nowIso()
      await this.deps.approvals.save(record)
    }
    waiter.resolve(record, reason)
  }

  /** The person wrote in the conversation while a card waited: it ends as cancelled (TOOL-CALL-004). */
  public cancelConfirmations(conversationId: string): number {
    let n = 0
    for (const [id, waiter] of [...this.waiters.entries()])
      if (waiter.conversationId === conversationId) {
        void this.close(id, 'CANCELLED', 'message')
        n++
      }
    return n
  }

  /** Whether a confirmation waits in a conversation. */
  public waitsIn(conversationId: string): boolean {
    return [...this.waiters.values()].some((w) => w.conversationId === conversationId)
  }

  /**
   * The person's decision on a confirmation, from any bound session of the conversation (PROF-TOOL-008): the first
   * counts, a later one gets the status already decided. `scope: conversation` on a card that offers no allowance is
   * taken as `once`.
   */
  public async decideConfirmation(
    approvalId: string,
    principal: Principal,
    session: Session,
    decision: 'approve' | 'reject',
    scope: 'once' | 'conversation' | undefined
  ): Promise<{ status: ApprovalStatus } | undefined> {
    const record = await this.deps.approvals.get(approvalId)
    if (record?.kind !== 'confirmation') return undefined
    if (record.requesterId !== principal.id || (session.conversationId ?? session.id) !== record.conversationId)
      return undefined
    const waiter = this.waiters.get(approvalId)
    if (record.status !== 'PENDING' || !waiter) return { status: record.status }
    // the first decision counts: the waiter is taken before anything is awaited
    this.waiters.delete(approvalId)
    record.status = decision === 'approve' ? 'APPROVED' : 'REJECTED'
    if (decision === 'approve')
      record.scope = scope === 'conversation' && record.allowForConversation ? 'conversation' : 'once'
    record.decisions.push({
      approverId: principal.id,
      approverName: displayName(principal),
      role: principal.roles[0] ?? '',
      decision,
      ts: nowIso(),
    })
    record.updatedAt = nowIso()
    await this.deps.approvals.save(record)
    waiter.resolve(record)
    return { status: record.status }
  }

  /** A confirmation changed outside its turn (expired by the job, after a restart): its devices are told. */
  public async onConfirmationChanged(record: ApprovalRecord): Promise<void> {
    if (record.kind !== 'confirmation') return
    if (this.waiters.has(record.id)) {
      const waiter = this.waiters.get(record.id)
      this.waiters.delete(record.id)
      waiter?.resolve(record)
      return
    }
    if (record.entryId) {
      const entry = await this.deps.memory.get(record.entryId)
      if (entry) await this.writeCard(entry, record, record.action?.title ?? record.toolName)
    }
    if (record.conversationId)
      await this.hooks.toConversation?.(record.conversationId, [
        { name: CUSTOM_EVENT.approvalUpdate, value: { approvalId: record.id, status: record.status } },
      ])
  }

  // ---- allowances (TOOL-CALL-006, PROF-TOOL-012) -------------------------------------------------------------------

  /** What an allowance was given under: the rule, the bindings and the account; a change of any ends it. */
  private fingerprint(tool: Pick<TurnTool, 'rule' | 'bindings' | 'accountSetAt'>): string {
    const bindings = Object.keys(tool.bindings)
      .sort()
      .map((k) => [k, tool.bindings[k]])
    return JSON.stringify({ rule: tool.rule, bindings, account: tool.accountSetAt ?? null })
  }

  /** The allowance that covers a call, if one lasts; one whose rule, bindings or account changed ends here. */
  private async allowanceFor(tool: TurnTool, state: TurnToolState): Promise<ToolAllowance | undefined> {
    const all = await this.store.toolAllowances.listByConversation(state.conversationId)
    const found = all.find((a) => !a.endedAt && a.sourceId === tool.source.name && a.toolName === tool.spec.rawName)
    if (!found) return undefined
    if (found.fingerprint !== this.fingerprint(tool)) {
      await this.endAllowance(found)
      return undefined
    }
    return found
  }

  /** Ends an allowance: its card says so, on every session of the conversation (PROF-TOOL-012). */
  public async endAllowance(allowance: ToolAllowance): Promise<void> {
    if (allowance.endedAt) return
    const endedAt = nowIso()
    await this.store.toolAllowances.save({ ...allowance, endedAt })
    const record = await this.deps.approvals.get(allowance.approvalId)
    if (record) {
      record.allowanceEndedAt = endedAt
      record.updatedAt = endedAt
      await this.deps.approvals.save(record)
      if (record.entryId) {
        const entry = await this.deps.memory.get(record.entryId)
        if (entry) await this.writeCard(entry, record, record.action?.title ?? record.toolName)
      }
    }
    await this.hooks.toConversation?.(allowance.conversationId, [
      {
        name: CUSTOM_EVENT.approvalUpdate,
        value: { approvalId: allowance.approvalId, status: 'APPROVED', scope: 'conversation', allowanceEnded: true },
      },
    ])
  }

  /** The rules, bindings or account of a source of a space changed, or it left: its allowances end (TOOL-CALL-006). */
  public async endAllowancesFor(spaceId: string, sourceId: string): Promise<void> {
    for (const allowance of await this.store.toolAllowances.listBySpaceSource(spaceId, sourceId))
      await this.endAllowance(allowance)
  }

  /** A conversation archived or closed for good: its allowances end (TOOL-CALL-006). */
  public async endConversationAllowances(conversationId: string): Promise<void> {
    for (const allowance of await this.store.toolAllowances.listByConversation(conversationId))
      await this.endAllowance(allowance)
  }

  /**
   * `DELETE {sessions}/conversations/{id}/allowances/{approvalId}` (PROF-TOOL-012): `true` once ended (again too),
   * `false` for a confirmation of another conversation or one that gave no allowance.
   */
  public async stopAllowance(conversationId: string, approvalId: string): Promise<boolean> {
    const allowance = await this.store.toolAllowances.get(approvalId)
    if (!allowance || allowance.conversationId !== conversationId) return false
    await this.endAllowance(allowance)
    return true
  }

  // ---- the approval (TOOL-CALL-009, INTX-APPR-004/013/014) -----------------------------------------------------------

  private async askApproval(
    tool: TurnTool,
    title: string,
    args: Record<string, unknown>,
    state: TurnToolState,
    ctx: CallContext,
    record: ToolCallRecord
  ): Promise<string> {
    const action = await this.actionOf(tool, title, args, state.spaceId)
    const owners = tool.spaceTool ? (state.space?.ownerIds ?? []) : []
    const approvers = tool.spaceTool ? [] : this.deps.catalog.approversOf(tool.packRule)
    const approval = await this.deps.approvals.requestSensitivity({
      principal: ctx.principal,
      role: ctx.principal.roles[0] ?? '',
      originSessionId: ctx.session.id,
      toolName: tool.spec.rawName,
      serverName: tool.spec.serverName,
      args,
      rule: tool.packRule.approvalRule ?? {
        tools: [tool.spec.rawName],
        approvers,
        // the space's owner decides attested on the phone, whatever the policy (INTX-APPR-013)
        ...(tool.spaceTool ? { attested: true } : this.deps.pack.approvals?.attested ? { attested: true } : {}),
      },
      inboundId: ctx.inbound?.id,
      tool: {
        action,
        sourceId: tool.source.name,
        conversationId: state.conversationId,
        callId: record.id,
        ...(tool.spaceTool ? { spaceId: state.spaceId, ownerApproval: true } : {}),
      },
    })
    const entry = await this.deps.memory.append({
      sessionId: ctx.session.id,
      principalId: ctx.principal.id,
      role: 'system',
      sourceType: 'approval',
      text: `Approval requested for ${title} (${approval.id})`,
      backingIdentity: ctx.principal.backingIdentity,
      payload: {
        approvalId: approval.id,
        kind: approval.kind,
        toolName: approval.toolName,
        status: approval.status,
        // the requester's card shows the action the approver decides on (PROF-TOOL-009)
        card: await this.requesterCard(approval, state),
      },
    })
    // the approvers' cards were recorded meanwhile: the record is read again before it names its own card
    const fresh = (await this.deps.approvals.get(approval.id)) ?? approval
    fresh.entryId = entry.id
    await this.deps.approvals.save(fresh)
    await this.hooks.onApprovalPending?.(ctx.session, ctx.principal, fresh, entry)
    record.approval = { approvalId: approval.id, status: approval.status, decidedBy: [] }
    record.rule = 'approval'
    await this.finish(record, 'pending')
    const who = tool.spaceTool
      ? `the owner of the space, ${(await this.ownerNames(owners)).join(' or ') || 'its owner'}`
      : approvers.join(' or ')
    return `${title} needs the approval of ${who}. The request is pending: the action runs once approved, and its outcome will be told in this conversation.`
  }

  /** The requester's card of an approval of a call: the action, and the space whose owner approves it. */
  private async requesterCard(record: ApprovalRecord, state: TurnToolState): Promise<Record<string, unknown>> {
    return {
      approvalId: record.id,
      kind: record.kind,
      tool: record.toolName,
      requester: { displayName: record.requesterName, name: record.requesterName, role: record.requesterRole },
      policy: { type: record.policy.type, value: record.policy.value, vetoOnRefusal: record.policy.vetoOnRefusal },
      expiresAt: record.expiresAt,
      status: record.status,
      own: true,
      canDecide: false,
      ...(record.action ? { action: record.action } : {}),
      ...(record.ownerApproval && state.space ? { space: { id: state.space.id, title: state.space.title } } : {}),
    }
  }

  private async ownerNames(ids: string[]): Promise<string[]> {
    const names: string[] = []
    for (const id of ids) {
      const p = await this.deps.principals.get(id)
      if (p) names.push(displayName(p))
    }
    return names
  }

  /**
   * An approval of a tool call decided (TOOL-CALL-009): approved, it runs with the arguments approved and the bindings
   * and account in force now, and its outcome is told in the conversation; otherwise its record says what became of it.
   */
  public async onApprovalDecided(record: ApprovalRecord, sinkFor: (session: Session) => TurnSink): Promise<void> {
    if (record.kind !== 'sensitivity' || !record.sourceId || !record.callId) return
    const call = await this.store.toolCalls.get(record.callId)
    if (call) {
      call.approval = {
        approvalId: record.id,
        status: record.status,
        decidedBy: record.decisions.map((d) => d.approverName),
      }
    }
    if (record.status !== 'APPROVED') {
      if (call)
        await this.finish(
          call,
          record.status === 'REJECTED' ? 'not-approved' : record.status === 'EXPIRED' ? 'expired' : 'cancelled'
        )
      return
    }
    const session = await this.store.sessions.get(record.originSessionId)
    const principal = await this.deps.principals.get(record.requesterId)
    const spec = (await this.deps.registry.all()).find(
      (s) => s.source === record.sourceId && s.rawName === record.toolName
    )
    if (session?.state !== 'bound' || !principal || !spec || !call) {
      if (call) await this.finish(call, 'failed')
      return
    }
    const source = this.deps.catalog.sourceOf(spec.source, spec.rawName)
    const spaceId = call.spaceId
    let bindings = this.deps.spaceTools.bindingValues(source, undefined)
    let accountSetAt: string | undefined
    if (source.availability === 'spaces') {
      const space = await this.deps.spaces.find(spaceId)
      const ready = space
        ? (await this.deps.spaceTools.readyIn(space)).find((r) => r.source.name === source.name)
        : undefined
      if (!ready) {
        await this.finish(call, 'failed')
        await this.tell(
          session,
          principal,
          `The approved action ${record.action?.title ?? ''} did not run: the tool is no longer ready in this space.`,
          []
        )
        return
      }
      bindings = ready.bindings
      accountSetAt = ready.accountSetAt
    }
    const packRule = this.deps.catalog.packRuleOf(source, spec.rawName, spec.annotations)
    const tool: TurnTool = {
      name: spec.name,
      spec,
      source,
      resolution: { tier: 'ALLOW' },
      effect: this.deps.catalog.effectOf(source, spec.rawName, spec.annotations),
      packRule,
      rule: 'approval',
      untrusted: this.deps.catalog.untrustedOf(source, spec.rawName, spec.annotations),
      spaceTool: source.availability === 'spaces',
      bindings,
      ...(accountSetAt ? { accountSetAt } : {}),
      definition: { name: spec.name, description: spec.description, parameters: spec.parameters },
    }
    const title = record.action?.title ?? this.deps.catalog.toolTitle(source, spec.rawName, spec.annotations)
    const args = this.pinned(tool, record.actionArgs ?? {}, bindings)
    const state = {
      conversationId: call.conversationId,
      spaceId,
      untrustedRead: new Map<string, string>(),
      sources: new Map<string, TurnSource>(),
    }
    const sink = sinkFor(session)
    const toolCtx: ToolContext = {
      principal,
      session,
      roles: principal.roles,
      logger: this.deps.logger,
      language: this.deps.pack.language.agent,
      spaceId,
      ...(record.inboundId ? { inboundId: record.inboundId, inboundIds: [record.inboundId] } : {}),
    }
    const content = await this.run(tool, title, args, state, { session, principal, toolCtx, sink }, call, record.id)
    await this.tell(
      session,
      principal,
      `The approved action ${title} ran. ${content.slice(0, 1500)}`,
      [...state.sources.values()],
      record.inboundId
    )
  }

  /** A message of the agent to the conversation, outside a turn, with the sources its tools read (TOOL-PROV-002). */
  private async tell(
    session: Session,
    principal: Principal,
    text: string,
    sources: TurnSource[],
    inboundId?: string
  ): Promise<void> {
    const entry = await this.deps.memory.append({
      sessionId: session.id,
      principalId: principal.id,
      role: 'agent',
      sourceType: 'text',
      text,
      backingIdentity: principal.backingIdentity,
      ...(sources.length ? { sources } : {}),
      ...(inboundId ? { payload: { inboundId, inboundIds: [inboundId] } } : {}),
    })
    await this.hooks.deliver?.(session, entry)
  }

  // ---- the record of each call (TOOL-PROV-004) -------------------------------------------------------------------------

  private newRecord(
    principal: Principal,
    state: TurnToolState,
    tool: TurnTool | undefined,
    name: string
  ): ToolCallRecord {
    const kind = tool?.source.account.kind ?? 'none'
    return {
      id: prefixedId('tcl'),
      at: nowIso(),
      principalId: principal.id,
      conversationId: state.conversationId,
      spaceId: state.spaceId,
      sourceId: tool?.source.name ?? '',
      toolName: tool?.spec.rawName ?? name,
      account: kind === 'space' ? { kind, spaceId: state.spaceId } : { kind },
      rule: tool?.rule ?? 'none',
      raisedByUntrusted: false,
      outcome: 'pending',
      updatedAt: nowIso(),
    }
  }

  private async finish(record: ToolCallRecord, outcome: ToolCallOutcome): Promise<void> {
    record.outcome = outcome
    record.updatedAt = nowIso()
    await this.store.toolCalls.save(record)
  }

  // ---- provenance (TOOL-PROV-003) ---------------------------------------------------------------------------------------

  /**
   * The sources of the tool results a conversation holds, one item per source and account, with the number of results
   * and the time of the latest; results erased with a deleted message do not count (PROF-TOOL-011).
   */
  public async conversationSources(conversationId: string) {
    const rows = await this.store.entries.listAll({ conversationId, limit: 100_000 })
    const groups = new Map<string, { sourceId: string; account: CallAccount; results: number; lastAt: string }>()
    for (const row of rows) {
      if (row.sourceType !== 'tool-call' || !row.provenance) continue
      if (row.state === 'crypto-erased' || row.state === 'deleted') continue
      const p = row.provenance
      const key = `${p.sourceId}|${p.account.kind}|${p.account.spaceId ?? ''}`
      const group = groups.get(key) ?? { sourceId: p.sourceId, account: p.account, results: 0, lastAt: row.createdAt }
      group.results++
      if (row.createdAt > group.lastAt) group.lastAt = row.createdAt
      groups.set(key, group)
    }
    const out = []
    for (const g of groups.values()) {
      const space =
        g.account.kind === 'space' && g.account.spaceId ? await this.deps.spaces.find(g.account.spaceId) : undefined
      out.push({
        source: g.sourceId,
        title: this.deps.catalog.source(g.sourceId)?.title ?? g.sourceId,
        account: { kind: g.account.kind, ...(space ? { space: { id: space.id, title: space.title } } : {}) },
        results: g.results,
        lastAt: g.lastAt,
      })
    }
    return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  }

  /**
   * A message deleted within its window (INTX-APPR-015): the cards of its turn stay with their outcome, the values of their
   * arguments go, and an approval still pending is cancelled.
   */
  public async onTurnErased(approvals: ApprovalRecord[]): Promise<void> {
    for (const record of approvals) {
      if (record.status === 'PENDING') {
        if (record.kind === 'confirmation') {
          const waiter = this.waiters.get(record.id)
          if (waiter) await this.close(record.id, 'CANCELLED', 'stopped')
        } else await this.deps.approvals.cancelBySystem(record.id)
      }
      const fresh = (await this.deps.approvals.get(record.id)) ?? record
      if (fresh.action) {
        fresh.action = { ...fresh.action, fields: [], erased: true }
        fresh.actionArgs = undefined
        fresh.argsErased = true
        await this.deps.approvals.save(fresh)
      }
      for (const entryId of [fresh.entryId, ...(fresh.cardEntryIds ?? [])]) {
        if (!entryId) continue
        const entry = await this.deps.memory.get(entryId)
        if (!entry?.payload) continue
        const card = entry.payload.card as Record<string, unknown> | undefined
        if (!card) continue
        await this.deps.memory.rewrite({
          ...entry,
          payload: {
            ...entry.payload,
            card: { ...card, ...(fresh.action ? { action: fresh.action } : {}), status: fresh.status },
          },
        })
      }
    }
  }
}

/** An input schema without the arguments the agent pins (TOOL-CAT-004, RBAC-FILTER-004). */
export function withoutPinned(
  parameters: Record<string, unknown>,
  source: Pick<CatalogSource, 'bindings'>
): Record<string, unknown> {
  const pinned = source.bindings.flatMap((b) => (b.argument ? [b.argument] : []))
  if (!pinned.length) return parameters
  const properties = { ...((parameters.properties ?? {}) as Record<string, unknown>) }
  for (const name of pinned) delete properties[name]
  const required = Array.isArray(parameters.required)
    ? (parameters.required as string[]).filter((name) => !pinned.includes(name))
    : undefined
  return { ...parameters, properties, ...(required ? { required } : {}) }
}
