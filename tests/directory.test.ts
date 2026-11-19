/**
 * The user directory (decision 61; ayni-spec D79, D87, D92; IDENT-ROLE-012/013, IDENT-DIR-001, IDENT-DIR-007,
 * IDENT-DIR-009, CORE-PACK-001): the file is read and validated, a pack that writes the people inline is refused, a
 * Kubernetes Secret's symlink swap is seen and reloaded, each load is diffed against the last one into the admin audit
 * without any value of a birthdate or a nationality, and a file that does not validate keeps the one in force.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PackError, validatePackDocument } from '../src/config/pack.js'
import { directoryReadsDocuments, mustBeRevocable } from '../src/config/packTypes.js'
import {
  DirectoryError,
  type DirectoryReload,
  diffDirectory,
  directoryDate,
  fold,
  parseDirectory,
  snapshotOf,
  UserDirectory,
} from '../src/core/directory.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'

const crypto = createEntryCrypto(Buffer.alloc(32, 5))
const rules = { roles: ['dispatcher', 'manager', 'admin'], passport: false }

const ANA = {
  id: 'p-0042',
  firstName: 'Ana',
  lastName: 'Ríos',
  email: 'ana.rios@northwind.example',
  birthDate: '19910521',
  nationality: 'ESP',
  department: 'Depot Rotterdam',
  groups: ['fleet-safety', 'night-shift'],
  roles: ['dispatcher'],
}
const JONAS = {
  id: 'p-0043',
  firstName: 'Jonas',
  lastName: 'Weber',
  email: 'jonas.weber@northwind.example',
  birthDate: '19850203',
  nationality: 'D',
  department: 'Depot Rotterdam',
  roles: ['manager'],
}
const PIET = { id: 'p-0044', firstName: 'Piet', lastName: 'de Vries', email: 'piet@northwind.example' }

const yamlOf = (people: Record<string, unknown>[]) => JSON.stringify({ people }, null, 2)

/** A log that keeps every line, to show what it says and what it never says. */
function capturingLogger() {
  const lines: string[] = []
  const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) })
  return { logger, lines }
}

