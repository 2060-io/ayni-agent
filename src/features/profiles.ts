/**
 * The agent's own copy of the feature profiles it knows (ayni-spec D121, D123, D151; TOOL-FEAT-010): Files 1.0 and
 * Calendar 1.0, transcribed from the profiles' documents, which win over it. The documents are vendored beside this file
 * (`spec/common.md`, `spec/files.md`, `spec/calendar.md`, ayni-spec `f85c136`), and `tests/featureProfiles.test.ts` reads
 * them and pins every name, title, description, effect, capability, mark of content written by others and argument title
 * of this copy to their tables.
 *
 * What the model is given of a tool of a profile is this copy's name, description and input schema, never what a server
 * lists: two providers with the same capabilities in use give the model the same bytes (TOOL-FEAT-010).
 */
import type { ToolEffect } from '../config/packTypes.js'

/** What of a tool's result people other than the account's holder may have written (feature profiles common §10). */
export type OthersWrote = 'no' | 'names' | 'names and content'

/** A JSON schema, as a tool's input schema holds it. */
export type JsonSchema = Record<string, unknown>

/** One argument of a tool of a profile. */
export interface ProfileArgument {
  name: string
  /** what a card and the record of a call show people (D151) */
  title: string
  schema: JsonSchema
  required?: true
  /** the optional capability that adds it to its tool; a core argument has none */
  capability?: string
}

/** An argument that holds people's addresses (common §10): a list of addresses, or of objects that carry one. */
export interface AddressArgument {
  argument: string
  /** the member of each item that holds the address; the item itself when absent */
  member?: string
}

/** What a result of a tool holds, as the agent checks it (TOOL-FEAT-015). */
export interface ResultShape {
  /** the members every result has, with their JSON type */
  members: Record<string, 'object' | 'array' | 'string' | 'boolean'>
  /** the members that hold one item, or a list of items, each carrying the location of its call (common §6) */
  located?: { single?: string[]; lists?: string[] }
}

export interface ProfileTool {
  name: string
  title: string
  /** what the model reads of the tool, word for word (common §4) */
  description: string
  effect: ToolEffect
  /** when the effect is `external` instead (common §10, TOOL-FEAT-013) */
  externalWhen?: { addresses?: AddressArgument[]; values?: { argument: string; value: unknown }[] }
  othersWrote: OthersWrote
  /** the optional capability the tool belongs to; a core tool has none */
  capability?: string
  arguments: ProfileArgument[]
  result: ResultShape
  /** a result whose `content` may be bytes, which the model never reads (TOOL-FEAT-020) */
  bytes?: true
}

export interface FeatureProfile {
  /** the MCP extension identifier the provider declares it under (FEAT-CORE-001) */
  id: string
  /** the version of this copy, `major.minor` */
  version: string
  major: number
  prefix: string
  location: {
    /** the location argument every other tool takes */
    argument: string
    /** the one core tool that lists the locations the account reaches */
    listTool: string
    /** the member of its result that holds them */
    listMember: string
    /** the location's three labels (common §6): one, a list, any */
    labels: { one: string; list: string; any: string }
  }
  /** the optional capabilities, in the profile's order */
  capabilities: string[]
  /** every tool, in the profile's order: the core, then each capability's */
  tools: ProfileTool[]
  /** the members of a result that hold references (common §5): what the code marks (TOOL-FEAT-016) */
  referenceMembers: string[]
  /** the arguments that take references: what the code unmarks before a call (TOOL-FEAT-016) */
  referenceArguments: string[]
}

// ---- the pieces the two profiles share (common §5, §7) ----------------------------------------------------------------

const REFERENCE: JsonSchema = { type: 'string', minLength: 1, maxLength: 1024 }
const VERSION: JsonSchema = { type: 'string', minLength: 1, maxLength: 255 }
const TEXT_200: JsonSchema = { type: 'string', minLength: 1, maxLength: 200 }
const EMAIL: JsonSchema = { type: 'string', format: 'email' }
const INSTANT: JsonSchema = { type: 'string', format: 'date-time' }

const limit = (): ProfileArgument => ({
  name: 'limit',
  title: 'Most results',
  schema: { type: 'integer', minimum: 1, maximum: 100 },
})
const cursor = (): ProfileArgument => ({ name: 'cursor', title: 'Next page', schema: { type: 'string', minLength: 1 } })

