/** MCP client over stdio, SSE and streamable-HTTP with lazy connect (D41, TOOL-MCP-001..003). */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerDef } from '../config/packTypes.js'
import type { Logger } from '../util/logger.js'
import type { ToolSource, ToolSpec } from './types.js'

export class McpServerSource implements ToolSource {
  public readonly id: string
  private client?: Client
  private connecting?: Promise<Client>
  private cachedTools?: ToolSpec[]

  public constructor(
    private readonly def: McpServerDef,
    private readonly logger: Logger
  ) {
    this.id = `mcp:${def.name}`
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const client = new Client({ name: 'ayni-agent', version: '3.0.0' })
      const transport = this.createTransport()
      await client.connect(transport)
      client.onclose = () => {
        this.logger.warn({ server: this.def.name }, 'mcp server connection closed')
        this.client = undefined
        this.cachedTools = undefined
      }
      this.client = client
      this.logger.info({ server: this.def.name, transport: this.def.transport }, 'mcp server connected')
      return client
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  private createTransport() {
    const { transport, url, command, args, env, headers } = this.def
    if (transport === 'stdio') {
      if (!command) throw new Error(`mcp server ${this.def.name}: stdio transport needs a command`)
      return new StdioClientTransport({
        command,
        args,
        env: { ...(process.env as Record<string, string>), ...(env ?? {}) },
      })
    }
    if (!url) throw new Error(`mcp server ${this.def.name}: ${transport} transport needs a url`)
    const requestInit = headers ? { headers } : undefined
    if (transport === 'sse') return new SSEClientTransport(new URL(url), { requestInit })
    return new StreamableHTTPClientTransport(new URL(url), { requestInit })
  }

  /** Discovery connects on first need; a lazy server that is unreachable yields no tools (logged). */
  public async list(): Promise<ToolSpec[]> {
    if (this.cachedTools) return this.cachedTools
    try {
      const client = await this.connect()
      const { tools } = await client.listTools()
      this.cachedTools = tools.map((t) => ({
        key: `mcp:${this.def.name}:${t.name}`,
        name: t.name,
        description: t.description ?? t.name,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        access: this.def.toolAccess,
        serverName: this.def.name,
        stepLabel: (t.description ?? t.name).split(/[.:\n]/)[0].slice(0, 60),
        invoke: async (args, ctx) => {
          const c = await this.connect()
          const result = await c.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal })
          const content = (result.content as { type: string; text?: string }[] | undefined) ?? []
          const text = content.map((p) => (p.type === 'text' ? (p.text ?? '') : `[${p.type}]`)).join('\n')
          return {
            content: text || JSON.stringify(result.structuredContent ?? {}),
            data: result.structuredContent,
            isError: result.isError === true,
          }
        },
      }))
      return this.cachedTools
    } catch (error) {
      this.logger.error({ server: this.def.name, err: error }, 'mcp server discovery failed')
      return []
    }
  }

  public async close(): Promise<void> {
    await this.client?.close().catch(() => undefined)
    this.client = undefined
  }
}

export function createMcpSources(defs: McpServerDef[], logger: Logger): McpServerSource[] {
  return defs.map((d) => new McpServerSource(d, logger))
}