describe('the file of the directory (IDENT-DIR-001, IDENT-ROLE-012)', () => {
  it('loads entries with a department, several groups and roles, every scalar as text', () => {
    const entries = parseDirectory(
      [
        'people:',
        '  - id: 0042',
        '    firstName: Ana',
        '    lastName: Ríos',
        '    email: ana.rios@northwind.example',
        '    birthDate: 19910521',
        '    nationality: NO',
        '    department: Depot Rotterdam',
        '    groups: [fleet-safety, night-shift]',
        '    roles: [dispatcher]',
      ].join('\n'),
      rules
    )
    // YAML's failsafe schema: the id keeps its zeros, Norway stays a nationality, the date a date
    expect(entries).toEqual([
      {
        id: '0042',
        firstName: 'Ana',
        lastName: 'Ríos',
        email: 'ana.rios@northwind.example',
        birthDate: '1991-05-21',
        nationality: 'NO',
        department: 'Depot Rotterdam',
        groups: ['fleet-safety', 'night-shift'],
        roles: ['dispatcher'],
      },
    ])
    // JSON is YAML too; birthdate, nationality, department, groups and roles are optional
    expect(parseDirectory(yamlOf([PIET]), rules)).toEqual([{ ...PIET, groups: [], roles: [] }])
  })

  it('refuses a file with two entries of one email, naming both entries and no value (IDENT-DIR-001)', () => {
    const twin = { ...JONAS, id: 'p-0099', email: 'ANA.RIOS@northwind.example' }
    let error: DirectoryError | undefined
    try {
      parseDirectory(yamlOf([ANA, twin]), rules)
    } catch (e) {
      error = e as DirectoryError
    }
    expect(error).toBeInstanceOf(DirectoryError)
    expect(error?.details).toEqual(['people[0] (p-0042) and people[1] (p-0099) have the same email'])
    expect(error?.message).not.toContain('northwind.example')
  })

  it('refuses an undeclared role, a duplicate id, an unknown field, a bad email, date and nationality', () => {
    const bad = [
      { ...ANA, roles: ['dispatcher', 'janitor'] },
      { ...PIET, id: 'p-0042' },
      { ...JONAS, role: 'manager', email: 'not an address', birthDate: '19850231', nationality: 'DEU1' },
      { id: 'p-0050', lastName: 'Nobody' },
    ]
    let error: DirectoryError | undefined
    try {
      parseDirectory(yamlOf(bad), rules)
    } catch (e) {
      error = e as DirectoryError
    }
    expect(error?.details).toEqual([
      'people[0] (p-0042).roles: names the role janitor, which identity.roles does not declare',
      'people[0] (p-0042) and people[1] (p-0042) have the same id',
      'people[2] (p-0043).role: unknown field',
      'people[2] (p-0043).email: is not an email address',
      'people[2] (p-0043).birthDate: is not a date (YYYYMMDD)',
      'people[2] (p-0043).nationality: is not a code of ICAO Doc 9303 (one to three letters)',
      'people[3] (p-0050).firstName: is required',
      'people[3] (p-0050).email: is required',
    ])
    // the values of a birthdate and a nationality are named at fault, never written (IDENT-DIR-007)
    expect(error?.message).not.toContain('19850231')
    expect(error?.message).not.toContain('DEU1')
  })

  it('needs a birthdate and a nationality on every entry when badges are obtained with a passport (IDENT-DIR-002)', () => {
    expect(() => parseDirectory(yamlOf([ANA]), { ...rules, passport: true })).not.toThrow()
    const error = (() => {
      try {
        parseDirectory(yamlOf([PIET]), { ...rules, passport: true })
      } catch (e) {
        return e as DirectoryError
      }
    })()
    expect(error?.details).toEqual([
      'people[0] (p-0044).birthDate: is required',
      'people[0] (p-0044).nationality: is required',
    ])
  })

  it('refuses a file that is not a list of people', () => {
    expect(() => parseDirectory('people: nobody', rules)).toThrow(/a list `people`/)
    expect(() => parseDirectory('- id: p-1', rules)).toThrow(/a map with a list `people`/)
    expect(() => parseDirectory(yamlOf([]).replace('"people"', '"staff"'), rules)).toThrow(DirectoryError)
    // an empty list is a directory that holds nobody
    expect(parseDirectory('people: []', rules)).toEqual([])
  })

  it('reads dates written YYYYMMDD or YYYY-MM-DD, and folds case and marks for the picker', () => {
    expect(directoryDate('19910521')).toBe('1991-05-21')
    expect(directoryDate('1991-05-21')).toBe('1991-05-21')
    expect(directoryDate('19910231')).toBeUndefined()
    expect(fold('Ríos')).toBe('rios')
    expect(fold('MÜLLER')).toBe('muller')
  })
})

