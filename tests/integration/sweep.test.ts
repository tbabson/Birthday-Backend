import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The queue is stubbed so these tests assert on database state — which rows the
 * sweep claims and when — without needing a live worker. What BullMQ does with
 * a job id is its own concern; what matters here is that exactly one row is
 * claimed per birthday, with the right occurrence year.
 */
const enqueued: string[] = [];
vi.mock('../../src/queue/queues.js', () => ({
  enqueueSend: vi.fn(async (id: string) => {
    enqueued.push(id);
  }),
  scheduleHourlySweep: vi.fn(async () => {}),
  sendQueue: vi.fn(),
  sweepQueue: vi.fn(),
  closeQueue: vi.fn(async () => {}),
  SEND_QUEUE: 'notifications-send',
  SWEEP_QUEUE: 'notifications-sweep',
}));

const { db } = await import('../../src/db/client.js');
const { closeDb } = await import('../../src/db/client.js');
const { contacts, notifications } = await import('../../src/db/schema.js');
const { catchUpForContact, reconcileMissedSweeps, runSweep } = await import(
  '../../src/services/sweep.js'
);
const { cancelPendingForContact } = await import('../../src/repositories/notifications.js');
const { sendNotification } = await import('../../src/services/sender.js');
const helpers = await import('./helpers.js');
const { allNotifications, createTestContact, createTestUser, recorder, setupDatabase, truncateAll } =
  helpers;

const { and, eq } = await import('drizzle-orm');

/** Africa/Lagos is UTC+1 with no DST, so 09:00 local is always 08:00Z. */
const lagos9am = (iso: string) => new Date(`${iso}T08:00:00Z`);

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  enqueued.length = 0;
});

describe('the sweep', () => {
  it('claims exactly one reminder, the day before the birthday', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    await createTestContact(user.id, {
      name: 'Chidi',
      birthMonth: 3,
      birthDay: 15,
      birthYear: 1996,
    });

    const result = await runSweep(lagos9am('2027-03-14'));

    expect(result.claimed).toBe(1);
    const rows = await allNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceYear).toBe(2027);
    expect(rows[0]!.leadDays).toBe(1);
    expect(rows[0]!.status).toBe('pending');
    expect(enqueued).toHaveLength(1);
  });

  it('does nothing on any other day', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, { name: 'Chidi', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-13'));
    await runSweep(lagos9am('2027-03-15')); // the birthday itself — too late to warn
    await runSweep(lagos9am('2027-06-01'));

    expect(await allNotifications()).toHaveLength(0);
  });

  it('does not fire outside the user’s notify hour', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    await createTestContact(user.id, { name: 'Chidi', birthMonth: 3, birthDay: 15 });

    // 07:00Z is 08:00 in Lagos — an hour early.
    await runSweep(new Date('2027-03-14T07:00:00Z'));
    expect(await allNotifications()).toHaveLength(0);

    await runSweep(new Date('2027-03-14T08:00:00Z'));
    expect(await allNotifications()).toHaveLength(1);
  });

  it('is idempotent: a repeated sweep produces no second row', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, { name: 'Chidi', birthMonth: 3, birthDay: 15 });

    const first = await runSweep(lagos9am('2027-03-14'));
    const second = await runSweep(lagos9am('2027-03-14'));
    const third = await runSweep(lagos9am('2027-03-14'));

    expect(first.claimed).toBe(1);
    expect(second.claimed).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(third.duplicates).toBe(1);
    expect(await allNotifications()).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  it('keys a 1 January birthday to the birthday’s year, not the send year', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, {
      name: 'Ada',
      birthMonth: 1,
      birthDay: 1,
      birthYear: 1990,
    });

    // Sent on 31 December 2026, for a birthday on 1 January 2027.
    await runSweep(lagos9am('2026-12-31'));

    const rows = await allNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceYear).toBe(2027);

    // The following New Year's Eve is a different occurrence and must produce
    // its own row — if the key used the send year, this would be suppressed.
    await runSweep(lagos9am('2027-12-31'));
    const after = await allNotifications();
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.occurrenceYear).sort()).toEqual([2027, 2028]);
  });

  it('reminds a 29 February contact on 27 February in a common year', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, {
      name: 'Leapling',
      birthMonth: 2,
      birthDay: 29,
      birthYear: 1996,
    });

    await runSweep(lagos9am('2027-02-26'));
    expect(await allNotifications()).toHaveLength(0);

    await runSweep(lagos9am('2027-02-27'));
    const rows = await allNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceYear).toBe(2027);
  });

  it('reminds a 29 February contact on 28 February in a leap year', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, { name: 'Leapling', birthMonth: 2, birthDay: 29 });

    await runSweep(lagos9am('2028-02-27'));
    expect(await allNotifications()).toHaveLength(0);

    await runSweep(lagos9am('2028-02-28'));
    expect(await allNotifications()).toHaveLength(1);
  });

  it('does not conflate 28 and 29 February contacts', async () => {
    const user = await createTestUser();
    const feb28 = await createTestContact(user.id, { name: 'Feb28', birthMonth: 2, birthDay: 28 });
    const feb29 = await createTestContact(user.id, { name: 'Feb29', birthMonth: 2, birthDay: 29 });

    // Common year: both are observed on 28 Feb, so both remind on 27 Feb.
    await runSweep(lagos9am('2027-02-27'));
    const rows = await allNotifications();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.contactId).sort()).toEqual([feb28.id, feb29.id].sort());
  });

  it('resolves the notify hour per user, not per server', async () => {
    // 08:00Z is 09:00 in Lagos (UTC+1) and 03:00 in New York (UTC-5).
    const lagosUser = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    const nyUser = await createTestUser({ timezone: 'America/New_York', notifyHour: 9 });
    await createTestContact(lagosUser.id, { name: 'A', birthMonth: 3, birthDay: 15 });
    await createTestContact(nyUser.id, { name: 'B', birthMonth: 3, birthDay: 15 });

    await runSweep(new Date('2027-03-14T08:00:00Z'));
    let rows = await allNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(lagosUser.id);

    // New York's 09:00 on 14 March 2027 is 13:00Z — DST began that morning.
    await runSweep(new Date('2027-03-14T13:00:00Z'));
    rows = await allNotifications();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([lagosUser.id, nyUser.id].sort());
  });

  it('ignores soft-deleted contacts', async () => {
    const user = await createTestUser();
    const contact = await createTestContact(user.id, {
      name: 'Removed',
      birthMonth: 3,
      birthDay: 15,
    });
    await db.update(contacts).set({ deletedAt: new Date() }).where(eq(contacts.id, contact.id));

    await runSweep(lagos9am('2027-03-14'));
    expect(await allNotifications()).toHaveLength(0);
  });

  it('never leaks another user’s contacts into a sweep', async () => {
    const a = await createTestUser({ timezone: 'Africa/Lagos' });
    const b = await createTestUser({ timezone: 'Africa/Lagos' });
    await createTestContact(a.id, { name: 'A-contact', birthMonth: 3, birthDay: 15 });
    await createTestContact(b.id, { name: 'B-contact', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));

    const rows = await allNotifications();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const [contact] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, row.contactId), eq(contacts.userId, row.userId)));
      expect(contact, 'notification points at a contact belonging to its own user').toBeDefined();
    }
  });
});

