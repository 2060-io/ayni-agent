/**
 * The people of the user directory, as the agent acts on them (decision 61; ayni-spec D79, D81, D87, D91, D92;
 * IDENT-ROLE-012/013/014, IDENT-DIR-006/008/009, SPACE-MEMB-001/002/005/008, IDENT-LIVE-004/005).
 *
 * - **Who holds an entry.** A Principal holds the entry its identity credential was issued from, by this agent: the
 *   issuance record names the entry and a keyed index of the actor the credential identifies, and the credential,
 *   once presented, finds that record (`entryOf`). The entry's roles, typed by hand, join those of the Principal's
 *   verified facts; its department and groups make it a member of the rule spaces that name them, and nothing else.
 * - **A reload.** What it changed is in the admin audit already (the directory writes it). Here: the rule spaces record
 *   who the rule took in or out (`joined`, `left`), the roles of the holders follow their entries from their next
 *   turn, and a person whose entry left the directory loses it at once: the roles it gave, every session, closed with
 *   `credential-invalid` before anything else, and every credential issued from the entry, revoked, its holder told.
 * - **In line with the directory.** All of this is done by bringing the agent in line with the directory as loaded
 *   (`reconcile`), at start (removals made while the agent was down) and after every reload; a revocation the DIDComm
 *   agent could not make is made again later.
 * - **What people see.** The member picker (names and departments), the admin view of roles and of the changes; never
 *   an email, a birthdate or a nationality (IDENT-DIR-007).
 */
import type { AgentPack } from '../config/packTypes.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { DirectoryReload, DirectoryView, UserDirectory } from './directory.js'
import { AUTHENTICATION_ENTRY, type EvidenceService } from './evidence.js'
import type { RevocationSlot } from './issuance.js'
import type { DirectoryLink, PrincipalService, VerifiedFacts } from './principals.js'
import { ruleMatches, SpaceError, type SpaceService } from './spaces.js'
import { DIRECTORY_ACTOR, type EvidenceRecord, type IssuedRevocation, type Principal } from './types.js'

/** How the agent revokes a credential it issued and tells its holder (the DIDComm agent, D91, INTX-FLOW-007). */
export interface RevocationPort {
  /** revokes and publishes the status list; resolves with when it was published */
  revoke(slot: RevocationSlot): Promise<string>
  /** `revocation_notification` to the holder's connection */
  notify(connectionId: string, slot: RevocationSlot, comment?: string): Promise<void>
}

export interface PeopleDeps {
  pack: AgentPack
  store: Store
  /** the user directory, when the agent-pack names one */
  directory?: UserDirectory
  principals: PrincipalService
  evidence: EvidenceService
  spaces: SpaceService
  /** how credentials are revoked; without it a removal ends the access and revokes nothing (logged) */
  revocations?: RevocationPort
  /** the key of the agent's own organization (IDENT-ROLE-011); none while it is not established */
  homeKey(): Promise<string | undefined>
  /**
   * ends the access of a Principal at once (IDENT-LIVE-004/005): its wallet is told, every session of it is closed with
   * `credential-invalid`, its devices are unpaired
   */
  endAccess(principal: Principal): Promise<void>
  /**
   * ends the person's own tool accounts, their key destroyed with them, in the same reload that ends their access
   * (IDENT-ROLE-013, TOOL-CONN-008)
   */
  endAccounts?(principal: Principal): Promise<void>
  /**
   * the governance of the spaces (D136, D139): a person whose entry left is no member of any space, a space they owned
   * passes to its successor or has no owner; then the spaces are brought in line with their people
   */
  governance?: { review(): Promise<void> }
  logger: Logger
}

/** How many times the notification of a revocation is tried before it is given up. */
const NOTIFY_ATTEMPTS = 3

/** What one bringing in line did. */
export interface Reconciliation {
  /** Principals whose entry left the directory: their access ended */
  released: number
  /** holders whose roles changed with their entry */
  rolesChanged: number
  /** invitations of people whose entry left the directory, removed */
  invitationsRemoved: number
  /** credentials revoked now */
  revoked: number
}

export class PeopleService implements DirectoryLink {
  /** a revocation or a notification is to be tried again */
  private pending = false
  /** the records issued under a definition without revocation, already reported */
  private readonly unrevocable = new Set<string>()

  public constructor(private readonly deps: PeopleDeps) {}

  public get directory(): UserDirectory | undefined {
    return this.deps.directory
  }

  // ---- who holds an entry (IDENT-ROLE-012, IDENT-DIR-006) -----------------------------------------------------

