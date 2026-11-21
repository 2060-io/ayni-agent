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
  /**
   * The entry of the user directory this Principal holds: the one its identity credential was issued from, by this
   * agent (IDENT-ROLE-012, IDENT-DIR-006). Set when the credential is presented, while the directory holds the entry;
   * cleared when the entry leaves it (IDENT-ROLE-013)
   */
  directoryEntryId?: string
  /**
   * the roles its verified facts give (organization pattern, role rules, overrides); `roles` adds those its directory
   * entry gives, so that a reload of the directory recomputes them without the facts (IDENT-ROLE-002)
   */
  factRoles?: string[]
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
  /**
   * the space it belongs to (SPACE-CONV-001): exactly one, the Principal's Personal space when absent. Set at its
   * creation; changed only before its first message
   */
  spaceId?: string
  /** its author shares it, read-only, with the members of its own space, from this time (SPACE-SHARE-001) */
  sharedAt?: string | null
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
  /**
   * the version of the AG-UI profile the client implements (PROF-SESS-016): a confirmation card is asked only of a
   * session whose client declared 3.4 or later (TOOL-CALL-005); a session without it is one of profile 3.3
   */
  profileVersion?: string
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
  /** the space the request named for its new conversation (PROF-CONV-011), checked when the session binds */
  spaceId?: string
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
  /**
   * the space of its conversation (SPACE-CONV-001): set when it is recorded, changed with its conversation's space
   * before the first message, and followed by the retention of that space (PRIV-RETN-008)
   */
  spaceId?: string
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
  /**
   * on a `tool-call` entry, in the clear beside its sealed arguments and result: the source, the tool, whose account the
   * call ran with, whether the source is untrusted, and the approval record it ran under (TOOL-PROV-001)
   */
  provenance?: ToolProvenance
  /** on a message of the agent: the sources whose tools ran in its turn, each with its kind of account (TOOL-PROV-002) */
  sources?: TurnSource[]
}

/** Whose account a call ran with (D97): none, the agent's, or the space's, with the space. */
export interface CallAccount {
  /** `personal`: the Principal's own account (D104) */
  kind: 'none' | 'agent' | 'space' | 'personal'
  spaceId?: string
}

/** What a tool result records of where it came from (TOOL-PROV-001, D100). */
export interface ToolProvenance {
  sourceId: string
  /** what the source is: a bundled tool acts on the agent's own records and is no source of a reply (TOOL-PROV-002) */
  sourceKind?: 'mcp' | 'http' | 'bundled'
  toolName: string
  account: CallAccount
  untrusted: boolean
  /** the confirmation or approval it ran under, or the confirmation whose allowance covered it */
  approvalId?: string
  /** its call record (TOOL-PROV-004) */
  callId?: string
}

/** A source a turn's tools read, with whose account (TOOL-PROV-002). */
export interface TurnSource {
  sourceId: string
  accountKind: CallAccount['kind']
  spaceId?: string
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
  /**
   * the space it belongs to: the space of the conversation it was taken in (MEM-SPACE-001). The model reads the notes of
   * the space of its conversation only. In the clear: the query filters on it. Personal when absent
   */
  spaceId?: string
  /**
   * In the store only (D77): the content under a key of the note, the `content` field then empty. The memory service
   * reads and writes notes in the clear through the sealed repository (src/memory/sealedMemory.ts).
   */
  sealed?: { keyRef: string; cipher: string }
}

// ---------------------------------------------------------------------------------------------
// Spaces (SPACE-DEF-001, ayni-spec D80..D84): one piece of work in one agent; every conversation belongs to exactly one.

export type SpaceKind = 'personal' | 'team' | 'organization'
export type LawfulBasis = 'consent' | 'contract' | 'legitimate-interest'

export interface SpaceRules {
  /** days the entries of its conversations stay active; then they are archived, legal hold excepted (PRIV-RETN-008) */
  retentionDays: number
  lawfulBasis: LawfulBasis
  /** the model providers (an agent-pack `llm.provider`) that may process its conversations; never empty */
  allowedProviders: string[]
  /** its members may read the conversations their authors share with it */
  handover: boolean
}

/** Membership by rule over verified facts, or by a list the owners keep. */
export type SpaceMembership =
  | { mode: 'rule'; rule: { department?: string; group?: string; organization?: true } }
  | { mode: 'list' }

