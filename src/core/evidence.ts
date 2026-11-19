/**
 * Evidence: what the agent verified about a Principal (D67, D68; PRIV-EVID-001..009, INTX-CRED-001).
 * A record is written by the code that received and verified a presentation, never by the model. Its audit
 * fields are in the clear; the values the agent-pack stores are sealed under a key of the record, kept for
 * the retention the pack gives, then archived or erased. The model reads the attributes the pack makes
 * visible, and nothing else.
 */
import { AUTHENTICATION_ENTRY, DOCUMENT_ENTRY } from '../config/pack.js'
import type { AgentPack, EvidencePolicy } from '../config/packTypes.js'
import { type EntryCrypto, openJson, sealJson } from '../memory/crypto.js'
import type { Store, StoredEvidence } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { EvidenceRecord, IssuedRevocation, Principal } from './types.js'

export { AUTHENTICATION_ENTRY }

/** The attribute names under which a credential may carry the name of the person. */
const NAME_ATTRIBUTES = ['userName', 'name']

/** What the agent-pack says of an entry; nothing stored and nothing visible when it says nothing (PRIV-EVID-004). */
export function evidencePolicyOf(pack: AgentPack, entry: string): EvidencePolicy {
  if (entry === AUTHENTICATION_ENTRY) {
    const authentication = pack.identity.authentication?.[0]
    return { store: authentication?.store, modelVisible: authentication?.modelVisible }
  }
  if (entry === DOCUMENT_ENTRY) return pack.evidence?.document ?? {}
  const catalog = pack.presentations?.[entry]
  return catalog ? { store: catalog.store, modelVisible: catalog.modelVisible } : {}
}

const pick = (values: Record<string, string>, names: string[]): Record<string, string> =>
  Object.fromEntries(names.filter((n) => values[n] !== undefined).map((n) => [n, values[n]]))

/**
 * What a Principal keeps of its identity credential: the issuer, an audit field, and the values the pack
 * stores, with the name of the person under `userName` when it is one of them. Nothing else of the
 * credential outlives the decision it was presented for (PRIV-EVID-009).
 */
export function storedIdentityAttributes(pack: AgentPack, values: Record<string, unknown>): Record<string, unknown> {
  const stored = evidencePolicyOf(pack, AUTHENTICATION_ENTRY).store?.attributes ?? []
  const kept: Record<string, unknown> = {}
  for (const name of stored) if (values[name] !== undefined) kept[name] = values[name]
  const nameAttribute = NAME_ATTRIBUTES.find((n) => stored.includes(n) && values[n] !== undefined)
  if (nameAttribute) kept.userName = values[nameAttribute]
  if (values.issuerDid !== undefined) kept.issuerDid = values.issuerDid
  return kept
}

/**
 * The name of the person as the model may know it. A person identified by a credential is named to the
 * model only when the pack makes the name visible; a service and an unidentified peer carry no credential
 * value, and are named as before.
 */
export function nameForModel(pack: AgentPack, principal: Principal | null | undefined): string | undefined {
  const name = principal?.identityAttributes.userName
  if (!name) return undefined
  if (!principal?.identityCredentialRef?.startsWith('badge:')) return name
  const visible = evidencePolicyOf(pack, AUTHENTICATION_ENTRY).modelVisible ?? []
  return NAME_ATTRIBUTES.some((n) => visible.includes(n)) ? name : undefined
}

/** What the code that verified something hands over. Values are those revealed; the pack decides what is kept. */
export interface EvidenceInput {
  kind: EvidenceRecord['kind']
  entry: string
  schema?: string
  credentialDefinitionId?: string
  issuerDid?: string
  issuerOrganization?: { key: string; name?: string }
  outcome?: EvidenceRecord['outcome']
  /** why what was received is not kept, when it is not: a word, never a value */
  reason?: string
  values: Record<string, string>
  unrevealed?: string[]
  requestRef?: string
  connectionRef?: string
  evidenceRefs?: string[]
  /** an issuance: the directory entry its claims came from (IDENT-DIR-006) */
  directoryEntryId?: string
  /**
   * an issuance of the identity credential: the actor it identifies once presented (D59). Kept only as a keyed index
   * (`holderIndex`), by which the presented credential finds its record (IDENT-ROLE-012)
   */
  holder?: string
  /** an issuance under a revocable definition: the registry and the index of the credential (D91) */
  revocation?: IssuedRevocation
}

/** What the model is told of a record: its audit fields and the visible attributes, when it is usable. */
export interface EvidenceForModel {
  entry: string
  kind: EvidenceRecord['kind']
  issuer?: string
  verifiedAt: string
  usable: boolean
  attributes: Record<string, string>
}

const auditOf = (stored: StoredEvidence): EvidenceRecord => {
  const { cipher: _cipher, ...record } = stored
  return record
}

