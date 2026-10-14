/** Retention and media garbage collection (PRIV-RETN-001..003). */

import type { ObjectStore } from '../media/objectStore.js'
import type { MemoryService } from '../memory/service.js'
import type { Store } from '../store/types.js'
import type { Logger } from '../util/logger.js'

export class RetentionService {
  public constructor(
    private readonly store: Store,
    private readonly memory: MemoryService,
    private readonly objects: ObjectStore | undefined,
    private readonly historyDays: number,
    private readonly mediaGraceDays: number,
    private readonly logger: Logger
  ) {}

  public async tick(): Promise<void> {
    const archived = await this.memory.archiveOlderThan(this.historyDays)
    if (archived) this.logger.info({ archived }, 'histories archived')
    await this.collectOrphans()
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
