# Birthday Reminder — Backend

Node.js + TypeScript + Express + PostgreSQL + Redis. Implements **all seven
phases** of the project brief: scaffold, auth, contacts CRUD, the date engine,
the reminder pipeline, settings, dashboard, CSV import, web push, and deploy.

**One reminder, one day before the birthday, at 09:00 in the user's own time
zone.** Never twice.

---

## Quick start

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into SESSION_SECRET
docker compose up -d
```

That is the whole stack: API, Postgres, Redis and Mailpit. Migrations run at
boot, so there is no separate migrate step.

- API on <http://localhost:3000>
- Mailpit (catches all outgoing email) on <http://localhost:8025>

Code changes need a rebuild — `docker compose up -d --build api` — because the
container runs the compiled image rather than `tsx watch`. For a fast
edit-reload loop, start the services alone and run the API on the host:

```bash
docker compose up -d postgres redis mailpit
npm install
npm run db:migrate
npm run dev
```

Only one of the two at a time: both bind the same port.

Postgres is published on **5433** and Redis on **6380**, not their default
ports — a native Postgres or Redis install commonly already owns 5432/6379, and
silently connecting to the wrong server is a miserable way to lose an hour.

**On this machine the API runs on port 4000, not 3000.** Windows has reserved
2928–3027 (a Hyper-V/WSL dynamic range), so binding 3000 fails with `EACCES`.
The local `.env` is set to 4000 accordingly; `.env.example` keeps 3000 as the
portable default. To check the reserved ranges:

```
netsh interface ipv4 show excludedportrange protocol=tcp
```

```bash
npm test              # everything (needs docker compose up)
npm run test:unit     # date engine only, no services needed
npm run typecheck
npm run build
```

## Layout

```
src/
  domain/dates.ts        The date engine. Pure, no IO, no wall clock.
  db/schema.ts           Drizzle schema; the unique index that guarantees no duplicates.
  repositories/          Every query. user_id is a required argument, not a convention.
  services/
    sweep.ts             Claims reminders. The scheduling decision lives here.
    sender.ts            Sends one reminder, per channel. Decides send vs. skip.
    import.ts            CSV parsing and column mapping. Pure.
    auth.ts              Magic links and sessions.
  email/                 SMTP + console providers, templates.
  push/                  Web Push provider (VAPID).
  queue/                 BullMQ queues + the send worker.
  scheduler.ts           Hourly sweep registration and boot recovery.
  http/                  Express app, routes, validation, error mapping.
  server.ts              API entry point.
  worker-entry.ts        Worker entry point (no HTTP).

frontend-assets/         PWA manifest + service worker. Belong in the frontend's
                         public/ — they live here because the service worker's
                         push contract is defined by sender.ts.
