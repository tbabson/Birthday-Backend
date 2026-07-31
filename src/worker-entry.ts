import { closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './logger.js';
import { closeQueue, closeRedis } from './queue/index.js';
import { startWorker, stopWorker } from './queue/worker.js';
import { runBootRecovery, startScheduler, stopScheduler } from './scheduler.js';

/**
 * The worker container: sweep scheduler + send worker, no HTTP.
 *
 * This is why the deploy target needs a persistent Redis and cannot be pure
 * serverless (§6.1).
 */
async function main(): Promise<void> {
  await runMigrations();

  startWorker();
  await startScheduler();
  await runBootRecovery();

  logger.info('worker ready');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down worker');
    await stopScheduler();
    await stopWorker();
    await closeQueue();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
