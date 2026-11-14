/**
 * One turn at a time per conversation (D63, CORE-MSG-010): what arrives while a turn runs waits, and is taken
 * together when the turn ends.
 */
import { describe, expect, it } from 'vitest'
import { type Entered, TooManyWaiting, TurnGate } from '../src/core/turnGate.js'

/** The outcome of a promise right now: its value, or `pending`. */
async function now<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))])
}
function running<T>(entered: Entered<T> | 'pending'): { items: T[]; release: () => void } {
  if (entered === 'pending' || entered.kind !== 'run')
    throw new Error(`expected a turn to run, got ${JSON.stringify(entered)}`)
  return entered
}

describe('the gate of a conversation', () => {
  it('lets a turn run at once when none is in progress', async () => {
    const gate = new TurnGate<string>()
    const first = running(await gate.enter('c1', 'a'))
    expect(first.items).toEqual(['a'])
    expect(gate.busy('c1')).toBe(true)
    first.release()
    expect(gate.busy('c1')).toBe(false)
    // and the next one runs at once too
    expect(running(await gate.enter('c1', 'b')).items).toEqual(['b'])
  })

  it('makes what arrives during a turn wait, and takes it together when the turn ends', async () => {
    const gate = new TurnGate<string>()
    const first = running(await gate.enter('c1', 'a'))
    const second = gate.enter('c1', 'b')
    const third = gate.enter('c1', 'c')
    expect(await now(second)).toBe('pending')
    expect(await now(third)).toBe('pending')
    expect(gate.waiting('c1')).toEqual(['b', 'c'])

    first.release()
    // the last to arrive carries the turn with both, in the order they came; the other is told who answers it
    expect(await second).toEqual({ kind: 'merged', into: 'c' })
    const next = running(await third)
    expect(next.items).toEqual(['b', 'c'])
    expect(gate.waiting('c1')).toEqual([])
    expect(gate.busy('c1')).toBe(true)

    // what arrives during that turn waits in its turn
    const fourth = gate.enter('c1', 'd')
    expect(await now(fourth)).toBe('pending')
    next.release()
    expect(running(await fourth).items).toEqual(['d'])
  })

  it('keeps conversations apart', async () => {
    const gate = new TurnGate<string>()
    running(await gate.enter('c1', 'a'))
    expect(running(await gate.enter('c2', 'x')).items).toEqual(['x'])
    expect(gate.waiting('c1')).toEqual([])
  })

  it('withdraws a caller that gives up while it waits, and leaves the others', async () => {
    const gate = new TurnGate<string>()
    const first = running(await gate.enter('c1', 'a'))
    const stop = new AbortController()
    const second = gate.enter('c1', 'b', stop.signal)
    const third = gate.enter('c1', 'c')
    stop.abort()
    expect(await second).toEqual({ kind: 'withdrawn' })
    expect(gate.waiting('c1')).toEqual(['c'])
    first.release()
    expect(running(await third).items).toEqual(['c'])
  })

  it('does not withdraw a caller once it is taken', async () => {
    const gate = new TurnGate<string>()
    const first = running(await gate.enter('c1', 'a'))
    const stop = new AbortController()
    const second = gate.enter('c1', 'b', stop.signal)
    first.release()
    const next = running(await second)
    // the signal now cancels the turn itself, which is the turn's business: the gate stays held
    stop.abort()
    expect(gate.busy('c1')).toBe(true)
    next.release()
    expect(gate.busy('c1')).toBe(false)
  })

  it('never lets a caller that had already given up wait', async () => {
    const gate = new TurnGate<string>()
    running(await gate.enter('c1', 'a'))
    const stop = new AbortController()
    stop.abort()
    expect(await gate.enter('c1', 'b', stop.signal)).toEqual({ kind: 'withdrawn' })
    expect(gate.waiting('c1')).toEqual([])
  })

  it('refuses beyond the number it lets wait', async () => {
    const gate = new TurnGate<string>(2)
    running(await gate.enter('c1', 'a'))
    void gate.enter('c1', 'b')
    void gate.enter('c1', 'c')
    await expect(gate.enter('c1', 'd')).rejects.toBeInstanceOf(TooManyWaiting)
    expect(gate.waiting('c1')).toEqual(['b', 'c'])
  })

  it('releases once only', async () => {
    const gate = new TurnGate<string>()
    const first = running(await gate.enter('c1', 'a'))
    const second = gate.enter('c1', 'b')
    first.release()
    const next = running(await second)
    // a second release of the first turn must not end the turn that followed it
    first.release()
    expect(gate.busy('c1')).toBe(true)
    next.release()
  })

  it('says each time what waits changes', async () => {
    const changes: string[] = []
    const gate = new TurnGate<string>(10, (key) => changes.push(`${key}:${gate.waiting(key).join(',')}`))
    const first = running(await gate.enter('c1', 'a'))
    const stop = new AbortController()
    void gate.enter('c1', 'b', stop.signal)
    const third = gate.enter('c1', 'c')
    stop.abort()
    first.release()
    await third
    expect(changes).toEqual(['c1:b', 'c1:b,c', 'c1:c', 'c1:'])
  })
})
