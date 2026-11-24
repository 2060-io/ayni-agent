/** TypeScript view of schemas/agent-pack.schema.json (schema 3.0). Field names follow the schema. */

/** `conversation-private` replaces v3's `session-private`: visible to every session of the entry's conversation (D76) */
export type Visibility =
  | 'conversation-private'
  | 'principal-private'
  | 'organization-shared'
  | 'partner-shared'
  | 'public'
export type Relation = 'home' | 'partner' | 'unrecognized'
export type ConnectionType = 'verifiable-user-agent' | 'verifiable-service'
export type ToolNameOrStar = string

/**
 * A role: approval rights and flags, never a scope of conversation reads (RBAC-XSESS-005, decision 60): `crossSession`
 * is withdrawn and a pack that declares it is refused at start.
 */
/**
 * The admin interface's two roles (RBAC-XSESS-008), declared like any other role and given by the user directory:
 * `auditor` reads what the admin interface serves, `operator` erases, sets and releases legal hold and rotates keys.
 * Nothing but the admin interface reads them.
 */
export const ADMIN_ROLES = ['auditor', 'operator'] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export interface RoleDefinition {
  description?: string
  canApprove?: boolean
  auditor?: boolean
  /** the role reads the admin view of roles and of the changes of the user directory (IDENT-DIR-008, decision 61) */
  admin?: boolean
}

/**
 * The user directory (ayni-spec D79, IDENT-ROLE-012): the people of the home organization, in a file mounted from a
 * secret of the deployment and never written in the agent-pack. A relative path resolves from the pack directory.
 */
export interface UserDirectoryRef {
  file: string
}

export interface RoleRule {
  when: {
    relation?: Relation
    connectionType?: ConnectionType
    userAgentVerified?: boolean
    claims?: Record<string, string | string[]>
  }
  roles: string[]
  comment?: string
}

export interface CredentialRef {
  jsonSchemaCredentialId?: string
  credentialDefinitionId?: string
  attributes?: string[]
}

/**
 * The attributes of a document read, a closed list, the same for a passport and for an identity card
 * (D73, PRIV-EVID-012): what the machine-readable zone and the portrait of the chip give.
 */
export const DOCUMENT_ATTRIBUTES = [
  'documentType',
  'documentNumber',
  'issuingState',
  'nationality',
  'lastName',
  'firstName',
  'fullName',
  'dateOfBirth',
  'dateOfExpiry',
  'sex',
  'portrait',
] as const

/** What is kept of a piece of evidence and what the model may read of it (D67, PRIV-EVID-003). */
export interface EvidencePolicy {
  /** the attributes whose values are kept, sealed, and for how long; none by default */
  store?: {
    attributes: string[]
    /** days the values are kept (kept until erased when absent) and what happens then (`erase` by default) */
    retention?: { days?: number; onExpiry?: 'archive' | 'erase' }
  }
  /** the stored attributes the model may read; none by default */
  modelVisible?: string[]
}

export interface AuthenticationEntry extends EvidencePolicy {
  /** requested by its ecosystem schema, so that any accredited issuer satisfies the request */
  credential: { jsonSchemaCredentialId: string }
  /** the attributes that, with the issuer's organization and the schema, form the principal key */
  subjectKey: string[]
  /** the attributes asked of the credential; every attribute of the schema when omitted */
  attributes?: string[]
  /**
   * when it is asked: at connection (default), or only when it is asked for, by the person, from their wallet or
   * a menu item, or by the model's tool (D65, D72)
   */
  request?: 'on-connect' | 'on-demand'
  /**
   * whether a person may enter without the credential, as a guest (D72). `false` by default with `on-connect`:
   * nothing opens without it. `on-demand` lets guests in by itself, and refuses `false`.
   */
  guests?: boolean
  /** the organizations whose credentials are accepted, by organization key; any accredited issuer when absent */
  issuers?: { organizations?: string[] }
  /** how a person obtains the credential, in the operator's words, with a link when there is one */
  obtain?: { text?: string; url?: string }
}

/**
 * How an agent authenticates a person (D72, IDENT-RES-010): **required**, asked at connection and nothing opens
 * without it; **offered**, asked at connection and the person may enter as a guest instead; **on-request**,
 * nothing asked at connection and a guest authenticates when they ask.
 */
export type AuthenticationMode = 'required' | 'offered' | 'on-request'

export function authenticationModeOf(entry: AuthenticationEntry | undefined): AuthenticationMode | undefined {
  if (!entry) return undefined
  if (entry.request === 'on-demand') return 'on-request'
  return entry.guests ? 'offered' : 'required'
}

