/**
 * The AG-UI channel endpoints of the Ayni AG-UI Profile v3 (CHAN-ADP-004, PROF-*):
 * descriptor, sessions, binding refresh, session stream, runs and cancellation, history, attachments; spaces, the
 * person's memories, handover (§3.7, §3.8); the member picker and the admin view of the user directory (§3.9).
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  ACTIVITY,
  type AgentDescriptor,
  type AyniAction,
  CUSTOM_EVENT,
  DESCRIPTOR_PATH,
  type NoTurn,
  RUN_ERROR_CODE,
  type SpaceNotificationsChangedValue,
} from '@ayni.org/ayni-agui-profile'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { admitsUnidentified, messageDeletionWindowSeconds } from '../../config/packTypes.js'
import type { AyniAgent, QueuedRun } from '../../core/agent.js'
import { CLIENT_METADATA_PATH, type ConnectionsChanged, OAUTH_CALLBACK_PATH } from '../../core/connections.js'
import { conversationOf } from '../../core/conversationOf.js'
import { isCredentialWithheld } from '../../core/credentials.js'
import { conversationKey, type TurnEvent, type TurnSink, withheldValue } from '../../core/orchestrator.js'
import { normalizeClient, SessionError } from '../../core/sessions.js'
import { type SpaceAccess, SpaceError, spaceIdOf } from '../../core/spaces.js'
import type { SpaceToolsChanged } from '../../core/spaceTools.js'
import {
  type ClientDescription,
  type Conversation,
  DIRECTORY_ACTOR,
  type MessageEntry,
  type Principal,
  type Session,
  type Space,
  type SpaceActivity,
  type SpaceMember,
} from '../../core/types.js'
import { TooManyWaiting } from '../../core/waiting.js'
import { canonicalMime, mimeAllowed } from '../../media/service.js'
import { MemoryService } from '../../memory/service.js'
import { type AdminChanged, deviceOf } from '../../platform/adminGrants.js'
import { displayName } from '../../policy/approvals.js'
import { prefixedId } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'
import type { AgUiAdapter } from './adapter.js'
import { registerAdminAccess } from './adminRoutes.js'
import { type AgUiEvent, ev, sse } from './events.js'
import { attachmentActivity, entryToMessages, replyReference, sharedEntryToMessages } from './mapping.js'
import { RunMirror } from './mirror.js'
import type { SessionStreams } from './streams.js'
import { uploadMeasures } from './uploadMeasures.js'
import { uploadName } from './uploadName.js'

/**
 * The profile revision this agent implements: 3.5 (each person's own accounts, Your accounts, the Connect card, a message
 * held back because it carried a credential; ayni-spec D104 to D110), over 3.4 (the tools of a space, the confirmation
 * card of a tool call, the sources of replies and conversations; ayni-spec D96 to D100), 3.3 (spaces, the person's
 * memories and preferences, the deletion window of a message; decision 60) and 3.1 (session grant, flows and
 * `ayni.flow`, `flowId` on routed capabilities, client platform and description).
 */
const AGENT_PROFILE_VERSION = '3.5'
/** A run's response gets a comment this often: it stays open while the run waits or a tool takes its time. */
const RUN_HEARTBEAT_MS = 15_000

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
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats.default(ajv)
const validateCreate = ajv.compile(createSessionSchema)
const validateAction = ajv.compile(actionSchema)

/** What a member of a space reads of a conversation shared with it: the messages of its transcript (PROF-SPACE-007). */
const SHARED_SOURCE_TYPES = ['text', 'voice', 'media']

/** What a request is told of a space it may see (decision 60): the person's own conversations and the people. */
interface SpaceViewContext {
  conversations: Conversation[]
  principals: Principal[]
  /** what waits for the person in the Notifications of each space (PROF-TOOL-025) */
  waiting?: Map<string | null, number>
}

/** The status of each code of a `SessionError` (profile §9); `ERROR_STATUS` of the profile package lists the same. */
export const SESSION_ERROR_STATUS: Record<SessionError['code'], number> = {
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
}

/** The base of the session endpoints and of the Principal's (profile §3.1). */
const SESSIONS_BASE = '/agui/v3/sessions'

/** A path of the profile: the descriptor (§2), the sessions base, or a path under it, a route taking it or not. */
export function isProfilePath(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  return path === DESCRIPTOR_PATH || path === SESSIONS_BASE || path.startsWith(`${SESSIONS_BASE}/`)
}

/** The private lifetime an attachment's success may keep (PROF-HIST-003); nothing else of the profile keeps one. */
const ATTACHMENT_LIFETIME = /^private, max-age=\d+$/

/**
 * The `Cache-Control` of an answer of the profile (PROF-ERR-003, decision 71): `no-store`, except the private lifetime
 * of an attachment's `200`. A browser kept a `410` that carried none and answered every later `GET /conversations`
 * with it, whatever the token, without asking the agent: Chromium holds a `410` with no freshness of its own as fresh
 * for ever, and the token travels in a header its cache does not key on.
 */
export function cacheControlOf(status: number, routeValue: unknown): string {
  return status === 200 && typeof routeValue === 'string' && ATTACHMENT_LIFETIME.test(routeValue)
    ? routeValue
    : 'no-store'
}

/** The attachments of a message as its sender gets them back: a voice note with its transcription (PROF-MAP-006). */
function attachmentEcho(entry: MessageEntry): AgUiEvent[] {
  return entry.attachments.map((a) =>
    ev.activitySnapshot(a.id, ACTIVITY.attachment, { ...attachmentActivity(a, 'user'), entryId: entry.id })
  )
}

export class AgUiRoutes {
  /**
   * the runs in progress, each with the key of its conversation; `conversation` on the one the agent started for what
   * waited, which any device of the conversation may stop (PROF-RUN-012)
   */
  private readonly runs = new Map<
    string,
    { sessionId: string; controller: AbortController; key: string; conversation?: string }
  >()
  /** the run requests being answered, each until its response has ended; and who waits for none to be */
  private answering = 0
  private readonly whenQuiet: (() => void)[] = []
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
        // the unread count is the agent's, the same on every device (D62, PROF-DESC-005)
        readState: true,
        // a message sent while a turn is in progress waits and is answered next (D63, PROF-DESC-006)
        queue: true,
        // a wallet waits for the agent's status before it asks for a session grant (D71, PROF-DESC-007):
        // declared only when the DIDComm agent can send one
        peerStatus: this.agent.peerStatus?.declared === true,
        // the context figure of a conversation in state.ayni.context (D74, PROF-DESC-008)
        context: true,
        // a person deletes their own message, with the reply to it, within the pack's window; none with a window of 0
        // (decision 60, PROF-DESC-008)
        ...(messageDeletionWindowSeconds(this.agent.pack) > 0
          ? { erasure: { windowSeconds: messageDeletionWindowSeconds(this.agent.pack) } }
          : {}),
        // the tools of a space, the confirmation card of a call, the sources of replies (ayni-spec D96 to D100,
        // PROF-DESC-009)
        tools: true,
        // each person's own accounts, while the agent-pack declares a source of them (ayni-spec D104 to D110,
        // PROF-DESC-010): an agent with none shows no Your accounts
        ...(this.agent.connections?.personalSources().length ? { connections: true } : {}),
        // the Notifications of a space and of the agent: approvals, pending and past (ayni-spec D114, PROF-DESC-011)
        notifications: true,
        // a person may enter without authenticating, as a visitor: the agent-pack names no authentication schema, or
        // one offered or asked on request (IDENT-RES-007, IDENT-RES-010, PROF-DESC-012); an agent that requires it
        // declares nothing
        ...(admitsUnidentified(this.agent.pack) ? { visitors: true } : {}),
        // admin access from the agent's card: Show Admin, Audit and Operations (agent D132, D133, PROF-DESC-013), while
        // the agent-pack declares auditor or operator
        ...(this.agent.adminGrants ? { admin: true } : {}),
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

