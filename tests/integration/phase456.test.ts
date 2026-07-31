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

const { db, closeDb } = await import('../../src/db/client.js');
const { createApp } = await import('../../src/http/app.js');
const { pushSubscriptions } = await import('../../src/db/schema.js');
const { setPushProvider } = await import('../../src/push/provider.js');
const { runSweep } = await import('../../src/services/sweep.js');
const { sendNotification } = await import('../../src/services/sender.js');
const {
  allNotifications,
  createTestContact,
  createTestUser,
  recorder,
  setupDatabase,
  truncateAll,
} = await import('./helpers.js');

const app = createApp();

async function signIn(email: string, timezone = 'Africa/Lagos'): Promise<string> {
  const before = recorder.sent.length;
  await request(app).post('/auth/magic-link').send({ email, timezone }).expect(202);

  const url = /https?:\/\/\S+/.exec(recorder.sent[before]!.text)![0];
  const token = new URL(url).searchParams.get('token')!;

  const verify = await request(app).get(`/auth/verify?token=${encodeURIComponent(token)}`);
  return verify.headers['set-cookie']![0]!.split(';')[0]!;
}

const csv = (text: string) => Buffer.from(text, 'utf8');
const lagos9am = (iso: string) => new Date(`${iso}T08:00:00Z`);

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  setPushProvider(undefined);
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  enqueued.length = 0;
  setPushProvider(undefined);
});

// ---------------------------------------------------------------- phase 6 --

describe('CSV import', () => {
  const sample =
    'Full Name,Date of Birth,Group,Notes\n' +
    'Chidi,1996-03-15,friends,Loves jollof\n' +
    'Ada,1990-01-01,family,\n' +
    'Leapling,1996-02-29,friends,\n';

  it('previews headers and suggests a mapping without writing anything', async () => {
    const cookie = await signIn('owner@example.test');

    const res = await request(app)
      .post('/contacts/import/preview')
      .set('Cookie', cookie)
      .attach('file', csv(sample), 'contacts.csv')
      .expect(200);

    expect(res.body.headers).toEqual(['Full Name', 'Date of Birth', 'Group', 'Notes']);
    expect(res.body.totalRows).toBe(3);
    expect(res.body.suggestedMapping.name).toBe('Full Name');
    expect(res.body.suggestedMapping.birthDate).toBe('Date of Birth');

    const list = await request(app).get('/contacts').set('Cookie', cookie).expect(200);
    expect(list.body.contacts).toHaveLength(0);
  });

  it('imports with a confirmed mapping', async () => {
    const cookie = await signIn('owner@example.test');

    const res = await request(app)
      .post('/contacts/import')
      .set('Cookie', cookie)
      .attach('file', csv(sample), 'contacts.csv')
      .field(
        'mapping',
        JSON.stringify({
          name: 'Full Name',
          birthDate: 'Date of Birth',
          tag: 'Group',
          notes: 'Notes',
        }),
      )
      .expect(201);

    expect(res.body.imported).toBe(3);
    expect(res.body.failedRows).toHaveLength(0);

    const list = await request(app).get('/contacts').set('Cookie', cookie).expect(200);
    expect(list.body.contacts).toHaveLength(3);

    const leapling = list.body.contacts.find((c: { name: string }) => c.name === 'Leapling');
    expect(leapling).toMatchObject({ birthMonth: 2, birthDay: 29 });
  });

  it('does not duplicate on a second import of the same file', async () => {
    const cookie = await signIn('owner@example.test');
    const mapping = JSON.stringify({ name: 'Full Name', birthDate: 'Date of Birth' });

    const first = await request(app)
      .post('/contacts/import')
      .set('Cookie', cookie)
      .attach('file', csv(sample), 'contacts.csv')
      .field('mapping', mapping)
      .expect(201);
    expect(first.body.imported).toBe(3);

    const second = await request(app)
      .post('/contacts/import')
      .set('Cookie', cookie)
      .attach('file', csv(sample), 'contacts.csv')
      .field('mapping', mapping)
      .expect(201);

    expect(second.body.imported).toBe(0);
    expect(second.body.skippedAsDuplicates).toBe(3);

    const list = await request(app).get('/contacts').set('Cookie', cookie).expect(200);
    expect(list.body.contacts).toHaveLength(3);
  });

  it('deduplicates within a single file too', async () => {
    const cookie = await signIn('owner@example.test');

    const res = await request(app)
      .post('/contacts/import')
      .set('Cookie', cookie)
      .attach('file', csv('Name,DOB\nChidi,1996-03-15\nChidi,1996-03-15\n'), 'c.csv')
      .field('mapping', JSON.stringify({ name: 'Name', birthDate: 'DOB' }))
      .expect(201);

    expect(res.body.imported).toBe(1);
    expect(res.body.skippedAsDuplicates).toBe(1);
  });

  it('reports bad rows and still imports the good ones', async () => {
    const cookie = await signIn('owner@example.test');

    const res = await request(app)
      .post('/contacts/import')
      .set('Cookie', cookie)
      .attach(
        'file',
        csv('Name,DOB\nGood,1996-03-15\nBad,not a date\n,1990-01-01\nAlsoGood,1985-07-04\n'),
        'c.csv',
      )
      .field('mapping', JSON.stringify({ name: 'Name', birthDate: 'DOB' }))
      .expect(201);

    expect(res.body.imported).toBe(2);
    expect(res.body.failedRows).toHaveLength(2);
    expect(res.body.failedRows[0].row).toBe(3);
  });

  it('schedules a reminder for an imported contact whose birthday is tomorrow', async () => {
    const cookie = await signIn('owner@example.test');
    const me = await request(app).get('/me').set('Cookie', cookie);

    const today = new Date(
      new Date().toLocaleString('en-US', { timeZone: me.body.user.timezone }),
    );
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const dd = String(tomorrow.getDate()).padStart(2, '0');

    // Delivery hour set to 00 so the sweep for today has certainly passed.
    await request(app).patch('/me').set('Cookie', cookie).send({ notifyHour: 0 }).expect(200);

    const res = await request(app)
      .post('/contacts/import')
      .set('Cookie', cookie)
      .attach('file', csv(`Name,DOB\nImminent,--${mm}-${dd}\n`), 'c.csv')
      .field('mapping', JSON.stringify({ name: 'Name', birthDate: 'DOB' }))
      .expect(201);

    expect(res.body.imported).toBe(1);
    expect(res.body.remindersScheduled).toBe(1);
  });

  it('rejects a file with no name column mapped', async () => {
    const cookie = await signIn('owner@example.test');

    await request(app)
      .post('/contacts/import')
      .set('Cookie', cookie)
      .attach('file', csv(sample), 'c.csv')
      .field('mapping', JSON.stringify({ name: 'Full Name' }))
      .expect(400);
  });

  it('rejects a request with no file attached', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/contacts/import/preview')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('requires a session', async () => {
    await request(app)
      .post('/contacts/import/preview')
      .attach('file', csv(sample), 'c.csv')
      .expect(401);
  });

  it('does not let one user import into another’s register', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');

    await request(app)
      .post('/contacts/import')
      .set('Cookie', alice)
      .attach('file', csv('Name,DOB\nAliceFriend,1996-03-15\n'), 'c.csv')
      .field('mapping', JSON.stringify({ name: 'Name', birthDate: 'DOB' }))
      .expect(201);

    const bobList = await request(app).get('/contacts').set('Cookie', bob).expect(200);
    expect(bobList.body.contacts).toHaveLength(0);
  });
});

