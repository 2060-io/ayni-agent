/**
 * The credential definition of this agent for a schema (D70, INTX-ISSUE-017). A credential definition
 * belongs to one DIDComm agent: its identifier holds the DID of the agent and exists only once the agent
 * created it. A profile that names a schema gets the definition the DIDComm agent holds for it, created
 * when there is none, and never a second one.
 *
 * A credential that must be revocable (a badge from the user directory, revoked when its entry leaves it: D91,
 * IDENT-ROLE-013) is issued under a definition created with revocation (decision 61). The DIDComm agent keeps one
 * definition per schema: when the one it holds was created without revocation, nothing that must be revocable is
 * issued under it, and the log says how to correct it, since the agent creates no second one.
 */
import type { Logger } from '../../util/logger.js'
import { type VsAgentClient, VsAgentError } from './vsAgentClient.js'

type Client = Pick<VsAgentClient, 'listCredentialDefinitions' | 'createCredentialDefinition'>

interface Definition {
  id: string
  supportRevocation: boolean
}

export class CredentialDefinitions {
  /** schema → definition, once established: a definition does not change while the wallet lives */
  private readonly known = new Map<string, Definition>()
  /** definition id → whether it supports revocation, as the DIDComm agent lists it */
  private readonly revocable = new Map<string, boolean>()
  /** one look-up at a time for a schema, so that two callers never create two definitions */
  private readonly pending = new Map<string, Promise<string | undefined>>()

  public constructor(
    private readonly client: Client,
    private readonly logger: Logger
  ) {}

  /**
   * The definition for a schema, found or created, with revocation when `revocable` asks for it. Undefined while it
   * cannot be established (the DIDComm agent out of reach, the registry of the schema without its AnonCreds schema yet,
   * a definition without revocation for a credential that must be revocable): asked again at the next call.
   */
  public forSchema(jsonSchemaCredentialId: string, options: { revocable?: boolean } = {}): Promise<string | undefined> {
    const known = this.known.get(jsonSchemaCredentialId)
    if (known && (!options.revocable || known.supportRevocation)) return Promise.resolve(known.id)
    const key = `${jsonSchemaCredentialId}\n${options.revocable === true}`
    const running = this.pending.get(key)
    if (running) return running
    const lookup = this.establish(jsonSchemaCredentialId, options.revocable === true).finally(() =>
      this.pending.delete(key)
    )
    this.pending.set(key, lookup)
    return lookup
  }

  /** Whether the credentials of a definition can be revoked: an offer under it then names a registry and an index. */
  public async supportsRevocation(credentialDefinitionId: string): Promise<boolean> {
    const known = this.revocable.get(credentialDefinitionId)
    if (known !== undefined) return known
    let cursor: string | undefined
    do {
      const page = await this.client.listCredentialDefinitions(cursor)
      for (const d of page.items) this.revocable.set(d.id, d.supportRevocation === true)
      cursor = page.nextCursor ?? undefined
    } while (cursor && !this.revocable.has(credentialDefinitionId))
    // a definition this DIDComm agent does not list is not one it can revoke under
    return this.revocable.get(credentialDefinitionId) ?? false
  }

  private async establish(schema: string, revocable: boolean): Promise<string | undefined> {
    try {
      let found = await this.find(schema)
      if (!found) {
        try {
          const created = await this.client.createCredentialDefinition({
            relatedJsonSchemaCredentialId: schema,
            ...(revocable ? { supportRevocation: true } : {}),
          })
          found = { id: created.id, supportRevocation: created.supportRevocation ?? revocable }
          this.logger.info(
            { schema, credentialDefinitionId: found.id, supportRevocation: found.supportRevocation },
            'credential definition created (INTX-ISSUE-017)'
          )
        } catch (error) {
          // a conflict tells that one exists by now: it is the one to use
          if (!(error instanceof VsAgentError) || error.status !== 409) throw error
          found = await this.find(schema)
          if (!found) throw error
        }
      }
      this.known.set(schema, found)
      this.revocable.set(found.id, found.supportRevocation)
      if (revocable && !found.supportRevocation) {
        this.logger.error(
          { schema, credentialDefinitionId: found.id },
          'the credential definition of this schema was created without revocation, and a badge from the user directory must be revocable (IDENT-ROLE-013): nothing is issued from the directory under it. Delete the definition in the DIDComm agent (DELETE /v2/anoncreds/credential-definitions/{id}) so that the agent creates a revocable one'
        )
        return undefined
      }
      return found.id
    } catch (error) {
      this.logger.warn({ err: error, schema }, 'credential definition not established: nothing is issued under it')
      return undefined
    }
  }

  private async find(schema: string): Promise<Definition | undefined> {
    let cursor: string | undefined
    do {
      const page = await this.client.listCredentialDefinitions(cursor)
      for (const d of page.items) this.revocable.set(d.id, d.supportRevocation === true)
      const found = page.items.find((definition) => definition.relatedJsonSchemaCredentialId === schema)
      if (found) return { id: found.id, supportRevocation: found.supportRevocation === true }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return undefined
  }
}
