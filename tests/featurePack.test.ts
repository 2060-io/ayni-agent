/**
 * Features and providers in the agent-pack (ayni-spec D120 to D124, D145, D150): what the agent starts on and what it
 * refuses, naming the feature, the source or the template and the field (TOOL-FEAT-001 to 005, TOOL-FEAT-023,
 * TOOL-AVAIL-002). The loader is all or nothing: a refused pack starts nothing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { catalogWarnings, PackError, validatePackDocument } from '../src/config/pack.js'
import { ToolCatalog } from '../src/tools/catalog.js'
import { featuresPack } from './featureFixtures.js'
import type { Doc } from './toolFixtures.js'

const env = {
  ...process.env,
  HOME_BACKING_IDENTITY: 'did:webvh:x:home',
  SEARCH_API_KEY: 'k',
  MANAGER_NAME: 'ayni-manager',
}

/** The pack of architecture §10.11, as written, with a change. */
function doc(edit?: (pack: Doc) => void): Doc {
  const dir = featuresPack({ nextcloudUrl: 'https://nc.example/mcp', driveUrl: 'https://drive.example/mcp' })
  const pack = parseYaml(readFileSync(join(dir, 'agent-pack.yaml'), 'utf8')) as Doc
  edit?.(pack)
  return pack
}

function refusal(pack: Doc): string {
  try {
    validatePackDocument(pack, env)
  } catch (error) {
    if (error instanceof PackError) return `${error.message}\n${error.details.join('\n')}`
    throw error
  }
  throw new Error('the pack was accepted')
}

describe('the features of the agent-pack (TOOL-FEAT-001)', () => {
  it('starts on a feature with a contract and on categories, each with its title', () => {
    const pack = validatePackDocument(doc(), env)
    const catalog = new ToolCatalog(pack)
    expect(catalog.feature('files')).toMatchObject({ id: 'files', title: 'Files' })
    expect(catalog.feature('files')?.profile?.id).toBe('org.ayni/files')
    expect(catalog.feature('crm')).toEqual({ id: 'crm', title: 'CRM', tools: {} })
    expect(catalog.profileOf(catalog.source('drive') ?? {})?.version).toBe('1.0')
  })

  it('refuses a profile it does not know, by its id or its major version, naming the feature and the field', () => {
    expect(
      refusal(doc((p) => (p.tools.features.mail = { title: 'Mail', profile: { id: 'org.ayni/mail', version: '1.0' } })))
    ).toContain('tools.features.mail.profile: org.ayni/mail 1.0 is no feature profile this agent knows')
    expect(refusal(doc((p) => (p.tools.features.files.profile.version = '2.0')))).toContain(
      'tools.features.files.profile: org.ayni/files 2.0 is no feature profile this agent knows'
    )
    // a later minor of a major it knows is taken (feature profiles common §14)
    expect(() =>
      validatePackDocument(
        doc((p) => (p.tools.features.files.profile.version = '1.3')),
        env
      )
    ).not.toThrow()
  })

  it('refuses a feature with no title, a malformed id, and two features of one profile', () => {
    expect(refusal(doc((p) => (p.tools.features.files.title = undefined)))).toMatch(/\/tools\/features\/files.*title/)
    expect(refusal(doc((p) => (p.tools.features.Files = { title: 'Files' })))).toContain('/tools/features')
    expect(
      refusal(
        doc((p) => (p.tools.features.docs = { title: 'Docs', profile: { id: 'org.ayni/files', version: '1.0' } }))
      )
    ).toContain('tools.features.docs.profile: org.ayni/files is also the profile of files: one feature per profile')
  })
})

describe('the feature each source serves (TOOL-FEAT-002)', () => {
  it('refuses an MCP server or an HTTP tool that names none, or one the map does not hold, and a bundled tool that names one', () => {
    expect(refusal(doc((p) => (p.tools.sources.websearch.feature = undefined)))).toContain(
      'tools.sources.websearch.feature: every MCP server and HTTP tool names the feature it serves'
    )
    expect(refusal(doc((p) => (p.tools.sources.lookup.feature = 'maps')))).toContain(
      'tools.sources.lookup.feature: maps is not a key of tools.features'
    )
    expect(refusal(doc((p) => (p.tools.sources.workingMemory.feature = 'files')))).toContain(
      'tools.sources.workingMemory.feature: a bundled tool is the agent'
    )
  })
})

