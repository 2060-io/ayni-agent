import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import {
  ACTIVITY,
  APP_LINK_DOMAIN,
  buildAppLink,
  CLIENT_PLATFORMS,
  INVITATION_GOAL_CODE,
  isAppLink,
  isClientPlatform,
  PROFILE_MAJOR,
  PROFILE_MINOR,
  PROFILE_VERSION,
  parseAppLink,
} from '../src/index.js'

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas')
const schema = (name: string) => JSON.parse(readFileSync(join(schemasDir, name), 'utf8'))
const ajv = new Ajv2020({ strict: false })
addFormats(ajv)

describe('profile 3.1 constants', () => {
  it('names the revision', () => {
    expect(PROFILE_VERSION).toBe(`${PROFILE_MAJOR}.${PROFILE_MINOR}`)
    expect(ACTIVITY.flow).toBe('ayni.flow')
    expect(INVITATION_GOAL_CODE.linkSession).toBe('ayni.link-session')
    expect(CLIENT_PLATFORMS).toEqual(['web', 'ios', 'android'])
    expect(isClientPlatform('ios')).toBe(true)
    expect(isClientPlatform('Firefox on Linux')).toBe(false)
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
