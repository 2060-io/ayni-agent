/**
 * MCP client over stdio, SSE and streamable-HTTP with lazy connect (D41, TOOL-MCP-001..003). A server gives the model the
 * tools its `offer` names, or every tool it lists (TOOL-CAT-003). A server whose account is a space's keeps one connection
 * per space account, opened on the first call that needs it and closed once idle, so that no call of a space travels on
 * another's connection (TOOL-ACCESS-007); a server of the agent's account, or of none, keeps one connection.
 *
 * A server of each person's own account (D104, TOOL-ACCESS-012) keeps one connection per account, shared by the sources
 * that use it (`account.from`), in a pool of the agent. An OAuth account's requests carry its access token in their
 * `Authorization` header, and only to the server the token is for (no token passthrough, TOOL-ACCESS-010); a `401` to a
 * token that had not expired is followed by one refresh and one more try, a `403 insufficient_scope` marks the account
 * as asking for more access (TOOL-OAUTH-008/009). No redirect is followed with a person's account.
 */
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpSource } from '../config/packTypes.js'
import type { Logger } from '../util/logger.js'
import { scrubAccount } from './accountValues.js'
import type { ToolAnnotations } from './catalog.js'
import { type FetchLike, parseBearerChallenge } from './oauth.js'
import type {
  CallAccountSecret,
  CheckRead,
  CheckResult,
  PersonalOAuthHandle,
  ToolContext,
  ToolResult,
  ToolSource,
  ToolSpec,
} from './types.js'

/** Whether a URL is the server's own: its origin, at its path or under it (no token passthrough, TOOL-ACCESS-010). */
export function withinServer(url: string, server: string): boolean {
  try {
    const u = new URL(url)
    const s = new URL(server)
    if (u.origin !== s.origin) return false
    const base = s.pathname.replace(/\/$/, '')
    const path = u.pathname.replace(/\/$/, '')
    return path === base || u.pathname.startsWith(`${base}/`)
  } catch {
    return false
  }
}

/**
 * The fetch of a person's account (TOOL-ACCESS-010, TOOL-OAUTH-008/009): only to the server of the account, never
 * following a redirect; for an OAuth account, the access token of the moment in `Authorization`, one refresh and one more
 * try after a `401`, and a `403 insufficient_scope` told to the account.
 */
export function personalFetch(
  server: string,
  handle?: PersonalOAuthHandle | (() => PersonalOAuthHandle | undefined),
  base: FetchLike = fetch
): FetchLike {
  return async (input, init = {}) => {
    // the handle of the call in progress: a connection outlives the call that opened it
    const oauth = typeof handle === 'function' ? handle() : handle
    const url = typeof input === 'string' ? input : input.toString()
    if (!withinServer(url, server)) throw new Error('a request of a person account goes to another server: refused')
    const send = (token?: string) => {
      const headers = new Headers(init.headers)
      if (token) headers.set('authorization', `Bearer ${token}`)
      return base(url, { ...init, headers, redirect: 'error' })
    }
    if (!oauth) return send()
    const token = await oauth.token()
    let response = await send(token)
    if (response.status === 401) {
      const next = await oauth.after401(token)
      if (next === undefined) return response
      await response.body?.cancel().catch(() => undefined)
      response = await send(next)
      if (response.status === 401) await oauth.refusedAgain()
    } else if (response.status === 403) {
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'))
      if (challenge?.error === 'insufficient_scope')
        await oauth.insufficientScope((challenge.scope ?? '').split(/\s+/).filter(Boolean))
    }
    return response
  }
}

/**
 * The connections of people's own accounts (TOOL-ACCESS-012): one per account, shared by every source that uses it,
 * opened by the first call that needs it and closed once idle. A replaced or ended account's connection closes.
 */
export class PersonalConnections {
  private readonly open = new Map<string, AccountConnection>()
  private readonly opening = new Map<string, Promise<AccountConnection>>()
  /** the handle of the latest call on each account's connection, whichever source made it: where its token comes from */
  private readonly handles = new Map<string, PersonalOAuthHandle>()

  public setHandle(accountId: string, handle: PersonalOAuthHandle): void {
    this.handles.set(accountId, handle)
  }

  public handleOf(accountId: string): PersonalOAuthHandle | undefined {
    return this.handles.get(accountId)
  }

  public constructor(
    private readonly logger: Logger,
    private readonly idleSeconds = DEFAULT_IDLE_SECONDS
  ) {}

  /** How many are open: for the tests of TOOL-ACCESS-012. */
  public get size(): number {
    return this.open.size
  }

