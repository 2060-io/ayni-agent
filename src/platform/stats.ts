/** Statistics (D44, PLAT-STATS-001..003): non-blocking ingest into a Redis stream or direct HTTP; query API over the relational store. */
import type Redis from 'ioredis'
import type { StatEvent } from '../core/types.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'

export const STATS_STREAM = 'ayni-agent:stats'

export interface StatsSink {
  emit(statClass: string, value: number, dimensions?: Record<string, string>): void
  drain?(): Promise<number>
}

export class NoopStats implements StatsSink {
  public emit(): void {}
}

export class RedisStreamStats implements StatsSink {
  public constructor(
    private readonly redis: Redis,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly group = 'ayni-agent'
  ) {}

  public emit(statClass: string, value: number, dimensions: Record<string, string> = {}): void {
    const event: StatEvent = { id: prefixedId('st'), ts: nowIso(), statClass, value, dimensions }
    this.redis
      .xadd(STATS_STREAM, '*', 'event', JSON.stringify(event))
      .catch((err) => this.logger.warn({ err }, 'stats emit failed'))
  }

  /** Consumer group: moves events from the stream into the store (PLAT-STATS-002). */
  public async drain(): Promise<number> {
    try {
      await this.redis.xgroup('CREATE', STATS_STREAM, this.group, '0', 'MKSTREAM')
    } catch {
      // group exists
    }
    const batch = (await this.redis.xreadgroup(
      'GROUP',
      this.group,
      'worker',
      'COUNT',
      500,
      'STREAMS',
      STATS_STREAM,
      '>'
    )) as [string, [string, string[]][]][] | null
    if (!batch) return 0
    const events: StatEvent[] = []
    const ids: string[] = []
    for (const [, messages] of batch) {
      for (const [id, fields] of messages) {
        const idx = fields.indexOf('event')
        if (idx >= 0) events.push(JSON.parse(fields[idx + 1]) as StatEvent)
        ids.push(id)
      }
    }
    if (events.length) await this.store.stats.insert(events)
    if (ids.length) await this.redis.xack(STATS_STREAM, this.group, ...ids)
    return events.length
  }
}

export class HttpStats implements StatsSink {
  public constructor(
    private readonly url: string,
    private readonly logger: Logger
  ) {}
  public emit(statClass: string, value: number, dimensions: Record<string, string> = {}): void {
    const event: StatEvent = { id: prefixedId('st'), ts: nowIso(), statClass, value, dimensions }
    fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    }).catch((err) => this.logger.warn({ err }, 'stats http ingest failed'))
  }
}

/** Direct ingest into the relational store when no stream is configured. */
export class StoreStats implements StatsSink {
  public constructor(
    private readonly store: Store,
    private readonly logger: Logger
  ) {}
  public emit(statClass: string, value: number, dimensions: Record<string, string> = {}): void {
    const event: StatEvent = { id: prefixedId('st'), ts: nowIso(), statClass, value, dimensions }
    this.store.stats.insert([event]).catch((err) => this.logger.warn({ err }, 'stats insert failed'))
  }
}
