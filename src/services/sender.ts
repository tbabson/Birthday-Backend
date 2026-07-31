import { env } from '../config/env.js';
import { db } from '../db/client.js';
import type { Contact, Notification, User } from '../db/schema.js';
import { ageAtOccurrence, formatHuman, observedOccurrence } from '../domain/dates.js';
import { getEmailProvider } from '../email/provider.js';
import { renderReminder, reminderSubject } from '../email/templates.js';
import { logger } from '../logger.js';
import { getSendPayload, markSent, markSkipped } from '../repositories/notifications.js';
import { listActiveSubscriptions, markSubscriptionExpired } from '../repositories/push.js';
import { listConfirmedRecipients } from '../repositories/recipients.js';
import { getPushProvider } from '../push/provider.js';
import { signRecipientLink, signUnsubscribe } from './auth.js';
import { birthDateOf } from './contacts.js';

export type SendOutcome =
  | { outcome: 'sent'; messageId: string | null }
  | { outcome: 'skipped'; reason: string };

/**
 * Sends one reminder. Throwing here is meaningful: BullMQ catches it and
 * retries with backoff. Anything that should *not* be retried is resolved as
 * `skipped` instead.
 */
export async function sendNotification(
  notificationId: string,
  now: Date = new Date(),
): Promise<SendOutcome> {
  const payload = await getSendPayload(db, notificationId);
  if (!payload) return { outcome: 'skipped', reason: 'notification no longer exists' };

  const { notification, contact, user } = payload;

  // Already handled — a duplicate job, or a retry that raced the success path.
  if (notification.status !== 'pending') {
    return { outcome: 'skipped', reason: `already ${notification.status}` };
  }

  // §6.4: cancel on soft-delete. The row may have been queued before the
  // contact was removed.
  if (contact.deletedAt) {
    await markSkipped(db, notification.id, 'contact deleted');
    return { outcome: 'skipped', reason: 'contact deleted' };
  }

  // §6.4: past the grace window, silence beats a stale reminder — a birthday
  // reminder three days late is worse than none.
  const lateByHours = (now.getTime() - notification.scheduledFor.getTime()) / 3_600_000;
  if (lateByHours > env.NOTIFICATION_GRACE_HOURS) {
    await markSkipped(db, notification.id, `outside grace window (${Math.round(lateByHours)}h late)`);
    logger.warn(
      { notificationId: notification.id, lateByHours: Math.round(lateByHours) },
      'reminder skipped: outside grace window',
    );
    return { outcome: 'skipped', reason: 'outside grace window' };
  }

  const result =
    notification.channel === 'push'
      ? await sendPush(notification, contact, user, now)
      : await sendEmail(notification, contact, user, now);

  if (result.outcome === 'sent') {
    logger.info(
      {
        notificationId: notification.id,
        userId: user.id,
        channel: notification.channel,
        leadDays: notification.leadDays,
      },
      'reminder sent',
    );
  }

  return result;
}

async function sendEmail(
  notification: Notification,
  contact: Contact,
  user: User,
  now: Date,
): Promise<SendOutcome> {
  const birth = birthDateOf(contact);
  const occurrence = observedOccurrence(birth, notification.occurrenceYear);

  const base = {
    contactName: contact.name,
    occurrence,
    turningAge: ageAtOccurrence(birth, notification.occurrenceYear),
    notes: contact.notes,
    leadDays: notification.leadDays,
    timezone: user.timezone,
  };

  const provider = getEmailProvider();

  /*
   * The owner's copy is sent first and is what decides the outcome. If it
   * throws, nothing is marked sent and BullMQ retries the whole job — which is
   * safe precisely because no extra recipient has been written to yet.
   */
  const ownerMessage = renderReminder({ ...base, unsubscribeUrl: signUnsubscribe(user.id) });
  const { messageId } = await provider.send({ ...ownerMessage, to: user.email });

  /*
   * Extra recipients are sent one message each, so every person gets their own
   * opt-out link rather than a shared one. A failure here is logged and
   * swallowed: the reminder has already reached the person it belongs to, and
   * throwing would retry the job and deliver the owner a second copy —
   * breaking "never send the same reminder twice" to fix a lesser problem.
   *
   * This is the same rule the push channel uses for a dead device.
   */
  const recipients = await listConfirmedRecipients(db, user.id);
  let alsoSent = 0;

  for (const recipient of recipients) {
    try {
      const copy = renderReminder({
        ...base,
        unsubscribeUrl: signRecipientLink(recipient.id, 'remove'),
      });
      await provider.send({ ...copy, to: recipient.email });
      alsoSent += 1;
    } catch (err) {
      logger.error(
        { err, notificationId: notification.id, recipientId: recipient.id },
        'reminder copy to an extra recipient failed',
      );
    }
  }

  await markSent(db, notification.id, messageId, now);

  if (recipients.length > 0) {
    logger.info(
      { notificationId: notification.id, alsoSent, recipients: recipients.length },
      'reminder copied to extra recipients',
    );
  }

  return { outcome: 'sent', messageId };
}

/**
 * Push fans out to every live device. One notification row covers all of them:
 * the user is being told once, on whichever screens they own.
 *
 * A device whose endpoint has died is retired and does not count as a failure —
 * otherwise an old laptop that will never come back would keep the whole
 * reminder retrying until it exhausted its attempts.
 */
async function sendPush(
  notification: Notification,
  contact: Contact,
  user: User,
  now: Date,
): Promise<SendOutcome> {
  const provider = getPushProvider();
  if (!provider.enabled) {
    await markSkipped(db, notification.id, 'push channel not configured');
    return { outcome: 'skipped', reason: 'push channel not configured' };
  }

  const subscriptions = await listActiveSubscriptions(db, user.id);
  if (subscriptions.length === 0) {
    await markSkipped(db, notification.id, 'no active push subscriptions');
    return { outcome: 'skipped', reason: 'no active push subscriptions' };
  }

  const birth = birthDateOf(contact);
  const occurrence = observedOccurrence(birth, notification.occurrenceYear);
  const turningAge = ageAtOccurrence(birth, notification.occurrenceYear);

  const message = {
    title: reminderSubject({
      contactName: contact.name,
      turningAge,
      leadDays: notification.leadDays,
    }),
    body: contact.notes ?? formatHuman(occurrence, user.timezone),
    url: `${env.WEB_URL}/contacts/${contact.id}`,
    tag: `birthday-${contact.id}-${notification.occurrenceYear}`,
  };

  let delivered = 0;
  let expired = 0;
  const failures: Error[] = [];

  for (const subscription of subscriptions) {
    try {
      const result = await provider.send(subscription, message);
      if (result.expired) {
        await markSubscriptionExpired(db, subscription.endpoint);
        expired += 1;
      } else if (result.delivered) {
        delivered += 1;
      }
    } catch (err) {
      failures.push(err as Error);
    }
  }

  if (delivered > 0) {
    await markSent(db, notification.id, `push:${delivered}`, now);
    return { outcome: 'sent', messageId: `push:${delivered}` };
  }

  // Nothing got through. If every endpoint is simply dead there is nothing to
  // retry; if any failed transiently, throw so the queue backs off.
  if (failures.length > 0) {
    throw failures[0]!;
  }

  await markSkipped(db, notification.id, `all ${expired} push endpoints expired`);
  return { outcome: 'skipped', reason: 'all push endpoints expired' };
}