// ---- Files 1.0 (files.md) -------------------------------------------------------------------------------------------

const ROOT = (): ProfileArgument => ({ name: 'root', title: 'Folder', schema: REFERENCE, required: true })
/** a name of an item (files §1) */
const NAME: JsonSchema = { type: 'string', minLength: 1, maxLength: 255 }
/** a content to write: a text, or bytes in base64 (files §1) */
const CONTENT: JsonSchema = {
  oneOf: [
    { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false },
    { type: 'object', required: ['base64'], properties: { base64: { type: 'string' } }, additionalProperties: false },
  ],
}
const ITEM = { item: 'object' } as const
const ONE_ITEM: ResultShape = { members: ITEM, located: { single: ['item'] } }

export const FILES_1_0: FeatureProfile = {
  id: 'org.ayni/files',
  version: '1.0',
  major: 1,
  prefix: 'files_',
  location: {
    argument: 'root',
    listTool: 'files_roots',
    listMember: 'roots',
    labels: { one: 'Folder', list: 'Folders', any: 'Any folder you can reach' },
  },
  capabilities: ['search', 'folders', 'trash', 'share', 'versions', 'export', 'team-roots'],
  referenceMembers: ['ref', 'root', 'parent'],
  referenceArguments: ['root', 'folder', 'ref', 'toFolder'],
  tools: [
    {
      name: 'files_roots',
      title: 'List folders to work in',
      description: 'List the folders you can work in. Give the start of a path to narrow the list.',
      effect: 'read',
      othersWrote: 'names',
      arguments: [{ name: 'query', title: 'Path begins with', schema: TEXT_200 }, limit(), cursor()],
      result: { members: { roots: 'array' } },
    },
    {
      name: 'files_list',
      title: 'List a folder',
      description:
        'List what a folder holds, one level only, without the content of its files. With no folder, list the top of the folder you work in.',
      effect: 'read',
      othersWrote: 'names',
      arguments: [ROOT(), { name: 'folder', title: 'Folder to list', schema: REFERENCE }, limit(), cursor()],
      result: { members: { folder: 'object', items: 'array' }, located: { single: ['folder'], lists: ['items'] } },
    },
    {
      name: 'files_get',
      title: 'Look at a file or a folder',
      description: 'Look at one file or folder: its name, path, type, size, version and dates, without its content.',
      effect: 'read',
      othersWrote: 'names',
      arguments: [ROOT(), { name: 'ref', title: 'Item', schema: REFERENCE, required: true }],
      result: ONE_ITEM,
    },
    {
      name: 'files_read',
      title: 'Read a file',
      description:
        "Read a file's content: a text file, or a document of the store's own, as text; any other file as its bytes. Give maxBytes to read only the start of a long text.",
      effect: 'read',
      othersWrote: 'names and content',
      arguments: [
        ROOT(),
        { name: 'ref', title: 'File', schema: REFERENCE, required: true },
        { name: 'maxBytes', title: 'Most bytes of text', schema: { type: 'integer', minimum: 1 } },
        { name: 'version', title: 'Version', schema: VERSION, capability: 'versions' },
      ],
      result: { members: { item: 'object', content: 'object' }, located: { single: ['item'] } },
      bytes: true,
    },
    {
      name: 'files_create',
      title: 'Create a file',
      description:
        'Create a new file with its content in a folder. Nothing is written if an item of that name is already there, and no folder is created on the way.',
      effect: 'write',
      othersWrote: 'names',
      arguments: [
        ROOT(),
        { name: 'folder', title: 'In folder', schema: REFERENCE },
        { name: 'name', title: 'Name', schema: NAME, required: true },
        { name: 'content', title: 'Content', schema: CONTENT, required: true },
        { name: 'mediaType', title: 'Type', schema: { type: 'string', minLength: 1 } },
      ],
      result: ONE_ITEM,
    },
    {
      name: 'files_replace',
      title: "Replace a file's content",
      description:
        'Replace the whole content of an existing file. Give the version you read: if the file changed since, nothing is written and the current version comes back.',
      effect: 'write',
      othersWrote: 'names',
      arguments: [
        ROOT(),
        { name: 'ref', title: 'File', schema: REFERENCE, required: true },
        { name: 'ifVersion', title: 'Version read', schema: VERSION, required: true },
        { name: 'content', title: 'New content', schema: CONTENT, required: true },
        { name: 'mediaType', title: 'Type', schema: { type: 'string', minLength: 1 } },
      ],
      result: ONE_ITEM,
    },
    {
      name: 'files_search',
      title: 'Search files',
      description:
        'Find files and folders by words in their name, their content, or either. Plain words only: no search operators.',
      effect: 'read',
      othersWrote: 'names and content',
      capability: 'search',
      arguments: [
        ROOT(),
        { name: 'query', title: 'Words', schema: TEXT_200, required: true },
        { name: 'folder', title: 'In folder', schema: REFERENCE },
        { name: 'in', title: 'Search in', schema: { type: 'string', enum: ['name', 'content', 'any'] } },
        limit(),
        cursor(),
      ],
      result: { members: { items: 'array' }, located: { lists: ['items'] } },
    },
    {
      name: 'files_create_folder',
      title: 'Create a folder',
      description: 'Create a folder inside a folder.',
      effect: 'write',
      othersWrote: 'names',
      capability: 'folders',
      arguments: [
        ROOT(),
        { name: 'folder', title: 'In folder', schema: REFERENCE },
        { name: 'name', title: 'Name', schema: NAME, required: true },
      ],
      result: ONE_ITEM,
    },
    {
      name: 'files_move',
      title: 'Move or rename',
      description:
        "Move a file or a folder to another folder, rename it, or both. A folder moves with what it holds. The item's reference changes: use the one this answers.",
      effect: 'write',
      othersWrote: 'names',
      capability: 'folders',
      arguments: [
        ROOT(),
        { name: 'ref', title: 'Item', schema: REFERENCE, required: true },
        { name: 'toFolder', title: 'To folder', schema: REFERENCE },
        { name: 'newName', title: 'New name', schema: NAME },
        { name: 'ifVersion', title: 'Version read', schema: VERSION },
      ],
      result: ONE_ITEM,
    },
    {
      name: 'files_trash',
      title: 'Move to the trash',
      description: 'Move a file or a folder to the trash. It can be restored for as long as the store keeps its trash.',
      effect: 'delete',
      othersWrote: 'names',
      capability: 'trash',
      arguments: [
        ROOT(),
        { name: 'ref', title: 'Item', schema: REFERENCE, required: true },
        { name: 'ifVersion', title: 'Version read', schema: VERSION },
      ],
      result: ONE_ITEM,
    },
    {
      name: 'files_restore',
      title: 'Restore from the trash',
      description: 'Bring an item back from the trash to the folder it left.',
      effect: 'write',
      othersWrote: 'names',
      capability: 'trash',
      arguments: [ROOT(), { name: 'ref', title: 'Item', schema: REFERENCE, required: true }],
      result: ONE_ITEM,
    },
    {
      name: 'files_list_trash',
      title: 'List the trash',
      description: 'List the items in the trash that came from the folder you work in.',
      effect: 'read',
      othersWrote: 'names',
      capability: 'trash',
      arguments: [ROOT(), limit(), cursor()],
      result: { members: { items: 'array' }, located: { lists: ['items'] } },
    },
    {
      name: 'files_shares',
      title: 'See who a file is shared with',
      description: 'See who a file or a folder is shared with, and how.',
      effect: 'read',
      othersWrote: 'names',
      capability: 'share',
      arguments: [ROOT(), { name: 'ref', title: 'Item', schema: REFERENCE, required: true }],
      result: { members: { shares: 'array' } },
    },
    {
      name: 'files_share',
      title: 'Share',
      description:
        'Share a file or a folder with people, by their email addresses, or with an audience, as a reader or an editor.',
      effect: 'write',
      externalWhen: {
        addresses: [{ argument: 'recipients', member: 'address' }],
        values: [{ argument: 'audience', value: 'anyone' }],
      },
      othersWrote: 'names',
      capability: 'share',
      arguments: [
        ROOT(),
        { name: 'ref', title: 'Item', schema: REFERENCE, required: true },
        {
          name: 'role',
          title: 'Role',
          schema: { type: 'string', enum: ['reader', 'editor', 'manager'] },
          required: true,
        },
        {
          name: 'recipients',
          title: 'People',
          schema: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              required: ['address'],
              properties: { address: EMAIL },
              additionalProperties: false,
            },
          },
        },
        { name: 'audience', title: 'Audience', schema: { type: 'string', enum: ['organization', 'anyone'] } },
        { name: 'notify', title: 'Tell them', schema: { type: 'boolean' } },
        { name: 'message', title: 'Message', schema: { type: 'string', maxLength: 1000 } },
      ],
      result: { members: { shares: 'array' } },
    },
    {
      name: 'files_unshare',
      title: 'Stop sharing',
      description: 'Stop one share of a file or a folder.',
      effect: 'write',
      othersWrote: 'names',
      capability: 'share',
      arguments: [
        ROOT(),
        { name: 'ref', title: 'Item', schema: REFERENCE, required: true },
        { name: 'share', title: 'Share', schema: { type: 'string', minLength: 1 }, required: true },
      ],
      result: { members: { shares: 'array' } },
    },
    {
      name: 'files_versions',
      title: "List a file's versions",
      description:
        'List the former versions of a file, newest first. Read one by giving its version to the read of the file.',
      effect: 'read',
      othersWrote: 'names',
      capability: 'versions',
      arguments: [ROOT(), { name: 'ref', title: 'File', schema: REFERENCE, required: true }, limit(), cursor()],
      result: { members: { versions: 'array' } },
    },
    {
      name: 'files_export',
      title: 'Read a file in another format',
      description: 'Read a file converted to another format, one of the formats the file lists.',
      effect: 'read',
      othersWrote: 'names and content',
      capability: 'export',
      arguments: [
        ROOT(),
        { name: 'ref', title: 'File', schema: REFERENCE, required: true },
        { name: 'mediaType', title: 'Format', schema: { type: 'string', minLength: 1 }, required: true },
      ],
      result: { members: { item: 'object', content: 'object' }, located: { single: ['item'] } },
      bytes: true,
    },
    {
      name: 'files_create_team_root',
      title: "Create a team's folder",
      description: 'Create a folder that belongs to the organization, for a team.',
      effect: 'write',
      othersWrote: 'no',
      capability: 'team-roots',
      arguments: [
        { name: 'name', title: 'Name', schema: { type: 'string', minLength: 1, maxLength: 100 }, required: true },
        {
          name: 'requestId',
          title: 'Request',
          schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
          required: true,
        },
      ],
      result: { members: { root: 'object' } },
    },
    {
      name: 'files_rename_root',
      title: "Rename a team's folder",
      description: "Rename a team's folder.",
      effect: 'write',
      othersWrote: 'no',
      capability: 'team-roots',
      arguments: [
        ROOT(),
        { name: 'name', title: 'New name', schema: { type: 'string', minLength: 1, maxLength: 100 }, required: true },
      ],
      result: { members: { root: 'object' } },
    },
  ],
}

