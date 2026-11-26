/**
 * The agent's copy of the feature profiles, pinned to the profiles' documents (ayni-spec D121, D151; TOOL-FEAT-010): the
 * documents are vendored in `src/features/spec/`, and every name, title, description, effect, capability, mark of content
 * written by others and argument title of `src/features/profiles.ts` is read again from their tables here.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CALENDAR_1_0,
  type FeatureProfile,
  FILES_1_0,
  inputSchemaOf,
  KNOWN_PROFILES,
  knownProfile,
  toolsInUse,
} from '../src/features/profiles.js'

const doc = (name: string) => readFileSync(`src/features/spec/${name}.md`, 'utf8')

/** The cells of the rows of the markdown tables of a text. */
function rows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[-| ]+\|$/.test(line.trim()))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
    )
}

const unquote = (cell: string) => cell.replace(/`/g, '')

interface Summary {
  title: string
  effect: string
  othersWrote: string
}

/** The tables of tools of a profile: name, title, effect (the first word), mark of content written by others. */
function summaries(text: string, prefix: string): Map<string, Summary> {
  const out = new Map<string, Summary>()
  for (const cells of rows(text)) {
    const [name, title, effect, marks] = cells
    if (!name || !title || !effect || !marks) continue
    const tool = unquote(name)
    if (!new RegExp(`^${prefix}[a-z_]+$`).test(tool) || !/^`(read|write|delete|external)`/.test(effect)) continue
    out.set(tool, {
      title,
      effect: unquote(effect.split(/[;\s]/)[0] ?? ''),
      othersWrote: marks.split(':')[0]?.trim() ?? '',
    })
  }
  return out
}

/** The description of each tool, word for word: `*Description:* "…"` after its name (common §4). */
function descriptions(text: string, prefix: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = new RegExp(`\`(${prefix}[a-z_]+)\`[^\\n]*?\\n?\\n?\\*Description:\\*\\s*"([^"]+)"`, 'g')
  for (const m of text.matchAll(re)) out.set(m[1] as string, (m[2] as string).replace(/\s+/g, ' ').trim())
  return out
}

/** The argument tables of each tool: the rows after its description, until the next prose. */
function argumentTables(text: string, prefix: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>()
  const re = /\*Description:\*\s*"[^"]+"\s*\n\n((?:\|.*\n)+)/g
  const names = [...text.matchAll(new RegExp(`\`(${prefix}[a-z_]+)\`[^\\n]*?\\n?\\n?\\*Description:\\*`, 'g'))]
  const tables = [...text.matchAll(re)]
  names.forEach((n, i) => {
    const table = tables[i]?.[1]
    if (table) out.set(n[1] as string, rows(table).slice(1))
  })
  return out
}

/** The capabilities of a profile and the tools each gives (its table "Capability | Tools | Adds to core tools"). */
function capabilityTools(text: string, prefix: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [capability, tools] of rows(text)) {
    if (!capability || tools === undefined || !/^`[a-z-]+`$/.test(capability)) continue
    const names = [...tools.matchAll(new RegExp(`\`(${prefix}[a-z_]+)\``, 'g'))].map((m) => m[1] as string)
    if (names.length || tools === '') out.set(unquote(capability), names)
  }
  return out
}

