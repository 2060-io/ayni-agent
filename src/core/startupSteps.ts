/**
 * The start-up steps that need the DIDComm agent (IDENT-SELF-005, INTX-ISSUE-017, PLAT-DEPLOY-006): learning its DID, declaring the
 * AG-UI descriptor in its DID Document, establishing the credential definitions of the issuance profiles, asking whether
 * it speaks the peer status. The DIDComm agent may come up after this agent, as on a deployment that restarts both: each
 * step is tried at once and, until it is done, tried again in the background with a growing delay, without holding the
 * HTTP server or any other step. The first failure of a step is logged, and its success after failures, once; the
 * attempts between are logged at debug.
 */
import type { Logger } from '../util/logger.js'

/** One step: true when it is done; false or a throw when the DIDComm agent did not answer as it needs. */
export type StartupTask = () => Promise<boolean>

export interface StartupStep {
  /** settles with the first attempt: true when it was done at once */
  readonly firstAttempt: Promise<boolean>
  /** resolves once the step is done, whichever attempt did it; never when the steps stop before */
  readonly done: Promise<void>
}

export interface StartupRetry {
  /** the delay before the second attempt, doubled at each attempt after */
  firstDelayMs: number
  /** the longest delay between two attempts */
  maxDelayMs: number
}

export const STARTUP_RETRY: StartupRetry = { firstDelayMs: 1_000, maxDelayMs: 60_000 }

export class StartupSteps {
  private readonly timers = new Set<NodeJS.Timeout>()
  private stopped = false

  public constructor(
    private readonly logger: Logger,
    private readonly retry: StartupRetry = STARTUP_RETRY
  ) {}

  /** Runs a step now, and again until it is done (or the steps stop). */
  public run(name: string, task: StartupTask): StartupStep {
    let settleFirst!: (done: boolean) => void
    let finish!: () => void
    const firstAttempt = new Promise<boolean>((resolve) => {
      settleFirst = resolve
    })
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    let attempts = 0
    const attempt = async (): Promise<void> => {
      if (this.stopped) return settleFirst(false)
      attempts++
      let ok = false
      let error: unknown
      try {
        ok = await task()
      } catch (e) {
        error = e
      }
      settleFirst(ok)
      if (ok) {
        if (attempts > 1) this.logger.info({ step: name, attempts }, 'start-up step done: the DIDComm agent answered')
        finish()
        return
      }
      if (this.stopped) return
      const delay = Math.min(this.retry.firstDelayMs * 2 ** (attempts - 1), this.retry.maxDelayMs)
      if (attempts === 1)
        this.logger.warn(
          { step: name, ...(error ? { err: error } : {}), retryInMs: delay },
          'start-up step not done: the DIDComm agent did not answer; tried again until it does'
        )
      else
        this.logger.debug(
          { step: name, attempts, ...(error ? { err: error } : {}), retryInMs: delay },
          'start-up step not done yet'
        )
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        void attempt()
      }, delay)
      timer.unref()
      this.timers.add(timer)
    }
    void attempt()
    return { firstAttempt, done }
  }

  /** No step is tried again: the process stops. */
  public stop(): void {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}

/** Waits for a promise at most `ms`: true when it resolved true in time. */
export async function within(promise: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    timer.unref()
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}
