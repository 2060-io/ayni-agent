/**
 * What the tests of features and providers share (ayni-spec D120 to D124): a fake provider of Files 1.0 and Calendar 1.0
 * over streamable HTTP, never a real service, that declares the profiles as MCP extensions, lists the tools of the core
 * and of the capabilities it declares with descriptions and schemas of its own, keeps a few folders, files and events, and
 * records every call with the headers it carried; and the agent-pack of architecture §10.11 built on the tools pack.
 */
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CALENDAR_1_0, type FeatureProfile, FILES_1_0 } from '../src/features/profiles.js'
import { type Doc, toolsPack } from './toolFixtures.js'

/** A folder the provider lets its accounts work in (files §2). */
export interface FakeRoot {
  ref: string
  title: string
  path: string
  writable: boolean
  portable: boolean
}

/** What a fake provider declares of one profile, and how it lists its tools (FEAT-CORE-001, FEAT-CORE-002). */
export interface FakeDeclaration {
  version: string
  capabilities: string[]
  /** core tools it does not list, to be refused (TOOL-FEAT-011) */
  missing?: string[]
  /** `team-roots`: whether the store has the role `manager` (files §4.7) */
  'team-roots'?: { manager: boolean }
}

/** A share of a team root at the fake store: a membership (files §4.4, §4.7). */
export interface FakeShare {
  id: string
  role: string
  recipient: { address: string; name?: string }
  inherited: false
}

/** A team root the fake store keeps: its name, the request that made it, its members (files §4.7). */
export interface FakeTeamRoot {
  ref: string
  title: string
  requestId: string
  shares: FakeShare[]
}

/** An answer the fake gives a tool in place of its own, once each, in order (common §9). */
export interface FakeFailure {
  tool: string
  code: string
  reason?: string
  retryAfterSeconds?: number
  /** only for a call whose recipient is this address */
  address?: string
}

export interface FakeProviderOptions {
  /** the profiles it declares, by identifier; none by default */
  files?: FakeDeclaration
  calendar?: FakeDeclaration
  /** what the provider's own description of every tool says: never what a model reads (TOOL-FEAT-010) */
  description?: (tool: string) => string
  /** the annotations it lists, by tool: never what decides an effect (TOOL-FEAT-012) */
  annotations?: Record<string, Record<string, unknown>>
  /** tools of its own, outside the profiles: the extras (TOOL-CAT-003) */
  extras?: string[]
  /** the folders it lets an account work in */
  roots?: FakeRoot[]
  /** the reference of a file it names `/Reports/Q3.md` */
  q3Ref?: string
  /**
   * who a call's account is at the store, by its address: from `Ayni-Dav-Username` (`<name>@example.org`) or a bearer
   * token `tok_<name>Token` (`<name>@example.org`)
   */
  whoIs?: (headers: Record<string, string | string[] | undefined>) => string | undefined
}

