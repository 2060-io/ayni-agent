/**
 * The AG-UI channel endpoints of the Hologram AG-UI Profile v3 (CHAN-ADP-004, PROF-*):
 * descriptor, sessions, binding refresh, session stream, runs and cancellation, history, attachments.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  ACTIVITY,
  type AgentDescriptor,
  CUSTOM_EVENT,
  DESCRIPTOR_PATH,
  type HologramAction,
  PROFILE_VERSION,
  RUN_ERROR_CODE,
} from '@2060.io/hologram-agui-profile'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { HologramAgent } from '../../core/agent.js'
import type { TurnEvent, TurnSink } from '../../core/orchestrator.js'
import { SessionError } from '../../core/sessions.js'
import type { ClientDescription, Session } from '../../core/types.js'
import { mimeAllowed } from '../../media/service.js'
import { prefixedId } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'
import type { AgUiAdapter } from './adapter.js'
import { type AgUiEvent, ev, sse } from './events.js'
import { attachmentActivity, entryToMessages } from './mapping.js'
import type { SessionStreams } from './streams.js'

const require = createRequire(import.meta.url)
const loadSchema = (name: string) =>
  JSON.parse(readFileSync(require.resolve(`@2060.io/hologram-agui-profile/schemas/${name}`), 'utf8'))
const createSessionSchema = loadSchema('create-session.schema.json')
const actionSchema = loadSchema('hologram-action.schema.json')

interface RunAgentInput {
  threadId: string
  runId: string
  messages?: { id?: string; role: string; content?: unknown }[]
  tools?: unknown[]
  forwardedProps?: { hologram?: HologramAction }
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
    private readonly agent: HologramAgent,
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
      profileVersion: PROFILE_VERSION,
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
        voiceNotes: f.voiceNotes,
        uploads: f.voiceNotes || f.inboundImages ? this.uploads : false,
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
      const body = request.body as { client?: ClientDescription; locale?: string; deviceHandle?: string }
      if (!validateCreate(body))
        return reply.code(400).send({ error: 'bad-request', message: ajv.errorsText(validateCreate.errors) })
      const client = body.client as ClientDescription
      const token = this.token(request)
      if (token) {
        try {
          const parent = await this.agent.sessions.authenticate(token)
          this.agent.sessions.requireBound(parent)
          const { session, token: newToken } = await this.agent.createSibling(parent, client, body.locale)
          const principal = await this.agent.principalOf(session)
          await this.agent.welcome(session)
          return reply.code(201).send({
            sessionId: session.id,
            sessionToken: newToken,
            state: session.state,
            agent: { did, name: this.agent.pack.metadata.displayName },
            parentSessionId: parent.id,
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
        } = await this.agent.createSession(client, body.locale, body.deviceHandle)
        return reply.code(201).send({
          sessionId: session.id,
          sessionToken: newToken,
          state: session.state,
          agent: { did, name: this.agent.pack.metadata.displayName },
          binding: this.agent.bindingMaterial(session),
          idleTimeoutSeconds: this.agent.sessions.idleTimeoutSeconds,
          ...(rebind ? { rebind } : {}),
        })
      } catch (error) {
        return this.sendError(reply, error)
      }
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
      const state = await this.agent.hologramState(session)
      reply.raw.write(sse(ev.stateSnapshot({ hologram: state })))
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
      const action: HologramAction = input.forwardedProps?.hologram ?? { kind: 'text' }
      if (!validateAction(action))
        return reply.code(400).send({
          error: 'bad-request',
          message: `invalid forwardedProps.hologram: ${ajv.errorsText(validateAction.errors)}`,
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
      let resumeAction: HologramAction | undefined
      const resumed = input.resume?.find((r) => r.status === 'resolved')
      if (resumed?.payload && typeof resumed.payload === 'object') {
        const p = resumed.payload as { menuId?: string; itemId?: string }
        if (p.menuId && p.itemId) resumeAction = { kind: 'menu.select', menuId: p.menuId, itemId: p.itemId }
      }
      const effective = resumeAction ?? action
      await this.run(session, input.runId, effective, text, reply, request)
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
      if (!mimeAllowed(file.mimetype, this.uploads.types))
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
        file.mimetype,
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
    action: HologramAction,
    text: string,
    reply: FastifyReply,
    request: FastifyRequest
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
                ev.activitySnapshot(a.id, ACTIVITY.attachment, { ...attachmentActivity(a), entryId: event.entry.id })
              )
            return
        }
      },
    }
    try {
      const principal = await this.agent.principalOf(session)
      if (!principal) throw new SessionError('principal missing', 'not-bound')
      let result: Awaited<ReturnType<HologramAgent['action']>>
      if (action.kind === 'text' || action.kind === 'attachments') {
        const attachments =
          action.kind === 'attachments' ? this.agent.media.takeUploads(session, action.attachmentIds) : []
        const voice = attachments.find((a) => a.type === 'voice')
        const entryText =
          text.trim() || voice?.textRepr || attachments.map((a) => a.textRepr).join('\n') || '(empty message)'
        result = await this.agent.turn(
          session,
          {
            entry: {
              sessionId: session.id,
              principalId: principal.id,
              role: 'principal',
              sourceType: voice ? 'voice' : attachments.length ? 'media' : 'text',
              text: entryText,
              attachments,
              language: session.locale ?? this.agent.pack.language.agent,
              backingIdentity: principal.backingIdentity,
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
      await this.streams.publish(session.id, ev.stateSnapshot({ hologram: await this.agent.hologramState(session) }))
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
      })
    )
    await this.announceState(session)
    await this.adapter.pushState(session)
  }
}
