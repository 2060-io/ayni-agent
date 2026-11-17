/**
 * What the system did, as the model reads it in the history. Found on devnet with a phone: a request shown on
 * the phone was written in the history in the agent's own voice, "[note] Read your passport or identity card".
 * When the person said "Retry", the model answered with that very line and called no tool, three times: the
 * person read the words and nothing was on their phone.
 */
import { describe, expect, it } from 'vitest'
import { systemRecord } from '../src/core/orchestrator.js'

describe('a record of the system in the history', () => {
  it('a request shown on the phone says what became of it, and that it is over when it is', () => {
    const card = (payload: Record<string, unknown>) =>
      systemRecord({ sourceType: 'flow', text: 'Read your passport or identity card', payload })
    expect(card({ kind: 'nfc-read', state: 'pending' })).toBe(
      '[system record, written by the system, not by the person and not by you: a request was shown on the phone of the person, "Read your passport or identity card" (nfc-read); it is pending]'
    )
    const expired = card({ kind: 'nfc-read', state: 'expired', outcome: 'expired' })
    expect(expired).toContain('it is expired and over: nothing is on their phone now')
    expect(card({ kind: 'issue', state: 'declined', outcome: 'declined' })).toContain('it is declined and over')
  })

  it('is never a line the model could take for one of its own', () => {
    for (const entry of [
      { sourceType: 'flow' as const, text: 'Read your passport or identity card', payload: { kind: 'nfc-read' } },
      { sourceType: 'auth-challenge' as const, text: 'Identity check (document) for issue_credential: expired' },
      { sourceType: 'approval' as const, text: 'Approval requested for wire_money (apr_1)' },
    ]) {
      const record = systemRecord(entry)
      expect(record.startsWith('[system record, written by the system')).toBe(true)
      expect(record.startsWith('[note]')).toBe(false)
      expect(record.endsWith(']')).toBe(true)
    }
  })
})
