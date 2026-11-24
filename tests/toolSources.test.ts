/**
 * The tool catalog as one map (ayni-spec D101): `tools.sources`, keyed by the source's id, holds each source's type and
 * connection, its account, availability, offer and bindings, its tier model (`access`) and what the pack says of each of
 * its tools, the step-up included. TOOL-CAT-001, TOOL-CAT-010 (a step-up belongs to one tool of one source).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { bundledToolNames, catalogWarnings, PackError, validatePackDocument } from '../src/config/pack.js'
import { ALWAYS_ALLOWED, BundledToolSource } from '../src/tools/bundled.js'
import { bundledSourceOf, ToolCatalog } from '../src/tools/catalog.js'
import { type Doc, toolsPack } from './toolFixtures.js'

const env = { ...process.env, HOME_BACKING_IDENTITY: 'did:webvh:x:home', OFFER: 'search, fetch_page', TIMEOUT: '12' }
const urls = { crmUrl: 'https://crm.example/mcp', searchUrl: 'https://search.example/mcp', xUrl: 'https://x.example' }

function doc(edit?: (pack: Doc) => void): Doc {
  const dir = toolsPack({ ...urls, edit })
  return parseYaml(readFileSync(join(dir, 'agent-pack.yaml'), 'utf8')) as Doc
}

function refusal(pack: Record<string, unknown>): string {
  try {
    validatePackDocument(pack, env)
  } catch (error) {
    if (error instanceof PackError) return error.message
    throw error
  }
  throw new Error('the pack was accepted')
}

describe('the keys of an earlier pack are not read (no backward compatibility, ayni-spec PR #123)', () => {
  it('leaves the keys one map replaced to the schema, which refuses them as keys it does not know', () => {
    const message = refusal(
      doc((p) => {
        p.mcp = { servers: [{ name: 'crm', transport: 'streamable-http', url: 'https://crm.example/mcp' }] }
        p.tools.http = [{ name: 'lookup', description: 'Looks up.', method: 'GET', url: 'https://x.example' }]
        p.actions = { wire_money: { authChallenge: { type: 'device' } } }
      })
    )
    expect(message).toContain('agent-pack fails schema validation')
    expect(message).toContain('must NOT have additional properties (mcp)')
    expect(message).not.toContain('is withdrawn')
  })

  it('refuses lazy and reconnect on an MCP server: nothing read them, the agent connects on first need (TOOL-MCP-003)', () => {
    for (const key of ['lazy', 'reconnect']) {
      const message = refusal(doc((p) => (p.tools.sources.websearch[key] = true)))
      expect(message).toContain('agent-pack fails schema validation')
      expect(message).toContain(`(${key})`)
    }
  })
})

describe('one map keyed by the source id (TOOL-CAT-001)', () => {
  it('gives every source its type, connection, access and declarations from its own entry', () => {
    const pack = validatePackDocument(doc(), env)
    const catalog = new ToolCatalog(pack)
    expect(catalog.source('websearch')).toMatchObject({ kind: 'mcp', transport: 'streamable-http', untrusted: true })
    expect(catalog.source('websearch')?.access).toMatchObject({ roles: { employee: ['*'] } })
    // an HTTP tool is one tool, named by its source's id, with its source's own tier model
    expect(catalog.source('purge')).toMatchObject({ kind: 'http', method: 'DELETE', tools: { purge: {} } })
    expect(catalog.source('purge')?.access?.roles?.guest).toEqual(['purge'])
    expect(catalog.source('post_to_x')?.tools).toEqual({ post_to_x: { effect: 'external' } })
  })

  it('coerces the connection of each type: a list and a number written as placeholders', () => {
    const pack = validatePackDocument(
      doc((p) => {
        p.tools.sources.websearch.offer = '$' + '{OFFER}'
        p.tools.sources.lookup.timeoutSeconds = '$' + '{TIMEOUT}'
      }),
      env
    )
    const sources = pack.tools?.sources ?? {}
    expect(sources.websearch).toMatchObject({ offer: ['search', 'fetch_page'] })
    expect(sources.lookup).toMatchObject({ timeoutSeconds: 12 })
  })

  it("refuses a key of another type's connection, a declaration of another tool, and a source with no type", () => {
    expect(refusal(doc((p) => (p.tools.sources.lookup.transport = 'stdio')))).toContain('(transport)')
    expect(refusal(doc((p) => (p.tools.sources.lookup.tools = { search: { effect: 'read' } })))).toContain(
      "tools.sources.lookup.tools.search: an HTTP tool is one tool, named by its source's id"
    )
    expect(refusal(doc((p) => (p.tools.sources.lookup.type = undefined)))).toContain(
      'tools.sources.lookup.type: a source says its type: mcp, http or bundled'
    )
    expect(refusal(doc((p) => (p.tools.sources.websearch.method = 'GET')))).toContain('(method)')
  })

  it('checks that the tier model of an HTTP tool names its own tool', () => {
    expect(refusal(doc((p) => (p.tools.sources.lookup.access.roles.employee = ['purge'])))).toContain(
      'rule 5: tool "purge" in tools.sources.lookup.access.roles.employee is not a tool of the source'
    )
  })
})

describe('a step-up belongs to one tool of one source (TOOL-CAT-010)', () => {
  it('asks it of that tool only, never of a tool of the same name in another source', () => {
    const pack = validatePackDocument(
      doc((p) => {
        // a second CRM, of the whole agent, whose tools have the same names as the first's
        p.tools.sources['crm-us'] = {
          type: 'mcp',
          title: 'CRM US',
          transport: 'streamable-http',
          url: 'https://crm-us.example/mcp',
          access: { roles: { sales: ['*'] } },
          tools: { 'delete-note': { stepUp: { authChallenge: { type: 'device' }, maxCredentialAge: 0 } } },
        }
      }),
      env
    )
    const catalog = new ToolCatalog(pack)
    const us = catalog.source('crm-us')
    const eu = catalog.source('relaticle')
    if (!us || !eu) throw new Error('sources missing')
    expect(catalog.stepUpOf(us, 'delete-note')).toMatchObject({
      authChallenge: { type: 'device' },
      maxCredentialAge: 0,
    })
    expect(catalog.stepUpTypeOf(us, 'delete-note')).toBe('device')
    expect(catalog.stepUpOf(eu, 'delete-note')).toBeUndefined()
    expect(catalog.stepUpTypeOf(eu, 'delete-note')).toBeNull()
  })

  it('refuses a challenge other than a device confirmation, naming the source and the tool: the rest are methods', () => {
    for (const type of ['email', 'face-match', 'document']) {
      const message = refusal(
        doc((p) => (p.tools.sources.lookup.tools = { lookup: { stepUp: { authChallenge: { type } } } }))
      )
      expect(message).toContain(
        `TOOL-CAT-010: tools.sources.lookup.tools.lookup.stepUp.authChallenge has the type ${type}: a tool's challenge is a device confirmation`
      )
    }
  })
})

describe("a step-up's re-authentication (D127, IDENT-AUTH-015, TOOL-CAT-010)", () => {
  /** the tools pack with an authentication of a badge, an email code, a face match and an authenticator app */
  const withMethods = (stepUp: Record<string, unknown>) =>
    doc((p) => {
      p.identity.directory = { file: '/var/run/secrets/directory.yaml' }
      p.identity.authentication = {
        request: 'on-demand',
        visitors: true,
        methods: {
          badge: {
            type: 'credential',
            credential: { jsonSchemaCredentialId: 'https://ecs.example/vt/schemas-badge-jsc.json' },
            subjectKey: ['badgeNumber'],
          },
          email: { type: 'email' },
          otp: { type: 'authenticator-app' },
        },
        combinations: [['badge'], ['email', 'otp']],
      }
      p.tools.sources.relaticle.tools['delete-note'] = { stepUp }
    })

  it('takes a set of enabled methods, confirming ones alone included, with maxAgeMinutes 0 by default', () => {
    const pack = validatePackDocument(withMethods({ authentication: { methods: ['otp'] } }), env)
    const catalog = new ToolCatalog(pack)
    const crm = catalog.source('relaticle')
    if (!crm) throw new Error('the CRM is missing')
    expect(catalog.stepUpOf(crm, 'delete-note')).toEqual({ authentication: { methods: ['otp'], maxAgeMinutes: 0 } })
    // the settings of a space read the types of the methods it asks (PROF-TOOL-001)
    expect(catalog.stepUpTypeOf(crm, 'delete-note')).toEqual(['authenticator-app'])
    const both = validatePackDocument(
      withMethods({
        authentication: { methods: ['email', 'otp'], maxAgeMinutes: 5 },
        authChallenge: { type: 'device' },
      }),
      env
    )
    expect(both.tools?.sources?.relaticle?.tools?.['delete-note']?.stepUp).toMatchObject({
      authentication: { methods: ['email', 'otp'], maxAgeMinutes: 5 },
      authChallenge: { type: 'device' },
    })
  })

  it('refuses a method that is not enabled, a set with none, and a set when nobody is ever identified', () => {
    expect(refusal(withMethods({ authentication: { methods: ['face'] } }))).toContain(
      'TOOL-CAT-010: tools.sources.relaticle.tools.delete-note.stepUp.authentication names [face], which identity.authentication.methods does not enable'
    )
    expect(refusal(withMethods({ authentication: { methods: [] } }))).toContain('agent-pack fails schema validation')
    const nobody = withMethods({ authentication: { methods: ['otp'] } })
    nobody.identity.authentication.combinations = []
    expect(refusal(nobody)).toContain(
      'IDENT-AUTH-015: tools.sources.relaticle.tools.delete-note.stepUp.authentication re-authenticates an identified person, and identity.authentication lists no combination'
    )
  })
})

