import { and, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { contacts, type Contact } from '../db/schema.js';
import { escapeLike, type Db } from './types.js';

/**
 * Every function here takes `userId` as a required argument and folds it into
 * the WHERE clause itself (§6.5). Callers cannot reach another tenant's rows
 * through this module even by mistake — there is no signature that omits the
 * scope, so a forgotten `WHERE user_id = ?` is a type error rather than a data
 * leak. Nothing outside this module should query the `contacts` table.
 */

export interface ContactInput {
  name: string;
  birthMonth: number;
  birthDay: number;
  birthYear?: number | null;
  tag?: string | null;
  notes?: string | null;
  photoUrl?: string | null;
}

export interface ListFilters {
  tag?: string | undefined;
  q?: string | undefined;
  includeDeleted?: boolean | undefined;
}

/** Guards against an unbounded scan; a personal register never approaches it. */
const MAX_CONTACTS_PER_QUERY = 5000;

function scope(userId: string, includeDeleted = false) {
  const clauses = [eq(contacts.userId, userId)];
  if (!includeDeleted) clauses.push(isNull(contacts.deletedAt));
  return and(...clauses);
}

export async function listContacts(
  db: Db,
  userId: string,
  filters: ListFilters = {},
): Promise<Contact[]> {
  const clauses = [scope(userId, filters.includeDeleted)];
  if (filters.tag) clauses.push(eq(contacts.tag, filters.tag));
  if (filters.q) clauses.push(ilike(contacts.name, `%${escapeLike(filters.q)}%`));

  return db
    .select()
    .from(contacts)
    .where(and(...clauses))
    .limit(MAX_CONTACTS_PER_QUERY);
}

export async function getContact(
  db: Db,
  userId: string,
  id: string,
): Promise<Contact | undefined> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), scope(userId, true)))
    .limit(1);
  return row;
}

export async function createContact(
  db: Db,
  userId: string,
  input: ContactInput,
): Promise<Contact> {
  const [row] = await db
    .insert(contacts)
    .values({ ...input, userId })
    .returning();
  return row!;
}

export async function updateContact(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<ContactInput>,
): Promise<Contact | undefined> {
  if (Object.keys(patch).length === 0) return getContact(db, userId, id);
  const [row] = await db
    .update(contacts)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(contacts.id, id), scope(userId)))
    .returning();
  return row;
}

/** Soft delete. Cancelling the contact's pending notifications is the caller's job. */
export async function softDeleteContact(
  db: Db,
  userId: string,
  id: string,
): Promise<Contact | undefined> {
  const [row] = await db
    .update(contacts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(contacts.id, id), scope(userId)))
    .returning();
  return row;
}

export async function restoreContact(
  db: Db,
  userId: string,
  id: string,
): Promise<Contact | undefined> {
  const [row] = await db
    .update(contacts)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(contacts.id, id), eq(contacts.userId, userId), isNotNull(contacts.deletedAt)))
    .returning();
  return row;
}

/**
 * The sweep's lookup: contacts whose stored (month, day) is one of `pairs`.
 * Hits the `contacts_month_day_idx` partial index (§6.3).
 *
 * `pairs` comes from `birthDatesObservedOn`, which is why 28 February in a
 * common year arrives here as two pairs rather than one.
 */
export async function findContactsByBirthDates(
  db: Db,
  userId: string,
  pairs: ReadonlyArray<{ month: number; day: number }>,
): Promise<Contact[]> {
  if (pairs.length === 0) return [];
  const matches = pairs.map(
    (p) => and(eq(contacts.birthMonth, p.month), eq(contacts.birthDay, p.day))!,
  );
  return db
    .select()
    .from(contacts)
    .where(and(scope(userId), or(...matches)))
    .limit(MAX_CONTACTS_PER_QUERY);
}

export interface BulkCreateResult {
  created: Contact[];
  /** Rows that matched an existing contact and were left alone. */
  skipped: number;
}

/**
 * Bulk insert for CSV import.
 *
 * Skips rows that match an existing active contact on name (case-insensitive)
 * plus month and day. Re-importing the same export is a normal thing to do by
 * accident, and silently doubling someone's register is the worst possible
 * response to it. Deliberately not an upsert: overwriting notes the user typed
 * by hand with a blank column from a spreadsheet is equally destructive.
 */
export async function bulkCreateContacts(
  db: Db,
  userId: string,
  inputs: ContactInput[],
): Promise<BulkCreateResult> {
  if (inputs.length === 0) return { created: [], skipped: 0 };

  const existing = await db
    .select({ name: contacts.name, month: contacts.birthMonth, day: contacts.birthDay })
    .from(contacts)
    .where(scope(userId));

  const seen = new Set(
    existing.map((c) => `${c.name.trim().toLowerCase()}|${c.month}|${c.day}`),
  );

  const fresh: ContactInput[] = [];
  let skipped = 0;

  for (const input of inputs) {
    const key = `${input.name.trim().toLowerCase()}|${input.birthMonth}|${input.birthDay}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    // Guards against duplicates inside the file itself, not just against the DB.
    seen.add(key);
    fresh.push(input);
  }

  if (fresh.length === 0) return { created: [], skipped };

  const created = await db
    .insert(contacts)
    .values(fresh.map((input) => ({ ...input, userId })))
    .returning();

  return { created, skipped };
}

export async function countContacts(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(scope(userId));
  return row?.count ?? 0;
}

export async function listTags(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tag: contacts.tag })
    .from(contacts)
    .where(and(scope(userId), isNotNull(contacts.tag)));
  return rows.map((r) => r.tag).filter((t): t is string => t !== null).sort();
}
