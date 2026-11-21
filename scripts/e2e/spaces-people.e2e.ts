/**
 * End to end, over HTTP, against the built agent (`node dist/index.js`) on PostgreSQL, with the stub model, a real SMTP
 * server (Mailpit) and a stand-in for the DIDComm agent, the trust resolver and the Verana Graph (decisions 60 to 62;
 * ayni-spec PR #94). The stand-in answers the calls the agent makes and plays the phone: it connects, links a web
 * session, accepts the badge offered and presents it, as a wallet would. A real VS Agent and a wallet are not part of
 * this run: the badge is never really issued on a ledger.
 *
 * `pnpm e2e` (Docker for PostgreSQL and Mailpit); `-- --no-build` reuses dist/. Writes scripts/e2e/report/ (the
 * report in Markdown and JSON) and the agent's log beside it.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const ROOT = new URL('../..', import.meta.url).pathname
const REPORT_DIR = join(ROOT, 'scripts/e2e/report')
const AGENT_DID = 'did:webvh:QmE2eAgent:agent.northwind.example'
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'
const PG_PORT = process.env.E2E_PG_PORT ?? '55441'
const SMTP_PORT = process.env.E2E_SMTP_PORT ?? '51027'
const MAIL_API_PORT = process.env.E2E_MAIL_API_PORT ?? '58027'
const AGENT_PORT = process.env.E2E_AGENT_PORT ?? '3091'
const AGENT = `http://127.0.0.1:${AGENT_PORT}`
const MAILPIT = `http://127.0.0.1:${MAIL_API_PORT}`
const WINDOW_SECONDS = 8
const client = { name: 'ayni-e2e', version: '1.0.0', platform: 'web' }

interface Step {
  name: string
  refs: string
  ok: boolean
  evidence: Record<string, unknown>
  error?: string
}
const steps: Step[] = []
const cleanups: (() => void | Promise<void>)[] = []

async function step(name: string, refs: string, work: () => Promise<Record<string, unknown>>): Promise<void> {
  const started = Date.now()
  try {
    const evidence = await work()
    steps.push({ name, refs, ok: true, evidence: { ...evidence, ms: Date.now() - started } })
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    steps.push({ name, refs, ok: false, evidence: {}, error: (error as Error).message })
    process.stdout.write(`  FAIL ${name}: ${(error as Error).message}\n`)
  }
}

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(what)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(what: string, probe: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

// ---- the stand-in for the DIDComm agent, the trust resolver and the Verana Graph ---------------------------------

interface Call {
  method: string
  url: string
  body: Record<string, unknown>
}

async function standIn() {
  const calls: Call[] = []
  const definitions: { id: string; relatedJsonSchemaCredentialId?: string; supportRevocation?: boolean }[] = []
  let n = 0
  const app = Fastify({ logger: false })
  app.addHook('preHandler', async (request) => {
    calls.push({ method: request.method, url: request.url, body: (request.body ?? {}) as Record<string, unknown> })
  })
  app.get('/v2/agent/info', async () => ({ did: AGENT_DID, version: 'e2e-stand-in' }))
  app.get('/v2/agent/health/ready', async () => ({}))
  // every DID resolves to the organization of the agent: its badges are Northwind's
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
  // a binding invitation is a standalone invitation record (vs-agent#804, CHAN-BIND-017)
  app.post('/v2/didcomm/invitations', async () => {
    n += 1
    return {
      id: `oob-${n}`,
      invitation: { '@id': `inv-${n}`, services: [AGENT_DID] },
      shortUrl: `https://agent.example/s?id=${n}`,
    }
  })
  app.post('/v2/didcomm/basic-messages', async () => ({ id: `msg-${++n}` }))
  app.post('/v2/didcomm/question-answer', async () => ({ id: `qa-${++n}` }))
  app.post('/v2/didcomm/action-menu', async () => ({ id: `menu-${++n}` }))
  app.post('/v2/didcomm/receipts', async () => ({}))
  app.get('/v2/anoncreds/credential-definitions', async () => ({ items: definitions, nextCursor: null }))
  app.post('/v2/anoncreds/credential-definitions', async (request) => {
    const body = request.body as { relatedJsonSchemaCredentialId: string; supportRevocation?: boolean }
    const created = { id: `def-${definitions.length + 1}`, ...body, supportRevocation: body.supportRevocation === true }
    definitions.push(created)
    return created
  })
  app.post('/v2/anoncreds/revocation-registries', async (request) => ({
    revocationRegistryDefinitionId: `${(request.body as { credentialDefinitionId: string }).credentialDefinitionId}/revreg-1`,
  }))
  app.post('/v2/didcomm/credential-offer', async () => ({ credentialExchangeId: `cex-${++n}` }))
  app.post('/v2/didcomm/presentation-request', async () => ({ proofExchangeId: `pex-${++n}` }))
  app.post('/v2/anoncreds/revoke-credential', async (request) => ({
    ...(request.body as object),
    revokedAt: new Date().toISOString(),
  }))
  app.post('/v2/didcomm/revocation-notification', async () => ({ sent: true }))
  // the Verana Graph: the Did surface, its operators of kind Organization
  const organizations = [
    { name: 'Northwind Logistics', countryCode: 'NL', registryId: '12345678' },
    { name: 'Acme Freight', countryCode: 'FR', registryId: '111' },
  ]
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
      .map((o) => ({
        type: 'Did',
        id: `did:webvh:Qm:${o.registryId}.example`,
        snippet: { trusted: true, isTrustExpired: false, operator: { kind: 'Organization', ...o } },
      }))
    return { totalCount: hits.length, hits, cursor: null }
  })
  app.setNotFoundHandler(async (request, reply) => reply.code(404).send({ error: `no stand-in for ${request.url}` }))
  // the ids it gives, as it gives them: the binding invitations, the questions, the offers, the presentation requests
  const ids: Record<'oob' | 'question' | 'exchange' | 'proof', string[]> = {
    oob: [],
    question: [],
    exchange: [],
    proof: [],
  }
  app.addHook('onSend', async (request, _reply, payload) => {
    if (typeof payload !== 'string' || !payload.startsWith('{')) return payload
    const body = JSON.parse(payload) as Record<string, string>
    if (request.url === '/v2/didcomm/invitations') ids.oob.push(body.id as string)
    if (request.url === '/v2/didcomm/question-answer') ids.question.push(body.id as string)
    if (request.url === '/v2/didcomm/credential-offer') ids.exchange.push(body.credentialExchangeId as string)
    if (request.url === '/v2/didcomm/presentation-request') ids.proof.push(body.proofExchangeId as string)
    return payload
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { app, url: `http://127.0.0.1:${port}`, calls, ids }
}

// ---- the agent, its store, its mail ---------------------------------------------------------------------------

function docker(args: string[]): void {
  execFileSync('docker', args, { stdio: 'ignore' })
}

function packWithDirectory(dir: string): string {
  const secret = join(dir, 'secret')
  mkdirSync(secret)
  writeFileSync(
    join(secret, 'directory.yaml'),
    stringifyYaml({
      people: [
        {
          id: 'p-0042',
          firstName: 'Ana',
          lastName: 'Ríos',
          email: 'ana.rios@northwind.example',
          department: 'Depot Rotterdam',
          roles: ['dispatcher'],
        },
        {
          id: 'p-0043',
          firstName: 'Jonas',
          lastName: 'Weber',
          email: 'jonas.weber@northwind.example',
          department: 'Depot Rotterdam',
          roles: ['manager'],
        },
      ],
    })
  )
  const pack = join(dir, 'pack')
  mkdirSync(pack)
  const doc = parseYaml(readFileSync(join(ROOT, 'agent-packs/dev/agent-pack.yaml'), 'utf8'))
  doc.identity.directory = { file: join(secret, 'directory.yaml') }
  doc.identity.roles = { ...doc.identity.roles, dispatcher: { description: 'Dispatches the trucks.' } }
  doc.identity.authentication = [
    {
      credential: { jsonSchemaCredentialId: BADGE },
      subjectKey: ['badgeNumber'],
      request: 'on-demand',
      guests: true,
      store: { attributes: ['name', 'email'] },
    },
  ]
  doc.evidence = { email: { store: { attributes: ['address'], retention: { days: 30 } } } }
  doc.issuance = {
    badge: {
      credential: { jsonSchemaCredentialId: BADGE },
      label: 'Northwind badge',
      trigger: 'model',
      authChallenge: [{ type: 'email' }],
      claims: {
        badgeNumber: { from: 'computed', fn: 'emailId' },
        name: { from: 'record', record: 'directory', field: 'name' },
        email: { from: 'record', record: 'directory', field: 'email' },
        department: { from: 'record', record: 'directory', field: 'department' },
        birthDate: { from: 'computed', fn: 'constant', value: '' },
        photo: { from: 'computed', fn: 'constant', value: '' },
        phoneNumber: { from: 'computed', fn: 'constant', value: '' },
      },
    },
  }
  writeFileSync(join(pack, 'agent-pack.yaml'), stringifyYaml(doc))
  return pack
}

// ---- HTTP helpers ------------------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: the JSON answers of the agent, read field by field
type Any = any

interface Session {
  sessionId: string
  sessionToken: string
}

async function http(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Any; text: string }> {
  const response = await fetch(`${AGENT}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let body: Any
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  return { status: response.status, body, text }
}

const sessions = (path: string, s: Session, method = 'GET', body?: unknown) =>
  http(method, `/agui/v3/sessions${path}`, { token: s.sessionToken, body })

/** A run: the events of its response, and the text the agent wrote in it. */
async function run(s: Session, text: string, messageId = `e2e-${randomBytes(4).toString('hex')}`) {
  const response = await http('POST', `/agui/v3/sessions/${s.sessionId}/runs`, {
    token: s.sessionToken,
    body: {
      threadId: s.sessionId,
      runId: `run-${randomBytes(4).toString('hex')}`,
      messages: [{ id: messageId, role: 'user', content: text }],
      tools: [],
      context: [],
    },
  })
  const events = response.text
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
  const said = events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => String(e.delta ?? ''))
    .join('')
  return { events, said, messageId }
}