export class EvidenceService {
  public constructor(
    private readonly store: Store,
    private readonly pack: AgentPack,
    private readonly crypto: EntryCrypto,
    private readonly logger: Logger
  ) {}

  /**
   * Records a verification. The values the pack stores are sealed, the others are dropped. The values of
   * the earlier records of the same entry are erased: the newest presentation is the one in use, the
   * earlier ones stay as audit.
   */
  public async record(
    principal: Pick<Principal, 'id'>,
    input: EvidenceInput,
    /** the policy of an issuance comes from its profile, not from an entry of the catalog */
    policyOf?: EvidencePolicy
  ): Promise<EvidenceRecord> {
    const policy = policyOf ?? evidencePolicyOf(this.pack, input.entry)
    const outcome = input.outcome ?? 'verified'
    const values = outcome === 'verified' ? pick(input.values, policy.store?.attributes ?? []) : {}
    const stored = Object.keys(values)
    const verifiedAt = nowIso()
    const days = policy.store?.retention?.days
    const record: StoredEvidence = {
      id: prefixedId('evd'),
      principalId: principal.id,
      kind: input.kind,
      entry: input.entry,
      schema: input.schema,
      credentialDefinitionId: input.credentialDefinitionId,
      issuerDid: input.issuerDid,
      issuerOrganization: input.issuerOrganization,
      outcome,
      reason: input.reason,
      revealed: Object.keys(input.values),
      unrevealed: [...(input.unrevealed ?? [])],
      stored,
      requestRef: input.requestRef,
      connectionRef: input.connectionRef,
      evidenceRefs: input.evidenceRefs,
      ...(input.directoryEntryId ? { directoryEntryId: input.directoryEntryId } : {}),
      ...(input.holder ? { holderIndex: this.holderIndex(input.holder) } : {}),
      ...(input.revocation ? { revocation: { ...input.revocation } } : {}),
      verifiedAt,
      state: 'active',
      expiresAt:
        stored.length && days !== undefined
          ? new Date(Date.parse(verifiedAt) + days * 86_400_000).toISOString()
          : undefined,
      onExpiry: stored.length ? (policy.store?.retention?.onExpiry ?? 'erase') : undefined,
      contentDigest: '',
      encKeyRef: null,
      cipher: null,
    }
    if (stored.length) {
      record.encKeyRef = this.crypto.newWrappedKey()
      const sealed = sealJson(this.crypto, record.encKeyRef, values)
      record.cipher = sealed.cipher
      record.contentDigest = sealed.digest
    }
    for (const earlier of await this.store.evidence.list(principal.id)) {
      if (earlier.entry === input.entry && earlier.state === 'active' && earlier.encKeyRef) await this.drop(earlier)
    }
    await this.store.evidence.save(record)
    this.logger.info(
      { evidenceId: record.id, principalId: principal.id, entry: record.entry, outcome, stored: stored.length },
      'evidence recorded'
    )
    return auditOf(record)
  }

  /** The keyed index of the actor an identity credential identifies: the actor itself is never kept with the record. */
  public holderIndex(actorIdentity: string): string {
    return this.crypto.blindIndex(`holder\n${actorIdentity}`)
  }

  /**
   * The entry of the user directory the presented identity credential of an actor was issued from, by this agent
   * (IDENT-DIR-006, IDENT-ROLE-012): the newest issuance to that actor whose claims came from the directory and which is
   * not revoked, under the credential definition presented when the presentation names it.
   */
  public async issuedFromDirectoryTo(
    actorIdentity: string,
    credentialDefinitionId?: string
  ): Promise<EvidenceRecord | undefined> {
    const found = (await this.store.evidence.listIssuedTo(this.holderIndex(actorIdentity))).find(
      (r) =>
        !!r.directoryEntryId &&
        !r.revocation?.revokedAt &&
        (!credentialDefinitionId || !r.credentialDefinitionId || r.credentialDefinitionId === credentialDefinitionId)
    )
    return found ? auditOf(found) : undefined
  }

  /** The issuances whose claims came from the directory: of one entry, or of every entry (IDENT-ROLE-013). */
  public async issuedFromDirectory(directoryEntryId?: string): Promise<EvidenceRecord[]> {
    return (await this.store.evidence.listIssuedFromDirectory(directoryEntryId)).map(auditOf)
  }

  /** Records what became of the revocation of an issued credential: audit fields only (D91). */
  public async setRevocation(id: string, revocation: IssuedRevocation): Promise<EvidenceRecord | undefined> {
    const stored = await this.store.evidence.get(id)
    if (stored?.kind !== 'issuance') return undefined
    const next: StoredEvidence = { ...stored, revocation: { ...revocation } }
    await this.store.evidence.save(next)
    return auditOf(next)
  }

