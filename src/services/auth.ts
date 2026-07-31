import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { getEmailProvider } from '../email/provider.js';
import { renderMagicLink } from '../email/templates.js';
import { logger } from '../logger.js';
import {
  consumeMagicLinkToken,
  createMagicLinkToken,
  createSession,
  deleteSession,
  findUserBySessionToken,
} from '../repositories/sessions.js';
import { upsertUserByEmail } from '../repositories/users.js';
import type { User } from '../db/schema.js';

/**
 * Tokens are 32 random bytes, so a plain hash is enough — there is nothing to
 * brute-force. The HMAC key means a database dump alone does not let an
 * attacker mint a working cookie from a stolen hash.
 */
function hashToken(token: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function requestMagicLink(
  email: string,
  timezone?: string,
): Promise<void> {
  const user = await upsertUserByEmail(db, email, timezone ? { timezone } : {});

  const token = newToken();
  const expiresAt = new Date(Date.now() + env.MAGIC_LINK_TTL_MINUTES * 60_000);
  await createMagicLinkToken(db, user.id, hashToken(token), expiresAt);

  const url = `${env.APP_URL}/auth/verify?token=${encodeURIComponent(token)}`;
  const message = renderMagicLink({ url, ttlMinutes: env.MAGIC_LINK_TTL_MINUTES });
  await getEmailProvider().send({ ...message, to: user.email });

  logger.info({ userId: user.id }, 'magic link issued');
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  user: User;
}

export async function verifyMagicLink(token: string): Promise<IssuedSession | null> {
  const now = new Date();
  const userId = await consumeMagicLinkToken(db, hashToken(token), now);
  if (!userId) return null;

  const sessionToken = newToken();
  const expiresAt = new Date(now.getTime() + env.SESSION_TTL_DAYS * 86_400_000);
  await createSession(db, userId, hashToken(sessionToken), expiresAt);

  const user = await findUserBySessionToken(db, hashToken(sessionToken), now);
  if (!user) return null;

  logger.info({ userId }, 'session issued');
  return { token: sessionToken, expiresAt, user };
}

export async function resolveSession(token: string): Promise<User | null> {
  const user = await findUserBySessionToken(db, hashToken(token), new Date());
  return user ?? null;
}

export async function revokeSession(token: string): Promise<void> {
  await deleteSession(db, hashToken(token));
}

/** Constant-time compare, for the unsubscribe signature below. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Unsubscribe links must work without a login — the user clicks them from an
 * email client, possibly on a different device. A signed user id gives a
 * one-click opt-out that cannot be forged or enumerated.
 */
export function signUnsubscribe(userId: string): string {
  const sig = createHmac('sha256', env.SESSION_SECRET)
    .update(`unsubscribe:${userId}`)
    .digest('base64url');
  return `${env.APP_URL}/notifications/unsubscribe?u=${userId}&s=${sig}`;
}

export function verifyUnsubscribe(userId: string, signature: string): boolean {
  const expected = createHmac('sha256', env.SESSION_SECRET)
    .update(`unsubscribe:${userId}`)
    .digest('base64url');
  return safeEqual(expected, signature);
}

/**
 * Links for extra recipients, who have no account and therefore no session.
 *
 * The purpose is part of the signed payload, so a confirmation link can never
 * be replayed as a removal link or the other way round.
 */
function recipientSignature(recipientId: string, purpose: 'confirm' | 'remove'): string {
  return createHmac('sha256', env.SESSION_SECRET)
    .update(`recipient:${purpose}:${recipientId}`)
    .digest('base64url');
}

export function signRecipientLink(
  recipientId: string,
  purpose: 'confirm' | 'remove',
): string {
  const sig = recipientSignature(recipientId, purpose);
  return `${env.APP_URL}/recipients/${purpose}?r=${recipientId}&s=${sig}`;
}

export function verifyRecipientLink(
  recipientId: string,
  purpose: 'confirm' | 'remove',
  signature: string,
): boolean {
  return safeEqual(recipientSignature(recipientId, purpose), signature);
}
