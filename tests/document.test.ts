/**
 * What the agent reads of a document's chip (D73, PRIV-EVID-011/012), on the specimen of the reference data set
 * of the German BSI (TR-03105-5): the passport of Erika Mustermann, number C11T002JM, expired on 2023-10-31,
 * with its portrait held as JPEG 2000. The data groups are those of the test suite of the mrtd module
 * (openwallet-foundation/credo-ts-didcomm-ext). No data of a real person is in this repository.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import jpeg from 'jpeg-js'
import { describe, expect, it } from 'vitest'
import { attributesOfZone, mrzLines, PORTRAIT_BOUND, portraitOf, readDocument } from '../src/core/document.js'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/document/${name}`, import.meta.url)))
const DG1 = fixture('DG1.bin')
const DG2 = fixture('DG2.bin')
/** a day on which the specimen was valid */
const VALID_ON = '2023-01-15'
const verified = { authenticity: true, integrity: true }
const groups = (raw: Record<string, Buffer>, verification?: object) => ({
  raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.toString('base64')])),
  ...(verification ? { verification } : {}),
})

describe('the machine-readable zone of DG1', () => {
  it('is read as its lines, and gives the attributes with calendar dates', () => {
    const lines = mrzLines(DG1)
    expect(lines).toEqual([
      'P<D<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<<<<<<<<<<',
      'C11T002JM4D<<9608122F2310314<<<<<<<<<<<<<<<4',
    ])
    expect(attributesOfZone(lines ?? [], VALID_ON)).toEqual({
      documentType: 'passport',
      documentNumber: 'C11T002JM',
      issuingState: 'D',
      nationality: 'D',
      lastName: 'MUSTERMANN',
      firstName: 'ERIKA',
      fullName: 'ERIKA MUSTERMANN',
      dateOfBirth: '1996-08-12',
      dateOfExpiry: '2023-10-31',
      sex: 'F',
    })
  })

  it('a zone whose check digits do not hold gives nothing', () => {
    const lines = mrzLines(DG1) ?? []
    // one digit of the date of birth changed: its check digit no longer matches
    const altered = [lines[0], lines[1].replace('9608122', '9608132')]
    expect(attributesOfZone(altered, VALID_ON)).toBeUndefined()
    expect(mrzLines(Buffer.from('not a data group'))).toBeUndefined()
  })
})

describe('the portrait of DG2', () => {
  it('held as JPEG 2000, comes out as a JPEG within the bound', async () => {
    const portrait = await portraitOf(DG2)
    expect(portrait?.startsWith('data:image/jpeg;base64,')).toBe(true)
    const bytes = Buffer.from((portrait ?? '').split(',')[1], 'base64')
    expect(bytes.length).toBeLessThanOrEqual(PORTRAIT_BOUND.maxBytes)
    const picture = jpeg.decode(bytes)
    // the specimen is 413 by 531: the longer side is brought to the bound, the shape is kept
    expect(Math.max(picture.width, picture.height)).toBe(PORTRAIT_BOUND.maxSide)
    expect(picture.width / picture.height).toBeCloseTo(413 / 531, 1)
  })

  it('a group with no picture gives nothing', async () => {
    expect(await portraitOf(Buffer.from('no picture here'))).toBeUndefined()
  })
})

describe('what a read is worth (PRIV-EVID-011)', () => {
  it('verified and valid: the closed list of attributes', async () => {
    const read = await readDocument(groups({ DG1, DG2 }, verified), VALID_ON)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.values.fullName).toBe('ERIKA MUSTERMANN')
    expect(read.values.documentNumber).toBe('C11T002JM')
    expect(read.values.portrait.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Object.keys(read.values).sort()).toEqual(
      [
        'dateOfBirth',
        'dateOfExpiry',
        'documentNumber',
        'documentType',
        'firstName',
        'fullName',
        'issuingState',
        'lastName',
        'nationality',
        'portrait',
        'sex',
      ].sort()
    )
  })

  it('not kept when the DIDComm agent verified nothing, or when either answer is not yes', async () => {
    expect(await readDocument(groups({ DG1, DG2 }), VALID_ON)).toEqual({ ok: false, reason: 'no-verification' })
    for (const verification of [
      { authenticity: false, integrity: true },
      { authenticity: true, integrity: false },
      { authenticity: true },
    ]) {
      const read = await readDocument(groups({ DG1, DG2 }, verification), VALID_ON)
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.reason).toBe('not-verified')
    }
  })

  it('not kept when the document has expired on the day of the read', async () => {
    expect(await readDocument(groups({ DG1, DG2 }, verified), '2023-11-01')).toEqual({ ok: false, reason: 'expired' })
    // valid on its last day
    expect((await readDocument(groups({ DG1, DG2 }, verified), '2023-10-31')).ok).toBe(true)
  })

  it('not kept when a group is missing or cannot be read', async () => {
    for (const raw of [{ DG1 }, { DG2 }, { DG1: Buffer.from('nothing'), DG2 }, { DG1, DG2: Buffer.from('nothing') }]) {
      const read = await readDocument(groups(raw as Record<string, Buffer>, verified), VALID_ON)
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.reason).toBe('unreadable')
    }
  })
})
