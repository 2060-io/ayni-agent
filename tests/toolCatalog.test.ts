/**
 * The tool catalog (ayni-spec D96 to D99) as the agent-pack declares it, and the MCP client's offer: CORE-PACK-001,
 * TOOL-CAT-001..009, TOOL-AVAIL-002/003, TOOL-CALL-010, TOOL-ACCESS-007 (one connection per space account).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { catalogWarnings, loadPack, PackError, validatePackDocument } from '../src/config/pack.js'
import { DEFAULT_FEATURES } from '../src/config/packTypes.js'
import { renderPromptAddon } from '../src/core/promptAddon.js'
import { withoutPinned } from '../src/core/toolGate.js'
import { accountSecrets, buildAccountHeaders, scrubAccount } from '../src/tools/accountValues.js'
import { effectFromAnnotations, ToolCatalog } from '../src/tools/catalog.js'
import { McpServerSource } from '../src/tools/mcp.js'
import type { Logger } from '../src/util/logger.js'
import {
  crmTools,
  type Doc,
  type FakeMcp,
  fakeMcpServer,
  toolsPack,
  X_ACCOUNT_APPLY,
  X_ACCOUNT_FIELDS,
} from './toolFixtures.js'

const env = { ...process.env, HOME_BACKING_IDENTITY: 'did:webvh:x:home' }
const urls = { crmUrl: 'https://crm.example/mcp', searchUrl: 'https://search.example/mcp', xUrl: 'https://x.example' }

/** The pack of the tests, as a document before its schema. */
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

