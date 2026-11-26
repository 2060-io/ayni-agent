/**
 * The Notifications of a space and of the agent (ayni-spec D114, D142; INTX-APPR-006, INTX-APPR-017, INTX-APPR-022,
 * INTX-APPR-027; profile §3.12, PROF-TOOL-024, PROF-TOOL-025, PROF-TOOL-038): what concerns one person there, pending and
 * past. They list approvals and the notices of a space's governance: a space's, the approvals of its tools and its
 * notices; the agent's, every other approval (one decided by roles, of a tool of the whole agent or of Personal, an
 * elevation request, and the approval of a space's tool for an approver who is not a member of the space), and the
 * notices of a space without an owner, for its stewards. A person finds there each approval they may decide, or could
 * decide while it waited, each request they sent, read-only, and their own confirmation of their own request, which
 * they decide. A confirmation is never listed.
 *
 * Approvals are read from their records, each of which names the approvers it was asked of (`approverIds`) and when it
 * ended (`closedAt`); notices are records of their own, one per person. An item carries what the request carries and
 * nothing else of the conversation it was asked in (D83, D86).
 */
import {
  NOTIFICATIONS_PAGE,
  type NotificationApproval,
  type NotificationItem,
  type NotificationsPage,
  type SpaceNotificationsChangedValue,
} from '@ayni.org/ayni-agui-profile'
import type { ApprovalService } from '../policy/approvals.js'
import { attestedFor } from '../policy/spacePolicy.js'
import type { Store } from '../store/types.js'
import type { ApprovalRecord, GovernanceNotice, Principal } from './types.js'

const DAY_MS = 86_400_000

export interface NotificationDeps {
  store: Store
  approvals: ApprovalService
  /** the content of an approval's card as a viewer reads it (PROF-TOOL-009): the action, the space, the requester */
  card: (record: ApprovalRecord, viewer: Principal) => Promise<Record<string, unknown>>
  /** the retention, in days, of a space; of the viewer's Personal space for the agent's Notifications (D84) */
  retentionDays: (place: string | null, viewer: Principal) => Promise<number>
  /** the label of an elevation's purpose, from the governance list */
  purposeLabel: (purposeId: string) => string | undefined
  /** whether a person is an active member of a space: its Notifications are theirs (INTX-APPR-022) */
  isMember: (viewer: Principal, spaceId: string) => Promise<boolean>
}

/** One entry of a person's Notifications, before it is read: an approval or a notice. */
type Listed = { kind: 'approval'; at: string; id: string; record: ApprovalRecord } | GovernanceListed
type GovernanceListed = { kind: 'notice'; at: string; id: string; notice: GovernanceNotice }

/**
 * Whether a notice waits for its person: a policy that needs attention, a space without an owner, a member whose access to
 * the managed folder failed (PROF-TOOL-042), until resolved.
 */
export function noticeWaits(notice: GovernanceNotice): boolean {
  return (
    !notice.resolvedAt &&
    (notice.kind === 'policy-attention' || notice.kind === 'space-without-owner' || notice.kind === 'folder-access')
  )
}

/** The place that lists a notice: the agent's for a space without an owner (its stewards), else the space's. */
export function noticePlace(notice: Pick<GovernanceNotice, 'kind' | 'spaceId'>): string | null {
  return notice.kind === 'space-without-owner' ? null : notice.spaceId
}

export class Notifications {
  /** tells a person's open sessions that a notification of theirs entered, changed or ended (PROF-TOOL-025) */
  public announce?: (principalId: string, value: SpaceNotificationsChangedValue) => Promise<void>

  public constructor(private readonly deps: NotificationDeps) {}

  /**
   * The place that lists an approval for a viewer (INTX-APPR-017, INTX-APPR-022): the space of a tool of a space, for a
   * member of it; the agent's Notifications for any other approval, and for an approver who is not a member.
   */
  public async placeOf(
    record: Pick<ApprovalRecord, 'spaceId' | 'spacePolicy'>,
    viewer: Principal
  ): Promise<string | null> {
    if (!record.spacePolicy || !record.spaceId) return null
    return (await this.deps.isMember(viewer, record.spaceId)) ? record.spaceId : null
  }

