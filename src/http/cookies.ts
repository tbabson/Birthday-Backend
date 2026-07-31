import type { CookieOptions } from 'express';
import { env } from '../config/env.js';

export const SESSION_COOKIE = 'br_session';

/**
 * The one place session cookie attributes are decided.
 *
 * `res.clearCookie` only removes a cookie when its name, path, domain,
 * sameSite and secure flags all match those it was set with. Deriving both the
 * set and the clear from the same object is the only reliable way to stop a
 * sign-out from silently leaving the session in place — a drift that is
 * invisible in development, where the attributes usually happen to match.
 */
function base(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function sessionCookieOptions(expiresAt: Date): CookieOptions {
  return { ...base(), expires: expiresAt };
}

/** Must mirror `sessionCookieOptions` in everything except the expiry. */
export function clearSessionCookieOptions(): CookieOptions {
  return base();
}

/** True when the cookie is configured for a genuinely cross-site deployment. */
export function isCrossSiteCookie(): boolean {
  return env.COOKIE_SAMESITE === 'none';
}