scripts/backup.sh        Nightly pg_dump with retention.
```

## How the scheduling works

A **daily sweep, not per-contact timers.** A cron job runs hourly, selects the
users whose local clock just struck their `notify_hour`, computes tomorrow in
each user's zone, and claims a `notifications` row per matching contact.

A job scheduled a year in advance is fragile against Redis loss, contact edits,
deletions and lead-time changes. The sweep re-derives everything from current
state each run, so the database stays the single source of truth.

### The idempotency key

```
UNIQUE (contact_id, occurrence_year, lead_days, channel)
```

That constraint is the whole no-duplicates story. Claiming a reminder is an
`INSERT ... ON CONFLICT DO NOTHING`; a retried job, an overlapping sweep, or a
redeploy mid-run all conflict harmlessly instead of sending a second email.

`occurrence_year` is the year of the **birthday**, not of the send. A 1 January
birthday reminds on 31 December of the *previous* year — keying on the send year
would silently break idempotency every New Year's Eve.

### The two layers of the date engine

`src/domain/dates.ts` separates:

1. A **calendar** layer of plain `{year, month, day}` integers. All birthday
   arithmetic happens here, so DST cannot reach it. "The day before 15 March"
   is a calendar question.
2. An **instant** layer that turns a calendar date + hour + IANA zone into a UTC
   timestamp. The only place a time zone is involved.

Mixing them is where off-by-one-day bugs come from: subtracting 24 hours from an
instant is not the same as subtracting one day from a date.

Nothing in the module reads the wall clock — `now` is always a parameter, which
is what makes the fixed-clock tests possible.

## Edge cases, and where they are handled

| Case | Behaviour | Where |
|---|---|---|
| **29 February** | Observed 28 Feb in common years, so the reminder goes out 27 Feb. In leap years, observed 29 Feb, reminder 28 Feb. | `observedOccurrence`, `birthDatesObservedOn` |
| **28 Feb lookup** | A sweep targeting 28 Feb in a common year must also match stored `(2, 29)` contacts, or every leapling misses three years in four. | `birthDatesObservedOn` |
| **1 January** | Reminder fires 31 Dec of the previous year; `occurrence_year` is the *next* year. | `occurrenceDateFor` |
| **Time zones** | Everything stored UTC. "9am local" resolved per user in SQL via `now AT TIME ZONE users.timezone`, never per server. | `findUsersAtNotifyHour` |
| **DST** | IANA zone names only. Calendar arithmetic never touches instants, so a 23- or 25-hour day is still one day. | `dates.ts` |
| **Contact added late** | Added at 3pm the day before a birthday, after the 09:00 sweep: enqueued immediately, keyed with the *actual* days-away (so a same-day add uses `lead_days = 0`, a distinct key that cannot collide with the T-1 row). | `catchUpForContact` |
| **Server downtime** | On boot, re-runs today's sweep for users past their notify hour, and re-drives claimed-but-unsent rows inside the grace window. Past it, they are marked `skipped` — a reminder three days late is worse than none. Deliberately does *not* resurrect yesterday's reminder for a birthday that is today, because "tomorrow" would then be a lie. | `runBootRecovery` |
| **Deleted contacts** | Soft-delete cancels pending notifications; the sender re-checks at send time in case the row was already queued. | `cancelPendingForContact`, `sendNotification` |

## Email

```bash
npm run email:check              # sends to SMTP_USER
npm run email:check me@you.com   # or to a specific address
```

That command connects, authenticates and sends a sample reminder, printing the
resolved config first. When a reminder does not arrive, it answers "is it the
mail setup or the app?" in one step — and it translates the SMTP failures that
actually happen (535, EAUTH, connection refused, rejected sender) into
something readable.

**Development** defaults to Mailpit, the local sink at
<http://localhost:8025>. Nothing leaves the machine. The compose file
interpolates `EMAIL_PROVIDER`/`SMTP_HOST`/`SMTP_PORT` from `.env` with Mailpit
as the fallback, so a fresh checkout gets the sink and a configured `.env` wins.

On Windows, Hyper-V/WSL2 reserves blocks of low ports at boot and 8025 often
lands inside one, so Docker fails to bind it ("An attempt was made to access a
socket in a way forbidden by its access permissions"). List the ranges with
`netsh interface ipv4 show excludedportrange protocol=tcp` and set
`MAILPIT_UI_PORT` in `.env` to a port outside them.

**Gmail** needs no domain and no DNS, sends ~500/day, and — sending from a
Google account to a Google inbox — has effectively perfect deliverability. Good
enough for a personal register; see `.env.example` for the block.

The App Password is the part people get wrong. It requires 2-Step Verification,
it is exactly 16 characters, and a normal Google password is *always* rejected
with an unhelpful 535. `email:check` catches an empty or wrong-length one before
it ever reaches Gmail.

**Brevo** (`EMAIL_PROVIDER=brevo`) posts to Brevo's transactional HTTP API
instead of speaking SMTP, and exists for one reason: managed hosts routinely
block outbound SMTP to curb spam. Render times out on port 587, and no change of
host, port or credential fixes it, because the packets never leave the
container. Port 443 is allowed, so an HTTPS API call gets through where SMTP
cannot. It needs two variables and ignores every `SMTP_*` one:

```bash
EMAIL_PROVIDER=brevo
BREVO_API_KEY=xkeysib-...                       # SMTP & API → API Keys (a v3 key, not the SMTP password)
EMAIL_FROM="Birthday Reminder <you@example.com>" # verified under Senders, Domains & Dedicated IPs
```

The sender is the part people get wrong: an unverified `EMAIL_FROM` is refused
with a 400 on every send. `email:check` names both failures — a rejected key and
a rejected sender — rather than leaving you with a bare status code. Free tier
is 300 mails/day, which is far more than a personal register sends.

The other trap is **Authorised IPs** (Brevo → Security → Authorised IPs). With
the restriction on, Brevo answers 401 to a perfectly valid key purely because of
where the call came from, and the message reads like a credential problem when
nothing is wrong with the credential. Either turn the restriction off, or add
every outbound IP the API can call from — for Render those are listed under the
service's Connect → Outbound. A home or office IP is rarely static, so an
allowlist that includes your laptop will quietly expire.

**Anything else** is the same five SMTP variables — Resend, SES and Postmark all
speak SMTP, so no code changes, only `.env`.

On an unencrypted port the transport sets `requireTLS`, so a failed STARTTLS
upgrade is an error rather than a silent fallback to plaintext with the password
in the clear. Mailpit is exempted by hostname rather than by relaxing the rule.

Before real mail lands anywhere but spam from a domain of your own: SPF, DKIM,
DMARC and a dedicated sending subdomain (§6.4). Gmail sidesteps all of that by
sending as an existing, already-trusted account.

## Channels

Email is unconditional — it is the guaranteed channel, and the one that still
works when a browser has forgotten the site exists. **Web push** is added only
when the server has VAPID keys *and* the user has at least one live device, so
a user with no devices never accumulates rows that could only ever be skipped.

Because `channel` is part of the unique index, email and push are **separate
claims**: one cannot suppress the other, and a dead browser cannot cost you the
email. Push fans out to every registered device under a single notification row
— the user is being told once, on whichever screens they own.

A push endpoint that answers 404 or 410 is retired rather than retried; a
browser that has dropped its subscription is never coming back, and treating
that as a failure would keep the whole reminder retrying until it exhausted its
attempts.

Set up:

```bash
npx web-push generate-vapid-keys     # then set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Leave them blank and push is simply off. See `frontend-assets/` for the service
worker and the subscription flow.

