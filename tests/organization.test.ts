/**
 * Organizations, the principal key and the issuer of an identity credential (D59, D64, D65;
 * IDENT-RES-001/002/008..012, IDENT-ROLE-008..011).
 */
import { describe, expect, it } from 'vitest'
import { actorIdentityOf, IdentityFlow, type ResolveResult, TrustResolver } from '../src/channels/didcomm/identity.js'
import type { PresentationRecord } from '../src/channels/didcomm/vsAgentClient.js'
import { crossFieldErrors, loadPack, validatePackDocument } from '../src/config/pack.js'
import type { AgentPack } from '../src/config/packTypes.js'
import { HomeOrganization, matchOrganization, organizationFrom, organizationKey } from '../src/core/organization.js'
import { assignRoles, PrincipalService, recognize, type VerifiedFacts } from '../src/core/principals.js'
import { MemoryStore } from '../src/store/memory.js'
import { badgeAuthentication } from './helpers.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
const BADGE = 'https://ecs.example/vt/schemas-badge-jsc.json'

const org = (countryCode: string, registryId: string, name = 'Org') => ({
  ecsSchema: 'OrganizationCredential',
  credentialSubject: { name, countryCode, registryId },
})
const trusted = (did: string, ...ecsCredentials: ResolveResult['ecsCredentials'] & object[]): ResolveResult => ({
  did,
  trusted: true,
  ecsCredentials,
})

function resolverOf(known: Record<string, ResolveResult>): TrustResolver {
  const resolver = new TrustResolver(undefined, silent as never)
  resolver.resolve = async (did: string) => known[did] ?? { did, trusted: false }
  return resolver
}

function packWith(identity: Partial<AgentPack['identity']> = {}): AgentPack {
  return {
    metadata: { displayName: 'Test agent' },
    identity: {
      homeBackingIdentity: 'did:webvh:x:agent',
      roleRules: [],
      userAgentGate: 'optional',
      authentication: badgeAuthentication({
        credential: { jsonSchemaCredentialId: BADGE },
        subjectKey: ['badgeNumber'],
      }),
      ...identity,
    },
  } as unknown as AgentPack
}

/** A DIDComm agent whose peer answers the identity request with the given record. */
function clientAnswering(ref: { flow?: IdentityFlow }, answer: Partial<PresentationRecord>, calls: unknown[][] = []) {
  let n = 0
  return {
    requestPresentation: async (...args: unknown[]) => {
      calls.push(args)
      const proofExchangeId = `pex-${++n}`
      setTimeout(
        () => ref.flow?.onPresentation({ proofExchangeId, state: 'done', claims: [], verified: true, ...answer }),
        0
      )
      return { proofExchangeId }
    },
  }
}

const presented = (issuerDid: string, claims: Record<string, string>, unrevealed: string[] = []) => ({
  credentials: [
    {
      credentialDefinitionId: `${issuerDid}/resources/def`,
      issuerDid,
      claims: Object.entries(claims).map(([name, value]) => ({ name, value })),
      unrevealed,
    },
  ],
})

async function identify(
  resolver: TrustResolver,
  answer: Partial<PresentationRecord>,
  pack = packWith(),
  calls: unknown[][] = []
) {
  const ref: { flow?: IdentityFlow } = {}
  ref.flow = new IdentityFlow(pack, clientAnswering(ref, answer, calls) as never, resolver, false, silent as never)
  return ref.flow.establish('conn-1', 'did:peer:4zWallet')
}