describe('web push', () => {
  /** Records deliveries; endpoints added to `expired` report themselves gone. */
  function recordingPush() {
    const sent: Array<{ endpoint: string; title: string }> = [];
    const expired = new Set<string>();
    return {
      sent,
      expired,
      provider: {
        name: 'recording-push',
        enabled: true,
        async send(sub: { endpoint: string }, msg: { title: string }) {
          if (expired.has(sub.endpoint)) return { delivered: false, expired: true };
          sent.push({ endpoint: sub.endpoint, title: msg.title });
          return { delivered: true, expired: false };
        },
      },
    };
  }
  let harness: ReturnType<typeof recordingPush>;

  const subscription = (id: string) => ({
    endpoint: `https://push.example.test/${id}`,
    keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
  });

  beforeEach(() => {
    harness = recordingPush();
    setPushProvider(harness.provider as never);
  });

  /*
   * These assert against an injected provider rather than whatever VAPID keys
   * happen to be in the developer's .env. The earlier version passed only
   * because no keys were configured locally, and started failing the moment
   * they were — a test that depends on ambient environment is not testing the
   * code.
   */
  it('advertises the key when push is configured', async () => {
    const res = await request(app).get('/push/public-key').expect(200);
    expect(res.body.enabled).toBe(true);
  });

  it('withholds the key when push is not configured', async () => {
    setPushProvider({
      name: 'disabled',
      enabled: false,
      async send() {
        return { delivered: false, expired: false };
      },
    } as never);

    const res = await request(app).get('/push/public-key').expect(200);

    expect(res.body.enabled).toBe(false);
    // A browser must not be able to subscribe against a server that cannot send.
    expect(res.body.publicKey).toBeNull();
  });

  it('registers a device and lists it without leaking the endpoint', async () => {
    const cookie = await signIn('owner@example.test');

    const res = await request(app)
      .post('/push/subscribe')
      .set('Cookie', cookie)
      .send(subscription('device-a'))
      .expect(201);
    expect(res.body.devices).toBe(1);

    const list = await request(app).get('/push/subscriptions').set('Cookie', cookie).expect(200);
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].endpointTail).toBe(
      subscription('device-a').endpoint.slice(-12),
    );
    // The endpoint is a bearer capability — the host must never come back.
    expect(JSON.stringify(list.body)).not.toContain('push.example.test');
  });

  it('treats a re-subscribe on the same endpoint as an update, not a new device', async () => {
    const cookie = await signIn('owner@example.test');

    await request(app).post('/push/subscribe').set('Cookie', cookie).send(subscription('a')).expect(201);
    const second = await request(app)
      .post('/push/subscribe')
      .set('Cookie', cookie)
      .send({ ...subscription('a'), keys: { p256dh: 'rotated', auth: 'rotated' } })
      .expect(201);

    expect(second.body.devices).toBe(1);

    const [row] = await db.select().from(pushSubscriptions);
    expect(row!.p256dh).toBe('rotated');
  });

  it('unsubscribes a device', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app).post('/push/subscribe').set('Cookie', cookie).send(subscription('a')).expect(201);

    const res = await request(app)
      .post('/push/unsubscribe')
      .set('Cookie', cookie)
      .send({ endpoint: subscription('a').endpoint })
      .expect(200);

    expect(res.body.removed).toBe(true);
    expect(res.body.devices).toBe(0);
  });

  it('claims an email row and a push row for the same birthday', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos', notifyHour: 9 });
    await createTestContact(user.id, { name: 'Chidi', birthMonth: 3, birthDay: 15 });
    await db.insert(pushSubscriptions).values({
      userId: user.id,
      endpoint: 'https://push.example.test/x',
      p256dh: 'k',
      auth: 'a',
    });

    const result = await runSweep(lagos9am('2027-03-14'));

    expect(result.claimed).toBe(2);
    const rows = await allNotifications();
    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'push']);
    // Separate idempotency keys — neither can suppress the other.
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('claims only email when the user has no devices', async () => {
    const user = await createTestUser();
    await createTestContact(user.id, { name: 'Chidi', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));

    const rows = await allNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe('email');
  });

  it('delivers a push reminder to every live device', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos' });
    await createTestContact(user.id, {
      name: 'Chidi',
      birthMonth: 3,
      birthDay: 15,
      birthYear: 1996,
    });
    for (const id of ['phone', 'laptop']) {
      await db.insert(pushSubscriptions).values({
        userId: user.id,
        endpoint: `https://push.example.test/${id}`,
        p256dh: 'k',
        auth: 'a',
      });
    }

    await runSweep(lagos9am('2027-03-14'));
    const pushRow = (await allNotifications()).find((r) => r.channel === 'push')!;

    const outcome = await sendNotification(pushRow.id, new Date('2027-03-14T08:00:05Z'));

    expect(outcome.outcome).toBe('sent');
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[0]!.title).toBe("Tomorrow: Chidi's birthday (turning 31)");
  });

  it('retires a dead endpoint instead of failing the reminder', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos' });
    await createTestContact(user.id, { name: 'Chidi', birthMonth: 3, birthDay: 15 });
    for (const id of ['alive', 'dead']) {
      await db.insert(pushSubscriptions).values({
        userId: user.id,
        endpoint: `https://push.example.test/${id}`,
        p256dh: 'k',
        auth: 'a',
      });
    }
    harness.expired.add('https://push.example.test/dead');

    await runSweep(lagos9am('2027-03-14'));
    const pushRow = (await allNotifications()).find((r) => r.channel === 'push')!;

    const outcome = await sendNotification(pushRow.id, new Date('2027-03-14T08:00:05Z'));

    expect(outcome.outcome).toBe('sent');
    expect(harness.sent).toHaveLength(1);

    // The dead device is marked, so it is skipped next time rather than retried.
    const rows = await db.select().from(pushSubscriptions);
    const dead = rows.find((r) => r.endpoint.endsWith('/dead'))!;
    expect(dead.expiredAt).not.toBeNull();
  });

  it('skips a push row when every endpoint is gone', async () => {
    const user = await createTestUser({ timezone: 'Africa/Lagos' });
    await createTestContact(user.id, { name: 'Chidi', birthMonth: 3, birthDay: 15 });
    await db.insert(pushSubscriptions).values({
      userId: user.id,
      endpoint: 'https://push.example.test/dead',
      p256dh: 'k',
      auth: 'a',
    });
    harness.expired.add('https://push.example.test/dead');

    await runSweep(lagos9am('2027-03-14'));
    const pushRow = (await allNotifications()).find((r) => r.channel === 'push')!;

    const outcome = await sendNotification(pushRow.id, new Date('2027-03-14T08:00:05Z'));

    expect(outcome.outcome).toBe('skipped');
    // The email row is untouched — one dead browser must not cost the email.
    const emailRow = (await allNotifications()).find((r) => r.channel === 'email')!;
    expect(emailRow.status).toBe('pending');
  });
});