export interface Space {
  id: string
  /** the agent it belongs to: `metadata.id` of the agent-pack */
  agentId: string
  kind: SpaceKind
  templateId: string
  /** sealed in the store with the purpose and the brief (D77): empty there */
  title: string
  purpose: string
  brief: string
  /** what the agent writes for the space is in this language; the agent's default when null */
  language: string | null
  rules: SpaceRules
  membership: SpaceMembership
  /** the Principals who own it */
  ownerIds: string[]
  createdAt: string
  updatedAt: string
  /** in the store only: title, purpose and brief under a key of the space */
  sealed?: { keyRef: string; cipher: string }
}

export type SpaceRole = 'owner' | 'member' | 'guest'
export type SpaceMemberState = 'invited' | 'active' | 'left'

/** A row of a space's members: an owner, a listed member, an invited person of another organization. */
export interface SpaceMember {
  id: string
  spaceId: string
  /** the Principal, once bound */
  principalId: string | null
  /** the entry of the employee list (ayni-spec D79), for a person of the organization */
  directoryId?: string
  /** a person of another organization, by its organization key and email (SPACE-INV-001); the email is sealed */
  organizationKey?: string
  /** the name the trust graph gives that organization, when it was invited (PROF-SPACE-003) */
  organizationName?: string
  email?: string
  /**
   * the Principals of the invited organization the agent asked, once, for a presentation that reveals their email,
   * their stored evidence holding none (SPACE-INV-004)
   */
  askedPrincipalIds?: string[]
  /** in the store only: the keyed index of the email, to bind a badge to the invitation */
  emailIndex?: string
  state: SpaceMemberState
  role: SpaceRole
  createdAt: string
  updatedAt: string
  /** in the store only: the email under a key of the row */
  sealed?: { keyRef: string; cipher: string }
}

/** What happened in a space (profile 3.3 §3.7): `rules-changed` names the fields an owner changed, never their values. */
export type SpaceActivityAction =
  | 'tool-added'
  | 'tool-changed'
  | 'tool-removed'
  | 'account-set'
  | 'account-cleared'
  | 'created'
  | 'rules-changed'
  | 'joined'
  | 'left'
  | 'invited'
  | 'removed'
  | 'owner-changed'
  | 'shared'
  | 'unshared'

/** What was done in a space, by whom; never the content of a field (only its name). */
export interface SpaceActivity {
  id: string
  spaceId: string
  at: string
  /** the Principal who did it, or `directory` for what a reload of the user directory did (SPACE-MEMB-008) */
  actorId: string
  action: SpaceActivityAction
  fields?: string[]
  memberId?: string
  /** the member concerned when no row of the space names them: a person a rule takes in or out (SPACE-MEMB-008) */
  principalId?: string
  /** the directory entry of the member concerned: a person of the directory added, invited or removed */
  directoryId?: string
  conversationId?: string
  /** the tool source a change of the space's tools concerns (TOOL-SPACE-010); never a value of its account */
  sourceId?: string
}

/** The actor of what a reload of the user directory does in a space (SPACE-MEMB-008). */
export const DIRECTORY_ACTOR = 'directory'

export interface PrincipalPreference {
  principalId: string
  key: string
  value: string
  updatedAt: string
  /**
   * In the store only (D77): the name and the value under a key of the preference; `key` then holds the keyed index
   * of the name (EntryCrypto.blindIndex) and `value` is empty.
   */
  sealed?: { keyRef: string; cipher: string }
}

/**
 * What the agent verified about a Principal: a credential presentation or a document read (D67,
 * PRIV-EVID-002). The audit fields are in the clear and hold no attribute value; the stored values are
 * sealed under the key of the record, which `erase` destroys.
 */