  /**
   * The entry this agent issued a presented identity credential from: the credential of a person of the home
   * organization, whose issuance record names an entry and the actor it identifies, and is not revoked.
   */
  public async entryOf(facts: VerifiedFacts): Promise<string | undefined> {
    if (!this.deps.directory || facts.evidence?.entry !== AUTHENTICATION_ENTRY) return undefined
    const home = await this.deps.homeKey()
    if (!home || facts.organization?.key !== home) return undefined
    const record = await this.deps.evidence.issuedFromDirectoryTo(
      facts.actorIdentity,
      facts.evidence.credentialDefinitionId
    )
    return record?.directoryEntryId
  }

  /** The roles an entry gives as the directory is loaded; undefined when it holds no such entry. */
  public rolesOf(entryId: string): string[] | undefined {
    return this.deps.directory?.view(entryId)?.roles
  }

  /** The department and groups of a Principal's entry: what a rule space reads (SPACE-MEMB-001). */
  public factsOf(principal: Principal): { department?: string; groups: string[] } | undefined {
    const view = principal.directoryEntryId ? this.deps.directory?.view(principal.directoryEntryId) : undefined
    return view ? { ...(view.department ? { department: view.department } : {}), groups: view.groups } : undefined
  }

  /**
   * After an issuance: a Principal that already is the actor of the credential it received (a person who obtains their
   * badge again) holds its entry from now, without presenting it again.
   */
  public async onIssued(principal: Principal, record: EvidenceRecord, holder: string | undefined): Promise<void> {
    if (!record.directoryEntryId || !holder || holder !== principal.actorIdentity) return
    const roles = this.rolesOf(record.directoryEntryId)
    if (!roles) return
    await this.deps.principals.holdEntry(principal, record.directoryEntryId, roles)
    await this.deps.spaces.bindDirectoryMember(principal)
  }

  // ---- a reload (IDENT-ROLE-013, D91, SPACE-MEMB-008) -------------------------------------------------------

  /** What a load of the directory changes in the agent: the rule spaces' activity, then everything else in line. */
  public async apply(reload: DirectoryReload): Promise<Reconciliation> {
    // before a Principal whose entry left loses it: the rule spaces record that it left them
    await this.recordRuleMembership(reload).catch((err) =>
      this.deps.logger.error({ err }, 'who a rule space took in or out was not recorded')
    )
    return this.reconcile()
  }

  /**
   * `joined` and `left` in the rule spaces of a department or a group, for each Principal that holds an entry whose
   * department or groups the load changed (SPACE-MEMB-008). The owner is a member whatever the rule says.
   */
  private async recordRuleMembership(reload: DirectoryReload): Promise<void> {
    const ruleSpaces = (await this.deps.spaces.all()).filter(
      (s) => s.membership.mode === 'rule' && !s.membership.rule.organization
    )
    if (!ruleSpaces.length) return
    const holders = (await this.deps.store.principals.list()).filter(
      (p) => p.directoryEntryId && p.backingRelation === 'home'
    )
    const facts = (view: DirectoryView | undefined) => ({
      ...(view?.department ? { department: view.department } : {}),
      groups: view?.groups ?? [],
      home: true,
    })
    for (const space of ruleSpaces) {
      if (space.membership.mode !== 'rule') continue
      const rule = space.membership.rule
      // the owner, and a former owner who stays a member by their row (SPACE-MEMB-007), are members whatever the rule
      const byRow = new Set(
        (await this.deps.spaces.memberRows(space.id)).flatMap((m) =>
          m.state === 'active' && m.principalId ? [m.principalId] : []
        )
      )
      for (const p of holders) {
        const entryId = p.directoryEntryId as string
        if (p.id === space.ownerPrincipalId || byRow.has(p.id)) continue
        const was = ruleMatches(rule, facts(reload.before.get(entryId)))
        const is = ruleMatches(rule, facts(reload.after.get(entryId)))
        if (was === is) continue
        await this.deps.spaces.record(space.id, DIRECTORY_ACTOR, is ? 'joined' : 'left', {
          principalId: p.id,
          directoryId: entryId,
        })
      }
    }
  }

