/**
 * Callbacks of the face-verification service and the WebRTC server (INTX-AUTH-007/008, IDENT-AUTH-010): keyed by the
 * token of a face step of an authentication, or of a challenge, never by a session token. Also the short-lived media
 * links for the wallet.
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
      return reply.send({ ok: true })
    }
    const challenge = await agent.challenges.findPendingByPeer(peerId)
    if (!challenge) return reply.send({ ok: true })
    if (event === 'peer-joined' || event === 'PEER_JOINED') {
      const visionUrl = agent.env.visionUrl ?? agent.pack.media?.faceVerification?.serviceUrl
      const wsUrl = String(challenge.details?.wsUrl ?? '')
      if (!visionUrl || !wsUrl) return reply.send({ ok: true })
      const visionPeerId = `vision-${challenge.id}`
      const body = {
        ws_url: `${wsUrl}/?roomId=${roomId}&peerId=${visionPeerId}`,
        callback_base_url: `${agent.env.publicBaseUrl}/vision`,
        token: challenge.token,
        lang: agent.pack.language.agent,
      }
      fetch(`${visionUrl.replace(/\/+$/, '')}/join-call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
        })
        .catch(async (err) => {
          logger.error({ err, challengeId: challenge.id }, 'vision join-call failed')
          await agent.challenges.complete(challenge.id, 'unavailable', { reason: 'vision-unavailable' })
        })
    } else if (event === 'peer-left' || event === 'PEER_LEFT') {
      // the person left before a verdict: the challenge expires on its timer
    }
    return reply.send({ ok: true })
  })

  // reference images for the face match: the badge photo of the Principal (IDENT-RES-006)
  app.get('/vision/list/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (faces?.byToken(token)) return [`${agent.env.publicBaseUrl}/vision/media/${token}/reference`]
    const challenge = await agent.challenges.findByToken(token)
    if (challenge?.outcome !== 'pending') return reply.code(400).send({ error: 'invalid token' })
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
    const challenge = await agent.challenges.findByToken(token)
    if (challenge?.outcome !== 'pending') return reply.code(400).send({ error: 'invalid token' })
    const principal = await agent.principals.get(challenge.principalId)
    const photo = principal?.identityAttributes.photo as string | undefined
    if (!photo) return reply.code(404).send({ error: 'no reference image' })
    const match = /^data:([^;]+);base64,(.+)$/.exec(photo)
    if (match) {
      reply.header('content-type', match[1])
      return reply.send(Buffer.from(match[2], 'base64'))
    }
    return reply.redirect(photo)
  })

  app.put('/vision/success/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (faces?.settle(token, 'passed')) return { statusCode: 200 }
    const challenge = await agent.challenges.findByToken(token)
    if (!challenge) return reply.code(400).send({ error: 'invalid token' })
    await agent.challenges.complete(challenge.id, 'completed', { verifier: 'face-match' })
    return { statusCode: 200 }
  })

  app.put('/vision/failure/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (faces?.settle(token, 'failed')) return { statusCode: 200 }
    const challenge = await agent.challenges.findByToken(token)
    if (!challenge) return reply.code(400).send({ error: 'invalid token' })
    await agent.challenges.complete(challenge.id, 'failed', { verifier: 'face-match' })
    return { statusCode: 200 }
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
