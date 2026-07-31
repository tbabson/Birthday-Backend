import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDb } from './client.js';
import { logger } from '../logger.js';

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
}

// Allow `npm run db:migrate` as a standalone command.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts')) {
  runMigrations()
    .then(async () => {
      logger.info('migrations applied');
      await closeDb();
    })
    .catch(async (err) => {
      logger.error({ err }, 'migration failed');
      await closeDb();
      process.exit(1);
    });
}
