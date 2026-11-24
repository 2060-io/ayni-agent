/**
 * The user directory (ayni-spec D79, D87, D91, D92; IDENT-ROLE-012/013, IDENT-DIR-001, IDENT-DIR-007, IDENT-DIR-009;
 * decision 61). When the agent-pack names no identity provider, the people of the home organization are a file the
 * pack refers to (`identity.directory.file`), mounted from a secret of the deployment and never written in the pack.
 * An entry names a person and gives roles, typed by hand; its `department` and `groups` serve the membership of rule
 * spaces only (D87, SPACE-MEMB-001).
 *
 * The file is read at start, and the agent refuses to start on one that does not validate, naming the entry and the
 * field. It is read again when it changes: a Kubernetes Secret is updated by swapping a symlink (`..data`) in the
 * directory of the mount, so the directory is watched, and the content is polled by its hash as well, with no
 * assumption on how the file is mounted. A new version that does not validate is not loaded: the one in force stays
 * and the reason goes to the log, without any value.
 *
 * Each load is compared with the one before, kept sealed in the store (so that what changed while the agent was down
 * is seen at start), and every entry added, removed or changed is written to the admin audit: its id, its name, the
 * names of the fields that changed and the roles before and after, never a birthdate or a nationality (IDENT-DIR-009).
 * The birthdate and the nationality are read only to match a document read (IDENT-DIR-007): they leave this module only
 * through `entry()`, for that matching.
 */
import { createHash } from 'node:crypto'
import { type FSWatcher, readFileSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import type { AdminAuditRepo, KvRepo } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import { type DocumentIdentity, entryMatchesDocument, type MismatchReason } from './icao.js'

/** A person of the directory (IDENT-ROLE-012). */
export interface DirectoryEntry {
  id: string
  firstName: string
  lastName: string
  email: string
  /** `YYYY-MM-DD`; read only to match a document read (IDENT-DIR-003, IDENT-DIR-007) */
  birthDate?: string
  /** the code of ICAO Doc 9303 (`ESP`, `D`); read only to match a document read */
  nationality?: string
  /**
   * the reference picture of a face match (D131, IDENT-DIR-010): the name of a JPEG or PNG file in the folder of the
   * directory file, read when a face match needs it and at no other time
   */
  photo?: string
  /** one text: rule spaces only (SPACE-MEMB-001) */
  department?: string
  /** rule spaces only */
  groups: string[]
  /** typed by hand, roles the agent-pack declares (D87) */
  roles: string[]
}

/** What the rest of the agent sees of an entry when the directory changes: no email, birthdate or nationality. */
export interface DirectoryView {
  id: string
  name: string
  department?: string
  groups: string[]
  roles: string[]
}

/** The fields of an entry, in the order a change names them. */
export const ENTRY_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'birthDate',
  'nationality',
  'photo',
  'department',
  'groups',
  'roles',
] as const
type EntryField = (typeof ENTRY_FIELDS)[number]

/** The first and last name joined by a space: the name the directory gives a person (IDENT-DIR-005). */
export const nameOf = (entry: Pick<DirectoryEntry, 'firstName' | 'lastName'>): string =>
  `${entry.firstName} ${entry.lastName}`

/** A text compared without regard to case or marks (SPACE-MEMB-005): `Ríos` and `rios` are the same. */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** What a file must say beyond its shape: the roles the pack declares, and whether badges are read from a passport. */
export interface DirectoryRules {
  /** the roles of `identity.roles` */
  roles: readonly string[]
  /** a badge is obtained from the directory with a passport: every entry carries a birthdate and a nationality */
  passport: boolean
}