/**
 * §8: "100% of birthdays in the DB produce exactly one notification, on the
 * correct day-before, over a full simulated test year with a controllable
 * clock." This is that criterion, against a real database.
 */
describe('a full simulated year against the database', () => {
  it('produces exactly one notification per birthday, and no duplicates', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });

    const roster = [
      { name: 'NewYear', birthMonth: 1, birthDay: 1, birthYear: 1990 },
      { name: 'Feb28', birthMonth: 2, birthDay: 28, birthYear: 1985 },
      { name: 'Leapling', birthMonth: 2, birthDay: 29, birthYear: 1996 },
      { name: 'March1', birthMonth: 3, birthDay: 1 },
      { name: 'MidMarch', birthMonth: 3, birthDay: 15, birthYear: 1996 },
      { name: 'July4', birthMonth: 7, birthDay: 4, birthYear: 2001 },
      { name: 'NewYearsEve', birthMonth: 12, birthDay: 31, birthYear: 1978 },
    ];
    const created = new Map<string, string>();
    for (const person of roster) {
      const c = await createTestContact(user.id, person);
      created.set(person.name, c.id);
    }

    // Sweep every day of 2027, plus 31 Dec 2026 so the 1 Jan 2027 reminder is
    // inside the window. Runs the sweep twice per day to prove that an
    // overlapping or retried sweep changes nothing.
    let day = new Date('2026-12-31T08:00:00Z');
    const end = new Date('2027-12-31T08:00:00Z');
    let sweeps = 0;
    while (day <= end) {
      await runSweep(day);
      await runSweep(day); // deliberate double-run
      sweeps += 1;
      day = new Date(day.getTime() + 86_400_000);
    }

    expect(sweeps).toBe(366); // 31 Dec 2026 + all 365 days of 2027

    const rows = await allNotifications();

    // Every contact fired exactly once for occurrence year 2027.
    for (const person of roster) {
      const contactId = created.get(person.name)!;
      const hits = rows.filter((r) => r.contactId === contactId && r.occurrenceYear === 2027);
      expect(hits, `${person.name} in 2027`).toHaveLength(1);
    }

    // No duplicates anywhere: the idempotency key is unique across the set.
    const keys = rows.map((r) => `${r.contactId}:${r.occurrenceYear}:${r.leadDays}:${r.channel}`);
    expect(new Set(keys).size).toBe(keys.length);

    // 'NewYearsEve' also picks up its 2028 occurrence, reminded on 30 Dec 2027.
    const eveId = created.get('NewYearsEve')!;
    expect(rows.filter((r) => r.contactId === eveId)).toHaveLength(1);
  });
});

