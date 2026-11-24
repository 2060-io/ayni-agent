/**
 * What the tests of the user directory share (decision 61): the DIDComm agent and the trust resolver of a deployment,
 * mocked as far as the agent calls them; the dev pack with a directory, the badge that authenticates, roles and rule
 * spaces; the directory file mounted as Kubernetes mounts a Secret; a person who presents a badge of the home
 * organization, issued from an entry when the test says so.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { RunningAgent } from '../src/app.js'
import { actorIdentityOf } from '../src/channels/didcomm/identity.js'
import { issuanceEntry } from '../src/core/issuance.js'
import type { Principal } from '../src/core/types.js'

export const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'
export const AGENT_DID = 'did:webvh:QmAgent:agent.northwind.example'
/** the organization of the agent, as the mocked trust resolver gives it */
export const HOME = 'org:NL:12345678'
export const webClient = { name: 'ayni-ui', version: '3.3.0', platform: 'web' }

export interface Call {
  method: string
  url: string
  body: Record<string, unknown>
  at: number
}

export interface MockServices {
  app: FastifyInstance
  url: string
  calls: Call[]
  /** how many revocations to refuse before the next ones go through */
  failRevoke: { n: number }
  /** the credential definitions the DIDComm agent holds */
  definitions: { id: string; relatedJsonSchemaCredentialId?: string; supportRevocation?: boolean }[]
  /** the organizations of the trust graph, as its search finds them (`/v4/graph/search`) */
  organizations: { name: string; countryCode: string; registryId: string; trusted?: boolean }[]
}

/** The DIDComm agent and the trust resolver of the deployment, as far as the agent calls them in these tests. */
export async function mockServices(): Promise<MockServices> {
  const calls: Call[] = []
  const failRevoke = { n: 0 }
  const definitions: MockServices['definitions'] = []
  const organizations: MockServices['organizations'] = [
    { name: 'Northwind Logistics', countryCode: 'NL', registryId: '12345678' },
  ]
  let registries = 0
  let offers = 0
  const app = Fastify({ logger: false })
  app.addHook('preHandler', async (request) => {
    calls.push({
      method: request.method,
      url: request.url,
      body: (request.body ?? {}) as Record<string, unknown>,
      at: Date.now(),
    })
  })
  app.get('/v2/agent/info', async () => ({ did: AGENT_DID, version: 'mock' }))
  app.get('/v2/agent/health/ready', async () => ({}))
  // every DID resolves to the organization of the agent: the badges here are the home organization's
  app.post('/v4/verifiable-trust/resolve', async (request) => ({
    did: (request.body as { did: string }).did,
    trusted: true,
    ecsCredentials: [
      {
        ecsSchema: 'OrganizationCredential',
        credentialSubject: { countryCode: 'NL', registryId: '12345678', name: 'Northwind Logistics' },
      },
    ],
  }))
  app.get('/v2/vt/service-endpoints', async () => ({ items: [] }))
  app.post('/v2/vt/service-endpoints', async (request) => ({ ...(request.body as object) }))
  app.post('/v2/didcomm/peer-status/query', async (_request, reply) => reply.code(400).send({}))
  app.get('/v2/anoncreds/credential-definitions', async () => ({ items: definitions, nextCursor: null }))
  app.post('/v2/anoncreds/credential-definitions', async (request) => {
    const body = request.body as { relatedJsonSchemaCredentialId: string; supportRevocation?: boolean }
    const created = { id: `def-${definitions.length + 1}`, ...body, supportRevocation: body.supportRevocation === true }
    definitions.push(created)
    return created
  })
  app.post('/v2/anoncreds/revocation-registries', async (request) => {
    registries += 1
    return {
      revocationRegistryDefinitionId: `${(request.body as { credentialDefinitionId: string }).credentialDefinitionId}/revreg-${registries}`,
    }
  })
  app.post('/v2/didcomm/credential-offer', async () => {
    offers += 1
    return { credentialExchangeId: `cex-${offers}` }
  })
  app.post('/v2/didcomm/presentation-request', async () => ({ proofExchangeId: `pex-${calls.length}` }))
  app.post('/v2/didcomm/question-answer', async () => ({ id: `qa-${calls.length}` }))
  // the Verana Graph: the Did surface, its operators of kind Organization (TG-FCT-1..9)
  app.post('/v4/graph/search', async (request) => {
    const body = request.body as { filters?: Record<string, string>; freeText?: string }
    const f = body.filters ?? {}
    const text = (body.freeText ?? '').toLowerCase()
    const hits = organizations
      .filter(
        (o) => !f['OrganizationCredential.countryCode'] || o.countryCode === f['OrganizationCredential.countryCode']
      )
      .filter((o) => !f['OrganizationCredential.registryId'] || o.registryId === f['OrganizationCredential.registryId'])
      .filter((o) => !text || o.name.toLowerCase().includes(text))
      .flatMap((o, i) =>
        // an organization runs two DIDs: two hits, one organization
        [1, 2].map((n) => ({
          type: 'Did',
          id: `did:webvh:Qm${i}${n}:${o.registryId}.example`,
          snippet: {
            trusted: o.trusted !== false,
            isTrustExpired: false,
            operator: {
              kind: 'Organization',
              name: n === 1 ? o.name : `${o.name} (second service)`,
              countryCode: o.countryCode,
              registryId: o.registryId,
            },
          },
        }))
      )
    return { totalCount: hits.length, hits, cursor: null }
  })
  app.post('/v2/anoncreds/revoke-credential', async (request, reply) => {
    if (failRevoke.n > 0) {
      failRevoke.n -= 1
      return reply.code(503).send({ error: 'the ledger is out of reach' })
    }
    return { ...(request.body as object), revokedAt: '2026-11-19T05:00:00.000Z' }
  })
  app.post('/v2/didcomm/revocation-notification', async () => ({ sent: true }))
  app.post('/v2/didcomm/basic-messages', async () => ({ id: 'msg-1' }))
  app.post('/v2/didcomm/action-menu', async () => ({ id: 'menu-1' }))
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { app, url: `http://127.0.0.1:${port}`, calls, failRevoke, definitions, organizations }
}

