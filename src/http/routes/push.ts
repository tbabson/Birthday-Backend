import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  countActiveSubscriptions,
  deleteSubscription,
  listActiveSubscriptions,
  upsertSubscription,
} from '../../repositories/push.js';
import { pushEnabled } from '../../push/provider.js';
import { badRequest } from '../errors.js';
import { currentUser, requireAuth } from '../middleware/auth.js';

export const pushRouter: Router = Router();

/**
 * The VAPID public key the service worker needs to subscribe. Public by
 * definition, and readable without a session so the frontend can decide
 * whether to offer the "enable notifications" prompt before sign-in.
 */
pushRouter.get('/public-key', (_req, res) => {
  const enabled = pushEnabled();
  res.json({
    enabled,
    // Withheld when push is off. Handing out a key the server cannot send
    // with would let a browser register a subscription that silently never
    // receives anything — worse than plainly saying the channel is disabled.
    publicKey: enabled ? (env.VAPID_PUBLIC_KEY ?? null) : null,
  });
});

pushRouter.use(requireAuth);

/** Mirrors the shape `PushSubscription.toJSON()` produces in the browser. */
const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
});

pushRouter.post('/subscribe', async (req, res) => {
  const user = currentUser(req);
  if (!pushEnabled()) throw badRequest('Push notifications are not configured on this server');

  const parsed = subscriptionSchema.parse(req.body);
  const userAgent = req.headers['user-agent'];

  await upsertSubscription(db, user.id, {
    endpoint: parsed.endpoint,
    p256dh: parsed.keys.p256dh,
    auth: parsed.keys.auth,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
  });

  res.status(201).json({ ok: true, devices: await countActiveSubscriptions(db, user.id) });
});

pushRouter.post('/unsubscribe', async (req, res) => {
  const user = currentUser(req);
  const { endpoint } = z.object({ endpoint: z.string().url().max(2000) }).parse(req.body);

  const removed = await deleteSubscription(db, user.id, endpoint);
  res.json({ ok: true, removed, devices: await countActiveSubscriptions(db, user.id) });
});

pushRouter.get('/subscriptions', async (req, res) => {
  const user = currentUser(req);
  const rows = await listActiveSubscriptions(db, user.id);

  res.json({
    enabled: pushEnabled(),
    devices: rows.map((r) => ({
      id: r.id,
      // The endpoint is a bearer capability for this device — never echo it in
      // full. The tail is enough for a person to tell two devices apart.
      endpointTail: r.endpoint.slice(-12),
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});
