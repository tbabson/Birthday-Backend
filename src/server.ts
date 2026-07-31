import { env } from './config/env.js';
import { closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';
import { closeQueue, closeRedis } from './queue/index.js';
import { stopWorker, startWorker } from './queue/worker.js';
import { runBootRecovery, startScheduler, stopScheduler } from './scheduler.js';

async function main(): Promise<void> {
  await runMigrations();
  logger.info('migrations up to date');

  const app = createApp();
  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, 'api listening');
  });

  // In development one process runs everything. In production the worker is a
  // separate container so a slow send queue cannot stall API requests.
  if (env.RUN_WORKER_IN_PROCESS) {
    startWorker();
    await startScheduler();
    await runBootRecovery();
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    server.close();
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
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
