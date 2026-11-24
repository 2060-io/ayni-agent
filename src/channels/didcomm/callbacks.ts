/**
 * Callbacks of the face-verification service and the WebRTC server (IDENT-AUTH-010): keyed by the token of a face step of
 * an authentication, never by a session token. A face match is a method of the authentication, never a challenge (D126).
 * Also the short-lived media links for the wallet.
 */
import type { FastifyInstance } from 'fastify'
import type { AyniAgent } from '../../core/agent.js'
import type { Logger } from '../../util/logger.js'
import type { MediaLinks } from './adapter.js'
import type { FaceSteps } from './faceSteps.js'

export function registerDidcommCallbacks(
  app: FastifyInstance,
  agent: AyniAgent,
  links: MediaLinks,
  logger: Logger,
  faces?: Pick<FaceSteps, 'byPeer' | 'byToken' | 'settle'>
): void {
  const visionUrl = () => agent.env.visionUrl ?? agent.pack.media?.faceVerification?.serviceUrl
  /** asks the face-verification service to join a room with a token of its own (CC-FACE-001) */
  const join = (token: string, wsUrl: string, roomId: string, onFailure: (err: unknown) => Promise<void> | void) => {
    const url = visionUrl()
    if (!url || !wsUrl) return
    const body = {
      ws_url: `${wsUrl}/?roomId=${roomId}&peerId=vision-${token}`,
      callback_base_url: `${agent.env.publicBaseUrl}/vision`,
      token,
      lang: agent.pack.language.agent,
    }
    fetch(`${url.replace(/\/+$/, '')}/join-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
      })
      .catch(async (err) => onFailure(err))
  }

  // the WebRTC server reports peers joining and leaving the room of a face-match call
  app.post('/webrtc/call-event', async (request, reply) => {
    const { event, peerId, roomId } = (request.body ?? {}) as { event?: string; peerId?: string; roomId?: string }
    if (!event || !peerId || !roomId) return reply.code(400).send({ error: 'bad-request' })
    // the face step of an authentication: the phone joined, the face-verification service joins it
    const face = faces?.byPeer(peerId)
    if (face) {
      if (event === 'peer-joined' || event === 'PEER_JOINED')
        join(face.token, face.wsUrl, roomId, (err) => {
          logger.error({ err, flowId: face.flowId }, 'vision join-call failed: the face step fails')
          faces?.settle(face.token, 'failed')
        })
    }
    return reply.send({ ok: true })
  })

  // the reference image of a face step (D131)
  app.get('/vision/list/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (!faces?.byToken(token)) return reply.code(400).send({ error: 'invalid token' })
    return [`${agent.env.publicBaseUrl}/vision/media/${token}/reference`]
  })

  app.get('/vision/media/:token/reference', async (request, reply) => {
    const { token } = request.params as { token: string }
    // the reference of a face step: the passport's portrait or the entry's photo, for the step only (D131)
    const face = faces?.byToken(token)
    if (face) {
      reply.header('content-type', face.reference.mimeType)
      reply.header('cache-control', 'no-store')
      return reply.send(face.reference.bytes)
    }
    return reply.code(400).send({ error: 'invalid token' })
  })

  app.put('/vision/success/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (faces?.settle(token, 'passed')) return { statusCode: 200 }
    return reply.code(400).send({ error: 'invalid token' })
  })

  app.put('/vision/failure/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (faces?.settle(token, 'failed')) return { statusCode: 200 }
    return reply.code(400).send({ error: 'invalid token' })
  })

  // short-lived links the wallet follows for media shared on DIDComm
  app.get('/media/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const link = links.take(token)
    if (!link) return reply.code(404).send({ error: 'not-found' })
    const session = await agent.sessions.get(link.sessionId)
    if (!session) return reply.code(404).send({ error: 'not-found' })
    const object = await agent.media.open(session, link.attachmentId)
    if (!object) return reply.code(404).send({ error: 'not-found' })
    reply.header('content-type', object.mimeType)
    return reply.send(object.bytes)
  })
}