export interface EvidenceRecord {
  id: string
  principalId: string
  /**
   * a verification (a presentation, a document read, an address verified by an email code) or an issuance, recorded
   * the same way (INTX-ISSUE-014, INTX-AUTH-015)
   */
  kind: 'presentation' | 'document' | 'email' | 'issuance'
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
  /**
   * an issuance whose claims came from the user directory: the entry they came from (IDENT-DIR-006). The Principal that
   * presents the credential holds that entry, and the credential is revoked when the entry leaves the directory
   */
  directoryEntryId?: string
  /**
   * an issuance of the identity credential: a keyed index of the actor it identifies (the home organization, the
   * schema and the subject key, D59), by which the presented credential finds its record (IDENT-ROLE-012)
   */
  holderIndex?: string
  /** an issuance under a revocable credential definition: where its status is kept, and its revocation (D91) */
  revocation?: IssuedRevocation
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

/**
 * The revocation of an issued AnonCreds credential (D91, IDENT-ROLE-013): the registry and the index the agent gave it
 * at the offer (the DIDComm agent takes both from the caller), and what became of its revocation. Audit fields, in the
 * clear: no value of a claim.
 */
export interface IssuedRevocation {
  registryDefinitionId: string
  index: number
  /** when the DIDComm agent published the revocation */
  revokedAt?: string
  /** why it is revoked: `directory-removal` (the entry left the directory) */
  reason?: string
  /** when the holder was sent the `revocation_notification` (INTX-FLOW-007) */
  notifiedAt?: string
  /** how many times the notification was tried: it is tried again a few times, then given up */
  notifyAttempts?: number
  /** the last failure of a revocation that is to be done again */
  lastError?: string
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'
/** `confirmation`: the person's own decision on an action of theirs (D99, INTX-APPR-012) */
export type ApprovalKind = 'sensitivity' | 'elevation' | 'confirmation'

/**
 * A tool call as its card shows it (TOOL-CALL-003, INTX-APPR-014): the action's title, the source, whose account, and
 * every argument the tool will receive with its label and its whole value, the pinned ones first. Sealed in the store.
 */
export interface ToolAction {
  title: string
  source: { id: string; title: string }
  /** a `personal` account carries no label here: the requester's own card adds it, and no other (PROF-TOOL-021) */
  account: { kind: CallAccount['kind']; space?: { id: string; title: string }; label?: string }
  fields: { label: string; value: string; pinned?: boolean }[]
  /** the arguments were erased with the message whose turn asked for it (INTX-APPR-015) */
  erased?: boolean
}

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
  /** a tool call's (D99): the conversation it was asked in, and the space whose owner approves a tool of a space */
  conversationId?: string
  spaceId?: string
  /** a tool call's: its source, and the action as its card shows it, sealed in the store (INTX-APPR-014) */
  sourceId?: string
  action?: ToolAction
  /** the space's owner approves it, whatever the roles (INTX-APPR-004) */
  ownerApproval?: boolean
  /** a confirmation: whether its card offers "Allow for this conversation" (PROF-TOOL-007) */
  allowForConversation?: boolean
  /** a confirmation allowed: for this call, or for the conversation (INTX-APPR-012) */
  scope?: 'once' | 'conversation'
  /** an allowance the confirmation gave ended (TOOL-CALL-006) */
  allowanceEndedAt?: string
  /** the titles of the untrusted sources the turn read, when they made the card ask (TOOL-CALL-008) */
  untrustedSources?: string[]
  /** the call record of the call it gates (TOOL-PROV-004) */
  callId?: string
  /** the approval entry of the conversation that shows it as a card */
  entryId?: string
  /** the other entries that carry its card with the action: the approvers' (INTX-APPR-015) */
  cardEntryIds?: string[]
  /**
   * In the store only: the arguments and the action, sealed under a key of the record (INTX-APPR-014, D77); the approval
   * repository opens them, and erasing them destroys that key
   */
  sealed?: { keyRef: string; cipher: string }
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

export type ChallengeType = 'device' | 'face-match' | 'document' | 'email'
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

/**
 * The kind of a `state-update` entry that tells what became of a card shown earlier (a flow, a confirmation): the card's
 * own record, which the model read, stays as it was written, and this record follows it when the card's state changes
 * (LLM-CACHE-004, MEM-RET-006). Never shown to the devices, which read the card itself.
 */
export const CARD_STATE = 'card-state'

export const TRUST_BOUND_KINDS: readonly string[] = [
  'authentication',
  'credential-exchange',
  'auth-challenge',
  'authorization',
  'confirmation',
  'signature',
  'link-session',
]

// ---- tools in spaces, allowances and the record of each call (ayni-spec D97 to D100) -----------------------------------

/** What waits for the owner's phone (TOOL-SPACE-008): the change, the code the screen shows, and its challenge. */
export interface PendingToolChange {
  id: string
  kind: 'add' | 'patch' | 'account'
  /** what the change sets: bindings, rules; never a value of the account, which is sealed apart */
  bindings?: Record<string, string>
  calls?: Record<string, 'none' | 'confirm' | 'approval' | 'off'>
  /**
   * the values of the fields of the account the change sets, sealed together under a key of their own, destroyed when the
   * change is dropped (D102)
   */
  sealedValues?: { keyRef: string; cipher: string }
  /** the names of the values of the bindings a personal account is for, read from the owner's own account (D110) */
  bindingLabels?: Record<string, string>
  summary: string
  code: string
  expiresAt: string
  challengeId?: string
  flowId?: string
  /** the session that made the request */
  sessionId: string
  requestedBy: string
}

/** A source a space's template names, in that space (D98, TOOL-SPACE-001). */
export interface SpaceToolRecord {
  spaceId: string
  sourceId: string
  /** the owner added it, or it came with the space (`add: auto`) and was not removed */
  added: boolean
  /** an `add: auto` source its owner removed: `off` */
  removed?: boolean
  /** the owner's values of the bindings the agent-pack leaves to them */
  bindings: Record<string, string>
  /**
   * the names of the values of the bindings a personal account is for (D110), read from the owner's own account when the
   * owner chose it: "ayni-dev-agent" for a workspace's id
   */
  bindingLabels?: Record<string, string>
  /** the owner's rules, never looser than the pack's (TOOL-SPACE-006) */
  calls: Record<string, 'none' | 'confirm' | 'approval' | 'off'>
  pendingChange?: PendingToolChange
  updatedAt: string
  updatedBy?: string
}

/** The space's account of a source (D97, TOOL-ACCESS-004): its token sealed under a key of its own. */
export interface SpaceAccountRecord {
  spaceId: string
  sourceId: string
  /** the values of the fields of the account, sealed together as ciphertext (base64, D102); never in the clear */
  cipher: string
  /** its key, wrapped by the master key; destroyed with the record */
  encKeyRef: string
  setAt: string
  setByPrincipalId: string
}

/** The key of a person (D106, PRIV-ERASE-013): wrapped by the master key; it wraps the key of each of their accounts. */
export interface PersonKeyRecord {
  principalId: string
  /** a key of 32 bytes, wrapped by the deployment's master key; destroyed when the person's access ends */
  wrappedKey: string
  createdAt: string
}

export type PersonalAccountState = 'connected' | 'reconnect'
export type ReconnectReason = 'expired' | 'revoked' | 'changed'

/**
 * A person's own account of a source (D104, D107, TOOL-ACCESS-009): in the clear only the Principal, the source, the value
 * of its binding and that value's name, the method, the state and its reason, and the times; the tokens or the values of
 * the fields, and the label, sealed together under a key of its own wrapped by the person's key.
 */
export interface PersonalAccountRecord {
  id: string
  principalId: string
  /** the source that declares the account; a source with `account.from` uses it */
  sourceId: string
  /** for a source with `account.binding`: the value the check read, and its name (D110) */
  bindingValue?: string
  bindingLabel?: string
  method: 'oauth' | 'fields'
  state: PersonalAccountState
  reason?: ReconnectReason
  moreAccess?: boolean
  /** the sealed tokens or values (base64); empty once its tokens are destroyed (`reconnect`) */
  cipher: string
  /** the label, sealed apart under the same key (base64): Your accounts reads it without opening the tokens */
  labelCipher?: string
  /** the account's key, wrapped by the person's key; destroyed with the record */
  encKeyRef: string
  /**
   * a digest of how the agent-pack connected the source when the account was made (its URL, registration, client id,
   * issuer, binding), and one of its scopes: an account whose source connects otherwise at a start ends, or goes to
   * reconnect (TOOL-CONN-009); a digest of the agent-pack's settings, nothing of the account
   */
  packDigest: string
  scopesDigest: string
  connectedAt: string
  refreshedAt?: string
  lastUsedAt?: string
}

/** What is sealed in a personal account (D106): never in the clear, never logged, never sent to a client. */
export interface PersonalAccountSecret {
  /** an OAuth account */
  tokens?: {
    accessToken: string
    refreshToken?: string
    /** when the access token expires, if the server said */
    expiresAt?: string
    scopes: string[]
    /** the scopes to ask at the next attempt of this account: those asked and those of a challenge (TOOL-OAUTH-009) */
    wantedScopes?: string[]
    issuer: string
    /** the key of the agent's client at the issuer */
    clientRef: string
    /** the server's URL the token is for, and the only one it is sent to */
    resource: string
  }
  /** an account of fields: one value per field (D102) */
  values?: Record<string, string>
  /** the name the account has at its service (D110) */
  label?: string
}

/** What became of a sign-in (PROF-TOOL-019). */
export type OAuthAttemptOutcome =
  | 'connected'
  | 'denied'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'wrong-binding'
  | 'wrong-person'

/** One sign-in in the browser (D105, TOOL-OAUTH-005): single use, ten minutes by default. */
export interface OAuthAttemptRecord {
  id: string
  principalId: string
  originSessionId: string
  /** the source that declares the account */
  sourceId: string
  /** the space the attempt was started for, for a source of availability spaces */
  spaceId?: string
  /** a digest of its `state`: the callback finds it by it; the state itself is kept nowhere */
  stateHash: string
  /** the value the check must read, and its name (D110); none when the owner connects to choose it */
  expectedBinding?: { value: string; label?: string }
  issuer: string
  /** whether the authorization server says it sends `iss` (RFC 9207) */
  issParameterSupported: boolean
  resource: string
  scopes: string[]
  /** the key of the agent's client at the issuer */
  clientRef: string
  /** the PKCE verifier, sealed under a key of the attempt's own (base64), and that key wrapped by the master key */
  verifierCipher: string
  encKeyRef: string
  createdAt: string
  expiresAt: string
  outcome?: OAuthAttemptOutcome
  endedAt?: string
}

/** The agent's client at one authorization server (D105, TOOL-OAUTH-003): never used at another issuer. */
export interface OAuthClientRecord {
  /** the key of the client: the issuer, and the registration */
  ref: string
  issuer: string
  registration: 'metadata-document' | 'pre-registered' | 'dynamic'
  clientId: string
  /** a secret the registration answered, sealed (base64) under the key below, wrapped by the master key */
  secretCipher?: string
  encKeyRef?: string
  redirectUri: string
  registeredAt: string
}

/** "Allow for this conversation" (TOOL-CALL-006). */
export interface ToolAllowance {
  approvalId: string
  conversationId: string
  sourceId: string
  toolName: string
  /** the space whose source it is, when it is a source of a space */
  spaceId?: string
  /** what it was given under: the rule, the bindings and the account; a change ends it */
  fingerprint: string
  since: string
  endedAt?: string
}

/** What became of a call the model asked for (TOOL-PROV-004). */
export type ToolCallOutcome =
  | 'completed'
  | 'failed'
  | 'refused'
  | 'expired'
  | 'cancelled'
  | 'not-approved'
  | 'unavailable'
  | 'no-approver'
  | 'not-available'
  /** a tool the Principal's roles reach only through an elevation grant, called while none is held (RBAC-TOOL-004) */
  | 'not-granted'
  /** waiting for another person's approval: the record is updated when the call runs or is not approved */
  | 'pending'
  /** the person's own account of the source was not connected when the call was to run (TOOL-CALL-011) */
  | 'not-connected'
  /** the server asked the person's own account for more scopes (TOOL-OAUTH-009) */
  | 'more-access-needed'

/** One call the model asked for (TOOL-PROV-004, D100): no argument, no result, no account value. */
export interface ToolCallRecord {
  id: string
  at: string
  principalId: string
  conversationId: string
  spaceId: string
  sourceId: string
  toolName: string
  account: CallAccount
  rule: 'none' | 'confirm' | 'approval'
  raisedByUntrusted: boolean
  confirmation?:
    | { approvalId: string; status: ApprovalStatus; decidedBy?: string; at?: string }
    | { allowanceApprovalId: string }
  approval?: { approvalId: string; status: ApprovalStatus; decidedBy: string[] }
  stepUp?: { type: string; outcome: string }
  outcome: ToolCallOutcome
  updatedAt: string
}
