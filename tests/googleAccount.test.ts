/**
 * A Google Workspace account, each person with their own sign-in (ayni-spec D118, architecture §10.10), over the real
 * agent (in-memory store, a scripted model, a stubbed phone), driven through the AG-UI profile 3.5, against a fake of
 * Google's authorization server and a fake of the deployment's Google connector on the loopback: never Google, and no
 * client registered anywhere. TOOL-CAT-020, TOOL-CAT-021, TOOL-OAUTH-012 to 016, TOOL-OAUTH-018, TOOL-CONN-006,
 * TOOL-CONN-007, TOOL-CONN-010, TOOL-CONN-011, TOOL-CONN-015, TOOL-CONN-016, PROF-TOOL-020, PROF-TOOL-028, PROF-TOOL-029.
 *
 * The whole file runs with a debug logger: no token, code, verifier, nonce or ID token may reach it.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTIVITY, CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { Principal } from '../src/core/types.js'
import { mintLocally } from './directoryFixtures.js'
import {
  CALENDAR_TOOLS,
  DRIVE_TOOLS,
  type FakeConnector,
  type FakeGoogle,
  fakeConnector,
  fakeGoogle,
  type GoogleUser,
  googleSources,
  type IdTokenFault,
  SCOPES,
} from './googleFixtures.js'
import { parseSse, testEnv } from './helpers.js'
import { type Doc, type FakeMcp, fakeMcpServer, phone, type ScriptedModel, scripted, until } from './toolFixtures.js'

const APP_LINK_BASE = 'https://app.dev.ayni.org/app/'
const DOMAIN = 'example.org'
const ANA: GoogleUser = { email: 'ana@example.org', hd: DOMAIN }
const PEOPLE = [
  { id: 'p-ana', firstName: 'Ana', lastName: 'Rios', email: 'ana@example.org', roles: ['employee'] },
  { id: 'p-jonas', firstName: 'Jonas', lastName: 'Weber', email: 'jonas@example.org', roles: ['employee'] },
]

let running: RunningAgent
let model: ScriptedModel
let google: FakeGoogle
let otherIssuer: FakeGoogle
let connector: FakeConnector
let search: FakeMcp
const logLines: string[] = []

interface Device {
  sessionId: string
  sessionToken: string
  principal: Principal
}
let ana: Device
let jonas: Device

async function device(name: string, directoryId: string): Promise<Device> {
  const created = (
    await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      payload: { client: { name: 'ayni-ui', version: '3.5.10', platform: 'web' }, locale: 'en' },
    })
  ).json() as { sessionId: string; sessionToken: string }
  const session = await running.agent.sessions.get(created.sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const connectionId = `conn-${name}`
  const { principal } = await running.agent.onPeerConnected(
    {
      connectionType: 'verifiable-user-agent',
      actorIdentity: `did:peer:${name}`,
      backingIdentity: null,
      claims: { userName: name },
      userAgentVerified: false,
      identityCredentialRef: null,
    },
    connectionId,
    { name: 'Ayni', version: '1.0.0', platform: 'ios' }
  )
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  const updated = { ...principal, roles: ['employee'], directoryEntryId: directoryId }
  await running.agent.principals.save(updated)
  return { ...created, principal: updated }
}

async function call(d: Pick<Device, 'sessionToken'>, method: string, url: string, payload?: unknown) {
  const response = await running.app.inject({
    method: method as 'GET',
    url: `/agui/v3/sessions${url}`,
    headers: { authorization: `Bearer ${d.sessionToken}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
  return { status: response.statusCode, body: (response.body ? response.json() : {}) as Doc }
}

function run(d: Pick<Device, 'sessionId' | 'sessionToken'>, text: string) {
  return running.app.inject({
    method: 'POST',
    url: `/agui/v3/sessions/${d.sessionId}/runs`,
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: {
      threadId: d.sessionId,
      runId: `run-${Date.now()}-${Math.random()}`,
      messages: [{ id: `u-${Math.random()}`, role: 'user', content: text }],
      tools: [],
      context: [],
    },
  })
}

/** What a session's stream has received so far. */
const received = (sessionId: string) => {
  const chunks: string[] = []
  running.streams.attach(sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
  return parseSse(chunks.join('')).map((e) => e.event)
}
const connectionsEvents = (sessionId: string) =>
  received(sessionId)
    .filter((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.connectionsChanged)
    .map((e) => e.value as Doc)

const toolNames = (index = -1) => (model.requests.at(index)?.tools ?? []).map((t) => t.name)
const toolAnswers = () =>
  (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))
/** What the person's messages of a request hold: the record of the person is at the start of the latest (MEM-CTX-008). */
const personOf = (index = -1) =>
  (model.requests.at(index)?.messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => String(m.content))
    .join('\n')

const googleItem = async (d: Device) =>
  ((await call(d, 'GET', '/connections')).body.connections as Doc[]).find((c) => c.source === 'google') as Doc

/** A sign-in in the browser: the agent's start, the consent at the fake Google, the browser back at the callback. */
async function signIn(
  d: Device,
  source: string,
  user: GoogleUser,
  options: { untick?: string[]; fault?: IdTokenFault; deny?: boolean } = {}
) {
  const start = await call(d, 'POST', `/connections/${source}/authorize`, {})
  if (start.status !== 202) return { start, url: undefined, callback: undefined }
  const url = new URL(start.body.authorizationUrl as string)
  google.fault = options.fault
  const answer = google.authorize(url.toString(), user, { untick: options.untick, deny: options.deny })
  const q = new URLSearchParams()
  if (answer.code) q.set('code', answer.code)
  if (answer.error) q.set('error', answer.error)
  q.set('state', answer.state)
  const callback = await running.app.inject({ method: 'GET', url: `/tools/oauth/callback?${q}` })
  return { start, url, callback }
}

const lastOutcome = (d: Device) =>
  connectionsEvents(d.sessionId)
    .filter((e) => e.outcome)
    .at(-1)

function googlePack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ayni-google-'))
  cpSync('agent-packs/dev/knowledge', join(dir, 'knowledge'), { recursive: true })
  const directoryFile = join(dir, 'directory.yaml')
  writeFileSync(directoryFile, stringifyYaml({ people: PEOPLE }))
  const pack = parseYaml(readFileSync('agent-packs/dev/agent-pack.yaml', 'utf8')) as Doc
  pack.identity.directory = { file: directoryFile }
  const bundled = Object.fromEntries(
    Object.entries(pack.tools.sources as Doc).filter(([, source]) => (source as Doc).type === 'bundled')
  )
  pack.tools = {
    features: { search: { title: 'Web search' } },
    sources: {
      ...bundled,
      // a server of the agent's own account beside the Google sources: a person's Google token never reaches it
      websearch: {
        type: 'mcp',
        feature: 'search',
        title: 'Web search',
        transport: 'streamable-http',
        url: search.url,
        account: { kind: 'agent' },
        availability: 'agent',
        offer: ['search'],
        access: { roles: { employee: ['*'] } },
      },
    },
  }
  googleSources(pack, { url: connector.url, issuer: google.issuer, domain: DOMAIN })
  pack.spaces.templates = (pack.spaces.templates as Doc[]).map((t) => ({ ...t, features: [] }))
  writeFileSync(join(dir, 'agent-pack.yaml'), stringifyYaml(pack))
  return dir
}

