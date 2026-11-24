/** The AG-UI channel adapter: renders capability events on session streams (CHAN-PROF-005, profile sections 5 and 7). */
import { ACTIVITY, CUSTOM_EVENT } from '@ayni.org/ayni-agui-profile'
import type { AyniAgent } from '../../core/agent.js'
import { AGUI_CAPABILITIES, type ChannelAdapter, type RenderResult } from '../../core/channel.js'
import type { CapabilityEvent, Session } from '../../core/types.js'
import { prefixedId } from '../../util/ids.js'
import { ev } from './events.js'
import { attachmentActivity } from './mapping.js'
import type { SessionStreams } from './streams.js'

export class AgUiAdapter implements ChannelAdapter {
  public readonly type = 'ag-ui' as const
  public readonly capabilities = AGUI_CAPABILITIES
  private agent?: AyniAgent

  public constructor(private readonly streams: SessionStreams) {}

  public attach(agent: AyniAgent): void {
    this.agent = agent
  }

  /** An attached session stream means a screen is showing the conversation (D57). */
  public isLive(session: Session): boolean {
    return this.streams.subscriberCount(session.id) > 0
  }

  /**
   * Agent-initiated conversation is framed as a server-initiated run (PROF-STREAM-002); when it carries content and
   * no screen of the conversation is live, the phone is woken up (INTX-NOTIFY-001).
   */
  private async serverRun(session: Session, body: (runId: string) => Promise<void>, preview?: string): Promise<void> {
    const runId = prefixedId('run')
    await this.streams.publish(session.id, ev.runStarted(session.id, runId))
    await body(runId)
    await this.streams.publish(session.id, ev.runFinished(session.id, runId, { type: 'success' }))
    if (preview !== undefined && this.agent) await this.agent.notifyIfAway(session, preview).catch(() => undefined)
  }

  public async pushState(session: Session): Promise<void> {
    if (!this.agent) return
    const state = await this.agent.ayniState(session)
    await this.streams.publish(session.id, ev.stateSnapshot({ ayni: state }))
  }

  public async render(
    session: Session,
    event: CapabilityEvent,
    options: { mirror?: boolean } = {}
  ): Promise<RenderResult> {
    // a mirror is shown, never announced: the wake-up of the conversation went with the session that was served
    const quiet = options.mirror === true
    const s = this.streams
    switch (event.kind) {
      case 'text':
        await this.serverRun(
          session,
          async () => {
            await s.publish(session.id, ev.textStart(event.entry.id))
            await s.publish(session.id, ev.textContent(event.entry.id, event.entry.text))
            await s.publish(session.id, ev.textEnd(event.entry.id))
          },
          quiet ? undefined : event.entry.text
        )
        return 'ok'
      case 'menu':
        await this.serverRun(
          session,
          async () => {
            await s.publish(
              session.id,
              ev.activitySnapshot(event.entry.id, ACTIVITY.menu, {
                menuId: event.menuId,
                prompt: event.prompt,
                items: event.items,
              })
            )
          },
          quiet ? undefined : event.prompt
        )
        return 'ok'
      case 'media':
        // a late artifact: its own run, message id = the entry ordered by initiation time (PROF-MAP-004)
        await this.serverRun(
          session,
          async () => {
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
          },
          quiet ? undefined : event.entry.text || 'Sent you a file'
        )
        await this.pushState(session)
        return 'ok'
      case 'approval': {
        // the requester's card, in the one conversation that holds it, replaced in place under its message id by each
        // later status (PROF-TOOL-009); no approver's session receives it, nor `ayni.approval.request` (D114)
        const entry = event.entry
        if (!entry || !this.agent) return 'unsupported'
        const principal = await this.agent.principalOf(session)
        const value = await this.agent.approvalCard(event.approval, principal)
        if (event.update)
          await s.publish(
            session.id,
            ev.custom(CUSTOM_EVENT.approvalUpdate, {
              approvalId: value.approvalId,
              status: value.status,
              decidedBy: value.decidedBy,
              grantExpiresAt: value.grantExpiresAt,
              // where an approval of a space's tool stands, at each decision (PROF-TOOL-037)
              ...(value.progress ? { progress: value.progress } : {}),
            })
          )
        await this.serverRun(session, async () => {
          await s.publish(session.id, ev.activitySnapshot(entry.id, ACTIVITY.approval, value))
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
            flowId: event.flowId,
          })
        )
        return 'ok'
      case 'flow':
        // the card, new or replaced in place under the same message id (PROF-MAP-007)
        await this.serverRun(session, async () => {
          await s.publish(
            session.id,
            ev.activitySnapshot(event.entry.id, ACTIVITY.flow, event.card as unknown as Record<string, unknown>)
          )
        })
        return 'ok'
    }
  }
}
