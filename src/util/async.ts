export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class Deferred<T> {
  public readonly promise: Promise<T>
  public resolve!: (value: T) => void
  public reject!: (error: unknown) => void
  public constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

/** Runs a function on an interval, never overlapping, swallowing (and reporting) errors. */
export function schedule(
  name: string,
  everyMs: number,
  fn: () => Promise<void>,
  onError: (name: string, error: unknown) => void
): () => void {
  let running = false
  let stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      await fn()
    } catch (error) {
      onError(name, error)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, everyMs)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
