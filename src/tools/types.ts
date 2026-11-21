import type { ToolAccess } from '../config/packTypes.js'
import type { Principal, Session } from '../core/types.js'
import type { Logger } from '../util/logger.js'
import type { ToolAnnotations } from './catalog.js'

export interface ToolContext {
  principal: Principal
  session: Session
  roles: string[]
  signal?: AbortSignal
  logger: Logger
  /** language of the conversation, for human-facing tool output */
  language: string
  /** the person's message the turn answers: what a note cites, so that its erasure flags the note (PRIV-ERASE-005) */
  inboundId?: string
  /** every message the turn answers, when several waited together (PRIV-ERASE-011) */
  inboundIds?: string[]
  /** the space of the conversation: the notes the tool reads and writes are of it (MEM-SPACE-002) */
  spaceId?: string
  /** a memory of the person changed: the turn tells the conversation, never its content (MEM-SPACE-005) */
  memoryChanged?: (change: MemoryChange) => Promise<void>
  /** the tool ends the turn with a message of the code (INTX-AUTH-012): the model is called no more in it */
  turnEnded?: (message: EndTurnMessage) => void
  /** shows the Connect card of a person's own account in the reply (TOOL-CONN-011, PROF-TOOL-020) */
  connectCard?: (card: ConnectCard) => Promise<void>
  /**
   * the account the call runs with (D97): a space's account is opened in memory for this call only, and sent only in the
   * headers the source's `account.apply` builds from its fields (D102, TOOL-ACCESS-005); never logged, never put in a result
   */
  account?: CallAccountSecret
}

/** The Connect card (profile 3.5 `ayni.connect`, PROF-TOOL-020): what the model offers to connect, never a field. */
export interface ConnectCard {
  source: string
  title: string
  description?: string
  method: 'oauth' | 'fields'
  why: 'connect' | 'reconnect'
  binding?: { label: string; value: string; valueLabel: string | null }
  spaceId?: string
}

/**
 * The handle of a person's own OAuth account for one call (D105, TOOL-OAUTH-008): the access token for the next request,
 * refreshed when it is about to expire, and what the server's refusals make of the account. The token goes only to `url`.
 */
export interface PersonalOAuthHandle {
  accountId: string
  /** the server the token is for, and the only one it is sent to (no token passthrough, TOOL-ACCESS-010) */
  url: string
  /** set when the account was not connected, or asked for more scopes, during the call (TOOL-CALL-011) */
  outcome?: 'not-connected' | 'more-access-needed'
  token(): Promise<string>
  /** the server answered 401 to `used`: one refresh, and the token to try once more with; undefined when there is none */
  after401(used: string): Promise<string | undefined>
  /** the server answered 401 to the token a refresh gave: the account goes to reconnect */
  refusedAgain(): Promise<void>
  /** the server answered 403 insufficient_scope with these scopes (TOOL-OAUTH-009) */
  insufficientScope(scopes: string[]): Promise<void>
  /** every token the call held, for what an echo is scrubbed of */
  secrets(): string[]
  /** resolves once no request of the call waits for a token or a refresh any more */
  settled(): Promise<void>
}

/**
 * The account of one call: its kind, the space, and the headers of the space's account or of the person's account of
 * fields, built for the call; or the handle of the person's OAuth account.
 */
export interface CallAccountSecret {
  kind: 'none' | 'agent' | 'space' | 'personal'
  spaceId?: string
  /** a person's own account (D104): its id; one connection per account (TOOL-ACCESS-012) */
  accountId?: string
  /** a person's own OAuth account: the token for each request, refreshed as it must be */
  oauth?: PersonalOAuthHandle
  /**
   * the headers of the space's account, built for this call from the values of its fields as `account.apply` says
   * (D102, TOOL-ACCESS-005); in memory for this call only, never logged; absent while the account is not set
   */
  headers?: Record<string, string>
  /** every value of the account and every header built from them, longest first: what an echo is scrubbed of */
  secrets?: string[]
}

/**
 * A message the code writes to end a turn (INTX-AUTH-012): the question of an email check. It is recorded as an
 * `auth-challenge` entry, streamed as the turn's last message, and the model is called no more in the turn.
 */
export interface EndTurnMessage {
  text: string
  payload?: Record<string, unknown>
}

/** What became of a memory of the person in a turn (MEM-SPACE-005). */
export interface MemoryChange {
  memoryId: string
  spaceId: string
  action: 'added' | 'changed' | 'removed'
}

export interface ToolResult {
  /** text handed to the model (tool results are text-first, D23) */
  content: string
  /** optional structured data persisted with the tool-call entry */
  data?: unknown
  isError?: boolean
  /** the turn ends after this call, with this message of the code (INTX-AUTH-012) */
  endTurn?: EndTurnMessage
  /** the person's own account was not connected, or needs more access: the call's record says so (TOOL-CALL-011) */
  accountOutcome?: 'not-connected' | 'more-access-needed'
}

export interface ToolSpec {
  /** stable key: `http:name`, `bundled:name`, `mcp:<server>:name` */
  key: string
  /** the source of the catalog the tool belongs to (TOOL-CAT-001): its id, the key of `tools.sources` (D101) */
  source: string
  /** the tool's own name at its source */
  rawName: string
  /** an MCP tool's annotations, as its server lists them: they give defaults only (D99) */
  annotations?: ToolAnnotations
  /** the name exposed to the model (unique across the registry) */
  name: string
  description: string
  parameters: Record<string, unknown>
  /** the tier model that governs this tool: the `access` of its source (D101) */
  access: ToolAccess | undefined
  serverName?: string
  /** when given, the tool exists only for the Principals it accepts: absent from the model's list for the others */
  when?: (principal: Principal) => boolean
  /** human label for StepStarted (PROF-MAP-005): never the function name or arguments */
  stepLabel?: string
  invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/** The read of the check of a person's account (TOOL-CONN-013). */
export interface CheckRead {
  url: string
  headers: Record<string, string>
  tool: string
}

export interface CheckResult {
  structured?: unknown
  text: string
  /** an MCP tool's annotations, as its server lists them: a check reads with a tool of effect read */
  annotations?: ToolAnnotations
}

export interface ToolSource {
  readonly id: string
  list(): Promise<ToolSpec[]>
  /**
   * Discovers the tools of a source whose account is a space's, on that space's own connection (TOOL-ACCESS-007), when
   * nothing listed them yet.
   */
  discover?(account: CallAccountSecret): Promise<void>
  /** Closes the connection of a space's account: the account was cleared, replaced or removed (TOOL-ACCESS-004/007). */
  closeAccount?(spaceId: string): Promise<void>
  /**
   * The read of the check of a person's new account (TOOL-CONN-013): the tool called once, with no argument, on a
   * connection of its own, at `url` with these headers; its structured content and its text
   */
  checkRead?(read: CheckRead): Promise<CheckResult | undefined>
  close?(): Promise<void>
}
