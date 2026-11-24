import { describe, expect, it } from 'vitest'
import {
  coerceBySchema,
  crossFieldErrors,
  loadPack,
  loadSchema,
  PackError,
  substitutePlaceholders,
  validatePackDocument,
} from '../src/config/pack.js'
import { authenticationModeOf, messageDeletionWindowSeconds, type SpaceTemplate } from '../src/config/packTypes.js'

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
    expect(dev.pack.metadata.id).toBe('ayni-dev')
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
    // admin access: both roles, the set of Show Admin, the grant's minutes, no internal interface (D132 to D134)
    expect(example.pack.admin).toEqual({
      authentication: { methods: ['badge'] },
      grantMinutes: 30,
      internal: { enabled: false },
    })
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

describe("no role reads other people's conversations (RBAC-XSESS-005)", () => {
  it('leaves crossSession, a key of an earlier pack, to the schema, which refuses it as a key it does not know', () => {
    const dev = loadPack('agent-packs/dev', { ...process.env, ...env })
    const bad = structuredClone(dev.pack) as unknown as {
      identity: { roles: Record<string, Record<string, unknown>> }
    }
    bad.identity.roles.manager = { ...bad.identity.roles.manager, crossSession: 'all' }
    let message = ''
    try {
      validatePackDocument(bad, env)
    } catch (error) {
      expect(error).toBeInstanceOf(PackError)
      message = (error as Error).message
    }
    expect(message).toContain('agent-pack fails schema validation')
    expect(message).toContain('(crossSession)')
    expect(message).not.toContain('is withdrawn')
    // the admin flag is a role's (IDENT-DIR-008)
    const admin = structuredClone(dev.pack) as unknown as {
      identity: { roles: Record<string, Record<string, unknown>> }
    }
    admin.identity.roles.manager = { ...admin.identity.roles.manager, admin: true }
    expect(() => validatePackDocument(admin, env)).not.toThrow()
  })
})

describe('space templates and the deletion window (SPACE-DEF-002/003, PRIV-ERASE-010)', () => {
  it('reads the templates and the window of the dev pack, the window 600 by default', () => {
    const dev = loadPack('agent-packs/dev', { ...process.env, ...env })
    expect(dev.pack.spaces?.templates?.map((t) => t.id)).toEqual(['project', 'sales', 'organization'])
    expect(dev.pack.spaces?.personal?.retentionDays).toBe(365)
    expect(dev.pack.conversations?.messageDeletionWindowSeconds).toBe(600)
    const short = loadPack('agent-packs/dev', { ...process.env, ...env, MESSAGE_DELETION_WINDOW_SECONDS: '30' })
    expect(short.pack.conversations?.messageDeletionWindowSeconds).toBe(30)
    const without = structuredClone(dev.pack)
    without.conversations = undefined
    expect(messageDeletionWindowSeconds(validatePackDocument(without, env))).toBe(600)
  })

  it('refuses a template whose roles are not declared, whose defaults lie outside its bounds, or that says too much', () => {
    const dev = loadPack('agent-packs/dev', { ...process.env, ...env })
    const template = (over: Record<string, unknown>) => {
      const pack = structuredClone(dev.pack)
      pack.spaces = {
        templates: [
          { id: 'p', title: 'P', kind: 'team', creators: ['employee'], membership: { mode: 'list' }, ...over },
        ],
      } as never
      return pack
    }
    expect(() => validatePackDocument(template({}), env)).not.toThrow()
    expect(() => validatePackDocument(template({ creators: ['ghost'] }), env)).toThrow(/rule 2.*ghost.*spaces/)
    expect(() => validatePackDocument(template({ rules: { retentionDays: { default: 10, min: 30 } } }), env)).toThrow(
      /rule 12.*retentionDays default is below min/
    )
    // without a default, a retention is of 365 days: above a max of 60
    expect(() => validatePackDocument(template({ rules: { retentionDays: { min: 30, max: 60 } } }), env)).toThrow(
      /rule 12.*retentionDays default is above max/
    )
    expect(() =>
      validatePackDocument(template({ rules: { lawfulBasis: { default: 'consent', allowed: ['contract'] } } }), env)
    ).toThrow(/rule 12.*lawfulBasis/)
    expect(() =>
      validatePackDocument(template({ rules: { allowedProviders: { allowed: ['anthropic'] } } }), env)
    ).toThrow(/rule 12.*allowedProviders default \[stub\]/)
    expect(() => validatePackDocument(template({ rules: { allowedProviders: { default: [] } } }), env)).toThrow(
      /schema/
    )
    // a provider is named as llm.providerName names it: kimi for openai-compatible on Moonshot
    const kimi = template({ rules: { allowedProviders: { default: ['kimi'] } } })
    kimi.llm = { ...kimi.llm, providerName: 'kimi' }
    expect(() => validatePackDocument(kimi, env)).not.toThrow()
    const twice = template({})
    twice.spaces?.templates?.push(structuredClone(twice.spaces.templates[0] as SpaceTemplate))
    expect(() => validatePackDocument(twice, env)).toThrow(/declared twice/)
    expect(() =>
      validatePackDocument(template({ membership: { mode: 'rule', rule: { department: 'Sales', group: 'x' } } }), env)
    ).toThrow(/schema/)
    expect(() =>
      validatePackDocument(template({ membership: { mode: 'rule', rule: { department: 'Sales' } } }), env)
    ).not.toThrow()
    // a space of the whole organization is the organization's rule
    expect(() =>
      validatePackDocument(template({ kind: 'organization', membership: { mode: 'rule', rule: { group: 'x' } } }), env)
    ).toThrow(/kind organization/)
    // the creation picks no rule: a template names its own
    expect(() => validatePackDocument(template({ membership: { mode: 'rule', by: 'department' } }), env)).toThrow(
      /schema/
    )
    // the names of an earlier draft are not read
    expect(() => validatePackDocument(template({ label: 'P' }), env)).toThrow(/schema/)
  })
})

