/**
 * The identity flow on DIDComm connect (IDENT-RES-003, IDENT-RES-007): a wallet that presents no valid
 * identity credential is refused, unless the pack admits unidentified peers (D53).
 */
import { describe, expect, it } from 'vitest'
import { IdentityFlow } from '../src/channels/didcomm/identity.js'
import type { AgentPack } from '../src/config/packTypes.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }

function packWith(identity: Partial<AgentPack['identity']>): AgentPack {
  return {
    identity: {
      homeBackingIdentity: 'did:webvh:x:home',
      recognizedBackingIdentities: [],
      roleRules: [],
      userAgentGate: 'optional',
      credentials: { badge: [{ schemaId: 'ecs-badge' }] },
      ...identity,
    },
  } as unknown as AgentPack
}

/** A VS Agent whose peer answers every presentation request with nothing verified. */
function clientRefusing(flowRef: { flow?: IdentityFlow }) {
  let n = 0
  return {
    requestPresentation: async () => {
      const proofExchangeId = `pex-${++n}`
      // the answer lands after the flow has registered the request (a macrotask later)
      setTimeout(
        () => flowRef.flow?.onPresentation({ proofExchangeId, state: 'declined', claims: [], verified: false }),
        0
      )
      return { proofExchangeId }
    },
  }
}

describe('unidentified peers (D53, IDENT-RES-007)', () => {
  it('refuses a wallet without a valid identity credential by default', async () => {
    const ref: { flow?: IdentityFlow } = {}
    ref.flow = new IdentityFlow(packWith({}), clientRefusing(ref) as never, {} as never, false, silent as never)
    expect(await ref.flow.establish('conn-1', 'did:peer:4z1')).toBeUndefined()
  })

  it('admits it as a Principal without backing identity when the pack says so', async () => {
    const ref: { flow?: IdentityFlow } = {}
    ref.flow = new IdentityFlow(
      packWith({ unidentifiedPeers: 'admit' }),
      clientRefusing(ref) as never,
      {} as never,
      false,
      silent as never
    )
    const facts = await ref.flow.establish('conn-2', 'did:peer:4z2')
    expect(facts).toMatchObject({
      connectionType: 'verifiable-user-agent',
      actorIdentity: 'did:peer:4z2',
      backingIdentity: null,
      identityCredentialRef: null,
      userAgentVerified: false,
    })
  })
})