  /**
   * Brings the agent in line with the directory as loaded (IDENT-ROLE-013, D91): a Principal whose entry left it loses
   * it, its roles and every session, at once and first; the holders of an entry get its roles; an invitation of a
   * person no longer listed is removed; every credential issued from an entry no longer listed is revoked and its
   * holder told. Idempotent: run at start, after every reload, and again while a revocation waits.
   */
  public async reconcile(): Promise<Reconciliation> {
    const out: Reconciliation = { released: 0, rolesChanged: 0, invitationsRemoved: 0, revoked: 0 }
    const directory = this.deps.directory
    if (!directory) {
      // the pack names no directory any more: the roles its entries gave are gone, and nothing else changes
      for (const principal of await this.deps.store.principals.list()) {
        if (!principal.directoryEntryId) continue
        await this.deps.principals.forgetEntry(principal)
        out.rolesChanged++
      }
      if (out.rolesChanged)
        this.deps.logger.warn(
          out,
          'the agent-pack names no user directory: the roles its entries gave are gone (IDENT-ROLE-012)'
        )
      return out
    }
    // the connections of the people who leave, where their wallet is told of the revocation
    const channels = new Map<string, Set<string>>()
    for (const principal of await this.deps.store.principals.list()) {
      const entryId = principal.directoryEntryId
      if (!entryId) continue
      const roles = this.rolesOf(entryId)
      if (roles) {
        if (await this.deps.principals.applyEntryRoles(principal, roles)) out.rolesChanged++
        continue
      }
      if (principal.capabilityChannelId)
        channels.set(entryId, new Set([...(channels.get(entryId) ?? []), principal.capabilityChannelId]))
      await this.release(principal, entryId)
      out.released++
    }
    out.invitationsRemoved = await this.removeStaleInvitations()
    out.revoked = await this.revokeIssued(channels)
    // who the approval policies name, the successors, the spaces with no owner: in line with the people now
    await this.deps.governance
      ?.review()
      .catch((err) => this.deps.logger.error({ err }, 'the governance of the spaces was not brought in line'))
    if (out.released || out.rolesChanged || out.invitationsRemoved || out.revoked)
      this.deps.logger.info(out, 'the agent is in line with the user directory')
    return out
  }

  /** A revocation or a notification that failed is tried again (the schedule of the agent). */
  public async retry(): Promise<void> {
    if (!this.pending) return
    this.pending = false
    await this.revokeIssued(new Map())
  }

  /** The access of a person whose entry left the directory ends at once (IDENT-ROLE-013, IDENT-LIVE-005). */
  private async release(principal: Principal, entryId: string): Promise<void> {
    await this.deps.principals.releaseEntry(principal)
    // no member of any space any more; a space they owned passes to its successor, or waits for a steward (D136)
    try {
      await this.deps.spaces.onEntryLeft(principal, entryId)
    } catch (error) {
      this.deps.logger.error(
        { err: error, principalId: principal.id },
        'the spaces of a removed person were not all brought in line'
      )
    }
    // their own accounts end first: no call of theirs runs once the entry is gone (TOOL-CONN-008)
    try {
      await this.deps.endAccounts?.(principal)
    } catch (error) {
      this.deps.logger.error(
        { err: error, principalId: principal.id },
        'the own accounts of a removed person were not all ended'
      )
    }
    try {
      await this.deps.endAccess(principal)
    } catch (error) {
      this.deps.logger.error(
        { err: error, principalId: principal.id },
        'the sessions of a removed person were not all closed'
      )
    }
    this.deps.logger.info(
      { principalId: principal.id, directoryId: entryId },
      'directory entry removed: its roles are gone and every session of its holder is closed (D91)'
    )
  }

  /** Invitations of the directory whose person is no longer listed: they can never bind (SPACE-MEMB-002/004). */
  private async removeStaleInvitations(): Promise<number> {
    const directory = this.deps.directory
    if (!directory) return 0
    let removed = 0
    for (const space of await this.deps.spaces.all()) {
      for (const row of await this.deps.spaces.memberRows(space.id)) {
        if (row.state !== 'invited' || !row.directoryId || directory.view(row.directoryId)) continue
        await this.deps.store.spaceMembers.delete(row.id)
        await this.deps.spaces.record(space.id, DIRECTORY_ACTOR, 'removed', {
          memberId: row.id,
          directoryId: row.directoryId,
        })
        removed++
      }
    }
    return removed
  }

  /** Revokes every credential issued from an entry the directory no longer holds, and tells its holder. */
  private async revokeIssued(channels: Map<string, Set<string>>): Promise<number> {
    const directory = this.deps.directory
    if (!directory) return 0
    let revoked = 0
    for (const record of await this.deps.evidence.issuedFromDirectory()) {
      const entryId = record.directoryEntryId as string
      if (directory.view(entryId)) continue
      const r = record.revocation
      if (r?.revokedAt && (r.notifiedAt || (r.notifyAttempts ?? 0) >= NOTIFY_ATTEMPTS)) continue
      if (await this.revokeOne(record, entryId, channels.get(entryId))) revoked++
    }
    return revoked
  }

