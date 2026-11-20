/**
 * Tools in spaces (ayni-spec D97, D98; TOOL-SPACE-001..011, TOOL-ACCESS-003..007; AG-UI profile 3.4 §3.10). A template
 * names the sources of availability `spaces` its spaces may use; in each space a source is `available`, `setup`, `ready`
 * or `off`. Its owner, on the web or on the phone, adds a source, binds it, sets the space's account, tightens or loosens
 * its rules within the agent-pack's, and removes it. A change that grants something waits for the owner's device (a
 * `confirm` flow, attested, whose code is the screen's); a change that only narrows applies at once.
 *
 * The space's account is a token the owner types in the space's settings and nowhere else. It is sealed as it arrives,
 * under a key of its own wrapped by the deployment's master key; it is opened in memory for a call and for nothing else,
 * and clearing it, replacing it or removing its source destroys its key. No answer, event, activity or log carries it.
 */
import { randomInt } from 'node:crypto'
import type { AgentPack, CallRule, SpaceCallRule, TemplateTool } from '../config/packTypes.js'
import { SPACE_CALL_RULES } from '../config/packTypes.js'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import type { Store } from '../store/types.js'
import { type CatalogSource, looser, strictest, type ToolCatalog } from '../tools/catalog.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { CallAccountSecret, ToolSpec } from '../tools/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { type ChallengeService, ConfirmationUnavailable, SPACE_TOOL_CHANGE } from './challenges.js'
import { isPersonalSpace, SpaceError, type SpaceService } from './spaces.js'
import type {
  AuthChallengeRecord,
  PendingToolChange,
  Principal,
  Session,
  Space,
  SpaceAccountRecord,
  SpaceToolRecord,
} from './types.js'

export type SpaceToolState = 'available' | 'setup' | 'ready' | 'off'
export type ChangeOutcome = 'applied' | 'declined' | 'expired' | 'failed' | 'cancelled'