describe('contact added after the sweep has run (§6.4)', () => {
  it('enqueues immediately rather than waiting for tomorrow', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });

    // 15:00 Lagos on 14 March; the 09:00 sweep is long gone.
    const now = new Date('2027-03-14T14:00:00Z');
    const contact = await createTestContact(user.id, {
      name: 'LateAddition',
      birthMonth: 3,
      birthDay: 15,
      birthYear: 1996,
    });

    const acted = await catchUpForContact(user, contact, now);

    expect(acted).toBe(true);
    const rows = await allNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceYear).toBe(2027);
    expect(rows[0]!.leadDays).toBe(1);
  });

  it('leaves it to the sweep when the notify hour has not yet passed', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    // 06:00 Lagos — today's sweep is still to come.
    const now = new Date('2027-03-14T05:00:00Z');
    const contact = await createTestContact(user.id, {
      name: 'EarlyAddition',
      birthMonth: 3,
      birthDay: 15,
    });

    expect(await catchUpForContact(user, contact, now)).toBe(false);
    expect(await allNotifications()).toHaveLength(0);
  });

  it('uses lead_days 0 for a contact whose birthday is today', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    const now = new Date('2027-03-15T14:00:00Z'); // the birthday itself
    const contact = await createTestContact(user.id, {
      name: 'SameDay',
      birthMonth: 3,
      birthDay: 15,
    });

    expect(await catchUpForContact(user, contact, now)).toBe(true);
    const rows = await allNotifications();
    expect(rows).toHaveLength(1);
    // A distinct idempotency key from the T-1 row, so the two never collide.
    expect(rows[0]!.leadDays).toBe(0);
  });

  it('does nothing for a birthday further out', async () => {
    const user = await createTestUser();
    const now = new Date('2027-03-01T14:00:00Z');
    const contact = await createTestContact(user.id, {
      name: 'FarOff',
      birthMonth: 3,
      birthDay: 15,
    });

    expect(await catchUpForContact(user, contact, now)).toBe(false);
    expect(await allNotifications()).toHaveLength(0);
  });

  it('does not double-send when the sweep later runs for the same day', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    const contact = await createTestContact(user.id, {
      name: 'Both',
      birthMonth: 3,
      birthDay: 15,
    });

    await catchUpForContact(user, contact, new Date('2027-03-14T14:00:00Z'));
    await runSweep(lagos9am('2027-03-14'));

    expect(await allNotifications()).toHaveLength(1);
  });
});

describe('deleting a contact cancels pending reminders (§6.4)', () => {
  it('marks them skipped', async () => {
    const user = await createTestUser();
    const contact = await createTestContact(user.id, {
      name: 'Doomed',
      birthMonth: 3,
      birthDay: 15,
    });

    await runSweep(lagos9am('2027-03-14'));
    expect((await allNotifications())[0]!.status).toBe('pending');

    const cancelled = await cancelPendingForContact(db, user.id, contact.id);

    expect(cancelled).toBe(1);
    const rows = await allNotifications();
    expect(rows[0]!.status).toBe('skipped');
    expect(rows[0]!.error).toBe('contact deleted');
  });
});

describe('boot reconcile after downtime (§6.4)', () => {
  it('claims today’s missed reminder once the process comes back', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    await createTestContact(user.id, { name: 'Missed', birthMonth: 3, birthDay: 15 });

    // The 09:00 sweep never ran; the process comes up at 11:00 Lagos.
    const result = await reconcileMissedSweeps(new Date('2027-03-14T10:00:00Z'));

    expect(result.claimed).toBe(1);
    expect(await allNotifications()).toHaveLength(1);
  });

  it('is a no-op when the sweep already ran', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    await createTestContact(user.id, { name: 'Fine', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));
    const result = await reconcileMissedSweeps(new Date('2027-03-14T10:00:00Z'));

    expect(result.claimed).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(await allNotifications()).toHaveLength(1);
  });

  it('does not resurrect yesterday’s reminder for a birthday that is today', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    await createTestContact(user.id, { name: 'Today', birthMonth: 3, birthDay: 15 });

    // Down all of the 14th; back up on the 15th, the birthday itself.
    // "X's birthday is tomorrow" sent today would be wrong, not merely late.
    const result = await reconcileMissedSweeps(new Date('2027-03-15T10:00:00Z'));

    expect(result.claimed).toBe(0);
    expect(await allNotifications()).toHaveLength(0);
  });
});

