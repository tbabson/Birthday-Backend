import webpush from 'web-push';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { PushSubscription } from '../db/schema.js';

export interface PushMessage {
  title: string;
  body: string;
  /** Deep link opened when the notification is tapped. */
  url: string;
  /**
   * Collapse key. Two reminders for the same contact replace each other on the
   * lock screen instead of stacking.
   */
  tag: string;
}

export interface PushProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(
    subscription: PushSubscription,
    message: PushMessage,
  ): Promise<{ delivered: boolean; expired: boolean }>;
}

/** Thrown for transient failures so the queue retries; expiry is not an error. */
export class PushDeliveryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | undefined,
  ) {
    super(message);
    this.name = 'PushDeliveryError';
  }
}

class WebPushProvider implements PushProvider {
  readonly name = 'web-push';
  readonly enabled = true;

  constructor(publicKey: string, privateKey: string) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, publicKey, privateKey);
  }

  async send(
    subscription: PushSubscription,
    message: PushMessage,
  ): Promise<{ delivered: boolean; expired: boolean }> {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(message),
        { TTL: 12 * 3600 }, // A day-ahead reminder is worthless a day later.
      );
      return { delivered: true, expired: false };
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;

      // 404/410: the browser dropped the subscription. Permanent, and not a
      // failure worth retrying — the row is retired instead.
      if (statusCode === 404 || statusCode === 410) {
        return { delivered: false, expired: true };
      }

      throw new PushDeliveryError(
        (err as Error).message ?? 'push delivery failed',
        statusCode,
      );
    }
  }
}

/** Used when VAPID keys are absent: push is simply off, email still works. */
class DisabledPushProvider implements PushProvider {
  readonly name = 'disabled';
  readonly enabled = false;

  async send(): Promise<{ delivered: boolean; expired: boolean }> {
    return { delivered: false, expired: false };
  }
}

let provider: PushProvider | undefined;

export function getPushProvider(): PushProvider {
  if (!provider) {
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      provider = new WebPushProvider(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
      logger.info('web push enabled');
    } else {
      provider = new DisabledPushProvider();
      logger.info('web push disabled (no VAPID keys configured)');
    }
  }
  return provider;
}

export function setPushProvider(next: PushProvider | undefined): void {
  provider = next;
}

export function pushEnabled(): boolean {
  return getPushProvider().enabled;
}
