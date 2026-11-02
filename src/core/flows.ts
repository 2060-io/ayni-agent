/**
 * Flows of the flow profile, as the agent opens them on a flow-capable capability channel (D54, D55;
 * INTX-FLOW-001..005): every capability event that needs the person's device is an `ayni-flow/1.0`
 * `open`, the carrier protocol's messages with the flow id as parent thread, and a `close` with the
 * outcome. A flow opened from a conversation is one `MessageEntry` (`sourceType: flow`) ordered at its
 * open time and updated in place at its close, rendered to every UI as the `ayni.flow` card.
 *
 * The DIDComm agent (VS Agent with the Ayni flow plugin) owns the protocol state and expiry; this
 * service keeps the conversation record, the per-connection pending cap and the waiters.
 */
import type { KvRepo } from '../store/types.js'
import { Deferred } from '../util/async.js'
import { nowIso } from '../util/ids.js'
import type { Logger } from '../util/logger.js'
import type { CapabilityRouter } from './channel.js'
import type { FlowCard, FlowOutcome, FlowReference, FlowState, MessageEntry, Session } from './types.js'

/** What the service needs from the DIDComm agent's flow routes (a subset of VsAgentClient). */
export interface FlowClient {
  openFlow(body: {
    connectionId: string
    kind: string
    title: string
    description?: string
    origin: FlowOrigin
    expiresTime: string
    requires?: string[]
  }): Promise<FlowRecordLike>
  closeFlow(
    flowId: string,
    body: { outcome: FlowOutcome; reason?: string; references?: FlowReference[] }
  ): Promise<FlowRecordLike>
  flowProblemReport(flowId: string, body: { code: string; description?: string }): Promise<FlowRecordLike>
}

export interface FlowOrigin {
  channel: 'ag-ui' | 'none'
  agentDid?: string
  sessionId?: string
  conversationId?: string
  client?: { description: string; platform: 'web' | 'ios' | 'android' }
}

export interface FlowRecordLike {
  flowId: string
  connectionId: string
  state: FlowState
  kind: string
  title: string
  expiresTime: string
  reason?: string
  references?: FlowReference[]
  errorCode?: string
  closedAt?: string
  closedBy?: 'me' | 'peer' | 'expiry'
  createdAt: string
}

/** What the service needs from memory: the flow entry's creation and in-place update. */
export interface FlowMemory {
  append(input: {
    sessionId: string
    principalId: string | null
    role: 'system'
    sourceType: 'flow'
    text: string
    backingIdentity: MessageEntry['backingIdentity']
    payload: Record<string, unknown>
    externalId: string
  }): Promise<MessageEntry>
  get(id: string): Promise<MessageEntry | undefined>
  rewrite(entry: MessageEntry): Promise<void>
}

export interface FlowOpenOptions {
  connectionId: string
  kind: string
  title: string
  description?: string
  /** the conversation session that triggered the flow; absent for the agent's own process (`origin: none`) */
  origin?: Session
  /** whether the flow is recorded as a card in the origin conversation (default: when the origin is bound) */
  card?: boolean
  expiresAt?: string
  expiresInMs?: number
  requires?: string[]
}

export interface FlowHandle {
  flowId: string
  connectionId: string
  kind: string
  entryId?: string
  sessionId?: string
  expiresAt: string
}

export interface FlowClosed {
  flowId: string
  state: FlowState
  outcome: FlowOutcome
  reason?: string
  errorCode?: string
  references?: FlowReference[]
  closedBy: 'me' | 'peer' | 'expiry'
}

const KEY_PREFIX = 'flow:'
const DEFAULT_EXPIRY_MS = 5 * 60_000
/** a service keeps at most ten flows pending per connection (INTX-FLOW-005, FLOW-CORE-008) */
export const MAX_PENDING_PER_CONNECTION = 10

export function platformOf(platform: string | undefined): 'web' | 'ios' | 'android' {
  return platform === 'ios' || platform === 'android' ? platform : 'web'
}

export function clientDescriptionOf(session: Session): { description: string; platform: 'web' | 'ios' | 'android' } {
  const c = session.client
  return { description: c.description ?? `${c.name} ${c.version}`.trim(), platform: platformOf(c.platform) }
}

export class FlowService {
  private agentDid = 'did:unknown'
  private readonly handles = new Map<string, FlowHandle>()
  private readonly waiters = new Map<string, Deferred<FlowClosed>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly pending = new Map<string, number>()
  private readonly queue = new Map<string, (() => void)[]>()

