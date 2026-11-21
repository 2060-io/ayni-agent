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
  /**
   * the account the call runs with (D97): a space's account is opened in memory for this call only, and sent only in the
   * headers the source's `account.apply` builds from its fields (D102, TOOL-ACCESS-005); never logged, never put in a result
   */
  account?: CallAccountSecret
}

/** The account of one call: its kind, the space, and the headers of the space's account, built for the call. */
export interface CallAccountSecret {
  kind: 'none' | 'agent' | 'space'
  spaceId?: string
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
  close?(): Promise<void>
}
