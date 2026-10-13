/**
 * A2A channel adapter (CHAN-ADP-001, CHAN-BIND-007, D36): an agent card and a JSON-RPC endpoint
 * (message/send, tasks/get). A peer service is a Principal resolved on its DIDComm connection
 * (DIDComm-first bootstrap); the agent hands it a bearer token over DIDComm, and every A2A task
 * or context maps to one conversation session bound to that Principal.
 */
import type { FastifyInstance } from 'fastify'
import type { HologramAgent } from '../../core/agent.js'
import { A2A_CAPABILITIES, type ChannelAdapter, type RenderResult } from '../../core/channel.js'
import { SessionError } from '../../core/sessions.js'
import type { CapabilityEvent, Session } from '../../core/types.js'
import { prefixedId } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'

interface JsonRpc {
  jsonrpc: '2.0'
  id: string | number | null
  method: string
  params?: Record<string, unknown>
}

export class A2aAdapter implements ChannelAdapter {
  public readonly type = 'a2a' as const
  public readonly capabilities = A2A_CAPABILITIES
  /** replies queued per task for tasks/get (text served in place, D40) */
  private readonly outbox = new Map<string, { text: string; at: string }[]>()

  public async render(session: Session, event: CapabilityEvent): Promise<RenderResult> {
    const queue = this.outbox.get(session.id) ?? []
    if (event.kind === 'text') queue.push({ text: event.entry.text, at: event.entry.createdAt })
    else if (event.kind === 'menu')
      queue.push({
        text: `${event.prompt}\n${event.items.map((i) => `- ${i.id}: ${i.label}`).join('\n')}`,
        at: event.entry.createdAt,
      })
    else if (event.kind === 'media') queue.push({ text: event.entry.text, at: event.entry.createdAt })
    else if (event.kind === 'approval')
      queue.push({
        text: `Approval ${event.approval.id} for ${event.approval.toolName}: ${event.approval.status}`,
        at: event.approval.updatedAt,
      })
    else return 'unsupported'
    this.outbox.set(session.id, queue)
    return 'ok'
  }

  public drain(sessionId: string): { text: string; at: string }[] {
    const out = this.outbox.get(sessionId) ?? []
    this.outbox.delete(sessionId)
    return out
  }
}

export class A2aRoutes {
  public constructor(
    private readonly agent: HologramAgent,
    private readonly adapter: A2aAdapter,
    private readonly logger: Logger
  ) {}

  public register(app: FastifyInstance, did: string): void {
    app.get('/.well-known/agent.json', async () => ({
      name: this.agent.pack.metadata.displayName,
      description: this.agent.pack.metadata.description ?? '',
      url: `${this.agent.env.publicBaseUrl}/a2a`,
      version: '3.0.0',
      protocolVersion: '0.3',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [
        {
          id: 'conversation',
          name: 'Conversation',
          description: 'Talks with a verified peer service.',
          tags: ['conversation'],
        },
      ],
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'Peer token handed over the DIDComm capability channel',
        },
      },
      security: [{ bearer: [] }],
      extensions: [
        { uri: 'https://2060.io/hologram/a2a/identity', description: `Peer identity through DIDComm with ${did}` },
      ],
    }))

    app.post('/a2a', async (request, reply) => {
      const rpc = request.body as JsonRpc
      const respond = (result: unknown) => reply.send({ jsonrpc: '2.0', id: rpc?.id ?? null, result })
      const fail = (code: number, message: string, status = 200) =>
        reply.code(status).send({ jsonrpc: '2.0', id: rpc?.id ?? null, error: { code, message } })
      if (rpc?.jsonrpc !== '2.0' || !rpc.method) return fail(-32600, 'invalid request', 400)
      const header = request.headers.authorization
      const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
      let peerSession: Session
      try {
        peerSession = await this.agent.sessions.authenticate(token)
        this.agent.sessions.requireBound(peerSession)
      } catch (error) {
        return fail(-32001, error instanceof SessionError ? error.message : 'unauthorized', 401)
      }
      const principal = await this.agent.principalOf(peerSession)
      if (principal?.connectionType !== 'verifiable-service') return fail(-32001, 'a2a is for verifiable services', 403)

      if (rpc.method === 'message/send') {
        const params = (rpc.params ?? {}) as {
          message?: { parts?: { kind?: string; text?: string }[]; taskId?: string; contextId?: string }
        }
        const text = (params.message?.parts ?? [])
          .filter((p) => p.kind === 'text')
          .map((p) => p.text ?? '')
          .join('\n')
          .trim()
        if (!text) return fail(-32602, 'a text part is required')
        const ref = params.message?.taskId ?? params.message?.contextId ?? prefixedId('task')
        // one conversation session per task or context (CHAN-BIND-007)
        const existing = await this.agent.store.sessions.findByExternalRef('a2a', ref)
        const session =
          existing ??
          (
            await this.agent.sessions.createBound('a2a', ref, principal, {
              name: 'a2a-peer',
              version: '',
              platform: 'a2a',
            })
          ).session
        let reply_text = ''
        try {
          const result = await this.agent.turn(
            session,
            {
              entry: {
                sessionId: session.id,
                principalId: principal.id,
                role: 'principal',
                sourceType: 'text',
                text,
                backingIdentity: principal.backingIdentity,
              },
            },
            { emit: () => undefined },
            new AbortController().signal
          )
          reply_text = result.reply.text
        } catch (error) {
          this.logger.error({ err: error }, 'a2a turn failed')
          return fail(-32000, 'internal error', 500)
        }
        const queued = this.adapter.drain(session.id)
        return respond({
          id: ref,
          contextId: ref,
          status: { state: 'completed', timestamp: this.agent.now },
          artifacts: [{ artifactId: prefixedId('art'), parts: [{ kind: 'text', text: reply_text }] }],
          history: queued.map((q) => ({ role: 'agent', parts: [{ kind: 'text', text: q.text }] })),
          kind: 'task',
        })
      }
      if (rpc.method === 'tasks/get') {
        const { id } = (rpc.params ?? {}) as { id?: string }
        const session = id ? await this.agent.store.sessions.findByExternalRef('a2a', id) : undefined
        if (!session || session.principalId !== principal.id) return fail(-32001, 'task not found')
        const queued = this.adapter.drain(session.id)
        return respond({
          id,
          contextId: id,
          status: { state: 'completed', timestamp: session.lastActivityAt },
          history: queued.map((q) => ({ role: 'agent', parts: [{ kind: 'text', text: q.text }] })),
          kind: 'task',
        })
      }
      return fail(-32601, 'method not found')
    })
  }
}
