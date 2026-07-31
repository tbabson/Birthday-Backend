import pg from 'pg';

/**
 * Creates the dedicated test database before any suite runs.
 *
 * The integration tests truncate `users` between cases, so they must never
 * point at the database being used for real work — running the suite would
 * silently delete the developer's own account and contacts. `vitest.config.ts`
 * overrides DATABASE_URL to name this database; this makes sure it exists.
 */
export default async function globalSetup(): Promise<void> {
  const url = new URL(
    process.env.DATABASE_URL ?? 'postgres://birthday:birthday@localhost:5433/birthday_test',
  );
  const dbName = url.pathname.slice(1);

  // Connect to the maintenance database — you cannot CREATE DATABASE from
  // inside the database you are creating.
  const admin = new URL(url.toString());
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount === 0) {
      // Identifier cannot be parameterised; dbName comes from our own config.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[tests] created database ${dbName}`);
    }
  } finally {
    await client.end();
  }
}
