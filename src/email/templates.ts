import { formatHuman, type CalendarDate } from '../domain/dates.js';
import type { EmailMessage } from './provider.js';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const WRAPPER = (body: string, footer: string) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
${body}
  </div>
  <div style="max-width:480px;margin:16px auto 0;font-size:12px;color:#6b7280;text-align:center">
${footer}
  </div>
</body></html>`;

export interface ReminderTemplateInput {
  contactName: string;
  occurrence: CalendarDate;
  /** Age being turned, or null when the birth year is unknown. */
  turningAge: number | null;
  notes: string | null;
  /** Calendar days between the send and the birthday. 1 for the standard T-1. */
  leadDays: number;
  timezone: string;
  unsubscribeUrl: string;
}

/**
 * §5.3: the subject line carries the whole message, because on a lock screen
 * that is all that is visible. `Tomorrow: Chidi's birthday (turning 31)`.
 */
export function reminderSubject(input: Pick<ReminderTemplateInput, 'contactName' | 'turningAge' | 'leadDays'>): string {
  const when =
    input.leadDays === 0 ? 'Today' : input.leadDays === 1 ? 'Tomorrow' : `In ${input.leadDays} days`;
  const age = input.turningAge !== null ? ` (turning ${input.turningAge})` : '';
  return `${when}: ${input.contactName}'s birthday${age}`;
}

export function renderReminder(input: ReminderTemplateInput): EmailMessage & { to: string } {
  const subject = reminderSubject(input);
  const dateLabel = formatHuman(input.occurrence, input.timezone);
  const whenPhrase =
    input.leadDays === 0
      ? 'is today'
      : input.leadDays === 1
        ? 'is tomorrow'
        : `is in ${input.leadDays} days`;
  const agePhrase = input.turningAge !== null ? ` They're turning ${input.turningAge}.` : '';

  const text = [
    `${input.contactName}'s birthday ${whenPhrase} — ${dateLabel}.${agePhrase}`,
    ...(input.notes ? ['', `Your notes: ${input.notes}`] : []),
    '',
    'Enough warning to actually do something about it.',
    '',
    `Stop these reminders: ${input.unsubscribeUrl}`,
  ].join('\n');

  const html = WRAPPER(
    [
      `    <p style="margin:0 0 8px;font-size:20px;font-weight:600">${escapeHtml(input.contactName)}'s birthday ${whenPhrase}</p>`,
      `    <p style="margin:0 0 16px;color:#6b7280">${escapeHtml(dateLabel)}${
        input.turningAge !== null ? ` · turning ${input.turningAge}` : ''
      }</p>`,
      input.notes
        ? `    <div style="margin:16px 0;padding:12px;background:#f6f7f9;border-radius:8px;font-size:14px;white-space:pre-wrap">${escapeHtml(input.notes)}</div>`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280">Stop these reminders</a>`,
  );

  return { to: '', subject, text, html, unsubscribeUrl: input.unsubscribeUrl };
}

/**
 * Double opt-in. Nothing is sent to an added address except this, until the
 * person holding it agrees — otherwise "add a recipient" is a button for
 * signing strangers up to mail they never asked for.
 */
export function renderRecipientConfirmation(input: {
  ownerEmail: string;
  confirmUrl: string;
}): Omit<EmailMessage, 'to'> {
  const text = [
    `${input.ownerEmail} would like to share their birthday reminders with you.`,
    '',
    'You would get an email the day before each birthday on their list.',
    'You would not get an account, and you cannot see or change their contacts.',
    '',
    'If that sounds good, confirm here:',
    input.confirmUrl,
    '',
    "If you weren't expecting this, ignore this email — nothing will be sent.",
  ].join('\n');

  const html = WRAPPER(
    [
      `    <p style="margin:0 0 12px;font-size:18px;font-weight:600">Share birthday reminders?</p>`,
      `    <p style="margin:0 0 16px">${escapeHtml(input.ownerEmail)} would like to send you their birthday reminders — one email the day before each birthday.</p>`,
      `    <p style="margin:0 0 20px"><a href="${escapeHtml(input.confirmUrl)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Yes, send them to me</a></p>`,
      `    <p style="margin:0;font-size:13px;color:#6b7280">If you weren't expecting this, ignore it — nothing will be sent.</p>`,
    ].join('\n'),
    'You are receiving this once, because someone entered your address.',
  );

  return { subject: 'Confirm birthday reminders', text, html };
}

export function renderMagicLink(input: { url: string; ttlMinutes: number }): Omit<EmailMessage, 'to'> {
  const text = [
    'Here is your sign-in link:',
    '',
    input.url,
    '',
    `It expires in ${input.ttlMinutes} minutes and can only be used once.`,
    "If you didn't request this, you can ignore this email.",
  ].join('\n');

  const html = WRAPPER(
    [
      `    <p style="margin:0 0 16px;font-size:18px;font-weight:600">Sign in to Birthday Reminder</p>`,
      `    <p style="margin:0 0 20px"><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a></p>`,
      `    <p style="margin:0;font-size:13px;color:#6b7280">Expires in ${input.ttlMinutes} minutes. Single use.</p>`,
    ].join('\n'),
    "If you didn't request this, ignore this email.",
  );

  return { subject: 'Your sign-in link', text, html };
}
