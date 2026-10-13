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
  /** human label for StepStarted (PROF-MAP-005): never the function name or arguments */
  stepLabel?: string
  invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolSource {
  readonly id: string
  list(): Promise<ToolSpec[]>
  close?(): Promise<void>
}
