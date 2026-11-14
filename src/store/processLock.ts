/**
 * One agent process at a time on a store (PLAT-DEPLOY-004, D63): the turn in progress and its lock live in the
 * memory of the process, so two processes on one store each answer what waits. A process takes this lock before
 * it touches the store and keeps it for its life; a second one waits here until the first is gone.
 *
 * It is a PostgreSQL advisory lock of the session: nothing is written, the lock lives in the server's memory and
 * belongs to one connection. The server drops it when that connection closes, however the process ended, so no
 * lock is ever left behind. Two things follow, and are handled here:
 *
 *  - a holder that dies without closing its connection (its machine is gone) keeps the lock until the server
 *    notices: the connection asks the server to probe it, so that it does within half a minute;
 *  - a holder that loses the connection while it still runs holds nothing any more: it is told (`onLost`), and
 *    must stop.
 *
 * The lock needs a connection of its own that stays the same from start to end: a pooler that hands a server
 * connection to another client between statements (transaction pooling) breaks it.
 */

/** The part of a database client the lock uses: one connection, not a pool. */
export interface LockConnection {
  connect(): Promise<unknown>
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<unknown>
  on(event: 'error' | 'end', listener: (error?: Error) => void): unknown
}

export interface ProcessLockOptions {
  /** another process holds the lock: this one waits */
  onWaiting?: () => void
  /** the lock is no longer this process's, which still runs: it must stop */
  onLost: (error?: Error) => void
  /** how often the holder checks that its connection still answers */
  checkEveryMs?: number
  /** how long a check may take */
  checkWithinMs?: number
}

/** The lock's name in the database: the two integers of an advisory lock ("AYNI", the agent process). */
export const PROCESS_LOCK = [0x41594e49, 1] as const

/** The server probes the connection after this long without news, then this often, and gives up after this many. */
const KEEPALIVE = { idle: 10, interval: 5, count: 3 }

/**
 * Takes the lock, waiting for it as long as another process holds it. Resolves with the way to give it back,
 * which a process calls as the last thing before it closes the store.
 */
export async function holdProcessLock(
  connection: LockConnection,
  { onWaiting, onLost, checkEveryMs = 10_000, checkWithinMs = 5_000 }: ProcessLockOptions
): Promise<() => Promise<void>> {
  let done = false
  let check: ReturnType<typeof setInterval> | undefined
  const lost = (error?: Error) => {
    if (done) return
    done = true
    if (check) clearInterval(check)
    onLost(error)
  }
  // from the first moment: a connection that breaks while this process waits or holds is the same loss
  connection.on('error', lost)
  connection.on('end', () => lost())
  await connection.connect()
  await connection.query(
    `SET tcp_keepalives_idle = ${KEEPALIVE.idle}; SET tcp_keepalives_interval = ${KEEPALIVE.interval}; SET tcp_keepalives_count = ${KEEPALIVE.count}`
  )
  const [first] = (await connection.query('SELECT pg_try_advisory_lock($1, $2) AS held', [...PROCESS_LOCK])).rows
  if (first?.held !== true) {
    onWaiting?.()
    await connection.query('SELECT pg_advisory_lock($1, $2)', [...PROCESS_LOCK])
  }

  let checking = false
  check = setInterval(() => {
    if (checking || done) return
    checking = true
    let late: ReturnType<typeof setTimeout> | undefined
    const within = new Promise<never>((_, reject) => {
      late = setTimeout(() => reject(new Error('the lock connection does not answer')), checkWithinMs)
    })
    Promise.race([connection.query('SELECT 1'), within])
      .catch((error: Error) => lost(error))
      .finally(() => {
        if (late) clearTimeout(late)
        checking = false
      })
  }, checkEveryMs)
  check.unref?.()

  return async () => {
    if (done) return
    done = true
    if (check) clearInterval(check)
    // closing the connection is what gives the lock back; the unlock only does it a moment sooner
    await connection.query('SELECT pg_advisory_unlock($1, $2)', [...PROCESS_LOCK]).catch(() => undefined)
    await connection.end().catch(() => undefined)
  }
}