describe('the organization key (D64, IDENT-RES-009)', () => {
  it('is the country of registration and the identifier in its register, computed in one place', () => {
    expect(organizationKey({ countryCode: 'ee', registryId: ' 16853041 ' })).toBe('org:EE:16853041')
    expect(organizationKey({ countryCode: 'EE' })).toBeUndefined()
    expect(organizationKey({ registryId: '1' })).toBeUndefined()
    expect(organizationFrom({ name: 'A', countryCode: 'CO', registryId: '900662462', lei: 'X' })).toEqual({
      key: 'org:CO:900662462',
      name: 'A',
      attributes: { countryCode: 'CO', registryId: '900662462', lei: 'X' },
    })
  })

  it('is the same for two DIDs of one organization, and absent for a Persona', () => {
    const resolver = resolverOf({})
    const a = resolver.organizationOf(trusted('did:a', org('EE', '1')))
    const b = resolver.organizationOf(trusted('did:b', org('EE', '1')))
    expect(a?.key).toBe(b?.key)
    expect(
      resolver.organizationOf(
        trusted('did:p', {
          ecsSchema: 'PersonaCredential',
          credentialSubject: { name: 'P', controllerCountryCode: 'EE' },
        })
      )
    ).toBeNull()
    expect(resolver.organizationOf({ did: 'did:u', trusted: false, ecsCredentials: [org('EE', '1')] })).toBeNull()
  })
})

describe('organization patterns and home (IDENT-ROLE-008..011)', () => {
  const pack = packWith({
    organizations: [
      { match: { countryCode: 'CO', registryId: '900662462' }, relation: 'partner', roles: ['partner'] },
      { match: { countryCode: ['FR', 'BE'] }, relation: 'unrecognized', roles: ['visitor'] },
      { match: { countryCode: 'CO' }, relation: 'unrecognized' },
    ],
    roleRules: [
      { when: { relation: 'home' }, roles: ['employee'] },
      { when: { relation: 'partner', claims: { department: 'Finance' } }, roles: ['finance'] },
    ],
    perActorOverrides: [{ actor: 'did:example:auditor', roles: ['auditor'] }],
  } as never)
  const of = (countryCode: string, registryId: string) => organizationFrom({ countryCode, registryId })

  it('recognizes one organization by its registry identifier and any organization of a country, first match wins', () => {
    expect(recognize(pack, of('CO', '900662462'), 'org:EE:1')).toEqual({ relation: 'partner', roles: ['partner'] })
    expect(recognize(pack, of('CO', '123'), 'org:EE:1')).toEqual({ relation: 'unrecognized', roles: [] })
    expect(recognize(pack, of('FR', '552100554'), 'org:EE:1')).toEqual({ relation: 'unrecognized', roles: ['visitor'] })
    expect(recognize(pack, of('US', '9'), 'org:EE:1')).toEqual({ relation: 'unrecognized', roles: [] })
    expect(recognize(pack, null, 'org:EE:1').relation).toBe('unrecognized')
    expect(matchOrganization(pack.identity.organizations ?? [], {})).toBeUndefined()
  })

  it('gives home to the organization that carries the key of the agent, before any pattern, and to no other', () => {
    expect(recognize(pack, of('CO', '900662462'), 'org:CO:900662462').relation).toBe('home')
    expect(recognize(pack, of('EE', '1'), 'org:EE:1').relation).toBe('home')
    // an agent that could not establish its own key: nobody is home
    expect(recognize(pack, of('EE', '1'), undefined).relation).toBe('unrecognized')
  })

  it('adds the roles of the pattern to those of the rule; overrides come first', () => {
    const facts = (over: Partial<VerifiedFacts>): VerifiedFacts => ({
      connectionType: 'verifiable-user-agent',
      actorIdentity: 'a',
      backingIdentity: null,
      claims: {},
      userAgentVerified: true,
      identityCredentialRef: 'badge:1',
      ...over,
    })
    const partner = recognize(pack, of('CO', '900662462'), 'org:EE:1')
    expect(assignRoles(pack, facts({ claims: { department: 'Finance' } }), partner)).toEqual(['partner', 'finance'])
    expect(assignRoles(pack, facts({}), partner)).toEqual(['partner'])
    expect(assignRoles(pack, facts({}), recognize(pack, of('EE', '1'), 'org:EE:1'))).toEqual(['employee'])
    expect(assignRoles(pack, facts({ actorIdentity: 'did:example:auditor' }), partner)).toEqual(['auditor'])
  })

  it('refuses a pack whose pattern sets home, a combination that names an unknown method, or a hidden subject key', () => {
    const dev = loadPack('agent-packs/dev', { ...process.env, HOME_BACKING_IDENTITY: 'did:webvh:x:home' })
    const base = structuredClone(dev.pack)
    base.identity.authentication = badgeAuthentication({
      credential: { jsonSchemaCredentialId: BADGE },
      subjectKey: ['badgeNumber'],
    })
    expect(crossFieldErrors(base)).toEqual([])
    const home = structuredClone(base)
    home.identity.organizations = [{ match: { countryCode: 'EE' }, relation: 'home' as never }]
    expect(crossFieldErrors(home).join('\n')).toMatch(/organizations\[0\].*home/)
    const two = structuredClone(base)
    two.identity.authentication?.combinations.push(['card'])
    expect(crossFieldErrors(two).join('\n')).toMatch(
      /combinations\[1\] \[card\] names \[card\], which no method enables/
    )
    const hidden = structuredClone(base)
    hidden.identity.authentication = badgeAuthentication({
      credential: { jsonSchemaCredentialId: BADGE },
      subjectKey: ['badgeNumber'],
      attributes: ['name'],
    })
    expect(crossFieldErrors(hidden).join('\n')).toMatch(/subjectKey \[badgeNumber\]/)
    const ghost = structuredClone(base)
    ghost.identity.organizations = [{ match: { countryCode: 'EE' }, relation: 'partner', roles: ['ghost'] }]
    expect(crossFieldErrors(ghost).join('\n')).toMatch(/rule 2.*ghost.*organizations\[0\]/)
    // the schema refuses them as well, with the field named
    const doc = structuredClone(dev.pack) as unknown as { identity: Record<string, unknown> }
    doc.identity.organizations = [{ match: { countryCode: 'EE' }, relation: 'home' }]
    expect(() => validatePackDocument(doc, {})).toThrow(/organizations/)
  })

  it('looks its own organization up again after a failure, and keeps a key it once established', async () => {
    let answer: 'none' | 'key' | 'fail' = 'none'
    const home = new HomeOrganization(
      async () => {
        if (answer === 'fail') throw new Error('indexer down')
        return answer === 'key' ? organizationFrom({ countryCode: 'EE', registryId: '1' }) : null
      },
      silent as never,
      0,
      0
    )
    expect(await home.key()).toBeUndefined()
    answer = 'key'
    expect(await home.key()).toBe('org:EE:1')
    answer = 'fail'
    expect(await home.key()).toBe('org:EE:1')
  })
})