export class DirectoryError extends Error {
  public constructor(
    message: string,
    public readonly details: string[] = []
  ) {
    super(details.length ? `${message}\n  - ${details.join('\n  - ')}` : message)
    this.name = 'DirectoryError'
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NATIONALITY = /^[A-Za-z]{1,3}$/
const KNOWN_KEYS = new Set<string>(['id', ...ENTRY_FIELDS])
const MAX_TEXT = 200

/** A date written `YYYYMMDD` (as the reference example writes it) or `YYYY-MM-DD`, as `YYYY-MM-DD`; undefined otherwise. */
export function directoryDate(value: string): string | undefined {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const iso = `${match[1]}-${match[2]}-${match[3]}`
  const date = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? undefined : iso
}

/**
 * Reads the text of a directory file (IDENT-DIR-001): a list `people` whose entries carry unique ids and unique emails
 * (in lower case) and name only declared roles. Every scalar is read as text (YAML's failsafe schema), so that an id
 * `0042` keeps its zeros and a nationality `NO` stays a nationality. Nothing is loaded from a file that does not
 * validate: the error names each entry and field at fault, and never a value of a birthdate or a nationality.
 */
export function parseDirectory(text: string, rules: DirectoryRules): DirectoryEntry[] {
  let doc: unknown
  try {
    doc = parseYaml(text, { schema: 'failsafe' })
  } catch (error) {
    throw new DirectoryError('the directory file is not YAML or JSON', [String((error as Error).message ?? error)])
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    throw new DirectoryError('the directory file must hold a map with a list `people`')
  const top = doc as Record<string, unknown>
  const errors: string[] = []
  for (const key of Object.keys(top))
    if (key !== 'people') errors.push(`${key}: unknown key; the file holds \`people\``)
  if (!Array.isArray(top.people)) throw new DirectoryError('the directory file must hold a list `people`', errors)
  const declared = new Set(rules.roles)
  const entries: DirectoryEntry[] = []
  const ids = new Map<string, string>()
  const emails = new Map<string, string>()
  top.people.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`people[${i}]: an entry is a map of its fields`)
      return
    }
    const item = raw as Record<string, unknown>
    const rawId = typeof item.id === 'string' ? item.id.trim() : ''
    const where = `people[${i}]${rawId ? ` (${rawId})` : ''}`
    const fault = (field: string, what: string) => errors.push(`${where}.${field}: ${what}`)
    for (const key of Object.keys(item)) if (!KNOWN_KEYS.has(key)) fault(key, 'unknown field')
    const text = (field: string, required: boolean): string | undefined => {
      const value = item[field]
      if (value === undefined || value === null || value === '') {
        if (required) fault(field, 'is required')
        return undefined
      }
      if (typeof value !== 'string') {
        fault(field, 'must be a text')
        return undefined
      }
      const trimmed = value.trim()
      if (!trimmed) {
        if (required) fault(field, 'is required')
        return undefined
      }
      if (trimmed.length > MAX_TEXT) fault(field, `is longer than ${MAX_TEXT} characters`)
      return trimmed
    }
    const list = (field: string): string[] => {
      const value = item[field]
      if (value === undefined || value === null || value === '') return []
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
        fault(field, 'must be a list of texts')
        return []
      }
      return [...new Set(value.map((v) => (v as string).trim()))]
    }
    const id = text('id', true)
    const firstName = text('firstName', true)
    const lastName = text('lastName', true)
    const email = text('email', true)
    if (email && !EMAIL.test(email)) fault('email', 'is not an email address')
    // the birthdate and the nationality are named at fault, never written (IDENT-DIR-007)
    const birthText = text('birthDate', rules.passport)
    const birthDate = birthText ? directoryDate(birthText) : undefined
    if (birthText && !birthDate) fault('birthDate', 'is not a date (YYYYMMDD)')
    const nationalityText = text('nationality', rules.passport)
    if (nationalityText && !NATIONALITY.test(nationalityText))
      fault('nationality', 'is not a code of ICAO Doc 9303 (one to three letters)')
    const nationality = nationalityText && NATIONALITY.test(nationalityText) ? nationalityText.toUpperCase() : undefined
    const department = text('department', false)
    // a file beside the directory, by its name alone: never a path that leaves its folder (IDENT-DIR-010)
    const photo = text('photo', false)
    if (photo && (basename(photo) !== photo || !/\.(jpe?g|png)$/i.test(photo)))
      fault('photo', 'names a JPEG or PNG file in the folder of the directory, by its name alone')
    const groups = list('groups')
    const roles = list('roles')
    for (const role of roles)
      if (!declared.has(role)) fault('roles', `names the role ${role}, which identity.roles does not declare`)
    if (id) {
      const earlier = ids.get(id)
      if (earlier) errors.push(`${earlier} and ${where} have the same id`)
      else ids.set(id, where)
    }
    if (email) {
      const key = email.toLowerCase()
      const earlier = emails.get(key)
      if (earlier) errors.push(`${earlier} and ${where} have the same email`)
      else emails.set(key, where)
    }
    if (!id || !firstName || !lastName || !email) return
    entries.push({
      id,
      firstName,
      lastName,
      email,
      ...(birthDate ? { birthDate } : {}),
      ...(nationality ? { nationality } : {}),
      ...(department ? { department } : {}),
      ...(photo && basename(photo) === photo && /\.(jpe?g|png)$/i.test(photo) ? { photo } : {}),
      groups,
      roles,
    })
  })
  if (errors.length) throw new DirectoryError('the directory file does not validate (IDENT-DIR-001)', errors)
  return entries
}

