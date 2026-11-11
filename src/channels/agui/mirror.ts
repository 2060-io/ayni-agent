/**
 * The mirror of a run (profile PROF-STREAM-005, IDENT-SESS-016): what a run of one session adds to its conversation
 * is sent, as it happens, to the other sessions of that conversation (the person's other devices) on their streams,
 * inside a server-initiated run. The person's message goes under the agent's id for it, the one history gives it;
 * the reply keeps the message ids of the originating run. Text deltas are grouped over a short interval, so a long
 * reply does not cost one stream write per token on every device.
 */
import type { MessageEntry } from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import { type AgUiEvent, ev } from './events.js'
import { entryToMessages } from './mapping.js'
import type { SessionStreams } from './streams.js'

const GROUP_MS = 120

export class RunMirror {
  private queue: Promise<void> = Promise.resolve()
  private started = false
  private readonly deltas = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined

  public constructor(
    private readonly streams: Pick<SessionStreams, 'publish'>,
    /** the ids of the other bound sessions of the conversation */
    private readonly targets: readonly string[],
    private readonly runId: string,
    private readonly logger: Logger,
    private readonly groupMs = GROUP_MS
  ) {}

  /** One event to every target, in order. */
  private send(event: (target: string) => AgUiEvent): void {
    this.queue = this.queue.then(async () => {
      for (const target of this.targets) {
        await this.streams
          .publish(target, event(target))
          .catch((err) => this.logger.debug({ err, target }, 'mirror publish failed'))
      }
    })
  }

  /** The run is opened on the targets with the first thing to show: a run that adds nothing mirrors nothing. */
  private open(): void {
    if (this.started) return
    this.started = true
    this.send((target) => ev.runStarted(target, this.runId))
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const [messageId, delta] of this.deltas) this.send(() => ev.textContent(messageId, delta))
    this.deltas.clear()
  }

  /** An event of the run, as its own response carries it. */
  public event(event: AgUiEvent): void {
    if (!this.targets.length) return
    this.open()
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      const id = String(event.messageId)
      this.deltas.set(id, `${this.deltas.get(id) ?? ''}${String(event.delta ?? '')}`)
      this.timer ??= setTimeout(() => this.flush(), this.groupMs)
      return
    }
    this.flush()
    this.send(() => event)
  }

  /** The person's message as the other devices show it: what history will give for the entry. */
  public inbound(entry: MessageEntry): void {
    if (!this.targets.length) return
    for (const message of entryToMessages(entry)) {
      if (message.role === 'activity') {
        this.event(
          ev.activitySnapshot(String(message.id), String(message.activityType), {
            ...(message.content as Record<string, unknown>),
            entryId: entry.id,
          })
        )
        continue
      }
      const id = String(message.id)
      this.event(ev.textStart(id, 'user'))
      this.event(ev.textContent(id, String(message.content ?? '')))
      this.event(ev.textEnd(id))
    }
  }

  /** The end of the run, as it ended for the session that made it. */
  public finish(error?: { message: string; code: string }): void {
    if (!this.started) return
    this.flush()
    if (error) this.send(() => ev.runError(error.message, error.code))
    else this.send((target) => ev.runFinished(target, this.runId, { type: 'success' }))
  }

  /** Resolves when everything sent so far is on the targets' streams. */
  public settled(): Promise<void> {
    return this.queue
  }
}
