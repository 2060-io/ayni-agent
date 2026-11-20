/**
 * Ayni AG-UI Profile 3.4 (2060-io/ayni-spec, v4/ayni-agui-profile/profile.md).
 * Every name below cites the section or the PROF-* requirement it implements.
 *
 * 3.4 over 3.3 (ayni-spec agent D96 to D100, tools, phase 1): the tools of a space, read by its members and managed by
 * its owner, a change that grants something confirmed on the owner's phone (§3.10, PROF-TOOL-001..006,
 * `ayni.space.tools.changed`); the confirmation card of a tool call, an `ayni.approval` of kind `confirmation` decided by
 * `approval.decide` while the turn waits (`scope`, `noTurn: 'decision'`, PROF-TOOL-007/008); the exact action on the
 * approval of a tool call (`action`, `space`, PROF-TOOL-009); the sources a reply used and those a conversation holds
 * (`metadata.sources`, `GET /conversations/{id}/sources`, PROF-TOOL-010/011); stopping an allowance (PROF-TOOL-012);
 * `features.tools` (PROF-DESC-009) and `client.profileVersion` (PROF-SESS-016); the errors of §3.10.
 *
 * 3.3 over 3.2 (ayni-spec agent D80 to D93; ayni-agent decision 60): spaces, their templates, members, activity,
 * ownership and handover (§3.7, PROF-SPACE-*); a conversation belongs to a space (`spaceId`, `shared`,
 * `state.ayni.space`; PROF-CONV-010..012, PROF-STREAM-009); the person's memories and preferences (`/memories`,
 * `/preferences`, `/about-me`; §3.8, PROF-MEM-*), the memories a reply used (`metadata.usedMemories`,
 * `usedPreferences`, PROF-HIST-011), a memory update as `ayni.memory.updated` and the `ayni.memory-update` history
 * item (PROF-STREAM-010, PROF-HIST-012); a person deletes their own message within a window (`features.erasure:
 * { windowSeconds }`, PROF-HIST-010); a run in a space the person left answers `409 space-left` (PROF-RUN-014); the
 * member picker of the user directory, the organizations of the trust graph and the admin view of roles and changes
 * (§3.9, PROF-DIR-001..003); the error codes of §9 with their statuses (`ERROR_STATUS`).
 * `POST {sessions}/conversations/{id}/erasure` is withdrawn (PROF-CONV-009).
 *
 * 3.1 over 3.0: the session grant (`CreateSessionRequest.grant`, `features.sessionGrant`, §4.1), `features.flows`,
 * `client.platform` as `web` | `ios` | `android` with `client.description` (PROF-SESS-014), the `ayni.flow` activity
 * and `flowId` on routed capabilities (§5, §6, PROF-MAP-007), `metadata.flowId` (§8), the `grant-used` and
 * `grant-expired` errors (§9), app links (§10, PROF-LINK-*). A 3.0 UI keeps working against a 3.1 agent.
 */

export const PROFILE_VERSION = '3.4'
export const PROFILE_MAJOR = 3
export const PROFILE_MINOR = 4

/** DID Document service type that references the descriptor (PROF-DESC-001). */
export const DID_SERVICE_TYPE = 'AyniAgUI'
/** Well-known path of the descriptor on the agent origin (PROF-DESC-001). */
export const DESCRIPTOR_PATH = '/.well-known/ayni-agent.json'
/**
 * goal_code of the 3.0 binding invitation (profile section 4). Flow-capable wallets read the flow profile's codes
 * below instead; agents keep emitting this one for wallets without flows.
 */
export const BINDING_GOAL_CODE = 'ayni.bind-session'

/** goal_code values of the flow profile §4 (FLOW-CONN-001): what follows the invitation. */
export const INVITATION_GOAL_CODE = {
  /** just connect */
  connect: 'ayni.connect',
  /** a web UI binding, confirmed by the `link-session` flow */
  linkSession: 'ayni.link-session',
  /** a service-initiated flow follows */
  flow: 'ayni.flow',
} as const

export type InvitationGoalCode = (typeof INVITATION_GOAL_CODE)[keyof typeof INVITATION_GOAL_CODE]

// ---------------------------------------------------------------------------------------------
// Descriptor (section 2)

export interface UploadLimits {
  maxBytes: number
  types: string[]
}

export interface DescriptorFeatures {
  contextualMenu: boolean
  approvals: boolean
  reactions: boolean
  receipts: boolean
  history: boolean
  voiceNotes?: boolean
  uploads: UploadLimits | false
  /** the agent answers the `session-grant` flow (§4.1, PROF-DESC-004); absent on a 3.0 descriptor */
  sessionGrant?: boolean
  /** the agent opens flows through the flow profile rather than question-answer and chat (PROF-DESC-004) */
  flows?: boolean
  /** the agent takes a message sent while a turn is in progress: it waits (PROF-DESC-006, PROF-RUN-011) */
  queue?: boolean
  /** the agent keeps the shared read state: `unread` and `readUpTo` on a conversation (PROF-DESC-005, PROF-CONV-008) */
  readState?: boolean
  /**
   * the agent tells a wallet where it stands with `peer-status/1.0/status`: a client that is also a wallet asks
   * for a session grant only once a status lists `ag-ui` as open (PROF-DESC-007, flow profile §4.1)
   */
  peerStatus?: boolean
  /** the agent publishes the context figure in `state.ayni.context` (PROF-DESC-008, PROF-STREAM-007) */
  context?: boolean
  /**
   * a Principal deletes a message they wrote, with the agent's reply to it, while the message is younger than
   * `windowSeconds` (3.3; PROF-DESC-008, PROF-HIST-010); absent when the agent lets nobody delete. A 3.2 agent declared
   * `true` here: a UI reads a boolean as no window it knows, and offers no deletion.
   */
  erasure?: { windowSeconds: number }
  /**
   * the agent serves the tools of a space (§3.10), the confirmation card of a tool call and the exact action on its
   * approval (§6), and the sources of replies and conversations (§3.6, §8): 3.4, PROF-DESC-009. A UI shows no Tools
   * segment and asks for no sources of an agent that does not declare it.
   */
  tools?: boolean
}

export type BindingMode = 'cross-device' | 'same-device'

export interface AgentDescriptor {
  profileVersion: string
  did: string
  name: string
  description?: string
  logo?: string
  sessions: string
  /**
   * `walletLinkTemplate` is an HTTPS app link on the wallet app's domain with an `{oob}` placeholder, for the Ayni app
   * `https://<app-link-domain>/app/connect?oob={oob}` (PROF-BIND-008); never a `didcomm://` URL.
   */
  binding: { modes: BindingMode[]; walletLinkTemplate: string }
  features: DescriptorFeatures
  locales: string[]
}