/** One entry added, removed or changed by a load of the directory, as the admin audit keeps it (IDENT-DIR-009). */
export interface DirectoryChange {
  kind: 'added' | 'removed' | 'changed'
  directoryId: string
  name: string
  /** the names of the fields that changed: never a value */
  fields: string[]
  /** when the roles changed */
  rolesBefore?: string[]
  rolesAfter?: string[]
}

/**
 * What the agent keeps of a loaded directory to tell what the next load changes: the names, departments, groups and
 * roles, and keyed digests of the email, the birthdate and the nationality. Sealed in the store, never in the clear.
 */
export interface SnapshotEntry {
  firstName: string
  lastName: string
  department?: string
  groups: string[]
  roles: string[]
  digests: Partial<Record<'email' | 'birthDate' | 'nationality' | 'photo', string>>
}
export type DirectorySnapshot = Map<string, SnapshotEntry>

const SNAPSHOT_KEY = 'directory:snapshot'

export function snapshotOf(
  entries: Iterable<DirectoryEntry>,
  crypto: Pick<EntryCrypto, 'blindIndex'>
): DirectorySnapshot {
  const digest = (field: string, value: string | undefined) =>
    value === undefined ? undefined : crypto.blindIndex(`directory\n${field}\n${value}`)
  const out: DirectorySnapshot = new Map()
  for (const e of entries) {
    const digests: SnapshotEntry['digests'] = {}
    for (const [field, value] of [
      ['email', e.email.toLowerCase()],
      ['birthDate', e.birthDate],
      ['nationality', e.nationality],
      ['photo', e.photo],
    ] as const) {
      const d = digest(field, value)
      if (d) digests[field] = d
    }
    out.set(e.id, {
      firstName: e.firstName,
      lastName: e.lastName,
      ...(e.department ? { department: e.department } : {}),
      groups: [...e.groups],
      roles: [...e.roles],
      digests,
    })
  }
  return out
}

const sameList = (a: string[], b: string[]) => [...a].sort().join('\n') === [...b].sort().join('\n')

