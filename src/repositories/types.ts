import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type * as schema from '../db/schema.js';

type Schema = typeof schema;

/**
 * Accepts either the pool-backed client or a transaction, so every repository
 * function composes inside `db.transaction(...)` without a second signature.
 */
export type Db =
  | NodePgDatabase<Schema>
  | PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/**
 * Escapes LIKE wildcards in user-supplied search text. Without this, a search
 * for "100%" matches everything.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
