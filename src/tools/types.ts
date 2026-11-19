import type { ToolAccess } from '../config/packTypes.js'
import type { Principal, Session } from '../core/types.js'
import type { Logger } from '../util/logger.js'

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
}

export interface ToolSpec {
  /** stable key: `http:name`, `bundled:name`, `mcp:<server>:name` */
  key: string
  /** the name exposed to the model (unique across the registry) */
  name: string
  description: string
  parameters: Record<string, unknown>
  /** the access policy that governs this tool (tools.access or the MCP server's toolAccess) */
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
  close?(): Promise<void>
}