/**
 * The dev pack with a user directory mounted as Kubernetes mounts a Secret (`directory.yaml -> ..data/directory.yaml`,
 * `..data` swapped by a rename at each update), the badge that authenticates, the roles `dispatcher`, `admin` (admin
 * view) and `claimrole` (a rule over a claim), and rule spaces of a department and of a group.
 */
/** A badge of the ECS schema issued from the directory (D88): by email code, by passport, or by both (IDENT-DIR-002). */
export type BadgeMethod = 'email' | 'document' | 'both'

export interface DirectoryPackOptions {
  /** an issuance profile `badge` of the authentication schema, its claims from the directory */
  badge?: BadgeMethod
  /** what the authentication stores of the badge (`name` by default) */
  authenticationStores?: string[]
  /** the organizations whose badges the authentication accepts */
  acceptedOrganizations?: string[]
  /** the countries whose organizations are partners (`identity.organizations`) */
  partners?: string[]
  /** the agent's default language (`language.agent`, `en` in the dev pack) */
  language?: string
  /** the window budget (`memory.contextWindowTokens`, 4000 in the dev pack) */
  contextWindowTokens?: number
}

export function directoryPack(
  people: Record<string, unknown>[],
  options: DirectoryPackOptions = {}
): {
  root: string
  pack: string
  swap: (people: Record<string, unknown>[]) => void
} {
  const root = mkdtempSync(join(tmpdir(), 'ayni-people-'))
  const secret = join(root, 'secret')
  mkdirSync(secret)
  let version = 0
  const swap = (list: Record<string, unknown>[]) => {
    version += 1
    const dir = join(secret, `..v${version}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'directory.yaml'), stringifyYaml({ people: list }))
    symlinkSync(`..v${version}`, join(secret, '..data_tmp'))
    renameSync(join(secret, '..data_tmp'), join(secret, '..data'))
  }
  swap(people)
  symlinkSync('..data/directory.yaml', join(secret, 'directory.yaml'))
  const pack = join(root, 'pack')
  cpSync('agent-packs/dev', pack, { recursive: true })
  const doc = parseYaml(readFileSync(join(pack, 'agent-pack.yaml'), 'utf8'))
  doc.identity.directory = { file: join(secret, 'directory.yaml') }
  doc.identity.roles = {
    ...doc.identity.roles,
    dispatcher: { description: 'Dispatches the trucks.' },
    admin: { description: 'Reads the admin view.', admin: true },
    claimrole: { description: 'Given by a rule over a claim.' },
  }
  doc.identity.roleRules = [
    { when: { relation: 'home', claims: { department: 'Depot Rotterdam' } }, roles: ['claimrole'] },
    ...doc.identity.roleRules,
  ]
  doc.identity.authentication = [
    {
      credential: { jsonSchemaCredentialId: BADGE },
      subjectKey: ['badgeNumber'],
      request: 'on-demand',
      visitors: true,
      store: { attributes: options.authenticationStores ?? ['name'] },
      ...(options.acceptedOrganizations ? { issuers: { organizations: options.acceptedOrganizations } } : {}),
    },
  ]
  if (options.language) doc.language = { ...doc.language, agent: options.language }
  if (options.contextWindowTokens) doc.memory = { ...doc.memory, contextWindowTokens: options.contextWindowTokens }
  if (options.partners?.length)
    doc.identity.organizations = [{ match: { countryCode: options.partners }, relation: 'partner' }]
  if (options.badge) {
    const reads = options.badge !== 'email'
    const checks = options.badge !== 'document'
    doc.evidence = {
      ...(reads
        ? {
            document: {
              store: {
                attributes: [
                  'documentNumber',
                  'issuingState',
                  'nationality',
                  'lastName',
                  'firstName',
                  'dateOfBirth',
                  'portrait',
                ],
              },
            },
          }
        : {}),
      ...(checks ? { email: { store: { attributes: ['address'], retention: { days: 30 } } } } : {}),
    }
    doc.issuance = {
      badge: {
        credential: { jsonSchemaCredentialId: BADGE },
        label: 'Northwind badge',
        trigger: 'model',
        authChallenge: [...(reads ? [{ type: 'document' }] : []), ...(checks ? [{ type: 'email' }] : [])],
        claims: {
          badgeNumber: reads ? { from: 'computed', fn: 'documentId' } : { from: 'computed', fn: 'emailId' },
          name: { from: 'record', record: 'directory', field: 'name' },
          email: { from: 'record', record: 'directory', field: 'email' },
          department: { from: 'record', record: 'directory', field: 'department' },
          birthDate: reads
            ? { from: 'evidence', entry: 'document', attribute: 'dateOfBirth', as: 'dateint' }
            : { from: 'computed', fn: 'constant', value: '' },
          photo: reads
            ? { from: 'evidence', entry: 'document', attribute: 'portrait' }
            : { from: 'computed', fn: 'constant', value: '' },
          phoneNumber: { from: 'computed', fn: 'constant', value: '' },
        },
      },
    }
  }
  doc.spaces.templates.push(
    {
      id: 'depot',
      title: 'Depot',
      kind: 'team',
      creators: ['manager'],
      membership: { mode: 'rule', rule: { department: 'Depot Rotterdam' } },
    },
    {
      id: 'night',
      title: 'Night shift',
      kind: 'team',
      creators: ['manager'],
      membership: { mode: 'rule', rule: { group: 'night-shift' } },
    }
  )
  writeFileSync(join(pack, 'agent-pack.yaml'), stringifyYaml(doc))
  return { root, pack, swap }
}

/** Mints binding material without the DIDComm agent: the phone confirms in the tests. */
export function mintLocally(running: RunningAgent): void {
  const minter = running.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
  minter.minter = {
    mint: async (id: string) => ({
      invitationId: `inv-${id}`,
      outOfBandId: `oob-${id}`,
      url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
    }),
  }
}

export interface Person {
  principal: Principal
  sessionId: string
  sessionToken: string
  connectionId: string
  /** the index of the revocation registry its badge took, when it was issued from an entry */
  slot?: number
}

let slots = 0

/**
 * A person presents a badge of the home organization on a DIDComm connection, and binds a web session. With `entry`,
 * the badge was issued by this agent from that entry: its record is the one the issuance writes (its shape is tested
 * in tests/revocation.test.ts): the entry, the keyed index of the actor, the registry and the index of the credential.
 */
export async function present(
  running: RunningAgent,
  badgeNumber: string,
  name: string,
  opts: { entry?: string; claims?: Record<string, string> } = {}
): Promise<Person> {
  const actorIdentity = actorIdentityOf(HOME, BADGE, [badgeNumber])
  const connectionId = `conn-${badgeNumber}`
  let slot: number | undefined
  if (opts.entry) {
    slot = slots++
    await running.agent.evidence.record(
      { id: `prn_guest_${badgeNumber}` },
      {
        kind: 'issuance',
        entry: issuanceEntry('badge'),
        credentialDefinitionId: 'def-badge',
        values: { badgeNumber, name },
        connectionRef: connectionId,
        directoryEntryId: opts.entry,
        holder: actorIdentity,
        revocation: { registryDefinitionId: 'def-badge/revreg-1', index: slot },
      }
    )
  }
  const claims = { badgeNumber, name, ...(opts.claims ?? {}) }
  const { principal } = await running.agent.onPeerConnected(
    {
      connectionType: 'verifiable-user-agent',
      actorIdentity,
      backingIdentity: { kind: 'org', id: HOME, name: 'Northwind Logistics' },
      organization: {
        key: HOME,
        name: 'Northwind Logistics',
        attributes: { countryCode: 'NL', registryId: '12345678' },
      },
      claims: { ...claims, userName: name },
      userAgentVerified: true,
      identityCredentialRef: `badge:pex-${badgeNumber}`,
      evidence: {
        kind: 'presentation',
        entry: 'authentication',
        schema: BADGE,
        credentialDefinitionId: 'def-badge',
        issuerDid: AGENT_DID,
        issuerOrganization: { key: HOME, name: 'Northwind Logistics' },
        values: claims,
      },
    },
    connectionId,
    { name: 'Ayni', version: '1.0.0', platform: 'ios' }
  )
  const created = (
    await running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client: webClient, locale: 'en' } })
  ).json() as { sessionId: string; sessionToken: string }
  const session = await running.agent.sessions.get(created.sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const thread = `thread-${badgeNumber}-${Math.random().toString(36).slice(2, 8)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  return { principal, ...created, connectionId, slot }
}

/**
 * A guest: a person whose wallet connected and presented nothing (the authentication is asked on demand), with a web
 * session bound by the phone, as the person who asks for a badge from the directory is.
 */
export async function guest(running: RunningAgent, id: string, locale = 'en'): Promise<Person> {
  const connectionId = `conn-${id}`
  const { principal } = await running.agent.onPeerConnected(
    {
      connectionType: 'verifiable-user-agent',
      actorIdentity: `did:peer:${id}`,
      backingIdentity: null,
      claims: {},
      userAgentVerified: true,
      identityCredentialRef: null,
    },
    connectionId,
    { name: 'Ayni', version: '1.0.0', platform: 'ios' },
    { welcome: false }
  )
  return { principal, ...(await bindWeb(running, principal, connectionId, locale)), connectionId }
}

/** A web session of a Principal, bound by its phone (CHAN-BIND-009). */
export async function bindWeb(
  running: RunningAgent,
  principal: Principal,
  connectionId: string,
  locale = 'en'
): Promise<{ sessionId: string; sessionToken: string }> {
  const created = (
    await running.app.inject({ method: 'POST', url: '/agui/v3/sessions', payload: { client: webClient, locale } })
  ).json() as { sessionId: string; sessionToken: string }
  const session = await running.agent.sessions.get(created.sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const thread = `thread-${principal.id}-${Math.random().toString(36).slice(2, 8)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  return created
}

/** A run of a web session: the events of its response. */
export async function runText(
  running: RunningAgent,
  s: { sessionId: string; sessionToken: string },
  text: string,
  messageId = `u-${Math.random().toString(36).slice(2)}`
): Promise<Record<string, unknown>[]> {
  const response = await running.app.inject({
    method: 'POST',
    url: `/agui/v3/sessions/${s.sessionId}/runs`,
    headers: { authorization: `Bearer ${s.sessionToken}` },
    payload: {
      threadId: s.sessionId,
      runId: `run-${Date.now()}-${Math.random()}`,
      messages: [{ id: messageId, role: 'user', content: text }],
      tools: [],
      context: [],
    },
  })
  return response.body
    .split('\n\n')
    .map((block) =>
      block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('')
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

/** The text the agent wrote in a run's events. */
export const textOf = (events: Record<string, unknown>[]): string =>
  events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => String(e.delta ?? ''))
    .join('')

/** The history of a web session's conversation. */
export async function historyOf(running: RunningAgent, s: { sessionId: string; sessionToken: string }) {
  return (
    await running.app.inject({
      method: 'GET',
      url: `/agui/v3/sessions/${s.sessionId}/messages?limit=200`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
    })
  ).json().messages as { id: string; role: string; content: unknown; metadata: Record<string, unknown> }[]
}

/** Waits until a condition holds, a few seconds at most. */
export async function until(check: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}