// ---- Calendar 1.0 (calendar.md) -------------------------------------------------------------------------------------

const CALENDAR = (): ProfileArgument => ({ name: 'calendar', title: 'Calendar', schema: REFERENCE, required: true })
/** a time of an event: an instant with its offset, or a date for an all-day event (calendar §1) */
const WHEN: JsonSchema = { type: 'string', anyOf: [{ format: 'date-time' }, { format: 'date' }] }
const ATTENDEES: JsonSchema = {
  type: 'array',
  maxItems: 100,
  items: {
    type: 'object',
    required: ['address'],
    properties: { address: EMAIL, name: { type: 'string' }, optional: { type: 'boolean' } },
    additionalProperties: false,
  },
}
const SCOPE = (): ProfileArgument => ({
  name: 'scope',
  title: 'Applies to',
  schema: { type: 'string', enum: ['this', 'series'] },
  capability: 'recurrence',
})
const RULE = (): ProfileArgument => ({
  name: 'rule',
  title: 'Repeats',
  schema: { type: 'string', minLength: 1 },
  capability: 'recurrence',
})
/** the members of an event a creation sets and a change may change (calendar §3.4, §3.5) */
const eventMembers = (required: boolean): ProfileArgument[] => {
  const r = required ? ({ required: true } as const) : {}
  return [
    { name: 'title', title: 'Title', schema: { type: 'string', maxLength: 1024 }, ...r },
    { name: 'start', title: 'Starts', schema: WHEN, ...r },
    { name: 'end', title: 'Ends', schema: WHEN, ...r },
    { name: 'allDay', title: 'All day', schema: { type: 'boolean' } },
    { name: 'timeZone', title: 'Time zone', schema: { type: 'string', minLength: 1 } },
    { name: 'description', title: 'Description', schema: { type: 'string' } },
    { name: 'place', title: 'Place', schema: { type: 'string' } },
    { name: 'busy', title: 'Shows as busy', schema: { type: 'boolean' } },
    RULE(),
    { name: 'attendees', title: 'Invited', schema: ATTENDEES, capability: 'attendees' },
    { name: 'notify', title: 'Send invitations', schema: { type: 'boolean' }, capability: 'attendees' },
    { name: 'meeting', title: 'Online meeting', schema: { type: 'boolean' }, capability: 'meeting' },
  ]
}
const ONE_EVENT: ResultShape = { members: { event: 'object' }, located: { single: ['event'] } }
const INVITED: ProfileTool['externalWhen'] = { addresses: [{ argument: 'attendees', member: 'address' }] }

