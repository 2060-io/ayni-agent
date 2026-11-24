/**
 * Invitations of people of other organizations, over the real agent (in-memory store, stub model), with a mocked DIDComm
 * agent, trust resolver and Verana Graph and a mailer that keeps what it is given (decision 62; ayni-spec D90, §7.4):
 * SPACE-INV-001..005, PROF-SPACE-003/005, PROF-DIR-002, PLAT-MAIL-001/002.
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgent, mailWarnings, type RunningAgent } from '../src/app.js'
import { actorIdentityOf } from '../src/channels/didcomm/identity.js'
import { loadPack } from '../src/config/pack.js'
import type { Principal } from '../src/core/types.js'
import type { Mailer, MailMessage } from '../src/platform/mail.js'
import { createLogger } from '../src/util/logger.js'
import {
  AGENT_DID,
  BADGE,
  bindWeb,
  directoryPack,
  type MockServices,
  mintLocally,
  mockServices,
  type Person,
  present as presentOn,
} from './directoryFixtures.js'
import { testEnv } from './helpers.js'

const JONAS = {
  id: 'p-0043',
  firstName: 'Jonas',
  lastName: 'Weber',
  email: 'jonas.weber@northwind.example',
  department: 'Depot Rotterdam',
  roles: ['manager'],
}
const ACME = { key: 'org:FR:111', name: 'Acme Freight', countryCode: 'FR', registryId: '111' }
const BALTIC = { key: 'org:EE:222', name: 'Baltic Haulage', countryCode: 'EE', registryId: '222' }
const OUTSIDE = { key: 'org:GB:444', name: 'Outside Ltd', countryCode: 'GB', registryId: '444' }

let services: MockServices
let running: RunningAgent
let root: string
const sent: MailMessage[] = []
const failing = { next: false }
const mailer: Mailer = {
  from: 'Fleet support <fleet@northwind.example>',
  send: async (message) => {
    if (failing.next) {
      failing.next = false
      throw new Error('the SMTP server is out of reach')
    }
    sent.push(message)
    return `mail-${sent.length}`
  },
}

beforeAll(async () => {
  services = await mockServices()
  services.organizations.push(
    { name: ACME.name, countryCode: 'FR', registryId: '111' },
    { name: BALTIC.name, countryCode: 'EE', registryId: '222' },
    { name: 'Untrusted Movers', countryCode: 'DE', registryId: '333', trusted: false },
    { name: OUTSIDE.name, countryCode: 'GB', registryId: '444' }
  )
  const fixture = directoryPack([JONAS], {
    authenticationStores: ['name', 'email'],
    acceptedOrganizations: ['org:NL:12345678', ACME.key, BALTIC.key, 'org:DE:333', 'org:FR:999'],
    // the people of Estonian organizations are partners: no rule gives them a role
    partners: ['EE'],
  })
  root = fixture.root
  running = await buildAgent(
    testEnv({
      agentPackPath: fixture.pack,
      vsAgentAdminUrl: services.url,
      veranaApiUrl: services.url,
      veranaGraphUrl: services.url,
      directoryPollSeconds: 0,
    }),
    createLogger('silent'),
    { drainMs: 200, mailer }
  )
  mintLocally(running)
}, 30_000)

afterAll(async () => {
  await running?.stop()
  await services?.app.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

async function call(
  p: Pick<Person, 'sessionToken'>,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown
) {
  const response = await running.app.inject({
    method,
    url: `/agui/v3/sessions${url}`,
    headers: { authorization: `Bearer ${p.sessionToken}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
  return { status: response.statusCode, body: response.body ? response.json() : undefined }
}

/** A person of another organization presents its badge, with or without its email, and binds a web session. */
async function outsider(
  badgeNumber: string,
  name: string,
  org: typeof ACME,
  email?: string,
  options: { web?: boolean; connection?: string } = {}
): Promise<Person> {
  const actorIdentity = actorIdentityOf(org.key, BADGE, [badgeNumber])
  const connectionId = options.connection ?? `conn-${badgeNumber}`
  const values = { badgeNumber, name, ...(email ? { email } : {}) }
  const { principal } = await running.agent.onPeerConnected(
    {
      connectionType: 'verifiable-user-agent',
      actorIdentity,
      backingIdentity: { kind: 'org', id: org.key, name: org.name },
      organization: {
        key: org.key,
        name: org.name,
        attributes: { countryCode: org.countryCode, registryId: org.registryId },
      },
      claims: { ...values, userName: name },
      userAgentVerified: true,
      identityCredentialRef: `badge:pex-${badgeNumber}`,
      evidence: {
        kind: 'presentation',
        entry: 'authentication',
        schema: BADGE,
        credentialDefinitionId: `def-${org.registryId}`,
        issuerDid: `did:webvh:issuer-${org.registryId}`,
        issuerOrganization: { key: org.key, name: org.name },
        values,
        ...(email ? {} : { unrevealed: ['email'] }),
      },
    },
    connectionId,
    { name: 'Ayni', version: '1.0.0', platform: 'ios' },
    { welcome: false }
  )
  if (options.web === false) return { principal, sessionId: '', sessionToken: '', connectionId }
  return { principal, ...(await bindWeb(running, principal, connectionId)), connectionId }
}

