import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/queue/queues.js', () => ({
  enqueueSend: vi.fn(async () => {}),
  scheduleHourlySweep: vi.fn(async () => {}),
  sendQueue: vi.fn(),
  sweepQueue: vi.fn(),
  closeQueue: vi.fn(async () => {}),
  SEND_QUEUE: 'notifications-send',
  SWEEP_QUEUE: 'notifications-sweep',
}));

const { closeDb, db } = await import('../../src/db/client.js');
const { createApp } = await import('../../src/http/app.js');
const { notificationRecipients } = await import('../../src/db/schema.js');
const { runSweep } = await import('../../src/services/sweep.js');
const { sendNotification } = await import('../../src/services/sender.js');
const { eq } = await import('drizzle-orm');
const {
  allNotifications,
  createTestContact,
  createTestUser,
  recorder,
  setupDatabase,
  truncateAll,
} = await import('./helpers.js');

const app = createApp();
const lagos9am = (iso: string) => new Date(`${iso}T08:00:00Z`);

async function signIn(email: string): Promise<string> {
  const before = recorder.sent.length;
  await request(app).post('/auth/magic-link').send({ email }).expect(202);
  const url = /https?:\/\/\S+/.exec(recorder.sent[before]!.text)![0];
  const token = new URL(url).searchParams.get('token')!;
  const verify = await request(app).get(`/auth/verify?token=${encodeURIComponent(token)}`);
  return verify.headers['set-cookie']![0]!.split(';')[0]!;
}

/** Pulls the confirm/remove link out of the most recent delivered email. */
function lastLink(): string {
  return /https?:\/\/\S+/.exec(recorder.sent.at(-1)!.text)![0];
}

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('adding a recipient', () => {
  it('sends a confirmation and does not activate the address yet', async () => {
    const cookie = await signIn('owner@example.test');

    const res = await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ada@example.test', label: 'Ada (wife)' })
      .expect(201);

    expect(res.body.recipient).toMatchObject({
      email: 'ada@example.test',
      label: 'Ada (wife)',
      confirmed: false,
    });

    const mail = recorder.sent.at(-1)!;
    expect(mail.to).toBe('ada@example.test');
    expect(mail.subject).toBe('Confirm birthday reminders');
    // The owner's address is named so the recipient knows who is asking.
    expect(mail.text).toContain('owner@example.test');
  });

  it('refuses to add your own address', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'owner@example.test' })
      .expect(400);
  });

  it('rejects a malformed address', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app).post('/recipients').set('Cookie', cookie).send({ email: 'nope' }).expect(400);
  });

  it('caps the list', async () => {
    const cookie = await signIn('owner@example.test');
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/recipients')
        .set('Cookie', cookie)
        .send({ email: `r${i}@example.test` })
        .expect(201);
    }
    await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'sixth@example.test' })
      .expect(400);
  });

  it('re-adding the same address does not duplicate it or revoke consent', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ada@example.test' })
      .expect(201);

    // Confirm, then re-add with a different label.
    await request(app).get(new URL(lastLink()).pathname + new URL(lastLink()).search).expect(200);
    await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ADA@example.test', label: 'Ada' })
      .expect(201);

    const list = await request(app).get('/recipients').set('Cookie', cookie).expect(200);
    expect(list.body.recipients).toHaveLength(1);
    expect(list.body.recipients[0].label).toBe('Ada');
    // Still confirmed — an address that already agreed should not have to again.
    expect(list.body.recipients[0].confirmed).toBe(true);
  });

  it('requires a session', async () => {
    await request(app).post('/recipients').send({ email: 'ada@example.test' }).expect(401);
  });
});