describe('the identity credential of a person (IDENT-RES-002/008/010/011/012)', () => {
  const resolver = resolverOf({
    'did:webvh:a1': trusted('did:webvh:a1', org('EE', '1', 'Org A')),
    'did:webvh:a2': trusted('did:webvh:a2', org('EE', '1', 'Org A')),
    'did:webvh:b': trusted('did:webvh:b', org('CO', '2', 'Org B')),
    'did:webvh:persona': trusted('did:webvh:persona', {
      ecsSchema: 'PersonaCredential',
      credentialSubject: { name: 'P', controllerCountryCode: 'EE' },
    }),
  })

  it('asks for one credential, by the ecosystem schema of the pack', async () => {
    const calls: unknown[][] = []
    await identify(resolver, presented('did:webvh:a1', { badgeNumber: '42', name: 'Alice' }), packWith(), calls)
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual([{ jsonSchemaCredentialId: BADGE }])
  })

  it('takes the issuer from what the DIDComm agent verified, never from an attribute that names one', async () => {
    const facts = await identify(
      resolver,
      presented('did:webvh:b', {
        badgeNumber: '42',
        name: 'Mallory',
        issuerDid: 'did:webvh:a1',
        issuer: 'did:webvh:a1',
      })
    )
    expect(facts?.organization?.key).toBe('org:CO:2')
    expect(facts?.backingIdentity).toEqual({ kind: 'org', id: 'org:CO:2', name: 'Org B' })
    expect(facts?.claims.issuerDid).toBe('did:webvh:b')
    expect(facts?.claims.issuer).toBeUndefined()
    expect(facts?.actorIdentity).toBe(actorIdentityOf('org:CO:2', BADGE, ['42']))
    // what is handed over as evidence: the verified issuer, and the values without the attribute that named another
    expect(facts?.evidence).toMatchObject({
      kind: 'presentation',
      entry: 'authentication',
      schema: BADGE,
      issuerDid: 'did:webvh:b',
      issuerOrganization: { key: 'org:CO:2', name: 'Org B' },
      values: { badgeNumber: '42', name: 'Mallory' },
    })
    expect(facts?.evidence?.values.issuerDid).toBeUndefined()
  })

  it('keys a person on the organization of the issuer, the schema and the badge number', async () => {
    const viaFirstDid = await identify(resolver, presented('did:webvh:a1', { badgeNumber: '42', name: 'Alice' }))
    const viaSecondDid = await identify(resolver, presented('did:webvh:a2', { badgeNumber: '42', name: 'Alice' }))
    const otherOrganization = await identify(resolver, presented('did:webvh:b', { badgeNumber: '42', name: 'Bob' }))
    expect(viaFirstDid?.actorIdentity).toBe('org:EE:1|https://ecs.example/vt/schemas-badge-jsc.json|42')
    // the same organization under another DID: the same person
    expect(viaSecondDid?.actorIdentity).toBe(viaFirstDid?.actorIdentity)
    // the same number from another organization: another person
    expect(otherOrganization?.actorIdentity).not.toBe(viaFirstDid?.actorIdentity)
    expect(viaFirstDid?.claims.userName).toBe('Alice')
  })

  it('identifies nobody without a reported issuer, a revealed subject key or an organization behind the issuer', async () => {
    const claims = { badgeNumber: '42', name: 'Alice' }
    // a DIDComm agent that reports no issuer
    expect(await identify(resolver, { claims: [{ name: 'badgeNumber', value: '42' }] })).toBeUndefined()
    // the subject key left unrevealed, or absent
    expect(await identify(resolver, presented('did:webvh:a1', { name: 'Alice' }, ['badgeNumber']))).toBeUndefined()
    expect(await identify(resolver, presented('did:webvh:a1', { name: 'Alice' }))).toBeUndefined()
    // an issuer that is not trusted, and one backed by a Persona
    expect(await identify(resolver, presented('did:webvh:unknown', claims))).toBeUndefined()
    expect(await identify(resolver, presented('did:webvh:persona', claims))).toBeUndefined()
    // a presentation that did not verify
    expect(await identify(resolver, { ...presented('did:webvh:a1', claims), verified: false })).toBeUndefined()
  })

  it('refuses, when the credential is asked on connect, a wallet whose credential identifies nobody', async () => {
    expect(
      await identify(resolver, presented('did:webvh:persona', { badgeNumber: '42', name: 'Alice' }))
    ).toBeUndefined()
  })
})