  /** A bound session and its Principal, or the answer that refuses the request. */
  private async bound(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<{ session: Session; principal: Principal } | undefined> {
    const session = await this.session(request, reply, true)
    if (!session) return undefined
    const principal = await this.agent.principalOf(session)
    if (!principal) {
      reply.code(404).send({ error: 'not-found' })
      return undefined
    }
    return { session, principal }
  }

  private sendError(reply: FastifyReply, error: unknown): void {
    if (error instanceof SpaceError) {
      reply.code(error.status).send({
        error: error.code,
        message: error.message,
        ...(error.field ? { field: error.field } : {}),
        ...(error.extra ?? {}),
      })
      return
    }
    if (error instanceof SessionError) {
      const code = SESSION_ERROR_STATUS[error.code]
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

  /** `did`: the agent's DID as the DIDComm agent reports it, known once it answers (IDENT-SELF-001) */
  public register(app: FastifyInstance, did: () => string): void {
    // every answer of the profile, its errors and the not-found of a path no route takes included, is stored by no
    // browser and no proxy (PROF-ERR-003, decision 71); the two streams write their own: `no-store, no-transform`
    app.addHook('onSend', async (request, reply, payload) => {
      if (isProfilePath(request.url))
        reply.header('cache-control', cacheControlOf(reply.statusCode, reply.getHeader('cache-control')))
      return payload
    })
    app.get(DESCRIPTOR_PATH, async () => this.descriptor(did()))
    const base = SESSIONS_BASE

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
        silent?: boolean
        /** the space of the new conversation (PROF-CONV-011) */
        spaceId?: string
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
            body.resumeSessionId,
            body.spaceId
          )
          const principal = await this.agent.principalOf(session)
          // the response hands the device secret: the session keeps it no longer (IDENT-DEV-001)
          const deviceSecret = await this.agent.sessions.takeDeviceSecret(session)
          await this.agent.welcome(session)
          return reply.code(201).send({
            sessionId: session.id,
            sessionToken: newToken,
            state: session.state,
            agent: { did: did(), name: this.agent.pack.metadata.displayName },
            principal: principal ? this.agent.principalDisplay(principal) : undefined,
            deviceHandle: session.deviceHandle,
            deviceSecret,
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
            body.newConversation === true,
            body.spaceId
          )
          const principal = await this.agent.principalOf(session)
          await this.agent.welcome(session)
          return reply.code(201).send({
            sessionId: session.id,
            sessionToken: newToken,
            state: session.state,
            agent: { did: did(), name: this.agent.pack.metadata.displayName },
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
          body.newConversation === true,
          body.silent === true,
          body.spaceId
        )
        if (session.state === 'bound') {
          // a paired device: bound at once, no phone round trip (PROF-SESS-010); the response hands the rotated
          // secret, which the session keeps no longer (IDENT-DEV-001)
          const principal = await this.agent.principalOf(session)
          const deviceSecret = await this.agent.sessions.takeDeviceSecret(session)
          await this.agent.welcome(session)
          return reply.code(201).send({
            sessionId: session.id,
            sessionToken: newToken,
            state: session.state,
            agent: { did: did(), name: this.agent.pack.metadata.displayName },
            principal: principal ? this.agent.principalDisplay(principal) : undefined,
            deviceHandle: session.deviceHandle,
            deviceSecret,
            conversationId: session.conversationId,
            resumedFromSessionId: session.resumedFromSessionId,
            idleTimeoutSeconds: this.agent.sessions.idleTimeoutSeconds,
          })
        }
        return reply.code(201).send({
          sessionId: session.id,
          sessionToken: newToken,
          state: session.state,
          agent: { did: did(), name: this.agent.pack.metadata.displayName },
          binding: this.agent.bindingMaterial(session),
          idleTimeoutSeconds: this.agent.sessions.idleTimeoutSeconds,
          ...(rebind ? { rebind } : {}),
          ...(pairing ? { pairing } : {}),
        })
      } catch (error) {
        return this.sendError(reply, error)
      }
    })

    // PROF-CONV-001: the Principal's conversations, of one space when one is named (decision 60)
    app.get(`${base}/conversations`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { spaceId } = request.query as { spaceId?: string }
      const list = await this.agent.sessions.listConversations(session.principalId ?? '', spaceId || undefined)
      return {
        conversations: list.map((c) => ({
          id: c.id,
          title: c.title,
          state: c.state,
          createdAt: c.createdAt,
          lastActivityAt: c.lastActivityAt,
          lastPreview: c.lastPreview,
          open: c.open,
          unread: c.unread ?? 0,
          readUpTo: c.readUpTo ?? null,
          spaceId: c.spaceId,
          shared: !!c.sharedAt,
        })),
      }
    })

    // PROF-CONV-002/003: rename, archive, unarchive
    app.patch(`${base}/conversations/:conversationId`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { conversationId: id } = request.params as { conversationId: string }
      const body = (request.body ?? {}) as { title?: string; state?: string; spaceId?: unknown }
      try {
        const principal = await this.agent.principalOf(session)
        if (!principal) return reply.code(404).send({ error: 'not-found' })
        let conversation = await this.agent.sessions.conversationOf(principal, id)
        // another space, only before its first message (PROF-CONV-011, SPACE-CONV-002): checked before anything changes
        if (body.spaceId !== undefined) {
          if (typeof body.spaceId !== 'string' || !body.spaceId)
            return reply.code(400).send({ error: 'bad-request', message: 'spaceId must be a space id' })
          if (await this.agent.sessions.hasStarted(conversation))
            throw new SpaceError('the conversation has a message: its space is fixed', 'has-messages')
          await this.agent.spaces.usable(principal, body.spaceId)
        }
        if (body.state !== undefined && body.state !== 'active' && body.state !== 'archived')
          return reply.code(400).send({ error: 'bad-request', message: 'state must be active or archived' })
        if (typeof body.title === 'string')
          conversation = await this.agent.sessions.renameConversation(conversation, body.title)
        if (body.state === 'active' || body.state === 'archived')
          conversation = await this.agent.sessions.setConversationState(conversation, body.state)
        if (typeof body.spaceId === 'string' && body.spaceId !== spaceIdOf(conversation)) {
          conversation = await this.agent.sessions.setConversationSpace(conversation, body.spaceId)
          // the header of every device that shows it names the new space (state.ayni.space)
          for (const shown of await this.agent.sessions.sessionsOfConversation(conversation))
            await this.adapter.pushState(shown).catch(() => undefined)
        }
        return {
          id: conversation.id,
          title: conversation.title,
          state: conversation.state,
          spaceId: spaceIdOf(conversation),
        }
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

    // a person cannot delete a conversation (PRIV-ERASE-007; PROF-CONV-009 is withdrawn, 404): the erasure of every message of theirs in one is removed,
    // operators erase through the admin interface. Handover: its author shares it with its own space, or stops
    this.registerSpaces(app, base)
    this.registerTools(app, base)
    // admin access (§3.14, D132, D133): while the agent-pack declares an admin role
    const { adminGrants, adminService } = this.agent
    if (adminGrants && adminService)
      registerAdminAccess(app, base, {
        grants: adminGrants,
        service: adminService,
        bound: (request, reply) => this.bound(request, reply),
        sendError: (reply, error) => this.sendError(reply, error),
        titleOf: this.titleOf,
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
        'cache-control': 'no-store, no-transform',
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
      // a conversation of a space its author left: 409 space-left, nothing recorded (PROF-RUN-014)
      const refusal = await this.agent.runRefusal(session, action.kind)
      if (refusal) return reply.code(refusal.status).send({ error: refusal.code, message: refusal.message })
      await this.run(session, input.runId, action, text, reply, request, last?.id ? String(last.id) : undefined)
    })

    // PROF-RUN-007
    app.post(`${base}/:id/runs/:runId/cancel`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { runId } = request.params as { runId: string }
      const run = this.runs.get(runId)
      // a run of this session; or the run the agent started for what waited, which any device of the
      // conversation may stop (PROF-RUN-012)
      const own =
        run?.sessionId === session.id || (!!run?.conversation && run.conversation === conversationKey(session))
      if (!run || !own) return reply.code(409).send({ error: 'conflict', message: 'run already ended' })
      run.controller.abort()
      return reply.code(202).send()
    })

    // PROF-HIST-010, decision 60: a message the Principal wrote, deleted within its window with the reply to it
    app.delete(`${base}/:id/messages/:messageId`, async (request, reply) => {
      const session = await this.session(request, reply, true)
      if (!session) return
      const { messageId } = request.params as { messageId: string }
      const principal = await this.agent.principalOf(session)
      if (!principal) return reply.code(404).send({ error: 'not-found' })
      const result = await this.agent.eraseOwnMessage(session, principal, messageId)
      if (result.outcome === 'not-found') return reply.code(404).send({ error: 'not-found' })
      if (result.outcome !== 'erased') return reply.code(409).send({ error: result.outcome })
      await this.announceErased(principal.id, result.conversationId, result.messageIds, result.clientIds)
      return reply.code(204).send()
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
      const messages = [...entries].reverse().flatMap((e) => entryToMessages(e, this.titleOf, this.featureOf))
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
        // the name the client gave in a field of its own, else the part's (PROF-HIST-008)
        uploadName(file),
        session.locale ?? this.agent.pack.language.agent,
        // what the recorder measured of a voice note (PROF-HIST-009)
        uploadMeasures(file)
      )
      return reply.code(201).send({
        attachmentId: attachment.id,
        type: attachment.type,
        mimeType: attachment.mimeType,
        size: attachment.size,
        textRepr: attachment.textRepr,
        duration: attachment.duration,
        waveform: attachment.waveform,
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

  // ---- spaces, memories, handover (decision 60, profile 3.3 §3.7 and §3.8) ------------------------------------

  private async spaceViewContext(principal: Principal): Promise<SpaceViewContext> {
    return {
      conversations: await this.agent.sessions.allConversations(principal.id),
      principals: await this.agent.store.principals.list(),
      waiting: await this.agent.notifications.waiting(principal),
    }
  }

  private nameOf(principals: Principal[], id: string): string {
    const p = principals.find((each) => each.id === id)
    return p ? this.personName(p) : id
  }

  /** A person of the home organization by the name the user directory gives them, else as the agent names them. */
  private personName(principal: Principal): string {
    return this.directoryName(principal.directoryEntryId) ?? displayName(principal)
  }

  /** The name the user directory gives a person, when the agent has one and holds the entry (decision 61). */
  private directoryName(directoryId: string | undefined): string | undefined {
    return directoryId ? this.agent.people?.directory?.view(directoryId)?.name : undefined
  }

  /**
   * A member of a list space as its members see it (PROF-SPACE-003): a person who holds a Principal by their name; one
   * of the directory still invited by the name the directory gives them; one of another organization by the address
   * they were invited at, until the invitation binds.
   */
  private memberInfo(m: SpaceMember, principals: Principal[]) {
    const p = m.principalId ? principals.find((each) => each.id === m.principalId) : undefined
    return {
      memberId: m.id,
      name: p ? this.personName(p) : (this.directoryName(m.directoryId) ?? m.email ?? m.directoryId ?? m.id),
      organization:
        p?.backingIdentity?.name ?? m.organizationName ?? p?.backingIdentity?.id ?? m.organizationKey ?? null,
      state: m.state,
      role: m.role,
    }
  }

  /**
   * A space as the person sees it (PROF-SPACE-001): its fields, its rules, its membership, its owner, their role and
   * state in it, and the unread messages of their own conversations of it.
   */
  private async spaceInfo(access: SpaceAccess, ctx: SpaceViewContext, rows?: SpaceMember[]) {
    const { space } = access
    // what waits for the person in its Notifications: the badge of its row (PROF-TOOL-025); Personal lists none
    const waiting = space.kind === 'personal' ? 0 : (ctx.waiting?.get(space.id) ?? 0)
    const personal = space.kind === 'personal'
    const mine = ctx.conversations.filter((c) => spaceIdOf(c) === space.id && c.state !== 'final')
    const members = rows ?? (personal ? [] : await this.agent.spaces.memberRows(space.id))
    const last = mine.map((c) => c.lastActivityAt).sort()
    return {
      id: space.id,
      kind: space.kind,
      title: space.title,
      purpose: space.purpose,
      brief: space.brief,
      templateId: personal ? null : space.templateId,
      language: space.language,
      rules: space.rules,
      membership: {
        mode: space.membership.mode,
        ...(space.membership.mode === 'rule' ? { rule: space.membership.rule } : {}),
        memberCount: this.agent.spaces.memberCount(space, members, ctx.principals),
      },
      // null while it has no owner (SPACE-MEMB-011); its successor to its owner alone (PROF-SPACE-008)
      owner: space.ownerPrincipalId ? { name: this.nameOf(ctx.principals, space.ownerPrincipalId) } : null,
      ...(access.role === 'owner' && !personal
        ? {
            successor: space.successorPrincipalId
              ? { name: this.nameOf(ctx.principals, space.successorPrincipalId) }
              : null,
          }
        : {}),
      role: access.role ?? access.member?.role ?? 'member',
      state: access.left ? 'left' : 'active',
      unread: mine.reduce((sum, c) => sum + (c.unread ?? 0), 0),
      notificationsWaiting: waiting,
      lastActivityAt: last[last.length - 1] ?? space.updatedAt,
    }
  }

  /** A space and, for an active member of a list space, its members (PROF-SPACE-003). */
  private async spaceDetail(access: SpaceAccess, ctx: SpaceViewContext) {
    const { space } = access
    const rows = space.kind === 'personal' ? [] : await this.agent.spaces.memberRows(space.id)
    return {
      ...(await this.spaceInfo(access, ctx, rows)),
      ...(space.membership.mode === 'list' && space.kind !== 'personal' && !access.left
        ? { members: rows.map((m) => this.memberInfo(m, ctx.principals)) }
        : {}),
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    }
  }

  /** A template the person may create from: its title, kind and membership, and the bounds an owner works within. */
  private templateInfo(template: ReturnType<AyniAgent['spaces']['templates']>[number]) {
    const resolved = this.agent.spaces.resolve(template)
    const m = template.membership
    return {
      id: template.id,
      title: template.title,
      kind: template.kind,
      membership: m.mode,
      ...(m.mode === 'rule' ? { rule: m.rule } : {}),
      rules: {
        retentionDays: resolved.retentionDays,
        lawfulBasis: resolved.lawfulBasis,
        allowedProviders: resolved.allowedProviders,
        handover: resolved.handover,
        approvalTimeouts: resolved.approvalTimeouts,
      },
    }
  }

  /**
   * One line of a space's activity (PROF-SPACE-006): who did what, and to whom; never the value of a field. What a reload
   * of the user directory did names no one as `by`.
   */
  private async activityItem(a: SpaceActivity, principals: Principal[]) {
    const member = a.memberId ? await this.agent.store.spaceMembers.get(a.memberId) : undefined
    const principalId = member?.principalId ?? a.principalId
    const name = principalId
      ? this.nameOf(principals, principalId)
      : this.directoryName(member?.directoryId ?? a.directoryId)
    return {
      id: a.id,
      at: a.at,
      kind: a.action,
      ...(a.actorId === DIRECTORY_ACTOR ? {} : { by: { name: this.nameOf(principals, a.actorId) } }),
      ...(name ? { member: { name } } : {}),
      ...(a.fields ? { fields: a.fields } : {}),
      ...(a.conversationId ? { conversationId: a.conversationId } : {}),
      // the source of a change of the space's tools, with its feature, never a value of its account (PROF-TOOL-006)
      ...(a.sourceId ? { tool: { source: a.sourceId, title: this.titleOf(a.sourceId) } } : {}),
      ...((feature) => (feature ? { feature: { id: feature.id, title: feature.title } } : {}))(
        this.agent.catalog?.feature(a.featureId ?? this.agent.catalog?.source(a.sourceId ?? '')?.feature)
      ),
      ...(a.formerSourceId ? { formerTool: { source: a.formerSourceId, title: this.titleOf(a.formerSourceId) } } : {}),
      // how the owner changed, and a steward's reason (SPACE-MEMB-008, PROF-SPACE-009)
      ...(a.how ? { how: a.how } : {}),
      ...(a.reason ? { reason: a.reason } : {}),
    }
  }

  /** A space as a steward reads it (PROF-SPACE-009): its title, template, kind, owner, successor and size; nothing else. */
  private async stewardedInfo(space: Space, principals: Principal[]) {
    const rows = await this.agent.spaces.memberRows(space.id)
    return {
      id: space.id,
      title: space.title,
      templateId: space.templateId,
      kind: space.kind,
      owner: space.ownerPrincipalId ? { name: this.nameOf(principals, space.ownerPrincipalId) } : null,
      successor: space.successorPrincipalId ? { name: this.nameOf(principals, space.successorPrincipalId) } : null,
      memberCount: this.agent.spaces.memberCount(space, rows, principals),
    }
  }

  /** A source's title, as people read it (TOOL-CAT-001). */
  private readonly titleOf = (sourceId: string): string => this.agent.catalog?.source(sourceId)?.title ?? sourceId

  /** The feature a source served, by the id a result recorded, else the source's own (TOOL-FEAT-019, PROF-TOOL-035). */
  private readonly featureOf = (featureId: string | undefined, sourceId: string) => {
    const feature = this.agent.catalog?.feature(featureId ?? this.agent.catalog?.source(sourceId)?.feature)
    return feature ? { id: feature.id, title: feature.title } : undefined
  }

  /**
   * Every bound session showing a conversation of the space: its header names the space again when the space's title
   * changes (PROF-STREAM-009).
   */
  private async spaceRenamed(spaceId: string): Promise<void> {
    for (const conversation of await this.agent.sessions.conversationsOfSpace(spaceId))
      for (const shown of await this.agent.sessions.sessionsOfConversation(conversation))
        await this.adapter.pushState(shown).catch(() => undefined)
  }

  /** The endpoints of spaces, handover and the person's memories (profile 3.3, decision 60). */
  private registerSpaces(app: FastifyInstance, base: string): void {
    const handle =
      (
        work: (
          bound: { session: Session; principal: Principal },
          request: FastifyRequest,
          reply: FastifyReply
        ) => Promise<unknown>
      ) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const bound = await this.bound(request, reply)
        if (!bound) return
        try {
          return await work(bound, request, reply)
        } catch (error) {
          return this.sendError(reply, error)
        }
      }
    const visible = async (principal: Principal, spaceId: string): Promise<SpaceAccess> => {
      const access = await this.agent.spaces.access(principal, spaceId)
      if (!access) throw new SpaceError('space not found', 'not-found')
      return access
    }
    /** A shared conversation of a space, for one of its active members (PROF-SPACE-007); 404 for anything else. */
    const sharedConversation = async (principal: Principal, spaceId: string, conversationId: string) => {
      const takes = await this.agent.spaces.readsHandovers(principal, spaceId)
      const conversation = await this.agent.sessions.conversationById(conversationId)
      if (!takes || !conversation || spaceIdOf(conversation) !== spaceId || !conversation.sharedAt)
        throw new SpaceError('conversation not found', 'not-found')
      return conversation
    }

    // the person's spaces, Personal first, and the templates they may create from (PROF-SPACE-001)
    app.get(
      `${base}/spaces`,
      handle(async ({ principal }) => {
        const ctx = await this.spaceViewContext(principal)
        const spaces = []
        for (const access of await this.agent.spaces.listFor(principal)) spaces.push(await this.spaceInfo(access, ctx))
        return { spaces, templates: this.agent.spaces.creatable(principal).map((t) => this.templateInfo(t)) }
      })
    )

    // PROF-SPACE-002
    app.post(
      `${base}/spaces`,
      handle(async ({ principal }, request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>
        if (typeof body.templateId !== 'string') throw new SpaceError('templateId is required', 'bad-request')
        const space = await this.agent.spaces.create(principal, {
          templateId: body.templateId,
          title: body.title as string,
          purpose: body.purpose as string,
          brief: body.brief as string | undefined,
        })
        const access = await visible(principal, space.id)
        return reply.code(201).send(await this.spaceDetail(access, await this.spaceViewContext(principal)))
      })
    )

    // PROF-SPACE-003
    app.get(
      `${base}/spaces/:spaceId`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        return this.spaceDetail(await visible(principal, spaceId), await this.spaceViewContext(principal))
      })
    )

    // PROF-SPACE-004: the owner, within the bounds of the template
    app.patch(
      `${base}/spaces/:spaceId`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        const body = (request.body ?? {}) as Record<string, unknown>
        const before = await this.agent.spaces.find(spaceId)
        const space = await this.agent.spaces.update(principal, spaceId, {
          title: body.title as string | undefined,
          purpose: body.purpose as string | undefined,
          brief: body.brief as string | undefined,
          language: body.language as string | null | undefined,
          rules: (body.rules ?? undefined) as Partial<Space['rules']> | undefined,
        })
        if (before && before.title !== space.title) await this.spaceRenamed(space.id)
        return this.spaceDetail(await visible(principal, spaceId), await this.spaceViewContext(principal))
      })
    )

    // PROF-SPACE-005: a person of the user directory by `directoryId`, `invited` until a Principal holds that entry
    // (SPACE-MEMB-002). A person of another organization comes with the invitations (agent phase 2b: 501 meanwhile)
    app.post(
      `${base}/spaces/:spaceId/members`,
      handle(async ({ principal }, request, reply) => {
        const { spaceId } = request.params as { spaceId: string }
        const row = await this.agent.spaces.addMember(
          principal,
          spaceId,
          (request.body ?? {}) as Record<string, unknown>
        )
        return reply.code(201).send(this.memberInfo(row, await this.agent.store.principals.list()))
      })
    )

    app.delete(
      `${base}/spaces/:spaceId/members/:memberId`,
      handle(async ({ principal }, request, reply) => {
        const { spaceId, memberId } = request.params as { spaceId: string; memberId: string }
        await this.agent.spaces.removeMember(principal, spaceId, memberId)
        return reply.code(204).send()
      })
    )

    // PROF-SPACE-006, SPACE-MEMB-007: a member of a list space by `memberId`; a person the rule of a rule space matches,
    // who holds a Principal, by `directoryId`. From a steward of the space's template who is not its owner, with a reason
    // (SPACE-MEMB-011, PROF-SPACE-009)
    app.post(
      `${base}/spaces/:spaceId/owner`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        const body = (request.body ?? {}) as { memberId?: unknown; directoryId?: unknown; reason?: unknown }
        const { memberId, directoryId } = body
        const space = await this.agent.spaces.find(spaceId)
        const owner = !!space && space.ownerPrincipalId === principal.id
        if (space && !owner && (this.agent.spaces.isSteward(principal, space) || body.reason !== undefined)) {
          const named = await this.agent.spaces.stewardNames(principal, spaceId, { memberId, directoryId }, body.reason)
          return this.stewardedInfo(named, await this.agent.store.principals.list())
        }
        if (memberId === undefined && directoryId === undefined)
          throw new SpaceError('memberId or directoryId is required', 'bad-request')
        await this.agent.spaces.transferOwner(principal, spaceId, { memberId, directoryId })
        return this.spaceDetail(await visible(principal, spaceId), await this.spaceViewContext(principal))
      })
    )

    // PROF-SPACE-008, SPACE-MEMB-010: the owner names the successor, or clears it
    app.put(
      `${base}/spaces/:spaceId/successor`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        const { memberId, directoryId } = (request.body ?? {}) as { memberId?: unknown; directoryId?: unknown }
        await this.agent.spaces.setSuccessor(principal, spaceId, { memberId, directoryId })
        return this.spaceDetail(await visible(principal, spaceId), await this.spaceViewContext(principal))
      })
    )
    app.delete(
      `${base}/spaces/:spaceId/successor`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        await this.agent.spaces.removeSuccessor(principal, spaceId)
        return this.spaceDetail(await visible(principal, spaceId), await this.spaceViewContext(principal))
      })
    )

    // PROF-SPACE-009, SPACE-MEMB-011: the spaces of the templates a steward stewards, and who could own one
    app.get(
      `${base}/stewardship`,
      handle(async ({ principal }) => {
        const principals = await this.agent.store.principals.list()
        const spaces = []
        for (const space of await this.agent.spaces.stewarded(principal))
          spaces.push(await this.stewardedInfo(space, principals))
        return { spaces }
      })
    )
    app.get(
      `${base}/spaces/:spaceId/owner/candidates`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        return { candidates: await this.agent.spaces.candidates(principal, spaceId, (p) => this.personName(p)) }
      })
    )

    app.get(
      `${base}/spaces/:spaceId/activity`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        const { before, limit } = request.query as { before?: string; limit?: string }
        const page = await this.agent.spaces.activity(principal, spaceId, {
          before: before || undefined,
          limit: Number(limit) || undefined,
        })
        const principals = await this.agent.store.principals.list()
        const activity = []
        for (const a of page.items) activity.push(await this.activityItem(a, principals))
        return { activity, nextBefore: page.nextBefore }
      })
    )

    // handover (S5, PROF-CONV-012): the author shares a conversation with its own space, read-only for its members,
    // live until the author stops (H1 and H2 were not answered: these two limits are flagged in decision 60)
    app.post(
      `${base}/conversations/:conversationId/share`,
      handle(async ({ principal }, request) => {
        const { conversationId } = request.params as { conversationId: string }
        let conversation = await this.agent.sessions.conversationOf(principal, conversationId)
        const space = await this.agent.spaces.mayShare(principal, conversation)
        if (!conversation.sharedAt) {
          conversation = await this.agent.sessions.setConversationShared(conversation, new Date().toISOString())
          await this.agent.spaces.record(space.id, principal.id, 'shared', { conversationId })
        }
        return { shared: true, sharedAt: conversation.sharedAt, conversationId, spaceId: space.id }
      })
    )

    app.delete(
      `${base}/conversations/:conversationId/share`,
      handle(async ({ principal }, request, reply) => {
        const { conversationId } = request.params as { conversationId: string }
        const conversation = await this.agent.sessions.conversationOf(principal, conversationId)
        if (conversation.sharedAt) {
          await this.agent.sessions.setConversationShared(conversation, null)
          await this.agent.spaces.record(spaceIdOf(conversation), principal.id, 'unshared', { conversationId })
        }
        return reply.code(204).send()
      })
    )

    // PROF-SPACE-007: what an active member reads of the handovers of a space
    app.get(
      `${base}/spaces/:spaceId/shared`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        // a space that takes no handover has nothing shared (PROF-SPACE-007)
        if (!(await this.agent.spaces.readsHandovers(principal, spaceId))) return { conversations: [] }
        const principals = await this.agent.store.principals.list()
        const shared = await this.agent.sessions.conversationsOfSpace(spaceId, true)
        return {
          conversations: shared.map((c) => ({
            id: c.id,
            title: c.title,
            author: { name: this.nameOf(principals, c.principalId) },
            sharedAt: c.sharedAt,
            lastActivityAt: c.lastActivityAt,
          })),
        }
      })
    )

    // its transcript as it is now, read-only, without what is the author's own
    app.get(
      `${base}/spaces/:spaceId/shared/:conversationId/messages`,
      handle(async ({ principal }, request) => {
        const { spaceId, conversationId } = request.params as { spaceId: string; conversationId: string }
        const conversation = await sharedConversation(principal, spaceId, conversationId)
        const { before, limit } = request.query as { before?: string; limit?: string }
        const entries = await this.agent.memory.sharedHistory(
          principal,
          conversation,
          this.agent.sessions.scopeOf(conversation),
          { before, limit: Math.min(Number(limit) || 50, 200), sourceTypes: SHARED_SOURCE_TYPES }
        )
        const messages = [...entries].reverse().flatMap((e) => sharedEntryToMessages(e, this.titleOf, this.featureOf))
        return { messages, nextBefore: entries.length ? entries[entries.length - 1]?.id : null }
      })
    )

    // and its attachments, as the history names them
    app.get(
      `${base}/spaces/:spaceId/shared/:conversationId/attachments/:attachmentId`,
      handle(async ({ principal }, request, reply) => {
        const { spaceId, conversationId, attachmentId } = request.params as {
          spaceId: string
          conversationId: string
          attachmentId: string
        }
        const conversation = await sharedConversation(principal, spaceId, conversationId)
        const object = await this.agent.media.openShared(
          principal,
          conversation,
          this.agent.sessions.scopeOf(conversation),
          attachmentId
        )
        if (!object) return reply.code(404).send({ error: 'not-found' })
        reply.header('content-type', object.mimeType)
        reply.header('cache-control', 'private, max-age=300')
        if (object.filename)
          reply.header('content-disposition', `inline; filename="${encodeURIComponent(object.filename)}"`)
        return reply.send(object.bytes)
      })
    )

    // the person's own memories and preferences (PROF-MEM-001/002): they see and delete them, and change them by
    // telling the agent in a conversation
    app.get(
      `${base}/memories`,
      handle(async ({ session, principal }, request) => {
        const { spaceId } = request.query as { spaceId?: string }
        const preferences = await this.agent.memory.ownPreferences(principal, session)
        const notes = await this.agent.memory.ownNotes(principal, session, spaceId || undefined)
        const memories = []
        for (const n of notes) {
          // the conversation it came from, while the person can still read it
          const from = n.lineageRefs[0] ? await this.agent.store.entries.get(n.lineageRefs[0]) : undefined
          const kept = from && from.principalId === principal.id && from.state !== 'crypto-erased'
          const conversation = kept ? await this.agent.sessions.conversationById(from.conversationId) : undefined
          const readable = conversation && conversation.principalId === principal.id && conversation.state !== 'final'
          memories.push({
            id: n.id,
            spaceId: MemoryService.spaceOfNote(n),
            content: n.content,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
            ...(readable ? { source: { conversationId: conversation.id, title: conversation.title } } : {}),
          })
        }
        return {
          preferences: preferences.map((p) => ({ key: p.key, value: p.value, updatedAt: p.updatedAt })),
          memories,
        }
      })
    )

    app.delete(
      `${base}/memories/:memoryId`,
      handle(async ({ principal }, request, reply) => {
        const { memoryId } = request.params as { memoryId: string }
        const removed = await this.agent.memory.removeNote(principal, memoryId)
        if (!removed) return reply.code(404).send({ error: 'not-found' })
        return reply.code(204).send()
      })
    )

    app.delete(
      `${base}/preferences/:key`,
      handle(async ({ principal }, request, reply) => {
        const { key } = request.params as { key: string }
        const removed = await this.agent.memory.deletePreference(principal, key)
        return removed ? reply.code(204).send() : reply.code(404).send({ error: 'not-found' })
      })
    )

    // PROF-MEM-003: what the agent keeps about the person
    app.get(
      `${base}/about-me`,
      handle(async ({ session, principal }) => this.agent.aboutMe(principal, session))
    )

    // PROF-DIR-001, SPACE-MEMB-005: the member picker, to a person who owns a list space or may create one; names and
    // departments only, never an email, a birthdate or a nationality (IDENT-DIR-007)
    app.get(
      `${base}/directory`,
      handle(async ({ principal }, request) => {
        const { q } = request.query as { q?: string }
        const people = this.agent.people
        if (!people)
          throw new SpaceError('only the owner of a list space, or who may create one, picks people', 'not-creator')
        return people.search(principal, typeof q === 'string' ? q : '')
      })
    )

    // PROF-DIR-002, SPACE-INV-001: the organizations of the trust graph a person of another organization is invited from,
    // the agent's own excluded; to the same people as the member picker
    app.get(
      `${base}/organizations`,
      handle(async ({ principal }, request) => {
        const { q } = request.query as { q?: string }
        const invitations = this.agent.invitations
        if (!invitations)
          throw new SpaceError('only the owner of a list space, or who may create one, invites people', 'not-creator')
        return invitations.search(principal, typeof q === 'string' ? q : '')
      })
    )

    // PROF-DIR-003, IDENT-DIR-008/009: who holds which role and why, and what each reload changed; to an admin only
    app.get(
      `${base}/admin/roles`,
      handle(async ({ principal }) => {
        if (!this.agent.people) throw new SpaceError('only an admin of the agent reads the admin view', 'not-admin')
        return this.agent.people.adminRoles(principal)
      })
    )
    app.get(
      `${base}/admin/changes`,
      handle(async ({ principal }, request) => {
        if (!this.agent.people) throw new SpaceError('only an admin of the agent reads the admin view', 'not-admin')
        const { before, limit } = request.query as { before?: string; limit?: string }
        return this.agent.people.adminChanges(principal, {
          before: before || undefined,
          limit: Number(limit) || undefined,
        })
      })
    )
  }

  /** The endpoints of the tools of a space, the sources of a conversation and its allowances (profile 3.4). */
  private registerTools(app: FastifyInstance, base: string): void {
    const handle =
      (
        work: (
          bound: { session: Session; principal: Principal },
          request: FastifyRequest,
          reply: FastifyReply
        ) => Promise<unknown>
      ) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const bound = await this.bound(request, reply)
        if (!bound) return
        try {
          return await work(bound, request, reply)
        } catch (error) {
          return this.sendError(reply, error)
        }
      }
    const tools = () => {
      if (!this.agent.spaceTools) throw new SpaceError('the tools of the spaces are not served here', 'not-found')
      return this.agent.spaceTools
    }
    type Params = { spaceId: string; source: string }

    // PROF-TOOL-001: the owner reads every source of the template, a member the ready ones
    app.get(
      `${base}/spaces/:spaceId/tools`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as Params
        return { tools: await tools().list(principal, spaceId) }
      })
    )
    // PROF-TOOL-002: add an available source, or switch an off one back on: 202 with the change pending
    app.post(
      `${base}/spaces/:spaceId/tools`,
      handle(async ({ session, principal }, request, reply) => {
        const { spaceId } = request.params as Params
        const tool = await tools().add(principal, session, spaceId, (request.body ?? {}) as Record<string, unknown>)
        return reply.code(202).send({ tool })
      })
    )
    // PROF-TOOL-003: 200 applied when it only tightens, 202 pending when any part of it grants something
    app.patch(
      `${base}/spaces/:spaceId/tools/:source`,
      handle(async ({ session, principal }, request, reply) => {
        const { spaceId, source } = request.params as Params
        const result = await tools().patch(
          principal,
          session,
          spaceId,
          source,
          (request.body ?? {}) as Record<string, unknown>
        )
        return reply.code(result.status).send({ tool: result.tool })
      })
    )
    // PROF-TOOL-004: the space's account, typed by its owner here and nowhere else (TOOL-ACCESS-003): one value for each
    // field its source declares (D102)
    app.put(
      `${base}/spaces/:spaceId/tools/:source/account`,
      handle(async ({ session, principal }, request, reply) => {
        const { spaceId, source } = request.params as Params
        const body = (request.body ?? {}) as { values?: unknown }
        const tool = await tools().setAccount(principal, session, spaceId, source, body.values)
        return reply.code(202).send({ tool })
      })
    )
    app.delete(
      `${base}/spaces/:spaceId/tools/:source/account`,
      handle(async ({ principal }, request) => {
        const { spaceId, source } = request.params as Params
        return { tool: await tools().clearAccount(principal, spaceId, source) }
      })
    )
    // PROF-TOOL-023: the locations of a provider of a feature with a contract, read with the owner's own calls' account
    app.get(
      `${base}/spaces/:spaceId/tools/:source/list/choices`,
      handle(async ({ principal }, request) => {
        const { spaceId, source } = request.params as Params
        const { text } = (request.query ?? {}) as { text?: unknown }
        return { choices: await tools().choices(principal, spaceId, source, text) }
      })
    )
    // PROF-TOOL-005: remove the source at once; withdraw the pending change
    app.delete(
      `${base}/spaces/:spaceId/tools/:source/pending`,
      handle(async ({ principal }, request, reply) => {
        const { spaceId, source } = request.params as Params
        await tools().withdraw(principal, spaceId, source)
        return reply.code(204).send()
      })
    )
    app.delete(
      `${base}/spaces/:spaceId/tools/:source`,
      handle(async ({ principal }, request) => {
        const { spaceId, source } = request.params as Params
        return { tool: await tools().remove(principal, spaceId, source) }
      })
    )
    // PROF-TOOL-011: the sources of the tool results a conversation holds, for its Principal only
    app.get(
      `${base}/conversations/:conversationId/sources`,
      handle(async ({ principal }, request) => {
        const { conversationId } = request.params as { conversationId: string }
        const conversation = await this.agent.sessions.conversationOf(principal, conversationId)
        return { sources: (await this.agent.gate?.conversationSources(conversation.id)) ?? [] }
      })
    )
    // PROF-TOOL-012: stop the allowance a confirmation gave
    app.delete(
      `${base}/conversations/:conversationId/allowances/:approvalId`,
      handle(async ({ principal }, request, reply) => {
        const { conversationId, approvalId } = request.params as { conversationId: string; approvalId: string }
        const conversation = await this.agent.sessions.conversationOf(principal, conversationId)
        const stopped = await this.agent.gate?.stopAllowance(conversation.id, approvalId)
        return stopped ? reply.code(204).send() : reply.code(404).send({ error: 'not-found' })
      })
    )

    // ---- the Notifications (§3.12, ayni-spec D114): a space's, and the agent's for what no space holds ---------------
    const page = (request: FastifyRequest) => {
      const query = (request.query ?? {}) as { before?: unknown; limit?: unknown }
      const limit = query.limit === undefined ? undefined : Number(query.limit)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
        throw new SpaceError('limit must be a whole number from 1', 'bad-request', 'limit')
      return { before: typeof query.before === 'string' && query.before ? query.before : undefined, limit }
    }
    // PROF-TOOL-024: the approvals of the space's tools, for a member of it; 404 to anyone else
    app.get(
      `${base}/spaces/:spaceId/notifications`,
      handle(async ({ principal }, request) => {
        const { spaceId } = request.params as { spaceId: string }
        const access = await this.agent.spaces.access(principal, spaceId)
        if (!access || access.left) throw new SpaceError('space not found', 'not-found')
        // Personal holds no tool of a space: its approvals are the agent's (INTX-APPR-017), and its list is empty
        return this.agent.notifications.list(principal, access.space.id, page(request))
      })
    )
    // PROF-TOOL-024: every other approval: by roles, of a tool of the whole agent or of Personal, an elevation request
    app.get(
      `${base}/notifications`,
      handle(async ({ principal }, request) => this.agent.notifications.list(principal, null, page(request)))
    )
    // PROF-TOOL-026: Decide on your phone, the request sent to the phone again
    app.post(
      `${base}/approvals/:approvalId/resend`,
      handle(async ({ principal }, request, reply) => {
        const { approvalId } = request.params as { approvalId: string }
        return reply.code(202).send(await this.agent.resendApproval(principal, approvalId))
      })
    )

    // ---- Your accounts (profile 3.5 §3.11): each person's own, read and changed by that person alone -----------------
    const connections = () => {
      if (!this.agent.connections) throw new SpaceError('no account is served here', 'not-found')
      return this.agent.connections
    }
    // PROF-TOOL-014: one item per account the person can connect or holds, with no token and no value
    app.get(
      `${base}/connections`,
      handle(async ({ principal }) => ({
        connections: this.agent.connections ? await this.agent.connections.list(principal) : [],
      }))
    )
    // PROF-TOOL-015: a sign-in in the browser; no confirmation on the phone (D104)
    app.post(
      `${base}/connections/:source/authorize`,
      handle(async ({ session, principal }, request, reply) => {
        const { source } = request.params as { source: string }
        const body = (request.body ?? {}) as { spaceId?: unknown }
        const attempt = await connections().startAuthorize(principal, session, source, body.spaceId)
        return reply.code(202).send(attempt)
      })
    )
    app.delete(
      `${base}/connections/attempts/:attemptId`,
      handle(async ({ principal }, request, reply) => {
        const { attemptId } = request.params as { attemptId: string }
        const ended = await connections().cancelAttempt(principal, attemptId)
        return ended ? reply.code(204).send() : reply.code(404).send({ error: 'not-found' })
      })
    )
    // PROF-TOOL-016: an account of fields, taken at once
    app.put(
      `${base}/connections/:source/account`,
      handle(async ({ principal }, request) => {
        const { source } = request.params as { source: string }
        const body = (request.body ?? {}) as { values?: unknown; spaceId?: unknown }
        return { connection: await connections().setFields(principal, source, body.values, body.spaceId) }
      })
    )
    // PROF-TOOL-017: disconnected at once
    app.delete(
      `${base}/connections/accounts/:accountId`,
      handle(async ({ principal }, request) => {
        const { accountId } = request.params as { accountId: string }
        return { connection: await connections().disconnect(principal, accountId) }
      })
    )
  }

  /**
   * The public paths of people's own accounts (D105): the callback of every sign-in (TOOL-OAUTH-006) and the agent's client
   * ID metadata document (TOOL-OAUTH-004). Neither takes a session token: the callback finds its attempt by its `state`.
   */
  public registerOAuth(app: FastifyInstance): void {
    app.get(OAUTH_CALLBACK_PATH, async (request, reply) => {
      // the answer carries nothing of the sign-in, is stored nowhere and tells no other site where it came from
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      if (!this.agent.connections) return reply.code(404).type('text/plain').send('not found')
      const answer = await this.agent.connections.callback((request.query ?? {}) as Record<string, unknown>)
      if (answer.status === 303 && answer.location) return reply.code(303).header('location', answer.location).send()
      return reply
        .code(answer.status)
        .type('text/html; charset=utf-8')
        .send(answer.page ?? '')
    })
    app.get(CLIENT_METADATA_PATH, async (_request, reply) => {
      if (!this.agent.connections) return reply.code(404).send({ error: 'not-found' })
      return reply.header('cache-control', 'public, max-age=3600').send(this.agent.connections.clientMetadata())
    })
  }

  /** A notification of a person entered, changed or ended: every bound session of theirs hears it (PROF-TOOL-025). */
  public async announceNotifications(principalId: string, value: SpaceNotificationsChangedValue): Promise<void> {
    for (const session of await this.agent.store.sessions.listByPrincipal(principalId, ['bound']))
      if (session.channelType === 'ag-ui')
        await this.streams.publish(session.id, ev.custom(CUSTOM_EVENT.spaceNotificationsChanged, { ...value }))
  }

  /** The admin state of a device changed: every bound session of that device hears it (PROF-ADMIN-004). */
  public async announceAdmin(principalId: string, device: string, value: AdminChanged): Promise<void> {
    for (const session of await this.agent.store.sessions.listByPrincipal(principalId, ['bound']))
      if (session.channelType === 'ag-ui' && deviceOf(session) === device)
        await this.streams.publish(session.id, ev.custom(CUSTOM_EVENT.adminChanged, { ...value }))
  }

  /** One of a person's own accounts, or an attempt, changed: every bound session of theirs hears it (PROF-TOOL-019). */
  public async announceConnections(principalId: string, value: ConnectionsChanged): Promise<void> {
    for (const session of await this.agent.store.sessions.listByPrincipal(principalId, ['bound']))
      if (session.channelType === 'ag-ui')
        await this.streams.publish(session.id, ev.custom(CUSTOM_EVENT.connectionsChanged, { ...value }))
  }

  /** A change of a space's tools applied or was dropped: every bound session of its owner hears it (PROF-TOOL-006). */
  public async announceSpaceTools(space: Space, value: SpaceToolsChanged): Promise<void> {
    if (!space.ownerPrincipalId) return
    for (const session of await this.agent.store.sessions.listByPrincipal(space.ownerPrincipalId, ['bound']))
      if (session.channelType === 'ag-ui')
        await this.streams.publish(session.id, ev.custom(CUSTOM_EVENT.spaceToolsChanged, { ...value }))
  }

  /** Events to every bound session of a conversation, outside a turn: an allowance ended, a card expired. */
  public async announceToConversation(
    conversationId: string,
    events: { name: string; value: Record<string, unknown> }[]
  ): Promise<void> {
    const conversation = await this.agent.sessions.conversationById(conversationId)
    if (!conversation) return
    for (const session of await this.agent.sessions.sessionsOfConversation(conversation))
      for (const event of events) await this.streams.publish(session.id, ev.custom(event.name, event.value))
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
    this.runs.set(runId, { sessionId: session.id, controller, key: conversationKey(session) })
    // counted until its response has ended: a process that ends lets it end first (PLAT-DEPLOY-005)
    this.answering++
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...this.corsHeaders(request),
    })
    const write = (event: AgUiEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(sse(event))
    }
    // `RunStarted` is written when the run does something, not when it arrives: a message sent during a turn gets
    // no turn of its own and says so there (PROF-RUN-011), and an action may wait for its turn. Comments keep the
    // response alive meanwhile, and during a tool that takes its time
    reply.raw.flushHeaders()
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': waiting\n\n')
    }, RUN_HEARTBEAT_MS)
    let started = false
    const start = (noTurn?: NoTurn) => {
      if (started) return
      started = true
      write(ev.runStarted(session.id, runId, noTurn))
    }
    // the person's other devices on this conversation see the run as it happens (PROF-STREAM-005)
    const peers = await this.agent.sessions.conversationPeers(session)
    const mirror = new RunMirror(
      this.streams,
      peers.map((p) => p.id),
      runId,
      this.logger
    )
    /** to the session that runs, and to the conversation's other sessions */
    const emit = (event: AgUiEvent) => {
      write(event)
      mirror.event(event)
    }
    // the client closing the run stream cancels the run (PROF-RUN-008)
    request.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort()
    })
    const sink: TurnSink = {
      emit: (event: TurnEvent) => {
        // the first thing a run does opens it: for a turn, that is its start, after any wait
        start()
        switch (event.type) {
          case 'turn-start':
            return
          case 'custom':
            return emit(ev.custom(event.name, event.value))
          case 'text-start':
            return emit(ev.textStart(event.messageId))
          case 'text-delta':
            return emit(ev.textContent(event.messageId, event.delta))
          case 'text-end':
            return emit(ev.textEnd(event.messageId))
          case 'step-started':
            return emit(ev.stepStarted(event.label))
          case 'step-finished':
            return emit(ev.stepFinished(event.label))
          case 'activity':
            return emit(ev.activitySnapshot(event.messageId, event.activityType, event.content))
          case 'inbound':
            // the other devices get the person's message whole; the device that sent it already shows it
            mirror.inbound(event.entry)
            // echo of the inbound entry for voice notes: the transcription under the note (PROF-MAP-006)
            for (const each of attachmentEcho(event.entry)) write(each)
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
            ? replyReference(quoted)
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
            // sent during a turn, it is recorded and waits, and this run ends at once (PROF-RUN-011)
            mayWait: true,
          },
          sink,
          controller.signal
        )
      } else {
        result = await this.agent.action(session, action, sink, controller.signal)
        // a decision on a confirmation or an approval, a request withdrawn: no turn of its own, the status it has now
        // (PROF-TOOL-008, PROF-TOOL-026)
        if (result && 'decision' in result) {
          start('decision')
          write(ev.runFinished(session.id, runId, { type: 'decision', ...result.decision }))
          return
        }
        // an approval to attest, decided on the phone; one the person may not decide (PROF-TOOL-026)
        if (result && 'refused' in result) {
          start('decision')
          write(
            ev.runError(
              result.refused.message,
              result.refused.code === 'decide-on-phone' ? RUN_ERROR_CODE.decideOnPhone : RUN_ERROR_CODE.notEligible
            )
          )
          return
        }
        if (result && 'text' in result && result.text) {
          const id = prefixedId('msg')
          emit(ev.textStart(id))
          emit(ev.textContent(id, result.text))
          emit(ev.textEnd(id))
        }
      }
      if (result && 'waiting' in result && result.waiting) {
        // no turn for this run: the message is recorded and waits, the agent answers it next (PROF-RUN-011)
        start('waiting')
        // a message that waits and carried a credential: every device of the conversation draws it with the text kept
        // (TOOL-ACCESS-014, PROF-STREAM-011)
        if (result.inbound && isCredentialWithheld(result.inbound)) {
          const withheld = ev.custom(CUSTOM_EVENT.messagesWithheld, withheldValue(result.inbound))
          write(withheld)
          for (const peer of peers) await this.streams.publish(peer.id, withheld).catch(() => undefined)
        }
        write(ev.runFinished(session.id, runId, { type: 'waiting', messageId: result.inbound?.id }))
      } else if (result && 'cancelled' in result && result.cancelled) {
        // stopped; or given up while an action waited for its turn, which ran nothing
        start('withdrawn' in result && result.withdrawn ? 'withdrawn' : undefined)
        write(ev.runError('cancelled', RUN_ERROR_CODE.cancelled))
        mirror.finish({ message: 'cancelled', code: RUN_ERROR_CODE.cancelled })
      } else {
        start()
        write(ev.runFinished(session.id, runId, { type: 'success' }))
        mirror.finish()
      }
      await this.streams.publish(session.id, ev.stateSnapshot({ ayni: await this.agent.ayniState(session) }))
      // the state a run changes (what is being generated, what waits) is the conversation's on every device
      for (const peer of peers) await this.adapter.pushState(peer).catch(() => undefined)
    } catch (error) {
      start(error instanceof TooManyWaiting ? 'refused' : undefined)
      const failed = (message: string, code: string) => {
        write(ev.runError(message, code))
        mirror.finish({ message, code })
      }
      if (error instanceof TooManyWaiting) failed(error.message, RUN_ERROR_CODE.tooManyWaiting)
      else if (error instanceof SessionError && error.code === 'not-bound')
        write(ev.runError(error.message, RUN_ERROR_CODE.notBound))
      else if (controller.signal.aborted) failed('cancelled', RUN_ERROR_CODE.cancelled)
      else {
        this.logger.error({ err: error, runId }, 'run failed')
        failed(error instanceof Error ? error.message : 'internal error', RUN_ERROR_CODE.internal)
      }
    } finally {
      clearInterval(heartbeat)
      this.runs.delete(runId)
      try {
        await mirror.settled()
        if (!reply.raw.writableEnded) reply.raw.end()
      } finally {
        this.answering--
        if (!this.answering) for (const tell of this.whenQuiet.splice(0)) tell()
      }
    }
  }

  /**
   * Cancels the runs in progress on a conversation, as the person stopping them would (CORE-MSG-009): a message deleted
   * while its reply is written stops that reply first (PRIV-ERASE-011). Returns how many it stopped.
   */
  public cancelConversation(key: string): number {
    let stopped = 0
    for (const run of this.runs.values()) {
      if (run.key !== key || run.controller.signal.aborted) continue
      run.controller.abort()
      stopped++
    }
    return stopped
  }

  /**
   * Resolves when no run is being answered any more, or after `withinMs`. A process that ends waits here before it
   * closes the connections: a turn that ended in time is told to its client as any other, with the end of its run
   * (PLAT-DEPLOY-005), where closing at once cut the response between the reply and `RunFinished`.
   */
  public quiet(withinMs: number): Promise<boolean> {
    if (!this.answering) return Promise.resolve(true)
    return new Promise((resolve) => {
      const late = setTimeout(() => resolve(false), withinMs)
      this.whenQuiet.push(() => {
        clearTimeout(late)
        resolve(true)
      })
    })
  }

  /**
   * The run the agent starts for the messages that waited (PROF-RUN-012): no request carries it, so it goes to the
   * stream of every session of the conversation, as the mirror of a run does. Each device gets the messages it
   * did not send, then the reply. Any of them may stop it.
   */
  public async queuedRun(session: Session): Promise<QueuedRun> {
    const runId = prefixedId('run')
    const controller = new AbortController()
    const targets = [session, ...(await this.agent.sessions.conversationPeers(session))].filter(
      (s) => s.channelType === 'ag-ui' && s.state === 'bound'
    )
    this.runs.set(runId, {
      sessionId: session.id,
      controller,
      key: conversationKey(session),
      conversation: conversationKey(session),
    })
    const mirror = new RunMirror(
      this.streams,
      targets.map((s) => s.id),
      runId,
      this.logger
    )
    const sink: TurnSink = {
      emit: (event: TurnEvent) => {
        switch (event.type) {
          case 'turn-start':
            return mirror.begin()
          case 'custom':
            return mirror.event(ev.custom(event.name, event.value))
          case 'text-start':
            return mirror.event(ev.textStart(event.messageId))
          case 'text-delta':
            return mirror.event(ev.textContent(event.messageId, event.delta))
          case 'text-end':
            return mirror.event(ev.textEnd(event.messageId))
          case 'step-started':
            return mirror.event(ev.stepStarted(event.label))
          case 'step-finished':
            return mirror.event(ev.stepFinished(event.label))
          case 'activity':
            return mirror.event(ev.activitySnapshot(event.messageId, event.activityType, event.content))
          case 'inbound':
            // every device but the one that sent it, which shows it already and gets its echo
            mirror.inbound(event.entry)
            for (const each of attachmentEcho(event.entry))
              void this.streams
                .publish(event.entry.sessionId, each)
                .catch((err) => this.logger.debug({ err, runId }, 'echo not sent to the sending device'))
            return
        }
      },
    }
    return {
      sink,
      signal: controller.signal,
      finish: async (result, error) => {
        if (error) mirror.finish({ message: 'internal error', code: RUN_ERROR_CODE.internal })
        else if (result?.cancelled) mirror.finish({ message: 'cancelled', code: RUN_ERROR_CODE.cancelled })
        else mirror.finish()
        this.runs.delete(runId)
        await mirror.settled()
        // the state a run changes is the conversation's on every device
        for (const target of targets) await this.adapter.pushState(target).catch(() => undefined)
      },
    }
  }

  /**
   * A conversation changed (its title, archived or not, closed for good, what is unread in it): every bound session of its Principal
   * hears of it on its stream, whichever conversation that session serves, so each device's list follows the
   * change made on another (PROF-CONV-007).
   */
  public async announceConversation(conversation: Conversation): Promise<void> {
    const sessions = await this.agent.store.sessions.listByPrincipal(conversation.principalId, ['bound'])
    for (const session of sessions) {
      if (session.channelType !== 'ag-ui') continue
      await this.streams.publish(
        session.id,
        ev.custom(CUSTOM_EVENT.conversationChanged, {
          conversationId: conversation.id,
          title: conversation.title,
          state: conversation.state,
          unread: conversation.unread ?? 0,
          readUpTo: conversation.readUpTo ?? null,
          spaceId: spaceIdOf(conversation),
          shared: !!conversation.sharedAt,
        })
      )
    }
  }

  /** Messages erased for good, told to every bound session of the conversation, the requesting one included (PROF-STREAM-008). */
  public async announceErased(
    principalId: string,
    conversationId: string,
    messageIds: string[],
    clientIds: string[] = []
  ): Promise<void> {
    if (!messageIds.length) return
    // a client holds a message it sent under its own id until it reads the history again: it is named both ways, the
    // client's ids in the order of the agent's, the empty string for an entry no client sent, and none when no client sent
    // any (PROF-STREAM-008)
    const aligned = messageIds.map((_id, i) => clientIds[i] ?? '')
    const value = { conversationId, messageIds, ...(aligned.some(Boolean) ? { clientIds: aligned } : {}) }
    const sessions = await this.agent.store.sessions.listByPrincipal(principalId, ['bound'])
    for (const session of sessions) {
      if (session.channelType !== 'ag-ui' || conversationOf(session) !== conversationId) continue
      await this.streams.publish(session.id, ev.custom(CUSTOM_EVENT.messagesErased, value))
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
    const deviceSecret = this.agent.sessions.heldDeviceSecret(session)
    await this.streams.publish(
      session.id,
      ev.custom(CUSTOM_EVENT.sessionBound, {
        principal: this.agent.principalDisplay(principal),
        boundAt: session.boundAt,
        deviceHandle: session.deviceHandle,
        deviceSecret,
        conversationId: session.conversationId,
        resumedFromSessionId: session.resumedFromSessionId,
      })
    )
    // a client on the stream has collected the secret: the session keeps it no longer; one that was not listening
    // picks it up from the status within five minutes (IDENT-DEV-001, PROF-BIND-010)
    if (deviceSecret && this.streams.subscriberCount(session.id) > 0)
      await this.agent.sessions.eraseDeviceSecret(session)
    await this.announceState(session)
    await this.adapter.pushState(session)
  }
}
