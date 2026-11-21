/**
 * OAuth as MCP defines it, revision 2026-07-28 (ayni-spec D105; TOOL-OAUTH-001..010): the agent is the OAuth client of
 * each person's own account of an MCP server.
 *
 * - Discovery (TOOL-OAUTH-001): the Protected Resource Metadata (RFC 9728) named by the `resource_metadata` of the
 *   `WWW-Authenticate` of a `401` to a request without a token, else at its well-known URIs, at the path of the server's
 *   endpoint and then at the root. Its `resource` must identify the server, and it must name an authorization server.
 * - The authorization server's metadata (TOOL-OAUTH-002): at the well-known URIs of RFC 8414 and OpenID Connect Discovery,
 *   in the order MCP gives; a document whose `issuer` is not exactly the one it was read for is not used; `S256` required.
 * - The client (TOOL-OAUTH-003): the one the source declares, never another; a registration (RFC 7591) kept for its issuer.
 * - The requests (TOOL-OAUTH-005..009): PKCE `S256`, `resource` (RFC 8707) in the authorization, token and refresh
 *   requests, the client's authentication, the revocation of RFC 7009.
 *
 * Nothing here logs, and no error it throws carries, a token, a code, a verifier or a secret: an error of a server is named
 * by its `error` code only.
 */
import { createHash, randomBytes } from 'node:crypto'

/** The MCP protocol version the discovery request speaks (MCP authorization, revision 2026-07-28). */
export const MCP_PROTOCOL_VERSION = '2025-06-18'
/** How long one request to an authorization server or to a server's metadata may take. */
export const OAUTH_REQUEST_MS = 10_000

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Why a source cannot be connected now: its metadata, its authorization server or the client cannot be had (502). */
export class SourceUnavailable extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'SourceUnavailable'
  }
}

/** A server answered a token, refresh or registration request with an OAuth error, named by its code only. */
export class OAuthRefused extends Error {
  public constructor(
    /** the `error` of the answer (`invalid_grant`), or `http_<status>` when it gave none */
    public readonly code: string,
    public readonly status: number
  ) {
    super(`the authorization server refused the request: ${code}`)
    this.name = 'OAuthRefused'
  }
}

/** The Protected Resource Metadata of a server (RFC 9728). */
export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

/** An authorization server's metadata (RFC 8414), what the agent reads of it. */
export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  client_id_metadata_document_supported?: boolean
  authorization_response_iss_parameter_supported?: boolean
}

/** What the discovery found of a server. */
export interface Discovery {
  /** the server's `resource`, as its metadata names it: sent in every request, and the only URL its tokens go to */
  resource: string
  /** the authorization servers its metadata lists, in order */
  authorizationServers: string[]
  /** the scopes of its challenge, when it answered `401` with one */
  challengeScopes?: string[]
  scopesSupported?: string[]
}

/** A token answer (RFC 6749 §5.1). */
export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** when the access token expires, when the server said */
  expiresAt?: string
  /** the scopes granted, when the server said */
  scopes?: string[]
}

/** How the agent authenticates to a token endpoint: a public client sends its id, a confidential one its secret too. */
export interface ClientCredentials {
  clientId: string
  clientSecret?: string
}

/** The parameters of a `WWW-Authenticate: Bearer` challenge (RFC 6750 §3, RFC 9728 §5.1). */
export function parseBearerChallenge(header: string | null | undefined): Record<string, string> | undefined {
  if (!header) return undefined
  const at = header.search(/\bBearer\b/i)
  if (at < 0) return undefined
  const params: Record<string, string> = {}
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g
  for (const m of header.slice(at + 6).matchAll(re)) {
    const name = (m[1] ?? '').toLowerCase()
    params[name] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '')
  }
  return params
}

/** Whether a URL may carry OAuth: HTTPS, or HTTP on the loopback (a local server of a test, MCP authorization §2.1). */
export function secureUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

/** A URL without its fragment and its one trailing slash, scheme and host in lower case: what RFC 9728 §3.3 compares. */
export function sameResource(a: string, b: string): boolean {
  const norm = (url: string) => {
    try {
      const u = new URL(url)
      u.hash = ''
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase()
    } catch {
      return url
    }
  }
  return norm(a) === norm(b)
}

/** The well-known URIs of a server's Protected Resource Metadata: at the path of its endpoint, then at the root. */
export function protectedResourceUris(url: string): string[] {
  const u = new URL(url)
  const path = u.pathname.replace(/\/$/, '')
  const root = `${u.origin}/.well-known/oauth-protected-resource`
  return path && path !== '/' ? [`${root}${u.pathname}`, root] : [root]
}

/** The well-known URIs of an authorization server's metadata, in the order of MCP authorization (RFC 8414, OIDC). */
export function authorizationServerUris(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, '')
  if (!path)
    return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ]
}

/** A PKCE pair (RFC 7636): a verifier of 43 characters or more and its `S256` challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** A `state` of 256 random bits, and the digest under which the attempt keeps it. */
export function newState(): { state: string; hash: string } {
  const state = randomBytes(32).toString('base64url')
  return { state, hash: stateHash(state) }
}

