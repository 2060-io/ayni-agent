/**
 * One turn at a time per conversation (D63, CORE-MSG-010): the lock of a conversation, and the list, kept in the
 * store, of the messages that wait for it.
 */
import { describe, expect, it } from 'vitest'
import { TurnLock } from '../src/core/turnLock.js'
import { TooManyWaiting, WaitingList } from '../src/core/waiting.js'

/** The outcome of a promise right now: its value, or `pending`. */
async function now<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))])
}
function held(release: (() => void) | undefined | 'pending'): () => void {
  if (typeof release !== 'function') throw new Error(`expected the lock, got ${String(release)}`)
  return release
}

describe('the lock of a conversation', () => {
  it('is taken at once when free, and passed on in the order of arrival', async () => {
    const lock = new TurnLock()
    const first = held(await lock.acquire('c1'))
    expect(lock.busy('c1')).toBe(true)
    const second = lock.acquire('c1')
    const third = lock.acquire('c1')
    expect(await now(second)).toBe('pending')
    first()
    const two = held(await second)
    expect(await now(third)).toBe('pending')
    two()
    held(await third)()
    expect(lock.busy('c1')).toBe(false)
  })

  it('keeps conversations apart', async () => {
    const lock = new TurnLock()
    held(await lock.acquire('c1'))
    held(await lock.acquire('c2'))()
    expect(lock.busy('c1')).toBe(true)
    expect(lock.busy('c2')).toBe(false)
  })

  it('lets a caller give up while it waits, and passes over it', async () => {
    const lock = new TurnLock()
    const first = held(await lock.acquire('c1'))
    const stop = new AbortController()
    const second = lock.acquire('c1', stop.signal)
    const third = lock.acquire('c1')
    stop.abort()
    expect(await second).toBeUndefined()
    first()
    held(await third)()
    expect(lock.busy('c1')).toBe(false)
    // one that had given up before asking never waits
    held(await lock.acquire('c1'))
    expect(await lock.acquire('c1', stop.signal)).toBeUndefined()
  })

  it('is released once only', async () => {
    const lock = new TurnLock()
    const first = held(await lock.acquire('c1'))
    const second = lock.acquire('c1')
    first()
    const two = held(await second)
    // a second release of the first turn must not end the turn that followed it
    first()
    expect(lock.busy('c1')).toBe(true)
    two()
    expect(lock.busy('c1')).toBe(false)
  })
})

describe('the messages that wait, in the store', () => {
  const store = () => {
    const values = new Map<string, string>()
    return {
      values,
      kv: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: string) => {
          values.set(key, value)
        },
      },
    }
  }
  const item = (entryId: string) => ({
    entryId,
    sessionId: 's1',
    messageId: `u_${entryId}`,
    at: '2026-11-14T10:00:00.000Z',
  })

  it('lists them in the order they arrived, by conversation', async () => {
    const list = new WaitingList(store().kv)
    await list.add('c1', item('m2'))
    await list.add('c1', item('m3'))
    await list.add('c2', item('x1'))
    expect((await list.list('c1')).map((w) => w.entryId)).toEqual(['m2', 'm3'])
    expect((await list.list('c2')).map((w) => w.entryId)).toEqual(['x1'])
    expect(await list.list('c3')).toEqual([])
    expect((await list.conversations()).sort()).toEqual(['c1', 'c2'])
  })

  it('is still there for an agent that starts again on the same store', async () => {
    const { kv } = store()
    await new WaitingList(kv).add('c1', item('m2'))
    const after = new WaitingList(kv)
    expect(await after.conversations()).toEqual(['c1'])
    expect((await after.list('c1')).map((w) => w.entryId)).toEqual(['m2'])
  })

  it('takes off what was answered, and forgets a conversation with nothing left', async () => {
    const list = new WaitingList(store().kv)
    await list.add('c1', item('m2'))
    await list.add('c1', item('m3'))
    await list.remove('c1', ['m2'])
    expect((await list.list('c1')).map((w) => w.entryId)).toEqual(['m3'])
    expect(await list.conversations()).toEqual(['c1'])
    await list.remove('c1', ['m3'])
    expect(await list.list('c1')).toEqual([])
    expect(await list.conversations()).toEqual([])
  })

  it('refuses beyond the number it lets wait, and keeps what was there', async () => {
    const list = new WaitingList(store().kv, 2)
    await list.add('c1', item('m2'))
    expect(await list.room('c1')).toBe(true)
    await list.add('c1', item('m3'))
    expect(await list.room('c1')).toBe(false)
    await expect(list.add('c1', item('m4'))).rejects.toBeInstanceOf(TooManyWaiting)
    expect((await list.list('c1')).map((w) => w.entryId)).toEqual(['m2', 'm3'])
  })

  it('writes one at a time: adds made together are all kept', async () => {
    const list = new WaitingList(store().kv)
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => list.add('c1', item(id))))
    expect((await list.list('c1')).map((w) => w.entryId)).toEqual(['a', 'b', 'c', 'd'])
  })
})
