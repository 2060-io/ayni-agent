/**
 * What the tests of tools phase 2 share (ayni-spec D104 to D110): a fake authorization server (its metadata, Dynamic Client
 * Registration, the authorization of a person with PKCE, a token endpoint that checks the verifier and the `resource`,
 * rotated refresh tokens, revocation) and a fake MCP server that is its resource server (its Protected Resource Metadata,
 * a `401` with `resource_metadata` to a request without a valid token, a `403 insufficient_scope`). Every token, code and
 * verifier they hand out is kept, so that a test can look for it where it must not be. Nothing here leaves the loopback.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/** Who a person is at the service: what their consent picks. */
export interface Identity {
  email: string
  /** the workspace they pick at the consent */
  workspace?: { id: string; name: string }
  /** the login, for a GitHub-like check */
  login?: string
}

interface Grant {
  identity: Identity
  scopes: string[]
  clientId: string
  resource: string
  /** false once revoked at the service: its refresh is refused and its tokens are invalid */
  live: boolean
}

interface AccessToken {
  grant: Grant
  expiresAt: number
  /** made invalid at the service before it expired */
  invalid?: boolean
}

export interface FakeAsOptions {
  /** the path of the issuer: `/login/oauth` for a GitHub-like server; none for Relaticle's */
  issuerPath?: string
  /** a registration endpoint (RFC 7591) */
  registration?: boolean
  /** a revocation endpoint (RFC 7009) */
  revocation?: boolean
  /** `authorization_response_iss_parameter_supported` (RFC 9207) */
  issSupported?: boolean
  /** `code_challenge_methods_supported`; S256 by default */
  challengeMethods?: string[] | null
  /** `client_id_metadata_document_supported` */
  metadataDocument?: boolean
  scopesSupported?: string[]
  /** the lifetime of an access token, in seconds */
  expiresIn?: number
  /** a pre-registered client: its id and secret */
  client?: { id: string; secret: string }
  /** the time a refresh takes, to see two at once */
  refreshDelayMs?: number
}

export interface FakeAs {
  url: string
  issuer: string
  options: FakeAsOptions
  /** every client registered */
  registrations: Record<string, unknown>[]
  /** every request to the token endpoint, its form */
  tokenRequests: Record<string, string>[]
  /** every request to the token endpoint, its Authorization header */
  tokenAuthorizations: (string | undefined)[]
  revocations: Record<string, string>[]
  /** every Authorization header any request to this server carried */
  authorizations: string[]
  /** every token, code and verifier handed out or seen: what no log, store or model request may hold */
  secrets: Set<string>
  /** the person signs in and consents: the code, or the refusal, the browser carries back to `redirect_uri` */
  authorize(
    url: string,
    identity: Identity,
    options?: { deny?: boolean }
  ): { code?: string; error?: string; state: string }
  /** what the token is for, while it is valid */
  tokenInfo(token: string): AccessToken | undefined
  /** the person removes the app at the service: every token and refresh of the grant fails */
  revokeGrant(token: string): void
  /** the access token alone is made invalid before it expires */
  invalidate(token: string): void
  refreshes: number
  close(): Promise<void>
}

