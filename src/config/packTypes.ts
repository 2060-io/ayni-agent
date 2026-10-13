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

export interface PackIdentity {
  homeBackingIdentity: string
  userAgentGate?: 'required' | 'optional'
  recognizedBackingIdentities: { identity: string; relation: 'home' | 'partner'; label?: string }[]
  roles?: Record<string, RoleDefinition>
  roleRules: RoleRule[]
  perActorOverrides?: { actor: string; roles: string[]; comment?: string }[]
  /** Credentials requested on DIDComm connect (addition over schema 3.0, see docs/agent-pack.md). */
  credentials?: {
    userAgent?: CredentialRef
    badge?: CredentialRef[]
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
  tools?: {
    http?: HttpToolDef[]
    bundled?: {
      statistics?: { enabled?: boolean; endpoint?: string; defaultStatClass?: string }
      generateImage?: { enabled?: boolean; provider?: string }
      principalCredentials?: { enabled?: boolean }
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
  }
  channels?: {
    agui?: {
      enabled?: boolean
      allowedOrigins?: string[]
      walletLinkTemplate?: string
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
