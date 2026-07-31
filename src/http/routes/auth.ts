import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { requestMagicLink, revokeSession, verifyMagicLink } from '../../services/auth.js';
import {
  SESSION_COOKIE,
  clearSessionCookieOptions,
  sessionCookieOptions,
} from '../cookies.js';
import { magicLinkSchema } from '../validation.js';

export const authRouter: Router = Router();

// §6.7: rate limits on auth. Keyed by IP; the window is deliberately generous
// enough for a person who mistypes their address twice.
const magicLinkLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many sign-in attempts. Try again shortly.' } },
});

const verifyLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX * 4,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

authRouter.post('/magic-link', magicLinkLimiter, async (req, res) => {
  const { email, timezone } = magicLinkSchema.parse(req.body);

  try {
    await requestMagicLink(email, timezone);
  } catch (err) {
    // Never let a delivery failure reveal whether the address exists.
    logger.error({ err }, 'magic link delivery failed');
  }

  // Always the same response, whether or not the account exists — otherwise
  // this endpoint is an account-enumeration oracle.
  res.status(202).json({ ok: true, message: 'If that address is valid, a sign-in link is on its way.' });
});

authRouter.get('/verify', verifyLimiter, async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const session = token ? await verifyMagicLink(token) : null;

  if (!session) {
    res.redirect(302, `${env.WEB_URL}/sign-in?error=invalid_link`);
    return;
  }

  res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  res.redirect(302, `${env.WEB_URL}/`);
});

authRouter.post('/logout', async (req, res) => {
  if (req.sessionToken) await revokeSession(req.sessionToken);
  res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());
  res.json({ ok: true });
});
