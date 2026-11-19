/**
 * The error codes the AG-UI routes answer are those the profile package exports, with the same status (profile 3.3
 * §9, PROF-ERR-001): the package is read by the UIs and the app, the routes are the reference implementation, and both
 * follow profile.md of ayni-spec PR #94.
 */
import { readFileSync } from 'node:fs'
import { ERROR_CODES, ERROR_STATUS, type ErrorCode } from '@ayni.org/ayni-agui-profile'
import { describe, expect, it } from 'vitest'
import { SESSION_ERROR_STATUS } from '../src/channels/agui/routes.js'
import { SPACE_ERROR_STATUS } from '../src/core/spaces.js'

/** §9 of profile.md (spec PR #94): every code and its status. */
const SECTION_9: Record<string, number> = {
  'bad-request': 400,
  unauthorized: 401,
  'not-bound': 403,
  'not-owner': 403,
  'not-creator': 403,
  'not-admin': 403,
  'grant-used': 409,
  'grant-expired': 409,
  'window-passed': 409,
  'legal-hold': 409,
  'has-messages': 409,
  'handover-not-allowed': 409,
  final: 409,
  'personal-space': 409,
  'rule-membership': 409,
  owner: 409,
  'already-member': 409,
  'organization-not-accepted': 409,
  'space-left': 409,
  closed: 410,
  'out-of-bounds': 422,
  'not-on-verana': 422,
  'home-organization': 422,
  'not-eligible': 422,
  'email-unavailable': 503,
  // PROF-SESS-015
  'pairing-expired': 409,
  'pairing-invalid': 409,
}

describe('the error codes of profile 3.3 (§9, PROF-ERR-001)', () => {
  it('exports every code of §9 with its status', () => {
    for (const [code, status] of Object.entries(SECTION_9))
      expect([code, ERROR_STATUS[code as ErrorCode]]).toEqual([code, status])
    expect(ERROR_CODES).toEqual(Object.keys(ERROR_STATUS))
    // the codes the earlier drafts had and the spec does not
    for (const stale of ['conversation-started', 'left-space']) expect(ERROR_CODES).not.toContain(stale)
  })

  it('answers each refusal of a space and of a session with the code and the status the package exports', () => {
    for (const [code, status] of Object.entries({ ...SPACE_ERROR_STATUS, ...SESSION_ERROR_STATUS }))
      expect([code, ERROR_STATUS[code as ErrorCode]]).toEqual([code, status])
  })

  it('answers no literal code the package does not export', () => {
    const source = readFileSync('src/channels/agui/routes.ts', 'utf8')
    const literal = [...source.matchAll(/error: '([a-z-]+)'/g)].map((m) => m[1] as string)
    // the outcomes of a deletion the route answers as the code (PROF-HIST-010)
    const deletion = ['legal-hold', 'window-passed', 'turn-in-progress']
    const unknown = [...new Set([...literal, ...deletion])].filter(
      (code) => code !== 'internal' && !(ERROR_CODES as string[]).includes(code)
    )
    expect(unknown).toEqual([])
    expect(literal.length).toBeGreaterThan(5)
  })
})