## CSV import

Two steps, deliberately. `POST /contacts/import/preview` reads the headers and
five sample rows and suggests a mapping; `POST /contacts/import` applies a
mapping the user has confirmed. Guessing silently is how you import 400 people
with months and days transposed and no way to notice.

- **Dates**: ISO is unambiguous and tried first. Slash and dot formats assume
  **day-first** (`03/04` is 3 April), matching the `en-GB` rendering used
  elsewhere — except where the first number cannot be a day. Anyone needing
  certainty maps three separate day/month/year columns instead. Month names
  and two-digit years are handled; a year-less birthday is fine throughout.
- **Bad rows are reported, not fatal.** One malformed date in a 300-row export
  should not cost the other 299. Row numbers count the header as row 1, so they
  match what the user sees in their spreadsheet.
- **A bad *year* does not lose the contact** — the birthday still works, only
  the age is unknown.
- **Duplicates are skipped**, matched on name + month + day, both against the
  existing register and within the file itself. Re-importing the same export is
  a normal accident; silently doubling someone's register is the worst possible
  response to it. Deliberately not an upsert — overwriting hand-typed notes
  with a blank spreadsheet column is equally destructive.
- Imported contacts get the same §6.4 catch-up as manually added ones.

Files are parsed **in memory**; writing other people's personal data to a temp
file on disk is a privacy liability for no benefit.

## Sessions, cookies and CSRF

The session is an httpOnly cookie holding an opaque random token. Nothing the
frontend runs can read it, which is the point.

**Pick the deployment topology first — it decides the config.**

| Topology | Same-site? | Setting |
|---|---|---|
| One host, API under `/api` | yes | `COOKIE_SAMESITE=lax` |
| `app.example.com` + `api.example.com` | **yes** | `COOKIE_SAMESITE=lax` |
| `app.netlify.app` + `api.fly.dev` | no | `COOKIE_SAMESITE=none` |

The middle row catches people out: different *subdomains* of one registrable
domain are same-site, so `Lax` works there and you should use it. Only
genuinely different registrable domains need `None`.