// ---------------------------------------------------------------------------------------------
// Sessions (section 3)

export type SessionState = 'provisional' | 'bound' | 'closed'

/** Closure reasons (section 5, ayni.session.state). */
export type ClosureReason =
  | 'user'
  | 'supersede'
  | 'channel-closed'
  | 'credential-invalid'
  | 'idle-timeout'
  | 'expired'
  | 'agent'

export const CLOSURE_REASONS: readonly ClosureReason[] = [
  'user',
  'supersede',
  'channel-closed',
  'credential-invalid',
  'idle-timeout',
  'expired',
  'agent',
]

/** The kind of device a client runs on (PROF-SESS-014). */
export const CLIENT_PLATFORMS = ['web', 'ios', 'android'] as const
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number]

export interface ClientDescription {
  name: string
  version: string
  /**
   * `web`, `ios` or `android` (PROF-SESS-014). A 3.0 client sent free text here ("Firefox on Linux"); a 3.1 agent
   * records such a value as `description` and treats the platform as `web`.
   */
  platform: ClientPlatform | (string & {})
  /** what the phone shows when it links this session: "Firefox on Linux", "Ayni on iPhone" (PROF-SESS-014) */
  description?: string
  /**
   * the version of this profile the client implements (3.4, PROF-SESS-016): the agent asks the confirmation of a tool
   * call only of sessions whose client declared 3.4 or later. A client that implements 3.4 sends it.
   */
  profileVersion?: string
}

export function isClientPlatform(value: unknown): value is ClientPlatform {
  return typeof value === 'string' && (CLIENT_PLATFORMS as readonly string[]).includes(value)
}

export interface CreateSessionRequest {
  client: ClientDescription
  locale?: string
  /** handle of a device the agent bound before (PROF-BIND-009): the agent asks the phone to re-link it */
  deviceHandle?: string
  /** the device secret handed with the handle (PROF-BIND-010): with it the session binds without the phone (PROF-SESS-010) */
  deviceProof?: string
  /** a closed session of the same Principal to resume: its transcript stays readable in the new session (PROF-SESS-009) */
  resumeSessionId?: string
  /** a conversation of the Principal to open on this device (PROF-CONV-005) */
  conversationId?: string
  /** start a new conversation; without it and without a conversation named, the session continues the Principal's latest active one (PROF-CONV-006) */
  newConversation?: boolean
  /** the single-use grant the `session-grant` flow returned (§4.1, PROF-SESS-013): the session is created bound */
  grant?: string
  /**
   * a bound session or none (PROF-SESS-015): the agent binds from the device proof or answers 409
   * `pairing-expired` / `pairing-invalid`, creates no session and asks the phone nothing
   */
  silent?: boolean
  /**
   * with `newConversation: true`, the space of the new conversation (3.3, PROF-CONV-011): one in which the Principal is
   * an active member, else `404`; Personal when absent. For a session the phone binds later, a space the person may
   * not use leaves the new conversation in Personal.
   */
  spaceId?: string
}

export interface BindingMaterial {
  oobUrl: string
  walletLink: string
  bindingCode: string
  expiresAt: string
}

export interface BackingIdentityDisplay {
  kind: 'org' | 'persona'
  name: string
}

export interface PrincipalDisplay {
  displayName: string
  /** attachment reference (id served by the attachments endpoint) or null */
  photo: string | null
  backingIdentity: BackingIdentityDisplay | null
}

export interface CreateSessionResponse {
  sessionId: string
  sessionToken: string
  state: SessionState
  agent: { did: string; name: string }
  /** absent on a sibling session (PROF-SESS-007) */
  binding?: BindingMaterial
  /** present on a sibling session */
  parentSessionId?: string
  principal?: PrincipalDisplay
  idleTimeoutSeconds: number
  /** 'asked' when the phone of the known device received the re-link question (PROF-BIND-009) */
  rebind?: 'asked' | 'unavailable'
  deviceHandle?: string
  /** the rotated device secret of a session bound from a proof, or minted at a phone binding (PROF-BIND-010) */
  deviceSecret?: string
  /** why a presented proof was not accepted (PROF-SESS-010); the client discards its secret */
  pairing?: 'expired' | 'invalid'
  /** set when the resume was accepted (sibling) or recorded for binding (provisional) */
  resumedFromSessionId?: string
  /** the conversation this session serves, once bound (PROF-CONV-005) */
  conversationId?: string
}

export interface SessionStatus {
  sessionId: string
  state: SessionState
  reason?: ClosureReason
  principal: PrincipalDisplay | null
  boundAt?: string
  /** the device secret of a freshly bound session, until the client uses it (PROF-BIND-010) */
  deviceSecret?: string
  /** the conversation this session serves, once bound */
  conversationId?: string
  lastActivityAt: string
  idleTimeoutSeconds: number
  binding?: BindingMaterial
  parentSessionId?: string
  deviceHandle?: string
  resumedFromSessionId?: string
}

// ---------------------------------------------------------------------------------------------
// Custom events on the session stream (section 5)

export const CUSTOM_EVENT = {
  sessionState: 'ayni.session.state',
  sessionBound: 'ayni.session.bound',
  sessionToken: 'ayni.session.token',
  capabilityRouted: 'ayni.capability.routed',
  approvalRequest: 'ayni.approval.request',
  approvalUpdate: 'ayni.approval.update',
  reaction: 'ayni.reaction',
  receipt: 'ayni.receipt',
  /** a conversation of the Principal was renamed, archived, unarchived or closed for good (PROF-CONV-007) */
  conversationChanged: 'ayni.conversation.changed',
  /** messages of a conversation were erased for good: a UI removes them (PROF-STREAM-008) */
  messagesErased: 'ayni.messages.erased',
  /** messages of the person the model never received, taken by an email check: a UI draws them apart (PROF-STREAM-011) */
  messagesWithheld: 'ayni.messages.withheld',
  /** the agent added, changed or removed one of the person's memories in a conversation (3.3) */
  memoryUpdated: 'ayni.memory.updated',
  /** a change of a space's tools applied or was dropped: to every bound session of the space's owner (3.4, PROF-TOOL-006) */
  spaceToolsChanged: 'ayni.space.tools.changed',
} as const

/** What became of a change of a space's tools (3.4, PROF-TOOL-006). */
export type SpaceToolChangeOutcome = 'applied' | 'declined' | 'expired' | 'failed' | 'cancelled'

