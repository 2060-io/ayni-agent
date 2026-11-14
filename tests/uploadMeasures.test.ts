/**
 * What the sender measured of a voice note (PROF-HIST-009): the fields `duration` and `waveform` of an upload are
 * kept on the attachment and given back with it. The rule is checked here; the whole way, from the upload to
 * history, in `agui.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { cleanDuration, cleanWaveform, uploadMeasures } from '../src/channels/agui/uploadMeasures.js'

const field = (value: string) => ({ type: 'field', value })

describe('the measures of an upload', () => {
  it('reads a length in seconds, to the tenth', () => {
    expect(cleanDuration('3.24')).toBe(3.2)
    expect(cleanDuration('125')).toBe(125)
    expect(cleanDuration(' 7.5 ')).toBe(7.5)
  })

  it('leaves out a length that is none', () => {
    for (const text of [undefined, '', '0', '-3', 'abc', '3s', '1e3', 'NaN', '99999999', '0.01'])
      expect(cleanDuration(text)).toBeUndefined()
  })

  it('reads a waveform of up to 64 whole levels from 0 to 100', () => {
    expect(cleanWaveform('[0,12,100,47]')).toEqual([0, 12, 100, 47])
    expect(cleanWaveform(JSON.stringify(Array(64).fill(50)))).toHaveLength(64)
  })

  it('leaves out a waveform that is none', () => {
    for (const text of [
      undefined,
      '',
      'not json',
      '[]',
      '{"a":1}',
      '[1,2,"3"]',
      '[1.5]',
      '[101]',
      '[-1]',
      JSON.stringify(Array(65).fill(1)),
      `[${'1,'.repeat(600)}1]`,
    ])
      expect(cleanWaveform(text)).toBeUndefined()
  })

  it('takes each field on its own, and nothing of a field that is a file', () => {
    expect(uploadMeasures({ fields: { duration: field('4'), waveform: field('[1,2]') } })).toEqual({
      duration: 4,
      waveform: [1, 2],
    })
    expect(uploadMeasures({ fields: { duration: field('4'), waveform: field('oops') } })).toEqual({ duration: 4 })
    expect(uploadMeasures({ fields: { duration: { type: 'file' } } })).toEqual({})
    expect(uploadMeasures({})).toEqual({})
  })
})
