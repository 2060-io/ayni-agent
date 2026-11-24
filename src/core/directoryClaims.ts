/**
 * The claims of a badge taken from the user directory (ayni-spec D130, IDENT-DIR-005/007, INTX-ISSUE-007, INTX-ISSUE-021).
 * The directory is a system of record, and its key is the entry the Principal's authentication identified
 * (IDENT-AUTH-003): issuing the badge neither authenticates nor finds the entry by itself.
 *
 * - A claim of the directory is `pending` while the Principal is not identified, the action that obtains it being the
 *   authentication; `unavailable` for a person identified otherwise than by an entry (a credential of another
 *   organization) or whose entry left the directory; and the entry's field otherwise, the resolution naming the entry,
 *   which the issuance record keeps (IDENT-DIR-006). A field the entry lacks is an empty value.
 * - A claim of the document (the birth date, the portrait) comes from a passport of that entry read when the person
 *   authenticated: the newest read still good for the profile, which the matching of IDENT-DIR-003 finds to be the
 *   entry's and nobody else's. Without one the claim is empty (IDENT-DIR-005).
 */
import { AUTHENTICATION_ENTRY, DOCUMENT_ENTRY } from '../config/pack.js'
import type { IssuanceProfile } from '../config/packTypes.js'
import type { Logger } from '../util/logger.js'
import { type DirectoryEntry, nameOf, type UserDirectory } from './directory.js'
import type { EvidenceService } from './evidence.js'
import { evidenceTooOld, type RecordSource, type Resolution } from './issuance.js'
import type { Principal } from './types.js'

export class DirectoryClaims {
  public constructor(
    private readonly directory: Pick<UserDirectory, 'matchDocument' | 'entry'>,
    private readonly evidence: Pick<EvidenceService, 'latest' | 'values'>,
    private readonly logger: Logger
  ) {}

  /** The value of one claim of the directory for a Principal and a profile (INTX-ISSUE-021). */
  public async resolve(
    principal: Principal,
    profileName: string,
    _profile: IssuanceProfile,
    source: RecordSource
  ): Promise<Resolution> {
    if (source.record !== 'directory')
      return { status: 'unavailable', action: { type: 'none', note: `this agent reads no ${source.record}` } }
    const entry = this.entryOf(principal, profileName)
    if ('status' in entry) return entry
    return { status: 'available', value: fieldOf(entry, source.field), directoryEntryId: entry.id }
  }

  /**
   * The passport of the Principal's entry read when the person authenticated, still good for the profile (IDENT-DIR-005):
   * the newest read, when it matches that entry and no other (IDENT-DIR-003). Its values are read by the code, never by
   * the model.
   */
  public async entryDocument(
    principal: Principal,
    profile: IssuanceProfile
  ): Promise<{ id: string; values: Record<string, string> } | undefined> {
    const entry = this.entryOf(principal)
    if ('status' in entry) return undefined
    const record = await this.evidence.latest(principal.id, DOCUMENT_ENTRY)
    if (record?.state !== 'active' || evidenceTooOld(record, profile)) return undefined
    const values = await this.evidence.values(principal.id, DOCUMENT_ENTRY)
    if (!values) return undefined
    const { ids } = this.directory.matchDocument({
      lastName: values.lastName ?? '',
      firstName: values.firstName ?? '',
      dateOfBirth: values.dateOfBirth ?? '',
      nationality: values.nationality ?? '',
    })
    if (ids.length !== 1 || ids[0] !== entry.id) {
      // a read of someone else, or of nobody single: the claims of the document stay empty; the reason, never a value
      this.logger.info(
        { principalId: principal.id, entries: ids.length },
        'the document read is not the passport of the entry: the claims of the document are empty'
      )
      return undefined
    }
    return { id: record.id, values }
  }

  /**
   * The entry the Principal's authentication identified (IDENT-AUTH-003), or the status of every claim of the directory
   * while there is none: `pending` before an authentication, `unavailable` for a person who is not on the list.
   */
  private entryOf(principal: Principal, profileName?: string): DirectoryEntry | Resolution {
    // nothing is looked up before an authentication identified an entry (INTX-ISSUE-007, INTX-ISSUE-021)
    if (!principal.identityCredentialRef)
      return { status: 'pending', action: { type: 'request_presentation', entry: AUTHENTICATION_ENTRY } }
    const id = principal.directoryEntryId
    const entry = id ? this.directory.entry(id) : undefined
    if (!entry) {
      if (profileName)
        this.logger.info(
          { principalId: principal.id, profile: profileName, entry: !!id },
          'the Principal holds no entry of the directory: no badge from it'
        )
      return {
        status: 'unavailable',
        action: {
          type: 'none',
          note: 'the person is not on the list of the organization: they authenticated otherwise than as one of its people',
        },
      }
    }
    return entry
  }
}

/** A field of an entry as a claim takes it (INTX-ISSUE-021, IDENT-DIR-005): an empty value for one it lacks. */
export function fieldOf(entry: DirectoryEntry, field: RecordSource['field']): string {
  switch (field) {
    case 'name':
      return nameOf(entry)
    case 'firstName':
      return entry.firstName
    case 'lastName':
      return entry.lastName
    case 'email':
      return entry.email
    case 'department':
      return entry.department ?? ''
  }
}
