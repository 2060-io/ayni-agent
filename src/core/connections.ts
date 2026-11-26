/**
 * Each person's own accounts (ayni-spec D104 to D110; TOOL-ACCESS-008..014, TOOL-OAUTH-001..010, TOOL-CONN-001..014,
 * TOOL-SPACE-012/013, TOOL-CALL-011, PRIV-ERASE-013; AG-UI profile 3.5 §3.11).
 *
 * A source of kind `personal` runs each call with the account of the person who asks. The person, and nobody else,
 * connects it: through OAuth as MCP defines it (an attempt started from a bound session, the sign-in in the browser, the
 * callback to the agent, the check of the account), or by typing the fields its source declares. An account is sealed
 * under a key of its own, wrapped by a key of the person, wrapped by the deployment's master key (D106); its tokens are
 * opened in memory for a call of that person or a refresh, never logged, recorded, given to the model or sent to a client.
 *
 * An account is `connected` or `reconnect` (with its reason); a person holds at most one per source, or one per value of
 * the binding the source's account is for (D110), which the check reads right after the sign-in, outside the model.
 */
import { createHash } from 'node:crypto'
import type { AccountCheck, AgentPack, SourceAccount } from '../config/packTypes.js'
import { type EntryCrypto, newKeyUnder, openJson, openUnder, sealJson, sealUnder } from '../memory/crypto.js'
import { resolveTier } from '../policy/rbac.js'
import type { Store } from '../store/types.js'
import { accountSecrets, buildAccountHeaders, fitsFields } from '../tools/accountValues.js'
import { type CatalogSource, effectFromAnnotations, type ToolCatalog } from '../tools/catalog.js'
import {
  type AuthorizationServerMetadata,
  type ClientCredentials,
  type Discovery,
  newState,
  type OAuthClient,
  OAuthRefused,
  pkcePair,
  SourceUnavailable,
  stateHash,
  type TokenSet,
} from '../tools/oauth.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { CallAccountSecret, PersonalOAuthHandle } from '../tools/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { isPersonalSpace, SpaceError, type SpaceService } from './spaces.js'
import type { SpaceToolService } from './spaceTools.js'
import type {
  ElevationGrant,
  OAuthAttemptOutcome,
  OAuthAttemptRecord,
  OAuthClientRecord,
  PersonalAccountRecord,
  PersonalAccountSecret,
  Principal,
  ReconnectReason,
  Session,
} from './types.js'

/** The path of the callback of every sign-in (D105, TOOL-OAUTH-006). */
export const OAUTH_CALLBACK_PATH = '/tools/oauth/callback'
/** The path of the agent's client ID metadata document (D105, TOOL-OAUTH-004). */
export const CLIENT_METADATA_PATH = '/tools/oauth/client-metadata.json'
/** How long a sign-in may take (TOOL_OAUTH_ATTEMPT_SECONDS, 600 by default). */
export const DEFAULT_ATTEMPT_SECONDS = 600
/** A token that expires within this is refreshed before a call (TOOL-OAUTH-008). */
export const REFRESH_BEFORE_MS = 60_000
/** How long a Disconnect waits for the service's revocation (TOOL-CONN-006). */
export const REVOKE_WAIT_MS = 5_000
/** How long what a server's metadata says is kept before it is read again. */
const DISCOVERY_TTL_MS = 10 * 60_000
/** The longest label of an account (TOOL-CONN-013). */
const LABEL_MAX = 80
/** The longest description of a source in what the model reads (TOOL-CONN-010). */
const DESCRIPTION_MAX = 120

/** A refusal of Your accounts (profile 3.5 §3.11), with what its body carries beyond the code. */
export class ConnectionError extends SpaceError {}

/** Where an account serves (PROF-TOOL-014). */
export type ConnectionUse = { kind: 'agent' } | { kind: 'personal' } | { kind: 'space'; id: string; title: string }

/** One item of `GET {sessions}/connections` (PROF-TOOL-014). */
export interface ConnectionView {
  source: string
  title: string
  description?: string
  method: 'oauth' | 'fields'
  fields?: { name: string; label: string; pattern?: string }[]
  binding: { name: string; label: string; value: string | null; valueLabel: string | null } | null
  usedIn: ConnectionUse[]
  state: 'not-connected' | 'connected' | 'reconnect'
  reason: ReconnectReason | null
  moreAccess: boolean
  account: { id: string; label: string | null; connectedAt: string; lastUsedAt: string | null } | null
  attempt: { id: string; expiresAt: string } | null
  revokesAtSource: boolean
  /** the features the sources that use the account serve, each once (PROF-TOOL-035) */
  features: { id: string; title: string }[]
}

/** `ayni.connections.changed` (PROF-TOOL-019). */
export interface ConnectionsChanged {
  source: string
  binding?: { value: string; valueLabel: string | null }
  state: 'not-connected' | 'connected' | 'reconnect'
  reason?: ReconnectReason
  moreAccess?: boolean
  accountId?: string
  label?: string
  attemptId?: string
  outcome?: OAuthAttemptOutcome | 'disconnected' | 'ended'
  expected?: string
  chosen?: string
}

/** A personal source the person has not connected, or must reconnect, in a conversation (TOOL-CONN-010, D108). */
export interface ToConnect {
  source: string
  title: string
  description?: string
  method: 'oauth' | 'fields'
  why: 'connect' | 'reconnect'
  binding?: { label: string; value: string; valueLabel: string | null }
  spaceId?: string
  /** the feature of the source the card is for (PROF-TOOL-035) */
  feature?: { id: string; title: string }
}

/** What the callback answers the browser (TOOL-OAUTH-006): a redirection, or a page. */
export interface CallbackAnswer {
  status: 303 | 400 | 200
  location?: string
  page?: string
}

/** The account a call of a person uses, or why it has none (TOOL-CALL-011). */
export type OpenedAccount =
  | { status: 'connected'; account: CallAccountSecret; record: PersonalAccountRecord }
  | { status: 'not-connected' | 'reconnect' }

export interface ConnectionHooks {
  /** an event to every bound session of the Principal that has its stream open (PROF-TOOL-019) */
  announce?: (principalId: string, value: ConnectionsChanged) => Promise<void>
  /** an account ended, was replaced or went to reconnect: its connection to the server closes (TOOL-ACCESS-012) */
  accountEnded?: (accountId: string) => Promise<void>
  /** the allowances of these sources' tools end, in every conversation of the Principal (TOOL-CONN-006) */
  endAllowances?: (principalId: string, sourceIds: string[]) => Promise<void>
  /** the sessions of a conversation of profile 3.5 or later, which can show a Connect card (TOOL-CONN-011) */
  connectSessions?: (conversationId: string) => Promise<Session[]>
}

export interface ConnectionDeps {
  pack: AgentPack
  store: Store
  catalog: ToolCatalog
  crypto: EntryCrypto
  spaces: SpaceService
  registry: ToolRegistry
  oauth: OAuthClient
  logger: Logger
  /** `PUBLIC_BASE_URL`: the callback and the client metadata document are under it */
  publicBaseUrl: string
  /** the agent's DID, for the return link (PROF-LINK-004) */
  agentDid: () => string
  /** the app-link base (`https://app.dev.ayni.org/app/`); the browser is sent there after a sign-in */
  appLinkBase?: string
  attemptSeconds?: number
  /** the email of the Principal's entry of the user directory (D110, `check.email`) */
  directoryEmail?: (principal: Principal) => string | undefined
}

/** The value at a JSON pointer (RFC 6901) of a document, or undefined. */
export function atPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc
  let here: unknown = doc
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(here)) here = here[Number(token)]
    else if (here && typeof here === 'object') here = (here as Record<string, unknown>)[token]
    else return undefined
    if (here === undefined) return undefined
  }
  return here
}

