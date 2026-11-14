/**
 * What the sender measured of a voice note while it recorded it (PROF-HIST-009): its length and the shape of its
 * sound, given in the text fields `duration` and `waveform` of the upload. The agent does not open the audio to
 * measure it: it keeps what the recorder knew, and every device shows the note the same way. The fields are
 * optional and never a reason to refuse an upload: a value that does not read is left out.
 */
import { fieldText, type UploadedPart } from './uploadName.js'

/** a note is not longer than this, in seconds: beyond, the field is not a length */
const MAX_DURATION = 6 * 3600
/** the levels of a waveform: this many at most, each from 0 (silence) to 100 (the loudest of the note) */
export const WAVEFORM_MAX_LEVELS = 64
const WAVEFORM_MAX_TEXT = 1024

export interface UploadMeasures {
  /** seconds */
  duration?: number
  waveform?: number[]
}

/** The length in seconds, to the tenth, of a text field that gives one. */
export function cleanDuration(text: string | undefined): number | undefined {
  if (!text || !/^\d{1,6}(\.\d{1,6})?$/.test(text.trim())) return undefined
  const seconds = Number(text)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DURATION) return undefined
  const tenths = Math.round(seconds * 10) / 10
  return tenths > 0 ? tenths : undefined
}

/** The levels of a text field that gives a waveform: a JSON array of whole numbers from 0 to 100. */
export function cleanWaveform(text: string | undefined): number[] | undefined {
  if (!text || text.length > WAVEFORM_MAX_TEXT) return undefined
  let levels: unknown
  try {
    levels = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > WAVEFORM_MAX_LEVELS) return undefined
  if (!levels.every((level) => Number.isInteger(level) && level >= 0 && level <= 100)) return undefined
  return levels as number[]
}

/** What the fields of an upload say of a voice note. */
export function uploadMeasures(part: UploadedPart): UploadMeasures {
  const duration = cleanDuration(fieldText(part.fields?.duration))
  const waveform = cleanWaveform(fieldText(part.fields?.waveform))
  return { ...(duration === undefined ? {} : { duration }), ...(waveform ? { waveform } : {}) }
}