beforeAll(async () => {
  google = await fakeGoogle()
  otherIssuer = await fakeGoogle()
  connector = await fakeConnector(google, { ...DRIVE_TOOLS, ...CALENDAR_TOOLS })
  search = await fakeMcpServer([{ name: 'search', annotations: { readOnlyHint: true } }])
  process.env.TOOLS_GOOGLE_CLIENT_ID = google.clientId
  process.env.TOOLS_GOOGLE_CLIENT_SECRET = google.clientSecret
  const logger = pino({ level: 'debug' }, { write: (line: string) => void logLines.push(line) })
  running = await buildAgent(
    testEnv({ agentPackPath: googlePack(), logLevel: 'debug', appLinkBase: APP_LINK_BASE, directoryPollSeconds: 3600 }),
    logger,
    { drainMs: 200 }
  )
  mintLocally(running)
  phone(running)
  model = scripted(running)
  ana = await device('ana', 'p-ana')
  jonas = await device('jonas', 'p-jonas')
}, 30_000)

afterAll(async () => {
  await running?.stop()
  for (const fake of [google, otherIssuer, connector, search]) await fake?.close()
  delete process.env.TOOLS_GOOGLE_CLIENT_ID
  delete process.env.TOOLS_GOOGLE_CLIENT_SECRET
})

