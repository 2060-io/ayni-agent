import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import {
  ACTIVITY,
  APP_LINK_DOMAIN,
  BINDING_GOAL_CODE,
  buildAppLink,
  CLIENT_PLATFORMS,
  CONNECTION_STATES,
  type ConnectActivity,
  type Connection,
  type ConnectionsChangedValue,
  CUSTOM_EVENT,
  ERROR_CODES,
  ERROR_STATUS,
  INVITATION_GOAL_CODE,
  isAppLink,
  isClientPlatform,
  type MessagesWithheldValue,
  NOTIFICATIONS_PAGE,
  noTurnOf,
  notificationsLink,
  PROFILE_MAJOR,
  PROFILE_MINOR,
  PROFILE_VERSION,
  parseAppLink,
  RUN_ERROR_CODE,
  SPACE_CALL_RULES,
  SPACE_TOOL_STATES,
  type SpaceAccountRequest,
  type SpaceTool,
  TOOL_EFFECTS,
} from '../src/index.js'

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas')
const schema = (name: string) => JSON.parse(readFileSync(join(schemasDir, name), 'utf8'))
const ajv = new Ajv2020({ strict: false })
addFormats(ajv)

describe('profile 3.5 constants', () => {
  it('names the revision', () => {
    expect(PROFILE_VERSION).toBe(`${PROFILE_MAJOR}.${PROFILE_MINOR}`)
    expect(PROFILE_VERSION).toBe('3.5')
    // 3.5 amended (agent D114): the Notifications, their event, and no more approval request
    expect(CUSTOM_EVENT.spaceNotificationsChanged).toBe('ayni.space.notifications.changed')
    expect('approvalRequest' in CUSTOM_EVENT).toBe(false)
    expect(NOTIFICATIONS_PAGE).toEqual({ default: 50, max: 200 })
    expect(RUN_ERROR_CODE.decideOnPhone).toBe('decide-on-phone')
    expect(ERROR_STATUS['not-pending']).toBe(409)
    expect(notificationsLink(APP_LINK_DOMAIN.devnet, 'did:web:a', 'spc_1', 'apr_1')).toBe(
      'https://app.dev.ayni.org/app/service/did%3Aweb%3Aa/spaces/spc_1/notifications?approval=apr_1'
    )
    expect(notificationsLink(APP_LINK_DOMAIN.devnet, 'did:web:a', null, 'apr_1')).toBe(
      'https://app.dev.ayni.org/app/service/did%3Aweb%3Aa/notifications?approval=apr_1'
    )
    expect(
      parseAppLink(
        'https://app.dev.ayni.org/app/service/did:web:a/notifications?approval=apr_1',
        APP_LINK_DOMAIN.devnet
      )
    ).toEqual({ route: 'service', segments: ['did:web:a', 'notifications'], params: { approval: 'apr_1' } })
    // 3.5: each person's own accounts, the Connect card (PROF-TOOL-019, PROF-TOOL-020)
    expect(CUSTOM_EVENT.connectionsChanged).toBe('ayni.connections.changed')
    expect(ACTIVITY.connect).toBe('ayni.connect')
    expect(CONNECTION_STATES).toEqual(['not-connected', 'connected', 'reconnect'])
    // 3.4: a change of a space's tools applied or dropped, and the decision run of a confirmation
    expect(CUSTOM_EVENT.spaceToolsChanged).toBe('ayni.space.tools.changed')
    expect(noTurnOf({ type: 'RUN_STARTED', noTurn: 'decision' })).toBe('decision')
    expect(SPACE_TOOL_STATES).toEqual(['available', 'setup', 'ready', 'off'])
    expect(SPACE_CALL_RULES).toEqual(['none', 'confirm', 'approval', 'off'])
    expect(TOOL_EFFECTS).toEqual(['read', 'write', 'delete', 'external'])
    // 3.3: a memory the agent changed, live and in history
    expect(CUSTOM_EVENT.memoryUpdated).toBe('ayni.memory.updated')
    expect(ACTIVITY.memoryUpdate).toBe('ayni.memory-update')
    expect(ACTIVITY.flow).toBe('ayni.flow')
    expect(INVITATION_GOAL_CODE.linkSession).toBe('ayni.link-session')
    // a binding invitation carries the goal code of the flow profile §4 (FLOW-CONN-001)
    expect(BINDING_GOAL_CODE).toBe('ayni.link-session')
    expect(CLIENT_PLATFORMS).toEqual(['web', 'ios', 'android'])
    expect(isClientPlatform('ios')).toBe(true)
    expect(isClientPlatform('Firefox on Linux')).toBe(false)
  })
})

