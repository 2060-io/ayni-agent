/**
 * The delivery of an issued credential to a person (D70, INTX-ISSUE-004): a credential offer on the
 * capability channel of the Principal, an `issue` flow on a flow-capable wallet, and the wait for what the
 * wallet does with it. The claims are those the issuance service resolved; nothing here reads the model.
 */
import type { FlowService } from '../../core/flows.js'
import { Deferred } from '../../util/async.js'
import type { Logger } from '../../util/logger.js'
import type { CredentialExchangeRecord, VsAgentClient } from './vsAgentClient.js'

type OfferOutcome = { outcome: 'issued' | 'declined' | 'failed'; exchangeId?: string }

export class CredentialOffers {
  private readonly pending = new Map<string, { deferred: Deferred<'issued' | 'declined'>; timer: NodeJS.Timeout }>()

  public constructor(
    private readonly client: Pick<VsAgentClient, 'offerCredential'>,
    private readonly flows: FlowService | undefined,
    private readonly isFlowCapable: (connectionId: string) => Promise<boolean>,
    private readonly logger: Logger,
    private readonly timeoutMs = 120_000
  ) {}

  /** Called by the webhook when a credential exchange changes state. */
  public onExchange(record: CredentialExchangeRecord): void {
    const pending = this.pending.get(record.credentialExchangeId)
    if (!pending) return
    const outcome =
      record.state === 'done' ? 'issued' : ['declined', 'abandoned'].includes(record.state) ? 'declined' : undefined
    if (!outcome) return
    clearTimeout(pending.timer)
    this.pending.delete(record.credentialExchangeId)
    pending.deferred.resolve(outcome)
  }

  public async offer(input: {
    connectionId: string
    credentialDefinitionId: string
    claims: Record<string, string>
    title: string
  }): Promise<OfferOutcome> {
    const flowMode = !!this.flows && (await this.isFlowCapable(input.connectionId))
    const handle = flowMode
      ? await this.flows?.open({
          connectionId: input.connectionId,
          kind: 'issue',
          title: input.title,
          expiresInMs: this.timeoutMs,
        })
      : undefined
    let exchangeId: string
    try {
      exchangeId = (
        await this.client.offerCredential({
          connectionId: input.connectionId,
          credentialDefinitionId: input.credentialDefinitionId,
          claims: Object.entries(input.claims).map(([name, value]) => ({ name, value })),
          autoAccept: true,
          ...(handle ? { parentThreadId: handle.flowId } : {}),
        })
      ).credentialExchangeId
    } catch (error) {
      this.logger.warn({ err: error, connectionId: input.connectionId }, 'credential offer could not be sent')
      if (handle) await this.flows?.close(handle.flowId, 'failed', { reason: 'The offer could not be sent.' })
      return { outcome: 'failed' }
    }
    const deferred = new Deferred<'issued' | 'declined'>()
    const timer = setTimeout(() => {
      this.pending.delete(exchangeId)
      deferred.resolve('declined')
    }, this.timeoutMs)
    this.pending.set(exchangeId, { deferred, timer })
    // whichever ends first settles it: the exchange, or the holder closing the flow
    const closed = handle ? this.flows?.waitForClose(handle.flowId).then(() => 'closed' as const) : undefined
    const first = await Promise.race([deferred.promise, ...(closed ? [closed] : [])])
    if (first === 'closed') {
      const waiting = this.pending.get(exchangeId)
      if (waiting) clearTimeout(waiting.timer)
      this.pending.delete(exchangeId)
      return { outcome: 'declined', exchangeId }
    }
    if (handle) {
      await this.flows?.close(handle.flowId, first === 'issued' ? 'completed' : 'failed', {
        reason: first === 'issued' ? undefined : 'The credential was not accepted.',
      })
    }
    return { outcome: first, exchangeId }
  }
}
