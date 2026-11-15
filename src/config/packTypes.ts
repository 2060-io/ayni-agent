/** TypeScript view of schemas/agent-pack.schema.json (schema 3.0). Field names follow the schema. */

export type Visibility = 'session-private' | 'principal-private' | 'organization-shared' | 'partner-shared' | 'public'
export type Relation = 'home' | 'partner' | 'unrecognized'
export type ConnectionType = 'verifiable-user-agent' | 'verifiable-service'
export type ToolNameOrStar = string

export interface RoleDefinition {
  description?: string
  crossSession?: 'own-sessions' | 'own-backing-identity' | 'all'
  canApprove?: boolean
  auditor?: boolean
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
  /** when it is asked: at connection (default), or later, by the model's tool or the person's menu item (D65) */
  request?: 'on-connect' | 'on-demand'
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
 * attribute of a verified presentation the pack stores; `computed` is a fixed function of the profile.
 */
export type ClaimSource =
  | { from: 'evidence'; entry: string; attribute: string }
  | { from: 'computed'; fn: ComputedFunction; days?: number; value?: string }

/**
 * The functions of a `computed` source, a closed list (INTX-ISSUE-015). `subjectId` is an identifier of the
 * subject, derived from the Principal and the profile (INTX-ISSUE-016): the number of a badge, for one.
 */
export const COMPUTED_FUNCTIONS = ['today', 'now', 'addDays', 'constant', 'subjectId'] as const
export type ComputedFunction = (typeof COMPUTED_FUNCTIONS)[number]

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
  /** enforced before the issuance, as for any action (INTX-ISSUE-010) */
  authChallenge?: ActionPolicy['authChallenge']
  /** evidence older than this is expired for the profile (INTX-ISSUE-013) */
  evidenceMaxAgeMinutes?: number
  claims: Record<string, ClaimSource>
  /** what is kept of an issuance beyond its audit fields: the issued claims, when asked, for the retention given */
  record?: { storeClaims?: boolean; retention?: { days?: number; onExpiry?: 'archive' | 'erase' } }
}

/** The connection type a schema of the given subject kind is asked of (INTX-PRES-007). */
export function connectionTypeOf(subjectKind: PresentationEntry['subjectKind']): ConnectionType {
  return subjectKind === 'service' ? 'verifiable-service' : 'verifiable-user-agent'
}

/**
 * Who enters unidentified follows from the authentication alone (D53, IDENT-RES-007): an agent that names
 * no authentication schema, or asks for it on demand, admits a person without a valid identity credential;
 * one that asks on connect identifies a person or refuses them.
 */
export function admitsUnidentified(pack: Pick<AgentPack, 'identity'>): boolean {
  const authentication = pack.identity.authentication?.[0]
  return !authentication || authentication.request === 'on-demand'
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
  model: string
  baseUrl?: string
  apiKeyEnv?: string
  temperature?: number
  maxOutputTokens?: number
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'max'
  multimodal?: boolean
  provider_options?: Record<string, unknown>
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

export interface HttpToolDef {
  name: string
  description: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  headers?: Record<string, string>
  parameters?: Record<string, unknown>
  bodyTemplate?: string
  timeoutSeconds?: number
}

export interface McpServerDef {
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  lazy?: boolean
  reconnect?: boolean
  toolAccess?: ToolAccess
}

export interface ActionPolicy {
  authChallenge?: {
    type: 'device' | 'face-match' | 'document'
    onChannelUnavailable?: 'fail' | 'degrade'
    referenceImage?: 'badge-photo'
    timeoutSeconds?: number
  }
  maxCredentialAge?: number
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
    summarization?: { enabled?: boolean; triggerTokens?: number }
    retrieval?: { topK?: number; ambientDescriptions?: boolean; chunkSize?: number; chunkOverlap?: number }
  }
  rag?: { enabled?: boolean; sources: RagSource[]; chunkSize?: number; chunkOverlap?: number }
  /** the credentials the agent may ask for, by name; `authentication` is the entry of identity.authentication (D69) */
  presentations?: Record<string, PresentationEntry>
  /** the credentials the agent may issue, by name (D70) */
  issuance?: Record<string, IssuanceProfile>
  tools?: {
    http?: HttpToolDef[]
    bundled?: {
      statistics?: { enabled?: boolean; endpoint?: string; defaultStatClass?: string }
      generateImage?: { enabled?: boolean; provider?: string }
      principalCredentials?: { enabled?: boolean }
      requestPresentation?: { enabled?: boolean }
      credentialIssuance?: { enabled?: boolean }
      principalPreferences?: { enabled?: boolean }
      workingMemory?: { enabled?: boolean }
    }
    access?: ToolAccess
  }
  mcp?: { servers: McpServerDef[] }
  purposes?: { id: string; label: string; description?: string; permittedRoles?: string[] }[]
  approvals?: { timeoutMinutes?: number; policy?: ApprovalPolicy; selfApproval?: boolean; grantTtlMinutes?: number }
  actions?: Record<string, ActionPolicy>
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
