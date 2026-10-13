/**
 * Callbacks of the face-verification service and the WebRTC server (INTX-AUTH-007/008): keyed by
 * the per-challenge token, never a session token. Also the short-lived media links for the wallet.
 */
import type { FastifyInstance } from 'fastify'
import type { HologramAgent } from '../../core/agent.js'
import type { Logger } from '../../util/logger.js'
import type { MediaLinks } from './adapter.js'

export function registerDidcommCallbacks(
  app: FastifyInstance,
  agent: HologramAgent,
  links: MediaLinks,
  logger: Logger
): void {
  // the WebRTC server reports peers joining and leaving the room of a face-match call
  app.post('/webrtc/call-event', async (request, reply) => {
    const { event, peerId, roomId } = (request.body ?? {}) as { event?: string; peerId?: string; roomId?: string }
    if (!event || !peerId || !roomId) return reply.code(400).send({ error: 'bad-request' })
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
    const challenge = await agent.challenges.findByToken(token)
    if (challenge?.outcome !== 'pending') return reply.code(400).send({ error: 'invalid token' })
    return [`${agent.env.publicBaseUrl}/vision/media/${token}/reference`]
  })

  app.get('/vision/media/:token/reference', async (request, reply) => {
    const { token } = request.params as { token: string }
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
    const challenge = await agent.challenges.findByToken(token)
    if (!challenge) return reply.code(400).send({ error: 'invalid token' })
    await agent.challenges.complete(challenge.id, 'completed', { verifier: 'face-match' })
    return { statusCode: 200 }
  })

  app.put('/vision/failure/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
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
