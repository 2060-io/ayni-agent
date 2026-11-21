/**
 * No answer of the profile is stored by a browser or a proxy (PROF-ERR-003, decision 71). Found by Fabrice on devnet,
 * 2026-11-21: Chrome kept a `410` of `GET {sessions}/conversations` that carried no `Cache-Control` and answered every
 * later call of that URL with it, whatever the token, without asking the agent (it holds a `410` with no freshness of
 * its own as fresh for ever, and the token travels in a header its cache does not key on).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningAgent } from '../src/app.js'
import { cacheControlOf, isProfilePath } from '../src/channels/agui/routes.js'
import { startTestAgent } from './helpers.js'

let running: RunningAgent
const client = { name: 'ayni-ui', version: '3.4.0', platform: 'web', profileVersion: '3.4' }
const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function createSession(token?: string) {
  const response = await running.app.inject({
    method: 'POST',
    url: '/agui/v3/sessions',
    headers: token ? auth(token) : {},
    payload: { client, locale: 'en', ...(token ? { newConversation: true } : {}) },
  })
  expect(response.headers['cache-control']).toBe('no-store')
  return response.json() as { sessionId: string; sessionToken: string }
}

/** Binds a provisional session the way the DIDComm events would: peer connected, question answered yes. */
async function bound(actor: string) {
  const body = await createSession()
  const session = await running.agent.sessions.get(body.sessionId)
  if (!session?.binding) throw new Error('no binding material')
  const connectionId = `conn-${actor}`
  const { principal } = await running.agent.onPeerConnected(
    {
      connectionType: 'verifiable-user-agent',
      actorIdentity: actor,
      backingIdentity: null,
      claims: { userName: 'Alice' },
      userAgentVerified: false,
      identityCredentialRef: null,
    },
    connectionId,
    { name: 'Wallet', version: '2.5.0', platform: 'ios' }
  )
  const thread = `thread-${Math.random().toString(36).slice(2, 10)}`
  await running.agent.sessions.markConfirmationSent(session, connectionId, thread)
  const confirm = await running.agent.sessions.findByConfirmation(connectionId, thread)
  if (!confirm?.binding) throw new Error('confirmation not found')
  await running.agent.sessions.bind(confirm, principal, confirm.binding.nonce)
  return { ...body, principal }
}

const get = (url: string, token?: string) =>
  running.app.inject({ method: 'GET', url, headers: token ? auth(token) : {} })

beforeAll(async () => {
  running = await startTestAgent()
  // the DIDComm agent is not reachable: invitations are minted locally
  const minter = running.agent.sessions as unknown as { minter: { mint: (id: string) => Promise<unknown> } }
  minter.minter = {
    mint: async (id: string) => ({
      invitationId: `inv-${id}`,
      outOfBandId: `oob-${id}`,
      url: `http://agent.test?oob=${Buffer.from(`{"@id":"inv-${id}"}`).toString('base64url')}`,
    }),
  }
}, 30_000)

afterAll(async () => {
  await running?.stop()
})

