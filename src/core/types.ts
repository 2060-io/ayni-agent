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
   * The last authentication that identified or confirmed this Principal (IDENT-AUTH-003): its purpose, the combination,
   * each step's outcome and the entry it identified. An enrolment reads it: within ten minutes, by a combination that
   * holds neither an authenticator app nor a passkey (IDENT-AUTH-014)
   */
  lastAuthentication?: AuthenticationRecord
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
  /** a new phone: the old capability channel and every session that depends on it (IDENT-SESS-003) */
  | 'supersede'
  /** a newer session of the same device on the conversation (IDENT-SESS-014) */
  | 'replaced'
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
  /**
   * the DIDComm connection whose session grant created this session, or the session it is a sibling of: the phone
   * (D56). Each such session gets a device handle of its own, so the admin grant of the phone is keyed to this
   * connection, not to the handle (RBAC-ADMIN-003, `deviceOf`)
   */
  grantConnectionId?: string
  /**
   * the pairing secret minted at binding, held for its client only until the client has collected it, five minutes
   * at most; only its hash stays, on the Principal's device (D51, IDENT-DEV-001)
   */
  deviceSecret?: string
  /** when the secret the session holds was minted */
  deviceSecretAt?: string
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
  /** the feature the source served when the call was made (TOOL-FEAT-019) */
  featureId?: string
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
  /** the feature the source served when the call was made (TOOL-FEAT-019, PROF-TOOL-035) */
  featureId?: string
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
  /**
   * how many minutes an approval of the space waits, per kind of approval (SPACE-DEF-008, D138): in this version
   * `tool-call`, the approval of a call of one of its tools; none for Personal
   */
  approvalTimeouts?: Record<string, number>
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
  /**
   * the one Principal who owns it and controls it (D135, SPACE-MEMB-009); none once the owner's entry left the directory
   * with no successor, until a steward names one (SPACE-MEMB-011)
   */
  ownerPrincipalId?: string
  /** the person the owner named to become the owner when the owner's entry leaves the directory (SPACE-MEMB-010) */
  successorPrincipalId?: string
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
  | 'provider-changed'
  /** the managed folder of a team space (D145 to D149, PROF-TOOL-043) */
  | 'folder-created'
  | 'folder-renamed'
  | 'folder-released'
  | 'access-failed'
  | 'manager-needed'
  | 'account-set'
  | 'account-cleared'
  | 'created'
  | 'rules-changed'
  | 'joined'
  | 'left'
  | 'invited'
  | 'removed'
  | 'owner-changed'
  | 'successor-set'
  | 'successor-cleared'
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
  /** the feature it concerns (PROF-TOOL-006) */
  featureId?: string
  /** a `provider-changed`: the provider it replaced (TOOL-FEAT-007) */
  formerSourceId?: string
  /** an `owner-changed`: how (SPACE-MEMB-012), and the reason a steward gave */
  how?: OwnerChange
  reason?: string
}

/** How the owner of a space changed (SPACE-MEMB-012): handed over, by succession, or named by a steward. */
export type OwnerChange = 'handover' | 'succession' | 'steward'

// ---- approval policies of the tools of a space (ayni-spec D137 to D142) -------------------------------------------------

export type ApproverKind = 'owner' | 'person' | 'member' | 'role' | 'department'

/**
 * One approver of a policy (INTX-APPR-020): the space's owner, one member (`memberId` in a list space, `directoryId` in a
 * rule space), every active member, the holders of a role, the people of a department; required or optional.
 */
export interface ApproverEntry {
  kind: ApproverKind
  memberId?: string
  directoryId?: string
  role?: string
  department?: string
  required: boolean
}

/** The approval policy of a tool of a space whose rule is `approval` (D137, D139, INTX-APPR-020); it holds no timeout. */
export interface SpaceApprovalPolicy {
  approvers: ApproverEntry[]
  /** the number of approvals in total, required ones included */
  threshold: number
  /** `any`: one refusal rejects; `required`: only the refusal of a person a required entry names */
  refusal: 'any' | 'required'
  /** each decision is made on the phone, under its OS authentication */
  attested: boolean
  /** whether an approver who makes the request may count by their own confirmation (INTX-APPR-023) */
  whenApproverAsks: 'another-approver' | 'own-confirmation'
}