export const CALENDAR_1_0: FeatureProfile = {
  id: 'org.ayni/calendar',
  version: '1.0',
  major: 1,
  prefix: 'calendar_',
  location: {
    argument: 'calendar',
    listTool: 'calendar_calendars',
    listMember: 'calendars',
    labels: { one: 'Calendar', list: 'Calendars', any: 'Any calendar you can reach' },
  },
  capabilities: ['free-busy', 'recurrence', 'attendees', 'respond', 'meeting'],
  referenceMembers: ['ref', 'calendar', 'series'],
  referenceArguments: ['calendar', 'ref'],
  tools: [
    {
      name: 'calendar_calendars',
      title: 'List calendars',
      description: 'List the calendars you can use. Give a text to keep those whose title holds it.',
      effect: 'read',
      othersWrote: 'names',
      arguments: [{ name: 'query', title: 'Title holds', schema: TEXT_200 }, limit(), cursor()],
      result: { members: { calendars: 'array' } },
    },
    {
      name: 'calendar_list_events',
      title: 'List events',
      description:
        'List the events of a calendar between two times, each occurrence of a repeating event on its own. Give a text to keep the events whose title, description or place holds it.',
      effect: 'read',
      othersWrote: 'names and content',
      arguments: [
        CALENDAR(),
        { name: 'from', title: 'From', schema: INSTANT, required: true },
        { name: 'to', title: 'To', schema: INSTANT, required: true },
        { name: 'query', title: 'Text', schema: TEXT_200 },
        limit(),
        cursor(),
      ],
      result: { members: { events: 'array' }, located: { lists: ['events'] } },
    },
    {
      name: 'calendar_get_event',
      title: 'Look at an event',
      description:
        "Look at one event. Given a repeating event's own reference, it answers the series once, with its rule.",
      effect: 'read',
      othersWrote: 'names and content',
      arguments: [CALENDAR(), { name: 'ref', title: 'Event', schema: REFERENCE, required: true }],
      result: ONE_EVENT,
    },
    {
      name: 'calendar_create_event',
      title: 'Add an event',
      description: 'Add an event to a calendar. Give a time zone for an event that repeats.',
      effect: 'write',
      externalWhen: INVITED,
      othersWrote: 'names',
      arguments: [CALENDAR(), ...eventMembers(true)],
      result: ONE_EVENT,
    },
    {
      name: 'calendar_update_event',
      title: 'Change an event',
      description:
        'Change an event you organize. Only the members you give change; an empty description or place removes it. Give the version you read to change nothing if the event changed since.',
      effect: 'write',
      externalWhen: INVITED,
      othersWrote: 'names',
      arguments: [
        CALENDAR(),
        { name: 'ref', title: 'Event', schema: REFERENCE, required: true },
        { name: 'ifVersion', title: 'Version read', schema: VERSION },
        ...eventMembers(false),
        SCOPE(),
      ],
      result: ONE_EVENT,
    },
    {
      name: 'calendar_cancel_event',
      title: 'Cancel an event',
      description:
        'Cancel an event you organize. Those invited are told where the calendar sends invitations. A cancelled event cannot be brought back.',
      effect: 'delete',
      othersWrote: 'no',
      arguments: [
        CALENDAR(),
        { name: 'ref', title: 'Event', schema: REFERENCE, required: true },
        { name: 'ifVersion', title: 'Version read', schema: VERSION },
        { name: 'notify', title: 'Tell those invited', schema: { type: 'boolean' }, capability: 'attendees' },
        { name: 'comment', title: 'Message', schema: { type: 'string', maxLength: 1000 }, capability: 'attendees' },
        SCOPE(),
      ],
      result: { members: { cancelled: 'boolean', ref: 'string' } },
    },
    {
      name: 'calendar_free_busy',
      title: 'See when people are busy',
      description:
        'See when a calendar, and other people, are busy between two times, without anything of their events.',
      effect: 'read',
      othersWrote: 'no',
      capability: 'free-busy',
      arguments: [
        CALENDAR(),
        { name: 'from', title: 'From', schema: INSTANT, required: true },
        { name: 'to', title: 'To', schema: INSTANT, required: true },
        { name: 'people', title: 'People', schema: { type: 'array', minItems: 1, maxItems: 20, items: EMAIL } },
      ],
      result: { members: { calendar: 'object' } },
    },
    {
      name: 'calendar_respond',
      title: 'Answer an invitation',
      description: 'Answer an invitation to an event you are invited to: accept, maybe, or decline.',
      effect: 'write',
      othersWrote: 'names and content',
      capability: 'respond',
      arguments: [
        CALENDAR(),
        { name: 'ref', title: 'Event', schema: REFERENCE, required: true },
        {
          name: 'response',
          title: 'Answer',
          schema: { type: 'string', enum: ['accepted', 'tentative', 'declined'] },
          required: true,
        },
        { name: 'comment', title: 'Message', schema: { type: 'string', maxLength: 1000 } },
        { name: 'notify', title: 'Tell the organizer', schema: { type: 'boolean' } },
        SCOPE(),
      ],
      result: ONE_EVENT,
    },
  ],
}

