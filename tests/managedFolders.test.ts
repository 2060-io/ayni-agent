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
import { CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, type RunningAgent } from '../src/app.js'
import type { Principal } from '../src/core/types.js'
import type { ManagedFolders } from '../src/features/managedFolders.js'
import { httpsUrlOf, REREAD_EVERY, requestIdOf } from '../src/features/managedFolders.js'
import { FILES_1_0 } from '../src/features/profiles.js'
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

async function open(d: Device, spaceId: string): Promise<Device> {
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

function run(d: Pick<Device, 'sessionId' | 'sessionToken'>, text: string, ayni?: Doc) {
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
const activityOf = async (spaceId: string, d: Device = jonas) =>
  ((await call(d, 'GET', `/spaces/${spaceId}/activity`)).body.activity as Doc[]).map((a) => a.kind)
const folderOf = (spaceId: string) => running.agent.store.managedFolders.get(spaceId, 'files')
const membershipsOf = (spaceId: string) => running.agent.store.folderMemberships.listByFolder(spaceId, 'files')
const teamOf = async (provider: FakeProvider, spaceId: string) => {
  const ref = (await folderOf(spaceId))?.ref as string
  return provider.teamRoots.get(ref)
}
const membersAtStore = async (provider: FakeProvider, spaceId: string) =>
  Object.fromEntries(((await teamOf(provider, spaceId))?.shares ?? []).map((s) => [s.recipient.address, s.role]))
const lastUserText = () => {
  const user = (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'user').at(-1)
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content)
}
const toolAnswers = () =>
  (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))
const definitionNames = () => (model.requests.at(-1)?.tools ?? []).map((t) => t.name)

let jonas: Device
let ana: Device
let lena: Device
let piet: Device
let tom: Device
let mia: Device
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
          { header: 'Ayni-Dav-Username', value: '$' + '{AYNI_TEST_MANAGER_NAME}' },
          { header: 'Ayni-Dav-Password', value: '$' + '{AYNI_TEST_MANAGER_PASSWORD}' },
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
  mia = await device('mia', ['employee'], 'mia@example.org')
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

/** A Principal's membership of a space's folder, as the agent records it. */
const membershipOf = async (spaceId: string, d: Device) =>
  (await membershipsOf(spaceId)).find((m) => m.principalId === d.principal.id)
/** A membership's next try made due now, as if its wait had passed. */
const dueNow = async (spaceId: string, d: Device, extra: Doc = {}) => {
  const m = await membershipOf(spaceId, d)
  if (!m) throw new Error('no membership')
  await running.agent.store.folderMemberships.save({
    ...m,
    nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    ...extra,
  })
}
const tokenOf = (d: Device) => `tok_${d.connectionId.replace(/[^A-Za-z0-9]/g, '')}Token`
const sharesFor = (provider: FakeProvider, address: string) =>
  provider.calls.filter(
    (c) =>
      c.name === 'files_share' && (c.args.recipients as { address: string }[] | undefined)?.[0]?.address === address
  )

describe("keeping the folder's members in step with the space (TOOL-FEAT-027)", () => {
  it('ends a membership first, then makes the new ones, at the change of the space', async () => {
    await addMember(alpha.id, mia.principal.id)
    const from = cloud.calls.length
    const anaShare = (await membershipOf(alpha.id, ana))?.shareId
    expect(anaShare).toBeDefined()
    expect(
      (await call(jonas, 'DELETE', `/spaces/${alpha.id}/members/mem_${alpha.id}_${ana.principal.id}`)).status
    ).toBe(204)
    const made = cloud.calls.slice(from).map((c) => c.name)
    expect(made.indexOf('files_unshare')).toBeGreaterThanOrEqual(0)
    expect(made.indexOf('files_unshare')).toBeLessThan(made.indexOf('files_share'))
    expect(cloud.calls.slice(from).find((c) => c.name === 'files_unshare')?.args.share).toBe(anaShare)
    expect(await membershipOf(alpha.id, ana)).toBeUndefined()
    expect(await membersAtStore(cloud, alpha.id)).toMatchObject({ 'mia@example.org': 'editor' })
    expect((await membersAtStore(cloud, alpha.id))['ana@example.org']).toBeUndefined()
  })

  it('reads the members and the name back every six hours, makes again what the store lost, leaves who it did not add', async () => {
    const team = await teamOf(cloud, alpha.id)
    if (!team) throw new Error('no team root')
    team.shares = team.shares.filter((s) => s.recipient.address !== 'mia@example.org')
    team.shares.push({
      id: 'sh-boss',
      role: 'editor',
      recipient: { address: 'boss@example.org', name: 'Boss' },
      inherited: false,
    })
    team.title = 'Alpha (renamed at the store)'
    // not yet six hours: nothing is read back
    const from = cloud.calls.length
    await folders.tick()
    expect(cloud.calls.slice(from).filter((c) => c.name === 'files_shares')).toHaveLength(0)
    await folders.tick(Date.now() + REREAD_EVERY + 1000)
    expect(cloud.calls.slice(from).map((c) => c.name)).toEqual(expect.arrayContaining(['files_shares', 'files_get']))
    expect(await membersAtStore(cloud, alpha.id)).toMatchObject({
      'mia@example.org': 'editor',
      'boss@example.org': 'editor',
    })
    expect(cloud.calls.slice(from).filter((c) => c.name === 'files_unshare')).toHaveLength(0)
    const folder = (await filesOf(jonas, alpha.id)).folder
    expect(folder).toMatchObject({ title: 'Alpha (renamed at the store)', addedOutside: 1 })
    expect((await call(jonas, 'GET', `/spaces/${alpha.id}`)).body.addedOutside).toEqual([{ name: 'Boss' }])
    // the name read back is the location's label; it is not changed back (TOOL-FEAT-030)
    expect((await running.agent.store.spaceTools.get(alpha.id, 'cloud-team'))?.list?.entries?.[0]?.label).toBe(
      'Alpha (renamed at the store)'
    )
    expect(cloud.calls.slice(from).filter((c) => c.name === 'files_rename_root')).toHaveLength(0)
  })
})

