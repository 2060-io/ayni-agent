/**
 * Revocation of the credentials this agent issues (D91, IDENT-ROLE-013, INTX-FLOW-007; decision 61).
 *
 * The DIDComm agent revokes an AnonCreds credential by its revocation registry and its index in it, and under a
 * revocable definition it takes both from the caller at the offer: it does not choose them, and does not report them.
 * So the agent allocates them: one registry at a time per definition, created when the definition has none or the one
 * in use is full, each index given once, from 0 to the capacity less one. What it allocated is kept in the store
 * before the offer leaves, so that an index is never given twice, whatever happens to the offer; an index whose offer
 * was not accepted is lost, as a registry allows. The registry and the index go into the issuance record, which is how
 * the agent revokes the credential later and tells its holder.
 */
import type { KvRepo } from '../../store/types.js'
import type { Logger } from '../../util/logger.js'
import type { VsAgentClient } from './vsAgentClient.js'

type Client = Pick<VsAgentClient, 'createRevocationRegistry' | 'revokeCredential' | 'sendRevocationNotification'>

/** Where an issued credential's status is kept: what the offer names and the revocation needs. */
export interface RevocationSlot {
  registryDefinitionId: string
  index: number
}

/** The registries of one definition, in the order they were created; only the last one is used. */
interface RegistryState {
  registries: { id: string; capacity: number; next: number }[]
}

/** The capacity of a registry the agent creates: the default of the DIDComm agent. */
export const REGISTRY_CAPACITY = 1000

const keyOf = (credentialDefinitionId: string) => `revocation:registries:${credentialDefinitionId}`

export class CredentialRevocations {
  /** one allocation at a time per definition */
  private readonly chains = new Map<string, Promise<unknown>>()

  public constructor(
    private readonly client: Client,
    private readonly kv: KvRepo,
    /** whether a definition supports revocation, as the DIDComm agent lists it */
    private readonly supportsRevocation: (credentialDefinitionId: string) => Promise<boolean>,
    private readonly logger: Logger,
    private readonly capacity = REGISTRY_CAPACITY
  ) {}

  /**
   * The registry and the index of the next credential issued under a definition, or undefined when the definition does
   * not support revocation (its credentials are offered without them). Throws when the definition supports revocation
   * and no registry can be had: nothing is issued then, since the DIDComm agent refuses such an offer.
   */
  public async allocate(credentialDefinitionId: string): Promise<RevocationSlot | undefined> {
    if (!(await this.supportsRevocation(credentialDefinitionId))) return undefined
    return this.serial(credentialDefinitionId, async () => {
      const state = await this.state(credentialDefinitionId)
      let registry = state.registries[state.registries.length - 1]
      if (!registry || registry.next >= registry.capacity) {
        const { revocationRegistryDefinitionId } = await this.client.createRevocationRegistry({
          credentialDefinitionId,
          maximumCredentialNumber: this.capacity,
        })
        registry = { id: revocationRegistryDefinitionId, capacity: this.capacity, next: 0 }
        state.registries.push(registry)
        this.logger.info(
          { credentialDefinitionId, revocationRegistryDefinitionId, capacity: this.capacity },
          'revocation registry created'
        )
      }
      const slot = { registryDefinitionId: registry.id, index: registry.next }
      registry.next += 1
      // kept before the offer leaves: the index is never given again
      await this.kv.set(keyOf(credentialDefinitionId), JSON.stringify(state))
      return slot
    })
  }

  /** Revokes a credential and publishes the new status list; returns when the DIDComm agent says it was published. */
  public async revoke(slot: RevocationSlot): Promise<string> {
    const result = await this.client.revokeCredential({
      revocationRegistryDefinitionId: slot.registryDefinitionId,
      revocationRegistryIndex: slot.index,
    })
    return result.revokedAt
  }

  /** Tells the holder that its credential was revoked: its wallet marks the card and asks nothing (FLOW-REVOKE-001). */
  public async notify(connectionId: string, slot: RevocationSlot, comment?: string): Promise<void> {
    await this.client.sendRevocationNotification({
      connectionId,
      revocationId: `${slot.registryDefinitionId}::${slot.index}`,
      revocationFormat: 'anoncreds',
      ...(comment ? { comment } : {}),
    })
  }

  private async state(credentialDefinitionId: string): Promise<RegistryState> {
    const raw = await this.kv.get(keyOf(credentialDefinitionId))
    return raw ? (JSON.parse(raw) as RegistryState) : { registries: [] }
  }

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.chains.get(key) ?? Promise.resolve()
    const next = before.then(work, work)
    this.chains.set(
      key,
      next.catch(() => undefined)
    )
    return next
  }
}