  public async client(accountId: string, key: string, connect: () => Promise<Client>): Promise<Client> {
    const found = this.open.get(accountId)
    if (found && found.key === key) {
      this.touch(accountId, found)
      return found.client
    }
    if (found) await this.close(accountId)
    const pending = this.opening.get(accountId)
    if (pending) {
      const connection = await pending
      if (connection.key === key) return connection.client
    }
    const opening = (async () => {
      const client = await connect()
      const connection: AccountConnection = { client, key }
      client.onclose = () => {
        if (this.open.get(accountId) === connection) this.open.delete(accountId)
      }
      this.open.set(accountId, connection)
      this.touch(accountId, connection)
      // the account is named by its id, never a value of it (TOOL-ACCESS-010)
      this.logger.info({ accountId }, 'mcp server connected with a person own account')
      return connection
    })()
    this.opening.set(accountId, opening)
    try {
      return (await opening).client
    } finally {
      this.opening.delete(accountId)
    }
  }

  public touch(accountId: string, connection = this.open.get(accountId)): void {
    if (!connection) return
    if (connection.timer) clearTimeout(connection.timer)
    connection.timer = setTimeout(() => {
      this.logger.info({ accountId }, 'mcp connection of a person own account closed: idle')
      void this.close(accountId)
    }, this.idleSeconds * 1000)
    connection.timer.unref?.()
  }

  /** The account ended, was replaced or must reconnect: its connection closes and nothing of its calls is kept. */
  public async end(accountId: string): Promise<void> {
    this.handles.delete(accountId)
    await this.close(accountId)
  }

  public async close(accountId: string): Promise<void> {
    const connection = this.open.get(accountId)
    if (!connection) return
    this.open.delete(accountId)
    if (connection.timer) clearTimeout(connection.timer)
    await connection.client.close().catch(() => undefined)
  }

  public async closeAll(): Promise<void> {
    for (const id of [...this.open.keys()]) await this.close(id)
  }
}

/** How long a connection of a space's account stays open unused (TOOL_CONNECTION_IDLE_SECONDS, 600 by default). */
export const DEFAULT_IDLE_SECONDS = 600

interface AccountConnection {
  client: Client
  /** a digest of the headers it was opened with: another account is another connection; never the values themselves */
  key: string
  timer?: NodeJS.Timeout
}

