/**
 * Canonical core objects (architecture section 15). The core deals only in Principals, Sessions,
 * MessageEntries and capability events (CORE-MSG-001).
 */
import type { ConnectionType, Relation, Visibility } from '../config/packTypes.js'

export type { ConnectionType, Relation, Visibility }

export type LifecycleState = 'active' | 'archived' | 'legal-hold' | 'crypto-erased' | 'deleted'
export const VISIBILITIES: readonly Visibility[] = [
  'conversation-private',
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
  /** paired devices (browser profiles), by opaque handle; the secret is kept hashed (D48, D51) */
  devices?: {
    handle: string
    client: ClientDescription
    createdAt: string
    lastUsedAt?: string
    secretHash?: string
  }[]
  createdAt: string
  updatedAt: string
}

export type ChannelType = 'didcomm' | 'ag-ui' | 'a2a'

/** The Principal's view of a thread with the agent (D52): title, state, and the sessions that served it. */
export type ConversationState = 'active' | 'archived' | 'final'
export interface Conversation {
  id: string
  principalId: string
  channelType: ChannelType
  title: string
  state: ConversationState
  lastPreview?: string
  /**
   * the title and the last text, sealed under a key of the conversation (D77): what the store keeps of them. The
   * service opens it into `title` and `lastPreview`, which the store never holds in the clear
   */
  sealed?: { keyRef: string; cipher: string }
  createdAt: string
  lastActivityAt: string
  /** every session that served it, newest first; the lineage of the next one */
  sessionIds: string[]
  /**
   * the read marker (D62, IDENT-SESS-017): the newest transcript message the Principal has seen, on any device.
   * One value, overwritten, with no time: when each message was seen is in the viewing entries (INTX-STATE-004)
   */
  readUpTo?: string | null
  /** the agent messages after the marker, kept beside it so that listing costs nothing */
  unread?: number
}
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
  /** `web`, `ios` or `android` (PROF-SESS-014); a 3.0 client's free text is moved to `description` */
  platform: string
  /** what the phone shows when it links this session: "Firefox on Linux", "Ayni on iPhone" (CHAN-BIND-015) */
  description?: string
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
  /** the question-answer thread, or the link-session request id on a flow-capable wallet */
  questionThreadId?: string
  /** the `link-session` flow carrying the question (D54, CHAN-BIND-009) */
  flowId?: string
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
  /** the pairing secret handed to the client at binding, kept until the client rotates it (D51) */
  deviceSecret?: string
  /** the conversation this session serves (D52); AG-UI sessions only */
  conversationId?: string
  /** the request asked for a new conversation rather than continuing the latest (PROF-CONV-006) */
  newConversation?: boolean
  /** a closed session this one resumes: its entries stay readable here (IDENT-SESS-009) */
  resumedFromSessionId?: string
  /** ids of every session in the resume chain, oldest last */
  lineage?: string[]
  /**
   * the first session of a conversation that no AG-UI conversation names (MEM-ENTRY-004): the sessions that resume
   * it carry it, and their entries belong to it
   */
  rootSessionId?: string
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
  /** a flow of the flow profile opened from this conversation, one entry updated in place at its close (D55) */
  | 'flow'
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
  'flow',
]

// ---------------------------------------------------------------------------------------------
// Flows (D55, INTX-FLOW-001..005): the agent's view of a flow of the flow profile.

export type FlowState = 'pending' | 'active' | 'completed' | 'declined' | 'cancelled' | 'failed' | 'expired'
export type FlowOutcome = 'completed' | 'declined' | 'cancelled' | 'failed' | 'expired'
export interface FlowReference {
  type: string
  id: string
}
/** The flow card as the UIs render it (`ayni.flow`, AG-UI profile 3.1 §6); kept in the flow entry's payload. */
export interface FlowCard {
  flowId: string
  kind: string
  state: FlowState
  title: string
  openedAt: string
  closedAt?: string
  outcome?: FlowOutcome
  reason?: string
  references?: FlowReference[]
  /** only what the person received or disclosed (PROF-MAP-007) */
  preview?: Record<string, unknown>
}