describe('one Google account for Google Drive and Google Calendar (TOOL-CONN-015, PROF-TOOL-028)', () => {
  it('lists the account once, under its id and title, with each of its sources not allowed', async () => {
    const list = (await call(ana, 'GET', '/connections')).body.connections as Doc[]
    expect(list.map((c) => c.source)).toEqual(['google'])
    expect(list[0]).toMatchObject({
      source: 'google',
      title: 'Google',
      description: 'Your files and your calendar at Google, with your own rights there',
      method: 'oauth',
      binding: null,
      usedIn: [{ kind: 'personal' }],
      state: 'not-connected',
      account: null,
      features: [
        { id: 'files', title: 'Files' },
        { id: 'calendar', title: 'Calendar' },
      ],
      access: [
        { source: 'drive', title: 'Google Drive', allowed: 'none' },
        { source: 'calendar', title: 'Google Calendar', allowed: 'none' },
      ],
    })
  })

  it('tells the model of each source of the account, not connected, and offers the card of the account', async () => {
    model.script = [{ calls: [{ name: 'offer_connection', arguments: { source: 'calendar' } }] }, { text: 'Connect.' }]
    const response = await run(ana, 'what do I have tomorrow?')
    expect(response.statusCode).toBe(200)
    expect(personOf(0)).toContain(
      'Accounts this person can connect, with the tool offer_connection:\n- drive: Google Drive, The files you can open in Google Drive (not connected)\n- calendar: Google Calendar, Your calendars and events at Google (not connected)'
    )
    const card = parseSse(response.body)
      .map((e) => e.event)
      .find((e) => e.type === 'ACTIVITY_SNAPSHOT' && e.activityType === ACTIVITY.connect)?.content as Doc
    expect(card).toEqual({
      source: 'google',
      title: 'Google',
      description: 'Your files and your calendar at Google, with your own rights there',
      method: 'oauth',
      why: 'connect',
      feature: { id: 'calendar', title: 'Calendar' },
    })
  })
})