**Treat the third row as a last resort, not a supported topology.** `None` is
the correct *server* answer for a cross-site split, and the server no longer
gets the last word: Safari discards third-party cookies outright under ITP, so
do Chrome Incognito and Brave, and so do the in-app browsers inside Gmail and
Outlook — which is precisely where a magic link gets opened. Everything
inspectable looks right (the cookie is set, CORS echoes the origin, the
attributes read `None; Secure`) and sign-in still lands back on `/sign-in`,
because `/me` answers 401 for want of a cookie the browser declined to send.
No server setting fixes that.

Collapse to one origin instead. A frontend host that can proxy turns the third
row into the first for free — this deployment rewrites the app's `/api/*` to
the backend, so the cookie is first-party and browser policy stops mattering:

```jsonc
// vercel.json, in the frontend repo — the /api rule must come first, or the
// SPA catch-all answers every API path with index.html
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "https://<service>.onrender.com/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

Two things move with it. `APP_URL` must become the **proxied** base
(`https://<app>.vercel.app/api`), because magic links have to point at the
address the browser uses rather than at the backend's own origin — a link
straight to `onrender.com` sets the cookie on the wrong domain and undoes the
whole arrangement. And `TRUST_PROXY` becomes `2`: the extra hop means Express
reads the proxy's address as the client's unless it is told how many to skip,
and every rate limit would otherwise share a single bucket for all users.

```bash
# cross-site only
COOKIE_SAMESITE=none      # implies Secure; boot fails if APP_URL is not HTTPS
ALLOWED_ORIGINS=https://preview.example.app   # optional extras beyond WEB_URL
```

Startup refuses `SameSite=None` without `Secure`, and refuses it over plain
HTTP. Browsers silently discard such cookies, and the symptom — a sign-in that
succeeds and is instantly forgotten — is miserable to diagnose. Failing loudly
at boot is worth more than the flexibility.

### Why `None` needs CSRF protection

`SameSite=Lax` is itself a CSRF defence: the browser refuses to attach the
cookie to a cross-site POST, so a forged request arrives unauthenticated and
fails. `None` removes exactly that guarantee.

**CORS does not fill the gap.** CORS decides whether a response may be *read*,
not whether a request may be *sent*. A form POST from an attacker's page is
dispatched and the state change happens regardless of the attacker never seeing
the reply.

So `http/middleware/csrf.ts` verifies the request's origin, and its rules
differ by mode — deliberately, because the threat differs:

| | Origin present | Origin absent |
|---|---|---|
| **Lax** | must be allowlisted | allowed — the cookie could not have been attached cross-site anyway, and rejecting would break curl and health probes for no gain |
| **None** | must be allowlisted | **rejected** — the browser guarantee is gone, so a request that cannot say where it came from cannot be trusted with a session |

Only state-changing methods are checked, and only when a session cookie is
actually present. `Referer` is accepted when `Origin` is absent.

Both modes are covered by tests: `tests/integration/csrf.test.ts` (Lax) and
`tests/integration/cross-site.test.ts` (None), the latter stubbing the
environment before importing so it exercises a genuinely different config.

Cookie attributes come from one place, `http/cookies.ts`. `clearCookie` only
removes a cookie whose name, path, domain, sameSite and secure all match how it
was set — deriving both from one object is the only reliable way to stop a
sign-out silently leaving the session alive, a drift that stays invisible in
development where the attributes usually happen to match.

## Multi-tenancy

Built multi-tenant-shaped, shipped single-user (brief §9.3). Every row carries
`user_id`, and every function in `src/repositories/` takes `userId` as a
required argument folded into the `WHERE` clause. There is no signature that
omits the scope, so a forgotten `WHERE user_id = ?` is a type error rather than
a data leak. Nothing outside a repository queries a table directly.

Hardening worth considering before opening this to shared lists: Postgres
row-level security as a second layer, which needs a per-request
`SET LOCAL app.current_user_id` inside a transaction.

## Testing

187 tests.

- **`src/domain/dates.test.ts`** (65) — the date engine against fixed clocks:
  leap years including 1900 and 2000, year rollovers, sub-hour offset zones,
  the New York DST boundary, and a **simulated two-year run** asserting every
  contact fires exactly once per occurrence year, always exactly one day before
  the observed birthday.