describe('errors (§9, PROF-ERR-001)', () => {
  it('gives each code its status, as profile.md does', () => {
    expect(ERROR_STATUS['has-messages']).toBe(409)
    // 3.5: the refusals of Your accounts (§3.11) and of a binding set from the owner's account (§3.10)
    expect(ERROR_STATUS['not-oauth']).toBe(409)
    expect(ERROR_STATUS['not-fields']).toBe(409)
    expect(ERROR_STATUS['wrong-binding']).toBe(422)
    expect(ERROR_STATUS['wrong-person']).toBe(422)
    expect(ERROR_STATUS['not-your-account']).toBe(422)
    expect(ERROR_STATUS['source-unavailable']).toBe(502)
    // 3.4: the refusals of the tools of a space (§3.10)
    expect(ERROR_STATUS['change-pending']).toBe(409)
    expect(ERROR_STATUS['confirmation-unavailable']).toBe(409)
    expect(ERROR_STATUS['looser-than-pack']).toBe(422)
    expect(ERROR_STATUS['bad-token']).toBe(422)
    expect(ERROR_STATUS['out-of-bounds']).toBe(422)
    expect(ERROR_STATUS['space-left']).toBe(409)
    expect(ERROR_STATUS['not-admin']).toBe(403)
    expect(ERROR_STATUS['not-creator']).toBe(403)
    expect(ERROR_STATUS['already-member']).toBe(409)
    expect(ERROR_STATUS['legal-hold']).toBe(409)
    expect(ERROR_STATUS['not-on-verana']).toBe(422)
    expect(ERROR_STATUS['email-unavailable']).toBe(503)
    expect(ERROR_CODES).not.toContain('conversation-started')
    expect(ERROR_CODES).not.toContain('left-space')
  })
})

describe("a space's account in named fields (§3.10, PROF-TOOL-001/004, agent D102)", () => {
  it('reads the fields of an account and sets it with one value per field', () => {
    const account: SpaceTool['account'] = {
      kind: 'space',
      fields: [
        { name: 'api_key', label: 'API key', pattern: '^[A-Za-z0-9]{10,64}$' },
        { name: 'access_token', label: 'Access token' },
      ],
      set: false,
      setAt: null,
      setBy: null,
    }
    const request: SpaceAccountRequest = { values: { api_key: 'key', access_token: 'token' } }
    expect(Object.keys(request.values)).toEqual(account.fields?.map((f) => f.name))
    // a refusal names the field: 422 for a value, 400 for a field missing or unknown
    expect(ERROR_STATUS['bad-token']).toBe(422)
    expect(ERROR_STATUS['bad-request']).toBe(400)
  })
})

