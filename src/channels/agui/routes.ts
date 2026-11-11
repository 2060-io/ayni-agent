/**
 * The AG-UI channel endpoints of the Ayni AG-UI Profile v3 (CHAN-ADP-004, PROF-*):
 * descriptor, sessions, binding refresh, session stream, runs and cancellation, history, attachments.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  ACTIVITY,
  type AgentDescriptor,
  type AyniAction,
  CUSTOM_EVENT,
  DESCRIPTOR_PATH,
  RUN_ERROR_CODE,
} from '@ayni.org/ayni-agui-profile'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AyniAgent } from '../../core/agent.js'
import type { TurnEvent, TurnSink } from '../../core/orchestrator.js'
import { normalizeClient, SessionError } from '../../core/sessions.js'
import type { ClientDescription, Session } from '../../core/types.js'
import { canonicalMime, mimeAllowed } from '../../media/service.js'
import { prefixedId } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'
import type { AgUiAdapter } from './adapter.js'
import { type AgUiEvent, ev, sse } from './events.js'
import { attachmentActivity, entryToMessages } from './mapping.js'
import type { SessionStreams } from './streams.js'

/**
 * The profile revision this agent implements: 3.1 (session grant, flows and `ayni.flow`, `flowId` on routed
 * capabilities, client platform and description).
 */
const AGENT_PROFILE_VERSION = '3.1'

const require = createRequire(import.meta.url)
const loadSchema = (name: string) =>
  JSON.parse(readFileSync(require.resolve(`@ayni.org/ayni-agui-profile/schemas/${name}`), 'utf8'))
const createSessionSchema = loadSchema('create-session.schema.json')
const actionSchema = loadSchema('ayni-action.schema.json')

interface RunAgentInput {
  threadId: string
  runId: string
  messages?: { id?: string; role: string; content?: unknown }[]
  tools?: unknown[]
  forwardedProps?: { ayni?: AyniAction }
  resume?: { interruptId: string; status: string; payload?: unknown }[]
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats.default(ajv)
const validateCreate = ajv.compile(createSessionSchema)
const validateAction = ajv.compile(actionSchema)

export class AgUiRoutes {
  private readonly runs = new Map<string, { sessionId: string; controller: AbortController }>()
  private readonly uploads: { maxBytes: number; types: string[] }

  public constructor(
    private readonly agent: AyniAgent,
    private readonly adapter: AgUiAdapter,
    private readonly streams: SessionStreams,
    private readonly logger: Logger
  ) {
    const u = agent.pack.channels?.agui?.uploads ?? {}
    this.uploads = {
      maxBytes: agent.env.uploadMaxBytes ?? u.maxBytes ?? 26214400,
      types: agent.env.uploadTypes ?? u.types ?? ['image/*', 'audio/webm', 'audio/ogg', 'audio/mp4', 'application/pdf'],
    }
  }

  public get maxUploadBytes(): number {
    return this.uploads.maxBytes
  }

  public descriptor(did: string): AgentDescriptor {
    const f = this.agent.features
    return {
      profileVersion: AGENT_PROFILE_VERSION,
      did,
      name: this.agent.pack.metadata.displayName,
      description: this.agent.pack.metadata.description,
      sessions: `${this.agent.env.publicBaseUrl}/agui/v3/sessions`,
      binding: { modes: ['cross-device', 'same-device'], walletLinkTemplate: this.agent.walletLinkTemplate() },
      features: {
        contextualMenu: true,
        approvals: f.approvals,
        reactions: f.reactions,
        receipts: f.receipts,
        history: f.history,
        voiceNotes: f.voiceNotes && this.agent.media.canTranscribe,
        uploads: f.voiceNotes || f.inboundImages ? this.uploads : false,
        // flows on flow-capable wallets (D54, D55); the session grant comes with D56
        flows: true,
        sessionGrant: true,
      },
      locales: [this.agent.pack.language.agent],
    }
  }

  private token(request: FastifyRequest): string | undefined {
    const header = request.headers.authorization
    return header?.startsWith('Bearer ') ? header.slice(7) : undefined
  }