- **`tests/integration/sweep.test.ts`** (29) — the sweep against a real
  database, including a **full simulated year** that runs 366 daily sweeps
  *twice each* and asserts exactly one notification per birthday and zero
  duplicates. Plus per-user notify hours, catch-up, boot reconcile, grace
  window, retry propagation, and a direct check that the unique index actually
  rejects a duplicate insert.
- **`tests/integration/api.test.ts`** (24) — HTTP: the real magic-link flow
  (link parsed out of the delivered email), single-use tokens, validation,
  and cross-tenant isolation.
- **`tests/integration/csrf.test.ts`** (14) — origin verification in Lax mode,
  CORS credential handling, and that `clearCookie` matches how the cookie was
  set so sign-out really ends the session.
- **`tests/integration/cross-site.test.ts`** (9) — the same API reconfigured
  for `SameSite=None`: the cookie carries `None; Secure`, forged cross-site
  POSTs are refused, and a state-changing request with no origin at all is
  refused too.
- **`src/services/import.test.ts`** (20) — CSV date parsing: ambiguous slash
  formats, two-digit years, month names, year-less birthdays, and the row-level
  error reporting.
- **`tests/integration/phase456.test.ts`** (26) — import over HTTP including
  double-import and cross-tenant checks, the push channel end to end (dual
  email+push claims, multi-device fan-out, dead-endpoint retirement), the
  calendar heatmap's leap-year placement, and account export/delete.

Rate limits are env-driven (`AUTH_RATE_LIMIT_MAX`, `WRITE_RATE_LIMIT_MAX`) and
raised in `vitest.config.ts`, because every test shares one source IP and would
otherwise trip the limiter rather than exercise the endpoint.

## API

Full reference with request/response bodies, error codes, rate limits and
object shapes: **[`docs/API.md`](docs/API.md)**. The summary:

```
POST   /auth/magic-link          { email, timezone? }
GET    /auth/verify?token=       -> 302 + session cookie
POST   /auth/logout

GET    /me
PATCH  /me                       { timezone?, notifyHour? }
GET    /me/export                full JSON export of everything the account holds
DELETE /me                       { confirmEmail } — irreversible, cascades

GET    /contacts?tag=&q=&sort=next_birthday&includeDeleted=
POST   /contacts
GET    /contacts/tags
GET    /contacts/:id
PATCH  /contacts/:id
DELETE /contacts/:id             soft delete; cancels pending reminders
POST   /contacts/:id/restore
POST   /contacts/import/preview  multipart CSV -> headers + suggested mapping
POST   /contacts/import          multipart CSV + mapping -> imported contacts

GET    /upcoming?window=30
GET    /dashboard
GET    /calendar?year=2027       per-day counts for the yearly heatmap
GET    /notifications?status=&limit=
GET    /notifications/scheduled?window=30   what is coming, from contacts
POST   /notifications/test       sends a sample; writes no row
GET    /notifications/unsubscribe?u=&s=     public, HMAC-signed, HTML

GET    /recipients               extra addresses that get copies; max 5
POST   /recipients               { email, label? } — sends a confirmation
POST   /recipients/:id/resend
DELETE /recipients/:id
GET    /recipients/confirm?r=&s=  public, HMAC-signed, HTML
GET    /recipients/remove?r=&s=   renders a button; changes nothing
POST   /recipients/remove         form-urlencoded r + s; performs the removal

GET    /push/public-key          VAPID key + whether push is enabled
POST   /push/subscribe           browser PushSubscription JSON
POST   /push/unsubscribe         { endpoint }
GET    /push/subscriptions       registered devices; endpoints never echoed

GET    /health
```

`lead_days` is fixed at 1 and deliberately not exposed as a setting (brief
§5.2). It is a column rather than a hardcoded number so a second reminder is a
config change and a migration, not a refactor.

## Deployment

Two processes off one image:

```bash
node dist/server.js         # API
node dist/worker-entry.js   # sweep scheduler + send worker
```

Set `RUN_WORKER_IN_PROCESS=false` on the API in production so a slow send queue
cannot stall requests. In development the default `true` runs everything in one
process.

Three options are provided:

- **`docker-compose.prod.yml`** — VPS deployment. API, worker, Postgres and
  Redis, with healthchecks and `POSTGRES_PASSWORD` required rather than
  defaulted.
