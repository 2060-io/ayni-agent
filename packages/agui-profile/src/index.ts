/**
 * Ayni AG-UI Profile 3.5 (2060-io/ayni-spec, v4/ayni-agui-profile/profile.md).
 * Every name below cites the section or the PROF-* requirement it implements.
 *
 * 3.5, amended 2026-11-21 (ayni-spec agent D114, found on devnet): approvals reach each person once. The requester's
 * card is one `ayni.approval` activity of the conversation where it was asked, replaced in place by each later status
 * (PROF-TOOL-009); the approver gets no card and no `ayni.approval.request`, which is withdrawn: the request is on their
 * phone and in the Notifications of the space or of the agent (§3.12, `NotificationsPage`, PROF-TOOL-024), kept current
 * by `ayni.space.notifications.changed` (PROF-TOOL-025) and counted in `notificationsWaiting` (§3.7). `approval.decide`
 * and `approval.cancel` start no turn (`noTurn: 'decision'`); an approval to attest answers `decide-on-phone` and is sent
 * to the phone again by `POST {sessions}/approvals/{approvalId}/resend` (PROF-TOOL-026); app links to the Notifications
 * (§10, `approval`, PROF-LINK-005); `features.notifications` (PROF-DESC-011). Not additive; `profileVersion` stays 3.5.
 *
 * 3.5 over 3.4 (ayni-spec agent D104 to D110, tools, phase 2): each person's own accounts, listed and managed in Your
 * accounts (§3.11, PROF-TOOL-014..018); the sign-in in the browser, sent back to the agent and from it to the app link
 * `/app/service/{did}/accounts` (§10, PROF-LINK-004); `ayni.connections.changed` (§5, PROF-TOOL-019); the Connect card,
 * the activity `ayni.connect` (§6, PROF-TOOL-020); the kind of account `personal` in the shapes of 3.4, and the binding of
 * a space set from an account of its owner (`valueLabel`, `fromAccount`, `choices`, PROF-TOOL-021); a message held back
 * because it carried a credential (`reason: 'credential'`, `texts`, `metadata.withheld`, PROF-STREAM-011, PROF-HIST-013);
 * `features.connections` (PROF-DESC-010); the errors of §3.11. Additive: a 3.4 client keeps working against a 3.5 agent.
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

export const PROFILE_VERSION = '3.5'
export const PROFILE_MAJOR = 3
export const PROFILE_MINOR = 5

/** DID Document service type that references the descriptor (PROF-DESC-001). */
export const DID_SERVICE_TYPE = 'AyniAgUI'
/** Well-known path of the descriptor on the agent origin (PROF-DESC-001). */
export const DESCRIPTOR_PATH = '/.well-known/ayni-agent.json'
/** goal_code values of the flow profile §4 (FLOW-CONN-001): what follows the invitation. */
export const INVITATION_GOAL_CODE = {
  /** just connect */
  connect: 'ayni.connect',
  /** a web UI binding, confirmed by the `link-session` flow */
  linkSession: 'ayni.link-session',
  /** a service-initiated flow follows */
  flow: 'ayni.flow',
} as const

/** goal_code of a binding invitation (profile section 4, flow profile §4, FLOW-CONN-001): `ayni.link-session`. */
export const BINDING_GOAL_CODE = INVITATION_GOAL_CODE.linkSession

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
  /**
   * the agent serves each person's own accounts (3.5, PROF-DESC-010): Your accounts (§3.11), `ayni.connections.changed`
   * (§5), the Connect card (§6) and the kind of account `personal`. A UI shows no Your accounts of an agent that does not
   * declare it.
   */
  connections?: boolean
  /**
   * the agent serves the Notifications of a space and of the agent (3.5 amended, agent D114, PROF-DESC-011): the lists of
   * §3.12, `ayni.space.notifications.changed` (§5) and `notificationsWaiting` on a space (§3.7). A UI shows no
   * Notifications of an agent that does not declare it.
   */
  notifications?: boolean
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
  /** a new phone: the old capability channel and every session that depends on it (agent IDENT-SESS-003) */
  | 'supersede'
  /** a newer session of the same device on the conversation (§3.6, agent IDENT-SESS-014) */
  | 'replaced'
  | 'channel-closed'
  | 'credential-invalid'
  | 'idle-timeout'
  | 'expired'
  | 'agent'