/** The longest token the owner may send (TOOL-SPACE-005). */
export const MAX_TOKEN_LENGTH = 4096

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
    kind: 'none' | 'agent' | 'space'
    label?: string
    pattern?: string
    set?: boolean
    setAt?: string | null
    setBy?: { name: string } | null
  }
  bindings: { name?: string; label: string; value: string | null; setBy?: 'pack' | 'owner'; pattern?: string | null }[]
  tools: {
    name?: string
    title: string
    effect: string | null
    rule: SpaceCallRule
    packRule?: CallRule
    stepUp: string | null
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

  public constructor(
    private readonly store: Store,
    _pack: AgentPack,
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

  /**
   * The space's account of a source, opened in memory for one call (TOOL-ACCESS-005): never logged, never returned to a
   * client, never given to the model.
   */
  public async openAccount(spaceId: string, sourceId: string): Promise<CallAccountSecret | undefined> {
    const source = this.catalog.source(sourceId)
    if (source?.account.kind !== 'space') return undefined
    const record = await this.store.spaceAccounts.get(spaceId, sourceId)
    if (!record) return { kind: 'space', spaceId }
    const { token } = openJson<{ token: string }>(this.crypto, record.encKeyRef, Buffer.from(record.cipher, 'base64'))
    return {
      kind: 'space',
      spaceId,
      token,
      header: source.account.apply?.header,
      prefix: source.account.apply?.prefix,
    }
  }

  // ---- what the settings show (PROF-TOOL-001) ---------------------------------------------------------------------

  /** The tools a source offers, with what the pack and its server say of them. */
  private async toolsOf(source: CatalogSource, spaceId?: string): Promise<{ name: string; spec?: ToolSpec }[]> {
    let specs = (await this.registry.all()).filter((s) => s.source === source.name)
    if (!specs.length && source.kind === 'mcp' && source.account.kind === 'space' && spaceId) {
      const account = await this.openAccount(spaceId, source.name)
      if (account?.token) {
        await this.registry.discover(source.name, account)
        specs = (await this.registry.all()).filter((s) => s.source === source.name)
      }
    }
    if (specs.length) return specs.map((spec) => ({ name: spec.rawName, spec }))
    return (source.offer ?? Object.keys(source.tools)).map((name) => ({ name }))
  }

  private async view(space: Space, entry: TemplateTool, owner: boolean): Promise<SpaceToolView | undefined> {
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
      tools.push({
        ...(owner ? { name } : {}),
        title: this.catalog.toolTitle(source, name, spec?.annotations),
        effect: this.catalog.effectOf(source, name, spec?.annotations) ?? null,
        rule,
        ...(owner ? { packRule } : {}),
        stepUp: this.catalog.stepUpTypeOf(source, name),
      })
    }
    const values = this.bindingValues(source, record)
    const bindings = source.bindings.map((b) =>
      owner
        ? {
            name: b.name,
            label: b.label,
            value: values[b.name] ?? null,
            setBy: b.value !== undefined ? ('pack' as const) : ('owner' as const),
            pattern: b.pattern ?? null,
          }
        : { label: b.label, value: values[b.name] ?? null }
    )
    const accountView: SpaceToolView['account'] = { kind: source.account.kind }
    if (owner && source.account.kind === 'space') {
      accountView.label = source.account.label
      if (source.account.pattern) accountView.pattern = source.account.pattern
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
      const view = await this.view(access.space, entry, owner)
      if (view) out.push(view)
    }
    return out
  }

  /** One source of a space, as its owner reads it. */
  public async ownerView(space: Space, sourceId: string): Promise<SpaceToolView> {
    const { entry } = this.entryOf(space, sourceId)
    return (await this.view(space, entry, true)) as SpaceToolView
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

  /** The owner's bindings, checked (TOOL-SPACE-004): a declared binding, left to the owner, matching its pattern. */
  private checkBindings(source: CatalogSource, bindings: unknown): Record<string, string> {
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

  /** The words of a change: the space, the source and every value but the token (TOOL-SPACE-008). */
  private async summaryOf(
    head: string,
    space: Space,
    source: CatalogSource,
    change: { bindings?: Record<string, string>; calls?: Record<string, SpaceCallRule> }
  ): Promise<string> {
    const parts: string[] = []
    for (const [name, value] of Object.entries(change.bindings ?? {}))
      parts.push(`${source.bindings.find((b) => b.name === name)?.label ?? name}: ${value}`)
    const tools = await this.toolsOf(source, space.id)
    for (const [name, rule] of Object.entries(change.calls ?? {}))
      parts.push(
        `${this.catalog.toolTitle(source, name, tools.find((t) => t.name === name)?.spec?.annotations)}: ${RULE_WORDS[rule]}`
      )
    void space
    return parts.length ? `${head}: ${parts.join('; ')}` : head
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
    const bindings = this.checkBindings(source, body.bindings)
    const calls = await this.checkCalls(space, source, body.calls)
    const summary = await this.summaryOf(`Add ${source.title} to ${space.title}`, space, source, { bindings, calls })
    await this.hold(principal, session, space, record, { kind: 'add', bindings, calls, summary })
    return this.ownerView(space, source.name)
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
    body: { bindings?: unknown; calls?: unknown }
  ): Promise<{ status: 200 | 202; tool: SpaceToolView }> {
    const { space, entry, source } = await this.owned(principal, spaceId, sourceId)
    const record = await this.recordOf(space, entry)
    if (!record.added) throw new SpaceError('add the source to the space first', 'not-added')
    const bindings = this.checkBindings(source, body.bindings)
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
    if (!Object.keys(changedBindings).length && !Object.keys(changedCalls).length)
      return { status: 200, tool: await this.ownerView(space, source.name) }
    if (grants) {
      // one granting change at a time; one that only narrows applies whatever waits (TOOL-SPACE-009)
      if (record.pendingChange) throw new SpaceError('a change of this source waits for the phone', 'change-pending')
      const summary = await this.summaryOf(`Change ${source.title} in ${space.title}`, space, source, {
        bindings: changedBindings,
        calls: changedCalls,
      })
      await this.hold(principal, session, space, record, {
        kind: 'patch',
        bindings: changedBindings,
        calls: changedCalls,
        summary,
      })
      return { status: 202, tool: await this.ownerView(space, source.name) }
    }
    // only stricter: at once, with no challenge, a change that waits for the phone kept as it is (TOOL-SPACE-008)
    const current = (await this.store.spaceTools.get(space.id, source.name)) ?? record
    await this.store.spaceTools.save({
      ...current,
      calls: { ...current.calls, ...changedCalls },
      updatedAt: nowIso(),
      updatedBy: principal.id,
    })
    await this.hooks.endAllowances?.(space.id, source.name)
    await this.spaces.record(space.id, principal.id, 'tool-changed', { sourceId: source.name })
    const tool = await this.ownerView(space, source.name)
    await this.announce(space, { spaceId: space.id, source: source.name, state: tool.state, outcome: 'applied' })
    return { status: 200, tool }
  }

  /**
   * `PUT {sessions}/spaces/{id}/tools/{source}/account` (TOOL-SPACE-005): the token is checked, sealed as it arrives, and
   * used only once the phone confirms; a refused token is kept nowhere.
   */
  public async setAccount(
    principal: Principal,
    session: Session,
    spaceId: string,
    sourceId: string,
    token: unknown
  ): Promise<SpaceToolView> {
    const { space, entry, source } = await this.owned(principal, spaceId, sourceId)
    if (source.account.kind !== 'space')
      throw new SpaceError('the calls of this source do not run with an account of the space', 'no-space-account')
    const record = await this.recordOf(space, entry)
    if (!record.added) throw new SpaceError('add the source to the space first', 'not-added')
    if (record.pendingChange) throw new SpaceError('a change of this source waits for the phone', 'change-pending')
    const pattern = source.account.pattern
    if (
      typeof token !== 'string' ||
      !token ||
      token.length > MAX_TOKEN_LENGTH ||
      (pattern !== undefined && !new RegExp(pattern).test(token))
    )
      throw new SpaceError(`the ${source.account.label ?? 'token'} is not one this source takes`, 'bad-token')
    const keyRef = this.crypto.newWrappedKey()
    const { cipher } = sealJson(this.crypto, keyRef, { token })
    const set = !!(await this.store.spaceAccounts.get(space.id, source.name))
    const head = `${set ? 'Replace' : 'Set'} the account of ${source.title} in ${space.title}`
    await this.hold(principal, session, space, record, {
      kind: 'account',
      sealedToken: { keyRef, cipher: cipher.toString('base64') },
      summary: head,
    })
    return this.ownerView(space, source.name)
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
    const tool = await this.ownerView(space, source.name)
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
    const tool = await this.ownerView(space, source.name)
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
    } else if (change.kind === 'patch') {
      next.bindings = { ...record.bindings, ...(change.bindings ?? {}) }
      next.calls = { ...record.calls, ...(change.calls ?? {}) }
    }
    if (change.kind === 'account' && change.sealedToken) {
      // the former account's key is destroyed with its row: the new token under a key of its own (TOOL-ACCESS-004)
      await this.destroyAccount(space.id, record.sourceId)
      await this.store.spaceAccounts.save({
        spaceId: space.id,
        sourceId: record.sourceId,
        cipher: change.sealedToken.cipher,
        encKeyRef: change.sealedToken.keyRef,
        setAt: nowIso(),
        setByPrincipalId: change.requestedBy,
      })
    }
    await this.store.spaceTools.save(next)
    if (change.kind !== 'add') await this.hooks.endAllowances?.(space.id, record.sourceId)
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

  /** A change dropped (declined, expired, failed, withdrawn): the token it carried is destroyed with it. */
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
      if (!space || !this.entriesOf(space).some((e) => e.source === account.sourceId))
        await this.destroyAccount(account.spaceId, account.sourceId)
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
