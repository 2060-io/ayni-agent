/**
 * What the tests of a Google Workspace account share (ayni-spec D118, architecture §10.10), never a real service: the
 * agent-pack's account of `tools.accounts` and its two sources, Google Drive and Google Calendar, as §10.10 writes them;
 * a fake OpenID Connect authorization server that stands for Google's (its discovery document, `jwks_uri`, an
 * authorization that lets the person untick scopes, a token endpoint that answers `scope` and a signed `id_token`,
 * `include_granted_scopes`, a revocation endpoint); and a fake connector that publishes Protected Resource Metadata naming
 * it, checks each call's token and scopes there, and answers Files 1.0 and Calendar 1.0 through the fake provider of the
 * features' tests. Nothing here leaves the loopback, and no client is registered anywhere.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeProvider, fakeProvider } from './featureFixtures.js'
import type { Doc } from './toolFixtures.js'

const G = 'https://www.googleapis.com/auth'
/** The scopes of the table of architecture §10.10, written in full. */
export const SCOPES = {
  driveRead: `${G}/drive.readonly`,
  drive: `${G}/drive`,
  calendarList: `${G}/calendar.calendarlist.readonly`,
  eventsRead: `${G}/calendar.events.readonly`,
  freeBusy: `${G}/calendar.events.freebusy`,
  events: `${G}/calendar.events`,
}

/** The scopes each tool of the two sources needs, as §10.10 declares them. */
export const DRIVE_TOOLS: Record<string, string[]> = {
  files_roots: [SCOPES.driveRead],
  files_list: [SCOPES.driveRead],
  files_get: [SCOPES.driveRead],
  files_read: [SCOPES.driveRead],
  files_search: [SCOPES.driveRead],
  files_create: [SCOPES.drive],
  files_replace: [SCOPES.drive],
}
/** The tools a team space's shared drive is managed with, and those of `share` a model may be given (§10.13). */
export const MANAGING_DRIVE_TOOLS: Record<string, string[]> = {
  files_create_team_root: [SCOPES.drive],
  files_rename_root: [SCOPES.drive],
  files_shares: [SCOPES.drive],
  files_share: [SCOPES.drive],
  files_unshare: [SCOPES.drive],
}
export const CALENDAR_TOOLS: Record<string, string[]> = {
  calendar_calendars: [SCOPES.calendarList],
  calendar_list_events: [SCOPES.eventsRead],
  calendar_get_event: [SCOPES.eventsRead],
  calendar_free_busy: [SCOPES.freeBusy],
  calendar_create_event: [SCOPES.events],
  calendar_update_event: [SCOPES.events],
  calendar_cancel_event: [SCOPES.events],
  calendar_respond: [SCOPES.events],
}

export interface GooglePackOptions {
  /** the connector of both sources, as §10.10 names one URL for both */
  url: string
  /** the issuer of the pre-registered client: Google's, or the fake's */
  issuer: string
  /** the organization's domain, asked as `hd` and checked in the ID token */
  domain: string
}

/**
 * The agent-pack text of architecture §10.10 applied to a pack: the features Files and Calendar, the account `google` of
 * `tools.accounts`, and the sources `drive` and `calendar` that use it, at the deployment's own connector.
 */
