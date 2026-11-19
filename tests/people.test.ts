/**
 * The people of the user directory over the real agent (in-memory store, stub model), with a mocked DIDComm agent and
 * trust resolver (decision 61; ayni-spec D79, D81, D87, D91, D92): IDENT-ROLE-002/012/013/014, IDENT-DIR-006/007/008/009,
 * IDENT-LIVE-004/005, SPACE-MEMB-001/002/004/005/007/008, PROF-DIR-001/003, PROF-SPACE-005/006.
 *
 * A badge "issued from an entry" is the issuance record phase 2b's issuance writes (its shape is tested in
 * tests/revocation.test.ts): the entry, the keyed index of the actor and the registry and index of the credential.
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { actorIdentityOf } from '../src/channels/didcomm/identity.js'
import type { PeopleService } from '../src/core/people.js'
import type { Principal } from '../src/core/types.js'
import {
  BADGE,
  directoryPack,
  HOME,
  type MockServices,
  mintLocally,
  mockServices,
  type Person,
  present as presentOn,
} from './directoryFixtures.js'
import { startTestAgent } from './helpers.js'

const ANA = {
  id: 'p-0042',
  firstName: 'Ana',
  lastName: 'Ríos',
  email: 'ana.rios@northwind.example',
  birthDate: '19910521',
  nationality: 'ESP',
  department: 'Depot Rotterdam',
  groups: ['fleet-safety', 'night-shift'],
  roles: ['dispatcher', 'admin'],
}
const JONAS = {
  id: 'p-0043',
  firstName: 'Jonas',
  lastName: 'Weber',
  email: 'jonas.weber@northwind.example',
  department: 'Depot Rotterdam',
  roles: ['manager'],
}
const PIET = { id: 'p-0044', firstName: 'Piet', lastName: 'de Vries', email: 'piet@northwind.example' }
const MIA = {
  id: 'p-0045',
  firstName: 'Mia',
  lastName: 'Jansen',
  email: 'mia.jansen@northwind.example',
  department: 'Depot Rotterdam',
  groups: ['night-shift'],
  roles: ['dispatcher'],
}
const LENA = { id: 'p-0046', firstName: 'Lena', lastName: 'Bakker', email: 'lena@northwind.example' }

let services: MockServices
let running: RunningAgent
let root: string
let swap: (people: Record<string, unknown>[]) => void

const people = () => running.agent.people as PeopleService
const present = (badgeNumber: string, name: string, opts: { entry?: string; claims?: Record<string, string> } = {}) =>
  presentOn(running, badgeNumber, name, opts)

beforeAll(async () => {
  services = await mockServices()
  const fixture = directoryPack([ANA, JONAS, PIET, MIA, LENA])
  root = fixture.root
  swap = fixture.swap
  running = await startTestAgent({
    agentPackPath: fixture.pack,
    vsAgentAdminUrl: services.url,
    veranaApiUrl: services.url,
    directoryPollSeconds: 0,
  })
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

const fresh = async (p: Person) => (await running.agent.principals.get(p.principal.id)) as Principal

/** Reads the mounted file again now, as its watch would (the watch and the poll are tested in directory.test.ts). */
async function reload(list: Record<string, unknown>[]) {
  swap(list)
  await people().directory?.check()
}

let ana: Person
let jonas: Person
let mia: Person
let karl: Person