export type AttachmentType = 'image' | 'voice' | 'video' | 'file' | 'credential'

export interface MessageAttachment {
  id: string
  type: AttachmentType
  bucketKey: string
  mimeType: string
  size?: number
  width?: number
  height?: number
  /** the length of a voice note or a video, in seconds */
  duration?: number
  /** the shape of a voice note's sound: up to 64 levels from 0 to 100, start to end (PROF-HIST-009) */
  waveform?: number[]
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
  /** the conversation it belongs to (MEM-ENTRY-004, D76): what `conversation-private` keys on */
  conversationId: string
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

/**
 * What the agent verified about a Principal: a credential presentation or a document read (D67,
 * PRIV-EVID-002). The audit fields are in the clear and hold no attribute value; the stored values are
 * sealed under the key of the record, which `erase` destroys.
 */
export interface EvidenceRecord {
  id: string
  principalId: string
  /** a verification (a presentation, a document read) or an issuance, recorded the same way (INTX-ISSUE-014) */
  kind: 'presentation' | 'document' | 'issuance'
  /** the entry of the agent-pack it answers: `authentication`, a catalog entry, or the evidence kind */
  entry: string
  schema?: string
  credentialDefinitionId?: string
  issuerDid?: string
  issuerOrganization?: { key: string; name?: string }
  outcome: 'verified' | 'refused'
  /** why a read or a presentation that was received is not kept (PRIV-EVID-011): a word, never a value */
  reason?: string
  /** the names of the attributes revealed and of the requested ones left unrevealed, never a value */
  revealed: string[]
  unrevealed: string[]
  /** the names of the attributes whose values are sealed in the record */
  stored: string[]
  requestRef?: string
  connectionRef?: string
  /** an issuance: the evidence records its claims were resolved from */
  evidenceRefs?: string[]
  verifiedAt: string
  state: 'active' | 'archived' | 'legal-hold' | 'crypto-erased'
  /** the end of the retention of the values, and what happens then */
  expiresAt?: string
  onExpiry?: 'archive' | 'erase'
  /** SHA-256 over the ciphertext; kept when the key is gone */
  contentDigest: string
  /** wrapped per-record key; null once the values are erased */
  encKeyRef: string | null
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
  /** how the approver authenticated on the device when the decision came through an `authorize` flow (D58) */
  attestation?: { method: 'biometric' | 'passcode' | 'none'; at: string }
}

export interface ApprovalRecord {
  id: string
  kind: ApprovalKind
  serverName?: string
  toolName: string
  actionArgs?: Record<string, unknown>
  /** the arguments were erased with the message whose turn asked for the approval (PRIV-ERASE-005) */
  argsErased?: boolean
  /** the person's message whose turn asked for it: the erasure cascade follows it (PRIV-ERASE-005) */
  inboundId?: string
  requesterId: string
  requesterName: string
  requesterRole: string
  originSessionId: string
  policy: { type: 'count' | 'percentage'; value: number; vetoOnRefusal: boolean }
  eligibleRoles: string[]
  approverConnectionType?: ConnectionType
  /** the rule asks for a device-authenticated decision (INTX-APPR-011) */
  attested?: boolean
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
  /** the store the retrieval read (PRIV-SCOPE-003): entries, working_memory, preferences or rag_chunks */
  store?: string
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
  /** the organization key of the partner of a `partner-shared` source (MEM-RAG-005) */
  partner?: string
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

export type TrustBoundKind =
  | 'authentication'
  | 'credential-exchange'
  | 'auth-challenge'
  | 'authorization'
  | 'confirmation'
  | 'signature'
  | 'link-session'

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
      /** the flow serving the capability, when the peer is flow-capable (INTX-FLOW-003) */
      flowId?: string
    }
  /** a flow card, new or updated in place (D55, PROF-MAP-007) */
  | { kind: 'flow'; entry: MessageEntry; card: FlowCard }

export const TRUST_BOUND_KINDS: readonly string[] = [
  'authentication',
  'credential-exchange',
  'auth-challenge',
  'authorization',
  'confirmation',
  'signature',
  'link-session',
]