const presentationsTo = (connectionId: string) =>
  services.calls.filter((c) => c.url === '/v2/didcomm/presentation-request' && c.body.connectionId === connectionId)
    .length

let jonas: Person
let project: { id: string }

describe('the organizations of the trust graph (PROF-DIR-002)', () => {
  it('finds organizations by name, once each, trusted only, the agent own excluded', async () => {
    jonas = await presentOn(running, 'BN-JONAS', 'Jonas Weber', { entry: 'p-0043', claims: { email: JONAS.email } })
    expect(await call(jonas, 'GET', '/organizations?q=acm')).toEqual({
      status: 200,
      body: { organizations: [{ organizationKey: ACME.key, name: 'Acme Freight', country: 'FR' }] },
    })
    // its own organization is picked from the directory, not invited
    expect((await call(jonas, 'GET', '/organizations?q=northwind')).body.organizations).toEqual([])
    expect((await call(jonas, 'GET', '/organizations?q=untrusted')).body.organizations).toEqual([])
    expect((await call(jonas, 'GET', '/organizations?q=a')).body.organizations).toEqual([])
    // the name contains what was typed, marks and case aside
    expect((await call(jonas, 'GET', '/organizations?q=HAUL')).body.organizations).toEqual([
      { organizationKey: BALTIC.key, name: 'Baltic Haulage', country: 'EE' },
    ])
  })

  it('answers 403 to a person who may add nobody', async () => {
    // a partner (Baltic Haulage) gets no role: it owns no list space and may create none
    const kalle = await outsider('BN-KALLE', 'Kalle Tamm', BALTIC, 'kalle@baltic.example')
    expect(kalle.principal.roles).toEqual([])
    expect(await call(kalle, 'GET', '/organizations?q=acme')).toMatchObject({
      status: 403,
      body: { error: 'not-creator' },
    })
  })
})

