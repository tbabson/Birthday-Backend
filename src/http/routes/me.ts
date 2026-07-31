import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { listContacts } from '../../repositories/contacts.js';
import { listNotifications } from '../../repositories/notifications.js';
import { listActiveSubscriptions } from '../../repositories/push.js';
import { deleteUser, updateUserSettings } from '../../repositories/users.js';
import { buildCalendar, summarise, upcomingWithin } from '../../services/contacts.js';
import { SESSION_COOKIE, clearSessionCookieOptions } from '../cookies.js';
import { logger } from '../../logger.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { badRequest, notFound } from '../errors.js';
import { calendarQuerySchema, updateMeSchema, upcomingQuerySchema } from '../validation.js';

export const meRouter: Router = Router();

meRouter.use(requireAuth);

function publicUser(user: ReturnType<typeof currentUser>) {
  return {
    id: user.id,
    email: user.email,
    timezone: user.timezone,
    notifyHour: user.notifyHour,
    leadDays: user.leadDays,
    createdAt: user.createdAt.toISOString(),
  };
}

meRouter.get('/', async (req, res) => {
  res.json({ user: publicUser(currentUser(req)) });
});

/**
 * Time zone and delivery hour only. `leadDays` is fixed at 1 in v1 (§5.2) —
 * the column exists so a second reminder is a migration rather than a
 * refactor, but it is deliberately not exposed as a setting.
 */
meRouter.patch('/', async (req, res) => {
  const user = currentUser(req);
  const patch = updateMeSchema.parse(req.body);

  const updated = await updateUserSettings(db, user.id, patch);
  if (!updated) throw notFound('User not found');

  res.json({ user: publicUser(updated) });
});

/**
 * §6.7 privacy: "provide a full export + delete".
 *
 * Everything the account holds, in one JSON document — contacts including
 * soft-deleted ones, the delivery log, and registered devices. This is the
 * user's own data; withholding the deleted rows would make the export a
 * summary rather than an export.
 */
meRouter.get('/export', async (req, res) => {
  const user = currentUser(req);

  const [allContacts, log, devices] = await Promise.all([
    listContacts(db, user.id, { includeDeleted: true }),
    listNotifications(db, user.id, { limit: 500 }),
    listActiveSubscriptions(db, user.id),
  ]);

  res.setHeader('Content-Disposition', 'attachment; filename="birthday-reminder-export.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    user: publicUser(user),
    contacts: allContacts.map((c) => ({
      name: c.name,
      birthMonth: c.birthMonth,
      birthDay: c.birthDay,
      birthYear: c.birthYear,
      tag: c.tag,
      notes: c.notes,
      photoUrl: c.photoUrl,
      deletedAt: c.deletedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
    notifications: log.map(({ notification, contactName }) => ({
      contactName,
      occurrenceYear: notification.occurrenceYear,
      leadDays: notification.leadDays,
      channel: notification.channel,
      status: notification.status,
      scheduledFor: notification.scheduledFor.toISOString(),
      sentAt: notification.sentAt?.toISOString() ?? null,
    })),
    pushDevices: devices.map((d) => ({
      userAgent: d.userAgent,
      createdAt: d.createdAt.toISOString(),
    })),
  });
});

/**
 * Irreversible, so it demands the account's own email address as confirmation
 * rather than deleting on an unadorned DELETE. Everything else cascades from
 * the users row.
 */
meRouter.delete('/', async (req, res) => {
  const user = currentUser(req);
  const { confirmEmail } = z.object({ confirmEmail: z.string() }).parse(req.body ?? {});

  if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw badRequest('Type your email address to confirm deletion');
  }

  await deleteUser(db, user.id);
  res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());

  logger.warn({ userId: user.id }, 'account deleted');
  res.json({ ok: true, deleted: true });
});

export const upcomingRouter: Router = Router();
upcomingRouter.use(requireAuth);

upcomingRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const { window } = upcomingQuerySchema.parse(req.query);

  const rows = await listContacts(db, user.id);
  res.json({
    window,
    contacts: upcomingWithin(rows, user, new Date(), window),
  });
});

export const dashboardRouter: Router = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const rows = await listContacts(db, user.id);
  res.json(summarise(rows, user, new Date()));
});

export const calendarRouter: Router = Router();
calendarRouter.use(requireAuth);

/**
 * §5.5, the yearly heatmap. Returns a count per calendar day so the frontend
 * can render 12 months without shipping the whole contact list, and without
 * reimplementing the Feb 29 rule in the browser.
 */
calendarRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const { year } = calendarQuerySchema.parse(req.query);

  const rows = await listContacts(db, user.id);
  res.json(buildCalendar(rows, user, new Date(), year));
});
