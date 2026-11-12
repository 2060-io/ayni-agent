/**
 * Ayni AG-UI Profile 3.1 (2060-io/ayni-spec, v4/ayni-agui-profile/profile.md).
 * Every name below cites the section or the PROF-* requirement it implements.
 *
 * 3.1 over 3.0: the session grant (`CreateSessionRequest.grant`, `features.sessionGrant`, §4.1), `features.flows`,
 * `client.platform` as `web` | `ios` | `android` with `client.description` (PROF-SESS-014), the `ayni.flow` activity
 * and `flowId` on routed capabilities (§5, §6, PROF-MAP-007), `metadata.flowId` (§8), the `grant-used` and
 * `grant-expired` errors (§9), app links (§10, PROF-LINK-*). A 3.0 UI keeps working against a 3.1 agent.
 */

export const PROFILE_VERSION = '3.1'
export const PROFILE_MAJOR = 3
export const PROFILE_MINOR = 1

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
} as const

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
export type ApprovalKind = 'sensitivity' | 'elevation'

export interface ApprovalPolicyDisplay {
  type: 'count' | 'percentage'
  value: number
  vetoOnRefusal?: boolean
}

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
  /** true when the receiving Principal is the requester */
  own?: boolean
  /** true when the receiving Principal may decide */
  canDecide?: boolean
}

export interface ApprovalUpdateValue {
  approvalId: string
  status: ApprovalStatus
  decidedBy?: string
  grantExpiresAt?: string
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

export interface AyniState {
  contextualMenu: { items: ContextualMenuItem[] }
  pendingApprovals: number
  generating: GeneratingEntry[]
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

/** A message the turn answers: the id of a transcript message of the same session (PROF-RUN-009). */
export interface ReplyReference {
  id: string
  /** short excerpt of the quoted message, for rendering */
  text: string
  role: 'user' | 'assistant'
}

export type AyniAction =
  | { kind: 'text'; replyTo?: string }
  | { kind: 'menu.select'; menuId: string; itemId: string }
  | { kind: 'contextual.select'; itemId: string }
  | { kind: 'approval.decide'; approvalId: string; decision: 'approve' | 'reject'; note?: string }
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
  duration?: number
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
} as const

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
}

export interface ConversationsResponse {
  conversations: ConversationInfo[]
}

export interface ConversationPatch {
  title?: string
  state?: ConversationState
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
}

// ---------------------------------------------------------------------------------------------
// Errors (section 9)

export type ErrorCode =
  | 'unauthorized'
  | 'not-bound'
  | 'not-found'
  | 'conflict'
  | 'closed'
  | 'too-large'
  | 'rate-limited'
  | 'bad-request'
  /** `POST {sessions}` with a grant already used (§3.2, PROF-SESS-013) */
  | 'grant-used'
  /** `POST {sessions}` with a grant past its sixty seconds */
  | 'grant-expired'

export interface ErrorBody {
  error: ErrorCode | string
  reason?: ClosureReason
  message?: string
  binding?: BindingMaterial
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
