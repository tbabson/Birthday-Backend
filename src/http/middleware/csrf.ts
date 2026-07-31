import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { AppError } from '../errors.js';
import { SESSION_COOKIE, isCrossSiteCookie } from '../cookies.js';

/**
 * CSRF protection by origin verification.
 *
 * Why this exists at all: `SameSite=Lax` is itself a CSRF defence — the
 * browser refuses to attach the cookie to a cross-site POST, so a forged
 * request arrives unauthenticated and fails. Switching to `SameSite=None` for
 * a cross-site deployment removes exactly that guarantee. The cookie now rides
 * along on requests originating from any site, and something has to check that
 * the request came from ours.
 *
 * Note that CORS does not help here. CORS governs whether a response may be
 * *read*, not whether a request may be *sent*: a form POST from an attacker's
 * page is dispatched, and the state change happens, regardless of the fact
 * that the attacker cannot see the reply.
 *
 * Enforcement, by mode:
 *
 * - **Origin present** — must be on the allowlist. Always enforced, in both
 *   modes. Browsers send `Origin` on every state-changing request, so this is
 *   the case that matters in practice.
 * - **Origin absent, `SameSite=None`** — rejected. The browser guarantee is
 *   gone, so a request that cannot prove where it came from cannot be trusted
 *   with a session.
 * - **Origin absent, `SameSite=Lax`** — allowed. The cookie could not have
 *   been attached cross-site in the first place, so there is nothing to forge;
 *   rejecting here would break curl, server-to-server calls and health probes
 *   for no security gain.
 *
 * `Referer` is accepted as a fallback for the small number of clients that
 * omit `Origin`.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin: string): boolean {
  return env.ALLOWED_ORIGINS.some((allowed) => originOf(allowed) === origin);
}

/**
 * Origins accepted for state-changing requests.
 *
 * Wider than the CORS allowlist by exactly one entry: the API's own origin.
 * The API serves a few plain HTML pages of its own — the recipient opt-out
 * confirmation, for instance — whose forms post back to it. A same-origin post
 * is by definition not cross-site request forgery, but it would otherwise be
 * rejected for not being the web app.
 */
function isTrustedRequestOrigin(origin: string): boolean {
  return isAllowedOrigin(origin) || originOf(env.APP_URL) === origin;
}

export function verifyOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // No session cookie means nothing to ride on — token-authenticated or
  // anonymous requests are not a CSRF concern.
  const hasSession = Boolean(req.cookies?.[SESSION_COOKIE]);
  if (!hasSession) {
    next();
    return;
  }

  const origin =
    originOf(req.headers.origin) ?? originOf(req.headers.referer);

  if (origin === null) {
    if (!isCrossSiteCookie()) {
      next();
      return;
    }
    logger.warn(
      { method: req.method, path: req.path },
      'blocked state-changing request with no Origin under SameSite=None',
    );
    next(
      new AppError(
        403,
        'This request could not be verified. Refresh the page and try again.',
        'csrf_origin_missing',
      ),
    );
    return;
  }

  if (!isTrustedRequestOrigin(origin)) {
    // The origin is attacker-controlled data; it is logged so a real attempt is
    // visible, but never echoed back to the caller.
    logger.warn(
      { method: req.method, path: req.path, origin },
      'blocked state-changing request from a disallowed origin',
    );
    next(
      new AppError(
        403,
        'This request came from an unrecognised origin.',
        'csrf_origin_mismatch',
      ),
    );
    return;
  }

  next();
}
