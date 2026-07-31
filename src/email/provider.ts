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

/**
 * Splits `Name <addr@host>` into the structured sender Brevo's API expects.
 * A bare address is accepted too, since EMAIL_FROM allows both forms.
 */
export function parseAddress(value: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { email: value.trim() };

  // A quoted display name is legal in a mail header but is not a name to Brevo.
  const name = match[1]!.replace(/^"|"$/g, '').trim();
  const email = match[2]!.trim();
  return name ? { name, email } : { email };
}

/**
 * Brevo's transactional HTTP API.
 *
 * Exists because managed hosts routinely block outbound SMTP to curb spam —
 * Render times out on port 587 — and no credential or port change fixes that,
 * because the packets never leave the container. This is an ordinary HTTPS
 * request to port 443, which those hosts do allow.
 */
class BrevoProvider implements EmailProvider {
  readonly name = 'brevo';
  private readonly sender: { name?: string; email: string };

  constructor(private readonly apiKey: string) {
    this.sender = parseAddress(env.EMAIL_FROM);
  }

  private async post(path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`https://api.brevo.com/v3${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'api-key': this.apiKey,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A hung request would otherwise occupy a worker slot indefinitely;
        // failing lets BullMQ retry with backoff, exactly as SMTP does.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const reason = (err as Error)?.name === 'TimeoutError' ? 'timed out' : (err as Error).message;
      throw new Error(`Could not reach the Brevo API: ${reason}`, { cause: err });
    }
  }

  async send(message: EmailMessage): Promise<{ messageId: string | null }> {
    const response = await this.post('/smtp/email', {
      sender: this.sender,
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
      htmlContent: message.html,
      ...(message.unsubscribeUrl
        ? { headers: { 'List-Unsubscribe': `<${message.unsubscribeUrl}>` } }
        : {}),
    });

    if (!response.ok) throw new Error(await explainBrevoError(response));

    const body = (await response.json().catch(() => ({}))) as { messageId?: string };
    return { messageId: body.messageId ?? null };
  }

  /** Checks the key without sending. Used by the CLI check, mirroring SmtpProvider. */
  async verify(): Promise<void> {
    const response = await this.post('/account');
    if (!response.ok) throw new Error(await explainBrevoError(response));
  }
}

/** The Brevo counterpart to `explainSmtpError` — the two failures that actually happen. */
async function explainBrevoError(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  let message: string | undefined;
  try {
    message = (JSON.parse(raw) as { message?: string }).message;
  } catch {
    // A non-JSON body (a gateway error page, say); the status carries the meaning.
  }

  /*
   * Brevo answers 401 for several unrelated causes — an unknown key, an
   * account awaiting activation, a caller outside the authorised-IP list — and
   * only its own message distinguishes them. An IP rejection is called out
   * separately because the key is *correct* in that case, and appending advice
   * about key formats to it sends you auditing a credential that was never the
   * problem.
   */
  if (response.status === 401 && /ip address/i.test(message ?? '')) {
    return (
      `Brevo refused the request on IP grounds: ${message} ` +
      'The API key itself is fine — this is the Authorised IPs restriction ' +
      'under Brevo → Security. Add every outbound address this service can ' +
      "call from, not just the one named above: a host's egress rotates across " +
      'a small pool, so allowlisting a single IP fails again on the next call ' +
      "from a sibling. Render lists the full set under the service's " +
      'Connect → Outbound.'
    );
  }
  if (response.status === 401) {
    return (
      `Brevo rejected the request (401)${message ? `: ${message}` : ''}. ` +
      'BREVO_API_KEY must be a v3 API key from Brevo → SMTP & API → API Keys ' +
      '— it starts with `xkeysib-`, whereas an SMTP password (`xsmtpsib-`) is ' +
      'a different credential and is always refused here. If the key is right, ' +
      'check that the account is activated.'
    );
  }
  if (response.status === 400 && /sender/i.test(message ?? '')) {
    return (
      `Brevo refused the sender address (${message}). The address in ` +
      'EMAIL_FROM must be verified under Brevo → Senders, Domains & Dedicated IPs.'
    );
  }
  return `Brevo send failed (${response.status})${message ? `: ${message}` : ''}`;
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
    switch (env.EMAIL_PROVIDER) {
      case 'smtp':
        provider = new SmtpProvider();
        break;
      case 'brevo':
        // env.ts refuses to boot without the key, so this cannot be empty.
        provider = new BrevoProvider(env.BREVO_API_KEY!);
        break;
      default:
        provider = new ConsoleProvider();
    }
    logger.info({ provider: provider.name }, 'email provider ready');
  }
  return provider;
}

/** Test seam: swap in a recording provider. */
export function setEmailProvider(next: EmailProvider | undefined): void {
  provider = next;
}