describe('an invitation (SPACE-INV-001/002)', () => {
  it('refuses an address, an organization key, the own organization, one not accepted, one not on Verana', async () => {
    project = (
      await call(jonas, 'POST', '/spaces', { templateId: 'project', title: 'Rotterdam handoff', purpose: 'p' })
    ).body
    const invite = (organizationKey: string, email: string) =>
      call(jonas, 'POST', `/spaces/${project.id}/members`, { organizationKey, email })
    expect(await invite(ACME.key, 'not-an-address')).toMatchObject({
      status: 400,
      body: { error: 'bad-request', field: 'email' },
    })
    expect(await invite('Acme', 'marc@acme.example')).toMatchObject({
      status: 400,
      body: { error: 'bad-request', field: 'organizationKey' },
    })
    expect(await invite('org:NL:12345678', 'piet@northwind.example')).toMatchObject({
      status: 422,
      body: { error: 'home-organization' },
    })
    expect(await invite(OUTSIDE.key, 'jane@outside.example')).toMatchObject({
      status: 409,
      body: { error: 'organization-not-accepted' },
    })
    expect(await invite('org:DE:333', 'max@untrusted.example')).toMatchObject({
      status: 422,
      body: { error: 'not-on-verana' },
    })
    expect(await invite('org:FR:999', 'nobody@unknown.example')).toMatchObject({
      status: 422,
      body: { error: 'not-on-verana' },
    })
    expect(sent).toEqual([])
    // a rule space takes no invitation
    const depot = (await call(jonas, 'POST', '/spaces', { templateId: 'depot', title: 'Depot', purpose: 'p' })).body
    expect(
      (await call(jonas, 'POST', `/spaces/${depot.id}/members`, { organizationKey: ACME.key, email: 'x@acme.example' }))
        .body.error
    ).toBe('rule-membership')
  })

  it('records an invited guest, sends one email with the app link and nothing that opens the space', async () => {
    const created = await call(jonas, 'POST', `/spaces/${project.id}/members`, {
      organizationKey: ACME.key,
      email: 'Marc.Petit@acme.example',
    })
    expect(created).toEqual({
      status: 201,
      body: {
        memberId: expect.stringMatching(/^mem_/),
        name: 'marc.petit@acme.example',
        organization: 'Acme Freight',
        state: 'invited',
        role: 'guest',
      },
    })
    expect(sent).toHaveLength(1)
    const mail = sent[0] as MailMessage
    expect(mail.to).toBe('marc.petit@acme.example')
    const agent = running.agent.pack.metadata.displayName
    expect(mail.subject).toBe(`Jonas Weber invites you to "Rotterdam handoff" with ${agent}`)
    expect(mail.text).toContain(
      `Jonas Weber invites you to the space "Rotterdam handoff" of ${agent}, the agent of Northwind Logistics.`
    )
    expect(mail.text).toContain('a badge issued by Acme Freight that carries this address, marc.petit@acme.example')
    expect(mail.text).toContain(`https://app.ayni.org/app/service/${AGENT_DID}`)
    // no token, no code, no invitation of the DIDComm agent: the link opens the agent and nothing else
    expect(mail.text).not.toMatch(/tok_|oob|\?|grant|\b\d{6}\b/)
    expect(
      (
        await call(jonas, 'POST', `/spaces/${project.id}/members`, {
          organizationKey: ACME.key,
          email: 'marc.petit@ACME.example',
        })
      ).body.error
    ).toBe('already-member')
    const activity = (await call(jonas, 'GET', `/spaces/${project.id}/activity`)).body.activity
    expect(activity[0]).toMatchObject({ kind: 'invited', by: { name: 'Jonas Weber' } })
    expect(JSON.stringify(activity)).not.toContain('marc')
  })

  it('creates no invitation whose email could not be sent', async () => {
    failing.next = true
    const refused = await call(jonas, 'POST', `/spaces/${project.id}/members`, {
      organizationKey: ACME.key,
      email: 'lea@acme.example',
    })
    expect(refused).toMatchObject({ status: 503, body: { error: 'email-unavailable' } })
    const members = (await call(jonas, 'GET', `/spaces/${project.id}`)).body.members
    expect(members.map((m: { name: string }) => m.name)).toEqual(['Jonas Weber', 'marc.petit@acme.example'])
  })
})

describe('the invitation binds to a badge of that organization carrying that address (SPACE-INV-003/005)', () => {
  let marc: Person

  it('grants nothing to a badge of another organization, nor to one with another address', async () => {
    await outsider('BN-MARC-EE', 'Marc Petit', BALTIC, 'marc.petit@acme.example')
    await outsider('BN-PAUL', 'Paul Roux', ACME, 'paul.roux@acme.example')
    const members = (await call(jonas, 'GET', `/spaces/${project.id}`)).body.members
    expect(members.find((m: { organization: string }) => m.organization === 'Acme Freight')?.state).toBe('invited')
  })

  it('binds the first presentation of the issuer and the address, case aside, as an active guest', async () => {
    marc = await outsider('BN-MARC', 'Marc Petit', ACME, 'MARC.PETIT@acme.example')
    const members = (await call(jonas, 'GET', `/spaces/${project.id}`)).body.members
    expect(members).toContainEqual({
      memberId: expect.any(String),
      name: 'Marc Petit',
      organization: 'Acme Freight',
      state: 'active',
      role: 'guest',
    })
    const spaces = (await call(marc, 'GET', '/spaces')).body.spaces as { id: string; role: string }[]
    expect(spaces.find((s) => s.id === project.id)?.role).toBe('guest')
    // a second presentation of the same address binds nothing more: the invitation is the first one's
    const twin = await outsider('BN-MARC-2', 'Marc Petit', ACME, 'marc.petit@acme.example')
    const theirs = (await call(twin, 'GET', '/spaces')).body.spaces as { id: string }[]
    expect(theirs.some((s) => s.id === project.id)).toBe(false)
  })

  it('lets the guest talk in the space and read what is shared with it, and nothing else (SPACE-INV-005)', async () => {
    const own = await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      headers: { authorization: `Bearer ${marc.sessionToken}` },
      payload: {
        client: { name: 'ayni-ui', version: '3.3.0', platform: 'web' },
        locale: 'en',
        newConversation: true,
        spaceId: project.id,
      },
    })
    expect(own.statusCode).toBe(201)
    const conversation = (await running.agent.sessions.get(own.json().sessionId))?.conversationId as string
    expect((await running.agent.sessions.conversationById(conversation))?.spaceId).toBe(project.id)
    // Jonas shares a conversation of the space: the guest reads it
    const shared = await running.app.inject({
      method: 'POST',
      url: '/agui/v3/sessions',
      headers: { authorization: `Bearer ${jonas.sessionToken}` },
      payload: {
        client: { name: 'ayni-ui', version: '3.3.0', platform: 'web' },
        locale: 'en',
        newConversation: true,
        spaceId: project.id,
      },
    })
    const sharedId = (await running.agent.sessions.get(shared.json().sessionId))?.conversationId as string
    expect((await call(jonas, 'POST', `/conversations/${sharedId}/share`)).status).toBe(200)
    const list = (await call(marc, 'GET', `/spaces/${project.id}/shared`)).body.conversations
    expect(list.map((c: { id: string }) => c.id)).toEqual([sharedId])
    // the space's activity is its owner's
    expect((await call(marc, 'GET', `/spaces/${project.id}/activity`)).status).toBe(403)
  })
})

