/**
 * Events from the DIDComm agent (webhook): connection lifecycle, invitation acceptance and handshake
 * reuse (binding), question answers (binding confirmation, device challenges, approvals), messages
 * (conversation on DIDComm), reactions, receipts, calls and documents (challenges), presentations.
 */
import type { FastifyInstance } from 'fastify'
import type { HologramAgent } from '../../core/agent.js'
import type { TurnSink } from '../../core/orchestrator.js'
import type { MessageAttachment, Session } from '../../core/types.js'
import type { Logger } from '../../util/logger.js'
import { clientOfConnection, DidcommAdapter } from './adapter.js'
import type { IdentityFlow } from './identity.js'
import type { ConnectionRecord, PresentationRecord, VsAgentClient } from './vsAgentClient.js'

interface Envelope {
  id: string
  type: string
  timestamp: string
  data: Record<string, unknown>
}

export class DidcommEvents {
  private readonly identifying = new Set<string>()

  public constructor(
    private readonly agent: HologramAgent,
    private readonly client: VsAgentClient,
    private readonly identity: IdentityFlow,
    private readonly adapter: DidcommAdapter,
    private readonly apiKey: string | undefined,
    private readonly logger: Logger
  ) {}

  public register(app: FastifyInstance): void {
    app.post('/vs-agent/events', async (request, reply) => {
      if (this.apiKey && request.headers.authorization !== `Bearer ${this.apiKey}`)
        return reply.code(401).send({ error: 'unauthorized' })
      const envelope = request.body as Envelope
      // acknowledge at once; processing never blocks the DIDComm agent
      void this.handle(envelope).catch((err) =>
        this.logger.error({ err, type: envelope?.type }, 'event handling failed')
      )
      return reply.code(202).send()
    })
  }

  public async handle(envelope: Envelope): Promise<void> {
    const { type, data } = envelope
    this.logger.debug({ type }, 'didcomm event')
    switch (type) {
      case 'didcomm.connections.state-updated':
        return this.onConnection(data as unknown as ConnectionRecord & { previousState?: string })
      case 'didcomm.out-of-band.handshake-reused':
        return this.onInvitationAccepted(
          String(data.outOfBandId ?? ''),
          String(data.invitationId ?? ''),
          String(data.connectionId ?? '')
        )
      case 'didcomm.basic-messages.message-received':
        return this.onText(String(data.connectionId), String(data.content ?? ''), String(data.id ?? ''))
      case 'didcomm.question-answer.answer-received':
        return this.onAnswer(String(data.connectionId), String(data.threadId ?? ''), String(data.response ?? ''))
      case 'didcomm.action-menu.perform-received':
        return this.onContextualSelect(String(data.connectionId), String(data.name ?? ''))
      case 'didcomm.action-menu.menu-request-received':
        return this.onMenuRequest(String(data.connectionId))
      case 'didcomm.reactions.message-reactions-received':
        return this.onReactions(
          String(data.connectionId),
          (data.reactions as { messageId: string; emoji: string; action: 'add' | 'remove' }[]) ?? []
        )
      case 'didcomm.receipts.message-receipts-received':
        return this.onReceipts(
          String(data.connectionId),
          (data.receipts as { messageId: string; state: string }[]) ?? []
        )
      case 'didcomm.media-sharing.share-media-received':
        return this.onMedia(String(data.connectionId), data)
      case 'didcomm.calls.call-reject-received':
      case 'didcomm.calls.call-end-received':
        return this.onCallEnded(
          String(data.connectionId),
          String(data.threadId ?? ''),
          type.endsWith('reject-received')
        )
      case 'didcomm.mrtd.emrtd-data-received':
        return this.onDocument(String(data.connectionId), String(data.threadId ?? ''), true, data)
      case 'didcomm.mrtd.problem-report-received':
        return this.onDocument(String(data.connectionId), String(data.threadId ?? ''), false, data)
      case 'didcomm.presentations.state-updated':
        this.identity.onPresentation(data as unknown as PresentationRecord)
        return
      default:
        return
    }
  }

  // ---- connections (IDENT-TRUST-002, IDENT-SESS-002/003) -----------------------------------------