describe('a service and its organization (IDENT-RES-001/011)', () => {
  const service = { ecsSchema: 'ServiceCredential', credentialSubject: { name: 'Billing' } }
  const resolver = resolverOf({
    'did:webvh:svc1': trusted('did:webvh:svc1', service, org('EE', '1', 'Org A')),
    'did:webvh:svc2': trusted('did:webvh:svc2', service, org('EE', '1', 'Org A')),
    'did:webvh:persona-svc': trusted('did:webvh:persona-svc', service, {
      ecsSchema: 'PersonaCredential',
      credentialSubject: { name: 'P', controllerCountryCode: 'EE' },
    }),
  })
  const flow = new IdentityFlow(packWith(), {} as never, resolver, false, silent as never)

  it('is its own DID behind its organization: two services of one organization share a backing identity', async () => {
    const one = await flow.establish('c1', 'did:webvh:svc1')
    const two = await flow.establish('c2', 'did:webvh:svc2')
    expect(one?.actorIdentity).toBe('did:webvh:svc1')
    expect(two?.actorIdentity).toBe('did:webvh:svc2')
    expect(one?.backingIdentity?.id).toBe('org:EE:1')
    expect(two?.backingIdentity?.id).toBe('org:EE:1')
  })

  it('has no backing identity when a Persona backs it, and is refused when it is not trusted', async () => {
    expect((await flow.establish('c3', 'did:webvh:persona-svc'))?.backingIdentity).toBeNull()
    expect(await flow.establish('c4', 'did:webvh:stranger')).toBeUndefined()
  })
})

