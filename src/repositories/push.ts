import { and, eq, isNull, sql } from 'drizzle-orm';
import { pushSubscriptions, type PushSubscription } from '../db/schema.js';
import type { Db } from './types.js';

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * Re-subscribing with the same endpoint updates the existing row rather than
 * creating a second one — browsers rotate keys on the same endpoint, and a
 * stale key means a silent delivery failure. Also clears `expired_at`, so a
 * device that comes back to life starts receiving again.
 */
export async function upsertSubscription(
  db: Db,
  userId: string,
  input: PushSubscriptionInput,
): Promise<PushSubscription> {
  const [row] = await db
    .insert(pushSubscriptions)
    .values({ userId, ...input })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        expiredAt: null,
      },
    })
    .returning();
  return row!;
}

/** Live subscriptions only — expired endpoints are skipped, not resurrected. */
export async function listActiveSubscriptions(
  db: Db,
  userId: string,
): Promise<PushSubscription[]> {
  return db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.expiredAt)));
}

export async function countActiveSubscriptions(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.expiredAt)));
  return row?.count ?? 0;
}

/**
 * Called when a push service answers 404 or 410: the browser is gone for good.
 * Marked rather than deleted so a re-subscribe can revive the same row and the
 * history stays intact.
 */
export async function markSubscriptionExpired(db: Db, endpoint: string): Promise<void> {
  await db
    .update(pushSubscriptions)
    .set({ expiredAt: new Date() })
    .where(eq(pushSubscriptions.endpoint, endpoint));
}

export async function deleteSubscription(
  db: Db,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)),
    )
    .returning({ id: pushSubscriptions.id });
  return rows.length > 0;
}
