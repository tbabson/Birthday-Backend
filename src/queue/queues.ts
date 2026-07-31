import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { sharedConnection } from './connection.js';

export const SEND_QUEUE = 'notifications-send';
export const SWEEP_QUEUE = 'notifications-sweep';

export interface SendJobData {
  notificationId: string;
}

let queue: Queue<SendJobData> | undefined;
let sweep: Queue | undefined;

export function sendQueue(): Queue<SendJobData> {
  queue ??= new Queue<SendJobData>(SEND_QUEUE, {
    connection: sharedConnection(),
    defaultJobOptions: {
      attempts: env.NOTIFICATION_MAX_ATTEMPTS,
      // Exponential backoff (§6.3): ~5s, 10s, 20s, 40s. A transient SMTP
      // failure resolves well inside that; a permanent one exhausts attempts
      // and the row is marked `failed` for the UI to surface.
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 7 * 86_400, count: 5_000 },
      removeOnFail: { age: 30 * 86_400 },
    },
  });
  return queue;
}

/**
 * The notification row's id is the job id, so BullMQ deduplicates too: an
 * enqueue for an already-queued reminder is dropped. Belt and braces on top of
 * the unique index, which remains the real guarantee.
 */
export async function enqueueSend(notificationId: string): Promise<void> {
  await sendQueue().add('send', { notificationId }, { jobId: notificationId });
}

export function sweepQueue(): Queue {
  sweep ??= new Queue(SWEEP_QUEUE, {
    connection: sharedConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
  });
  return sweep;
}

/**
 * Registers the hourly sweep as a BullMQ repeatable job rather than an
 * in-process cron. With more than one API instance running, a process-local
 * timer fires on every instance; a repeatable job is claimed once.
 */
export async function scheduleHourlySweep(): Promise<void> {
  await sweepQueue().add(
    'sweep',
    {},
    {
      repeat: { pattern: '0 * * * *' }, // §6.3: every hour, on the hour.
      jobId: 'hourly-sweep',
    },
  );
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
  if (sweep) {
    await sweep.close();
    sweep = undefined;
  }
}
