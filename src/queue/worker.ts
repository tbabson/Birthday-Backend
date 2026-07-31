import { Worker, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { recordAttempt } from '../repositories/notifications.js';
import { sendNotification } from '../services/sender.js';
import { createRedisConnection } from './connection.js';
import { SEND_QUEUE, type SendJobData } from './queues.js';

let worker: Worker<SendJobData> | undefined;

export function startWorker(): Worker<SendJobData> {
  if (worker) return worker;

  worker = new Worker<SendJobData>(
    SEND_QUEUE,
    async (job: Job<SendJobData>) => sendNotification(job.data.notificationId),
    {
      connection: createRedisConnection(),
      concurrency: 5,
      // Rate-limit sends so a large register does not trip the provider's
      // per-second cap and start producing retryable failures.
      limiter: { max: 20, duration: 1_000 },
    },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const attemptsMade = job.attemptsMade;
    const final = attemptsMade >= (job.opts.attempts ?? env.NOTIFICATION_MAX_ATTEMPTS);

    // Record on the row so the delivery log in the UI shows why (§5.3, §6.3).
    void recordAttempt(db, job.data.notificationId, err.message, final).catch((e) =>
      logger.error({ err: e }, 'could not record send attempt'),
    );

    logger[final ? 'error' : 'warn'](
      { notificationId: job.data.notificationId, attemptsMade, final, err: err.message },
      final ? 'reminder failed permanently' : 'reminder send failed, will retry',
    );
  });

  worker.on('error', (err) => logger.error({ err }, 'worker error'));

  logger.info({ queue: SEND_QUEUE, concurrency: 5 }, 'send worker started');
  return worker;
}

export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = undefined;
  }
}
