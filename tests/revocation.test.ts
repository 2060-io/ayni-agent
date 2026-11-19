/**
 * Revocation of the credentials this agent issues (decision 61; ayni-spec D91, IDENT-ROLE-013, IDENT-DIR-006,
 * INTX-FLOW-007). The DIDComm agent takes the revocation registry and the index of a credential from the caller at the
 * offer, and revokes by both: the agent allocates them, never twice, keeps them in the issuance record, and creates the
 * definition of a schema with revocation when a credential of it must be revocable (a badge from the directory).
 */
import { describe, expect, it } from 'vitest'
import { CredentialDefinitions } from '../src/channels/didcomm/credentialDefinitions.js'
import { CredentialOffers } from '../src/channels/didcomm/credentialOffers.js'
import { CredentialRevocations } from '../src/channels/didcomm/revocations.js'
import type { AgentPack, IssuanceProfile } from '../src/config/packTypes.js'
import { EvidenceService } from '../src/core/evidence.js'
import {
  type IssuanceDeps,
  IssuanceService,
  issuanceEntry,
  type RevocationSlot,
  subjectIdKey,
} from '../src/core/issuance.js'
import type { Principal, Session } from '../src/core/types.js'
import { createEntryCrypto } from '../src/memory/crypto.js'
import { MemoryStore } from '../src/store/memory.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
const crypto = createEntryCrypto(Buffer.alloc(32, 3))
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'

/** A DIDComm agent that holds definitions and registries, and keeps what it was asked. */
function didcommAgent(
  held: { id: string; relatedJsonSchemaCredentialId?: string; supportRevocation?: boolean }[] = []
) {
  const calls: { path: string; body?: unknown }[] = []
  let registries = 0
  const client = {
    listCredentialDefinitions: async () => {
      calls.push({ path: 'list-definitions' })
      return { items: held, nextCursor: null }
    },
    createCredentialDefinition: async (body: {
      relatedJsonSchemaCredentialId: string
      supportRevocation?: boolean
    }) => {
      calls.push({ path: 'create-definition', body })
      const created = { id: `def-${held.length + 1}`, ...body, supportRevocation: body.supportRevocation === true }
      held.push(created)
      return created
    },
    createRevocationRegistry: async (body: { credentialDefinitionId: string; maximumCredentialNumber?: number }) => {
      calls.push({ path: 'create-registry', body })
      registries += 1
      return { revocationRegistryDefinitionId: `${body.credentialDefinitionId}/revreg-${registries}` }
    },
    revokeCredential: async (body: { revocationRegistryDefinitionId: string; revocationRegistryIndex: number }) => {
      calls.push({ path: 'revoke', body })
      return { ...body, revokedAt: '2026-11-19T05:00:00.000Z' }
    },
    sendRevocationNotification: async (body: unknown) => {
      calls.push({ path: 'notify', body })
      return { sent: true as const }
    },
  }
  return { client, calls, held }
}

describe('the registry and the index of a credential (decision 61)', () => {
  it('gives each index once, from 0, and opens a new registry when one is full', async () => {
    const { client, calls } = didcommAgent()
    const store = new MemoryStore()
    const revocations = new CredentialRevocations(client, store.kv, async () => true, silent as never, 2)
    const slots: RevocationSlot[] = []
    for (let i = 0; i < 3; i++) slots.push((await revocations.allocate('def-1')) as RevocationSlot)
    expect(slots).toEqual([
      { registryDefinitionId: 'def-1/revreg-1', index: 0 },
      { registryDefinitionId: 'def-1/revreg-1', index: 1 },
      { registryDefinitionId: 'def-1/revreg-2', index: 0 },
    ])
    expect(calls.filter((c) => c.path === 'create-registry').map((c) => c.body)).toEqual([
      { credentialDefinitionId: 'def-1', maximumCredentialNumber: 2 },
      { credentialDefinitionId: 'def-1', maximumCredentialNumber: 2 },
    ])
    // the next process continues where this one stopped: what was given is kept before the offer leaves
    const restarted = new CredentialRevocations(client, store.kv, async () => true, silent as never, 2)
    expect(await restarted.allocate('def-1')).toEqual({ registryDefinitionId: 'def-1/revreg-2', index: 1 })
  })

  it('never gives one index twice to offers made at once', async () => {
    const { client } = didcommAgent()
    const revocations = new CredentialRevocations(client, new MemoryStore().kv, async () => true, silent as never, 5)
    const slots = await Promise.all(Array.from({ length: 8 }, () => revocations.allocate('def-1')))
    const keys = slots.map((s) => `${s?.registryDefinitionId}#${s?.index}`)
    expect(new Set(keys).size).toBe(8)
  })

  it('gives none under a definition without revocation, and fails when no registry can be had', async () => {
    const { client } = didcommAgent()
    const store = new MemoryStore()
    expect(
      await new CredentialRevocations(client, store.kv, async () => false, silent as never).allocate('def-1')
    ).toBe(undefined)
    client.createRevocationRegistry = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    await expect(
      new CredentialRevocations(client, store.kv, async () => true, silent as never).allocate('def-2')
    ).rejects.toThrow(/ECONNREFUSED/)
    // nothing was kept of the registry that does not exist
    expect(await store.kv.get('revocation:registries:def-2')).toBeUndefined()
  })

  it('revokes by registry and index, and tells the holder with <registry>::<index> (FLOW-REVOKE-001)', async () => {
    const { client, calls } = didcommAgent()
    const revocations = new CredentialRevocations(client, new MemoryStore().kv, async () => true, silent as never)
    const slot = { registryDefinitionId: 'def-1/revreg-1', index: 7 }
    expect(await revocations.revoke(slot)).toBe('2026-11-19T05:00:00.000Z')
    await revocations.notify('conn-1', slot, 'You left the list.')
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['revoke', { revocationRegistryDefinitionId: 'def-1/revreg-1', revocationRegistryIndex: 7 }],
      [
        'notify',
        {
          connectionId: 'conn-1',
          revocationId: 'def-1/revreg-1::7',
          revocationFormat: 'anoncreds',
          comment: 'You left the list.',
        },
      ],
    ])
  })
})

