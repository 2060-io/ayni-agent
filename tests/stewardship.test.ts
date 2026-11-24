/**
 * The owner, the successor and the stewards of a space, over the real agent with a user directory (in-memory store, stub
 * model, a mocked DIDComm agent and trust resolver): ayni-spec D135, D136; SPACE-MEMB-008 to 012, INTX-APPR-027;
 * PROF-SPACE-008, PROF-SPACE-009, PROF-TOOL-038.
 *
 * Jonas owns two projects: Truck 14 recall, whose successor is Ana, and Depot fleet, with none. Ana holds `admin`, the
 * steward role of the Project template. Jonas's entry leaves the directory.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { RunningAgent } from '../src/app.js'
import type { PeopleService } from '../src/core/people.js'
import {
  directoryPack,
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
  department: 'Depot Rotterdam',
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
const MIA = {
  id: 'p-0045',
  firstName: 'Mia',
  lastName: 'Jansen',
  email: 'mia.jansen@northwind.example',
  department: 'Depot Antwerp',
  roles: ['dispatcher'],
}
const PIET = { id: 'p-0044', firstName: 'Piet', lastName: 'de Vries', email: 'piet@northwind.example' }

let services: MockServices
let running: RunningAgent
let root: string
let swap: (people: Record<string, unknown>[]) => void

let ana: Person
let jonas: Person
let mia: Person
let piet: Person
let recall: { id: string }
let fleet: { id: string }

const people = () => running.agent.people as PeopleService

async function call(p: Pick<Person, 'sessionToken'>, method: string, url: string, payload?: unknown) {
  const response = await running.app.inject({
    method: method as 'GET',
    url: `/agui/v3/sessions${url}`,
    headers: { authorization: `Bearer ${p.sessionToken}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
  // biome-ignore lint/suspicious/noExplicitAny: the bodies of the profile, read as they come
  return { status: response.statusCode, body: response.body ? (response.json() as any) : undefined }
}

const memberOf = async (space: { id: string }, name: string): Promise<string> =>
  (await call(jonas, 'GET', `/spaces/${space.id}`)).body.members.find((m: { name: string }) => m.name === name).memberId

beforeAll(async () => {
  services = await mockServices()
  const fixture = directoryPack([ANA, JONAS, MIA, PIET])
  root = fixture.root
  swap = fixture.swap
  // the stewards of the Project template: the admins (SPACE-MEMB-011)
  const file = join(fixture.pack, 'agent-pack.yaml')
  const doc = parseYaml(readFileSync(file, 'utf8'))
  for (const t of doc.spaces.templates) if (t.id === 'project') t.stewards = ['admin']
  writeFileSync(file, stringifyYaml(doc))
  running = await startTestAgent({
    agentPackPath: fixture.pack,
    vsAgentAdminUrl: services.url,
    veranaApiUrl: services.url,
    directoryPollSeconds: 0,
  })
  mintLocally(running)
  ana = await presentOn(running, 'BN-ANA', 'Ana Ríos', { entry: 'p-0042' })
  jonas = await presentOn(running, 'BN-JONAS', 'Jonas Weber', { entry: 'p-0043' })
  mia = await presentOn(running, 'BN-MIA', 'Mia Jansen', { entry: 'p-0045' })
  piet = await presentOn(running, 'BN-PIET', 'Piet de Vries', { entry: 'p-0044' })
  recall = (await call(jonas, 'POST', '/spaces', { templateId: 'project', title: 'Truck 14 recall', purpose: 'p' }))
    .body
  fleet = (await call(jonas, 'POST', '/spaces', { templateId: 'project', title: 'Depot fleet', purpose: 'p' })).body
  for (const directoryId of ['p-0042', 'p-0045'])
    expect((await call(jonas, 'POST', `/spaces/${recall.id}/members`, { directoryId })).status).toBe(201)
  for (const directoryId of ['p-0045', 'p-0044'])
    expect((await call(jonas, 'POST', `/spaces/${fleet.id}/members`, { directoryId })).status).toBe(201)
}, 30_000)

afterAll(async () => {
  await running?.stop()
  await services?.app.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('the successor (SPACE-MEMB-010, PROF-SPACE-008)', () => {
  it('is named and cleared by the owner alone, among the people the space could be handed to', async () => {
    const anaRow = await memberOf(recall, 'Ana Ríos')
    const named = await call(jonas, 'PUT', `/spaces/${recall.id}/successor`, { memberId: anaRow })
    expect(named).toMatchObject({
      status: 200,
      body: { successor: { name: 'Ana Ríos' }, owner: { name: 'Jonas Weber' } },
    })
    expect((await call(ana, 'GET', `/spaces/${recall.id}`)).body.successor).toBeUndefined()
    const own = await call(jonas, 'PUT', `/spaces/${recall.id}/successor`, {
      memberId: await memberOf(recall, 'Jonas Weber'),
    })
    expect(own).toMatchObject({ status: 422, body: { error: 'not-eligible' } })
    expect((await call(ana, 'PUT', `/spaces/${recall.id}/successor`, { memberId: anaRow })).body.error).toBe(
      'not-owner'
    )
    expect((await call(jonas, 'DELETE', `/spaces/${recall.id}/successor`)).body.successor).toBeNull()
    await call(jonas, 'PUT', `/spaces/${recall.id}/successor`, { memberId: anaRow })
    const kinds = (await call(jonas, 'GET', `/spaces/${recall.id}/activity`)).body.activity.map(
      (a: { kind: string }) => a.kind
    )
    expect(kinds.slice(0, 3)).toEqual(['successor-set', 'successor-cleared', 'successor-set'])
  })
})

describe("the owner's entry leaves the directory (D91, D136, SPACE-MEMB-011, SPACE-MEMB-012)", () => {
  it('passes a space to its successor, and leaves one without a successor with no owner, its stewards told', async () => {
    swap([ANA, MIA, PIET])
    await people().directory?.check()
    // succession: Ana owns Truck 14 recall, with no successor; its members are told
    const owned = (await call(ana, 'GET', `/spaces/${recall.id}`)).body
    expect(owned).toMatchObject({ role: 'owner', owner: { name: 'Ana Ríos' }, successor: null })
    const activity = (await call(ana, 'GET', `/spaces/${recall.id}/activity`)).body.activity
    expect(activity.find((a: { kind: string }) => a.kind === 'owner-changed')).toMatchObject({
      how: 'succession',
      member: { name: 'Ana Ríos' },
    })
    const told = (await call(mia, 'GET', `/spaces/${recall.id}/notifications`)).body.notifications
    expect(told.find((n: { kind: string }) => n.kind === 'owner-changed')).toMatchObject({
      waiting: false,
      notice: { how: 'succession', from: { name: 'Jonas Weber' }, to: { name: 'Ana Ríos' } },
    })
    // no successor: Depot fleet has no owner; its conversations go on, what only an owner does waits
    const orphan = (await call(mia, 'GET', `/spaces/${fleet.id}`)).body
    expect(orphan).toMatchObject({ owner: null, role: 'member', state: 'active' })
    expect((await call(mia, 'PATCH', `/spaces/${fleet.id}`, { title: 'Mine' })).body.error).toBe('not-owner')
    // the steward reads it in the agent's Notifications, waiting until an owner is named
    const agentList = (await call(ana, 'GET', '/notifications')).body
    expect(agentList.waiting).toBe(1)
    expect(agentList.notifications[0]).toMatchObject({
      kind: 'space-without-owner',
      waiting: true,
      notice: { space: { title: 'Depot fleet' }, template: { id: 'project' }, formerOwner: { name: 'Jonas Weber' } },
    })
  })
})

describe('the stewards (SPACE-MEMB-011, PROF-SPACE-009)', () => {
  it('lists the spaces of the template and who could own one, to a steward only, who reads nothing else of them', async () => {
    const listed = (await call(ana, 'GET', '/stewardship')).body.spaces
    expect(listed.find((s: { id: string }) => s.id === fleet.id)).toEqual({
      id: fleet.id,
      title: 'Depot fleet',
      templateId: 'project',
      kind: 'team',
      owner: null,
      successor: null,
      memberCount: 2,
    })
    expect(await call(mia, 'GET', '/stewardship')).toMatchObject({ status: 403, body: { error: 'not-steward' } })
    expect((await call(mia, 'GET', `/spaces/${fleet.id}/owner/candidates`)).body.error).toBe('not-steward')
    const candidates = (await call(ana, 'GET', `/spaces/${fleet.id}/owner/candidates`)).body.candidates
    expect(candidates.map((c: { name: string; department: string | null }) => [c.name, c.department])).toEqual([
      ['Mia Jansen', 'Depot Antwerp'],
      ['Piet de Vries', null],
    ])
    // not a member: nothing else of the space
    for (const path of ['', '/activity', '/tools', '/notifications', '/shared'])
      expect((await call(ana, 'GET', `/spaces/${fleet.id}${path}`)).status).toBe(404)
  })

  it('names an owner with a reason, recorded and told; on request too, the former owner staying a member', async () => {
    const miaRow = (await call(ana, 'GET', `/spaces/${fleet.id}/owner/candidates`)).body.candidates[0].memberId
    const bare = await call(ana, 'POST', `/spaces/${fleet.id}/owner`, { memberId: miaRow })
    expect(bare).toMatchObject({ status: 400, body: { error: 'bad-request', field: 'reason' } })
    const long = await call(ana, 'POST', `/spaces/${fleet.id}/owner`, { memberId: miaRow, reason: 'x'.repeat(501) })
    expect(long.status).toBe(400)
    const named = await call(ana, 'POST', `/spaces/${fleet.id}/owner`, {
      memberId: miaRow,
      reason: 'Jonas left the company',
    })
    expect(named).toMatchObject({ status: 200, body: { id: fleet.id, owner: { name: 'Mia Jansen' } } })
    expect((await call(mia, 'GET', `/spaces/${fleet.id}`)).body.role).toBe('owner')
    const activity = (await call(mia, 'GET', `/spaces/${fleet.id}/activity`)).body.activity
    expect(activity[0]).toMatchObject({
      kind: 'owner-changed',
      how: 'steward',
      reason: 'Jonas left the company',
      by: { name: 'Ana Ríos' },
      member: { name: 'Mia Jansen' },
    })
    // the steward's notice is resolved; Ana is still no member
    const agentList = (await call(ana, 'GET', '/notifications')).body
    expect(agentList.waiting).toBe(0)
    expect(agentList.notifications[0].notice.resolvedAt).toBeDefined()
    expect((await call(ana, 'GET', `/spaces/${fleet.id}`)).status).toBe(404)
    // on request, while it has an owner
    const pietRow = (await call(ana, 'GET', `/spaces/${fleet.id}/owner/candidates`)).body.candidates.find(
      (c: { name: string }) => c.name === 'Piet de Vries'
    ).memberId
    const handed = await call(ana, 'POST', `/spaces/${fleet.id}/owner`, { memberId: pietRow, reason: 'Mia asked' })
    expect(handed.body.owner).toEqual({ name: 'Piet de Vries' })
    expect((await call(mia, 'GET', `/spaces/${fleet.id}`)).body).toMatchObject({ role: 'member', state: 'active' })
    expect((await call(piet, 'GET', `/spaces/${fleet.id}/notifications`)).body.notifications[0]).toMatchObject({
      kind: 'owner-changed',
      notice: { how: 'steward', from: { name: 'Mia Jansen' }, to: { name: 'Piet de Vries' }, reason: 'Mia asked' },
    })
  })
})
