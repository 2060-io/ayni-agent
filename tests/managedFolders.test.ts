/**
 * A team space's folder made and kept by the agent (ayni-spec D145 to D151, architecture §10.13), over the real agent (an
 * in-memory store, a scripted model, a stubbed phone) and fake providers of Files 1.0 that keep team roots (files §4.7),
 * never a real service, driven through the AG-UI profile 3.5.9: TOOL-FEAT-024 to 034, PROF-TOOL-040 to 043.
 *
 * Two managed providers: a Nextcloud-like store managed with the managing account (`as: manager`, D150), and a shared
 * drive managed with the space owner's own account (`as: owner`, D147), whose sign-in is stood in for here by the accounts
 * the test gives the folder service. A third declares `manage` but its server no `team-roots` (TOOL-FEAT-033). People
 * are named to the store by the email the directory gives them (D146), stood in for by the test's own list.
 */
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { Principal } from '../src/core/types.js'
import type { ManagedFolders } from '../src/features/managedFolders.js'
import { requestIdOf } from '../src/features/managedFolders.js'
import { type FakeProvider, fakeProvider, featuresPack, PERSONAL_ACCOUNT } from './featureFixtures.js'
import { parseSse, testEnv } from './helpers.js'
import { type Doc, type Phone, phone, type ScriptedModel, scripted, until } from './toolFixtures.js'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const READ_TOOLS = ['files_roots', 'files_list', 'files_get', 'files_read', 'files_search', 'files_shares']

let running: RunningAgent
let cloud: FakeProvider
let gdrive: FakeProvider
let plain: FakeProvider
let model: ScriptedModel
let ph: Phone
let folders: ManagedFolders
const logLines: string[] = []

interface Device {
  sessionId: string
  sessionToken: string
  principal: Principal
  connectionId: string
}

const web = () => ({ name: 'ayni-ui', version: '3.5.9', platform: 'web' })
/** the email each person's directory entry gives, by Principal (D146): Tom's entry has none */
const emails = new Map<string, string>()
/** each person's own account of the shared drive, connected or not: their sign-in, stood in for (D147) */
const driveAccounts = new Map<string, string>()

async function device(name: string, roles: string[], email?: string): Promise<Device> {
  const created = (
    await running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client: web(), locale: 'en' } })
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
  const updated = { ...principal, roles }
  await running.agent.principals.save(updated)
  if (email) emails.set(updated.id, email)
  return { ...created, principal: updated, connectionId }
}

async function _open(d: Device, spaceId: string): Promise<Device> {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: { authorization: `Bearer ${d.sessionToken}` },
    payload: { client: web(), locale: 'en', newConversation: true, spaceId },
  })
  if (response.statusCode !== 201) throw new Error(`session ${response.statusCode}: ${response.body}`)
  return { ...(response.json() as Device), principal: d.principal, connectionId: d.connectionId }
}