- **`fly.toml`** — Fly.io, two process groups from one image, primary region
  `jnb` (closest to Lagos). The API is pinned to `min_machines_running = 1`: a
  suspended machine cannot answer a magic-link click, and the first request
  after a cold start is the one that matters.
- **`render.yaml`** — Render, everything on the free tier. See below.

The worker needs a **persistent Redis**, which is why this cannot be pure
serverless. Redis is configured with `appendonly yes` and
`maxmemory-policy noeviction` — evicting a BullMQ key loses a send.

### Render

Dashboard → **New → Blueprint** → pick this repo. The blueprint creates a free
Postgres, a free Key Value instance and one free web service, and prompts for
the values it cannot derive: `APP_URL`, `WEB_URL`, the SMTP credentials and the
VAPID pair. `SESSION_SECRET` is generated by Render; `DATABASE_URL` and
`REDIS_URL` are wired to the managed instances over the private network.

`APP_URL` is not known until the service exists. Set it to the URL shown in the
dashboard after the first deploy and let it redeploy — magic links built against
the wrong origin land nowhere.

Render has no free instance type for background workers, so `render.yaml` sets
`RUN_WORKER_IN_PROCESS=true` and the API process owns the sweep — the one
deviation from the two-process layout above.

**Keeping it awake.** A free web service suspends after 15 minutes idle, and a
suspended process runs no hourly sweep, so reminders would fire only when the
next visitor happened to wake it. Point a scheduler at `/health` every 10
minutes — [cron-job.org](https://cron-job.org) is free and enough:

```
GET https://<service>.onrender.com/health   every 10 minutes
```

`/health` is excluded from request logging (`http/app.ts`), so this does not
drown the logs. 10-minute pings keep one service awake for ~730 hours a month,
inside Render's 750 free instance-hours.

Two free-tier expiries to diarise: **free Postgres is deleted 30 days after
creation** — upgrade it or take a dump with `scripts/backup.sh` first — and free
Key Value has no persistence. Losing Redis is survivable: Postgres is the source
of truth, and `runBootRecovery()` re-drives anything still `pending` inside the
grace window on the next boot.

Backups: `scripts/backup.sh`, nightly via cron. It writes to a `.partial` file
and moves it into place only after checking the dump is non-empty — a truncated
dump that shares the final name is worse than no dump, because it looks like
one. A backup you have never restored is a hypothesis; the restore command is
in the script header.

Before real email will land anywhere but spam: SPF, DKIM, DMARC, and a
dedicated sending subdomain (brief §6.4).

## Out of scope / deliberately absent

**Frontend.** Brief §6.6 (mobile-first responsive, 360/640/1024 breakpoints,
44px touch targets, safe-area insets) and the Lighthouse target in §8 belong to
the React app, which is a separate codebase. `frontend-assets/` carries the PWA
manifest and the service worker because the worker's push contract is defined
by this backend; everything else there is the frontend's job.

**Google Contacts OAuth import** — brief §5.4 scopes this as v2.

**SMS / WhatsApp** — brief §5.3 scopes these as v2. The `channel` enum already
has `sms`, and adding a provider is now a matter of one branch in
`sender.ts` plus one entry in `resolveChannels`.

**A one-click unsubscribe.** The endpoint verifies its HMAC signature and then
explains how to stop reminders rather than acting, because a destructive action
on a `GET` fires when a mail client prefetches the link. With one reminder per
birthday there is nothing granular to switch off; the right shape is a
preferences page reached by that signed token, and push already has real
per-device opt-out via `POST /push/unsubscribe`.

**The §6.7 silent-failure alert** (zero notifications across three days that
had birthdays). The sweep logs structured counts on every run
(`msg="sweep complete"`, with `claimed` and `contactsMatched`), so this is an
alerting rule in whatever you point at the logs rather than application code.
It is still the single most valuable thing left to add — silent failure is the
main risk in a system like this.

**Encryption at rest** (§6.7) is a database/volume concern: enable it on the
managed Postgres, or use an encrypted volume on a VPS. Application-level
encryption of names and notes would break search and sorting for little gain
against the realistic threat.