describe('confirming', () => {
  async function addAndGetLink(cookie: string, email = 'ada@example.test') {
    await request(app).post('/recipients').set('Cookie', cookie).send({ email }).expect(201);
    const url = new URL(lastLink());
    return url.pathname + url.search;
  }

  it('activates the address', async () => {
    const cookie = await signIn('owner@example.test');
    const link = await addAndGetLink(cookie);

    await request(app).get(link).expect(200);

    const list = await request(app).get('/recipients').set('Cookie', cookie).expect(200);
    expect(list.body.recipients[0].confirmed).toBe(true);
  });

  it('rejects a forged signature', async () => {
    const cookie = await signIn('owner@example.test');
    const link = await addAndGetLink(cookie);
    const id = new URL(`http://x${link}`).searchParams.get('r')!;

    await request(app).get(`/recipients/confirm?r=${id}&s=forged`).expect(400);

    const list = await request(app).get('/recipients').set('Cookie', cookie).expect(200);
    expect(list.body.recipients[0].confirmed).toBe(false);
  });

  /**
   * The purpose is part of the signed payload, so a link issued for one action
   * cannot be replayed as the other — a removal link must not silently confirm
   * a subscription, or vice versa.
   */
  it('will not accept a removal signature as a confirmation', async () => {
    const cookie = await signIn('owner@example.test');
    const link = await addAndGetLink(cookie);
    const id = new URL(`http://x${link}`).searchParams.get('r')!;

    const { signRecipientLink } = await import('../../src/services/auth.js');
    const removeSig = new URL(signRecipientLink(id, 'remove')).searchParams.get('s')!;
    const confirmSig = new URL(`http://x${link}`).searchParams.get('s')!;

    expect(removeSig).not.toBe(confirmSig);

    // A genuine removal signature, presented to the confirm endpoint.
    await request(app).get(`/recipients/confirm?r=${id}&s=${removeSig}`).expect(400);
    // And the confirm signature presented to the removal endpoint.
    await request(app)
      .post('/recipients/remove')
      .type('form')
      .send({ r: id, s: confirmSig })
      .expect(400);

    const list = await request(app).get('/recipients').set('Cookie', cookie).expect(200);
    expect(list.body.recipients[0].confirmed).toBe(false);
  });
});

describe('receiving reminders', () => {
  it('copies the reminder to every confirmed recipient', async () => {
    const cookie = await signIn('owner@example.test');
    for (const email of ['ada@example.test', 'ben@example.test']) {
      await request(app).post('/recipients').set('Cookie', cookie).send({ email }).expect(201);
      const url = new URL(lastLink());
      await request(app).get(url.pathname + url.search).expect(200);
    }

    // The owner's own contact, with a birthday tomorrow.
    const me = await request(app).get('/me').set('Cookie', cookie);
    await request(app)
      .patch('/me')
      .set('Cookie', cookie)
      .send({ timezone: 'Africa/Lagos' })
      .expect(200);
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Chidi', birthMonth: 3, birthDay: 15, birthYear: 1996 })
      .expect(201);
    expect(me.body.user.email).toBe('owner@example.test');

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();

    recorder.reset();
    const outcome = await sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'));

    expect(outcome.outcome).toBe('sent');
    const to = recorder.sent.map((m) => m.to).sort();
    expect(to).toEqual(['ada@example.test', 'ben@example.test', 'owner@example.test']);

    // Everyone gets the same subject line.
    for (const m of recorder.sent) {
      expect(m.subject).toBe("Tomorrow: Chidi's birthday (turning 31)");
    }
  });

  it('skips unconfirmed addresses', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ada@example.test' })
      .expect(201); // never confirmed

    await request(app).patch('/me').set('Cookie', cookie).send({ timezone: 'Africa/Lagos' });
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Chidi', birthMonth: 3, birthDay: 15 })
      .expect(201);

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();

    recorder.reset();
    await sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'));

    expect(recorder.sent.map((m) => m.to)).toEqual(['owner@example.test']);
  });

  it('gives each recipient their own opt-out link', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ada@example.test' })
      .expect(201);
    const confirm = new URL(lastLink());
    await request(app).get(confirm.pathname + confirm.search).expect(200);

    await request(app).patch('/me').set('Cookie', cookie).send({ timezone: 'Africa/Lagos' });
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Chidi', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();

    recorder.reset();
    await sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'));

    const owner = recorder.sent.find((m) => m.to === 'owner@example.test')!;
    const ada = recorder.sent.find((m) => m.to === 'ada@example.test')!;

    // Not a shared link: Ada can leave without affecting the owner.
    expect(ada.unsubscribeUrl).toContain('/recipients/remove');
    expect(owner.unsubscribeUrl).not.toBe(ada.unsubscribeUrl);
  });

  /**
   * A copy that fails must not retry the job, because the owner has already
   * been sent to — retrying would deliver them a second reminder, which is the
   * one thing the whole idempotency design exists to prevent.
   */
  it('does not fail the reminder when a copy bounces', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ada@example.test' })
      .expect(201);
    const confirm = new URL(lastLink());
    await request(app).get(confirm.pathname + confirm.search).expect(200);

    await request(app).patch('/me').set('Cookie', cookie).send({ timezone: 'Africa/Lagos' });
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send({ name: 'Chidi', birthMonth: 3, birthDay: 15 });

    await runSweep(lagos9am('2027-03-14'));
    const [row] = await allNotifications();

    recorder.reset();
    // Owner's copy goes first and succeeds; the next one throws.
    recorder.failAfter = 1;

    const outcome = await sendNotification(row!.id, new Date('2027-03-14T08:00:05Z'));

    expect(outcome.outcome).toBe('sent');
    expect((await allNotifications())[0]!.status).toBe('sent');
    expect(recorder.sent.map((m) => m.to)).toEqual(['owner@example.test']);
  });
});