describe('a change of the members that fails (TOOL-FEAT-028, PROF-TOOL-041, PROF-TOOL-042)', () => {
  let zoe: Device
  let zoeAlpha: Device

  it('tries one that passes again after 1 and 5 minutes, or the wait the store asks, and the member has no tools meanwhile', async () => {
    zoe = await device('zoe', ['employee'], 'zoe@example.org')
    cloud.failures.push(
      { tool: 'files_share', code: 'unavailable', address: 'zoe@example.org' },
      { tool: 'files_share', code: 'unavailable', address: 'zoe@example.org' },
      { tool: 'files_share', code: 'rate-limited', retryAfterSeconds: 120, address: 'zoe@example.org' }
    )
    await addMember(alpha.id, zoe.principal.id)
    const put = await call(zoe, 'PUT', '/connections/cloud-team/account', {
      values: { token: tokenOf(zoe) },
      spaceId: alpha.id,
    })
    expect(put.status).toBe(200)
    let at = Date.now()
    await running.agent.spaces.membersChanged(alpha.id)
    let m = await membershipOf(alpha.id, zoe)
    expect(m).toMatchObject({ state: 'pending', reason: 'unavailable', attempts: 1 })
    expect(Date.parse(m?.nextAttemptAt as string) - at).toBeGreaterThanOrEqual(59_000)
    expect(Date.parse(m?.nextAttemptAt as string) - at).toBeLessThan(65_000)
    // the owner is told: the count on the item, the member list, the activity and one notice
    expect((await filesOf(jonas, alpha.id)).folder.access).toEqual({ inPlace: 5, pending: 1, failed: 0 })
    const detail = (await call(jonas, 'GET', `/spaces/${alpha.id}`)).body
    expect((detail.members as Doc[]).find((x) => x.name === 'zoe')?.folderAccess).toEqual({
      state: 'pending',
      role: 'editor',
      reason: 'unavailable',
    })
    const notices = (await call(jonas, 'GET', `/spaces/${alpha.id}/notifications`)).body.notifications as Doc[]
    expect(notices.filter((n) => n.kind === 'folder-access' && n.waiting).map((n) => n.folderAccess.member)).toEqual([
      { name: 'zoe' },
    ])
    // Zoe is given none of the feature's tools, and the model reads why
    zoeAlpha = await open(zoe, alpha.id)
    expect((await filesOf(zoe, alpha.id)).folder).toMatchObject({ myAccess: 'pending' })
    model.script = [{ text: 'Not yet.' }]
    await run(zoeAlpha, 'what is in the folder?')
    expect(definitionNames()).not.toContain('files_list')
    expect(lastUserText()).toContain("the person's access to this space's files is not ready yet")
    // not due: not tried
    const tries = () => sharesFor(cloud, 'zoe@example.org').length
    await folders.tick()
    expect(tries()).toBe(1)
    await dueNow(alpha.id, zoe)
    at = Date.now()
    await folders.tick()
    m = await membershipOf(alpha.id, zoe)
    expect(tries()).toBe(2)
    expect(m?.attempts).toBe(2)
    expect(Date.parse(m?.nextAttemptAt as string) - at).toBeGreaterThanOrEqual(5 * 60_000 - 1000)
    expect(Date.parse(m?.nextAttemptAt as string) - at).toBeLessThan(5 * 60_000 + 5000)
    await dueNow(alpha.id, zoe)
    at = Date.now()
    await folders.tick()
    m = await membershipOf(alpha.id, zoe)
    expect(Date.parse(m?.nextAttemptAt as string) - at).toBeGreaterThanOrEqual(119_000)
    expect(Date.parse(m?.nextAttemptAt as string) - at).toBeLessThan(125_000)
    await dueNow(alpha.id, zoe)
    await folders.tick()
    expect(await membershipOf(alpha.id, zoe)).toMatchObject({ state: 'in-place', attempts: 0 })
    const after = (await call(jonas, 'GET', `/spaces/${alpha.id}/notifications`)).body.notifications as Doc[]
    expect(after.filter((n) => n.kind === 'folder-access' && n.waiting)).toEqual([])
    model.script = [{ text: 'Here.' }]
    await run(zoeAlpha, 'and now?')
    expect(definitionNames()).toContain('files_list')
    expect(lastUserText()).not.toContain('not ready yet')
  })

  it('leaves one that passes failed after a day of tries, and the owner tries again', async () => {
    cloud.failures.push({ tool: 'files_share', code: 'unavailable', address: 'zoe@example.org' })
    const team = await teamOf(cloud, alpha.id)
    if (!team) throw new Error('no team root')
    team.shares = team.shares.filter((s) => s.recipient.address !== 'zoe@example.org')
    await dueNow(alpha.id, zoe, {
      state: 'pending',
      attempts: 20,
      firstFailedAt: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    })
    await folders.tick()
    expect(await membershipOf(alpha.id, zoe)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    const tries = sharesFor(cloud, 'zoe@example.org').length
    await folders.tick()
    expect(sharesFor(cloud, 'zoe@example.org')).toHaveLength(tries)
    const checked = await call(jonas, 'PATCH', `/spaces/${alpha.id}/tools/cloud-team`, { folder: { check: true } })
    expect(checked.status).toBe(202)
    expect(await membershipOf(alpha.id, zoe)).toMatchObject({ state: 'in-place' })
  })

  it('leaves one refused for a reason that stays failed at once, until the owner tries again', async () => {
    const kim = await device('kim', ['employee'])
    cloud.refuse.set('kim@partner.example', 'not-allowed')
    await addMember(alpha.id, kim.principal.id, 'guest', 'kim@partner.example')
    await running.agent.spaces.membersChanged(alpha.id)
    expect(await membershipOf(alpha.id, kim)).toMatchObject({ state: 'failed', reason: 'not-allowed' })
    const tries = sharesFor(cloud, 'kim@partner.example').length
    await dueNow(alpha.id, kim)
    await folders.tick(Date.now() + 2 * 3_600_000)
    expect(sharesFor(cloud, 'kim@partner.example')).toHaveLength(tries)
    expect((await filesOf(jonas, alpha.id)).folder.access.failed).toBe(1)
    const detail = (await call(jonas, 'GET', `/spaces/${alpha.id}`)).body
    expect((detail.members as Doc[]).find((x) => x.name === 'kim')?.folderAccess).toEqual({
      state: 'failed',
      role: 'editor',
      reason: 'not-allowed',
    })
    cloud.refuse.delete('kim@partner.example')
    expect(
      (await call(jonas, 'PATCH', `/spaces/${alpha.id}/tools/cloud-team`, { folder: { check: true } })).status
    ).toBe(202)
    expect(await membershipOf(alpha.id, kim)).toMatchObject({ state: 'in-place' })
  })

  it('tries a removal every hour until it is done', async () => {
    cloud.failures.push({ tool: 'files_unshare', code: 'unavailable' })
    const at = Date.now()
    await call(jonas, 'DELETE', `/spaces/${alpha.id}/members/mem_${alpha.id}_${zoe.principal.id}`)
    const m = await membershipOf(alpha.id, zoe)
    expect(m?.state).toBe('removing')
    expect(Date.parse(m?.nextAttemptAt as string) - at).toBeGreaterThanOrEqual(3_600_000 - 1000)
    await folders.tick()
    expect((await membershipOf(alpha.id, zoe))?.state).toBe('removing')
    await dueNow(alpha.id, zoe)
    await folders.tick()
    expect(await membershipOf(alpha.id, zoe)).toBeUndefined()
    expect((await membersAtStore(cloud, alpha.id))['zoe@example.org']).toBeUndefined()
  })
})

describe("what the owner's and the member's sessions hear (PROF-TOOL-041)", () => {
  it("announces a change of a member's access to the owner's sessions and to that member's, with no change id", async () => {
    const noa = await device('noa', ['employee'], 'noa@example.org')
    await addMember(alpha.id, noa.principal.id)
    const noaAlpha = await open(noa, alpha.id)
    const jonasAlpha = await open(jonas, alpha.id)
    await running.agent.spaces.membersChanged(alpha.id)
    const heard = (sessionId: string) => {
      const chunks: string[] = []
      running.streams.attach(sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
      return parseSse(chunks.join(''))
        .map((e) => e.event as Doc)
        .filter((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.spaceToolsChanged)
        .map((e) => e.value)
    }
    const value = { spaceId: alpha.id, feature: 'files', source: 'cloud-team', state: 'ready', outcome: 'applied' }
    expect(heard(noaAlpha.sessionId)).toContainEqual(value)
    expect(heard(jonasAlpha.sessionId)).toContainEqual(value)
    expect((await membershipOf(alpha.id, noa))?.state).toBe('in-place')
  })
})

describe('what the model is given of a managed folder (TOOL-FEAT-025, TOOL-FEAT-031)', () => {
  it('never gives the tools of team-roots, and refuses in code a share of the folder itself', async () => {
    expect(
      (
        await call(mia, 'PUT', '/connections/cloud-team/account', {
          values: { token: tokenOf(mia) },
          spaceId: alpha.id,
        })
      ).status
    ).toBe(200)
    const miaAlpha = await open(mia, alpha.id)
    // the mark of the space's provider, made at the first turn that gives its tools (TOOL-FEAT-016)
    model.script = [{ text: 'Ready.' }]
    await run(miaAlpha, 'hello')
    const mark = (await running.agent.store.featureMarks.get(alpha.id, 'files'))?.mark
    const ref = (await folderOf(alpha.id))?.ref
    const from = cloud.calls.length
    model.script = [
      {
        calls: [
          {
            name: 'files_share',
            arguments: { ref: `${mark}~${ref}`, role: 'editor', recipients: [{ address: 'someone@example.org' }] },
          },
        ],
      },
      { text: 'Only the owner changes that.' },
    ]
    await run(miaAlpha, 'give someone access to our folder')
    expect(definitionNames()).toEqual(expect.arrayContaining(['files_list', 'files_share', 'files_unshare']))
    expect(definitionNames()).not.toContain('files_create_team_root')
    expect(definitionNames()).not.toContain('files_rename_root')
    expect(toolAnswers().at(-1)).toMatch(
      /^managed-root: who belongs to this space's folder follows the space's members/
    )
    expect(cloud.calls.slice(from)).toEqual([])
    const records = await running.agent.store.toolCalls.list({
      spaceId: alpha.id,
      principalId: mia.principal.id,
      limit: 5,
    })
    expect(records[0]).toMatchObject({ toolName: 'files_share', outcome: 'managed-root' })
    expect(ph.callsOf('sendConfirmRequest').filter((c) => JSON.stringify(c).includes('someone@example.org'))).toEqual(
      []
    )
    // an item inside it follows the rules of the profile and of the space
    model.script = [
      {
        calls: [
          {
            name: 'files_share',
            arguments: { ref: `${mark}~f-q3`, role: 'reader', recipients: [{ address: 'lena@example.org' }] },
          },
        ],
      },
      { text: 'Shared.' },
    ]
    const turn = run(miaAlpha, 'share Q3 with Lena')
    const conversationId = (await running.agent.sessions.get(miaAlpha.sessionId))?.conversationId
    let card: { id: string } | undefined
    await until(async () => {
      card = (await running.agent.store.approvals.list({ status: 'PENDING' })).find(
        (r) => r.conversationId === conversationId
      )
      return !!card
    })
    await run(miaAlpha, '', { kind: 'approval.decide', approvalId: card?.id, decision: 'reject' })
    await turn
    const inside = await running.agent.store.toolCalls.list({
      spaceId: alpha.id,
      principalId: mia.principal.id,
      limit: 5,
    })
    expect(inside[0]?.outcome).not.toBe('managed-root')
  }, 15_000)
})

describe("the folder's name (TOOL-FEAT-030, PROF-TOOL-043)", () => {
  it('is renamed by the owner alone, at once and with no phone, and not by a rename of the space', async () => {
    const patch = (d: Device, body: Doc) => call(d, 'PATCH', `/spaces/${alpha.id}/tools/cloud-team`, body)
    expect(await patch(mia, { folder: { title: 'Mine' } })).toMatchObject({ status: 403, body: { error: 'not-owner' } })
    for (const title of ['a/b', '', ' ', 'x'.repeat(101), '..'])
      expect(await patch(jonas, { folder: { title } })).toMatchObject({
        status: 422,
        body: { error: 'bad-name', field: 'folder.title' },
      })
    const asked = ph.callsOf('sendConfirmRequest').length
    const renamed = await patch(jonas, { folder: { title: 'Alpha Files' } })
    expect(renamed.status).toBe(200)
    expect(renamed.body.tool.folder.title).toBe('Alpha Files')
    expect(ph.callsOf('sendConfirmRequest')).toHaveLength(asked)
    const call0 = cloud.calls.filter((c) => c.name === 'files_rename_root').at(-1)
    expect(call0?.args).toEqual({ root: (await folderOf(alpha.id))?.ref, name: 'Alpha Files' })
    expect(call0?.headers['ayni-dav-username']).toBe('ayni-manager')
    expect((await teamOf(cloud, alpha.id))?.title).toBe('Alpha Files')
    expect((await activityOf(alpha.id))[0]).toBe('folder-renamed')
    expect((await call(jonas, 'PATCH', `/spaces/${alpha.id}`, { title: 'Project Alpha 2' })).status).toBe(200)
    expect((await folderOf(alpha.id))?.name).toBe('Alpha Files')
    expect(await patch(jonas, { folder: {} })).toMatchObject({ status: 400, body: { error: 'bad-request' } })
  })

  it('answers not-managed for Files in the existing mode', async () => {
    const beta = await space('Project Beta', 'existing-only')
    await confirmed(jonas, () => call(jonas, 'POST', `/spaces/${beta.id}/tools`, { source: 'cloud-team' }))
    expect((await filesOf(jonas, beta.id)).location).toBe('existing')
    expect(
      await call(jonas, 'PATCH', `/spaces/${beta.id}/tools/cloud-team`, { folder: { title: 'Beta' } })
    ).toMatchObject({ status: 409, body: { error: 'not-managed' } })
    expect(await folderOf(beta.id)).toBeUndefined()
  })
})

describe("the space's rules of Files change a member's role at the folder (TOOL-FEAT-026, TOOL-FEAT-027)", () => {
  it('makes a writer a reader once every tool that writes or deletes is off in the space', async () => {
    // of the core and of the capabilities in use, which the owner reads with his own account
    expect(
      (
        await call(jonas, 'PUT', '/connections/cloud-team/account', {
          values: { token: tokenOf(jonas) },
          spaceId: alpha.id,
        })
      ).status
    ).toBe(200)
    const writes = FILES_1_0.tools
      .filter(
        (t) =>
          (t.effect === 'write' || t.effect === 'delete') &&
          ['folders', 'search', 'share', undefined].includes(t.capability)
      )
      .map((t) => t.name)
    const res = await call(jonas, 'PATCH', `/spaces/${alpha.id}/tools/cloud-team`, {
      calls: Object.fromEntries(writes.map((name) => [name, 'off'])),
    })
    expect(res.status).toBe(200)
    expect(await membersAtStore(cloud, alpha.id)).toMatchObject({
      'mia@example.org': 'reader',
      'jonas@example.org': 'reader',
      'lena@example.org': 'reader',
    })
    expect((await membershipOf(alpha.id, mia))?.role).toBe('reader')
  })
})

describe("a shared drive managed with the owner's own account (TOOL-FEAT-025, TOOL-FEAT-029, D147)", () => {
  let gamma: { id: string }
  const driveToken = (d: Device, n = 1) => `tok_conn${d.connectionId.replace(/^conn-/, '')}${n > 1 ? n : ''}Token`
  const drivers = () => gdrive.calls.map((c) => c.headers.authorization)

  it("waits for the owner's account, then makes the drive with it, the owner and the successor its managers", async () => {
    gamma = await space('Project Gamma')
    await addMember(gamma.id, ana.principal.id)
    await addMember(gamma.id, mia.principal.id)
    expect(
      (await call(jonas, 'PUT', `/spaces/${gamma.id}/successor`, { memberId: `mem_${gamma.id}_${ana.principal.id}` }))
        .status
    ).toBe(200)
    const asked = await confirmed(jonas, () =>
      call(jonas, 'POST', `/spaces/${gamma.id}/tools`, { source: 'team-drive', location: 'managed' })
    )
    expect(asked.body.tool.pending.summary).toBe(
      'Use Google Drive for Files in Project Gamma. Fleet support makes a shared drive named Project Gamma, owned by ' +
        'your organization, with you as its manager, and gives each member of the space access to it. People outside ' +
        'your organization included.'
    )
    // the owner's account is not connected: Files is setup, the folder waits for it, nothing reaches the store
    await until(async () => (await folderOf(gamma.id))?.state === 'creating')
    const waiting = await filesOf(jonas, gamma.id)
    expect(waiting).toMatchObject({
      state: 'setup',
      location: 'managed',
      folder: { title: 'Project Gamma', state: 'creating', reason: 'not-connected', managedWith: 'owner' },
    })
    expect(gdrive.calls.filter((c) => c.name === 'files_create_team_root')).toEqual([])
    driveAccounts.set(jonas.principal.id, driveToken(jonas))
    await folders.tick()
    expect((await folderOf(gamma.id))?.state).toBe('ready')
    const made = gdrive.calls.find((c) => c.name === 'files_create_team_root')
    expect(made?.headers.authorization).toBe(`Bearer ${driveToken(jonas)}`)
    expect(made?.args.requestId).toBe(requestIdOf(gamma.id, 'files'))
    expect(await membersAtStore(gdrive, gamma.id)).toEqual({
      'jonas@example.org': 'manager',
      'ana@example.org': 'manager',
      'mia@example.org': 'editor',
    })
    // the owner's own membership is the one the store made with the drive: recorded with its share
    expect(await membershipOf(gamma.id, jonas)).toMatchObject({ role: 'manager', shareId: 'sh-1-0', state: 'in-place' })
    expect((await filesOf(jonas, gamma.id)).state).toBe('ready')
    // nobody but the owner's account changed the drive's members
    expect(new Set(drivers())).toEqual(new Set([`Bearer ${driveToken(jonas)}`]))
  })

  it("hands the drive to the new owner with the former owner's account, then manages it with the new one", async () => {
    const from = gdrive.calls.length
    const res = await call(jonas, 'POST', `/spaces/${gamma.id}/owner`, {
      memberId: `mem_${gamma.id}_${mia.principal.id}`,
    })
    expect(res.status).toBe(200)
    const handed = gdrive.calls.slice(from)
    // Mia made a manager first, with Jonas's account, then Jonas's own role set from his membership
    expect(handed[0]).toMatchObject({
      name: 'files_share',
      args: { role: 'manager', recipients: [{ address: 'mia@example.org' }] },
    })
    expect(handed.every((c) => c.headers.authorization === `Bearer ${driveToken(jonas)}`)).toBe(true)
    expect(await membersAtStore(gdrive, gamma.id)).toMatchObject({
      'mia@example.org': 'manager',
      'jonas@example.org': 'editor',
    })
    expect((await folderOf(gamma.id))?.managerPrincipalId).toBe(mia.principal.id)
    // from then on, the new owner's account
    driveAccounts.set(mia.principal.id, driveToken(mia))
    await addMember(gamma.id, lena.principal.id)
    const next = gdrive.calls.length
    await running.agent.spaces.membersChanged(gamma.id)
    expect(gdrive.calls.slice(next).map((c) => c.headers.authorization)).toEqual([`Bearer ${driveToken(mia)}`])
    expect((await membersAtStore(gdrive, gamma.id))['lena@example.org']).toBe('reader')
  })

  it('makes no change with an account the store refused, until that account changes', async () => {
    gdrive.failures.push({ tool: 'files_share', code: 'account-refused' })
    const kai = await device('kai', ['employee'], 'kai@example.org')
    await addMember(gamma.id, kai.principal.id)
    await running.agent.spaces.membersChanged(gamma.id)
    expect(await membershipOf(gamma.id, kai)).toMatchObject({ state: 'failed', reason: 'not-connected' })
    const tries = sharesFor(gdrive, 'kai@example.org').length
    await folders.tick()
    await running.agent.spaces.membersChanged(gamma.id)
    expect(sharesFor(gdrive, 'kai@example.org')).toHaveLength(tries)
    // a new sign-in of the owner: tried again
    driveAccounts.set(mia.principal.id, driveToken(mia, 2))
    await folders.tick()
    expect(await membershipOf(gamma.id, kai)).toMatchObject({ state: 'in-place' })
    expect(sharesFor(gdrive, 'kai@example.org').at(-1)?.headers.authorization).toBe(`Bearer ${driveToken(mia, 2)}`)
  })

  it('reads needs-manager when no account it holds manages the drive, changes no member, and Check again restores it', async () => {
    const delta = await space('Project Delta')
    await addMember(delta.id, ana.principal.id)
    await confirmed(jonas, () =>
      call(jonas, 'POST', `/spaces/${delta.id}/tools`, { source: 'team-drive', location: 'managed' })
    )
    await until(async () => (await folderOf(delta.id))?.state === 'ready')
    // Jonas's account is gone before the hand-over, and Ana has none that manages the drive
    driveAccounts.delete(jonas.principal.id)
    const from = gdrive.calls.length
    await call(jonas, 'POST', `/spaces/${delta.id}/owner`, { memberId: `mem_${delta.id}_${ana.principal.id}` })
    expect(await folderOf(delta.id)).toMatchObject({ state: 'needs-manager', reason: 'manager-gone' })
    expect(await activityOf(delta.id, ana)).toContain('manager-needed')
    const owner = await filesOf(ana, delta.id)
    expect(owner.folder).toMatchObject({ state: 'needs-manager', reason: 'manager-gone', managedWith: 'owner' })
    // the members keep their access, and none is changed
    expect(owner.state).toBe('ready')
    await addMember(delta.id, lena.principal.id)
    await running.agent.spaces.membersChanged(delta.id)
    await folders.tick(Date.now() + REREAD_EVERY + 1000)
    const deltaRef = (await folderOf(delta.id))?.ref
    expect(gdrive.calls.slice(from).filter((c) => c.args.root === deltaRef && c.name !== 'files_shares')).toEqual([])
    expect(await membersAtStore(gdrive, delta.id)).toEqual({
      'jonas@example.org': 'manager',
      'ana@example.org': 'editor',
    })
    // an administrator makes Ana a manager at the store; she signs in; Check again
    const team = await teamOf(gdrive, delta.id)
    const ana0 = team?.shares.find((s) => s.recipient.address === 'ana@example.org')
    if (ana0) ana0.role = 'manager'
    driveAccounts.set(ana.principal.id, driveToken(ana))
    expect((await call(ana, 'PATCH', `/spaces/${delta.id}/tools/team-drive`, { folder: { check: true } })).status).toBe(
      202
    )
    expect(await folderOf(delta.id)).toMatchObject({ state: 'ready', managerPrincipalId: ana.principal.id })
    expect((await membersAtStore(gdrive, delta.id))['lena@example.org']).toBe('reader')
    expect(sharesFor(gdrive, 'lena@example.org').at(-1)?.headers.authorization).toBe(`Bearer ${driveToken(ana)}`)
  })

  it("leaves the folder creating with scope-missing while the owner's account lacks a scope", async () => {
    driveAccounts.set(jonas.principal.id, driveToken(jonas, 3))
    const deps = (folders as unknown as { deps: Doc }).deps
    const server = deps.server
    let asked = 0
    // the server asks the owner's account for more access (TOOL-OAUTH-009), as a 403 insufficient_scope does
    deps.server = (id: string) =>
      id === 'team-drive'
        ? {
            callTool: async (name: string) => {
              if (name !== 'files_create_team_root') return { content: '', data: {}, isError: false }
              asked++
              return { content: 'more access', isError: true, accountOutcome: 'more-access-needed' }
            },
          }
        : server(id)
    try {
      const epsilon = await space('Project Epsilon')
      await confirmed(jonas, () =>
        call(jonas, 'POST', `/spaces/${epsilon.id}/tools`, { source: 'team-drive', location: 'managed' })
      )
      await until(async () => (await folderOf(epsilon.id))?.reason === 'scope-missing')
      expect((await filesOf(jonas, epsilon.id)).folder).toMatchObject({ state: 'creating', reason: 'scope-missing' })
      await folders.tick()
      expect(asked).toBe(1)
      // a new sign-in that grants it
      deps.server = server
      driveAccounts.set(jonas.principal.id, driveToken(jonas, 4))
      await folders.tick()
      expect((await folderOf(epsilon.id))?.state).toBe('ready')
    } finally {
      deps.server = server
    }
  })
})

describe('a folder of the managing account at a change of owner (TOOL-FEAT-029)', () => {
  it("is unchanged but for the members' roles", async () => {
    const zeta = await space('Project Zeta', 'managed-only')
    await addMember(zeta.id, mia.principal.id)
    await confirmed(jonas, () => call(jonas, 'POST', `/spaces/${zeta.id}/tools`, { source: 'cloud-team' }))
    await until(async () => (await folderOf(zeta.id))?.state === 'ready')
    const before = await folderOf(zeta.id)
    const from = cloud.calls.length
    expect(
      (await call(jonas, 'POST', `/spaces/${zeta.id}/owner`, { memberId: `mem_${zeta.id}_${mia.principal.id}` })).status
    ).toBe(200)
    const after = await folderOf(zeta.id)
    expect(after).toMatchObject({ state: 'ready', managedWith: 'manager', ref: before?.ref, name: 'Project Zeta' })
    expect(cloud.calls.slice(from).filter((c) => c.name !== 'files_share' && c.name !== 'files_shares')).toEqual([])
    expect(cloud.calls.slice(from).every((c) => c.headers['ayni-dav-username'] === 'ayni-manager')).toBe(true)
    expect(await membersAtStore(cloud, zeta.id)).toMatchObject({
      'jonas@example.org': 'editor',
      'mia@example.org': 'editor',
    })
  })
})

describe('releasing the folder (TOOL-FEAT-032)', () => {
  it('stops managing it when the provider changes, says so on the phone, and leaves it as it is at the store', async () => {
    const before = await membersAtStore(cloud, alpha.id)
    const ref = (await folderOf(alpha.id))?.ref as string
    const asked = ph.callsOf('sendConfirmRequest').length
    const res = await call(jonas, 'POST', `/spaces/${alpha.id}/tools`, {
      source: 'plain-team',
      replaces: 'cloud-team',
      location: 'existing',
    })
    expect(res.status).toBe(202)
    expect(res.body.tool.pending.summary).toContain(
      'Fleet support stops managing the team folder Alpha Files. It stays at Nextcloud with its members and its files.'
    )
    await until(() => ph.callsOf('sendConfirmRequest').length > asked)
    const from = cloud.calls.length
    await ph.confirm(jonas.connectionId, true)
    await until(async () => !(await folderOf(alpha.id)))
    await folders.tick(Date.now() + REREAD_EVERY + 1000)
    await call(jonas, 'DELETE', `/spaces/${alpha.id}/members/mem_${alpha.id}_${mia.principal.id}`)
    expect(cloud.calls.slice(from).filter((c) => c.args.root === ref)).toEqual([])
    expect(await membershipsOf(alpha.id)).toEqual([])
    expect(cloud.teamRoots.get(ref)?.title).toBe('Alpha Files')
    expect(
      Object.fromEntries((cloud.teamRoots.get(ref)?.shares ?? []).map((s) => [s.recipient.address, s.role]))
    ).toEqual(before)
    expect(await activityOf(alpha.id)).toContain('folder-released')
    const notices = (await call(jonas, 'GET', `/spaces/${alpha.id}/notifications`)).body.notifications as Doc[]
    expect(notices.filter((n) => n.kind === 'folder-access' && n.waiting)).toEqual([])
    expect((await filesOf(jonas, alpha.id)).folder).toBeUndefined()
  })

  it('stops managing it when Files is removed, and makes no call to the store for it', async () => {
    const managed = await space('Project Removed', 'managed-only')
    await confirmed(jonas, () => call(jonas, 'POST', `/spaces/${managed.id}/tools`, { source: 'cloud-team' }))
    await until(async () => (await folderOf(managed.id))?.state === 'ready')
    const from = cloud.calls.length
    const jonasManaged = await open(jonas, managed.id)
    expect((await call(jonas, 'DELETE', `/spaces/${managed.id}/tools/cloud-team`)).status).toBe(200)
    expect(await folderOf(managed.id)).toBeUndefined()
    // Files has no provider any more: the event names none (profile §5)
    const chunks: string[] = []
    running.streams.attach(jonasManaged.sessionId, { write: (c) => chunks.push(c), end: () => undefined }, 0)()
    const told = parseSse(chunks.join(''))
      .map((e) => e.event as Doc)
      .filter((e) => e.type === 'CUSTOM' && e.name === CUSTOM_EVENT.spaceToolsChanged)
      .map((e) => e.value)
    expect(told.at(-1)).toMatchObject({ spaceId: managed.id, feature: 'files', source: null, outcome: 'applied' })
    expect(cloud.calls.slice(from)).toEqual([])
    expect((await activityOf(managed.id)).slice(0, 2)).toEqual(['tool-removed', 'folder-released'])
  })
})

describe('the address a store gives of a folder (PROF-TOOL-041, TOOL-FEAT-017)', () => {
  it('is kept only when it is an https address, since the clients open it as a link', () => {
    expect(httpsUrlOf('https://store.example/folders/team-1')).toBe('https://store.example/folders/team-1')
    for (const other of [
      'javascript:alert(1)',
      'http://store.example/f',
      'data:text/html,x',
      '/folders/1',
      '',
      7,
      null,
    ])
      expect(httpsUrlOf(other)).toBeUndefined()
  })
})
