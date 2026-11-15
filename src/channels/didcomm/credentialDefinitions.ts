/**
 * The credential definition of this agent for a schema (D70, INTX-ISSUE-017). A credential definition
 * belongs to one DIDComm agent: its identifier holds the DID of the agent and exists only once the agent
 * created it. A profile that names a schema gets the definition the DIDComm agent holds for it, created
 * when there is none, and never a second one.
 */
import type { Logger } from '../../util/logger.js'
import { type VsAgentClient, VsAgentError } from './vsAgentClient.js'

type Client = Pick<VsAgentClient, 'listCredentialDefinitions' | 'createCredentialDefinition'>

export class CredentialDefinitions {
  /** schema → definition, once established: a definition does not change while the wallet lives */
  private readonly known = new Map<string, string>()
  /** one look-up at a time for a schema, so that two callers never create two definitions */
  private readonly pending = new Map<string, Promise<string | undefined>>()

  public constructor(
    private readonly client: Client,
    private readonly logger: Logger
  ) {}

  /**
   * The definition for a schema, found or created. Undefined while it cannot be established (the DIDComm
   * agent out of reach, the registry of the schema without its AnonCreds schema yet): asked again at the
   * next call.
   */
  public forSchema(jsonSchemaCredentialId: string): Promise<string | undefined> {
    const known = this.known.get(jsonSchemaCredentialId)
    if (known) return Promise.resolve(known)
    const running = this.pending.get(jsonSchemaCredentialId)
    if (running) return running
    const lookup = this.establish(jsonSchemaCredentialId).finally(() => this.pending.delete(jsonSchemaCredentialId))
    this.pending.set(jsonSchemaCredentialId, lookup)
    return lookup
  }

  private async establish(schema: string): Promise<string | undefined> {
    try {
      let id = await this.find(schema)
      if (!id) {
        try {
          id = (await this.client.createCredentialDefinition({ relatedJsonSchemaCredentialId: schema })).id
          this.logger.info({ schema, credentialDefinitionId: id }, 'credential definition created (INTX-ISSUE-017)')
        } catch (error) {
          // a conflict tells that one exists by now: it is the one to use
          if (!(error instanceof VsAgentError) || error.status !== 409) throw error
          id = await this.find(schema)
          if (!id) throw error
        }
      }
      this.known.set(schema, id)
      return id
    } catch (error) {
      this.logger.warn({ err: error, schema }, 'credential definition not established: nothing is issued under it')
      return undefined
    }
  }

  private async find(schema: string): Promise<string | undefined> {
    let cursor: string | undefined
    do {
      const page = await this.client.listCredentialDefinitions(cursor)
      const found = page.items.find((definition) => definition.relatedJsonSchemaCredentialId === schema)
      if (found) return found.id
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return undefined
  }
}