describe('the keys the clean spec removed (ayni-spec PR #123: no backward compatibility)', () => {
  const dev = () =>
    structuredClone(loadPack('agent-packs/dev', { ...process.env, ...env }).pack) as unknown as {
      identity: Record<string, unknown> & { roles: Record<string, Record<string, unknown>> }
    }
  const refusal = (pack: unknown): string => {
    try {
      validatePackDocument(pack, env)
    } catch (error) {
      if (error instanceof PackError) return error.message
      throw error
    }
    return ''
  }
  const authentication = (over: Record<string, unknown>) => ({
    methods: {
      badge: {
        type: 'credential',
        credential: { jsonSchemaCredentialId: 'https://ecs.example/badge.json' },
        subjectKey: ['badgeNumber'],
      },
    },
    combinations: [['badge']],
    ...over,
  })

  it('refuses a role that declares auditor: the admin interface reads the roles auditor and operator instead', () => {
    const pack = dev()
    pack.identity.roles.manager = { ...pack.identity.roles.manager, auditor: true }
    const message = refusal(pack)
    expect(message).toContain('agent-pack fails schema validation')
    expect(message).toContain('(auditor)')
  })

  it('names the authentication setting that lets people in without authenticating visitors, and refuses guests', () => {
    const offered = dev()
    offered.identity.authentication = authentication({ request: 'on-connect', visitors: true })
    const pack = validatePackDocument(offered, env)
    expect(authenticationModeOf(pack.identity.authentication)).toBe('offered')
    const old = dev()
    old.identity.authentication = authentication({ request: 'on-connect', guests: true })
    const message = refusal(old)
    expect(message).toContain('agent-pack fails schema validation')
    expect(message).toContain('(guests)')
  })
})

describe('the approval policies of the tools of spaces, their bounds and the stewards (TOOL-CAT-023, SPACE-MEMB-011)', () => {
  const dev = () =>
    structuredClone(loadPack('agent-packs/dev', { ...process.env, ...env }).pack) as never as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: a pack document edited by the test
      any
    >
  const refusal = (pack: unknown): string => {
    try {
      validatePackDocument(pack, env)
    } catch (error) {
      if (error instanceof PackError) return `${error.message} ${JSON.stringify(error)}`
      throw error
    }
    return ''
  }
  const withX = (approval: Record<string, unknown>) => {
    const pack = dev()
    pack.tools.sources.post = {
      type: 'http',
      title: 'Post on X',
      description: 'Posts.',
      method: 'POST',
      url: 'https://x.example/2/tweets',
      availability: 'spaces',
      tools: { post: { effect: 'external', approval } },
    }
    return pack
  }

  it('takes bounds a default fits, and the stewards of a template among the declared roles', () => {
    expect(() => validatePackDocument(withX({ minApprovals: 2, default: { threshold: 2 } }), env)).not.toThrow()
    const stewards = dev()
    stewards.spaces.templates[0].stewards = ['manager']
    stewards.approvals = {
      ...stewards.approvals,
      spaces: { allowedApprovers: { roles: ['manager'] }, timeouts: { 'tool-call': { default: 120, max: 1440 } } },
    }
    expect(() => validatePackDocument(stewards, env)).not.toThrow()
  })

  it('refuses to start, naming the field, on a default outside its bounds, a person, a role that does not approve, a timeout outside its own', () => {
    expect(refusal(withX({ minApprovals: 2 }))).toContain('tools.sources.post.tools.post.approval.default')
    expect(refusal(withX({ attested: 'required', default: { attested: false } }))).toContain('attestation-required')
    const person = dev()
    person.approvals = { ...person.approvals, spaces: { default: { approvers: [{ kind: 'person', required: true }] } } }
    expect(refusal(person)).toContain('approvals.spaces.default.approvers.0: an agent-pack names no person')
    const intern = dev()
    intern.approvals = {
      ...intern.approvals,
      spaces: { default: { approvers: [{ kind: 'role', role: 'employee', required: true }] } },
    }
    expect(refusal(intern)).toContain('approvals.spaces.default.approvers.0: role "employee" has no canApprove')
    const timeout = dev()
    timeout.approvals = { ...timeout.approvals, spaces: { timeouts: { 'tool-call': { default: 2, min: 5 } } } }
    expect(refusal(timeout)).toContain('approvals.spaces.timeouts.tool-call.default is outside its min and max')
    const steward = dev()
    steward.spaces.templates[0].stewards = ['ghost']
    expect(refusal(steward)).toMatch(/rule 2.*ghost.*stewards/)
  })
})