describe('schemas', () => {
  it('accepts a 3.1 descriptor with sessionGrant and flows, and a 3.0 one without', () => {
    const validate = ajv.compile(schema('descriptor.schema.json'))
    const base = {
      profileVersion: '3.1',
      did: 'did:webvh:acme',
      name: 'Acme Support',
      sessions: 'https://agent.example/agui/v3/sessions',
      binding: { modes: ['cross-device'], walletLinkTemplate: 'https://app.ayni.org/app/connect?oob={oob}' },
      features: {
        contextualMenu: true,
        approvals: true,
        reactions: true,
        receipts: true,
        history: true,
        uploads: false,
      },
    }
    expect(validate(base)).toBe(true)
    expect(validate({ ...base, features: { ...base.features, sessionGrant: true, flows: true } })).toBe(true)
    // PROF-DESC-007: additive, a boolean
    expect(validate({ ...base, features: { ...base.features, peerStatus: true } })).toBe(true)
    expect(validate({ ...base, features: { ...base.features, peerStatus: 'yes' } })).toBe(false)
    // 3.3: the deletion window of a message, spaces and memories
    expect(
      validate({
        ...base,
        profileVersion: '3.3',
        features: { ...base.features, erasure: { windowSeconds: 600 } },
      })
    ).toBe(true)
    expect(validate({ ...base, features: { ...base.features, erasure: { windowSeconds: -1 } } })).toBe(false)
    // 3.4: the tools, a boolean (PROF-DESC-009)
    expect(validate({ ...base, profileVersion: '3.4', features: { ...base.features, tools: true } })).toBe(true)
    expect(validate({ ...base, features: { ...base.features, tools: 'yes' } })).toBe(false)
    // 3.5: each person's own accounts, a boolean (PROF-DESC-010)
    expect(
      validate({ ...base, profileVersion: '3.5', features: { ...base.features, tools: true, connections: true } })
    ).toBe(true)
    expect(validate({ ...base, features: { ...base.features, connections: 'yes' } })).toBe(false)
    expect(validate({ ...base, features: { ...base.features, notifications: true } })).toBe(true)
    expect(validate({ ...base, features: { ...base.features, notifications: 'yes' } })).toBe(false)
    // 3.5.2: the agent lets visitors in, a boolean (PROF-DESC-012)
    expect(validate({ ...base, features: { ...base.features, visitors: true } })).toBe(true)
    expect(validate({ ...base, features: { ...base.features, visitors: 'yes' } })).toBe(false)
    expect(validate({ ...base, features: { ...base.features, erasure: {} } })).toBe(false)
    expect(
      validate({ ...base, binding: { modes: ['cross-device'], walletLinkTemplate: 'didcomm://x?oob={oob}' } })
    ).toBe(false)
  })

  it('accepts a create-session body from a 3.0 client and from the app with a grant', () => {
    const validate = ajv.compile(schema('create-session.schema.json'))
    expect(validate({ client: { name: 'ayni-ui', version: '3.0.0', platform: 'Firefox on Linux' } })).toBe(true)
    expect(
      validate({
        client: { name: 'ayni-app', version: '1.0.0', platform: 'ios', description: 'Ayni on iPhone' },
        grant: 'g_1',
        conversationId: 'conv_1',
      })
    ).toBe(true)
    expect(validate({ client: { name: 'ayni-ui' } })).toBe(false)
    // 3.3: the space of the new conversation
    expect(
      validate({
        client: { name: 'ayni-ui', version: '3.3.0', platform: 'web' },
        newConversation: true,
        spaceId: 'spc_1',
      })
    ).toBe(true)
    expect(validate({ client: { name: 'ayni-ui', version: '3.3.0', platform: 'web' }, spaceId: 7 })).toBe(false)
    // 3.4: the version of the profile the client implements (PROF-SESS-016)
    expect(validate({ client: { name: 'ayni-ui', version: '3.4.0', platform: 'web', profileVersion: '3.4' } })).toBe(
      true
    )
    expect(validate({ client: { name: 'ayni-ui', version: '3.4.0', platform: 'web', profileVersion: 'four' } })).toBe(
      false
    )
  })

  it('takes the scope of a decision on a confirmation (PROF-TOOL-008)', () => {
    const validate = ajv.compile(schema('ayni-action.schema.json'))
    expect(validate({ kind: 'approval.decide', approvalId: 'apr_1', decision: 'approve', scope: 'conversation' })).toBe(
      true
    )
    expect(validate({ kind: 'approval.decide', approvalId: 'apr_1', decision: 'approve', scope: 'forever' })).toBe(
      false
    )
  })
})