  private async session(request: FastifyRequest, reply: FastifyReply, bound: boolean): Promise<Session | undefined> {
    try {
      const session = await this.agent.sessions.authenticate(this.token(request))
      const id = (request.params as { id?: string }).id
      if (id && session.id !== id) {
        reply.code(404).send({ error: 'not-found' })
        return undefined
      }
      if (bound) this.agent.sessions.requireBound(session)
      return session
    } catch (error) {
      this.sendError(reply, error)
      return undefined
    }
  }

  private sendError(reply: FastifyReply, error: unknown): void {
    if (error instanceof SessionError) {
      const code = {
        unauthorized: 401,
        'not-bound': 403,
        'not-found': 404,
        conflict: 409,
        'pairing-expired': 409,
        'pairing-invalid': 409,
        'grant-used': 409,
        'grant-expired': 409,
        final: 409,
        closed: 410,
        forbidden: 403,
      }[error.code]
      reply.code(code).send({
        error: error.code === 'not-found' ? 'not-found' : error.code,
        ...(error.reason ? { reason: error.reason } : {}),
        message: error.message,
      })
      return
    }
    this.logger.error({ err: error }, 'agui route failed')
    reply.code(500).send({ error: 'internal' })
  }

  public register(app: FastifyInstance, did: string): void {
    app.get(DESCRIPTOR_PATH, async () => this.descriptor(did))
    const base = '/agui/v3/sessions'

    // PROF-SESS-001 create, PROF-SESS-007 sibling
    app.post(base, async (request, reply) => {
      const body = request.body as {
        client?: ClientDescription
        locale?: string
        deviceHandle?: string
        deviceProof?: string
        resumeSessionId?: string
        conversationId?: string
        newConversation?: boolean
        grant?: string
      }
      if (!validateCreate(body))
        return reply.code(400).send({ error: 'bad-request', message: ajv.errorsText(validateCreate.errors) })
      const client = normalizeClient(body.client as ClientDescription)
      // PROF-SESS-013: a grant obtained on DIDComm binds the session at creation, nothing asked on the channel
      if (body.grant) {
        try {
          const { session, token: newToken } = await this.agent.createSessionFromGrant(
            client,
            body.locale,
            body.grant,
            body.conversationId,
            body.newConversation === true,
            body.resumeSessionId
          )
          const principal = await this.agent.principalOf(session)
          await this.agent.welcome(session)
          return reply.code(201).send({
            sessionId: session.id,
            sessionToken: newToken,
            state: session.state,
            agent: { did, name: this.agent.pack.metadata.displayName },
            principal: principal ? this.agent.principalDisplay(principal) : undefined,
            deviceHandle: session.deviceHandle,
            deviceSecret: session.deviceSecret,
            conversationId: session.conversationId,
            resumedFromSessionId: session.resumedFromSessionId,
            idleTimeoutSeconds: this.agent.sessions.idleTimeoutSeconds,
          })
        } catch (error) {
          return this.sendError(reply, error)
        }
      }
      const token = this.token(request)
      if (token) {
        try {
          const parent = await this.agent.sessions.authenticate(token)
          this.agent.sessions.requireBound(parent)
          const { session, token: newToken } = await this.agent.createSibling(
            parent,
            client,
            body.locale,
            body.resumeSessionId,
            body.conversationId,
            body.newConversation === true
          )
          const principal = await this.agent.principalOf(session)
          await this.agent.welcome(session)
          return reply.code(201).send({
            sessionId: session.id,
            sessionToken: newToken,
            state: session.state,
            agent: { did, name: this.agent.pack.metadata.displayName },
            parentSessionId: parent.id,
            conversationId: session.conversationId,
            resumedFromSessionId: session.resumedFromSessionId,
            principal: principal ? this.agent.principalDisplay(principal) : undefined,
            idleTimeoutSeconds: this.agent.sessions.idleTimeoutSeconds,
          })
        } catch (error) {
          return this.sendError(reply, error)
        }
      }
      try {
        const {
          session,
          token: newToken,
          rebind,
          pairing,
        } = await this.agent.createSession(
          client,
          body.locale,
          body.deviceHandle,
          body.resumeSessionId,
          body.deviceProof,
          body.conversationId,
          body.newConversation === true
        )
        if (session.state === 'bound') {
          // a paired device: bound at once, no phone round trip (PROF-SESS-010)
          const principal = await this.agent.principalOf(session)
          await this.agent.welcome(session)
          return reply.code(201).send({
            sessionId: session.id,
            sessionToken: newToken,
            state: session.state,
            agent: { did, name: this.agent.pack.metadata.displayName },
            principal: principal ? this.agent.principalDisplay(principal) : undefined,
            deviceHandle: session.deviceHandle,
            deviceSecret: session.deviceSecret,
            conversationId: session.conversationId,
            resumedFromSessionId: session.resumedFromSessionId,
            idleTimeoutSeconds: this.agent.sessions.idleTimeoutSeconds,
          })
        }
        return reply.code(201).send({
          sessionId: session.id,
          sessionToken: newToken,
          state: session.state,
          agent: { did, name: this.agent.pack.metadata.displayName },
          binding: this.agent.bindingMaterial(session),
          idleTimeoutSeconds: this.agent.sessions.idleTimeoutSeconds,
          ...(rebind ? { rebind } : {}),
          ...(pairing ? { pairing } : {}),
        })
      } catch (error) {
        return this.sendError(reply, error)
      }
    })

    // PROF-CONV-001: the Principal's conversations
    app.get(`${base}/conversations`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const list = await this.agent.sessions.listConversations(session.principalId ?? '')
      return {
        conversations: list.map((c) => ({
          id: c.id,
          title: c.title,
          state: c.state,
          createdAt: c.createdAt,
          lastActivityAt: c.lastActivityAt,
          lastPreview: c.lastPreview,
          open: c.open,
        })),
      }
    })