export interface OrganizationPattern {
  match: Partial<
    Record<'countryCode' | 'registryId' | 'legalJurisdiction' | 'organizationKind' | 'lei', string | string[]>
  >
  relation: 'partner' | 'unrecognized'
  roles?: string[]
  label?: string
}

/**
 * A credential the agent may ask for, beyond the one that authenticates (D69, INTX-PRES-001). What comes
 * back is evidence attached to the Principal of the connection; it never binds one.
 */
export interface PresentationEntry extends EvidencePolicy {
  credential: { jsonSchemaCredentialId: string }
  /** to whom credentials of the schema are issued: a person (default) or a service; declared here under Verifiable Trust v4 */
  subjectKind?: 'person' | 'service'
  /** asked by the code when the connection is established, or by the model's tool when it judges the moment right */
  request: 'on-connect' | 'on-demand'
  /** shown to the person, or to the controller of the service, before it answers */
  purpose: string
  /** the attributes asked of the credential; every attribute of the schema when omitted */
  attributes?: string[]
}

/**
 * Where a claim of an issued credential comes from (D70, INTX-ISSUE-002): never the model. `evidence` is an
 * attribute of a verified presentation, document read or email check the pack stores, `as: dateint` writing a calendar
 * date as the integer `YYYYMMDD` (IDENT-DIR-005); `record` is a field of the person's entry of the user directory, found
 * from their evidence (INTX-ISSUE-021); `computed` is a fixed function of the profile.
 */
export type ClaimSource =
  | { from: 'evidence'; entry: string; attribute: string; as?: 'dateint' }
  | { from: 'computed'; fn: ComputedFunction; days?: number; value?: string }
  | { from: 'record'; record: 'directory'; field: DirectoryField }

/**
 * The fields a claim may take from an entry of the user directory (INTX-ISSUE-021): `name` is the first and last name
 * joined by a space. Never the birthdate or the nationality, which only the matching of a document reads (IDENT-DIR-007).
 */
export const DIRECTORY_FIELDS = ['name', 'firstName', 'lastName', 'email', 'department'] as const
export type DirectoryField = (typeof DIRECTORY_FIELDS)[number]

/**
 * The functions of a `computed` source, a closed list (INTX-ISSUE-015). `subjectId` is an identifier of the
 * subject, derived from the Principal and the profile (INTX-ISSUE-016): the number of a badge, for one.
 * `documentId` is an identifier of the document the Principal read, derived from its issuing state and its
 * number (INTX-ISSUE-019): one document gives one value, through whichever connection it is read. `emailId` is an
 * identifier of the address the Principal verified by an email code (INTX-ISSUE-020).
 */
export const COMPUTED_FUNCTIONS = ['today', 'now', 'addDays', 'constant', 'subjectId', 'documentId', 'emailId'] as const
export type ComputedFunction = (typeof COMPUTED_FUNCTIONS)[number]

/**
 * One challenge of an issuance profile (INTX-ISSUE-010): those of any action, and `email`, the email code of a badge
 * from the user directory (D89, INTX-AUTH-011), which no other action may declare.
 */
export interface IssuanceChallenge {
  type: 'device' | 'face-match' | 'document' | 'email'
  onChannelUnavailable?: 'fail' | 'degrade'
  referenceImage?: 'badge-photo'
  timeoutSeconds?: number
}

/** The one attribute of the evidence of an email check: the verified address (INTX-AUTH-015). */
export const EMAIL_ATTRIBUTES = ['address'] as const

/** A credential the agent may issue, and the source of each of its claims (D70, INTX-ISSUE-001). */
export interface IssuanceProfile {
  /**
   * The credential issued: a credential definition of this agent, or the schema of the credential in its
   * ecosystem, for which the agent finds or creates its definition (INTX-ISSUE-017). One of the two.
   */
  credential: { credentialDefinitionId?: string; jsonSchemaCredentialId?: string }
  /** how the credential is named to a person, in the menu */
  label?: string
  /** to whom it is issued; persons only in this version */
  subjectKind?: 'person'
  /** who starts the issuance: the model (default), the peer (a menu item), or the agent once every claim resolves */
  trigger?: 'model' | 'request' | 'automatic'
  /** the roles that may receive it; anyone of the subject kind when absent */
  roles?: string[]
  /**
   * enforced before the issuance, in order (INTX-ISSUE-010): one challenge or a list of them; a badge from the user
   * directory declares `[document]`, `[email]` or `[document, email]` (IDENT-DIR-002). Read through `challengesOf`
   */
  authChallenge?: IssuanceChallenge | IssuanceChallenge[]
  /** evidence older than this is expired for the profile (INTX-ISSUE-013) */
  evidenceMaxAgeMinutes?: number
  claims: Record<string, ClaimSource>
  /** what is kept of an issuance beyond its audit fields: the issued claims, when asked, for the retention given */
  record?: { storeClaims?: boolean; retention?: { days?: number; onExpiry?: 'archive' | 'erase' } }
}