describe('the catalog in the agent-pack (CORE-PACK-001, TOOL-CAT-001/002)', () => {
  it('starts on the example of architecture §10.4: every source answers the four questions', () => {
    const pack = validatePackDocument(doc(), env)
    const catalog = new ToolCatalog(pack)
    expect(catalog.source('websearch')).toMatchObject({
      kind: 'mcp',
      title: 'Web search',
      account: { kind: 'agent' },
      availability: 'agent',
      untrusted: true,
    })
    expect(catalog.source('relaticle')).toMatchObject({
      title: 'Relaticle CRM',
      account: { kind: 'space', fields: [{ name: 'token', label: 'API token' }] },
      availability: 'spaces',
    })
    // the defaults: an HTTP tool of the agent's account, everywhere; a bundled tool of none
    expect(catalog.source('lookup')).toMatchObject({ kind: 'http', account: { kind: 'agent' }, availability: 'agent' })
    expect(catalog.source('workingMemory')).toMatchObject({ kind: 'bundled', account: { kind: 'none' } })
    // the defaults of a template's entry: added by the owner, not to guests (TOOL-AVAIL-002)
    expect(catalog.templateTools('sales')).toEqual([
      { source: 'relaticle', add: 'auto', guests: false },
      { source: 'crm_status', add: 'owner', guests: false },
    ])
    expect(catalog.templateTools('comms')).toEqual([
      { source: 'post_to_x', add: 'owner', guests: false },
      { source: 'x_mentions', add: 'owner', guests: false },
    ])
    // an account of four fields, in the agent-pack's order, sent in one header built from them (D102)
    expect(catalog.source('x_mentions')?.account).toEqual({
      kind: 'space',
      fields: X_ACCOUNT_FIELDS,
      apply: [{ header: 'X-Account', value: '{api_key}:{api_secret}:{access_token}:{access_token_secret}' }],
    })
  })

  it('refuses an unknown value, naming the source and the field', () => {
    const everywhere = refusal(doc((p) => (p.tools.sources.websearch.availability = 'everywhere')))
    expect(everywhere).toContain('tools.sources.websearch.availability')
    expect(everywhere).toContain('everywhere')
    expect(refusal(doc((p) => (p.tools.sources.relaticle.tools['create-note'].effect = 'erase')))).toContain(
      'tools.sources.relaticle.tools.create-note.effect'
    )
    expect(refusal(doc((p) => (p.tools.sources.lookup.type = 'ftp')))).toContain('tools.sources.lookup.type')
  })

  it('refuses the kinds of account of the later phases, saying they are not in this version', () => {
    const personal = refusal(doc((p) => (p.tools.sources.websearch.account = { kind: 'personal' })))
    expect(personal).toContain('tools.sources.websearch.account.kind: personal is not available in this version')
    expect(personal).toContain('phase 2')
    const organization = refusal(doc((p) => (p.tools.sources.lookup.account = { kind: 'organization' })))
    expect(organization).toContain('tools.sources.lookup.account.kind: organization is not available in this version')
    expect(organization).toContain('phase 3')
  })

  it('refuses an account on a bundled tool, and a space account without what it needs', () => {
    expect(refusal(doc((p) => (p.tools.sources.workingMemory.account = { kind: 'agent' })))).toContain(
      "tools.sources.workingMemory.account: a bundled tool's account is none"
    )
    expect(refusal(doc((p) => (p.tools.sources.relaticle.account.apply = undefined)))).toContain(
      'tools.sources.relaticle.account.apply'
    )
    expect(refusal(doc((p) => (p.tools.sources.relaticle.account.fields = undefined)))).toContain(
      'tools.sources.relaticle.account.fields'
    )
  })

  it('refuses a space account outside the spaces and on a stdio server (TOOL-AVAIL-003)', () => {
    const agentWide = refusal(
      doc((p) => {
        p.tools.sources.post_to_x.availability = 'agent'
        p.spaces.templates.find((t: { id: string }) => t.id === 'comms').tools = []
      })
    )
    expect(agentWide).toContain('tools.sources.post_to_x.availability')
    const stdio = refusal(
      doc((p) => {
        Object.assign(p.tools.sources.relaticle, { transport: 'stdio', command: 'crm-mcp' })
        p.tools.sources.relaticle.url = undefined
      })
    )
    expect(stdio).toContain('tools.sources.relaticle.transport')
  })

  it('refuses a binding of a source of the whole agent without a value (TOOL-CAT-005)', () => {
    const unvalued = refusal(doc((p) => (p.tools.sources.websearch.bindings = [{ name: 'region', label: 'Region' }])))
    expect(unvalued).toContain('tools.sources.websearch.bindings.region.value')
    expect(() =>
      validatePackDocument(
        doc((p) => (p.tools.sources.websearch.bindings = [{ name: 'region', label: 'Region', value: 'eu' }])),
        env
      )
    ).not.toThrow()
  })

  it('refuses a template that names a source of another availability, warns of a source no template names (TOOL-AVAIL-002)', () => {
    const wrong = refusal(
      doc((p) => p.spaces.templates.find((t: { id: string }) => t.id === 'sales').tools.push({ source: 'websearch' }))
    )
    expect(wrong).toContain('websearch is of availability agent')
    const unnamed = validatePackDocument(
      doc((p) => (p.spaces.templates.find((t: { id: string }) => t.id === 'comms').tools = [])),
      env
    )
    expect(catalogWarnings(unnamed).join('\n')).toContain(
      'tools.sources.post_to_x: a source of availability spaces that no template'
    )
  })

  it('refuses an approval entry that names a tool of the spaces, and warns of a rule of approval nobody approves (TOOL-CAT-009)', () => {
    const entry = refusal(
      doc((p) => (p.tools.sources.relaticle.access.approval = [{ tools: ['delete-note'], approvers: ['manager'] }]))
    )
    expect(entry).toContain('tools.sources.relaticle.access.approval names [delete-note], tools of availability spaces')
    const noApprover = validatePackDocument(
      doc((p) => {
        p.approvals.approvers = undefined
      }),
      env
    )
    // the DELETE tool of the whole agent has the rule approval, from its method
    expect(catalogWarnings(noApprover).join('\n')).toContain('tools.sources.purge: the rule of purge is approval')
    expect(catalogWarnings(validatePackDocument(doc(), env)).join('\n')).not.toContain('no-approver')
  })

  it('loads the dev and example packs unchanged', () => {
    expect(loadPack('agent-packs/dev', env).pack.metadata.id).toBe('ayni-dev')
  })
})