/** A digest of the headers of an account, to tell one account's connection from another's without keeping them twice. */
function accountKey(headers: Record<string, string>): string {
  const entries = Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
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
    private readonly idleSeconds = DEFAULT_IDLE_SECONDS,
    /** the connections of people's own accounts, shared by the sources that use one account (TOOL-ACCESS-012) */
    private readonly personal: PersonalConnections = new PersonalConnections(logger, idleSeconds)
  ) {
    this.name = name
    this.id = `mcp:${name}`
  }

  private get spaceAccount(): boolean {
    return this.def.account?.kind === 'space'
  }

  private get personalAccount(): boolean {
    return this.def.account?.kind === 'personal'
  }

  /**
   * The connection of a person's own account (TOOL-ACCESS-012): its OAuth token set per request by the account's fetch,
   * or the headers built from its fields; the server of the account and no other.
   */
  private async connectPersonal(account: CallAccountSecret): Promise<Client> {
    const accountId = account.accountId
    if (!accountId || (!account.oauth && !account.headers))
      throw new Error('the account of this person is not connected')
    const url = account.oauth?.url ?? (this.def.url as string)
    const key = account.oauth ? `oauth:${url}` : accountKey(account.headers ?? {})
    if (account.oauth) this.personal.setHandle(accountId, account.oauth)
    return this.personal.client(accountId, key, async () => {
      const client = new Client({ name: 'ayni-agent', version: '3.0.0' })
      await client.connect(
        this.createRemote(
          url,
          account.oauth ? {} : (account.headers ?? {}),
          personalFetch(url, account.oauth ? () => this.personal.handleOf(accountId) : undefined)
        )
      )
      return client
    })
  }

  /** A remote transport to a URL with extra headers and, for a person's account, its own fetch. */
  private createRemote(url: string, extraHeaders: Record<string, string>, fetchFn?: FetchLike) {
    const all = { ...(this.def.headers ?? {}), ...extraHeaders }
    const requestInit = Object.keys(all).length ? { headers: all } : undefined
    const options = { ...(requestInit ? { requestInit } : {}), ...(fetchFn ? { fetch: fetchFn } : {}) }
    if (this.def.transport === 'sse') return new SSEClientTransport(new URL(url), options)
    return new StreamableHTTPClientTransport(new URL(url), options)
  }

  /** Closes the connection of a person's account: it ended, was replaced or must reconnect (TOOL-ACCESS-012). */
  public async closePersonal(accountId: string): Promise<void> {
    await this.personal.end(accountId)
  }

  /**
   * The check of a person's new account (TOOL-CONN-013): its tool called once with no argument, on a connection of its
   * own that closes after, at the account's server and with its headers; outside any conversation, with no record.
   */
  public async checkRead(read: CheckRead): Promise<CheckResult | undefined> {
    const client = new Client({ name: 'ayni-agent', version: '3.0.0' })
    try {
      await client.connect(this.createRemote(read.url, read.headers, personalFetch(read.url)))
      const { tools } = await client.listTools()
      const listed = (tools as ListedTool[]).find((t) => t.name === read.tool)
      if (!listed) return undefined
      const result = await client.callTool({ name: read.tool, arguments: {} })
      if (result.isError === true) return undefined
      const content = (result.content as { type: string; text?: string }[] | undefined) ?? []
      const text = content.find((p) => p.type === 'text')?.text ?? ''
      return {
        ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
        text,
        ...(listed.annotations ? { annotations: listed.annotations } : {}),
      }
    } finally {
      await client.close().catch(() => undefined)
    }
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

  /**
   * The connection of a space's account: opened on first need with the headers built from its fields (D102), kept while
   * used, closed once idle.
   */
  private async connectAccount(account: CallAccountSecret): Promise<Client> {
    const spaceId = account.spaceId
    const headers = account.headers
    if (!spaceId || !headers) throw new Error('the account of this space is not set')
    const key = accountKey(headers)
    const open = this.accounts.get(spaceId)
    if (open && open.key === key) {
      this.touch(spaceId, open)
      return open.client
    }
    // an account replaced: the connection of the former one closes, and nothing of it is reused
    if (open) await this.closeAccount(spaceId)
    const pending = this.opening.get(spaceId)
    if (pending) {
      const connection = await pending
      if (connection.key === key) return connection.client
    }
    const opening = (async () => {
      const client = new Client({ name: 'ayni-agent', version: '3.0.0' })
      await client.connect(this.createTransport(headers))
      const connection: AccountConnection = { client, key }
      client.onclose = () => {
        if (this.accounts.get(spaceId) === connection) this.accounts.delete(spaceId)
      }
      this.accounts.set(spaceId, connection)
      this.touch(spaceId, connection)
      // the space is named, never a value of its account (TOOL-ACCESS-005)
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

  /**
   * A call with a person's own account (TOOL-ACCESS-012, TOOL-CALL-011): on that account's connection; when the account
   * turns out not connected, or asks for more access, the call says so and its connection closes.
   */
  private async callPersonal(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const account = ctx.account
    if (!account?.accountId || (!account.oauth && !account.headers))
      return { content: 'The person has not connected their account.', isError: true, accountOutcome: 'not-connected' }
    try {
      const c = await this.connectPersonal(account)
      const result = await c.callTool({ name, arguments: args }, undefined, { signal: ctx.signal })
      this.personal.touch(account.accountId)
      const content = (result.content as { type: string; text?: string }[] | undefined) ?? []
      const text = content.map((p) => (p.type === 'text' ? (p.text ?? '') : `[${p.type}]`)).join('\n')
      return {
        content: text || JSON.stringify(result.structuredContent ?? {}),
        data: result.structuredContent,
        isError: result.isError === true,
      }
    } catch (error) {
      // a refresh in progress may end the account, and close this connection under the call: its outcome first
      await account.oauth?.settled()
      const outcome = account.oauth?.outcome
      if (outcome) {
        await this.personal.close(account.accountId)
        return {
          content:
            outcome === 'more-access-needed'
              ? 'The server asks this account for more access.'
              : 'The account of this person is not connected.',
          isError: true,
          accountOutcome: outcome,
        }
      }
      throw error
    }
  }

  private async call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (this.personalAccount) return this.callPersonal(name, args, ctx)
    // a call of a space travels on that space's connection, with its own account, and on no other (TOOL-ACCESS-007)
    if (this.spaceAccount && !ctx.account?.headers)
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
    if (this.spaceAccount || this.personalAccount) return []
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
    if (this.cachedTools || (!this.spaceAccount && !this.personalAccount)) return
    try {
      const client = this.personalAccount ? await this.connectPersonal(account) : await this.connectAccount(account)
      const { tools } = await client.listTools()
      this.cachedTools = this.specsOf(tools as ListedTool[])
    } catch (error) {
      // the error may echo the request: the space is named, nothing of the account (TOOL-ACCESS-005)
      this.logger.error(
        {
          server: this.name,
          ...(account.spaceId ? { spaceId: account.spaceId } : {}),
          ...(account.accountId ? { accountId: account.accountId } : {}),
          err: scrub(error, [...(account.secrets ?? []), ...(account.oauth?.secrets() ?? [])]),
        },
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

/** The message of an error with every value of the account, and every header built from them, replaced (TOOL-ACCESS-005). */
export function scrub(error: unknown, secrets: readonly string[] | undefined): string {
  return scrubAccount(error instanceof Error ? error.message : String(error), secrets)
}

/** The MCP servers of `tools.sources`, each with its source's id (D101). */
export function createMcpSources(
  defs: [string, McpSource][],
  logger: Logger,
  idleSeconds = DEFAULT_IDLE_SECONDS,
  personal: PersonalConnections = new PersonalConnections(logger, idleSeconds)
): McpServerSource[] {
  return defs.map(([name, def]) => new McpServerSource(name, def, logger, idleSeconds, personal))
}