/** Where an approval of a tool of a space stands (INTX-APPR-026, D142): the approvals counted, the entries not satisfied. */
export interface ApprovalProgress {
  threshold: number
  approvals: number
  waitingFor: { kind: ApproverKind; name?: string; role?: string; department?: string; required: boolean }[]
}

export type GovernanceNoticeKind =
  | 'owner-changed'
  | 'policy-attention'
  | 'no-approver'
  | 'space-without-owner'
  /** a member's access to the space's managed folder failed: to the owner, while it is not in place (TOOL-FEAT-028) */
  | 'folder-access'

/**
 * A notice of a space's governance in a person's Notifications (INTX-APPR-027, D142): read-only, carrying no content of
 * any conversation. `policy-attention` and `space-without-owner` wait for the person until `resolvedAt`.
 */
export interface GovernanceNotice {
  id: string
  principalId: string
  spaceId: string
  kind: GovernanceNoticeKind
  at: string
  /** what the kind needs, by name: never a value of a conversation */
  subject: {
    space: { id: string; title: string }
    how?: OwnerChange
    from?: { name: string } | null
    to?: { name: string }
    reason?: string
    tool?: { source: string; name: string; title: string }
    entries?: ApprovalProgress['waitingFor']
    requester?: { displayName: string }
    template?: { id: string; title: string }
    formerOwner?: { name: string } | null
    /** `folder-access`: the member, the feature and its provider, the folder, and why (PROF-TOOL-042) */
    member?: { name: string }
    feature?: { id: string; title: string }
    source?: { id: string; title: string }
    folder?: { title: string }
    folderReason?: FolderAccessReason
    /** `folder-access`: the Principal whose access it is, to resolve it once in place */
    memberPrincipalId?: string
  }
  resolvedAt?: string
}

/** The actor of what a reload of the user directory does in a space (SPACE-MEMB-008). */
export const DIRECTORY_ACTOR = 'directory'

/** The actor of what the agent's own code does in a space by itself: a managed folder's members kept in step (D146). */
export const AGENT_ACTOR = 'agent'

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
   * a verification (a presentation, a document read, an address verified by an email code, a face match with its
   * audit fields only, IDENT-AUTH-011) or an issuance, recorded the same way (INTX-ISSUE-014, PRIV-EVID-001)
   */
  kind: 'presentation' | 'document' | 'email' | 'face-match' | 'issuance'
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
  /** a face match: the reference picture used, `document` or `directory`; no image, no score (IDENT-AUTH-011) */
  reference?: string
  /**
   * an issuance of the identity credential: a keyed index of the actor it identifies (the home organization, the
   * schema and the subject key, D59), by which the presented credential finds its record (IDENT-ROLE-012)
   */
  holderIndex?: string
  /** an issuance under a revocable credential definition: where its status is kept, and its revocation (D91) */
  revocation?: IssuedRevocation
  /**
   * an issuance whose profile names the claim of its last day of validity: that day, `YYYY-MM-DD` (INTX-ISSUE-023); the
   * credential is held no more after it (IDENT-AUTH-016)
   */
  validUntil?: string
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
  /**
   * why it is revoked: `directory-removal` (the entry left the directory), `issued-again` (the holder asked for it again
   * on the same connection, INTX-ISSUE-022)
   */
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
  /** the source, and the feature it serves (PROF-TOOL-035): a client shows "Files · Nextcloud" */
  source: { id: string; title: string; feature?: { id: string; title: string } }
  /** the addresses outside the organization that made the call `external` (TOOL-FEAT-013, PROF-TOOL-007) */
  outsideOrganization?: string[]
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
  /** a requester's own confirmation of their own request (INTX-APPR-023) */
  self?: boolean
  /**
   * an approval of a tool of a space: the indexes of its policy's entries that named the approver when they decided, which
   * it keeps satisfying whatever becomes of that person (INTX-APPR-021, INTX-APPR-025)
   */
  satisfies?: number[]
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
  /** a tool of a space's: the policy it was asked under (D137, INTX-APPR-026); its approvers are the people it names */
  spacePolicy?: SpaceApprovalPolicy
  /** a tool of a space's: where it stands, updated at each decision (INTX-APPR-026) */
  progress?: ApprovalProgress
  /** `no-approver`: refused at once, nobody else could decide it (INTX-APPR-024) */
  reason?: 'no-approver'
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
  /**
   * the one entry that draws its card: of the conversation where it was asked, the requester's; no other conversation
   * holds one (D114, INTX-APPR-016)
   */
  entryId?: string
  /** before D114, the cards written in the approvers' sessions and the requester's other ones; no longer written */
  cardEntryIds?: string[]
  /**
   * the approvers it was asked of when it was made (D114, INTX-APPR-017): their Notifications keep listing it, once it
   * ended, as one they could decide while it waited
   */
  approverIds?: string[]
  /** when it ended: decided, cancelled or expired; a past item of the Notifications is listed for a retention from it */
  closedAt?: string
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