  public constructor(
    private readonly client: FlowClient,
    private readonly memory: FlowMemory,
    private readonly router: CapabilityRouter,
    private readonly kv: KvRepo,
    private readonly logger: Logger,
    private readonly maxPending = MAX_PENDING_PER_CONNECTION
  ) {}

  public setAgentDid(did: string): void {
    this.agentDid = did
  }

  public originOf(session: Session | undefined): FlowOrigin {
    if (!session) return { channel: 'none' }
    return {
      channel: 'ag-ui',
      agentDid: this.agentDid,
      sessionId: session.id,
      conversationId: session.conversationId,
      client: clientDescriptionOf(session),
    }
  }

  /** Opens a flow; waits for a slot when ten are pending on the connection (INTX-FLOW-005). */
  public async open(opts: FlowOpenOptions): Promise<FlowHandle> {
    await this.acquire(opts.connectionId)
    const expiresAt = opts.expiresAt ?? new Date(Date.now() + (opts.expiresInMs ?? DEFAULT_EXPIRY_MS)).toISOString()
    let record: FlowRecordLike
    try {
      record = await this.client.openFlow({
        connectionId: opts.connectionId,
        kind: opts.kind,
        title: opts.title,
        description: opts.description,
        origin: this.originOf(opts.origin),
        expiresTime: expiresAt,
        requires: opts.requires,
      })
    } catch (error) {
      this.release(opts.connectionId)
      throw error
    }
    const handle: FlowHandle = {
      flowId: record.flowId,
      connectionId: opts.connectionId,
      kind: opts.kind,
      expiresAt: record.expiresTime ?? expiresAt,
    }
    const card = opts.card ?? (!!opts.origin && opts.origin.state === 'bound')
    if (card && opts.origin) {
      const entry = await this.memory.append({
        sessionId: opts.origin.id,
        principalId: opts.origin.principalId,
        role: 'system',
        sourceType: 'flow',
        text: opts.title,
        backingIdentity: null,
        externalId: record.flowId,
        payload: {
          flowId: record.flowId,
          kind: opts.kind,
          state: record.state,
          title: opts.title,
          openedAt: record.createdAt,
        } satisfies FlowCard,
      })
      handle.entryId = entry.id
      handle.sessionId = opts.origin.id
      await this.router.deliver(opts.origin, { kind: 'flow', entry, card: entry.payload as unknown as FlowCard })
    }
    this.handles.set(record.flowId, handle)
    await this.kv.set(KEY_PREFIX + record.flowId, JSON.stringify(handle))
    // the DIDComm agent expires the flow and reports it; this timer only frees local waiters if it never does
    const grace = Math.max(0, Date.parse(handle.expiresAt) - Date.now()) + 15_000
    this.timers.set(
      record.flowId,
      setTimeout(() => {
        void this.finish(record.flowId, { state: 'expired', closedBy: 'expiry' }).catch(() => undefined)
      }, grace)
    )
    this.logger.debug({ flowId: record.flowId, kind: opts.kind, connectionId: opts.connectionId }, 'flow opened')
    return handle
  }

  /** The opener closes `completed` or `failed` when the carrier protocol ends, `cancelled` to abandon (§5.2). */
  public async close(
    flowId: string,
    outcome: FlowOutcome,
    extra: { reason?: string; references?: FlowReference[]; preview?: Record<string, unknown> } = {}
  ): Promise<void> {
    if (!this.handles.has(flowId) && !(await this.handle(flowId))) return
    try {
      await this.client.closeFlow(flowId, { outcome, reason: extra.reason, references: extra.references })
    } catch (error) {
      // already closed on the DIDComm agent (the holder was first, or it expired): the record below still settles
      this.logger.debug({ err: error, flowId, outcome }, 'flow close not accepted by the DIDComm agent')
    }
    await this.finish(flowId, {
      state: outcome,
      reason: extra.reason,
      references: extra.references,
      closedBy: 'me',
      preview: extra.preview,
    })
  }

  /** A refusal or failure decided by the agent: report-problem with a code of the flow profile §11. */
  public async problemReport(flowId: string, code: string, description?: string): Promise<void> {
    try {
      await this.client.flowProblemReport(flowId, { code, description })
    } catch (error) {
      this.logger.debug({ err: error, flowId, code }, 'flow problem report not accepted by the DIDComm agent')
    }
    await this.finish(flowId, { state: 'failed', errorCode: code, reason: description, closedBy: 'me' })
  }