  /**
   * Revokes a credential this agent issued on a connection, which its holder asked to be issued again there
   * (INTX-ISSUE-022, D156): revoked and published now, recorded in the admin audit and on the issuance record, and the
   * holder told on that connection (INTX-FLOW-007), once: a wallet that deleted the credential has nothing to mark.
   * False when it cannot be revoked: no registry, no DIDComm agent, or the revocation failed; nothing is issued then.
   */
  public async revokeForReissue(record: EvidenceRecord): Promise<boolean> {
    const port = this.deps.revocations
    const slot = record.revocation
    if (!port || !slot) return false
    let revokedAt: string
    try {
      revokedAt = await port.revoke(slot)
    } catch (error) {
      this.deps.logger.warn({ err: error, evidenceId: record.id }, 'a credential to be issued again is not revoked')
      return false
    }
    const { lastError: _done, ...rest } = slot as IssuedRevocation
    const revocation: IssuedRevocation = { ...rest, revokedAt, reason: 'issued-again' }
    await this.deps.store.adminAudit.insert({
      id: prefixedId('adm'),
      ts: nowIso(),
      action: 'credential-revocation',
      actor: record.principalId,
      reason: 'issued-again',
      detail: {
        evidenceId: record.id,
        registryDefinitionId: slot.registryDefinitionId,
        index: slot.index,
        revokedAt,
      },
    })
    if (record.connectionRef) {
      revocation.notifyAttempts = 1
      try {
        await port.notify(record.connectionRef, slot, 'Replaced by the one you asked for again.')
        revocation.notifiedAt = nowIso()
      } catch (error) {
        this.deps.logger.warn({ err: error, evidenceId: record.id }, 'the holder was not told of the revocation')
      }
    }
    await this.deps.evidence.setRevocation(record.id, revocation)
    this.deps.logger.info(
      { evidenceId: record.id, registryDefinitionId: slot.registryDefinitionId, index: slot.index },
      'credential revoked: its holder asked for it again (INTX-ISSUE-022)'
    )
    return true
  }

  private async revokeOne(record: EvidenceRecord, entryId: string, holders?: Set<string>): Promise<boolean> {
    const port = this.deps.revocations
    const slot = record.revocation
    if (!slot) {
      // issued under a definition without revocation: it cannot be revoked. Its presenter holds no entry any more, so it
      // gives no role from the directory; it still authenticates a person of the organization
      if (!this.unrevocable.has(record.id))
        this.deps.logger.error(
          { evidenceId: record.id, directoryId: entryId },
          'a credential issued from a removed directory entry has no revocation registry: it cannot be revoked'
        )
      this.unrevocable.add(record.id)
      return false
    }
    if (!port) {
      if (!this.unrevocable.has(record.id))
        this.deps.logger.error({ evidenceId: record.id }, 'no DIDComm agent to revoke with: the credential stays valid')
      this.unrevocable.add(record.id)
      return false
    }
    let revocation: IssuedRevocation = { ...slot }
    let revokedNow = false
    if (!revocation.revokedAt) {
      try {
        const revokedAt = await port.revoke(slot)
        const { lastError: _done, ...rest } = revocation
        revocation = { ...rest, revokedAt, reason: 'directory-removal' }
        revokedNow = true
      } catch (error) {
        revocation.lastError = errorText(error)
        await this.deps.evidence.setRevocation(record.id, revocation)
        this.pending = true
        this.deps.logger.warn(
          { err: error, evidenceId: record.id, directoryId: entryId },
          'a credential of a removed directory entry is not revoked yet: tried again later'
        )
        return false
      }
      await this.deps.store.adminAudit.insert({
        id: prefixedId('adm'),
        ts: nowIso(),
        action: 'credential-revocation',
        actor: DIRECTORY_ACTOR,
        reason: 'directory-removal',
        detail: {
          evidenceId: record.id,
          directoryId: entryId,
          registryDefinitionId: slot.registryDefinitionId,
          index: slot.index,
          revokedAt: revocation.revokedAt,
        },
      })
      this.deps.logger.info(
        {
          evidenceId: record.id,
          directoryId: entryId,
          registryDefinitionId: slot.registryDefinitionId,
          index: slot.index,
        },
        'credential of a removed directory entry revoked (D91)'
      )
    }
    // the holder is told (INTX-FLOW-007): on the connection it was issued on, and on its connection now
    if (!revocation.notifiedAt) {
      const targets = new Set([...(record.connectionRef ? [record.connectionRef] : []), ...(holders ?? [])])
      revocation.notifyAttempts = (revocation.notifyAttempts ?? 0) + 1
      for (const connectionId of targets) {
        try {
          await port.notify(connectionId, slot, 'You are no longer on the list of people of this organization.')
          revocation.notifiedAt = nowIso()
        } catch (error) {
          this.deps.logger.warn({ err: error, evidenceId: record.id }, 'the holder was not told of the revocation')
        }
      }
      if (!revocation.notifiedAt && revocation.notifyAttempts < NOTIFY_ATTEMPTS) this.pending = true
    }
    await this.deps.evidence.setRevocation(record.id, revocation)
    return revokedNow
  }

