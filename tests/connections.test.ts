/**
 * Tools, phase 2, over the real agent (in-memory store, a scripted model, a stubbed phone), driven through the AG-UI
 * profile 3.5, against a fake authorization server and fake MCP servers on the loopback (ayni-spec D104 to D110):
 * TOOL-ACCESS-008..014, TOOL-OAUTH-001..010, TOOL-CONN-001..014, TOOL-SPACE-012/013, TOOL-CALL-011, TOOL-AVAIL-007,
 * PRIV-ERASE-013, PROF-TOOL-014..021, PROF-DESC-010, PROF-LINK-004, PROF-STREAM-011, PROF-HIST-013.
 *
 * The whole file runs with a debug logger: no token, code, verifier or pasted credential may reach it.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTIVITY, CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildAgent, type RunningAgent } from '../src/app.js'
import { sharedEntryToMessages } from '../src/channels/agui/mapping.js'
import type { ConnectionService } from '../src/core/connections.js'
import type { ApprovalRecord, MessageEntry, PersonalAccountRecord, Principal } from '../src/core/types.js'
import { createEntryCrypto, openUnder } from '../src/memory/crypto.js'
import {
  callbackQuery,
  type FakeAs,
  type FakeOAuthMcp,
  fakeAuthServer,
  fakeOAuthMcp,
  githubTools,
  type Identity,
  relaticleTools,
} from './connectionFixtures.js'
import { parseSse, testEnv } from './helpers.js'
import {
  type Doc,
  type FakeHttp,
  fakeHttpTool,
  type Phone,
  phone,
  type ScriptedModel,
  scripted,
  until,
} from './toolFixtures.js'

const APP_LINK_BASE = 'https://app.dev.ayni.org/app/'
const GH_CLIENT_ID = 'Iv1.ghClientOfTests'
const GH_CLIENT_SECRET = 'ghClientSecretOfTests0001'
const TASKS_TOKEN = `tt_${'a1'.repeat(16)}`
const PASTED = `ghp_${'Z9y8X7w6V5u4T3s2R1q0'}${'P9o8N7m6L5k4J3i2H1g0'.slice(0, 16)}`

let running: RunningAgent
let model: ScriptedModel
let ph: Phone
let crmAs: FakeAs
let crm: FakeOAuthMcp
let ghAs: FakeAs
let gh: FakeOAuthMcp
let otherAs: FakeAs
let docAs: FakeAs
let docMcp: FakeOAuthMcp
let noDocAs: FakeAs
let noDocMcp: FakeOAuthMcp
let tasks: FakeHttp
let directoryFile: string
/** What the agent logs, at debug, over this whole file: no token, code or verifier may be in it (TOOL-ACCESS-010). */
const logLines: string[] = []
const crypto = createEntryCrypto(Buffer.alloc(32, 7))

const PEOPLE = [
  { id: 'p-ana', firstName: 'Ana', lastName: 'Rios', email: 'ana@2060.io', roles: ['employee'] },
  { id: 'p-jonas', firstName: 'Jonas', lastName: 'Weber', email: 'jonas@2060.io', roles: ['employee', 'manager'] },
]

interface Device {
  sessionId: string
  sessionToken: string
  principal: Principal
  connectionId: string
}

let ana: Device
let jonas: Device
let dina: Device
let salesEu: { id: string }
let testRepo: { id: string }

const web = (profileVersion: string | null = '3.5') => ({
  name: 'ayni-ui',
  version: '3.5.0',
  platform: 'web',
  ...(profileVersion ? { profileVersion } : {}),
})

function mintLocally(agent: RunningAgent): void {
  const minter = agent.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
  minter.minter = {
    mint: async (id: string) => ({
      invitationId: `inv-${id}`,
      outOfBandId: `oob-${id}`,
      url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
    }),
  }
}

async function device(name: string, roles: string[], directoryId?: string, profileVersion = '3.5'): Promise<Device> {
  const created = (
    await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      payload: { client: web(profileVersion), locale: 'en' },
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
  await ph.flowCapable(connectionId)
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  const updated = { ...principal, roles, ...(directoryId ? { directoryEntryId: directoryId } : {}) }
  await running.agent.principals.save(updated)
  return { ...created, principal: updated, connectionId }
}

async function open(
  d: Pick<Device, 'sessionToken' | 'principal' | 'connectionId'>,
  options: { spaceId?: string; conversationId?: string; profileVersion?: string | null }
): Promise<Device> {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: {
      client: web(options.profileVersion === undefined ? '3.5' : options.profileVersion),
      locale: 'en',
      ...(options.conversationId
        ? { conversationId: options.conversationId }
        : { newConversation: true, ...(options.spaceId ? { spaceId: options.spaceId } : {}) }),
    },
  })
  if (response.statusCode !== 201) throw new Error(`session ${response.statusCode}: ${response.body}`)
  const body = response.json() as { sessionId: string; sessionToken: string }
  return { ...body, principal: d.principal, connectionId: d.connectionId }
}

