/**
 * Verana anchoring (D26, INTEG-ANCHOR-001..004): a digest over each batch of persisted entries is
 * written to the ledger with the VPR store-digest module, asynchronously, retry-queued, never
 * blocking. Local anchor records are kept indefinitely.
 */
import { createHash } from 'node:crypto'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate'
import { createVeranaRegistry, veranaTypeUrls } from '@verana-labs/verana-types'
import type { DigestAnchor } from '../core/types.js'
import type { Store } from '../store/types.js'
import { nowIso, prefixedId } from '../util/ids.js'
import type { Logger } from '../util/logger.js'

export interface LedgerWriter {
  storeDigest(digest: string): Promise<string>
}

export class VeranaLedgerWriter implements LedgerWriter {
  private client?: SigningStargateClient
  private address?: string

  public constructor(
    private readonly rpcUrl: string,
    private readonly mnemonic: string,
    private readonly authority: string,
    private readonly gasPrice = '1uvna'
  ) {}

  private async connect(): Promise<{ client: SigningStargateClient; address: string }> {
    if (this.client && this.address) return { client: this.client, address: this.address }
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, { prefix: 'verana' })
    const [account] = await wallet.getAccounts()
    this.client = await SigningStargateClient.connectWithSigner(this.rpcUrl, wallet, {
      registry: createVeranaRegistry(),
      gasPrice: GasPrice.fromString(this.gasPrice),
    })
    this.address = account.address
    return { client: this.client, address: account.address }
  }

  public async storeDigest(digest: string): Promise<string> {
    const { client, address } = await this.connect()
    const msg = {
      typeUrl: veranaTypeUrls.MsgStoreDigest,
      value: { authority: this.authority, operator: address, digest },
    }
    const result = await client.signAndBroadcast(address, [msg], 'auto', 'hologram-agent anchor')
    if (result.code !== 0) throw new Error(`store-digest failed: code ${result.code} ${result.rawLog ?? ''}`)
    return result.transactionHash
  }
}

/** The digest over a batch: SHA-256 of the ordered entry digests, which are themselves over ciphertext (INTEG-DIG-002). */
export function batchDigest(contentDigests: string[]): string {
  return createHash('sha256').update(contentDigests.join('\n')).digest('base64')
}

export class AnchoringService {
  public constructor(
    private readonly store: Store,
    private readonly ledger: LedgerWriter | undefined,
    private readonly maxBatchEntries: number,
    private readonly logger: Logger
  ) {}

  /** Builds the next batch from unanchored entries and records it locally before the ledger write. */
  public async batch(): Promise<DigestAnchor | undefined> {
    const entries = await this.store.entries.listUnanchored(this.maxBatchEntries)
    if (entries.length === 0) return undefined
    const anchor: DigestAnchor = {
      batchId: prefixedId('bat'),
      digest: batchDigest(entries.map((e) => e.contentDigest)),
      entryCount: entries.length,
      firstEntryId: entries[0].id,
      lastEntryId: entries[entries.length - 1].id,
      attempts: 0,
      createdAt: nowIso(),
    }
    await this.store.anchors.save(anchor)
    await this.store.entries.markAnchored(
      entries.map((e) => e.id),
      anchor.batchId
    )
    return anchor
  }

  /** Retries pending batches, best effort; failures stay queued (INTEG-ANCHOR-002). */
  public async flush(): Promise<void> {
    if (!this.ledger) return
    for (const anchor of await this.store.anchors.listPending()) {
      anchor.attempts += 1
      try {
        anchor.ledgerTxRef = await this.ledger.storeDigest(anchor.digest)
        anchor.anchoredAt = nowIso()
        anchor.lastError = undefined
        this.logger.info(
          { batchId: anchor.batchId, tx: anchor.ledgerTxRef, entries: anchor.entryCount },
          'batch anchored'
        )
      } catch (error) {
        anchor.lastError = error instanceof Error ? error.message : String(error)
        this.logger.warn(
          { batchId: anchor.batchId, attempt: anchor.attempts, err: anchor.lastError },
          'anchoring failed, will retry'
        )
      }
      await this.store.anchors.save(anchor)
    }
  }

  public async tick(): Promise<void> {
    await this.batch()
    await this.flush()
  }

  /** Verifies the chain for one batch: recomputed digest equals the anchored one (INTEG-DIG-002). */
  public async verify(batchId: string): Promise<{ ok: boolean; expected: string; actual?: string }> {
    const anchors = await this.store.anchors.list()
    const anchor = anchors.find((a) => a.batchId === batchId)
    if (!anchor) return { ok: false, expected: '' }
    const ids: string[] = []
    let cursor: string | undefined
    void cursor
    // entries are marked with the batch id; recompute in creation order
    const all = (await this.store.entries.listOlderThan('9999-12-31T00:00:00.000Z', 'active', 100000)).filter(
      (e) => e.anchorBatchId === batchId
    )
    const archived = (await this.store.entries.listOlderThan('9999-12-31T00:00:00.000Z', 'archived', 100000)).filter(
      (e) => e.anchorBatchId === batchId
    )
    const erased = (await this.store.entries.listOlderThan('9999-12-31T00:00:00.000Z', 'crypto-erased', 100000)).filter(
      (e) => e.anchorBatchId === batchId
    )
    const entries = [...all, ...archived, ...erased].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    )
    for (const e of entries) ids.push(e.contentDigest)
    const actual = batchDigest(ids)
    return { ok: actual === anchor.digest, expected: anchor.digest, actual }
  }
}