/** The profiles this agent knows, by their identifier (TOOL-FEAT-001). */
export const KNOWN_PROFILES: readonly FeatureProfile[] = [FILES_1_0, CALENDAR_1_0]

/** The capability whose tools are never given to a model: the agent's code alone makes and keeps a team's folder (D145). */
export const CODE_ONLY_CAPABILITIES: readonly string[] = ['team-roots']

/** The major and minor of a version `major.minor`, or undefined for anything else. */
export function parseVersion(version: unknown): { major: number; minor: number } | undefined {
  if (typeof version !== 'string') return undefined
  const m = /^(\d+)\.(\d+)$/.exec(version)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined
}

/**
 * The agent's copy of a profile by its identifier and a version of it: any minor of a major the copy has, since a later
 * minor removes and renames nothing (common §14, TOOL-FEAT-001); undefined for another identifier or major.
 */
export function knownProfile(id: string, version: unknown): FeatureProfile | undefined {
  const parsed = parseVersion(version)
  if (!parsed) return undefined
  return KNOWN_PROFILES.find((p) => p.id === id && p.major === parsed.major)
}

/** A tool of a profile by its name. */
export function profileTool(profile: FeatureProfile, name: string): ProfileTool | undefined {
  return profile.tools.find((t) => t.name === name)
}

/** Whether a name has the prefix of a profile's tools (common §2). */
export function hasProfilePrefix(profile: FeatureProfile, name: string): boolean {
  return name.startsWith(profile.prefix)
}

/** The tools of the core, and those of each capability in use, in the profile's order (TOOL-FEAT-010). */
export function toolsInUse(profile: FeatureProfile, capabilities: readonly string[]): ProfileTool[] {
  return profile.tools.filter((t) => !t.capability || capabilities.includes(t.capability))
}

/**
 * The input schema of a tool, as the model receives it (TOOL-FEAT-010): the arguments of the core and of the capabilities
 * in use, each with its title, in the profile's order; an argument of a capability not in use is absent.
 */
export function inputSchemaOf(tool: ProfileTool, capabilities: readonly string[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const argument of tool.arguments) {
    if (argument.capability && !capabilities.includes(argument.capability)) continue
    properties[argument.name] = { ...argument.schema, title: argument.title }
    if (argument.required) required.push(argument.name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}