/** Whether a profile takes a claim from the user directory (`{ from: record, record: directory, field }`, INTX-ISSUE-021). */
export function takesClaimsFromDirectory(profile: Pick<IssuanceProfile, 'claims'>): boolean {
  return Object.values(profile.claims).some((source) => source.from === 'record' && source.record === 'directory')
}

/** The challenges a profile declares, in their order: one object or a list of them (IDENT-DIR-002). */
export function challengesOf(profile: Pick<IssuanceProfile, 'authChallenge'>): IssuanceChallenge[] {
  return ([] as IssuanceChallenge[]).concat(profile.authChallenge ?? [])
}

/** The types of the challenges a profile declares, in their order. */
export function challengeTypesOf(profile: Pick<IssuanceProfile, 'authChallenge'>): IssuanceChallenge['type'][] {
  return challengesOf(profile).map((c) => c.type)
}

/**
 * Badges are obtained from the directory with a passport: then every entry carries a birthdate and a nationality,
 * which only the matching of a document read reads (IDENT-ROLE-012, IDENT-DIR-002, IDENT-DIR-007).
 */
export function directoryReadsDocuments(pack: Pick<AgentPack, 'issuance'>): boolean {
  return Object.values(pack.issuance ?? {}).some(
    (profile) => takesClaimsFromDirectory(profile) && challengeTypesOf(profile).includes('document')
  )
}

/**
 * A credential that must be revocable: one whose claims come from the directory, revoked when its entry leaves it
 * (D91, IDENT-ROLE-013, IDENT-DIR-006). The definition of its schema is created with revocation (decision 61).
 */
export function mustBeRevocable(profile: Pick<IssuanceProfile, 'claims'>): boolean {
  return takesClaimsFromDirectory(profile)
}

/** The connection type a schema of the given subject kind is asked of (INTX-PRES-007). */
export function connectionTypeOf(subjectKind: PresentationEntry['subjectKind']): ConnectionType {
  return subjectKind === 'service' ? 'verifiable-service' : 'verifiable-user-agent'
}

/**
 * Who enters unidentified follows from the authentication alone (D53, D72, IDENT-RES-007): an agent that names
 * no authentication schema, or lets guests in, admits a person without a valid identity credential; one that
 * requires it authenticates a person or refuses them.
 */
export function admitsUnidentified(pack: Pick<AgentPack, 'identity'>): boolean {
  return authenticationModeOf(pack.identity.authentication?.[0]) !== 'required'
}

export interface PackIdentity {
  homeBackingIdentity: string
  userAgentGate?: 'required' | 'optional'
  /** the one credential schema that authenticates a person: a list validated to one entry (D65, IDENT-RES-010) */
  authentication?: AuthenticationEntry[]
  /** patterns over the verified Organization credential, first match wins; `home` is never set here (D64) */
  organizations?: OrganizationPattern[]
  roles?: Record<string, RoleDefinition>
  roleRules: RoleRule[]
  perActorOverrides?: { actor: string; roles: string[]; comment?: string }[]
  /** the people of the home organization and their roles, typed by hand (D79, D87, IDENT-ROLE-012) */
  directory?: UserDirectoryRef
  /** Credentials requested on DIDComm connect (addition over schema 3.0, see docs/agent-pack.md). */
  credentials?: {
    userAgent?: CredentialRef
    service?: CredentialRef[]
  }
}

export interface MenuItemDef {
  id: string
  label: string
  action: { type: 'prompt' | 'tool' | 'url'; prompt?: string; tool?: string; url?: string }
  visibleWhen?: 'always' | 'bound' | 'role'
  roles?: string[]
}

