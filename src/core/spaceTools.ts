/**
 * Tools in spaces (ayni-spec D97, D98; TOOL-SPACE-001..011, TOOL-ACCESS-003..007; AG-UI profile 3.4 §3.10). A template
 * names the sources of availability `spaces` its spaces may use; in each space a source is `available`, `setup`, `ready`
 * or `off`. Its owner, on the web or on the phone, adds a source, binds it, sets the space's account, tightens or loosens
 * its rules within the agent-pack's, and removes it. A change that grants something waits for the owner's device (a
 * `confirm` flow, attested, whose code is the screen's); a change that only narrows applies at once.
 *
 * The space's account is what the owner types in the space's settings and nowhere else: one value for each field its
 * source declares (D102). The values are trimmed and checked, then sealed together as they arrive, as one record under a
 * key of its own wrapped by the deployment's master key; they are opened in memory for a call and for nothing else, the
 * headers of `account.apply` built from them then, and clearing the account, replacing it or removing its source destroys
 * its key. No answer, event, activity or log carries a value of it.
 */
import { randomInt } from 'node:crypto'
import type { AccountField, AgentPack, CallRule, SpaceCallRule, TemplateTool } from '../config/packTypes.js'
import { SPACE_CALL_RULES } from '../config/packTypes.js'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import {
  boundsOf,
  defaultPolicyOf,
  isLooser,
  type PolicyBounds,
  policyWords,
  samePolicy,
} from '../policy/spacePolicy.js'
import type { Store } from '../store/types.js'
import { accountSecrets, buildAccountHeaders, fitsFields } from '../tools/accountValues.js'
import { type CatalogSource, looser, strictest, type ToolCatalog } from '../tools/catalog.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { CallAccountSecret, ToolSpec } from '../tools/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { type ChallengeService, ConfirmationUnavailable, SPACE_TOOL_CHANGE } from './challenges.js'
import type { ConnectionService } from './connections.js'
import type { Governance, PolicyInForce, PolicyView, PolicyWarning } from './governance.js'
import { isPersonalSpace, SpaceError, type SpaceService } from './spaces.js'
import type {
  AuthChallengeRecord,
  PendingToolChange,
  Principal,
  Session,
  Space,
  SpaceAccountRecord,
  SpaceApprovalPolicy,
  SpaceToolRecord,
} from './types.js'

export type SpaceToolState = 'available' | 'setup' | 'ready' | 'off'
export type ChangeOutcome = 'applied' | 'declined' | 'expired' | 'failed' | 'cancelled'

/** The longest value of a field of an account the owner may send, once trimmed (TOOL-SPACE-005). */
export const MAX_VALUE_LENGTH = 4096

/** What a value of an account may not hold inside it, once trimmed: whitespace or a control character (TOOL-SPACE-005). */
const INNER_WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u

/** The values an owner sends for the fields of an account, before they are sealed (D102). */
type AccountValues = Record<string, string>

/** `ayni.space.tools.changed` (PROF-TOOL-006). */
export interface SpaceToolsChanged {
  spaceId: string
  source: string
  state: SpaceToolState
  changeId?: string
  outcome: ChangeOutcome
}

/** What the owner, or a member, reads of a source in a space (PROF-TOOL-001). */
export interface SpaceToolView {
  source: string
  title: string
  description?: string
  state: SpaceToolState
  add?: 'auto' | 'owner'
  guests: boolean
  account: {
    kind: 'none' | 'agent' | 'space' | 'personal'
    /** the owner's, for a `space` account: the fields to fill, in the agent-pack's order (D102) */
    fields?: { name: string; label: string; pattern?: string }[]
    set?: boolean
    setAt?: string | null
    setBy?: { name: string } | null
    /** a `personal` account: whether the reader's own account of it, for this space, is connected (TOOL-SPACE-012) */
    connected?: boolean
    /** a `personal` account of another source (`account.from`): the source Your accounts lists it under */
    source?: string
  }
  bindings: {
    name?: string
    label: string
    value: string | null
    setBy?: 'pack' | 'owner'
    pattern?: string | null
    /** the binding a personal account is for (D110): the name of its value, read from the owner's account */
    valueLabel?: string | null
    /** the owner's: set from an account of their own, never typed (TOOL-SPACE-013) */
    fromAccount?: true
    /** the owner's: the value and name of each of the owner's own accounts of the source */
    choices?: { value: string; valueLabel: string | null }[]
  }[]
  tools: {
    name?: string
    title: string
    effect: string | null
    rule: SpaceCallRule
    packRule?: CallRule
    stepUp: 'device' | string[] | null
    /** a tool whose rule is `approval`: its approval policy in this space (TOOL-SPACE-018, PROF-TOOL-036) */
    approval?: PolicyView
  }[]
  pending?: { changeId: string; summary: string; code: string; expiresAt: string } | null
}

/** A source ready in a space, as a turn takes it (TOOL-SPACE-001, RBAC-FILTER-004). */
export interface ReadySource {
  source: CatalogSource
  entry: TemplateTool
  record: SpaceToolRecord
  /** the values of its bindings, the pack's and the owner's */
  bindings: Record<string, string>
  /** when its account was set, for the fingerprint of an allowance (TOOL-CALL-006) */
  accountSetAt?: string
}

export interface SpaceToolsHooks {
  /** a change applied or was dropped: every bound session of the space's owners hears it (TOOL-SPACE-010) */
  announce?: (space: Space, value: SpaceToolsChanged) => Promise<void>
  /** the account of a source ended or changed: its connection closes (TOOL-ACCESS-007) */
  accountEnded?: (spaceId: string, sourceId: string) => Promise<void>
  /** the rules, bindings or account of a source changed: the allowances of its tools end (TOOL-CALL-006) */
  endAllowances?: (spaceId: string, sourceId: string) => Promise<void>
  /** a person's name, as the settings show who set the account */
  nameOf?: (principalId: string) => Promise<string>
}

const RULE_WORDS: Record<SpaceCallRule, string> = {
  none: 'runs without asking',
  confirm: 'asks the person to confirm',
  approval: 'asks for your approval',
  off: 'off',
}