export type ChallengeType = 'device' | 'document'
export type ChallengeOutcome = 'pending' | 'completed' | 'failed' | 'expired' | 'unavailable' | 'degraded'

/**
 * One authentication, as the Principal it identified or confirmed keeps it (IDENT-AUTH-003): when, why, the combination
 * the person chose, the types of its methods, each step's outcome and the directory entry it identified.
 */
export interface AuthenticationRecord {
  at: string
  purpose: 'connection' | 'visitor' | 'step-up' | 'admin' | 'enrol'
  combination: string[]
  types: string[]
  /**
   * every step of the flow, in order: a combination left after a declined face-match consent stays here, its face step
   * `failed` with the reason `consent-declined` (D152)
   */
  steps: { method: string; type: string; outcome: 'passed' | 'failed' | 'expired'; reason?: 'consent-declined' }[]
  directoryEntryId?: string
}

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
  /**
   * an approval's card: the requester's, in the conversation where it was asked (`entry`, its card's entry, D114); on a
   * DIDComm peer in chat mode, the question an approver answers from the contextual menu (no entry)
   */
  | { kind: 'approval'; entry?: MessageEntry; approval: ApprovalRecord; update?: boolean }
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
  'confirmation',
  'signature',
  'link-session',
]

// ---- tools in spaces, allowances and the record of each call (ayni-spec D97 to D100) -----------------------------------

/** What waits for the owner's phone (TOOL-SPACE-008): the change, the code the screen shows, and its challenge. */
export interface PendingToolChange {
  id: string
  /** `provider`: the feature's provider in use replaced by `source` (TOOL-FEAT-007) */
  kind: 'add' | 'patch' | 'account' | 'provider'
  /** a change of provider: the new provider, the change waiting on the record of the provider in use (TOOL-FEAT-007) */
  source?: string
  /** what the change sets: bindings, rules; never a value of the account, which is sealed apart */
  bindings?: Record<string, string>
  /** the location list of a feature with a contract the change sets, whole (TOOL-SPACE-014, TOOL-FEAT-014) */
  list?: SpaceToolList
  /** Files: the mode the owner chose with the provider, a folder the agent makes or one that exists (TOOL-FEAT-024) */
  location?: 'managed' | 'existing'
  calls?: Record<string, 'none' | 'confirm' | 'approval' | 'off'>
  /** the approval policies the change sets, each whole, by tool (TOOL-SPACE-018, TOOL-SPACE-019) */
  approvals?: Record<string, SpaceApprovalPolicy>
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
  /** the owner's approval policies, by tool, for a tool whose rule is `approval`; none: the pack's default (TOOL-SPACE-018) */
  approvals?: Record<string, SpaceApprovalPolicy>
  /**
   * the provider of a feature with a contract: its locations, the entries the owner picked from what the provider listed,
   * each with the title it read, or any location (TOOL-SPACE-014, TOOL-FEAT-014)
   */
  list?: SpaceToolList
  /** Files: the mode in use, `managed` when the agent made and keeps the space's folder (D145, TOOL-FEAT-024) */
  location?: 'managed' | 'existing'
  pendingChange?: PendingToolChange
  updatedAt: string
  updatedBy?: string
}

/** Why a managed folder is not ready, as the owner reads it (PROF-TOOL-041). */
export type ManagedFolderReason =
  | 'not-connected'
  | 'scope-missing'
  | 'manager-gone'
  | 'permission-denied'
  | 'unavailable'

/**
 * A team space's folder the agent made at a provider of Files and keeps (D145, TOOL-FEAT-034): its reference, its name as
 * last read, the `requestId` that makes a retry make no second one, its state and whose account manages it. No address.
 */