describe('roles from the entry, typed by hand (IDENT-ROLE-002/012/014, IDENT-DIR-006)', () => {
  it('gives a person the roles of the entry their badge was issued from, and none from a rule over its claims', async () => {
    ana = await present('BN-ANA', 'Ana Ríos', { entry: 'p-0042', claims: { department: 'Depot Rotterdam' } })
    expect(ana.principal.directoryEntryId).toBe('p-0042')
    // employee from the relation; dispatcher and admin from the entry; no claimrole: the claims of a badge issued from
    // the directory are the entry's fields (IDENT-ROLE-014)
    expect([...ana.principal.roles].sort()).toEqual(['admin', 'dispatcher', 'employee'])
    expect(ana.principal.factRoles).toEqual(['employee'])
    // a badge of the home organization not issued from an entry gets no role from the directory, and the rule over its
    // claims still reads it
    karl = await present('BN-KARL', 'Karl Smit', { claims: { department: 'Depot Rotterdam' } })
    expect(karl.principal.directoryEntryId).toBeUndefined()
    expect(karl.principal.roles).toEqual(['claimrole'])
    jonas = await present('BN-JONAS', 'Jonas Weber', { entry: 'p-0043' })
    expect([...jonas.principal.roles].sort()).toEqual(['employee', 'manager'])
    mia = await present('BN-MIA', 'Mia Jansen', { entry: 'p-0045' })
  })

  it('answers the admin view to an admin only, with who holds which entry (IDENT-DIR-008, PROF-DIR-003)', async () => {
    expect(await call(jonas, 'GET', '/admin/roles')).toMatchObject({ status: 403, body: { error: 'not-admin' } })
    expect(await call(jonas, 'GET', '/admin/changes')).toMatchObject({ status: 403, body: { error: 'not-admin' } })
    const { status, body } = await call(ana, 'GET', '/admin/roles')
    expect(status).toBe(200)
    expect(body.entries).toEqual([
      {
        directoryId: 'p-0042',
        name: 'Ana Ríos',
        department: 'Depot Rotterdam',
        groups: ['fleet-safety', 'night-shift'],
        roles: ['dispatcher', 'admin'],
        onAgent: true,
      },
      {
        directoryId: 'p-0043',
        name: 'Jonas Weber',
        department: 'Depot Rotterdam',
        groups: [],
        roles: ['manager'],
        onAgent: true,
      },
      { directoryId: 'p-0044', name: 'Piet de Vries', department: null, groups: [], roles: [], onAgent: false },
      {
        directoryId: 'p-0045',
        name: 'Mia Jansen',
        department: 'Depot Rotterdam',
        groups: ['night-shift'],
        roles: ['dispatcher'],
        onAgent: true,
      },
      { directoryId: 'p-0046', name: 'Lena Bakker', department: null, groups: [], roles: [], onAgent: false },
    ])
    // the first load: every entry added, newest first, a page at a time
    const first = await call(ana, 'GET', '/admin/changes?limit=2')
    expect(first.body.changes).toHaveLength(2)
    expect(first.body.changes[0]).toMatchObject({ kind: 'added', fields: expect.any(Array) })
    const rest = await call(ana, 'GET', `/admin/changes?limit=10&before=${first.body.nextBefore}`)
    expect(rest.body.nextBefore).toBeNull()
    const all = [...first.body.changes, ...rest.body.changes]
    expect(all.map((c: { directoryId: string }) => c.directoryId).sort()).toEqual([
      'p-0042',
      'p-0043',
      'p-0044',
      'p-0045',
      'p-0046',
    ])
    expect(all.find((c: { directoryId: string }) => c.directoryId === 'p-0042')).toMatchObject({
      name: 'Ana Ríos',
      rolesBefore: [],
      rolesAfter: ['dispatcher', 'admin'],
    })
    // no birthdate, nationality or email in any of it (IDENT-DIR-007)
    const said = JSON.stringify([body, all])
    for (const value of ['19910521', '1991-05-21', 'ESP', 'northwind.example']) expect(said).not.toContain(value)
  })
})