describe('bundled tools as sources (TOOL-HTTP-002, TOOL-CAT-001)', () => {
  it('names a bundled tool by its source, which may take another id', () => {
    const pack = validatePackDocument(
      doc((p) => {
        p.tools.sources.workingMemory = undefined
        p.tools.sources.notes = { type: 'bundled', bundled: 'workingMemory', title: 'Notes' }
      }),
      env
    )
    const catalog = new ToolCatalog(pack)
    expect(bundledSourceOf(pack, 'working_memory')).toBe('notes')
    expect(catalog.source('notes')).toMatchObject({ kind: 'bundled', title: 'Notes', account: { kind: 'none' } })
    // a bundled tool no source names is a source of its bundled name, with its defaults
    expect(bundledSourceOf(pack, 'credential_requirements')).toBe('credentialIssuance')
    expect(catalog.source('credentialIssuance')).toMatchObject({ kind: 'bundled', availability: 'agent' })
  })

  it('turns one on by declaring it, one on by default off with enabled: false', () => {
    const pack = validatePackDocument(
      doc((p) => {
        p.tools.sources.stats = { type: 'bundled', bundled: 'statistics', access: { roles: { manager: ['*'] } } }
        p.tools.sources.workingMemory.enabled = false
      }),
      env
    )
    const names = bundledToolNames(pack)
    expect(names).toContain('statistics')
    expect(names).not.toContain('working_memory')
    expect(bundledToolNames(validatePackDocument(doc(), env))).not.toContain('statistics')
  })

  it("governs its tools by the source's access, and lets every Principal use one on their own records otherwise", async () => {
    const restricted = validatePackDocument(
      doc((p) => (p.tools.sources.workingMemory.access = { roles: { manager: ['working_memory'] } })),
      env
    )
    const spec = async (pack: typeof restricted, name: string) =>
      (await new BundledToolSource({ pack } as never).list()).find((s) => s.name === name)
    expect((await spec(restricted, 'working_memory'))?.access).toMatchObject({ roles: { manager: ['working_memory'] } })
    expect((await spec(restricted, 'working_memory'))?.source).toBe('workingMemory')
    expect((await spec(validatePackDocument(doc(), env), 'working_memory'))?.access).toEqual(ALWAYS_ALLOWED)
  })

  it('refuses two sources of one bundled tool, a tool it does not give, an effect, trust and an unknown name', () => {
    expect(refusal(doc((p) => (p.tools.sources.memory = { type: 'bundled', bundled: 'workingMemory' })))).toContain(
      'tools.sources.memory.bundled: workingMemory is also named by tools.sources.workingMemory'
    )
    const wrong = refusal(
      doc(
        (p) =>
          (p.tools.sources.workingMemory.tools = { recall: {}, working_memory: { effect: 'read', untrusted: true } })
      )
    )
    expect(wrong).toContain(
      'tools.sources.workingMemory.tools.recall: workingMemory gives the model working_memory, not recall'
    )
    expect(wrong).toContain('tools.sources.workingMemory.tools.working_memory.effect: a bundled tool has no effect')
    expect(wrong).toContain('tools.sources.workingMemory.tools.working_memory.untrusted: a bundled tool is trusted')
    expect(refusal(doc((p) => (p.tools.sources.workingMemory.bundled = 'memory')))).toContain(
      'tools.sources.workingMemory.bundled: "memory" is not one of statistics, generateImage'
    )
  })

  it('warns of no approver for a source of the whole agent only, by its key', () => {
    const noApprover = validatePackDocument(
      doc((p) => {
        p.approvals.approvers = undefined
      }),
      env
    )
    expect(catalogWarnings(noApprover).join('\n')).toContain('tools.sources.purge: the rule of purge is approval')
  })
})
