/**
 * One turn at a time per conversation (D63, CORE-MSG-010). A turn enters the gate of its conversation: when none
 * is in progress it runs; otherwise it waits. When the turn in progress ends, everything that waits is taken
 * together: the last to arrive carries the next turn with all of them, in the order they came, and the others are
 * told which one answers them. A caller that gives up while it waits is withdrawn and never ran.
 *
 * The gate is in the memory of the process: one replica of the agent serves a conversation.
 */

/** What entering the gate leads to. */
export type Entered<T> =
  /** this caller runs the turn, with what waited before it; `release` when the turn has ended */
  | { kind: 'run'; items: T[]; release: () => void }
  /** another caller's turn answers this one */
  | { kind: 'merged'; into: T }
  /** the caller gave up while it waited */
  | { kind: 'withdrawn' }

/** More wait in a conversation than the agent lets wait (PROF-RUN-011). */
export class TooManyWaiting extends Error {
  public constructor() {
    super('too many messages are waiting in this conversation')
    this.name = 'TooManyWaiting'
  }
}

interface Waiter<T> {
  item: T
  settle(entered: Entered<T>): void
  /** stops listening for the caller giving up */
  detach(): void
}

interface Gate<T> {
  waiting: Waiter<T>[]
}

export class TurnGate<T> {
  /** the conversations with a turn in progress */
  private readonly gates = new Map<string, Gate<T>>()

  public constructor(
    /** how many may wait in one conversation */
    private readonly maxWaiting = 10,
    /** called each time what waits in a conversation changes */
    private readonly onChange: (key: string) => void = () => undefined
  ) {}

  /** What waits in a conversation, in the order it arrived. */
  public waiting(key: string): T[] {
    return (this.gates.get(key)?.waiting ?? []).map((w) => w.item)
  }

  /** Whether a turn of the conversation is in progress. */
  public busy(key: string): boolean {
    return this.gates.has(key)
  }

  /**
   * Enters the conversation's gate. Resolves at once when no turn is in progress, else when the caller is taken
   * (to run, or answered by another's turn) or gives up. Throws `TooManyWaiting` beyond the limit.
   */
  public enter(key: string, item: T, signal?: AbortSignal): Promise<Entered<T>> {
    const gate = this.gates.get(key)
    if (!gate) {
      this.gates.set(key, { waiting: [] })
      return Promise.resolve({ kind: 'run', items: [item], release: this.releaser(key) })
    }
    if (signal?.aborted) return Promise.resolve({ kind: 'withdrawn' })
    if (gate.waiting.length >= this.maxWaiting) return Promise.reject(new TooManyWaiting())
    return new Promise<Entered<T>>((resolve) => {
      const withdraw = () => {
        const at = gate.waiting.indexOf(waiter)
        if (at < 0) return // already taken: its turn runs, or another's answers it
        gate.waiting.splice(at, 1)
        resolve({ kind: 'withdrawn' })
        this.onChange(key)
      }
      const waiter: Waiter<T> = {
        item,
        settle: resolve,
        detach: () => signal?.removeEventListener('abort', withdraw),
      }
      signal?.addEventListener('abort', withdraw, { once: true })
      gate.waiting.push(waiter)
      this.onChange(key)
    })
  }

  /** Ends the turn in progress, once: what waits is taken into the next turn, or the conversation is free. */
  private releaser(key: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const gate = this.gates.get(key)
      if (!gate) return
      const taken = gate.waiting.splice(0)
      if (!taken.length) {
        this.gates.delete(key)
        return
      }
      for (const waiter of taken) waiter.detach()
      // the last to arrive carries the turn: its reply follows the latest message, on the device that sent it
      const carrier = taken[taken.length - 1] as Waiter<T>
      for (const waiter of taken) if (waiter !== carrier) waiter.settle({ kind: 'merged', into: carrier.item })
      carrier.settle({ kind: 'run', items: taken.map((w) => w.item), release: this.releaser(key) })
      this.onChange(key)
    }
  }
}
