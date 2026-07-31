import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { notificationRecipients, type NotificationRecipient } from '../db/schema.js';
import type { Db } from './types.js';

/** Keeps one register's cc-list from becoming a mailing list. */
export const MAX_RECIPIENTS_PER_USER = 5;

export async function listRecipients(
  db: Db,
  userId: string,
): Promise<NotificationRecipient[]> {
  return db
    .select()
    .from(notificationRecipients)
    .where(eq(notificationRecipients.userId, userId))
    .orderBy(notificationRecipients.createdAt);
}

/** Only confirmed addresses are ever sent to. */
export async function listConfirmedRecipients(
  db: Db,
  userId: string,
): Promise<NotificationRecipient[]> {
  return db
    .select()
    .from(notificationRecipients)
    .where(
      and(
        eq(notificationRecipients.userId, userId),
        isNotNull(notificationRecipients.confirmedAt),
      ),
    );
}

export async function countRecipients(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationRecipients)
    .where(eq(notificationRecipients.userId, userId));
  return row?.count ?? 0;
}

/**
 * Re-adding an existing address returns the existing row rather than creating
 * a second one, and deliberately does *not* reset `confirmed_at` — an address
 * that already agreed should not have to agree again because the owner
 * re-typed it.
 */
export async function addRecipient(
  db: Db,
  userId: string,
  email: string,
  label: string | null,
): Promise<NotificationRecipient> {
  // Looked up explicitly rather than via ON CONFLICT: the unique index is on
  // `lower(email)`, and a functional index cannot be named as a conflict
  // target through the query builder.
  const [existing] = await db
    .select()
    .from(notificationRecipients)
    .where(
      and(
        eq(notificationRecipients.userId, userId),
        sql`lower(${notificationRecipients.email}) = lower(${email})`,
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(notificationRecipients)
      .set({ label })
      .where(eq(notificationRecipients.id, existing.id))
      .returning();
    return updated!;
  }

  const [row] = await db
    .insert(notificationRecipients)
    .values({ userId, email, label })
    .returning();
  return row!;
}

export async function findRecipientById(
  db: Db,
  id: string,
): Promise<NotificationRecipient | undefined> {
  const [row] = await db
    .select()
    .from(notificationRecipients)
    .where(eq(notificationRecipients.id, id))
    .limit(1);
  return row;
}

export async function confirmRecipient(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(notificationRecipients)
    .set({ confirmedAt: new Date() })
    .where(eq(notificationRecipients.id, id))
    .returning({ id: notificationRecipients.id });
  return rows.length > 0;
}

export async function deleteRecipient(
  db: Db,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(notificationRecipients)
    .where(
      and(eq(notificationRecipients.id, id), eq(notificationRecipients.userId, userId)),
    )
    .returning({ id: notificationRecipients.id });
  return rows.length > 0;
}

/** Used by the recipient's own opt-out link, which carries no session. */
export async function deleteRecipientById(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(notificationRecipients)
    .where(eq(notificationRecipients.id, id))
    .returning({ id: notificationRecipients.id });
  return rows.length > 0;
}