describe('a revocable definition for a credential that must be revocable (decision 61, INTX-ISSUE-017)', () => {
  it('creates the definition with revocation, and tells which definitions support it', async () => {
    const { client, calls } = didcommAgent([
      { id: 'other', relatedJsonSchemaCredentialId: 'x', supportRevocation: false },
    ])
    const definitions = new CredentialDefinitions(client, silent as never)
    expect(await definitions.forSchema(BADGE, { revocable: true })).toBe('def-2')
    expect(calls.find((c) => c.path === 'create-definition')?.body).toEqual({
      relatedJsonSchemaCredentialId: BADGE,
      supportRevocation: true,
    })
    expect(await definitions.supportsRevocation('def-2')).toBe(true)
    expect(await definitions.supportsRevocation('other')).toBe(false)
    expect(await definitions.supportsRevocation('unknown')).toBe(false)
    // a definition that is not to be revocable is created without it, as before
    const plain = didcommAgent()
    await new CredentialDefinitions(plain.client, silent as never).forSchema(BADGE)
    expect(plain.calls.find((c) => c.path === 'create-definition')?.body).toEqual({
      relatedJsonSchemaCredentialId: BADGE,
    })
  })

  it('issues nothing that must be revocable under a definition created without revocation, and creates no second one', async () => {
    const errors: string[] = []
    const logger = { ...silent, error: (_o: unknown, message: string) => void errors.push(message) }
    const { client, calls } = didcommAgent([
      { id: 'old', relatedJsonSchemaCredentialId: BADGE, supportRevocation: false },
    ])
    const definitions = new CredentialDefinitions(client, logger as never)
    expect(await definitions.forSchema(BADGE, { revocable: true })).toBeUndefined()
    expect(errors[0]).toMatch(/created without revocation.*Delete the definition/)
    expect(calls.some((c) => c.path === 'create-definition')).toBe(false)
    // what need not be revocable is issued under it
    expect(await definitions.forSchema(BADGE)).toBe('old')
  })
})

describe('the offer names the registry and the index (VSA-ADM-DC-CE-OFFER)', () => {
  it('sends them with the claims', async () => {
    const sent: Record<string, unknown>[] = []
    const client = {
      offerCredential: async (body: Record<string, unknown>) => {
        sent.push(body)
        return { credentialExchangeId: 'cex-1' }
      },
    }
    const offers = new CredentialOffers(client as never, undefined, async () => false, silent as never, 50)
    await offers.offer({
      connectionId: 'conn-1',
      credentialDefinitionId: 'def-1',
      claims: { name: 'Ana Ríos' },
      title: 'Badge',
      revocation: { registryDefinitionId: 'def-1/revreg-1', index: 3 },
    })
    expect(sent[0]).toMatchObject({ revocationRegistryDefinitionId: 'def-1/revreg-1', revocationRegistryIndex: 3 })
  })
})

