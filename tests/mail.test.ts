/**
 * Email (decision 62; ayni-spec D89, PLAT-MAIL-001/002): the SMTP server of the deployment, or none. The part that sends
 * to a real SMTP server runs with `pnpm test:mail` (a Mailpit in Docker, whose API the test reads the message from).
 */
import nodemailer from 'nodemailer'
import { describe, expect, it } from 'vitest'
import { createMailer, isEmailAddress, TransportMailer } from '../src/platform/mail.js'
import { createLogger } from '../src/util/logger.js'

const logger = createLogger('silent')
const FROM = 'Fleet support <fleet@northwind.example>'

describe('the mailer (PLAT-MAIL-001)', () => {
  it('sends nothing without both SMTP_URL and SMTP_FROM', () => {
    expect(createMailer(undefined, FROM, logger)).toBeUndefined()
    expect(createMailer('smtp://mail.example:587', undefined, logger)).toBeUndefined()
    expect(createMailer('', '', logger)).toBeUndefined()
  })

  it('takes an smtp:// or smtps:// address, and refuses anything else', () => {
    expect(createMailer('smtp://user:secret@mail.example:587', FROM, logger)).toBeInstanceOf(TransportMailer)
    expect(createMailer('smtps://user:secret@mail.example:465', FROM, logger)?.from).toBe(FROM)
    expect(() => createMailer('mail.example:587', FROM, logger)).toThrow(/SMTP_URL/)
    expect(() => createMailer('https://mail.example', FROM, logger)).toThrow(/smtp:\/\/ .*smtps:\/\//)
  })

  it('sends one plain-text message from the sender of the deployment (a JSON transport)', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    let written: string | undefined
    const mailer = new TransportMailer(
      {
        sendMail: async (message) => {
          const info = await transport.sendMail(message)
          written = info.message as unknown as string
          return info
        },
      },
      FROM
    )
    const id = await mailer.send({
      to: 'ana.rios@northwind.example',
      subject: 'Your code',
      text: 'Your code is 123456.',
    })
    expect(id).toEqual(expect.any(String))
    const sent = JSON.parse(written ?? '{}') as {
      from: { address: string; name: string }
      to: { address: string }[]
      subject: string
      text: string
      html?: string
    }
    expect(sent.from).toEqual({ address: 'fleet@northwind.example', name: 'Fleet support' })
    expect(sent.to).toEqual([{ address: 'ana.rios@northwind.example', name: '' }])
    expect(sent.subject).toBe('Your code')
    expect(sent.text).toBe('Your code is 123456.')
    expect(sent.html).toBeUndefined()
  })

  it('writes to addresses only', () => {
    for (const ok of ['ana.rios@northwind.example', 'A+b@x.co', ' ana@northwind.example '])
      expect(isEmailAddress(ok)).toBe(true)
    for (const no of ['ana', 'ana@', 'ana@northwind', 'a b@x.co', 'a@b@c.co', '<a@b.co>', ''])
      expect(isEmailAddress(no)).toBe(false)
  })
})

const smtp = process.env.MAILPIT_SMTP_URL
const api = process.env.MAILPIT_API_URL

describe.skipIf(!smtp || !api)('a real SMTP server (Mailpit, pnpm test:mail)', () => {
  it('delivers the message to the SMTP server of SMTP_URL', async () => {
    const mailer = createMailer(smtp, FROM, logger)
    const subject = `Your code for the test ${Date.now()}`
    await mailer?.send({ to: 'ana.rios@northwind.example', subject, text: 'Your code is 482913.\n' })
    mailer?.close?.()
    type Listed = { ID: string; Subject: string; To: { Address: string }[]; From: { Address: string; Name: string } }
    let found: Listed | undefined
    for (let i = 0; i < 50 && !found; i++) {
      const list = (await (await fetch(`${api}/api/v1/messages`)).json()) as { messages: Listed[] }
      found = list.messages.find((m) => m.Subject === subject)
      if (!found) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(found?.To).toEqual([expect.objectContaining({ Address: 'ana.rios@northwind.example' })])
    expect(found?.From).toEqual(expect.objectContaining({ Address: 'fleet@northwind.example', Name: 'Fleet support' }))
    const message = (await (await fetch(`${api}/api/v1/message/${found?.ID}`)).json()) as { Text: string; HTML: string }
    expect(message.Text.trim()).toBe('Your code is 482913.')
    expect(message.HTML).toBe('')
  })
})
