import { and, eq, inArray } from 'drizzle-orm';
import type { Contact, NotificationStatus, User } from '../db/schema.js';
import { notifications } from '../db/schema.js';
import {
  ageAtOccurrence,
  compareDates,
  daysBetween,
  formatISODate,
  instantAt,
  nextOccurrence,
  reminderDateFor,
  todayIn,
} from '../domain/dates.js';
import type { Db } from '../repositories/types.js';
import { birthDateOf } from './contacts.js';

/**
 * Reminders that are going to happen but have not yet.
 *
 * The `notifications` table is a record of work *claimed*, and the sweep only
 * claims on the morning a reminder is due — so until 09:00 on the day before a
 * birthday there is no row for it, and a delivery log correctly shows nothing.
 *
 * That is right for the log and wrong as an answer to "what is coming?". This
 * derives the answer from contacts and the user's lead time instead, exactly
 * the way the sweep will when the day arrives, so the two cannot disagree.
 *
 * Nothing is written here. Pre-creating rows to make the list non-empty would
 * mean carrying stale claims whenever a contact is edited or deleted, and
 * would put the schedule in two places at once (§6.3).
 */

export interface ScheduledReminder {
  contactId: string;
  contactName: string;
  /** ISO date of the birthday itself. */
  occurrenceDate: string;
  occurrenceYear: number;
  /** ISO date the reminder goes out — `leadDays` before the birthday. */
  remindOn: string;
  /** The exact instant, resolved in the user's own zone. */
  remindAt: string;
  daysUntilReminder: number;
  turningAge: number | null;
  /**
   * Set once the sweep has claimed this reminder. `pending` means it is
   * queued right now; absent means the day has not come round yet.
   */
  claimedStatus: NotificationStatus | null;
}

/** Statuses that mean the reminder is finished with, one way or another. */
const SETTLED: NotificationStatus[] = ['sent', 'failed', 'skipped'];

export async function listScheduledReminders(
  db: Db,
  user: User,
  contacts: Contact[],
  now: Date,
  windowDays: number,
): Promise<ScheduledReminder[]> {
  const today = todayIn(user.timezone, now);
  const candidates: ScheduledReminder[] = [];

  for (const contact of contacts) {
    const birth = birthDateOf(contact);
    const occurrence = nextOccurrence(birth, today);
    const remindOn = reminderDateFor(occurrence, user.leadDays);

    // The reminder day has already passed — the birthday is today, or today is
    // the birthday eve and 09:00 has gone. Whatever happened is in the log.
    if (compareDates(remindOn, today) < 0) continue;

    const daysUntilReminder = daysBetween(today, remindOn);
    if (daysUntilReminder > windowDays) continue;

    candidates.push({
      contactId: contact.id,
      contactName: contact.name,
      occurrenceDate: formatISODate(occurrence),
      occurrenceYear: occurrence.year,
      remindOn: formatISODate(remindOn),
      remindAt: instantAt(remindOn, user.notifyHour, user.timezone).toISOString(),
      daysUntilReminder,
      turningAge: ageAtOccurrence(birth, occurrence.year),
      claimedStatus: null,
    });
  }

  if (candidates.length === 0) return [];

  // Today's entries may already have been claimed by this morning's sweep.
  // Fetching their real status keeps a reminder from appearing as upcoming
  // when it has in fact already gone out.
  const claimed = await db
    .select({
      contactId: notifications.contactId,
      occurrenceYear: notifications.occurrenceYear,
      status: notifications.status,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, user.id),
        eq(notifications.channel, 'email'),
        inArray(
          notifications.contactId,
          candidates.map((c) => c.contactId),
        ),
      ),
    );

  const byKey = new Map(
    claimed.map((row) => [`${row.contactId}:${row.occurrenceYear}`, row.status]),
  );

  return candidates
    .map((candidate) => ({
      ...candidate,
      claimedStatus:
        byKey.get(`${candidate.contactId}:${candidate.occurrenceYear}`) ?? null,
    }))
    // Anything already sent, failed or skipped belongs in the log, not here.
    .filter((c) => c.claimedStatus === null || !SETTLED.includes(c.claimedStatus))
    .sort((a, b) => a.remindAt.localeCompare(b.remindAt));
}
