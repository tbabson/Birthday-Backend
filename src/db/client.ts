import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

// Postgres returns DATE/TIMESTAMP as strings by default under node-postgres in
// some configurations; force numeric parsing of int8 so counts come back as
// numbers rather than strings.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
