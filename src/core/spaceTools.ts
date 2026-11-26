/**
 * Tools in spaces, by feature (ayni-spec D97, D98, D120 to D123; TOOL-SPACE-001..021, TOOL-FEAT-006..009, TOOL-FEAT-014;
 * AG-UI profile §3.10). A template names the features its spaces may use, each with the providers it allows; in each space
 * a feature is `available`, `setup`, `ready` or `off`, with at most one provider, the one its owner chose. The owner, on
 * the web or on the phone, chooses the provider, binds it, picks the locations of a feature with a contract, sets the
 * space's account, tightens or loosens the rules within the agent-pack's, changes the provider, and removes it. A change
 * that grants something waits for the owner's device (a `confirm` flow, attested, whose code is the screen's); a change
 * that only narrows applies at once.
 *
 * The record of a feature in a space is kept by its provider's source: one record per (space, source), at most one of a
 * feature's providers added at a time. A change of provider waits on the record of the provider in use and, once
 * confirmed, replaces it in one step: nothing is copied from one provider to the other, nothing deleted at either.
 *
 * The space's account is what the owner types in the space's settings and nowhere else: one value for each field its
 * source declares (D102). The values are trimmed and checked, then sealed together as they arrive, as one record under a
 * key of its own wrapped by the deployment's master key; they are opened in memory for a call and for nothing else, the
 * headers of `account.apply` built from them then, and clearing the account, replacing it or removing its source destroys
 * its key. No answer, event, activity or log carries a value of it.
 */
import { randomInt } from 'node:crypto'
import type { AccountField, AgentPack, CallRule, SpaceCallRule, TemplateFeature } from '../config/packTypes.js'
import { defaultProviderOf, SPACE_CALL_RULES } from '../config/packTypes.js'
import { type FolderView, ManagedFolders } from '../features/managedFolders.js'
import { CODE_ONLY_CAPABILITIES, type FeatureProfile, FILES_1_0, toolsInUse } from '../features/profiles.js'
import { FeatureService, type ProviderState } from '../features/service.js'
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
import { type CatalogFeature, type CatalogSource, looser, strictest, type ToolCatalog } from '../tools/catalog.js'
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
  SpaceToolList,
  SpaceToolRecord,
} from './types.js'

export type SpaceToolState = 'available' | 'setup' | 'ready' | 'off'
export type ChangeOutcome = 'applied' | 'declined' | 'expired' | 'failed' | 'cancelled'

/** The longest value of a field of an account the owner may send, once trimmed (TOOL-SPACE-005). */
export const MAX_VALUE_LENGTH = 4096

/** The most entries a list holds (TOOL-SPACE-014). */
export const MAX_LIST_ENTRIES = 10

/** The most choices of a location the owner's search answers (TOOL-SPACE-015). */
export const MAX_CHOICES = 50

/** How long the choices the owner was given stand for a `PATCH` that picks one (TOOL-FEAT-014). */
const CHOICES_SECONDS = 30 * 60

/** What a value of an account may not hold inside it, once trimmed: whitespace or a control character (TOOL-SPACE-005). */
const INNER_WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u

/** The values an owner sends for the fields of an account, before they are sealed (D102). */
type AccountValues = Record<string, string>

/** `ayni.space.tools.changed` (PROF-TOOL-006). */
export interface SpaceToolsChanged {
  spaceId: string
  /** the feature the change concerns (PROF-TOOL-006) */
  feature: string
  source: string
  state: SpaceToolState
  changeId?: string
  outcome: ChangeOutcome
  /** a change of provider: the provider it replaced (PROF-TOOL-034) */
  formerSource?: string
}

/** The location list of a feature with a contract, as the owner or a member reads it (PROF-TOOL-022, PROF-TOOL-033). */
export interface SpaceToolListView {
  label: string
  any: boolean
  entries?: { values?: Record<string, string>; label: string }[]
  anyAllowed?: boolean
  anyLabel?: string
  choices?: boolean
  typed?: false
  maxEntries?: number
}

