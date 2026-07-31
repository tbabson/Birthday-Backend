import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { magicLinkTokens, sessions, users, type User } from '../db/schema.js';
import type { Db } from './types.js';

export async function createSession(
  db: Db,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(sessions).values({ userId, tokenHash, expiresAt });
}

/** Resolves a session cookie to its user in one query. Expired rows never match. */
export async function findUserBySessionToken(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<User | undefined> {
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  return row?.user;
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function createMagicLinkToken(
  db: Db,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(magicLinkTokens).values({ userId, tokenHash, expiresAt });
}

/**
 * Consumes a magic-link token, returning its user only if the token was
 * unused and unexpired. The UPDATE ... WHERE consumed_at IS NULL is what makes
 * this single-use: two concurrent requests race on the same row and exactly
 * one comes back with a result.
 */
export async function consumeMagicLinkToken(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<string | undefined> {
  const [row] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(magicLinkTokens.tokenHash, tokenHash),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, now),
      ),
    )
    .returning({ userId: magicLinkTokens.userId });
  return row?.userId;
}

/** Housekeeping; safe to call on a schedule. */
export async function purgeExpiredAuthRows(db: Db, now: Date): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.delete(magicLinkTokens).where(lt(magicLinkTokens.expiresAt, now));
}

export async function countSessions(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return row?.count ?? 0;
}