describe('effect, rule and trust (TOOL-CAT-006/007/008)', () => {
  const pack = validatePackDocument(doc(), env)
  const catalog = new ToolCatalog(pack)
  const crm = catalog.source('relaticle')
  const search = catalog.source('websearch')
  if (!crm || !search) throw new Error('sources missing')

  it('derives the effect from the annotations, with the defaults of MCP, and from the method', () => {
    expect(effectFromAnnotations({ readOnlyHint: true })).toBe('read')
    expect(effectFromAnnotations(undefined)).toBe('delete')
    expect(effectFromAnnotations({ destructiveHint: false })).toBe('external')
    expect(effectFromAnnotations({ destructiveHint: false, openWorldHint: false })).toBe('write')
    // the pack's declaration wins over the annotations
    expect(catalog.effectOf(crm, 'create-note', { destructiveHint: true })).toBe('write')
    expect(catalog.effectOf(crm, 'delete-note', undefined)).toBe('delete')
    expect(catalog.effectOf(catalog.source('post_to_x') as never, 'post_to_x')).toBe('external')
    expect(catalog.effectOf(catalog.source('lookup') as never, 'lookup')).toBe('read')
    expect(catalog.effectOf(catalog.source('purge') as never, 'purge')).toBe('delete')
    expect(catalog.effectOf(catalog.source('workingMemory') as never, 'working_memory')).toBeUndefined()
  })

  it('gives the rule from an approval entry, else the declaration, else the effect', () => {
    expect(catalog.packRuleOf(crm, 'delete-note').rule).toBe('approval')
    expect(catalog.packRuleOf(crm, 'create-note').rule).toBe('confirm')
    expect(catalog.packRuleOf(crm, 'get-company').rule).toBe('none')
    expect(catalog.packRuleOf(catalog.source('workingMemory') as never, 'working_memory').rule).toBe('none')
    const declared = new ToolCatalog(
      validatePackDocument(
        doc((p) => {
          p.tools.sources.relaticle.tools['delete-note'] = { call: 'confirm' }
          p.tools.sources.websearch.access.approval = [{ tools: ['search'], approvers: ['manager'] }]
          p.tools.sources.workingMemory.tools = { working_memory: { call: 'confirm' } }
        }),
        env
      )
    )
    expect(declared.packRuleOf(declared.source('relaticle') as never, 'delete-note').rule).toBe('confirm')
    // a read-only tool an approval entry lists asks for an approval by that entry's approvers
    const entry = declared.packRuleOf(declared.source('websearch') as never, 'search', { readOnlyHint: true })
    expect(entry).toMatchObject({ rule: 'approval', approvalRule: { approvers: ['manager'] } })
    expect(declared.packRuleOf(declared.source('workingMemory') as never, 'working_memory').rule).toBe('confirm')
  })

  it('takes the trust per tool, then per source, then from openWorldHint for an MCP tool; HTTP and bundled are trusted', () => {
    expect(catalog.untrustedOf(search, 'search', { readOnlyHint: true, openWorldHint: false })).toBe(true)
    expect(catalog.untrustedOf(crm, 'get-company', undefined)).toBe(false)
    expect(catalog.untrustedOf(crm, 'delete-note', undefined)).toBe(true)
    expect(catalog.untrustedOf(crm, 'delete-note', { openWorldHint: false })).toBe(false)
    expect(catalog.untrustedOf(catalog.source('lookup') as never, 'lookup')).toBe(false)
    expect(catalog.untrustedOf(catalog.source('workingMemory') as never, 'working_memory')).toBe(false)
  })

  it('takes the pinned arguments out of the input schema the model receives (TOOL-CAT-004)', () => {
    const schema = withoutPinned(
      { type: 'object', required: ['workspace_id', 'note'], properties: { workspace_id: {}, note: {} } },
      crm
    )
    expect(schema).toEqual({ type: 'object', required: ['note'], properties: { note: {} } })
  })

  it('replaces an echo of the account by [account] in a text and in data (TOOL-ACCESS-005)', () => {
    expect(scrubAccount('header Bearer abc|123 seen', ['abc|123'])).toBe('header Bearer [account] seen')
    expect(scrubAccount({ auth: 'Bearer abc|123', n: 1 }, ['abc|123'])).toEqual({ auth: 'Bearer [account]', n: 1 })
    expect(scrubAccount('nothing', undefined)).toBe('nothing')
    // a token with characters JSON escapes is found in data too
    expect(scrubAccount({ auth: ['Bearer a"b\\c'] }, ['a"b\\c'])).toEqual({ auth: ['Bearer [account]'] })
  })

  it('tells the model that actions may ask, only when some tool can (TOOL-CALL-010)', () => {
    expect(catalog.mayAsk()).toBe(true)
    const quiet = new ToolCatalog(
      validatePackDocument(
        doc((p) => {
          for (const id of ['websearch', 'relaticle', 'post_to_x', 'crm_status', 'purge'])
            p.tools.sources[id] = undefined
          p.tools.sources.lookup.access.roles = { employee: ['lookup'] }
          p.spaces.templates = p.spaces.templates.filter((t: { id: string }) => t.id === 'project')
        }),
        env
      )
    )
    expect(quiet.mayAsk()).toBe(false)
    const base = {
      features: DEFAULT_FEATURES,
      agentLanguage: 'en',
      hasTools: true,
      hasRequestableTools: false,
      challengesConfigured: false,
    }
    expect(renderPromptAddon({ ...base, toolsMayAsk: true })).toContain('never in words in place of the card')
    expect(renderPromptAddon({ ...base, toolsMayAsk: false })).not.toContain('in place of the card')
  })
})