async function call(d: Pick<Device, 'sessionToken'>, method: string, url: string, payload?: unknown) {
  const response = await running.app.inject({
    method: method as 'GET',
    url: `/agui/v3/sessions${url}`,
    headers: { authorization: `Bearer ${d.sessionToken}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
  return { status: response.statusCode, body: response.body ? response.json() : undefined }
}

function _run(d: Pick<Device, 'sessionId' | 'sessionToken'>, text: string) {
  return running.app
    .inject({
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
    .then((response) => ({
      status: response.statusCode,
      events: response.statusCode === 200 ? parseSse(response.body).map((e) => e.event) : [],
    }))
}

/** The owner asks, and his phone confirms: the change applies. */
async function confirmed(d: Device, request: () => Promise<{ status: number; body: Doc }>) {
  const asked = ph.callsOf('sendConfirmRequest').length
  const response = await request()
  expect(response.status).toBe(202)
  await until(() => ph.callsOf('sendConfirmRequest').length > asked)
  await ph.confirm(d.connectionId, true)
  return response
}

/** A member of a space, active, by their row: a person of the directory, or a guest invited by email (D90). */
async function addMember(spaceId: string, principalId: string, role: 'member' | 'guest' = 'member', email?: string) {
  const now = new Date().toISOString()
  await running.agent.store.spaceMembers.save({
    id: `mem_${spaceId}_${principalId}`,
    spaceId,
    principalId,
    state: 'active',
    role,
    ...(email ? { email } : {}),
    createdAt: now,
    updatedAt: now,
  })
}

const space = (title: string, templateId = 'team-project') =>
  call(jonas, 'POST', '/spaces', { templateId, title, purpose: 'Build' }).then((r) => r.body as { id: string })
const filesOf = async (d: Device, spaceId: string) =>
  ((await call(d, 'GET', `/spaces/${spaceId}/tools`)).body.tools as Doc[]).find((t) => t.feature.id === 'files') as Doc
const activityOf = async (spaceId: string) =>
  ((await call(jonas, 'GET', `/spaces/${spaceId}/activity`)).body.activity as Doc[]).map((a) => a.kind)
const folderOf = (spaceId: string) => running.agent.store.managedFolders.get(spaceId, 'files')
const membershipsOf = (spaceId: string) => running.agent.store.folderMemberships.listByFolder(spaceId, 'files')
const teamOf = async (provider: FakeProvider, spaceId: string) => {
  const ref = (await folderOf(spaceId))?.ref as string
  return provider.teamRoots.get(ref)
}
const membersAtStore = async (provider: FakeProvider, spaceId: string) =>
  Object.fromEntries(((await teamOf(provider, spaceId))?.shares ?? []).map((s) => [s.recipient.address, s.role]))
const _lastUserText = () => {
  const user = (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'user').at(-1)
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content)
}
const _toolAnswers = () =>
  (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))
const _definitionNames = () => (model.requests.at(-1)?.tools ?? []).map((t) => t.name)

let jonas: Device
let ana: Device
let lena: Device
let piet: Device
let tom: Device
let _mia: Device
let alpha: { id: string }

beforeAll(async () => {
  process.env.AYNI_TEST_MANAGER_NAME = 'ayni-manager'
  process.env.AYNI_TEST_MANAGER_PASSWORD = 'manager-password-0001'
  // a store whose team roots have no role manager, managed with the managing account (D150)
  cloud = await fakeProvider({
    files: {
      version: '1.0',
      capabilities: ['folders', 'search', 'share', 'team-roots'],
      'team-roots': { manager: false },
    },
  })
  // a store of shared drives, whose managers change its members (D147)
  gdrive = await fakeProvider({
    files: {
      version: '1.0',
      capabilities: ['folders', 'search', 'share', 'team-roots'],
      'team-roots': { manager: true },
    },
  })
  // a store that declares no team-roots: the existing mode alone, whatever its source says (TOOL-FEAT-033)
  plain = await fakeProvider({ files: { version: '1.0', capabilities: ['folders', 'search', 'share'] } })
  const pack = featuresPack({
    nextcloudUrl: plain.url,
    driveUrl: plain.url,
    edit: (p) => {
      p.metadata.displayName = 'Fleet support'
      p.identity.roles = { ...p.identity.roles, reader: { description: 'Reads the files of projects.' } }
      const access = { roles: { employee: ['*'], reader: READ_TOOLS } }
      const manage = {
        as: 'manager',
        apply: [
          { header: 'Ayni-Dav-Username', value: '${AYNI_TEST_MANAGER_NAME}' },
          { header: 'Ayni-Dav-Password', value: '${AYNI_TEST_MANAGER_PASSWORD}' },
        ],
      }
      p.tools.sources['cloud-team'] = {
        type: 'mcp',
        feature: 'files',
        title: 'Nextcloud',
        transport: 'streamable-http',
        url: cloud.url,
        account: PERSONAL_ACCOUNT,
        availability: 'spaces',
        manage,
        access,
      }
      p.tools.sources['team-drive'] = {
        type: 'mcp',
        feature: 'files',
        title: 'Google Drive',
        transport: 'streamable-http',
        url: gdrive.url,
        account: { kind: 'personal', oauth: { client: { registration: 'dynamic' }, scopes: [DRIVE_SCOPE] } },
        availability: 'spaces',
        manage: { as: 'owner' },
        access,
      }
      p.tools.sources['plain-team'] = {
        type: 'mcp',
        feature: 'files',
        title: 'WebDAV',
        transport: 'streamable-http',
        url: plain.url,
        account: PERSONAL_ACCOUNT,
        availability: 'spaces',
        manage,
        access,
      }
      p.spaces.templates.push(
        {
          id: 'team-project',
          title: 'Project',
          kind: 'team',
          creators: ['employee'],
          membership: { mode: 'list' },
          features: [
            {
              feature: 'files',
              providers: ['cloud-team', 'team-drive', 'plain-team', 'nextcloud'],
              default: 'cloud-team',
              add: 'owner',
              guests: true,
            },
          ],
        },
        {
          id: 'managed-only',
          title: 'Managed project',
          kind: 'team',
          creators: ['employee'],
          membership: { mode: 'list' },
          features: [
            { feature: 'files', providers: ['cloud-team', 'nextcloud'], default: 'cloud-team', location: 'managed' },
          ],
        },
        {
          id: 'existing-only',
          title: 'Existing project',
          kind: 'team',
          creators: ['employee'],
          membership: { mode: 'list' },
          features: [{ feature: 'files', providers: ['cloud-team'], location: 'existing', add: 'owner' }],
        }
      )
    },
  })
  const logger = pino({ level: 'debug' }, { write: (line: string) => void logLines.push(line) })
  running = await buildAgent(testEnv({ agentPackPath: pack, logLevel: 'debug' }), logger, { drainMs: 200 })
  const minter = running.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
  minter.minter = {
    mint: async (id: string) => ({
      invitationId: `inv-${id}`,
      outOfBandId: `oob-${id}`,
      url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
    }),
  }
  ph = phone(running)
  model = scripted(running)
  folders = running.agent.spaceTools?.folders as ManagedFolders
  // the directory's emails and names (D146), and each person's own sign-in of the shared drive (D147)
  const deps = (folders as unknown as { deps: Doc }).deps
  deps.emailOf = (p: Principal) => emails.get(p.id)
  folders.connections = {
    open: async (p: Principal) =>
      driveAccounts.has(p.id)
        ? {
            status: 'connected',
            account: {
              kind: 'personal',
              accountId: `acc-${p.id}`,
              headers: { authorization: `Bearer ${driveAccounts.get(p.id)}` },
              secrets: [driveAccounts.get(p.id)],
            },
          }
        : { status: 'not-connected' },
    fingerprintIn: async (p: Principal) =>
      driveAccounts.has(p.id) ? `acc-${p.id}@${driveAccounts.get(p.id)}` : undefined,
  } as never
  jonas = await device('jonas', ['employee', 'lead'], 'jonas@example.org')
  ana = await device('ana', ['employee'], 'ana@example.org')
  lena = await device('lena', ['reader'], 'lena@example.org')
  piet = await device('piet', ['employee'])
  tom = await device('tom', ['employee'])
  _mia = await device('mia', ['employee'], 'mia@example.org')
}, 30_000)

afterAll(async () => {
  await running?.stop()
  await cloud?.close()
  await gdrive?.close()
  await plain?.close()
})

describe('the modes of Files in a team space (PROF-TOOL-040, TOOL-FEAT-023, TOOL-FEAT-024, TOOL-FEAT-033)', () => {
  it('offers each provider the modes the template allows, the existing one alone where the agent cannot manage', async () => {
    alpha = await space('Project Alpha')
    const files = await filesOf(jonas, alpha.id)
    expect(files.locations).toEqual(['managed', 'existing'])
    expect(Object.fromEntries((files.providers as Doc[]).map((p) => [p.source, p.locations]))).toEqual({
      'cloud-team': ['managed', 'existing'],
      // the owner's own account is not there yet to read what the server declares with: both, as far as is known
      'team-drive': ['managed', 'existing'],
      'plain-team': ['existing'],
      nextcloud: ['existing'],
    })
    // a member reads no modes
    await addMember(alpha.id, ana.principal.id)
    expect((await filesOf(ana, alpha.id))?.locations).toBeUndefined()
  })

  it('requires the mode where both are allowed, and refuses a mode the template or the provider does not allow', async () => {
    const post = (spaceId: string, body: Doc) => call(jonas, 'POST', `/spaces/${spaceId}/tools`, body)
    expect(await post(alpha.id, { source: 'cloud-team' })).toMatchObject({
      status: 400,
      body: { error: 'bad-request', field: 'location' },
    })
    expect(await post(alpha.id, { source: 'plain-team', location: 'managed' })).toMatchObject({
      status: 409,
      body: { error: 'cannot-manage' },
    })
    expect(await post(alpha.id, { source: 'nextcloud', location: 'managed' })).toMatchObject({
      status: 409,
      body: { error: 'cannot-manage' },
    })
    expect(
      await post(alpha.id, { source: 'cloud-team', location: 'managed', list: { entries: [{ root: '48213' }] } })
    ).toMatchObject({ status: 400, body: { error: 'bad-request', field: 'list' } })
    const existing = await space('Project Existing', 'existing-only')
    expect(await post(existing.id, { source: 'cloud-team', location: 'managed' })).toMatchObject({
      status: 422,
      body: { error: 'location-not-allowed', field: 'location' },
    })
    expect((await filesOf(jonas, existing.id)).locations).toEqual(['existing'])
    const managed = await space('Project Managed', 'managed-only')
    expect(await post(managed.id, { source: 'cloud-team', location: 'existing' })).toMatchObject({
      status: 422,
      body: { error: 'location-not-allowed', field: 'location' },
    })
    expect(cloud.calls.filter((c) => c.name === 'files_create_team_root')).toHaveLength(0)
  })
})

describe('adding Files in the managed mode (TOOL-FEAT-024 to 026, TOOL-FEAT-034, PROF-TOOL-040, PROF-TOOL-041)', () => {
  it("says on the phone what the agent makes, then makes the folder with the managing account and the space's title", async () => {
    await addMember(alpha.id, lena.principal.id)
    await addMember(alpha.id, tom.principal.id)
    await addMember(alpha.id, piet.principal.id, 'guest', 'piet@partner.example')
    const asked = await confirmed(jonas, () =>
      call(jonas, 'POST', `/spaces/${alpha.id}/tools`, { source: 'cloud-team', location: 'managed' })
    )
    expect(asked.body.tool.pending.summary).toBe(
      'Use Nextcloud for Files in Project Alpha. Fleet support makes a team folder named Project Alpha, owned by your ' +
        'organization, and gives each member of the space access to it. People outside your organization included.'
    )
    await until(async () => (await folderOf(alpha.id))?.state === 'ready')
    const made = cloud.calls.filter((c) => c.name === 'files_create_team_root')
    expect(made).toHaveLength(1)
    expect(made[0]?.args).toEqual({ name: 'Project Alpha', requestId: requestIdOf(alpha.id, 'files') })
    // the managing account the deployment's secrets build, and no person's (TOOL-FEAT-025)
    expect(made[0]?.headers['ayni-dav-username']).toBe('ayni-manager')
    expect(made[0]?.headers.authorization).toBeUndefined()
  })

  it("keeps the folder as the feature's one location, which the owner does not change", async () => {
    const folder = await folderOf(alpha.id)
    expect(folder).toMatchObject({ name: 'Project Alpha', state: 'ready', managedWith: 'manager', managers: false })
    expect((await running.agent.store.spaceTools.get(alpha.id, 'cloud-team'))?.list).toEqual({
      entries: [{ values: { root: folder?.ref }, label: 'Project Alpha' }],
    })
    const files = await filesOf(jonas, alpha.id)
    expect(files).toMatchObject({
      state: 'ready',
      location: 'managed',
      list: { choices: false, anyAllowed: false, maxEntries: 1 },
    })
    expect(
      await call(jonas, 'PATCH', `/spaces/${alpha.id}/tools/cloud-team`, { list: { entries: [{ root: '48213' }] } })
    ).toMatchObject({ status: 409, body: { error: 'managed-location' } })
  })

  it("makes the space's members its members, each by their address and with the role their tools give", async () => {
    // the owner and Ana write, Lena only reads, Piet is a guest of a template whose guests is true; Tom has no email
    expect(await membersAtStore(cloud, alpha.id)).toEqual({
      'ayni-manager@example.org': 'editor',
      'jonas@example.org': 'editor',
      'ana@example.org': 'editor',
      'lena@example.org': 'reader',
      'piet@partner.example': 'editor',
    })
    const shares = cloud.calls.filter((c) => c.name === 'files_share')
    expect(shares.every((c) => c.headers['ayni-dav-username'] === 'ayni-manager')).toBe(true)
    expect(shares.every((c) => c.args.ref === c.args.root)).toBe(true)
    const memberships = await membershipsOf(alpha.id)
    expect(memberships.find((m) => m.principalId === tom.principal.id)).toMatchObject({
      state: 'failed',
      reason: 'no-address',
    })
    // no address is kept, of a member or of the folder (TOOL-FEAT-034)
    expect(JSON.stringify([memberships, await folderOf(alpha.id)])).not.toContain('@')
    expect(logLines.join('\n')).not.toContain('ana@example.org')
  })

  it('shows the owner the folder and each member access, and a member their own', async () => {
    const owner = await filesOf(jonas, alpha.id)
    expect(owner.folder).toEqual({
      title: 'Project Alpha',
      state: 'ready',
      reason: null,
      managedWith: 'manager',
      webUrl: expect.stringMatching(/^https:\/\/store\.example\/folders\/team-/),
      access: { inPlace: 4, pending: 0, failed: 1 },
      addedOutside: 0,
    })
    expect((await filesOf(ana, alpha.id)).folder).toEqual({
      title: 'Project Alpha',
      webUrl: owner.folder.webUrl,
      myAccess: 'in-place',
    })
    const detail = (await call(jonas, 'GET', `/spaces/${alpha.id}`)).body
    const byName = Object.fromEntries((detail.members as Doc[]).map((m) => [m.name, m.folderAccess]))
    expect(byName).toMatchObject({
      ana: { state: 'in-place', role: 'editor' },
      lena: { state: 'in-place', role: 'reader' },
      tom: { state: 'failed', role: 'editor', reason: 'no-address' },
    })
    expect(detail.addedOutside).toEqual([])
    expect((await call(ana, 'GET', `/spaces/${alpha.id}`)).body.members[0].folderAccess).toBeUndefined()
    expect(await activityOf(alpha.id)).toEqual(expect.arrayContaining(['folder-created', 'access-failed']))
  })

  it("tells the owner, in the space's Notifications, of the member who has no access (PROF-TOOL-042)", async () => {
    const owner = (await call(jonas, 'GET', `/spaces/${alpha.id}/notifications`)).body
    const items = (owner.notifications as Doc[]).filter((n) => n.kind === 'folder-access')
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'folder-access',
        waiting: true,
        folderAccess: {
          member: { name: 'tom' },
          feature: { id: 'files', title: 'Files' },
          source: { id: 'cloud-team', title: 'Nextcloud' },
          folder: { title: 'Project Alpha' },
          reason: 'no-address',
        },
      }),
    ])
    const member = (await call(ana, 'GET', `/spaces/${alpha.id}/notifications`)).body.notifications as Doc[]
    expect(member.filter((n) => n.kind === 'folder-access')).toEqual([])
    // the address comes, from the directory: the member is tried again, and the notice ends
    emails.set(tom.principal.id, 'tom@example.org')
    await folders.reconcile((await running.agent.spaces.find(alpha.id)) as never)
    expect((await membersAtStore(cloud, alpha.id))['tom@example.org']).toBe('editor')
    const after = (await call(jonas, 'GET', `/spaces/${alpha.id}/notifications`)).body.notifications as Doc[]
    expect(after.filter((n) => n.kind === 'folder-access' && n.waiting)).toEqual([])
  })
})
