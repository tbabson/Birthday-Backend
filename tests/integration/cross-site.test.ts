import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * The cross-site deployment: app and API on different registrable domains, so
 * the session cookie must be `SameSite=None; Secure`.
 *
 * Environment is stubbed before any application module is imported, because
 * `config/env.ts` reads it once at load. Vitest gives each test file its own
 * module registry, so this does not leak into the Lax-mode suite next door.
 */
vi.stubEnv('COOKIE_SAMESITE', 'none');
vi.stubEnv('COOKIE_SECURE', 'true');
vi.stubEnv('APP_URL', 'https://api.example.test');
vi.stubEnv('WEB_URL', 'https://app.example.test');
vi.stubEnv('ALLOWED_ORIGINS', 'https://preview.example.test');

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
const { recorder, setupDatabase, truncateAll } = await import('./helpers.js');

const app = createApp();
const WEB_ORIGIN = 'https://app.example.test';
const NEW_CONTACT = { name: 'Chidi', birthMonth: 3, birthDay: 15 };

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
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await truncateAll();
});

describe('configuration', () => {
  it('resolves to a Secure, cross-site cookie', () => {
    expect(env.COOKIE_SAMESITE).toBe('none');
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('allows WEB_URL plus any extra configured origins', () => {
    expect(env.ALLOWED_ORIGINS).toContain('https://app.example.test');
    expect(env.ALLOWED_ORIGINS).toContain('https://preview.example.test');
  });
});

describe('the cookie itself', () => {
  it('is sent as SameSite=None; Secure so the browser will keep it', async () => {
    const before = recorder.sent.length;
    await request(app).post('/auth/magic-link').send({ email: 'x@example.test' }).expect(202);
    const url = /https?:\/\/\S+/.exec(recorder.sent[before]!.text)![0];
    const token = new URL(url).searchParams.get('token')!;

    const res = await request(app).get(`/auth/verify?token=${encodeURIComponent(token)}`);
    const raw = res.headers['set-cookie']![0]!;

    // Both are required together: a SameSite=None cookie without Secure is
    // discarded outright, and the symptom is a login that never persists.
    expect(raw).toMatch(/SameSite=None/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/HttpOnly/i);
  });
});

describe('CSRF, now that the browser no longer prevents it', () => {
  it('still accepts requests from the real app origin', async () => {
    const cookie = await signIn();
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .send(NEW_CONTACT)
      .expect(201);
  });

  it('accepts an additional allowlisted origin', async () => {
    const cookie = await signIn();
    await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .set('Origin', 'https://preview.example.test')
      .send(NEW_CONTACT)
      .expect(201);
  });

  it('rejects the forged cross-site POST that SameSite=Lax used to stop', async () => {
    const cookie = await signIn();

    const res = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send(NEW_CONTACT)
      .expect(403);

    expect(res.body.error.code).toBe('csrf_origin_mismatch');
  });

  /**
   * The rule that differs from Lax mode. With `SameSite=None` the browser will
   * attach the session to anything, so a state-changing request that cannot
   * say where it came from has to be refused.
   */
  it('rejects a state-changing request with no Origin or Referer', async () => {
    const cookie = await signIn();

    const res = await request(app)
      .post('/contacts')
      .set('Cookie', cookie)
      .send(NEW_CONTACT)
      .expect(403);

    expect(res.body.error.code).toBe('csrf_origin_missing');
  });

  it('still allows reads without an Origin', async () => {
    const cookie = await signIn();
    await request(app).get('/contacts').set('Cookie', cookie).expect(200);
  });

  it('still ignores anonymous requests', async () => {
    await request(app).post('/contacts').send(NEW_CONTACT).expect(401);
  });
});
