import { sql } from 'drizzle-orm';
import { users, type User } from '../db/schema.js';
import type { Db } from './types.js';

/**
 * Users whose own wall clock has just struck their `notify_hour`.
 *
 * `now AT TIME ZONE users.timezone` is evaluated per row, so "9am local" is
 * resolved per user, not per server (§6.4). Postgres reads the IANA database
 * for this, so DST is handled for free — the same reason `timezone` must never
 * hold a fixed offset.
 *
 * Note on sub-hour offsets: the sweep runs on the hour, so a user in
 * Asia/Kathmandu (UTC+05:45) is picked up when their local clock reads 09:15
 * rather than 09:00. Within-the-hour accuracy is fine for a day-ahead
 * reminder, and the alternative is a per-minute cron.
 */
export async function findUsersAtNotifyHour(db: Db, now: Date): Promise<User[]> {
  return db
    .select()
    .from(users)
    .where(
      sql`extract(hour from (${now.toISOString()}::timestamptz AT TIME ZONE ${users.timezone})) = ${users.notifyHour}`,
    );
}

/**
 * Users whose notify hour has already gone by today. Used on boot to work out
 * whose sweep was missed while the process was down, and by the on-create
 * catch-up.
 */
export async function findUsersPastNotifyHour(db: Db, now: Date): Promise<User[]> {
  return db
    .select()
    .from(users)
    .where(
      sql`extract(hour from (${now.toISOString()}::timestamptz AT TIME ZONE ${users.timezone})) >= ${users.notifyHour}`,
    );
}

export async function countUsers(db: Db): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  return row?.count ?? 0;
}