/**
 * `ayni.space.tools.changed` (3.4, PROF-TOOL-006): a change of a space's tools applied or was dropped. A change that
 * applied at once (`200`) is announced with `outcome: 'applied'` and no `changeId`.
 */
export interface SpaceToolsChangedValue {
  spaceId: string
  source: string
  state: SpaceToolState
  changeId?: string
  outcome: SpaceToolChangeOutcome
}

/** `ayni.messages.erased` (PROF-STREAM-008). */
export interface MessagesErasedValue {
  conversationId: string
  /** the agent's ids of the erased messages */
  messageIds: string[]
  /** the ids the client gave those it sent: a client holds them so until it reads the history again */
  clientIds?: string[]
}

/**
 * `ayni.messages.withheld` (PROF-STREAM-011, 3.3 amended): messages of the person that the model never received, what
 * the code of an email check took. Sent in the run that carried them; the same messages carry
 * `metadata.modelVisible: false` in history (PROF-HIST-013).
 */
export interface MessagesWithheldValue {
  conversationId: string
  /** the agent's ids of the messages */
  messageIds: string[]
  /** the ids the client gave those it sent */
  clientIds?: string[]
}

/** What became of a memory (3.3). */
export type MemoryAction = 'added' | 'changed' | 'removed'

/**
 * `ayni.memory.updated` (3.3): the agent changed one of the person's memories during a turn. The same item is in
 * the history as an `ayni.memory-update` activity, under the agent's id `entryId`; it never carries the memory's
 * content, which the person reads at `GET {sessions}/memories`.
 */
export interface MemoryUpdatedValue {
  conversationId: string
  entryId: string
  memoryId: string
  spaceId: string
  action: MemoryAction
}

export type CustomEventName = (typeof CUSTOM_EVENT)[keyof typeof CUSTOM_EVENT]

export type CapabilityKind =
  | 'authentication'
  | 'credential-exchange'
  | 'auth-challenge'
  | 'authorization'
  | 'confirmation'
  | 'signature'
  | 'link-session'
export type ChallengeType = 'device' | 'face-match' | 'document'
export type CapabilityStatus = 'pending' | 'completed' | 'failed' | 'expired' | 'unavailable' | 'degraded'

export interface SessionStateValue {
  state: SessionState
  reason?: ClosureReason
}

export interface SessionBoundValue {
  principal: PrincipalDisplay
  boundAt: string
  /** opaque handle of this device, presented on later session creations to ask the phone for a re-link */
  deviceHandle?: string
  /** the closed session this one resumes, when the agent accepted it */
  resumedFromSessionId?: string
  /** the device secret minted at this binding (PROF-BIND-010) */
  deviceSecret?: string
  conversationId?: string
}

export interface SessionTokenValue {
  sessionToken: string
}