/** A scalar at a pointer as text, or undefined: a check reads ids, names and emails. */
function textAt(doc: unknown, pointer: string | undefined): string | undefined {
  if (pointer === undefined) return undefined
  const value = atPointer(doc, pointer)
  if (typeof value === 'string') return value || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** The label of an account from its check's template (TOOL-CONN-013): undefined when a pointer finds nothing. */
export function labelFrom(template: string | undefined, doc: unknown): string | undefined {
  if (!template) return undefined
  let missing = false
  const label = template.replace(/\{(\/[^{}]*)\}/g, (_m, pointer: string) => {
    const value = textAt(doc, pointer)
    if (value === undefined) missing = true
    return value ?? ''
  })
  if (missing || !label.trim()) return undefined
  return label.length > LABEL_MAX ? label.slice(0, LABEL_MAX) : label
}

/** A digest of how the agent-pack connects a source (TOOL-CONN-009): its URL, method, registration, client, issuer, binding. */
export function packDigestOf(source: Pick<CatalogSource, 'kind' | 'account' | 'url'>): string {
  const account = source.account
  const client = account.oauth?.client
  return digest({
    type: source.kind,
    url: source.url ?? null,
    method: account.oauth ? 'oauth' : 'fields',
    registration: client?.registration ?? null,
    clientId: client?.registration === 'pre-registered' ? (client.id ?? null) : null,
    issuer: client?.registration === 'pre-registered' ? (client.issuer ?? null) : null,
    binding: account.binding ?? null,
    bindingResource: account.oauth?.bindingRequest?.resource ?? null,
    fields: (account.fields ?? []).map((f) => f.name),
  })
}

/** A digest of the scopes the agent-pack asks (TOOL-CONN-009): a change of them asks each account to reconnect. */
export function scopesDigestOf(account: SourceAccount): string {
  return digest({ scopes: account.oauth?.scopes ?? null })
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The account of a call is not connected (any more): the call does not run (TOOL-CALL-011). */
export class AccountNotConnected extends Error {
  public constructor(public readonly reason: 'not-connected' | 'reconnect' = 'not-connected') {
    super('the account of this person is not connected')
    this.name = 'AccountNotConnected'
  }
}

/** A page the callback shows: words only, no code, no token, no outcome beyond "start again". */
function page(title: string, text: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`
}

interface Expected {
  value?: string
  label?: string
  uses: ConnectionUse[]
  spaceId?: string
}

export class ConnectionService {
  public hooks: ConnectionHooks = {}
  /** set once the tools of the spaces are built: the sources ready in a space, and their bindings */
  public spaceTools?: SpaceToolService
  /** the refreshes of one account, one at a time (TOOL-OAUTH-008) */
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly discoveries = new Map<string, { at: number; discovery: Discovery }>()
  private readonly metadatas = new Map<string, { at: number; metadata: AuthorizationServerMetadata }>()

  public constructor(private readonly deps: ConnectionDeps) {}

  private get store(): Store {
    return this.deps.store
  }

  public get callbackUrl(): string {
    return `${this.deps.publicBaseUrl}${OAUTH_CALLBACK_PATH}`
  }

  public get clientMetadataUrl(): string {
    return `${this.deps.publicBaseUrl}${CLIENT_METADATA_PATH}`
  }

  /** The client ID metadata document (TOOL-OAUTH-004): a public client of the agent's callback. */
  public clientMetadata(): Record<string, unknown> {
    return {
      client_id: this.clientMetadataUrl,
      client_name: this.deps.pack.metadata.displayName,
      client_uri: this.deps.publicBaseUrl,
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  // ---- the catalog of personal sources ---------------------------------------------------------------------------

  /** The sources of each person's own account, in the agent-pack's order. */
  public personalSources(): CatalogSource[] {
    return this.deps.catalog.sources().filter((s) => s.kind !== 'bundled' && s.account.kind === 'personal')
  }

  /** The source that declares the account a source uses: itself, or the one its `account.from` names (TOOL-CAT-015). */
  public declaringOf(source: CatalogSource): CatalogSource | undefined {
    if (source.account.kind !== 'personal') return undefined
    if (!source.account.from) return source
    const named = this.deps.catalog.source(source.account.from)
    return named?.account.kind === 'personal' && !named.account.from ? named : undefined
  }

  /** The sources that use a declaring source's account: itself, and those whose `account.from` names it. */
  private consumersOf(declaring: CatalogSource): CatalogSource[] {
    return this.personalSources().filter((s) => s.name === declaring.name || s.account.from === declaring.name)
  }

  /** A source the person may connect or use: of kind personal, declaring its own account (TOOL-CONN-001). */
  private declared(sourceId: string): CatalogSource | undefined {
    const source = this.deps.catalog.source(sourceId)
    if (!source || source.kind === 'bundled' || source.account.kind !== 'personal' || source.account.from)
      return undefined
    if (!source.account.oauth && !source.account.fields) return undefined
    return source
  }

  /** Whether the Principal's roles give at least one tool of a source (TOOL-CONN-001, RBAC-TOOL-001). */
  private async givesATool(
    principal: Principal,
    source: CatalogSource,
    grants: ElevationGrant[] = []
  ): Promise<boolean> {
    const discovered = (await this.deps.registry.all()).filter((s) => s.source === source.name).map((s) => s.rawName)
    const names = new Set<string>([
      ...(source.kind === 'http' ? [source.name] : []),
      ...(source.offer ?? []),
      ...Object.keys(source.tools),
      ...discovered,
    ])
    if (!names.size) names.add('*')
    for (const name of names) {
      const hasGrant = grants.some((g) => g.toolName === name && (!g.serverName || g.serverName === source.name))
      const tier = resolveTier(source.access, principal.roles, name, hasGrant).tier
      if (tier === 'ALLOW' || tier === 'APPROVAL') return true
    }
    return false
  }

  /** The binding a declaring source's accounts are for, if it declares one (D110). */
  private bindingOf(declaring: CatalogSource) {
    const name = declaring.account.binding
    return name ? declaring.bindings.find((b) => b.name === name) : undefined
  }

  /**
   * Where a declaring source's account serves the Principal, and which value of its binding each place expects
   * (TOOL-CONN-001): the whole agent and Personal, by the agent-pack's value; each space where a source that uses the
   * account is ready and the Principal an active member (a guest only where the template opens it), by the space's value.
   */
  private async expectedOf(principal: Principal, declaring: CatalogSource): Promise<Expected[]> {
    const binding = this.bindingOf(declaring)
    const groups = new Map<string, Expected>()
    const add = (value: string | undefined, label: string | undefined, use: ConnectionUse, spaceId?: string) => {
      const key = value ?? ''
      const group = groups.get(key) ?? {
        ...(value !== undefined ? { value } : {}),
        ...(label ? { label } : {}),
        uses: [],
      }
      if (!group.label && label) group.label = label
      group.uses.push(use)
      if (spaceId && !group.spaceId) group.spaceId = spaceId
      groups.set(key, group)
    }
    const spaces = this.spaceTools ? await this.deps.spaces.listFor(principal) : []
    for (const consumer of this.consumersOf(declaring)) {
      if (!(await this.givesATool(principal, consumer))) continue
      if (consumer.availability === 'agent' || consumer.availability === 'personal') {
        add(binding?.value, undefined, consumer.availability === 'agent' ? { kind: 'agent' } : { kind: 'personal' })
        continue
      }
      for (const access of spaces) {
        if (access.left || !access.role || isPersonalSpace(access.space.id)) continue
        const ready = (await this.spaceTools?.readyIn(access.space))?.find((r) => r.source.name === consumer.name)
        if (!ready) continue
        if (access.role === 'guest' && ready.entry.guests !== true) continue
        const value = binding ? ready.bindings[binding.name] : undefined
        const label = binding ? ready.record.bindingLabels?.[binding.name] : undefined
        add(value, label, { kind: 'space', id: access.space.id, title: access.space.title }, access.space.id)
      }
    }
    // a place that names the same use twice (two sources of one account in Personal) is one
    for (const group of groups.values()) {
      const seen = new Set<string>()
      group.uses = group.uses.filter((u) => {
        const key = u.kind === 'space' ? `space:${u.id}` : u.kind
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
    return [...groups.values()]
  }

  // ---- Your accounts (TOOL-CONN-001, PROF-TOOL-014) ------------------------------------------------------------------

  /** The label of an account, opened from its own sealed part: never the tokens (TOOL-ACCESS-011). */
  private async labelOf(record: PersonalAccountRecord): Promise<string | undefined> {
    if (!record.labelCipher || !record.encKeyRef) return undefined
    const person = await this.store.personKeys.get(record.principalId)
    if (!person) return undefined
    try {
      return openUnder<{ label?: string }>(
        this.deps.crypto,
        person.wrappedKey,
        record.encKeyRef,
        Buffer.from(record.labelCipher, 'base64')
      ).label
    } catch {
      return undefined
    }
  }

  /** Whether a Disconnect reaches the service: its authorization server names a revocation endpoint (TOOL-CONN-006). */
  private async revokesAtSource(declaring: CatalogSource): Promise<boolean> {
    if (!declaring.account.oauth) return false
    const issuer = await this.store.kv.get(`oauth-source-issuer:${declaring.name}`)
    if (!issuer) return false
    return (await this.store.kv.get(`oauth-revocation:${issuer}`)) === 'yes'
  }

  private async view(
    principal: Principal,
    declaring: CatalogSource,
    expected: Pick<Expected, 'value' | 'label' | 'uses'>,
    record: PersonalAccountRecord | undefined,
    waiting: OAuthAttemptRecord[]
  ): Promise<ConnectionView> {
    const binding = this.bindingOf(declaring)
    const value = record?.bindingValue ?? expected.value
    const attempt = waiting.find(
      (a) =>
        a.principalId === principal.id &&
        a.sourceId === declaring.name &&
        (a.expectedBinding?.value ?? '') === (binding ? (expected.value ?? '') : '')
    )
    const label = record ? await this.labelOf(record) : undefined
    return {
      source: declaring.name,
      title: declaring.title,
      ...(declaring.description ? { description: declaring.description } : {}),
      method: declaring.account.oauth ? 'oauth' : 'fields',
      ...(declaring.account.fields
        ? {
            fields: declaring.account.fields.map((f) => ({
              name: f.name,
              label: f.label,
              ...(f.pattern ? { pattern: f.pattern } : {}),
            })),
          }
        : {}),
      binding: binding
        ? {
            name: binding.name,
            label: binding.label,
            value: value ?? null,
            valueLabel: record?.bindingLabel ?? expected.label ?? null,
          }
        : null,
      usedIn: expected.uses,
      state: record?.state ?? 'not-connected',
      reason: record?.reason ?? null,
      moreAccess: record?.moreAccess === true,
      account: record
        ? {
            id: record.id,
            label: label ?? null,
            connectedAt: record.connectedAt,
            lastUsedAt: record.lastUsedAt ?? null,
          }
        : null,
      attempt: attempt ? { id: attempt.id, expiresAt: attempt.expiresAt } : null,
      revokesAtSource: await this.revokesAtSource(declaring),
      features: this.featuresOf(declaring),
    }
  }

  /** The features the sources that use an account serve, each once, in the order of tools.sources (PROF-TOOL-035). */
  private featuresOf(declaring: CatalogSource): { id: string; title: string }[] {
    const out: { id: string; title: string }[] = []
    for (const consumer of this.consumersOf(declaring)) {
      const feature = this.deps.catalog.featureOf(consumer)
      if (feature && !out.some((f) => f.id === feature.id)) out.push({ id: feature.id, title: feature.title })
    }
    return out
  }

  /**
   * `GET {sessions}/connections` (TOOL-CONN-001): one item per account the Principal can connect or holds; for a source with
   * a binding, one per value expected and one per account held for a value nothing expects any more.
   */
  public async list(principal: Principal): Promise<ConnectionView[]> {
    const held = await this.store.personalAccounts.listByPrincipal(principal.id)
    const waiting = (await this.store.oauthAttempts.listWaiting()).filter((a) => a.principalId === principal.id)
    const out: ConnectionView[] = []
    for (const source of this.personalSources()) {
      const declaring = this.declared(source.name)
      if (!declaring) continue
      const binding = this.bindingOf(declaring)
      const expected = await this.expectedOf(principal, declaring)
      const mine = held.filter((r) => r.sourceId === declaring.name)
      const shown = new Set<string>()
      for (const group of expected) {
        if (binding && group.value === undefined) continue
        const record = mine.find((r) => (r.bindingValue ?? '') === (binding ? (group.value ?? '') : ''))
        if (record) shown.add(record.id)
        out.push(await this.view(principal, declaring, group, record, waiting))
      }
      // an account nothing uses any more is kept, and listed as used nowhere (TOOL-CONN-009)
      for (const record of mine)
        if (!shown.has(record.id))
          out.push(
            await this.view(
              principal,
              declaring,
              { ...(record.bindingValue ? { value: record.bindingValue } : {}), uses: [] },
              record,
              waiting
            )
          )
    }
    return out
  }

  /** The item of one account, or of what it is for, after a change. */
  private async itemFor(
    principal: Principal,
    declaring: CatalogSource,
    value: string | undefined
  ): Promise<ConnectionView> {
    const binding = this.bindingOf(declaring)
    const items = (await this.list(principal)).filter((i) => i.source === declaring.name)
    const found = items.find((i) => (binding ? i.binding?.value === (value ?? null) : true))
    if (found) return found
    return this.view(principal, declaring, { ...(value !== undefined ? { value } : {}), uses: [] }, undefined, [])
  }

  // ---- the place of a request: which value of the binding it is for (TOOL-CONN-004) -------------------------------

  /**
   * The value an attempt, or the fields, expect: the binding's value in the space asked, or the agent-pack's; in a space
   * whose binding has no value only its owner may connect, expecting nothing (TOOL-CONN-004, TOOL-SPACE-013).
   */
  private async placeOf(
    principal: Principal,
    declaring: CatalogSource,
    spaceId: unknown
  ): Promise<{ expected?: { value: string; label?: string }; spaceId?: string }> {
    const binding = this.bindingOf(declaring)
    const consumers = this.consumersOf(declaring)
    // a source none of whose tools the Principal's roles give is not theirs to connect, anywhere (TOOL-CONN-001)
    let gives = false
    for (const consumer of consumers) if (await this.givesATool(principal, consumer)) gives = true
    if (!gives) throw new ConnectionError('this source cannot be connected', 'not-found')
    const ofSpaces = consumers.every((c) => c.availability === 'spaces')
    if (spaceId === undefined || spaceId === null || spaceId === '') {
      if (ofSpaces) throw new ConnectionError('this source is of a space: name it', 'bad-request', 'spaceId')
      const usable = (await this.expectedOf(principal, declaring)).some((g) =>
        g.uses.some((u) => u.kind === 'agent' || u.kind === 'personal')
      )
      if (!usable) throw new ConnectionError('this source cannot be connected here', 'not-found')
      return binding?.value !== undefined ? { expected: { value: binding.value } } : {}
    }
    if (typeof spaceId !== 'string') throw new ConnectionError('spaceId is a text', 'bad-request', 'spaceId')
    const access = await this.deps.spaces.access(principal, spaceId)
    if (!access || access.left || !access.role || isPersonalSpace(spaceId) || !this.spaceTools)
      throw new ConnectionError('this source cannot be connected in that space', 'not-found')
    for (const consumer of consumers) {
      if (consumer.availability !== 'spaces' || !(await this.givesATool(principal, consumer))) continue
      const entry = this.spaceTools.entryOfSource(access.space, consumer.name)
      if (!entry) continue
      if (access.role === 'guest' && entry.guests !== true) continue
      const ready = (await this.spaceTools.readyIn(access.space)).find((r) => r.source.name === consumer.name)
      if (ready) {
        if (!binding) return { spaceId }
        const value = ready.bindings[binding.name]
        if (value !== undefined)
          return {
            expected: {
              value,
              ...(ready.record.bindingLabels?.[binding.name]
                ? { label: ready.record.bindingLabels[binding.name] }
                : {}),
            },
            spaceId,
          }
      }
      // the owner of a space whose binding has no value connects to choose it: the attempt expects nothing
      if (binding && access.role === 'owner') {
        const record = await this.store.spaceTools.get(access.space.id, consumer.name)
        const bound = binding.value ?? record?.bindings[binding.name]
        if ((record?.added || entry.add === 'auto') && bound === undefined) return { spaceId }
      }
    }
    throw new ConnectionError('this source cannot be connected in that space', 'not-found')
  }

  // ---- the client and the metadata (TOOL-OAUTH-001..004) ------------------------------------------------------------

  /** What a server's metadata says, kept a while: read again on a start, and when the cached one is old. */
  private async discoveryOf(declaring: CatalogSource, fresh = false): Promise<Discovery> {
    const url = declaring.url as string
    const cached = this.discoveries.get(declaring.name)
    if (!fresh && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.discovery
    const discovery = await this.deps.oauth.discover(url)
    this.discoveries.set(declaring.name, { at: Date.now(), discovery })
    return discovery
  }

  private async metadataOf(issuer: string, fresh = false): Promise<AuthorizationServerMetadata> {
    const cached = this.metadatas.get(issuer)
    if (!fresh && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.metadata
    const metadata = await this.deps.oauth.metadata(issuer)
    this.metadatas.set(issuer, { at: Date.now(), metadata })
    await this.store.kv.set(`oauth-revocation:${issuer}`, metadata.revocation_endpoint ? 'yes' : 'no')
    return metadata
  }

  /** The authorization server the agent uses for a source: the first its metadata lists, or a pre-registered client's. */
  private issuerFor(declaring: CatalogSource, discovery: Discovery): string {
    const client = declaring.account.oauth?.client
    if (client?.registration === 'pre-registered') {
      const issuer = client.issuer as string
      if (!discovery.authorizationServers.includes(issuer))
        throw new SourceUnavailable('the server does not name the authorization server of the pre-registered client')
      return issuer
    }
    return discovery.authorizationServers[0] as string
  }

  private clientRef(declaring: CatalogSource, issuer: string): string {
    const client = declaring.account.oauth?.client
    return client?.registration === 'pre-registered'
      ? `pre-registered|${issuer}|${client.id}`
      : `${client?.registration}|${issuer}`
  }

  /**
   * The agent's client at an issuer, as the source declares it and in no other way (TOOL-OAUTH-003): the pre-registered
   * client of the deployment's secrets; the metadata document, where the server takes one; the registration kept for the
   * issuer, made at the first connection and again when the callback changed.
   */
  private async clientFor(
    declaring: CatalogSource,
    issuer: string,
    metadata: AuthorizationServerMetadata
  ): Promise<{ ref: string; credentials: ClientCredentials }> {
    const client = declaring.account.oauth?.client
    const ref = this.clientRef(declaring, issuer)
    if (client?.registration === 'pre-registered')
      return {
        ref,
        credentials: { clientId: client.id as string, ...(client.secret ? { clientSecret: client.secret } : {}) },
      }
    if (client?.registration === 'metadata-document') {
      if (metadata.client_id_metadata_document_supported !== true)
        throw new SourceUnavailable('the authorization server takes no client ID metadata document')
      return { ref, credentials: { clientId: this.clientMetadataUrl } }
    }
    if (!metadata.registration_endpoint) throw new SourceUnavailable('the authorization server registers no client')
    const kept = await this.store.oauthClients.get(ref)
    if (kept && kept.issuer === issuer && kept.redirectUri === this.callbackUrl)
      return { ref, credentials: this.credentialsOf(kept) }
    const registered = await this.deps.oauth.register(metadata, this.deps.pack.metadata.displayName, this.callbackUrl)
    const record: OAuthClientRecord = {
      ref,
      issuer,
      registration: 'dynamic',
      clientId: registered.clientId,
      redirectUri: this.callbackUrl,
      registeredAt: nowIso(),
    }
    if (registered.clientSecret) {
      const keyRef = this.deps.crypto.newWrappedKey()
      record.encKeyRef = keyRef
      record.secretCipher = sealJson(this.deps.crypto, keyRef, { secret: registered.clientSecret }).cipher.toString(
        'base64'
      )
    }
    await this.store.oauthClients.save(record)
    this.deps.logger.info(
      { source: declaring.name, issuer },
      'the agent registered its client at an authorization server'
    )
    return { ref, credentials: registered }
  }

  private credentialsOf(record: OAuthClientRecord): ClientCredentials {
    let clientSecret: string | undefined
    if (record.secretCipher && record.encKeyRef)
      clientSecret = openJson<{ secret?: string }>(
        this.deps.crypto,
        record.encKeyRef,
        Buffer.from(record.secretCipher, 'base64')
      ).secret
    return { clientId: record.clientId, ...(clientSecret ? { clientSecret } : {}) }
  }

  /** The client an account's tokens came from (TOOL-OAUTH-008): the one of its issuer, and never of another. */
  private async credentialsFor(declaring: CatalogSource, clientRef: string): Promise<ClientCredentials> {
    const client = declaring.account.oauth?.client
    if (clientRef.startsWith('pre-registered|'))
      return { clientId: client?.id as string, ...(client?.secret ? { clientSecret: client.secret } : {}) }
    if (clientRef.startsWith('metadata-document|')) return { clientId: this.clientMetadataUrl }
    const kept = await this.store.oauthClients.get(clientRef)
    if (!kept) throw new SourceUnavailable('the agent holds no client at that authorization server any more')
    return this.credentialsOf(kept)
  }

  // ---- connecting through OAuth (TOOL-OAUTH-005, TOOL-CONN-004) ----------------------------------------------------

  /**
   * `POST {sessions}/connections/{source}/authorize` (TOOL-CONN-004): an attempt for the Principal and the session, for
   * one use and ten minutes, and the URL of the sign-in. No confirmation on the phone (D104).
   */
  public async startAuthorize(
    principal: Principal,
    session: Session,
    sourceId: string,
    spaceId: unknown
  ): Promise<{ attemptId: string; authorizationUrl: string; expiresAt: string }> {
    const declaring = this.declared(sourceId)
    if (!declaring) throw new ConnectionError('this source cannot be connected', 'not-found')
    const place = await this.placeOf(principal, declaring, spaceId)
    if (!declaring.account.oauth)
      throw new ConnectionError('this source connects with fields, not a sign-in', 'not-oauth')
    const oauth = declaring.account.oauth
    let discovery: Discovery
    let issuer: string
    let metadata: AuthorizationServerMetadata
    let client: { ref: string; credentials: ClientCredentials }
    try {
      discovery = await this.discoveryOf(declaring, true)
      issuer = this.issuerFor(declaring, discovery)
      metadata = await this.metadataOf(issuer, true)
      client = await this.clientFor(declaring, issuer, metadata)
    } catch (error) {
      const why = error instanceof SourceUnavailable ? error.message : 'the server cannot be reached'
      this.deps.logger.warn({ source: declaring.name, why }, 'a sign-in could not start: the source is unavailable')
      throw new ConnectionError(why, 'source-unavailable')
    }
    await this.store.kv.set(`oauth-source-issuer:${declaring.name}`, issuer)
    // the scopes: the agent-pack's when it declares them (`[]`: none), else the challenge's, else the server's metadata's,
    // with offline_access when the authorization server lists it; and, for an account that asked for more, those too
    const declared = oauth.scopes
    let scopes = declared ?? discovery.challengeScopes ?? discovery.scopesSupported ?? []
    if (!declared && metadata.scopes_supported?.includes('offline_access') && !scopes.includes('offline_access'))
      scopes = [...scopes, 'offline_access']
    const binding = this.bindingOf(declaring)
    const held = await this.store.personalAccounts.find(
      principal.id,
      declaring.name,
      binding ? place.expected?.value : undefined
    )
    if (held?.moreAccess) {
      const secret = await this.openSecret(held)
      for (const scope of secret?.tokens?.wantedScopes ?? []) if (!scopes.includes(scope)) scopes = [...scopes, scope]
    }
    // the value asked at the sign-in, where the service allows it (D110, layer a)
    let resource = discovery.resource
    const extra: Record<string, string> = {}
    const request = oauth.bindingRequest
    if (request && place.expected) {
      if (request.parameter) extra[request.parameter] = place.expected.value
      if (request.resource) resource = request.resource.replace(/\{value\}/g, encodeURIComponent(place.expected.value))
    }
    // a new start of the same source for the same value ends the attempt that waits (TOOL-OAUTH-005)
    for (const waiting of await this.store.oauthAttempts.listWaiting())
      if (
        waiting.principalId === principal.id &&
        waiting.sourceId === declaring.name &&
        (waiting.expectedBinding?.value ?? '') === (place.expected?.value ?? '')
      )
        await this.endAttempt(waiting, 'cancelled')
    const { verifier, challenge } = pkcePair()
    const { state, hash } = newState()
    const keyRef = this.deps.crypto.newWrappedKey()
    const now = Date.now()
    const attempt: OAuthAttemptRecord = {
      id: prefixedId('att'),
      principalId: principal.id,
      originSessionId: session.id,
      sourceId: declaring.name,
      ...(place.spaceId ? { spaceId: place.spaceId } : {}),
      stateHash: hash,
      ...(place.expected ? { expectedBinding: place.expected } : {}),
      issuer,
      issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
      resource,
      scopes,
      clientRef: client.ref,
      verifierCipher: sealJson(this.deps.crypto, keyRef, { verifier }).cipher.toString('base64'),
      encKeyRef: keyRef,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.deps.attemptSeconds ?? DEFAULT_ATTEMPT_SECONDS) * 1000).toISOString(),
    }
    await this.store.oauthAttempts.save(attempt)
    const authorizationUrl = this.deps.oauth.authorizationUrl(metadata, {
      clientId: client.credentials.clientId,
      redirectUri: this.callbackUrl,
      state,
      challenge,
      resource,
      scopes,
      extra,
    })
    this.deps.logger.info(
      { principalId: principal.id, source: declaring.name, attemptId: attempt.id },
      'a sign-in of a person own account started'
    )
    return { attemptId: attempt.id, authorizationUrl, expiresAt: attempt.expiresAt }
  }

  /** `DELETE {sessions}/connections/attempts/{attemptId}` (PROF-TOOL-015): ended as cancelled; false when it does not wait. */
  public async cancelAttempt(principal: Principal, attemptId: string): Promise<boolean> {
    const attempt = await this.store.oauthAttempts.get(attemptId)
    if (!attempt || attempt.principalId !== principal.id || attempt.outcome) return false
    return this.endAttempt(attempt, 'cancelled')
  }

  /** Ends an attempt that waits, once: its outcome is told and audited; false when another ended it first. */
  private async endAttempt(
    attempt: OAuthAttemptRecord,
    outcome: OAuthAttemptOutcome,
    extra: { expected?: string; chosen?: string; claimed?: boolean; value?: string } = {}
  ): Promise<boolean> {
    if (!extra.claimed && !(await this.store.oauthAttempts.claim(attempt.id, outcome, nowIso()))) return false
    if (extra.claimed) await this.store.oauthAttempts.save({ ...attempt, outcome, endedAt: nowIso() })
    // the verifier goes with it: nothing of a sign-in that ended can be used again
    const ended = await this.store.oauthAttempts.get(attempt.id)
    if (ended) await this.store.oauthAttempts.save({ ...ended, verifierCipher: '', encKeyRef: '' })
    await this.audit(attempt.principalId, attempt.sourceId, attempt.expectedBinding?.value, `attempt-${outcome}`)
    const declaring = this.declared(attempt.sourceId)
    if (declaring)
      await this.announce(attempt.principalId, declaring, extra.value ?? attempt.expectedBinding?.value, {
        attemptId: attempt.id,
        outcome,
        ...(extra.expected !== undefined ? { expected: extra.expected } : {}),
        ...(extra.chosen !== undefined ? { chosen: extra.chosen } : {}),
      })
    return true
  }

  /** Attempts whose time is over and that nobody ended: ended as expired (TOOL-OAUTH-005). */
  public async expireAttempts(): Promise<number> {
    let n = 0
    const now = nowIso()
    for (const attempt of await this.store.oauthAttempts.listWaiting())
      if (attempt.expiresAt <= now && (await this.endAttempt(attempt, 'expired'))) n++
    return n
  }

  /** Where the browser goes after a sign-in (PROF-LINK-004): Your accounts of the agent, with no parameter. */
  private returnLink(): string | undefined {
    const base = this.deps.appLinkBase
    if (!base) return undefined
    return `${base.replace(/\/*$/, '/')}service/${this.deps.agentDid()}/accounts`
  }

  private finished(): CallbackAnswer {
    const location = this.returnLink()
    if (location) return { status: 303, location }
    return { status: 200, page: page('Back to Ayni', 'You can close this window and go back to Ayni.') }
  }

  /**
   * `GET {PUBLIC_BASE_URL}/tools/oauth/callback` (TOOL-OAUTH-006): the attempt of the `state`, once; the issuer of the
   * response checked (RFC 9207); the code exchanged with the verifier and the `resource`; the account checked (D110), then
   * sealed. The browser goes on to Your accounts, with nothing of the outcome; the person's sessions are told it.
   */
  public async callback(query: Record<string, unknown>): Promise<CallbackAnswer> {
    const expired = (): CallbackAnswer => ({
      status: 400,
      page: page('This sign-in has expired', 'Nothing was changed. Start again from Your accounts in Ayni.'),
    })
    const state = typeof query.state === 'string' ? query.state : ''
    if (!state) return expired()
    const attempt = await this.store.oauthAttempts.findByStateHash(stateHash(state))
    if (!attempt || attempt.outcome || attempt.expiresAt <= nowIso()) return expired()
    // one use: only the first request takes it; it stays `failed` unless it connects or ends otherwise
    if (!(await this.store.oauthAttempts.claim(attempt.id, 'failed', nowIso()))) return expired()
    const end = async (
      outcome: OAuthAttemptOutcome,
      extra: { expected?: string; chosen?: string; value?: string } = {}
    ) => {
      await this.endAttempt(attempt, outcome, { ...extra, claimed: true })
      return this.finished()
    }
    const declaring = this.declared(attempt.sourceId)
    const principal = await this.principal(attempt.principalId)
    if (!declaring || !principal) return end('failed')
    // the issuer of the response (RFC 9207 §2.4): refused before anything of the response is acted on or shown
    const iss = typeof query.iss === 'string' ? query.iss : undefined
    if (iss !== undefined ? iss !== attempt.issuer : attempt.issParameterSupported) {
      this.deps.logger.warn(
        { attemptId: attempt.id, source: attempt.sourceId },
        'a sign-in answered from another issuer: refused'
      )
      return end('failed')
    }
    if (typeof query.error === 'string') return end(query.error === 'access_denied' ? 'denied' : 'failed')
    const code = typeof query.code === 'string' ? query.code : ''
    if (!code) return end('failed')
    let tokens: TokenSet
    let metadata: AuthorizationServerMetadata
    let credentials: ClientCredentials
    try {
      const verifier = openJson<{ verifier: string }>(
        this.deps.crypto,
        attempt.encKeyRef,
        Buffer.from(attempt.verifierCipher, 'base64')
      ).verifier
      metadata = await this.metadataOf(attempt.issuer)
      credentials = await this.credentialsFor(declaring, attempt.clientRef)
      tokens = await this.deps.oauth.exchange(metadata, credentials, {
        code,
        verifier,
        redirectUri: this.callbackUrl,
        resource: attempt.resource,
      })
    } catch (error) {
      this.deps.logger.warn(
        {
          attemptId: attempt.id,
          source: attempt.sourceId,
          why: error instanceof OAuthRefused ? error.code : 'unavailable',
        },
        'a sign-in code could not be exchanged'
      )
      return end('failed')
    }
    const secret: PersonalAccountSecret = {
      tokens: {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
        scopes: tokens.scopes ?? attempt.scopes,
        wantedScopes: attempt.scopes,
        issuer: attempt.issuer,
        clientRef: attempt.clientRef,
        resource: attempt.resource,
      },
    }
    const checked = await this.check(principal, declaring, secret, attempt.expectedBinding)
    if (!checked.ok) {
      // nothing of a refused account is kept: its tokens are revoked where the service allows it, and forgotten
      await this.revokeTokens(metadata, credentials, secret, REVOKE_WAIT_MS)
      return end(checked.outcome, {
        ...(checked.expected ? { expected: checked.expected } : {}),
        ...(checked.chosen ? { chosen: checked.chosen } : {}),
      })
    }
    const record = await this.seal(principal, declaring, 'oauth', secret, checked)
    return end('connected', record.bindingValue !== undefined ? { value: record.bindingValue } : {})
  }

  // ---- connecting with fields (TOOL-CONN-005) -----------------------------------------------------------------------

  /**
   * `PUT {sessions}/connections/{source}/account` (TOOL-CONN-005): the values of the fields checked as a space's account's
   * are, the account checked when its source declares a check, then sealed: connected at once, with no phone.
   */
  public async setFields(
    principal: Principal,
    sourceId: string,
    values: unknown,
    spaceId: unknown
  ): Promise<ConnectionView> {
    const declaring = this.declared(sourceId)
    if (!declaring) throw new ConnectionError('this source cannot be connected', 'not-found')
    const place = await this.placeOf(principal, declaring, spaceId)
    if (!declaring.account.fields)
      throw new ConnectionError('this source connects with a sign-in, not fields', 'not-fields')
    if (!this.spaceTools) throw new ConnectionError('this source cannot be connected', 'not-found')
    const checkedValues = this.spaceTools.checkValues(declaring.account.fields, values)
    const secret: PersonalAccountSecret = { values: checkedValues }
    const checked = await this.check(principal, declaring, secret, place.expected)
    if (!checked.ok) {
      if (checked.outcome === 'wrong-binding')
        throw new ConnectionError('the account is for another value', 'wrong-binding', undefined, {
          ...(checked.expected ? { expected: checked.expected } : {}),
          ...(checked.chosen ? { chosen: checked.chosen } : {}),
        })
      if (checked.outcome === 'wrong-person')
        throw new ConnectionError('the account is not the person own by the email of the directory', 'wrong-person')
      throw new ConnectionError('the account could not be checked at the service', 'source-unavailable')
    }
    const record = await this.seal(principal, declaring, 'fields', secret, checked)
    return this.itemFor(principal, declaring, record.bindingValue)
  }

  // ---- the check (D110, TOOL-CONN-013) -----------------------------------------------------------------------------

  /**
   * The read a source declares, once, with the new account, in code, outside any conversation and with no call record:
   * the value of the binding and its name, compared with the one expected; the email, compared with the directory's; the
   * label. Nothing of the read reaches the model, a conversation or a log beyond the outcome.
   */
  private async check(
    principal: Principal,
    declaring: CatalogSource,
    secret: PersonalAccountSecret,
    expected: { value: string; label?: string } | undefined
  ): Promise<
    | { ok: true; value?: string; valueLabel?: string; label?: string }
    | { ok: false; outcome: 'wrong-binding' | 'wrong-person' | 'failed'; expected?: string; chosen?: string }
  > {
    const check: AccountCheck | undefined = declaring.account.check
    if (!check)
      return {
        ok: true,
        ...(expected ? { value: expected.value, ...(expected.label ? { valueLabel: expected.label } : {}) } : {}),
      }
    let doc: unknown
    try {
      doc = await this.readCheck(declaring, check, secret)
    } catch (error) {
      this.deps.logger.warn(
        { source: declaring.name, why: error instanceof Error ? error.name : 'error' },
        'the check of an account could not be read'
      )
      return { ok: false, outcome: 'failed' }
    }
    if (doc === undefined) return { ok: false, outcome: 'failed' }
    let value: string | undefined
    let valueLabel: string | undefined
    if (check.binding) {
      value = textAt(doc, check.binding.value)
      valueLabel = textAt(doc, check.binding.label)
      if (value === undefined) return { ok: false, outcome: 'failed' }
      if (expected && value !== expected.value)
        return {
          ok: false,
          outcome: 'wrong-binding',
          expected: expected.label ?? expected.value,
          chosen: valueLabel ?? value,
        }
    }
    if (check.email !== undefined) {
      const own = this.deps.directoryEmail?.(principal)
      if (!own) return { ok: false, outcome: 'wrong-person' }
      const email = textAt(doc, check.email)
      if (email === undefined) return { ok: false, outcome: 'failed' }
      if (email.toLowerCase() !== own.toLowerCase()) return { ok: false, outcome: 'wrong-person' }
    }
    const label = labelFrom(check.label, doc)
    return {
      ok: true,
      ...(value !== undefined ? { value } : {}),
      ...(valueLabel !== undefined ? { valueLabel } : {}),
      ...(label ? { label } : {}),
    }
  }

  /** The result of the check's tool: its structured content, else its first text read as JSON (TOOL-CONN-013). */
  private async readCheck(
    declaring: CatalogSource,
    check: AccountCheck,
    secret: PersonalAccountSecret
  ): Promise<unknown> {
    const headers = secret.tokens
      ? { Authorization: `Bearer ${secret.tokens.accessToken}` }
      : buildAccountHeaders(declaring.account, secret.values ?? {})
    const url = secret.tokens?.resource ?? declaring.url
    const result = await this.deps.registry.checkRead(declaring.name, {
      url: url as string,
      headers,
      tool: check.tool,
    })
    if (!result) return undefined
    // a check reads: a tool the agent-pack declares nothing of is taken by its annotations (TOOL-CAT-017)
    const declared = declaring.tools[check.tool]?.effect
    if (declaring.kind === 'mcp' && !declared && effectFromAnnotations(result.annotations) !== 'read') return undefined
    if (result.structured !== undefined && result.structured !== null) return result.structured
    try {
      return JSON.parse(result.text)
    } catch {
      return undefined
    }
  }

  // ---- keeping an account (D106, TOOL-ACCESS-009) -------------------------------------------------------------------

  /** The person's key, made at their first account: wrapped by the master key (PRIV-ERASE-013). */
  private async personKey(principalId: string): Promise<string> {
    const kept = await this.store.personKeys.get(principalId)
    if (kept) return kept.wrappedKey
    const saved = await this.store.personKeys.saveIfAbsent({
      principalId,
      wrappedKey: this.deps.crypto.newWrappedKey(),
      createdAt: nowIso(),
    })
    return saved.wrappedKey
  }

  /** What an account seals, opened in memory: undefined when its key or the person's is gone. */
  private async openSecret(record: PersonalAccountRecord): Promise<PersonalAccountSecret | undefined> {
    if (!record.encKeyRef || !record.cipher) return undefined
    const person = await this.store.personKeys.get(record.principalId)
    if (!person) return undefined
    try {
      return openUnder<PersonalAccountSecret>(
        this.deps.crypto,
        person.wrappedKey,
        record.encKeyRef,
        Buffer.from(record.cipher, 'base64')
      )
    } catch {
      return undefined
    }
  }

  /**
   * Seals a new account under a key of its own, wrapped by the person's key, in place of the one held for the same
   * value, whose key goes with its row (TOOL-CONN-002): a Reconnect replaces the account only once it succeeds.
   */
  private async seal(
    principal: Principal,
    declaring: CatalogSource,
    method: 'oauth' | 'fields',
    secret: PersonalAccountSecret,
    checked: { value?: string; valueLabel?: string; label?: string }
  ): Promise<PersonalAccountRecord> {
    const binding = this.bindingOf(declaring)
    const value = binding ? checked.value : undefined
    const person = await this.personKey(principal.id)
    const keyRef = newKeyUnder(this.deps.crypto, person)
    const former = await this.store.personalAccounts.find(principal.id, declaring.name, value)
    const record: PersonalAccountRecord = {
      id: prefixedId('acc'),
      principalId: principal.id,
      sourceId: declaring.name,
      ...(value !== undefined ? { bindingValue: value } : {}),
      ...(binding && checked.valueLabel ? { bindingLabel: checked.valueLabel } : {}),
      method,
      state: 'connected',
      cipher: sealUnder(this.deps.crypto, person, keyRef, secret).toString('base64'),
      ...(checked.label
        ? { labelCipher: sealUnder(this.deps.crypto, person, keyRef, { label: checked.label }).toString('base64') }
        : {}),
      encKeyRef: keyRef,
      packDigest: packDigestOf(declaring),
      scopesDigest: scopesDigestOf(declaring.account),
      connectedAt: nowIso(),
    }
    await this.store.personalAccounts.save(record)
    if (former) {
      await this.hooks.accountEnded?.(former.id)
      await this.hooks.endAllowances?.(
        principal.id,
        this.consumersOf(declaring).map((s) => s.name)
      )
    }
    this.deps.logger.info(
      { principalId: principal.id, source: declaring.name, accountId: record.id, replaced: !!former },
      'a person own account connected'
    )
    await this.audit(principal.id, declaring.name, value, former ? 'replaced' : 'connected')
    await this.announce(principal.id, declaring, value, {})
    return record
  }

  /** An account to reconnect: its tokens destroyed, its key with them, its state and reason kept (TOOL-OAUTH-008/010). */
  private async toReconnect(record: PersonalAccountRecord, reason: ReconnectReason): Promise<void> {
    const current = await this.store.personalAccounts.get(record.id)
    if (!current || current.state === 'reconnect') return
    const { labelCipher: _label, ...rest } = current
    if (
      !(await this.store.personalAccounts.update({
        ...rest,
        state: 'reconnect',
        reason,
        moreAccess: false,
        cipher: '',
        encKeyRef: '',
      }))
    )
      return
    await this.hooks.accountEnded?.(record.id)
    this.deps.logger.info(
      { principalId: record.principalId, source: record.sourceId, reason },
      'a person own account must reconnect'
    )
    await this.audit(record.principalId, record.sourceId, record.bindingValue, `reconnect-${reason}`)
    const declaring = this.declared(record.sourceId)
    if (declaring) await this.announce(record.principalId, declaring, record.bindingValue, {})
  }

  // ---- disconnecting, and the end of an account (TOOL-CONN-006, 008, 009) -----------------------------------------

  /** Asks the authorization server to revoke an account's tokens, the refresh token first (RFC 7009, TOOL-CONN-006). */
  private async revokeTokens(
    metadata: AuthorizationServerMetadata,
    credentials: ClientCredentials,
    secret: PersonalAccountSecret,
    waitMs: number
  ): Promise<void> {
    const tokens = secret.tokens
    if (!tokens || !metadata.revocation_endpoint) return
    const end = Date.now() + waitMs
    if (tokens.refreshToken)
      await this.deps.oauth.revoke(
        metadata,
        credentials,
        tokens.refreshToken,
        'refresh_token',
        Math.max(1, end - Date.now())
      )
    await this.deps.oauth.revoke(
      metadata,
      credentials,
      tokens.accessToken,
      'access_token',
      Math.max(1, end - Date.now())
    )
  }

  /** Revokes an account's tokens at its service, as far as its metadata allows, within the time given. */
  private async revokeAccount(record: PersonalAccountRecord, waitMs: number): Promise<void> {
    const secret = await this.openSecret(record)
    if (secret) await this.revokeSecret(record, secret, waitMs)
  }

  private async revokeSecret(
    record: PersonalAccountRecord,
    secret: PersonalAccountSecret,
    waitMs: number
  ): Promise<void> {
    const declaring = this.declared(record.sourceId)
    if (!declaring || !secret.tokens) return
    try {
      const metadata = await this.metadataOf(secret.tokens.issuer)
      const credentials = await this.credentialsFor(declaring, secret.tokens.clientRef)
      await this.revokeTokens(metadata, credentials, secret, waitMs)
    } catch {
      // the service could not be asked: the account's key is destroyed all the same
    }
  }

  /**
   * `DELETE {sessions}/connections/accounts/{accountId}` (TOOL-CONN-006): revoked at the service where it allows, within five
   * seconds; then its key destroyed, its attempt ended, its connection closed and the allowances of its tools ended.
   */
  public async disconnect(principal: Principal, accountId: string): Promise<ConnectionView> {
    const record = await this.store.personalAccounts.get(accountId)
    const declaring = record ? this.deps.catalog.source(record.sourceId) : undefined
    if (!record || record.principalId !== principal.id || !declaring)
      throw new ConnectionError('no such account', 'not-found')
    await this.revokeAccount(record, REVOKE_WAIT_MS)
    await this.store.personalAccounts.delete(record.id)
    await this.hooks.accountEnded?.(record.id)
    for (const waiting of await this.store.oauthAttempts.listWaiting())
      if (
        waiting.principalId === principal.id &&
        waiting.sourceId === record.sourceId &&
        (waiting.expectedBinding?.value ?? '') === (record.bindingValue ?? '')
      )
        await this.endAttempt(waiting, 'cancelled')
    await this.hooks.endAllowances?.(
      principal.id,
      this.consumersOf(declaring).map((s) => s.name)
    )
    this.deps.logger.info(
      { principalId: principal.id, source: record.sourceId, accountId },
      'a person own account disconnected'
    )
    await this.audit(principal.id, record.sourceId, record.bindingValue, 'disconnected')
    await this.announce(principal.id, declaring, record.bindingValue, { outcome: 'disconnected', accountId: record.id })
    return this.itemFor(principal, declaring, record.bindingValue)
  }

  /**
   * The end of a person's access (TOOL-CONN-008, PRIV-ERASE-013): their accounts revoked without waiting on the services,
   * their attempts ended, and their key destroyed, with every account it wraps, at once.
   */
  public async endPerson(principalId: string): Promise<number> {
    const accounts = await this.store.personalAccounts.listByPrincipal(principalId)
    // the tokens are opened before the key goes, and their revocation asked of the services in the background: the key is
    // destroyed now, whatever they answer
    const opened = await Promise.all(
      accounts.map(async (record) => ({ record, secret: await this.openSecret(record) }))
    )
    for (const { record, secret } of opened) if (secret) void this.revokeSecret(record, secret, REVOKE_WAIT_MS)
    for (const waiting of await this.store.oauthAttempts.listWaiting())
      if (waiting.principalId === principalId) await this.endAttempt(waiting, 'cancelled')
    await this.store.personKeys.delete(principalId)
    for (const record of accounts) {
      await this.store.personalAccounts.delete(record.id)
      await this.hooks.accountEnded?.(record.id)
      await this.audit(principalId, record.sourceId, record.bindingValue, 'ended')
    }
    if (accounts.length)
      this.deps.logger.info(
        { principalId, accounts: accounts.length },
        'the access of a person ended: their accounts with it'
      )
    return accounts.length
  }

  /**
   * At start (TOOL-CONN-009): an account whose source the agent-pack no longer declares as it did ends, revoked; one whose
   * source asks other scopes goes to reconnect. One whose source is no longer available to its person is kept.
   */
  public async align(): Promise<void> {
    for (const record of await this.store.personalAccounts.listAll()) {
      const declaring = this.declared(record.sourceId)
      if (!declaring || packDigestOf(declaring) !== record.packDigest) {
        await this.revokeAccount(record, REVOKE_WAIT_MS)
        await this.store.personalAccounts.delete(record.id)
        await this.audit(record.principalId, record.sourceId, record.bindingValue, 'ended')
        this.deps.logger.info(
          { principalId: record.principalId, source: record.sourceId },
          'a person own account ended: its source connects otherwise now'
        )
        continue
      }
      if (record.state === 'connected' && scopesDigestOf(declaring.account) !== record.scopesDigest)
        await this.toReconnect(record, 'changed')
    }
  }

  // ---- the account of a conversation, and of a call (TOOL-CONN-014, TOOL-CALL-011) -------------------------------

  /** The value of a declaring source's binding in force in a conversation: its space's, or the agent-pack's (TOOL-CONN-014). */
  public async valueInForce(
    declaring: CatalogSource,
    consumer: CatalogSource,
    spaceId: string
  ): Promise<{ value?: string; label?: string; unbound?: boolean }> {
    const binding = this.bindingOf(declaring)
    if (!binding) return {}
    if (binding.value !== undefined) return { value: binding.value }
    if (consumer.availability !== 'spaces' || isPersonalSpace(spaceId)) return { unbound: true }
    const record = await this.store.spaceTools.get(spaceId, consumer.name)
    const value = record?.bindings[binding.name]
    if (value === undefined) return { unbound: true }
    return { value, ...(record?.bindingLabels?.[binding.name] ? { label: record.bindingLabels[binding.name] } : {}) }
  }

  /** The account a source uses for the Principal in a conversation, connected or not (TOOL-CONN-014). */
  public async accountIn(
    principal: Principal,
    source: CatalogSource,
    spaceId: string
  ): Promise<{ declaring: CatalogSource; record?: PersonalAccountRecord; value?: string; label?: string } | undefined> {
    const declaring = this.declaringOf(source)
    if (!declaring) return undefined
    const { value, label, unbound } = await this.valueInForce(declaring, source, spaceId)
    if (unbound) return { declaring }
    const record = await this.store.personalAccounts.find(principal.id, declaring.name, value)
    return {
      declaring,
      ...(record ? { record } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(label ? { label } : {}),
    }
  }

  /** Whether the Principal's account of a source is connected for a conversation of a space (TOOL-SPACE-012). */
  public async connectedIn(principal: Principal, source: CatalogSource, spaceId: string): Promise<boolean> {
    return (await this.accountIn(principal, source, spaceId))?.record?.state === 'connected'
  }

  /**
   * The account a call of the Principal runs with, opened in memory for this call (TOOL-ACCESS-010, TOOL-CALL-011): the
   * headers built from its fields, or a handle that gives the access token, refreshed when it is about to expire.
   */
  public async open(principal: Principal, source: CatalogSource, spaceId: string, use = true): Promise<OpenedAccount> {
    const found = await this.accountIn(principal, source, spaceId)
    const record = found?.record
    if (!found || !record) return { status: 'not-connected' }
    if (record.state !== 'connected') return { status: 'reconnect' }
    const secret = await this.openSecret(record)
    if (!secret) return { status: 'not-connected' }
    // when it was last used, for Your accounts: a call, and not the discovery of a server's tools
    if (use) await this.store.personalAccounts.touch(record.id, nowIso())
    if (secret.values) {
      if (!fitsFields(found.declaring.account.fields ?? [], secret.values)) return { status: 'not-connected' }
      const headers = buildAccountHeaders(found.declaring.account, secret.values)
      return {
        status: 'connected',
        record,
        account: { kind: 'personal', accountId: record.id, headers, secrets: accountSecrets(secret.values, headers) },
      }
    }
    if (!secret.tokens) return { status: 'not-connected' }
    return {
      status: 'connected',
      record,
      account: {
        kind: 'personal',
        accountId: record.id,
        oauth: new OAuthHandle(this, record.id, secret.tokens.resource, secret.tokens.accessToken),
      },
    }
  }

  /** The label of the Principal's account a source uses in a conversation: for the person's own cards (PROF-TOOL-021). */
  public async labelIn(principal: Principal, source: CatalogSource, spaceId: string): Promise<string | undefined> {
    const record = (await this.accountIn(principal, source, spaceId))?.record
    return record ? this.labelOf(record) : undefined
  }

  /** What the allowance of a call records of its account: a new account ends it (TOOL-CALL-006). */
  public async fingerprintIn(
    principal: Principal,
    source: CatalogSource,
    spaceId: string
  ): Promise<string | undefined> {
    const record = (await this.accountIn(principal, source, spaceId))?.record
    return record ? `${record.id}@${record.connectedAt}` : undefined
  }

  /**
   * The access token of an account for a call (TOOL-OAUTH-008, TOOL-OAUTH-010): refreshed when it expires within a minute,
   * or once more after the server refused one that had not expired; one refresh at a time per account, the rotated refresh
   * token kept before the new access token is used. A server that names another authorization server than the account's
   * gets no token, and the account goes to reconnect.
   */
  public async accessToken(accountId: string, after401?: string): Promise<string> {
    return this.serial(accountId, async () => {
      const record = await this.store.personalAccounts.get(accountId)
      if (record?.state !== 'connected') throw new AccountNotConnected(record ? 'reconnect' : 'not-connected')
      const secret = await this.openSecret(record)
      const tokens = secret?.tokens
      const declaring = this.declared(record.sourceId)
      if (!secret || !tokens || !declaring) throw new AccountNotConnected()
      // the server names another authorization server: the account's token never goes there, nor anywhere (TOOL-OAUTH-010)
      let discovery: Discovery | undefined
      try {
        discovery = await this.discoveryOf(declaring, after401 !== undefined)
      } catch {
        // the metadata cannot be read now: the token stays with its own server
      }
      if (discovery) {
        const client = declaring.account.oauth?.client
        const wanted = client?.registration === 'pre-registered' ? client.issuer : discovery.authorizationServers[0]
        if (wanted !== tokens.issuer || !discovery.authorizationServers.includes(tokens.issuer)) {
          await this.toReconnect(record, 'changed')
          throw new AccountNotConnected('reconnect')
        }
      }
      // another call refreshed it meanwhile: its token is the new one
      if (after401 !== undefined && after401 !== tokens.accessToken) return tokens.accessToken
      const expiring = tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) - Date.now() <= REFRESH_BEFORE_MS
      if (after401 === undefined && !expiring) return tokens.accessToken
      const reason: ReconnectReason = after401 !== undefined && !expiring ? 'revoked' : 'expired'
      if (!tokens.refreshToken) {
        await this.toReconnect(record, reason)
        throw new AccountNotConnected('reconnect')
      }
      let fresh: TokenSet
      try {
        const metadata = await this.metadataOf(tokens.issuer)
        const credentials = await this.credentialsFor(declaring, tokens.clientRef)
        fresh = await this.deps.oauth.refresh(metadata, credentials, {
          refreshToken: tokens.refreshToken,
          resource: tokens.resource,
        })
      } catch (error) {
        if (error instanceof OAuthRefused) {
          this.deps.logger.info({ accountId, source: record.sourceId, why: error.code }, 'a refresh was refused')
          await this.toReconnect(record, reason)
          throw new AccountNotConnected('reconnect')
        }
        throw new SourceUnavailable('the authorization server cannot be reached to refresh the account')
      }
      // the refresh token the service returns replaces the one held, before the new access token is used
      const { expiresAt: _former, ...kept } = tokens
      const next: PersonalAccountSecret = {
        ...secret,
        tokens: {
          ...kept,
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken ?? tokens.refreshToken,
          ...(fresh.expiresAt ? { expiresAt: fresh.expiresAt } : {}),
          ...(fresh.scopes ? { scopes: fresh.scopes } : {}),
        },
      }
      const person = await this.store.personKeys.get(record.principalId)
      // the account was replaced, disconnected or ended during the refresh: nothing of it is written back
      if (
        !person ||
        !(await this.store.personalAccounts.update({
          ...((await this.store.personalAccounts.get(accountId)) ?? record),
          cipher: sealUnder(this.deps.crypto, person.wrappedKey, record.encKeyRef, next).toString('base64'),
          refreshedAt: nowIso(),
        }))
      )
        throw new AccountNotConnected()
      this.deps.logger.info({ accountId, source: record.sourceId }, 'a person own account refreshed')
      return fresh.accessToken
    })
  }

  /** The server refused the token a refresh just gave: the account goes to reconnect (TOOL-OAUTH-008). */
  public async refusedFresh(accountId: string): Promise<void> {
    await this.serial(accountId, async () => {
      const record = await this.store.personalAccounts.get(accountId)
      if (record) await this.toReconnect(record, 'revoked')
    })
  }

  /**
   * The server asked for more scopes (TOOL-OAUTH-009): the account says so and keeps its tokens; its next attempt asks the
   * scopes it asked and those of the challenge.
   */
  public async moreAccess(accountId: string, scopes: string[]): Promise<void> {
    await this.serial(accountId, async () => {
      const record = await this.store.personalAccounts.get(accountId)
      const secret = record ? await this.openSecret(record) : undefined
      if (!record || !secret?.tokens) return
      const wanted = [...new Set([...(secret.tokens.wantedScopes ?? secret.tokens.scopes), ...scopes])]
      const person = await this.store.personKeys.get(record.principalId)
      if (!person) return
      await this.store.personalAccounts.update({
        ...record,
        moreAccess: true,
        cipher: sealUnder(this.deps.crypto, person.wrappedKey, record.encKeyRef, {
          ...secret,
          tokens: { ...secret.tokens, wantedScopes: wanted },
        }).toString('base64'),
      })
      await this.audit(record.principalId, record.sourceId, record.bindingValue, 'more-access')
      const declaring = this.declared(record.sourceId)
      if (declaring) await this.announce(record.principalId, declaring, record.bindingValue, {})
    })
  }

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve()
    const run = before.then(work, work)
    const settled = run.catch(() => undefined)
    this.locks.set(key, settled)
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key)
    })
    return run
  }

  // ---- what the model knows, and the Connect card (TOOL-CONN-010, 011) --------------------------------------------

  /**
   * The personal sources available in a conversation whose tools the Principal's roles give and whose account there is
   * `not-connected` or `reconnect`, in the order of `tools.sources`, one per account (TOOL-CONN-010).
   */
  public async toConnect(principal: Principal, spaceId: string, grants: ElevationGrant[] = []): Promise<ToConnect[]> {
    const personal = isPersonalSpace(spaceId)
    const access = personal ? undefined : await this.deps.spaces.access(principal, spaceId)
    const ready = access && !access.left && this.spaceTools ? await this.spaceTools.readyIn(access.space) : []
    const out: ToConnect[] = []
    const seen = new Set<string>()
    for (const source of this.personalSources()) {
      if (source.availability === 'personal' && !personal) continue
      if (source.availability === 'spaces') {
        const r = ready.find((x) => x.source.name === source.name)
        if (!r) continue
        if (access?.role === 'guest' && r.entry.guests !== true) continue
      }
      if (!(await this.givesATool(principal, source, grants))) continue
      const found = await this.accountIn(principal, source, spaceId)
      if (!found || found.record?.state === 'connected') continue
      const declaring = found.declaring
      const key = `${declaring.name}|${found.value ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const binding = this.bindingOf(declaring)
      out.push({
        source: declaring.name,
        title: declaring.title,
        ...(declaring.description ? { description: declaring.description.slice(0, DESCRIPTION_MAX) } : {}),
        method: declaring.account.oauth ? 'oauth' : 'fields',
        why: found.record?.state === 'reconnect' ? 'reconnect' : 'connect',
        ...(binding && found.value !== undefined
          ? { binding: { label: binding.label, value: found.value, valueLabel: found.label ?? null } }
          : {}),
        ...(source.availability === 'spaces' ? { spaceId } : {}),
        ...((feature) => (feature ? { feature: { id: feature.id, title: feature.title } } : {}))(
          this.deps.catalog.featureOf(source)
        ),
      })
    }
    return out
  }

  /** The record of the system the model reads of them, in the Principal's block (TOOL-CONN-010); none with nothing to connect. */
  public static record(lines: ToConnect[]): string | undefined {
    if (!lines.length) return undefined
    return [
      'Accounts this person can connect, with the tool offer_connection:',
      ...lines.map(
        (l) =>
          `- ${l.source}: ${l.title}${l.description ? `, ${l.description}` : ''}${l.binding ? ` (${l.binding.label}: ${l.binding.valueLabel ?? l.binding.value})` : ''} (${l.why === 'reconnect' ? 'to reconnect' : 'not connected'})`
      ),
    ].join('\n')
  }

  /**
   * The model's `offer_connection` (TOOL-CONN-011): the Connect card of a source the record lists, `connected` when the
   * account is now, `not-available` for another, `unavailable` when no session of the conversation can show the card.
   */
  public async offer(
    principal: Principal,
    session: Session,
    spaceId: string,
    sourceId: string,
    show: (card: ToConnect) => Promise<void>
  ): Promise<'shown' | 'connected' | 'not-available' | 'unavailable'> {
    const source = this.deps.catalog.source(sourceId)
    const lines = await this.toConnect(principal, spaceId)
    const line = lines.find((l) => l.source === sourceId || (source && this.declaringOf(source)?.name === l.source))
    if (!line) {
      if (source && (await this.connectedIn(principal, source, spaceId))) return 'connected'
      const declaring = this.declared(sourceId)
      if (declaring)
        for (const consumer of this.consumersOf(declaring))
          if (await this.connectedIn(principal, consumer, spaceId)) return 'connected'
      return 'not-available'
    }
    const conversationId = session.conversationId ?? session.id
    const capable = (await this.hooks.connectSessions?.(conversationId)) ?? []
    if (!capable.length) return 'unavailable'
    await show(line)
    return 'shown'
  }

  /** The owner's own accounts of a source: the values a binding may take in a space (TOOL-SPACE-013). */
  public async choicesOf(
    principal: Principal,
    source: CatalogSource
  ): Promise<{ value: string; valueLabel: string | null }[]> {
    const declaring = this.declaringOf(source)
    if (!declaring || !this.bindingOf(declaring)) return []
    return (await this.store.personalAccounts.listByPrincipal(principal.id))
      .filter((r) => r.sourceId === declaring.name && r.state === 'connected' && r.bindingValue !== undefined)
      .map((r) => ({ value: r.bindingValue as string, valueLabel: r.bindingLabel ?? null }))
  }

  /** The binding of a source that a personal account is for, if any (D110): what the owner sets from an account of theirs. */
  public accountBindingOf(source: CatalogSource): string | undefined {
    const declaring = this.declaringOf(source)
    return declaring && declaring.name === source.name ? declaring.account.binding : undefined
  }

  // ---- the events and the audit (TOOL-CONN-007) ---------------------------------------------------------------------

  private async principal(id: string): Promise<Principal | undefined> {
    return this.store.principals.get(id)
  }

  /** `ayni.connections.changed` for an account, or an attempt, of the Principal (PROF-TOOL-019). */
  private async announce(
    principalId: string,
    declaring: CatalogSource,
    value: string | undefined,
    extra: Pick<ConnectionsChanged, 'attemptId' | 'outcome' | 'expected' | 'chosen' | 'accountId'>
  ): Promise<void> {
    const binding = this.bindingOf(declaring)
    const record = await this.store.personalAccounts.find(principalId, declaring.name, binding ? value : undefined)
    const label = record ? await this.labelOf(record) : undefined
    const event: ConnectionsChanged = {
      source: declaring.name,
      ...(binding && (record?.bindingValue ?? value) !== undefined
        ? { binding: { value: (record?.bindingValue ?? value) as string, valueLabel: record?.bindingLabel ?? null } }
        : {}),
      state: record?.state ?? 'not-connected',
      ...(record?.reason ? { reason: record.reason } : {}),
      ...(record ? { moreAccess: record.moreAccess === true, accountId: record.id } : {}),
      ...(label ? { label } : {}),
      ...extra,
    }
    await this.hooks
      .announce?.(principalId, event)
      .catch((err) => this.deps.logger.warn({ err, principalId }, 'a change of a person account was not announced'))
  }

  /** One record of the admin audit per change of an account or an attempt: no token, value or label (TOOL-CONN-007). */
  private async audit(
    principalId: string,
    sourceId: string,
    bindingValue: string | undefined,
    what: string
  ): Promise<void> {
    await this.store.adminAudit.insert({
      id: prefixedId('adm'),
      ts: nowIso(),
      action: 'personal-account',
      actor: principalId,
      reason: what,
      detail: { principalId, sourceId, ...(bindingValue !== undefined ? { bindingValue } : {}), what },
    })
  }
}

/**
 * The handle a call of a person's OAuth account carries (TOOL-OAUTH-008): it gives the access token for the next request,
 * refreshed when it is about to expire; after a `401` to a token that had not expired, one refresh and one more try; it
 * tells what became of the account, so that the call answers `not-connected` or `more-access-needed` (TOOL-CALL-011).
 */
export class OAuthHandle implements PersonalOAuthHandle {
  public outcome?: 'not-connected' | 'more-access-needed'
  private readonly seen = new Set<string>()
  /** the token operations in progress */
  private readonly pending = new Set<Promise<unknown>>()

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work)
    )
    return work
  }

  public async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  public constructor(
    private readonly service: ConnectionService,
    public readonly accountId: string,
    /** the server the token is for: the only URL it is sent to (no token passthrough) */
    public readonly url: string,
    private current: string
  ) {
    this.seen.add(current)
  }

  public token(): Promise<string> {
    return this.track(this.fetchToken())
  }

  public after401(used: string): Promise<string | undefined> {
    return this.track(this.refreshAfter401(used))
  }

  private async fetchToken(): Promise<string> {
    try {
      this.current = await this.service.accessToken(this.accountId)
      this.seen.add(this.current)
      return this.current
    } catch (error) {
      if (error instanceof AccountNotConnected) this.outcome = 'not-connected'
      throw error
    }
  }

  private async refreshAfter401(used: string): Promise<string | undefined> {
    try {
      this.current = await this.service.accessToken(this.accountId, used)
      this.seen.add(this.current)
      return this.current
    } catch (error) {
      if (error instanceof AccountNotConnected) {
        this.outcome = 'not-connected'
        return undefined
      }
      throw error
    }
  }

  public refusedAgain(): Promise<void> {
    this.outcome = 'not-connected'
    return this.track(this.service.refusedFresh(this.accountId))
  }

  public insufficientScope(scopes: string[]): Promise<void> {
    this.outcome = 'more-access-needed'
    return this.track(this.service.moreAccess(this.accountId, scopes))
  }

  /** Every token this call held: what an echo in its result is scrubbed of (TOOL-ACCESS-010). */
  public secrets(): string[] {
    return [...this.seen]
  }
}