export interface LlmConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'openai-compatible' | 'azure-openai' | 'bedrock' | 'vertex' | 'stub'
  /**
   * the name of the model provider the spaces' `allowedProviders` list (SPACE-CONV-004), `kimi` for `openai-compatible` on
   * Moonshot for example; `provider` when absent
   */
  providerName?: string
  model: string
  baseUrl?: string
  apiKeyEnv?: string
  temperature?: number
  maxOutputTokens?: number
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'max'
  multimodal?: boolean
  provider_options?: Record<string, unknown>
  /** the model's input limit; the window budget plus the output limit must fit in it (MEM-CTX-006) */
  maxInputTokens?: number
  /** provider caching by prefix (LLM-CACHE-001): the conversation is the cache key; Kimi first */
  cache?: { enabled?: boolean; ttl?: '5m' | '1h' }
}

export interface EmbeddingsConfig {
  provider: 'openai' | 'cohere' | 'voyage' | 'openai-compatible' | 'stub'
  model: string
  dimensions?: number
  baseUrl?: string
  apiKeyEnv?: string
}

export interface ApprovalPolicy {
  type: 'count' | 'percentage'
  value?: number
  vetoOnRefusal?: boolean
}

export interface ApprovalRule {
  tools: string[]
  approvers: string[]
  timeoutMinutes?: number
  policy?: ApprovalPolicy
  approverConnectionType?: ConnectionType
  /** the decision must be device-authenticated: an `authorize` flow on a flow-capable approver (D58, INTX-APPR-011) */
  attested?: boolean
}

export interface ElevationRule extends Omit<ApprovalRule, 'approverConnectionType'> {
  purposes: string[]
  grantTtlMinutes?: number
}

export interface ToolAccess {
  default?: 'none' | 'all'
  roles?: Record<string, ToolNameOrStar[]>
  approval?: ApprovalRule[]
  elevation?: ElevationRule[]
}

// ---- the tool catalog (ayni-spec D96 to D99, D101; TOOL-CAT, TOOL-AVAIL) ---------------------------------------

/**
 * Whose account a source's calls run with (D97, D104, TOOL-CAT-002): none, the agent's, the space's, or the person's own.
 * `organization` is refused (phase 3).
 */
export type AccountKind = 'none' | 'agent' | 'space' | 'personal'
/** The kinds of account reserved for the later phases of the tools (O29): an agent-pack that names one is refused. */
export const RESERVED_ACCOUNT_KINDS = ['organization'] as const
/** Where a source is available (D96, TOOL-AVAIL-001). */
export type Availability = 'agent' | 'personal' | 'spaces'
/** What a tool does (D99, TOOL-CAT-006): it gives its default rule. */
export type ToolEffect = 'read' | 'write' | 'delete' | 'external'
/** What a call needs (D99, TOOL-CAT-007). */
export type CallRule = 'none' | 'confirm' | 'approval'
/** The rule the owner of a space sets for a tool there (TOOL-SPACE-006): a call rule, or `off`. */
export type SpaceCallRule = CallRule | 'off'
/** The type of a source of `tools.sources` (D101, TOOL-CAT-001). */
export type SourceType = 'mcp' | 'http' | 'bundled'

export const ACCOUNT_KINDS: readonly AccountKind[] = ['none', 'agent', 'space', 'personal']
export const AVAILABILITIES: readonly Availability[] = ['agent', 'personal', 'spaces']
export const TOOL_EFFECTS: readonly ToolEffect[] = ['read', 'write', 'delete', 'external']
export const CALL_RULES: readonly CallRule[] = ['none', 'confirm', 'approval']
export const SPACE_CALL_RULES: readonly SpaceCallRule[] = ['none', 'confirm', 'approval', 'off']
export const SOURCE_TYPES: readonly SourceType[] = ['mcp', 'http', 'bundled']

/**
 * The bundled tools a source of `type: bundled` may name (`bundled`), each with the tools it gives the model. A bundled
 * tool no source names keeps its defaults: on, except `statistics` and `generateImage`; the tools of no name here
 * (`knowledge_search`, `set_reaction_policy`, `email_check`) are sources of their own name (TOOL-CAT-001).
 */
export const BUNDLED_TOOLS = {
  statistics: ['statistics'],
  generateImage: ['generate_image'],
  principalCredentials: ['principal_credentials'],
  requestPresentation: ['request_presentation'],
  credentialIssuance: ['credential_requirements', 'issue_credential'],
  principalPreferences: ['principal_preferences'],
  workingMemory: ['working_memory'],
  /** the Connect card of a person's own account (D108, TOOL-CONN-011): given only while one is to connect */
  connections: ['offer_connection'],
} as const satisfies Record<string, readonly string[]>
export type BundledName = keyof typeof BUNDLED_TOOLS
export const BUNDLED_NAMES = Object.keys(BUNDLED_TOOLS) as BundledName[]
/** The bundled tools that are on while no source names them: those that act on the Principal's own records. */
export const BUNDLED_ON_BY_DEFAULT: readonly BundledName[] = [
  'principalCredentials',
  'requestPresentation',
  'credentialIssuance',
  'principalPreferences',
  'workingMemory',
  'connections',
]