describe("a space's account in named fields (D102, TOOL-CAT-002/012, TOOL-ACCESS-005)", () => {
  const x = (account: Doc) => doc((p) => (p.tools.sources.x_mentions.account = account))

  it('refuses the former form of an account before the schema, with the form that replaces it (TOOL-CAT-012)', () => {
    const old = refusal(
      doc((p) => {
        p.tools.sources.relaticle.account = {
          kind: 'space',
          label: 'API token',
          pattern: '^[A-Za-z0-9|]{20,200}$',
          apply: { header: 'Authorization', prefix: 'Bearer ' },
        }
      })
    )
    expect(old).toContain('agent-pack declares a space account in the form that its fields replaced (D102)')
    expect(old).toContain('tools.sources.relaticle.account.label is withdrawn')
    expect(old).toContain('fields: [{ name: token, label: API token, pattern: "^[A-Za-z0-9|]{20,200}$" }]')
    expect(old).toContain('tools.sources.relaticle.account.pattern is withdrawn')
    expect(old).toContain('tools.sources.relaticle.account.apply as one header with its prefix is withdrawn')
    expect(old).toContain('apply: [{ header: Authorization, value: "Bearer {token}" }]')
    // in words, before the schema would name the keys
    expect(old).not.toContain('schema validation')
    // the header alone, as the X server of devnet took the four keys joined
    const header = refusal(x({ kind: 'space', label: 'Keys of the X account', apply: { header: 'X-Account' } }))
    expect(header).toContain('apply: [{ header: X-Account, value: "{token}" }]')
  })

  it('refuses a header that names a field the account lacks, and a field no header names (TOOL-CAT-002)', () => {
    const lacks = refusal(
      x({
        kind: 'space',
        fields: X_ACCOUNT_FIELDS,
        apply: [{ header: 'X-Account', value: '{api_key}:{api_secrt}:{access_token}:{access_token_secret}' }],
      })
    )
    expect(lacks).toContain(
      'tools.sources.x_mentions.account.apply[0].value names {api_secrt}, which is not a field of the account'
    )
    expect(lacks).toContain('tools.sources.x_mentions.account.fields.api_secret: no header of account.apply names')
    const unnamed = refusal(
      x({
        kind: 'space',
        fields: X_ACCOUNT_FIELDS,
        apply: [{ header: 'X-Account', value: '{api_key}:{api_secret}:{access_token}' }],
      })
    )
    expect(unnamed).toContain(
      'tools.sources.x_mentions.account.fields.access_token_secret: no header of account.apply names {access_token_secret}'
    )
  })

  it('refuses two fields of one name, a header declared twice and a pattern that is not one (TOOL-CAT-002)', () => {
    const twice = refusal(
      x({
        kind: 'space',
        fields: [
          { name: 'token', label: 'Token' },
          { name: 'token', label: 'Token again', pattern: '[' },
        ],
        apply: [
          { header: 'Authorization', value: 'Bearer {token}' },
          { header: 'authorization', value: '{token}' },
        ],
      })
    )
    expect(twice).toContain("tools.sources.x_mentions.account.fields.token: a field's name is unique in its account")
    expect(twice).toContain('tools.sources.x_mentions.account.fields.token.pattern is not a regular expression')
    expect(twice).toContain('tools.sources.x_mentions.account.apply[1].header: authorization is declared twice')
  })

  it('refuses fields and apply on an account that is not a space, a space account without them, and wrong names (schema)', () => {
    const agent = refusal(
      doc((p) => {
        p.tools.sources.lookup.account = {
          kind: 'agent',
          fields: [{ name: 'token', label: 'Token' }],
          apply: [{ header: 'Authorization', value: 'Bearer {token}' }],
        }
      })
    )
    expect(agent).toContain('tools.sources.lookup.account: fields and apply belong to a space account only')
    expect(refusal(x({ kind: 'space', apply: X_ACCOUNT_APPLY }))).toContain('tools.sources.x_mentions.account.fields')
    expect(refusal(x({ kind: 'space', fields: X_ACCOUNT_FIELDS }))).toContain('tools.sources.x_mentions.account.apply')
    // a name of lower-case letters, digits and _, starting with a letter
    expect(
      refusal(
        x({
          kind: 'space',
          fields: [{ name: 'API-Key', label: 'API key' }],
          apply: [{ header: 'X-Account', value: '{API-Key}' }],
        })
      )
    ).toContain('/tools/sources/x_mentions/account/fields/0/name must match pattern')
    // a header's value holds no line break: a header could be split in two
    expect(
      refusal(
        x({
          kind: 'space',
          fields: [{ name: 'token', label: 'Token' }],
          apply: [{ header: 'X-Account', value: '{token}\r\nX-Other: 1' }],
        })
      )
    ).toContain('/tools/sources/x_mentions/account/apply/0/value must match pattern')
  })

  it('builds the headers of a call from the values of the fields, and scrubs an echo of each (TOOL-ACCESS-005)', () => {
    const values = {
      api_key: 'keyKey0001',
      api_secret: 'secretSecretSecret0001',
      access_token: '1234-tokenToken01',
      access_token_secret: 'tokenSecretSecret0001',
    }
    // four fields, one header
    const headers = buildAccountHeaders({ kind: 'space', fields: X_ACCOUNT_FIELDS, apply: X_ACCOUNT_APPLY }, values)
    expect(headers).toEqual({
      'X-Account': 'keyKey0001:secretSecretSecret0001:1234-tokenToken01:tokenSecretSecret0001',
    })
    // a single token, after Bearer
    expect(
      buildAccountHeaders(
        {
          kind: 'space',
          fields: [{ name: 'token', label: 'API token' }],
          apply: [{ header: 'Authorization', value: 'Bearer {token}' }],
        },
        { token: 'abc|123' }
      )
    ).toEqual({ Authorization: 'Bearer abc|123' })
    // the header whole first, then each value alone
    const secrets = accountSecrets(values, headers)
    expect(secrets[0]).toBe(headers['X-Account'])
    const echo = {
      header: `X-Account: ${headers['X-Account']}`,
      parts: Object.values(values),
      [values.api_key]: 'a key named by the value',
    }
    expect(scrubAccount(echo, secrets)).toEqual({
      header: 'X-Account: [account]',
      parts: ['[account]', '[account]', '[account]', '[account]'],
      '[account]': 'a key named by the value',
    })
  })
})

