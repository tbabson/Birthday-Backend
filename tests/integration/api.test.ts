import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

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

const { closeDb, db } = await import('../../src/db/client.js');
const { createApp } = await import('../../src/http/app.js');
const { notifications, users } = await import('../../src/db/schema.js');
const { eq } = await import('drizzle-orm');
const { recorder, setupDatabase, truncateAll } = await import('./helpers.js');

const app = createApp();

/**
 * Signs in the way a real user does: request a link, read it out of the
 * delivered email, follow it. Nothing here reaches into the session table, so
 * the whole magic-link flow is under test rather than stubbed around.
 */
async function signIn(email: string, timezone = 'Africa/Lagos'): Promise<string> {
  const before = recorder.sent.length;

  await request(app).post('/auth/magic-link').send({ email, timezone }).expect(202);

  const mail = recorder.sent[before];
  if (!mail) throw new Error('no sign-in email was delivered');

  const url = /https?:\/\/\S+/.exec(mail.text)?.[0];
  if (!url) throw new Error(`no link in sign-in email: ${mail.text}`);
  const token = new URL(url).searchParams.get('token')!;

  const verify = await request(app).get(`/auth/verify?token=${encodeURIComponent(token)}`);
  expect(verify.status).toBe(302);

  const cookie = verify.headers['set-cookie']?.[0];
  if (!cookie) throw new Error('no session cookie was set');
  return cookie.split(';')[0]!;
}

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

describe('auth', () => {
  it('signs a new user in from a magic link', async () => {
    const cookie = await signIn('owner@example.test');

    const me = await request(app).get('/me').set('Cookie', cookie).expect(200);
    expect(me.body.user.email).toBe('owner@example.test');
    expect(me.body.user.timezone).toBe('Africa/Lagos');
    expect(me.body.user.notifyHour).toBe(9);
    expect(me.body.user.leadDays).toBe(1);
  });

  it('gives the same answer for unknown addresses, so it cannot enumerate accounts', async () => {
    const a = await request(app)
      .post('/auth/magic-link')
      .send({ email: 'nobody@example.test' })
      .expect(202);
    const b = await request(app)
      .post('/auth/magic-link')
      .send({ email: 'nobody@example.test' })
      .expect(202);
    expect(a.body).toEqual(b.body);
  });

  it('burns the magic link after one use', async () => {
    await request(app)
      .post('/auth/magic-link')
      .send({ email: 'once@example.test' })
      .expect(202);

    const url = /https?:\/\/\S+/.exec(recorder.sent[0]!.text)![0];
    const token = new URL(url).searchParams.get('token')!;

    const first = await request(app).get(`/auth/verify?token=${encodeURIComponent(token)}`);
    expect(first.headers.location).not.toMatch(/error/);

    const second = await request(app).get(`/auth/verify?token=${encodeURIComponent(token)}`);
    expect(second.headers.location).toMatch(/error=invalid_link/);
  });

  it('rejects a forged token', async () => {
    const res = await request(app).get('/auth/verify?token=not-a-real-token');
    expect(res.headers.location).toMatch(/error=invalid_link/);
  });

  it('refuses protected routes without a session', async () => {
    await request(app).get('/me').expect(401);
    await request(app).get('/contacts').expect(401);
    await request(app).post('/contacts').send({ name: 'X', birthMonth: 1, birthDay: 1 }).expect(401);
  });

  it('logs out', async () => {
    const cookie = await signIn('bye@example.test');
    await request(app).post('/auth/logout').set('Cookie', cookie).expect(200);
    await request(app).get('/me').set('Cookie', cookie).expect(401);
  });
});