describe('no answer of the profile is stored (PROF-ERR-003)', () => {
  it('answers the list of a session a supersede closed with a 410 that no cache keeps', async () => {
    const d = await bound('did:peer:nostore-gone')
    await running.agent.sessions.supersede(d.principal, 'conn-new-device')
    const gone = await get('/agui/v3/sessions/conversations', d.sessionToken)
    expect([gone.statusCode, gone.json().error, gone.json().reason]).toEqual([410, 'closed', 'supersede'])
    expect(gone.headers['cache-control']).toBe('no-store')
  })

  it('answers the list of a bound session with a 200 that no cache keeps, and the spaces the same', async () => {
    const d = await bound('did:peer:nostore-list')
    const list = await get('/agui/v3/sessions/conversations', d.sessionToken)
    expect(list.statusCode).toBe(200)
    expect(list.json().conversations.length).toBeGreaterThan(0)
    expect(list.headers['cache-control']).toBe('no-store')
    const spaces = await get('/agui/v3/sessions/spaces', d.sessionToken)
    expect([spaces.statusCode, spaces.headers['cache-control']]).toEqual([200, 'no-store'])
  })

  it('answers 401, 403, 404 and 409 with no-store, and a path no route takes', async () => {
    const missing = await get('/agui/v3/sessions/conversations')
    const invalid = await get('/agui/v3/sessions/conversations', 'not-a-token')
    const provisional = await createSession()
    const notBound = await get('/agui/v3/sessions/conversations', provisional.sessionToken)
    const otherId = await get('/agui/v3/sessions/ses_other', provisional.sessionToken)
    const conflict = await running.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/${provisional.sessionId}/binding`,
      headers: auth(provisional.sessionToken),
    })
    const noRoute = await get('/agui/v3/sessions/a/b/c/d/e', provisional.sessionToken)
    const answers = [missing, invalid, notBound, otherId, conflict, noRoute]
    expect(answers.map((r) => r.statusCode)).toEqual([401, 401, 403, 404, 409, 404])
    expect(answers.map((r) => r.headers['cache-control'])).toEqual(Array(6).fill('no-store'))
  })

  it('keeps the private lifetime of an attachment on its 200 only', async () => {
    const d = await bound('did:peer:nostore-attachment')
    const boundary = 'nostore-boundary'
    const upload = await running.app.inject({
      method: 'POST',
      url: `/agui/v3/sessions/${d.sessionId}/attachments`,
      headers: { ...auth(d.sessionToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="x.m4a"\r\ncontent-type: audio/mp4\r\n\r\naudio\r\n--${boundary}--\r\n`,
    })
    expect([upload.statusCode, upload.headers['cache-control']]).toEqual([201, 'no-store'])
    const { attachmentId } = upload.json() as { attachmentId: string }
    const object = await get(`/agui/v3/sessions/${d.sessionId}/attachments/${attachmentId}`, d.sessionToken)
    expect([object.statusCode, object.headers['cache-control']]).toEqual([200, 'private, max-age=300'])
    // its errors: an unknown attachment, a token refused, an attachment of a conversation no space shares
    const unknown = await get(`/agui/v3/sessions/${d.sessionId}/attachments/att_none`, d.sessionToken)
    const refused = await get(`/agui/v3/sessions/${d.sessionId}/attachments/${attachmentId}`)
    const shared = await get(
      `/agui/v3/sessions/spaces/spc_none/shared/conv_none/attachments/${attachmentId}`,
      d.sessionToken
    )
    expect([unknown, refused, shared].map((r) => [r.statusCode, r.headers['cache-control']])).toEqual([
      [404, 'no-store'],
      [401, 'no-store'],
      [404, 'no-store'],
    ])
    await running.agent.sessions.supersede(d.principal, 'conn-another-device')
    const closed = await get(`/agui/v3/sessions/${d.sessionId}/attachments/${attachmentId}`, d.sessionToken)
    expect([closed.statusCode, closed.headers['cache-control']]).toEqual([410, 'no-store'])
  })

  it('serves the descriptor with no-store, since a UI reads it again for its features and limits', async () => {
    const descriptor = await get('/.well-known/ayni-agent.json')
    expect([descriptor.statusCode, descriptor.headers['cache-control']]).toEqual([200, 'no-store'])
  })

  it('streams a run and the session stream with no-store, and refuses a run with no-store', async () => {
    const d = await bound('did:peer:nostore-streams')
    const runs = `/agui/v3/sessions/${d.sessionId}/runs`
    const input = { threadId: d.sessionId, runId: 'run-nostore', messages: [{ id: 'u1', role: 'user', content: 'hi' }] }
    const run = await running.app.inject({ method: 'POST', url: runs, headers: auth(d.sessionToken), payload: input })
    expect([run.statusCode, run.headers['cache-control']]).toEqual([200, 'no-store, no-transform'])
    const refused = await running.app.inject({
      method: 'POST',
      url: runs,
      headers: auth(d.sessionToken),
      payload: { ...input, threadId: 'another' },
    })
    expect([refused.statusCode, refused.headers['cache-control']]).toEqual([400, 'no-store'])
    // the session stream never ends by itself: read its head over a real connection, then hang up
    const address = await running.app.listen({ port: 0, host: '127.0.0.1' })
    const hangUp = new AbortController()
    const stream = await fetch(`${address}/agui/v3/sessions/${d.sessionId}/stream`, {
      headers: { ...auth(d.sessionToken), accept: 'text/event-stream' },
      signal: hangUp.signal,
    })
    expect([stream.status, stream.headers.get('cache-control')]).toEqual([200, 'no-store, no-transform'])
    hangUp.abort()
  })

  it('leaves what is not of the profile as it was', async () => {
    const live = await get('/health/live')
    expect([live.statusCode, live.headers['cache-control']]).toEqual([200, undefined])
  })
})

describe('the Cache-Control of an answer of the profile (cacheControlOf, isProfilePath)', () => {
  it('is no-store but for the private lifetime of a 200', () => {
    expect(cacheControlOf(200, undefined)).toBe('no-store')
    expect(cacheControlOf(200, 'private, max-age=300')).toBe('private, max-age=300')
    for (const status of [201, 204, 302, 401, 403, 404, 409, 410, 413, 500, 503])
      expect([status, cacheControlOf(status, 'private, max-age=300')]).toEqual([status, 'no-store'])
    expect(cacheControlOf(200, 'public, max-age=60')).toBe('no-store')
    expect(cacheControlOf(200, 'no-cache')).toBe('no-store')
  })

  it('takes the descriptor and every path of the sessions base, its query aside', () => {
    for (const path of [
      '/.well-known/ayni-agent.json',
      '/agui/v3/sessions',
      '/agui/v3/sessions?x=1',
      '/agui/v3/sessions/conversations?spaceId=spc_1&_=1732200000000',
      '/agui/v3/sessions/ses_1/attachments/att_1',
    ])
      expect([path, isProfilePath(path)]).toEqual([path, true])
    for (const path of ['/health/live', '/agui/v3/sessionsx', '/media/abc', '/.well-known/agent.json'])
      expect([path, isProfilePath(path)]).toEqual([path, false])
  })
})
