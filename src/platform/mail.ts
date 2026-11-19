/**
 * Email (ayni-spec D89, PLAT-MAIL-001/002): the agent sends email through the SMTP server the deployment configures,
 * and only what its purpose needs. The variables are those of the 2060.io website (Laravel-style): `MAIL_HOST`,
 * `MAIL_PORT` (587 by default: STARTTLS when the server offers it), `MAIL_ENCRYPTION` (`ssl`, or port 465: TLS from
 * the start), `MAIL_USERNAME` and `MAIL_PASSWORD` (no authentication without them), `MAIL_FROM_ADDRESS` and
 * `MAIL_FROM_NAME` (the sender). Without `MAIL_HOST` and `MAIL_FROM_ADDRESS` the agent sends nothing: the email code
 * and the invitations of other organizations are disabled, which the agent says at start.
 */
import nodemailer, { type Transporter } from 'nodemailer'
import type { Logger } from '../util/logger.js'

/** One email: plain text, to one address. */
export interface MailMessage {
  to: string
  subject: string
  text: string
}

/** The SMTP server of the deployment, from the MAIL_* environment (src/config/env.ts). */
export interface MailConfig {
  host: string
  port: number
  /** `ssl`: TLS from the start; anything else: STARTTLS when the server offers it (port 465 is TLS whatever this says) */
  encryption?: string
  username?: string
  password?: string
  fromAddress: string
  fromName?: string
}

export interface Mailer {
  /** the sender: `MAIL_FROM_NAME <MAIL_FROM_ADDRESS>`, or the address alone */
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

/** The sender of the agent's email: `MAIL_FROM_NAME <MAIL_FROM_ADDRESS>`, or the address alone. */
export function senderOf(config: Pick<MailConfig, 'fromAddress' | 'fromName'>): string {
  return config.fromName ? `${config.fromName} <${config.fromAddress}>` : config.fromAddress
}

/** The SMTP server of the deployment, or nothing when `MAIL_HOST` or `MAIL_FROM_ADDRESS` is missing (PLAT-MAIL-001). */
export function createMailer(config: MailConfig | undefined, logger: Logger): Mailer | undefined {
  if (!config?.host || !config.fromAddress) return undefined
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error(`MAIL_PORT is not a port: ${config.port}`)
  if (!isEmailAddress(config.fromAddress)) throw new Error('MAIL_FROM_ADDRESS is not an email address')
  if (!!config.username !== !!config.password) throw new Error('MAIL_USERNAME and MAIL_PASSWORD go together')
  const secure = (config.encryption ?? '').toLowerCase() === 'ssl' || config.port === 465
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure,
    ...(config.username ? { auth: { user: config.username, pass: config.password as string } } : {}),
  })
  logger.info(
    { host: config.host, port: config.port, tls: secure, authenticated: !!config.username },
    'email through the SMTP server of the deployment (PLAT-MAIL-001)'
  )
  return new TransportMailer(transport, senderOf(config))
}

/** Whether a text is an email address the agent will write to: one `@`, a domain with a dot, no space. */
export function isEmailAddress(text: string): boolean {
  const value = text.trim()
  return value.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(value)
}
