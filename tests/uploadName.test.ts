/**
 * The name an upload is kept under (PROF-HIST-008): the `filename` field a client sends before the file, else the
 * name the part declares. Checked on the rule and through the multipart parser the agent uses.
 */
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { cleanFileName, uploadName } from '../src/channels/agui/uploadName.js'

const field = (value: string) => ({ type: 'field', fieldname: 'filename', value })

describe('the name of an upload', () => {
  it('is the field when the client sent one', () => {
    // what React Native writes on the part, and the name the app sends beside it
    expect(
      uploadName({ filename: 'Terms%20of%20service.pdf', fields: { filename: field('Terms of service.pdf') } })
    ).toBe('Terms of service.pdf')
    expect(uploadName({ filename: 'x', fields: { filename: [field('one.txt'), field('two.txt')] } })).toBe('one.txt')
  })

  it('is the name of the part without the field, or with an empty one', () => {
    expect(uploadName({ filename: 'photo.jpg', fields: {} })).toBe('photo.jpg')
    expect(uploadName({ filename: 'photo.jpg' })).toBe('photo.jpg')
    expect(uploadName({ filename: 'photo.jpg', fields: { filename: field('   ') } })).toBe('photo.jpg')
    // a part named `filename` that is a file is not the field
    expect(uploadName({ filename: 'photo.jpg', fields: { filename: { type: 'file', filename: 'x' } } })).toBe(
      'photo.jpg'
    )
    expect(uploadName({ fields: {} })).toBeUndefined()
  })

  it('keeps a percent sign and a name that only looks encoded', () => {
    expect(uploadName({ filename: 'x', fields: { filename: field('100% done.txt') } })).toBe('100% done.txt')
    expect(uploadName({ filename: 'x', fields: { filename: field('a%20b.pdf') } })).toBe('a%20b.pdf')
  })

  it('takes nothing of a path and no control character', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd')
    expect(cleanFileName('C:\\Users\\ada\\notes.txt')).toBe('notes.txt')
    expect(cleanFileName('a\u0000b\nc.txt')).toBe('abc.txt')
    expect(cleanFileName('dir/')).toBeUndefined()
    expect(cleanFileName('x'.repeat(400))?.length).toBe(255)
  })
})

describe('through the multipart parser', () => {
  const BOUNDARY = 'ayni-test-boundary'
  function body(parts: { name: string; value: string; filename?: string; type?: string }[]): string {
    return `${parts
      .map(
        (p) =>
          `--${BOUNDARY}\r\ncontent-disposition: form-data; name="${p.name}"${
            p.filename ? `; filename="${p.filename}"` : ''
          }\r\n${p.type ? `content-type: ${p.type}\r\n` : ''}\r\n${p.value}\r\n`
      )
      .join('')}--${BOUNDARY}--\r\n`
  }
  async function upload(payload: string): Promise<string | undefined> {
    const app = Fastify()
    // registered as the agent registers it
    await app.register(multipart, { limits: { fileSize: 1024, files: 1 } })
    app.post('/upload', async (request) => {
      const file = await request.file()
      if (!file) return { name: null }
      await file.toBuffer()
      return { name: uploadName(file) ?? null }
    })
    const response = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload,
    })
    await app.close()
    return (response.json() as { name: string | null }).name ?? undefined
  }
  const file = { name: 'file', value: 'hello', filename: 'Terms%20of%20service.pdf', type: 'application/pdf' }

  it('reads the field sent before the file', async () => {
    expect(await upload(body([{ name: 'filename', value: 'Terms of service.pdf' }, file]))).toBe('Terms of service.pdf')
    expect(await upload(body([{ name: 'filename', value: 'Señal ñ 100%.pdf' }, file]))).toBe('Señal ñ 100%.pdf')
  })

  it('keeps the name of the part when no field came before it', async () => {
    expect(await upload(body([file]))).toBe('Terms%20of%20service.pdf')
  })

  it('reads the field after the file too, the whole body being read before the file is named', async () => {
    expect(await upload(body([file, { name: 'filename', value: 'late.pdf' }]))).toBe('late.pdf')
  })
})