  // ---- what people see (SPACE-MEMB-005, IDENT-DIR-008/009, PROF-DIR-001/003) --------------------------------

  /**
   * The member picker: to a Principal who owns a list space or may create one, the people whose first or last name
   * contains `q`, with their name and department only; an empty list without a directory.
   */
  public async search(principal: Principal, q: string): Promise<{ people: DirectoryPersonView[] }> {
    if (!(await this.deps.spaces.mayPickPeople(principal)))
      throw new SpaceError('only the owner of a list space, or who may create one, picks people', 'not-creator')
    return {
      people: (this.deps.directory?.search(q) ?? []).map((v) => ({
        directoryId: v.id,
        name: v.name,
        department: v.department ?? null,
      })),
    }
  }

  /** A Principal that holds a role the agent-pack marks `admin` (IDENT-DIR-008). */
  public isAdmin(principal: Principal): boolean {
    const roles = this.deps.pack.identity.roles ?? {}
    return principal.roles.some((r) => roles[r]?.admin === true)
  }

  /** Who holds which role and why: every entry with its roles, and whether a Principal holds it (IDENT-DIR-008). */
  public async adminRoles(principal: Principal): Promise<{ entries: AdminRoleView[] }> {
    if (!this.isAdmin(principal)) throw new SpaceError('only an admin of the agent reads the admin view', 'not-admin')
    const held = new Set(
      (await this.deps.store.principals.list()).map((p) => p.directoryEntryId).filter((id): id is string => !!id)
    )
    return {
      entries: (this.deps.directory?.views() ?? []).map((v) => ({
        directoryId: v.id,
        name: v.name,
        department: v.department ?? null,
        groups: v.groups,
        roles: v.roles,
        onAgent: held.has(v.id),
      })),
    }
  }

  /** What each load of the directory changed, newest first, a page at a time (IDENT-DIR-009). */
  public async adminChanges(
    principal: Principal,
    page: { before?: string; limit?: number } = {}
  ): Promise<{ changes: DirectoryChangeView[]; nextBefore: string | null }> {
    if (!this.isAdmin(principal)) throw new SpaceError('only an admin of the agent reads the admin view', 'not-admin')
    const limit = Math.min(Math.max(1, page.limit ?? 50), 200)
    const rows = await this.deps.store.adminAudit.list(limit + 1, {
      action: 'directory-change',
      ...(page.before ? { before: page.before } : {}),
    })
    const shown = rows.slice(0, limit)
    return {
      changes: shown.map((r) => {
        const d = r.detail as Partial<DirectoryChangeView>
        return {
          id: r.id,
          at: r.ts,
          kind: d.kind as DirectoryChangeView['kind'],
          directoryId: String(d.directoryId ?? ''),
          name: String(d.name ?? ''),
          fields: Array.isArray(d.fields) ? d.fields : [],
          ...(d.rolesBefore ? { rolesBefore: d.rolesBefore } : {}),
          ...(d.rolesAfter ? { rolesAfter: d.rolesAfter } : {}),
        }
      }),
      nextBefore: rows.length > limit ? (shown[shown.length - 1]?.id ?? null) : null,
    }
  }
}

/** One person of the member picker (PROF-DIR-001). */
export interface DirectoryPersonView {
  directoryId: string
  name: string
  department: string | null
}

/** One entry of the admin view of roles (PROF-DIR-003). */
export interface AdminRoleView {
  directoryId: string
  name: string
  department: string | null
  groups: string[]
  roles: string[]
  onAgent: boolean
}

/** One change of the admin view (PROF-DIR-003); `id` is the cursor of `before`. */
export interface DirectoryChangeView {
  id: string
  at: string
  kind: 'added' | 'removed' | 'changed'
  directoryId: string
  name: string
  fields: string[]
  rolesBefore?: string[]
  rolesAfter?: string[]
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}