  /**
   * Whether the viewer may decide the approval now: it waits, they are eligible and they have not decided it. The requester
   * decides only their own confirmation of a tool of a space (INTX-APPR-023).
   */
  private async canDecide(record: ApprovalRecord, viewer: Principal): Promise<boolean> {
    if (record.status !== 'PENDING') return false
    if (record.requesterId === viewer.id && !record.spacePolicy) return false
    if (record.decisions.some((d) => d.approverId === viewer.id)) return false
    return this.deps.approvals.isEligible(viewer, record)
  }

  /** Whether an approval is in the viewer's Notifications, while its retention runs (INTX-APPR-017). */
  private async lists(record: ApprovalRecord, viewer: Principal, place: string | null, now: number): Promise<boolean> {
    if (record.kind === 'confirmation') return false
    const concerned =
      record.requesterId === viewer.id ||
      !!record.approverIds?.includes(viewer.id) ||
      record.decisions.some((d) => d.approverId === viewer.id) ||
      (await this.canDecide(record, viewer))
    if (!concerned) return false
    if (record.status === 'PENDING') return true
    const ended = Date.parse(record.closedAt ?? record.updatedAt)
    return ended + (await this.deps.retentionDays(place, viewer)) * DAY_MS > now
  }

  /** Whether a notice is listed: while the retention of its space runs from when it was made, or resolved. */
  private async listsNotice(notice: GovernanceNotice, viewer: Principal, now: number): Promise<boolean> {
    if (noticeWaits(notice)) return true
    const from = Date.parse(notice.resolvedAt ?? notice.at)
    return from + (await this.deps.retentionDays(noticePlace(notice), viewer)) * DAY_MS > now
  }