function header(text: string) {
  const id = /\*\*Identifier:\*\* `([^`]+)`/.exec(text)?.[1]
  const version = /\*\*Version:\*\* `([^`]+)`/.exec(text)?.[1]
  const prefix = /\*\*Prefix:\*\* `([^`]+)`/.exec(text)?.[1]
  const location = /\*\*Location argument:\*\* `([^`]+)`/.exec(text)?.[1]
  const labels = /one location `([^`]+)`; a list of them `([^`]+)`; any location `([^`]+)`/.exec(text)
  return { id, version, prefix, location, labels: labels ? { one: labels[1], list: labels[2], any: labels[3] } : {} }
}

function pinned(profile: FeatureProfile, text: string) {
  describe(`${profile.id} ${profile.version}`, () => {
    it('has the identifier, version, prefix, location and labels of its document', () => {
      expect(header(text)).toEqual({
        id: profile.id,
        version: profile.version,
        prefix: profile.prefix,
        location: profile.location.argument,
        labels: profile.location.labels,
      })
    })

    it('has every tool of its tables, with its title, effect and mark of content written by others, in their order', () => {
      const tables = summaries(text, profile.prefix)
      expect(profile.tools.map((t) => t.name)).toEqual([...tables.keys()])
      for (const tool of profile.tools)
        expect({ title: tool.title, effect: tool.effect, othersWrote: tool.othersWrote }, tool.name).toEqual(
          tables.get(tool.name)
        )
    })

    it("has each tool's description word for word", () => {
      const written = descriptions(text, profile.prefix)
      for (const tool of profile.tools) expect(tool.description, tool.name).toBe(written.get(tool.name))
    })

    it('puts each tool in the capability its table names, the core in none', () => {
      const byCapability = capabilityTools(text, profile.prefix)
      expect(profile.capabilities).toEqual([...byCapability.keys()])
      for (const [capability, tools] of byCapability)
        expect(
          profile.tools.filter((t) => t.capability === capability).map((t) => t.name),
          capability
        ).toEqual(tools)
    })

    it('has the arguments of each tool, with their titles and whether they are required, as its table writes them', () => {
      const tables = argumentTables(text, profile.prefix)
      const titleOf = (tool: string, argument: string) =>
        profile.tools.find((t) => t.name === tool)?.arguments.find((a) => a.name === argument)?.title
      for (const tool of profile.tools) {
        const table = tables.get(tool.name)
        expect(table, tool.name).toBeDefined()
        for (const [names, title, , need] of table ?? []) {
          const listed = [...(names ?? '').matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1] as string)
          for (const argument of listed) {
            const ours = tool.arguments.find((a) => a.name === argument)
            expect(ours, `${tool.name}.${argument}`).toBeDefined()
            // "as in §3.4": the title of the creation's argument of the same name
            const expected = title?.startsWith('as in') ? titleOf(`${profile.prefix}create_event`, argument) : title
            expect(ours?.title, `${tool.name}.${argument}`).toBe(expected)
            if (need === 'required') expect(ours?.required, `${tool.name}.${argument}`).toBe(true)
            const capability = /capability `([a-z-]+)`/.exec(need ?? '')?.[1]
            if (capability) expect(ours?.capability, `${tool.name}.${argument}`).toBe(capability)
          }
        }
      }
    })
  })
}

pinned(FILES_1_0, doc('files'))
pinned(CALENDAR_1_0, doc('calendar'))

describe('what the copy gives a model (TOOL-FEAT-010)', () => {
  it('knows Files and Calendar, any minor of their major and nothing else (TOOL-FEAT-001)', () => {
    expect(KNOWN_PROFILES.map((p) => p.id)).toEqual(['org.ayni/files', 'org.ayni/calendar'])
    expect(knownProfile('org.ayni/files', '1.0')).toBe(FILES_1_0)
    expect(knownProfile('org.ayni/files', '1.7')).toBe(FILES_1_0)
    expect(knownProfile('org.ayni/files', '2.0')).toBeUndefined()
    expect(knownProfile('org.ayni/mail', '1.0')).toBeUndefined()
    expect(knownProfile('org.ayni/files', '1')).toBeUndefined()
  })

  it('takes the version argument of a read with versions only, and the invitees of an event with attendees only', () => {
    const read = FILES_1_0.tools.find((t) => t.name === 'files_read')
    const create = CALENDAR_1_0.tools.find((t) => t.name === 'calendar_create_event')
    if (!read || !create) throw new Error('missing tools')
    expect(Object.keys(inputSchemaOf(read, []).properties as object)).toEqual(['root', 'ref', 'maxBytes'])
    expect(Object.keys(inputSchemaOf(read, ['versions']).properties as object)).toContain('version')
    expect(Object.keys(inputSchemaOf(create, []).properties as object)).not.toContain('attendees')
    expect(inputSchemaOf(create, ['attendees']).required).toEqual(['calendar', 'title', 'start', 'end'])
    expect(toolsInUse(CALENDAR_1_0, []).map((t) => t.name)).toEqual([
      'calendar_calendars',
      'calendar_list_events',
      'calendar_get_event',
      'calendar_create_event',
      'calendar_update_event',
      'calendar_cancel_event',
    ])
  })

  it('marks the arguments that name people, and the value that makes a share external (common §10)', () => {
    expect(FILES_1_0.tools.find((t) => t.name === 'files_share')?.externalWhen).toEqual({
      addresses: [{ argument: 'recipients', member: 'address' }],
      values: [{ argument: 'audience', value: 'anyone' }],
    })
    expect(CALENDAR_1_0.tools.find((t) => t.name === 'calendar_update_event')?.externalWhen).toEqual({
      addresses: [{ argument: 'attendees', member: 'address' }],
    })
  })
})
