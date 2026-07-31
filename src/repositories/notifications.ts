import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  contacts,
  notifications,
  users,
  type Contact,
  type Notification,
  type NotificationChannel,
  type NotificationStatus,
  type User,
} from '../db/schema.js';
import type { Db } from './types.js';

export interface NotificationKey {
  userId: string;
  contactId: string;
  /** Year of the *birthday*, not of the send. See schema comment. */
  occurrenceYear: number;
  leadDays: number;
  channel: NotificationChannel;
  scheduledFor: Date;
}

/**
 * Claims the right to send one reminder.
 *
 * Returns the new row, or `undefined` if this exact reminder already exists —
 * the unique index on (contact_id, occurrence_year, lead_days, channel) turns
 * a duplicate into a no-op rather than a second email. A retried job, an
 * overlapping sweep, or a redeploy mid-run all land here harmlessly (§6.2).
 */
export async function claimNotification(
  db: Db,
  key: NotificationKey,
): Promise<Notification | undefined> {
  const [row] = await db
    .insert(notifications)
    .values({ ...key, status: 'pending' })
    .onConflictDoNothing({
      target: [
        notifications.contactId,
        notifications.occurrenceYear,
        notifications.leadDays,
        notifications.channel,
      ],
    })
    .returning();
  return row;
}

export interface SendPayload {
  notification: Notification;
  contact: Contact;
  user: User;
}

/** Everything the worker needs to render and address one email. */
export async function getSendPayload(
  db: Db,
  notificationId: string,
): Promise<SendPayload | undefined> {
  const [row] = await db
    .select({ notification: notifications, contact: contacts, user: users })
    .from(notifications)
    .innerJoin(contacts, eq(contacts.id, notifications.contactId))
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(eq(notifications.id, notificationId))
    .limit(1);
  return row;
}

export async function markSent(
  db: Db,
  id: string,
  providerMessageId: string | null,
  sentAt: Date,
): Promise<void> {
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt, providerMessageId, error: null, updatedAt: new Date() })
    .where(eq(notifications.id, id));
}

export async function recordAttempt(
  db: Db,
  id: string,
  error: string,
  final: boolean,
): Promise<void> {
  await db
    .update(notifications)
    .set({
      attempts: sql`${notifications.attempts} + 1`,
      error: error.slice(0, 1000),
      ...(final ? { status: 'failed' as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(notifications.id, id));
}

export async function markSkipped(db: Db, id: string, reason: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: 'skipped', error: reason.slice(0, 1000), updatedAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'pending')));
}

/**
 * Soft-deleting a contact must cancel anything not yet sent (§6.4) — otherwise
 * a queued job fires a reminder for someone the user just removed.
 */
export async function cancelPendingForContact(
  db: Db,
  userId: string,
  contactId: string,
): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ status: 'skipped', error: 'contact deleted', updatedAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.contactId, contactId),
        eq(notifications.status, 'pending'),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}

export interface NotificationLogRow {
  notification: Notification;
  contactName: string;
}

export async function listNotifications(
  db: Db,
  userId: string,
  opts: { status?: NotificationStatus | undefined; limit?: number } = {},
): Promise<NotificationLogRow[]> {
  const clauses = [eq(notifications.userId, userId)];
  if (opts.status) clauses.push(eq(notifications.status, opts.status));

  const rows = await db
    .select({ notification: notifications, contactName: contacts.name })
    .from(notifications)
    .innerJoin(contacts, eq(contacts.id, notifications.contactId))
    .where(and(...clauses))
    .orderBy(desc(notifications.scheduledFor))
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows;
}

/**
 * Pending rows whose send time has passed. Used on boot to recover from
 * downtime: anything inside the grace window is re-enqueued, anything older is
 * skipped — a birthday reminder three days late is worse than none (§6.4).
 */
export async function findOverduePending(
  db: Db,
  now: Date,
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.status, 'pending'), lt(notifications.scheduledFor, now)))
    .orderBy(notifications.scheduledFor)
    .limit(1000);
}

export async function countByStatus(
  db: Db,
  since: Date,
): Promise<Array<{ status: NotificationStatus; count: number }>> {
  return db
    .select({ status: notifications.status, count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(gte(notifications.createdAt, since))
    .groupBy(notifications.status);
}