describe('the member picker and the members of a list (SPACE-MEMB-002/005, PROF-DIR-001, PROF-SPACE-005)', () => {
  let project: { id: string }

  it('finds people by name for whoever may add members, with their department only', async () => {
    const found = await call(jonas, 'GET', '/directory?q=rio')
    expect(found).toEqual({
      status: 200,
      body: { people: [{ directoryId: 'p-0042', name: 'Ana Ríos', department: 'Depot Rotterdam' }] },
    })
    expect((await call(jonas, 'GET', '/directory?q=r')).body).toEqual({ people: [] })
    // Karl owns no list space and holds no creator role of a list template
    expect(await call(karl, 'GET', '/directory?q=rio')).toMatchObject({ status: 403, body: { error: 'not-creator' } })
  })

  it('adds a person of the directory: active at once when a Principal holds the entry, else invited', async () => {
    project = (
      await call(jonas, 'POST', '/spaces', { templateId: 'project', title: 'Truck 14 recall', purpose: 'The recall' })
    ).body
    const added = await call(jonas, 'POST', `/spaces/${project.id}/members`, { directoryId: 'p-0042' })
    expect(added).toMatchObject({ status: 201, body: { name: 'Ana Ríos', state: 'active', role: 'member' } })
    const invited = await call(jonas, 'POST', `/spaces/${project.id}/members`, { directoryId: 'p-0044' })
    expect(invited).toMatchObject({ status: 201, body: { name: 'Piet de Vries', state: 'invited', role: 'member' } })
    expect((await call(jonas, 'POST', `/spaces/${project.id}/members`, { directoryId: 'p-0046' })).status).toBe(201)
    // refusals (profile §3.7)
    expect((await call(jonas, 'POST', `/spaces/${project.id}/members`, { directoryId: 'p-0042' })).body.error).toBe(
      'already-member'
    )
    expect((await call(jonas, 'POST', `/spaces/${project.id}/members`, { directoryId: 'p-0043' })).body.error).toBe(
      'already-member'
    )
    expect((await call(jonas, 'POST', `/spaces/${project.id}/members`, { directoryId: 'p-9999' })).status).toBe(404)
    expect((await call(ana, 'POST', `/spaces/${project.id}/members`, { directoryId: 'p-0045' })).body.error).toBe(
      'not-owner'
    )
    expect(await call(jonas, 'POST', `/spaces/${project.id}/members`, {})).toMatchObject({
      status: 400,
      body: { error: 'bad-request' },
    })
    // a person of another organization is invited by email: this agent has no SMTP server (PLAT-MAIL-001, SPACE-INV-001)
    const outsider = await call(jonas, 'POST', `/spaces/${project.id}/members`, {
      organizationKey: 'org:FR:1',
      email: 'x@acme.example',
    })
    expect(outsider).toMatchObject({ status: 503, body: { error: 'email-unavailable' } })
    // Ana reads the space as a member; Piet, invited, holds no Principal yet
    expect((await call(ana, 'GET', `/spaces/${project.id}`)).body).toMatchObject({ role: 'member', state: 'active' })
    const members = (await call(jonas, 'GET', `/spaces/${project.id}`)).body.members
    expect(members.map((m: { name: string; state: string }) => [m.name, m.state])).toEqual([
      ['Jonas Weber', 'active'],
      ['Ana Ríos', 'active'],
      ['Piet de Vries', 'invited'],
      ['Lena Bakker', 'invited'],
    ])
  })

  it('makes the invited person active once their badge from the directory is presented', async () => {
    const piet = await present('BN-PIET', 'Piet de Vries', { entry: 'p-0044' })
    expect((await call(piet, 'GET', `/spaces/${project.id}`)).body).toMatchObject({ role: 'member', state: 'active' })
    const activity = (await call(jonas, 'GET', `/spaces/${project.id}/activity`)).body.activity
    expect(activity[0]).toMatchObject({
      kind: 'joined',
      by: { name: 'Piet de Vries' },
      member: { name: 'Piet de Vries' },
    })
    expect(activity.find((a: { kind: string }) => a.kind === 'invited')).toMatchObject({
      by: { name: 'Jonas Weber' },
      member: { name: 'Lena Bakker' },
    })
    pietRef = piet
  })
})

let pietRef: Person

describe('rule spaces by department and group (SPACE-MEMB-001/007)', () => {
  let depot: { id: string }

  it('makes the people of a department and of a group members, from their entry and never from a claim', async () => {
    depot = (await call(jonas, 'POST', '/spaces', { templateId: 'depot', title: 'Depot Rotterdam', purpose: 'p' })).body
    expect(depot).toBeDefined()
    expect((await call(ana, 'GET', `/spaces/${depot.id}`)).body).toMatchObject({ role: 'member', state: 'active' })
    expect((await call(mia, 'GET', `/spaces/${depot.id}`)).body).toMatchObject({ role: 'member' })
    // Karl's badge claims the department, and no entry gives it: not a member
    expect((await call(karl, 'GET', `/spaces/${depot.id}`)).status).toBe(404)
    expect((await call(pietRef, 'GET', `/spaces/${depot.id}`)).status).toBe(404)
    expect((await call(jonas, 'GET', `/spaces/${depot.id}`)).body.membership).toEqual({
      mode: 'rule',
      rule: { department: 'Depot Rotterdam' },
      memberCount: 3,
    })
    const night = (await call(jonas, 'POST', '/spaces', { templateId: 'night', title: 'Night shift', purpose: 'p' }))
      .body
    expect((await call(mia, 'GET', `/spaces/${night.id}`)).body).toMatchObject({ role: 'member' })
    expect((await call(ana, 'GET', `/spaces/${night.id}`)).body).toMatchObject({ role: 'member' })
    // the members of a rule space follow its rule
    expect((await call(jonas, 'POST', `/spaces/${depot.id}/members`, { directoryId: 'p-0044' })).body.error).toBe(
      'rule-membership'
    )
  })

  it('is given, by directoryId, to a person the rule matches who holds a Principal, and to nobody else', async () => {
    const piet = await call(jonas, 'POST', `/spaces/${depot.id}/owner`, { directoryId: 'p-0044' })
    expect(piet).toMatchObject({ status: 422, body: { error: 'not-eligible' } })
    expect((await call(jonas, 'POST', `/spaces/${depot.id}/owner`, { directoryId: 'p-0046' })).status).toBe(422)
    expect((await call(jonas, 'POST', `/spaces/${depot.id}/owner`, { memberId: 'mem_x' })).status).toBe(422)
    expect((await call(ana, 'POST', `/spaces/${depot.id}/owner`, { directoryId: 'p-0042' })).body.error).toBe(
      'not-owner'
    )
    const given = await call(jonas, 'POST', `/spaces/${depot.id}/owner`, { directoryId: 'p-0042' })
    expect(given).toMatchObject({ status: 200, body: { owner: { name: 'Ana Ríos' } } })
    expect((await call(ana, 'GET', `/spaces/${depot.id}`)).body.role).toBe('owner')
    // the former owner stays a member
    expect((await call(jonas, 'GET', `/spaces/${depot.id}`)).body).toMatchObject({ role: 'member', state: 'active' })
    const activity = (await call(ana, 'GET', `/spaces/${depot.id}/activity`)).body.activity
    expect(activity[0]).toMatchObject({
      kind: 'owner-changed',
      by: { name: 'Jonas Weber' },
      member: { name: 'Ana Ríos' },
    })
    depotRef = depot
  })
})