export interface ManagedFolderRecord {
  spaceId: string
  featureId: string
  sourceId: string
  /** the team root's reference at the store, once made */
  ref?: string
  name: string
  requestId: string
  state: 'creating' | 'ready' | 'needs-manager' | 'failed'
  reason?: ManagedFolderReason
  /** `owner`: the space owner's own account (a shared drive); `manager`: the managing account (D147, D150) */
  managedWith: 'owner' | 'manager'
  /** `owner`: the Principal whose own account manages it now */
  managerPrincipalId?: string
  /** whether the store has the role `manager` on a team root (files §4.7) */
  managers?: boolean
  webUrl?: string
  /** the people the store lists that the agent did not add, by their names only, as last read (D146) */
  addedOutside: { name: string }[]
  /** the ids of the shares the store listed right after the folder was made: the account that made it (files §4.7) */
  baseline?: string[]
  attempts: number
  firstFailedAt?: string
  nextAttemptAt?: string
  lastReadAt?: string
  createdAt: string
  updatedAt: string
}

/** Why a member has no access to a managed folder (TOOL-FEAT-026, TOOL-FEAT-028, PROF-SPACE-003). */
export type FolderAccessReason =
  | 'no-address'
  | 'no-account'
  | 'not-allowed'
  | 'too-many'
  | 'permission-denied'
  | 'unavailable'
  | 'not-connected'

/**
 * A membership of a managed folder the agent made, or is making (D146, TOOL-FEAT-034): the member, the role, the share's
 * id at the store, its state, its reason and its attempts; never the member's address, read at each change.
 */
export interface FolderMembershipRecord {
  spaceId: string
  featureId: string
  principalId: string
  role: 'reader' | 'editor' | 'manager'
  shareId?: string
  state: 'pending' | 'in-place' | 'failed' | 'removing'
  reason?: FolderAccessReason
  attempts: number
  firstFailedAt?: string
  nextAttemptAt?: string
  updatedAt: string
}

/**
 * The locations of a feature with a contract in a space (TOOL-FEAT-014): entries in the owner's order, each the value of the
 * location argument and the title the provider gave it, or any location.
 */
export interface SpaceToolList {
  any?: true
  entries?: { values: Record<string, string>; label: string }[]
}

/**
 * The mark of the provider of a feature with a contract in a space, or in a person's Personal (TOOL-FEAT-016): a random
 * value written before every reference the model reads, renewed whenever the feature's provider changes.
 */
export interface FeatureMarkRecord {
  spaceId: string
  featureId: string
  /** the provider it is the mark of: another provider is another mark */
  sourceId: string
  mark: string
  createdAt: string
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
  /** a reference of another provider of the feature, or of none, in the call: it reached no provider (TOOL-FEAT-016) */
  | 'stale-reference'
  /** a location outside the space's list in the call: it reached no provider (TOOL-CALL-012, TOOL-FEAT-014) */
  | 'outside-list'
  /** approved after the feature's provider in the space changed: it did not run (TOOL-FEAT-009) */
  | 'provider-changed'
  /** a share of a space's managed folder itself, asked by the model: who belongs to it is the space's (TOOL-FEAT-031) */
  | 'managed-root'

/** One call the model asked for (TOOL-PROV-004, D100): no argument, no result, no account value. */
export interface ToolCallRecord {
  id: string
  at: string
  principalId: string
  conversationId: string
  spaceId: string
  sourceId: string
  /** the feature the source served when the call was made (TOOL-FEAT-019) */
  featureId?: string
  toolName: string
  account: CallAccount
  rule: 'none' | 'confirm' | 'approval'
  raisedByUntrusted: boolean
  confirmation?:
    | { approvalId: string; status: ApprovalStatus; decidedBy?: string; at?: string }
    | { allowanceApprovalId: string }
  approval?: { approvalId: string; status: ApprovalStatus; decidedBy: string[] }
  stepUp?: { type: string; outcome: string }
  /**
   * a step-up's re-authentication (IDENT-AUTH-015): the methods of its set and what it ended in, `recent` when an
   * authentication within its `maxAgeMinutes` stood for it
   */
  reauthentication?: { methods: string[]; outcome: string }
  outcome: ToolCallOutcome
  updatedAt: string
}
