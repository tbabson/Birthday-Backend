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

const { closeDb } = await import('../../src/db/client.js');
const { createApp } = await import('../../src/http/app.js');
const { env } = await import('../../src/config/env.js');
const { SESSION_COOKIE, clearSessionCookieOptions, sessionCookieOptions } = await import(
  '../../src/http/cookies.js'
);
const { recorder, setupDatabase, truncateAll } = await import('./helpers.js');

const app = createApp();
const WEB_ORIGIN = new URL(env.WEB_URL).origin;

async function signIn(email = 'owner@example.test'): Promise<string> {
  const before = recorder.sent.length;
  await request(app).post('/auth/magic-link').send({ email }).expect(202);

  const url = /https?:\/\/\S+/.exec(recorder.sent[before]!.text)![0];
  const token = new URL(url).searchParams.get('token')!;

  const verify = await request(app).get(`/auth/verify?token=${encodeURIComponent(token)}`);
  return verify.headers['set-cookie']![0]!.split(';')[0]!;
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

const NEW_CONTACT = { name: 'Chidi', birthMonth: 3, birthDay: 15 };

describe('origin verification', () => {
  it('allows a state-changing request from the app’s own origin', async () => {
    const cookie = await signIn();

    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .send(NEW_CONTACT)
      .expect(201);
  });

  it('rejects one from an attacker’s origin, even with a valid session', async () => {
    const cookie = await signIn();

    const res = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send(NEW_CONTACT)
      .expect(403);

    expect(res.body.error.code).toBe('csrf_origin_mismatch');

    // And nothing was written.
    const list = await request(app)
      .get('/contacts')
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .expect(200);
    expect(list.body.contacts).toHaveLength(0);
  });

  it('rejects a forged DELETE just the same', async () => {
    const cookie = await signIn();
    const created = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .send(NEW_CONTACT)
      .expect(201);

    await request(app)
      .delete(`/contacts/${created.body.contact.id}`)
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .expect(403);

    // Still there.
    await request(app)
      .get(`/contacts/${created.body.contact.id}`)
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .expect(200);
  });

  it('falls back to Referer when Origin is absent', async () => {
    const cookie = await signIn();

    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .set('Referer', `${WEB_ORIGIN}/contacts/new`)
      .send(NEW_CONTACT)
      .expect(201);

    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .set('Referer', 'https://evil.example/attack')
      .send({ ...NEW_CONTACT, name: 'Forged' })
      .expect(403);
  });

  it('leaves safe methods alone regardless of origin', async () => {
    const cookie = await signIn();

    // Reading is not a state change, and CORS already stops the attacker
    // reading the response.
    await request(app)
      .get('/contacts')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .expect(200);
  });

  it('ignores anonymous requests — there is no session to ride on', async () => {
    // Rejected for being unauthenticated (401), not for its origin (403).
    await request(app)
      .post('/contacts')
      .set('Origin', 'https://evil.example')
      .send(NEW_CONTACT)
      .expect(401);
  });

  it('rejects a bad origin on multipart import too', async () => {
    const cookie = await signIn();

    await request(app)
      .post('/contacts/import')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .attach('file', Buffer.from('Name,DOB\nX,1996-03-15\n'), 'c.csv')
      .field('mapping', JSON.stringify({ name: 'Name', birthDate: 'DOB' }))
      .expect(403);
  });

  it('allows a request with no Origin at all under SameSite=Lax', async () => {
    // curl, server-to-server, health probes. Lax already guarantees the cookie
    // was not attached cross-site, so there is nothing to forge.
    expect(env.COOKIE_SAMESITE).toBe('lax');

    const cookie = await signIn();
    await request(app).post('/contacts').set('Cookie', cookie).send(NEW_CONTACT).expect(201);
  });
});

describe('CORS', () => {
  it('echoes the allowed origin and permits credentials', async () => {
    const res = await request(app).get('/health').set('Origin', WEB_ORIGIN).expect(200);

    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('never returns credentials headers for a disallowed origin', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    // Set even on rejection, so a cache cannot replay one origin's response
    // for another.
    expect(res.headers['vary']).toContain('Origin');
  });

  it('answers preflight for the allowed origin', async () => {
    const res = await request(app)
      .options('/contacts')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('cookie attributes', () => {
  it('sets the session cookie httpOnly and scoped to the whole site', async () => {
    const before = recorder.sent.length;
    await request(app).post('/auth/magic-link').send({ email: 'c@example.test' }).expect(202);
    const url = /https?:\/\/\S+/.exec(recorder.sent[before]!.text)![0];
    const token = new URL(url).searchParams.get('token')!;

    const res = await request(app).get(`/auth/verify?token=${encodeURIComponent(token)}`);
    const raw = res.headers['set-cookie']![0]!;

    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\//i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  /**
   * `clearCookie` only removes a cookie whose attributes match those it was
   * set with. If these two drift, sign-out silently leaves the session in
   * place — the exact bug the shared helper exists to prevent.
   */
  it('clears with attributes matching how it was set', async () => {
    const set = sessionCookieOptions(new Date(Date.now() + 60_000));
    const clear = clearSessionCookieOptions();

    expect(clear.path).toBe(set.path);
    expect(clear.domain).toBe(set.domain);
    expect(clear.sameSite).toBe(set.sameSite);
    expect(clear.secure).toBe(set.secure);
    expect(clear.httpOnly).toBe(set.httpOnly);
  });

  it('actually ends the session on logout', async () => {
    const cookie = await signIn();

    await request(app)
      .post('/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .expect(200);

    await request(app).get('/me').set('Cookie', cookie).expect(401);
  });
});
