import { eq, sql } from 'drizzle-orm';
import { users, type User } from '../db/schema.js';
import type { Db } from './types.js';

export async function findUserByEmail(db: Db, email: string): Promise<User | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row;
}

export async function findUserById(db: Db, id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

/** Idempotent: a magic-link request for an unknown address creates the account. */
export async function upsertUserByEmail(
  db: Db,
  email: string,
  defaults: { timezone?: string } = {},
): Promise<User> {
  const existing = await findUserByEmail(db, email);
  if (existing) return existing;

  const [row] = await db
    .insert(users)
    .values({ email, ...(defaults.timezone ? { timezone: defaults.timezone } : {}) })
    .onConflictDoNothing()
    .returning();

  // Lost a race with a concurrent request for the same address.
  return row ?? (await findUserByEmail(db, email))!;
}

/**
 * §6.7 privacy: full delete. Contacts, notifications, sessions, magic links
 * and push subscriptions all cascade from this row, so one statement removes
 * every trace of the account.
 */
export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

export async function updateUserSettings(
  db: Db,
  userId: string,
  patch: { timezone?: string; notifyHour?: number; leadDays?: number },
): Promise<User | undefined> {
  const [row] = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return row;
}
