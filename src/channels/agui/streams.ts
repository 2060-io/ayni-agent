/**
 * Session event streams (profile section 5, PROF-STREAM-001..004): one long-lived SSE stream per
 * session with monotonic ids and resumption from Last-Event-ID through a replay buffer.
 */
import type { Store } from '../../store/types.js'
import type { Logger } from '../../util/logger.js'
import { type AgUiEvent, sse } from './events.js'

interface Subscriber {
  write(chunk: string): void
  end(): void
}

const REPLAY_LIMIT = 500

export class SessionStreams {
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly replay = new Map<string, { id: number; chunk: string }[]>()

  public constructor(
    private readonly store: Store,
    private readonly logger: Logger
  ) {}

  public async publish(sessionId: string, event: AgUiEvent): Promise<number> {
    const id = await this.store.sessions.nextStreamCursor(sessionId)
    const chunk = sse(event, id)
    const buffer = this.replay.get(sessionId) ?? []
    buffer.push({ id, chunk })
    if (buffer.length > REPLAY_LIMIT) buffer.splice(0, buffer.length - REPLAY_LIMIT)
    this.replay.set(sessionId, buffer)
    for (const sub of this.subscribers.get(sessionId) ?? []) {
      try {
        sub.write(chunk)
      } catch (error) {
        this.logger.debug({ err: error }, 'stream write failed')
      }
    }
    return id
  }

  /** Replays events after `lastEventId`, then attaches; returns the detach function. */
  public attach(sessionId: string, subscriber: Subscriber, lastEventId?: number): () => void {
    if (lastEventId !== undefined) {
      for (const item of this.replay.get(sessionId) ?? []) if (item.id > lastEventId) subscriber.write(item.chunk)
    }
    const set = this.subscribers.get(sessionId) ?? new Set()
    set.add(subscriber)
    this.subscribers.set(sessionId, set)
    return () => {
      set.delete(subscriber)
      if (set.size === 0) this.subscribers.delete(sessionId)
    }
  }

  public subscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0
  }

  public end(sessionId: string): void {
    for (const sub of this.subscribers.get(sessionId) ?? []) {
      try {
        sub.end()
      } catch {
        // closed already
      }
    }
    this.subscribers.delete(sessionId)
    this.replay.delete(sessionId)
  }
}
