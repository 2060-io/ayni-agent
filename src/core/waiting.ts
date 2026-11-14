/**
 * The messages that wait for the turn in progress of their conversation to end (D63, CORE-MSG-010), kept in the
 * store: they survive a restart of the agent and do not depend on the session that sent them. The message itself
 * is an entry, recorded when it arrived; this is the list of which entries wait, by conversation, in the order
 * they arrived. An entry leaves the list when the turn that answered it has ended, so a turn cut short by a
 * restart is run again.
 */
import type { KvRepo } from '../store/types.js'

/** A message that waits: the entry that holds it and how the channel named it. */
export interface WaitingItem {
  entryId: string
  /** the session it came through */
  sessionId: string
  /** the id the client gave the message */
  messageId?: string
  /** when it arrived */
  at: string
}

/** More wait in a conversation than the agent lets wait (PROF-RUN-011). */
export class TooManyWaiting extends Error {
  public constructor() {
    super('too many messages are waiting in this conversation')
    this.name = 'TooManyWaiting'
  }
}

/** The process was told to end: no turn starts any more (PLAT-DEPLOY-004). */
export class ProcessEnding extends Error {
  public constructor() {
    super('the agent is restarting: try again in a moment')
    this.name = 'ProcessEnding'
  }
}

const PREFIX = 'turn.waiting:'
/** the conversations that have something waiting: the store reads one key at a time */
const INDEX = 'turn.waiting-index'

export class WaitingList {
  /** one write at a time: the list of a conversation is read, changed and written whole */
  private chain: Promise<unknown> = Promise.resolve()

  public constructor(
    private readonly kv: KvRepo,
    /** how many may wait in one conversation */
    private readonly max = 10
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async read<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.kv.get(key)
    if (!raw) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  /** What waits in a conversation, in the order it arrived. */
  public list(key: string): Promise<WaitingItem[]> {
    return this.serial(() => this.read<WaitingItem[]>(PREFIX + key, []))
  }

  /** Whether one more may wait in the conversation. */
  public async room(key: string): Promise<boolean> {
    return (await this.list(key)).length < this.max
  }

  /** Adds a message to those that wait. Throws `TooManyWaiting` beyond the limit. */
  public add(key: string, item: WaitingItem): Promise<void> {
    return this.serial(async () => {
      const items = await this.read<WaitingItem[]>(PREFIX + key, [])
      if (items.length >= this.max) throw new TooManyWaiting()
      await this.kv.set(PREFIX + key, JSON.stringify([...items, item]))
      const index = await this.read<string[]>(INDEX, [])
      if (!index.includes(key)) await this.kv.set(INDEX, JSON.stringify([...index, key]))
    })
  }

  /** Takes messages off the list: the turn that answered them has ended. */
  public remove(key: string, entryIds: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const gone = new Set(entryIds)
      const left = (await this.read<WaitingItem[]>(PREFIX + key, [])).filter((item) => !gone.has(item.entryId))
      await this.kv.set(PREFIX + key, JSON.stringify(left))
      if (left.length) return
      const index = await this.read<string[]>(INDEX, [])
      await this.kv.set(INDEX, JSON.stringify(index.filter((k) => k !== key)))
    })
  }

  /** The conversations that have something waiting: read when the agent starts, to answer what a restart left. */
  public conversations(): Promise<string[]> {
    return this.serial(() => this.read<string[]>(INDEX, []))
  }
}