// ---------------------------------------------------------------- phase 5 --

describe('calendar heatmap', () => {
  it('counts birthdays per day for the year', async () => {
    const cookie = await signIn('owner@example.test');
    const add = (name: string, birthMonth: number, birthDay: number) =>
      request(app).post('/contacts').set('Cookie', cookie).send({ name, birthMonth, birthDay });

    await add('A', 3, 15);
    await add('B', 3, 15);
    await add('C', 7, 4);

    const res = await request(app).get('/calendar?year=2027').set('Cookie', cookie).expect(200);

    expect(res.body.year).toBe(2027);
    expect(res.body.total).toBe(3);
    expect(res.body.days).toHaveLength(2);
    expect(res.body.busiestDay).toMatchObject({ date: '2027-03-15', count: 2 });
    expect(res.body.days.find((d: { date: string }) => d.date === '2027-07-04').names).toEqual(['C']);
  });

  it('places a 29 February contact on its observed day', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Leapling', birthMonth: 2, birthDay: 29 });

    const common = await request(app).get('/calendar?year=2027').set('Cookie', cookie).expect(200);
    expect(common.body.days[0].date).toBe('2027-02-28');

    const leap = await request(app).get('/calendar?year=2028').set('Cookie', cookie).expect(200);
    expect(leap.body.days[0].date).toBe('2028-02-29');
  });

  it('rejects a nonsense year', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app).get('/calendar?year=99999').set('Cookie', cookie).expect(400);
  });
});