/** What the owner, or a member, reads of a feature in a space (PROF-TOOL-001, PROF-TOOL-033). */
export interface SpaceToolView {
  feature: { id: string; title: string; profile: { id: string; version: string } | null }
  /** the owner's: the providers the template allows for the feature, in its order */
  providers?: {
    source: string
    title: string
    description?: string
    account: { kind: 'none' | 'agent' | 'space' | 'personal' }
    default: boolean
    /** Files: the modes this provider is offered in (PROF-TOOL-040) */
    locations?: ('managed' | 'existing')[]
  }[]
  /** the provider in use: null while none is chosen */
  source: string | null
  title: string | null
  description?: string | null
  state: SpaceToolState
  add?: 'auto' | 'owner'
  guests: boolean
  /** a feature with a contract: whether its provider offered the profile at its last connection, absent before one */
  conformant?: boolean
  /** a feature with a contract: the optional capabilities of its profile in use */
  capabilities?: string[]
  account?: {
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
  bindings?: {
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
  /** a feature with a contract: its location (TOOL-FEAT-014) */
  list?: SpaceToolListView
  /** Files, to the owner: the modes the template allows for the provider (PROF-TOOL-040) */
  locations?: ('managed' | 'existing')[]
  /** Files, to the owner: the mode in use (PROF-TOOL-040) */
  location?: 'managed' | 'existing'
  /** Files in the managed mode: the folder the agent made and keeps (PROF-TOOL-041) */
  folder?: FolderView
  tools?: {
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

/** A provider ready in a space, as a turn takes it (TOOL-SPACE-001, RBAC-FILTER-004). */
export interface ReadySource {
  source: CatalogSource
  entry: TemplateFeature
  record: SpaceToolRecord
  /** the values of its bindings, the pack's and the owner's */
  bindings: Record<string, string>
  /** when its account was set, for the fingerprint of an allowance (TOOL-CALL-006) */
  accountSetAt?: string
}

export interface SpaceToolsHooks {
  /** a change applied or was dropped: every bound session of the space's owners hears it (TOOL-SPACE-010) */
  announce?: (space: Space, value: SpaceToolsChanged) => Promise<void>
  /** a member's access to the managed folder changed: that member's sessions hear it too (PROF-TOOL-041) */
  announceTo?: (principalId: string, value: SpaceToolsChanged) => Promise<void>
  /** the account of a source ended or changed: its connection closes (TOOL-ACCESS-007) */
  accountEnded?: (spaceId: string, sourceId: string) => Promise<void>
  /** the rules, bindings or account of a source changed: the allowances of its tools end (TOOL-CALL-006) */
  endAllowances?: (spaceId: string, sourceId: string) => Promise<void>
  /** a person's name, as the settings show who set the account */
  nameOf?: (principalId: string) => Promise<string>
}

/** A feature of a space: its template's entry, the provider in use and the records of its providers (TOOL-SPACE-001). */
interface FeatureSlot {
  entry: TemplateFeature
  feature: CatalogFeature
  /** the provider in use, and its record */
  inUse?: { source: CatalogSource; record: SpaceToolRecord }
  /** the choice of a first provider that waits for the owner's phone */
  pendingAdd?: { source: CatalogSource; record: SpaceToolRecord }
  /** an `add: auto` feature whose provider its owner removed */
  off: boolean
  /** every record of the feature's providers in the space */
  records: SpaceToolRecord[]
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

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Whether every entry of a list is one of another's: a list that only narrows (TOOL-SPACE-014). */
function narrowsList(next: SpaceToolList | undefined, inForce: SpaceToolList | undefined): boolean {
  if (next?.any) return !!inForce?.any
  if (inForce?.any) return true
  const held = new Set((inForce?.entries ?? []).map((e) => JSON.stringify(e.values)))
  return (next?.entries ?? []).every((e) => held.has(JSON.stringify(e.values)))
}

function sameList(a: SpaceToolList | undefined, b: SpaceToolList | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

export class SpaceToolService {
  public hooks: SpaceToolsHooks = {}
  /** each person's own accounts (D104): whether a reader's is connected, the owner's choices of a binding (D110) */
  public connections?: ConnectionService
  /** the approval policies of the tools (D137): whom they name, their checks, warnings and attention */
  public governance?: Governance
  /** the features with a contract: their providers' declarations and marks (D121 to D123) */
  public features?: FeatureService
  /** a team space's folders the agent makes and keeps (D145 to D150) */
  public folders?: ManagedFolders
  /** the locations the owner was last given, by space and source, for the `PATCH` that picks one (TOOL-FEAT-014) */
  private readonly choicesRead = new Map<
    string,
    Map<string, { label: string; portable: boolean; text: string; at: number }>
  >()

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

  /** The agent's name, as the phone's text of a change of provider names it (TOOL-FEAT-007). */
  private get agentName(): string {
    return this.pack.metadata.displayName
  }

  // ---- the template, the features, the state ------------------------------------------------------------------------

  /** The features a space's template names, in its order (TOOL-AVAIL-002): none for Personal. */
  public entriesOf(space: Pick<Space, 'id' | 'templateId'>): TemplateFeature[] {
    if (isPersonalSpace(space.id)) return []
    return this.catalog.templateFeatures(space.templateId)
  }

  /** The entry of the template that allows a source as a provider of its feature. */
  public entryOfSource(space: Pick<Space, 'id' | 'templateId'>, sourceId: string): TemplateFeature | undefined {
    return this.entriesOf(space).find((e) => e.providers.includes(sourceId))
  }

  /**
   * A feature of a space: the provider in use, a first choice that waits, or nothing (TOOL-SPACE-001). An `add: auto`
   * feature with no record has its default provider from the space's creation.
   */
  private async slotOf(space: Space, entry: TemplateFeature): Promise<FeatureSlot | undefined> {
    const feature = this.catalog.feature(entry.feature)
    if (!feature) return undefined
    const records = (await this.store.spaceTools.listBySpace(space.id)).filter((r) =>
      entry.providers.includes(r.sourceId)
    )
    const sourceOf = (record: SpaceToolRecord) => this.catalog.source(record.sourceId)
    if (!records.length && entry.add === 'auto') {
      const provider = defaultProviderOf(entry)
      if (provider && this.catalog.source(provider)) {
        const record: SpaceToolRecord = {
          spaceId: space.id,
          sourceId: provider,
          added: true,
          bindings: {},
          calls: {},
          updatedAt: nowIso(),
        }
        await this.store.spaceTools.save(record)
        records.push(record)
      }
    }
    const added = records.find((r) => r.added && sourceOf(r))
    const waiting = added ? undefined : records.find((r) => !r.added && r.pendingChange && sourceOf(r))
    return {
      entry,
      feature,
      ...(added ? { inUse: { source: sourceOf(added) as CatalogSource, record: added } } : {}),
      ...(waiting ? { pendingAdd: { source: sourceOf(waiting) as CatalogSource, record: waiting } } : {}),
      off: !added && records.some((r) => r.removed),
      records,
    }
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

  /**
   * `available`, `setup`, `ready` or `off` (TOOL-SPACE-001): a provider added is `setup` while a binding has no value, the
   * location list of a feature with a contract no entry and no any value (TOOL-FEAT-014), or its space account is not set.
   */
  public stateOf(
    source: CatalogSource,
    record: SpaceToolRecord,
    account: SpaceAccountRecord | undefined
  ): SpaceToolState {
    if (!record.added) return record.removed ? 'off' : 'available'
    const values = this.bindingValues(source, record)
    const unbound = source.bindings.some((b) => values[b.name] === undefined)
    const noAccount = source.account.kind === 'space' && !account
    const noLocation = !!this.catalog.profileOf(source) && !record.list?.any && !record.list?.entries?.length
    return unbound || noAccount || noLocation ? 'setup' : 'ready'
  }

  /** The providers ready in a space, for a turn (TOOL-SPACE-001, RBAC-FILTER-004): one at most per feature. */
  public async readyIn(space: Space): Promise<ReadySource[]> {
    const out: ReadySource[] = []
    for (const entry of this.entriesOf(space)) {
      const slot = await this.slotOf(space, entry)
      if (!slot?.inUse) continue
      const { source, record } = slot.inUse
      const account = await this.store.spaceAccounts.get(space.id, source.name)
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

  /** The provider in use of a feature in a space, ready or not: none while none is chosen (TOOL-FEAT-006, TOOL-FEAT-009). */
  public async providerOf(space: Space, featureId: string): Promise<CatalogSource | undefined> {
    const entry = this.entriesOf(space).find((e) => e.feature === featureId)
    return entry ? (await this.slotOf(space, entry))?.inUse?.source : undefined
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

  /**
   * The account the owner's own calls of a source would use in a space (TOOL-SPACE-015): the owner's own for a personal
   * source, the space's for a space one, the agent's otherwise; refused while the one it needs is missing.
   */
  private async ownersAccount(owner: Principal, space: Space, source: CatalogSource): Promise<CallAccountSecret> {
    if (source.account.kind === 'personal') {
      const opened = await this.connections?.open(owner, source, space.id, false)
      if (opened?.status !== 'connected')
        throw new SpaceError(`connect your own account of ${source.title} first`, 'not-connected')
      return opened.account
    }
    if (source.account.kind === 'space') {
      const account = await this.openAccount(space.id, source.name)
      if (!account?.headers) throw new SpaceError(`set the account of ${source.title} first`, 'space-account-not-set')
      return account
    }
    return { kind: source.account.kind }
  }

  // ---- the provider of a feature with a contract: its declaration (TOOL-FEAT-011) ---------------------------------

  /**
   * What a provider declares with the account a reader's calls use in the space, read when that account is there; what is
   * known otherwise (the core and the source's `capabilities`, before any connection).
   */
  private async providerState(source: CatalogSource, space: Space, reader?: Principal): Promise<ProviderState> {
    const features = this.features
    if (!features) return { capabilities: [], extras: [] }
    let account: CallAccountSecret | undefined
    if (source.account.kind === 'space') {
      const opened = await this.openAccount(space.id, source.name)
      if (opened?.headers) account = opened
    } else if (source.account.kind === 'personal') {
      const opened = reader ? await this.connections?.open(reader, source, space.id, false) : undefined
      if (opened?.status === 'connected') account = opened.account
    } else account = { kind: source.account.kind }
    if (!account) return features.known(source, FeatureService.keyOf({ kind: source.account.kind, spaceId: space.id }))
    return features.declared(source, account, FeatureService.keyOf(account))
  }

  // ---- what the settings show (PROF-TOOL-001, PROF-TOOL-033) --------------------------------------------------------

  /**
   * The tools a source offers, with what the pack and its server say of them; with `discover` false, from what the
   * registry knows and the agent-pack only, with no connection. A provider of a feature with a contract offers its
   * profile's tools, of the capabilities in use, then its offered extras (TOOL-FEAT-010, TOOL-FEAT-011).
   */
  private async toolsOf(
    source: CatalogSource,
    space?: Space,
    discover = true,
    reader?: Principal
  ): Promise<{ name: string; spec?: Pick<ToolSpec, 'annotations'> }[]> {
    const profile = this.catalog.profileOf(source)
    if (profile) {
      const state =
        discover && space
          ? await this.providerState(source, space, reader)
          : (this.features?.known(source, FeatureService.keyOf({ kind: source.account.kind, spaceId: space?.id })) ?? {
              capabilities: [],
              extras: [],
            })
      if (state.conformant === false) return []
      const capabilities = state.capabilities.filter((c) => !CODE_ONLY_CAPABILITIES.includes(c))
      return [
        ...toolsInUse(profile, capabilities).map((t) => ({ name: t.name })),
        ...state.extras.map((e) => ({ name: e.name, spec: e.annotations ? { annotations: e.annotations } : {} })),
      ]
    }
    let specs = (await this.registry.all()).filter((s) => s.source === source.name)
    if (discover && !specs.length && source.kind === 'mcp' && source.account.kind === 'space' && space) {
      const account = await this.openAccount(space.id, source.name)
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
    return record.approvals?.[tool] ?? defaultPolicyOf(this.pack, this.catalog.declOf(source, tool)?.approval)
  }

  /** The agent-pack's bounds of a tool's policy (TOOL-CAT-023), on its feature for a tool of a profile (TOOL-FEAT-005). */
  public boundsFor(source: CatalogSource, tool: string): PolicyBounds {
    return boundsOf(this.pack, this.catalog.declOf(source, tool)?.approval)
  }

  /** The policies in force of a space's tools whose rule is `approval`, of every provider in use in it; no connection made. */
  public async policiesOf(space: Space): Promise<PolicyInForce[]> {
    const out: PolicyInForce[] = []
    for (const entry of this.entriesOf(space)) {
      const slot = await this.slotOf(space, entry)
      if (!slot?.inUse) continue
      const { source, record } = slot.inUse
      for (const { name, spec } of await this.toolsOf(source, space, false)) {
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

  /** The location list of a provider of a feature with a contract, as the owner or a member reads it (PROF-TOOL-033). */
  private listView(profile: FeatureProfile, entry: TemplateFeature, record: SpaceToolRecord, owner: boolean) {
    const list = record.list
    const any = list?.any === true
    if (!owner)
      return {
        label: profile.location.labels.list,
        any,
        ...(any
          ? { anyLabel: profile.location.labels.any }
          : { entries: (list?.entries ?? []).map((e) => ({ label: e.label })) }),
      }
    // the managed folder is the one entry, which the owner does not change (TOOL-FEAT-024)
    const managed = record.location === 'managed'
    return {
      label: profile.location.labels.list,
      any,
      ...(any ? {} : { entries: (list?.entries ?? []).map((e) => ({ values: { ...e.values }, label: e.label })) }),
      anyAllowed: !managed && entry.any === true,
      anyLabel: profile.location.labels.any,
      choices: !managed,
      typed: false as const,
      maxEntries: managed ? 1 : MAX_LIST_ENTRIES,
    }
  }

  private async view(
    space: Space,
    entry: TemplateFeature,
    owner: boolean,
    reader?: Principal,
    /** the warnings of the policies a request sent, for the answer of that request (TOOL-SPACE-020) */
    warningsFor?: Record<string, PolicyWarning[]>
  ): Promise<SpaceToolView | undefined> {
    const slot = await this.slotOf(space, entry)
    if (!slot) return undefined
    const { feature } = slot
    const profile = feature.profile
    const inUse = slot.inUse
    const account = inUse ? await this.store.spaceAccounts.get(space.id, inUse.source.name) : undefined
    const state: SpaceToolState = inUse
      ? this.stateOf(inUse.source, inUse.record, account)
      : slot.off
        ? 'off'
        : 'available'
    if (!owner && state !== 'ready') return undefined
    const head: SpaceToolView = {
      feature: {
        id: feature.id,
        title: feature.title,
        profile: profile ? { id: profile.id, version: profile.version } : null,
      },
      ...(owner
        ? {
            providers: entry.providers.flatMap((id) => {
              const source = this.catalog.source(id)
              if (!source) return []
              return [
                {
                  source: source.name,
                  title: source.title,
                  ...(source.description ? { description: source.description } : {}),
                  account: { kind: source.account.kind },
                  default: defaultProviderOf(entry) === source.name,
                },
              ]
            }),
          }
        : {}),
      source: inUse?.source.name ?? null,
      title: inUse?.source.title ?? null,
      ...(inUse ? { description: inUse.source.description ?? null } : {}),
      state,
      ...(owner ? { add: entry.add ?? 'owner' } : {}),
      guests: entry.guests === true,
    }
    const pendingOf = (record: SpaceToolRecord | undefined) => {
      const pending = record?.pendingChange
      return pending
        ? { changeId: pending.id, summary: pending.summary, code: pending.code, expiresAt: pending.expiresAt }
        : null
    }
    // Files: the modes each provider allows, to the owner, and those of the provider in use, or of the default while none
    // is chosen, on the item (PROF-TOOL-040)
    if (owner && profile?.id === FILES_1_0.id && this.folders && head.providers) {
      for (const provider of head.providers) {
        const source = this.catalog.source(provider.source)
        const locations = source ? await this.folders.locationsOf(space, entry, source) : undefined
        if (locations) provider.locations = locations
      }
      const shown = head.providers.find((p) => p.source === (inUse?.source.name ?? defaultProviderOf(entry)))
      if (shown?.locations) head.locations = shown.locations
    }
    // an item with no provider carries no account, bindings, list or tools, and a pending only while the choice of its
    // provider waits (PROF-TOOL-033)
    if (!inUse) return owner ? { ...head, pending: pendingOf(slot.pendingAdd?.record) } : head
    const { source, record } = inUse
    if (owner && record.location) head.location = record.location
    const folder = record.location === 'managed' ? await this.folders?.folderOf(space.id, entry.feature) : undefined
    if (folder && this.folders) head.folder = await this.folders.view(space, folder, owner, reader?.id)
    const providerState = profile ? await this.providerState(source, space, reader) : undefined
    const tools = []
    for (const { name, spec } of await this.toolsOf(source, space, true, reader)) {
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
    const accountView: NonNullable<SpaceToolView['account']> = { kind: source.account.kind }
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
    return {
      ...head,
      ...(providerState?.conformant !== undefined ? { conformant: providerState.conformant } : {}),
      ...(profile ? { capabilities: providerState?.capabilities ?? [] } : {}),
      account: accountView,
      bindings,
      ...(profile ? { list: this.listView(profile, entry, record, owner) } : {}),
      tools,
      ...(owner ? { pending: pendingOf(record) } : {}),
    }
  }

  /**
   * `GET {sessions}/spaces/{id}/tools` (TOOL-SPACE-002, PROF-TOOL-033): one item per feature, to the owner every feature
   * of the template, to another active member the `ready` ones; Personal has none; anyone else gets 404.
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

  /** The feature a provider serves in a space, as its owner reads it. */
  public async ownerView(
    space: Space,
    sourceId: string,
    reader?: Principal,
    warningsFor?: Record<string, PolicyWarning[]>
  ): Promise<SpaceToolView> {
    const entry = this.entryOfSource(space, sourceId)
    if (!entry) throw new SpaceError('this source is no provider of a feature of the space template', 'not-found')
    return (await this.view(space, entry, true, reader, warningsFor)) as SpaceToolView
  }

  // ---- what the owner changes -------------------------------------------------------------------------------------

  /**
   * The owner of a space, and the feature of the source its template names; Personal's tools change never (`409
   * personal-space`); a source the template names as a provider of no feature is not found (`404`).
   */
  private async owned(
    principal: Principal,
    spaceId: string,
    sourceId: string
  ): Promise<{ space: Space; slot: FeatureSlot; source: CatalogSource }> {
    const access = await this.spaces.owned(principal, spaceId)
    const entry = this.entryOfSource(access.space, sourceId)
    const source = entry ? this.catalog.source(sourceId) : undefined
    const slot = entry && source ? await this.slotOf(access.space, entry) : undefined
    if (!entry || !source || !slot) throw new SpaceError('this source is not one of the space template', 'not-found')
    return { space: access.space, slot, source }
  }

  /**
   * The provider a request about a source of a feature names, when it is the one in use (TOOL-FEAT-006): `409 not-added`
   * while the feature has none, `409 provider-not-used` for another provider the template allows.
   */
  private inUse(slot: FeatureSlot, source: CatalogSource): { source: CatalogSource; record: SpaceToolRecord } {
    if (!slot.inUse) throw new SpaceError('add the source to the space first', 'not-added')
    if (slot.inUse.source.name !== source.name)
      throw new SpaceError(
        `${slot.feature.title} uses ${slot.inUse.source.title} in this space, not ${source.title}`,
        'provider-not-used'
      )
    return slot.inUse
  }

  /** Whether a change of the feature waits for the phone, whichever provider it concerns (TOOL-SPACE-009, TOOL-FEAT-007). */
  private pendingOf(slot: FeatureSlot): SpaceToolRecord | undefined {
    return slot.records.find((r) => r.pendingChange)
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
    calls: unknown,
    reader?: Principal
  ): Promise<Record<string, SpaceCallRule>> {
    if (calls === undefined || calls === null) return {}
    if (typeof calls !== 'object' || Array.isArray(calls))
      throw new SpaceError('calls is an object of rules', 'bad-request', 'calls')
    const tools = await this.toolsOf(source, space, true, reader)
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

  /**
   * The location list the owner sends for a provider of a feature with a contract (TOOL-SPACE-014, TOOL-FEAT-014): any value
   * where the template allows it, or at most ten entries, each one location the provider answered for the account the
   * owner's own calls use, read again now and kept with the title read, and portable for a provider of each person's own
   * account in a team space. Undefined when the request sends none.
   */
  private async checkList(
    principal: Principal,
    space: Space,
    entry: TemplateFeature,
    source: CatalogSource,
    list: unknown,
    inForce: SpaceToolList | undefined
  ): Promise<SpaceToolList | undefined> {
    if (list === undefined || list === null) return undefined
    const profile = this.catalog.profileOf(source)
    if (!profile)
      throw new SpaceError(`${source.title} declares no list: its bindings take one value each`, 'bad-request', 'list')
    if (!isObject(list)) throw new SpaceError('list is { entries } or { any: true }', 'bad-request', 'list')
    if (list.any !== undefined) {
      if (list.any !== true || list.entries !== undefined)
        throw new SpaceError('list is { entries } or { any: true }', 'bad-request', 'list.any')
      if (!entry.any)
        throw new SpaceError(
          `the template does not allow ${profile.location.labels.any}`,
          'any-not-allowed',
          'list.any'
        )
      return { any: true }
    }
    if (!Array.isArray(list.entries)) throw new SpaceError('list.entries is a list', 'bad-request', 'list.entries')
    if (list.entries.length > MAX_LIST_ENTRIES)
      throw new SpaceError(`a list holds at most ${MAX_LIST_ENTRIES} entries`, 'too-many-entries', 'list.entries')
    const argument = profile.location.argument
    const held = new Map((inForce?.entries ?? []).map((e) => [e.values[argument], e.label]))
    const read = this.choicesRead.get(`${space.id}|${source.name}`)
    const out: { values: Record<string, string>; label: string }[] = []
    const seen = new Set<string>()
    const fresh = new Map<string, { label: string; portable: boolean }>()
    for (const [i, raw] of list.entries.entries()) {
      const at = `list.entries.${i}`
      if (!isObject(raw) || Object.keys(raw).some((k) => k !== argument) || !(argument in raw))
        throw new SpaceError(
          `an entry names one ${profile.location.labels.one.toLowerCase()}, as ${argument}`,
          'bad-binding',
          at
        )
      const value = typeof raw[argument] === 'string' ? (raw[argument] as string).trim() : ''
      if (!value)
        throw new SpaceError(`${profile.location.labels.one} is a reference`, 'bad-binding', `${at}.${argument}`)
      if (seen.has(value)) throw new SpaceError('this entry is already in the list', 'repeated-entry', at)
      seen.add(value)
      const label = held.get(value)
      if (label !== undefined) {
        out.push({ values: { [argument]: value }, label })
        continue
      }
      // a location the provider listed to the owner: read again now with the owner's account, never a value the code cannot
      // read (TOOL-FEAT-014, PROF-TOOL-023)
      const choice = read?.get(value)
      if (!choice || Date.now() - choice.at > CHOICES_SECONDS * 1000)
        throw new SpaceError(
          `pick the ${profile.location.labels.one.toLowerCase()} from those ${source.title} lists`,
          'bad-binding',
          `${at}.${argument}`
        )
      if (!fresh.has(value)) {
        const again = await this.readChoices(principal, space, source, profile, choice.text)
        for (const c of again) fresh.set(c.value, { label: c.label, portable: c.portable })
      }
      const now = fresh.get(value)
      if (!now)
        throw new SpaceError(
          `${source.title} no longer lists this ${profile.location.labels.one.toLowerCase()}`,
          'bad-binding',
          `${at}.${argument}`
        )
      // a location that names the same place for every account, for a provider of each person's own (TOOL-FEAT-014)
      if (source.account.kind === 'personal' && !now.portable)
        throw new SpaceError(
          `this ${profile.location.labels.one.toLowerCase()} does not name the same place for every member's account`,
          'not-portable',
          at
        )
      out.push({ values: { [argument]: value }, label: now.label })
    }
    return { entries: out }
  }

  /** The rule in force for a tool in a space: the owner's, never looser than the pack's (TOOL-CALL-002). */
  private async ruleInForce(space: Space, source: CatalogSource, record: SpaceToolRecord, tool: string) {
    const spec = (await this.toolsOf(source, space, false)).find((t) => t.name === tool)?.spec
    const packRule = this.catalog.packRuleOf(source, tool, spec?.annotations).rule
    const owner = record.calls[tool]
    return owner ? strictest<SpaceCallRule>(packRule, owner) : packRule
  }

  /** "Folders: /Projects/Alpha, /Projects/Beta", or the label of any value (TOOL-SPACE-014). */
  private listWords(source: CatalogSource, list: SpaceToolList | undefined): string | undefined {
    const profile = this.catalog.profileOf(source)
    if (!profile || !list) return undefined
    if (list.any)
      return `${profile.location.labels.any}. Each member's calls use their own account, but what ${this.agentName} reads with it goes into this space's conversations, which the other members read once they are shared.`
    if (!list.entries?.length) return `${profile.location.labels.list}: none`
    return `${profile.location.labels.list}: ${list.entries.map((e) => e.label).join(', ')}`
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
      list?: SpaceToolList
    }
  ): Promise<string> {
    const parts: string[] = []
    for (const [name, value] of Object.entries(change.bindings ?? {}))
      parts.push(`${source.bindings.find((b) => b.name === name)?.label ?? name}: ${change.labels?.[name] ?? value}`)
    const words = this.listWords(source, change.list)
    if (words) parts.push(words)
    const tools = await this.toolsOf(source, space, false)
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
   * Holds a change that grants something until the owner's device confirms it (TOOL-SPACE-008): one per feature
   * (TOOL-SPACE-009, TOOL-FEAT-007), with a code and its expiry; refused with no capability channel to serve it.
   */
  private async hold(
    principal: Principal,
    session: Session,
    space: Space,
    record: SpaceToolRecord,
    change: Omit<PendingToolChange, 'id' | 'code' | 'expiresAt' | 'sessionId' | 'requestedBy'>
  ): Promise<SpaceToolRecord> {
    if (record.pendingChange) throw new SpaceError('a change of this feature waits for the phone', 'change-pending')
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

  /**
   * `POST {sessions}/spaces/{id}/tools` (TOOL-SPACE-003, TOOL-FEAT-006, TOOL-FEAT-007): the owner chooses the provider of an
   * `available` feature, or of an `off` one, with values for its bindings, its location list and rules for its tools; with
   * `replaces`, the provider in use, the same request changes the provider of a feature that has one.
   */
  public async add(
    principal: Principal,
    session: Session,
    spaceId: string,
    body: {
      source?: unknown
      replaces?: unknown
      bindings?: unknown
      list?: unknown
      calls?: unknown
      location?: unknown
    }
  ): Promise<SpaceToolView> {
    if (typeof body.source !== 'string' || !body.source)
      throw new SpaceError('source is required', 'bad-request', 'source')
    const { space, slot, source } = await this.owned(principal, spaceId, body.source)
    const { feature } = slot
    if (slot.inUse) {
      if (slot.inUse.source.name === source.name)
        throw new SpaceError('the source is in the space already', 'already-added')
      if (body.replaces === undefined || body.replaces === null)
        throw new SpaceError(
          `${feature.title} uses ${slot.inUse.source.title} in this space: change its provider with replaces`,
          'feature-has-provider'
        )
    }
    if (body.replaces !== undefined && body.replaces !== null && body.replaces !== slot.inUse?.source.name)
      throw new SpaceError(`replaces names the provider of ${feature.title} in use`, 'bad-request', 'replaces')
    if (this.pendingOf(slot)) throw new SpaceError(`a change of ${feature.title} waits for the phone`, 'change-pending')
    // Files: a folder the agent makes, or one that exists (TOOL-FEAT-024, PROF-TOOL-040)
    const location = await this.locationOf(space, slot.entry, source, body)
    const { values: bindings, labels } = await this.checkBindings(principal, source, body.bindings)
    const list = await this.checkList(principal, space, slot.entry, source, body.list, undefined)
    const calls = await this.checkCalls(space, source, body.calls, principal)
    const extra = {
      ...(Object.keys(labels).length ? { bindingLabels: labels } : {}),
      ...(list ? { list } : {}),
      ...(location ? { location } : {}),
    }
    const managedWords = location === 'managed' ? ` ${this.managedWords(space, slot.entry, source)}` : ''
    if (slot.inUse) {
      // a change of provider (TOOL-FEAT-007): it waits on the record of the provider in use, which stays in force until then
      const former = slot.inUse.source
      const head = `Use ${source.title} for ${feature.title} in ${space.title}, in place of ${former.title}`
      const values = await this.summaryOf(head, space, source, { bindings, labels, list })
      const released = await this.releaseWords(space, slot.entry, former, slot.inUse.record)
      const summary = `${values}.${managedWords} ${this.agentName} stops using ${former.title} in this space. Nothing is copied from ${former.title} to ${source.title}.${released}`
      await this.hold(principal, session, space, slot.inUse.record, {
        kind: 'provider',
        source: source.name,
        bindings,
        calls,
        summary,
        ...extra,
      })
      return this.ownerView(space, former.name, principal)
    }
    const record: SpaceToolRecord = slot.records.find((r) => r.sourceId === source.name) ?? {
      spaceId: space.id,
      sourceId: source.name,
      added: false,
      bindings: {},
      calls: {},
      updatedAt: nowIso(),
    }
    const values = await this.summaryOf(`Use ${source.title} for ${feature.title} in ${space.title}`, space, source, {
      bindings,
      calls,
      labels,
      list,
    })
    const summary = managedWords ? `${values}.${managedWords}` : values
    await this.hold(principal, session, space, record, { kind: 'add', bindings, calls, summary, ...extra })
    return this.ownerView(space, source.name, principal)
  }

  /**
   * The mode of Files a request asks (TOOL-FEAT-023, TOOL-FEAT-024, TOOL-FEAT-033, PROF-TOOL-040): required where the
   * template allows both and the provider manages; one the template does not allow `422 location-not-allowed`; `managed`
   * with a provider the agent cannot manage `409 cannot-manage`, and with a `list` `400`. A provider that declares no
   * `manage` is in the existing mode whatever the template says. None for another feature.
   */
  private async locationOf(
    space: Space,
    entry: TemplateFeature,
    source: CatalogSource,
    body: { location?: unknown; list?: unknown }
  ): Promise<'managed' | 'existing' | undefined> {
    if (this.catalog.profileOf(source)?.id !== FILES_1_0.id || !this.folders) {
      if (body.location !== undefined)
        throw new SpaceError('a location mode is for Files only', 'bad-request', 'location')
      return undefined
    }
    if (body.location !== undefined && body.location !== 'managed' && body.location !== 'existing')
      throw new SpaceError('location is managed or existing', 'bad-request', 'location')
    let given: 'managed' | 'existing' | undefined = body.location
    const allowed = ManagedFolders.allowed(entry, space)
    // a provider with no `manage` is in the existing mode whatever the template says (TOOL-FEAT-023)
    const manages = this.folders.managesAt(source)
    if (!manages) {
      if (given === 'managed' && !allowed.includes('managed'))
        throw new SpaceError(`the template allows ${allowed.join(' or ')}`, 'location-not-allowed', 'location')
      if (given === 'managed')
        throw new SpaceError(`${this.agentName} cannot make a folder at ${source.title}`, 'cannot-manage')
      return 'existing'
    }
    if (given === undefined) {
      if (allowed.length > 1)
        throw new SpaceError('choose a folder the agent makes, or one that exists', 'bad-request', 'location')
      given = allowed[0]
    }
    if (!allowed.includes(given))
      throw new SpaceError(`the template allows ${allowed.join(' or ')}`, 'location-not-allowed', 'location')
    if (given === 'existing') return given
    // the server must declare team-roots and share with the managing account (TOOL-FEAT-033)
    if ((await this.folders.mayManage(space, source)) === false)
      throw new SpaceError(`${this.agentName} cannot make a folder at ${source.title}`, 'cannot-manage')
    if (body.list !== undefined)
      throw new SpaceError('a folder the agent makes is the one location: send no list', 'bad-request', 'list')
    return given
  }

  /** What the kind of a managed folder is called on the phone (TOOL-FEAT-024): a shared drive of an owner's account. */
  private folderKind(source: CatalogSource): string {
    return source.manage?.as === 'owner' ? 'shared drive' : 'team folder'
  }

  /** The words of adding Files in the managed mode (TOOL-FEAT-024, architecture §10.13). */
  private managedWords(space: Space, entry: TemplateFeature, source: CatalogSource): string {
    const manager = source.manage?.as === 'owner' ? ', with you as its manager' : ''
    const guests = entry.guests ? ' People outside your organization included.' : ''
    return `${this.agentName} makes a ${this.folderKind(source)} named ${space.title}, owned by your organization${manager}, and gives each member of the space access to it.${guests}`
  }

  /** The words of a change that ends the management of a folder (TOOL-FEAT-032): empty when none is managed. */
  private async releaseWords(
    space: Space,
    entry: TemplateFeature,
    source: CatalogSource,
    record: SpaceToolRecord
  ): Promise<string> {
    if (record.location !== 'managed') return ''
    const folder = await this.folders?.folderOf(space.id, entry.feature)
    if (!folder) return ''
    return ` ${this.agentName} stops managing the ${this.folderKind(source)} ${folder.name}. It stays at ${source.title} with its members and its files.`
  }

  /**
   * `PATCH {sessions}/spaces/{id}/tools/{source}` (TOOL-SPACE-004/006/014): a change that only makes rules stricter or a
   * list narrower applies at once (`200`); one that sets a binding, widens a list or loosens a rule waits whole for the
   * phone (`202`).
   */
  public async patch(
    principal: Principal,
    session: Session,
    spaceId: string,
    sourceId: string,
    body: { bindings?: unknown; calls?: unknown; approvals?: unknown; list?: unknown; folder?: unknown }
  ): Promise<{ status: 200 | 202; tool: SpaceToolView }> {
    const { space, slot, source } = await this.owned(principal, spaceId, sourceId)
    const { record } = this.inUse(slot, source)
    // the managed folder: renamed at once, or checked again (PROF-TOOL-043); its location is the agent's (TOOL-FEAT-024)
    if (body.folder !== undefined) return this.patchFolder(principal, space, slot, source, record, body.folder)
    if (body.list !== undefined && record.location === 'managed')
      throw new SpaceError(`${this.agentName} manages this folder: it cannot be changed`, 'managed-location')
    const { values: bindings, labels } = await this.checkBindings(principal, source, body.bindings)
    const calls = await this.checkCalls(space, source, body.calls, principal)
    const list = await this.checkList(principal, space, slot.entry, source, body.list, record.list)
    const changedBindings = Object.fromEntries(Object.entries(bindings).filter(([k, v]) => record.bindings[k] !== v))
    let grants = Object.keys(changedBindings).length > 0
    const changedList = list && !sameList(list, record.list) ? list : undefined
    if (changedList && !narrowsList(changedList, record.list)) grants = true
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
      !Object.keys(changedApprovals).length &&
      !changedList
    )
      return { status: 200, tool: await this.ownerView(space, source.name, principal, warningsFor) }
    if (grants) {
      // one granting change at a time; one that only narrows applies whatever waits (TOOL-SPACE-009)
      if (this.pendingOf(slot))
        throw new SpaceError(`a change of ${slot.feature.title} waits for the phone`, 'change-pending')
      const changedLabels = Object.fromEntries(Object.entries(labels).filter(([k]) => k in changedBindings))
      const head = changedList
        ? `Limit ${source.title} in ${space.title} to`
        : `Change ${source.title} in ${space.title}`
      const summary = await this.summaryOf(head, space, source, {
        bindings: changedBindings,
        calls: changedCalls,
        labels: changedLabels,
        approvals: policyChanges,
        ...(changedList ? { list: changedList } : {}),
      })
      await this.hold(principal, session, space, record, {
        kind: 'patch',
        bindings: changedBindings,
        calls: changedCalls,
        ...(Object.keys(changedApprovals).length ? { approvals: changedApprovals } : {}),
        ...(changedList ? { list: changedList } : {}),
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
        ...(changedList ? { list: changedList } : {}),
        updatedAt: nowIso(),
        updatedBy: principal.id,
      })
    )
    await this.hooks.endAllowances?.(space.id, source.name)
    await this.spaces.record(space.id, principal.id, 'tool-changed', {
      sourceId: source.name,
      featureId: slot.feature.id,
    })
    await this.governance?.review(space)
    const tool = await this.ownerView(space, source.name, principal, warningsFor)
    await this.announce(space, {
      spaceId: space.id,
      feature: slot.feature.id,
      source: source.name,
      state: tool.state,
      outcome: 'applied',
    })
    // the space's rules of Files changed what its members may do: their roles at the managed folder follow (TOOL-FEAT-027)
    if (current.location === 'managed') await this.folders?.reconcile(space)
    return { status: 200, tool }
  }

  /**
   * `PATCH …/tools/{source}` with `folder` (TOOL-FEAT-030, PROF-TOOL-043): `title` renames the managed folder at once,
   * with no phone (a name grants nothing), `200`; `check: true` checks the folder and the members whose access failed
   * again, `202`. Files in the existing mode answers `409 not-managed`.
   */
  private async patchFolder(
    principal: Principal,
    space: Space,
    slot: FeatureSlot,
    source: CatalogSource,
    record: SpaceToolRecord,
    body: unknown
  ): Promise<{ status: 200 | 202; tool: SpaceToolView }> {
    const folder = record.location === 'managed' ? await this.folders?.folderOf(space.id, slot.feature.id) : undefined
    if (!folder || !this.folders)
      throw new SpaceError(`${this.agentName} manages no folder of this space`, 'not-managed')
    if (!isObject(body)) throw new SpaceError('folder is { title } or { check: true }', 'bad-request', 'folder')
    if (body.title !== undefined) {
      await this.folders.rename(space, folder, body.title, principal.id)
      const tool = await this.ownerView(space, source.name, principal)
      await this.announce(space, {
        spaceId: space.id,
        feature: slot.feature.id,
        source: source.name,
        state: tool.state,
        outcome: 'applied',
      })
      return { status: 200, tool }
    }
    if (body.check === true) {
      await this.folders.check(space, folder)
      return { status: 202, tool: await this.ownerView(space, source.name, principal) }
    }
    throw new SpaceError('folder is { title } or { check: true }', 'bad-request', 'folder')
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
    const tools = await this.toolsOf(source, space)
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
    const { space, slot, source } = await this.owned(principal, spaceId, sourceId)
    if (source.account.kind !== 'space')
      throw new SpaceError('the calls of this source do not run with an account of the space', 'no-space-account')
    const { record } = this.inUse(slot, source)
    if (this.pendingOf(slot))
      throw new SpaceError(`a change of ${slot.feature.title} waits for the phone`, 'change-pending')
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
    const { space, slot, source } = await this.owned(principal, spaceId, sourceId)
    if (source.account.kind !== 'space')
      throw new SpaceError('the calls of this source do not run with an account of the space', 'no-space-account')
    if (slot.inUse && slot.inUse.source.name !== source.name) this.inUse(slot, source)
    if (await this.store.spaceAccounts.get(space.id, source.name)) {
      await this.destroyAccount(space.id, source.name)
      await this.hooks.endAllowances?.(space.id, source.name)
      await this.spaces.record(space.id, principal.id, 'account-cleared', {
        sourceId: source.name,
        featureId: slot.feature.id,
      })
    }
    const tool = await this.ownerView(space, source.name, principal)
    await this.announce(space, {
      spaceId: space.id,
      feature: slot.feature.id,
      source: source.name,
      state: tool.state,
      outcome: 'applied',
    })
    return tool
  }

  /**
   * `DELETE {sessions}/spaces/{id}/tools/{source}` (TOOL-SPACE-007): at once, `available` again or `off`, its bindings,
   * list, rules and account dropped, its pending change withdrawn, the allowances of its tools ended.
   */
  public async remove(principal: Principal, spaceId: string, sourceId: string): Promise<SpaceToolView> {
    const { space, slot, source } = await this.owned(principal, spaceId, sourceId)
    if (slot.inUse && slot.inUse.source.name !== source.name) this.inUse(slot, source)
    const wasAdded = !!slot.inUse
    // the agent stops managing the folder, left as it is with its members and its files (TOOL-FEAT-032)
    if (slot.inUse?.record.location === 'managed') await this.folders?.release(space, slot.feature.id, principal.id)
    for (const record of slot.records) if (record.pendingChange) await this.drop(space, record, 'cancelled', true)
    // the provider removed leaves a record only to say that an `add: auto` feature is `off` (TOOL-SPACE-001)
    for (const record of slot.records)
      if (record.sourceId !== source.name || slot.entry.add !== 'auto')
        await this.store.spaceTools.delete(space.id, record.sourceId)
    if (slot.entry.add === 'auto')
      await this.store.spaceTools.save({
        spaceId: space.id,
        sourceId: source.name,
        added: false,
        removed: true,
        bindings: {},
        calls: {},
        updatedAt: nowIso(),
        updatedBy: principal.id,
      })
    await this.destroyAccount(space.id, source.name)
    await this.hooks.endAllowances?.(space.id, source.name)
    if (wasAdded)
      await this.spaces.record(space.id, principal.id, 'tool-removed', {
        sourceId: source.name,
        featureId: slot.feature.id,
      })
    // its policies left with it: a notice of one that needed attention ends (TOOL-SPACE-018)
    await this.governance?.review(space)
    const tool = await this.ownerView(space, source.name, principal)
    await this.announce(space, {
      spaceId: space.id,
      feature: slot.feature.id,
      source: source.name,
      state: tool.state,
      outcome: 'applied',
    })
    return tool
  }

  /**
   * `DELETE …/pending` (TOOL-SPACE-009, PROF-TOOL-034): the change of the feature is withdrawn, whichever of its providers
   * the request names, its flow closed as cancelled, its account's values destroyed.
   */
  public async withdraw(principal: Principal, spaceId: string, sourceId: string): Promise<void> {
    const { space, slot } = await this.owned(principal, spaceId, sourceId)
    const record = this.pendingOf(slot)
    if (!record) throw new SpaceError('nothing of this feature waits for the phone', 'not-found')
    await this.drop(space, record, 'cancelled', true)
  }

  // ---- the choices of a feature's location (TOOL-SPACE-015, TOOL-FEAT-014) -------------------------------------------

  /** The locations the provider answers to a text, read with an account, outside any conversation and with no record. */
  private async readChoices(
    owner: Principal,
    space: Space,
    source: CatalogSource,
    profile: FeatureProfile,
    text: string
  ): Promise<{ value: string; label: string; portable: boolean }[]> {
    const account = await this.ownersAccount(owner, space, source)
    const server = this.registry.sourceById(`mcp:${source.name}`) as
      | {
          callTool?: (
            name: string,
            args: Record<string, unknown>,
            ctx: never
          ) => Promise<{ data?: unknown; isError?: boolean }>
        }
      | undefined
    if (!server?.callTool) throw new SpaceError(`${source.title} cannot be reached`, 'source-unavailable')
    let answer: { data?: unknown; isError?: boolean }
    try {
      answer = await server.callTool(profile.location.listTool, { query: text, limit: MAX_CHOICES }, {
        principal: owner,
        roles: owner.roles,
        logger: this.logger,
        language: this.pack.language.agent,
        spaceId: space.id,
        account,
      } as never)
    } catch (error) {
      this.logger.warn(
        { spaceId: space.id, source: source.name, err: error instanceof Error ? error.message : String(error) },
        'the choices of a location could not be read'
      )
      throw new SpaceError(`${source.title} did not answer`, 'source-unavailable')
    }
    const data = isObject(answer.data) ? answer.data[profile.location.listMember] : undefined
    if (answer.isError || !Array.isArray(data))
      throw new SpaceError(
        `${source.title} did not list its ${profile.location.labels.list.toLowerCase()}`,
        'source-unavailable'
      )
    const out: { value: string; label: string; portable: boolean }[] = []
    for (const item of data) {
      if (!isObject(item) || typeof item.ref !== 'string' || !item.ref) continue
      if (out.some((o) => o.value === item.ref)) continue
      const label = typeof item.title === 'string' && item.title ? item.title : item.ref
      out.push({ value: item.ref, label, portable: item.portable === true })
      if (out.length >= MAX_CHOICES) break
    }
    return out
  }

  /**
   * `GET {sessions}/spaces/{id}/tools/{source}/list/choices?text=` (TOOL-SPACE-015, PROF-TOOL-023): for the owner alone,
   * the locations of a provider of a feature with a contract that its tool listing locations answers to the text, read with
   * the account the owner's own calls would use in the space; nothing of it reaches a model or a record. Any provider the
   * template allows answers, the one in use or another: the list of a change of provider is picked before it is sent
   * (PROF-TOOL-034).
   */
  public async choices(
    principal: Principal,
    spaceId: string,
    sourceId: string,
    text: unknown
  ): Promise<{ values: Record<string, string>; label: string }[]> {
    const { space, slot, source } = await this.owned(principal, spaceId, sourceId)
    const profile = this.catalog.profileOf(source)
    if (!profile) throw new SpaceError(`${source.title} declares no list to search`, 'not-found')
    if (!slot.inUse && slot.off) throw new SpaceError(`${slot.feature.title} is off in this space`, 'not-found')
    if (typeof text !== 'string' || text.length < 1 || text.length > 100)
      throw new SpaceError('text is 1 to 100 characters', 'bad-request', 'text')
    const read = await this.readChoices(principal, space, source, profile, text)
    const key = `${space.id}|${source.name}`
    const kept = this.choicesRead.get(key) ?? new Map()
    const at = Date.now()
    for (const choice of read) kept.set(choice.value, { label: choice.label, portable: choice.portable, text, at })
    this.choicesRead.set(key, kept)
    return read.map((c) => ({ values: { [profile.location.argument]: c.value }, label: c.label }))
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

  /** The feature of a source in a space, by its template (D120). */
  private featureIdOf(space: Space, sourceId: string): string {
    return this.entryOfSource(space, sourceId)?.feature ?? this.catalog.source(sourceId)?.feature ?? ''
  }

  /** The change the phone confirmed applies at once (TOOL-SPACE-008), and is recorded in the space's activity. */
  private async apply(space: Space, record: SpaceToolRecord): Promise<void> {
    const change = record.pendingChange as PendingToolChange
    const source = this.catalog.source(record.sourceId)
    if (!source) return
    if (change.kind === 'provider') return this.applyProvider(space, record, change)
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
    const featureId = this.featureIdOf(space, record.sourceId)
    if (change.kind === 'add') {
      next.added = true
      next.bindings = { ...(change.bindings ?? {}) }
      next.calls = { ...(change.calls ?? {}) }
      next.bindingLabels = change.bindingLabels ? { ...change.bindingLabels } : undefined
      next.list = change.list
      next.location = change.location
      // the feature's other providers, an `off` one among them, leave it: one provider at a time (TOOL-FEAT-003)
      const entry = this.entryOfSource(space, record.sourceId)
      for (const other of await this.store.spaceTools.listBySpace(space.id))
        if (other.sourceId !== record.sourceId && entry?.providers.includes(other.sourceId)) {
          if (other.pendingChange) await this.drop(space, other, 'cancelled', true)
          await this.store.spaceTools.delete(space.id, other.sourceId)
          await this.destroyAccount(space.id, other.sourceId)
        }
    } else if (change.kind === 'patch') {
      next.bindings = { ...record.bindings, ...(change.bindings ?? {}) }
      next.calls = { ...record.calls, ...(change.calls ?? {}) }
      if (change.approvals) next.approvals = { ...(record.approvals ?? {}), ...change.approvals }
      if (change.list) next.list = change.list
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
      { sourceId: record.sourceId, featureId }
    )
    const state = this.stateOf(source, next, await this.store.spaceAccounts.get(space.id, record.sourceId))
    this.logger.info(
      { spaceId: space.id, source: record.sourceId, changeId: change.id },
      'a change of a space tool applied'
    )
    await this.announce(space, {
      spaceId: space.id,
      feature: featureId,
      source: record.sourceId,
      state,
      changeId: change.id,
      outcome: 'applied',
    })
    // the space's folder, made by the agent once the owner confirmed Files in the managed mode, the feature `setup` with
    // the folder `creating` until it is (TOOL-FEAT-024)
    if (change.kind === 'add' && change.location === 'managed') await this.folders?.start(space, featureId, source)
    // the space's rules of Files changed what its members may do: their roles at the managed folder follow (TOOL-FEAT-027)
    else if (change.kind === 'patch' && next.location === 'managed') await this.folders?.reconcile(space)
  }

  /**
   * A change of provider, confirmed (TOOL-FEAT-007), as one step: the former provider's bindings, list, rules and policies
   * dropped with its record, the key of its space account destroyed, the allowances of its tools ended; the new provider
   * put in, `setup` or `ready`, with the bindings, list and rules the change carried; the feature's mark renewed, so that a
   * reference the model read of the former provider reaches no provider (TOOL-FEAT-016). Each member's own account of the
   * former provider stays theirs (TOOL-CONN-009); nothing is copied from one provider to the other, nothing deleted at
   * either (TOOL-FEAT-008).
   */
  private async applyProvider(space: Space, record: SpaceToolRecord, change: PendingToolChange): Promise<void> {
    const former = this.catalog.source(record.sourceId)
    const next = change.source ? this.catalog.source(change.source) : undefined
    const entry = this.entryOfSource(space, record.sourceId)
    if (!former || !next || !entry?.providers.includes(next.name)) return this.drop(space, record, 'failed', false)
    // the folder the agent managed at the former provider stays there as it is (TOOL-FEAT-032)
    if (record.location === 'managed') await this.folders?.release(space, entry.feature, change.requestedBy)
    for (const other of await this.store.spaceTools.listBySpace(space.id))
      if (entry.providers.includes(other.sourceId)) {
        await this.store.spaceTools.delete(space.id, other.sourceId)
        await this.destroyAccount(space.id, other.sourceId)
        await this.hooks.endAllowances?.(space.id, other.sourceId)
      }
    const added: SpaceToolRecord = {
      spaceId: space.id,
      sourceId: next.name,
      added: true,
      bindings: { ...(change.bindings ?? {}) },
      calls: { ...(change.calls ?? {}) },
      ...(change.bindingLabels ? { bindingLabels: { ...change.bindingLabels } } : {}),
      ...(change.list ? { list: change.list } : {}),
      ...(change.location ? { location: change.location } : {}),
      updatedAt: nowIso(),
      updatedBy: change.requestedBy,
    }
    await this.store.spaceTools.save(added)
    if (this.catalog.profileOf(next)) await this.features?.renewMark(space.id, entry.feature, next.name)
    await this.governance?.review(space)
    await this.spaces.record(space.id, change.requestedBy, 'provider-changed', {
      sourceId: next.name,
      featureId: entry.feature,
      formerSourceId: former.name,
    })
    const state = this.stateOf(next, added, await this.store.spaceAccounts.get(space.id, next.name))
    this.logger.info(
      { spaceId: space.id, feature: entry.feature, source: next.name, formerSource: former.name, changeId: change.id },
      'the provider of a feature of a space changed'
    )
    await this.announce(space, {
      spaceId: space.id,
      feature: entry.feature,
      source: next.name,
      formerSource: former.name,
      state,
      changeId: change.id,
      outcome: 'applied',
    })
    // a folder made at the new provider, in the managed mode (TOOL-FEAT-024)
    if (change.location === 'managed') await this.folders?.start(space, entry.feature, next)
  }

  /** A change dropped (declined, expired, failed, withdrawn): the account's values it carried are destroyed with it. */
  private async drop(space: Space, record: SpaceToolRecord, outcome: ChangeOutcome, withdraw: boolean): Promise<void> {
    const change = record.pendingChange
    if (!change) return
    const { pendingChange: _dropped, ...next } = record
    // the record of a first choice that never applied leaves nothing behind
    if (!next.added && !next.removed) await this.store.spaceTools.delete(space.id, record.sourceId)
    else await this.store.spaceTools.save(next)
    if (withdraw && change.challengeId) await this.challenges.withdraw(change.challengeId)
    const source = this.catalog.source(record.sourceId)
    const state = source
      ? this.stateOf(source, next, await this.store.spaceAccounts.get(space.id, record.sourceId))
      : 'available'
    this.logger.info(
      { spaceId: space.id, source: record.sourceId, changeId: change.id, outcome },
      'a change of a space tool dropped'
    )
    // a change of provider dropped leaves the provider in use as it was: the event names it
    await this.announce(space, {
      spaceId: space.id,
      feature: this.featureIdOf(space, record.sourceId),
      source: record.sourceId,
      state,
      changeId: change.id,
      outcome,
    })
  }

  private async destroyAccount(spaceId: string, sourceId: string): Promise<void> {
    await this.store.spaceAccounts.delete(spaceId, sourceId)
    await this.hooks.accountEnded?.(spaceId, sourceId)
  }

  /**
   * The managed folder of a feature, or members' access to it, changed (PROF-TOOL-041): `ayni.space.tools.changed`,
   * applied, with no change id, to the owner's sessions and to those of each member whose access it is.
   */
  public async folderChanged(space: Space, featureId: string, sourceId: string, principalIds: string[]): Promise<void> {
    const source = this.catalog.source(sourceId)
    const record = await this.store.spaceTools.get(space.id, sourceId)
    if (!source || !record) return
    const state = this.stateOf(source, record, await this.store.spaceAccounts.get(space.id, sourceId))
    const value: SpaceToolsChanged = {
      spaceId: space.id,
      feature: featureId,
      source: sourceId,
      state,
      outcome: 'applied',
    }
    await this.announce(space, value)
    for (const id of new Set(principalIds))
      if (id !== space.ownerPrincipalId)
        await this.hooks
          .announceTo?.(id, value)
          .catch((err) => this.logger.warn({ err, spaceId: space.id }, 'a change of a folder was not announced'))
  }

  private async announce(space: Space, value: SpaceToolsChanged): Promise<void> {
    await this.hooks
      .announce?.(space, value)
      .catch((err) => this.logger.warn({ err, spaceId: space.id }, 'a change of the space tools was not announced'))
  }

  // ---- the life of a space --------------------------------------------------------------------------------------------

  /** A new space: the features its template adds by itself come with it, with their default provider (TOOL-SPACE-001). */
  public async onCreated(space: Space): Promise<void> {
    for (const entry of this.entriesOf(space)) if (entry.add === 'auto') await this.slotOf(space, entry)
  }

  /** The space passed to another owner: its tools stay, its pending changes are dropped (TOOL-SPACE-011). */
  public async onOwnerChanged(space: Space): Promise<void> {
    for (const record of await this.store.spaceTools.listBySpace(space.id))
      if (record.pendingChange) await this.drop(space, record, 'cancelled', true)
  }

  /**
   * At start (TOOL-SPACE-001/011, TOOL-FEAT-006): a source the template no longer names as a provider of a feature leaves
   * its spaces, its account's key destroyed; where a space holds two providers of one feature, as it may at the first start
   * with features, the template's default is kept, else the first of its providers, and the other leaves as a removal does;
   * the `add: auto` features of each template reach the spaces created before it named them; a change left pending by the
   * previous process expires when its time is over.
   */
  public async align(): Promise<void> {
    const leave = async (record: SpaceToolRecord, why: string) => {
      await this.store.spaceTools.delete(record.spaceId, record.sourceId)
      await this.destroyAccount(record.spaceId, record.sourceId)
      await this.hooks.endAllowances?.(record.spaceId, record.sourceId)
      this.logger.info({ spaceId: record.spaceId, source: record.sourceId }, why)
    }
    const bySpace = new Map<string, SpaceToolRecord[]>()
    for (const record of await this.store.spaceTools.listAll())
      bySpace.set(record.spaceId, [...(bySpace.get(record.spaceId) ?? []), record])
    for (const [spaceId, records] of bySpace) {
      const space = await this.spaces.find(spaceId)
      const entries = space ? this.entriesOf(space) : []
      for (const record of records)
        if (!entries.some((e) => e.providers.includes(record.sourceId)) || !this.catalog.source(record.sourceId))
          await leave(record, 'a source the template no longer names left the space')
      for (const entry of entries) {
        const ofFeature = records.filter((r) => entry.providers.includes(r.sourceId) && this.catalog.source(r.sourceId))
        const added = ofFeature.filter((r) => r.added)
        if (!added.length) continue
        // one provider per feature (TOOL-FEAT-003, TOOL-FEAT-006): the default kept, else the first of the providers
        const keep =
          added.find((r) => r.sourceId === defaultProviderOf(entry)) ??
          [...added].sort((a, b) => entry.providers.indexOf(a.sourceId) - entry.providers.indexOf(b.sourceId))[0]
        for (const record of ofFeature)
          if (record !== keep)
            await leave(record, `a second provider of ${entry.feature} left the space: one provider per feature`)
      }
    }
    for (const account of await this.store.spaceAccounts.listAll()) {
      const space = await this.spaces.find(account.spaceId)
      const record = await this.store.spaceTools.get(account.spaceId, account.sourceId)
      if (!space || !record?.added) {
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
