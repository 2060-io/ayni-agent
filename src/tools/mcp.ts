/**
 * MCP client over stdio, SSE and streamable-HTTP with lazy connect (D41, TOOL-MCP-001..003). A server gives the model the
 * tools its `offer` names, or every tool it lists (TOOL-CAT-003). A server whose account is a space's keeps one connection
 * per space account, opened on the first call that needs it and closed once idle, so that no call of a space travels on
 * another's connection (TOOL-ACCESS-007); a server of the agent's account, or of none, keeps one connection.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpSource } from '../config/packTypes.js'
import type { Logger } from '../util/logger.js'
import type { ToolAnnotations } from './catalog.js'
import type { CallAccountSecret, ToolContext, ToolResult, ToolSource, ToolSpec } from './types.js'

/** How long a connection of a space's account stays open unused (TOOL_CONNECTION_IDLE_SECONDS, 600 by default). */
export const DEFAULT_IDLE_SECONDS = 600

interface AccountConnection {
  client: Client
  /** the token it was opened with: another token is another connection */
  token: string
  timer?: NodeJS.Timeout
}

interface ListedTool {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: ToolAnnotations
  title?: string
}

export class McpServerSource implements ToolSource {
  public readonly id: string
  private client?: Client
  private connecting?: Promise<Client>
  private cachedTools?: ToolSpec[]
  /** the connections of the spaces' accounts, by space (TOOL-ACCESS-007) */
  private readonly accounts = new Map<string, AccountConnection>()
  private readonly opening = new Map<string, Promise<AccountConnection>>()
  /** an offered name the server does not list is warned of once (TOOL-CAT-003) */
  private warnedMissing = false

  /** the server's name: its source's id in `tools.sources` (D101) */
  private readonly name: string

  public constructor(
    name: string,
    private readonly def: McpSource,
    private readonly logger: Logger,
    private readonly idleSeconds = DEFAULT_IDLE_SECONDS
  ) {
    this.name = name
    this.id = `mcp:${name}`
  }

  private get spaceAccount(): boolean {
    return this.def.account?.kind === 'space'
  }