describe('dashboard additions', () => {
  it('reports the most recently added contact', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'First', birthMonth: 3, birthDay: 15 });
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Second', birthMonth: 9, birthDay: 9 });

    const res = await request(app).get('/dashboard').set('Cookie', cookie).expect(200);
    expect(res.body.mostRecentlyAdded.name).toBe('Second');
    expect(res.body.totalContacts).toBe(2);
  });
});

// ---------------------------------------------------------------- phase 4 --

describe('account export and delete', () => {
  it('exports everything the account holds, including deleted contacts', async () => {
    const cookie = await signIn('owner@example.test');

    const keep = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Kept', birthMonth: 3, birthDay: 15, notes: 'a note' });
    const drop = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Dropped', birthMonth: 4, birthDay: 1 });
    await request(app).delete(`/contacts/${drop.body.contact.id}`).set('Cookie', cookie).expect(200);

    const res = await request(app).get('/me/export').set('Cookie', cookie).expect(200);

    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.user.email).toBe('owner@example.test');
    expect(res.body.contacts).toHaveLength(2);

    const kept = res.body.contacts.find((c: { name: string }) => c.name === 'Kept');
    expect(kept.notes).toBe('a note');
    expect(kept.deletedAt).toBeNull();

    const dropped = res.body.contacts.find((c: { name: string }) => c.name === 'Dropped');
    expect(dropped.deletedAt).not.toBeNull();
    expect(keep.body.contact.id).toBeDefined();
  });

  it('refuses to delete the account without the confirming email', async () => {
    const cookie = await signIn('owner@example.test');

    await request(app).delete('/me').set('Cookie', cookie).send({ confirmEmail: '' }).expect(400);
    await request(app)
      .delete('/me')
      .set('Cookie', cookie)
      .send({ confirmEmail: 'someone@else.test' })
      .expect(400);

    await request(app).get('/me').set('Cookie', cookie).expect(200);
  });

  it('deletes the account and everything cascading from it', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Gone', birthMonth: 3, birthDay: 15 });
    await request(app).post('/push/subscribe').set('Cookie', cookie).send({
      endpoint: 'https://push.example.test/z',
      keys: { p256dh: 'k', auth: 'a' },
    });

    await request(app)
      .delete('/me')
      .set('Cookie', cookie)
      .send({ confirmEmail: 'OWNER@example.test' }) // case-insensitive
      .expect(200);

    // The session died with the account.
    await request(app).get('/me').set('Cookie', cookie).expect(401);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });
});