async function event(type: string, data: Record<string, unknown>): Promise<void> {
  const response = await http('POST', '/vs-agent/events', { body: { type, data } })
  check(response.status === 202, `the agent did not take the event ${type} (${response.status})`)
}

/** The mail Mailpit received for an address, newest first. */
async function mailTo(address: string): Promise<{ ID: string; Subject: string }[]> {
  const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as {
    messages: { ID: string; Subject: string; To: { Address: string }[] }[]
  }
  return list.messages.filter((m) => m.To.some((t) => t.Address.toLowerCase() === address))
}

async function mailText(id: string): Promise<string> {
  return ((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string }).Text
}

// ---- the run --------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const build = !process.argv.includes('--no-build')
  mkdirSync(REPORT_DIR, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'ayni-e2e-'))
  cleanups.push(() => rmSync(work, { recursive: true, force: true }))
  const pg = `ayni-e2e-pg-${process.pid}`
  const mail = `ayni-e2e-mail-${process.pid}`
  process.stdout.write('starting PostgreSQL and Mailpit in Docker\n')
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    pg,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-p',
    `${PG_PORT}:5432`,
    'pgvector/pgvector:pg16',
  ])
  cleanups.push(() => void spawnSync('docker', ['stop', pg], { stdio: 'ignore' }))
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    mail,
    '-p',
    `${SMTP_PORT}:1025`,
    '-p',
    `${MAIL_API_PORT}:8025`,
    'axllent/mailpit:v1.32.0',
  ])
  cleanups.push(() => void spawnSync('docker', ['stop', mail], { stdio: 'ignore' }))
  await until(
    'PostgreSQL',
    async () => spawnSync('docker', ['exec', pg, 'pg_isready', '-U', 'postgres']).status === 0,
    60_000
  )
  await until('Mailpit', async () => (await fetch(`${MAILPIT}/api/v1/info`).catch(() => undefined))?.ok, 60_000)
  const stand = await standIn()
  cleanups.push(() => stand.app.close())
  if (build) {
    process.stdout.write('building the agent\n')
    execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' })
  }
  const pack = packWithDirectory(work)
  const logFile = join(REPORT_DIR, 'agent.log')
  const log = createWriteStream(logFile)
  const agent: ChildProcess = spawn('node', ['dist/index.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: AGENT_PORT,
      ADMIN_PORT: '0',
      PUBLIC_BASE_URL: AGENT,
      AGENT_PACK_PATH: pack,
      STORE: 'postgres',
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`,
      SESSION_TOKEN_SECRET: randomBytes(32).toString('hex'),
      ENTRY_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      VS_AGENT_ADMIN_URL: stand.url,
      VERANA_API_URL: stand.url,
      VERANA_GRAPH_URL: stand.url,
      MAIL_HOST: '127.0.0.1',
      MAIL_PORT: String(SMTP_PORT),
      MAIL_FROM_ADDRESS: 'fleet@northwind.example',
      MAIL_FROM_NAME: 'Northwind fleet support',
      APP_LINK_BASE: 'https://app.dev.ayni.org/app/',
      ANCHORING_ENABLED: 'false',
      LLM_PROVIDER: 'stub',
      LLM_MODEL: 'echo',
      MESSAGE_DELETION_WINDOW_SECONDS: String(WINDOW_SECONDS),
      DIRECTORY_POLL_SECONDS: '2',
      AGUI_ALLOWED_ORIGINS: 'http://localhost:5173',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  agent.stdout?.pipe(log)
  agent.stderr?.pipe(log)
  cleanups.push(() => void agent.kill('SIGTERM'))
  await until('the agent', async () => (await fetch(`${AGENT}/health/live`).catch(() => undefined))?.ok, 60_000)
  process.stdout.write(`agent on ${AGENT}, stand-in on ${stand.url}\n`)

  const callsTo = (url: string, connectionId?: string) =>
    stand.calls.filter((c) => c.url === url && (!connectionId || c.body.connectionId === connectionId))

  /** A wallet connects as a guest, and a web session is linked to it by the phone's Yes (CHAN-BIND-009). */
  async function linked(connectionId: string): Promise<Session> {
    await event('didcomm.connections.state-updated', {
      id: connectionId,
      state: 'completed',
      previousState: 'response-sent',
      theirDid: `did:peer:2.${connectionId}`,
      theirLabel: 'Ayni',
    })
    await until(
      'the welcome on the connection',
      async () => callsTo('/v2/didcomm/basic-messages', connectionId).length > 0
    )
    const created = await http('POST', '/agui/v3/sessions', { body: { client, locale: 'en' } })
    check(created.status === 201, `no session (${created.status})`)
    const outOfBandId = stand.ids.oob.at(-1) as string
    const asked = stand.ids.question.length
    // the phone scans the code of the page: its connection is reused, and the agent asks it to confirm
    await event('didcomm.out-of-band.handshake-reused', { outOfBandId, invitationId: '', connectionId })
    const threadId = await until('the binding question', async () =>
      stand.ids.question.length > asked ? stand.ids.question.at(-1) : undefined
    )
    await event('didcomm.question-answer.answer-received', { connectionId, threadId, response: 'Yes' })
    const bound = { sessionId: created.body.sessionId as string, sessionToken: created.body.sessionToken as string }
    await until('the session bound', async () => (await sessions('/spaces', bound)).status === 200)
    return bound
  }

  let jonas: Session = { sessionId: '', sessionToken: '' }
  let stranger: Session = { sessionId: '', sessionToken: '' }
  let offerClaims: Record<string, string> = {}
  let spaceId = ''
  let spaceSession: Session = { sessionId: '', sessionToken: '' }

  process.stdout.write('\nsteps\n')

  await step('A guest connects and links a web session (CHAN-BIND-009)', 'IDENT-RES-007, CHAN-BIND-009', async () => {
    jonas = await linked('conn-jonas')
    const status = await sessions(`/${jonas.sessionId}`, jonas)
    check(status.status === 200, `status ${status.status}`)
    return { session: jonas.sessionId, principal: status.body?.principal?.displayName ?? null }
  })

  await step(
    'The badge is ready before any evidence: its own email check is the action that obtains its claims',
    'INTX-ISSUE-005/006/021',
    async () => {
      const { said } = await run(jonas, '/call credential_requirements {}')
      // the stub model repeats the first 400 characters of the tool's answer: the first claims, and the state
      check(said.includes('"challenge":"email"'), 'the action does not name the email challenge')
      check(said.includes('"state":"ready"'), 'the badge is not ready')
      return { toolAnswer: said.slice(0, 600) }
    }
  )

  let _question = ''
  await step(
    'Issuing ends the turn with the code question in the conversation, nothing on the phone',
    'INTX-AUTH-012',
    async () => {
      const before = stand.calls.length
      const { said, events } = await run(jonas, '/call issue_credential {"credential":"badge"}')
      _question = said
      check(said.startsWith('To issue your Northwind badge'), `unexpected: ${said}`)
      check(events.at(-1)?.type === 'RUN_FINISHED', 'the run did not finish')
      const phone = stand.calls
        .slice(before)
        .filter((c) => c.url.startsWith('/v2/didcomm/') && !c.url.startsWith('/v2/didcomm/peer-status'))
      check(phone.length === 0, `the phone was sent ${phone.map((c) => c.url).join(', ')}`)
      return { question: said }
    }
  )

  await step(
    'A listed and an unlisted address get the same answer; only the listed one gets a code',
    'INTX-AUTH-013/014',
    async () => {
      stranger = await linked('conn-stranger')
      await run(stranger, '/call issue_credential {"credential":"badge"}')
      const toStranger = (await run(stranger, 'nobody@northwind.example')).said
      const toJonas = (await run(jonas, 'Jonas.Weber@Northwind.example')).said
      check(toJonas === toStranger, `different answers:\n${toJonas}\n${toStranger}`)
      const mails = await until('the code email', async () => {
        const found = await mailTo('jonas.weber@northwind.example')
        return found.length ? found : undefined
      })
      await sleep(500)
      check((await mailTo('nobody@northwind.example')).length === 0, 'an unlisted address got an email')
      return { answer: toJonas, emailSubject: mails[0]?.Subject }
    }
  )

  let code = ''
  await step(
    'A wrong code is a try; the right one verifies the address and the badge is offered by itself',
    'INTX-AUTH-014/015, IDENT-DIR-004/005',
    async () => {
      const [mail] = await mailTo('jonas.weber@northwind.example')
      const text = await mailText(mail?.ID as string)
      code = /\b(\d{6})\b/.exec(text)?.[1] as string
      check(code, 'no code in the email')
      const wrong = code === '000000' ? '111111' : '000000'
      const first = (await run(jonas, wrong)).said
      check(first === 'That code is not right. 4 tries are left.', first)
      const right = (await run(jonas, code)).said
      check(right.startsWith('Your email address is verified.'), right)
      const offer = await until('the offer', async () => callsTo('/v2/didcomm/credential-offer', 'conn-jonas')[0])
      offerClaims = Object.fromEntries(
        (offer.body.claims as { name: string; value: string }[]).map((c) => [c.name, c.value])
      )
      check(
        offerClaims.name === 'Jonas Weber' && offerClaims.department === 'Depot Rotterdam',
        JSON.stringify(offerClaims)
      )
      check(typeof offer.body.revocationRegistryIndex === 'number', 'the offer names no revocation index')
      return {
        emailText: text,
        wrongTry: first,
        rightCode: right,
        offer: { ...offer.body, claims: offerClaims },
      }
    }
  )

  await step(
    'The wallet accepts; the person is told, then asked to present the badge, which identifies them',
    'IDENT-RES-017, IDENT-DIR-006, IDENT-ROLE-012',
    async () => {
      const credentialExchangeId = stand.ids.exchange[0] as string
      await event('didcomm.credential-exchanges.state-updated', { credentialExchangeId, state: 'done' })
      const told = await until('the outcome in the conversation', async () => {
        const history = await sessions(`/${jonas.sessionId}/messages?limit=200`, jonas)
        return (history.body?.messages as { content: unknown }[] | undefined)?.find(
          (m) => m.content === 'The credential is in your wallet.'
        )
      })
      const asked = await until('the presentation request', async () => {
        const found = callsTo('/v2/didcomm/presentation-request', 'conn-jonas')
        return found.length ? found : undefined
      })
      const proofExchangeId = await until('the proof exchange id', async () => stand.ids.proof.at(-1))
      const claims = Object.entries(offerClaims).map(([name, value]) => ({ name, value }))
      await event('didcomm.presentations.state-updated', {
        proofExchangeId,
        state: 'done',
        verified: true,
        connectionId: 'conn-jonas',
        claims,
        credentials: [
          {
            credentialDefinitionId: 'def-1',
            issuerDid: AGENT_DID,
            jsonSchemaCredentialId: BADGE,
            claims,
            unrevealed: [],
          },
        ],
      })
      const spaces = await until('Jonas identified, holding his entry', async () => {
        const listed = await sessions('/spaces', jonas)
        const templates = (listed.body?.templates ?? []) as { id: string }[]
        // the manager role comes from his entry, typed by hand (IDENT-ROLE-002/012): it creates the sales spaces
        return templates.some((t) => t.id === 'sales') ? listed.body : undefined
      })
      const status = await sessions(`/${jonas.sessionId}`, jonas)
      return {
        told: told.content,
        presentationRequests: asked.length,
        principal: status.body.principal,
        creatableTemplates: spaces.templates.map((t: { id: string }) => t.id),
      }
    }
  )

  await step(
    'Space lifecycle: create, change within bounds, read, activity',
    'SPACE-DEF-001..006, PROF-SPACE-001..004/006',
    async () => {
      const created = await sessions('/spaces', jonas, 'POST', {
        templateId: 'project',
        title: 'Rotterdam handoff',
        purpose: 'Hand the night shipments over to the morning shift',
      })
      check(created.status === 201, `create ${created.status} ${created.text}`)
      spaceId = created.body.id
      const patched = await sessions(`/spaces/${spaceId}`, jonas, 'PATCH', {
        brief: 'Containers of the night',
        rules: { retentionDays: 90 },
      })
      check(patched.status === 200 && patched.body.rules.retentionDays === 90, `patch ${patched.status}`)
      const outside = await sessions(`/spaces/${spaceId}`, jonas, 'PATCH', { rules: { retentionDays: 99999 } })
      check(outside.status === 422 && outside.body.error === 'out-of-bounds', `bounds ${outside.status}`)
      const read = await sessions(`/spaces/${spaceId}`, jonas)
      const activity = await sessions(`/spaces/${spaceId}/activity`, jonas)
      return {
        space: { id: spaceId, title: read.body.title, rules: read.body.rules, members: read.body.members },
        refusedOutOfBounds: outside.body,
        activity: activity.body.activity.map((a: { kind: string }) => a.kind),
      }
    }
  )

  await step(
    'The member picker and adding a person of the directory',
    'SPACE-MEMB-002/005, PROF-DIR-001, PROF-SPACE-005',
    async () => {
      const picked = await sessions('/directory?q=rio', jonas)
      check(picked.body.people?.[0]?.directoryId === 'p-0042', JSON.stringify(picked.body))
      check(!JSON.stringify(picked.body).includes('@'), 'the picker shows an email')
      const added = await sessions(`/spaces/${spaceId}/members`, jonas, 'POST', { directoryId: 'p-0042' })
      check(added.status === 201 && added.body.state === 'invited', `add ${added.status}`)
      return { picker: picked.body, added: added.body }
    }
  )

  await step('A conversation in the space', 'SPACE-CONV-001, PROF-CONV-010/011', async () => {
    const created = await http('POST', '/agui/v3/sessions', {
      token: jonas.sessionToken,
      body: { client, locale: 'en', newConversation: true, spaceId },
    })
    check(created.status === 201, `new conversation ${created.status} ${created.text}`)
    spaceSession = { sessionId: created.body.sessionId, sessionToken: created.body.sessionToken }
    const { said } = await run(spaceSession, 'What is planned for the night shipments?')
    check(said.startsWith('You said:'), said)
    const listed = await sessions(`/conversations?spaceId=${encodeURIComponent(spaceId)}`, spaceSession)
    const conversations = (listed.body.conversations ?? listed.body) as { id: string; spaceId: string }[]
    check(
      conversations.some((c) => c.spaceId === spaceId),
      'the conversation is not in the space'
    )
    return { reply: said, conversations: conversations.map((c) => ({ id: c.id, spaceId: c.spaceId })) }
  })

  await step(
    'A memory added by the working_memory tool: its event, its history line, /memories and /about-me',
    'MEM-SPACE-001..007, PROF-STREAM-010, PROF-HIST-012, PROF-MEM-001/003',
    async () => {
      const { events } = await run(
        spaceSession,
        '/call working_memory {"action":"add","content":"Jonas prefers morning deliveries"}'
      )
      const custom = events.find((e) => e.type === 'CUSTOM' && e.name === 'ayni.memory.updated')
      check(custom, 'no ayni.memory.updated event')
      const history = await sessions(`/${spaceSession.sessionId}/messages?limit=200`, spaceSession)
      const line = (history.body.messages as { activityType?: string; content: unknown }[]).find(
        (m) => m.activityType === 'ayni.memory-update'
      )
      check(line, 'no memory line in history')
      const memories = await sessions(`/memories?spaceId=${encodeURIComponent(spaceId)}`, spaceSession)
      check(memories.body.memories?.[0]?.content === 'Jonas prefers morning deliveries', JSON.stringify(memories.body))
      const about = await sessions('/about-me', spaceSession)
      check(
        about.body.memoriesBySpace.some((m: { spaceId: string }) => m.spaceId === spaceId),
        'about-me misses the space'
      )
      check(
        about.body.verified.some((v: { source: string }) => v.source === 'email'),
        'about-me misses the verified address'
      )
      return { event: custom, historyLine: line, memories: memories.body, aboutMe: about.body }
    }
  )

  await step(
    'Deleting a message within its window, and window-passed after it',
    'PRIV-ERASE-010..012, PROF-HIST-010',
    async () => {
      const doomed = await run(spaceSession, 'This message goes', 'e2e-doomed')
      const erased = await sessions(`/${spaceSession.sessionId}/messages/e2e-doomed`, spaceSession, 'DELETE')
      check(erased.status === 204, `delete ${erased.status} ${erased.text}`)
      const history = await sessions(`/${spaceSession.sessionId}/messages?limit=200`, spaceSession)
      check(!JSON.stringify(history.body).includes('This message goes'), 'the message is still in history')
      await run(spaceSession, 'This message stays', 'e2e-kept')
      await sleep((WINDOW_SECONDS + 1) * 1000)
      const late = await sessions(`/${spaceSession.sessionId}/messages/e2e-kept`, spaceSession, 'DELETE')
      check(late.status === 409 && late.body.error === 'window-passed', `late delete ${late.status} ${late.text}`)
      return { deletedReply: doomed.said, deleted: erased.status, late: late.body }
    }
  )

  await step('Handing the conversation over to the space', 'SPACE-SHARE-001..004, PROF-CONV-012', async () => {
    const conversationId = (await sessions(`/${spaceSession.sessionId}`, spaceSession)).body.conversationId
    const shared = await sessions(`/conversations/${conversationId}/share`, spaceSession, 'POST')
    check(shared.status === 200 && shared.body.shared === true, `share ${shared.status} ${shared.text}`)
    const listed = await sessions(`/spaces/${spaceId}/shared`, spaceSession)
    return { shared: shared.body, list: listed.body }
  })

  await step(
    'Organizations of the trust graph, and an invitation of another organization by email',
    'PROF-DIR-002, SPACE-INV-001/002, PLAT-MAIL-002',
    async () => {
      const found = await sessions('/organizations?q=acme', jonas)
      check(found.body.organizations?.[0]?.organizationKey === 'org:FR:111', JSON.stringify(found.body))
      const own = await sessions('/organizations?q=northwind', jonas)
      check(own.body.organizations.length === 0, 'the own organization is listed')
      const unknown = await sessions(`/spaces/${spaceId}/members`, jonas, 'POST', {
        organizationKey: 'org:FR:999',
        email: 'someone@unknown.example',
      })
      check(unknown.status === 422 && unknown.body.error === 'not-on-verana', `unknown ${unknown.status}`)
      const invited = await sessions(`/spaces/${spaceId}/members`, jonas, 'POST', {
        organizationKey: 'org:FR:111',
        email: 'marc.petit@acme.example',
      })
      check(invited.status === 201 && invited.body.state === 'invited' && invited.body.role === 'guest', invited.text)
      const [mail] = await until('the invitation email', async () => {
        const found = await mailTo('marc.petit@acme.example')
        return found.length ? found : undefined
      })
      const text = await mailText(mail?.ID as string)
      check(text.includes(`https://app.dev.ayni.org/app/service/${AGENT_DID}`), 'no app link in the invitation')
      check(!/tok_|oob|\?/.test(text), 'the invitation carries something that opens the space')
      return { organizations: found.body, refused: unknown.body, member: invited.body, subject: mail?.Subject, text }
    }
  )

  await step(
    'The store holds no code, no typed address and no invited email in the clear',
    'INTX-AUTH-014, SPACE-INV-001, D77',
    async () => {
      const psql = (sql: string) =>
        spawnSync('docker', ['exec', pg, 'psql', '-U', 'postgres', '-At', '-c', sql], {
          encoding: 'utf8',
        }).stdout.trim()
      const tables = psql(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
      ).split('\n')
      // case counts: the address was typed Jonas.Weber@Northwind.example, and verified in lower case
      const holding = (needle: string, anyCase = false) =>
        tables.filter(
          (t) =>
            Number(psql(`SELECT count(*) FROM ${t} x WHERE x::text ${anyCase ? 'ILIKE' : 'LIKE'} '%${needle}%'`)) > 0
        )
      // what only the email check and the invitation ever held: sealed, or kept as a keyed hash
      const sealed = {
        code: holding(code),
        typedAddress: holding('Jonas.Weber@Northwind'),
        unlistedAddress: holding('nobody@northwind'),
        invitedEmail: holding('marc.petit@acme'),
      }
      for (const [what, where] of Object.entries(sealed))
        check(where.length === 0, `${what} in the clear in ${where.join(', ')}`)
      // the verified address is also the `email` claim of the badge, which the authentication of this pack stores: the
      // Principal keeps the stored claims of its identity credential in identityAttributes (decision 43), in the clear
      return { tables: tables.length, sealed, verifiedAddressAlsoIn: holding('jonas.weber@northwind.example', true) }
    }
  )

  await step('The agent logged no error', 'operations', async () => {
    const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
    const parsed = lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as { level: number; msg: string }]
      } catch {
        return []
      }
    })
    const errors = parsed.filter((l) => l.level >= 50).map((l) => l.msg)
    const warnings = parsed.filter((l) => l.level === 40).map((l) => l.msg)
    check(errors.length === 0, `errors: ${errors.join(' | ')}`)
    return { lines: parsed.length, warnings: [...new Set(warnings)] }
  })

  // ---- the report -------------------------------------------------------------------------------------------
  const passed = steps.filter((s) => s.ok).length
  const report = {
    at: new Date().toISOString(),
    commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
    setup: {
      agent: 'node dist/index.js (stub model), PostgreSQL pgvector/pgvector:pg16, Mailpit axllent/mailpit:v1.32.0',
      standIn: 'DIDComm agent, trust resolver and Verana Graph answered by this script; it plays the phone',
      notCovered: 'a real VS Agent, a wallet and the ledger: the badge offer is accepted by this script',
    },
    passed,
    failed: steps.length - passed,
    steps,
  }
  writeFileSync(join(REPORT_DIR, 'spaces-people.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(REPORT_DIR, 'spaces-people.md'), markdown(report))
  process.stdout.write(`\n${passed}/${steps.length} steps passed; report in scripts/e2e/report/\n`)
  if (passed !== steps.length) process.exitCode = 1
}

function markdown(report: {
  at: string
  commit: string
  setup: Record<string, string>
  passed: number
  failed: number
  steps: Step[]
}): string {
  const lines = [
    '# End to end: spaces, memories, the employee list, badges from it, invitations',
    '',
    `Run ${report.at} on commit ${report.commit}: **${report.passed} passed, ${report.failed} failed**.`,
    '',
    `- Agent: ${report.setup.agent}.`,
    `- Stand-in: ${report.setup.standIn}.`,
    `- Not covered: ${report.setup.notCovered}.`,
    '',
    '| # | Step | Requirements | Result |',
    '|---|------|--------------|--------|',
    ...report.steps.map(
      (s, i) => `| ${i + 1} | ${s.name} | ${s.refs} | ${s.ok ? 'passed' : `**failed**: ${s.error}`} |`
    ),
    '',
    '## Evidence',
    '',
  ]
  for (const [i, s] of report.steps.entries()) {
    lines.push(`### ${i + 1}. ${s.name}`, '', '```json', JSON.stringify(s.evidence, null, 2).slice(0, 4000), '```', '')
  }
  return `${lines.join('\n')}\n`
}

main()
  .catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? error}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
  })
