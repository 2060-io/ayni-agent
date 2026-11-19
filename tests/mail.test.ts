/**
 * Email (decision 62; ayni-spec D89, PLAT-MAIL-001/002): the SMTP server of the deployment, or none. The part that sends
 * to a real SMTP server runs with `pnpm test:mail` (a Mailpit in Docker, whose API the test reads the message from).
 */
import nodemailer from 'nodemailer'
import { describe, expect, it } from 'vitest'
import { createMailer, isEmailAddress, type MailConfig, senderOf, TransportMailer } from '../src/platform/mail.js'
import { createLogger } from '../src/util/logger.js'

const logger = createLogger('silent')
const FROM = 'Fleet support <fleet@northwind.example>'
const CONFIG: MailConfig = {
  host: 'mail.example',
  port: 587,
  username: 'user',
  password: 'secret',
  fromAddress: 'fleet@northwind.example',
  fromName: 'Fleet support',
}

describe('the mailer (PLAT-MAIL-001), from the MAIL_* variables of the 2060.io website', () => {
  it('sends nothing without MAIL_HOST and MAIL_FROM_ADDRESS', () => {
    expect(createMailer(undefined, logger)).toBeUndefined()
    expect(createMailer({ ...CONFIG, host: '' }, logger)).toBeUndefined()
    expect(createMailer({ ...CONFIG, fromAddress: '' }, logger)).toBeUndefined()
  })

  it('writes the sender as MAIL_FROM_NAME <MAIL_FROM_ADDRESS>, or the address alone', () => {
    expect(createMailer(CONFIG, logger)).toBeInstanceOf(TransportMailer)
    expect(createMailer(CONFIG, logger)?.from).toBe(FROM)
    expect(senderOf({ fromAddress: 'fleet@northwind.example' })).toBe('fleet@northwind.example')
  })

  it('refuses a port, a sender or credentials it cannot use', () => {
    expect(() => createMailer({ ...CONFIG, port: 0 }, logger)).toThrow(/MAIL_PORT/)
    expect(() => createMailer({ ...CONFIG, fromAddress: 'fleet' }, logger)).toThrow(/MAIL_FROM_ADDRESS/)
    expect(() => createMailer({ ...CONFIG, password: undefined }, logger)).toThrow(/MAIL_USERNAME and MAIL_PASSWORD/)
    // no credentials at all: a relay that takes mail without them, as a Mailpit does
    expect(createMailer({ ...CONFIG, username: undefined, password: undefined }, logger)).toBeInstanceOf(
      TransportMailer
    )
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

const smtp = process.env.MAILPIT_SMTP_URL ? new URL(process.env.MAILPIT_SMTP_URL) : undefined
const api = process.env.MAILPIT_API_URL

describe.skipIf(!smtp || !api)('a real SMTP server (Mailpit, pnpm test:mail)', () => {
  it('delivers the message to the SMTP server of MAIL_HOST', async () => {
    const mailer = createMailer(
      {
        host: smtp?.hostname ?? '',
        port: Number(smtp?.port || 1025),
        fromAddress: CONFIG.fromAddress,
        fromName: CONFIG.fromName,
      },
      logger
    )
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
