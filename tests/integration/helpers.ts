import { sql } from 'drizzle-orm';
import { env } from '../../src/config/env.js';
import { db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { contacts, notifications, users, type Contact, type User } from '../../src/db/schema.js';
import { setEmailProvider, type EmailMessage, type EmailProvider } from '../../src/email/provider.js';

/** Records every send so tests can assert on subject lines and recipients. */
export class RecordingEmailProvider implements EmailProvider {
  readonly name = 'recording';
  readonly sent: EmailMessage[] = [];
  /** Set to fail the next N sends, to exercise the retry path. */
  failuresRemaining = 0;
  /**
   * Fail every send after this many have succeeded. Used to break a copy to an
   * extra recipient *after* the owner's message has already gone out.
   */
  failAfter: number | null = null;

  async send(message: EmailMessage): Promise<{ messageId: string | null }> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('simulated SMTP failure');
    }
    if (this.failAfter !== null && this.sent.length >= this.failAfter) {
      throw new Error('simulated SMTP failure');
    }
    this.sent.push(message);
    return { messageId: `rec-${this.sent.length}` };
  }

  reset(): void {
    this.sent.length = 0;
    this.failuresRemaining = 0;
    this.failAfter = null;
  }
}

export const recorder = new RecordingEmailProvider();

/**
 * Refuses to touch anything that is not obviously a test database.
 *
 * `truncateAll` deletes every user and everything cascading from them. Pointed
 * at a development database it destroys real work, and the failure is silent —
 * the suite passes either way. A name check is crude, but it turns a
 * catastrophic misconfiguration into a loud one.
 */
function assertTestDatabase(): void {
  const name = new URL(env.DATABASE_URL).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against database "${name}".\n` +
        'These tests TRUNCATE every table, which would delete real data.\n' +
        'DATABASE_URL must name a database ending in "_test" — see the env ' +
        'block in vitest.config.ts.',
    );
  }
}

export async function setupDatabase(): Promise<void> {
  assertTestDatabase();
  await runMigrations();
  setEmailProvider(recorder);
}

export async function truncateAll(): Promise<void> {
  assertTestDatabase();
  // notifications and contacts cascade from users.
  await db.execute(sql`TRUNCATE TABLE ${users} RESTART IDENTITY CASCADE`);
  recorder.reset();
}

let emailCounter = 0;

export async function createTestUser(
  overrides: Partial<Pick<User, 'timezone' | 'notifyHour' | 'leadDays' | 'email'>> = {},
): Promise<User> {
  emailCounter += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `owner-${emailCounter}@example.test`,
      timezone: overrides.timezone ?? 'Africa/Lagos',
      notifyHour: overrides.notifyHour ?? 9,
      leadDays: overrides.leadDays ?? 1,
    })
    .returning();
  return row!;
}

export async function createTestContact(
  userId: string,
  values: {
    name: string;
    birthMonth: number;
    birthDay: number;
    birthYear?: number | null;
    tag?: string | null;
    notes?: string | null;
  },
): Promise<Contact> {
  const [row] = await db
    .insert(contacts)
    .values({ userId, ...values })
    .returning();
  return row!;
}

export async function allNotifications() {
  return db.select().from(notifications);
}
