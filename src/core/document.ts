/**
 * What the agent reads of the chip of a passport or of an identity card (D73, PRIV-EVID-011/012). The DIDComm
 * agent receives the data groups and says two things of them: that the document security object is signed under
 * a certificate of the issuing state the deployment trusts, and that the data groups match that object. Only
 * then does the agent read them, and only two: DG1, the machine-readable zone, and DG2, the portrait. Nothing the
 * wallet says beside the data groups is read.
 *
 * The attributes are a closed list, the same for every document. Names are those of the machine-readable zone,
 * in capitals and without accents; dates are calendar dates; the portrait, which a chip usually holds as
 * JPEG 2000, comes out as a JPEG within a bound, since no credential schema takes JPEG 2000 and a credential
 * that carries a full-size picture is heavy to deliver.
 */
import { createRequire } from 'node:module'
import jpeg from 'jpeg-js'
import { parse } from 'mrz'
import { DOCUMENT_ATTRIBUTES } from '../config/packTypes.js'

export type DocumentAttribute = (typeof DOCUMENT_ATTRIBUTES)[number]

/** Why a read is not kept: the model and the person are told this word, and nothing of the document. */
export type DocumentRefusal = 'no-verification' | 'not-verified' | 'expired' | 'unreadable'

export type DocumentRead =
  | { ok: true; values: Record<DocumentAttribute, string> }
  | { ok: false; reason: DocumentRefusal; detail?: string }

/** The longer side and the weight a portrait is brought within. */
export interface PortraitBound {
  maxSide: number
  maxBytes: number
}
export const PORTRAIT_BOUND: PortraitBound = { maxSide: 240, maxBytes: 24_000 }

interface Pixels {
  width: number
  height: number
  /** RGBA, eight bits a channel */
  data: Uint8Array
}

/** The machine-readable zone held by DG1 (ICAO 9303-10: tag 5F1F), as its lines. */
export function mrzLines(dg1: Uint8Array): string[] | undefined {
  const bytes = Buffer.from(dg1)
  const at = bytes.indexOf(Buffer.from([0x5f, 0x1f]))
  if (at < 0) return undefined
  let length = bytes[at + 2]
  let start = at + 3
  if (length === 0x81) {
    length = bytes[at + 3]
    start = at + 4
  }
  const text = bytes.subarray(start, start + length).toString('latin1')
  const width = { 88: 44, 72: 36, 90: 30 }[text.length]
  if (!width) return undefined
  const lines: string[] = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines
}