let depotRef: { id: string }

describe('a reload of the directory (IDENT-ROLE-013, IDENT-DIR-009, D91, SPACE-MEMB-004/008)', () => {
  it('changes roles from the next request, moves people out of rule spaces, and ends the access of who was removed', async () => {
    const piet = pietRef
    const pietRecord = (await running.agent.evidence.issuedFromDirectory('p-0044'))[0]
    expect(pietRecord?.revocation?.revokedAt).toBeUndefined()
    services.calls.length = 0
    // Ana loses admin, Mia moves to Depot Antwerp, Piet and Lena leave the list
    await reload([{ ...ANA, roles: ['dispatcher'] }, JONAS, { ...MIA, department: 'Depot Antwerp' }])

    // three records of the reload, newest first, none with a birthdate (IDENT-DIR-009)
    const audit = (await running.agent.store.adminAudit.list(20, { action: 'directory-change' })).filter(
      (r) => r.reason === 'reload'
    )
    expect(audit.map((r) => [r.detail.kind, r.detail.directoryId, r.detail.fields])).toEqual([
      ['removed', 'p-0046', []],
      ['removed', 'p-0044', []],
      ['changed', 'p-0045', ['department']],
      ['changed', 'p-0042', ['roles']],
    ])

    // Ana's roles change from her next request (IDENT-ROLE-013)
    expect([...(await fresh(ana)).roles].sort()).toEqual(['dispatcher', 'employee'])
    expect(await call(ana, 'GET', '/admin/roles')).toMatchObject({ status: 403, body: { error: 'not-admin' } })

    // Piet: the entry, its roles and every session are gone at once, before he sends anything (IDENT-LIVE-005)
    const gone = await fresh(piet)
    expect(gone.directoryEntryId).toBeUndefined()
    const sessions = await running.agent.store.sessions.listByPrincipal(piet.principal.id)
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    expect(sessions.every((s) => s.state === 'closed' && s.closedReason === 'credential-invalid')).toBe(true)
    expect((await call(piet, 'GET', '/spaces')).status).toBe(410)
    // the badge issued from his entry is revoked by its registry and index, and his wallet is told (INTX-FLOW-007)
    const revoked = services.calls.filter((c) => c.url === '/v2/anoncreds/revoke-credential')
    expect(revoked.map((c) => c.body)).toEqual([
      { revocationRegistryDefinitionId: 'def-badge/revreg-1', revocationRegistryIndex: piet.slot },
    ])
    const told = services.calls.filter((c) => c.url === '/v2/didcomm/revocation-notification')
    expect(told.map((c) => c.body)).toEqual([
      expect.objectContaining({
        connectionId: piet.connectionId,
        revocationId: `def-badge/revreg-1::${piet.slot}`,
        revocationFormat: 'anoncreds',
      }),
    ])
    // the sessions were closed first, the revocation went next
    const lastClosed = Math.max(...sessions.map((s) => Date.parse(s.closedAt as string)))
    expect(lastClosed).toBeLessThanOrEqual(revoked[0]?.at as number)
    const record = (await running.agent.evidence.issuedFromDirectory('p-0044'))[0]
    expect(record?.revocation).toMatchObject({ revokedAt: '2026-11-19T05:00:00.000Z', reason: 'directory-removal' })
    expect(record?.revocation?.notifiedAt).toBeDefined()
    const revocations = await running.agent.store.adminAudit.list(10, { action: 'credential-revocation' })
    expect(revocations[0]?.detail).toMatchObject({
      evidenceId: pietRecord?.id,
      directoryId: 'p-0044',
      index: piet.slot,
    })
    // a presentation of the revoked badge finds no entry any more
    expect(
      await running.agent.evidence.issuedFromDirectoryTo(actorIdentityOf(HOME, BADGE, ['BN-PIET']))
    ).toBeUndefined()

    // Mia left the depot by the rule, and keeps reading her own conversations of it (SPACE-MEMB-004/008)
    expect(
      (await call(mia, 'GET', '/spaces')).body.spaces.find((s: { id: string }) => s.id === depotRef.id)
    ).toBeUndefined()
    const activity = (await call(ana, 'GET', `/spaces/${depotRef.id}/activity`)).body.activity
    expect(activity[0]).toEqual(expect.objectContaining({ kind: 'left', member: { name: 'Mia Jansen' } }))
    expect(activity[0].by).toBeUndefined()

    // Lena, invited and no longer listed, is removed from the project; Piet's row stays (SPACE-MEMB-004)
    const project = (await call(jonas, 'GET', '/spaces')).body.spaces.find(
      (s: { title: string }) => s.title === 'Truck 14 recall'
    )
    const members = (await call(jonas, 'GET', `/spaces/${project.id}`)).body.members
    expect(members.map((m: { name: string }) => m.name)).toEqual(['Jonas Weber', 'Ana Ríos', 'Piet de Vries'])
    const projectActivity = (await call(jonas, 'GET', `/spaces/${project.id}/activity`)).body.activity
    expect(projectActivity[0]).toMatchObject({ kind: 'removed' })
    expect(projectActivity[0].by).toBeUndefined()

    // the admin view: who holds an entry now
    const roles = (await running.agent.people?.adminRoles({ ...(await fresh(jonas)), roles: ['admin'] }))?.entries
    expect(roles?.map((e) => [e.directoryId, e.onAgent])).toEqual([
      ['p-0042', true],
      ['p-0043', true],
      ['p-0045', true],
    ])
  })

  it('keeps the directory in force when the new file does not validate (IDENT-DIR-001)', async () => {
    const before = (await running.agent.store.adminAudit.list(100)).length
    await reload([{ ...ANA, roles: ['janitor'] }, JONAS, MIA])
    expect(people().directory?.view('p-0042')?.roles).toEqual(['dispatcher'])
    expect((await running.agent.store.adminAudit.list(100)).length).toBe(before)
    expect([...(await fresh(ana)).roles].sort()).toEqual(['dispatcher', 'employee'])
    // corrected: Mia back in Depot Rotterdam is a member of its space again, and its activity says so (SPACE-MEMB-004/008)
    await reload([{ ...ANA, roles: ['dispatcher'] }, JONAS, MIA])
    expect((await call(mia, 'GET', `/spaces/${depotRef.id}`)).body).toMatchObject({ role: 'member', state: 'active' })
    const activity = (await call(ana, 'GET', `/spaces/${depotRef.id}/activity`)).body.activity
    expect(activity[0]).toEqual(expect.objectContaining({ kind: 'joined', member: { name: 'Mia Jansen' } }))
  })

  it('revokes again what the DIDComm agent could not revoke, once it can (D91)', async () => {
    services.failRevoke.n = 1
    services.calls.length = 0
    await reload([{ ...ANA, roles: ['dispatcher'] }, JONAS])
    // Mia's access ended at once, though her badge is not revoked yet
    expect((await fresh(mia)).directoryEntryId).toBeUndefined()
    const sessions = await running.agent.store.sessions.listByPrincipal(mia.principal.id)
    expect(sessions.every((s) => s.state === 'closed')).toBe(true)
    let record = (await running.agent.evidence.issuedFromDirectory('p-0045'))[0]
    expect(record?.revocation?.revokedAt).toBeUndefined()
    expect(record?.revocation?.lastError).toMatch(/503/)
    await people().retry()
    record = (await running.agent.evidence.issuedFromDirectory('p-0045'))[0]
    expect(record?.revocation?.revokedAt).toBe('2026-11-19T05:00:00.000Z')
    expect(record?.revocation?.lastError).toBeUndefined()
    expect(services.calls.filter((c) => c.url === '/v2/anoncreds/revoke-credential')).toHaveLength(2)
    // nothing more to do: a retry asks nothing
    await people().retry()
    expect(services.calls.filter((c) => c.url === '/v2/anoncreds/revoke-credential')).toHaveLength(2)
  })
})