  /** `didcomm.ayni-flow.state-changed` from the DIDComm agent: the peer or the expiry closed the flow. */
  public async onFlowEvent(record: FlowRecordLike & { previousState?: string }): Promise<FlowClosed | undefined> {
    if (record.state === 'pending') return undefined
    if (record.state === 'active') {
      const handle = await this.handle(record.flowId)
      if (handle?.entryId) await this.updateCard(handle, { state: 'active' })
      return undefined
    }
    return this.finish(record.flowId, {
      state: record.state,
      reason: record.reason,
      errorCode: record.errorCode,
      references: record.references,
      closedBy: record.closedBy ?? 'peer',
    })
  }

  /** Resolves when the flow closes, whoever closes it. */
  public waitForClose(flowId: string): Promise<FlowClosed> {
    const existing = this.waiters.get(flowId)
    if (existing) return existing.promise
    const deferred = new Deferred<FlowClosed>()
    this.waiters.set(flowId, deferred)
    return deferred.promise
  }

  public async handle(flowId: string): Promise<FlowHandle | undefined> {
    const cached = this.handles.get(flowId)
    if (cached) return cached
    const stored = await this.kv.get(KEY_PREFIX + flowId)
    if (!stored) return undefined
    const handle = JSON.parse(stored) as FlowHandle
    this.handles.set(flowId, handle)
    return handle
  }

  // ---- internals -------------------------------------------------------------------------------------

  private async finish(
    flowId: string,
    closed: {
      state: FlowState
      reason?: string
      errorCode?: string
      references?: FlowReference[]
      closedBy: 'me' | 'peer' | 'expiry'
      preview?: Record<string, unknown>
    }
  ): Promise<FlowClosed | undefined> {
    const handle = await this.handle(flowId)
    if (!handle) return undefined
    const timer = this.timers.get(flowId)
    if (timer) clearTimeout(timer)
    this.timers.delete(flowId)
    this.handles.delete(flowId)
    await this.kv.set(KEY_PREFIX + flowId, '')
    this.release(handle.connectionId)
    const outcome = (closed.state === 'pending' || closed.state === 'active' ? 'failed' : closed.state) as FlowOutcome
    const result: FlowClosed = {
      flowId,
      state: closed.state,
      outcome,
      reason: closed.reason,
      errorCode: closed.errorCode,
      references: closed.references,
      closedBy: closed.closedBy,
    }
    if (handle.entryId)
      await this.updateCard(handle, {
        state: closed.state,
        outcome,
        reason: closed.reason,
        references: closed.references,
        preview: closed.preview,
        closedAt: nowIso(),
      }).catch((err) => this.logger.warn({ err, flowId }, 'flow card update failed'))
    this.logger.info({ flowId, kind: handle.kind, outcome, closedBy: closed.closedBy }, 'flow closed')
    const waiter = this.waiters.get(flowId)
    if (waiter) {
      this.waiters.delete(flowId)
      waiter.resolve(result)
    }
    return result
  }

  /** The flow entry is updated in place; the UIs receive the card again with the same id (PROF-MAP-007). */
  private async updateCard(handle: FlowHandle, patch: Partial<FlowCard>): Promise<void> {
    if (!handle.entryId) return
    const entry = await this.memory.get(handle.entryId)
    if (!entry) return
    const card = { ...(entry.payload as unknown as FlowCard), ...patch }
    for (const key of Object.keys(card) as (keyof FlowCard)[]) if (card[key] === undefined) delete card[key]
    entry.payload = card as unknown as Record<string, unknown>
    await this.memory.rewrite(entry)
    const session = await this.router.session(entry.sessionId)
    if (session) await this.router.deliver(session, { kind: 'flow', entry, card })
  }

  private async acquire(connectionId: string): Promise<void> {
    const count = this.pending.get(connectionId) ?? 0
    if (count < this.maxPending) {
      this.pending.set(connectionId, count + 1)
      return
    }
    this.logger.info({ connectionId, pending: count }, 'flow waits: ten flows pending on the connection')
    await new Promise<void>((resolve) => {
      this.queue.set(connectionId, [...(this.queue.get(connectionId) ?? []), resolve])
    })
    this.pending.set(connectionId, (this.pending.get(connectionId) ?? 0) + 1)
  }

  private release(connectionId: string): void {
    const count = Math.max(0, (this.pending.get(connectionId) ?? 1) - 1)
    this.pending.set(connectionId, count)
    const next = this.queue.get(connectionId)?.shift()
    if (next) next()
  }

  /** Pending flows on a connection, for tests and the sessions command. */
  public pendingOn(connectionId: string): number {
    return this.pending.get(connectionId) ?? 0
  }
}