    // PROF-CONV-002/003: rename, archive, unarchive
    app.patch(`${base}/conversations/:conversationId`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { conversationId: id } = request.params as { conversationId: string }
      const body = (request.body ?? {}) as { title?: string; state?: string }
      try {
        const principal = await this.agent.principalOf(session)
        if (!principal) return reply.code(404).send({ error: 'not-found' })
        let conversation = await this.agent.sessions.conversationOf(principal, id)
        if (typeof body.title === 'string')
          conversation = await this.agent.sessions.renameConversation(conversation, body.title)
        if (body.state !== undefined) {
          if (body.state !== 'active' && body.state !== 'archived')
            return reply.code(400).send({ error: 'bad-request', message: 'state must be active or archived' })
          conversation = await this.agent.sessions.setConversationState(conversation, body.state)
        }
        return { id: conversation.id, title: conversation.title, state: conversation.state }
      } catch (error) {
        return this.sendError(reply, error)
      }
    })

    // PROF-CONV-004: close for good
    app.delete(`${base}/conversations/:conversationId`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { conversationId: id } = request.params as { conversationId: string }
      try {
        const principal = await this.agent.principalOf(session)
        if (!principal) return reply.code(404).send({ error: 'not-found' })
        const conversation = await this.agent.sessions.conversationOf(principal, id)
        await this.agent.sessions.finalizeConversation(conversation)
        return reply.code(204).send()
      } catch (error) {
        return this.sendError(reply, error)
      }
    })

    // PROF-SESS-011: the Principal's paired devices
    app.get(`${base}/devices`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const principal = await this.agent.principalOf(session)
      return { devices: principal ? this.agent.listDevices(principal, session.deviceHandle) : [] }
    })

    // PROF-SESS-012: revoke a pairing with a bound token, or with the device's own proof
    app.delete(`${base}/devices/:handle`, async (request, reply) => {
      const { handle } = request.params as { handle: string }
      const body = (request.body ?? {}) as { deviceProof?: string }
      if (!this.token(request)) {
        if (!body.deviceProof) return reply.code(401).send({ error: 'unauthorized' })
        const revoked = await this.agent.revokeDeviceByProof(handle, body.deviceProof)
        return revoked ? reply.code(204).send() : reply.code(404).send({ error: 'not-found' })
      }
      const session = await this.session(request, reply, true)
      if (!session) return
      const principal = await this.agent.principalOf(session)
      if (!principal) return reply.code(404).send({ error: 'not-found' })
      const revoked = await this.agent.sessions.revokeDevice(principal, handle)
      if (revoked)
        for (const s of await this.agent.sessions.listOpen(principal.id))
          if (s.deviceHandle === handle && s.id !== session.id) await this.agent.sessions.close(s, 'user')
      return revoked ? reply.code(204).send() : reply.code(404).send({ error: 'not-found' })
    })

    app.get(`${base}/:id`, async (request, reply) => {
      const session = await this.session(request, reply, false)
      if (!session) return
      return this.agent.status(session)
    })

    // PROF-SESS-005
    app.delete(`${base}/:id`, async (request, reply) => {
      const session = await this.session(request, reply, false)
      if (!session) return
      await this.agent.closeSession(session, 'user')
      return reply.code(204).send()
    })

    // PROF-BIND-007
    app.post(`${base}/:id/binding`, async (request, reply) => {
      const session = await this.session(request, reply, false)
      if (!session) return
      try {
        const refreshed = await this.agent.sessions.refreshBinding(session)
        return { binding: this.agent.bindingMaterial(refreshed) }
      } catch (error) {
        if (error instanceof SessionError && error.code === 'conflict')
          return reply.code(409).send({ error: 'conflict', binding: this.agent.bindingMaterial(session) })
        return this.sendError(reply, error)
      }
    })

    // PROF-STREAM-001..004
    app.get(`${base}/:id/stream`, async (request, reply) => {
      const session = await this.session(request, reply, false)
      if (!session) return
      const lastHeader = request.headers['last-event-id']
      const lastEventId = typeof lastHeader === 'string' && lastHeader !== '' ? Number(lastHeader) : undefined
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...this.corsHeaders(request),
      })
      reply.raw.write(': connected\n\n')
      const detach = this.streams.attach(
        session.id,
        { write: (c) => reply.raw.write(c), end: () => reply.raw.end() },
        lastEventId
      )
      // a full snapshot at stream start (PROF-STREAM-004), then deltas through the stream
      const state = await this.agent.ayniState(session)
      reply.raw.write(sse(ev.stateSnapshot({ ayni: state })))
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
      request.raw.on('close', () => {
        clearInterval(heartbeat)
        detach()
      })
      await new Promise<void>((resolve) => request.raw.on('close', resolve))
    })

    // PROF-RUN-001..006
    app.post(`${base}/:id/runs`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const input = request.body as RunAgentInput
      if (!input || input.threadId !== session.id || !input.runId)
        return reply
          .code(400)
          .send({ error: 'bad-request', message: 'threadId must equal the session id and runId is required' })
      const action: AyniAction = input.forwardedProps?.ayni ?? { kind: 'text' }
      if (!validateAction(action))
        return reply.code(400).send({
          error: 'bad-request',
          message: `invalid forwardedProps.ayni: ${ajv.errorsText(validateAction.errors)}`,
        })
      const userMessages = (input.messages ?? []).filter((m) => m.role === 'user')
      const last = userMessages[userMessages.length - 1]
      const content = last?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as { type: string; text?: string }[]).map((p) => p.text ?? '').join(' ')
            : ''
      let resumeAction: AyniAction | undefined
      const resumed = input.resume?.find((r) => r.status === 'resolved')
      if (resumed?.payload && typeof resumed.payload === 'object') {
        const p = resumed.payload as { menuId?: string; itemId?: string }
        if (p.menuId && p.itemId) resumeAction = { kind: 'menu.select', menuId: p.menuId, itemId: p.itemId }
      }
      const effective = resumeAction ?? action
      await this.run(session, input.runId, effective, text, reply, request, last?.id ? String(last.id) : undefined)
    })

    // PROF-RUN-007
    app.post(`${base}/:id/runs/:runId/cancel`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { runId } = request.params as { runId: string }
      const run = this.runs.get(runId)
      if (!run || run.sessionId !== session.id)
        return reply.code(409).send({ error: 'conflict', message: 'run already ended' })
      run.controller.abort()
      return reply.code(202).send()
    })

    // PROF-HIST-001/002
    app.get(`${base}/:id/messages`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { before, limit } = request.query as { before?: string; limit?: string }
      const principal = await this.agent.principalOf(session)
      const entries = await this.agent.memory.history(principal, session, {
        before,
        limit: Math.min(Number(limit) || 50, 200),
      })
      const messages = [...entries].reverse().flatMap(entryToMessages)
      return { messages, nextBefore: entries.length ? entries[entries.length - 1].id : null }
    })

    // PROF-HIST-004/005
    app.post(`${base}/:id/attachments`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const file = await request.file({ limits: { fileSize: this.uploads.maxBytes } }).catch(() => undefined)
      if (!file) return reply.code(400).send({ error: 'bad-request', message: 'multipart file expected' })
      const mimeType = canonicalMime(file.mimetype)
      if (!mimeAllowed(mimeType, this.uploads.types))
        return reply.code(415).send({ error: 'bad-request', message: 'type not accepted' })
      let bytes: Buffer
      try {
        bytes = await file.toBuffer()
      } catch {
        return reply.code(413).send({ error: 'too-large' })
      }
      if (bytes.length > this.uploads.maxBytes) return reply.code(413).send({ error: 'too-large' })
      const attachment = await this.agent.media.ingest(
        session,
        bytes,
        mimeType,
        file.filename,
        session.locale ?? this.agent.pack.language.agent
      )
      return reply.code(201).send({
        attachmentId: attachment.id,
        type: attachment.type,
        mimeType: attachment.mimeType,
        size: attachment.size,
        textRepr: attachment.textRepr,
      })
    })

    // PROF-HIST-003: streamed through the agent with the session token
    app.get(`${base}/:id/attachments/:attachmentId`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { attachmentId } = request.params as { attachmentId: string }
      const object = await this.agent.media.open(session, attachmentId)
      if (!object) return reply.code(404).send({ error: 'not-found' })
      reply.header('content-type', object.mimeType)
      reply.header('cache-control', 'private, max-age=300')
      if (object.filename)
        reply.header('content-disposition', `inline; filename="${encodeURIComponent(object.filename)}"`)
      return reply.send(object.bytes)
    })
  }

  private corsHeaders(request: FastifyRequest): Record<string, string> {
    const origin = request.headers.origin
    const allowed = this.agent.env.aguiAllowedOrigins.length
      ? this.agent.env.aguiAllowedOrigins
      : (this.agent.pack.channels?.agui?.allowedOrigins ?? [])
    if (origin && (allowed.includes(origin) || allowed.includes('*'))) {
      return { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'origin' }
    }
    return {}
  }

  private async run(
    session: Session,
    runId: string,
    action: AyniAction,
    text: string,
    reply: FastifyReply,
    request: FastifyRequest,
    /** the id the client gave its message, kept on the entry so history names it the same way (PROF-HIST-006) */
    clientMessageId?: string
  ): Promise<void> {
    const controller = new AbortController()
    this.runs.set(runId, { sessionId: session.id, controller })
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...this.corsHeaders(request),
    })
    const write = (event: AgUiEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(sse(event))
    }
    // the client closing the run stream cancels the run (PROF-RUN-008)
    request.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort()
    })
    write(ev.runStarted(session.id, runId))
    const sink: TurnSink = {
      emit: (event: TurnEvent) => {
        switch (event.type) {
          case 'text-start':
            return write(ev.textStart(event.messageId))
          case 'text-delta':
            return write(ev.textContent(event.messageId, event.delta))
          case 'text-end':
            return write(ev.textEnd(event.messageId))
          case 'step-started':
            return write(ev.stepStarted(event.label))
          case 'step-finished':
            return write(ev.stepFinished(event.label))
          case 'activity':
            return write(ev.activitySnapshot(event.messageId, event.activityType, event.content))
          case 'inbound':
            // echo of the inbound entry for voice notes: the transcription under the note (PROF-MAP-006)
            for (const a of event.entry.attachments)
              write(
                ev.activitySnapshot(a.id, ACTIVITY.attachment, {
                  ...attachmentActivity(a, 'user'),
                  entryId: event.entry.id,
                })
              )
            return
        }
      },
    }
    try {
      const principal = await this.agent.principalOf(session)
      if (!principal) throw new SessionError('principal missing', 'not-bound')
      let result: Awaited<ReturnType<AyniAgent['action']>>
      if (action.kind === 'text' || action.kind === 'attachments') {
        const attachments =
          action.kind === 'attachments' ? this.agent.media.takeUploads(session, action.attachmentIds) : []
        const voice = attachments.find((a) => a.type === 'voice')
        const entryText =
          text.trim() || voice?.textRepr || attachments.map((a) => a.textRepr).join('\n') || '(empty message)'
        // a reply quotes a message of this conversation (PROF-RUN-009); an unknown id is ignored
        const quoted = action.replyTo ? await this.agent.memory.get(action.replyTo) : undefined
        const replyTo =
          quoted && [session.id, ...(session.lineage ?? [])].includes(quoted.sessionId)
            ? {
                id: quoted.id,
                text: quoted.text.slice(0, 200),
                role: quoted.role === 'agent' ? 'assistant' : 'user',
              }
            : undefined
        result = await this.agent.turn(
          session,
          {
            entry: {
              sessionId: session.id,
              principalId: principal.id,
              role: 'principal',
              sourceType: voice ? 'voice' : attachments.length ? 'media' : 'text',
              text: entryText,
              // the id the client gave the message in its run, so history names it the same way (PROF-HIST-006)
              externalId: clientMessageId,
              attachments,
              language: session.locale ?? this.agent.pack.language.agent,
              backingIdentity: principal.backingIdentity,
              payload: replyTo ? { replyTo } : undefined,
            },
          },
          sink,
          controller.signal
        )
      } else {
        result = await this.agent.action(session, action, sink, controller.signal)
        if (result && 'text' in result && result.text) {
          const id = prefixedId('msg')
          write(ev.textStart(id))
          write(ev.textContent(id, result.text))
          write(ev.textEnd(id))
        }
      }
      if (result && 'cancelled' in result && result.cancelled) {
        write(ev.runError('cancelled', RUN_ERROR_CODE.cancelled))
      } else {
        write(ev.runFinished(session.id, runId, { type: 'success' }))
      }
      await this.streams.publish(session.id, ev.stateSnapshot({ ayni: await this.agent.ayniState(session) }))
    } catch (error) {
      if (error instanceof SessionError && error.code === 'not-bound')
        write(ev.runError(error.message, RUN_ERROR_CODE.notBound))
      else if (controller.signal.aborted) write(ev.runError('cancelled', RUN_ERROR_CODE.cancelled))
      else {
        this.logger.error({ err: error, runId }, 'run failed')
        write(ev.runError(error instanceof Error ? error.message : 'internal error', RUN_ERROR_CODE.internal))
      }
    } finally {
      this.runs.delete(runId)
      if (!reply.raw.writableEnded) reply.raw.end()
    }
  }

  /** Session lifecycle on the stream (PROF-STREAM-003, PROF-BIND-006). */
  public async announceState(session: Session): Promise<void> {
    const value = { state: session.state, ...(session.closedReason ? { reason: session.closedReason } : {}) }
    await this.streams.publish(session.id, ev.custom(CUSTOM_EVENT.sessionState, value))
    if (session.state === 'closed') this.streams.end(session.id)
  }

  public async announceBound(session: Session): Promise<void> {
    const principal = await this.agent.principalOf(session)
    if (!principal) return
    await this.streams.publish(
      session.id,
      ev.custom(CUSTOM_EVENT.sessionBound, {
        principal: this.agent.principalDisplay(principal),
        boundAt: session.boundAt,
        deviceHandle: session.deviceHandle,
        deviceSecret: session.deviceSecret,
        conversationId: session.conversationId,
        resumedFromSessionId: session.resumedFromSessionId,
      })
    )
    await this.announceState(session)
    await this.adapter.pushState(session)
  }
}