export function googleSources(pack: Doc, options: GooglePackOptions): void {
  pack.tools.features.files = { title: 'Files', profile: { id: 'org.ayni/files', version: '1.0' } }
  pack.tools.features.calendar = {
    title: 'Calendar',
    profile: { id: 'org.ayni/calendar', version: '1.0' },
    tools: { calendar_cancel_event: { call: 'confirm' } },
  }
  pack.tools.accounts = {
    google: {
      kind: 'personal',
      title: 'Google',
      description: 'Your files and your calendar at Google, with your own rights there',
      oauth: {
        client: {
          registration: 'pre-registered',
          issuer: options.issuer,
          id: '$' + '{TOOLS_GOOGLE_CLIENT_ID}',
          secret: '$' + '{TOOLS_GOOGLE_CLIENT_SECRET}',
        },
        resource: false,
        parameters: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
        loginHint: 'email',
        hostedDomain: options.domain,
      },
      check: { idToken: { email: true, hostedDomain: options.domain }, label: '{email}' },
    },
  }
  const scoped = (tools: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(tools).map(([name, scopes]) => [name, { scopes }]))
  pack.tools.sources.drive = {
    type: 'mcp',
    feature: 'files',
    title: 'Google Drive',
    description: 'The files you can open in Google Drive',
    transport: 'streamable-http',
    url: options.url,
    account: { kind: 'personal', from: 'google' },
    availability: 'personal',
    capabilities: ['search'],
    untrusted: true,
    access: { roles: { employee: ['*'] } },
    tools: scoped(DRIVE_TOOLS),
  }
  pack.tools.sources.calendar = {
    type: 'mcp',
    feature: 'calendar',
    title: 'Google Calendar',
    description: 'Your calendars and events at Google',
    transport: 'streamable-http',
    url: options.url,
    account: { kind: 'personal', from: 'google' },
    availability: 'personal',
    capabilities: ['free-busy', 'respond', 'attendees'],
    untrusted: true,
    access: { roles: { employee: ['*'] } },
    tools: scoped(CALENDAR_TOOLS),
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/** Who signs in at the fake Google: their address, whether it is verified, their Workspace's domain. */
export interface GoogleUser {
  email: string
  emailVerified?: boolean
  /** the Workspace domain Google names as `hd`; none for a personal Google account */
  hd?: string
}

/** What the next ID token gets wrong, one thing at a time, for the bad cases of TOOL-OAUTH-016. */
export interface IdTokenFault {
  /** signed with a key the `jwks_uri` does not hold */
  signature?: boolean
  iss?: string
  aud?: string
  /** an `exp` already passed */
  expired?: boolean
  nonce?: string
  /** no `id_token` in the token answer at all */
  missing?: boolean
}

interface Grant {
  user: GoogleUser
  scopes: string[]
  live: boolean
}

export interface FakeGoogle {
  issuer: string
  clientId: string
  clientSecret: string
  /** every request to the token endpoint, its form */
  tokenRequests: Record<string, string>[]
  revocations: Record<string, string>[]
  /** every access, refresh and ID token handed out, every code: what no log, store or model request may hold */
  secrets: Set<string>
  /** the fault of the next ID token, consumed by it */
  fault?: IdTokenFault
  /**
   * The person signs in and consents: `untick` leaves out scopes the request asked; with `include_granted_scopes=true`,
   * what the same person granted before is granted again.
   */
  authorize(
    url: string,
    user: GoogleUser,
    options?: { untick?: string[]; deny?: boolean }
  ): { code?: string; error?: string; state: string }
  /** the grant a token is of, while it is valid */
  tokenInfo(token: string): Grant | undefined
  close(): Promise<void>
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A fake of Google's authorization server: OpenID Connect discovery, RS256 ID tokens, incremental consent, revocation. */
export async function fakeGoogle(): Promise<FakeGoogle> {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = `kid-${randomBytes(4).toString('hex')}`
  const clientId = `test-client-${randomBytes(4).toString('hex')}.apps.example.org`
  const clientSecret = `test-secret-${randomBytes(12).toString('hex')}`
  const secrets = new Set<string>()
  const tokenRequests: Record<string, string>[] = []
  const revocations: Record<string, string>[] = []
  const codes = new Map<
    string,
    { grant: Grant; challenge: string; redirectUri: string; nonce?: string; used: boolean }
  >()
  const tokens = new Map<string, Grant>()
  const refreshTokens = new Map<string, Grant>()
  /** what each person granted this client before, for include_granted_scopes */
  const granted = new Map<string, Set<string>>()
  let base = ''
  const fake = { tokenRequests, revocations, secrets, clientId, clientSecret } as unknown as FakeGoogle
  const signIdToken = (claims: Record<string, unknown>, signer: KeyObject) => {
    const header = b64({ alg: 'RS256', kid, typ: 'JWT' })
    const payload = b64(claims)
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), signer).toString('base64url')
    return `${header}.${payload}.${signature}`
  }
  const issue = (grant: Grant, nonce: string | undefined, withRefresh: boolean) => {
    const access = `ya29.${randomBytes(18).toString('hex')}`
    secrets.add(access)
    tokens.set(access, grant)
    const answer: Record<string, unknown> = {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3599,
      scope: grant.scopes.join(' '),
    }
    if (withRefresh) {
      const refresh = `1//${randomBytes(18).toString('hex')}`
      secrets.add(refresh)
      refreshTokens.set(refresh, grant)
      answer.refresh_token = refresh
    }
    const fault = fake.fault
    fake.fault = undefined
    if (grant.scopes.includes('openid') && !fault?.missing) {
      const now = Math.floor(Date.now() / 1000)
      const idToken = signIdToken(
        {
          iss: fault?.iss ?? `${base}`,
          aud: fault?.aud ?? clientId,
          azp: clientId,
          sub: `sub-${createHash('sha256').update(grant.user.email).digest('hex').slice(0, 12)}`,
          iat: now - 5,
          exp: fault?.expired ? now - 60 : now + 3600,
          ...(nonce !== undefined || fault?.nonce !== undefined ? { nonce: fault?.nonce ?? nonce } : {}),
          email: grant.user.email,
          email_verified: grant.user.emailVerified ?? true,
          ...(grant.user.hd ? { hd: grant.user.hd } : {}),
        },
        fault?.signature ? stranger.privateKey : key.privateKey
      )
      secrets.add(idToken)
      answer.id_token = idToken
    }
    return answer
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    const route = url.pathname
    if (req.method === 'GET' && route === '/.well-known/openid-configuration')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/o/oauth2/v2/auth`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
        jwks_uri: `${base}/oauth2/v3/certs`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['plain', 'S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
      })
    if (req.method === 'GET' && route === '/oauth2/v3/certs')
      return json(res, 200, { keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })
    if (req.method === 'POST' && route === '/token') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
      tokenRequests.push(form)
      for (const k of ['code', 'code_verifier', 'refresh_token']) if (form[k]) secrets.add(form[k] as string)
      if (form.client_id !== clientId || form.client_secret !== clientSecret)
        return json(res, 401, { error: 'invalid_client' })
      // Google issues tokens for its own interfaces: a resource is no part of its requests
      if (form.resource !== undefined) return json(res, 400, { error: 'invalid_request' })
      if (form.grant_type === 'authorization_code') {
        const code = codes.get(form.code ?? '')
        if (!code || code.used) return json(res, 400, { error: 'invalid_grant' })
        code.used = true
        const expected = createHash('sha256')
          .update(form.code_verifier ?? '')
          .digest('base64url')
        if (expected !== code.challenge || form.redirect_uri !== code.redirectUri)
          return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, issue(code.grant, code.nonce, true))
      }
      if (form.grant_type === 'refresh_token') {
        const grant = refreshTokens.get(form.refresh_token ?? '')
        if (!grant?.live) return json(res, 400, { error: 'invalid_grant' })
        // Google keeps its refresh token, and answers no ID token to a refresh
        const { id_token: _none, ...answer } = issue(
          { ...grant, scopes: grant.scopes.filter((s) => s !== 'openid') },
          undefined,
          false
        )
        answer.scope = grant.scopes.join(' ')
        tokens.set(answer.access_token as string, grant)
        return json(res, 200, answer)
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (req.method === 'POST' && route === '/revoke') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
      revocations.push(form)
      // Google revokes the whole grant of the person to the project
      const grant = refreshTokens.get(form.token ?? '') ?? tokens.get(form.token ?? '')
      if (grant) {
        grant.live = false
        granted.delete(grant.user.email)
      }
      res.writeHead(200).end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return Object.assign(fake, {
    issuer: base,
    authorize: (raw: string, user: GoogleUser, options: { untick?: string[]; deny?: boolean } = {}) => {
      const p = Object.fromEntries(new URL(raw).searchParams)
      const state = p.state ?? ''
      if (options.deny) return { error: 'access_denied', state }
      if (
        p.response_type !== 'code' ||
        p.client_id !== clientId ||
        !p.code_challenge ||
        p.code_challenge_method !== 'S256'
      )
        return { error: 'invalid_request', state }
      const asked = (p.scope ?? '').split(' ').filter(Boolean)
      const now = asked.filter((s) => !(options.untick ?? []).includes(s))
      const before = p.include_granted_scopes === 'true' ? [...(granted.get(user.email) ?? [])] : []
      const scopes = [...new Set([...before, ...now])]
      granted.set(user.email, new Set(scopes))
      const code = `4/${randomBytes(12).toString('hex')}`
      secrets.add(code)
      codes.set(code, {
        grant: { user, scopes, live: true },
        challenge: p.code_challenge,
        redirectUri: p.redirect_uri ?? '',
        ...(p.nonce ? { nonce: p.nonce } : {}),
        used: false,
      })
      return { code, state }
    },
    tokenInfo: (token: string) => {
      const grant = tokens.get(token)
      return grant?.live ? grant : undefined
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  })
}

export interface FakeConnector {
  url: string
  /** the authorization servers its Protected Resource Metadata names: a test moves them */
  authorizationServers: string[]
  /** every Authorization header that reached it, valid or not */
  authorizations: (string | undefined)[]
  /** every header of every request that reached it, by lower-case name: what the agent sends of an account */
  headers: Record<string, string | string[] | undefined>[]
  /** the provider of Files and Calendar behind it */
  provider: FakeProvider
  close(): Promise<void>
}

/**
 * A fake of the deployment's Google connector (D118, TOOL-OAUTH-018): Protected Resource Metadata that names the fake
 * Google, a `401` with `resource_metadata` to a request without a valid token, a `403 insufficient_scope` to a call whose
 * token lacks the tool's scope, and the fake provider of Files 1.0 and Calendar 1.0 for the rest.
 */
export async function fakeConnector(google: FakeGoogle, scopes: Record<string, string[]>): Promise<FakeConnector> {
  // Google Drive declares team roots, shared drives with managers, to an account of a Workspace (providers.md §6)
  const provider = await fakeProvider({
    files: {
      version: '1.0',
      capabilities: ['search', 'folders', 'trash', 'share', 'team-roots'],
      'team-roots': { manager: true },
    },
    calendar: { version: '1.0', capabilities: ['free-busy', 'respond', 'attendees'] },
  })
  const fake = { authorizations: [], headers: [], provider } as unknown as FakeConnector
  let base = ''
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: fake.authorizationServers })
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    fake.authorizations.push(req.headers.authorization)
    fake.headers.push({ ...req.headers })
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const grant = token ? google.tokenInfo(token) : undefined
    const body = await readBody(req)
    if (!grant) {
      const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
      res.writeHead(401, { 'www-authenticate': token ? `${challenge}, error="invalid_token"` : challenge }).end()
      return
    }
    const parsed = JSON.parse(body || 'null') as { method?: string; params?: { name?: string } } | null
    const needs = parsed?.method === 'tools/call' ? (scopes[parsed.params?.name ?? ''] ?? []) : []
    const lacking = needs.filter((s) => !grant.scopes.includes(s))
    if (lacking.length) {
      res
        .writeHead(403, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${lacking.join(' ')}"` })
        .end()
      return
    }
    // the token is for Google: the connector passes the call on, and no header of the account goes further here
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: String(req.headers.accept ?? ''),
    }
    if (req.headers['mcp-protocol-version'])
      headers['mcp-protocol-version'] = String(req.headers['mcp-protocol-version'])
    if (req.headers['mcp-session-id']) headers['mcp-session-id'] = String(req.headers['mcp-session-id'])
    headers['ayni-dav-username'] = grant.user.email.split('@')[0] as string
    const answer = await fetch(provider.url, { method: req.method ?? 'POST', headers, body: body || undefined })
    const out: Record<string, string> = {}
    answer.headers.forEach((value, name) => {
      if (name !== 'content-length' && name !== 'transfer-encoding') out[name] = value
    })
    res.writeHead(answer.status, out)
    res.end(Buffer.from(await answer.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return Object.assign(fake, {
    url: `${base}/mcp`,
    authorizationServers: [google.issuer],
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await provider.close()
    },
  })
}