/** The name of a field of a space's account (D102): a lower-case letter, then lower-case letters, digits or `_`. */
export const ACCOUNT_FIELD_NAME = /^[a-z][a-z0-9_]{0,31}$/

/** One field of a space's account (D102, TOOL-CAT-002): what its owner types, in a masked field of its own. */
export interface AccountField {
  /** unique in the account; `{name}` in a header of `apply` stands for its value */
  name: string
  /** what the owner of a space is asked for ("API key") */
  label: string
  /** a regular expression its value must match */
  pattern?: string
}

/** A header each call with a space's account carries (D102): every `{name}` of `value` is that field's value. */
export interface AccountHeader {
  header: string
  value: string
}

/** How the agent obtains its client at the authorization server of a person's own account (D105, TOOL-CAT-014). */
export type ClientRegistration = 'metadata-document' | 'pre-registered' | 'dynamic'
export const CLIENT_REGISTRATIONS: readonly ClientRegistration[] = ['metadata-document', 'pre-registered', 'dynamic']

/** The OAuth of a person's own account of an MCP server (D105, TOOL-CAT-014). */
export interface AccountOAuth {
  client: {
    registration: ClientRegistration
    /** `pre-registered`: the issuer identifier of the authorization server the client was registered with */
    issuer?: string
    /** `pre-registered`: the client's id, from the deployment's secrets */
    id?: string
    /** `pre-registered`: the client's secret, from the deployment's secrets */
    secret?: string
  }
  /** the scopes asked; `[]` asks none; absent, the agent takes MCP's choice (TOOL-OAUTH-005) */
  scopes?: string[]
  /**
   * how the sign-in asks the service for the value of the account's binding (D110, layer a): a parameter of the
   * authorization request, or a `resource` in which `{value}` stands for it
   */
  bindingRequest?: { parameter?: string; resource?: string }
}

/** The read the agent makes once after each connection of a person's own account (D110, TOOL-CAT-017). */
export interface AccountCheck {
  /** a tool the source offers, of effect `read`, called with no argument */
  tool: string
  /** JSON pointers into its result: the value of the account's binding and its name */
  binding?: { value: string; label?: string }
  /** a JSON pointer to the account's email, compared with the person's entry of the directory */
  email?: string
  /** a text naming the account, in which `{/pointer}` stands for the value at that pointer */
  label?: string
}

/**
 * The account of a source (TOOL-CAT-002). A `space` account declares the fields its owner fills, in the order the
 * settings show them, and the headers each call carries, built from their values at the call (D102). A `personal`
 * account (D104, TOOL-CAT-013) declares one of `oauth`, `fields` and `apply`, or `from`, and may declare `check`,
 * `binding` and `tokenPatterns`.
 */
export interface SourceAccount {
  kind: AccountKind
  /** a `space` or `personal` account: the fields its owner, or the person, fills, one or more; every field is a secret */
  fields?: AccountField[]
  /** a `space` or `personal` account: the headers of each call, one or more; each field is named by at least one */
  apply?: AccountHeader[]
  /** a `personal` account of an MCP server: OAuth as MCP defines it (D105) */
  oauth?: AccountOAuth
  /** a `personal` account: the id of another source whose account it uses, at the same URL (TOOL-CAT-015) */
  from?: string
  /** a `personal` account: the binding whose value each account is for (D110, TOOL-CAT-017) */
  binding?: string
  /** a `personal` account: the read after each connection (D110, TOOL-CAT-017) */
  check?: AccountCheck
  /** a `space` or `personal` account: the forms of its credentials in a text (D109, TOOL-CAT-016) */
  tokenPatterns?: string[]
}

/**
 * A parameter the agent pins (TOOL-CAT-004/005): its value comes from the agent-pack (`value`) or, in a space, from its
 * owner. `argument` is the input argument it fills (and an HTTP tool's `{argument}` placeholder); without it the binding is
 * a label the account's own scope enforces.
 */
export interface SourceBinding {
  name: string
  label: string
  argument?: string
  pattern?: string
  value?: string
}