describe('app links (section 10)', () => {
  it('builds the destinations on the app-link domain', () => {
    expect(buildAppLink(APP_LINK_DOMAIN.devnet, 'wallet', ['card', 'cred-1'])).toBe(
      'https://app.dev.ayni.org/app/wallet/card/cred-1'
    )
    expect(buildAppLink(APP_LINK_DOMAIN.mainnet, 'explore', [], { q: 'notary public' })).toBe(
      'https://app.ayni.org/app/explore?q=notary+public'
    )
    expect(
      buildAppLink('app.test.ayni.org', 'wallet', ['send'], {
        to: 'verana1abc',
        amount: '150000uvna',
        memo: 'Order 8812',
      })
    ).toBe('https://app.test.ayni.org/app/wallet/send?to=verana1abc&amount=150000uvna&memo=Order+8812')
    expect(buildAppLink(APP_LINK_DOMAIN.devnet, 'service', ['did:webvh:acme'])).toBe(
      'https://app.dev.ayni.org/app/service/did%3Awebvh%3Aacme'
    )
  })

  it('parses a link, keeps only the parameters of PROF-LINK-003 and refuses other hosts and schemes', () => {
    expect(parseAppLink('https://app.dev.ayni.org/app/explore?q=notary&utm_source=x', APP_LINK_DOMAIN.devnet)).toEqual({
      route: 'explore',
      segments: [],
      params: { q: 'notary' },
    })
    expect(parseAppLink('https://app.dev.ayni.org/app/service/did%3Awebvh%3Aacme', APP_LINK_DOMAIN.devnet)).toEqual({
      route: 'service',
      segments: ['did:webvh:acme'],
      params: {},
    })
    expect(parseAppLink('https://app.dev.ayni.org/app/connect?oob=abc', 'app.dev.ayni.org')?.params.oob).toBe('abc')
    expect(parseAppLink('https://app.ayni.org/app/home', APP_LINK_DOMAIN.devnet)).toBeNull()
    expect(parseAppLink('http://app.dev.ayni.org/app/home', APP_LINK_DOMAIN.devnet)).toBeNull()
    expect(parseAppLink('https://app.dev.ayni.org/app/unknown', APP_LINK_DOMAIN.devnet)).toBeNull()
    expect(parseAppLink('didcomm://x', APP_LINK_DOMAIN.devnet)).toBeNull()
    expect(isAppLink('https://app.dev.ayni.org/app/scan', APP_LINK_DOMAIN.devnet)).toBe(true)
  })
})

describe("each person's own accounts (§3.11, PROF-TOOL-014..021, agent D104 to D110)", () => {
  it('lists an account by its state, its binding and where it serves, with no token', () => {
    const relaticle: Connection = {
      source: 'relaticle',
      title: 'Relaticle CRM',
      method: 'oauth',
      binding: { name: 'workspace', label: 'Workspace', value: '01JD8', valueLabel: 'ayni-dev-agent' },
      usedIn: [{ kind: 'space', id: 'spc_1', title: 'Sales EU' }],
      state: 'connected',
      reason: null,
      moreAccess: false,
      account: {
        id: 'acc_1',
        label: 'ana@2060.io · ayni-dev-agent',
        connectedAt: '2026-11-21T10:02:00Z',
        lastUsedAt: null,
      },
      attempt: null,
      revokesAtSource: false,
    }
    expect(JSON.stringify(relaticle)).not.toMatch(/token/i)
    const changed: ConnectionsChangedValue = {
      source: 'relaticle',
      state: 'not-connected',
      attemptId: 'att_1',
      outcome: 'wrong-binding',
      expected: 'ayni-dev-agent',
      chosen: 'Partners',
    }
    expect(changed.outcome).toBe('wrong-binding')
    const card: ConnectActivity = { source: 'github', title: 'GitHub', method: 'oauth', why: 'connect' }
    expect(card.why).toBe('connect')
    const withheld: MessagesWithheldValue = {
      conversationId: 'conv_1',
      messageIds: ['msg_1'],
      reason: 'credential',
      texts: { msg_1: 'my token is ghp_… please' },
    }
    expect(withheld.texts?.msg_1).toContain('ghp_…')
  })

  it('links to Your accounts of an agent (PROF-LINK-004)', () => {
    const link = buildAppLink(APP_LINK_DOMAIN.devnet, 'service', ['did:webvh:abc', 'accounts'])
    expect(link).toBe('https://app.dev.ayni.org/app/service/did%3Awebvh%3Aabc/accounts')
    expect(parseAppLink(link, APP_LINK_DOMAIN.devnet)).toEqual({
      route: 'service',
      segments: ['did:webvh:abc', 'accounts'],
      params: {},
    })
  })
})