export const CLOSURE_REASONS: readonly ClosureReason[] = [
  'user',
  'supersede',
  'replaced',
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
  // `ayni.approval.request` is withdrawn (agent D114): an approver's request is on their phone and in their Notifications
  /** a later status of the requester's card, to the sessions of the one conversation that holds it (§5, PROF-TOOL-009) */
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
  /** one of the Principal's own accounts, or an attempt to connect one, changed (3.5, PROF-TOOL-019) */
  connectionsChanged: 'ayni.connections.changed',
  /**
   * a notification of the Principal entered, changed or ended in the Notifications of a space, or of the agent when
   * `spaceId` is null (3.5 amended, agent D114, PROF-TOOL-025)
   */
  spaceNotificationsChanged: 'ayni.space.notifications.changed',
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
  /**
   * the ids the client gave those it sent, a client holding them so until it reads the history again: when present, of
   * the length and in the order of `messageIds`, the empty string for an entry the client did not send
   */
  clientIds?: string[]
}

/** Why the model never received a message of the person (PROF-STREAM-011): an email check took it, or a credential (3.5). */
export type WithheldReason = 'email-check' | 'credential'

/**
 * `ayni.messages.withheld` (PROF-STREAM-011, 3.3 amended, 3.5): messages of the person that the model never received,
 * what the code of an email check took, or a message that carried a credential (`reason: 'credential'`). Sent in the run
 * that carried them; the same messages carry `metadata.modelVisible: false` in history (PROF-HIST-013).
 */