/** A date of the zone, `YYMMDD`, as a calendar date. The zone gives no century: `pivot` is the last year of this one it may be. */
function calendarDate(yymmdd: string | null | undefined, pivot: number): string | undefined {
  if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return undefined
  const year = 2000 + Number(yymmdd.slice(0, 2))
  return `${year > pivot ? year - 100 : year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
}

function documentTypeOf(code: string | null | undefined): string {
  const first = (code ?? '').charAt(0)
  if (first === 'P') return 'passport'
  if (first === 'I' || first === 'A' || first === 'C') return 'identity-card'
  return 'travel-document'
}

/** The attributes the zone gives, or nothing when it does not hold together (its check digits). */
export function attributesOfZone(
  lines: string[],
  today: string
): Omit<Record<DocumentAttribute, string>, 'portrait'> | undefined {
  let zone: ReturnType<typeof parse>
  try {
    zone = parse(lines)
  } catch {
    return undefined
  }
  if (!zone.valid) return undefined
  const f = zone.fields
  const thisYear = Number(today.slice(0, 4))
  // nobody is born in the future; a document does not expire more than fifty years ahead
  const dateOfBirth = calendarDate(f.birthDate, thisYear)
  const dateOfExpiry = calendarDate(f.expirationDate, thisYear + 50)
  const documentNumber = f.documentNumber ?? ''
  const issuingState = f.issuingState ?? ''
  if (!dateOfBirth || !dateOfExpiry || !documentNumber || !issuingState) return undefined
  const firstName = f.firstName ?? ''
  const lastName = f.lastName ?? ''
  return {
    documentType: documentTypeOf(f.documentCode),
    documentNumber,
    issuingState,
    nationality: f.nationality ?? '',
    lastName,
    firstName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    dateOfBirth,
    dateOfExpiry,
    sex: f.sex === 'male' ? 'M' : f.sex === 'female' ? 'F' : 'X',
  }
}

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff])
const JP2_START = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20])
const J2K_START = Buffer.from([0xff, 0x4f, 0xff, 0x51])

interface OpenJpegDecoder {
  getEncodedBuffer(length: number): Uint8Array
  decode(): void
  getFrameInfo(): { width: number; height: number; bitsPerSample: number; componentCount: number }
  getDecodedBuffer(): Uint8Array
}
let openJpeg: Promise<{ J2KDecoder: new () => OpenJpegDecoder }> | undefined

/** The JPEG 2000 decoder, built once: OpenJPEG as WebAssembly, silent. */
function decoder(): Promise<{ J2KDecoder: new () => OpenJpegDecoder }> {
  if (!openJpeg) {
    const load = createRequire(import.meta.url)('@cornerstonejs/codec-openjpeg/decodewasmjs')
    openJpeg = (load.default ?? load)({ print: () => undefined, printErr: () => undefined })
  }
  return openJpeg as Promise<{ J2KDecoder: new () => OpenJpegDecoder }>
}

/** The picture a face data group holds, whichever of the two formats a chip may use. */
async function pictureOf(dg2: Uint8Array): Promise<Pixels | undefined> {
  const bytes = Buffer.from(dg2)
  const starts = [
    { at: bytes.indexOf(JPEG_START), kind: 'jpeg' as const },
    { at: bytes.indexOf(JP2_START), kind: 'jpeg2000' as const },
    { at: bytes.indexOf(J2K_START), kind: 'jpeg2000' as const },
  ].filter((s) => s.at >= 0)
  const first = starts.sort((a, b) => a.at - b.at)[0]
  if (!first) return undefined
  const encoded = bytes.subarray(first.at)
  if (first.kind === 'jpeg') {
    const decoded = jpeg.decode(encoded, { useTArray: true, formatAsRGBA: true })
    return { width: decoded.width, height: decoded.height, data: decoded.data }
  }
  const openjpeg = new (await decoder()).J2KDecoder()
  openjpeg.getEncodedBuffer(encoded.length).set(encoded)
  openjpeg.decode()
  const { width, height, bitsPerSample, componentCount } = openjpeg.getFrameInfo()
  if (bitsPerSample !== 8 || (componentCount !== 1 && componentCount < 3)) return undefined
  const samples = openjpeg.getDecodedBuffer()
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const at = i * componentCount
    const grey = componentCount === 1
    data[i * 4] = samples[at]
    data[i * 4 + 1] = samples[grey ? at : at + 1]
    data[i * 4 + 2] = samples[grey ? at : at + 2]
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

/** The picture with its longer side brought to `maxSide`, each new pixel the mean of those it covers. */
function reduced(picture: Pixels, maxSide: number): Pixels {
  const scale = Math.max(picture.width, picture.height) / maxSide
  if (scale <= 1) return picture
  const width = Math.max(1, Math.round(picture.width / scale))
  const height = Math.max(1, Math.round(picture.height / scale))
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const top = Math.floor(y * scale)
    const bottom = Math.max(top + 1, Math.min(picture.height, Math.floor((y + 1) * scale)))
    for (let x = 0; x < width; x++) {
      const left = Math.floor(x * scale)
      const right = Math.max(left + 1, Math.min(picture.width, Math.floor((x + 1) * scale)))
      const sum = [0, 0, 0]
      for (let sy = top; sy < bottom; sy++) {
        for (let sx = left; sx < right; sx++) {
          const at = (sy * picture.width + sx) * 4
          sum[0] += picture.data[at]
          sum[1] += picture.data[at + 1]
          sum[2] += picture.data[at + 2]
        }
      }
      const count = (bottom - top) * (right - left)
      const at = (y * width + x) * 4
      data[at] = Math.round(sum[0] / count)
      data[at + 1] = Math.round(sum[1] / count)
      data[at + 2] = Math.round(sum[2] / count)
      data[at + 3] = 255
    }
  }
  return { width, height, data }
}

/** The portrait of DG2 as a JPEG within the bound, as a data URL; nothing when the group holds no picture it can read. */
export async function portraitOf(dg2: Uint8Array, bound: PortraitBound = PORTRAIT_BOUND): Promise<string | undefined> {
  let picture: Pixels | undefined
  try {
    picture = await pictureOf(dg2)
  } catch {
    return undefined
  }
  if (!picture) return undefined
  const small = reduced(picture, bound.maxSide)
  let encoded: Buffer | undefined
  for (const quality of [80, 70, 60, 50, 40]) {
    encoded = jpeg.encode({ data: Buffer.from(small.data), width: small.width, height: small.height }, quality).data
    if (encoded.length <= bound.maxBytes) break
  }
  return encoded ? `data:image/jpeg;base64,${encoded.toString('base64')}` : undefined
}

const group = (raw: Record<string, unknown>, name: string): Buffer | undefined => {
  const value = raw[name]
  return typeof value === 'string' && value ? Buffer.from(value, 'base64') : undefined
}

/**
 * What a document read is worth (PRIV-EVID-011): its attributes when the DIDComm agent verified it and the
 * document is valid on `today`, the reason otherwise. `dataGroups` is what the DIDComm agent reports of the
 * chip's data: the groups as the wallet sent them, and the result of its verification.
 */
export async function readDocument(
  dataGroups: unknown,
  today: string,
  bound: PortraitBound = PORTRAIT_BOUND
): Promise<DocumentRead> {
  const data = (dataGroups ?? {}) as { raw?: Record<string, unknown>; verification?: Record<string, unknown> }
  // with no list of state certificates the DIDComm agent verifies nothing, and says nothing
  if (!data.verification) return { ok: false, reason: 'no-verification' }
  if (data.verification.authenticity !== true)
    return { ok: false, reason: 'not-verified', detail: 'the signer is not a state this deployment trusts' }
  if (data.verification.integrity !== true)
    return { ok: false, reason: 'not-verified', detail: 'the data does not match its signature' }
  const raw = data.raw ?? {}
  const dg1 = group(raw, 'DG1')
  const dg2 = group(raw, 'DG2')
  if (!dg1 || !dg2) return { ok: false, reason: 'unreadable', detail: 'DG1 or DG2 is missing' }
  const lines = mrzLines(dg1)
  const zone = lines ? attributesOfZone(lines, today) : undefined
  if (!zone) return { ok: false, reason: 'unreadable', detail: 'the machine-readable zone does not hold together' }
  if (zone.dateOfExpiry < today) return { ok: false, reason: 'expired' }
  const portrait = await portraitOf(dg2, bound)
  if (!portrait) return { ok: false, reason: 'unreadable', detail: 'the portrait cannot be read' }
  return { ok: true, values: { ...zone, portrait } }
}

/** What the person reads on their phone when a read is not kept. */
export function documentRefusalForPerson(reason: DocumentRefusal): string {
  if (reason === 'expired') return 'This document has expired.'
  if (reason === 'unreadable') return 'The data of this document could not be read.'
  return 'This document could not be verified.'
}

/**
 * What the model is told when the read of a document did not pass, by the reason the challenge ended with: the
 * word of the phone (`declined`, `read-failed`), of the flow (`expired`), or of the verification
 * (`document-…`). Never anything of the document.
 */
export function documentOutcomeForModel(reason: string | undefined): string {
  switch (reason) {
    case 'declined':
      return 'the person declined to read their document'
    case 'read-failed':
      return 'the phone could not read the chip of the document; the person can try again'
    case 'expired':
      return 'the person did not read their document in time; nothing was refused, they can ask again'
    case 'document-expired':
      return 'the document has expired; another, valid document is needed'
    case 'document-unreadable':
      return 'the data of the document could not be read'
    case 'document-not-verified':
      return 'the document could not be verified: its data is not signed by a state this agent trusts, or does not match its signature; trying again with the same document will not help'
    case 'document-no-verification':
      return 'this agent cannot verify documents: it is not configured for it; it is not something the person can fix'
    default:
      return 'the phone of the person is not connected, or cannot read the chip of a document'
  }
}