/** What changed between two loads, entry by entry: the names of the fields, the roles before and after (IDENT-DIR-009). */
export function diffDirectory(before: DirectorySnapshot, after: DirectorySnapshot): DirectoryChange[] {
  const changes: DirectoryChange[] = []
  const present = (e: SnapshotEntry): EntryField[] =>
    ENTRY_FIELDS.filter((f) => {
      if (f === 'firstName' || f === 'lastName') return true
      if (f === 'groups' || f === 'roles') return e[f].length > 0
      if (f === 'department') return e.department !== undefined
      return e.digests[f] !== undefined
    })
  const roles = (from: string[], to: string[]) => (sameList(from, to) ? {} : { rolesBefore: from, rolesAfter: to })
  for (const [id, next] of after) {
    const prev = before.get(id)
    if (!prev) {
      changes.push({
        kind: 'added',
        directoryId: id,
        name: nameOf(next),
        fields: present(next),
        ...roles([], next.roles),
      })
      continue
    }
    const fields = ENTRY_FIELDS.filter((f) => {
      if (f === 'firstName' || f === 'lastName') return prev[f] !== next[f]
      if (f === 'department') return prev.department !== next.department
      if (f === 'groups' || f === 'roles') return !sameList(prev[f], next[f])
      return prev.digests[f] !== next.digests[f]
    })
    if (fields.length)
      changes.push({ kind: 'changed', directoryId: id, name: nameOf(next), fields, ...roles(prev.roles, next.roles) })
  }
  for (const [id, prev] of before)
    if (!after.has(id))
      changes.push({ kind: 'removed', directoryId: id, name: nameOf(prev), fields: [], ...roles(prev.roles, []) })
  return changes
}

const viewOf = (id: string, e: SnapshotEntry): DirectoryView => ({
  id,
  name: nameOf(e),
  ...(e.department ? { department: e.department } : {}),
  groups: [...e.groups],
  roles: [...e.roles],
})

/** One load of the directory: what it changed, and what the entries were before and are now (no email, no birthdate). */
export interface DirectoryReload {
  at: string
  /** `start`: the load at start, against the one the agent kept; `reload`: a change of the file while it runs */
  reason: 'start' | 'reload'
  changes: DirectoryChange[]
  before: ReadonlyMap<string, DirectoryView>
  after: ReadonlyMap<string, DirectoryView>
}

export class UserDirectory {
  private current = new Map<string, DirectoryEntry>()
  /** the hash of the content read last, valid or not: a content that did not validate is not read again until it changes */
  private seen?: string
  private watcher?: FSWatcher
  private poller?: NodeJS.Timeout
  private debounce?: NodeJS.Timeout
  /** one load at a time */
  private chain: Promise<unknown> = Promise.resolve()
  private readonly listeners: ((reload: DirectoryReload) => Promise<void>)[] = []
  private stopped = false

  public constructor(
    /** the path of the file, as the agent-pack names it, resolved from the pack directory */
    public readonly file: string,
    private readonly rules: DirectoryRules,
    private readonly kv: KvRepo,
    private readonly audit: AdminAuditRepo,
    private readonly crypto: EntryCrypto,
    private readonly logger: Logger
  ) {}

  private read(): { text: string; hash: string } {
    let text: string
    try {
      // through the symlink of a mounted secret, to the file it points to now
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      throw new DirectoryError(`the directory file ${this.file} cannot be read`, [
        (error as NodeJS.ErrnoException).code ?? String(error),
      ])
    }
    return { text, hash: createHash('sha256').update(text).digest('hex') }
  }

  /** Reads and validates the file at start: one that does not validate stops the agent (IDENT-DIR-001). */
  public open(): void {
    const { text, hash } = this.read()
    this.current = new Map(parseDirectory(text, this.rules).map((e) => [e.id, e]))
    this.seen = hash
    this.logger.info({ file: this.file, people: this.current.size }, 'user directory loaded (D79)')
  }

  /**
   * At start: what the file changed since the agent last loaded it, the removals made while it was down included, is
   * recorded in the admin audit and returned, for the agent to act on once it is wired (IDENT-ROLE-013).
   */
  public settle(): Promise<DirectoryReload> {
    return this.serial(async () => this.commit((await this.loadSnapshot()) ?? new Map(), 'start'))
  }

  /** Called with every load that changed the directory while the agent runs. */
  public onReload(listener: (reload: DirectoryReload) => Promise<void>): void {
    this.listeners.push(listener)
  }

