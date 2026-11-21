/**
 * The Notifications of a space and of the agent (ayni-spec D114; INTX-APPR-006, INTX-APPR-017; profile §3.12,
 * PROF-TOOL-024, PROF-TOOL-025): what concerns one person there, pending and past. In this version they list approvals
 * only: a space's, the approvals of its tools, which its owner decides; the agent's, every other approval (one decided by
 * roles, of a tool of the whole agent or of Personal, and an elevation request). A person finds there each approval they
 * may decide, or could decide while it waited, and each request they sent, read-only. A confirmation is never listed.
 *
 * Nothing is stored for them: a list is read from the approval records, each of which names the approvers it was asked
 * of (`approverIds`) and when it ended (`closedAt`). An item carries what the request carries and nothing else of the
 * conversation it was asked in (D83, D86).
 */
import {
  NOTIFICATIONS_PAGE,
  type NotificationApproval,
  type NotificationItem,
  type NotificationsPage,
  type SpaceNotificationsChangedValue,
} from '@ayni.org/ayni-agui-profile'
import { type ApprovalService, needsAttestation } from '../policy/approvals.js'
import type { Store } from '../store/types.js'
import type { ApprovalRecord, Principal } from './types.js'

const DAY_MS = 86_400_000

/**
 * The place that lists an approval (INTX-APPR-017): the space of a tool of a space, which its owner approves; null, the
 * agent's Notifications, for any other.
 */
export function placeOf(record: Pick<ApprovalRecord, 'ownerApproval' | 'spaceId'>): string | null {
  return record.ownerApproval && record.spaceId ? record.spaceId : null
}

export interface NotificationDeps {
  store: Store
  approvals: ApprovalService
  /** the content of an approval's card as a viewer reads it (PROF-TOOL-009): the action, the space, the requester */
  card: (record: ApprovalRecord, viewer: Principal) => Promise<Record<string, unknown>>
  /** the retention, in days, of a space; of the viewer's Personal space for the agent's Notifications (D84) */
  retentionDays: (place: string | null, viewer: Principal) => Promise<number>
  /** the label of an elevation's purpose, from the governance list */
  purposeLabel: (purposeId: string) => string | undefined
}

export class Notifications {
  /** tells a person's open sessions that a notification of theirs entered, changed or ended (PROF-TOOL-025) */
  public announce?: (principalId: string, value: SpaceNotificationsChangedValue) => Promise<void>

  public constructor(private readonly deps: NotificationDeps) {}

  /** Whether the viewer may decide the approval now: it waits, they are eligible and they have not decided it. */
  private async canDecide(record: ApprovalRecord, viewer: Principal): Promise<boolean> {
    if (record.status !== 'PENDING' || record.requesterId === viewer.id) return false
    if (record.decisions.some((d) => d.approverId === viewer.id)) return false
    return this.deps.approvals.isEligible(viewer, record)
  }

  /** Whether an approval is in the viewer's Notifications, while its retention runs (INTX-APPR-017). */
  private async lists(record: ApprovalRecord, viewer: Principal, now = Date.now()): Promise<boolean> {
    if (record.kind === 'confirmation') return false
    const concerned =
      record.requesterId === viewer.id ||
      !!record.approverIds?.includes(viewer.id) ||
      record.decisions.some((d) => d.approverId === viewer.id) ||
      (await this.canDecide(record, viewer))
    if (!concerned) return false
    if (record.status === 'PENDING') return true
    const ended = Date.parse(record.closedAt ?? record.updatedAt)
    return ended + (await this.deps.retentionDays(placeOf(record), viewer)) * DAY_MS > now
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
      attested: needsAttestation(record),
      myDecision: record.status === 'PENDING' && mine ? mine.decision : null,
      decisions: record.decisions.map((d) => ({ by: { displayName: d.approverName }, decision: d.decision, at: d.ts })),
      ...(record.kind === 'elevation' && record.purpose
        ? {
            purpose: { id: record.purpose, label: this.deps.purposeLabel(record.purpose) ?? record.purpose },
            justification: record.justification ?? '',
          }
        : {}),
      ...(record.status !== 'PENDING' ? { closedAt: record.closedAt ?? record.updatedAt } : {}),
    }
    return { id: record.id, kind: 'approval', at: record.createdAt, waiting: canDecide, approval }
  }

  /** Every approval of a place the viewer's Notifications list, newest first. */
  private async listed(viewer: Principal, place: string | null): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = []
    const now = Date.now()
    for (const record of await this.deps.store.approvals.list({}))
      if (placeOf(record) === place && (await this.lists(record, viewer, now))) out.push(record)
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
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
    for (const record of slice) notifications.push(await this.item(record, viewer))
    let waiting = 0
    for (const record of all) if (await this.canDecide(record, viewer)) waiting++
    const last = slice.at(-1)
    return { notifications, nextBefore: last && from + limit < all.length ? last.id : null, waiting }
  }

  /** What waits for the viewer in each place: the badge of each space's row and of the agent's entry (PROF-TOOL-025). */
  public async waiting(viewer: Principal): Promise<Map<string | null, number>> {
    const counts = new Map<string | null, number>()
    for (const record of await this.deps.store.approvals.list({ status: 'PENDING' })) {
      if (record.kind === 'confirmation' || !(await this.canDecide(record, viewer))) continue
      const place = placeOf(record)
      counts.set(place, (counts.get(place) ?? 0) + 1)
    }
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
    const place = placeOf(record)
    for (const id of ids) {
      const viewer = await this.deps.store.principals.get(id)
      if (!viewer) continue
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
}