describe('a recipient removing themselves', () => {
  async function addConfirmed(cookie: string, email: string): Promise<string> {
    await request(app).post('/recipients').set('Cookie', cookie).send({ email }).expect(201);
    const url = new URL(lastLink());
    await request(app).get(url.pathname + url.search).expect(200);
    const [row] = await db
      .select()
      .from(notificationRecipients)
      .where(eq(notificationRecipients.email, email));
    return row!.id;
  }

  it('shows a confirmation page on GET rather than acting', async () => {
    const cookie = await signIn('owner@example.test');
    const id = await addConfirmed(cookie, 'ada@example.test');
    const { signRecipientLink } = await import('../../src/services/auth.js');
    const link = new URL(signRecipientLink(id, 'remove'));

    const res = await request(app).get(link.pathname + link.search).expect(200);

    expect(res.text).toContain('<form method="post"');
    // A mail client prefetching the link must not unsubscribe anyone.
    const still = await request(app).get('/recipients').set('Cookie', cookie).expect(200);
    expect(still.body.recipients).toHaveLength(1);
  });

  it('removes on POST', async () => {
    const cookie = await signIn('owner@example.test');
    const id = await addConfirmed(cookie, 'ada@example.test');
    const { signRecipientLink } = await import('../../src/services/auth.js');
    const link = new URL(signRecipientLink(id, 'remove'));

    await request(app)
      .post('/recipients/remove')
      .type('form')
      .send({ r: id, s: link.searchParams.get('s')! })
      .expect(200);

    const list = await request(app).get('/recipients').set('Cookie', cookie).expect(200);
    expect(list.body.recipients).toHaveLength(0);
  });

  it('rejects a forged removal', async () => {
    const cookie = await signIn('owner@example.test');
    const id = await addConfirmed(cookie, 'ada@example.test');

    await request(app).post('/recipients/remove').type('form').send({ r: id, s: 'forged' }).expect(400);

    const list = await request(app).get('/recipients').set('Cookie', cookie).expect(200);
    expect(list.body.recipients).toHaveLength(1);
  });
});

describe('the owner managing the list', () => {
  it('removes a recipient', async () => {
    const cookie = await signIn('owner@example.test');
    const created = await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ada@example.test' })
      .expect(201);

    await request(app)
      .delete(`/recipients/${created.body.recipient.id}`)
      .set('Cookie', cookie)
      .expect(200);

    const list = await request(app).get('/recipients').set('Cookie', cookie).expect(200);
    expect(list.body.recipients).toHaveLength(0);
  });

  it('cannot touch another owner’s recipients', async () => {
    const alice = await signIn('owner@example.test');
    const created = await request(app)
      .post('/recipients')
      .set('Cookie', alice)
      .send({ email: 'ada@example.test' })
      .expect(201);

    const bob = await signIn('bob@example.test');

    await request(app)
      .delete(`/recipients/${created.body.recipient.id}`)
      .set('Cookie', bob)
      .expect(404);
    await request(app)
      .post(`/recipients/${created.body.recipient.id}/resend`)
      .set('Cookie', bob)
      .expect(404);

    const bobList = await request(app).get('/recipients').set('Cookie', bob).expect(200);
    expect(bobList.body.recipients).toHaveLength(0);
  });

  it('resends a confirmation, but not for an already-confirmed address', async () => {
    const cookie = await signIn('owner@example.test');
    const created = await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ada@example.test' })
      .expect(201);

    await request(app)
      .post(`/recipients/${created.body.recipient.id}/resend`)
      .set('Cookie', cookie)
      .expect(200);
    expect(recorder.sent.at(-1)!.to).toBe('ada@example.test');

    const url = new URL(lastLink());
    await request(app).get(url.pathname + url.search).expect(200);

    await request(app)
      .post(`/recipients/${created.body.recipient.id}/resend`)
      .set('Cookie', cookie)
      .expect(400);
  });

  it('drops recipients when the account is deleted', async () => {
    const cookie = await signIn('owner@example.test');
    await request(app)
      .post('/recipients')
      .set('Cookie', cookie)
      .send({ email: 'ada@example.test' })
      .expect(201);

    await request(app)
      .delete('/me')
      .set('Cookie', cookie)
      .send({ confirmEmail: 'owner@example.test' })
      .expect(200);

    expect(await db.select().from(notificationRecipients)).toHaveLength(0);
  });
});