describe('the record of a badge from the directory (IDENT-DIR-006, D91)', () => {
  /** The profile of phase 2b: a claim from the directory, found by the hook that phase 2b gives (the matcher). */
  const badge = {
    credential: { jsonSchemaCredentialId: BADGE },
    label: 'Badge',
    claims: {
      badgeNumber: { from: 'computed', fn: 'constant', value: 'BN-42' },
      name: { from: 'record', record: 'directory', field: 'name' },
    },
  } as unknown as IssuanceProfile
  const person = {
    id: 'prn_ana',
    connectionType: 'verifiable-user-agent',
    capabilityChannelId: 'conn-ana',
    roles: [],
  } as unknown as Principal
  const session = { id: 'ses_1' } as Session

  function setup(deps: Partial<IssuanceDeps> = {}) {
    const pack = { identity: { roleRules: [] }, issuance: { badge } } as unknown as AgentPack
    const store = new MemoryStore()
    const evidence = new EvidenceService(store, pack, crypto, silent as never)
    const offers: Parameters<IssuanceDeps['offer']>[0][] = []
    const asked: { schema: string; revocable: boolean }[] = []
    const issued: unknown[] = []
    const service = new IssuanceService(
      pack,
      evidence,
      {
        offer: async (input) => {
          offers.push(input)
          return { outcome: 'issued', exchangeId: `cex-${offers.length}` }
        },
        challenge: async () => ({ passed: true }),
        definitionFor: async (schema, options) => {
          asked.push({ schema, ...options })
          return 'def-badge'
        },
        allocateRevocation: async () => ({ registryDefinitionId: 'def-badge/revreg-1', index: 4 }),
        record: async () => ({ status: 'available', value: 'Ana Ríos', directoryEntryId: 'p-0042' }),
        holderOf: async (_name, _profile, claims) => `org:NL:1|${BADGE}|${claims.badgeNumber}`,
        issued: async (principal, record, holder) => void issued.push({ principal: principal.id, record, holder }),
        ...deps,
      },
      silent as never,
      subjectIdKey(Buffer.alloc(32, 9))
    )
    return { store, evidence, service, offers, asked, issued }
  }

  it('asks a revocable definition, offers with the registry and the index, and keeps the entry, the holder and both', async () => {
    const { service, offers, asked, evidence, store, issued } = setup()
    expect((await service.issue(person, session, 'badge', 'model')).outcome).toBe('issued')
    expect(asked).toEqual([{ schema: BADGE, revocable: true }])
    expect(offers[0]).toMatchObject({
      claims: { badgeNumber: 'BN-42', name: 'Ana Ríos' },
      revocation: { registryDefinitionId: 'def-badge/revreg-1', index: 4 },
    })
    const [record] = await evidence.issuedFromDirectory('p-0042')
    expect(record).toMatchObject({
      kind: 'issuance',
      entry: issuanceEntry('badge'),
      directoryEntryId: 'p-0042',
      revocation: { registryDefinitionId: 'def-badge/revreg-1', index: 4 },
      connectionRef: 'conn-ana',
    })
    // the actor is kept only as a keyed index, by which the presented badge finds the record (IDENT-ROLE-012)
    expect(record?.holderIndex).toBe(evidence.holderIndex(`org:NL:1|${BADGE}|BN-42`))
    expect(JSON.stringify(await store.evidence.list('prn_ana'))).not.toContain('BN-42')
    expect((await evidence.issuedFromDirectoryTo(`org:NL:1|${BADGE}|BN-42`, 'def-badge'))?.directoryEntryId).toBe(
      'p-0042'
    )
    expect(await evidence.issuedFromDirectoryTo(`org:NL:1|${BADGE}|BN-42`, 'another-definition')).toBeUndefined()
    expect(issued).toHaveLength(1)
    // held, until it is revoked: then it may be issued again (D91)
    expect((await service.requirements(person))[0].state).toBe('held')
    await evidence.setRevocation(record?.id as string, { ...(record?.revocation as RevocationSlot), revokedAt: 'now' })
    expect((await service.requirements(person))[0].state).toBe('ready')
    expect(await evidence.issuedFromDirectoryTo(`org:NL:1|${BADGE}|BN-42`)).toBeUndefined()
  })

  it('issues nothing from the directory under a definition that cannot revoke, or with no registry to be had', async () => {
    const noRevocation = setup({ allocateRevocation: async () => undefined })
    expect(await noRevocation.service.issue(person, session, 'badge', 'model')).toEqual({ outcome: 'not-ready' })
    expect(noRevocation.offers).toEqual([])
    const noRegistry = setup({
      allocateRevocation: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    expect(await noRegistry.service.issue(person, session, 'badge', 'model')).toEqual({ outcome: 'not-ready' })
    expect(noRegistry.offers).toEqual([])
    // a badge whose holder cannot be told (the home organization not established yet) would never find its entry again
    const noHolder = setup({ holderOf: async () => undefined })
    expect(await noHolder.service.issue(person, session, 'badge', 'model')).toEqual({ outcome: 'not-ready' })
    expect(noHolder.offers).toEqual([])
  })

  it('reads a claim of the directory as unavailable while nothing finds the entry, and missing as the matcher says', async () => {
    const without = setup({ record: undefined })
    const [requirements] = await without.service.requirements(person)
    expect(requirements.claims.find((c) => c.name === 'name')).toMatchObject({ status: 'unavailable' })
    const missing = setup({ record: async () => ({ status: 'missing' }) })
    expect((await missing.service.issue(person, session, 'badge', 'model')).outcome).toBe('incomplete')
    expect(missing.offers).toEqual([])
  })
})
