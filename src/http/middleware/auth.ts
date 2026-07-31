import type { NextFunction, Request, Response } from 'express';
import type { User } from '../../db/schema.js';
import { resolveSession } from '../../services/auth.js';
import { SESSION_COOKIE } from '../cookies.js';
import { unauthorized } from '../errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
    sessionToken?: string;
  }
}

/** Attaches the user when a valid session cookie is present. Never rejects. */
export async function loadSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === 'string' && token.length > 0) {
    const user = await resolveSession(token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
    }
  }
  next();
}

/** Rejects anonymous requests. Everything past this point has `req.user`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(unauthorized());
    return;
  }
  next();
}

/**
 * Narrowing helper. Route handlers behind `requireAuth` know a user exists,
 * but TypeScript does not — this makes that assertion explicit and loud rather
 * than a scattering of non-null assertions.
 */
export function currentUser(req: Request): User {
  if (!req.user) throw unauthorized();
  return req.user;
}