describe('Principals under the organization key (IDENT-PRIN, D59)', () => {
  const pack = packWith({
    roles: { employee: {}, partner: {} },
    organizations: [{ match: { countryCode: 'CO', registryId: '2' }, relation: 'partner', roles: ['partner'] }],
    roleRules: [{ when: { relation: 'home' }, roles: ['employee'] }],
  } as never)
  const liveness = { verify: async () => ({ ok: true, checkedAt: '' }) }
  const person = (over: Partial<VerifiedFacts>): VerifiedFacts => ({
    connectionType: 'verifiable-user-agent',
    actorIdentity: actorIdentityOf('org:EE:1', BADGE, ['42']),
    backingIdentity: { kind: 'org', id: 'org:EE:1', name: 'Org A' },
    organization: organizationFrom({ countryCode: 'EE', registryId: '1', name: 'Org A' }),
    claims: { userName: 'Alice' },
    userAgentVerified: true,
    identityCredentialRef: 'badge:1',
    ...over,
  })

  it('is home for the people of the agent’s own organization, a partner by a pattern, nobody without the key', async () => {
    const store = new MemoryStore()
    const home = { key: async () => 'org:EE:1' }
    const service = new PrincipalService(store, pack, liveness, silent as never, undefined, home)
    const alice = await service.resolve(person({}))
    expect(alice.backingRelation).toBe('home')
    expect(alice.roles).toEqual(['employee'])
    expect(alice.backingIdentity?.id).toBe('org:EE:1')
    const bob = await service.resolve(
      person({
        actorIdentity: actorIdentityOf('org:CO:2', BADGE, ['42']),
        backingIdentity: { kind: 'org', id: 'org:CO:2' },
        organization: organizationFrom({ countryCode: 'CO', registryId: '2' }),
      })
    )
    expect(bob.backingRelation).toBe('partner')
    expect(bob.roles).toEqual(['partner'])
    expect(bob.id).not.toBe(alice.id)
    // an agent that has not established its own organization: nobody is home
    const unknown = new PrincipalService(new MemoryStore(), pack, liveness, silent as never)
    expect((await unknown.resolve(person({}))).backingRelation).toBe('unrecognized')
  })

  it('keeps a Principal keyed before the organization key, under its new key', async () => {
    const store = new MemoryStore()
    const service = new PrincipalService(store, pack, liveness, silent as never, undefined, {
      key: async () => 'org:EE:1',
    })
    const before = await service.resolve(person({ actorIdentity: 'subject-42' }))
    const after = await service.resolve(person({ legacyActorIdentity: 'subject-42' }))
    expect(after.id).toBe(before.id)
    expect(after.actorIdentity).toBe(actorIdentityOf('org:EE:1', BADGE, ['42']))
    expect(await store.principals.findByActor('subject-42')).toBeUndefined()
    // met again, it is found by its new key alone
    expect((await service.resolve(person({}))).id).toBe(before.id)
  })
})
