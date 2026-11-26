/**
 * Each person's own accounts, as the agent-pack declares them, the credentials a message may carry, and the OAuth client
 * (ayni-spec D104 to D110): TOOL-CAT-002, TOOL-CAT-013..017, TOOL-AVAIL-007, TOOL-ACCESS-010/013/014,
 * TOOL-OAUTH-001/002/005, TOOL-CONN-010/012.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { bundledToolNames, PackError, validatePackDocument } from '../src/config/pack.js'
import { DEFAULT_FEATURES } from '../src/config/packTypes.js'
import { atPointer, ConnectionService, labelFrom, packDigestOf } from '../src/core/connections.js'
import { CredentialScanner, credentialRecordText, maskCredential } from '../src/core/credentials.js'
import { renderPromptAddon } from '../src/core/promptAddon.js'
import { ToolCatalog } from '../src/tools/catalog.js'
import { personalFetch, withinServer } from '../src/tools/mcp.js'
import {
  authorizationServerUris,
  OAuthClient,
  parseBearerChallenge,
  pkcePair,
  protectedResourceUris,
  SourceUnavailable,
  sameResource,
  secureUrl,
} from '../src/tools/oauth.js'
import type { PersonalOAuthHandle } from '../src/tools/types.js'
import { type Doc, toolsPack } from './toolFixtures.js'

const env = {
  ...process.env,
  HOME_BACKING_IDENTITY: 'did:webvh:x:home',
  TOOLS_GITHUB_CLIENT_ID: 'Iv1.devnet',
  TOOLS_GITHUB_CLIENT_SECRET: 'devnet-secret',
}
const urls = { crmUrl: 'https://crm.example/mcp', searchUrl: 'https://search.example/mcp', xUrl: 'https://x.example' }

/** The sources of architecture §10.8: Relaticle in Sales spaces, GitHub in Personal and a Project space, a task tracker. */
function phase2(pack: Doc): void {
  pack.identity.directory = { file: 'directory.yaml' }
  pack.tools.features.code = { title: 'Code and issues' }
  pack.tools.features.tasks = { title: 'Tasks' }
  pack.tools.sources.relaticle = {
    type: 'mcp',
    feature: 'crm',
    title: 'Relaticle CRM',
    description: "The companies, people, notes and tasks of the space's workspace",
    transport: 'streamable-http',
    url: 'https://crm.2060.io/mcp',
    account: {
      kind: 'personal',
      oauth: { client: { registration: 'dynamic' } },
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
    offer: ['who-ami-tool', 'list-companies-tool', 'create-note-tool'],
    access: { roles: { employee: ['*'] } },
    tools: {
      'who-ami-tool': { effect: 'read', untrusted: false },
      'list-companies-tool': { effect: 'read', untrusted: false },
      'create-note-tool': { title: 'Add a note', effect: 'write', untrusted: false },
    },
  }
  pack.tools.sources.github = {
    type: 'mcp',
    feature: 'code',
    title: 'GitHub',
    description: 'Code, issues and pull requests in GitHub',
    transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    account: {
      kind: 'personal',
      oauth: {
        client: {
          registration: 'pre-registered',
          issuer: 'https://github.com/login/oauth',
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
    untrusted: true,
    access: { roles: { employee: ['*'] } },
    tools: { get_me: { effect: 'read' }, issue_write: { title: 'Open or change an issue', effect: 'write' } },
  }
  pack.tools.sources['github-project'] = {
    type: 'mcp',
    feature: 'code',
    title: 'GitHub repository',
    transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    account: { kind: 'personal', from: 'github' },
    availability: 'spaces',
    offer: ['list_issues', 'issue_write'],
    bindings: [
      { name: 'owner', label: 'Organization', argument: 'owner' },
      { name: 'repo', label: 'Repository', argument: 'repo' },
    ],
    access: { roles: { employee: ['*'] } },
  }
  pack.tools.sources.my_tasks = {
    type: 'http',
    feature: 'tasks',
    title: 'My tasks',
    description: 'Lists your open tasks in the task tracker',
    method: 'GET',
    url: 'https://tasks.example/api/v1/tasks?state=open',
    account: {
      kind: 'personal',
      fields: [{ name: 'token', label: 'API token', pattern: '^tt_[A-Za-z0-9]{32}$' }],
      apply: [{ header: 'Authorization', value: 'Bearer {token}' }],
      tokenPatterns: ['tt_[A-Za-z0-9]{32}'],
    },
    availability: 'personal',
    access: { roles: { employee: ['my_tasks'] } },
  }
  pack.spaces.templates.push({
    id: 'project-gh',
    title: 'Project',
    kind: 'team',
    creators: ['manager'],
    membership: { mode: 'list' },
    features: [{ feature: 'code', providers: ['github-project'], add: 'auto' }],
  })
  pack.spaces.templates.find((t: Doc) => t.id === 'sales').features.push({ feature: 'crm', providers: ['relaticle'] })
  Reflect.deleteProperty(pack.tools.sources.relaticle.account, 'fields')
}

function doc(edit?: (pack: Doc) => void): Doc {
  const dir = toolsPack({
    ...urls,
    edit: (p) => {
      // the CRM of phase 1 gives its place to Relaticle of phase 2
      Reflect.deleteProperty(p.tools.sources, 'relaticle')
      p.spaces.templates.find((t: Doc) => t.id === 'sales').features = [
        { feature: 'crm-status', providers: ['crm_status'] },
      ]
      phase2(p)
      edit?.(p)
    },
  })
  return parseYaml(readFileSync(join(dir, 'agent-pack.yaml'), 'utf8')) as Doc
}

function refusal(pack: Record<string, unknown>, e: Record<string, string | undefined> = env): string {
  try {
    validatePackDocument(pack, e)
  } catch (error) {
    if (error instanceof PackError) return error.message
    throw error
  }
  throw new Error('the pack was accepted')
}

describe("each person's own account in the agent-pack (TOOL-CAT-002, TOOL-CAT-013..017, TOOL-AVAIL-007)", () => {
  it('starts on the sources of architecture §10.8, and gives the model offer_connection', () => {
    const pack = validatePackDocument(doc(), env)
    const catalog = new ToolCatalog(pack)
    expect(catalog.source('github')).toMatchObject({
      account: { kind: 'personal', oauth: { client: { registration: 'pre-registered', id: 'Iv1.devnet' } } },
      availability: 'personal',
      url: 'https://api.githubcopilot.com/mcp/',
    })
    expect(catalog.source('github-project')?.account).toEqual({ kind: 'personal', from: 'github' })
    expect(bundledToolNames(pack)).toContain('offer_connection')
    // a pack with no personal source gives no offer_connection
    const none = validatePackDocument(
      doc((p) => {
        for (const id of ['relaticle', 'github', 'github-project', 'my_tasks'])
          Reflect.deleteProperty(p.tools.sources, id)
        p.spaces.templates = p.spaces.templates.filter((t: Doc) => t.id !== 'project-gh')
        p.spaces.templates.find((t: Doc) => t.id === 'sales').features = [
          { feature: 'crm-status', providers: ['crm_status'] },
        ]
      }),
      env
    )
    expect(bundledToolNames(none)).not.toContain('offer_connection')
  })

  it('refuses a personal account of none or of two of oauth, fields and from, naming the account (TOOL-CAT-013)', () => {
    const both = refusal(
      doc((p) => {
        p.tools.sources.github.account.fields = [{ name: 'token', label: 'Token' }]
        p.tools.sources.github.account.apply = [{ header: 'X-Token', value: '{token}' }]
      })
    )
    expect(both).toContain(
      "tools.sources.github.account: a person's own account declares exactly one of oauth, fields and apply, or from, not oauth and fields"
    )
  })

  it('refuses OAuth on an HTTP tool, a personal account on stdio, and an Authorization of its own beside OAuth', () => {
    expect(
      refusal(
        doc(
          (p) =>
            (p.tools.sources.my_tasks.account = { kind: 'personal', oauth: { client: { registration: 'dynamic' } } })
        )
      )
    ).toContain('tools.sources.my_tasks.account.oauth: OAuth is for an MCP server only')
    expect(
      refusal(
        doc((p) => {
          p.tools.sources.github.transport = 'stdio'
          p.tools.sources.github.command = 'github-mcp'
          Reflect.deleteProperty(p.tools.sources.github, 'url')
          Reflect.deleteProperty(p.tools.sources, 'github-project')
          p.spaces.templates = p.spaces.templates.filter((t: Doc) => t.id !== 'project-gh')
        })
      )
    ).toContain("tools.sources.github.transport: a person's own account reaches a remote MCP server")
    expect(refusal(doc((p) => (p.tools.sources.github.headers = { Authorization: 'Bearer x' })))).toContain(
      'tools.sources.github.headers.Authorization'
    )
  })

  it('refuses a pre-registered client without its id once placeholders are resolved, and another registration with one', () => {
    const unset = refusal(
      doc((p) => (p.tools.sources.github.account.oauth.client.id = '$' + '{TOOLS_GITHUB_CLIENT_ID:-}')),
      { ...env, TOOLS_GITHUB_CLIENT_ID: '' }
    )
    expect(unset).toContain('tools.sources.github.account.oauth.client.id')
    const missing = refusal(doc(), { ...env, TOOLS_GITHUB_CLIENT_ID: undefined })
    expect(missing).toContain('tools.sources.github.account.oauth.client.id')
    expect(refusal(doc((p) => (p.tools.sources.relaticle.account.oauth.client.id = 'x')))).toContain(
      'tools.sources.relaticle.account.oauth.client.id: only a pre-registered client declares it'
    )
    expect(refusal(doc((p) => (p.tools.sources.relaticle.account.oauth.client.registration = 'implicit')))).toContain(
      'tools.sources.relaticle.account.oauth.client.registration'
    )
    expect(
      refusal(doc((p) => (p.tools.sources.github.account.oauth.bindingRequest = { parameter: 'workspace' })))
    ).toContain('tools.sources.github.account.oauth.bindingRequest: the account declares no binding')
    // Relaticle asks its workspace at the sign-in (D110, layer a)
    validatePackDocument(
      doc((p) => (p.tools.sources.relaticle.account.oauth.bindingRequest = { parameter: 'workspace' })),
      env
    )
  })

  it('refuses a from that names an unknown source, a source with a binding, or one at another URL (TOOL-CAT-015)', () => {
    expect(refusal(doc((p) => (p.tools.sources['github-project'].account.from = 'gitlab')))).toContain(
      'tools.sources.github-project.account.from: gitlab is not a key of tools.sources'
    )
    expect(refusal(doc((p) => (p.tools.sources['github-project'].account.from = 'relaticle')))).toContain(
      'tools.sources.github-project.account.from: relaticle declares a binding'
    )
    expect(refusal(doc((p) => (p.tools.sources['github-project'].url = 'https://other.example/mcp')))).toContain(
      'tools.sources.github-project.account.from: github is at another URL'
    )
  })

  it('refuses a token pattern that does not compile, naming it (TOOL-CAT-016)', () => {
    expect(refusal(doc((p) => (p.tools.sources.github.account.tokenPatterns = ['gh['])))).toContain(
      'tools.sources.github.account.tokenPatterns: "gh[" is not a regular expression'
    )
  })

  it('refuses a check by a tool that writes, a binding without check.binding, and an email check without a directory', () => {
    expect(refusal(doc((p) => (p.tools.sources.relaticle.account.check.tool = 'create-note-tool')))).toContain(
      'tools.sources.relaticle.account.check.tool: create-note-tool is of effect write'
    )
    expect(refusal(doc((p) => Reflect.deleteProperty(p.tools.sources.relaticle.account.check, 'binding')))).toContain(
      'tools.sources.relaticle.account.check.binding'
    )
    expect(refusal(doc((p) => (p.tools.sources.relaticle.account.binding = 'region')))).toContain(
      'tools.sources.relaticle.account.binding: region is not a binding of the source'
    )
    expect(refusal(doc((p) => Reflect.deleteProperty(p.identity, 'directory')))).toContain(
      'tools.sources.relaticle.account.check.email: the email of an account is compared with the person'
    )
    expect(refusal(doc((p) => (p.tools.sources.relaticle.account.check.email = 'user/email')))).toContain(
      'tools.sources.relaticle.account.check.email: "user/email" is not a JSON pointer'
    )
  })

  it('still refuses the kind organization, of phase 3', () => {
    expect(refusal(doc((p) => (p.tools.sources.lookup.account = { kind: 'organization' })))).toContain('phase 3')
  })

  it('tells the model never to ask for a credential when the pack declares a personal source (TOOL-CONN-012)', () => {
    const base = {
      features: DEFAULT_FEATURES,
      agentLanguage: 'en',
      hasTools: true,
      hasRequestableTools: false,
      challengesConfigured: false,
    }
    const rule = 'never ask for a password, a token or a key in a conversation'
    expect(renderPromptAddon({ ...base, personalAccounts: true })).toContain(rule)
    expect(renderPromptAddon(base)).not.toContain(rule)
  })

  it('digests how the pack connects a source: another client id is another account (TOOL-CONN-009)', () => {
    const pack = validatePackDocument(doc(), env)
    const catalog = new ToolCatalog(pack)
    const github = catalog.source('github')
    const other = validatePackDocument(doc(), { ...env, TOOLS_GITHUB_CLIENT_ID: 'Iv1.other' })
    expect(packDigestOf(github as never)).not.toBe(packDigestOf(new ToolCatalog(other).source('github') as never))
  })
})

describe('a credential in a message (D109, TOOL-ACCESS-013/014, TOOL-CAT-016)', () => {
  const pack = validatePackDocument(doc(), env)
  const scanner = new CredentialScanner(pack)
  const ghp = `ghp_${'a'.repeat(36)}`

  it('finds a pattern of a source and names it, and masks each credential to its first four characters', () => {
    expect(scanner.scan(`my token is ${ghp} please`)).toEqual({
      text: 'my token is ghp_… please',
      count: 1,
      source: 'github',
    })
    expect(scanner.scan(`tt_${'x'.repeat(32)}`)).toMatchObject({ text: 'tt_x…', source: 'my_tasks' })
    expect(maskCredential('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA…')
  })

  it('finds the well-known formats, a JSON Web Token and a private key in PEM, and no match of fewer than 16', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123_-x'
    for (const [text, masked] of [
      ['AKIAIOSFODNN7EXAMPLE in a sentence', 'AKIA… in a sentence'],
      [`a key xoxb-${'1'.repeat(12)}-abc`, 'a key xoxb…'],
      [`AIza${'B'.repeat(35)}`, 'AIza…'],
      [`sk_live_${'c'.repeat(24)}`, 'sk_l…'],
      [`sk-ant-api03-${'d'.repeat(20)}`, 'sk-a…'],
      [`sk-${'e'.repeat(40)}`, 'sk-e…'],
      [`bearer ${jwt}`, 'bearer eyJh…'],
      [`github_pat_${'f'.repeat(30)}`, 'gith…'],
    ])
      expect(scanner.scan(text as string)?.text).toBe(masked)
    const pem =
      'here:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\nthanks'
    expect(scanner.scan(pem)?.text).toBe('here:\n----…\nthanks')
    expect(scanner.scan('a short ghp_abcdefgh here')).toBeUndefined()
    expect(scanner.scan('nothing to see')).toBeUndefined()
  })

  it('tells the model only that a message was held back, of which source', () => {
    expect(credentialRecordText('GitHub')).toContain('held back because it carried a credential of GitHub')
    expect(credentialRecordText(undefined)).not.toContain('credential of')
  })
})

describe('the check of an account and the record of the accounts to connect (TOOL-CONN-010, TOOL-CONN-013)', () => {
  const read = { workspace: { id: 'ws-1', name: 'ayni-dev-agent' }, user: { email: 'ana@2060.io' }, 'a/b': { '~x': 1 } }

  it('reads JSON pointers and builds the label, none when a pointer finds nothing', () => {
    expect(atPointer(read, '/workspace/id')).toBe('ws-1')
    expect(atPointer(read, '/a~1b/~0x')).toBe(1)
    expect(atPointer(read, '/missing/x')).toBeUndefined()
    expect(labelFrom('{/user/email} · {/workspace/name}', read)).toBe('ana@2060.io · ayni-dev-agent')
    expect(labelFrom('{/user/login}', read)).toBeUndefined()
    expect(labelFrom(`{/user/email}${'x'.repeat(100)}`, read)?.length).toBe(80)
  })

  it('writes one line per account, cut to 120 characters, connect or reconnect', () => {
    expect(
      ConnectionService.record([
        {
          source: 'github',
          title: 'GitHub',
          description: 'Code, issues and pull requests in GitHub',
          method: 'oauth',
          why: 'connect',
        },
        {
          source: 'relaticle',
          title: 'Relaticle CRM',
          method: 'oauth',
          why: 'reconnect',
          binding: { label: 'Workspace', value: 'ws-1', valueLabel: 'ayni-dev-agent' },
        },
      ])
    ).toBe(
      'Accounts this person can connect, with the tool offer_connection:\n- github: GitHub, Code, issues and pull requests in GitHub (not connected)\n- relaticle: Relaticle CRM (Workspace: ayni-dev-agent) (to reconnect)'
    )
    expect(ConnectionService.record([])).toBeUndefined()
  })
})

describe('OAuth as MCP defines it, the client (TOOL-OAUTH-001/002/005, TOOL-ACCESS-010)', () => {
  it('reads the well-known URIs in the order of MCP authorization', () => {
    expect(authorizationServerUris('https://github.com/login/oauth')).toEqual([
      'https://github.com/.well-known/oauth-authorization-server/login/oauth',
      'https://github.com/.well-known/openid-configuration/login/oauth',
      'https://github.com/login/oauth/.well-known/openid-configuration',
    ])
    expect(authorizationServerUris('https://crm.2060.io')).toEqual([
      'https://crm.2060.io/.well-known/oauth-authorization-server',
      'https://crm.2060.io/.well-known/openid-configuration',
    ])
    expect(protectedResourceUris('https://crm.2060.io/mcp')).toEqual([
      'https://crm.2060.io/.well-known/oauth-protected-resource/mcp',
      'https://crm.2060.io/.well-known/oauth-protected-resource',
    ])
    expect(protectedResourceUris('https://api.githubcopilot.com/mcp/')[0]).toBe(
      'https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/'
    )
  })

  it('reads a Bearer challenge, compares resources, takes HTTPS or the loopback only, and makes a PKCE pair', () => {
    expect(
      parseBearerChallenge('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/mcp", scope="a b"')
    ).toEqual({ resource_metadata: 'https://x/.well-known/oauth-protected-resource/mcp', scope: 'a b' })
    expect(parseBearerChallenge('Bearer error="insufficient_scope", scope="files:write"')?.error).toBe(
      'insufficient_scope'
    )
    expect(sameResource('https://API.githubcopilot.com/mcp/', 'https://api.githubcopilot.com/mcp')).toBe(true)
    expect(sameResource('https://crm.2060.io/mcp', 'https://crm.2060.io/other')).toBe(false)
    expect(secureUrl('http://crm.example/mcp')).toBe(false)
    expect(secureUrl('http://127.0.0.1:4000/mcp')).toBe(true)
    const { verifier, challenge } = pkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('refuses a server whose metadata names another resource, an issuer that is not its own, and one without S256', async () => {
    let prm: Record<string, unknown> = {}
    let as: Record<string, unknown> = {}
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url?.startsWith('/.well-known/oauth-protected-resource')) return res.end(JSON.stringify(prm))
      if (req.url === '/.well-known/oauth-authorization-server') return res.end(JSON.stringify(as))
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const client = new OAuthClient()
    try {
      prm = { resource: `${base}/other`, authorization_servers: [base] }
      await expect(client.discover(`${base}/mcp`)).rejects.toThrow('names another resource')
      prm = { resource: `${base}/mcp`, authorization_servers: [] }
      await expect(client.discover(`${base}/mcp`)).rejects.toThrow('names no authorization server')
      prm = { resource: `${base}/mcp`, authorization_servers: [base] }
      expect((await client.discover(`${base}/mcp`)).authorizationServers).toEqual([base])
      as = {
        issuer: 'https://evil.example',
        authorization_endpoint: `${base}/a`,
        token_endpoint: `${base}/t`,
        code_challenge_methods_supported: ['S256'],
      }
      await expect(client.metadata(base)).rejects.toThrow(SourceUnavailable)
      as = { issuer: base, authorization_endpoint: `${base}/a`, token_endpoint: `${base}/t` }
      await expect(client.metadata(base)).rejects.toThrow('does not support PKCE with S256')
      as = { ...as, code_challenge_methods_supported: ['plain'] }
      await expect(client.metadata(base)).rejects.toThrow('does not support PKCE with S256')
      as = { ...as, code_challenge_methods_supported: ['S256'] }
      expect((await client.metadata(base)).issuer).toBe(base)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('sends a token only to the server it is for, never following a redirect (no token passthrough)', async () => {
    const sent: { url: string; init?: RequestInit }[] = []
    const base = async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    }
    const handle = {
      accountId: 'acc_1',
      url: 'https://api.githubcopilot.com/mcp/',
      token: async () => 'ghu_token_of_ana_0000000000',
      after401: async () => undefined,
      refusedAgain: async () => undefined,
      insufficientScope: async () => undefined,
      secrets: () => [],
      settled: async () => undefined,
    } satisfies PersonalOAuthHandle
    const fetchOf = personalFetch(handle.url, handle, base)
    await fetchOf('https://api.githubcopilot.com/mcp/', { method: 'POST' })
    expect(new Headers(sent[0]?.init?.headers).get('authorization')).toBe('Bearer ghu_token_of_ana_0000000000')
    expect(sent[0]?.init?.redirect).toBe('error')
    await expect(fetchOf('https://evil.example/mcp/', { method: 'POST' })).rejects.toThrow('another server')
    await expect(fetchOf('https://api.githubcopilot.com/other', { method: 'POST' })).rejects.toThrow('another server')
    expect(sent).toHaveLength(1)
    expect(withinServer('https://crm.2060.io/mcp', 'https://crm.2060.io/mcp')).toBe(true)
    expect(withinServer('https://crm.2060.io/mcpx', 'https://crm.2060.io/mcp')).toBe(false)
  })
})
