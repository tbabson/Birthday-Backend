# Birthday Reminder — API Reference

Base URL: **`https://birthday-backend-eafe.onrender.com`**

A JSON API over HTTPS. Every response is `application/json` except the four
public HTML pages listed under [Recipient links](#recipient-links) and
[Unsubscribe](#get-notificationsunsubscribe), which are opened directly from
email clients and render their own markup.

There is no version prefix. The surface described here is v1.

---

## Contents

- [Authentication](#authentication)
- [CORS and CSRF](#cors-and-csrf)
- [Errors](#errors)
- [Rate limits](#rate-limits)
- [Conventions](#conventions)
- [Endpoints](#endpoints)
  - [Health](#health)
  - [Auth](#auth)
  - [Account](#account)
  - [Contacts](#contacts)
  - [CSV import](#csv-import)
  - [Views](#views)
  - [Notifications](#notifications)
  - [Recipients](#recipients)
  - [Push](#push)
- [Object reference](#object-reference)

---

## Authentication

Passwordless, by emailed magic link. There are no API keys and no bearer
tokens — the session is an `HttpOnly` cookie, so a browser client never handles
the credential in JavaScript.

The flow:

1. `POST /auth/magic-link` with an email address. The response is always the
   same whether or not the account exists.
2. The user clicks the link, which is a `GET /auth/verify?token=…` on this API.
3. The API sets the session cookie and redirects to `WEB_URL`.
4. Subsequent requests carry the cookie automatically.

| | |
|---|---|
| Cookie name | `br_session` |
| Flags | `HttpOnly`, `Path=/`, `Secure` in production |
| `SameSite` | `COOKIE_SAMESITE` — `lax` by default, `none` for a cross-site frontend |
| Lifetime | `SESSION_TTL_DAYS`, 30 days by default |
| Magic link validity | `MAGIC_LINK_TTL_MINUTES`, 15 minutes by default |

Requests to a protected endpoint without a valid session get `401`:

```json
{ "error": { "code": "unauthorized", "message": "Not signed in" } }
```

Browser clients must send credentials explicitly — `fetch` omits cookies
cross-origin unless told otherwise:

```js
fetch('https://birthday-backend-eafe.onrender.com/me', { credentials: 'include' })
```

### Endpoints that need no session

`GET /health`, `POST /auth/magic-link`, `GET /auth/verify`,
`GET /push/public-key`, `GET /notifications/unsubscribe`, and the three
`/recipients` link routes. Everything else requires one.

The public link routes are not unauthenticated so much as authenticated
differently: they carry an HMAC signature in the query string, because the
person opening them is typically not the account holder and may have no account
at all.

---

## CORS and CSRF

Allowed origins are `WEB_URL` plus anything in `ALLOWED_ORIGINS`. The matching
origin is echoed back with `Access-Control-Allow-Credentials: true`; a wildcard
is not permitted alongside credentials. Preflights get `204` and are cached for
24 hours.

State-changing requests (anything not `GET`/`HEAD`/`OPTIONS`) that carry a
session cookie are checked against the origin allowlist, plus the API's own
origin for its self-hosted HTML forms. Two failure codes, both `403`:

| Code | Cause |
|---|---|
| `csrf_origin_mismatch` | `Origin`/`Referer` present but not on the allowlist |
| `csrf_origin_missing` | No `Origin` or `Referer` at all, while `COOKIE_SAMESITE=none` |

### Testing with curl

This trips people up. If the deployment runs `COOKIE_SAMESITE=none` — which it
must when the frontend is on a different registrable domain — then any
authenticated `POST`/`PATCH`/`DELETE` from curl is rejected with
`csrf_origin_missing`, because curl sends no `Origin` header and the browser's
SameSite guarantee is what would otherwise have protected the request.

Send one explicitly:

```bash
curl -X POST https://birthday-backend-eafe.onrender.com/contacts \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://your-frontend.example' \
  -b cookies.txt \
  -d '{"name":"Chidi","birthMonth":3,"birthDay":15}'
```

Under `SameSite=lax` the header is unnecessary — a Lax cookie could not have
been attached to a cross-site request in the first place, so there is nothing
to forge.

---

## Errors

Every error shares one envelope:

```json
{ "error": { "code": "not_found", "message": "Contact not found" } }
```

Validation failures add a `details` array naming the offending fields:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid request",
    "details": [
      { "path": "birthDay", "message": "There is no day 31 in month 2" }
    ]
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `validation_failed` | Body or query failed schema validation |
| 400 | `bad_request` | Valid shape, rejected by a rule — including malformed JSON |
| 400 | `upload_failed` | CSV rejected; oversized files give `That file is too large` |
| 401 | `unauthorized` | Missing or expired session |
| 403 | `csrf_origin_mismatch` / `csrf_origin_missing` | See [CSRF](#cors-and-csrf) |
| 404 | `not_found` | No such route, or no such row **for this account** |
| 429 | `rate_limited` | See [Rate limits](#rate-limits) |
| 500 | `internal` | Unhandled. Details are logged, never returned |

A row belonging to another account returns `404`, not `403` — the API does not
confirm that an id it will not serve exists at all.

Oversized-upload responses carry an additional top-level `code` field (the
Multer error code, e.g. `LIMIT_FILE_SIZE`) alongside the standard envelope.

---

## Rate limits

Keyed by client IP, with `RateLimit-*` response headers (draft-7).

| Scope | Limit | Window |
|---|---|---|
| `POST /auth/magic-link` | 5 | 15 min |
| `GET /auth/verify` | 20 | 15 min |
| Contact writes | 60 | 1 min |
| CSV import (both routes) | 10 | 15 min |
| Recipient link routes | 30 | 15 min |

Defaults, configurable via `AUTH_RATE_LIMIT_MAX`,
`AUTH_RATE_LIMIT_WINDOW_MINUTES` and `WRITE_RATE_LIMIT_MAX`.

Body size caps: JSON `256 kb`, form-urlencoded `16 kb`, CSV upload
`IMPORT_MAX_BYTES` (2 MB default) and `IMPORT_MAX_ROWS` (5,000 default).

---

## Conventions

**Dates.** Birthdays are stored as separate `birthMonth` / `birthDay` /
`birthYear` integers, not as a date — a birthday is an annual recurrence, and
`birthYear` is optional because many people record a friend's birthday without
knowing the year. Computed dates (`nextBirthday`, `remindOn`) come back as
`YYYY-MM-DD` strings. Timestamps are ISO 8601 UTC.

**29 February is a real birthday** and is accepted. In common years the
*observed* occurrence is 28 February, and every derived field — the calendar
heatmap, the reminder schedule, `daysAway` — uses the observed date
consistently.

**Time zones.** All day arithmetic happens in the account's IANA zone
(`user.timezone`), not the server's. "Today" means today where the user is.

**Ids** are UUIDs. A malformed id fails validation with `400`, not `404`.

**`leadDays`** is fixed at 1 and deliberately not writable. It exists as a
column so that a second reminder is a migration rather than a refactor.

**Soft deletes.** `DELETE /contacts/:id` hides the contact and cancels its
pending reminders; the row survives and `POST /contacts/:id/restore` brings it
back. Only `DELETE /me` destroys data irreversibly.

---

# Endpoints

## Health

### `GET /health`

No session required. Excluded from request logging, so it is safe to poll — as
the free-tier keep-alive ping does every 10 minutes.

```json
{ "ok": true, "status": "up" }
```

---

## Auth

### `POST /auth/magic-link`

```json
{ "email": "you@example.com", "timezone": "Africa/Lagos" }
```

`timezone` is optional and only used when creating a new account; it must be a
recognised IANA name. Responds `202` regardless of whether the address is
registered, and regardless of whether delivery succeeded — anything else would
turn this endpoint into an account-enumeration oracle.

```json
{ "ok": true, "message": "If that address is valid, a sign-in link is on its way." }
```

### `GET /auth/verify?token=…`

Consumes a single-use token. Always redirects, never returns JSON:

| Outcome | Redirect |
|---|---|
| Valid | `302` to `WEB_URL/` with `Set-Cookie: br_session=…` |
| Invalid or expired | `302` to `WEB_URL/sign-in?error=invalid_link` |

This is the endpoint that makes `APP_URL` load-bearing: links are built against
it, so a wrong value produces mail nobody can sign in from.

### `POST /auth/logout`

Revokes the session server-side and clears the cookie. Safe to call without a
session.

```json
{ "ok": true }
```

---

## Account

All require a session.

### `GET /me`

```json
{
  "user": {
    "id": "8f2b…",
    "email": "you@example.com",
    "timezone": "Africa/Lagos",
    "notifyHour": 9,
    "leadDays": 1,
    "createdAt": "2026-07-31T09:12:04.101Z"
  }
}
```

### `PATCH /me`

```json
{ "timezone": "Europe/London", "notifyHour": 7 }
```

Both optional. `notifyHour` is 0–23 in the account's own zone. Returns the
updated `user`.

### `GET /me/export`

Everything the account holds, as a JSON attachment
(`birthday-reminder-export.json`): profile, **all** contacts including
soft-deleted ones, the last 500 delivery-log entries, and registered push
devices. Deleted rows are included deliberately — withholding them would make
this a summary rather than an export.

### `DELETE /me`

```json
{ "confirmEmail": "you@example.com" }
```

Irreversible, and cascades to contacts, notifications, recipients and devices.
`confirmEmail` must match the account's address (case-insensitive) or the call
fails `400`. The session cookie is cleared.

```json
{ "ok": true, "deleted": true }
```

---

## Contacts

All require a session.

### `GET /contacts`

| Query | Type | Default | Notes |
|---|---|---|---|
| `tag` | string ≤50 | — | Exact match |
| `q` | string ≤100 | — | Name search |
| `sort` | `next_birthday` \| `name` \| `created_at` | `next_birthday` | |
| `includeDeleted` | `true` \| `false` | `false` | |

Returns `{ "contacts": ContactView[] }`. `next_birthday` ordering is computed in
the application rather than in SQL, so the leap-year rule lives in exactly one
place; ties break by name for a stable order.

### `GET /contacts/tags`

`{ "tags": ["family", "work"] }` — every distinct tag in use, for populating a
filter. Declared before `/contacts/:id` so it is not swallowed by the parameter
route.

### `GET /contacts/:id`

`{ "contact": ContactView }`, or `404`.

### `POST /contacts`

```json
{
  "name": "Chidi Okafor",
  "birthMonth": 3,
  "birthDay": 15,
  "birthYear": 1996,
  "tag": "family",
  "notes": "Loves jollof",
  "photoUrl": "https://example.com/chidi.jpg"
}
```

| Field | Rules |
|---|---|
| `name` | required, 1–200 chars, trimmed |
| `birthMonth` | required, 1–12 |
| `birthDay` | required, 1–31, checked against the month |
| `birthYear` | optional, 1900–2100, nullable |
| `tag` | optional, ≤50 |
| `notes` | optional, ≤2000 |
| `photoUrl` | optional, valid URL, ≤1000 |

`201` with the created `ContactView`. If the birthday falls within the reminder
window and today's sweep has already run, a reminder is scheduled immediately —
otherwise a contact added the afternoon before their birthday would get nothing.

### `PATCH /contacts/:id`

Every field optional. Month and day are validated **as a pair against the
stored values**, so you cannot walk a 31 January contact into 31 February in two
individually-valid requests. Moving the birthday re-runs the catch-up check.

### `DELETE /contacts/:id`

Soft delete. Cancels pending reminders and reports how many:

```json
{ "ok": true, "cancelledNotifications": 1 }
```

### `POST /contacts/:id/restore`

Un-deletes, and re-runs the catch-up check for the same reason a create does.
`404` if the contact does not exist or was never deleted.

---

## CSV import

Two steps: preview the file and confirm the column mapping, then apply it.
Both are `multipart/form-data` with the file in a field named **`file`**, and
both require a session.

### `POST /contacts/import/preview`

Persists nothing. Reads the headers back with a guessed mapping for the user to
confirm:

```json
{
  "headers": ["Full Name", "DOB", "Group"],
  "sampleRows": [{ "Full Name": "Chidi Okafor", "DOB": "15/03/1996", "Group": "family" }],
  "totalRows": 128,
  "suggestedMapping": {
    "name": "Full Name",
    "birthDate": "DOB",
    "birthDay": null,
    "birthMonth": null,
    "birthYear": null,
    "tag": "Group",
    "notes": null
  }
}
```

### `POST /contacts/import`

Send the file again plus a `mapping` field — a JSON string, or an object if
your client encodes it that way. Supply either `birthDate` (one whole-date
column) or the separate `birthDay`/`birthMonth`/`birthYear` columns. Only
`name` is required.

Unreadable rows are reported rather than aborting the run — one malformed date
in a 300-row export should not cost the other 299.

```json
{
  "imported": 126,
  "skippedAsDuplicates": 1,
  "remindersScheduled": 2,
  "failedRows": [{ "row": 44, "message": "Could not read a date from \"n/a\"" }],
  "contacts": [],
  "today": "2026-07-31"
}
```

`contacts` is capped at the first 50 created records. Ambiguous slash and dot
dates are read **day-first** (`03/04` is 3 April); ISO `1996-03-15` is tried
first because it is unambiguous.

---

## Views

Read-only projections for the UI. All require a session.

### `GET /upcoming?window=30`

`window` is 1–366, default 30. Returns contacts whose next birthday falls
within that many days:

```json
{ "window": 30, "contacts": [] }
```

### `GET /dashboard`

```json
{
  "totalContacts": 128,
  "today": [],
  "tomorrow": [],
  "thisWeek": [],
  "thisMonth": [],
  "next": null,
  "mostRecentlyAdded": null
}
```

The buckets overlap by design — a birthday today is also in `thisWeek`. Every
array holds full `ContactView` objects. `next` is the soonest upcoming contact.

### `GET /calendar?year=2027`

Per-day counts for a yearly heatmap. `year` defaults to the current year in the
account's zone. Only days that actually have a birthday appear — a heatmap
fills the rest with zero.

```json
{
  "year": 2027,
  "days": [{ "date": "2027-03-15", "count": 2, "names": ["Ada", "Chidi"] }],
  "total": 128,
  "busiestDay": { "date": "2027-03-15", "count": 2, "names": ["Ada", "Chidi"] }
}
```

Keyed on the *observed* occurrence, so in a common year a 29 February contact
appears under 28 February — the same day the reminder actually fires.

---

## Notifications

### `GET /notifications/unsubscribe?u=&s=`

**Public**, HTML. Authenticated by an HMAC signature rather than a session,
because it is opened from an email client. Returns `400` HTML for a bad
signature.

Deliberately does not unsubscribe anything on `GET` — it explains how to stop
reminders instead. Mail clients prefetch links, and a destructive `GET` would
fire on prefetch.

### `GET /notifications/scheduled?window=30`

What is *going to* happen. Derived from contacts rather than read from the
notifications table, because the sweep does not claim a row until the morning a
reminder is due — so a purely table-driven view would show almost nothing.

```json
{ "window": 30, "scheduled": [ScheduledReminder] }
```

### `GET /notifications`

What *has* happened — the delivery log.

| Query | Type | Default |
|---|---|---|
| `status` | `pending` \| `sent` \| `failed` \| `skipped` | all |
| `limit` | 1–500 | 100 |

```json
{ "notifications": [Notification] }
```

### `POST /notifications/test`

Sends a sample reminder to the signed-in address so the user can see what a
real one looks like. Takes no body.

```json
{ "ok": true, "messageId": "<abc@smtp>", "sentTo": "you@example.com" }
```

Sent directly rather than through the queue, and **writes no row** — a test
send must never occupy an idempotency key, or it would suppress the real
reminder for that contact and year.

---

## Recipients

Extra addresses that receive copies of the reminders — a partner or sibling who
should also know. Capped per account; the ceiling is returned as `max`.

### Recipient links

Three **public** HTML routes, HMAC-signed, opened by people who may have no
account:

| Route | Behaviour |
|---|---|
| `GET /recipients/confirm?r=&s=` | Confirms the address. A `GET` is fine — confirming is not destructive |
| `GET /recipients/remove?r=&s=` | Renders a confirmation **button**. Changes nothing |
| `POST /recipients/remove` | Form-urlencoded `r` and `s`. Performs the removal |

Removal is split across two requests for the same reason unsubscribe is: a mail
client prefetching the link must not be able to remove someone by accident.

### `GET /recipients`

```json
{
  "recipients": [
    {
      "id": "3a91…",
      "email": "partner@example.com",
      "label": "Ada",
      "confirmed": true,
      "createdAt": "2026-07-30T18:00:00.000Z"
    }
  ],
  "max": 5
}
```

### `POST /recipients`

```json
{ "email": "partner@example.com", "label": "Ada" }
```

`label` is optional, ≤60 chars. Sends a confirmation email; the recipient
receives nothing else until they confirm. `201` with the recipient.

Rejected with `400` if the address is your own — you already receive these —
or if the per-account ceiling is reached.

### `POST /recipients/:id/resend`

Re-sends the confirmation. `400` if already confirmed, `404` if the recipient
belongs to another account.

### `DELETE /recipients/:id`

`{ "ok": true }`, or `404`.

---

## Push

Web Push over VAPID. The channel is optional: with no VAPID keys configured the
server reports it disabled rather than failing to start, and email remains the
guaranteed channel.

### `GET /push/public-key`

**No session required**, so the frontend can decide whether to offer the
"enable notifications" prompt before sign-in.

```json
{ "enabled": true, "publicKey": "BCS-izv…" }
```

`publicKey` is `null` when disabled. The key is withheld rather than served
inertly — handing out a key the server cannot send with would let a browser
register a subscription that silently never receives anything.

### `POST /push/subscribe`

The output of `PushSubscription.toJSON()` in the browser:

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/…",
  "keys": { "p256dh": "BN…", "auth": "k9…" }
}
```

`201` with `{ "ok": true, "devices": 2 }`. Upserts, so re-subscribing the same
device is idempotent. `400` if push is not configured on the server.

### `POST /push/unsubscribe`

```json
{ "endpoint": "https://fcm.googleapis.com/fcm/send/…" }
```

Returns `{ "ok": true, "removed": true, "devices": 1 }`.

### `GET /push/subscriptions`

```json
{
  "enabled": true,
  "devices": [
    {
      "id": "c7f0…",
      "endpointTail": "aBc123XyZ890",
      "userAgent": "Mozilla/5.0 …",
      "createdAt": "2026-07-28T10:02:11.000Z"
    }
  ]
}
```

Endpoints are **never echoed in full** — an endpoint is a bearer capability for
that device. The last 12 characters are enough to tell two devices apart.

---

# Object reference

## ContactView

```ts
{
  id: string
  name: string
  birthMonth: number          // 1-12
  birthDay: number            // 1-31
  birthYear: number | null
  tag: string | null
  notes: string | null
  photoUrl: string | null
  nextBirthday: string        // YYYY-MM-DD, observed, in the user's zone
  daysAway: number            // 0 means today
  turningAge: number | null   // null when birthYear is unknown
  age: number | null          // age today
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}
```

## ScheduledReminder

```ts
{
  contactId: string
  contactName: string
  occurrenceDate: string              // YYYY-MM-DD, the birthday itself
  occurrenceYear: number
  remindOn: string                    // YYYY-MM-DD, leadDays before
  remindAt: string                    // exact instant, resolved in the user's zone
  daysUntilReminder: number
  turningAge: number | null
  claimedStatus: 'pending' | 'sent' | 'failed' | 'skipped' | null
}
```

`claimedStatus` is `null` until the sweep claims the reminder on the morning it
is due. `pending` means it is queued right now.

## Notification

```ts
{
  id: string
  contactId: string
  contactName: string
  occurrenceYear: number
  leadDays: number
  channel: 'email' | 'push'
  status: 'pending' | 'sent' | 'failed' | 'skipped'
  scheduledFor: string        // ISO 8601
  sentAt: string | null
  attempts: number
  error: string | null
}
```

`skipped` means the reminder aged past `NOTIFICATION_GRACE_HOURS` (12 by
default) before it could be delivered — a birthday reminder three days late is
worse than none. `failed` means `NOTIFICATION_MAX_ATTEMPTS` retries were
exhausted.

---

## Worked example

Sign in, then create a contact and read the dashboard, keeping cookies in a jar:

```bash
API=https://birthday-backend-eafe.onrender.com

# 1. Request the link — then open it from your inbox in a browser.
curl -X POST $API/auth/magic-link \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","timezone":"Africa/Lagos"}'

# 2. With a session cookie saved to cookies.txt:
curl -X POST $API/contacts \
  -H 'Content-Type: application/json' \
  -H "Origin: $API" \
  -b cookies.txt \
  -d '{"name":"Chidi Okafor","birthMonth":3,"birthDay":15,"birthYear":1996,"tag":"family"}'

curl -b cookies.txt "$API/dashboard"
curl -b cookies.txt "$API/upcoming?window=7"
```

Step 2 needs the `Origin` header only when the deployment runs
`COOKIE_SAMESITE=none`; see [Testing with curl](#testing-with-curl).
