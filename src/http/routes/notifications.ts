import { Router } from 'express';
import { db } from '../../db/client.js';
import { observedOccurrence, todayIn } from '../../domain/dates.js';
import { getEmailProvider } from '../../email/provider.js';
import { renderReminder } from '../../email/templates.js';
import { listContacts } from '../../repositories/contacts.js';
import { listNotifications } from '../../repositories/notifications.js';
import { signUnsubscribe, verifyUnsubscribe } from '../../services/auth.js';
import { listScheduledReminders } from '../../services/scheduled.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { notificationsQuerySchema, upcomingQuerySchema } from '../validation.js';

export const notificationsRouter: Router = Router();

/**
 * Unsubscribe must work from an email client with no session (§6.4), so it
 * sits before `requireAuth` and authenticates with a signed user id instead.
 */
notificationsRouter.get('/unsubscribe', async (req, res) => {
  const userId = typeof req.query.u === 'string' ? req.query.u : '';
  const signature = typeof req.query.s === 'string' ? req.query.s : '';

  if (!userId || !signature || !verifyUnsubscribe(userId, signature)) {
    res.status(400).type('html').send('<p>That unsubscribe link is not valid.</p>');
    return;
  }

  // v1 has a single channel and a single reminder, so there is nothing to
  // granularly opt out of yet. Deleting the account is the real opt-out, and
  // that is a destructive action which must not happen on a GET — a mail
  // client prefetching links would fire it. Acknowledge and hand off.
  res
    .status(200)
    .type('html')
    .send(
      '<p>To stop birthday reminders, sign in and delete your account, ' +
        'or reply to this email and we will remove it.</p>',
    );
});

notificationsRouter.use(requireAuth);

/**
 * What is coming, as opposed to what has happened.
 *
 * Derived from contacts rather than read from `notifications`, because the
 * sweep does not claim a row until the morning the reminder is due — see
 * `services/scheduled.ts`.
 */
notificationsRouter.get('/scheduled', async (req, res) => {
  const user = currentUser(req);
  const { window } = upcomingQuerySchema.parse(req.query);

  const contacts = await listContacts(db, user.id);
  const scheduled = await listScheduledReminders(db, user, contacts, new Date(), window);

  res.json({ window, scheduled });
});

notificationsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const { status, limit } = notificationsQuerySchema.parse(req.query);

  const rows = await listNotifications(db, user.id, { status, limit });
  res.json({
    notifications: rows.map(({ notification, contactName }) => ({
      id: notification.id,
      contactId: notification.contactId,
      contactName,
      occurrenceYear: notification.occurrenceYear,
      leadDays: notification.leadDays,
      channel: notification.channel,
      status: notification.status,
      scheduledFor: notification.scheduledFor.toISOString(),
      sentAt: notification.sentAt?.toISOString() ?? null,
      attempts: notification.attempts,
      error: notification.error,
    })),
  });
});

/**
 * §6.5 POST /notifications/test — send yourself a sample.
 *
 * Sends directly rather than through the queue, and writes no `notifications`
 * row: a test send must never occupy an idempotency key, or it would suppress
 * the real reminder for that contact and year.
 */
notificationsRouter.post('/test', async (req, res) => {
  const user = currentUser(req);
  const today = todayIn(user.timezone, new Date());
  const occurrenceYear = today.year;

  const message = renderReminder({
    contactName: 'Chidi',
    occurrence: observedOccurrence({ month: 3, day: 15 }, occurrenceYear),
    turningAge: 31,
    notes: 'Sample reminder — this is what a real one looks like.',
    leadDays: user.leadDays,
    timezone: user.timezone,
    unsubscribeUrl: signUnsubscribe(user.id),
  });

  const { messageId } = await getEmailProvider().send({ ...message, to: user.email });
  res.json({ ok: true, messageId, sentTo: user.email });
});
