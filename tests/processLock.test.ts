/**
 * One agent process at a time on a store (PLAT-DEPLOY-004): the lock a process takes before it touches the store.
 * Here against a connection that plays the server; `scripts/check-process-lock.ts` runs it against PostgreSQL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdProcessLock, type LockConnection, PROCESS_LOCK } from '../src/store/processLock.js'

/** A connection whose server holds the lock for someone else until `free()`. */
function connection(held = false) {
  const listeners: Record<string, ((error?: Error) => void)[]> = { error: [], end: [] }
  const queries: string[] = []
  let granted: (() => void) | undefined
  let answers = true
  const self = {
    queries,
    connected: false,
    ended: false,
    free: () => granted?.(),
    /** the server stops answering, without closing anything */
    silent: () => {
      answers = false
    },
    emit: (event: 'error' | 'end', error?: Error) => {
      for (const listener of listeners[event] ?? []) listener(error)
    },
    connect: async () => {
      self.connected = true
    },
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql)
      if (sql.includes('pg_try_advisory_lock')) {
        expect(params).toEqual([...PROCESS_LOCK])
        return { rows: [{ held: !held }] }
      }
      if (sql.includes('pg_advisory_lock'))
        await new Promise<void>((resolve) => {
          granted = resolve
        })
      if (sql === 'SELECT 1' && !answers) await new Promise(() => undefined)
      return { rows: [] }
    },
    end: async () => {
      self.ended = true
    },
    on: (event: 'error' | 'end', listener: (error?: Error) => void) => {
      listeners[event]?.push(listener)
    },
  }
  return self satisfies LockConnection as typeof self
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the lock of the agent process on its store (PLAT-DEPLOY-004)', () => {
  it('is taken at once when no other process holds it, on a connection the server is asked to probe', async () => {
    const c = connection()
    const onWaiting = vi.fn()
    const release = await holdProcessLock(c, { onWaiting, onLost: vi.fn() })
    expect(c.connected).toBe(true)
    expect(onWaiting).not.toHaveBeenCalled()
    expect(c.queries[0]).toContain('tcp_keepalives_idle')
    expect(c.queries.some((q) => q.includes('pg_advisory_lock('))).toBe(false)
    await release()
  })

  it('waits for as long as another process holds it, and says so', async () => {
    const c = connection(true)
    const onWaiting = vi.fn()
    let mine = false
    const taking = holdProcessLock(c, { onWaiting, onLost: vi.fn() }).then((release) => {
      mine = true
      return release
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onWaiting).toHaveBeenCalledTimes(1)
    expect(mine).toBe(false)
    // the other process is gone: the server gives the lock
    c.free()
    await (await taking)()
    expect(mine).toBe(true)
  })

  it('gives it back by unlocking and closing its connection, and tells no loss for that', async () => {
    const c = connection()
    const onLost = vi.fn()
    const release = await holdProcessLock(c, { onLost })
    await release()
    expect(c.queries[c.queries.length - 1]).toContain('pg_advisory_unlock')
    expect(c.ended).toBe(true)
    // the close it asked for is not a loss
    c.emit('end')
    expect(onLost).not.toHaveBeenCalled()
  })

  it('tells the process that the lock is lost when its connection closes or breaks while it runs', async () => {
    for (const how of ['end', 'error'] as const) {
      const c = connection()
      const onLost = vi.fn()
      await holdProcessLock(c, { onLost })
      c.emit(how, how === 'error' ? new Error('connection reset') : undefined)
      c.emit('end')
      expect(onLost).toHaveBeenCalledTimes(1)
    }
  })

  it('checks that the connection still answers, and tells the loss when it does not', async () => {
    vi.useFakeTimers()
    const c = connection()
    const onLost = vi.fn()
    await holdProcessLock(c, { onLost, checkEveryMs: 1000, checkWithinMs: 300 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.queries.filter((q) => q === 'SELECT 1')).toHaveLength(1)
    expect(onLost).not.toHaveBeenCalled()
    // the machine of the server is gone: nothing answers, nothing closes
    c.silent()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onLost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(onLost).toHaveBeenCalledTimes(1)
    expect(String(onLost.mock.calls[0]?.[0])).toContain('does not answer')
    // told once, and no more checks
    await vi.advanceTimersByTimeAsync(5000)
    expect(onLost).toHaveBeenCalledTimes(1)
  })
})