  /** An item of the Notifications, as the viewer may read it (§3.12). */
  public async item(record: ApprovalRecord, viewer: Principal): Promise<NotificationItem> {
    const card = await this.deps.card(record, viewer)
    const canDecide = await this.canDecide(record, viewer)
    const mine = record.decisions.find((d) => d.approverId === viewer.id)
    const approval: NotificationApproval = {
      ...(card as unknown as NotificationApproval),
      approvalId: record.id,
      kind: record.kind,
      status: record.status,
      expiresAt: record.expiresAt,
      own: record.requesterId === viewer.id,
      canDecide,
      attested: attestedFor(record, viewer.id),
      myDecision: record.status === 'PENDING' && mine ? mine.decision : null,
      decisions: record.decisions.map((d) => ({
        by: { displayName: d.approverName },
        decision: d.decision,
        at: d.ts,
        ...(d.self ? { self: true } : {}),
      })),
      ...(record.kind === 'elevation' && record.purpose
        ? {
            purpose: { id: record.purpose, label: this.deps.purposeLabel(record.purpose) ?? record.purpose },
            justification: record.justification ?? '',
          }
        : {}),
      ...(record.status !== 'PENDING' ? { closedAt: record.closedAt ?? record.updatedAt } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    }
    return { id: record.id, kind: 'approval', at: record.createdAt, waiting: canDecide, approval }
  }

  /** A notice as its person reads it (§3.12, PROF-TOOL-038, PROF-TOOL-042). */
  public noticeItem(notice: GovernanceNotice): NotificationItem {
    const s = notice.subject
    // a member whose access to the managed folder failed, to the owner (PROF-TOOL-042)
    if (notice.kind === 'folder-access')
      return {
        id: notice.id,
        kind: notice.kind,
        at: notice.at,
        waiting: noticeWaits(notice),
        folderAccess: {
          member: s.member ?? { name: '' },
          feature: s.feature ?? { id: '', title: '' },
          source: s.source ?? { id: '', title: '' },
          folder: s.folder ?? { title: '' },
          reason: s.folderReason ?? 'unavailable',
        },
      }
    const base = { space: s.space }
    const body =
      notice.kind === 'owner-changed'
        ? {
            ...base,
            how: s.how,
            from: s.from ?? null,
            to: s.to ?? null,
            ...(s.reason ? { reason: s.reason } : {}),
          }
        : notice.kind === 'policy-attention'
          ? { ...base, tool: { source: s.tool?.source, title: s.tool?.title }, entries: s.entries ?? [] }
          : notice.kind === 'no-approver'
            ? { ...base, tool: { source: s.tool?.source, title: s.tool?.title }, requester: s.requester }
            : { ...base, template: s.template, formerOwner: s.formerOwner ?? null }
    return {
      id: notice.id,
      kind: notice.kind,
      at: notice.at,
      waiting: noticeWaits(notice),
      notice: { ...body, ...(notice.resolvedAt ? { resolvedAt: notice.resolvedAt } : {}) },
    } as unknown as NotificationItem
  }

  /** Everything a place of the viewer's Notifications lists, newest first. */
  private async listed(viewer: Principal, place: string | null): Promise<Listed[]> {
    const out: Listed[] = []
    const now = Date.now()
    for (const record of await this.deps.store.approvals.list({})) {
      if (record.kind === 'confirmation') continue
      if ((await this.placeOf(record, viewer)) !== place) continue
      if (await this.lists(record, viewer, place, now))
        out.push({ kind: 'approval', at: record.createdAt, id: record.id, record })
    }
    for (const notice of await this.deps.store.governanceNotices.list({ principalId: viewer.id }))
      if (noticePlace(notice) === place && (await this.listsNotice(notice, viewer, now)))
        out.push({ kind: 'notice', at: notice.at, id: notice.id, notice })
    return out.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
  }

  /**
   * A page of the Notifications of a space, or of the agent when `place` is null (PROF-TOOL-024): newest first, after the
   * item `before` names, `limit` of them (50 by default, 200 at most), with what waits in the whole place.
   */
  public async list(
    viewer: Principal,
    place: string | null,
    page: { before?: string; limit?: number } = {}
  ): Promise<NotificationsPage> {
    const all = await this.listed(viewer, place)
    const limit = Math.min(Math.max(1, Math.floor(page.limit ?? NOTIFICATIONS_PAGE.default)), NOTIFICATIONS_PAGE.max)
    const from = page.before ? all.findIndex((r) => r.id === page.before) + 1 : 0
    const slice = from > 0 || !page.before ? all.slice(from, from + limit) : []
    const notifications: NotificationItem[] = []
    for (const each of slice)
      notifications.push(each.kind === 'approval' ? await this.item(each.record, viewer) : this.noticeItem(each.notice))
    let waiting = 0
    for (const each of all)
      if (each.kind === 'approval' ? await this.canDecide(each.record, viewer) : noticeWaits(each.notice)) waiting++
    const last = slice.at(-1)
    return { notifications, nextBefore: last && from + limit < all.length ? last.id : null, waiting }
  }

  /** What waits for the viewer in each place: the badge of each space's row and of the agent's entry (PROF-TOOL-025). */
  public async waiting(viewer: Principal): Promise<Map<string | null, number>> {
    const counts = new Map<string | null, number>()
    const add = (place: string | null) => counts.set(place, (counts.get(place) ?? 0) + 1)
    for (const record of await this.deps.store.approvals.list({ status: 'PENDING' })) {
      if (record.kind === 'confirmation' || !(await this.canDecide(record, viewer))) continue
      add(await this.placeOf(record, viewer))
    }
    for (const notice of await this.deps.store.governanceNotices.list({ principalId: viewer.id, open: true }))
      if (noticeWaits(notice)) add(noticePlace(notice))
    return counts
  }

  /**
   * An approval entered, changed or ended: every person whose Notifications list it hears it, on every open session
   * (PROF-TOOL-025): its approvers, those who decided it, and its requester.
   */
  public async changed(record: ApprovalRecord): Promise<void> {
    if (record.kind === 'confirmation' || !this.announce) return
    const ids = new Set<string>([record.requesterId, ...(record.approverIds ?? [])])
    for (const d of record.decisions) ids.add(d.approverId)
    for (const p of await this.deps.approvals.approversOf(record)) ids.add(p.id)
    for (const id of ids) {
      const viewer = await this.deps.store.principals.get(id)
      if (!viewer) continue
      const place = await this.placeOf(record, viewer)
      const counts = await this.waiting(viewer)
      await this.announce(id, {
        spaceId: place,
        id: record.id,
        kind: 'approval',
        waiting: await this.canDecide(record, viewer),
        count: counts.get(place) ?? 0,
      })
    }
  }

  /** A notice entered or was resolved: its person hears it, with no status (PROF-TOOL-038). */
  public async noticeChanged(notice: GovernanceNotice): Promise<void> {
    if (!this.announce) return
    const viewer = await this.deps.store.principals.get(notice.principalId)
    if (!viewer) return
    const place = noticePlace(notice)
    const counts = await this.waiting(viewer)
    await this.announce(notice.principalId, {
      spaceId: place,
      id: notice.id,
      kind: notice.kind,
      waiting: noticeWaits(notice),
      count: counts.get(place) ?? 0,
    })
  }
}