describe('the MCP client: the offer, one connection per space account (TOOL-CAT-003, TOOL-ACCESS-007)', () => {
  let crm: FakeMcp
  beforeAll(async () => {
    crm = await fakeMcpServer(crmTools())
  })
  afterAll(async () => {
    await crm.close()
  })

  function capture(): { logger: Logger; warnings: string[] } {
    const warnings: string[] = []
    const noop = () => undefined
    const logger = {
      warn: (_o: unknown, message?: string) => warnings.push(String(message ?? _o)),
      info: noop,
      error: noop,
      debug: noop,
      fatal: noop,
      trace: noop,
    } as unknown as Logger
    return { logger, warnings }
  }

  it('gives the offered tools only, warns once of an offered name the server does not list', async () => {
    const { logger, warnings } = capture()
    const source = new McpServerSource(
      'crm',
      { type: 'mcp', transport: 'streamable-http', url: crm.url, offer: ['get-company', 'create-note', 'ghost'] },
      logger
    )
    const names = (await source.list()).map((s) => s.rawName)
    expect(names).toEqual(['get-company', 'create-note'])
    expect((await source.list()).map((s) => s.rawName)).toEqual(['get-company', 'create-note'])
    expect(warnings.filter((w) => w.includes('TOOL-CAT-003'))).toHaveLength(1)
    // the annotations come with the tools: they give the defaults
    expect((await source.list())[0]?.annotations).toMatchObject({ readOnlyHint: true })
    await source.close()
  })

  it('opens one connection per space account, sends each its own headers, and closes them once idle', async () => {
    const { logger } = capture()
    const source = new McpServerSource(
      'crm',
      {
        type: 'mcp',
        transport: 'streamable-http',
        url: crm.url,
        account: {
          kind: 'space',
          fields: [{ name: 'token', label: 'API token' }],
          apply: [{ header: 'Authorization', value: 'Bearer {token}' }],
        },
        availability: 'spaces',
      },
      logger,
      0.3
    )
    // a source of space accounts lists nothing before a space's connection discovers it
    expect(await source.list()).toEqual([])
    const tokenA = 'token-of-space-a-000000'
    const tokenB = 'token-of-space-b-000000'
    const a = { kind: 'space' as const, spaceId: 'spc_a', headers: { Authorization: `Bearer ${tokenA}` } }
    const b = { kind: 'space' as const, spaceId: 'spc_b', headers: { Authorization: `Bearer ${tokenB}` } }
    await source.discover(a)
    const tool = (await source.list()).find((t) => t.rawName === 'list-companies')
    if (!tool) throw new Error('not discovered')
    const ctx = { principal: {}, session: {}, roles: [], logger, language: 'en' } as never
    const before = crm.calls.length
    await tool.invoke({ workspace_id: 'one' }, { ...(ctx as object), account: a } as never)
    await tool.invoke({ workspace_id: 'two' }, { ...(ctx as object), account: b } as never)
    expect(source.openAccounts).toBe(2)
    const calls = crm.calls.slice(before)
    expect(calls.map((c) => c.authorization)).toEqual([`Bearer ${tokenA}`, `Bearer ${tokenB}`])
    // a call of a space without its account does not reach the server
    const refused = await tool.invoke({}, { ...(ctx as object), account: { kind: 'space', spaceId: 'spc_c' } } as never)
    expect(refused).toMatchObject({ isError: true })
    expect(crm.calls.length).toBe(before + 2)
    await new Promise((r) => setTimeout(r, 450))
    expect(source.openAccounts).toBe(0)
    await source.close()
  })
})
