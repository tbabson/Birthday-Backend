/**
 * `npm run email:check [recipient]`
 *
 * Proves the mail configuration end to end — connect, authenticate, send —
 * without going through sign-in. Worth having as its own command: when a
 * reminder fails to arrive the question is always "is it the mail setup or the
 * app?", and this answers it in one step.
 */
import { env } from '../config/env.js';
import { explainSmtpError, getEmailProvider } from '../email/provider.js';
import { renderReminder } from '../email/templates.js';
import { observedOccurrence } from '../domain/dates.js';

function mask(secret: string | undefined): string {
  if (!secret) return '(not set)';
  return `${'•'.repeat(Math.max(secret.length - 4, 0))}${secret.slice(-4)} (${secret.length} chars)`;
}

async function main(): Promise<void> {
  const to = process.argv[2] ?? env.SMTP_USER;

  if (!to) {
    console.error('No recipient. Pass one: npm run email:check you@example.com');
    process.exit(1);
  }

  console.log('Mail configuration');
  console.log(`  provider   ${env.EMAIL_PROVIDER}`);
  console.log(`  host       ${env.SMTP_HOST}:${env.SMTP_PORT} (secure=${env.SMTP_SECURE})`);
  console.log(`  user       ${env.SMTP_USER || '(none)'}`);
  console.log(`  password   ${mask(env.SMTP_PASS)}`);
  console.log(`  from       ${env.EMAIL_FROM}`);
  console.log(`  to         ${to}\n`);

  if (env.EMAIL_PROVIDER === 'console') {
    console.log('EMAIL_PROVIDER is "console", so nothing will actually be sent.');
    console.log('Set EMAIL_PROVIDER=smtp in .env to send for real.\n');
  }

  // The likeliest state on first run, and it deserves an instruction rather
  // than a round trip to an SMTP error that only says "missing credentials".
  if (env.EMAIL_PROVIDER === 'smtp' && env.SMTP_USER && !env.SMTP_PASS) {
    console.error('SMTP_PASS is empty, so authentication cannot succeed.\n');
    if (env.SMTP_HOST.includes('gmail')) {
      console.error('For Gmail:');
      console.error('  1. Turn on 2-Step Verification: https://myaccount.google.com/signinoptions/two-step-verification');
      console.error('  2. Create an App Password:       https://myaccount.google.com/apppasswords');
      console.error('  3. Paste the 16 characters (no spaces) into SMTP_PASS in .env');
      console.error('  4. Run this again: npm run email:check');
    }
    process.exit(1);
  }

  // A Gmail App Password is exactly 16 characters. Catching a mistyped one
  // here saves a round trip to a 535 that says nothing useful.
  if (env.SMTP_HOST.includes('gmail') && env.SMTP_PASS && env.SMTP_PASS.length !== 16) {
    console.warn(
      `Warning: SMTP_PASS is ${env.SMTP_PASS.length} characters. Gmail App ` +
        'Passwords are exactly 16, with no spaces — check for a stray space ' +
        'or a copied quote.\n',
    );
  }

  const provider = getEmailProvider();

  if ('verify' in provider && typeof provider.verify === 'function') {
    process.stdout.write('Connecting and authenticating... ');
    await (provider as { verify(): Promise<void> }).verify();
    console.log('ok');
  }

  const today = new Date();
  const message = renderReminder({
    contactName: 'Chidi',
    occurrence: observedOccurrence({ month: 3, day: 15 }, today.getFullYear()),
    turningAge: 31,
    notes: 'This is a test of your mail setup. If you can read this, it works.',
    leadDays: 1,
    timezone: 'Africa/Lagos',
    unsubscribeUrl: `${env.APP_URL}/notifications/unsubscribe`,
  });

  process.stdout.write('Sending... ');
  const { messageId } = await provider.send({ ...message, to });
  console.log('ok');

  console.log(`\nSent to ${to}`);
  if (messageId) console.log(`Message id: ${messageId}`);
  if (env.SMTP_HOST === 'mailpit' || env.SMTP_HOST === 'localhost') {
    console.log('Using the local sink — open http://localhost:8025 to read it.');
  } else {
    console.log('Check the inbox (and the spam folder the first time).');
  }
}

main().catch((err) => {
  console.log('failed\n');
  // `send` and `verify` already translate SMTP failures; explaining again
  // would nest one message inside another.
  console.error(err instanceof Error ? err.message : explainSmtpError(err));
  process.exit(1);
});
