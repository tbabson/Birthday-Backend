import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Set before dotenv reads .env, so these win (dotenv never overrides an
    // already-defined variable). Every test shares one source IP, so the real
    // auth rate limit would reject the suite rather than be exercised by it —
    // it gets its own dedicated test instead.
    env: {
      NODE_ENV: 'test',
      AUTH_RATE_LIMIT_MAX: '100000',
      WRITE_RATE_LIMIT_MAX: '100000',
      EMAIL_PROVIDER: 'console',
      /*
       * A database of its own. The integration tests truncate `users` between
       * cases, so pointing them at the development database means running the
       * suite deletes whatever you were working with. Created on demand by
       * `tests/global-setup.ts`, and `truncateAll` refuses to run against a
       * database whose name does not end in `_test`.
       */
      DATABASE_URL: 'postgres://birthday:birthday@localhost:5433/birthday_test',
      // Push is configured per-test; never inherit real VAPID keys from .env.
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
    },
    globalSetup: ['./tests/global-setup.ts'],
    // Unit tests are pure; integration tests hit Postgres + Redis and are
    // opt-in via `npm run test:integration`.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Integration tests share one database; running files in parallel would
    // have them truncating each other's rows mid-assertion.
    fileParallelism: false,
  },
});