/** The auth challenge a tool's step-up asks before the call (D28, INTX-AUTH-002). */
export interface AuthChallengePolicy {
  type: 'device' | 'face-match' | 'document'
  onChannelUnavailable?: 'fail' | 'degrade'
  referenceImage?: 'badge-photo'
  timeoutSeconds?: number
}

/**
 * A tool's step-up (D101, TOOL-CAT-010): what `actions.<tool>` held, now in the tool's own source, so that two sources
 * with a tool of one name never share it. `maxCredentialAge` in seconds: 0 forces a fresh liveness check (D7).
 */
export interface StepUp {
  authChallenge?: AuthChallengePolicy
  maxCredentialAge?: number
}

/** What the agent-pack says of one tool of a source (TOOL-CAT-001/006/007/008/010). */
export interface ToolDeclaration {
  title?: string
  effect?: ToolEffect
  call?: CallRule
  untrusted?: boolean
  stepUp?: StepUp
}

/** What every source of `tools.sources` may declare (D101, TOOL-CAT-001), whatever its type. */
export interface SourceFields {
  type: SourceType
  /** what people read on the cards, in the sources and in a space's settings; the source's id by default */
  title?: string
  description?: string
  /** `agent` by default for an MCP server and an HTTP tool; never declared for a bundled tool */
  account?: SourceAccount
  /** `agent` by default */
  availability?: Availability
  /** the tier model of the source's tools (D12, D14, RBAC-TOOL): roles, approval, elevation, default */
  access?: ToolAccess
  /** what the agent-pack says of each tool of the source, by the tool's name */
  tools?: Record<string, ToolDeclaration>
}

/** An MCP server (TOOL-MCP): its connection, the tools it offers, the parameters the agent pins, its trust. */
export interface McpSource extends SourceFields {
  type: 'mcp'
  transport: 'stdio' | 'sse' | 'streamable-http'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  lazy?: boolean
  reconnect?: boolean
  /** the tools of the server the model is given; every tool it lists when absent (TOOL-CAT-003) */
  offer?: string[]
  bindings?: SourceBinding[]
  untrusted?: boolean
}

/** An HTTP tool (TOOL-HTTP-001): one tool, named by the source's id, and its request. */
export interface HttpSource extends SourceFields {
  type: 'http'
  /** what the model reads of the tool, and people of the source */
  description: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  headers?: Record<string, string>
  parameters?: Record<string, unknown>
  bodyTemplate?: string
  timeoutSeconds?: number
  bindings?: SourceBinding[]
  untrusted?: boolean
}

/** A bundled tool (TOOL-HTTP-002): the one it names, on while the source is declared unless `enabled: false`. */
export interface BundledSource extends SourceFields {
  type: 'bundled'
  bundled: BundledName
  enabled?: boolean
  /** `statistics`: where it reads from, and the class it reads by default */
  endpoint?: string
  defaultStatClass?: string
  /** `generateImage`: the name of a `media.imageGeneration` provider */
  provider?: string
}

export type ToolSourceDef = McpSource | HttpSource | BundledSource

/** The sources of one type, each with its id: the key of `tools.sources` (D101). */
export function sourcesOfType<T extends SourceType>(
  pack: Pick<AgentPack, 'tools'>,
  type: T
): [string, Extract<ToolSourceDef, { type: T }>][] {
  return Object.entries(pack.tools?.sources ?? {}).filter(
    (entry): entry is [string, Extract<ToolSourceDef, { type: T }>] => entry[1].type === type
  )
}

/** The source that names a bundled tool, with its id, if one does. */
export function bundledSource(pack: Pick<AgentPack, 'tools'>, name: BundledName): [string, BundledSource] | undefined {
  return sourcesOfType(pack, 'bundled').find(([, s]) => s.bundled === name)
}

/** Whether a bundled tool is on: named by a source, unless `enabled: false`; else on by default for some (TOOL-HTTP-002). */
export function bundledEnabled(pack: Pick<AgentPack, 'tools'>, name: BundledName): boolean {
  const declared = bundledSource(pack, name)
  if (declared) return declared[1].enabled !== false
  return BUNDLED_ON_BY_DEFAULT.includes(name)
}

export type ProcessingActivityId =
  | 'conversation-memory'
  | 'working-memory'
  | 'rag-corpus'
  | 'media-objects'
  | 'credential-presentations'
  | 'approvals'
  | 'statistics'

export interface ProcessingActivity {
  id: ProcessingActivityId
  lawfulBasis: 'consent' | 'contract' | 'legitimate-interest'
  retention?: { days?: number; onExpiry?: 'archive' | 'delete' }
  description?: string
}

