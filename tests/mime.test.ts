/** Upload types (PROF-HIST-005): the aliases phones send are canonical before the descriptor's list is checked. */
import { describe, expect, it } from 'vitest'
import { canonicalMime, mimeAllowed } from '../src/media/service.js'

describe('canonicalMime', () => {
  it('maps the m4a and aac aliases of an iPhone to audio/mp4', () => {
    expect(canonicalMime('audio/x-m4a')).toBe('audio/mp4')
    expect(canonicalMime('audio/m4a')).toBe('audio/mp4')
    expect(canonicalMime('audio/aac')).toBe('audio/mp4')
    expect(canonicalMime('audio/mp4')).toBe('audio/mp4')
  })

  it('drops parameters and case, and keeps the rest as it is', () => {
    expect(canonicalMime('Audio/WebM; codecs=opus')).toBe('audio/webm')
    expect(canonicalMime('image/jpg')).toBe('image/jpeg')
    expect(canonicalMime('application/pdf')).toBe('application/pdf')
  })

  it('lets the canonical type through the descriptor list', () => {
    const types = ['image/*', 'audio/webm', 'audio/ogg', 'audio/mp4', 'application/pdf']
    expect(mimeAllowed(canonicalMime('audio/x-m4a'), types)).toBe(true)
    expect(mimeAllowed('audio/x-m4a', types)).toBe(false)
  })
})
