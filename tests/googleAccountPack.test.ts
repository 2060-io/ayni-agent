/**
 * A Google Workspace account in the agent-pack (ayni-spec D118, architecture §10.10): one person's own account declared
 * once in `tools.accounts` for Google Drive and Google Calendar, the scopes of each tool, the parameters of the sign-in
 * and the check by the ID token. TOOL-CAT-015, TOOL-CAT-020, TOOL-CAT-021, TOOL-FEAT-004, TOOL-FEAT-005, TOOL-OAUTH-017.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { PackError, validatePackDocument } from '../src/config/pack.js'
import { FILES_1_0 } from '../src/features/profiles.js'
import { ToolCatalog } from '../src/tools/catalog.js'
import { modelToolsOf } from '../src/tools/scopes.js'
import { DRIVE_TOOLS, googleSources } from './googleFixtures.js'
import { type Doc, toolsPack } from './toolFixtures.js'

const env = {
  ...process.env,
  HOME_BACKING_IDENTITY: 'did:webvh:x:home',
  TOOLS_GOOGLE_CLIENT_ID: 'client-of-the-tests',
  TOOLS_GOOGLE_CLIENT_SECRET: 'secret-of-the-tests',
  TOOLS_GITHUB_CLIENT_ID: 'Iv1.tests',
  TOOLS_GITHUB_CLIENT_SECRET: 'tests-secret',
}
const urls = { crmUrl: 'https://crm.example/mcp', searchUrl: 'https://search.example/mcp', xUrl: 'https://x.example' }

/** The dev pack with the tools of architecture §10.4, a directory, GitHub of §10.8, and the Google account of §10.10. */
function doc(edit?: (pack: Doc) => void): Doc {
  const dir = toolsPack({
    ...urls,
    edit: (p) => {
      p.identity.directory = { file: 'directory.yaml' }
      p.tools.features.code = { title: 'Code and issues' }
      p.tools.sources.github = {
        type: 'mcp',
        feature: 'code',
        title: 'GitHub',
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
        },
        availability: 'personal',
        offer: ['get_me', 'list_issues'],
        access: { roles: { employee: ['*'] } },
        tools: { get_me: { effect: 'read' } },
      }
      googleSources(p, {
        url: 'http://connector-google.internal:8000/mcp',
        issuer: 'https://accounts.google.com',
        domain: 'example.org',
      })
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

describe('the account of tools.accounts that several sources use (TOOL-CAT-020, TOOL-CAT-015)', () => {
  it('starts on the agent-pack of architecture §10.10: google, used by drive and calendar', () => {
    const pack = validatePackDocument(doc(), env)
    const catalog = new ToolCatalog(pack)
    expect(catalog.account('google')).toMatchObject({
      name: 'google',
      title: 'Google',
      accountOnly: true,
      account: {
        kind: 'personal',
        oauth: {
          client: { registration: 'pre-registered', issuer: 'https://accounts.google.com', id: 'client-of-the-tests' },
          resource: false,
          parameters: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
          loginHint: 'email',
          hostedDomain: 'example.org',
        },
        check: { idToken: { email: true, hostedDomain: 'example.org' }, label: '{email}' },
      },
    })
    // an account is no source: it gives the model nothing of its own
    expect(catalog.source('google')).toBeUndefined()
    expect(catalog.source('drive')?.account).toEqual({ kind: 'personal', from: 'google' })
    expect(catalog.source('calendar')?.account).toEqual({ kind: 'personal', from: 'google' })
    expect(catalog.source('drive')?.tools.files_create?.scopes).toEqual(['https://www.googleapis.com/auth/drive'])
  })

  it('refuses an account no source uses, naming it', () => {
    const unused = refusal(
      doc((p) => {
        for (const id of ['drive', 'calendar']) Reflect.deleteProperty(p.tools.sources, id)
      })
    )
    expect(unused).toContain('tools.accounts.google: no source uses it')
  })

  it('refuses a source that declares anything beside from: google, naming the source and the key', () => {
    const withOauth = refusal(
      doc((p) => (p.tools.sources.drive.account.oauth = { client: { registration: 'dynamic' } }))
    )
    expect(withOauth).toContain('tools.sources.drive.account: a person')
    expect(withOauth).toContain('tools.sources.drive.account.oauth: a source of the account google of tools.accounts')
    const withPatterns = refusal(
      doc((p) => (p.tools.sources.drive.account.tokenPatterns = ['ya29\\.[A-Za-z0-9_-]{20,}']))
    )
    expect(withPatterns).toContain(
      'tools.sources.drive.account.tokenPatterns: a source of the account google of tools.accounts declares kind and from only'
    )
  })

  it('refuses an id a source also has, a client of another registration, and a source that is not an MCP server', () => {
    const twice = refusal(
      doc((p) => {
        p.tools.accounts.drive = structuredClone(p.tools.accounts.google)
      })
    )
    expect(twice).toContain('tools.accounts.drive: drive is also the id of a source')
    const dynamic = refusal(
      doc((p) => {
        p.tools.accounts.google.oauth.client = { registration: 'dynamic' }
      })
    )
    expect(dynamic).toContain(
      'tools.accounts.google.oauth.client.registration: the client of an account of tools.accounts is pre-registered'
    )
    const http = refusal(
      doc((p) => {
        p.tools.features.lookup = { title: 'Lookup' }
        p.tools.sources.lookup.account = { kind: 'personal', from: 'google' }
        p.tools.sources.lookup.availability = 'personal'
      })
    )
    expect(http).toContain('tools.sources.lookup.type: lookup uses the account google of tools.accounts')
  })

  it('takes a from that names an account at any URL, and still names a source by the same rules (TOOL-CAT-015)', () => {
    // the two sources of one account need not share a URL: the account names none
    validatePackDocument(
      doc((p) => (p.tools.sources.calendar.url = 'http://connector-calendar.internal:8000/mcp')),
      env
    )
    expect(refusal(doc((p) => (p.tools.sources.drive.account.from = 'gmail')))).toContain(
      'tools.sources.drive.account.from: gmail is not a key of tools.sources or of tools.accounts'
    )
  })
})

describe('the scopes of each tool, the parameters of the sign-in, the check by the ID token (TOOL-CAT-021)', () => {
  it('refuses a parameter the agent sets itself, naming the account and the key', () => {
    for (const name of ['state', 'scope', 'nonce', 'login_hint', 'hd', 'redirect_uri', 'resource'])
      expect(refusal(doc((p) => (p.tools.accounts.google.oauth.parameters[name] = 'x'))), name).toContain(
        `tools.accounts.google.oauth.parameters.${name}: the agent sets ${name} itself`
      )
    // a source's own sign-in is held to the same rule
    expect(refusal(doc((p) => (p.tools.sources.github.account.oauth.parameters = { state: 'x' })))).toContain(
      'tools.sources.github.account.oauth.parameters.state'
    )
  })

  it('refuses a tool the model is given without scopes, where the others of its source declare theirs', () => {
    const cancel = refusal(doc((p) => Reflect.deleteProperty(p.tools.sources.calendar.tools, 'calendar_cancel_event')))
    expect(cancel).toContain(
      'tools.sources.calendar.tools.calendar_cancel_event.scopes: calendar_cancel_event is given to the model'
    )
    // a capability the source leaves in gives its tools: they declare their scopes too
    const share = refusal(doc((p) => p.tools.sources.drive.capabilities.push('share')))
    expect(share).toContain('tools.sources.drive.tools.files_share.scopes')
    // the tools of team-roots are the agent's code's, never the model's: they need not declare theirs
    expect(
      modelToolsOf('drive', { kind: 'mcp', capabilities: ['search', 'team-roots'], tools: {} }, FILES_1_0)
    ).toEqual([...Object.keys(DRIVE_TOOLS).filter((t) => t !== 'files_search'), 'files_search'])
  })

  it("refuses resource: false in a source's own account, and scopes of the account beside its tools' own", () => {
    expect(refusal(doc((p) => (p.tools.sources.github.account.oauth.resource = false)))).toContain(
      'tools.sources.github.account.oauth.resource: false is for an account of tools.accounts alone'
    )
    expect(refusal(doc((p) => (p.tools.accounts.google.oauth.scopes = ['openid'])))).toContain(
      'tools.accounts.google.oauth.scopes: the tools of drive declare the scopes they need'
    )
  })

  it('refuses scopes on a tool whose source has no OAuth sign-in, and on a tool of a feature', () => {
    expect(
      refusal(doc((p) => (p.tools.sources.lookup.tools = { lookup: { scopes: ['https://example.org/auth/read'] } })))
    ).toContain('tools.sources.lookup.tools.lookup.scopes: a tool says the scopes of an OAuth sign-in')
    expect(
      refusal(doc((p) => (p.tools.features.calendar.tools.calendar_cancel_event.scopes = ['https://example.org/x'])))
    ).toContain('tools.features.calendar.tools.calendar_cancel_event.scopes: the scopes a tool needs are its provider')
    // a provider gives the scopes of a tool of its profile, and nothing else of it (TOOL-FEAT-004)
    expect(refusal(doc((p) => (p.tools.sources.drive.tools.files_read.title = 'Read it')))).toContain(
      'tools.sources.drive.tools.files_read.title: what is said of a tool of org.ayni/files is said once'
    )
  })

  it('refuses check.idToken beside check.tool, a tool on an account, and the email without a directory', () => {
    const beside = refusal(doc((p) => (p.tools.sources.github.account.check.idToken = { email: true })))
    expect(beside).toContain('tools.sources.github.account.check.idToken: the ID token stands in place of check.tool')
    const tool = refusal(doc((p) => (p.tools.accounts.google.check = { tool: 'files_roots' })))
    expect(tool).toContain('tools.accounts.google.check.tool: an account of tools.accounts offers no tool')
    const none = refusal(doc((p) => Reflect.deleteProperty(p.identity, 'directory')))
    expect(none).toContain('tools.accounts.google.check.idToken.email: the email of the ID token is compared')
    const pointer = refusal(doc((p) => (p.tools.accounts.google.check.email = '/email')))
    expect(pointer).toContain('tools.accounts.google.check.email: a pointer into the result of check.tool')
  })

  it('refuses a login hint other than the email and a domain that is not one, by the schema', () => {
    expect(refusal(doc((p) => (p.tools.accounts.google.oauth.loginHint = 'name')))).toContain('loginHint')
    expect(refusal(doc((p) => (p.tools.accounts.google.oauth.hostedDomain = 'https://example.org')))).toContain(
      'hostedDomain'
    )
    expect(refusal(doc((p) => (p.tools.accounts.google.check.idToken.email = false)))).toContain('idToken/email')
  })
})

describe("the organization's own client (TOOL-OAUTH-017)", () => {
  it('refuses to start without TOOLS_GOOGLE_CLIENT_ID, and with an empty one, naming the client id', () => {
    expect(refusal(doc(), { ...env, TOOLS_GOOGLE_CLIENT_ID: undefined })).toContain(
      'tools.accounts.google.oauth.client.id: placeholder $' + '{TOOLS_GOOGLE_CLIENT_ID} has no value'
    )
    expect(
      refusal(
        doc((p) => (p.tools.accounts.google.oauth.client.id = '$' + '{TOOLS_GOOGLE_CLIENT_ID:-}')),
        { ...env, TOOLS_GOOGLE_CLIENT_ID: '' }
      )
    ).toContain('tools.accounts.google.oauth.client.id: a pre-registered client declares its id')
  })

  it('ships no Google client id or secret in its agent-packs, its chart or its docs', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? files(path) : [path]
      })
    const shipped = [...files('agent-packs'), ...files('charts'), ...files('docs'), 'Dockerfile']
    for (const file of shipped) {
      const text = readFileSync(file, 'utf8')
      // a Google client id ends in .apps.googleusercontent.com; a client secret starts with GOCSPX-
      expect(text, file).not.toMatch(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/)
      expect(text, file).not.toMatch(/GOCSPX-/)
    }
  })
})