export interface RagSource {
  id: string
  type: 'local' | 'url'
  path?: string
  url?: string
  visibility?: 'public' | 'organization-shared' | 'partner-shared'
  /** the organization key of the partner whose Principals may read a `partner-shared` source (MEM-RAG-005) */
  partner?: string
  refreshHours?: number
}

export interface Features {
  approvals: boolean
  elevation: boolean
  reactions: boolean
  receipts: boolean
  voiceNotes: boolean
  inboundImages: boolean
  imageGeneration: boolean
  rag: boolean
  workingMemory: boolean
  semanticRecall: boolean
  preferences: boolean
  credentialTool: boolean
  anchoring: boolean
  history: boolean
}

export type LawfulBasis = 'consent' | 'contract' | 'legitimate-interest'

/**
 * A kind of space the pack lets people create (SPACE-DEF-003, decision 60): who may create one, how its members are
 * given, and the rules an owner may set, with their bounds. A rule without bounds keeps its default.
 */
export interface SpaceTemplate {
  id: string
  title: string
  kind: 'team' | 'organization'
  /** the roles of the people who may create a space from it */
  creators: string[]
  /** by a list the owner keeps, or by a rule over verified facts of the people of the home organization */
  membership: { mode: 'list' } | { mode: 'rule'; rule: { department?: string; group?: string; organization?: true } }
  rules?: {
    retentionDays?: { default?: number; min?: number; max?: number }
    lawfulBasis?: { default?: LawfulBasis; allowed?: LawfulBasis[] }
    allowedProviders?: { default?: string[]; allowed?: string[] }
    handover?: { default?: boolean; allowed?: boolean[] }
  }
  /** the sources of availability `spaces` its spaces may use (TOOL-AVAIL-002) */
  tools?: TemplateTool[]
}

/**
 * A source a template of spaces offers (TOOL-AVAIL-002): in every space of the template from its creation (`auto`), or
 * when the owner of each space adds it (`owner`, the default); used by people of other organizations only with `guests`.
 */
export interface TemplateTool {
  source: string
  add?: 'auto' | 'owner'
  guests?: boolean
}

/** The rules of every Personal space (SPACE-DEF-002): 365 days, the conversation memory's basis, the agent's provider. */
export interface PersonalSpaceRules {
  retentionDays?: number
  lawfulBasis?: LawfulBasis
  allowedProviders?: string[]
}

export interface ImageProviderDef {
  name: string
  type: 'openai-image' | 'openai-compatible-image'
  model: string
  baseUrl?: string
  apiKeyEnv?: string
  defaultSize?: string
  quality?: string
  outputFormat?: 'png' | 'jpeg' | 'webp'
}