describe('contacts', () => {
  it('creates and returns a contact with its computed fields', async () => {
    const cookie = await signIn('owner@example.test');

    const created = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({
        name: 'Chidi',
        birthMonth: 3,
        birthDay: 15,
        birthYear: 1996,
        tag: 'friends',
        notes: 'Loves jollof',
      })
      .expect(201);

    expect(created.body.contact).toMatchObject({
      name: 'Chidi',
      birthMonth: 3,
      birthDay: 15,
      birthYear: 1996,
      tag: 'friends',
    });
    expect(created.body.contact.nextBirthday).toMatch(/^\d{4}-03-15$/);
    expect(typeof created.body.contact.daysAway).toBe('number');
    expect(created.body.contact.turningAge).toBeGreaterThan(0);
  });

  it('sorts the list by next birthday ascending', async () => {
    const cookie = await signIn('owner@example.test');
    const add = (name: string, birthMonth: number, birthDay: number) =>
      request(app).post('/contacts').set('Cookie', cookie).send({ name, birthMonth, birthDay });

    await add('Jan', 1, 2);
    await add('Jun', 6, 15);
    await add('Dec', 12, 25);

    const list = await request(app).get('/contacts').set('Cookie', cookie).expect(200);
    const days = list.body.contacts.map((c: { daysAway: number }) => c.daysAway);
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });

  it('filters by tag and searches by name', async () => {
    const cookie = await signIn('owner@example.test');
    const add = (name: string, tag: string) =>
      request(app)
        .post('/contacts')
        .set('Cookie', cookie)
        .send({ name, birthMonth: 5, birthDay: 5, tag });

    await add('Amaka', 'family');
    await add('Bola', 'work');

    const family = await request(app).get('/contacts?tag=family').set('Cookie', cookie).expect(200);
    expect(family.body.contacts.map((c: { name: string }) => c.name)).toEqual(['Amaka']);

    const search = await request(app).get('/contacts?q=bol').set('Cookie', cookie).expect(200);
    expect(search.body.contacts.map((c: { name: string }) => c.name)).toEqual(['Bola']);

    const tags = await request(app).get('/contacts/tags').set('Cookie', cookie).expect(200);
    expect(tags.body.tags).toEqual(['family', 'work']);
  });

  it('omits the age when the birth year is unknown', async () => {
    const cookie = await signIn('owner@example.test');
    const res = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Ngozi', birthMonth: 8, birthDay: 9 })
      .expect(201);

    expect(res.body.contact.birthYear).toBeNull();
    expect(res.body.contact.turningAge).toBeNull();
    expect(res.body.contact.age).toBeNull();
  });

  it('accepts 29 February', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Leapling', birthMonth: 2, birthDay: 29 })
      .expect(201);
  });

  it('rejects dates that do not exist', async () => {
    const cookie = await signIn('owner@example.test');
    for (const [birthMonth, birthDay] of [
      [2, 30],
      [4, 31],
      [13, 1],
      [1, 32],
    ]) {
      await request(app)
        .post('/contacts')
        .set('Cookie', cookie)
        .send({ name: 'Bad', birthMonth, birthDay })
        .expect(400);
    }
  });

  it('will not let a two-step patch walk a contact into an impossible date', async () => {
    const cookie = await signIn('owner@example.test');
    const created = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Edge', birthMonth: 1, birthDay: 31 })
      .expect(201);

    // Moving only the month would leave 31 February.
    await request(app)
      .patch(`/contacts/${created.body.contact.id}`)
      .set('Cookie', cookie)
      .send({ birthMonth: 2 })
      .expect(400);
  });

  it('soft-deletes and restores', async () => {
    const cookie = await signIn('owner@example.test');
    const created = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Temp', birthMonth: 6, birthDay: 1 })
      .expect(201);
    const id = created.body.contact.id;

    await request(app).delete(`/contacts/${id}`).set('Cookie', cookie).expect(200);

    const afterDelete = await request(app).get('/contacts').set('Cookie', cookie).expect(200);
    expect(afterDelete.body.contacts).toHaveLength(0);

    await request(app).post(`/contacts/${id}/restore`).set('Cookie', cookie).expect(200);

    const afterRestore = await request(app).get('/contacts').set('Cookie', cookie).expect(200);
    expect(afterRestore.body.contacts).toHaveLength(1);
  });

  it('404s on a contact id that is not yours', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');

    const created = await request(app)
      .post('/contacts')
      .set('Cookie', alice)
      .send({ name: 'Alice-only', birthMonth: 4, birthDay: 4 })
      .expect(201);
    const id = created.body.contact.id;

    await request(app).get(`/contacts/${id}`).set('Cookie', bob).expect(404);
    await request(app).patch(`/contacts/${id}`).set('Cookie', bob).send({ name: 'hax' }).expect(404);
    await request(app).delete(`/contacts/${id}`).set('Cookie', bob).expect(404);

    // And Alice's copy is untouched.
    const still = await request(app).get(`/contacts/${id}`).set('Cookie', alice).expect(200);
    expect(still.body.contact.name).toBe('Alice-only');
  });

  it('keeps each user’s list to their own contacts', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');

    await request(app)
      .post('/contacts')
      .set('Cookie', alice)
      .send({ name: 'A', birthMonth: 4, birthDay: 4 });
    await request(app)
      .post('/contacts')
      .set('Cookie', bob)
      .send({ name: 'B', birthMonth: 4, birthDay: 4 });

    const aList = await request(app).get('/contacts').set('Cookie', alice).expect(200);
    const bList = await request(app).get('/contacts').set('Cookie', bob).expect(200);

    expect(aList.body.contacts.map((c: { name: string }) => c.name)).toEqual(['A']);
    expect(bList.body.contacts.map((c: { name: string }) => c.name)).toEqual(['B']);
  });
});