/** A code the screen shows and the phone repeats: two groups of two digits (TOOL-SPACE-008). */
function newCode(): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(randomInt(0, 100))} ${pad(randomInt(0, 100))}`
}

export class SpaceToolService {
  public hooks: SpaceToolsHooks = {}
  /** each person's own accounts (D104): whether a reader's is connected, the owner's choices of a binding (D110) */
  public connections?: ConnectionService
  /** the approval policies of the tools (D137): whom they name, their checks, warnings and attention */
  public governance?: Governance

  public constructor(
    private readonly store: Store,
    private readonly pack: AgentPack,
    private readonly catalog: ToolCatalog,
    private readonly crypto: EntryCrypto,
    private readonly spaces: SpaceService,
    private readonly registry: ToolRegistry,
    private readonly challenges: ChallengeService,
    private readonly logger: Logger,
    /** how long the owner's phone has to confirm a change (TOOL_CHANGE_CONFIRMATION_SECONDS, 300 by default) */
    private readonly confirmationSeconds = 300
  ) {}

  // ---- the template, the state ----------------------------------------------------------------------------------

  /** The sources a space's template names (TOOL-AVAIL-002): none for Personal. */
  public entriesOf(space: Pick<Space, 'id' | 'templateId'>): TemplateTool[] {
    if (isPersonalSpace(space.id)) return []
    return this.catalog.templateTools(space.templateId)
  }

  private entryOf(space: Space, sourceId: string): { entry: TemplateTool; source: CatalogSource } {
    const entry = this.entriesOf(space).find((e) => e.source === sourceId)
    const source = entry ? this.catalog.source(sourceId) : undefined
    if (!entry || !source) throw new SpaceError('this source is not one of the space template', 'not-found')
    return { entry, source }
  }

  /** The record of a source in a space; an `add: auto` source has one from the space's creation (TOOL-SPACE-001). */
  private async recordOf(space: Space, entry: TemplateTool): Promise<SpaceToolRecord> {
    const found = await this.store.spaceTools.get(space.id, entry.source)
    if (found) return found
    const record: SpaceToolRecord = {
      spaceId: space.id,
      sourceId: entry.source,
      added: entry.add === 'auto',
      bindings: {},
      calls: {},
      updatedAt: nowIso(),
    }
    if (entry.add === 'auto') await this.store.spaceTools.save(record)
    return record
  }

  /** The values of a source's bindings in a space: the pack's, then the owner's (TOOL-CAT-005). */
  public bindingValues(
    source: CatalogSource,
    record: Pick<SpaceToolRecord, 'bindings'> | undefined
  ): Record<string, string> {
    const values: Record<string, string> = {}
    for (const binding of source.bindings) {
      const value = binding.value ?? record?.bindings[binding.name]
      if (value !== undefined) values[binding.name] = value
    }
    return values
  }

  /** `available`, `setup`, `ready` or `off` (TOOL-SPACE-001). */
  public stateOf(
    source: CatalogSource,
    record: SpaceToolRecord,
    account: SpaceAccountRecord | undefined
  ): SpaceToolState {
    if (!record.added) return record.removed ? 'off' : 'available'
    const values = this.bindingValues(source, record)
    const unbound = source.bindings.some((b) => values[b.name] === undefined)
    const noAccount = source.account.kind === 'space' && !account
    return unbound || noAccount ? 'setup' : 'ready'
  }

  /** The sources ready in a space, for a turn (TOOL-SPACE-001, RBAC-FILTER-004). */
  public async readyIn(space: Space): Promise<ReadySource[]> {
    const out: ReadySource[] = []
    for (const entry of this.entriesOf(space)) {
      const source = this.catalog.source(entry.source)
      if (!source) continue
      const record = await this.recordOf(space, entry)
      const account = await this.store.spaceAccounts.get(space.id, entry.source)
      if (this.stateOf(source, record, account) !== 'ready') continue
      out.push({
        source,
        entry,
        record,
        bindings: this.bindingValues(source, record),
        ...(account ? { accountSetAt: account.setAt } : {}),
      })
    }
    return out
  }

  /** The values of an account, opened from what is sealed; none when they do not fit the fields its source declares. */
  private openValues(fields: readonly AccountField[], sealed: { encKeyRef: string; cipher: string }) {
    try {
      const opened = openJson<{ values?: unknown }>(this.crypto, sealed.encKeyRef, Buffer.from(sealed.cipher, 'base64'))
      return fitsFields(fields, opened.values) ? opened.values : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The space's account of a source, opened in memory for one call (TOOL-ACCESS-005): the headers of `account.apply`
   * built from the values of its fields (D102), with what an echo is scrubbed of; never logged, never returned to a
   * client, never given to the model.
   */
  public async openAccount(spaceId: string, sourceId: string): Promise<CallAccountSecret | undefined> {
    const source = this.catalog.source(sourceId)
    if (source?.account.kind !== 'space') return undefined
    const record = await this.store.spaceAccounts.get(spaceId, sourceId)
    const values = record ? this.openValues(source.account.fields ?? [], record) : undefined
    if (!values) return { kind: 'space', spaceId }
    const headers = buildAccountHeaders(source.account, values)
    return { kind: 'space', spaceId, headers, secrets: accountSecrets(values, headers) }
  }

  // ---- what the settings show (PROF-TOOL-001) ---------------------------------------------------------------------

  /**
   * The tools a source offers, with what the pack and its server say of them; with `discover` false, from what the
   * registry knows and the agent-pack only, with no connection.
   */
  private async toolsOf(
    source: CatalogSource,
    spaceId?: string,
    discover = true
  ): Promise<{ name: string; spec?: ToolSpec }[]> {
    let specs = (await this.registry.all()).filter((s) => s.source === source.name)
    if (discover && !specs.length && source.kind === 'mcp' && source.account.kind === 'space' && spaceId) {
      const account = await this.openAccount(spaceId, source.name)
      if (account?.headers) {
        await this.registry.discover(source.name, account)
        specs = (await this.registry.all()).filter((s) => s.source === source.name)
      }
    }
    if (specs.length) return specs.map((spec) => ({ name: spec.rawName, spec }))
    return (source.offer ?? Object.keys(source.tools)).map((name) => ({ name }))
  }

  // ---- the approval policies of its tools (TOOL-SPACE-018 to 021, TOOL-CAT-023) ------------------------------------

  /** The policy in force of a tool whose rule is `approval`: the owner's, else the agent-pack's default (TOOL-SPACE-018). */
  public policyOf(
    source: CatalogSource,
    record: Pick<SpaceToolRecord, 'approvals'>,
    tool: string
  ): SpaceApprovalPolicy {
    return record.approvals?.[tool] ?? defaultPolicyOf(this.pack, source.tools[tool]?.approval)
  }

  /** The agent-pack's bounds of a tool's policy (TOOL-CAT-023). */
  public boundsFor(source: CatalogSource, tool: string): PolicyBounds {
    return boundsOf(this.pack, source.tools[tool]?.approval)
  }

  /** The policies in force of a space's tools whose rule is `approval`, of every source added to it; no connection made. */
  public async policiesOf(space: Space): Promise<PolicyInForce[]> {
    const out: PolicyInForce[] = []
    for (const entry of this.entriesOf(space)) {
      const source = this.catalog.source(entry.source)
      const record = source ? await this.store.spaceTools.get(space.id, entry.source) : undefined
      if (!source || !record?.added) continue
      for (const { name, spec } of await this.toolsOf(source, space.id, false)) {
        const packRule = this.catalog.packRuleOf(source, name, spec?.annotations).rule
        const owner = record.calls[name]
        const rule = owner ? strictest<SpaceCallRule>(packRule, owner) : packRule
        if (rule !== 'approval') continue
        out.push({
          sourceId: source.name,
          tool: name,
          title: this.catalog.toolTitle(source, name, spec?.annotations),
          policy: this.policyOf(source, record, name),
          bounds: this.boundsFor(source, name),
        })
      }
    }
    return out
  }

  /** The policies of tools whose rule is no longer `approval` are dropped with it (TOOL-SPACE-018). */
  private async withoutStalePolicies(space: Space, source: CatalogSource, record: SpaceToolRecord) {
    if (!record.approvals) return record
    const kept: Record<string, SpaceApprovalPolicy> = {}
    for (const [tool, policy] of Object.entries(record.approvals))
      if ((await this.ruleInForce(space, source, record, tool)) === 'approval') kept[tool] = policy
    const { approvals: _all, ...rest } = record
    return Object.keys(kept).length ? { ...rest, approvals: kept } : rest
  }

  private async view(
    space: Space,
    entry: TemplateTool,
    owner: boolean,
    reader?: Principal,
    /** the warnings of the policies a request sent, for the answer of that request (TOOL-SPACE-020) */
    warningsFor?: Record<string, PolicyWarning[]>
  ): Promise<SpaceToolView | undefined> {
    const source = this.catalog.source(entry.source)
    if (!source) return undefined
    const record = await this.recordOf(space, entry)
    const account = await this.store.spaceAccounts.get(space.id, entry.source)
    const state = this.stateOf(source, record, account)
    if (!owner && state !== 'ready') return undefined
    const tools = []
    for (const { name, spec } of await this.toolsOf(source, space.id)) {
      const packRule = this.catalog.packRuleOf(source, name, spec?.annotations).rule
      const ownerRule = record.calls[name]
      const rule: SpaceCallRule = ownerRule ? strictest<SpaceCallRule>(packRule, ownerRule) : packRule
      // a member reads the tools members can use: one set `off` is not listed to them (PROF-TOOL-001)
      if (!owner && rule === 'off') continue
      const approval =
        rule === 'approval' && this.governance
          ? await this.governance.view(
              space,
              this.policyOf(source, record, name),
              this.boundsFor(source, name),
              owner,
              warningsFor?.[name]
            )
          : undefined
      tools.push({
        ...(owner ? { name } : {}),
        title: this.catalog.toolTitle(source, name, spec?.annotations),
        effect: this.catalog.effectOf(source, name, spec?.annotations) ?? null,
        rule,
        ...(owner ? { packRule } : {}),
        stepUp: this.catalog.stepUpTypeOf(source, name),
        ...(approval ? { approval } : {}),
      })
    }
    const values = this.bindingValues(source, record)
    // the binding each person's account is for (D110): its value's name for every reader, the owner's own accounts as the
    // choices of its value
    const accountBinding = this.connections?.accountBindingOf(source)
    const choices = owner && accountBinding && reader ? await this.connections?.choicesOf(reader, source) : undefined
    const bindings = source.bindings.map((b) => {
      const ofAccount = b.name === accountBinding
      const valueLabel = ofAccount ? { valueLabel: record.bindingLabels?.[b.name] ?? null } : {}
      return owner
        ? {
            name: b.name,
            label: b.label,
            value: values[b.name] ?? null,
            setBy: b.value !== undefined ? ('pack' as const) : ('owner' as const),
            pattern: b.pattern ?? null,
            ...valueLabel,
            ...(ofAccount && b.value === undefined ? { fromAccount: true as const, choices: choices ?? [] } : {}),
          }
        : { label: b.label, value: values[b.name] ?? null, ...valueLabel }
    })
    const accountView: SpaceToolView['account'] = { kind: source.account.kind }
    // a person's own account (TOOL-SPACE-012): whether the reader's is connected for this space, never a label; and, for
    // a source that uses another's account, the source Your accounts lists it under (TOOL-CAT-015)
    if (source.account.kind === 'personal') {
      accountView.connected = reader
        ? ((await this.connections?.connectedIn(reader, source, space.id)) ?? false)
        : false
      const declaring = this.connections?.declaringOf(source)
      if (declaring && declaring.name !== source.name) accountView.source = declaring.name
    }
    if (owner && source.account.kind === 'space') {
      // the fields the owner fills, in the agent-pack's order, and never a value (PROF-TOOL-001)
      accountView.fields = (source.account.fields ?? []).map((f) => ({
        name: f.name,
        label: f.label,
        ...(f.pattern ? { pattern: f.pattern } : {}),
      }))
      accountView.set = !!account
      accountView.setAt = account?.setAt ?? null
      accountView.setBy = account ? { name: (await this.hooks.nameOf?.(account.setByPrincipalId)) ?? '' } : null
    }
    const pending = record.pendingChange
    return {
      source: source.name,
      title: source.title,
      ...(source.description ? { description: source.description } : {}),
      state,
      ...(owner ? { add: entry.add ?? 'owner' } : {}),
      guests: entry.guests === true,
      account: accountView,
      bindings,
      tools,
      ...(owner
        ? {
            pending: pending
              ? { changeId: pending.id, summary: pending.summary, code: pending.code, expiresAt: pending.expiresAt }
              : null,
          }
        : {}),
    }
  }

  /**
   * `GET {sessions}/spaces/{id}/tools` (TOOL-SPACE-002): to the owner every source of the template, to another active
   * member the `ready` ones; Personal has none; anyone else gets 404.
   */
  public async list(principal: Principal, spaceId: string): Promise<SpaceToolView[]> {
    const access = await this.spaces.access(principal, spaceId)
    if (!access || access.left) throw new SpaceError('space not found', 'not-found')
    if (isPersonalSpace(spaceId)) return []
    const owner = access.role === 'owner'
    const out: SpaceToolView[] = []
    for (const entry of this.entriesOf(access.space)) {
      const view = await this.view(access.space, entry, owner, principal)
      if (view) out.push(view)
    }
    return out
  }

  /** One source of a space, as its owner reads it. */
  public async ownerView(
    space: Space,
    sourceId: string,
    reader?: Principal,
    warningsFor?: Record<string, PolicyWarning[]>
  ): Promise<SpaceToolView> {
    const { entry } = this.entryOf(space, sourceId)
    return (await this.view(space, entry, true, reader, warningsFor)) as SpaceToolView
  }

  // ---- what the owner changes -------------------------------------------------------------------------------------

  /** The owner of a space, and the source its template names; Personal's tools change never (`409 personal-space`). */
  private async owned(
    principal: Principal,
    spaceId: string,
    sourceId: string
  ): Promise<{ space: Space; entry: TemplateTool; source: CatalogSource }> {
    const access = await this.spaces.owned(principal, spaceId)
    return { space: access.space, ...this.entryOf(access.space, sourceId) }
  }

  /**
   * The owner's bindings, checked (TOOL-SPACE-004, TOOL-SPACE-013): a declared binding, left to the owner, matching its
   * pattern; the binding a personal account is for, one of the owner's own accounts' values, with its name.
   */
  private async checkBindings(
    principal: Principal,
    source: CatalogSource,
    bindings: unknown
  ): Promise<{ values: Record<string, string>; labels: Record<string, string> }> {
    const values = this.checkBindingValues(source, bindings)
    const labels: Record<string, string> = {}
    const accountBinding = this.connections?.accountBindingOf(source)
    if (accountBinding && values[accountBinding] !== undefined) {
      const choice = (await this.connections?.choicesOf(principal, source))?.find(
        (c) => c.value === values[accountBinding]
      )
      if (!choice)
        throw new SpaceError(
          'the value of this binding is set from an account of your own: connect it, then choose it',
          'not-your-account',
          `bindings.${accountBinding}`
        )
      if (choice.valueLabel) labels[accountBinding] = choice.valueLabel
    }
    return { values, labels }
  }

  private checkBindingValues(source: CatalogSource, bindings: unknown): Record<string, string> {
    if (bindings === undefined || bindings === null) return {}
    if (typeof bindings !== 'object' || Array.isArray(bindings))
      throw new SpaceError('bindings is an object of values', 'bad-binding', 'bindings')
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(bindings as Record<string, unknown>)) {
      const field = `bindings.${name}`
      const binding = source.bindings.find((b) => b.name === name)
      if (!binding) throw new SpaceError(`the source declares no binding ${name}`, 'bad-binding', field)
      if (binding.value !== undefined) throw new SpaceError(`the agent-pack sets ${name}`, 'pinned-by-pack', field)
      if (typeof value !== 'string' || !value.trim())
        throw new SpaceError(`${binding.label} is a text`, 'bad-binding', field)
      if (binding.pattern && !new RegExp(binding.pattern).test(value))
        throw new SpaceError(`${binding.label} does not match its pattern`, 'bad-binding', field)
      out[name] = value
    }
    return out
  }

  /** The owner's rules, checked (TOOL-SPACE-006): a tool of the source, a known rule, never looser than the pack's. */
  private async checkCalls(
    space: Space,
    source: CatalogSource,
    calls: unknown
  ): Promise<Record<string, SpaceCallRule>> {
    if (calls === undefined || calls === null) return {}
    if (typeof calls !== 'object' || Array.isArray(calls))
      throw new SpaceError('calls is an object of rules', 'bad-request', 'calls')
    const tools = await this.toolsOf(source, space.id)
    const out: Record<string, SpaceCallRule> = {}
    for (const [name, rule] of Object.entries(calls as Record<string, unknown>)) {
      const field = `calls.${name}`
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new SpaceError(`the source offers no tool ${name}`, 'bad-request', field)
      if (!SPACE_CALL_RULES.includes(rule as SpaceCallRule))
        throw new SpaceError(`a rule is one of ${SPACE_CALL_RULES.join(', ')}`, 'bad-request', field)
      const packRule = this.catalog.packRuleOf(source, name, tool.spec?.annotations).rule
      if (looser(rule as SpaceCallRule, packRule))
        throw new SpaceError(`${name} cannot be looser than the agent-pack's ${packRule}`, 'looser-than-pack', field)
      out[name] = rule as SpaceCallRule
    }
    return out
  }

  /** The rule in force for a tool in a space: the owner's, never looser than the pack's (TOOL-CALL-002). */
  private async ruleInForce(space: Space, source: CatalogSource, record: SpaceToolRecord, tool: string) {
    const spec = (await this.toolsOf(source, space.id)).find((t) => t.name === tool)?.spec
    const packRule = this.catalog.packRuleOf(source, tool, spec?.annotations).rule
    const owner = record.calls[tool]
    return owner ? strictest<SpaceCallRule>(packRule, owner) : packRule
  }

  /** The words of a change: the space, the source and every value but the account's (TOOL-SPACE-008). */
  private async summaryOf(
    head: string,
    space: Space,
    source: CatalogSource,
    change: {
      bindings?: Record<string, string>
      calls?: Record<string, SpaceCallRule>
      /** the names of the values of a binding a personal account is for: what the phone shows (D110) */
      labels?: Record<string, string>
      /** the policies a change sets, with those in force (TOOL-SPACE-019) */
      approvals?: Record<string, { before: SpaceApprovalPolicy; after: SpaceApprovalPolicy }>
    }
  ): Promise<string> {
    const parts: string[] = []
    for (const [name, value] of Object.entries(change.bindings ?? {}))
      parts.push(`${source.bindings.find((b) => b.name === name)?.label ?? name}: ${change.labels?.[name] ?? value}`)
    const tools = await this.toolsOf(source, space.id)
    const title = (name: string) =>
      this.catalog.toolTitle(source, name, tools.find((t) => t.name === name)?.spec?.annotations)
    for (const [name, rule] of Object.entries(change.calls ?? {})) parts.push(`${title(name)}: ${RULE_WORDS[rule]}`)
    // a policy as people read it, before and after (TOOL-SPACE-019)
    const policies: { name: string; text: string }[] = []
    for (const [name, { before, after }] of Object.entries(change.approvals ?? {}))
      policies.push({
        name,
        text: `from ${await this.policyText(space, before)}, to ${await this.policyText(space, after)}`,
      })
    const [only] = policies
    if (only && policies.length === 1 && !parts.length)
      return `Change who approves ${title(only.name)} in ${space.title}: ${only.text}`
    for (const p of policies) parts.push(`who approves ${title(p.name)}: ${p.text}`)
    return parts.length ? `${head}: ${parts.join('; ')}` : head
  }

  /** "Jonas Weber (required), Marta Kova, 2 approvals" (TOOL-SPACE-019). */
  private async policyText(space: Space, policy: SpaceApprovalPolicy): Promise<string> {
    const names = new Map<number, string>()
    for (const [i, entry] of policy.approvers.entries())
      names.set(i, (await this.governance?.entryText(space, entry)) ?? entry.kind)
    return policyWords(policy, (entry) => names.get(policy.approvers.indexOf(entry)) ?? entry.kind)
  }

  /**
   * Holds a change that grants something until the owner's device confirms it (TOOL-SPACE-008): one per source
   * (TOOL-SPACE-009), with a code and its expiry; refused with no capability channel to serve it.
   */
  private async hold(
    principal: Principal,
    session: Session,
    space: Space,
    record: SpaceToolRecord,
    change: Omit<PendingToolChange, 'id' | 'code' | 'expiresAt' | 'sessionId' | 'requestedBy'>
  ): Promise<SpaceToolRecord> {
    if (record.pendingChange) throw new SpaceError('a change of this source waits for the phone', 'change-pending')
    const pending: PendingToolChange = {
      ...change,
      id: prefixedId('chg'),
      code: newCode(),
      expiresAt: new Date(Date.now() + this.confirmationSeconds * 1000).toISOString(),
      sessionId: session.id,
      requestedBy: principal.id,
    }
    let challenge: AuthChallengeRecord
    try {
      challenge = await this.challenges.confirmChange({
        principal,
        originSession: session,
        text: pending.summary,
        code: pending.code,
        expiresAt: pending.expiresAt,
        changeId: pending.id,
      })
    } catch (error) {
      if (error instanceof ConfirmationUnavailable)
        throw new SpaceError(
          'the change needs the confirmation of your phone, which is not connected',
          'confirmation-unavailable'
        )
      throw error
    }
    const flowId = challenge.details?.flowId
    const held: SpaceToolRecord = {
      ...record,
      pendingChange: {
        ...pending,
        challengeId: challenge.id,
        ...(typeof flowId === 'string' ? { flowId } : {}),
      },
    }
    // the challenge may have ended already (a phone that answers at once): what follows it reads the store
    const now = await this.store.spaceTools.get(space.id, record.sourceId)
    if (now?.pendingChange?.id && now.pendingChange.id !== pending.id) return now
    await this.store.spaceTools.save(held)
    const settled = await this.store.challenges.get(challenge.id)
    if (settled && settled.outcome !== 'pending') await this.settle(settled)
    this.logger.info(
      { spaceId: space.id, source: record.sourceId, changeId: pending.id, kind: pending.kind },
      'a change of a space tool waits for the owner phone'
    )
    return (await this.store.spaceTools.get(space.id, record.sourceId)) ?? held
  }

  /** `POST {sessions}/spaces/{id}/tools` (TOOL-SPACE-003): add an `available` source, or switch an `off` one back on. */
  public async add(
    principal: Principal,
    session: Session,
    spaceId: string,
    body: { source?: unknown; bindings?: unknown; calls?: unknown }
  ): Promise<SpaceToolView> {
    if (typeof body.source !== 'string' || !body.source)
      throw new SpaceError('source is required', 'bad-request', 'source')
    const { space, entry, source } = await this.owned(principal, spaceId, body.source)
    const record = await this.recordOf(space, entry)
    if (record.added) throw new SpaceError('the source is in the space already', 'already-added')
    const { values: bindings, labels } = await this.checkBindings(principal, source, body.bindings)
    const calls = await this.checkCalls(space, source, body.calls)
    const summary = await this.summaryOf(`Add ${source.title} to ${space.title}`, space, source, {
      bindings,
      calls,
      labels,
    })
    await this.hold(principal, session, space, record, {
      kind: 'add',
      bindings,
      calls,
      summary,
      ...(Object.keys(labels).length ? { bindingLabels: labels } : {}),
    })
    return this.ownerView(space, source.name, principal)
  }

  /**
   * `PATCH {sessions}/spaces/{id}/tools/{source}` (TOOL-SPACE-004/006): a change that only makes rules stricter applies at
   * once (`200`); one that sets a binding or loosens a rule waits whole for the phone (`202`).
   */
  public async patch(
    principal: Principal,
    session: Session,
    spaceId: string,
    sourceId: string,
    body: { bindings?: unknown; calls?: unknown; approvals?: unknown }
  ): Promise<{ status: 200 | 202; tool: SpaceToolView }> {
    const { space, entry, source } = await this.owned(principal, spaceId, sourceId)
    const record = await this.recordOf(space, entry)
    if (!record.added) throw new SpaceError('add the source to the space first', 'not-added')
    const { values: bindings, labels } = await this.checkBindings(principal, source, body.bindings)
    const calls = await this.checkCalls(space, source, body.calls)
    const changedBindings = Object.fromEntries(Object.entries(bindings).filter(([k, v]) => record.bindings[k] !== v))
    let grants = Object.keys(changedBindings).length > 0
    const changedCalls: Record<string, SpaceCallRule> = {}
    for (const [tool, rule] of Object.entries(calls)) {
      const inForce = await this.ruleInForce(space, source, record, tool)
      if (rule === inForce && record.calls[tool] === rule) continue
      changedCalls[tool] = rule
      if (looser(rule, inForce)) grants = true
    }
    // the approval policies, each whole (TOOL-SPACE-018); a looser one grants, a stricter one narrows (TOOL-SPACE-019)
    const policies = await this.checkPolicies(space, source, record, calls, body.approvals)
    const changedApprovals: Record<string, SpaceApprovalPolicy> = {}
    const policyChanges: Record<string, { before: SpaceApprovalPolicy; after: SpaceApprovalPolicy }> = {}
    const warningsFor: Record<string, PolicyWarning[]> = {}
    for (const [tool, after] of Object.entries(policies)) {
      if (this.governance) warningsFor[tool] = await this.governance.warnings(space, after)
      const before = this.policyOf(source, record, tool)
      if (samePolicy(before, after)) continue
      changedApprovals[tool] = after
      policyChanges[tool] = { before, after }
      if (isLooser(before, after)) grants = true
    }
    if (
      !Object.keys(changedBindings).length &&
      !Object.keys(changedCalls).length &&
      !Object.keys(changedApprovals).length
    )
      return { status: 200, tool: await this.ownerView(space, source.name, principal, warningsFor) }
    if (grants) {
      // one granting change at a time; one that only narrows applies whatever waits (TOOL-SPACE-009)
      if (record.pendingChange) throw new SpaceError('a change of this source waits for the phone', 'change-pending')
      const changedLabels = Object.fromEntries(Object.entries(labels).filter(([k]) => k in changedBindings))
      const summary = await this.summaryOf(`Change ${source.title} in ${space.title}`, space, source, {
        bindings: changedBindings,
        calls: changedCalls,
        labels: changedLabels,
        approvals: policyChanges,
      })
      await this.hold(principal, session, space, record, {
        kind: 'patch',
        bindings: changedBindings,
        calls: changedCalls,
        ...(Object.keys(changedApprovals).length ? { approvals: changedApprovals } : {}),
        summary,
        ...(Object.keys(changedLabels).length ? { bindingLabels: changedLabels } : {}),
      })
      return { status: 202, tool: await this.ownerView(space, source.name, principal, warningsFor) }
    }
    // only stricter: at once, with no challenge, a change that waits for the phone kept as it is (TOOL-SPACE-008)
    const current = (await this.store.spaceTools.get(space.id, source.name)) ?? record
    const approvals = { ...(current.approvals ?? {}), ...changedApprovals }
    await this.store.spaceTools.save(
      await this.withoutStalePolicies(space, source, {
        ...current,
        calls: { ...current.calls, ...changedCalls },
        ...(Object.keys(approvals).length ? { approvals } : {}),
        updatedAt: nowIso(),
        updatedBy: principal.id,
      })
    )
    await this.hooks.endAllowances?.(space.id, source.name)
    await this.spaces.record(space.id, principal.id, 'tool-changed', { sourceId: source.name })
    await this.governance?.review(space)
    const tool = await this.ownerView(space, source.name, principal, warningsFor)
    await this.announce(space, { spaceId: space.id, source: source.name, state: tool.state, outcome: 'applied' })
    return { status: 200, tool }
  }

  /**
   * The policies a request sets (TOOL-SPACE-018): for tools the source offers (`400 bad-request` otherwise), whose rule
   * is `approval` once the request applies (`422 not-approval`), each whole and within the agent-pack's bounds.
   */
  private async checkPolicies(
    space: Space,
    source: CatalogSource,
    record: SpaceToolRecord,
    calls: Record<string, SpaceCallRule>,
    approvals: unknown
  ): Promise<Record<string, SpaceApprovalPolicy>> {
    if (approvals === undefined || approvals === null) return {}
    if (typeof approvals !== 'object' || Array.isArray(approvals))
      throw new SpaceError('approvals is an object of policies by tool', 'bad-request', 'approvals')
    if (!this.governance) throw new SpaceError('this agent sets no approval policy', 'bad-request', 'approvals')
    const tools = await this.toolsOf(source, space.id)
    const out: Record<string, SpaceApprovalPolicy> = {}
    for (const [name, raw] of Object.entries(approvals as Record<string, unknown>)) {
      const field = `approvals.${name}`
      if (!tools.some((t) => t.name === name))
        throw new SpaceError(`the source offers no tool ${name}`, 'bad-request', field)
      const rule = calls[name] ?? (await this.ruleInForce(space, source, record, name))
      if (rule !== 'approval') throw new SpaceError(`the rule of ${name} is not approval`, 'not-approval', field)
      out[name] = await this.governance.parsePolicy(space, name, raw, this.boundsFor(source, name))
    }
    return out
  }

  /**
   * The values the owner sent for the fields of an account (TOOL-SPACE-005, D102): every declared field and no other
   * (`400 bad-request`, `field: account.<name>`), each trimmed of the whitespace around it, then refused (`422 bad-token`,
   * at its field) when empty, longer than 4096 characters, with whitespace or a control character inside, or not matching
   * its pattern. No message names a value.
   */
  public checkValues(fields: readonly AccountField[], values: unknown): AccountValues {
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new SpaceError('values is an object of the values of the fields of the account', 'bad-request', 'values')
    const given = values as Record<string, unknown>
    for (const name of Object.keys(given))
      if (!fields.some((f) => f.name === name))
        throw new SpaceError(`the account declares no field ${name}`, 'bad-request', `account.${name}`)
    for (const field of fields)
      if (!Object.hasOwn(given, field.name))
        throw new SpaceError(`the ${field.label} is missing`, 'bad-request', `account.${field.name}`)
    const out: AccountValues = {}
    for (const field of fields) {
      const at = `account.${field.name}`
      const raw = given[field.name]
      if (typeof raw !== 'string') throw new SpaceError(`the ${field.label} is not a text`, 'bad-token', at)
      // a paste often brings a space or a line break with it: the value is what lies between (D102)
      const value = raw.trim()
      if (!value) throw new SpaceError(`the ${field.label} is empty`, 'bad-token', at)
      if (value.length > MAX_VALUE_LENGTH)
        throw new SpaceError(`the ${field.label} is longer than ${MAX_VALUE_LENGTH} characters`, 'bad-token', at)
      if (INNER_WHITESPACE_OR_CONTROL.test(value))
        throw new SpaceError(`the ${field.label} has whitespace or a control character inside it`, 'bad-token', at)
      if (field.pattern !== undefined && !new RegExp(field.pattern).test(value))
        throw new SpaceError(`the ${field.label} is not in the form this source takes`, 'bad-token', at)
      out[field.name] = value
    }
    return out
  }

  /**
   * `PUT {sessions}/spaces/{id}/tools/{source}/account` (TOOL-SPACE-005): the values of its fields are checked, sealed
   * together as they arrive, and used only once the phone confirms; refused values are kept nowhere.
   */
  public async setAccount(
    principal: Principal,
    session: Session,
    spaceId: string,
    sourceId: string,
    values: unknown
  ): Promise<SpaceToolView> {
    const { space, entry, source } = await this.owned(principal, spaceId, sourceId)
    if (source.account.kind !== 'space')
      throw new SpaceError('the calls of this source do not run with an account of the space', 'no-space-account')
    const record = await this.recordOf(space, entry)
    if (!record.added) throw new SpaceError('add the source to the space first', 'not-added')
    if (record.pendingChange) throw new SpaceError('a change of this source waits for the phone', 'change-pending')
    const checked = this.checkValues(source.account.fields ?? [], values)
    // the values of every field together, as one record under one key (TOOL-ACCESS-004)
    const keyRef = this.crypto.newWrappedKey()
    const { cipher } = sealJson(this.crypto, keyRef, { values: checked })
    const set = !!(await this.store.spaceAccounts.get(space.id, source.name))
    const head = `${set ? 'Replace' : 'Set'} the account of ${source.title} in ${space.title}`
    await this.hold(principal, session, space, record, {
      kind: 'account',
      sealedValues: { keyRef, cipher: cipher.toString('base64') },
      summary: head,
    })
    return this.ownerView(space, source.name, principal)
  }

  /** `DELETE …/account` (TOOL-SPACE-005): cleared at once, its key destroyed. */
  public async clearAccount(principal: Principal, spaceId: string, sourceId: string): Promise<SpaceToolView> {
    const { space, source } = await this.owned(principal, spaceId, sourceId)
    if (source.account.kind !== 'space')
      throw new SpaceError('the calls of this source do not run with an account of the space', 'no-space-account')
    if (await this.store.spaceAccounts.get(space.id, source.name)) {
      await this.destroyAccount(space.id, source.name)
      await this.hooks.endAllowances?.(space.id, source.name)
      await this.spaces.record(space.id, principal.id, 'account-cleared', { sourceId: source.name })
    }
    const tool = await this.ownerView(space, source.name, principal)
    await this.announce(space, { spaceId: space.id, source: source.name, state: tool.state, outcome: 'applied' })
    return tool
  }

  /**
   * `DELETE {sessions}/spaces/{id}/tools/{source}` (TOOL-SPACE-007): at once, `available` again or `off`, its bindings,
   * rules and account dropped, its pending change withdrawn, the allowances of its tools ended.
   */
  public async remove(principal: Principal, spaceId: string, sourceId: string): Promise<SpaceToolView> {
    const { space, entry, source } = await this.owned(principal, spaceId, sourceId)
    const record = await this.recordOf(space, entry)
    const wasAdded = record.added
    if (record.pendingChange) await this.drop(space, record, 'cancelled', true)
    await this.store.spaceTools.save({
      spaceId: space.id,
      sourceId: source.name,
      added: false,
      ...(entry.add === 'auto' ? { removed: true } : {}),
      bindings: {},
      calls: {},
      updatedAt: nowIso(),
      updatedBy: principal.id,
    })
    await this.destroyAccount(space.id, source.name)
    await this.hooks.endAllowances?.(space.id, source.name)
    if (wasAdded) await this.spaces.record(space.id, principal.id, 'tool-removed', { sourceId: source.name })
    // its policies left with it: a notice of one that needed attention ends (TOOL-SPACE-018)
    await this.governance?.review(space)
    const tool = await this.ownerView(space, source.name, principal)
    await this.announce(space, { spaceId: space.id, source: source.name, state: tool.state, outcome: 'applied' })
    return tool
  }

  /** `DELETE …/pending` (TOOL-SPACE-009): the change is withdrawn, its flow closed as cancelled, its token destroyed. */
  public async withdraw(principal: Principal, spaceId: string, sourceId: string): Promise<void> {
    const { space, entry } = await this.owned(principal, spaceId, sourceId)
    const record = await this.recordOf(space, entry)
    if (!record.pendingChange) throw new SpaceError('nothing of this source waits for the phone', 'not-found')
    await this.drop(space, record, 'cancelled', true)
  }

  // ---- what the phone decides ---------------------------------------------------------------------------------------

  /** A challenge ended: the change it confirms applies, or is dropped (TOOL-SPACE-008). */
  public async settle(challenge: AuthChallengeRecord): Promise<void> {
    if (challenge.details?.kind !== SPACE_TOOL_CHANGE) return
    const changeId = challenge.details.changeId
    const record = (await this.store.spaceTools.listAll()).find((r) => r.pendingChange?.id === changeId)
    if (!record?.pendingChange) return
    const space = await this.spaces.find(record.spaceId)
    if (!space) return
    if (challenge.outcome === 'completed') return this.apply(space, record)
    const outcome: ChangeOutcome =
      challenge.details.cancelled === true
        ? 'cancelled'
        : challenge.outcome === 'expired'
          ? 'expired'
          : challenge.details.response === false
            ? 'declined'
            : 'failed'
    await this.drop(space, record, outcome, false)
  }

  /** The change the phone confirmed applies at once (TOOL-SPACE-008), and is recorded in the space's activity. */
  private async apply(space: Space, record: SpaceToolRecord): Promise<void> {
    const change = record.pendingChange as PendingToolChange
    const source = this.catalog.source(record.sourceId)
    if (!source) return
    // an account whose values no longer fit its source's fields (the agent-pack changed while it waited) is not set
    if (
      change.kind === 'account' &&
      !(
        change.sealedValues &&
        this.openValues(source.account.fields ?? [], {
          encKeyRef: change.sealedValues.keyRef,
          cipher: change.sealedValues.cipher,
        })
      )
    ) {
      this.logger.warn(
        { spaceId: space.id, source: record.sourceId, changeId: change.id },
        'a confirmed account does not fit the fields of its source: it is not set'
      )
      return this.drop(space, record, 'failed', false)
    }
    const { pendingChange: _applied, removed, ...rest } = record
    const next: SpaceToolRecord = {
      ...rest,
      // an `add: auto` source switched back on is not `off` any more
      ...(change.kind === 'add' || removed === undefined ? {} : { removed }),
      updatedAt: nowIso(),
      updatedBy: change.requestedBy,
    }
    if (change.kind === 'add') {
      next.added = true
      next.bindings = { ...(change.bindings ?? {}) }
      next.calls = { ...(change.calls ?? {}) }
      next.bindingLabels = change.bindingLabels ? { ...change.bindingLabels } : undefined
    } else if (change.kind === 'patch') {
      next.bindings = { ...record.bindings, ...(change.bindings ?? {}) }
      next.calls = { ...record.calls, ...(change.calls ?? {}) }
      if (change.approvals) next.approvals = { ...(record.approvals ?? {}), ...change.approvals }
      // the name of a value the change sets comes with it; a value set otherwise has none
      const changed = new Set(Object.keys(change.bindings ?? {}))
      const labels = {
        ...Object.fromEntries(Object.entries(record.bindingLabels ?? {}).filter(([name]) => !changed.has(name))),
        ...(change.bindingLabels ?? {}),
      }
      next.bindingLabels = Object.keys(labels).length ? labels : undefined
    }
    if (change.kind === 'account' && change.sealedValues) {
      // the former account's key is destroyed with its row: the new values under a key of their own (TOOL-ACCESS-004)
      await this.destroyAccount(space.id, record.sourceId)
      await this.store.spaceAccounts.save({
        spaceId: space.id,
        sourceId: record.sourceId,
        cipher: change.sealedValues.cipher,
        encKeyRef: change.sealedValues.keyRef,
        setAt: nowIso(),
        setByPrincipalId: change.requestedBy,
      })
    }
    await this.store.spaceTools.save(await this.withoutStalePolicies(space, source, next))
    if (change.kind !== 'add') await this.hooks.endAllowances?.(space.id, record.sourceId)
    await this.governance?.review(space)
    await this.spaces.record(
      space.id,
      change.requestedBy,
      change.kind === 'add' ? 'tool-added' : change.kind === 'account' ? 'account-set' : 'tool-changed',
      { sourceId: record.sourceId }
    )
    const state = this.stateOf(source, next, await this.store.spaceAccounts.get(space.id, record.sourceId))
    this.logger.info(
      { spaceId: space.id, source: record.sourceId, changeId: change.id },
      'a change of a space tool applied'
    )
    await this.announce(space, {
      spaceId: space.id,
      source: record.sourceId,
      state,
      changeId: change.id,
      outcome: 'applied',
    })
  }

  /** A change dropped (declined, expired, failed, withdrawn): the account's values it carried are destroyed with it. */
  private async drop(space: Space, record: SpaceToolRecord, outcome: ChangeOutcome, withdraw: boolean): Promise<void> {
    const change = record.pendingChange
    if (!change) return
    const { pendingChange: _dropped, ...next } = record
    await this.store.spaceTools.save(next)
    if (withdraw && change.challengeId) await this.challenges.withdraw(change.challengeId)
    const source = this.catalog.source(record.sourceId)
    const state = source
      ? this.stateOf(source, next, await this.store.spaceAccounts.get(space.id, record.sourceId))
      : 'available'
    this.logger.info(
      { spaceId: space.id, source: record.sourceId, changeId: change.id, outcome },
      'a change of a space tool dropped'
    )
    await this.announce(space, { spaceId: space.id, source: record.sourceId, state, changeId: change.id, outcome })
  }

  private async destroyAccount(spaceId: string, sourceId: string): Promise<void> {
    await this.store.spaceAccounts.delete(spaceId, sourceId)
    await this.hooks.accountEnded?.(spaceId, sourceId)
  }

  private async announce(space: Space, value: SpaceToolsChanged): Promise<void> {
    await this.hooks
      .announce?.(space, value)
      .catch((err) => this.logger.warn({ err, spaceId: space.id }, 'a change of the space tools was not announced'))
  }

  // ---- the life of a space --------------------------------------------------------------------------------------------

  /** A new space: the sources its template adds by itself come with it (TOOL-SPACE-001). */
  public async onCreated(space: Space): Promise<void> {
    for (const entry of this.entriesOf(space)) if (entry.add === 'auto') await this.recordOf(space, entry)
  }

  /** The space passed to another owner: its tools stay, its pending changes are dropped (TOOL-SPACE-011). */
  public async onOwnerChanged(space: Space): Promise<void> {
    for (const record of await this.store.spaceTools.listBySpace(space.id))
      if (record.pendingChange) await this.drop(space, record, 'cancelled', true)
  }

  /**
   * At start (TOOL-SPACE-001/011): the `add: auto` sources of each template reach the spaces created before it named them,
   * and a source the template no longer names leaves its spaces, its account's key destroyed; a change left pending by
   * the previous process expires when its time is over.
   */
  public async align(): Promise<void> {
    for (const record of await this.store.spaceTools.listAll()) {
      const space = await this.spaces.find(record.spaceId)
      const named = space ? this.entriesOf(space).some((e) => e.source === record.sourceId) : false
      if (!named) {
        await this.store.spaceTools.delete(record.spaceId, record.sourceId)
        await this.destroyAccount(record.spaceId, record.sourceId)
        this.logger.info(
          { spaceId: record.spaceId, source: record.sourceId },
          'a source the template no longer names left the space'
        )
      }
    }
    for (const account of await this.store.spaceAccounts.listAll()) {
      const space = await this.spaces.find(account.spaceId)
      if (!space || !this.entriesOf(space).some((e) => e.source === account.sourceId)) {
        await this.destroyAccount(account.spaceId, account.sourceId)
        continue
      }
      // an account whose sealed values do not fit the fields its source declares, such as a single token sealed before
      // the fields (D102) or one set before the agent-pack changed them, is dropped: its owner sets it again
      const source = this.catalog.source(account.sourceId)
      if (source?.account.kind !== 'space' || !this.openValues(source.account.fields ?? [], account)) {
        await this.destroyAccount(account.spaceId, account.sourceId)
        this.logger.warn(
          { spaceId: account.spaceId, source: account.sourceId },
          'a space account that does not fit the fields of its source was dropped: its owner sets it again (D102)'
        )
      }
    }
    for (const space of await this.spaces.all()) await this.onCreated(space)
    await this.expirePending()
  }

  /** Changes whose time is over and that no answer ended: dropped as expired (TOOL-SPACE-008). */
  public async expirePending(): Promise<number> {
    let n = 0
    const now = nowIso()
    for (const record of await this.store.spaceTools.listAll()) {
      if (!record.pendingChange || record.pendingChange.expiresAt > now) continue
      const space = await this.spaces.find(record.spaceId)
      if (!space) continue
      if (record.pendingChange.challengeId) {
        const challenge = await this.store.challenges.get(record.pendingChange.challengeId)
        if (challenge?.outcome === 'pending') {
          await this.challenges.complete(challenge.id, 'expired')
          n++
          continue
        }
      }
      await this.drop(space, record, 'expired', false)
      n++
    }
    return n
  }
}