export interface AgentPack {
  schemaVersion: string
  metadata: { id: string; displayName: string; description?: string; tags?: string[] }
  identity: PackIdentity
  language: { agent: string }
  persona: { systemPrompt: string; greeting?: string; menu?: MenuItemDef[] }
  llm: LlmConfig
  embeddings: EmbeddingsConfig
  memory?: {
    contextWindowTokens?: number
    workingMemory?: { enabled?: boolean; maxNotes?: number; maxNoteChars?: number }
    /** the window moves in steps (MEM-CTX-003): down to keepRatio of the budget, never more than maxEntries entries */
    window?: { keepRatio?: number; maxEntries?: number }
    /** the conversation summary (MEM-CTX-004): what a step drops, compressed with the previous summary */
    summarization?: { enabled?: boolean; triggerTokens?: number; maxSummaryTokens?: number }
    retrieval?: { topK?: number; ambientDescriptions?: boolean; chunkSize?: number; chunkOverlap?: number }
  }
  rag?: { enabled?: boolean; sources: RagSource[]; chunkSize?: number; chunkOverlap?: number }
  /** the credentials the agent may ask for, by name; `authentication` is the entry of identity.authentication (D69) */
  presentations?: Record<string, PresentationEntry>
  /**
   * The evidence that is not a credential: what is kept of a document read (the `document` challenge) and of an address
   * verified by an email code (the `email` challenge, D89), and what the model may read of it (D73, PRIV-EVID-003).
   */
  evidence?: { document?: EvidencePolicy; email?: EvidencePolicy }
  /** the credentials the agent may issue, by name (D70) */
  issuance?: Record<string, IssuanceProfile>
  /**
   * The catalog of tool sources (D101, TOOL-CAT-001): one map keyed by the source's id, each entry an MCP server, an HTTP
   * tool or a bundled tool with everything the four questions ask of it. `mcp.servers`, `tools.http`, `tools.bundled`,
   * `tools.access` and `actions` are withdrawn, and refused at start in words (TOOL-CAT-011).
   */
  tools?: { sources?: Record<string, ToolSourceDef> }
  purposes?: { id: string; label: string; description?: string; permittedRoles?: string[] }[]
  approvals?: {
    timeoutMinutes?: number
    policy?: ApprovalPolicy
    selfApproval?: boolean
    grantTtlMinutes?: number
    attested?: boolean
    /**
     * the roles that approve a tool of the whole agent or of Personal whose rule is `approval` and that no
     * `access.approval` entry of its source lists (TOOL-CAT-009)
     */
    approvers?: string[]
    /** how long a confirmation card waits for the person (TOOL-CALL-004): 300 seconds by default */
    confirmation?: { timeoutSeconds?: number }
  }
  sessions?: {
    idleTimeoutSeconds?: number
    bindingExpirySeconds?: number
    credentialCheckTtlSeconds?: number
    siblingSessions?: boolean
    /** device pairing window (D51, IDENT-DEV-004); slidingDays 0 disables silent binding */
    devicePairing?: { slidingDays?: number; maxDays?: number }
  }
  channels?: {
    agui?: {
      enabled?: boolean
      allowedOrigins?: string[]
      walletLinkTemplate?: string
      /** base of the app links the model may write, on the network's app-link domain (PROF-LINK-001, §10) */
      appLinkBase?: string
      uploads?: { maxBytes?: number; types?: string[] }
    }
    a2a?: { enabled?: boolean }
  }
  privacy: { processingActivities: ProcessingActivity[]; erasureRequests?: boolean; mediaOrphanGraceDays?: number }
  media?: {
    speechToText?: {
      enabled?: boolean
      provider: 'openai' | 'openai-compatible'
      model: string
      baseUrl?: string
      apiKeyEnv?: string
      languageHint?: string
    }
    vision?: {
      enabled?: boolean
      provider: 'openai' | 'openai-compatible' | 'llm'
      model: string
      baseUrl?: string
      apiKeyEnv?: string
      prompt?: string
      maxOutputTokens?: number
    }
    imageGeneration?: { enabled?: boolean; providers: ImageProviderDef[]; thumbnailPx?: number }
    faceVerification?: { enabled?: boolean; serviceUrl: string; webrtcServerUrl: string; timeoutSeconds?: number }
  }
  integrity?: { anchoring?: { enabled?: boolean; batchIntervalSeconds?: number; maxBatchEntries?: number } }
  statistics?: { enabled?: boolean; sink?: 'redis-stream' | 'http'; httpUrl?: string }
  features?: Partial<Features>
  /** what a person may do with their conversations (PRIV-ERASE-010) */
  conversations?: {
    /** a person deletes their own message, with the agent's reply, while it is younger than this; 600 by default */
    messageDeletionWindowSeconds?: number
  }
  /** the rules of Personal and the spaces people may create in this agent (SPACE-DEF-002/003) */
  spaces?: { personal?: PersonalSpaceRules; templates?: SpaceTemplate[] }
}

/** The retention of a space whose template or `spaces.personal` gives none (SPACE-DEF-002). */
export const PERSONAL_RETENTION_DAYS = 365

/** The model provider a space allows or not (SPACE-CONV-004): `llm.providerName`, else `llm.provider`. */
export function providerNameOf(pack: Pick<AgentPack, 'llm'>): string {
  return pack.llm.providerName ?? pack.llm.provider
}

/** The deletion window of a message (PRIV-ERASE-010), in seconds. */
export function messageDeletionWindowSeconds(pack: Pick<AgentPack, 'conversations'>): number {
  return pack.conversations?.messageDeletionWindowSeconds ?? 600
}

export const DEFAULT_FEATURES: Features = {
  approvals: true,
  elevation: true,
  reactions: true,
  receipts: true,
  voiceNotes: true,
  inboundImages: true,
  imageGeneration: false,
  rag: false,
  workingMemory: true,
  semanticRecall: true,
  preferences: true,
  credentialTool: true,
  anchoring: true,
  history: true,
}

export function featuresOf(pack: AgentPack): Features {
  return { ...DEFAULT_FEATURES, ...(pack.features ?? {}) }
}

/** How long a confirmation card waits (TOOL-CALL-004), in seconds. */
export function confirmationTimeoutSeconds(pack: Pick<AgentPack, 'approvals'>): number {
  return pack.approvals?.confirmation?.timeoutSeconds ?? 300
}