describe('allowing Google Drive, in part (TOOL-OAUTH-012 to 014, TOOL-OAUTH-016, TOOL-CONN-016)', () => {
  it("asks Google for Drive's scopes with openid and email, the agent-pack's parameters, the hint and the domain", async () => {
    const start = await call(ana, 'POST', '/connections/drive/authorize', {})
    expect(start.status).toBe(202)
    const url = new URL(start.body.authorizationUrl as string)
    const p = Object.fromEntries(url.searchParams)
    expect(url.origin).toBe(google.issuer)
    expect(p.scope?.split(' ')).toEqual(['openid', 'email', SCOPES.driveRead, SCOPES.drive])
    expect(p).toMatchObject({
      response_type: 'code',
      client_id: google.clientId,
      redirect_uri: 'http://agent.test/tools/oauth/callback',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      login_hint: 'ana@example.org',
      hd: DOMAIN,
    })
    // no resource: Google issues its tokens for its own interfaces (TOOL-CAT-021)
    expect(p.resource).toBeUndefined()
    // a nonce of at least 128 bits, kept sealed in the attempt, never in the clear
    expect(p.nonce?.length).toBeGreaterThanOrEqual(22)
    const attempt = await running.agent.store.oauthAttempts.get(start.body.attemptId as string)
    expect(attempt).toMatchObject({ sourceId: 'google', allow: ['drive'], scopes: p.scope?.split(' ') })
    expect(attempt?.nonceCipher).toBeTruthy()
    expect(JSON.stringify(attempt)).not.toContain(p.nonce)
    await call(ana, 'DELETE', `/connections/attempts/${start.body.attemptId}`)
  })

  it('connects with the scopes granted when Ana unticks drive, and gives the model the reads only', async () => {
    const { callback } = await signIn(ana, 'drive', ANA, { untick: [SCOPES.drive] })
    expect(callback?.statusCode).toBe(303)
    expect(callback?.headers.location).toMatch(/^https:\/\/app\.dev\.ayni\.org\/app\/service\/.+\/accounts$/)
    expect(lastOutcome(ana)).toMatchObject({
      source: 'google',
      outcome: 'connected',
      state: 'connected',
      label: 'ana@example.org',
    })
    const item = await googleItem(ana)
    expect(item).toMatchObject({
      state: 'connected',
      account: { label: 'ana@example.org' },
      revokesAtSource: true,
      access: [
        {
          source: 'drive',
          title: 'Google Drive',
          allowed: 'some',
          missing: ['Create a file', "Replace a file's content"],
        },
        { source: 'calendar', title: 'Google Calendar', allowed: 'none' },
      ],
    })
    // the scopes granted are sealed with the account, never in the clear (TOOL-ACCESS-009)
    const [record] = await running.agent.store.personalAccounts.listByPrincipal(ana.principal.id)
    expect(record?.sourceId).toBe('google')
    expect(JSON.stringify(record)).not.toContain('drive.readonly')
    model.script = [{ text: 'Here are your files.' }]
    await run(ana, 'which files do I have?')
    const names = toolNames()
    expect(names).toEqual(
      expect.arrayContaining(['files_roots', 'files_list', 'files_get', 'files_read', 'files_search'])
    )
    expect(names).not.toContain('files_create')
    expect(names).not.toContain('files_replace')
    expect(names.filter((n) => n.startsWith('calendar_'))).toEqual([])
    expect(personOf()).toContain(
      "- drive: Google Drive, The files you can open in Google Drive (allowed in part: Create a file, Replace a file's content)\n- calendar: Google Calendar, Your calendars and events at Google (not allowed)"
    )
  })

  it('reads the connector with the access token alone, and sends it to no other server (TOOL-OAUTH-015, 018)', async () => {
    model.script = [{ calls: [{ name: 'files_roots', arguments: { query: '/Projects' } }] }, { text: 'Two folders.' }]
    await run(ana, 'which folders?')
    expect(JSON.parse(toolAnswers().at(-1) ?? '{}').roots).toHaveLength(2)
    expect(connector.provider.calls.at(-1)).toMatchObject({ name: 'files_roots', args: { query: '/Projects' } })
    const bearer = connector.authorizations.filter((a) => a?.startsWith('Bearer ya29.'))
    expect(bearer.length).toBeGreaterThan(0)
    // nothing of the account but its access token reaches the connector: no refresh token, ID token or client secret
    const sent = JSON.stringify(connector.headers)
    for (const secret of google.secrets)
      if (!secret.startsWith('ya29.')) expect(sent.includes(secret), 'a secret of the account').toBe(false)
    expect(sent).not.toContain(google.clientSecret)
    // the agent's own server beside it never sees a Google token
    expect(search.authorizations.some((a) => a?.includes('ya29.'))).toBe(false)
    expect(otherIssuer.tokenRequests).toHaveLength(0)
  })

  it('offers the card that allows the rest of a source, why: allow, the source of the account', async () => {
    model.script = [{ calls: [{ name: 'offer_connection', arguments: { source: 'calendar' } }] }, { text: 'Allow it.' }]
    const response = await run(ana, 'add a meeting tomorrow')
    const card = parseSse(response.body)
      .map((e) => e.event)
      .find((e) => e.type === 'ACTIVITY_SNAPSHOT' && e.activityType === ACTIVITY.connect)?.content as Doc
    expect(card).toEqual({
      source: 'google',
      title: 'Google',
      description: 'Your files and your calendar at Google, with your own rights there',
      method: 'oauth',
      why: 'allow',
      allow: { source: 'calendar', title: 'Google Calendar' },
      feature: { id: 'calendar', title: 'Calendar' },
    })
  })
})