export interface FakeProvider {
  url: string
  /** every call, with its arguments and the headers it carried, by their lower-case names */
  calls: { name: string; args: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }[]
  /** what a list of a folder answers beside its own items: an item of another folder, which the agent drops */
  foreignItem: boolean
  /** a read answers bytes of this type instead of the file's text */
  bytes?: { base64: string; mediaType: string; name: string }
  /** an answer that is not the profile's shape */
  malformed: boolean
  /** the team roots it made (files §4.7), by reference */
  teamRoots: Map<string, FakeTeamRoot>
  /** answers given in place of the tool's own, consumed in order */
  failures: FakeFailure[]
  /** the addresses a team root does not take, with the reason of `recipient-refused` */
  refuse: Map<string, string>
  declare(profile: 'files' | 'calendar', declaration: FakeDeclaration | undefined): void
  close(): Promise<void>
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

/** The server's own schema of a tool: loose, with its own words, taking the profile's required arguments. */
function serverSchema(profile: FeatureProfile, name: string): Record<string, unknown> {
  const tool = profile.tools.find((t) => t.name === name)
  const properties: Record<string, unknown> = {}
  for (const a of tool?.arguments ?? []) properties[a.name] = { description: `the server's own words on ${a.name}` }
  const required = (tool?.arguments ?? []).filter((a) => a.required && !a.capability).map((a) => a.name)
  return { type: 'object', properties, required }
}

/** Who an account is at a fake store: its user name, or the name in its token, at example.org. */
export function defaultWhoIs(headers: Record<string, string | string[] | undefined>): string | undefined {
  const user = headers['ayni-dav-username']
  if (typeof user === 'string' && user) return `${user}@example.org`
  const auth = headers.authorization
  const token = typeof auth === 'string' ? /^Bearer tok_(.+)Token$/.exec(auth)?.[1] : undefined
  return token ? `${token.replace(/^conn/, '')}@example.org` : undefined
}

const DEFAULT_ROOTS: FakeRoot[] = [
  { ref: '48213', title: '/Projects/Alpha', path: '/Projects/Alpha', writable: true, portable: true },
  { ref: '48214', title: '/Projects/Beta', path: '/Projects/Beta', writable: true, portable: true },
  { ref: 'dav-hr', title: '/HR', path: '/HR', writable: true, portable: false },
]

/** A stateless provider of Files 1.0 and Calendar 1.0 over streamable HTTP: a fresh server answers each request. */
export async function fakeProvider(options: FakeProviderOptions): Promise<FakeProvider> {
  const declarations: { files?: FakeDeclaration; calendar?: FakeDeclaration } = {
    ...(options.files ? { files: options.files } : {}),
    ...(options.calendar ? { calendar: options.calendar } : {}),
  }
  const roots = options.roots ?? DEFAULT_ROOTS
  const q3 = options.q3Ref ?? 'f-q3'
  const fake: Omit<FakeProvider, 'url' | 'close' | 'declare'> = {
    calls: [],
    foreignItem: false,
    malformed: false,
    teamRoots: new Map(),
    failures: [],
    refuse: new Map(),
  }
  const whoIs = options.whoIs ?? defaultWhoIs
  let made = 0
  const error = (code: string, extra: Record<string, unknown> = {}) => ({
    structured: { error: { code, message: `The store answered ${code}.`, ...extra } },
    isError: true,
  })
  const item = (root: string, ref: string, name: string, path: string, extra: Record<string, unknown> = {}) => ({
    ref,
    root,
    kind: 'file',
    name,
    path,
    parent: root,
    mediaType: 'text/markdown',
    version: 'v1',
    ...extra,
  })
  /** The team roots of files §4.7: made once per request, their members through the tools of `share`. */
  const teamAnswer = (
    name: string,
    args: Record<string, unknown>,
    caller: string | undefined
  ): { structured: unknown; isError?: boolean } | undefined => {
    const manager = declarations.files?.['team-roots']?.manager === true
    if (name === 'files_create_team_root') {
      const existing = [...fake.teamRoots.values()].find((t) => t.requestId === args.requestId)
      const team = existing ?? {
        ref: `team-${++made}`,
        title: String(args.name),
        requestId: String(args.requestId),
        shares: caller
          ? [
              {
                id: `sh-${made}-0`,
                role: manager ? 'manager' : 'editor',
                recipient: { address: caller },
                inherited: false,
              },
            ]
          : [],
      }
      fake.teamRoots.set(team.ref, team as FakeTeamRoot)
      return {
        structured: {
          root: { ref: team.ref, title: team.title, path: '/', writable: true, portable: true, team: true },
        },
      }
    }
    const team = fake.teamRoots.get(typeof args.root === 'string' ? args.root : '')
    if (!team) return undefined
    if (name === 'files_rename_root') {
      team.title = String(args.name)
      return {
        structured: {
          root: { ref: team.ref, title: team.title, path: '/', writable: true, portable: true, team: true },
        },
      }
    }
    if (args.ref !== team.ref) return undefined
    if (name === 'files_get')
      return {
        structured: {
          item: {
            ref: team.ref,
            root: team.ref,
            kind: 'folder',
            name: team.title,
            path: '/',
            webUrl: `https://store.example/folders/${team.ref}`,
          },
        },
      }
    if (name === 'files_shares') return { structured: { shares: team.shares } }
    if (name === 'files_share') {
      const address = String((args.recipients as { address: string }[] | undefined)?.[0]?.address ?? '')
      if (args.role === 'manager' && !manager) return error('not-supported', { field: 'role' })
      const refused = fake.refuse.get(address)
      if (refused) return error('recipient-refused', { reason: refused })
      const held = team.shares.find((s) => s.recipient.address === address)
      const share = held ?? {
        id: `sh-${team.ref}-${team.shares.length + 1}-${made++}`,
        role: '',
        recipient: { address },
        inherited: false as const,
      }
      share.role = String(args.role)
      if (!held) team.shares.push(share)
      return { structured: { shares: [share] } }
    }
    if (name === 'files_unshare') {
      const at = team.shares.findIndex((s) => s.id === args.share)
      if (at < 0) return error('not-found')
      team.shares.splice(at, 1)
      return { structured: { shares: team.shares } }
    }
    return undefined
  }
  const answer = (
    name: string,
    args: Record<string, unknown>,
    caller?: string
  ): { structured: unknown; isError?: boolean } => {
    const failing = fake.failures.findIndex(
      (f) =>
        f.tool === name &&
        (!f.address || (args.recipients as { address: string }[] | undefined)?.[0]?.address === f.address)
    )
    if (failing >= 0) {
      const [f] = fake.failures.splice(failing, 1)
      return error(f.code, {
        ...(f.reason ? { reason: f.reason } : {}),
        ...(f.retryAfterSeconds ? { retryAfterSeconds: f.retryAfterSeconds } : {}),
      })
    }
    const team = teamAnswer(name, args, caller)
    if (team) return team
    const root = typeof args.root === 'string' ? args.root : ''
    const known = roots.some((r) => r.ref === root) || fake.teamRoots.has(root)
    const notFound = { structured: { error: { code: 'not-found', message: 'No such item here.' } }, isError: true }
    if (fake.malformed && name !== 'files_roots' && name !== 'calendar_calendars') return { structured: { odd: true } }
    switch (name) {
      case 'files_roots': {
        const query = typeof args.query === 'string' ? args.query : ''
        return { structured: { roots: roots.filter((r) => r.path.startsWith(query)) } }
      }
      case 'files_list': {
        if (!known) return notFound
        const items = [item(root, q3, 'Q3.md', '/Reports/Q3.md')]
        if (fake.foreignItem) items.push(item('dav-hr', 'f-salaries', 'salaries.md', '/salaries.md'))
        return { structured: { folder: { ref: root, root, kind: 'folder', name: 'Alpha', path: '/' }, items } }
      }
      case 'files_get':
      case 'files_read': {
        if (!known || args.ref !== q3) return notFound
        const read = item(root, q3, fake.bytes?.name ?? 'Q3.md', '/Reports/Q3.md')
        if (name === 'files_get') return { structured: { item: read } }
        const content = fake.bytes
          ? { kind: 'bytes', base64: fake.bytes.base64, mediaType: fake.bytes.mediaType }
          : { kind: 'text', text: '# Q3\nRevenue grew.', mediaType: 'text/markdown' }
        return { structured: { item: read, content } }
      }
      case 'files_create':
        if (!known) return notFound
        return { structured: { item: item(root, 'f-new', String(args.name), `/${String(args.name)}`) } }
      case 'files_replace':
      case 'files_trash':
      case 'files_move':
        if (!known || args.ref !== q3) return notFound
        return { structured: { item: item(root, q3, 'Q3.md', '/Reports/Q3.md', { version: 'v2' }) } }
      case 'files_search':
        if (!known) return notFound
        return { structured: { items: [item(root, q3, 'Q3.md', '/Reports/Q3.md')] } }
      case 'files_share':
        if (!known) return notFound
        return { structured: { shares: [{ id: 's1', role: args.role, inherited: false }] } }
      case 'calendar_calendars':
        return {
          structured: {
            calendars: [{ ref: 'cal-team', title: 'Team', writable: true, portable: false, primary: true }],
          },
        }
      case 'calendar_list_events':
      case 'calendar_create_event': {
        const calendar = typeof args.calendar === 'string' ? args.calendar : ''
        if (calendar !== 'cal-team') return notFound
        const event = {
          ref: 'ev-1',
          calendar,
          title: String(args.title ?? 'Sync'),
          allDay: false,
          start: '2026-11-23T10:00:00+01:00',
          end: '2026-11-23T11:00:00+01:00',
          status: 'confirmed',
          busy: true,
          mine: true,
          recurring: false,
          version: 'e1',
        }
        return { structured: name === 'calendar_create_event' ? { event } : { events: [event] } }
      }
      case 'calendar_cancel_event':
        return { structured: { cancelled: true, ref: args.ref } }
      default:
        return { structured: { done: name } }
    }
  }
  const listed = () => {
    const out: Record<string, unknown>[] = []
    for (const [key, profile] of [
      ['files', FILES_1_0],
      ['calendar', CALENDAR_1_0],
    ] as const) {
      const declared = declarations[key]
      if (!declared) continue
      for (const tool of profile.tools) {
        if (tool.capability && !declared.capabilities.includes(tool.capability)) continue
        if (declared.missing?.includes(tool.name)) continue
        out.push({
          name: tool.name,
          description: options.description?.(tool.name) ?? `The server's own words on ${tool.name}.`,
          inputSchema: serverSchema(profile, tool.name),
          ...(options.annotations?.[tool.name] ? { annotations: options.annotations[tool.name] } : {}),
        })
      }
    }
    for (const extra of options.extras ?? [])
      out.push({
        name: extra,
        description: `An extra of the server: ${extra}.`,
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      })
    return out
  }
  const http: HttpServer = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const headers = { ...req.headers }
    const parsed = await body(req)
    const extensions: Record<string, object> = {}
    if (declarations.files) extensions[FILES_1_0.id] = { ...declarations.files }
    if (declarations.calendar) extensions[CALENDAR_1_0.id] = { ...declarations.calendar }
    const server = new Server({ name: 'fake-provider', version: '1.0.0' }, { capabilities: { tools: {}, extensions } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed() as never }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      fake.calls.push({ name: request.params.name, args, headers })
      const { structured, isError } = answer(request.params.name, args, whoIs(headers))
      return {
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured as Record<string, unknown>,
        ...(isError ? { isError: true } : {}),
      }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, parsed)
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  return Object.assign(fake as FakeProvider, {
    url: `http://127.0.0.1:${port}/mcp`,
    declare: (profile: 'files' | 'calendar', declaration: FakeDeclaration | undefined) => {
      if (declaration) declarations[profile] = declaration
      else delete declarations[profile]
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  })
}

/** The account of a space of a Nextcloud: a user name and an app password, sent in two headers (providers.md §1.1). */
export const DAV_ACCOUNT = {
  kind: 'space',
  fields: [
    { name: 'username', label: 'User name', pattern: '^[\\x21-\\x7E]{1,128}$' },
    { name: 'password', label: 'App password', pattern: '^[\\x21-\\x7E]{8,255}$' },
  ],
  apply: [
    { header: 'Ayni-Dav-Username', value: '{username}' },
    { header: 'Ayni-Dav-Password', value: '{password}' },
  ],
}

/** Each person's own account of a store, typed by the person in Your accounts (D102, D104). */
export const PERSONAL_ACCOUNT = {
  kind: 'personal',
  fields: [{ name: 'token', label: 'Access token', pattern: '^tok_[A-Za-z0-9]{8,64}$' }],
  apply: [{ header: 'Authorization', value: 'Bearer {token}' }],
}

export interface FeaturesPackOptions {
  nextcloudUrl: string
  driveUrl: string
  /** changes to the pack before it is written */
  edit?: (pack: Doc) => void
}

/**
 * The tools pack with the features of architecture §10.11: Files and Calendar with a contract, two providers of Files for
 * a Project space (Nextcloud with the space's account, the default; a drive of each person's own account), a provider of
 * Calendar, a provider of Files in Personal, and the organization's domains.
 */
export function featuresPack(options: FeaturesPackOptions): string {
  return toolsPack({
    crmUrl: 'http://127.0.0.1:1/mcp',
    searchUrl: 'http://127.0.0.1:1/mcp',
    xUrl: 'http://127.0.0.1:1',
    edit: (pack) => {
      pack.identity.organization = { emailDomains: ['example.org'] }
      pack.identity.roles = { ...pack.identity.roles, lead: { description: 'Leads projects.', canApprove: true } }
      pack.tools.features.files = { title: 'Files', profile: { id: 'org.ayni/files', version: '1.0' } }
      pack.tools.features.calendar = {
        title: 'Calendar',
        profile: { id: 'org.ayni/calendar', version: '1.0' },
        // a rule set once, for every provider (TOOL-FEAT-005)
        tools: { calendar_cancel_event: { call: 'confirm' } },
      }
      const access = { roles: { employee: ['*'] } }
      pack.tools.sources.nextcloud = {
        type: 'mcp',
        feature: 'files',
        title: 'Nextcloud',
        description: "A folder of the organization's Nextcloud, with an account of the space",
        transport: 'streamable-http',
        url: options.nextcloudUrl,
        headers: { 'Ayni-Nextcloud': 'https://cloud.example.org' },
        account: DAV_ACCOUNT,
        availability: 'spaces',
        access,
      }
      pack.tools.sources.drive = {
        type: 'mcp',
        feature: 'files',
        title: 'Google Drive',
        description: 'The files each person can open in their drive',
        transport: 'streamable-http',
        url: options.driveUrl,
        account: PERSONAL_ACCOUNT,
        availability: 'spaces',
        capabilities: ['folders', 'search', 'trash', 'share'],
        access,
      }
      pack.tools.sources['nextcloud-calendar'] = {
        type: 'mcp',
        feature: 'calendar',
        title: 'Nextcloud',
        transport: 'streamable-http',
        url: options.nextcloudUrl,
        headers: { 'Ayni-Nextcloud': 'https://cloud.example.org' },
        account: DAV_ACCOUNT,
        availability: 'spaces',
        access,
      }
      // Files in Personal: each person's own account of the same drive (TOOL-FEAT-022)
      pack.tools.sources['my-drive'] = {
        type: 'mcp',
        feature: 'files',
        title: 'Google Drive',
        transport: 'streamable-http',
        url: options.driveUrl,
        account: { kind: 'personal', from: 'drive' },
        availability: 'personal',
        access,
      }
      pack.spaces.templates.push({
        id: 'alpha',
        title: 'Project',
        kind: 'team',
        creators: ['employee'],
        membership: { mode: 'list' },
        rules: { allowedProviders: { default: ['stub'] } },
        features: [
          { feature: 'files', providers: ['nextcloud', 'drive'], default: 'nextcloud', add: 'owner' },
          { feature: 'calendar', providers: ['nextcloud-calendar'], add: 'owner' },
        ],
      })
      options.edit?.(pack)
    },
  })
}
