/**
 * Canonical core objects (architecture section 15). The core deals only in Principals, Sessions,
 * MessageEntries and capability events (CORE-MSG-001).
 */
import type { ConnectionType, Relation, Visibility } from '../config/packTypes.js'

export type { ConnectionType, Relation, Visibility }

export type LifecycleState = 'active' | 'archived' | 'legal-hold' | 'crypto-erased' | 'deleted'
export const VISIBILITIES: readonly Visibility[] = [
  'session-private',
  'principal-private',
  'organization-shared',
  'partner-shared',
  'public',
]
export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'active',
  'archived',
  'legal-hold',
  'crypto-erased',
  'deleted',
]

export interface BackingIdentity {
  kind: 'org' | 'persona'
  id: string
  name?: string
}

export const sameBackingIdentity = (
  a: BackingIdentity | null | undefined,
  b: BackingIdentity | null | undefined
): boolean => !!a && !!b && a.id === b.id

export interface LivenessVerdict {
  ok: boolean
  checkedAt: string
  reason?: string
}

export interface Principal {
  id: string
  connectionType: ConnectionType
  actorIdentity: string
  backingIdentity: BackingIdentity | null
  backingRelation: Relation
  roles: string[]
  identityAttributes: Record<string, unknown> & {
    userName?: string
    photoRef?: string
    title?: string
    department?: string
  }
  capabilityChannelId: string | null
  identityCredentialRef: string | null
  livenessCache: Record<string, LivenessVerdict>
  userAgentVerified: boolean
  /** devices (browser profiles) this Principal bound before, by opaque handle */
  devices?: { handle: string; client: ClientDescription; createdAt: string }[]
  createdAt: string
  updatedAt: string
}

export type ChannelType = 'didcomm' | 'ag-ui' | 'a2a'
export type SessionState = 'provisional' | 'bound' | 'closed'
export type ClosureReason =
  | 'user'
  | 'supersede'
  | 'channel-closed'
  | 'credential-invalid'
  | 'idle-timeout'
  | 'expired'
  | 'agent'

export interface ClientDescription {
  name: string
  version: string
  platform: string
}

export interface BindingState {
  /** the invitation id: one-time nonce (D5, CHAN-BIND-008) */
  nonce: string
  outOfBandId: string
  oobUrl: string
  bindingCode: string
  expiresAt: string
  /** set once a connection accepted the invitation and the confirmation question was sent */
  connectionId?: string
  questionThreadId?: string
  used: boolean
}

export interface Session {
  id: string
  principalId: string | null
  channelType: ChannelType
  /** AG-UI thread id, DIDComm connection id, A2A task or context id */
  externalRef: string
  state: SessionState
  client: ClientDescription
  locale?: string
  parentSessionId?: string
  boundAt?: string
  closedAt?: string
  closedReason?: ClosureReason
  binding?: BindingState
  /** opaque device handle: inherited from the creation request or minted at binding */
  deviceHandle?: string
  /** a closed session this one resumes: its entries stay readable here (IDENT-SESS-009) */
  resumedFromSessionId?: string
  /** ids of every session in the resume chain, oldest last */
  lineage?: string[]
  tokenHash?: string
  lastActivityAt: string
  createdAt: string
  /** last SSE event id delivered on the session stream (AG-UI) */
  streamCursor: number
}

export type EntryRole = 'principal' | 'agent' | 'system'
export type SourceType =
  | 'text'
  | 'voice'
  | 'media'
  | 'tool-call'
  | 'approval'
  | 'refusal'
  | 'auth-challenge'
  | 'reaction'
  | 'state-update'
export const SOURCE_TYPES: readonly SourceType[] = [
  'text',
  'voice',
  'media',
  'tool-call',
  'approval',
  'refusal',
  'auth-challenge',
  'reaction',
  'state-update',
]

export type AttachmentType = 'image' | 'voice' | 'video' | 'file' | 'credential'

export interface MessageAttachment {
  id: string
  type: AttachmentType
  bucketKey: string
  mimeType: string
  size?: number
  width?: number
  height?: number
  duration?: number
  filename?: string
  /** prompt | transcription | description | summary */
  textRepr: string
  /** wrapped per-object key, never in LLM context (MEM-ATT-006) */
  objectKeyRef: string
  /** SHA-256 of the stored object */
  refDigest: string
  thumbnailBucketKey?: string
  thumbnailId?: string
}

export type ReactionPolicy = 'notify' | 'historize' | { notifyOn: string[] }
export type Completion = 'complete' | 'interrupted'

export interface MessageEntry {
  id: string
  sessionId: string
  principalId: string | null
  role: EntryRole
  sourceType: SourceType
  text: string
  completion: Completion
  attachments: MessageAttachment[]
  language: string
  visibility: Visibility
  backingIdentity: BackingIdentity | null
  state: LifecycleState
  contentDigest: string
  /** wrapped per-entry key; null once crypto-erased (D19) */
  encKeyRef: string | null
  reactionPolicy?: ReactionPolicy
  /** structured payload (tool-call, approval, menu items, `reactions` by principal, `replyTo`), encrypted with the entry */
  payload?: Record<string, unknown>
  /** transport message id (DIDComm message id, AG-UI message id) for receipts and reactions */
  externalId?: string
  initiatedAt: string
  createdAt: string
  anchorBatchId?: string
}

