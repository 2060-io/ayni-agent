/**
 * The claims of a badge taken from the user directory (decision 62; ayni-spec D88, IDENT-DIR-003/004/005/007,
 * INTX-ISSUE-007, INTX-ISSUE-021). The directory is a system of record: the code finds the person's entry with a key
 * that comes from their evidence, and never before that evidence exists.
 *
 * - **With a document read** (the passport of D73): the one entry whose date of birth, nationality and last name equal
 *   the document's, and whose first names are among its given names, after the transliteration of ICAO Doc 9303.
 * - **With an email code** (D89): the entry that holds the verified address, compared in lower case.
 * - **With both**: the entry both find; none when they differ or one finds none.
 *
 * A claim is `pending` while its evidence does not exist (the action that obtains it is the profile's own challenge,
 * run by the issuance), `missing` when no single entry is found (the reason goes to the log, without any value), and
 * `available` with the entry's field otherwise; the resolution names the entry, which the issuance record keeps
 * (IDENT-DIR-006). A field the entry lacks is an empty value.
 */
import { DOCUMENT_ENTRY, EMAIL_ENTRY } from '../config/pack.js'
import { challengeTypesOf, type IssuanceProfile } from '../config/packTypes.js'
import type { Logger } from '../util/logger.js'
import { type DirectoryEntry, nameOf, type UserDirectory } from './directory.js'
import type { EvidenceService } from './evidence.js'
import {
  documentAction,
  type EmailCheckPort,
  emailAction,
  evidenceTooOld,
  type RecordSource,
  type Resolution,
} from './issuance.js'
import type { Principal } from './types.js'

/** Why no single entry was found: a word for the log, never a value (IDENT-DIR-003/004, IDENT-DIR-007). */
export type NoEntryReason =
  | 'document-matches-no-entry'
  | 'document-matches-several'
  | 'address-in-no-entry'
  | 'entries-differ'

export class DirectoryClaims {
  public constructor(
    private readonly directory: Pick<UserDirectory, 'matchDocument' | 'byEmail' | 'entry'>,
    private readonly evidence: Pick<EvidenceService, 'latest' | 'values'>,
    private readonly logger: Logger,
    /** whether the email check can be served: without an SMTP server it cannot (INTX-AUTH-011) */
    private readonly emailCheck?: Pick<EmailCheckPort, 'available'>
  ) {}

  /** The value of one claim of the directory for a Principal and a profile (INTX-ISSUE-021). */
  public async resolve(
    principal: Principal,
    profileName: string,
    profile: IssuanceProfile,
    source: RecordSource
  ): Promise<Resolution> {
    if (source.record !== 'directory')
      return { status: 'unavailable', action: { type: 'none', note: `this agent reads no ${source.record}` } }
    const found = await this.entryOf(principal, profileName, profile)
    if ('status' in found) return found
    const { entry, evidenceRef } = found
    return {
      status: 'available',
      value: fieldOf(entry, source.field),
      evidenceRef,
      directoryEntryId: entry.id,
    }
  }

  /**
   * The entry of the person, found from the evidence the profile's challenges obtain; or the status of every claim of
   * the directory while it cannot be: `pending` without that evidence, `missing` when no single entry is found.
   */
  private async entryOf(
    principal: Principal,
    profileName: string,
    profile: IssuanceProfile
  ): Promise<{ entry: DirectoryEntry; evidenceRef?: string } | Resolution> {
    const challenges = challengeTypesOf(profile)
    let byDocument: string | undefined
    let byEmail: string | undefined
    let evidenceRef: string | undefined
    if (challenges.includes('document')) {
      const read = await this.usable(principal, profile, DOCUMENT_ENTRY)
      // nothing is looked up before the evidence that holds the key exists (INTX-ISSUE-007)
      if (!read) return { status: 'pending', action: documentAction(profileName, profile) }
      const { ids, nearest } = this.directory.matchDocument({
        lastName: read.values.lastName ?? '',
        firstName: read.values.firstName ?? '',
        dateOfBirth: read.values.dateOfBirth ?? '',
        nationality: read.values.nationality ?? '',
      })
      if (ids.length !== 1)
        return this.noEntry(
          principal,
          profileName,
          ids.length ? 'document-matches-several' : 'document-matches-no-entry',
          {
            entries: ids.length,
            nearest,
          }
        )
      byDocument = ids[0]
      evidenceRef = read.id
    }
    if (challenges.includes('email')) {
      const proved = await this.usable(principal, profile, EMAIL_ENTRY)
      if (!proved) {
        // an email check this agent cannot serve: the claims it serves are unavailable (INTX-AUTH-011)
        if (!this.emailCheck?.available())
          return {
            status: 'unavailable',
            action: { type: 'none', note: 'this agent sends no email: it cannot check an address' },
          }
        return { status: 'pending', action: emailAction(profileName, profile) }
      }
      const entry = this.directory.byEmail(proved.values.address ?? '')
      // an address that left the directory since it was proved: the person may prove another
      if (!entry)
        return this.noEntry(principal, profileName, 'address-in-no-entry', {}, emailAction(profileName, profile))
      byEmail = entry.id
      evidenceRef ??= proved.id
    }
    if (byDocument && byEmail && byDocument !== byEmail)
      return this.noEntry(principal, profileName, 'entries-differ', {})
    const id = byDocument ?? byEmail
    const entry = id ? this.directory.entry(id) : undefined
    if (!entry) return this.noEntry(principal, profileName, 'document-matches-no-entry', {})
    return { entry, evidenceRef }
  }

  /** The newest usable evidence of an entry for the profile, with its stored values: the code reads them, never the model. */
  private async usable(
    principal: Principal,
    profile: IssuanceProfile,
    entry: string
  ): Promise<{ id: string; values: Record<string, string> } | undefined> {
    const record = await this.evidence.latest(principal.id, entry)
    if (record?.state !== 'active' || evidenceTooOld(record, profile)) return undefined
    const values = await this.evidence.values(principal.id, entry)
    return values ? { id: record.id, values } : undefined
  }

  private noEntry(
    principal: Principal,
    profile: string,
    reason: NoEntryReason,
    detail: Record<string, unknown>,
    action: Resolution['action'] = {
      type: 'none',
      note: 'what the person proved matches no single person of the list of their organization; the organization corrects its list',
    }
  ): Resolution {
    this.logger.info(
      { principalId: principal.id, profile, reason, ...detail },
      'no single directory entry for the badge'
    )
    return { status: 'missing', action }
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
