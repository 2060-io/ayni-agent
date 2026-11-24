/**
 * A credential pasted in a conversation (ayni-spec D109; TOOL-ACCESS-013, TOOL-ACCESS-014, TOOL-CAT-016).
 *
 * As a message of the person arrives, before it is recorded, mirrored or queued, the code looks in each run of characters
 * without whitespace for a match, of 16 characters or more, of the `tokenPatterns` of a source of the agent-pack or of a
 * format of well-known credentials, and for a private key in PEM. A message with one is held back from the model whole:
 * it is kept with each credential replaced by its first four characters and `…` (a private key by `----…`), so that the
 * credential is stored nowhere, and the model reads in its place a record of the system that names the source whose
 * pattern matched, if one did, and nothing of the message.
 */
import type { AgentPack } from '../config/packTypes.js'
import type { MessageEntry } from './types.js'

/** The shortest match taken as a credential (TOOL-CAT-016). */
export const MIN_CREDENTIAL_LENGTH = 16

/** The mark of a message held back because it carried a credential (PROF-HIST-013). */
export const CREDENTIAL_WITHHELD = 'credential'

/**
 * The formats of well-known credentials the agent knows (architecture §10.8): GitHub, Slack, AWS access key ids, Google API
 * keys, Stripe secret and restricted keys, keys of model providers, JSON Web Tokens.
 */
export const KNOWN_CREDENTIAL_FORMATS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{12,}/g,
  /github_pat_[A-Za-z0-9_]{12,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /[sr]k_live_[A-Za-z0-9]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{32,}/g,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
]

/** A private key in PEM, from its `-----BEGIN` line to its `-----END` line, across lines. */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g

/** What a message carried: the text kept, each credential masked, and the source whose pattern matched first, if one did. */
export interface HeldCredential {
  text: string
  /** the id of the source of the agent-pack whose `tokenPatterns` matched, if one did */
  source?: string
  /** how many credentials it carried */
  count: number
}

/** The mask of one credential: its first four characters and an ellipsis (TOOL-ACCESS-014). */
export function maskCredential(credential: string): string {
  return `${credential.slice(0, 4)}…`
}

interface Pattern {
  re: RegExp
  source?: string
}

/** The credentials of a message, found as it arrives (TOOL-ACCESS-013). */
export class CredentialScanner {
  private readonly patterns: Pattern[]

  public constructor(pack: Pick<AgentPack, 'tools'>) {
    const declared: Pattern[] = []
    for (const [id, source] of Object.entries(pack.tools?.sources ?? {})) {
      if (source.type === 'bundled') continue
      for (const pattern of source.account?.tokenPatterns ?? [])
        declared.push({ re: new RegExp(pattern, 'g'), source: id })
    }
    // the agent-pack's patterns first: a match of one names its source
    this.patterns = [...declared, ...KNOWN_CREDENTIAL_FORMATS.map((re) => ({ re }))]
  }

  /** What a text carries: undefined when it holds no credential, else the text with each one masked. */
  public scan(text: string): HeldCredential | undefined {
    const ranges: { start: number; end: number; mask: string; source?: string }[] = []
    for (const m of text.matchAll(PEM_PRIVATE_KEY))
      ranges.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, mask: '----…' })
    // each run of characters without whitespace, outside a private key already found
    for (const run of text.matchAll(/\S+/g)) {
      const at = run.index ?? 0
      if (ranges.some((r) => at >= r.start && at < r.end)) continue
      for (const { re, source } of this.patterns) {
        re.lastIndex = 0
        for (const m of run[0].matchAll(re)) {
          if (m[0].length < MIN_CREDENTIAL_LENGTH) continue
          const start = at + (m.index ?? 0)
          ranges.push({ start, end: start + m[0].length, mask: maskCredential(m[0]), ...(source ? { source } : {}) })
        }
      }
    }
    if (!ranges.length) return undefined
    // overlapping matches are one credential: the first that starts, the longest of those
    ranges.sort((a, b) => a.start - b.start || b.end - a.end)
    const kept: typeof ranges = []
    for (const range of ranges) {
      const last = kept[kept.length - 1]
      if (last && range.start < last.end) {
        if (range.end > last.end) last.end = range.end
        last.source ??= range.source
        continue
      }
      kept.push({ ...range })
    }
    let out = ''
    let from = 0
    for (const range of kept) {
      out +=
        text.slice(from, range.start) +
        (range.mask.startsWith('----') ? range.mask : maskCredential(text.slice(range.start, range.end)))
      from = range.end
    }
    out += text.slice(from)
    const source = kept.find((r) => r.source)?.source
    return { text: out, count: kept.length, ...(source ? { source } : {}) }
  }
}

/** Whether an entry is a message of the person held back because it carried a credential (D109, PROF-HIST-013). */
export function isCredentialWithheld(entry: Pick<MessageEntry, 'payload' | 'role'>): boolean {
  return entry.role === 'principal' && entry.payload?.withheld === CREDENTIAL_WITHHELD
}

/**
 * The record the model reads in the place of such a message (D109, TOOL-ACCESS-013): that the code held it back because it
 * carried a credential, of which source when a pattern of one matched, and nothing of its content.
 */
export function credentialRecordText(sourceTitle: string | undefined): string {
  return `the person sent a message here that the code of the service held back because it carried a credential${sourceTitle ? ` of ${sourceTitle}` : ''}; nothing of it is shown to you. Never ask for a password, a token or a key: offer the Connect card of the source instead`
}

/**
 * An entry an email check in a conversation recorded before the check moved to the phone (ayni-spec D128): the person's
 * message the check took, or the check's own words. Shown to no client and given to no model.
 */
export function isLegacyEmailCheck(entry: Pick<MessageEntry, 'sourceType' | 'payload'>): boolean {
  return (
    entry.sourceType === 'auth-challenge' && (entry.payload?.kind === 'email-check' || entry.payload?.type === 'email')
  )
}