async function call(d: Pick<Device, 'sessionToken'>, method: string, url: string, payload?: unknown) {
  const response = await running.app.inject({
    method: method as 'GET',
    url: `/agui/v3/sessions${url}`,
    headers: { authorization: `Bearer ${d.sessionToken}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
  return {
    status: response.statusCode,
    headers: response.headers,
    body: (response.body ? response.json() : {}) as Doc,
  }
}

function run(d: Pick<Device, 'sessionId' | 'sessionToken'>, text: string, ayni?: Record<string, unknown>) {
  return running.app
    .inject({
      method: 'POST',
      url: `/agui/v3/sessions/${d.sessionId}/runs`,
      headers: { authorization: `Bearer ${d.sessionToken}` },
      payload: {
        threadId: d.sessionId,
        runId: `run-${Date.now()}-${Math.random()}`,
        messages: text ? [{ id: `u-${Math.random()}`, role: 'user', content: text }] : [],
        tools: [],
        context: [],
        ...(ayni ? { forwardedProps: { ayni } } : {}),
      },
    })
    .then((response) => ({
      status: response.statusCode,
      events: response.statusCode === 200 ? parseSse(response.body).map((e) => e.event) : [],
    }))
}

const decide = (
  d: Pick<Device, 'sessionId' | 'sessionToken'>,
  approvalId: string,
  decision: 'approve' | 'reject',
  scope?: 'once' | 'conversation'
) => run(d, '', { kind: 'approval.decide', approvalId, decision, ...(scope ? { scope } : {}) })

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

async function conversationOf(sessionId: string): Promise<string> {
  return (await running.agent.sessions.get(sessionId))?.conversationId as string
}

async function pendingConfirmation(conversationId: string): Promise<ApprovalRecord> {
  let found: ApprovalRecord | undefined
  await until(async () => {
    found = (await running.agent.store.approvals.list({ status: 'PENDING' })).find(
      (r) => r.kind === 'confirmation' && r.conversationId === conversationId
    )
    return !!found
  })
  return found as ApprovalRecord
}

const toolAnswers = () =>
  (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))
const toolNames = (index = -1) => (model.requests.at(index)?.tools ?? []).map((t) => t.name)
const systemOf = (index = -1) =>
  (model.requests.at(index)?.messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content))
    .join('\n')

const connections = () => running.agent.connections as ConnectionService

async function entries(conversationId: string): Promise<MessageEntry[]> {
  const rows = await running.agent.store.entries.listAll({ conversationId, limit: 1000 })
  return rows.map((r) => running.agent.memory.open(r))
}

/** The owner sets a change, and his phone confirms it. */
async function confirmed(d: Device, request: () => Promise<{ status: number; body?: Doc }>) {
  const asked = ph.callsOf('sendConfirmRequest').length
  const response = await request()
  expect(response.status).toBe(202)
  await until(() => ph.callsOf('sendConfirmRequest').length > asked)
  await ph.confirm(d.connectionId, true)
  return response
}

/**
 * A sign-in in the browser: the agent's start, the consent at the service, the browser sent back to the agent's callback.
 */
async function signIn(
  d: Device,
  source: string,
  identity: Identity,
  options: { spaceId?: string; as?: FakeAs; deny?: boolean; iss?: string | null } = {}
) {
  const start = await call(
    d,
    'POST',
    `/connections/${source}/authorize`,
    options.spaceId ? { spaceId: options.spaceId } : {}
  )
  if (start.status !== 202) return { start, url: undefined, callback: undefined }
  const as = options.as ?? (source === 'relaticle' ? crmAs : ghAs)
  const url = new URL(start.body.authorizationUrl as string)
  const answer = as.authorize(url.toString(), identity, { deny: options.deny })
  const iss = options.iss === null ? undefined : (options.iss ?? as.issuer)
  const callback = await running.app.inject({
    method: 'GET',
    url: `/tools/oauth/callback?${callbackQuery(answer, iss)}`,
  })
  return { start, url, callback, answer }
}

const accountsOf = async (principalId: string) => running.agent.store.personalAccounts.listByPrincipal(principalId)

/** The pack of these tests: the dev pack with the sources of architecture §10.8, at the fakes. */
function connectionsPack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ayni-connections-'))
  cpSync('agent-packs/dev/knowledge', join(dir, 'knowledge'), { recursive: true })
  directoryFile = join(dir, 'directory.yaml')
  writeFileSync(directoryFile, stringifyYaml({ people: PEOPLE }))
  const pack = parseYaml(readFileSync('agent-packs/dev/agent-pack.yaml', 'utf8')) as Doc
  pack.identity.directory = { file: directoryFile }
  pack.identity.roles = { ...pack.identity.roles, dispatcher: { description: 'Dispatches the trucks.' } }
  const bundled = Object.fromEntries(
    Object.entries(pack.tools.sources as Doc).filter(([, source]) => (source as Doc).type === 'bundled')
  )
  pack.tools = {
    sources: {
      ...bundled,
      relaticle: {
        type: 'mcp',
        title: 'Relaticle CRM',
        description: "The companies, people, notes and tasks of the space's workspace",
        transport: 'streamable-http',
        url: crm.url,
        account: {
          kind: 'personal',
          oauth: { client: { registration: 'dynamic' }, bindingRequest: { parameter: 'workspace' } },
          binding: 'workspace',
          check: {
            tool: 'who-ami-tool',
            binding: { value: '/workspace/id', label: '/workspace/name' },
            email: '/user/email',
            label: '{/user/email} · {/workspace/name}',
          },
        },
        availability: 'spaces',
        bindings: [{ name: 'workspace', label: 'Workspace' }],
        offer: ['who-ami-tool', 'list-companies-tool', 'create-note-tool', 'echo-auth', 'export-files'],
        access: { roles: { employee: ['*'] } },
        tools: {
          'who-ami-tool': { effect: 'read', untrusted: false },
          'list-companies-tool': { effect: 'read', untrusted: false },
          'create-note-tool': { title: 'Add a note', effect: 'write', untrusted: false },
          'echo-auth': { effect: 'read', untrusted: false },
          'export-files': { effect: 'read', untrusted: false },
        },
      },
      github: {
        type: 'mcp',
        title: 'GitHub',
        description: 'Code, issues and pull requests in GitHub',
        transport: 'streamable-http',
        url: gh.url,
        account: {
          kind: 'personal',
          oauth: {
            client: {
              registration: 'pre-registered',
              issuer: ghAs.issuer,
              id: '$' + '{TOOLS_GITHUB_CLIENT_ID}',
              secret: '$' + '{TOOLS_GITHUB_CLIENT_SECRET}',
            },
            scopes: [],
          },
          check: { tool: 'get_me', label: '{/login}' },
          tokenPatterns: ['gh[pousr]_[A-Za-z0-9]{36,251}', 'github_pat_[A-Za-z0-9_]{22,255}'],
        },
        availability: 'personal',
        offer: ['get_me', 'list_issues', 'issue_write'],
        untrusted: false,
        access: { roles: { employee: ['*'] } },
        tools: {
          get_me: { effect: 'read' },
          list_issues: { effect: 'read' },
          issue_write: { title: 'Open or change an issue', effect: 'write' },
        },
      },
      'github-project': {
        type: 'mcp',
        title: 'GitHub repository',
        description: "The issues of the project's repository",
        transport: 'streamable-http',
        url: gh.url,
        account: { kind: 'personal', from: 'github' },
        availability: 'spaces',
        offer: ['list_issues', 'issue_write'],
        bindings: [
          { name: 'owner', label: 'Organization', argument: 'owner', pattern: '^[A-Za-z0-9-]{1,39}$' },
          { name: 'repo', label: 'Repository', argument: 'repo', pattern: '^[A-Za-z0-9._-]{1,100}$' },
        ],
        untrusted: false,
        access: { roles: { employee: ['*'] } },
        tools: {
          list_issues: { effect: 'read' },
          // its space's owner approves it: what runs once approved runs with the requester's own account (TOOL-CALL-011)
          issue_write: { title: 'Open or change an issue', effect: 'write', call: 'approval' },
        },
      },
      my_tasks: {
        type: 'http',
        title: 'My tasks',
        description: 'Lists your open tasks in the task tracker',
        method: 'GET',
        url: `${tasks.url}/echo/tasks`,
        parameters: { type: 'object', properties: {} },
        account: {
          kind: 'personal',
          fields: [{ name: 'token', label: 'API token', pattern: '^tt_[A-Za-z0-9]{32}$' }],
          apply: [{ header: 'Authorization', value: 'Bearer {token}' }],
          tokenPatterns: ['tt_[A-Za-z0-9]{32}'],
        },
        availability: 'personal',
        access: { roles: { employee: ['my_tasks'] } },
        tools: { my_tasks: { effect: 'read' } },
      },
      // a source of a client ID metadata document, and one whose server takes none: for a manager only
      docs: {
        type: 'mcp',
        title: 'Docs',
        transport: 'streamable-http',
        url: docMcp.url,
        account: { kind: 'personal', oauth: { client: { registration: 'metadata-document' } } },
        availability: 'personal',
        access: { roles: { manager: ['*'] } },
      },
      nodocs: {
        type: 'mcp',
        title: 'No docs',
        transport: 'streamable-http',
        url: noDocMcp.url,
        account: { kind: 'personal', oauth: { client: { registration: 'metadata-document' } } },
        availability: 'personal',
        access: { roles: { manager: ['*'] } },
      },
    },
  }
  pack.spaces.templates = [
    {
      id: 'sales',
      title: 'Sales',
      kind: 'team',
      creators: ['manager'],
      membership: { mode: 'list' },
      rules: { allowedProviders: { default: ['stub'] }, handover: { default: true } },
      tools: [{ source: 'relaticle', add: 'auto' }],
    },
    {
      id: 'project',
      title: 'Project',
      kind: 'team',
      creators: ['manager'],
      membership: { mode: 'list' },
      rules: { allowedProviders: { default: ['stub'] } },
      tools: [{ source: 'github-project', add: 'auto' }],
    },
  ]
  writeFileSync(join(dir, 'agent-pack.yaml'), stringifyYaml(pack))
  return dir
}

const addMember = async (spaceId: string, principalId: string) => {
  const now = new Date().toISOString()
  await running.agent.store.spaceMembers.save({
    id: `mem_${spaceId}_${principalId}`,
    spaceId,
    principalId,
    state: 'active',
    role: 'member',
    createdAt: now,
    updatedAt: now,
  })
}

beforeAll(async () => {
  crmAs = await fakeAuthServer({ registration: true, revocation: true, issSupported: true })
  crm = await fakeOAuthMcp(crmAs, relaticleTools())
  ghAs = await fakeAuthServer({ issuerPath: '/login/oauth', client: { id: GH_CLIENT_ID, secret: GH_CLIENT_SECRET } })
  gh = await fakeOAuthMcp(ghAs, githubTools())
  otherAs = await fakeAuthServer({ registration: true })
  docAs = await fakeAuthServer({ metadataDocument: true, scopesSupported: ['mcp:use', 'offline_access'] })
  docMcp = await fakeOAuthMcp(docAs, [])
  noDocAs = await fakeAuthServer({ registration: true })
  noDocMcp = await fakeOAuthMcp(noDocAs, [])
  tasks = await fakeHttpTool()
  process.env.TOOLS_GITHUB_CLIENT_ID = GH_CLIENT_ID
  process.env.TOOLS_GITHUB_CLIENT_SECRET = GH_CLIENT_SECRET
  const pack = connectionsPack()
  const logger = pino({ level: 'debug' }, { write: (line: string) => void logLines.push(line) })
  running = await buildAgent(
    testEnv({ agentPackPath: pack, logLevel: 'debug', appLinkBase: APP_LINK_BASE, directoryPollSeconds: 3600 }),
    logger,
    { drainMs: 200 }
  )
  mintLocally(running)
  ph = phone(running)
  model = scripted(running)
  ana = await device('ana', ['employee'], 'p-ana')
  jonas = await device('jonas', ['employee', 'manager'], 'p-jonas')
  dina = await device('dina', ['dispatcher'])
}, 30_000)

afterAll(async () => {
  await running?.stop()
  for (const fake of [crm, crmAs, gh, ghAs, otherAs, docAs, docMcp, noDocAs, noDocMcp, tasks]) await fake?.close()
  delete process.env.TOOLS_GITHUB_CLIENT_ID
  delete process.env.TOOLS_GITHUB_CLIENT_SECRET
})

describe('the descriptor and the public paths (PROF-DESC-010, TOOL-OAUTH-004, PROF-ERR-003)', () => {
  it('declares profile 3.5 and features.connections, with a personal source in the agent-pack', async () => {
    const descriptor = (await running.app.inject({ method: 'GET', url: '/.well-known/ayni-agent.json' })).json()
    expect(descriptor.profileVersion).toBe('3.5')
    expect(descriptor.features).toMatchObject({ tools: true, connections: true })
  })

  it('serves the client ID metadata document of a public client of its callback, with cache headers', async () => {
    const response = await running.app.inject({ method: 'GET', url: '/tools/oauth/client-metadata.json' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('public, max-age=3600')
    expect(response.json()).toEqual({
      client_id: 'http://agent.test/tools/oauth/client-metadata.json',
      client_name: running.agent.pack.metadata.displayName,
      client_uri: 'http://agent.test',
      redirect_uris: ['http://agent.test/tools/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  })

  it('answers a callback of no attempt with a page to start again, stored nowhere, changing nothing', async () => {
    const response = await running.app.inject({ method: 'GET', url: '/tools/oauth/callback?code=x&state=unknown' })
    expect(response.statusCode).toBe(400)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toContain('This sign-in has expired')
    expect(crmAs.tokenRequests).toHaveLength(0)
  })

  it('answers Your accounts with no-store (PROF-ERR-003)', async () => {
    const response = await call(ana, 'GET', '/connections')
    expect(response.headers['cache-control']).toBe('no-store')
  })
})

describe('Your accounts (TOOL-CONN-001, PROF-TOOL-014)', () => {
  it("lists to Ana GitHub of Personal and her task tracker's fields, to a dispatcher nothing", async () => {
    const listed = (await call(ana, 'GET', '/connections')).body.connections as Doc[]
    expect(listed.map((c) => c.source)).toEqual(['github', 'my_tasks'])
    expect(listed[0]).toEqual({
      source: 'github',
      title: 'GitHub',
      description: 'Code, issues and pull requests in GitHub',
      method: 'oauth',
      binding: null,
      usedIn: [{ kind: 'personal' }],
      state: 'not-connected',
      reason: null,
      moreAccess: false,
      account: null,
      attempt: null,
      revokesAtSource: false,
    })
    expect(listed[1]).toMatchObject({
      source: 'my_tasks',
      method: 'fields',
      fields: [{ name: 'token', label: 'API token', pattern: '^tt_[A-Za-z0-9]{32}$' }],
    })
    expect((await call(dina, 'GET', '/connections')).body).toEqual({ connections: [] })
    // nor can she start one: 404, as for a source that is not hers (TOOL-CONN-004)
    expect((await call(dina, 'POST', '/connections/github/authorize', {})).status).toBe(404)
    expect((await call(dina, 'POST', '/connections/relaticle/authorize', {})).status).toBe(404)
    expect((await call(dina, 'PUT', '/connections/my_tasks/account', { values: { token: TASKS_TOKEN } })).status).toBe(
      404
    )
  })

  it('shows a new Sales space Relaticle in setup, its workspace chosen from an account of the owner (TOOL-SPACE-012/013)', async () => {
    const created = await call(jonas, 'POST', '/spaces', { templateId: 'sales', title: 'Sales EU', purpose: 'Sell' })
    expect(created.status).toBe(201)
    salesEu = created.body as { id: string }
    await addMember(salesEu.id, ana.principal.id)
    const owner = (await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0] as Doc
    expect(owner).toMatchObject({
      source: 'relaticle',
      state: 'setup',
      account: { kind: 'personal', connected: false },
      bindings: [
        { name: 'workspace', label: 'Workspace', value: null, valueLabel: null, fromAccount: true, choices: [] },
      ],
    })
    // no space account for a person's own source (TOOL-SPACE-012)
    const put = await call(jonas, 'PUT', `/spaces/${salesEu.id}/tools/relaticle/account`, { values: { token: 'x' } })
    expect(put).toMatchObject({ status: 409, body: { error: 'no-space-account' } })
    // nobody lists it while it is not ready; a member cannot connect it yet, and a space is named
    expect(((await call(ana, 'GET', '/connections')).body.connections as Doc[]).map((c) => c.source)).not.toContain(
      'relaticle'
    )
    expect((await call(ana, 'POST', '/connections/relaticle/authorize', { spaceId: salesEu.id })).status).toBe(404)
    expect(await call(ana, 'POST', '/connections/relaticle/authorize', {})).toMatchObject({
      status: 400,
      body: { error: 'bad-request', field: 'spaceId' },
    })
  })
})

describe('OAuth as MCP defines it (TOOL-OAUTH-001..007, TOOL-CONN-004, TOOL-CONN-013, PROF-LINK-004)', () => {
  it('registers its client once, signs the owner in with PKCE and the resource, and sends the browser to Your accounts', async () => {
    const asked = ph.callsOf('sendConfirmRequest').length
    const before = received(jonas.sessionId).length
    const { start, url, callback } = await signIn(
      jonas,
      'relaticle',
      { email: 'jonas@2060.io', workspace: { id: 'ws-1', name: 'ayni-dev-agent' } },
      { spaceId: salesEu.id }
    )
    expect(start.status).toBe(202)
    expect(start.body).toMatchObject({ attemptId: expect.stringMatching(/^att_/), expiresAt: expect.any(String) })
    // Dynamic Client Registration, as the source declares it, with the callback alone (TOOL-OAUTH-003)
    expect(crmAs.registrations).toEqual([
      {
        client_name: running.agent.pack.metadata.displayName,
        redirect_uris: ['http://agent.test/tools/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
      },
    ])
    // the request of a sign-in (TOOL-OAUTH-005): no value expected, so no workspace asked
    const params = Object.fromEntries(url?.searchParams ?? [])
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: 'client_1',
      redirect_uri: 'http://agent.test/tools/oauth/callback',
      code_challenge_method: 'S256',
      resource: crm.url,
      scope: 'mcp:use',
    })
    expect(params.state.length).toBeGreaterThanOrEqual(22)
    expect(params.code_challenge.length).toBe(43)
    expect(params.workspace).toBeUndefined()
    // the token request: the verifier (checked by the fake against the challenge), the callback, the resource
    expect(crmAs.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: 'http://agent.test/tools/oauth/callback',
      resource: crm.url,
      client_id: 'client_1',
    })
    // the browser goes to Your accounts on the app-link domain, with nothing of the outcome (PROF-LINK-004)
    expect(callback?.statusCode).toBe(303)
    expect(callback?.headers.location).toBe(`${APP_LINK_BASE}service/${running.agent.did}/accounts`)
    // no phone was asked (D104)
    expect(ph.callsOf('sendConfirmRequest').length).toBe(asked)
    // the outcome reaches the owner's sessions (PROF-TOOL-019)
    expect(connectionsEvents(jonas.sessionId).slice(-1)[0]).toMatchObject({
      source: 'relaticle',
      binding: { value: 'ws-1', valueLabel: 'ayni-dev-agent' },
      state: 'connected',
      label: 'jonas@2060.io · ayni-dev-agent',
      outcome: 'connected',
    })
    expect(received(jonas.sessionId).length).toBeGreaterThan(before)
  })

  it('takes a state once: the callback loaded again answers 400 and exchanges nothing (TOOL-OAUTH-006)', async () => {
    const start = await call(ana, 'POST', '/connections/github/authorize', {})
    const answer = ghAs.authorize(start.body.authorizationUrl as string, { email: 'ana@2060.io', login: 'ana-rios' })
    const first = await running.app.inject({
      method: 'GET',
      url: `/tools/oauth/callback?${callbackQuery(answer, ghAs.issuer)}`,
    })
    expect(first.statusCode).toBe(303)
    const exchanged = ghAs.tokenRequests.length
    const again = await running.app.inject({
      method: 'GET',
      url: `/tools/oauth/callback?${callbackQuery(answer, ghAs.issuer)}`,
    })
    expect(again.statusCode).toBe(400)
    expect(ghAs.tokenRequests.length).toBe(exchanged)
    // GitHub: the pre-registered client of the deployment's secrets, at its issuer, and nothing registered
    expect(ghAs.registrations).toHaveLength(0)
    expect(ghAs.tokenRequests.at(-1)).toMatchObject({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET })
    expect(new URL(start.body.authorizationUrl as string).searchParams.get('scope')).toBeNull()
    const item = ((await call(ana, 'GET', '/connections')).body.connections as Doc[]).find((c) => c.source === 'github')
    expect(item).toMatchObject({ state: 'connected', account: { label: 'ana-rios' } })
  })

  it('ends the waiting attempt when the same source is started again, as cancelled (TOOL-OAUTH-005)', async () => {
    const first = await call(jonas, 'POST', '/connections/github/authorize', {})
    const second = await call(jonas, 'POST', '/connections/github/authorize', {})
    expect(second.status).toBe(202)
    expect(
      connectionsEvents(jonas.sessionId).some((e) => e.attemptId === first.body.attemptId && e.outcome === 'cancelled')
    ).toBe(true)
    const late = ghAs.authorize(first.body.authorizationUrl as string, { email: 'jonas@2060.io', login: 'jonas-w' })
    expect(
      (await running.app.inject({ method: 'GET', url: `/tools/oauth/callback?${callbackQuery(late, ghAs.issuer)}` }))
        .statusCode
    ).toBe(400)
    // the person cancels the second (PROF-TOOL-015)
    expect((await call(jonas, 'DELETE', `/connections/attempts/${second.body.attemptId}`)).status).toBe(204)
    expect((await call(jonas, 'DELETE', `/connections/attempts/${second.body.attemptId}`)).status).toBe(404)
  })

  it('refuses a response from another issuer, or without iss where the server sends it, before any exchange (RFC 9207)', async () => {
    const exchanged = crmAs.tokenRequests.length
    const wrong = await signIn(
      jonas,
      'relaticle',
      { email: 'jonas@2060.io', workspace: { id: 'ws-1', name: 'ayni-dev-agent' } },
      {
        spaceId: salesEu.id,
        iss: otherAs.issuer,
      }
    )
    expect(wrong.callback?.statusCode).toBe(303)
    expect(connectionsEvents(jonas.sessionId).at(-1)).toMatchObject({ outcome: 'failed' })
    const missing = await signIn(
      jonas,
      'relaticle',
      { email: 'jonas@2060.io', workspace: { id: 'ws-1', name: 'ayni-dev-agent' } },
      {
        spaceId: salesEu.id,
        iss: null,
      }
    )
    expect(missing.callback?.statusCode).toBe(303)
    expect(connectionsEvents(jonas.sessionId).at(-1)).toMatchObject({ outcome: 'failed' })
    expect(crmAs.tokenRequests.length).toBe(exchanged)
  })

  it('ends a refusal at the service as denied, and keeps the account in force (TOOL-OAUTH-006, TOOL-CONN-002)', async () => {
    const held = await accountsOf(jonas.principal.id)
    await signIn(jonas, 'relaticle', { email: 'jonas@2060.io' }, { spaceId: salesEu.id, deny: true })
    expect(connectionsEvents(jonas.sessionId).at(-1)).toMatchObject({ outcome: 'denied' })
    expect((await accountsOf(jonas.principal.id)).map((a) => a.id)).toEqual(held.map((a) => a.id))
  })

  it('answers 502 for a metadata document the server does not take, and gives the document as client_id where it does', async () => {
    expect(await call(jonas, 'POST', '/connections/nodocs/authorize', {})).toMatchObject({
      status: 502,
      body: { error: 'source-unavailable' },
    })
    expect(noDocAs.registrations).toHaveLength(0)
    const docs = await call(jonas, 'POST', '/connections/docs/authorize', {})
    expect(docs.status).toBe(202)
    expect(new URL(docs.body.authorizationUrl as string).searchParams.get('client_id')).toBe(
      'http://agent.test/tools/oauth/client-metadata.json'
    )
    // the challenge's scope, and offline_access since the authorization server lists it and the pack names none
    expect(new URL(docs.body.authorizationUrl as string).searchParams.get('scope')).toBe('mcp:use offline_access')
    // a source of fields takes no sign-in, a source of OAuth no fields
    expect(await call(ana, 'POST', '/connections/my_tasks/authorize', {})).toMatchObject({
      status: 409,
      body: { error: 'not-oauth' },
    })
    expect(await call(ana, 'PUT', '/connections/github/account', { values: { token: 'x' } })).toMatchObject({
      status: 409,
      body: { error: 'not-fields' },
    })
    expect((await call(ana, 'POST', '/connections/docs/authorize', {})).status).toBe(404)
  })
})

describe("an account for the space's workspace (D110, TOOL-SPACE-013, TOOL-CONN-013/014)", () => {
  it('lets the owner bind the workspace of his own account only, confirmed on his phone; members read its name', async () => {
    const owner = (await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0] as Doc
    expect(owner.bindings[0]).toMatchObject({
      fromAccount: true,
      choices: [{ value: 'ws-1', valueLabel: 'ayni-dev-agent' }],
    })
    expect(
      await call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, { bindings: { workspace: 'ws-2' } })
    ).toMatchObject({
      status: 422,
      body: { error: 'not-your-account', field: 'bindings.workspace' },
    })
    await confirmed(jonas, () =>
      call(jonas, 'PATCH', `/spaces/${salesEu.id}/tools/relaticle`, { bindings: { workspace: 'ws-1' } })
    )
    const confirm = ph.callsOf('sendConfirmRequest').at(-1)?.args[0] as Doc
    expect(JSON.stringify(confirm)).toContain('Workspace: ayni-dev-agent')
    await until(
      async () => ((await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0] as Doc).state === 'ready'
    )
    const member = (await call(ana, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0] as Doc
    expect(member).toMatchObject({
      account: { kind: 'personal', connected: false },
      bindings: [{ label: 'Workspace', value: 'ws-1', valueLabel: 'ayni-dev-agent' }],
    })
    expect((await call(jonas, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0].account).toEqual({
      kind: 'personal',
      connected: true,
    })
    const listed = ((await call(ana, 'GET', '/connections')).body.connections as Doc[]).find(
      (c) => c.source === 'relaticle'
    )
    expect(listed).toMatchObject({
      binding: { name: 'workspace', label: 'Workspace', value: 'ws-1', valueLabel: 'ayni-dev-agent' },
      usedIn: [{ kind: 'space', id: salesEu.id, title: 'Sales EU' }],
      state: 'not-connected',
      revokesAtSource: true,
    })
  })

  it('discards, before any call and outside the model, a token for another workspace, and revokes it', async () => {
    const requests = model.requests.length
    const { url } = await signIn(
      ana,
      'relaticle',
      { email: 'ana@2060.io', workspace: { id: 'ws-2', name: 'Partners' } },
      {
        spaceId: salesEu.id,
      }
    )
    // the sign-in asks the service for the space's workspace (layer a), and the registration is reused
    expect(url?.searchParams.get('workspace')).toBe('ws-1')
    expect(crmAs.registrations).toHaveLength(1)
    expect(connectionsEvents(ana.sessionId).at(-1)).toMatchObject({
      source: 'relaticle',
      state: 'not-connected',
      outcome: 'wrong-binding',
      expected: 'ayni-dev-agent',
      chosen: 'Partners',
    })
    expect(await running.agent.store.personalAccounts.find(ana.principal.id, 'relaticle', 'ws-1')).toBeUndefined()
    expect(await running.agent.store.personalAccounts.find(ana.principal.id, 'relaticle', 'ws-2')).toBeUndefined()
    // the token of Partners made one call, the check's read, and it is revoked at the service
    const partners = crmAs.tokenRequests.length
    const token = crm.calls.filter((c) => c.name === 'who-ami-tool').at(-1)?.token as string
    expect(crm.calls.filter((c) => c.token === token).map((c) => c.name)).toEqual(['who-ami-tool'])
    expect(crmAs.revocations.map((r) => r.token)).toContain(token)
    // nothing of it reached a model, a conversation or a record of a call
    expect(model.requests.length).toBe(requests)
    expect(
      JSON.stringify(await running.agent.store.toolCalls.list({ principalId: ana.principal.id, limit: 100 }))
    ).not.toContain('who-ami-tool')
    expect(partners).toBeGreaterThan(0)
  })

  it("discards an account that is not the person's own by the email of the directory", async () => {
    await signIn(
      ana,
      'relaticle',
      { email: 'jonas@2060.io', workspace: { id: 'ws-1', name: 'ayni-dev-agent' } },
      {
        spaceId: salesEu.id,
      }
    )
    expect(connectionsEvents(ana.sessionId).at(-1)).toMatchObject({ outcome: 'wrong-person' })
    expect(await running.agent.store.personalAccounts.find(ana.principal.id, 'relaticle', 'ws-1')).toBeUndefined()
  })

  it('connects the account for the space, labelled from the check', async () => {
    await signIn(
      ana,
      'relaticle',
      { email: 'ANA@2060.io', workspace: { id: 'ws-1', name: 'ayni-dev-agent' } },
      {
        spaceId: salesEu.id,
      }
    )
    expect(connectionsEvents(ana.sessionId).at(-1)).toMatchObject({
      outcome: 'connected',
      state: 'connected',
      label: 'ANA@2060.io · ayni-dev-agent',
    })
    expect((await call(ana, 'GET', `/spaces/${salesEu.id}/tools`)).body.tools[0].account).toEqual({
      kind: 'personal',
      connected: true,
    })
  })
})

describe("calls with each person's own account (TOOL-CALL-011, TOOL-ACCESS-010..012, PROF-TOOL-021, TOOL-CONN-014)", () => {
  let anaSales: Device
  let jonasSales: Device

  it("gives the Sales conversation Relaticle's tools once the person's account is connected, and none before", async () => {
    anaSales = await open(ana, { spaceId: salesEu.id })
    model.script = [{ text: 'ok' }]
    await run(anaSales, 'hello')
    expect(toolNames()).toEqual(expect.arrayContaining(['who-ami-tool', 'create-note-tool', 'list-companies-tool']))
    // Personal has none of them, and Relaticle is no account to connect there
    model.script = [{ text: 'ok' }]
    await run(ana, 'hello')
    expect(toolNames()).not.toContain('create-note-tool')
    expect(systemOf()).not.toContain('relaticle')
  })

  it("asks the card naming the person's account, and runs the call with that account's token only", async () => {
    const conversationId = await conversationOf(anaSales.sessionId)
    model.script = [
      { calls: [{ name: 'create-note-tool', arguments: { note: 'Renewal in March' } }] },
      { text: 'done' },
    ]
    const pending = run(anaSales, 'add a note')
    const card = await pendingConfirmation(conversationId)
    // the person's own card names their account at the service (PROF-TOOL-021)
    expect(card.action?.account).toEqual({ kind: 'personal', label: 'ANA@2060.io · ayni-dev-agent' })
    await decide(anaSales, card.id, 'approve', 'conversation')
    await pending
    const last = crm.calls.at(-1)
    expect(last?.name).toBe('create-note-tool')
    expect(crmAs.tokenInfo(last?.token as string)?.grant.identity.email).toBe('ANA@2060.io')
    expect(toolAnswers().at(-1)).toContain('added in ayni-dev-agent by ANA@2060.io')
    // the record of the call and the provenance of its result: the person's own account (TOOL-PROV-001/004)
    const record = (await running.agent.store.toolCalls.list({ conversationId, limit: 10 }))[0]
    expect(record).toMatchObject({
      sourceId: 'relaticle',
      toolName: 'create-note-tool',
      account: { kind: 'personal' },
      outcome: 'completed',
    })
    const result = (await entries(conversationId)).find((e) => e.sourceType === 'tool-call')
    expect(result?.provenance?.account).toEqual({ kind: 'personal' })
  })

  it("runs Jonas's calls with Jonas's account, on a connection of its own (TOOL-ACCESS-012)", async () => {
    jonasSales = await open(jonas, { spaceId: salesEu.id })
    model.script = [{ calls: [{ name: 'list-companies-tool', arguments: {} }] }, { text: 'done' }]
    await run(jonasSales, 'list')
    const last = crm.calls.at(-1)
    expect(crmAs.tokenInfo(last?.token as string)?.grant.identity.email).toBe('jonas@2060.io')
    const pool = (running.agent.registry.sourceById('mcp:relaticle') as unknown as { personal: { size: number } })
      .personal
    expect(pool.size).toBeGreaterThanOrEqual(2)
  })

  it('replaces an echo of the token in a result by [account] (TOOL-ACCESS-010)', async () => {
    model.script = [{ calls: [{ name: 'echo-auth', arguments: {} }] }, { text: 'done' }]
    await run(anaSales, 'echo')
    const answer = toolAnswers().at(-1) as string
    expect(answer).toBe('you called with Bearer [account]')
  })

  it('answers more-access-needed for a 403 insufficient_scope, and asks the scopes at the next attempt (TOOL-OAUTH-009)', async () => {
    model.script = [{ calls: [{ name: 'export-files', arguments: {} }] }, { text: 'done' }]
    await run(anaSales, 'export')
    expect(toolAnswers().at(-1)).toContain('needs more access')
    const record = (await running.agent.store.toolCalls.list({ principalId: ana.principal.id, limit: 1 }))[0]
    expect(record?.outcome).toBe('more-access-needed')
    const item = ((await call(ana, 'GET', '/connections')).body.connections as Doc[]).find(
      (c) => c.source === 'relaticle'
    )
    expect(item).toMatchObject({ state: 'connected', moreAccess: true })
    const again = await call(ana, 'POST', '/connections/relaticle/authorize', { spaceId: salesEu.id })
    expect(new URL(again.body.authorizationUrl as string).searchParams.get('scope')?.split(' ')).toEqual([
      'mcp:use',
      'files:write',
    ])
    expect((await call(ana, 'DELETE', `/connections/attempts/${again.body.attemptId}`)).status).toBe(204)
  })

  it('keeps one connection for both sources of one account: GitHub in Personal and in a Project space (TOOL-CAT-015)', async () => {
    const created = await call(jonas, 'POST', '/spaces', {
      templateId: 'project',
      title: 'Test repo',
      purpose: 'Build',
    })
    testRepo = created.body as { id: string }
    await addMember(testRepo.id, ana.principal.id)
    expect(((await call(jonas, 'GET', `/spaces/${testRepo.id}/tools`)).body.tools[0] as Doc).state).toBe('setup')
    await confirmed(jonas, () =>
      call(jonas, 'PATCH', `/spaces/${testRepo.id}/tools/github-project`, {
        bindings: { owner: '2060-io', repo: 'ayni-dev-agent-test-repo' },
      })
    )
    await until(async () => ((await call(ana, 'GET', `/spaces/${testRepo.id}/tools`)).body.tools ?? []).length === 1)
    // the source Your accounts lists the account under (TOOL-CAT-015)
    expect((await call(ana, 'GET', `/spaces/${testRepo.id}/tools`)).body.tools[0].account).toEqual({
      kind: 'personal',
      connected: true,
      source: 'github',
    })
    // a sign-in from Your accounts may name any space where the account serves: the same attempt (§3.11)
    const fromSpace = await call(ana, 'POST', '/connections/github/authorize', { spaceId: testRepo.id })
    expect(fromSpace.status).toBe(202)
    expect((await call(ana, 'DELETE', `/connections/attempts/${fromSpace.body.attemptId}`)).status).toBe(204)
    // a source that uses another's account is no source of Your accounts itself
    expect((await call(ana, 'POST', '/connections/github-project/authorize', { spaceId: testRepo.id })).status).toBe(
      404
    )
    // Ana's GitHub, connected for Personal, serves the Project space with no second sign-in
    const anaRepo = await open(ana, { spaceId: testRepo.id })
    model.script = [{ calls: [{ name: 'list_issues', arguments: { owner: 'evil', repo: 'other' } }] }, { text: 'done' }]
    await run(anaRepo, 'issues')
    expect(toolAnswers().at(-1)).toBe('issues of 2060-io/ayni-dev-agent-test-repo for ana-rios')
    const listed = ((await call(ana, 'GET', '/connections')).body.connections as Doc[]).filter(
      (c) => c.source === 'github'
    )
    expect(listed).toHaveLength(1)
    expect(listed[0]?.usedIn).toEqual([{ kind: 'personal' }, { kind: 'space', id: testRepo.id, title: 'Test repo' }])
  })

  it("runs an approved call with the requester's account at the time it runs: not at all once disconnected (TOOL-CALL-011)", async () => {
    const anaRepo = await open(ana, { spaceId: testRepo.id })
    const conversationId = await conversationOf(anaRepo.sessionId)
    model.script = [{ calls: [{ name: 'issue_write', arguments: { title: 'Flaky test' } }] }, { text: 'asked' }]
    await run(anaRepo, 'open an issue')
    const approval = (await running.agent.store.approvals.list({ status: 'PENDING' })).find(
      (r) => r.kind === 'sensitivity' && r.conversationId === conversationId
    ) as ApprovalRecord
    // the approver's card names no label; the requester's own does (PROF-TOOL-021)
    expect(approval.action?.account).toEqual({ kind: 'personal' })
    expect((await running.agent.approvalCard(approval, jonas.principal)).action).toMatchObject({
      account: { kind: 'personal' },
    })
    expect(((await running.agent.approvalCard(approval, jonas.principal)).action as Doc).account.label).toBeUndefined()
    expect(((await running.agent.approvalCard(approval, ana.principal)).action as Doc).account.label).toBe('ana-rios')
    // Ana disconnects GitHub while the approval waits
    const github = (await accountsOf(ana.principal.id)).find((a) => a.sourceId === 'github') as PersonalAccountRecord
    expect((await call(ana, 'DELETE', `/connections/accounts/${github.id}`)).status).toBe(200)
    const calls = gh.calls.length
    const jonasDevice = await open(jonas, { conversationId: undefined, spaceId: testRepo.id })
    await decide(jonasDevice, approval.id, 'approve')
    await until(async () => (await running.agent.store.toolCalls.get(approval.callId as string))?.outcome !== 'pending')
    expect((await running.agent.store.toolCalls.get(approval.callId as string))?.outcome).toBe('not-connected')
    expect(gh.calls.length).toBe(calls)
  })
})

describe('the life of a connection (TOOL-OAUTH-008, TOOL-OAUTH-010, TOOL-CONN-003, TOOL-CONN-006)', () => {
  let anaGh: PersonalAccountRecord

  it('refreshes a token about to expire before the call, keeping the rotated refresh token; two at once make one refresh', async () => {
    ghAs.options.expiresIn = 30
    await signIn(ana, 'github', { email: 'ana@2060.io', login: 'ana-rios' })
    ghAs.options.expiresIn = 3600
    anaGh = (await accountsOf(ana.principal.id)).find((a) => a.sourceId === 'github') as PersonalAccountRecord
    ghAs.options.refreshDelayMs = 100
    const refreshes = ghAs.refreshes
    const [a, b] = await Promise.all([connections().accessToken(anaGh.id), connections().accessToken(anaGh.id)])
    ghAs.options.refreshDelayMs = 0
    expect(ghAs.refreshes).toBe(refreshes + 1)
    expect(a).toBe(b)
    expect(ghAs.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      resource: gh.url,
      client_id: GH_CLIENT_ID,
    })
    // the fresh token is not expiring: no refresh before this call
    model.script = [{ calls: [{ name: 'get_me', arguments: {} }] }, { text: 'done' }]
    await run(ana, 'who am I')
    expect(ghAs.refreshes).toBe(refreshes + 1)
    expect(gh.calls.at(-1)?.token).toBe(a)
  })

  it('refreshes once after a 401 to a token that had not expired, with the rotated refresh token, and calls again', async () => {
    ghAs.invalidate(gh.calls.at(-1)?.token as string)
    const refreshes = ghAs.refreshes
    model.script = [{ calls: [{ name: 'get_me', arguments: {} }] }, { text: 'done' }]
    await run(ana, 'who am I')
    expect(ghAs.refreshes).toBe(refreshes + 1)
    expect(toolAnswers().at(-1)).toContain('ana-rios')
  })

  it('puts the account to reconnect when the service refuses its refresh: revoked; the next turn has none of its tools', async () => {
    ghAs.revokeGrant(gh.calls.at(-1)?.token as string)
    model.script = [{ calls: [{ name: 'get_me', arguments: {} }] }, { text: 'done' }]
    await run(ana, 'who am I')
    expect(toolAnswers().at(-1)).toContain('is to be reconnected')
    expect((await running.agent.store.toolCalls.list({ principalId: ana.principal.id, limit: 1 }))[0]?.outcome).toBe(
      'not-connected'
    )
    const item = ((await call(ana, 'GET', '/connections')).body.connections as Doc[]).find((c) => c.source === 'github')
    expect(item).toMatchObject({ state: 'reconnect', reason: 'revoked' })
    const stored = await running.agent.store.personalAccounts.get(anaGh.id)
    expect(stored).toMatchObject({ state: 'reconnect', reason: 'revoked', cipher: '', encKeyRef: '' })
    model.script = [{ text: 'ok' }]
    await run(ana, 'hello')
    expect(toolNames()).not.toContain('get_me')
    expect(systemOf()).toContain('- github: GitHub, Code, issues and pull requests in GitHub (to reconnect)')
  })

  it('reconnects: the new account replaces the former one once it succeeds (TOOL-CONN-002)', async () => {
    await signIn(ana, 'github', { email: 'ana@2060.io', login: 'ana-rios' })
    const now = (await accountsOf(ana.principal.id)).filter((a) => a.sourceId === 'github')
    expect(now).toHaveLength(1)
    expect(now[0]?.state).toBe('connected')
    expect(now[0]?.id).not.toBe(anaGh.id)
    anaGh = now[0] as PersonalAccountRecord
  })

  it('sends no token to a server whose metadata names another authorization server, and asks to reconnect (TOOL-OAUTH-010)', async () => {
    gh.authorizationServers = [otherAs.issuer]
    ;(connections() as unknown as { discoveries: Map<string, unknown> }).discoveries.clear()
    const calls = gh.calls.length
    model.script = [{ calls: [{ name: 'get_me', arguments: {} }] }, { text: 'done' }]
    await run(ana, 'who am I')
    expect(gh.calls.length).toBe(calls)
    expect(await running.agent.store.personalAccounts.get(anaGh.id)).toMatchObject({
      state: 'reconnect',
      reason: 'changed',
    })
    expect(otherAs.authorizations).toEqual([])
    expect(otherAs.tokenRequests).toEqual([])
    gh.authorizationServers = [ghAs.issuer]
    ;(connections() as unknown as { discoveries: Map<string, unknown> }).discoveries.clear()
  })

  it('disconnects at once, revoking at the service the refresh token then the access token (TOOL-CONN-006)', async () => {
    const account = (await accountsOf(ana.principal.id)).find(
      (a) => a.sourceId === 'relaticle'
    ) as PersonalAccountRecord
    const anaSales = await open(ana, { spaceId: salesEu.id })
    const conversationId = await conversationOf(anaSales.sessionId)
    // an allowance on Add a note, which the Disconnect ends
    model.script = [{ calls: [{ name: 'create-note-tool', arguments: { note: 'one' } }] }, { text: 'done' }]
    const pending = run(anaSales, 'note')
    await decide(anaSales, (await pendingConfirmation(conversationId)).id, 'approve', 'conversation')
    await pending
    const allowance = (await running.agent.store.toolAllowances.listByConversation(conversationId))[0]
    expect(allowance?.endedAt).toBeUndefined()
    const revocations = crmAs.revocations.length
    const response = await call(ana, 'DELETE', `/connections/accounts/${account.id}`)
    expect(response.status).toBe(200)
    expect(response.body.connection).toMatchObject({ source: 'relaticle', state: 'not-connected', account: null })
    expect(crmAs.revocations.slice(revocations).map((r) => r.token_type_hint)).toEqual([
      'refresh_token',
      'access_token',
    ])
    expect(await running.agent.store.personalAccounts.get(account.id)).toBeUndefined()
    expect((await running.agent.store.toolAllowances.get(allowance?.approvalId as string))?.endedAt).toBeDefined()
    expect((await call(ana, 'DELETE', `/connections/accounts/${account.id}`)).status).toBe(404)
    expect((await call(jonas, 'DELETE', `/connections/accounts/${anaGh.id}`)).status).toBe(404)
    // and connects again, for what follows
    await signIn(
      ana,
      'relaticle',
      { email: 'ana@2060.io', workspace: { id: 'ws-1', name: 'ayni-dev-agent' } },
      { spaceId: salesEu.id }
    )
  })
})

describe('an account of fields (TOOL-CONN-005, PROF-TOOL-016)', () => {
  it('takes the token at once, with the checks of a space account, and calls with it', async () => {
    expect(await call(ana, 'PUT', '/connections/my_tasks/account', { values: {} })).toMatchObject({
      status: 400,
      body: { error: 'bad-request', field: 'account.token' },
    })
    expect(
      await call(ana, 'PUT', '/connections/my_tasks/account', {
        values: { token: `tt_${'b'.repeat(15)} ${'c'.repeat(16)}` },
      })
    ).toMatchObject({ status: 422, body: { error: 'bad-token', field: 'account.token' } })
    const set = await call(ana, 'PUT', '/connections/my_tasks/account', { values: { token: `  ${TASKS_TOKEN}\n` } })
    expect(set).toMatchObject({ status: 200, body: { connection: { source: 'my_tasks', state: 'connected' } } })
    model.script = [{ calls: [{ name: 'my_tasks', arguments: {} }] }, { text: 'done' }]
    await run(ana, 'my tasks')
    expect(tasks.requests.at(-1)?.authorization).toBe(`Bearer ${TASKS_TOKEN}`)
    expect(toolAnswers().at(-1)).not.toContain(TASKS_TOKEN)
    expect(toolAnswers().at(-1)).toContain('[account]')
  })
})

describe('what the model knows, and the Connect card (TOOL-CONN-010..012, PROF-TOOL-020, D108)', () => {
  let personal: Device

  it('reads one line per account to connect, in the Principal block, and none of its tools; the same line each turn', async () => {
    // GitHub must be reconnected: its source named another authorization server for a while
    personal = await open(ana, {})
    model.script = [{ text: 'ok' }]
    await run(personal, 'hello')
    const record =
      'Accounts this person can connect, with the tool offer_connection:\n- github: GitHub, Code, issues and pull requests in GitHub (to reconnect)'
    expect(systemOf()).toContain(record)
    expect(toolNames()).toContain('offer_connection')
    expect(toolNames()).not.toContain('get_me')
    const first = systemOf()
    model.script = [{ text: 'ok' }]
    await run(personal, 'again')
    expect(systemOf()).toBe(first)
    // the platform rules: never a credential in a conversation, the Connect card instead (TOOL-CONN-012)
    expect(first).toContain('never ask for a password, a token or a key in a conversation')
  })

  it('shows the Connect card in the run and in history, and answers shown; not-available for another source', async () => {
    model.script = [
      { calls: [{ name: 'offer_connection', arguments: { source: 'github' } }] },
      { calls: [{ name: 'offer_connection', arguments: { source: 'relaticle' } }] },
      { text: 'Connect GitHub from the card.' },
    ]
    const result = await run(personal, 'list my issues')
    const card = result.events.find((e) => e.type === 'ACTIVITY_SNAPSHOT' && e.activityType === ACTIVITY.connect)
    expect(card?.content).toEqual({
      source: 'github',
      title: 'GitHub',
      description: 'Code, issues and pull requests in GitHub',
      method: 'oauth',
      why: 'reconnect',
    })
    const answers = toolAnswers()
    expect(answers.at(-2)).toMatch(/^shown: /)
    expect(answers.at(-1)).toMatch(/^not-available: /)
    const history = (await call(personal, 'GET', `/${personal.sessionId}/messages?limit=100`)).body.messages as Doc[]
    expect(history.find((m) => m.activityType === ACTIVITY.connect)?.content).toMatchObject({ source: 'github' })
    // recorded for the model as a record of the system; never in the history of a shared conversation
    const entry = (await entries(await conversationOf(personal.sessionId))).find(
      (e) => e.sourceType === 'state-update' && e.payload?.kind === 'connect'
    ) as MessageEntry
    expect(sharedEntryToMessages(entry)).toEqual([])
    model.script = [{ text: 'ok' }]
    await run(personal, 'next')
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain('The Connect card of GitHub was shown')
  })

  it('answers unavailable, with no card, in a conversation open only in a 3.4 client (PROF-SESS-016)', async () => {
    const old = await open(ana, { profileVersion: '3.4' })
    model.script = [{ calls: [{ name: 'offer_connection', arguments: { source: 'github' } }] }, { text: 'ok' }]
    const result = await run(old, 'issues')
    expect(toolAnswers().at(-1)).toMatch(/^unavailable: /)
    expect(result.events.some((e) => e.activityType === ACTIVITY.connect)).toBe(false)
  })

  it('answers connected once the person connected meanwhile, and the next turn has the tools and no line', async () => {
    await signIn(ana, 'github', { email: 'ana@2060.io', login: 'ana-rios' })
    model.script = [{ text: 'ok' }]
    await run(personal, 'connected')
    expect(toolNames()).toContain('get_me')
    expect(toolNames()).not.toContain('offer_connection')
    expect(systemOf()).not.toContain('Accounts this person can connect')
  })
})

describe('a credential pasted in a conversation (D109, TOOL-ACCESS-013/014, PROF-STREAM-011, PROF-HIST-013)', () => {
  it('holds the whole message back from the model, keeps it masked and draws it as never received', async () => {
    const personal = await open(ana, {})
    const conversationId = await conversationOf(personal.sessionId)
    const text = `my token is ${PASTED} please list my repos`
    model.script = [{ text: 'Connect GitHub instead.' }]
    const result = await run(personal, text)
    // the model reads a record naming GitHub, and nothing of the message
    const request = JSON.stringify(model.requests.at(-1)?.messages)
    expect(request).not.toContain(PASTED)
    expect(request).not.toContain('list my repos')
    expect(request).toContain('held back because it carried a credential of GitHub')
    // the run tells every device, with the text kept (PROF-STREAM-011)
    const withheld = result.events.find((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.messagesWithheld)
    const kept = `my token is ${PASTED.slice(0, 4)}… please list my repos`
    expect(withheld?.value).toMatchObject({ conversationId, reason: 'credential' })
    expect(Object.values(((withheld?.value ?? {}) as Doc).texts)).toEqual([kept])
    // stored masked, and history gives it as one the model never received (PROF-HIST-013)
    const stored = (await entries(conversationId)).find((e) => e.role === 'principal' && e.text.includes('my token'))
    expect(stored?.text).toBe(kept)
    const history = (await call(personal, 'GET', `/${personal.sessionId}/messages?limit=100`)).body.messages as Doc[]
    const item = history.find((m) => m.id === stored?.id)
    expect(item?.content).toBe(kept)
    expect(item?.metadata).toMatchObject({ modelVisible: false, withheld: 'credential' })
    // the conversation's preview is masked too
    const list = (await call(personal, 'GET', '/conversations')).body as Doc
    expect(JSON.stringify(list)).not.toContain(PASTED)
  })

  it('holds back a known format of 16 characters or more, and lets a shorter match through', async () => {
    const personal = await open(ana, {})
    model.script = [{ text: 'ok' }]
    await run(personal, 'the word AKIAIOSFODNN7EXAMPLE in a sentence')
    expect(JSON.stringify(model.requests.at(-1)?.messages)).not.toContain('AKIAIOSFODNN7EXAMPLE')
    model.script = [{ text: 'ok' }]
    await run(personal, 'a short ghp_abcdefgh is fine')
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain('a short ghp_abcdefgh is fine')
  })
})

describe("the end of a person's access (TOOL-CONN-008, PRIV-ERASE-013, IDENT-ROLE-013)", () => {
  it("makes every account of the person unreadable at once, even with the master key; another person's still opens", async () => {
    const anaAccounts = await accountsOf(ana.principal.id)
    expect(anaAccounts.length).toBeGreaterThanOrEqual(2)
    // a copy of the accounts' rows, taken before
    const copy = anaAccounts.map((a) => ({ ...a }))
    const anaKey = (await running.agent.store.personKeys.get(ana.principal.id))?.wrappedKey as string
    // the account's key is under the person's key, not the master key: the master key alone opens nothing
    const connected = copy.find((a) => a.cipher) as PersonalAccountRecord
    expect(() => crypto.decrypt(connected.encKeyRef, Buffer.from(connected.cipher, 'base64'))).toThrow()
    expect(openUnder(crypto, anaKey, connected.encKeyRef, Buffer.from(connected.cipher, 'base64'))).toBeDefined()
    // a sign-in Ana started before she leaves
    const waiting = await call(ana, 'POST', '/connections/relaticle/authorize', { spaceId: salesEu.id })
    const late = crmAs.authorize(waiting.body.authorizationUrl as string, {
      email: 'ana@2060.io',
      workspace: { id: 'ws-1', name: 'ayni-dev-agent' },
    })
    // her entry leaves the directory
    writeFileSync(directoryFile, stringifyYaml({ people: PEOPLE.filter((p) => p.id !== 'p-ana') }))
    const people = running.agent.people as unknown as {
      apply(r: unknown): Promise<unknown>
      deps: { directory: { check(): Promise<unknown> } }
    }
    await people.apply(await people.deps.directory.check())
    expect(await running.agent.store.personKeys.get(ana.principal.id)).toBeUndefined()
    expect(await accountsOf(ana.principal.id)).toEqual([])
    // the copy taken before opens no more: its person's key is gone, and the master key never opened it
    expect(await running.agent.store.personKeys.get(ana.principal.id)).toBeUndefined()
    // Jonas's still opens
    const jonasAccount = (await accountsOf(jonas.principal.id)).find(
      (a) => a.sourceId === 'relaticle'
    ) as PersonalAccountRecord
    const jonasKey = (await running.agent.store.personKeys.get(jonas.principal.id))?.wrappedKey as string
    expect(
      openUnder(crypto, jonasKey, jonasAccount.encKeyRef, Buffer.from(jonasAccount.cipher, 'base64'))
    ).toMatchObject({
      tokens: { issuer: crmAs.issuer },
    })
    // the callback of her attempt answers 400 and changes nothing
    const answer = await running.app.inject({
      method: 'GET',
      url: `/tools/oauth/callback?${callbackQuery(late, crmAs.issuer)}`,
    })
    expect(answer.statusCode).toBe(400)
    expect(await accountsOf(ana.principal.id)).toEqual([])
  })
})

describe('at start, the accounts follow the agent-pack (TOOL-CONN-009)', () => {
  it('ends an account whose source connects otherwise, and asks to reconnect one whose scopes changed', async () => {
    const jonasAccount = (await accountsOf(jonas.principal.id)).find(
      (a) => a.sourceId === 'relaticle'
    ) as PersonalAccountRecord
    await running.agent.store.personalAccounts.update({ ...jonasAccount, scopesDigest: 'former' })
    const ghAccount = (await accountsOf(jonas.principal.id)).find((a) => a.sourceId === 'docs')
    expect(ghAccount).toBeUndefined()
    await connections().align()
    expect(await running.agent.store.personalAccounts.get(jonasAccount.id)).toMatchObject({
      state: 'reconnect',
      reason: 'changed',
    })
    await running.agent.store.personalAccounts.update({
      ...((await running.agent.store.personalAccounts.get(jonasAccount.id)) as PersonalAccountRecord),
      packDigest: 'former',
    })
    await connections().align()
    expect(await running.agent.store.personalAccounts.get(jonasAccount.id)).toBeUndefined()
  })
})

describe('what nothing ever holds (TOOL-OAUTH-007, TOOL-ACCESS-008..011, TOOL-CONN-007)', () => {
  it('gives the model no tool that carries an account, and no request of a client the tokens', () => {
    for (const request of model.requests)
      for (const tool of request.tools ?? []) expect(JSON.stringify(tool.parameters)).not.toMatch(/token|account/i)
  })

  it('writes to the admin audit each connection, end and attempt, with no token, value or label', async () => {
    const audit = await running.agent.store.adminAudit.list(1000, { action: 'personal-account' })
    const what = new Set(audit.map((r) => r.reason))
    for (const kind of [
      'connected',
      'replaced',
      'disconnected',
      'ended',
      'reconnect-revoked',
      'reconnect-changed',
      'more-access',
      'attempt-wrong-binding',
      'attempt-wrong-person',
      'attempt-cancelled',
      'attempt-denied',
      'attempt-failed',
    ])
      expect(what).toContain(kind)
    const text = JSON.stringify(audit)
    for (const secret of [...crmAs.secrets, ...ghAs.secrets, TASKS_TOKEN]) expect(text).not.toContain(secret)
    expect(text).not.toContain('ayni-dev-agent')
    expect(text).not.toContain('ana-rios')
  })

  it('leaves no token, code, verifier or pasted credential in the log, at debug, over this whole file', () => {
    const log = logLines.join('\n')
    expect(logLines.length).toBeGreaterThan(100)
    const secrets = [...crmAs.secrets, ...ghAs.secrets, ...otherAs.secrets, TASKS_TOKEN, PASTED, GH_CLIENT_SECRET]
    expect(secrets.length).toBeGreaterThan(10)
    for (const secret of secrets) expect(log).not.toContain(secret)
    expect(log).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('stores no token outside the sealed accounts: entries, approvals, call records, attempts', async () => {
    const all: unknown[] = []
    for (const conversation of await running.agent.store.conversations.listByPrincipal(ana.principal.id))
      all.push(...(await entries(conversation.id)))
    all.push(...(await running.agent.store.approvals.list({})))
    all.push(...(await running.agent.store.toolCalls.list({ limit: 1000 })))
    all.push(...(await running.agent.store.oauthAttempts.listWaiting()))
    const text = JSON.stringify(all)
    for (const secret of [...crmAs.secrets, ...ghAs.secrets, TASKS_TOKEN, PASTED]) expect(text).not.toContain(secret)
  })
})
