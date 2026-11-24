/**
 * What the methods of the authentication need of the deployment (IDENT-AUTH-001, PLAT-MAIL-001, IDENT-DIR-010): an
 * `email` method with no SMTP server stops the start, naming the method; the photo of a directory entry is a file beside
 * the directory, read when a face match needs it and at no other time.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildAgent } from '../src/app.js'
import { DirectoryError, parseDirectory, UserDirectory } from '../src/core/directory.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'
import { createLogger } from '../src/util/logger.js'
import { testEnv } from './helpers.js'

const logger = createLogger('silent')
const people = [
  { id: 'p-1', firstName: 'Ana', lastName: 'Ríos', email: 'ana.rios@northwind.example', photo: 'p-1.jpg' },
]

/** The dev pack in a folder of its own, with a directory and an authentication by email. */
function packWithEmail(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ayni-authentication-'))
  cpSync('agent-packs/dev', dir, { recursive: true })
  writeFileSync(join(dir, 'directory.yaml'), stringifyYaml({ people }))
  const file = join(dir, 'agent-pack.yaml')
  const doc = parseYaml(readFileSync(file, 'utf8')) as { identity: Record<string, unknown> }
  doc.identity.directory = { file: 'directory.yaml' }
  doc.identity.authentication = { request: 'on-demand', methods: { mail: { type: 'email' } }, combinations: [['mail']] }
  writeFileSync(file, stringifyYaml(doc))
  return dir
}

describe('what a method needs of the deployment (IDENT-AUTH-001, PLAT-MAIL-001)', () => {
  it('an email method with no SMTP server stops the start, naming the method', async () => {
    await expect(buildAgent(testEnv({ agentPackPath: packWithEmail() }), logger)).rejects.toThrow(
      /identity\.authentication\.methods \[mail\] send an email code, and MAIL_HOST and MAIL_FROM_ADDRESS are not both set/
    )
  })

  it('starts with one', async () => {
    const sent: unknown[] = []
    const running = await buildAgent(testEnv({ agentPackPath: packWithEmail() }), logger, {
      mailer: { send: async (m: unknown) => void sent.push(m) } as never,
      drainMs: 200,
    })
    expect(running.agent.pack.identity.authentication?.combinations).toEqual([['mail']])
    await running.stop()
  })
})

describe('the photo of a directory entry (D131, IDENT-DIR-010)', () => {
  const rules = { roles: [], passport: false }

  it('names a JPEG or PNG file beside the directory, by its name alone', () => {
    expect(parseDirectory(stringifyYaml({ people }), rules)[0].photo).toBe('p-1.jpg')
    for (const photo of ['../p-1.jpg', '/etc/p-1.jpg', 'p-1.gif'])
      expect(() => parseDirectory(stringifyYaml({ people: [{ ...people[0], photo }] }), rules)).toThrow(DirectoryError)
  })

  it('is read when it is asked for, from the folder of the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ayni-photo-'))
    writeFileSync(join(dir, 'directory.yaml'), stringifyYaml({ people }))
    writeFileSync(join(dir, 'p-1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const store = new MemoryStore()
    const directory = new UserDirectory(
      join(dir, 'directory.yaml'),
      rules,
      store.kv,
      store.adminAudit,
      createEntryCrypto(Buffer.alloc(32, 1)),
      logger
    )
    directory.open()
    expect(directory.photoOf('p-1')).toEqual({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' })
    expect(directory.photoOf('p-2')).toBeUndefined()
    directory.stop()
  })
})
