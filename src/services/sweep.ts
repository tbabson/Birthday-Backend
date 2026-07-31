import type { Contact, NotificationChannel, User } from '../db/schema.js';
import { db } from '../db/client.js';
import { countActiveSubscriptions } from '../repositories/push.js';
import { pushEnabled } from '../push/provider.js';
import {
  birthDatesObservedOn,
  daysBetween,
  formatISODate,
  hourIn,
  instantAt,
  nextOccurrence,
  occurrenceDateFor,
  reminderDateFor,
  todayIn,
  type CalendarDate,
} from '../domain/dates.js';
import { logger } from '../logger.js';
import { findContactsByBirthDates } from '../repositories/contacts.js';
import { claimNotification } from '../repositories/notifications.js';
import { findUsersAtNotifyHour, findUsersPastNotifyHour } from '../repositories/sweep.js';
import { birthDateOf } from './contacts.js';
import { enqueueSend } from '../queue/queues.js';

/**
 * The sweep (§6.3).
 *
 * A daily sweep, not per-contact timers. A job scheduled a year in advance is
 * fragile against Redis loss, contact edits, deletions and lead-time changes;
 * the sweep re-derives everything from current state each day, so the database
 * stays the single source of truth.
 */

export interface SweepResult {
  usersSwept: number;
  contactsMatched: number;
  claimed: number;
  /** Claims that hit the unique index — already handled, deliberately not resent. */
  duplicates: number;
}

const EMPTY: SweepResult = { usersSwept: 0, contactsMatched: 0, claimed: 0, duplicates: 0 };

/**
 * Which channels this user gets. Email is unconditional — it is the guaranteed
 * channel and the one that works when a browser has forgotten the site exists.
 * Push is added only when the server has VAPID keys *and* the user has a live
 * device, so a user with no devices does not accumulate rows that can only ever
 * be skipped.
 *
 * Because `channel` is part of the unique index, email and push are separate
 * claims and cannot suppress one another.
 */
async function resolveChannels(user: User): Promise<NotificationChannel[]> {
  const channels: NotificationChannel[] = ['email'];
  if (pushEnabled() && (await countActiveSubscriptions(db, user.id)) > 0) {
    channels.push('push');
  }
  return channels;
}

/**
 * Claims and enqueues reminders for one user, for the occurrence date implied
 * by `reminderDate` and their lead time.
 */
async function scheduleFor(
  user: User,
  reminderDate: CalendarDate,
  occurrence: CalendarDate,
  leadDays: number,
  opts: { sendImmediately?: boolean; now: Date },
): Promise<{ matched: number; claimed: number; duplicates: number }> {
  const pairs = birthDatesObservedOn(occurrence);
  const matches = await findContactsByBirthDates(db, user.id, pairs);
  const channels = await resolveChannels(user);

  let claimed = 0;
  let duplicates = 0;

  const scheduledFor = opts.sendImmediately
    ? opts.now
    : instantAt(reminderDate, user.notifyHour, user.timezone);

  for (const contact of matches) {
    for (const channel of channels) {
      const row = await claimNotification(db, {
        userId: user.id,
        contactId: contact.id,
        // The year of the *birthday*. On 31 December this is next year (§6.4).
        occurrenceYear: occurrence.year,
        leadDays,
        channel,
        scheduledFor,
      });

      if (!row) {
        duplicates += 1;
        continue;
      }
      claimed += 1;
      await enqueueSend(row.id);
    }
  }

  return { matched: matches.length, claimed, duplicates };
}

/** One user's sweep, for the reminder that is due on their today. */
export async function sweepUser(user: User, now: Date): Promise<SweepResult> {
  const today = todayIn(user.timezone, now);
  const occurrence = occurrenceDateFor(today, user.leadDays);
  const { matched, claimed, duplicates } = await scheduleFor(
    user,
    today,
    occurrence,
    user.leadDays,
    { now },
  );

  logger.info(
    {
      userId: user.id,
      reminderDate: formatISODate(today),
      occurrenceDate: formatISODate(occurrence),
      occurrenceYear: occurrence.year,
      matched,
      claimed,
      duplicates,
    },
    'swept user',
  );

  return { usersSwept: 1, contactsMatched: matched, claimed, duplicates };
}