describe('one provider of a feature in a space (TOOL-FEAT-003)', () => {
  it('refuses a second provider of the whole agent, and one of the whole agent beside a template that names one', () => {
    const second = refusal(
      doc((p) => (p.tools.sources['websearch-2'] = { ...p.tools.sources.websearch, title: 'Another search' }))
    )
    expect(second).toContain(
      'tools.features.search: websearch and websearch-2 would both be providers of search in Personal'
    )
    const beside = refusal(
      doc((p) => {
        p.spaces.templates
          .find((t: Doc) => t.id === 'sales')
          .features.push({ feature: 'search', providers: ['crm_status'] })
        p.tools.sources.crm_status.feature = 'search'
      })
    )
    expect(beside).toContain(
      'websearch, of availability agent, already provides search in every space: a space of sales would hold two providers of it (TOOL-FEAT-003)'
    )
  })

  it('starts on a provider of Personal and a provider of spaces of one feature', () => {
    // my-drive in Personal, nextcloud and drive in the Project spaces: one at a time in each
    expect(() => validatePackDocument(doc(), env)).not.toThrow()
  })

  it('refuses a template that names a feature twice', () => {
    expect(
      refusal(
        doc((p) =>
          p.spaces.templates
            .find((t: Doc) => t.id === 'alpha')
            .features.push({ feature: 'files', providers: ['drive'] })
        )
      )
    ).toContain('spaces.templates.alpha.features[2].feature: files is named twice in the template')
  })
})

describe('a provider of a feature with a contract (TOOL-FEAT-004)', () => {
  it('refuses an HTTP tool, a source of the whole agent, an unknown capability, an offer of the profile, a list of the location', () => {
    expect(
      refusal(
        doc((p) => {
          p.tools.sources.lookup.feature = 'files'
        })
      )
    ).toContain('tools.sources.lookup.type: a provider of files, a feature with a contract, is an MCP server')
    expect(
      refusal(
        doc((p) => {
          p.tools.sources['my-drive'].availability = 'agent'
        })
      )
    ).toContain(
      'tools.sources.my-drive.availability: a provider of files, a feature with a contract, is of availability spaces or personal'
    )
    expect(refusal(doc((p) => (p.tools.sources.drive.capabilities = ['folders', 'comments'])))).toContain(
      'tools.sources.drive.capabilities: comments is no capability of org.ayni/files 1.0'
    )
    expect(refusal(doc((p) => (p.tools.sources.drive.offer = ['files_search'])))).toContain(
      'tools.sources.drive.offer: files_search has the prefix of org.ayni/files'
    )
    expect(
      refusal(doc((p) => (p.tools.sources.drive.bindings = [{ name: 'root', label: 'Folder', argument: 'root' }])))
    ).toContain('tools.sources.drive.bindings.root: root is the location of org.ayni/files')
    expect(refusal(doc((p) => (p.tools.sources.drive.tools = { files_read: { effect: 'read' } })))).toContain(
      'tools.sources.drive.tools.files_read.effect: what is said of a tool of org.ayni/files is said once, on the feature files'
    )
    expect(refusal(doc((p) => (p.tools.sources.drive.list = { label: 'Folders' })))).toContain('(list)')
    // an extra of the provider, outside the profile, is offered and declared on the source
    expect(() =>
      validatePackDocument(
        doc((p) => {
          p.tools.sources.drive.offer = ['drive_about']
          p.tools.sources.drive.tools = { drive_about: { effect: 'read' } }
        }),
        env
      )
    ).not.toThrow()
  })

  it('refuses capabilities on a provider of a category', () => {
    expect(refusal(doc((p) => (p.tools.sources.relaticle.capabilities = ['search'])))).toContain(
      'tools.sources.relaticle.capabilities: crm has no contract'
    )
  })
})

describe("a feature's own rules of its profile's tools (TOOL-FEAT-005)", () => {
  it("takes a rule and a step-up, and refuses an effect, a title, a trust and a tool the profile's version lacks", () => {
    const pack = validatePackDocument(doc(), env)
    const catalog = new ToolCatalog(pack)
    const calendar = catalog.source('nextcloud-calendar')
    if (!calendar) throw new Error('no calendar')
    expect(catalog.packRuleOf(calendar, 'calendar_cancel_event')).toMatchObject({ rule: 'confirm', from: 'declared' })
    expect(catalog.effectOf(calendar, 'calendar_cancel_event', { readOnlyHint: true })).toBe('delete')
    expect(
      refusal(doc((p) => (p.tools.features.calendar.tools.calendar_cancel_event = { call: 'confirm', effect: 'read' })))
    ).toContain(
      "tools.features.calendar.tools.calendar_cancel_event.effect: the effect of a tool of a profile is the profile's"
    )
    expect(refusal(doc((p) => (p.tools.features.calendar.tools.calendar_delete = { call: 'confirm' })))).toContain(
      'tools.features.calendar.tools.calendar_delete: calendar_delete is no tool of org.ayni/calendar 1.0'
    )
    expect(refusal(doc((p) => (p.tools.features.crm.tools = { 'create-note': { call: 'approval' } })))).toContain(
      'tools.features.crm.tools: crm is a category'
    )
  })
})

