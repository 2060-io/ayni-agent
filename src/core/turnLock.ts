/**
 * One turn at a time per conversation (D63, CORE-MSG-010): the lock a turn holds while it runs. A caller that finds
 * it held waits its turn, in the order of arrival, unless it gives up meanwhile.
 *
 * The lock is in the memory of the process, as the turn in progress is: one replica of the agent serves a
 * conversation. What the person sends during a turn does not wait here: it is recorded and listed in the store
 * (`WaitingList`), and answered when the lock is next free.
 */
export class TurnLock {
  /** the conversations with a turn in progress, and who waits for each */
  private readonly held = new Map<string, { take(): void }[]>()

  /** Whether a turn of the conversation is in progress. */
  public busy(key: string): boolean {
    return this.held.has(key)
  }

  /**
   * Takes the conversation's lock: at once when it is free, else when those before have released it. Resolves
   * with the function that releases it (once), or with nothing when the caller gave up while it waited.
   */
  public acquire(key: string, signal?: AbortSignal): Promise<(() => void) | undefined> {
    const waiters = this.held.get(key)
    if (!waiters) {
      this.held.set(key, [])
      return Promise.resolve(this.releaser(key))
    }
    if (signal?.aborted) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const giveUp = () => {
        const at = waiters.indexOf(waiter)
        if (at < 0) return // taken already: the turn is the caller's now
        waiters.splice(at, 1)
        resolve(undefined)
      }
      const waiter = {
        take: () => {
          signal?.removeEventListener('abort', giveUp)
          resolve(this.releaser(key))
        },
      }
      signal?.addEventListener('abort', giveUp, { once: true })
      waiters.push(waiter)
    })
  }

  private releaser(key: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.held.get(key)?.shift()
      if (next) next.take()
      else this.held.delete(key)
    }
  }
}