export interface MessagesWithheldValue {
  conversationId: string
  /** the agent's ids of the messages */
  messageIds: string[]
  /**
   * the ids the client gave those it sent: when present, of the length and in the order of `messageIds`, the empty string
   * for an entry the client did not send
   */
  clientIds?: string[]
  /** absent means `email-check` */
  reason?: WithheldReason
  /**
   * with `reason: 'credential'`: the text the agent kept of each message, by the agent's id, each credential replaced by its
   * first four characters and `…`; a UI puts it in place of the text it holds, in the transcript, its cache and its outbox
   */
  texts?: Record<string, string>
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

/** Whose account a tool call runs with (3.4): none, the agent's, the space's, or the person's own (3.5). */
export type AccountKind = 'none' | 'agent' | 'space' | 'personal'

/**
 * A tool call as its card shows it (3.4, PROF-TOOL-007/009): the action's title, its source, whose account, and every
 * argument the tool will receive, the pinned ones first, each value whole, as text. After the message whose turn asked
 * for it is deleted within the window, `fields` is empty and `erased` true (agent INTX-APPR-015).
 */
export interface ToolAction {
  title: string
  source: { id: string; title: string }
  /**
   * whose account: with the space for `space`; for `personal` (3.5, PROF-TOOL-021), `label`, the name of the account at its
   * service, on the card of the person whose account it is, and on no other card
   */
  account: { kind: AccountKind; space?: { id: string; title: string }; label?: string }
  fields: { label: string; value: string; pinned?: boolean }[]
  erased?: boolean
}

export interface ApprovalPolicyDisplay {
  type: 'count' | 'percentage'
  value: number
  vetoOnRefusal?: boolean
}

/**
 * The content of an approval as the `ayni.approval` activity carries it: the requester's card, in the conversation where
 * it was asked (PROF-TOOL-009), and the `approval` of an item of the Notifications (§3.12). It was also the value of
 * `ayni.approval.request`, which is withdrawn (agent D114).
 */
export interface ApprovalRequestValue {
  approvalId: string
  kind: ApprovalKind
  tool: string
  requester: { displayName: string; role?: string }
  purpose?: { id: string; label: string }
  justification?: string
  policy: ApprovalPolicyDisplay
  expiresAt: string
  status?: ApprovalStatus
  /** true when the receiving Principal is the requester: the requester's card, read-only */
  own?: boolean
  /** true while the receiving Principal may decide */
  canDecide?: boolean
  /** who decided, by the names the agent shows, joined with commas */
  decidedBy?: string
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
  requester: { displayName: string; role?: string }
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
   * `'credential'` on a message held back because it carried a credential, whose text is as the agent kept it, each
   * credential replaced by its first four characters and `…` (3.5, PROF-HIST-013); absent on every other message
   */
  withheld?: 'credential'
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
  'ayni.approval.update': ApprovalUpdateValue
  'ayni.reaction': ReactionValue
  'ayni.receipt': ReceiptValue
  'ayni.messages.erased': MessagesErasedValue
  'ayni.messages.withheld': MessagesWithheldValue
  'ayni.memory.updated': MemoryUpdatedValue
  'ayni.space.tools.changed': SpaceToolsChangedValue
  'ayni.connections.changed': ConnectionsChangedValue
  'ayni.space.notifications.changed': SpaceNotificationsChangedValue
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
  /** an AG-UI session's carries no item for approvals (agent D114): an approver's requests are in the Notifications */
  contextualMenu: { items: ContextualMenuItem[] }
  /** the approvals the Principal may decide now, the same on every session (PROF-TOOL-025): a mark of the agent */
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
  /** the Connect card: the model offers the person to connect one of their own accounts (3.5, PROF-TOOL-020) */
  connect: 'ayni.connect',
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
  /** an `approval.decide` of an approval whose decision must be attested: decided on the phone (PROF-TOOL-026) */
  decideOnPhone: 'decide-on-phone',
  /** an `approval.decide` or `approval.cancel` of an approval the Principal may not decide or withdraw (PROF-TOOL-026) */
  notEligible: 'not-eligible',
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
 * The outcome of an `approval.decide` run (3.4, PROF-TOOL-008, PROF-TOOL-026) and of an `approval.cancel` (agent D114): it
 * starts no turn, and says the status the approval has now: the one it took, `PENDING` while it waits for other
 * approvers, or the one an earlier decision gave it.
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
  /**
   * 3.4: a value of a field of a space's account that, trimmed, is empty, longer than 4096 characters, has whitespace or a
   * control character inside, or does not match its field's pattern, with `field: "account.<name>"` (§3.10, agent D102)
   */
  'bad-token': 422,
  /** 3.5: the value of a binding a personal account is for, not one of the owner's own accounts, with `field` (§3.10) */
  'not-your-account': 422,
  /** 3.5: `POST /connections/{source}/authorize` on a source of fields (§3.11) */
  'not-oauth': 409,
  /** 3.5: `PUT /connections/{source}/account` on a source of OAuth (§3.11) */
  'not-fields': 409,
  /** 3.5: the check refused the account: it is for another value of the binding, with `expected` and `chosen` (§3.11) */
  'wrong-binding': 422,
  /** 3.5: the check refused the account: it is not the person's own by the email of the directory (§3.11) */
  'wrong-person': 422,
  /** 3.5: the service's metadata, its authorization server or the agent's client there cannot be had (§3.11) */
  'source-unavailable': 502,
  /** 3.5 amended (D114): `POST /approvals/{id}/resend` once the approval ended or the person decided it (§3.12) */
  'not-pending': 409,
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
  /** `wrong-binding` (3.5): the names of the value the space wants and of the one the account is for */
  expected?: string
  chosen?: string
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
export const APP_LINK_PARAMS = ['q', 'to', 'amount', 'memo', 'oob', 'approval'] as const
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

/**
 * The app link of the Notifications that list an approval (3.5 amended, agent D114, PROF-LINK-005), the `link` of its
 * `authorize` flow: `/app/service/{did}/spaces/{spaceId}/notifications?approval={approvalId}` for an approval of a space's
 * tool, `/app/service/{did}/notifications?approval={approvalId}` for any other.
 */
export function notificationsLink(domain: string, did: string, spaceId: string | null, approvalId: string): string {
  return buildAppLink(domain, 'service', spaceId ? [did, 'spaces', spaceId, 'notifications'] : [did, 'notifications'], {
    approval: approvalId,
  })
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
  /**
   * the notifications of the space that wait for the caller (§3.12): the badge of the space's row and of its
   * Notifications; from an agent that declares `features.notifications` (agent D114, PROF-TOOL-025)
   */
  notificationsWaiting?: number
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
 * `setBy` and `pattern`, the tools' `name` and `packRule`, the account's fields and status, and `pending`. No answer
 * carries a value of an account.
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
    /**
     * the owner's, for a `space` account: the fields to fill, one masked field each, in the agent-pack's order (agent
     * D102); every field is a secret, and no answer carries its value
     */
    fields?: SpaceAccountField[]
    /** the owner's, for a `space` account: whether it is set, when and by whom */
    set?: boolean
    setAt?: string | null
    setBy?: { name: string } | null
    /**
     * a `personal` account (3.5, PROF-TOOL-021): whether the reader's own account of it, for this space, is connected, to
     * the owner and to every member alike; never a label
     */
    connected?: boolean
    /**
     * a `personal` account that the tool uses from another source (`account.from`, agent TOOL-CAT-015): the source Your
     * accounts lists it under (`github` for `github-project`); absent otherwise
     */
    source?: string
  }
  bindings: {
    name?: string
    label: string
    value: string | null
    setBy?: 'pack' | 'owner'
    pattern?: string | null
    /** the name of the value of a binding a personal account is for (3.5, agent D110) */
    valueLabel?: string | null
    /** the owner's (3.5): the binding is set from an account of the owner's own, never typed */
    fromAccount?: true
    /** the owner's (3.5): the value and name of each of the owner's own accounts of the source */
    choices?: { value: string; valueLabel: string | null }[]
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

/** One field of a space's account, as its owner reads it (PROF-TOOL-001, agent D102). */
export interface SpaceAccountField {
  /** the key of its value in `SpaceAccountRequest.values`; a refusal names it as `account.<name>` */
  name: string
  /** what the owner is asked for ("API key") */
  label: string
  /** a regular expression its value must match, once trimmed */
  pattern?: string
}

/**
 * `PUT {sessions}/spaces/{id}/tools/{source}/account` (PROF-TOOL-004): one value for each field of the account and for
 * no other, each trimmed of the whitespace at its ends; answered `202 { tool }` with `pending`, `400 bad-request` with
 * `field: "account.<name>"` for a field missing or not declared, `422 bad-token` with `field: "account.<name>"` for a
 * value the agent will not take.
 */
export interface SpaceAccountRequest {
  values: Record<string, string>
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

// ---------------------------------------------------------------------------------------------
// Your accounts (3.5, §3.11): `{sessions}/connections`, a bound session's token

/** How a person's own account connects: the service's sign-in in the browser, or fields the person types (§3.11). */
export type ConnectionMethod = 'oauth' | 'fields'
/** Where a person's own account stands (agent D107). */
export type ConnectionState = 'not-connected' | 'connected' | 'reconnect'
export const CONNECTION_STATES: readonly ConnectionState[] = ['not-connected', 'connected', 'reconnect']
/** Why an account must be reconnected: the service no longer refreshes it, refused it, or how it connects changed. */
export type ReconnectReason = 'expired' | 'revoked' | 'changed'
/** What became of a sign-in, or of an account (PROF-TOOL-019). */
export type ConnectionOutcome =
  | 'connected'
  | 'denied'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'wrong-binding'
  | 'wrong-person'
  | 'disconnected'
  | 'ended'

/** Where an account serves: every conversation, Personal, or a space (§3.11). */
export type ConnectionUse = { kind: 'agent' } | { kind: 'personal' } | { kind: 'space'; id: string; title: string }

/**
 * One item of `GET {sessions}/connections` (PROF-TOOL-014): an account the person can connect or holds. No item carries a
 * token or a value of a field; `account.label` is shown to this person only.
 */
export interface Connection {
  source: string
  title: string
  description?: string
  method: ConnectionMethod
  /** a source of fields: the fields to type, one masked field each (agent D102) */
  fields?: SpaceAccountField[]
  /** a source whose accounts are each for one value of a binding (agent D110): this item's value and its name */
  binding: { name: string; label: string; value: string | null; valueLabel: string | null } | null
  usedIn: ConnectionUse[]
  state: ConnectionState
  reason: ReconnectReason | null
  moreAccess: boolean
  account: { id: string; label: string | null; connectedAt: string; lastUsedAt: string | null } | null
  attempt: { id: string; expiresAt: string } | null
  /** whether a Disconnect also ends the agent's access at the service */
  revokesAtSource: boolean
}

export interface ConnectionsResponse {
  connections: Connection[]
}

/** `POST {sessions}/connections/{source}/authorize` (PROF-TOOL-015): `spaceId` for a source of a space's template. */
export interface AuthorizeConnectionRequest {
  spaceId?: string
}

/** The answer `202` of `POST {sessions}/connections/{source}/authorize` (PROF-TOOL-015). */
export interface AuthorizeConnectionResponse {
  attemptId: string
  /** opened in the browser, never in a frame or a web view of the client (PROF-TOOL-018) */
  authorizationUrl: string
  expiresAt: string
}

/** `PUT {sessions}/connections/{source}/account` (PROF-TOOL-016): answered `200 { connection }`. */
export interface ConnectionAccountRequest {
  values: Record<string, string>
  spaceId?: string
}

export interface ConnectionResponse {
  connection: Connection
}

/**
 * `ayni.connections.changed` (3.5, PROF-TOOL-019): one of the Principal's own accounts, or an attempt to connect one,
 * changed; to every bound session of the Principal that has its stream open. A UI reads §3.11 again on it.
 */
export interface ConnectionsChangedValue {
  source: string
  binding?: { value: string; valueLabel: string | null }
  state: ConnectionState
  reason?: ReconnectReason
  moreAccess?: boolean
  accountId?: string
  /** the name of the account at its service: this event goes to the Principal's own sessions only */
  label?: string
  attemptId?: string
  outcome?: ConnectionOutcome
  /** `wrong-binding`: the names of the value expected and of the one the account is for */
  expected?: string
  chosen?: string
}

/**
 * The Connect card (3.5, PROF-TOOL-020): an `ayni.connect` activity. It holds no state: a UI shows the state of the account
 * it names (`source`, and `binding.value`) from §3.11. Its Connect starts the flow of §3.11 and never shows a field in the
 * conversation.
 */
export interface ConnectActivity {
  source: string
  title: string
  description?: string
  method: ConnectionMethod
  why: 'connect' | 'reconnect'
  binding?: { label: string; value: string; valueLabel: string | null }
  spaceId?: string
}

// ---------------------------------------------------------------------------------------------
// Notifications (3.5 amended, §3.12, agent D114): `{sessions}/spaces/{id}/notifications` and `{sessions}/notifications`,
// a bound session's token

/** The default and the largest page of the Notifications (§3.12, PROF-TOOL-024). */
export const NOTIFICATIONS_PAGE = { default: 50, max: 200 } as const

/** What a person's notification is: in this version, an approval only (agent D114, O43). */
export type NotificationKind = 'approval'

/** One decision of an approver, as an item of the Notifications names it. */
export interface NotificationDecision {
  by: { displayName: string }
  decision: 'approve' | 'reject'
  at: string
}

/**
 * The approval of an item (§3.12): the shape of the `ayni.approval` activity as this person may read it, never more of the
 * conversation it was asked in. `own` on a request the person sent (Sent by you), which they read and never decide;
 * `canDecide` while they may decide it; `attested`: its decision is made on the phone only; `myDecision` the person's own
 * while it waits for other approvers; `closedAt` once it ended. An elevation carries `purpose` and `justification` and no
 * `action`. A `personal` account carries its `label` on the requester's item only (PROF-TOOL-021).
 */
export interface NotificationApproval extends ApprovalRequestValue {
  status: ApprovalStatus
  own: boolean
  canDecide: boolean
  attested: boolean
  myDecision: 'approve' | 'reject' | null
  decisions: NotificationDecision[]
  closedAt?: string
}

export interface NotificationItem {
  /** the approval's id */
  id: string
  kind: NotificationKind
  /** when the request was made: the order of the list */
  at: string
  /** the person can still decide it: `PENDING`, and not decided by them */
  waiting: boolean
  approval: NotificationApproval
}

/** `GET {sessions}/spaces/{id}/notifications` and `GET {sessions}/notifications`: newest first (PROF-TOOL-024). */
export interface NotificationsPage {
  notifications: NotificationItem[]
  /** the `id` to pass as `before` for the next page; null on the last */
  nextBefore: string | null
  /** what waits for the person in the whole place: the badge */
  waiting: number
}

/** `POST {sessions}/approvals/{approvalId}/resend` answers `202` with the expiry of the request sent again (PROF-TOOL-026). */
export interface ApprovalResendResponse {
  expiresAt: string
}

/**
 * `ayni.space.notifications.changed` (PROF-TOOL-025): a notification of the Principal entered, changed or ended in the
 * Notifications of `spaceId`, or of the agent when it is null; to every bound session of the Principal that has its
 * stream open. A UI reads the list again on it; `count` is the badge.
 */
export interface SpaceNotificationsChangedValue {
  spaceId: string | null
  id: string
  kind: NotificationKind
  waiting: boolean
  count: number
}