describe("the templates' features (TOOL-AVAIL-002)", () => {
  it('refuses an unknown feature, a provider of another feature or availability, a default not among them, auto with no default', () => {
    const edit = (entry: Doc) => (p: Doc) => p.spaces.templates.find((t: Doc) => t.id === 'alpha').features.push(entry)
    expect(refusal(doc(edit({ feature: 'maps', providers: ['drive'] })))).toContain(
      'spaces.templates.alpha.features[2].feature: maps is not a key of tools.features'
    )
    expect(refusal(doc(edit({ feature: 'crm', providers: ['nextcloud'] })))).toContain(
      'spaces.templates.alpha.features[2].providers: nextcloud serves files, not crm'
    )
    expect(refusal(doc(edit({ feature: 'crm', providers: ['ghost'] })))).toContain(
      'spaces.templates.alpha.features[2].providers: ghost is not a key of tools.sources'
    )
    const entry = (p: Doc) => p.spaces.templates.find((t: Doc) => t.id === 'alpha').features[0]
    expect(refusal(doc((p) => (entry(p).default = 'nextcloud-calendar')))).toContain(
      'spaces.templates.alpha.features[0].default: nextcloud-calendar is not among its providers'
    )
    expect(
      refusal(
        doc((p) => {
          entry(p).add = 'auto'
          entry(p).default = undefined
        })
      )
    ).toContain(
      'spaces.templates.alpha.features[0].default: an entry added by itself with several providers names its default'
    )
  })

  it('takes any value where a provider of each person own account serves a contract, and refuses it elsewhere', () => {
    expect(() =>
      validatePackDocument(
        doc((p) => (p.spaces.templates.find((t: Doc) => t.id === 'alpha').features[0].any = true)),
        env
      )
    ).not.toThrow()
    expect(
      refusal(doc((p) => (p.spaces.templates.find((t: Doc) => t.id === 'alpha').features[1].any = true)))
    ).toContain('spaces.templates.alpha.features[1].any: no provider of the entry can take any value')
  })

  it("refuses a template's withdrawn tools in words, before anything else", () => {
    expect(
      refusal(doc((p) => (p.spaces.templates.find((t: Doc) => t.id === 'sales').tools = [{ source: 'relaticle' }])))
    ).toContain('spaces.templates.sales.tools is withdrawn: a template names its features')
  })

  it('warns of a provider of spaces that no template names', () => {
    const pack = validatePackDocument(
      doc((p) => p.spaces.templates.find((t: Doc) => t.id === 'alpha').features.pop()),
      env
    )
    expect(catalogWarnings(pack).join('\n')).toContain(
      'tools.sources.nextcloud-calendar: a source of availability spaces that no template names as a provider of its feature'
    )
  })
})

describe("a team space's folder managed by the agent, in the agent-pack (TOOL-FEAT-023)", () => {
  const managed = (p: Doc) => {
    p.tools.sources.drive.manage = {
      as: 'manager',
      apply: [{ header: 'Ayni-Dav-Username', value: '$' + '{MANAGER_NAME}' }],
    }
    p.spaces.templates.find((t: Doc) => t.id === 'alpha').features[0].location = 'either'
  }

  it('starts on a managing account from the deployment secrets, warning that the managed mode is not built', () => {
    const pack = validatePackDocument(doc(managed), { ...env, MANAGER_NAME: 'ayni-manager' })
    expect(catalogWarnings(pack).join('\n')).toContain(
      "tools.sources.drive.manage: the managed mode of a team space's folder is not built in this version"
    )
  })

  it('refuses a managing value that is not a placeholder, manage on another feature, and a managed location with no provider that manages', () => {
    expect(
      refusal(
        doc((p) => {
          managed(p)
          p.tools.sources.drive.manage.apply[0].value = 'hunter2'
        })
      )
    ).toContain('tools.sources.drive.manage.apply.0.value: the managing account comes from the deployment')
    expect(
      refusal(
        doc(
          (p) =>
            (p.tools.sources['nextcloud-calendar'].manage = {
              as: 'manager',
              apply: [{ header: 'Ayni-Dav-Username', value: '$' + '{MANAGER_NAME}' }],
            })
        )
      )
    ).toContain("tools.sources.nextcloud-calendar.manage: the agent manages a team space's folder of Files only")
    expect(refusal(doc((p) => (p.tools.sources.nextcloud.manage = { as: 'owner' })))).toContain(
      "tools.sources.nextcloud.manage: a folder is managed for the members' own accounts"
    )
    expect(
      refusal(doc((p) => (p.spaces.templates.find((t: Doc) => t.id === 'alpha').features[0].location = 'managed')))
    ).toContain('spaces.templates.alpha.features[0].location: managed, and no provider of the entry declares manage')
    expect(
      refusal(doc((p) => (p.spaces.templates.find((t: Doc) => t.id === 'alpha').features[1].location = 'existing')))
    ).toContain('spaces.templates.alpha.features[1].location: the mode of a location is for Files only')
  })
})
