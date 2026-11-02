/**
 * Per-peer capability profiles (D54, CHAN-PROF-006): the disclosure recorded from the DIDComm agent's
 * connection event decides whether a wallet is flow-capable; a waiter gets it as it lands.
 */
import { describe, expect, it } from 'vitest'
import { AYNI_FLOW_PROTOCOL, PeerProfiles } from '../src/channels/didcomm/peerProfiles.js'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }

function kv() {
  const rows = new Map<string, string>()
  return { get: async (k: string) => rows.get(k), set: async (k: string, v: string) => void rows.set(k, v) }
}

const feature = (id: string, roles?: string[]) =>
  JSON.stringify({ 'feature-type': 'protocol', id, ...(roles ? { roles } : {}) })

describe('peer profiles', () => {
  it('records the disclosed protocols and recognizes the Ayni flow profile', async () => {
    const peers = new PeerProfiles(kv(), silent as never)
    await peers.record('c1', {
      [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL, ['holder']),
      'https://didcomm.org/authorize/1.0': feature('https://didcomm.org/authorize/1.0'),
      'https://didcomm.org/basicmessage/1.0': feature('https://didcomm.org/basicmessage/1.0'),
    })
    expect(await peers.isFlowCapable('c1')).toBe(true)
    expect(await peers.supports('c1', 'https://didcomm.org/authorize/1.0')).toBe(true)
    expect(await peers.supports('c1', 'https://didcomm.org/authorize/1.3')).toBe(true) // same major
    expect(await peers.supports('c1', 'https://didcomm.org/sign-tx/1.0')).toBe(false)
    expect((await peers.get('c1'))?.roles[AYNI_FLOW_PROTOCOL]).toEqual(['holder'])
  })

  it('serves a wallet without the flow profile as in v3', async () => {
    const peers = new PeerProfiles(kv(), silent as never)
    await peers.record('c2', {
      'https://didcomm.org/basicmessage/1.0': feature('https://didcomm.org/basicmessage/1.0'),
    })
    expect(await peers.isFlowCapable('c2')).toBe(false)
    expect(await peers.isFlowCapable('unknown')).toBe(false)
  })

  it('merges a later disclosure and survives a cold cache', async () => {
    const store = kv()
    const peers = new PeerProfiles(store, silent as never)
    await peers.record('c3', {
      'https://didcomm.org/basicmessage/1.0': feature('https://didcomm.org/basicmessage/1.0'),
    })
    await peers.record('c3', { [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL) })
    const fresh = new PeerProfiles(store, silent as never)
    expect((await fresh.get('c3'))?.protocols).toHaveLength(2)
    expect(await fresh.isFlowCapable('c3')).toBe(true)
    await fresh.forget('c3')
    expect(await fresh.get('c3')).toBeUndefined()
  })

  it('hands a disclosure to a waiter as it lands, or times out', async () => {
    const peers = new PeerProfiles(kv(), silent as never)
    const waiting = peers.awaitDisclosure('c4', 1_000)
    await peers.record('c4', { [AYNI_FLOW_PROTOCOL]: feature(AYNI_FLOW_PROTOCOL) })
    expect((await waiting)?.protocols).toEqual([AYNI_FLOW_PROTOCOL])
    expect(await peers.awaitDisclosure('c5', 20)).toBeUndefined()
  })
})