export interface WorkingMemoryNote {
  id: string
  principalId: string
  content: string
  visibility: Visibility
  state: LifecycleState
  backingIdentity: BackingIdentity | null
  lineageRefs: string[]
  needsRevision: boolean
  createdAt: string
  updatedAt: string
}

export interface PrincipalPreference {
  principalId: string
  key: string
  value: string
  updatedAt: string
}

export interface CredentialPresentation {
  id: string
  principalId: string
  credentialId: string
  type: string
  issuerDid: string
  summary: Record<string, unknown>
  refDigest: string
  presentedAt: string
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'
export type ApprovalKind = 'sensitivity' | 'elevation'

export interface ApprovalDecision {
  approverId: string
  approverName: string
  role: string
  decision: 'approve' | 'reject'
  reason?: string
  ts: string
}

export interface ApprovalRecord {
  id: string
  kind: ApprovalKind
  serverName?: string
  toolName: string
  actionArgs?: Record<string, unknown>
  requesterId: string
  requesterName: string
  requesterRole: string
  originSessionId: string
  policy: { type: 'count' | 'percentage'; value: number; vetoOnRefusal: boolean }
  eligibleRoles: string[]
  approverConnectionType?: ConnectionType
  purpose?: string
  justification?: string
  decisions: ApprovalDecision[]
  status: ApprovalStatus
  vetoed: boolean
  grantTtlMinutes?: number
  grantExpiresAt?: string
  expiresAt: string
  createdAt: string
  updatedAt: string
}

export interface ElevationGrant {
  id: string
  principalId: string
  serverName?: string
  toolName: string
  purpose: string
  justification: string
  approverId: string
  approvalId: string
  grantedAt: string
  expiresAt: string
}

export type ChallengeType = 'device' | 'face-match' | 'document'
export type ChallengeOutcome = 'pending' | 'completed' | 'failed' | 'expired' | 'unavailable' | 'degraded'

export interface AuthChallengeRecord {
  id: string
  type: ChallengeType
  principalId: string
  originSessionId: string
  toolName?: string
  /** per-challenge token for callbacks (INTX-AUTH-008) or question nonce */
  token: string
  outcome: ChallengeOutcome
  details?: Record<string, unknown>
  createdAt: string
  expiresAt: string
  completedAt?: string
}

export interface DigestAnchor {
  batchId: string
  digest: string
  entryCount: number
  firstEntryId: string
  lastEntryId: string
  ledgerTxRef?: string
  anchoredAt?: string
  attempts: number
  lastError?: string
  createdAt: string
}

export interface MemoryAccessLog {
  id: string
  principalId: string
  roles: string[]
  activeGrantId?: string
  scopePredicate: Record<string, unknown>
  matchedEntryIds: string[]
  fromSessionIds: string[]
  shownToLlm: boolean
  influencedToolCall: boolean
  ts: string
}

export interface RagChunk {
  id: string
  sourceId: string
  uri: string
  visibility: Visibility
  state: LifecycleState
  chunkText: string
  position: number
  createdAt: string
}

export interface StatEvent {
  id: string
  ts: string
  statClass: string
  value: number
  dimensions: Record<string, string>
}

// ---------------------------------------------------------------------------------------------
// Capability events (D40): core-emitted requests that need channel rendering.

export type TrustBoundKind = 'authentication' | 'credential-exchange' | 'auth-challenge'

export type CapabilityEvent =
  | { kind: 'text'; entry: MessageEntry }
  | {
      kind: 'menu'
      entry: MessageEntry
      menuId: string
      prompt: string
      items: { id: string; label: string; description?: string }[]
    }
  | { kind: 'media'; entry: MessageEntry }
  | { kind: 'approval'; entry: MessageEntry; approval: ApprovalRecord; update?: boolean }
  | {
      kind: 'reaction'
      messageId: string
      emoji: string
      action: 'add' | 'remove'
      by: string
      /** who reacted: the Principal's own reaction is mirrored to their web sessions, never echoed to their phone */
      origin: 'principal' | 'agent'
    }
  | { kind: 'receipt'; messageIds: string[]; state: 'received' | 'viewed' }
  | { kind: 'contextual-menu'; sessionId: string }
  | { kind: 'generating'; entryId: string; kindOf: 'image'; startedAt: string }
  | {
      kind: 'routed'
      trustBound: TrustBoundKind
      challengeType?: ChallengeType
      status: ChallengeOutcome
      originSessionId: string
      expiresAt?: string
      message?: string
    }

export const TRUST_BOUND_KINDS: readonly string[] = ['authentication', 'credential-exchange', 'auth-challenge']
