/**
 * Invitations of people of other organizations (decision 62; ayni-spec D90, §7.4, SPACE-INV-001..005, PROF-SPACE-005,
 * PROF-DIR-002, PLAT-MAIL-002).
 *
 * - **The invitation** is the pair (organization key, email). The owner of a list space finds the organization in the
 *   trust graph and enters the email; the agent refuses an organization that is not on Verana, its own, and one whose
 *   credentials its authentication does not accept, records an `invited` member (the email sealed, with a keyed
 *   index) and sends one email: who invites, to which space, of which agent, the badge needed and the app link to the
 *   agent. The link carries nothing that opens the space: forwarded, it opens nothing.
 * - **It binds** to the first Principal that presents an identity credential whose issuer's organization key (from the
 *   proof) is the invitation's and whose `email` attribute is its address, both in lower case; the member is then
 *   `active` with the role `guest`. A Principal the agent already holds is compared at once on its stored evidence and
 *   asked nothing; one whose stored evidence holds no email is asked once, now when its wallet is connected, else at
 *   its next connection, for a presentation of the authentication schema that reveals it.
 */
import { AUTHENTICATION_ENTRY } from '../config/pack.js'
import type { AgentPack } from '../config/packTypes.js'
import { isEmailAddress, type Mailer } from '../platform/mail.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { EvidenceService } from './evidence.js'
import type { GraphOrganization, TrustGraph } from './organizations.js'
import type { VerifiedFacts } from './principals.js'
import { type OutsiderInvitations, SpaceError, type SpaceService } from './spaces.js'
import type { Principal, Space, SpaceMember } from './types.js'

/** The app link domain the agent sends people to when the deployment names none: mainnet's (profile §10). */
export const DEFAULT_APP_LINK_BASE = 'https://app.ayni.org/app/'

export interface InvitationDeps {
  pack: AgentPack
  store: Store
  spaces: SpaceService
  evidence: EvidenceService
  graph: TrustGraph
  /** the SMTP server of the deployment; without it nobody is invited (PLAT-MAIL-001) */
  mailer?: Mailer
  /** the key and the name of the agent's own organization */
  home(): Promise<{ key?: string; name?: string }>
  /** the DID of the agent, which the app link opens */
  agentDid(): string
  /** where the app links of the network point (`https://app.dev.ayni.org/app/` on devnet) */
  appLinkBase?: string
  /** how a person is named to others: by the directory, else by their credential */
  nameOf(principal: Principal): string
  /** whether the Principal's wallet is connected now */
  isLive(principal: Principal): Promise<boolean>
  /**
   * asks the wallet of an identified Principal for the authentication credential again, revealing its email; what it
   * presents binds through `bindPresented` (SPACE-INV-004)
   */
  reveal?(principal: Principal): Promise<unknown>
  logger: Logger
}

const KEY = /^org:[A-Z]{2}:.+$/

export class InvitationService implements OutsiderInvitations {
  public constructor(private readonly deps: InvitationDeps) {}

  /** Whether invitations can be sent: an SMTP server is configured (PLAT-MAIL-001). */
  public get available(): boolean {
    return !!this.deps.mailer
  }

  /** Whether the authentication asks for `email`: when it does not, a known Principal cannot be asked to reveal it. */
  private get asksEmail(): boolean {
    const authentication = this.deps.pack.identity.authentication?.[0]
    return !!authentication && (!authentication.attributes || authentication.attributes.includes('email'))
  }

