import { Worker } from 'bullmq';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { logger } from './logger.js';
import { findOverduePending, markSkipped } from './repositories/notifications.js';
import { createRedisConnection } from './queue/connection.js';
import { SWEEP_QUEUE, enqueueSend, scheduleHourlySweep } from './queue/queues.js';
import { reconcileMissedSweeps, runSweep } from './services/sweep.js';

let sweepWorker: Worker | undefined;

/**
 * Re-drives notifications that were claimed but never sent — the process died
 * between the INSERT and the job being picked up, or Redis lost the queue.
 *
 * Inside the grace window they are re-enqueued; past it they are marked
 * `skipped` (§6.4). The `pending` status is the recovery log: any row still
 * pending after this ran is a genuine problem, which is what makes the §6.7
 * silent-failure alert meaningful.
 */
export async function recoverPendingNotifications(now: Date = new Date()): Promise<{
  requeued: number;
  skipped: number;
}> {
  const overdue = await findOverduePending(db, now);
  let requeued = 0;
  let skipped = 0;

  for (const row of overdue) {
    const lateByHours = (now.getTime() - row.scheduledFor.getTime()) / 3_600_000;
    if (lateByHours > env.NOTIFICATION_GRACE_HOURS) {
      await markSkipped(db, row.id, `outside grace window (${Math.round(lateByHours)}h late)`);
      skipped += 1;
    } else {
      await enqueueSend(row.id);
      requeued += 1;
    }
  }

  if (requeued || skipped) {
    logger.warn({ requeued, skipped }, 'recovered pending notifications');
  }
  return { requeued, skipped };
}

/** Runs once at startup: catch up on anything missed while the process was down. */
export async function runBootRecovery(now: Date = new Date()): Promise<void> {
  await recoverPendingNotifications(now);
  await reconcileMissedSweeps(now);
}

export async function startScheduler(): Promise<void> {
  sweepWorker = new Worker(
    SWEEP_QUEUE,
    async () => {
      const result = await runSweep(new Date());
      return result;
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );

  sweepWorker.on('failed', (_job, err) => logger.error({ err }, 'sweep job failed'));
  sweepWorker.on('error', (err) => logger.error({ err }, 'sweep worker error'));

  await scheduleHourlySweep();
  logger.info({ pattern: '0 * * * *' }, 'hourly sweep scheduled');
}

export async function stopScheduler(): Promise<void> {
  if (sweepWorker) {
    await sweepWorker.close();
    sweepWorker = undefined;
  }
}