describe('settings', () => {
  it('updates time zone and delivery hour', async () => {
    const cookie = await signIn('owner@example.test');

    const res = await request(app)
      .patch('/me')
      .set('Cookie', cookie)
      .send({ timezone: 'America/New_York', notifyHour: 7 })
      .expect(200);

    expect(res.body.user.timezone).toBe('America/New_York');
    expect(res.body.user.notifyHour).toBe(7);
  });

  it('rejects a bogus time zone and an out-of-range hour', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app).patch('/me').set('Cookie', cookie).send({ timezone: 'Mars/Base' }).expect(400);
    await request(app).patch('/me').set('Cookie', cookie).send({ notifyHour: 25 }).expect(400);
  });
});

describe('upcoming and dashboard', () => {
  it('returns only birthdays inside the window', async () => {
    const cookie = await signIn('owner@example.test');
    const me = await request(app).get('/me').set('Cookie', cookie);

    // Place one birthday two days out and one half a year out, relative to the
    // user's own zone rather than the test runner's.
    const today = new Date(
      new Date().toLocaleString('en-US', { timeZone: me.body.user.timezone }),
    );
    const soon = new Date(today.getTime() + 2 * 86_400_000);
    const later = new Date(today.getTime() + 180 * 86_400_000);

    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Soon', birthMonth: soon.getMonth() + 1, birthDay: soon.getDate() });
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Later', birthMonth: later.getMonth() + 1, birthDay: later.getDate() });

    const upcoming = await request(app).get('/upcoming?window=7').set('Cookie', cookie).expect(200);
    expect(upcoming.body.contacts.map((c: { name: string }) => c.name)).toEqual(['Soon']);

    const dash = await request(app).get('/dashboard').set('Cookie', cookie).expect(200);
    expect(dash.body.totalContacts).toBe(2);
    expect(dash.body.thisWeek.map((c: { name: string }) => c.name)).toEqual(['Soon']);
    expect(dash.body.next.name).toBe('Soon');
  });
});