describe('the agent-pack names the file and never the people (CORE-PACK-001, IDENT-ROLE-012)', () => {
  const doc = (identity: Record<string, unknown>) => ({
    schemaVersion: '3.0',
    metadata: { id: 'test-agent', displayName: 'A' },
    identity: {
      homeBackingIdentity: 'did:webvh:x:home',
      roleRules: [],
      roles: { dispatcher: {}, auditor: { admin: true } },
      ...identity,
    },
    language: { agent: 'en' },
    persona: { systemPrompt: 'x' },
    llm: { provider: 'stub', model: 'echo' },
    embeddings: { provider: 'stub', model: 'hash' },
    privacy: {
      processingActivities: [
        { id: 'conversation-memory', lawfulBasis: 'contract' },
        { id: 'working-memory', lawfulBasis: 'contract' },
        { id: 'credential-presentations', lawfulBasis: 'contract' },
        { id: 'approvals', lawfulBasis: 'contract' },
      ],
    },
    features: { voiceNotes: false, inboundImages: false },
  })

  it('accepts identity.directory.file and the admin flag of a role', () => {
    const pack = validatePackDocument(doc({ directory: { file: '/run/secrets/ayni/directory.yaml' } }), {})
    expect(pack.identity.directory).toEqual({ file: '/run/secrets/ayni/directory.yaml' })
    expect(pack.identity.roles?.auditor?.admin).toBe(true)
  })

  it('refuses a pack that writes the people inline, in words', () => {
    for (const identity of [
      { directory: { file: 'x.yaml', people: [{ id: 'p-1' }] } },
      { directory: [{ id: 'p-1', firstName: 'Ana' }] },
      { people: [{ id: 'p-1' }] },
    ]) {
      let error: PackError | undefined
      try {
        validatePackDocument(doc(identity), {})
      } catch (e) {
        error = e as PackError
      }
      expect(error).toBeInstanceOf(PackError)
      expect(error?.message).toContain('writes the people of the user directory inline')
      expect(error?.message).toContain('IDENT-ROLE-012')
    }
    // a directory with no file is refused by the schema
    expect(() => validatePackDocument(doc({ directory: {} }), {})).toThrow(/schema validation/)
  })

  it('reads the passport method and the revocable credentials from the profiles that take claims from the directory', () => {
    const fromDirectory = {
      credential: { jsonSchemaCredentialId: 'https://ecs.example/badge' },
      authChallenge: { type: 'document' as const },
      claims: { name: { from: 'record', record: 'directory', field: 'name' } },
    }
    const pack = { issuance: { badge: fromDirectory } } as never
    expect(directoryReadsDocuments(pack)).toBe(true)
    expect(mustBeRevocable(fromDirectory as never)).toBe(true)
    // the list of challenges of phase 2b: [{ type: email }] reads no document
    expect(
      directoryReadsDocuments({
        issuance: { badge: { ...fromDirectory, authChallenge: [{ type: 'email' }] } },
      } as never)
    ).toBe(false)
    expect(mustBeRevocable({ claims: { n: { from: 'computed', fn: 'today' } } } as never)).toBe(false)
  })
})

describe('what a load changes, entry by entry (IDENT-DIR-009)', () => {
  const snap = (people: Record<string, unknown>[]) => snapshotOf(parseDirectory(yamlOf(people), rules), crypto)

  it('names the fields that changed and the roles before and after, never a value of a birthdate or a nationality', () => {
    const before = snap([ANA, JONAS, PIET])
    const after = snap([
      { ...ANA, roles: ['dispatcher', 'manager'], birthDate: '19910522' },
      { ...JONAS, department: 'Depot Antwerp' },
      { id: 'p-0045', firstName: 'Mia', lastName: 'Jansen', email: 'mia@northwind.example', roles: ['dispatcher'] },
    ])
    const changes = diffDirectory(before, after)
    expect(changes).toEqual([
      {
        kind: 'changed',
        directoryId: 'p-0042',
        name: 'Ana Ríos',
        fields: ['birthDate', 'roles'],
        rolesBefore: ['dispatcher'],
        rolesAfter: ['dispatcher', 'manager'],
      },
      { kind: 'changed', directoryId: 'p-0043', name: 'Jonas Weber', fields: ['department'] },
      {
        kind: 'added',
        directoryId: 'p-0045',
        name: 'Mia Jansen',
        fields: ['firstName', 'lastName', 'email', 'roles'],
        rolesBefore: [],
        rolesAfter: ['dispatcher'],
      },
      { kind: 'removed', directoryId: 'p-0044', name: 'Piet de Vries', fields: [] },
    ])
    expect(JSON.stringify(changes)).not.toMatch(/1991|ESP|northwind/)
    // the email is compared without regard to case, the order of groups and roles does not count
    expect(
      diffDirectory(
        before,
        snap([{ ...ANA, email: 'Ana.Rios@Northwind.example', groups: ['night-shift', 'fleet-safety'] }, JONAS, PIET])
      )
    ).toEqual([])
  })
})