  /** The audit fields of the records of a Principal, oldest first. */
  public async list(principalId: string): Promise<EvidenceRecord[]> {
    return (await this.store.evidence.list(principalId)).map(auditOf)
  }

  /** What the model may read: for each record its audit fields, and the visible attributes while it is usable. */
  public async forModel(principalId: string): Promise<EvidenceForModel[]> {
    const out: EvidenceForModel[] = []
    for (const stored of await this.store.evidence.list(principalId)) {
      // an issuance is not something the person presented: the requirements tool tells what was issued
      if (stored.outcome !== 'verified' || stored.kind === 'issuance') continue
      const usable = stored.state === 'active' && !this.expired(stored)
      const visible = evidencePolicyOf(this.pack, stored.entry).modelVisible ?? []
      const values = usable ? this.open(stored) : {}
      out.push({
        entry: stored.entry,
        kind: stored.kind,
        issuer: stored.issuerOrganization?.name ?? stored.issuerOrganization?.key,
        verifiedAt: stored.verifiedAt,
        usable,
        attributes: pick(values, visible),
      })
    }
    return out.reverse()
  }

  /** The newest verified record of an entry, with its audit fields: what the requirements of an issuance are read from. */
  public async latest(principalId: string, entry: string): Promise<EvidenceRecord | undefined> {
    const stored = (await this.store.evidence.list(principalId))
      .filter((e) => e.entry === entry && e.outcome === 'verified')
      .at(-1)
    return stored ? auditOf(stored) : undefined
  }

  /** The stored values of the newest usable record of an entry, for the code that issues from it; never the model. */
  public async values(principalId: string, entry: string): Promise<Record<string, string> | undefined> {
    const usable = (await this.store.evidence.list(principalId))
      .filter((e) => e.entry === entry && e.outcome === 'verified' && e.state === 'active' && !this.expired(e))
      .at(-1)
    return usable ? this.open(usable) : undefined
  }

  /** The values an auditor reads: those of an active or archived record, through the logged interface (RBAC-XSESS-006). */
  public async audit(id: string): Promise<{ record: EvidenceRecord; values: Record<string, string> } | undefined> {
    const stored = await this.store.evidence.get(id)
    return stored ? { record: auditOf(stored), values: this.open(stored) } : undefined
  }

  /** An erasure request: the values go as `erase` does, the audit fields stay; a legal hold blocks it (PRIV-EVID-008). */
  public async erase(id: string): Promise<{ erased: boolean; reason?: string }> {
    const stored = await this.store.evidence.get(id)
    if (!stored) return { erased: false, reason: 'not-found' }
    if (stored.state === 'legal-hold') return { erased: false, reason: 'legal-hold' }
    await this.drop(stored)
    await this.forgetOnPrincipal(stored)
    return { erased: true }
  }

  /** The end of retentions (PRIV-EVID-007): `archive` hides the values, `erase` destroys the key. */
  public async expire(now = nowIso()): Promise<{ archived: number; erased: number }> {
    let archived = 0
    let erased = 0
    for (const stored of await this.store.evidence.listExpired(now)) {
      if (stored.onExpiry === 'archive') {
        await this.store.evidence.save({ ...stored, state: 'archived' })
        archived++
      } else {
        await this.drop(stored)
        erased++
      }
      await this.forgetOnPrincipal(stored)
    }
    if (archived || erased) this.logger.info({ archived, erased }, 'evidence retention applied')
    return { archived, erased }
  }

  private expired(stored: StoredEvidence): boolean {
    return !!stored.expiresAt && stored.expiresAt <= nowIso()
  }

  private open(stored: StoredEvidence): Record<string, string> {
    if (!stored.cipher || !stored.encKeyRef || stored.state === 'crypto-erased') return {}
    try {
      return openJson<Record<string, string>>(this.crypto, stored.encKeyRef, stored.cipher)
    } catch (error) {
      this.logger.error({ err: error, evidenceId: stored.id }, 'evidence values could not be opened')
      return {}
    }
  }

  /** Destroys the key of a record: its values are gone, its audit fields and digest remain. */
  private async drop(stored: StoredEvidence): Promise<void> {
    await this.store.evidence.save({ ...stored, encKeyRef: null, cipher: null, state: 'crypto-erased' })
  }

  /** The values a Principal carried from its identity credential go with the record they came from. */
  private async forgetOnPrincipal(stored: StoredEvidence): Promise<void> {
    if (stored.entry !== AUTHENTICATION_ENTRY) return
    const principal = await this.store.principals.get(stored.principalId)
    if (!principal) return
    const { issuerDid } = principal.identityAttributes as { issuerDid?: unknown }
    principal.identityAttributes = issuerDid === undefined ? {} : { issuerDid }
    await this.store.principals.save(principal)
  }
}