/** A fake authorization server (RFC 8414, 7591, 7636, 8707, 9207, 7009). */
export async function fakeAuthServer(options: FakeAsOptions = {}): Promise<FakeAs> {
  const registrations: Record<string, unknown>[] = []
  const tokenRequests: Record<string, string>[] = []
  const tokenAuthorizations: (string | undefined)[] = []
  const revocations: Record<string, string>[] = []
  const authorizations: string[] = []
  const secrets = new Set<string>()
  const clients = new Map<string, { redirectUris: string[] }>()
  const codes = new Map<
    string,
    { grant: Grant; challenge: string; method: string; redirectUri: string; used: boolean }
  >()
  const tokens = new Map<string, AccessToken>()
  const refreshTokens = new Map<string, Grant>()
  let base = ''
  const path = options.issuerPath ?? ''
  const fake = {
    registrations,
    tokenRequests,
    tokenAuthorizations,
    revocations,
    authorizations,
    secrets,
    options,
    refreshes: 0,
  } as unknown as FakeAs
  if (options.client) clients.set(options.client.id, { redirectUris: [] })
  const metadata = () => ({
    issuer: `${base}${path}`,
    authorization_endpoint: `${base}${path}/authorize`,
    token_endpoint: `${base}${path}/token`,
    ...(options.registration ? { registration_endpoint: `${base}${path}/register` } : {}),
    ...(options.revocation ? { revocation_endpoint: `${base}${path}/revoke` } : {}),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    ...(options.challengeMethods === null
      ? {}
      : { code_challenge_methods_supported: options.challengeMethods ?? ['S256'] }),
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    ...(options.scopesSupported ? { scopes_supported: options.scopesSupported } : {}),
    ...(options.issSupported ? { authorization_response_iss_parameter_supported: true } : {}),
    ...(options.metadataDocument ? { client_id_metadata_document_supported: true } : {}),
  })
  const issue = (grant: Grant) => {
    const access = `at_${randomBytes(18).toString('hex')}`
    const refresh = `rt_${randomBytes(18).toString('hex')}`
    secrets.add(access)
    secrets.add(refresh)
    tokens.set(access, { grant, expiresAt: Date.now() + (options.expiresIn ?? 3600) * 1000 })
    refreshTokens.set(refresh, grant)
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: options.expiresIn ?? 3600,
      refresh_token: refresh,
      scope: grant.scopes.join(' '),
    }
  }
  const server = createServer(async (req, res) => {
    if (req.headers.authorization) authorizations.push(req.headers.authorization)
    const url = new URL(req.url ?? '/', base)
    const route = url.pathname
    const wellKnown = path
      ? `/.well-known/oauth-authorization-server${path}`
      : '/.well-known/oauth-authorization-server'
    if (req.method === 'GET' && route === wellKnown) return json(res, 200, metadata())
    // a document read at a URI of another issuer says so, and the agent must not use it
    if (req.method === 'GET' && route === '/.well-known/openid-configuration')
      return json(res, 200, { ...metadata(), issuer: `${base}/someone-else` })
    if (req.method === 'POST' && route === `${path}/register` && options.registration) {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      registrations.push(body)
      const clientId = `client_${registrations.length}`
      clients.set(clientId, { redirectUris: (body.redirect_uris as string[]) ?? [] })
      return json(res, 201, { client_id: clientId, ...body })
    }
    if (req.method === 'POST' && route === `${path}/token`) {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
      tokenRequests.push(form)
      tokenAuthorizations.push(req.headers.authorization)
      for (const key of ['code', 'code_verifier', 'refresh_token']) if (form[key]) secrets.add(form[key] as string)
      const clientId =
        form.client_id ??
        Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64')
          .toString('utf8')
          .split(':')[0]
      if (options.client && clientId === options.client.id) {
        const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString('utf8')
        const secret = form.client_secret ?? basic.split(':')[1]
        if (decodeURIComponent(secret ?? '') !== options.client.secret)
          return json(res, 401, { error: 'invalid_client' })
      } else if (!clients.has(clientId ?? '')) return json(res, 401, { error: 'invalid_client' })
      if (form.grant_type === 'authorization_code') {
        const code = codes.get(form.code ?? '')
        if (!code || code.used) return json(res, 400, { error: 'invalid_grant' })
        code.used = true
        // PKCE S256 (RFC 7636 §4.6) and the resource of the authorization (RFC 8707 §2.2)
        const expected = createHash('sha256')
          .update(form.code_verifier ?? '')
          .digest('base64url')
        if (code.method !== 'S256' || expected !== code.challenge) return json(res, 400, { error: 'invalid_grant' })
        if (form.redirect_uri !== code.redirectUri) return json(res, 400, { error: 'invalid_grant' })
        if (form.resource !== code.grant.resource) return json(res, 400, { error: 'invalid_target' })
        return json(res, 200, issue(code.grant))
      }
      if (form.grant_type === 'refresh_token') {
        fake.refreshes++
        if (options.refreshDelayMs) await new Promise((r) => setTimeout(r, options.refreshDelayMs))
        const grant = refreshTokens.get(form.refresh_token ?? '')
        if (!grant?.live) return json(res, 400, { error: 'invalid_grant' })
        if (form.resource !== grant.resource) return json(res, 400, { error: 'invalid_target' })
        // rotated: the former refresh token is refused from now on
        refreshTokens.delete(form.refresh_token ?? '')
        return json(res, 200, issue(grant))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (req.method === 'POST' && route === `${path}/revoke` && options.revocation) {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
      revocations.push(form)
      const grant = refreshTokens.get(form.token ?? '') ?? tokens.get(form.token ?? '')?.grant
      if (grant) grant.live = false
      res.writeHead(200).end()
      return
    }
    res.writeHead(404).end()
  })
  base = await listen(server)
  return Object.assign(fake, {
    url: base,
    issuer: `${base}${path}`,
    authorize: (raw: string, identity: Identity, opts: { deny?: boolean } = {}) => {
      const url = new URL(raw)
      const p = Object.fromEntries(url.searchParams)
      const state = p.state ?? ''
      if (opts.deny) return { error: 'access_denied', state }
      if (p.response_type !== 'code' || !p.client_id || !p.redirect_uri || !p.code_challenge)
        return { error: 'invalid_request', state }
      const client = clients.get(p.client_id)
      if (!client && !p.client_id.startsWith('http')) return { error: 'unauthorized_client', state }
      if (client?.redirectUris.length && !client.redirectUris.includes(p.redirect_uri))
        return { error: 'invalid_request', state }
      const code = `code_${randomBytes(12).toString('hex')}`
      secrets.add(code)
      codes.set(code, {
        grant: {
          identity,
          scopes: (p.scope ?? '').split(' ').filter(Boolean),
          clientId: p.client_id,
          resource: p.resource ?? '',
          live: true,
        },
        challenge: p.code_challenge,
        method: p.code_challenge_method ?? 'plain',
        redirectUri: p.redirect_uri,
        used: false,
      })
      return { code, state }
    },
    tokenInfo: (token: string) => {
      const found = tokens.get(token)
      if (!found || found.invalid || !found.grant.live || found.expiresAt < Date.now()) return undefined
      return found
    },
    revokeGrant: (token: string) => {
      const grant = tokens.get(token)?.grant ?? refreshTokens.get(token)
      if (grant) grant.live = false
    },
    invalidate: (token: string) => {
      const found = tokens.get(token)
      if (found) found.invalid = true
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  })
}

export interface OAuthTool {
  name: string
  annotations?: Record<string, unknown>
  inputSchema?: Record<string, unknown>
  /** what it answers, given the arguments, the identity of the token and the Authorization it carried */
  answer?: (args: Record<string, unknown>, who: Identity, authorization: string) => unknown
  /** the scope a call needs: without it the server answers 403 insufficient_scope (TOOL-OAUTH-009) */
  scope?: string
}

export interface FakeOAuthMcp {
  url: string
  /** the authorization servers the Protected Resource Metadata names: a test moves them */
  authorizationServers: string[]
  /** the `resource` the metadata names: a test changes it */
  resource: string
  /** every tool call, with the token it carried */
  calls: { name: string; args: Record<string, unknown>; token: string }[]
  /** every Authorization header that reached it, valid or not */
  authorizations: (string | undefined)[]
  initializations: number
  close(): Promise<void>
}

/** A fake MCP server that is a resource server of a fake authorization server (RFC 9728, MCP authorization). */
export async function fakeOAuthMcp(
  as: FakeAs,
  tools: OAuthTool[],
  options: { scope?: string } = {}
): Promise<FakeOAuthMcp> {
  const fake = {
    calls: [],
    authorizations: [],
    initializations: 0,
    authorizationServers: [as.issuer],
  } as unknown as FakeOAuthMcp
  let base = ''
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(res, 200, {
        resource: fake.resource,
        authorization_servers: fake.authorizationServers,
        scopes_supported: [options.scope ?? 'mcp:use'],
      })
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    const authorization = req.headers.authorization
    fake.authorizations.push(authorization)
    const token = (authorization ?? '').replace(/^Bearer /, '')
    const info = token ? as.tokenInfo(token) : undefined
    const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${options.scope ?? 'mcp:use'}"`
    if (!info) {
      await readBody(req)
      res.writeHead(401, { 'www-authenticate': token ? `${challenge}, error="invalid_token"` : challenge }).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const parsed = JSON.parse((await readBody(req)) || 'null') as { method?: string; params?: { name?: string } } | null
    if (parsed?.method === 'initialize') fake.initializations++
    // a tool that needs a scope the token lacks: 403 at the HTTP level, as MCP authorization says
    const needs = parsed?.method === 'tools/call' ? tools.find((t) => t.name === parsed.params?.name)?.scope : undefined
    if (needs && !info.grant.scopes.includes(needs)) {
      res.writeHead(403, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${needs}"` }).end()
      return
    }
    const mcp = new Server({ name: 'fake-oauth', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.name,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    }))
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      fake.calls.push({ name: request.params.name, args, token })
      const tool = tools.find((t) => t.name === request.params.name)
      const answer = tool?.answer
        ? tool.answer(args, info.grant.identity, authorization ?? '')
        : `${request.params.name} done`
      return typeof answer === 'string'
        ? { content: [{ type: 'text', text: answer }] }
        : {
            content: [{ type: 'text', text: JSON.stringify(answer) }],
            structuredContent: answer as Record<string, unknown>,
          }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, parsed)
  })
  base = await listen(server)
  return Object.assign(fake, {
    url: `${base}/mcp`,
    resource: `${base}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  })
}

/** Relaticle's tools, as its server lists them: `who-ami-tool` reads the workspace and the email of the token. */
export function relaticleTools(): OAuthTool[] {
  return [
    {
      name: 'who-ami-tool',
      annotations: { readOnlyHint: true },
      answer: (_args, who) => ({ workspace: who.workspace ?? null, user: { email: who.email } }),
    },
    {
      name: 'list-companies-tool',
      annotations: { readOnlyHint: true },
      answer: (_args, who) => `companies of ${who.workspace?.name}: Acme Logistics`,
    },
    {
      name: 'create-note-tool',
      inputSchema: {
        type: 'object',
        required: ['note'],
        properties: { note: { type: 'string', title: 'Note' } },
      },
      answer: (args, who) => `note "${String(args.note)}" added in ${who.workspace?.name} by ${who.email}`,
    },
    {
      name: 'echo-auth',
      annotations: { readOnlyHint: true },
      // a server that echoes the Authorization it received (TOOL-ACCESS-010)
      answer: (_args, _who, authorization) => `you called with ${authorization}`,
    },
    { name: 'export-files', annotations: { readOnlyHint: true }, scope: 'files:write' },
  ]
}

/** GitHub's tools, as far as the tests use them. */
export function githubTools(): OAuthTool[] {
  return [
    { name: 'get_me', annotations: { readOnlyHint: true }, answer: (_a, who) => ({ login: who.login }) },
    {
      name: 'list_issues',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      },
      answer: (args, who) => `issues of ${String(args.owner)}/${String(args.repo)} for ${who.login}`,
    },
    {
      name: 'issue_write',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', title: 'Title' } },
      },
      answer: (args, who) =>
        `issue "${String(args.title)}" opened in ${String(args.owner)}/${String(args.repo)} by ${who.login}`,
    },
  ]
}

/** The person's browser comes back to the agent: the query of the callback the authorization server redirected to. */
export function callbackQuery(answer: { code?: string; error?: string; state: string }, iss?: string): string {
  const q = new URLSearchParams()
  if (answer.code) q.set('code', answer.code)
  if (answer.error) q.set('error', answer.error)
  q.set('state', answer.state)
  if (iss !== undefined) q.set('iss', iss)
  return q.toString()
}