describe('the directory as it runs (IDENT-ROLE-013, IDENT-DIR-001, IDENT-DIR-009)', () => {
  const dirs: string[] = []
  const directories: UserDirectory[] = []
  afterEach(() => {
    for (const d of directories.splice(0)) d.stop()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /**
   * A Secret as Kubernetes mounts it: `directory.yaml -> ..data/directory.yaml`, `..data -> ..<version>`; an update
   * writes a new version directory and swaps `..data` by a rename.
   */
  function secretMount(people: Record<string, unknown>[]) {
    const root = mkdtempSync(join(tmpdir(), 'ayni-directory-'))
    dirs.push(root)
    let version = 0
    const write = (content: string) => {
      version += 1
      const dir = join(root, `..2026_11_19_00_00_0${version}`)
      mkdirSync(dir)
      writeFileSync(join(dir, 'directory.yaml'), content)
      const tmp = join(root, '..data_tmp')
      symlinkSync(`..2026_11_19_00_00_0${version}`, tmp)
      renameSync(tmp, join(root, '..data'))
    }
    write(yamlOf(people))
    symlinkSync('..data/directory.yaml', join(root, 'directory.yaml'))
    return {
      file: join(root, 'directory.yaml'),
      swap: (p: Record<string, unknown>[] | string) => write(typeof p === 'string' ? p : yamlOf(p)),
    }
  }

  function open(file: string, store = new MemoryStore(), logger = capturingLogger().logger) {
    const directory = new UserDirectory(file, rules, store.kv, store.adminAudit, crypto, logger)
    directories.push(directory)
    directory.open()
    return { directory, store }
  }

  it('refuses to start on a file that does not validate, and on a file that is not there', () => {
    const mount = secretMount([ANA, { ...JONAS, email: ANA.email }])
    expect(() => open(mount.file)).toThrow(/p-0042.*p-0043.*same email/s)
    expect(() => open(join(dirs[0] as string, 'missing.yaml'))).toThrow(/cannot be read/)
  })

  it('records every entry as added at its first load, and only what changed after a restart', async () => {
    const mount = secretMount([ANA, JONAS])
    const { directory, store } = open(mount.file)
    const first = await directory.settle()
    expect(first.reason).toBe('start')
    expect(first.changes.map((c) => [c.kind, c.directoryId])).toEqual([
      ['added', 'p-0042'],
      ['added', 'p-0043'],
    ])
    // the next process, after Piet was added and Jonas removed while the agent was down
    mount.swap([ANA, PIET])
    const restarted = open(mount.file, store).directory
    const second = await restarted.settle()
    expect(second.changes.map((c) => [c.kind, c.directoryId])).toEqual([
      ['added', 'p-0044'],
      ['removed', 'p-0043'],
    ])
    // what it was before is what the agent kept: names, departments, groups, roles; no email, birthdate or nationality
    expect(second.before.get('p-0043')).toEqual({
      id: 'p-0043',
      name: 'Jonas Weber',
      department: 'Depot Rotterdam',
      groups: [],
      roles: ['manager'],
    })
    // the last load is kept sealed: nothing of a person in the clear in the store
    const kept = (await store.kv.get('directory:snapshot')) as string
    for (const value of ['Ana', 'Ríos', 'northwind', '1991', 'ESP', 'Depot', 'fleet-safety', 'dispatcher'])
      expect(kept).not.toContain(value)
  })

  it('reloads when a symlink swap updates the Secret, and diffs the change into the admin audit (IDENT-DIR-009)', async () => {
    const mount = secretMount([ANA, JONAS, PIET])
    const { logger, lines } = capturingLogger()
    const { directory, store } = open(mount.file, new MemoryStore(), logger)
    await directory.settle()
    const reloads: DirectoryReload[] = []
    directory.onReload(async (r) => void reloads.push(r))
    // watched, and polled every 50 ms
    directory.watch(50)
    // Ana's roles, Jonas's department, Piet removed: three records (the spec's Verify of IDENT-DIR-009)
    mount.swap([
      { ...ANA, roles: ['dispatcher', 'manager'] },
      { ...JONAS, department: 'Depot Antwerp' },
    ])
    await vi.waitFor(() => expect(reloads).toHaveLength(1), { timeout: 5000, interval: 20 })
    expect(directory.view('p-0044')).toBeUndefined()
    expect(directory.view('p-0042')?.roles).toEqual(['dispatcher', 'manager'])
    const changes = (await store.adminAudit.list(10, { action: 'directory-change' })).filter(
      (r) => r.reason === 'reload'
    )
    expect(changes.map((r) => r.detail)).toEqual([
      { kind: 'removed', directoryId: 'p-0044', name: 'Piet de Vries', fields: [] },
      { kind: 'changed', directoryId: 'p-0043', name: 'Jonas Weber', fields: ['department'] },
      {
        kind: 'changed',
        directoryId: 'p-0042',
        name: 'Ana Ríos',
        fields: ['roles'],
        rolesBefore: ['dispatcher'],
        rolesAfter: ['dispatcher', 'manager'],
      },
    ])
    expect(changes.every((r) => r.actor === 'directory')).toBe(true)
    // no birthdate, nationality or email in any audit record or log line (IDENT-DIR-007)
    const everything = JSON.stringify(await store.adminAudit.list(100)) + lines.join('')
    for (const value of ['19910521', '1991-05-21', 'ESP', '19850203', 'northwind.example'])
      expect(everything).not.toContain(value)
  })

  it('sees a swap through the watch alone, with no poll', async () => {
    const mount = secretMount([ANA])
    const { directory } = open(mount.file)
    await directory.settle()
    directory.watch(0)
    mount.swap([ANA, JONAS])
    await vi.waitFor(() => expect(directory.view('p-0043')).toBeDefined(), { timeout: 5000, interval: 20 })
  })

  it('keeps the directory in force when the new file does not validate, and logs why without a value (IDENT-DIR-001)', async () => {
    const mount = secretMount([ANA, JONAS])
    const { logger, lines } = capturingLogger()
    const { directory, store } = open(mount.file, new MemoryStore(), logger)
    await directory.settle()
    const audited = (await store.adminAudit.list(100)).length
    mount.swap([{ ...ANA, roles: ['janitor'], birthDate: '19910521' }, JONAS])
    expect(await directory.check()).toBeUndefined()
    expect(directory.view('p-0042')?.roles).toEqual(['dispatcher'])
    expect((await store.adminAudit.list(100)).length).toBe(audited)
    const said = lines.join('')
    expect(said).toContain('janitor')
    expect(said).toContain('the one in force stays')
    expect(said).not.toContain('19910521')
    // the same content is not read again; a corrected one is
    expect(await directory.check()).toBeUndefined()
    mount.swap([{ ...ANA, roles: ['manager'] }, JONAS])
    expect((await directory.check())?.changes.map((c) => c.fields)).toEqual([['roles']])
    // nothing changed, nothing recorded
    expect(await directory.check()).toBeUndefined()
  })

  it('answers the member picker by first or last name, without regard to case or marks, at most 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `p-${100 + i}`,
      firstName: `Rio${i}`,
      lastName: 'Smith',
      email: `r${i}@northwind.example`,
    }))
    const mount = secretMount([ANA, JONAS, ...many])
    const { directory } = open(mount.file)
    expect(directory.search('rÍo').length).toBe(20)
    expect(directory.search('ríos').map((v) => v.id)).toEqual(['p-0042'])
    expect(directory.search('web')).toEqual([
      { id: 'p-0043', name: 'Jonas Weber', department: 'Depot Rotterdam', groups: [], roles: ['manager'] },
    ])
    // two characters at least
    expect(directory.search('r')).toEqual([])
    expect(directory.byEmail('ANA.RIOS@northwind.example')?.id).toBe('p-0042')
  })
})
