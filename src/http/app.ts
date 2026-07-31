import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { loadSession } from './middleware/auth.js';
import { isAllowedOrigin, verifyOrigin } from './middleware/csrf.js';
import { authRouter } from './routes/auth.js';
import { contactsRouter } from './routes/contacts.js';
import { importRouter } from './routes/import.js';
import { calendarRouter, dashboardRouter, meRouter, upcomingRouter } from './routes/me.js';
import { notificationsRouter } from './routes/notifications.js';
import { pushRouter } from './routes/push.js';
import { recipientsRouter } from './routes/recipients.js';

/**
 * The frontend is a separate origin (Vite on :5173 in development), and the
 * session is a cookie — so the allowed origin must be echoed back exactly and
 * credentials must be enabled. A wildcard origin is not permitted alongside
 * credentials, which is the correct constraint here rather than an obstacle.
 *
 * `Vary: Origin` is set unconditionally, including on rejected origins: a
 * cache that stored one origin's response and replayed it for another would
 * hand out an Allow-Origin header for the wrong site.
 */
function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Vary', 'Origin');

  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    // Spares the browser a preflight on every mutation for a day.
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

export function createApp(): Express {
  const app = express();

  // Behind Railway/Fly/nginx the client IP arrives in X-Forwarded-For; without
  // this the rate limiters would key every request to the proxy's address.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors);
  app.use(express.json({ limit: '256kb' }));
  // For the API's own HTML forms — the recipient opt-out page posts back here,
  // and a browser form sends urlencoded, not JSON.
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      // §6.7: don't log names. Query strings can carry a search term, which is
      // a fragment of someone's name.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, path: req.url?.split('?')[0] }),
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  // Ordered deliberately: cookies must be parsed before the origin check can
  // tell whether a session is riding on the request, and the check must run
  // before any route that changes state.
  app.use(verifyOrigin);
  app.use(loadSession);

  /**
   * A signpost, not an index. Anyone who opens the base URL in a browser would
   * otherwise get a bare 404 and reasonably conclude the service is down, so
   * this points them at the health check and the reference. It deliberately
   * lists neither the routes nor a version — an unauthenticated caller has no
   * need of either.
   */
  app.get('/', (_req, res) => {
    res.json({
      service: 'birthday-reminder-api',
      status: 'up',
      health: '/health',
      docs: 'https://github.com/tbabson/Birthday-Backend/blob/main/docs/API.md',
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, status: 'up' });
  });

  app.use('/auth', authRouter);
  app.use('/me', meRouter);
  // Mounted before /contacts so `/contacts/import` is not captured by the
  // `/contacts/:id` parameter route.
  app.use('/contacts/import', importRouter);
  app.use('/contacts', contactsRouter);
  app.use('/upcoming', upcomingRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/calendar', calendarRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/recipients', recipientsRouter);
  app.use('/push', pushRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
