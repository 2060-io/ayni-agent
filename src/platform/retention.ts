/**
 * Retention and media garbage collection (PRIV-RETN-001..003), the retention of evidence (PRIV-EVID-007), and the
 * retention of each space (PRIV-RETN-008, decision 60): the entries of a conversation older than the retention of its
 * space are archived, never deleted and never an entry on legal hold; Personal follows `spaces.personal`.
 */

import type { EvidenceService } from '../core/evidence.js'
import type { SpaceService } from '../core/spaces.js'
import type { ObjectStore } from '../media/objectStore.js'
import type { MemoryService } from '../memory/service.js'
import type { Store } from '../store/types.js'
import type { Logger } from '../util/logger.js'

export class RetentionService {
  public constructor(
    private readonly store: Store,
    private readonly memory: MemoryService,
    private readonly objects: ObjectStore | undefined,
    private readonly spaces: SpaceService,
    private readonly mediaGraceDays: number,
    private readonly logger: Logger,
    private readonly evidence?: EvidenceService
  ) {}

  public async tick(): Promise<void> {
    const archived = await this.archiveSpaces()
    if (archived) this.logger.info({ archived }, 'histories archived')
    await this.collectOrphans()
    // the values of evidence past their retention are archived or erased; the audit fields stay (PRIV-EVID-007)
    await this.evidence?.expire()
  }

  /**
   * The retention of every space (PRIV-RETN-008): each stored space by its own `retentionDays`, every Personal space by
   * `spaces.personal`. A change of a space's retention applies at the next run. Returns how many entries it archived.
   */
  public async archiveSpaces(now = Date.now()): Promise<number> {
    let archived = 0
    for (const space of await this.spaces.all()) {
      const days = space.rules.retentionDays
      if (typeof days !== 'number') continue
      archived += await this.memory.archiveSpaceOlderThan(days, { spaceId: space.id }, now)
    }
    const personal = this.spaces.personalRules().retentionDays
    if (typeof personal === 'number')
      archived += await this.memory.archiveSpaceOlderThan(personal, { personal: true }, now)
    return archived
  }

  /** Objects referenced by any non-deleted entry are kept; orphans older than the grace period go (PRIV-RETN-003). */
  public async collectOrphans(): Promise<number> {
    if (!this.objects) return 0
    const referenced = new Set(
      (await this.store.entries.listAttachmentKeys()).filter((a) => a.state !== 'deleted').map((a) => a.bucketKey)
    )
    const cutoff = Date.now() - this.mediaGraceDays * 86_400_000
    let removed = 0
    for (const o of await this.objects.list()) {
      if (referenced.has(o.key)) continue
      if (o.lastModified && o.lastModified.getTime() > cutoff) continue
      await this.objects.delete(o.key).catch((err) => this.logger.warn({ err, key: o.key }, 'orphan delete failed'))
      removed++
    }
    if (removed) this.logger.info({ removed }, 'orphaned media objects collected')
    return removed
  }
}