  /** How many connections of spaces' accounts are open: for the tests of TOOL-ACCESS-007. */
  public get openAccounts(): number {
    return this.accounts.size
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const client = new Client({ name: 'ayni-agent', version: '3.0.0' })
      const transport = this.createTransport()
      await client.connect(transport)
      client.onclose = () => {
        this.logger.warn({ server: this.name }, 'mcp server connection closed')
        this.client = undefined
      }
      this.client = client
      this.logger.info({ server: this.name, transport: this.def.transport }, 'mcp server connected')
      return client
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  /** The connection of a space's account: opened on first need, kept while used, closed once idle. */
  private async connectAccount(account: CallAccountSecret): Promise<Client> {
    const spaceId = account.spaceId
    const token = account.token
    if (!spaceId || !token) throw new Error('the account of this space is not set')
    const open = this.accounts.get(spaceId)
    if (open && open.token === token) {
      this.touch(spaceId, open)
      return open.client
    }
    // a token replaced: the connection of the former one closes, and nothing of it is reused
    if (open) await this.closeAccount(spaceId)
    const pending = this.opening.get(spaceId)
    if (pending) {
      const connection = await pending
      if (connection.token === token) return connection.client
    }
    const opening = (async () => {
      const client = new Client({ name: 'ayni-agent', version: '3.0.0' })
      const header = this.def.account?.apply?.header ?? 'Authorization'
      const value = `${this.def.account?.apply?.prefix ?? ''}${token}`
      await client.connect(this.createTransport({ [header]: value }))
      const connection: AccountConnection = { client, token }
      client.onclose = () => {
        if (this.accounts.get(spaceId) === connection) this.accounts.delete(spaceId)
      }
      this.accounts.set(spaceId, connection)
      this.touch(spaceId, connection)
      // the space is named, never its token (TOOL-ACCESS-005)
      this.logger.info({ server: this.name, spaceId }, 'mcp server connected with a space account')
      return connection
    })()
    this.opening.set(spaceId, opening)
    try {
      return (await opening).client
    } finally {
      this.opening.delete(spaceId)
    }
  }

  private touch(spaceId: string, connection: AccountConnection): void {
    if (connection.timer) clearTimeout(connection.timer)
    connection.timer = setTimeout(() => {
      this.logger.info({ server: this.name, spaceId }, 'mcp connection of a space account closed: idle')
      void this.closeAccount(spaceId)
    }, this.idleSeconds * 1000)
    connection.timer.unref?.()
  }

  public async closeAccount(spaceId: string): Promise<void> {
    const connection = this.accounts.get(spaceId)
    if (!connection) return
    this.accounts.delete(spaceId)
    if (connection.timer) clearTimeout(connection.timer)
    await connection.client.close().catch(() => undefined)
  }

  private createTransport(extraHeaders: Record<string, string> = {}) {
    const { transport, url, command, args, env, headers } = this.def
    if (transport === 'stdio') {
      if (!command) throw new Error(`mcp server ${this.name}: stdio transport needs a command`)
      return new StdioClientTransport({
        command,
        args,
        env: { ...(process.env as Record<string, string>), ...(env ?? {}) },
      })
    }
    if (!url) throw new Error(`mcp server ${this.name}: ${transport} transport needs a url`)
    const all = { ...(headers ?? {}), ...extraHeaders }
    const requestInit = Object.keys(all).length ? { headers: all } : undefined
    if (transport === 'sse') return new SSEClientTransport(new URL(url), { requestInit })
    return new StreamableHTTPClientTransport(new URL(url), { requestInit })
  }

  /** The offered tools of what the server lists (TOOL-CAT-003), warned once of an offered name it lacks. */
  private specsOf(tools: ListedTool[]): ToolSpec[] {
    const offer = this.def.offer
    if (offer && !this.warnedMissing) {
      const missing = offer.filter((name) => !tools.some((t) => t.name === name))
      if (missing.length) {
        this.warnedMissing = true
        this.logger.warn(
          { server: this.name, missing },
          'mcp server does not list tools its offer names: they are not given to the model (TOOL-CAT-003)'
        )
      }
    }
    return tools
      .filter((t) => !offer || offer.includes(t.name))
      .map((t) => ({
        key: `mcp:${this.name}:${t.name}`,
        name: t.name,
        source: this.name,
        rawName: t.name,
        description: t.description ?? this.def.tools?.[t.name]?.title ?? t.name,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        // the tier model of its source (D101)
        access: this.def.access,
        serverName: this.name,
        ...(t.annotations || t.title
          ? {
              annotations: {
                ...(t.annotations ?? {}),
                ...(t.title && !t.annotations?.title ? { title: t.title } : {}),
              },
            }
          : {}),
        // a step label names no tool (PROF-TOOL-013): the source's title, when the pack gives one
        stepLabel: this.def.title ? `Using ${this.def.title}` : 'Working',
        invoke: (args, ctx) => this.call(t.name, args, ctx),
      }))
  }

  private async call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // a call of a space travels on that space's connection, with its own token, and on no other (TOOL-ACCESS-007)
    if (this.spaceAccount && !ctx.account?.token)
      return { content: 'The account of this space is not set.', isError: true }
    const c = this.spaceAccount ? await this.connectAccount(ctx.account as CallAccountSecret) : await this.connect()
    const result = await c.callTool({ name, arguments: args }, undefined, { signal: ctx.signal })
    if (this.spaceAccount && ctx.account?.spaceId) {
      const open = this.accounts.get(ctx.account.spaceId)
      if (open) this.touch(ctx.account.spaceId, open)
    }
    const content = (result.content as { type: string; text?: string }[] | undefined) ?? []
    const text = content.map((p) => (p.type === 'text' ? (p.text ?? '') : `[${p.type}]`)).join('\n')
    return {
      content: text || JSON.stringify(result.structuredContent ?? {}),
      data: result.structuredContent,
      isError: result.isError === true,
    }
  }

  /**
   * Discovery connects on first need; a lazy server that is unreachable yields no tools (logged). A server of a space's
   * account is discovered on a space's own connection (`discover`): until then it lists nothing.
   */
  public async list(): Promise<ToolSpec[]> {
    if (this.cachedTools) return this.cachedTools
    if (this.spaceAccount) return []
    try {
      const client = await this.connect()
      const { tools } = await client.listTools()
      this.cachedTools = this.specsOf(tools as ListedTool[])
      return this.cachedTools
    } catch (error) {
      this.logger.error({ server: this.name, err: error }, 'mcp server discovery failed')
      return []
    }
  }

  public async discover(account: CallAccountSecret): Promise<void> {
    if (this.cachedTools || !this.spaceAccount) return
    try {
      const client = await this.connectAccount(account)
      const { tools } = await client.listTools()
      this.cachedTools = this.specsOf(tools as ListedTool[])
    } catch (error) {
      // the error may echo the request: the space is named, nothing of the account (TOOL-ACCESS-005)
      this.logger.error(
        { server: this.name, spaceId: account.spaceId, err: scrub(error, account.token) },
        'mcp server discovery failed'
      )
    }
  }

  public async close(): Promise<void> {
    await this.client?.close().catch(() => undefined)
    this.client = undefined
    for (const spaceId of [...this.accounts.keys()]) await this.closeAccount(spaceId)
  }
}

/** An error with a token in its message, the token replaced (TOOL-ACCESS-005). */
export function scrub(error: unknown, token: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error)
  return token ? message.split(token).join('[account]') : message
}

/** The MCP servers of `tools.sources`, each with its source's id (D101). */
export function createMcpSources(
  defs: [string, McpSource][],
  logger: Logger,
  idleSeconds = DEFAULT_IDLE_SECONDS
): McpServerSource[] {
  return defs.map(([name, def]) => new McpServerSource(name, def, logger, idleSeconds))
}