describe('sending', () => {
  it('sends one email with the whole message in the subject (§5.3)', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', email: 'owner@example.test' });
    await createTestContact(user.id, {
      name: 'Chidi',
      birthMonth: 3,
      birthDay: 15,
      birthYear: 1996,
      notes: 'Loves jollof. Owes me a call.',
    });

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();

    const outcome = await sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'));

    expect(outcome.outcome).toBe('sent');
    expect(recorder.sent).toHaveLength(1);
    expect(recorder.sent[0]!.to).toBe('owner@example.test');
    expect(recorder.sent[0]!.subject).toBe("Tomorrow: Chidi's birthday (turning 31)");
    expect(recorder.sent[0]!.text).toContain('Loves jollof');

    const [after] = await allNotifications();
    expect(after!.status).toBe('sent');
    expect(after!.sentAt).not.toBeNull();
  });

  it('omits the age when the birth year is unknown', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, { name: 'Ngozi', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();
    await sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'));

    expect(recorder.sent[0]!.subject).toBe("Tomorrow: Ngozi's birthday");
  });

  it('refuses to send twice for the same row', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, { name: 'Chidi', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();

    await sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'));
    const second = await sendNotification(row!.id, new Date('2027-03-14T08:00:10Z'));

    expect(second).toEqual({ outcome: 'skipped', reason: 'already sent' });
    expect(recorder.sent).toHaveLength(1);
  });

  it('skips a reminder for a contact deleted after it was queued', async () => {
    const user = await createTestUser();
    const contact = await createTestContact(user.id, {
      name: 'Removed',
      birthMonth: 3,
      birthDay: 15,
    });

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();
    await db.update(contacts).set({ deletedAt: new Date() }).where(eq(contacts.id, contact.id));

    const outcome = await sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'));

    expect(outcome).toEqual({ outcome: 'skipped', reason: 'contact deleted' });
    expect(recorder.sent).toHaveLength(0);
    expect((await allNotifications())[0]!.status).toBe('skipped');
  });

  it('skips a reminder that has fallen outside the grace window', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, { name: 'Stale', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();

    // Three days late — worse than none.
    const outcome = await sendNotification(row!.id, new Date('2027-03-17T08:00:00Z'));

    expect(outcome.outcome).toBe('skipped');
    expect(recorder.sent).toHaveLength(0);
    const [after] = await allNotifications();
    expect(after!.status).toBe('skipped');
    expect(after!.error).toMatch(/grace window/);
  });

  it('propagates provider failures so the queue can retry', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, { name: 'Flaky', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();
    recorder.failuresRemaining = 1;

    await expect(sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'))).rejects.toThrow(
      /simulated SMTP failure/,
    );

    // Still pending, so a retry can pick it up.
    expect((await allNotifications())[0]!.status).toBe('pending');

    const retry = await sendNotification(row!.id, new Date('2027-03-14T08:01:00Z'));
    expect(retry.outcome).toBe('sent');
    expect(recorder.sent).toHaveLength(1);
  });

  it('says "Today" for a same-day catch-up reminder', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    const contact = await createTestContact(user.id, {
      name: 'Chidi',
      birthMonth: 3,
      birthDay: 15,
      birthYear: 1996,
    });

    const now = new Date('2027-03-15T14:00:00Z');
    await catchUpForContact(user, contact, now);
    const [row] = await allNotifications();
    await sendNotification(row!.id, now);

    expect(recorder.sent[0]!.subject).toBe("Today: Chidi's birthday (turning 31)");
  });
});

describe('the unique index is the real guarantee', () => {
  it('rejects a duplicate insert at the database level', async () => {
    const user = await createTestUser();
    const contact = await createTestContact(user.id, {
      name: 'Chidi',
      birthMonth: 3,
      birthDay: 15,
    });

    const values = {
      userId: user.id,
      contactId: contact.id,
      occurrenceYear: 2027,
      leadDays: 1,
      channel: 'email' as const,
      scheduledFor: new Date(),
    };

    await db.insert(notifications).values(values);
    // No ON CONFLICT here: this must actually throw.
    await expect(db.insert(notifications).values(values)).rejects.toThrow();
  });
});
