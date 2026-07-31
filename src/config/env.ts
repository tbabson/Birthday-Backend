import "dotenv/config";
import { z } from "zod";

const bool = z
  .string()
  .transform((v) => v === "true" || v === "1")
  .pipe(z.boolean());

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Interface to bind. 0.0.0.0 is required inside a container, where binding
   * to loopback makes the service unreachable from outside it. Override to
   * 127.0.0.1 to keep the API off the network on a shared machine.
   */
  HOST: z.string().default("0.0.0.0"),
  /**
   * How many reverse proxies sit in front of this process. Express uses the
   * count to pick the client's address out of `X-Forwarded-For`, and the rate
   * limiters key on that address.
   *
   * `1` suits a single platform proxy (Render, Fly, nginx on its own). `2` is
   * right when the frontend host proxies as well — routing the app's `/api/*`
   * through Vercel to Render adds a hop.
   *
   * Both directions of error are worth avoiding. Too low resolves every
   * request to the nearest proxy's address, so the whole internet shares one
   * rate-limit bucket and `AUTH_RATE_LIMIT_MAX` locks out every user at once.
   * Too high lets a caller name its own address in `X-Forwarded-For`, which
   * makes the limits opt-out.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  APP_URL: z.string().url().default("http://localhost:3000"),
  WEB_URL: z.string().url().default("http://localhost:5173"),
  /**
   * Extra browser origins allowed to call the API, comma-separated. WEB_URL is
   * always allowed and does not need repeating. Useful for preview deploys.
   */
  ALLOWED_ORIGINS: z.string().optional(),

  /**
   * Session cookie policy.
   *
   * `lax` (the default) is correct whenever the app and the API share a
   * registrable domain — app.example.com and api.example.com are *same-site*,
   * so Lax cookies flow between them and CSRF is prevented by the browser.
   *
   * `none` is required only for a genuinely cross-site split, where the two
   * sit on different registrable domains (app.netlify.app calling
   * api.fly.dev). It makes the browser send the cookie on cross-site requests,
   * which is the whole point — and which is also exactly what CSRF needs, so
   * origin checking becomes mandatory rather than defence in depth. See
   * `http/middleware/csrf.ts`.
   */
  COOKIE_SAMESITE: z.enum(["lax", "none", "strict"]).default("lax"),
  /**
   * `auto` means: on in production, and always on when SameSite=None (the
   * browser rejects `SameSite=None` without `Secure`).
   */
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  /**
   * Set to a parent domain (`.example.com`) to share the session across
   * subdomains. Leave unset for a host-only cookie, which is the safer default.
   */
  COOKIE_DOMAIN: z.string().optional(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  /**
   * `smtp` is right wherever outbound SMTP is permitted. Several managed hosts
   * block it outright to curb spam — Render times out on port 587 — and no
   * amount of host/port/credential fiddling changes that, because the packets
   * never leave the container. `brevo` posts to an HTTPS API on 443 instead,
   * which those hosts do allow.
   */
  EMAIL_PROVIDER: z.enum(["console", "smtp", "brevo"]).default("console"),
  EMAIL_FROM: z
    .string()
    .min(1)
    .default("Birthday Reminder <reminders@example.com>"),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: bool.default("false"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /**
   * v3 key from Brevo → SMTP & API → API Keys. Only read when
   * EMAIL_PROVIDER=brevo. Trimmed because a dashboard paste picks up a
   * trailing space or newline far too easily, and Brevo answers 401 to a key
   * that is correct apart from the whitespace.
   */
  BREVO_API_KEY: z.string().trim().optional(),

  // §6.7: rate limits on auth and import. Env-driven so the test suite can
  // raise them — every test shares one source IP, which would otherwise trip
  // the limiter rather than exercise the endpoint.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
  WRITE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

  // Web push (§5.3 channel v1.5). Generate a pair with `npx web-push generate-vapid-keys`.
  // Absent keys simply disable the push channel rather than failing startup —
  // email remains the guaranteed channel.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:tbabson20@gmail.com"),

  /** Largest CSV accepted by the import endpoint, in bytes. */
  IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(5_000),

  RUN_WORKER_IN_PROCESS: bool.default("true"),
  NOTIFICATION_GRACE_HOURS: z.coerce.number().int().positive().default(12),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

/**
 * `SameSite=None` without `Secure` is rejected outright by every current
 * browser — the cookie is simply never stored, and the symptom is a login that
 * appears to succeed and then immediately forgets you. Failing at boot with a
 * readable message beats debugging that.
 */
const cookieSecure =
  raw.COOKIE_SECURE === "auto"
    ? raw.NODE_ENV === "production" || raw.COOKIE_SAMESITE === "none"
    : raw.COOKIE_SECURE === "true";

if (raw.COOKIE_SAMESITE === "none" && !cookieSecure) {
  throw new Error(
    "Invalid environment configuration:\n" +
      "  COOKIE_SAMESITE=none requires a Secure cookie, but COOKIE_SECURE=false.\n" +
      "  Browsers discard SameSite=None cookies that are not Secure, so sign-in\n" +
      "  would silently never persist. Serve the API over HTTPS and unset\n" +
      "  COOKIE_SECURE (or set it to true).",
  );
}

if (raw.COOKIE_SAMESITE === "none" && !raw.APP_URL.startsWith("https://")) {
  // localhost is a secure context by browser policy, so it is exempt.
  const host = new URL(raw.APP_URL).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(
      "Invalid environment configuration:\n" +
        `  COOKIE_SAMESITE=none requires an HTTPS APP_URL, got ${raw.APP_URL}.\n` +
        "  A Secure cookie is not sent over plain HTTP.",
    );
  }
}

/**
 * Without a key the Brevo provider would build cleanly and then fail on every
 * send with a 401 — and because a delivery failure is deliberately swallowed
 * so it cannot leak which addresses exist, the only symptom would be mail that
 * never arrives. Refuse to start instead.
 */
if (raw.EMAIL_PROVIDER === "brevo" && !raw.BREVO_API_KEY) {
  throw new Error(
    "Invalid environment configuration:\n" +
      "  EMAIL_PROVIDER=brevo requires BREVO_API_KEY.\n" +
      "  Create one at Brevo → SMTP & API → API Keys.",
  );
}

/**
 * Brevo hands out two credentials on the same screen, and they are easy to
 * transpose: an SMTP password (`xsmtpsib-…`) and a v3 API key (`xkeysib-…`).
 * Only the second authenticates an HTTP request — the first returns 401 on
 * every send, and since a delivery failure is deliberately swallowed so it
 * cannot leak which addresses exist, the only symptom is mail that never
 * arrives. Catch it at boot, where the message can say what to fix.
 */
if (raw.EMAIL_PROVIDER === "brevo" && raw.BREVO_API_KEY?.startsWith("xsmtpsib-")) {
  throw new Error(
    "Invalid environment configuration:\n" +
      "  BREVO_API_KEY is an SMTP password (it starts with `xsmtpsib-`), which\n" +
      "  the HTTP API always rejects with a 401. The v3 API key starts with\n" +
      "  `xkeysib-` and lives on the API Keys tab of the same Brevo screen.",
  );
}

/** Every browser origin permitted to call this API with credentials. */
const allowedOrigins = [
  raw.WEB_URL,
  ...(raw.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
];

export const env = {
  ...raw,
  COOKIE_SECURE: cookieSecure,
  ALLOWED_ORIGINS: [...new Set(allowedOrigins)],
};

export type Env = typeof env;