  private async onConnection(record: ConnectionRecord & { previousState?: string }): Promise<void> {
    if (record.state === 'completed' && record.previousState !== 'completed') {
      if (this.identifying.has(record.id)) return
      this.identifying.add(record.id)
      try {
        const facts = await this.identity.establish(record.id, record.theirDid)
        if (!facts) {
          await this.client
            .sendText(
              record.id,
              'This agent accepts connections from Verifiable User Agents with a valid identity credential only.'
            )
            .catch(() => undefined)
          await this.client.deleteConnection(record.id).catch(() => undefined)
          return
        }
        await this.agent.onPeerConnected(facts, record.id, clientOfConnection(record.theirLabel))
        // a connection created from a binding invitation: ask the confirmation question (CHAN-BIND-009)
        if (record.outOfBandId) await this.onInvitationAccepted(record.outOfBandId, '', record.id)
      } finally {
        this.identifying.delete(record.id)
      }
    } else if (record.state === 'terminated' || record.state === 'abandoned') {
      await this.agent.onPeerDisconnected(record.id)
    }
  }

  // ---- binding (CHAN-BIND-003/009, PROF-BIND-002/004/005) -------------------------------------------

  private async onInvitationAccepted(outOfBandId: string, invitationId: string, connectionId: string): Promise<void> {
    const session =
      (outOfBandId && (await this.agent.sessions.findProvisionalByOutOfBandId(outOfBandId))) ||
      (invitationId && (await this.agent.sessions.findProvisionalByNonce(invitationId))) ||
      undefined
    if (!session) return
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) {
      // handshake reuse on a connection whose Principal is not established yet: wait for identity
      this.logger.warn(
        { connectionId, sessionId: session.id },
        'invitation accepted before the principal was established'
      )
      return
    }
    if (session.binding && Date.parse(session.binding.expiresAt) < Date.now()) {
      await this.client.sendText(connectionId, 'This link code has expired. Ask the web page for a new one.')
      return
    }
    const client = session.client
    const threadId = await this.adapter.askQuestion(
      connectionId,
      `Link a web session to ${this.agent.pack.metadata.displayName}?`,
      `Code ${session.binding?.bindingCode ?? ''}, ${client.name} ${client.version} on ${client.platform}. Answer Yes only if this code is shown on your screen.`,
      ['Yes', 'No']
    )
    await this.agent.sessions.markConfirmationSent(session, connectionId, threadId)
  }

  private async onAnswer(connectionId: string, threadId: string, response: string): Promise<void> {
    const yes = /^(yes|approve|y)$/i.test(response.trim())
    const binding = await this.agent.sessions.findByConfirmation(connectionId, threadId)
    if (binding) {
      if (binding.state !== 'provisional' || !binding.binding) return
      if (!yes) {
        await this.client.sendText(connectionId, 'The web session was not linked.')
        return
      }
      const bound = await this.agent.didcommSession(connectionId)
      if (!bound) return
      try {
        await this.agent.sessions.bind(binding, bound.principal, binding.binding.nonce)
        await this.client.sendText(
          connectionId,
          `Linked: ${binding.client.name} on ${binding.client.platform} (code ${binding.binding.bindingCode}).`
        )
        await this.agent.welcome(binding)
      } catch (error) {
        this.logger.warn({ err: error, sessionId: binding.id }, 'binding refused')
        await this.client.sendText(connectionId, 'This link could not be completed; ask the web page for a new code.')
      }
      return
    }
    const challenge = await this.agent.challenges.findPendingByThread(connectionId, threadId)
    if (challenge) {
      await this.agent.challenges.complete(challenge.id, yes ? 'completed' : 'failed', { response })
      return
    }
    // an approval asked as a question (approval cards on DIDComm)
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    const pending = await this.agent.approvals.pendingFor(bound.principal)
    const sink = this.sinkFor(bound.session)
    if (pending.length === 1 && /^(approve|reject|yes|no)$/i.test(response.trim())) {
      await this.agent.action(
        bound.session,
        {
          kind: 'approval.decide',
          approvalId: pending[0].id,
          decision: /^(approve|yes)$/i.test(response.trim()) ? 'approve' : 'reject',
        },
        sink,
        new AbortController().signal
      )
      return
    }
    // an inline menu answered on DIDComm
    await this.turn(bound.session, response)
  }

  // ---- conversation on DIDComm (CHAN-ROUTE-003) ---------------------------------------------------------

  private sinkFor(session: Session): TurnSink {
    const client = this.client
    const connectionId = session.externalRef
    let buffer = ''
    return {
      emit: async (event) => {
        if (event.type === 'text-delta') buffer += event.delta
        else if (event.type === 'text-end') {
          const text = buffer
          buffer = ''
          if (text.trim()) await client.sendText(connectionId, text)
        } else if (event.type === 'activity' && event.activityType === 'hologram.menu') {
          const content = event.content as { prompt: string; items: { label: string }[] }
          await client.sendQuestion(
            connectionId,
            content.prompt,
            content.items.map((i) => i.label)
          )
        }
      },
    }
  }

  private async turn(session: Session, text: string, attachments?: MessageAttachment[]): Promise<void> {
    const principal = await this.agent.principalOf(session)
    if (!principal) return
    const command = await this.agent.sessionsCommand(session, text)
    if (command !== undefined) {
      await this.client.sendText(session.externalRef, command)
      return
    }
    await this.agent.turn(
      session,
      {
        entry: {
          sessionId: session.id,
          principalId: principal.id,
          role: 'principal',
          sourceType: attachments?.some((a) => a.type === 'voice') ? 'voice' : attachments?.length ? 'media' : 'text',
          text,
          attachments,
          backingIdentity: principal.backingIdentity,
        },
      },
      this.sinkFor(session),
      new AbortController().signal
    )
  }

  private async onText(connectionId: string, content: string, messageId: string): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    void messageId
    await this.turn(bound.session, content)
  }

  private async onContextualSelect(connectionId: string, itemId: string): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    const result = await this.agent.action(
      bound.session,
      { kind: 'contextual.select', itemId },
      this.sinkFor(bound.session),
      new AbortController().signal
    )
    if (result && 'text' in result && result.text) await this.client.sendText(connectionId, result.text)
  }

  private async onMenuRequest(connectionId: string): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    await this.agent.router.deliver(bound.session, { kind: 'contextual-menu', sessionId: bound.session.id })
  }

  private async onReactions(
    connectionId: string,
    reactions: { messageId: string; emoji: string; action: 'add' | 'remove' }[]
  ): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    for (const r of reactions) {
      const entry = await this.agent.memory.findByExternalId(bound.session.id, r.messageId)
      await this.agent.action(
        bound.session,
        { kind: 'reaction', messageId: entry?.id ?? r.messageId, emoji: r.emoji, action: r.action },
        this.sinkFor(bound.session),
        new AbortController().signal
      )
    }
  }

  private async onReceipts(connectionId: string, receipts: { messageId: string; state: string }[]): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    const viewed = receipts.filter((r) => r.state === 'viewed').map((r) => r.messageId)
    if (viewed.length)
      await this.agent.action(
        bound.session,
        { kind: 'receipt', messageIds: viewed, state: 'viewed' },
        this.sinkFor(bound.session),
        new AbortController().signal
      )
  }

  private async onMedia(connectionId: string, data: Record<string, unknown>): Promise<void> {
    const bound = await this.agent.didcommSession(connectionId)
    if (!bound) return
    const items =
      (data.items as
        | {
            uri: string
            mimeType: string
            fileName?: string
            description?: string
            ciphering?: { algorithm: string; parameters: { key: string; iv: string } }
          }[]
        | undefined) ?? []
    const attachments = []
    for (const item of items) {
      try {
        const response = await fetch(item.uri)
        if (!response.ok) continue
        let bytes = Buffer.from(await response.arrayBuffer())
        if (item.ciphering?.algorithm === 'aes-256-cbc') {
          const { createDecipheriv } = await import('node:crypto')
          const d = createDecipheriv(
            'aes-256-cbc',
            Buffer.from(item.ciphering.parameters.key, 'hex'),
            Buffer.from(item.ciphering.parameters.iv, 'hex')
          )
          bytes = Buffer.concat([d.update(bytes), d.final()])
        }
        attachments.push(
          await this.agent.media.ingest(
            bound.session,
            bytes,
            item.mimeType,
            item.fileName,
            this.agent.pack.language.agent
          )
        )
      } catch (error) {
        this.logger.warn({ err: error, uri: item.uri }, 'inbound media could not be fetched')
      }
    }
    if (!attachments.length) return
    const text = String(data.description ?? '') || attachments.map((a) => a.textRepr).join('\n')
    await this.turn(bound.session, text, attachments)
  }

  // ---- challenges (INTX-AUTH-007/009) ----------------------------------------------------------------

  private async onCallEnded(connectionId: string, threadId: string, rejected: boolean): Promise<void> {
    const challenge = await this.agent.challenges.findPendingByThread(connectionId, threadId)
    if (challenge && rejected) await this.agent.challenges.complete(challenge.id, 'failed', { reason: 'call-rejected' })
  }

  private async onDocument(
    connectionId: string,
    threadId: string,
    ok: boolean,
    data: Record<string, unknown>
  ): Promise<void> {
    const challenge = await this.agent.challenges.findPendingByThread(connectionId, threadId)
    if (!challenge) return
    const groups = (data.dataGroups as { dg1?: unknown } | undefined) ?? {}
    await this.agent.challenges.complete(
      challenge.id,
      ok ? 'completed' : 'failed',
      ok ? { documentRead: true, hasDg1: 'dg1' in groups } : { reason: String(data.reason ?? 'refused') }
    )
  }
}