  /** The organizations of the trust graph for the member picker, the agent's own excluded (PROF-DIR-002). */
  public async search(principal: Principal, q: string): Promise<{ organizations: GraphOrganization[] }> {
    if (!(await this.deps.spaces.mayPickPeople(principal)))
      throw new SpaceError('only the owner of a list space, or who may create one, invites people', 'not-creator')
    const { key: home } = await this.deps.home()
    let found: GraphOrganization[] = []
    try {
      found = await this.deps.graph.search(q, 21)
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'the trust graph cannot be searched: no organization is found')
    }
    return { organizations: found.filter((o) => o.organizationKey !== home).slice(0, 20) }
  }

  /** Invites a person of another organization to a list space (SPACE-INV-001), for its owner (checked by the space). */
  public async invite(
    principal: Principal,
    space: Space,
    input: { organizationKey: unknown; email: unknown }
  ): Promise<SpaceMember> {
    const key = typeof input.organizationKey === 'string' ? input.organizationKey.trim() : ''
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    if (!KEY.test(key))
      throw new SpaceError(
        'organizationKey is a key of the trust graph, org:<country>:<register id>',
        'bad-request',
        'organizationKey'
      )
    if (!isEmailAddress(email)) throw new SpaceError('email is not an email address', 'bad-request', 'email')
    const mailer = this.deps.mailer
    if (!mailer) throw new SpaceError('this agent sends no email: it invites nobody', 'email-unavailable')
    const home = await this.deps.home()
    if (home.key && key === home.key)
      throw new SpaceError('the people of this organization are added from the directory', 'home-organization')
    // its people could never authenticate (IDENT-RES-018)
    const accepted = this.deps.pack.identity.authentication?.[0]?.issuers?.organizations
    if (accepted && !accepted.includes(key))
      throw new SpaceError(
        'this agent does not accept the credentials of that organization',
        'organization-not-accepted'
      )
    let organization: GraphOrganization | undefined
    try {
      organization = await this.deps.graph.find(key)
    } catch (error) {
      // the graph cannot say the organization is on Verana: it is not invited (fail closed)
      this.deps.logger.warn(
        { err: error, organizationKey: key },
        'the trust graph cannot be asked: the invitation is refused'
      )
    }
    if (!organization)
      throw new SpaceError('this organization is not found trusted in the trust graph', 'not-on-verana')
    const rows = await this.deps.spaces.memberRows(space.id)
    const existing = rows.find((m) => m.organizationKey === key && m.email?.toLowerCase() === email)
    if (existing && existing.state !== 'left') throw new SpaceError('this person is invited already', 'already-member')
    const now = nowIso()
    const row: SpaceMember = {
      ...(existing ?? { id: prefixedId('mem'), spaceId: space.id, createdAt: now }),
      principalId: null,
      organizationKey: key,
      organizationName: organization.name,
      email,
      state: 'invited',
      role: 'guest',
      askedPrincipalIds: [],
      updatedAt: now,
    }
    await this.deps.spaces.saveMember(row)
    // one email, or no invitation: an owner is not told a person was invited who was not (SPACE-INV-001)
    try {
      await mailer.send(this.email(principal, space, organization, email, home.name))
    } catch (error) {
      this.deps.logger.error(
        { err: error, spaceId: space.id, memberId: row.id },
        'the invitation email could not be sent'
      )
      if (existing) await this.deps.spaces.saveMember(existing)
      else await this.deps.store.spaceMembers.delete(row.id)
      throw new SpaceError('the invitation email could not be sent', 'email-unavailable')
    }
    await this.deps.spaces.record(space.id, principal.id, 'invited', { memberId: row.id })
    this.deps.logger.info(
      { spaceId: space.id, memberId: row.id, organizationKey: key },
      'a person of another organization invited (SPACE-INV-001)'
    )
    return (await this.settle(row)) ?? row
  }

  /**
   * The invitation email (SPACE-INV-002, PLAT-MAIL-002): who invites, to which space, of which agent and organization, the
   * badge needed, and the app link to the agent. No token, no code, nothing of any conversation.
   */
  private email(
    principal: Principal,
    space: Space,
    organization: GraphOrganization,
    email: string,
    homeName: string | undefined
  ) {
    const agent = this.deps.pack.metadata.displayName
    const inviter = this.deps.nameOf(principal)
    const of = homeName ? `${agent}, the agent of ${homeName}` : agent
    const base = (this.deps.appLinkBase ?? DEFAULT_APP_LINK_BASE).replace(/\/*$/, '/')
    const link = `${base}service/${this.deps.agentDid()}`
    return {
      to: email,
      subject: `${inviter} invites you to "${space.title}" with ${agent}`,
      text: [
        `${inviter} invites you to the space "${space.title}" of ${of}.`,
        '',
        `To join, connect to ${agent} with the Ayni app and authenticate with a badge issued by ${organization.name} that carries this address, ${email}. This link opens the agent in the Ayni app:`,
        '',
        link,
        '',
        'The link opens nothing by itself: the space opens to the badge of your organization that carries this address.',
        '',
      ].join('\n'),
    }
  }

  /**
   * At its creation, an invitation is compared with the Principals of that organization the agent holds (SPACE-INV-004):
   * the one whose stored email matches is bound at once, and asked nothing; one whose stored evidence holds no email is
   * asked once for it, now when its wallet is connected, else at its next connection.
   */
  private async settle(row: SpaceMember): Promise<SpaceMember | undefined> {
    const key = row.organizationKey as string
    const email = row.email as string
    const silent: Principal[] = []
    const principals = (await this.deps.store.principals.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const principal of principals) {
      const stored = await this.storedEmail(principal, key)
      if (stored === undefined) continue
      if (stored === null) {
        silent.push(principal)
        continue
      }
      if (stored === email) return this.bind(row, principal)
    }
    if (!silent.length) return undefined
    if (!this.asksEmail) {
      this.deps.logger.warn(
        { memberId: row.id, principals: silent.length },
        'Principals of the invited organization hold no email, and the authentication does not ask for it: they cannot be asked (SPACE-INV-004)'
      )
      return undefined
    }
    const asked: string[] = []
    for (const principal of silent) {
      if (!(await this.deps.isLive(principal))) continue
      asked.push(principal.id)
      void this.ask(principal)
    }
    if (asked.length) {
      const next = { ...row, askedPrincipalIds: [...(row.askedPrincipalIds ?? []), ...asked], updatedAt: nowIso() }
      await this.deps.spaces.saveMember(next)
      return next
    }
    return undefined
  }

  /**
   * The email of the identity credential of a Principal of an organization, as its stored evidence holds it: the address
   * in lower case; null when the evidence holds none; undefined when the Principal is not of that organization.
   */
  private async storedEmail(principal: Principal, organizationKey: string): Promise<string | null | undefined> {
    const record = await this.deps.evidence.latest(principal.id, AUTHENTICATION_ENTRY)
    if (record?.state !== 'active' || record.issuerOrganization?.key !== organizationKey) return undefined
    const values = await this.deps.evidence.values(principal.id, AUTHENTICATION_ENTRY)
    const email = values?.email?.trim().toLowerCase()
    return email || null
  }

  private async ask(principal: Principal): Promise<void> {
    if (!this.deps.reveal) return
    this.deps.logger.info(
      { principalId: principal.id },
      'asked for a presentation that reveals the email (SPACE-INV-004)'
    )
    await this.deps
      .reveal(principal)
      .catch((err) =>
        this.deps.logger.warn({ err, principalId: principal.id }, 'the email of an invited person was not asked')
      )
  }

  private async bind(row: SpaceMember, principal: Principal): Promise<SpaceMember> {
    const next: SpaceMember = { ...row, principalId: principal.id, state: 'active', role: 'guest', updatedAt: nowIso() }
    await this.deps.spaces.saveMember(next)
    await this.deps.spaces.record(row.spaceId, principal.id, 'joined', { memberId: row.id, principalId: principal.id })
    this.deps.logger.info(
      { spaceId: row.spaceId, memberId: row.id, principalId: principal.id },
      'an invitation of another organization bound (SPACE-INV-003)'
    )
    return next
  }

  /**
   * An identity credential is presented (SPACE-INV-003): the invitations whose organization key is that of its issuer, as
   * the proof gives it, and whose address is its `email` attribute, bind to its Principal. Anything else grants nothing.
   */
  public async bindPresented(principal: Principal, facts: VerifiedFacts): Promise<number> {
    const evidence = facts.evidence
    if (evidence?.entry !== AUTHENTICATION_ENTRY || evidence.outcome === 'refused') return 0
    const key = evidence.issuerOrganization?.key ?? facts.organization?.key
    const email = (evidence.values.email ?? '').trim().toLowerCase()
    if (!key || !email) return 0
    let bound = 0
    for (const row of await this.deps.spaces.invitationsOf(key, email)) {
      if (row.state !== 'invited' || row.email?.toLowerCase() !== email) continue
      if (!(await this.deps.spaces.find(row.spaceId))) continue
      await this.bind(row, principal)
      bound++
    }
    return bound
  }

  /**
   * A Principal connects: the invitations of its organization that wait, and for which it was not asked yet, ask it once
   * for its email when its stored evidence holds none (SPACE-INV-004).
   */
  public async onConnected(principal: Principal): Promise<void> {
    if (!this.asksEmail) return
    const record = await this.deps.evidence.latest(principal.id, AUTHENTICATION_ENTRY)
    const key = record?.issuerOrganization?.key
    if (!key || (await this.storedEmail(principal, key)) !== null) return
    const waiting: SpaceMember[] = []
    for (const space of await this.deps.spaces.all())
      for (const row of await this.deps.spaces.memberRows(space.id))
        if (row.state === 'invited' && row.organizationKey === key && !row.askedPrincipalIds?.includes(principal.id))
          waiting.push(row)
    if (!waiting.length) return
    for (const row of waiting)
      await this.deps.spaces.saveMember({
        ...row,
        askedPrincipalIds: [...(row.askedPrincipalIds ?? []), principal.id],
        updatedAt: nowIso(),
      })
    await this.ask(principal)
  }
}