describe('notifications', () => {
  it('sends a test email without occupying an idempotency key', async () => {
    const cookie = await signIn('owner@example.test');
    const before = recorder.sent.length;

    await request(app).post('/notifications/test').set('Cookie', cookie).expect(200);

    expect(recorder.sent.length).toBe(before + 1);
    expect(recorder.sent.at(-1)!.subject).toContain("Chidi's birthday");

    // No row written — a test send must never suppress a real reminder.
    const log = await request(app).get('/notifications').set('Cookie', cookie).expect(200);
    expect(log.body.notifications).toHaveLength(0);
  });

  it('rejects an unsigned unsubscribe link', async () => {
    await request(app).get('/notifications/unsubscribe?u=someone&s=wrong').expect(400);
  });

  /**
   * The delivery log's status filters. Seeded directly rather than driven
   * through the sweep, because the point here is the filtering, not how a row
   * came to have a given status.
   */
  /**
   * The forecast, not the log. A reminder due tomorrow has no `notifications`
   * row yet — the sweep does not claim one until the morning it is due — so
   * this is derived from contacts the same way the sweep will.
   */
  describe('scheduled reminders', () => {
    /** A birthday `days` away in the signed-in user's own zone. */
    function birthdayIn(days: number, timezone: string) {
      const local = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
      const target = new Date(local.getTime() + days * 86_400_000);
      return { birthMonth: target.getMonth() + 1, birthDay: target.getDate() };
    }

    it('lists a reminder that has not been claimed yet', async () => {
      const cookie = await signIn('owner@example.test');
      const me = await request(app).get('/me').set('Cookie', cookie);
      const tz = me.body.user.timezone;

      // Birthday in two days, so the T-1 reminder goes out tomorrow.
      await request(app)
        .post('/contacts')
        .set('Cookie', cookie)
        .send({ name: 'Chidi', ...birthdayIn(2, tz) })
        .expect(201);

      const res = await request(app)
        .get('/notifications/scheduled')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.scheduled).toHaveLength(1);
      expect(res.body.scheduled[0]).toMatchObject({
        contactName: 'Chidi',
        daysUntilReminder: 1,
        claimedStatus: null,
      });
      // The exact instant the sweep will send it.
      expect(res.body.scheduled[0].remindAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // And the delivery log is still legitimately empty.
      const log = await request(app).get('/notifications').set('Cookie', cookie).expect(200);
      expect(log.body.notifications).toHaveLength(0);
    });

    it('honours the window', async () => {
      const cookie = await signIn('owner@example.test');
      const me = await request(app).get('/me').set('Cookie', cookie);
      const tz = me.body.user.timezone;

      await request(app)
        .post('/contacts')
        .set('Cookie', cookie)
        .send({ name: 'Soon', ...birthdayIn(3, tz) });
      await request(app)
        .post('/contacts')
        .set('Cookie', cookie)
        .send({ name: 'Later', ...birthdayIn(90, tz) });

      const res = await request(app)
        .get('/notifications/scheduled?window=7')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.scheduled.map((s: { contactName: string }) => s.contactName)).toEqual([
        'Soon',
      ]);
    });

    it('drops a reminder once it has actually been sent', async () => {
      const cookie = await signIn('owner@example.test');
      const me = await request(app).get('/me').set('Cookie', cookie);

      const created = await request(app)
        .post('/contacts')
        .set('Cookie', cookie)
        .send({ name: 'Chidi', ...birthdayIn(2, me.body.user.timezone) })
        .expect(201);

      const before = await request(app)
        .get('/notifications/scheduled')
        .set('Cookie', cookie)
        .expect(200);
      expect(before.body.scheduled).toHaveLength(1);

      // Simulate the sweep having claimed and delivered it.
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, 'owner@example.test'));
      await db.insert(notifications).values({
        userId: rows[0]!.id,
        contactId: created.body.contact.id,
        occurrenceYear: Number(before.body.scheduled[0].occurrenceYear),
        leadDays: 1,
        channel: 'email',
        status: 'sent',
        scheduledFor: new Date(),
        sentAt: new Date(),
      });

      const after = await request(app)
        .get('/notifications/scheduled')
        .set('Cookie', cookie)
        .expect(200);

      // It belongs in the log now, not the forecast.
      expect(after.body.scheduled).toHaveLength(0);
    });

    it('is empty when there are no contacts', async () => {
      const cookie = await signIn('owner@example.test');
      const res = await request(app)
        .get('/notifications/scheduled')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.scheduled).toEqual([]);
    });

    it('never leaks another user’s schedule', async () => {
      const alice = await signIn('owner@example.test');
      const me = await request(app).get('/me').set('Cookie', alice);
      await request(app)
        .post('/contacts')
        .set('Cookie', alice)
        .send({ name: 'AliceOnly', ...birthdayIn(2, me.body.user.timezone) });

      const bob = await signIn('bob@example.test');
      const res = await request(app)
        .get('/notifications/scheduled')
        .set('Cookie', bob)
        .expect(200);
      expect(res.body.scheduled).toEqual([]);
    });
  });

  describe('status filters', () => {
    async function seedOnePerStatus(cookie: string) {
      const created = await request(app)
        .post('/contacts')
        .set('Cookie', cookie)
        .send({ name: 'Chidi', birthMonth: 3, birthDay: 15 })
        .expect(201);
      const contactId = created.body.contact.id;

      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, 'owner@example.test'));
      const userId = rows[0]!.id;

      const statuses = ['pending', 'sent', 'failed', 'skipped'] as const;
      await db.insert(notifications).values(
        statuses.map((status, i) => ({
          userId,
          contactId,
          // occurrence_year varies so each row gets its own idempotency key.
          occurrenceYear: 2030 + i,
          leadDays: 1,
          channel: 'email' as const,
          status,
          scheduledFor: new Date(`2030-03-1${i + 1}T08:00:00Z`),
        })),
      );
      return contactId;
    }

    it('returns every row when no status is given', async () => {
      const cookie = await signIn('owner@example.test');
      await seedOnePerStatus(cookie);

      const res = await request(app).get('/notifications').set('Cookie', cookie).expect(200);
      expect(res.body.notifications).toHaveLength(4);
    });

    it.each(['pending', 'sent', 'failed', 'skipped'] as const)(
      'returns only %s rows when filtered',
      async (status) => {
        const cookie = await signIn('owner@example.test');
        await seedOnePerStatus(cookie);

        const res = await request(app)
          .get(`/notifications?status=${status}`)
          .set('Cookie', cookie)
          .expect(200);

        expect(res.body.notifications).toHaveLength(1);
        expect(res.body.notifications[0].status).toBe(status);
        expect(res.body.notifications[0].contactName).toBe('Chidi');
      },
    );

    it('rejects a status that is not one of the four', async () => {
      const cookie = await signIn('owner@example.test');
      await request(app)
        .get('/notifications?status=exploded')
        .set('Cookie', cookie)
        .expect(400);
    });

    it('never shows another user’s delivery log', async () => {
      const alice = await signIn('owner@example.test');
      await seedOnePerStatus(alice);
      const bob = await signIn('bob@example.test');

      const res = await request(app)
        .get('/notifications?status=sent')
        .set('Cookie', bob)
        .expect(200);
      expect(res.body.notifications).toHaveLength(0);
    });
  });
});

describe('general', () => {
  it('answers /health without a session', async () => {
    await request(app).get('/health').expect(200, { ok: true, status: 'up' });
  });

  it('404s unknown routes as JSON', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('rejects a malformed uuid in the path', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app).get('/contacts/not-a-uuid').set('Cookie', cookie).expect(400);
  });
});
