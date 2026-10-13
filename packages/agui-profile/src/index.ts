/**
 * Hologram AG-UI Profile v3 (2060-io/hologram-spec, v3/hologram-agui-profile/profile.md).
 * Every name below cites the section or the PROF-* requirement it implements.
 */

export const PROFILE_VERSION = '3.0'
export const PROFILE_MAJOR = 3

/** DID Document service type that references the descriptor (PROF-DESC-001). */
export const DID_SERVICE_TYPE = 'HologramAgUI'
/** Well-known path of the descriptor on the agent origin (PROF-DESC-001). */
export const DESCRIPTOR_PATH = '/.well-known/hologram-agent.json'
/** goal_code of the binding invitation (profile section 4). */
export const BINDING_GOAL_CODE = 'hologram.bind-session'

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
}

export type BindingMode = 'cross-device' | 'same-device'

export interface AgentDescriptor {
  profileVersion: string
  did: string
  name: string
  description?: string
  logo?: string
  sessions: string
  binding: { modes: BindingMode[]; walletLinkTemplate: string }
  features: DescriptorFeatures
  locales: string[]
}

// ---------------------------------------------------------------------------------------------
// Sessions (section 3)

export type SessionState = 'provisional' | 'bound' | 'closed'

/** Closure reasons (section 5, hologram.session.state). */
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

export interface ClientDescription {
  name: string
  version: string
  platform: string
}

export interface CreateSessionRequest {
  client: ClientDescription
  locale?: string
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
}

export interface SessionStatus {
  sessionId: string
  state: SessionState
  reason?: ClosureReason
  principal: PrincipalDisplay | null
  boundAt?: string
  lastActivityAt: string
  idleTimeoutSeconds: number
  binding?: BindingMaterial
  parentSessionId?: string
}

// ---------------------------------------------------------------------------------------------
// Custom events on the session stream (section 5)

export const CUSTOM_EVENT = {
  sessionState: 'hologram.session.state',
  sessionBound: 'hologram.session.bound',
  sessionToken: 'hologram.session.token',
  capabilityRouted: 'hologram.capability.routed',
  approvalRequest: 'hologram.approval.request',
  approvalUpdate: 'hologram.approval.update',
  reaction: 'hologram.reaction',
  receipt: 'hologram.receipt',
} as const

export type CustomEventName = (typeof CUSTOM_EVENT)[keyof typeof CUSTOM_EVENT]

export type CapabilityKind = 'authentication' | 'credential-exchange' | 'auth-challenge'
export type ChallengeType = 'device' | 'face-match' | 'document'
export type CapabilityStatus = 'pending' | 'completed' | 'failed' | 'expired' | 'unavailable' | 'degraded'

export interface SessionStateValue {
  state: SessionState
  reason?: ClosureReason
}

export interface SessionBoundValue {
  principal: PrincipalDisplay
  boundAt: string
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

export interface ReactionValue {
  messageId: string
  emoji: string
  action: 'add' | 'remove'
  by: string
}

export type ReceiptState = 'received' | 'viewed'

export interface ReceiptValue {
  messageIds: string[]
  state: ReceiptState
}

export interface CustomEventValueMap {
  'hologram.session.state': SessionStateValue
  'hologram.session.bound': SessionBoundValue
  'hologram.session.token': SessionTokenValue
  'hologram.capability.routed': CapabilityRoutedValue
  'hologram.approval.request': ApprovalRequestValue
  'hologram.approval.update': ApprovalUpdateValue
  'hologram.reaction': ReactionValue
  'hologram.receipt': ReceiptValue
}

// ---------------------------------------------------------------------------------------------
// state.hologram (section 5, PROF-STREAM-004)

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

export interface HologramState {
  contextualMenu: { items: ContextualMenuItem[] }
  pendingApprovals: number
  generating: GeneratingEntry[]
  principal: PrincipalDisplay | null
  /** purposes a human may declare on an elevation request (PROF-RUN-005) */
  purposes?: { id: string; label: string; description?: string }[]
}

export interface AgUiState {
  hologram: HologramState
}

// ---------------------------------------------------------------------------------------------
// Runs and input (section 6)

export type HologramActionKind =
  | 'text'
  | 'menu.select'
  | 'contextual.select'
  | 'approval.decide'
  | 'approval.cancel'
  | 'elevation.request'
  | 'reaction'
  | 'receipt'
  | 'attachments'

export const HOLOGRAM_ACTION_KINDS: readonly HologramActionKind[] = [
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

export type HologramAction =
  | { kind: 'text' }
  | { kind: 'menu.select'; menuId: string; itemId: string }
  | { kind: 'contextual.select'; itemId: string }
  | { kind: 'approval.decide'; approvalId: string; decision: 'approve' | 'reject'; note?: string }
  | { kind: 'approval.cancel'; approvalId: string }
  | { kind: 'elevation.request'; tool: string; purposeId: string; justification: string }
  | { kind: 'reaction'; messageId: string; emoji: string; action: 'add' | 'remove' }
  | { kind: 'receipt'; messageIds: string[]; state: ReceiptState }
  | { kind: 'attachments'; attachmentIds: string[] }

export interface HologramForwardedProps {
  hologram?: HologramAction
}

/** Activity message types inside runs (section 6). */
export const ACTIVITY = {
  menu: 'hologram.menu',
  attachment: 'hologram.attachment',
  approval: 'hologram.approval',
  capability: 'hologram.capability',
  generating: 'hologram.generating',
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
  textRepr: string
  size?: number
  width?: number
  height?: number
  duration?: number
  filename?: string
  thumbnailId?: string
}

export type ApprovalActivity = ApprovalRequestValue & { status: ApprovalStatus }
export type CapabilityActivity = CapabilityRoutedValue
export interface GeneratingActivity {
  entryId: string
  kind: 'image'
}

/** Interrupt reasons the agent uses (PROF-RUN-006). */
export const INTERRUPT_REASON = {
  menu: 'hologram.menu',
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

export interface ErrorBody {
  error: ErrorCode | string
  reason?: ClosureReason
  message?: string
  binding?: BindingMaterial
}

/** Binding code format: two letters, a dash, two letters or digits, derived from the nonce (section 3.2). */
export const BINDING_CODE_PATTERN = /^[A-Z0-9]{2}-[A-Z0-9]{2}$/
