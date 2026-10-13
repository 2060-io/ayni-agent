import { describe, expect, it } from 'vitest'
import {
  coerceBySchema,
  loadPack,
  loadSchema,
  PackError,
  substitutePlaceholders,
  validatePackDocument,
} from '../src/config/pack.js'

const env = { HOME_BACKING_IDENTITY: 'did:webvh:x:home', AGUI_ALLOWED_ORIGINS: 'https://a.example,https://b.example' }

describe('agent-pack loader (CORE-PACK-001..004)', () => {
  it('substitutes ${VAR} and ${VAR:-default} and fails on a missing value', () => {
    expect(substitutePlaceholders('x-$' + '{HOME_BACKING_IDENTITY}', env)).toBe('x-did:webvh:x:home')
    expect(substitutePlaceholders('$' + '{MISSING:-fallback}', env)).toBe('fallback')
    expect(() => substitutePlaceholders('$' + '{MISSING}', env)).toThrow(PackError)
  })

  it('coerces strings to the number, boolean and list the schema expects', () => {
    const schema = loadSchema()
    const coerced = coerceBySchema(
      {
        sessions: { idleTimeoutSeconds: '1800', siblingSessions: 'true' },
        channels: { agui: { allowedOrigins: 'https://a,https://b' } },
      },
      schema,
      schema
    ) as {
      sessions: { idleTimeoutSeconds: number; siblingSessions: boolean }
      channels: { agui: { allowedOrigins: string[] } }
    }
    expect(coerced.sessions.idleTimeoutSeconds).toBe(1800)
    expect(coerced.sessions.siblingSessions).toBe(true)
    expect(coerced.channels.agui.allowedOrigins).toEqual(['https://a', 'https://b'])
  })

  it('loads the dev pack and the example pack', () => {
    const dev = loadPack('agent-packs/dev', { ...process.env, ...env })
    expect(dev.pack.metadata.id).toBe('hologram-dev')
    expect(dev.pack.llm.provider).toBe('stub')
    const example = loadPack('agent-packs/example', {
      ...env,
      AUDITOR_BADGE_SUBJECT: 'a',
      SHIPMENTS_API_TOKEN: 't',
      CRM_MCP_URL: 'https://crm.example/mcp',
      CRM_MCP_TOKEN: 't',
      VISION_URL: 'https://vision.example',
      WEBRTC_SERVER_URL: 'https://webrtc.example',
    })
    expect(example.pack.metadata.id).toBe('northwind-support')
  })

  it('refuses another schema major and names the failing field', () => {
    const dev = loadPack('agent-packs/dev', { ...process.env, ...env })
    expect(() => validatePackDocument({ ...dev.pack, schemaVersion: '4.0' }, env)).toThrow(/4\.0/)
    const broken = structuredClone(dev.pack) as unknown as Record<string, unknown>
    ;(broken.llm as Record<string, unknown>).temperature = 'hot'
    expect(() => validatePackDocument(broken, env)).toThrow(/temperature/)
  })

  it('applies the cross-field rules (undeclared role, missing lawful basis)', () => {
    const dev = loadPack('agent-packs/dev', { ...process.env, ...env })
    const bad = structuredClone(dev.pack)
    bad.identity.roleRules.push({ when: { relation: 'partner' }, roles: ['ghost'] })
    expect(() => validatePackDocument(bad, env)).toThrow(/rule 2.*ghost/)
    const noBasis = structuredClone(dev.pack)
    noBasis.privacy.processingActivities = noBasis.privacy.processingActivities.filter((a) => a.id !== 'rag-corpus')
    expect(() => validatePackDocument(noBasis, env)).toThrow(/PRIV-RETN-006.*rag-corpus/)
  })
})