export interface CapabilityRoutedValue {
  kind: CapabilityKind
  challengeType?: ChallengeType
  status: CapabilityStatus
  originSessionId: string
  expiresAt?: string
  /** operator wording for unavailable or degraded outcomes */
  message?: string
  /** the flow profile's flow id when the capability is served as a flow (PROF-MAP-007) */
  flowId?: string
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'
/** `confirmation` (3.4): the person's own decision on a call of theirs, shown in its conversation only (PROF-TOOL-007) */
export type ApprovalKind = 'sensitivity' | 'elevation' | 'confirmation'

/** Whose account a tool call runs with (3.4): none, the agent's, or the space's. */
export type AccountKind = 'none' | 'agent' | 'space'

/**
 * A tool call as its card shows it (3.4, PROF-TOOL-007/009): the action's title, its source, whose account, and every
 * argument the tool will receive, the pinned ones first, each value whole, as text. After the message whose turn asked
 * for it is deleted within the window, `fields` is empty and `erased` true (agent INTX-APPR-015).
 */
export interface ToolAction {
  title: string
  source: { id: string; title: string }
  account: { kind: AccountKind; space?: { id: string; title: string } }
  fields: { label: string; value: string; pinned?: boolean }[]
  erased?: boolean
}

export interface ApprovalPolicyDisplay {
  type: 'count' | 'percentage'
  value: number
  vetoOnRefusal?: boolean
}

export interface ApprovalRequestValue {
  approvalId: string
  kind: ApprovalKind
  tool: string
  /** `name` is the requester's name as the 3.4 cards write it; `displayName` the same, as earlier revisions did */
  requester: { displayName: string; name?: string; role?: string }
  purpose?: { id: string; label: string }
  justification?: string
  policy: ApprovalPolicyDisplay
  expiresAt: string
  status?: ApprovalStatus
  /** true when the receiving Principal is the requester */
  own?: boolean
  /** true when the receiving Principal may decide */
  canDecide?: boolean
  /** the call of a tool, as its card shows it (3.4, PROF-TOOL-009) */
  action?: ToolAction
  /** the space whose owner approves the call of a tool of the space (3.4, PROF-TOOL-009) */
  space?: { id: string; title: string }
}

export interface ApprovalUpdateValue {
  approvalId: string
  status: ApprovalStatus
  decidedBy?: string
  grantExpiresAt?: string
  /** a confirmation allowed: for this call, or for the conversation (3.4) */
  scope?: 'once' | 'conversation'
  /** the allowance a confirmation gave ended (3.4, PROF-TOOL-012) */
  allowanceEnded?: boolean
}

/**
 * The confirmation card of a tool call (3.4, PROF-TOOL-007): an `ayni.approval` activity of `kind: 'confirmation'`, in
 * the run of the turn and on every other session of the conversation, never an `ayni.approval.request`, never counted
 * in `pendingApprovals`. `allowForConversation` says whether the card offers "Allow for this conversation"; `untrusted`
 * names the untrusted sources the turn read when they made the card ask.
 */
export interface ConfirmationActivity {
  approvalId: string
  kind: 'confirmation'
  status: ApprovalStatus
  expiresAt: string
  requester: { name: string; displayName?: string }
  tool: string
  action: ToolAction
  untrusted?: { sources: string[] }
  allowForConversation: boolean
  scope?: 'once' | 'conversation'
  allowanceEnded?: boolean
}

/**
 * One reaction per person per message (PROF-ACT-003): an `add` replaces whatever the same `by`
 * had on that message; a `remove` clears it.
 */
export interface ReactionValue {
  messageId: string
  emoji: string
  action: 'add' | 'remove'
  by: string
}

/** `metadata` of a history or run message (PROF-HIST-006). */
export interface MessageMetadata {
  createdAt: string
  initiatedAt?: string
  sourceType?: string
  completion?: 'completed' | 'interrupted'
  entryId?: string
  /** the id the client gave this message in the run that sent it, when it was the client's */
  externalId?: string
  /** current reactions on the message, one per person */
  reactions?: { emoji: string; by: string }[]
  /** the message this one answers */
  replyTo?: ReplyReference
  /** on an `ayni.flow` activity, the flow it records (section 8) */
  flowId?: string
  /** on a message of the agent's reply: the ids of the person's memories the turn was given (3.3) */
  usedMemories?: string[]
  /** on a message of the agent's reply: the names of the person's preferences the turn was given (3.3) */
  usedPreferences?: string[]
  /** `false` on a message of the person that the model never received (PROF-HIST-013, 3.3 amended); absent otherwise */
  modelVisible?: false
  /**
   * on a message of the agent whose turn ran tools: the sources of the tool results that turn read, and whose account
   * read them, one item per source and account (3.4, PROF-TOOL-010); absent on a message whose turn ran none
   */
  sources?: MessageSource[]
}

/** A source of a reply (3.4, PROF-TOOL-010). */
export interface MessageSource {
  source: string
  title: string
  account: AccountKind
}

export type ReceiptState = 'received' | 'viewed'

export interface ReceiptValue {
  messageIds: string[]
  state: ReceiptState
}

export interface CustomEventValueMap {
  'ayni.session.state': SessionStateValue
  'ayni.session.bound': SessionBoundValue
  'ayni.session.token': SessionTokenValue
  'ayni.capability.routed': CapabilityRoutedValue
  'ayni.approval.request': ApprovalRequestValue
  'ayni.approval.update': ApprovalUpdateValue
  'ayni.reaction': ReactionValue
  'ayni.receipt': ReceiptValue
  'ayni.messages.erased': MessagesErasedValue
  'ayni.messages.withheld': MessagesWithheldValue
  'ayni.memory.updated': MemoryUpdatedValue
  'ayni.space.tools.changed': SpaceToolsChangedValue
}

// ---------------------------------------------------------------------------------------------
// state.ayni (section 5, PROF-STREAM-004)

export interface ContextualMenuItem {
  id: string
  label: string
  description?: string
  badge?: number
  /** url items open a link instead of sending contextual.select */
  url?: string
}

export interface GeneratingEntry {
  entryId: string
  kind: 'image'
  startedAt: string
}

/** A message of the person that waits for the turn in progress of its conversation to end (PROF-RUN-011). */
export interface WaitingMessage {
  /** the agent's id for the message: the one history gives it */
  id: string
  /** the session it came through */
  sessionId: string
  /** the id the client gave the message */
  messageId?: string
  text: string
  /** how many attachments it has */
  attachments: number
  /** when it was sent */
  at: string
}

/**
 * The context figure of a conversation after its latest turn (PROF-STREAM-007): the input tokens of the turn's last
 * model call, the part of them the provider served from its cache, the token budget of the context window, and when
 * the turn ended.
 */
export interface ContextFigure {
  used: number
  cached: number
  max: number
  at: string
}

/** The space of the session's conversation, as its header shows it (3.3). */
export interface SpaceRef {
  id: string
  title: string
  kind: SpaceKind
}

export interface AyniState {
  /** absent before the first turn, and from an agent that does not declare `features.context` */
  context?: ContextFigure
  /** the space of the conversation, `{ id, title, kind }` (3.3, PROF-STREAM-009); absent from an earlier agent */
  space?: SpaceRef
  contextualMenu: { items: ContextualMenuItem[] }
  pendingApprovals: number
  generating: GeneratingEntry[]
  /** what waits, in the order it arrived, the same on every session of the conversation; absent on an agent without `features.queue` */
  waiting?: WaitingMessage[]
  principal: PrincipalDisplay | null
  /** purposes a human may declare on an elevation request (PROF-RUN-005) */
  purposes?: { id: string; label: string; description?: string }[]
}

export interface AgUiState {
  ayni: AyniState
}

// ---------------------------------------------------------------------------------------------
// Runs and input (section 6)

export type AyniActionKind =
  | 'text'
  | 'menu.select'
  | 'contextual.select'
  | 'approval.decide'
  | 'approval.cancel'
  | 'elevation.request'
  | 'reaction'
  | 'receipt'
  | 'attachments'

export const AYNI_ACTION_KINDS: readonly AyniActionKind[] = [
  'text',
  'menu.select',
  'contextual.select',
  'approval.decide',
  'approval.cancel',
  'elevation.request',
  'reaction',
  'receipt',
  'attachments',
]

/** A message the turn answers: the id of a transcript message of the same conversation (PROF-RUN-009). */
export interface ReplyReference {
  id: string
  /** short excerpt of the quoted message, for rendering; empty for a media message that carries no words of its own */
  text: string
  role: 'user' | 'assistant'
  /** what the quoted message is, when it is a media message: a UI names it ("Photo", "Voice note", the file's name) */
  media?: 'image' | 'voice' | 'video' | 'file'
  filename?: string
}

export type AyniAction =
  | { kind: 'text'; replyTo?: string }
  | { kind: 'menu.select'; menuId: string; itemId: string }
  | { kind: 'contextual.select'; itemId: string }
  | {
      kind: 'approval.decide'
      approvalId: string
      decision: 'approve' | 'reject'
      note?: string
      /** on a confirmation: Allow (`once`) or Allow for this conversation (3.4, PROF-TOOL-008) */
      scope?: 'once' | 'conversation'
    }
  | { kind: 'approval.cancel'; approvalId: string }
  | { kind: 'elevation.request'; tool: string; purposeId: string; justification: string }
  | { kind: 'reaction'; messageId: string; emoji: string; action: 'add' | 'remove' }
  | { kind: 'receipt'; messageIds: string[]; state: ReceiptState }
  | { kind: 'attachments'; attachmentIds: string[]; replyTo?: string }

export interface AyniForwardedProps {
  ayni?: AyniAction
}

/** Activity message types inside runs (section 6). */
export const ACTIVITY = {
  menu: 'ayni.menu',
  attachment: 'ayni.attachment',
  approval: 'ayni.approval',
  capability: 'ayni.capability',
  flow: 'ayni.flow',
  generating: 'ayni.generating',
  /** a line of the transcript: the agent added, changed or removed a memory of the person (3.3) */
  memoryUpdate: 'ayni.memory-update',
} as const

export type ActivityType = (typeof ACTIVITY)[keyof typeof ACTIVITY]

export interface MenuActivity {
  menuId: string
  prompt: string
  items: { id: string; label: string; description?: string }[]
  /** set once answered */
  selectedItemId?: string
}

export type AttachmentType = 'image' | 'voice' | 'video' | 'file'

export interface AttachmentActivity {
  attachmentId: string
  type: AttachmentType
  mimeType: string
  /** a short text stand-in: a caption, a transcription, a description; long extractions stay on the agent */
  textRepr: string
  /** who sent it: the person (`user`) or the agent (`assistant`) */
  role?: 'user' | 'assistant'
  size?: number
  width?: number
  height?: number
  /** the length of a voice note or a video, in seconds */
  duration?: number
  /**
   * The shape of a voice note's sound, as its recorder measured it: up to 64 levels, each a whole number from 0
   * (silence) to 100 (the loudest of the note), from its start to its end (PROF-HIST-009).
   */
  waveform?: number[]
  filename?: string
  thumbnailId?: string
}

export type ApprovalActivity = ApprovalRequestValue & { status: ApprovalStatus }
export type CapabilityActivity = CapabilityRoutedValue

/** Lifecycle of a flow (flow profile §5.2). */
export type FlowState = 'pending' | 'active' | 'completed' | 'declined' | 'cancelled' | 'failed' | 'expired'
export type FlowOutcome = 'completed' | 'declined' | 'cancelled' | 'failed' | 'expired'

export interface FlowReference {
  type: string
  id: string
}

/**
 * The flow card (section 6, PROF-MAP-007; app spec §8.5): one per flow whose origin is a conversation, ordered at
 * `openedAt`, replaced in place at close. `preview` holds only what the person received or disclosed, in a shape per
 * kind that the agent pack may restrict.
 */
export interface FlowActivity {
  flowId: string
  /** a kind of the flow profile §6: `present`, `issue`, `authorize`, `sign-tx`, `link-session`... */
  kind: string
  state: FlowState
  title: string
  openedAt: string
  closedAt?: string
  outcome?: FlowOutcome
  references?: FlowReference[]
  preview?: Record<string, unknown>
}
export interface GeneratingActivity {
  entryId: string
  kind: 'image'
}

/** The `ayni.memory-update` activity (3.3): which memory changed and how, never its content. */
export interface MemoryUpdateActivity {
  memoryId: string
  spaceId: string
  action: MemoryAction
}

/** Interrupt reasons the agent uses (PROF-RUN-006). */
export const INTERRUPT_REASON = {
  menu: 'ayni.menu',
} as const

/** RunError codes the agent uses (PROF-RUN-007). */
export const RUN_ERROR_CODE = {
  cancelled: 'cancelled',
  notBound: 'not-bound',
  closed: 'closed',
  internal: 'internal',
  /** more messages wait in the conversation than the agent lets wait (PROF-RUN-011) */
  tooManyWaiting: 'too-many-waiting',
} as const

/** The outcome of a run that ended without a turn of its own: the run named answers its message (PROF-RUN-012). */
export interface MergedRunOutcome {
  type: 'merged'
  runId: string
}

/**
 * Why a run gets no turn (PROF-RUN-011): its message was recorded and waits for the turn in progress to end, the
 * agent refused it (too many wait), or the caller gave up while its action waited for its turn. Carried by the
 * run's `RunStarted` as `noTurn`.
 */
export type NoTurn = 'waiting' | 'refused' | 'withdrawn' | 'decision'

/**
 * The outcome of an `approval.decide` run on a confirmation (3.4, PROF-TOOL-008): it starts no turn, and says the status
 * the confirmation has now: the one it took, or the one an earlier decision gave it.
 */
export interface DecisionRunOutcome {
  type: 'decision'
  approvalId: string
  status: ApprovalStatus
}

/** The outcome of a run whose message waits: the agent's id for it (PROF-RUN-011). */
export interface WaitingRunOutcome {
  type: 'waiting'
  messageId: string
}

/**
 * What a `RunStarted` says of a run that gets no turn, undefined for any other event. A UI gives the events of
 * such a response no effect on the run it shows in progress (PROF-RUN-013).
 */
export function noTurnOf(event: { type?: unknown; noTurn?: unknown }): NoTurn | undefined {
  if (event.type !== 'RUN_STARTED') return undefined
  return event.noTurn === 'waiting' ||
    event.noTurn === 'refused' ||
    event.noTurn === 'withdrawn' ||
    event.noTurn === 'decision'
    ? event.noTurn
    : undefined
}

// ---------------------------------------------------------------------------------------------
// History (section 8)

/** A conversation of the Principal with this agent (section 3.6, PROF-CONV-001). */
export type ConversationState = 'active' | 'archived'

export interface ConversationInfo {
  id: string
  title: string
  state: ConversationState
  createdAt: string
  lastActivityAt: string
  lastPreview?: string
  /** a session is open on it somewhere */
  open: boolean
  /** the messages from the agent after the read marker, the same on every device (PROF-CONV-008) */
  unread?: number
  /** the read marker: the newest message the person has seen on any device, null while none */
  readUpTo?: string | null
  /** the space it belongs to (3.3) */
  spaceId?: string
  /** its author shares it, read-only, with the members of its space (3.3) */
  shared?: boolean
}

/** The value of `ayni.conversation.changed` (PROF-CONV-007). */
export interface ConversationChangedValue {
  conversationId: string
  title: string
  state: ConversationState | 'final'
  unread?: number
  readUpTo?: string | null
  /** the space it belongs to, and whether it is shared with it (3.3) */
  spaceId?: string
  shared?: boolean
}

export interface ConversationsResponse {
  conversations: ConversationInfo[]
}

export interface ConversationPatch {
  title?: string
  state?: ConversationState
  /** another space, only before the conversation's first message: 409 `has-messages` after it (3.3, PROF-CONV-011) */
  spaceId?: string
}

/** A paired device of the Principal (PROF-SESS-011). */
export interface DeviceInfo {
  handle: string
  client: ClientDescription
  createdAt: string
  lastUsedAt: string
  /** the caller's own device */
  current: boolean
}

export interface DevicesResponse {
  devices: DeviceInfo[]
}

export interface HistoryPage {
  messages: unknown[]
  nextBefore: string | null
}

export interface UploadResponse {
  attachmentId: string
  type: AttachmentType
  mimeType: string
  size: number
  /** what the agent kept of the measures the sender gave of a voice note (PROF-HIST-009) */
  duration?: number
  waveform?: number[]
}

// ---------------------------------------------------------------------------------------------
// Errors (section 9)

/**
 * Every error code of §9 with its status, as the reference agent answers them. `ErrorCode` is derived from it, so that
 * a client and the agent read one list. `forbidden` is the reference agent's beyond §9 (an agent-pack that turns
 * sibling sessions off, PROF-SESS-007).
 */
export const ERROR_STATUS = {
  'bad-request': 400,
  unauthorized: 401,
  /** a bound-only endpoint called with a provisional session */
  'not-bound': 403,
  /** 3.3: only the owner of the space does this (§3.7) */
  'not-owner': 403,
  /** 3.3: the person holds no creator role of the template; the member picker for a person who may add nobody (§3.7, §3.9) */
  'not-creator': 403,
  /** 3.3: only a holder of an admin role reads the admin view (PROF-DIR-003) */
  'not-admin': 403,
  'not-found': 404,
  /** binding material still valid on `POST /binding` (with `binding`); a run that already ended */
  conflict: 409,
  /** `POST {sessions}` with a grant already used (§3.2, PROF-SESS-013) */
  'grant-used': 409,
  /** `POST {sessions}` with a grant past its sixty seconds */
  'grant-expired': 409,
  /** `silent: true` with a pairing that expired, or with no valid proof (PROF-SESS-015) */
  'pairing-expired': 409,
  'pairing-invalid': 409,
  /** 3.3: a message older than the deletion window (`features.erasure.windowSeconds`, PROF-HIST-010) */
  'window-passed': 409,
  /** 3.3: a message on legal hold is not deleted (PROF-HIST-010) */
  'legal-hold': 409,
  /** 3.3: a conversation that has a message of the person keeps its space (PROF-CONV-011) */
  'has-messages': 409,
  /** 3.3: the space takes no handover, Personal included (PROF-CONV-012) */
  'handover-not-allowed': 409,
  /** a conversation closed for good: not reopened, not shared (PROF-CONV-012) */
  final: 409,
  /** 3.3: the Personal space has no settings, members or owner (§3.7) */
  'personal-space': 409,
  /** 3.3: the members of a rule space follow its rule (§3.7) */
  'rule-membership': 409,
  /** 3.3: the owner is not removed: they give the space first (§3.7) */
  owner: 409,
  /** 3.3: the person is a member of the space already (§3.7) */
  'already-member': 409,
  /** 3.3: the authentication entry does not accept credentials of that organization (§3.7) */
  'organization-not-accepted': 409,
  /** 3.3: a run on a conversation of a space the person is no longer a member of: readable, no run (PROF-RUN-014) */
  'space-left': 409,
  closed: 410,
  'too-large': 413,
  /** 3.3: a value outside the bounds of the space's template, with `field` (PROF-SPACE-004) */
  'out-of-bounds': 422,
  /** 3.3: the organization is not found trusted in the trust graph (§3.7) */
  'not-on-verana': 422,
  /** 3.3: the agent's own organization is picked from the directory, not invited (§3.7) */
  'home-organization': 422,
  /** 3.3: the space is given to an active member of the organization only (PROF-SPACE-006) */
  'not-eligible': 422,
  'rate-limited': 429,
  /** 3.3: the agent cannot send email: no SMTP server is configured (§3.7) */
  'email-unavailable': 503,
  /** the agent-pack turns sibling sessions off (the reference agent, beyond §9) */
  forbidden: 403,
  /** 3.3: a message whose reply is being written, whose turn did not stop in time: nothing changed, ask again (PROF-HIST-010) */
  'turn-in-progress': 409,
  /** 3.4: the source is in the space already (§3.10) */
  'already-added': 409,
  /** 3.4: a source `available` or `off` takes no bindings, rules or account (§3.10) */
  'not-added': 409,
  /** 3.4: a change of the source waits for the owner's phone (§3.10, PROF-TOOL-002..004) */
  'change-pending': 409,
  /** 3.4: the calls of the source do not run with an account of the space (§3.10, PROF-TOOL-004) */
  'no-space-account': 409,
  /** 3.4: no capability channel of the owner can serve the confirmation of a change (§3.10) */
  'confirmation-unavailable': 409,
  /** 3.4: a binding the source does not declare, or a value that does not match its pattern, with `field` (§3.10) */
  'bad-binding': 422,
  /** 3.4: a binding the agent-pack sets, with `field` (§3.10) */
  'pinned-by-pack': 422,
  /** 3.4: a rule looser than the agent-pack's, with `field` (§3.10) */
  'looser-than-pack': 422,
  /** 3.4: a token empty, longer than 4096 characters, or not matching the account's pattern (§3.10) */
  'bad-token': 422,
} as const

export type ErrorCode = keyof typeof ERROR_STATUS

/** The error codes of §9 and of the reference agent. */
export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[]

export interface ErrorBody {
  error: ErrorCode | string
  reason?: ClosureReason
  message?: string
  binding?: BindingMaterial
  /** the field an `out-of-bounds` refusal names (3.3) */
  field?: string
}

/** Binding code format: two letters, a dash, two letters or digits, derived from the nonce (section 3.2). */
export const BINDING_CODE_PATTERN = /^[A-Z0-9]{2}-[A-Z0-9]{2}$/

// ---------------------------------------------------------------------------------------------
// App links (section 10, PROF-LINK-001..003)

/** The app-link domain of each network (section 10; app spec D39): the hosts of the web UI. */
export const APP_LINK_DOMAIN = {
  devnet: 'app.dev.ayni.org',
  testnet: 'app.test.ayni.org',
  mainnet: 'app.ayni.org',
} as const

export type AppLinkNetwork = keyof typeof APP_LINK_DOMAIN

/** The first path segment after `/app/` of every destination of section 10. */
export const APP_LINK_ROUTES = [
  'home',
  'recent',
  'scan',
  'explore',
  'wallet',
  'service',
  'settings',
  'connect',
] as const
export type AppLinkRoute = (typeof APP_LINK_ROUTES)[number]

/** The only query parameters a link may carry (PROF-LINK-003); a UI ignores any other. */
export const APP_LINK_PARAMS = ['q', 'to', 'amount', 'memo', 'oob'] as const
export type AppLinkParam = (typeof APP_LINK_PARAMS)[number]

export interface AppLink {
  route: AppLinkRoute
  /** the path segments after the route: a controller key, `documents`, `card` and an id, a DID, `backup`... */
  segments: string[]
  params: Partial<Record<AppLinkParam, string>>
}

/** Builds an HTTPS app link of section 10 on the given app-link domain (PROF-LINK-001). */
export function buildAppLink(
  domain: string,
  route: AppLinkRoute,
  segments: string[] = [],
  params: Partial<Record<AppLinkParam, string>> = {}
): string {
  const path = ['app', route, ...segments.map((segment) => encodeURIComponent(segment))].join('/')
  const url = new URL(`https://${domain}/${path}`)
  for (const key of APP_LINK_PARAMS) {
    const value = params[key]
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

/**
 * Reads an app link (PROF-LINK-002): null when the URL is not HTTPS on the app-link domain, or not an `/app/<route>`
 * path of section 10. Parameters outside PROF-LINK-003 are dropped. Links navigate, never act.
 */
export function parseAppLink(url: string, domain: string): AppLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.host.toLowerCase() !== domain.toLowerCase()) return null

  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (segments.length < 2 || segments[0] !== 'app') return null
  const route = segments[1]
  if (!(APP_LINK_ROUTES as readonly string[]).includes(route)) return null

  const params: Partial<Record<AppLinkParam, string>> = {}
  for (const key of APP_LINK_PARAMS) {
    const value = parsed.searchParams.get(key)
    if (value !== null) params[key] = value
  }
  return { route: route as AppLinkRoute, segments: segments.slice(2), params }
}

/** Whether a URL is a link on the app-link domain, whatever its path. */
export function isAppLink(url: string, domain: string): boolean {
  return parseAppLink(url, domain) !== null
}

// ---------------------------------------------------------------------------------------------
// Spaces (3.3): `{sessions}/spaces`, a bound session's token

export type SpaceKind = 'personal' | 'team' | 'organization'
export type SpaceRole = 'owner' | 'member' | 'guest'
export type LawfulBasis = 'consent' | 'contract' | 'legitimate-interest'

/** What a space keeps and how (3.3): its conversations' retention, lawful basis, models, handover. */
export interface SpaceRules {
  /** days the entries of its conversations stay active, then they are archived (PRIV-RETN-008) */
  retentionDays: number
  lawfulBasis: LawfulBasis
  /** the model providers that may process its conversations (an agent-pack `llm.provider`) */
  allowedProviders: string[]
  /** its members may read the conversations their authors share with it */
  handover: boolean
}

/** Membership by rule, over verified facts: a department, a group, or the whole organization. */
export interface SpaceMembershipRule {
  department?: string
  group?: string
  organization?: true
}

export interface SpaceMembership {
  mode: 'rule' | 'list'
  rule?: SpaceMembershipRule
  /** the people the rule gives, or the listed members invited or active */
  memberCount: number
}

export interface SpaceInfo {
  id: string
  kind: SpaceKind
  /** Personal's is `Personal`: a UI writes its own word for it */
  title: string
  purpose: string
  brief: string
  /** null for Personal */
  templateId: string | null
  /** the language the agent writes the space's own data in; null: the agent's default language */
  language: string | null
  rules: SpaceRules
  membership: SpaceMembership
  owner: { name: string }
  /** the caller's role in it */
  role: SpaceRole
  /** `left`: the caller's own conversations of it stay readable, and take no run (409 `space-left`) */
  state: 'active' | 'left'
  /** the agent messages the caller has not read in their conversations of it */
  unread: number
  lastActivityAt: string
}

/** A template the caller may create from (PROF-SPACE-001); `rules`, the bounds an owner works within, is additive. */
export interface SpaceTemplateInfo {
  id: string
  title: string
  kind: Exclude<SpaceKind, 'personal'>
  membership: 'rule' | 'list'
  /** the rule of a rule template */
  rule?: SpaceMembershipRule
  rules?: {
    retentionDays: { default: number; min?: number; max?: number }
    lawfulBasis: { default: LawfulBasis; allowed: LawfulBasis[] }
    allowedProviders: { default: string[]; allowed: string[] }
    handover: { default: boolean; allowed: boolean[] }
  }
}

/** `GET {sessions}/spaces`: Personal first, then the others; the templates the caller may create from. */
export interface SpacesResponse {
  spaces: SpaceInfo[]
  templates: SpaceTemplateInfo[]
}

/** `POST {sessions}/spaces` (PROF-SPACE-002). */
export interface CreateSpaceRequest {
  templateId: string
  title: string
  purpose: string
  brief?: string
}

export interface SpaceMemberInfo {
  memberId: string
  name: string
  organization: string | null
  state: 'active' | 'invited' | 'left'
  role: SpaceRole
}

/** `GET {sessions}/spaces/{id}`: the space, and, for an active member of a list space, its members. */
export interface SpaceDetail extends SpaceInfo {
  members?: SpaceMemberInfo[]
  createdAt: string
  updatedAt: string
}

/** `PATCH {sessions}/spaces/{id}` (an owner): within the template's bounds, 422 `out-of-bounds` with `field` outside. */
export interface SpacePatch {
  title?: string
  purpose?: string
  brief?: string
  language?: string | null
  rules?: Partial<SpaceRules>
}

/** `POST {sessions}/spaces/{id}/members`: a person of the employee list, or of another organization. */
export type AddMemberRequest = { directoryId: string } | { organizationKey: string; email: string }

/** `POST {sessions}/spaces/{id}/owner`: a member of a list space, or a person of the directory for a rule space. */
export type OwnerTransferRequest = { memberId: string } | { directoryId: string }

export type SpaceActivityKind =
  | 'tool-added'
  | 'tool-changed'
  | 'tool-removed'
  | 'account-set'
  | 'account-cleared'
  | 'created'
  | 'joined'
  | 'left'
  | 'invited'
  | 'removed'
  | 'owner-changed'
  | 'rules-changed'
  | 'shared'
  | 'unshared'

/** One line of `GET {sessions}/spaces/{id}/activity?before=&limit=` (the owner): never the value of a field. */
export interface SpaceActivityItem {
  id: string
  at: string
  kind: SpaceActivityKind
  by?: { name: string }
  member?: { name: string }
  /** the names of the fields a `rules-changed` changed */
  fields?: string[]
  conversationId?: string
  /** the source a change of the space's tools concerns (3.4); never a value of its account */
  tool?: { source: string; title: string }
}

export interface SpaceActivityPage {
  activity: SpaceActivityItem[]
  nextBefore: string | null
}

/** `POST {sessions}/conversations/{id}/share`: the author shares a conversation with its own space. */
export interface ShareResponse {
  shared: true
  sharedAt: string
  conversationId: string
  spaceId: string
}

/** One line of `GET {sessions}/spaces/{id}/shared`: a conversation its author shares with the space. */
export interface SharedConversationInfo {
  id: string
  title: string
  author: { name: string }
  sharedAt: string
  lastActivityAt: string
}

// ---------------------------------------------------------------------------------------------
// People, organizations and the admin view (3.3, §3.9): `{sessions}/directory`, `/organizations`, `/admin/*`

/** One person of `GET {sessions}/directory?q=` (PROF-DIR-001): the member picker sees a name and a department only. */
export interface DirectoryPerson {
  directoryId: string
  /** first and last name */
  name: string
  department: string | null
}

/** `GET {sessions}/directory?q=`: at most 20, to a person who owns a list space or may create one (else 403). */
export interface DirectoryResponse {
  people: DirectoryPerson[]
}

/** One organization of `GET {sessions}/organizations?q=` (PROF-DIR-002), found in the trust graph. */
export interface OrganizationInfo {
  organizationKey: string
  name: string
  country: string
}

export interface OrganizationsResponse {
  organizations: OrganizationInfo[]
}

/** One entry of `GET {sessions}/admin/roles` (PROF-DIR-003): who holds which role, and the entry that gives it. */
export interface AdminRoleEntry {
  directoryId: string
  name: string
  department: string | null
  groups: string[]
  roles: string[]
  /** a Principal of the agent holds the entry */
  onAgent: boolean
}

export interface AdminRolesResponse {
  entries: AdminRoleEntry[]
}

/** One change a reload of the directory made (PROF-DIR-003): field names, never a value. */
export interface DirectoryChangeItem {
  at: string
  kind: 'added' | 'removed' | 'changed'
  directoryId: string
  name: string
  /** the names of the fields that changed */
  fields: string[]
  /** when the roles changed */
  rolesBefore?: string[]
  rolesAfter?: string[]
}

/** `GET {sessions}/admin/changes?before=&limit=`: newest first. */
export interface AdminChangesResponse {
  changes: DirectoryChangeItem[]
  nextBefore: string | null
}

// ---------------------------------------------------------------------------------------------
// Memories and preferences (3.3): the person's own, never another's

export interface PreferenceInfo {
  key: string
  value: string
  updatedAt: string
}

export interface MemoryInfo {
  id: string
  spaceId: string
  content: string
  createdAt: string
  updatedAt: string
  /** the conversation it was taken from, while the person can still read it */
  source?: { conversationId: string; title: string }
}

/** `GET {sessions}/memories?spaceId=`: every preference, and the memories of the space (of every space without it). */
export interface MemoriesResponse {
  preferences: PreferenceInfo[]
  memories: MemoryInfo[]
}

/** `GET {sessions}/about-me`: what the agent keeps about the person. */
export interface AboutMeResponse {
  preferences: PreferenceInfo[]
  memoriesBySpace: { spaceId: string; title: string; count: number }[]
  conversations: { spaceId: string; title: string; count: number; retentionDays: number | null }[]
  verified: { label: string; source: string | null; verifiedAt: string; expiresAt: string | null }[]
}

// ---------------------------------------------------------------------------------------------
// Tools (3.4, §3.10 and §3.6): `{sessions}/spaces/{id}/tools`, `/conversations/{id}/sources`, `/allowances`

/** What a tool does (agent D99): it gives its default rule. */
export type ToolEffect = 'read' | 'write' | 'delete' | 'external'
export const TOOL_EFFECTS: readonly ToolEffect[] = ['read', 'write', 'delete', 'external']
/** What a call needs: nothing, the person's confirmation, an approval; `off` in a space: not given to the model. */
export type SpaceCallRule = 'none' | 'confirm' | 'approval' | 'off'
export const SPACE_CALL_RULES: readonly SpaceCallRule[] = ['none', 'confirm', 'approval', 'off']
/** A source in a space: offered, added but not bound or without its account, ready, or an automatic one removed. */
export type SpaceToolState = 'available' | 'setup' | 'ready' | 'off'
export const SPACE_TOOL_STATES: readonly SpaceToolState[] = ['available', 'setup', 'ready', 'off']

/**
 * A source of a space, as `GET {sessions}/spaces/{id}/tools` gives it (PROF-TOOL-001). To the owner, every source the
 * template names, with every field; to another active member, the `ready` sources, without `add`, the bindings' `name`,
 * `setBy` and `pattern`, the tools' `name` and `packRule`, the account's status, and `pending`. No answer carries a token.
 */
export interface SpaceTool {
  source: string
  title: string
  description?: string
  state: SpaceToolState
  /** the owner's: added to every space of the template (`auto`) or by each owner (`owner`) */
  add?: 'auto' | 'owner'
  guests: boolean
  account: {
    kind: AccountKind
    /** the owner's, for a `space` account: what is asked, the pattern, whether it is set, when and by whom */
    label?: string
    pattern?: string
    set?: boolean
    setAt?: string | null
    setBy?: { name: string } | null
  }
  bindings: {
    name?: string
    label: string
    value: string | null
    setBy?: 'pack' | 'owner'
    pattern?: string | null
  }[]
  tools: {
    name?: string
    title: string
    effect: ToolEffect | null
    /** the rule in force in this space */
    rule: SpaceCallRule
    /** the owner's: the agent-pack's rule, the loosest the owner may choose */
    packRule?: Exclude<SpaceCallRule, 'off'>
    stepUp: 'device' | 'face-match' | 'document' | null
  }[]
  /** the owner's: the change waiting for the owner's phone */
  pending?: { changeId: string; summary: string; code: string; expiresAt: string } | null
}

export interface SpaceToolsResponse {
  tools: SpaceTool[]
}

/** `POST {sessions}/spaces/{id}/tools` (PROF-TOOL-002): answered `202 { tool }` with its `pending` change. */
export interface AddSpaceToolRequest {
  source: string
  bindings?: Record<string, string>
  calls?: Record<string, SpaceCallRule>
}

/** `PATCH {sessions}/spaces/{id}/tools/{source}` (PROF-TOOL-003): `200` applied, or `202` with `pending`. */
export interface SpaceToolPatch {
  bindings?: Record<string, string>
  calls?: Record<string, SpaceCallRule>
}

/** `PUT {sessions}/spaces/{id}/tools/{source}/account` (PROF-TOOL-004): answered `202 { tool }` with `pending`. */
export interface SpaceAccountRequest {
  token: string
}

export interface SpaceToolResponse {
  tool: SpaceTool
}

/** One source of `GET {sessions}/conversations/{id}/sources` (PROF-TOOL-011). */
export interface ConversationSource {
  source: string
  title: string
  account: { kind: AccountKind; space?: { id: string; title: string } }
  /** how many results of it the conversation holds */
  results: number
  /** the time of the latest */
  lastAt: string
}

export interface ConversationSourcesResponse {
  sources: ConversationSource[]
}
