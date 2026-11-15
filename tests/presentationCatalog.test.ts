/**
 * The presentation catalog (D69; INTX-PRES-001..008): the credentials the agent may ask for, on connect or
 * on demand, kept as evidence of the Principal of the connection.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { IdentityFlow, type ResolveResult, TrustResolver } from '../src/channels/didcomm/identity.js'
import { type IdentityRequestDeps, IdentityRequests } from '../src/channels/didcomm/identityRequests.js'
import type { PresentationRecord } from '../src/channels/didcomm/vsAgentClient.js'
import { crossFieldErrors, loadPack, validatePackDocument } from '../src/config/pack.js'
import type { AgentPack, PresentationEntry } from '../src/config/packTypes.js'
import type { EvidenceInput } from '../src/core/evidence.js'
import type { Principal } from '../src/core/types.js'
import { startTestAgent } from './helpers.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
const DIPLOMA = 'https://edu.example/vt/schemas-diploma-jsc.json'
const diploma = (over: Partial<PresentationEntry> = {}): PresentationEntry => ({
  credential: { jsonSchemaCredentialId: DIPLOMA },
  request: 'on-demand',
  purpose: 'Check your degree for the application',
  attributes: ['degree', 'institution', 'graduationDate'],
  store: { attributes: ['degree', 'institution'] },
  modelVisible: ['degree'],
  ...over,
})
const packWith = (presentations: Record<string, PresentationEntry>): AgentPack =>
  ({
    metadata: { displayName: 'Test agent' },
    identity: { homeBackingIdentity: 'did:webvh:x:agent', roleRules: [] },
    presentations,
  }) as unknown as AgentPack
const person = (over: Partial<Principal> = {}) =>
  ({
    id: 'prn_1',
    connectionType: 'verifiable-user-agent',
    actorIdentity: 'did:peer:4zVisitor',
    capabilityChannelId: 'conn-1',
    identityCredentialRef: null,
    userAgentVerified: false,
    roles: [],
    ...over,
  }) as Principal
const verified: EvidenceInput = {
  kind: 'presentation',
  entry: 'diploma',
  schema: DIPLOMA,
  issuerDid: 'did:webvh:uni',
  values: { degree: 'MSc', institution: 'A University' },
  requestRef: 'pex-1',
}

describe('asking for a catalog entry (INTX-PRES-003..007)', () => {
  const deps = (over: Partial<IdentityRequestDeps> = {}, recorded: EvidenceInput[] = []): IdentityRequestDeps => ({
    identify: async () => undefined,
    isFlowCapable: async () => true,
    onIdentityPresented: async () => ({ outcome: 'identified' }),
    present: async () => verified,
    record: async (_principal, input) => void recorded.push(input),
    ...over,
  })

  it('records what comes back as evidence of the Principal of the connection', async () => {
    const recorded: EvidenceInput[] = []
    const asked: unknown[][] = []
    const requests = new IdentityRequests(
      packWith({ diploma: diploma() }),
      deps(
        {
          present: async (...args) => {
            asked.push(args)
            return verified
          },
        },
        recorded
      ),
      silent as never
    )
    expect(await requests.present(person(), 'diploma', 'model')).toBe('verified')
    expect(asked[0].slice(0, 2)).toEqual(['conn-1', 'diploma'])
    expect(recorded).toEqual([{ ...verified, connectionRef: 'conn-1' }])
  })

  it('asks only what the pack lists, of a peer of the subject kind, and on demand only what is on demand', async () => {
    const pack = packWith({
      diploma: diploma(),
      licence: diploma({ request: 'on-connect' }),
      accreditation: diploma({ subjectKind: 'service' }),
    })
    const requests = new IdentityRequests(pack, deps(), silent as never)
    expect(await requests.present(person(), 'passport', 'model')).toBe('not-offered')
    expect(await requests.present(person(), 'licence', 'model')).toBe('not-offered')
    expect(await requests.present(person(), 'accreditation', 'model')).toBe('not-offered')
    const service = person({ connectionType: 'verifiable-service' })
    expect(await requests.present(service, 'accreditation', 'model')).toBe('verified')
    expect(await requests.present(service, 'diploma', 'model')).toBe('not-offered')
    expect(await requests.present(person({ capabilityChannelId: null }), 'diploma', 'model')).toBe('unavailable')
  })

  it('reports a request left unanswered as not presented, and does not insist', async () => {
    let calls = 0
    const requests = new IdentityRequests(
      packWith({ diploma: diploma(), licence: diploma() }),
      deps({
        present: async () => {
          calls++
          return undefined
        },
      }),
      silent as never
    )
    expect(await requests.present(person(), 'diploma', 'model')).toBe('not-presented')
    expect(await requests.present(person(), 'diploma', 'model')).toBe('wait')
    // another entry is another question
    expect(await requests.present(person(), 'licence', 'model')).toBe('not-presented')
    expect(calls).toBe(2)
  })

  it('asks the on-connect entries of the kind when the connection is established, and no other', async () => {
    const asked: string[] = []
    const requests = new IdentityRequests(
      packWith({
        diploma: diploma(),
        licence: diploma({ request: 'on-connect' }),
        accreditation: diploma({ request: 'on-connect', subjectKind: 'service' }),
      }),
      deps({
        present: async (_connection, name) => {
          asked.push(name)
          return { ...verified, entry: name }
        },
      }),
      silent as never
    )
    await requests.onConnect(person())
    expect(asked).toEqual(['licence'])
  })
})

describe('what a presentation is worth (INTX-PRES-005, IDENT-RES-008)', () => {
  const resolver = new TrustResolver(undefined, silent as never)
  resolver.resolve = async (did: string): Promise<ResolveResult> => ({
    did,
    trusted: true,
    ecsCredentials: [
      {
        ecsSchema: 'OrganizationCredential',
        credentialSubject: { name: 'A University', countryCode: 'FR', registryId: '7' },
      },
    ],
  })
  async function present(answer: Partial<PresentationRecord>, calls: unknown[][] = []) {
    const ref: { flow?: IdentityFlow } = {}
    const client = {
      requestPresentation: async (...args: unknown[]) => {
        calls.push(args)
        setTimeout(
          () =>
            ref.flow?.onPresentation({
              proofExchangeId: 'pex-9',
              state: 'done',
              claims: [],
              verified: true,
              ...answer,
            }),
          0
        )
        return { proofExchangeId: 'pex-9' }
      },
    }
    ref.flow = new IdentityFlow(packWith({}), client as never, resolver, false, silent as never)
    return ref.flow.present('conn-1', 'diploma', diploma(), false)
  }
  const credentials = [
    {
      credentialDefinitionId: 'did:webvh:uni/resources/def',
      issuerDid: 'did:webvh:uni',
      claims: [
        { name: 'degree', value: 'MSc' },
        { name: 'institution', value: 'A University' },
      ],
      unrevealed: ['graduationDate'],
    },
  ]

  it('asks one credential by its schema with the attributes of the entry, and reads the issuer from the proof', async () => {
    const calls: unknown[][] = []
    expect(await present({ credentials }, calls)).toEqual({
      kind: 'presentation',
      entry: 'diploma',
      schema: DIPLOMA,
      credentialDefinitionId: 'did:webvh:uni/resources/def',
      issuerDid: 'did:webvh:uni',
      issuerOrganization: { key: 'org:FR:7', name: 'A University' },
      values: { degree: 'MSc', institution: 'A University' },
      unrevealed: ['graduationDate'],
      requestRef: 'pex-9',
    })
    expect(calls[0][1]).toEqual([
      { jsonSchemaCredentialId: DIPLOMA, attributes: ['degree', 'institution', 'graduationDate'] },
    ])
  })

  it('is worth nothing when it did not verify or reports no issuer', async () => {
    expect(await present({ credentials, verified: false, state: 'declined' })).toBeUndefined()
    expect(await present({ claims: [{ name: 'degree', value: 'MSc' }] })).toBeUndefined()
  })
})

describe('the pack and the tool (INTX-PRES-001/003, PRIV-EVID-006)', () => {
  let running: RunningAgent | undefined
  afterEach(async () => {
    await running?.stop()
    running = undefined
  })

  it('refuses the name authentication and an entry whose visible attribute is not stored', () => {
    const dev = structuredClone(
      loadPack('agent-packs/dev', { ...process.env, HOME_BACKING_IDENTITY: 'did:webvh:x:h' }).pack
    )
    dev.presentations = { diploma: diploma() }
    expect(crossFieldErrors(dev)).toEqual([])
    dev.presentations = { diploma: diploma({ modelVisible: ['graduationDate'] }) }
    expect(crossFieldErrors(dev).join('\n')).toMatch(/presentations\.diploma makes \[graduationDate\] visible/)
    const reserved = structuredClone(dev) as unknown as Record<string, unknown>
    reserved.presentations = { authentication: diploma() }
    expect(() => validatePackDocument(reserved, {})).toThrow(/presentations/)
  })

  it('offers the on-demand entries of the peer’s kind by name, records the evidence and shows the model what is visible', async () => {
    running = await startTestAgent()
    const { agent } = running
    agent.pack.presentations = {
      diploma: diploma(),
      licence: diploma({ request: 'on-connect' }),
      accreditation: diploma({ subjectKind: 'service' }),
    }
    const { principal, session } = await agent.onPeerConnected(
      {
        connectionType: 'verifiable-user-agent',
        actorIdentity: 'did:peer:catalog',
        backingIdentity: null,
        claims: { userName: 'Unidentified peer' },
        userAgentVerified: false,
        identityCredentialRef: null,
      },
      'conn-catalog',
      { name: 'Wallet', version: '1', platform: 'ios' },
      { welcome: false }
    )
    const tool = (await agent.registry.visible(principal.roles, [], principal)).find(
      (t) => t.spec.name === 'request_presentation'
    )?.spec
    if (!tool) throw new Error('no request_presentation tool')
    const parameters = tool.parameters as { properties: { entry: { enum: string[] } } }
    expect(parameters.properties.entry.enum).toEqual(['diploma', 'accreditation'])
    expect(tool.description).toContain('diploma: Check your degree for the application')
    const ctx = { principal, session, roles: principal.roles, logger: agent.logger, language: 'en' }
    // an entry of another kind, one asked on connect only, and one the pack does not list are not asked
    for (const entry of ['accreditation', 'licence', 'passport'])
      expect((await tool.invoke({ entry }, ctx)).content).toMatch(/^not asked: this credential is not one/)
    // the wallet answers: the presentation is evidence of this Principal, and the model reads the visible attribute
    agent.identityRequests = new IdentityRequests(
      agent.pack,
      {
        identify: async () => undefined,
        isFlowCapable: async () => false,
        onIdentityPresented: async () => ({ outcome: 'unavailable' }),
        present: async () => verified,
        record: (p, input) => agent.evidence.record(p, input),
      },
      silent as never
    )
    expect(await agent.identityRequests.present(principal, 'diploma', 'model')).toBe('verified')
    const [record] = await agent.evidence.list(principal.id)
    expect(record).toMatchObject({ entry: 'diploma', stored: ['degree', 'institution'], connectionRef: 'conn-catalog' })
    expect(await agent.evidence.forModel(principal.id)).toEqual([
      expect.objectContaining({ entry: 'diploma', usable: true, attributes: { degree: 'MSc' } }),
    ])
    // a presentation binds nobody: the visitor is still unidentified
    expect((await agent.store.principals.get(principal.id))?.identityCredentialRef).toBeNull()
  })
})
