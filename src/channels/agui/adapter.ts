/** The AG-UI channel adapter: renders capability events on session streams (CHAN-PROF-005, profile sections 5 and 7). */
import { ACTIVITY, CUSTOM_EVENT } from '@2060.io/ayni-agui-profile'
import type { AyniAgent } from '../../core/agent.js'
import { AGUI_CAPABILITIES, type ChannelAdapter, type RenderResult } from '../../core/channel.js'
import type { CapabilityEvent, Session } from '../../core/types.js'
import { prefixedId } from '../../util/ids.js'
import { ev } from './events.js'
import { approvalValue, attachmentActivity } from './mapping.js'
import type { SessionStreams } from './streams.js'

export class AgUiAdapter implements ChannelAdapter {
  public readonly type = 'ag-ui' as const
  public readonly capabilities = AGUI_CAPABILITIES
  private agent?: AyniAgent

  public constructor(private readonly streams: SessionStreams) {}

  public attach(agent: AyniAgent): void {
    this.agent = agent
  }

  /** Agent-initiated conversation is framed as a server-initiated run (PROF-STREAM-002). */
  private async serverRun(session: Session, body: (runId: string) => Promise<void>): Promise<void> {
    const runId = prefixedId('run')
    await this.streams.publish(session.id, ev.runStarted(session.id, runId))
    await body(runId)
    await this.streams.publish(session.id, ev.runFinished(session.id, runId, { type: 'success' }))
  }

  public async pushState(session: Session): Promise<void> {
    if (!this.agent) return
    const state = await this.agent.ayniState(session)
    await this.streams.publish(session.id, ev.stateSnapshot({ ayni: state }))
  }

  public async render(session: Session, event: CapabilityEvent): Promise<RenderResult> {
    const s = this.streams
    switch (event.kind) {
      case 'text':
        await this.serverRun(session, async () => {
          await s.publish(session.id, ev.textStart(event.entry.id))
          await s.publish(session.id, ev.textContent(event.entry.id, event.entry.text))
          await s.publish(session.id, ev.textEnd(event.entry.id))
        })
        return 'ok'
      case 'menu':
        await this.serverRun(session, async () => {
          await s.publish(
            session.id,
            ev.activitySnapshot(event.entry.id, ACTIVITY.menu, {
              menuId: event.menuId,
              prompt: event.prompt,
              items: event.items,
            })
          )
        })
        return 'ok'
      case 'media':
        // a late artifact: its own run, message id = the entry ordered by initiation time (PROF-MAP-004)
        await this.serverRun(session, async () => {
          for (const a of event.entry.attachments) {
            await s.publish(
              session.id,
              ev.activitySnapshot(a.id, ACTIVITY.attachment, {
                ...attachmentActivity(a, event.entry.role === 'agent' ? 'assistant' : 'user'),
                entryId: event.entry.id,
                initiatedAt: event.entry.initiatedAt,
              })
            )
          }
        })
        await this.pushState(session)
        return 'ok'
      case 'approval': {
        const principal = this.agent ? await this.agent.principalOf(session) : null
        const canDecide =
          !!principal &&
          !!this.agent &&
          this.agent.approvals.isEligible(principal, event.approval) &&
          event.approval.status === 'PENDING'
        const value = approvalValue(event.approval, principal?.id ?? '', canDecide)
        if (event.update)
          await s.publish(
            session.id,
            ev.custom(CUSTOM_EVENT.approvalUpdate, {
              approvalId: value.approvalId,
              status: value.status,
              decidedBy: value.decidedBy,
              grantExpiresAt: value.grantExpiresAt,
            })
          )
        else await s.publish(session.id, ev.custom(CUSTOM_EVENT.approvalRequest, value))
        await this.serverRun(session, async () => {
          await s.publish(
            session.id,
            ev.activitySnapshot(event.entry.id, ACTIVITY.approval, value as unknown as Record<string, unknown>)
          )
        })
        return 'ok'
      }
      case 'reaction':
        await s.publish(
          session.id,
          ev.custom(CUSTOM_EVENT.reaction, {
            messageId: event.messageId,
            emoji: event.emoji,
            action: event.action,
            by: event.by,
          })
        )
        return 'ok'
      case 'receipt':
        await s.publish(
          session.id,
          ev.custom(CUSTOM_EVENT.receipt, { messageIds: event.messageIds, state: event.state })
        )
        return 'ok'
      case 'contextual-menu':
        await this.pushState(session)
        return 'ok'
      case 'generating':
        await this.pushState(session)
        await this.serverRun(session, async () => {
          await s.publish(
            session.id,
            ev.activitySnapshot(event.entryId, ACTIVITY.generating, { entryId: event.entryId, kind: event.kindOf })
          )
        })
        return 'ok'
      case 'routed':
        await s.publish(
          session.id,
          ev.custom(CUSTOM_EVENT.capabilityRouted, {
            kind: event.trustBound,
            challengeType: event.challengeType,
            status: event.status,
            originSessionId: event.originSessionId,
            expiresAt: event.expiresAt,
            message: event.message,
          })
        )
        return 'ok'
    }
  }
}