/** The hourly job. Picks up only the users whose local clock just hit their hour. */
export async function runSweep(now: Date = new Date()): Promise<SweepResult> {
  const due = await findUsersAtNotifyHour(db, now);
  if (due.length === 0) return EMPTY;

  const total = { ...EMPTY };
  for (const user of due) {
    try {
      const r = await sweepUser(user, now);
      total.usersSwept += r.usersSwept;
      total.contactsMatched += r.contactsMatched;
      total.claimed += r.claimed;
      total.duplicates += r.duplicates;
    } catch (err) {
      // One user's bad time zone must not stop everyone else's reminders.
      logger.error({ err, userId: user.id }, 'sweep failed for user');
    }
  }

  logger.info(total, 'sweep complete');
  return total;
}

/**
 * §6.4, contact added on or after the reminder day.
 *
 * Add someone at 3pm on 14 March whose birthday is 15 March and the 09:00
 * sweep has already run — without this they get no reminder at all. Called on
 * create and whenever a birthday is edited.
 *
 * The lead time used is the *actual* distance to the birthday, so a contact
 * added on the day itself is keyed with lead_days = 0. That is a different
 * idempotency key from the normal T-1 row, which is what makes it safe to run
 * alongside the sweep.
 */
export async function catchUpForContact(
  user: User,
  contact: Contact,
  now: Date = new Date(),
): Promise<boolean> {
  const today = todayIn(user.timezone, now);
  const occurrence = nextOccurrence(birthDateOf(contact), today);
  const daysAway = daysBetween(today, occurrence);

  if (daysAway > user.leadDays) return false; // The normal sweep will get it.

  const sweepAlreadyRan = hourIn(user.timezone, now) >= user.notifyHour;
  if (daysAway === user.leadDays && !sweepAlreadyRan) return false; // Today's sweep still to come.

  const { claimed } = await scheduleForSingleContact(user, contact, occurrence, daysAway, now);

  if (claimed > 0) {
    logger.info(
      { userId: user.id, contactId: contact.id, daysAway, occurrenceYear: occurrence.year },
      'catch-up reminder enqueued',
    );
  }
  return claimed > 0;
}

async function scheduleForSingleContact(
  user: User,
  contact: Contact,
  occurrence: CalendarDate,
  leadDays: number,
  now: Date,
): Promise<{ claimed: number }> {
  const channels = await resolveChannels(user);
  let claimed = 0;

  for (const channel of channels) {
    const row = await claimNotification(db, {
      userId: user.id,
      contactId: contact.id,
      occurrenceYear: occurrence.year,
      leadDays,
      channel,
      scheduledFor: now,
    });
    if (!row) continue;
    claimed += 1;
    await enqueueSend(row.id);
  }

  return { claimed };
}

/**
 * §6.4, server downtime. On boot, re-run today's sweep for every user whose
 * notify hour has already passed. The unique index makes this free when
 * nothing was missed.
 *
 * Deliberately does *not* resurrect yesterday's missed reminders: yesterday's
 * T-1 reminder is about a birthday that is today, and "X's birthday is
 * tomorrow" sent on the day itself is wrong rather than merely late.
 */
export async function reconcileMissedSweeps(now: Date = new Date()): Promise<SweepResult> {
  const users = await findUsersPastNotifyHour(db, now);
  const total = { ...EMPTY };

  for (const user of users) {
    try {
      const today = todayIn(user.timezone, now);
      const occurrence = occurrenceDateFor(today, user.leadDays);
      const r = await scheduleFor(user, today, occurrence, user.leadDays, {
        sendImmediately: true,
        now,
      });
      total.usersSwept += 1;
      total.contactsMatched += r.matched;
      total.claimed += r.claimed;
      total.duplicates += r.duplicates;
    } catch (err) {
      logger.error({ err, userId: user.id }, 'reconcile failed for user');
    }
  }

  if (total.claimed > 0) {
    logger.warn(total, 'reconcile recovered missed reminders');
  } else {
    logger.info(total, 'reconcile found nothing missed');
  }
  return total;
}

/** Exposed for the test-send endpoint and tests. */
export { reminderDateFor };