describe('allowing Google Calendar next (TOOL-OAUTH-012, TOOL-CONN-015, PROF-TOOL-029)', () => {
  it("asks for Calendar's scopes only, with include_granted_scopes, and adds them to the same account", async () => {
    const before = (await googleItem(ana)).account as Doc
    const events = connectionsEvents(ana.sessionId).length
    const { url, callback } = await signIn(ana, 'calendar', ANA)
    expect(callback?.statusCode).toBe(303)
    const asked = url?.searchParams.get('scope')?.split(' ') ?? []
    expect(asked.slice(0, 2)).toEqual(['openid', 'email'])
    expect(asked.slice(2).sort()).toEqual([SCOPES.calendarList, SCOPES.events, SCOPES.freeBusy, SCOPES.eventsRead])
    expect(url?.searchParams.get('include_granted_scopes')).toBe('true')
    const item = await googleItem(ana)
    // connects nothing new: the same account, Calendar allowed, Drive as it was
    expect(item.account).toMatchObject({ id: before.id, connectedAt: before.connectedAt })
    expect(item.access).toEqual([
      {
        source: 'drive',
        title: 'Google Drive',
        allowed: 'some',
        missing: ['Create a file', "Replace a file's content"],
      },
      { source: 'calendar', title: 'Google Calendar', allowed: 'all' },
    ])
    expect(connectionsEvents(ana.sessionId).length).toBeGreaterThan(events)
    model.script = [{ text: 'Your calendar.' }]
    await run(ana, 'what do I have tomorrow?')
    expect(toolNames()).toEqual(expect.arrayContaining(Object.keys(CALENDAR_TOOLS)))
    expect(personOf()).not.toContain('- calendar: Google Calendar, Your calendars')
  })

  it("asks, from the account's own id, for the scopes of every source not yet allowed", async () => {
    const start = await call(ana, 'POST', '/connections/google/authorize', {})
    expect(start.status).toBe(202)
    expect(new URL(start.body.authorizationUrl as string).searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'email',
      SCOPES.drive,
    ])
    expect((await running.agent.store.oauthAttempts.get(start.body.attemptId as string))?.allow).toEqual(['drive'])
    await call(ana, 'DELETE', `/connections/attempts/${start.body.attemptId}`)
    // a source that is not one of an account's: not found
    expect((await call(ana, 'POST', '/connections/websearch/authorize', {})).status).toBe(404)
  })
})