  /**
   * Reads the file again when its content changed; a new version that does not validate leaves the one in force and
   * logs why (IDENT-DIR-001). Returns the load, or undefined when nothing changed or nothing was loaded.
   */
  public check(): Promise<DirectoryReload | undefined> {
    return this.serial(async () => {
      if (this.stopped) return undefined
      let read: { text: string; hash: string }
      try {
        read = this.read()
      } catch (error) {
        if (this.seen !== 'unreadable')
          this.logger.error({ err: error, file: this.file }, 'user directory not reloaded: the file cannot be read')
        this.seen = 'unreadable'
        return undefined
      }
      if (read.hash === this.seen) return undefined
      this.seen = read.hash
      let entries: DirectoryEntry[]
      try {
        entries = parseDirectory(read.text, this.rules)
      } catch (error) {
        this.logger.error(
          { file: this.file, faults: error instanceof DirectoryError ? error.details : [String(error)] },
          'user directory not reloaded: the new file does not validate; the one in force stays (IDENT-DIR-001)'
        )
        return undefined
      }
      const before = snapshotOf(this.current.values(), this.crypto)
      this.current = new Map(entries.map((e) => [e.id, e]))
      const reload = await this.commit(before, 'reload')
      for (const listener of this.listeners) {
        try {
          await listener(reload)
        } catch (error) {
          this.logger.error({ err: error }, 'what a reload of the user directory changes was not all done')
        }
      }
      return reload
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async commit(before: DirectorySnapshot, reason: DirectoryReload['reason']): Promise<DirectoryReload> {
    const after = snapshotOf(this.current.values(), this.crypto)
    const changes = diffDirectory(before, after)
    const at = nowIso()
    for (const change of changes)
      await this.audit.insert({
        id: prefixedId('adm'),
        ts: at,
        action: 'directory-change',
        actor: 'directory',
        reason,
        detail: { ...change },
      })
    await this.saveSnapshot(after)
    if (changes.length)
      this.logger.info(
        {
          reason,
          added: changes.filter((c) => c.kind === 'added').length,
          removed: changes.filter((c) => c.kind === 'removed').length,
          changed: changes.filter((c) => c.kind === 'changed').length,
        },
        'user directory changed (IDENT-DIR-009)'
      )
    const views = (s: DirectorySnapshot) => new Map([...s].map(([id, e]) => [id, viewOf(id, e)]))
    return { at, reason, changes, before: views(before), after: views(after) }
  }

  private async loadSnapshot(): Promise<DirectorySnapshot | undefined> {
    const raw = await this.kv.get(SNAPSHOT_KEY)
    if (!raw) return undefined
    try {
      const { keyRef, cipher } = JSON.parse(raw) as { keyRef: string; cipher: string }
      const rows = openJson<[string, SnapshotEntry][]>(this.crypto, keyRef, Buffer.from(cipher, 'base64'))
      return new Map(rows)
    } catch (error) {
      this.logger.warn(
        { err: error },
        'the last load of the user directory cannot be read: every entry counts as added'
      )
      return undefined
    }
  }

  private async saveSnapshot(snapshot: DirectorySnapshot): Promise<void> {
    const keyRef = this.crypto.newWrappedKey()
    const { cipher } = sealJson(this.crypto, keyRef, [...snapshot])
    await this.kv.set(SNAPSHOT_KEY, JSON.stringify({ keyRef, cipher: cipher.toString('base64') }))
  }

  /**
   * Reloads on change (IDENT-ROLE-013): the directory of the file is watched (a Secret is updated by a symlink swap in
   * it), and the content is read every `pollMs` and compared by its hash, whatever the mount. 0 polls nothing.
   */
  public watch(pollMs: number): void {
    try {
      this.watcher = watch(dirname(this.file), { persistent: false }, () => this.soon())
      this.watcher.on('error', (error) =>
        this.logger.warn({ err: error, file: this.file }, 'user directory no longer watched: polled only')
      )
    } catch (error) {
      this.logger.warn({ err: error, file: this.file }, 'user directory not watched: polled only')
    }
    if (pollMs > 0) {
      this.poller = setInterval(() => this.soon(0), pollMs)
      this.poller.unref()
    }
  }

  private soon(delayMs = 150): void {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.check().catch((error) => this.logger.error({ err: error }, 'user directory reload failed'))
    }, delayMs)
    this.debounce.unref()
  }

  public stop(): void {
    this.stopped = true
    this.watcher?.close()
    if (this.poller) clearInterval(this.poller)
    if (this.debounce) clearTimeout(this.debounce)
  }

  // ---- reading -------------------------------------------------------------------------------------------

  public get size(): number {
    return this.current.size
  }

  /** An entry, birthdate and nationality included: for the matching of a document read only (IDENT-DIR-007). */
  public entry(id: string): DirectoryEntry | undefined {
    return this.current.get(id)
  }

  /** An entry as the agent shows it: name, department, groups and roles. */
  public view(id: string): DirectoryView | undefined {
    const e = this.current.get(id)
    return e
      ? {
          id,
          name: nameOf(e),
          ...(e.department ? { department: e.department } : {}),
          groups: [...e.groups],
          roles: [...e.roles],
        }
      : undefined
  }

  /** Every entry as the agent shows it, in the order of the file. */
  public views(): DirectoryView[] {
    return [...this.current.keys()].map((id) => this.view(id) as DirectoryView)
  }

  /**
   * The entries a document read is of (IDENT-DIR-003): the same date of birth and nationality, the same last name and the
   * entry's first names among the given names of the document, after the transliteration of ICAO Doc 9303, Part 3. The
   * birthdate and the nationality are compared here and leave the module in no form (IDENT-DIR-007); what the caller
   * learns of an entry that does not match is the first test it failed, counted.
   */
  public matchDocument(document: DocumentIdentity): {
    ids: string[]
    nearest: Partial<Record<MismatchReason, number>>
  } {
    const ids: string[] = []
    const nearest: Partial<Record<MismatchReason, number>> = {}
    for (const entry of this.current.values()) {
      const reason = entryMatchesDocument(entry, document)
      if (!reason) ids.push(entry.id)
      else nearest[reason] = (nearest[reason] ?? 0) + 1
    }
    return { ids, nearest }
  }

  /**
   * The reference picture of an entry, for a face match and nothing else (D131, IDENT-DIR-010): the file its `photo`
   * names, read now, with its type; undefined when it names none or the file cannot be read (the reason is logged, the
   * picture never).
   */
  public photoOf(id: string): { bytes: Buffer; mimeType: string } | undefined {
    const photo = this.current.get(id)?.photo
    if (!photo) return undefined
    try {
      const bytes = readFileSync(join(dirname(this.file), photo))
      return { bytes, mimeType: /\.png$/i.test(photo) ? 'image/png' : 'image/jpeg' }
    } catch (error) {
      this.logger.warn({ entryId: id, err: (error as Error).message }, 'the photo of a directory entry cannot be read')
      return undefined
    }
  }

  /** The entry that holds an address, compared in lower case (IDENT-DIR-004). */
  public byEmail(email: string): DirectoryEntry | undefined {
    const key = email.trim().toLowerCase()
    return [...this.current.values()].find((e) => e.email.toLowerCase() === key)
  }

  /**
   * The member picker (SPACE-MEMB-005, PROF-DIR-001): the entries whose first or last name contains `q`, at least two
   * characters, compared without regard to case or marks; at most `limit`, by name.
   */
  public search(q: string, limit = 20): DirectoryView[] {
    const needle = fold(q.trim())
    if (needle.length < 2) return []
    return [...this.current.values()]
      .filter((e) => fold(e.firstName).includes(needle) || fold(e.lastName).includes(needle))
      .sort((a, b) => fold(nameOf(a)).localeCompare(fold(nameOf(b))))
      .slice(0, limit)
      .map((e) => this.view(e.id) as DirectoryView)
  }
}