describe('the methods and combinations of the authentication (IDENT-AUTH-001, D125, D126)', () => {
  const BADGE = 'https://ecs.example/badge.json'
  const dev = () => structuredClone(loadPack('agent-packs/dev', { ...process.env, ...env }).pack)
  const withAuthentication = (
    methods: Record<string, unknown>,
    combinations: string[][],
    more: Record<string, unknown> = {}
  ) => {
    const pack = dev()
    pack.identity.directory = { file: '/run/secrets/ayni/directory.yaml' }
    pack.identity.authentication = { methods, combinations, ...more } as never
    return pack
  }
  const errors = (pack: ReturnType<typeof dev>) => crossFieldErrors(pack).join('\n')

  it('takes the six types, each combination of enabled methods holding an identifying one', () => {
    const pack = withAuthentication(
      {
        badge: { type: 'credential', credential: { jsonSchemaCredentialId: BADGE }, subjectKey: ['badgeNumber'] },
        email: { type: 'email' },
        passport: { type: 'document' },
        otp: { type: 'authenticator-app' },
        key: { type: 'passkey' },
      },
      [['badge'], ['email'], ['passport'], ['email', 'otp'], ['key']]
    )
    expect(crossFieldErrors(pack)).toEqual([])
    expect(authenticationModeOf(pack.identity.authentication)).toBe('required')
    // with no combination nobody authenticates (IDENT-RES-010)
    expect(authenticationModeOf({ methods: {}, combinations: [] })).toBeUndefined()
  })

  it('refuses to start on an unknown type, naming the method', () => {
    expect(errors(withAuthentication({ sms: { type: 'sms' } }, [['sms']]))).toMatch(
      /methods\.sms has the type sms, which this agent does not know/
    )
  })

  it('refuses a combination of confirming methods only, one that names a method not enabled, and one listed twice', () => {
    const methods = { email: { type: 'email' }, otp: { type: 'authenticator-app' } }
    expect(errors(withAuthentication(methods, [['otp']]))).toMatch(
      /combinations\[0\] \[otp\] holds no identifying method/
    )
    expect(errors(withAuthentication(methods, [['email', 'face']]))).toMatch(/names \[face\], which no method enables/)
    expect(
      errors(
        withAuthentication(methods, [
          ['email', 'otp'],
          ['otp', 'email'],
        ])
      )
    ).toMatch(/is listed twice/)
  })

  it('refuses a credential method without its schema or subject key, and a field of a credential on another type', () => {
    expect(errors(withAuthentication({ badge: { type: 'credential' } }, [['badge']]))).toMatch(
      /badge is a credential method without its schema[\s\S]*badge is a credential method without a subject key/
    )
    expect(
      errors(withAuthentication({ email: { type: 'email', issuers: { organizations: ['org:EE:1'] } } }, [['email']]))
    ).toMatch(/methods\.email is of type email: \[issuers\] belong to a credential method/)
  })

  it('refuses a face match without the consent of biometric-matching or a face-verification service (IDENT-AUTH-011)', () => {
    const methods = { email: { type: 'email' }, face: { type: 'face-match', reference: ['directory'] } }
    const pack = withAuthentication(methods, [['email', 'face']])
    expect(errors(pack)).toMatch(/face needs the processing activity biometric-matching, with the lawful basis consent/)
    expect(errors(pack)).toMatch(/face needs a face-verification service/)
    pack.privacy.processingActivities.push({ id: 'biometric-matching', lawfulBasis: 'legitimate-interest' })
    expect(errors(pack)).toMatch(/biometric-matching with the lawful basis consent, not legitimate-interest/)
  })

  it('refuses an email or a document method with no user directory to find the person in (IDENT-DIR-003/004)', () => {
    const pack = withAuthentication({ email: { type: 'email' } }, [['email']])
    pack.identity.directory = undefined
    expect(errors(pack)).toMatch(/methods\.email \(email\) finds a person in the user directory/)
  })

  it('refuses on-demand with visitors false (IDENT-RES-010)', () => {
    const pack = withAuthentication({ email: { type: 'email' } }, [['email']], {
      request: 'on-demand',
      visitors: false,
    })
    expect(errors(pack)).toMatch(/visitors cannot be false/)
  })
})