describe('the check by the ID token, one bad case at a time (TOOL-OAUTH-016)', () => {
  const cases: [string, { fault?: IdTokenFault; user?: GoogleUser }, 'failed' | 'wrong-person'][] = [
    ['a signature by a key the issuer does not publish', { fault: { signature: true } }, 'failed'],
    ['another issuer', { fault: { iss: 'https://accounts.example.net' } }, 'failed'],
    ['another audience', { fault: { aud: 'someone-elses-client' } }, 'failed'],
    ['an expiry passed', { fault: { expired: true } }, 'failed'],
    ['another nonce', { fault: { nonce: 'not-the-attempts-nonce' } }, 'failed'],
    ['no ID token in the answer', { fault: { missing: true } }, 'failed'],
    [
      'an email not verified',
      { user: { email: 'jonas@example.org', hd: DOMAIN, emailVerified: false } },
      'wrong-person',
    ],
    ['a Google address of his own', { user: { email: 'jonas.private@example.com' } }, 'wrong-person'],
    ['his email, at another domain', { user: { email: 'jonas@example.org', hd: 'example.net' } }, 'wrong-person'],
  ]
  for (const [what, setup, outcome] of cases)
    it(`ends Jonas's sign-in with ${what} as ${outcome}, keeps nothing and revokes the tokens`, async () => {
      const revoked = google.revocations.length
      const { callback } = await signIn(jonas, 'drive', setup.user ?? { email: 'jonas@example.org', hd: DOMAIN }, {
        ...(setup.fault ? { fault: setup.fault } : {}),
      })
      expect(callback?.statusCode).toBe(303)
      expect(lastOutcome(jonas)).toMatchObject({ source: 'google', outcome, state: 'not-connected' })
      expect(await running.agent.store.personalAccounts.listByPrincipal(jonas.principal.id)).toEqual([])
      // revoked at Google, the refresh token first
      expect(google.revocations.length).toBeGreaterThan(revoked)
      expect(google.revocations[revoked]?.token_type_hint).toBe('refresh_token')
      expect((await googleItem(jonas)).state).toBe('not-connected')
    })

  it('connects Jonas once the ID token is his, signed, for this client and this attempt', async () => {
    const { callback } = await signIn(jonas, 'drive', { email: 'Jonas@Example.org', hd: DOMAIN })
    expect(callback?.statusCode).toBe(303)
    expect(lastOutcome(jonas)).toMatchObject({ outcome: 'connected', label: 'jonas@example.org' })
  })
})

describe('the life of the account (TOOL-OAUTH-015, TOOL-CONN-006)', () => {
  it("turns the account to reconnect for both sources when a source's server names another issuer", async () => {
    connector.authorizationServers = [otherIssuer.issuer]
    const discoveries = () =>
      (running.agent.connections as unknown as { discoveries: Map<string, unknown> }).discoveries
    discoveries().clear()
    try {
      model.script = [{ calls: [{ name: 'files_roots', arguments: {} }] }, { text: 'No.' }]
      const before = otherIssuer.tokenRequests.length
      await run(jonas, 'my folders')
      const item = await googleItem(jonas)
      expect(item).toMatchObject({ state: 'reconnect', reason: 'changed' })
      expect(item.access).toEqual([
        { source: 'drive', title: 'Google Drive', allowed: 'none' },
        { source: 'calendar', title: 'Google Calendar', allowed: 'none' },
      ])
      expect(otherIssuer.tokenRequests.length).toBe(before)
    } finally {
      connector.authorizationServers = [google.issuer]
      discoveries().clear()
    }
  })

  it('disconnects the account for both sources at once, revoked at Google', async () => {
    const item = await googleItem(ana)
    const revoked = google.revocations.length
    const answer = await call(ana, 'DELETE', `/connections/accounts/${(item.account as Doc).id}`)
    expect(answer.status).toBe(200)
    expect(answer.body.connection).toMatchObject({
      source: 'google',
      state: 'not-connected',
      account: null,
      access: [
        { source: 'drive', title: 'Google Drive', allowed: 'none' },
        { source: 'calendar', title: 'Google Calendar', allowed: 'none' },
      ],
    })
    expect(google.revocations.slice(revoked).map((r) => r.token_type_hint)).toEqual(['refresh_token', 'access_token'])
    expect(await running.agent.store.personalAccounts.listByPrincipal(ana.principal.id)).toEqual([])
    await until(() => connectionsEvents(ana.sessionId).some((e) => e.outcome === 'disconnected'))
    model.script = [{ text: 'Gone.' }]
    await run(ana, 'my files')
    expect(toolNames().filter((n) => n.startsWith('files_') || n.startsWith('calendar_'))).toEqual([])
  })

  it('wrote nothing of a token, a code, a nonce or an ID token to its log', () => {
    const log = logLines.join('\n')
    for (const secret of google.secrets) expect(log.includes(secret), 'a secret in the log').toBe(false)
    expect(log).not.toContain(google.clientSecret)
  })
})
