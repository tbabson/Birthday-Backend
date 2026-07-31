import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Surfaced as List-Unsubscribe; required for deliverability (§6.4). */
  unsubscribeUrl?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId: string | null }>;
}

/** Development sink: prints the message instead of sending it. */
class ConsoleProvider implements EmailProvider {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<{ messageId: string | null }> {
    // Deliberately bypasses the redacting logger — in development the whole
    // point is to read the message, including the magic link.
    process.stdout.write(
      `\n──── email (console provider) ────\n` +
        `To:      ${message.to}\n` +
        `Subject: ${message.subject}\n\n` +
        `${message.text}\n` +
        `──────────────────────────────────\n\n`,
    );
    return { messageId: `console-${Date.now()}` };
  }
}

class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';
  private transport: nodemailer.Transporter;

  constructor() {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      /*
       * On an unencrypted port, insist on STARTTLS rather than accepting
       * whatever the server offers. Without this nodemailer will happily fall
       * back to plaintext if the upgrade fails, and the SMTP password crosses
       * the wire in the clear. The local Mailpit sink has no TLS, so it is
       * exempted by hostname rather than by weakening the rule.
       */
      requireTLS: !env.SMTP_SECURE && !isLocalSink(env.SMTP_HOST),
      // A hung SMTP connection would otherwise occupy a worker slot
      // indefinitely; failing lets BullMQ retry with backoff.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      ...(env.SMTP_USER
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } }
        : {}),
    });
  }

  async send(message: EmailMessage): Promise<{ messageId: string | null }> {
    try {
      const info = await this.transport.sendMail({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.unsubscribeUrl
          ? { headers: { 'List-Unsubscribe': `<${message.unsubscribeUrl}>` } }
          : {}),
      });
      return { messageId: info.messageId ?? null };
    } catch (err) {
      // Rethrown so BullMQ still retries, but with a message that names the
      // actual cause — the raw SMTP codes are unreadable in a delivery log.
      throw new Error(explainSmtpError(err), { cause: err });
    }
  }

  /** Opens a connection and authenticates without sending. Used by the CLI check. */
  async verify(): Promise<void> {
    try {
      await this.transport.verify();
    } catch (err) {
      throw new Error(explainSmtpError(err), { cause: err });
    }
  }
}

function isLocalSink(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === 'mailpit';
}

/** Turns the handful of SMTP failures that actually happen into plain English. */
export function explainSmtpError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const message = e?.message ?? String(err);

  if (e?.responseCode === 535 || /invalid login|username and password not accepted/i.test(message)) {
    return (
      'SMTP rejected the credentials. For Gmail this almost always means ' +
      'SMTP_PASS is not a 16-character App Password — a normal Google ' +
      'password is always refused, and App Passwords require 2-Step ' +
      'Verification to be enabled.'
    );
  }
  if (e?.code === 'EAUTH') {
    return `SMTP authentication failed: ${message}`;
  }
  if (e?.code === 'ECONNECTION' || e?.code === 'ETIMEDOUT' || e?.code === 'ESOCKET') {
    return (
      `Could not reach ${env.SMTP_HOST}:${env.SMTP_PORT} — ${message}. ` +
      'Check the host and port, and that outbound SMTP is not blocked.'
    );
  }
  if (e?.responseCode === 550 || e?.responseCode === 553) {
    return (
      `The server refused the sender address (${message}). EMAIL_FROM must ` +
      'match the authenticated account.'
    );
  }
  return `SMTP send failed: ${message}`;
}

let provider: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  if (!provider) {
    provider = env.EMAIL_PROVIDER === 'smtp' ? new SmtpProvider() : new ConsoleProvider();
    logger.info({ provider: provider.name }, 'email provider ready');
  }
  return provider;
}

/** Test seam: swap in a recording provider. */
export function setEmailProvider(next: EmailProvider | undefined): void {
  provider = next;
}
