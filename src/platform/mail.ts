/**
 * Email (ayni-spec D89, PLAT-MAIL-001/002): the agent sends email through the SMTP server the deployment configures,
 * and only what its purpose needs. `SMTP_URL` names the server with its credentials (`smtp://user:password@host:587`,
 * upgraded to TLS by STARTTLS when the server offers it, or `smtps://…:465`, TLS from the start); `SMTP_FROM` is the
 * sender. Without both the agent sends nothing: the email code and the invitations of other organizations are
 * disabled, which the agent says at start.
 */
import nodemailer, { type Transporter } from 'nodemailer'
import type { Logger } from '../util/logger.js'

/** One email: plain text, to one address. */
export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  /** the sender, as `SMTP_FROM` gives it */
  readonly from: string
  /** sends one email; resolves with the id the server gave it */
  send(message: MailMessage): Promise<string | undefined>
  close?(): void
}

/** A mailer over a nodemailer transport: SMTP in a deployment, a stream or JSON transport in tests. */
export class TransportMailer implements Mailer {
  public constructor(
    private readonly transport: Pick<Transporter, 'sendMail'> & Partial<Pick<Transporter, 'close'>>,
    public readonly from: string
  ) {}

  public async send(message: MailMessage): Promise<string | undefined> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
    return typeof info?.messageId === 'string' ? info.messageId : undefined
  }

  public close(): void {
    this.transport.close?.()
  }
}

/** The SMTP server of the deployment, or nothing when `SMTP_URL` or `SMTP_FROM` is missing (PLAT-MAIL-001). */
export function createMailer(
  smtpUrl: string | undefined,
  from: string | undefined,
  logger: Logger
): Mailer | undefined {
  if (!smtpUrl || !from) return undefined
  let url: URL
  try {
    url = new URL(smtpUrl)
  } catch {
    throw new Error('SMTP_URL is not a URL: smtp://user:password@host:587 or smtps://user:password@host:465')
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:')
    throw new Error('SMTP_URL must start with smtp:// (STARTTLS when offered) or smtps:// (TLS)')
  const transport = nodemailer.createTransport(smtpUrl)
  logger.info(
    {
      host: url.hostname,
      port: url.port || (url.protocol === 'smtps:' ? '465' : '587'),
      tls: url.protocol === 'smtps:',
    },
    'email through the SMTP server of the deployment (PLAT-MAIL-001)'
  )
  return new TransportMailer(transport, from)
}

/** Whether a text is an email address the agent will write to: one `@`, a domain with a dot, no space. */
export function isEmailAddress(text: string): boolean {
  const value = text.trim()
  return value.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(value)
}