describe('a person the agent knows already (SPACE-INV-004)', () => {
  it('binds at once, asking nothing, the one whose stored email matches', async () => {
    const lea = await outsider('BN-LEA', 'Léa Martin', ACME, 'lea.martin@acme.example')
    const before = presentationsTo(lea.connectionId)
    const created = await call(jonas, 'POST', `/spaces/${project.id}/members`, {
      organizationKey: ACME.key,
      email: 'lea.martin@acme.example',
    })
    expect(created.body).toMatchObject({ name: 'Léa Martin', state: 'active', role: 'guest' })
    expect(presentationsTo(lea.connectionId)).toBe(before)
  })

  it('asks once for the email a Principal of that organization did not reveal, now when its wallet is connected', async () => {
    const hugo = await outsider('BN-HUGO', 'Hugo Blanc', ACME)
    expect(presentationsTo(hugo.connectionId)).toBe(0)
    const created = await call(jonas, 'POST', `/spaces/${project.id}/members`, {
      organizationKey: ACME.key,
      email: 'hugo.blanc@acme.example',
    })
    expect(created.body).toMatchObject({ state: 'invited' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(presentationsTo(hugo.connectionId)).toBe(1)
  })

  it('asks one that was not connected at its next connection, once', async () => {
    // Nora connects while Hugo's invitation waits: her evidence holds no email, so she is asked for it once
    const nora = await outsider('BN-NORA', 'Nora Lemaire', ACME, undefined, { web: false })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(presentationsTo(nora.connectionId)).toBe(1)
    await running.agent.onPeerDisconnected(nora.connectionId)
    expect(((await running.agent.principals.get(nora.principal.id)) as Principal).capabilityChannelId).toBeNull()
    await call(jonas, 'POST', `/spaces/${project.id}/members`, {
      organizationKey: ACME.key,
      email: 'nora.lemaire@acme.example',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(presentationsTo(nora.connectionId)).toBe(1)
    // she comes back on a new connection: asked once for the new invitation, and not again at the connection after
    const back = await outsider('BN-NORA', 'Nora Lemaire', ACME, undefined, { web: false, connection: 'conn-nora-2' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(presentationsTo(back.connectionId)).toBe(1)
    await running.agent.onPeerDisconnected(back.connectionId)
    const again = await outsider('BN-NORA', 'Nora Lemaire', ACME, undefined, { web: false, connection: 'conn-nora-3' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(presentationsTo(again.connectionId)).toBe(0)
  })
})

describe('what the agent says at start (PLAT-MAIL-001, SPACE-INV-004)', () => {
  it('names the templates without SMTP, an authentication that keeps no email, a missing trust graph', () => {
    const fixture = directoryPack([JONAS])
    try {
      const { pack } = loadPack(fixture.pack)
      const warnings = mailWarnings(pack, false, false)
      expect(warnings).toHaveLength(3)
      expect(warnings[0]).toContain('the invitations of other organizations are disabled for the templates [project]')
      expect(warnings[1]).toContain('does not both ask for and store email')
      expect(warnings[2]).toContain('VERANA_GRAPH_URL is not set')
      expect(mailWarnings(pack, true, true)).toHaveLength(1)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