export function stateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex')
}

function scopesOf(text: string | undefined): string[] | undefined {
  const scopes = (text ?? '').split(/\s+/).filter(Boolean)
  return scopes.length ? scopes : undefined
}

/** The OAuth client of the agent: discovery, client registration, the requests of a sign-in, refresh, revocation. */
export class OAuthClient {
  public constructor(
    private readonly fetchFn: FetchLike = fetch,
    private readonly timeoutMs = OAUTH_REQUEST_MS
  ) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    if (!secureUrl(url)) throw new SourceUnavailable(`${new URL(url).origin} is not served over HTTPS`)
    return this.fetchFn(url, { ...init, signal: init.signal ?? AbortSignal.timeout(this.timeoutMs) })
  }

  private async getJson<T>(url: string): Promise<T | undefined> {
    try {
      const response = await this.request(url, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return undefined
      }
      return (await response.json()) as T
    } catch (error) {
      if (error instanceof SourceUnavailable) throw error
      return undefined
    }
  }

  /**
   * Finds a server's authorization servers (TOOL-OAUTH-001): its `401` to a request without a token names its Protected
   * Resource Metadata, else the well-known URIs do. The metadata must identify the server and name an authorization server.
   */
  public async discover(url: string): Promise<Discovery> {
    if (!secureUrl(url)) throw new SourceUnavailable('the server is not reached over HTTPS')
    let metadataUrl: string | undefined
    let challengeScopes: string[] | undefined
    try {
      // an MCP request without a token: the server's 401 names where its metadata is (RFC 9728 §5.1)
      const response = await this.request(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'ayni-agent', version: '3.0.0' },
          },
        }),
        redirect: 'error',
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401) {
        const challenge = parseBearerChallenge(response.headers.get('www-authenticate'))
        metadataUrl = challenge?.resource_metadata
        challengeScopes = scopesOf(challenge?.scope)
      }
    } catch (error) {
      if (error instanceof SourceUnavailable) throw error
    }
    const candidates = metadataUrl ? [metadataUrl] : protectedResourceUris(url)
    let prm: ProtectedResourceMetadata | undefined
    for (const candidate of candidates) {
      if (!secureUrl(candidate)) continue
      prm = await this.getJson<ProtectedResourceMetadata>(candidate)
      if (prm) break
    }
    if (!prm || typeof prm.resource !== 'string')
      throw new SourceUnavailable('the server publishes no Protected Resource Metadata')
    if (!sameResource(prm.resource, url))
      throw new SourceUnavailable('the Protected Resource Metadata names another resource than the server')
    const servers = (prm.authorization_servers ?? []).filter((s) => typeof s === 'string' && s)
    if (!servers.length) throw new SourceUnavailable('the Protected Resource Metadata names no authorization server')
    return {
      resource: prm.resource,
      authorizationServers: servers,
      ...(challengeScopes ? { challengeScopes } : {}),
      ...(prm.scopes_supported?.length ? { scopesSupported: prm.scopes_supported } : {}),
    }
  }

  /**
   * An authorization server's metadata (TOOL-OAUTH-002), read at the well-known URIs in order; a document whose `issuer`
   * is not exactly the one asked is not used, and a server without `S256` cannot be connected.
   */
  public async metadata(issuer: string): Promise<AuthorizationServerMetadata> {
    if (!secureUrl(issuer)) throw new SourceUnavailable('the authorization server is not served over HTTPS')
    for (const uri of authorizationServerUris(issuer)) {
      const doc = await this.getJson<AuthorizationServerMetadata>(uri)
      if (!doc) continue
      if (doc.issuer !== issuer) continue
      if (!doc.authorization_endpoint || !doc.token_endpoint)
        throw new SourceUnavailable('the authorization server names no authorization or token endpoint')
      if (!doc.code_challenge_methods_supported?.includes('S256'))
        throw new SourceUnavailable('the authorization server does not support PKCE with S256')
      for (const endpoint of [doc.authorization_endpoint, doc.token_endpoint])
        if (!secureUrl(endpoint)) throw new SourceUnavailable('an endpoint of the authorization server is not HTTPS')
      return doc
    }
    throw new SourceUnavailable('the authorization server publishes no metadata for its issuer')
  }

  /** Dynamic Client Registration (RFC 7591, TOOL-OAUTH-003): a public client of the agent's callback. */
  public async register(
    metadata: AuthorizationServerMetadata,
    clientName: string,
    redirectUri: string
  ): Promise<ClientCredentials> {
    if (!metadata.registration_endpoint) throw new SourceUnavailable('the authorization server registers no client')
    let response: Response
    try {
      response = await this.request(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          application_type: 'web',
        }),
        redirect: 'error',
      })
    } catch (error) {
      if (error instanceof SourceUnavailable) throw error
      throw new SourceUnavailable('the registration endpoint cannot be reached')
    }
    const body = (await response.json().catch(() => ({}))) as {
      client_id?: unknown
      client_secret?: unknown
      error?: unknown
    }
    if (!response.ok || typeof body.client_id !== 'string' || !body.client_id)
      throw new SourceUnavailable(
        `the authorization server refused the registration${typeof body.error === 'string' ? `: ${body.error}` : ''}`
      )
    return {
      clientId: body.client_id,
      ...(typeof body.client_secret === 'string' && body.client_secret ? { clientSecret: body.client_secret } : {}),
    }
  }

  /** The URL of a sign-in (TOOL-OAUTH-005): the code flow with PKCE `S256`, the `resource`, the scopes, the binding asked. */
  public authorizationUrl(
    metadata: AuthorizationServerMetadata,
    params: {
      clientId: string
      redirectUri: string
      state: string
      challenge: string
      resource: string
      scopes: string[]
      extra?: Record<string, string>
    }
  ): string {
    const url = new URL(metadata.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', params.clientId)
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('state', params.state)
    url.searchParams.set('code_challenge', params.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('resource', params.resource)
    if (params.scopes.length) url.searchParams.set('scope', params.scopes.join(' '))
    for (const [name, value] of Object.entries(params.extra ?? {})) url.searchParams.set(name, value)
    return url.toString()
  }

  /**
   * A request to the token endpoint, with the client's authentication: `client_secret_post` when the server lists it or
   * lists none, else `client_secret_basic`, for a client with a secret; its id alone for a public client. An answer that
   * holds an `error`, whatever its status, is a refusal, named by that code only.
   */
  private async tokenRequest(
    metadata: AuthorizationServerMetadata,
    client: ClientCredentials,
    form: Record<string, string>
  ): Promise<TokenSet> {
    const body = new URLSearchParams(form)
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    }
    const methods = metadata.token_endpoint_auth_methods_supported
    if (
      client.clientSecret &&
      methods?.length &&
      !methods.includes('client_secret_post') &&
      methods.includes('client_secret_basic')
    ) {
      const encode = (v: string) => encodeURIComponent(v)
      headers.authorization = `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret)}`).toString('base64')}`
    } else {
      body.set('client_id', client.clientId)
      if (client.clientSecret) body.set('client_secret', client.clientSecret)
    }
    let response: Response
    try {
      response = await this.request(metadata.token_endpoint, { method: 'POST', headers, body, redirect: 'error' })
    } catch (error) {
      if (error instanceof SourceUnavailable) throw error
      throw new SourceUnavailable('the token endpoint cannot be reached')
    }
    const text = await response.text().catch(() => '')
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      // a server that answers in a form (GitHub without `accept`) still names its fields
      json = Object.fromEntries(new URLSearchParams(text))
    }
    if (typeof json.error === 'string' || !response.ok) {
      const code = typeof json.error === 'string' ? json.error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) : ''
      if (response.status >= 500 && !code) throw new SourceUnavailable(`the token endpoint answered ${response.status}`)
      throw new OAuthRefused(code || `http_${response.status}`, response.status)
    }
    const accessToken = json.access_token
    const tokenType = typeof json.token_type === 'string' ? json.token_type : 'bearer'
    if (typeof accessToken !== 'string' || !accessToken || tokenType.toLowerCase() !== 'bearer')
      throw new OAuthRefused('invalid_token_response', response.status)
    const expiresIn = Number(json.expires_in)
    return {
      accessToken,
      ...(typeof json.refresh_token === 'string' && json.refresh_token ? { refreshToken: json.refresh_token } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0
        ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
        : {}),
      ...(typeof json.scope === 'string' ? { scopes: json.scope.split(/[\s,]+/).filter(Boolean) } : {}),
    }
  }

  /** The code of a callback exchanged with the verifier, the callback and the `resource` (TOOL-OAUTH-006). */
  public exchange(
    metadata: AuthorizationServerMetadata,
    client: ClientCredentials,
    params: { code: string; verifier: string; redirectUri: string; resource: string }
  ): Promise<TokenSet> {
    return this.tokenRequest(metadata, client, {
      grant_type: 'authorization_code',
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
      resource: params.resource,
    })
  }

  /** A refresh with the `resource` and the client's authentication (TOOL-OAUTH-008). */
  public refresh(
    metadata: AuthorizationServerMetadata,
    client: ClientCredentials,
    params: { refreshToken: string; resource: string }
  ): Promise<TokenSet> {
    return this.tokenRequest(metadata, client, {
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      resource: params.resource,
    })
  }

  /**
   * Asks the server to revoke a token (RFC 7009), when its metadata names an endpoint for it: within the time given, and
   * whatever it answers (TOOL-CONN-006). Resolves whether it was asked.
   */
  public async revoke(
    metadata: AuthorizationServerMetadata,
    client: ClientCredentials,
    token: string,
    hint: 'refresh_token' | 'access_token',
    timeoutMs: number
  ): Promise<boolean> {
    if (!metadata.revocation_endpoint || !secureUrl(metadata.revocation_endpoint)) return false
    const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.clientId })
    if (client.clientSecret) body.set('client_secret', client.clientSecret)
    try {
      const response = await this.fetchFn(metadata.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      await response.body?.cancel().catch(() => undefined)
    } catch {
      // whatever it answers, or not in time: the account's key is destroyed all the same
    }
    return true
  }
}
