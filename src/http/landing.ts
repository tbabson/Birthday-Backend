/**
 * The API's own landing page, served at `/`.
 *
 * A bare 404 at the root is correct for an API but reads as an outage to
 * anyone who opens the base URL in a browser. This is the reference instead.
 *
 * Deliberately one self-contained document: inline CSS, no scripts, no
 * external fonts or assets. `helmet()`'s default CSP allows inline styles but
 * blocks inline scripts, so the collapsible sections use native
 * `<details>`/`<summary>` rather than JavaScript — which also means the page
 * works with scripting disabled.
 */

/**
 * Only `baseUrl` is interpolated, and it comes from `APP_URL` rather than from
 * a request, so it is not attacker-controlled. Escaped anyway: a value that
 * reaches HTML unescaped is a habit worth not forming.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLandingPage(appUrl: string): string {
  const base = esc(appUrl.replace(/\/$/, ''));

  /** One endpoint card. `path` is shown after the greyed-out base URL. */
  const ep = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    access: 'public' | 'session',
    summary: string,
    body: string,
    id?: string,
  ): string => `
  <details class="ep"${id ? ` id="${id}"` : ''}>
    <summary><span class="m ${method.toLowerCase()}">${method}</span>
      <span class="url"><span class="b">${base}</span><span class="p">${path}</span></span>
      <span class="role ${access}">${access}</span><span class="sum">${summary}</span></summary>
    <div class="body">${body}</div>
  </details>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Birthday Reminder API</title>
<meta name="description" content="Birthday Reminder — never miss a birthday. Backend API reference.">
<style>
  :root{
    --bg:#ffffff; --bg-alt:#f6f7f9; --bg-code:#f2f4f7; --fg:#16181d; --fg-mut:#5c6370;
    --line:#e3e6ea; --accent:#2563eb; --get:#0d8050; --post:#1f6feb;
    --patch:#8250df; --del:#cf222e; --pill:#eef1f5; --warn:#9a6700;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0f1115; --bg-alt:#151922; --bg-code:#11151d; --fg:#e6e9ef; --fg-mut:#9aa3b2;
      --line:#242a35; --accent:#6ea8fe; --get:#3fb950; --post:#58a6ff;
      --patch:#bc8cff; --del:#f85149; --pill:#1b2130; --warn:#d29922;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  code,pre{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}

  header{border-bottom:1px solid var(--line);background:var(--bg-alt);padding:28px 24px}
  .wrap{max-width:1180px;margin:0 auto}
  header h1{margin:0 0 6px;font-size:26px;letter-spacing:-.02em}
  header p{margin:0;color:var(--fg-mut)}
  .baseurl{margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .baseurl span{color:var(--fg-mut);font-size:13px}
  .baseurl code{background:var(--bg-code);border:1px solid var(--line);border-radius:6px;
                padding:6px 10px;font-size:13px;word-break:break-all}

  .layout{max-width:1180px;margin:0 auto;display:flex;gap:32px;padding:24px}
  nav{width:230px;flex:none;position:sticky;top:24px;align-self:flex-start;max-height:calc(100vh - 48px);overflow:auto}
  nav h4{margin:16px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-mut)}
  nav h4:first-child{margin-top:0}
  nav a{display:block;padding:3px 0;font-size:13.5px;color:var(--fg)}
  main{flex:1;min-width:0}

  section{margin-bottom:40px;scroll-margin-top:16px}
  section>h2{margin:0 0 4px;font-size:20px;border-bottom:1px solid var(--line);padding-bottom:8px}
  section>p.lead{color:var(--fg-mut);margin:8px 0 16px}

  details.ep{border:1px solid var(--line);border-radius:8px;margin-bottom:10px;background:var(--bg-alt);overflow:hidden;scroll-margin-top:16px}
  details.ep>summary{cursor:pointer;padding:11px 14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;list-style:none}
  details.ep>summary::-webkit-details-marker{display:none}
  details.ep>summary:hover{background:var(--pill)}
  details.ep[open]>summary{border-bottom:1px solid var(--line)}
  .m{font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 7px;border-radius:4px;color:#fff;flex:none}
  .m.get{background:var(--get)} .m.post{background:var(--post)}
  .m.patch{background:var(--patch)} .m.delete{background:var(--del)}
  .url{font-size:13px;word-break:break-all}
  .url .b{color:var(--fg-mut)}
  .url .p{font-weight:600}
  .role{font-size:11px;padding:2px 7px;border-radius:99px;background:var(--pill);color:var(--fg-mut);flex:none}
  .role.session{color:var(--accent)}
  .sum{color:var(--fg-mut);font-size:13px;width:100%}
  @media(min-width:900px){.sum{width:auto;margin-left:auto;text-align:right}}
  .ep .body{padding:14px}
  .ep .body p{margin:0 0 12px}
  .ep .body p:last-child{margin-bottom:0}
  .ep h5{margin:14px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-mut)}
  .ep h5:first-child{margin-top:0}
  pre{background:var(--bg-code);border:1px solid var(--line);border-radius:6px;padding:11px 13px;
      overflow-x:auto;font-size:12.5px;margin:0 0 12px}
  pre:last-child{margin-bottom:0}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--fg-mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  td code{background:var(--bg-code);padding:1px 5px;border-radius:4px;font-size:12.5px}
  .errs{font-size:13px;color:var(--fg-mut)}
  ul.plain{margin:0 0 12px;padding-left:20px}
  ul.plain li{margin:3px 0}
  .note{border-left:3px solid var(--accent);background:var(--bg-alt);padding:10px 14px;border-radius:0 6px 6px 0;margin:0 0 16px}
  .note.warn{border-left-color:var(--warn)}
  footer{border-top:1px solid var(--line);padding:24px;color:var(--fg-mut);font-size:13px}
  .tablewrap{overflow-x:auto}
  @media(max-width:860px){.layout{flex-direction:column;padding:16px}nav{width:auto;position:static;max-height:none}}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <h1>Birthday Reminder API</h1>
    <p>Never miss a birthday — Node.js · Express · PostgreSQL · Drizzle · BullMQ</p>
    <div class="baseurl">
      <span>Base URL</span>
      <code>${base}</code>
    </div>
  </div>
</header>

<div class="layout">
<nav>
  <h4>Getting started</h4>
  <a href="#conventions">Conventions</a>
  <a href="#errors">Errors &amp; limits</a>
  <a href="#health">Health</a>
  <h4>Auth</h4>
  <a href="#auth-link">Request magic link</a>
  <a href="#auth-verify">Verify</a>
  <a href="#auth-logout">Log out</a>
  <h4>Account</h4>
  <a href="#me-get">Profile</a>
  <a href="#me-patch">Update settings</a>
  <a href="#me-export">Export</a>
  <a href="#me-delete">Delete account</a>
  <h4>Contacts</h4>
  <a href="#c-list">List</a>
  <a href="#c-tags">Tags</a>
  <a href="#c-get">Detail</a>
  <a href="#c-create">Create</a>
  <a href="#c-patch">Update</a>
  <a href="#c-delete">Delete</a>
  <a href="#c-restore">Restore</a>
  <h4>CSV import</h4>
  <a href="#i-preview">Preview</a>
  <a href="#i-apply">Import</a>
  <h4>Views</h4>
  <a href="#v-upcoming">Upcoming</a>
  <a href="#v-dashboard">Dashboard</a>
  <a href="#v-calendar">Calendar</a>
  <h4>Notifications</h4>
  <a href="#n-log">Delivery log</a>
  <a href="#n-scheduled">Scheduled</a>
  <a href="#n-test">Send a test</a>
  <a href="#n-unsub">Unsubscribe</a>
  <h4>Recipients</h4>
  <a href="#r-list">List</a>
  <a href="#r-add">Add</a>
  <a href="#r-resend">Resend confirmation</a>
  <a href="#r-delete">Remove</a>
  <a href="#r-links">Public links</a>
  <h4>Push</h4>
  <a href="#p-key">VAPID key</a>
  <a href="#p-sub">Subscribe</a>
  <a href="#p-unsub">Unsubscribe</a>
  <a href="#p-list">Devices</a>
</nav>

<main>

<section id="conventions">
  <h2>Conventions</h2>
  <ul class="plain">
    <li><b>Auth:</b> passwordless, by emailed magic link. The session is an <code>HttpOnly</code>
        cookie named <code>br_session</code> — there are no API keys and no bearer tokens.
        Browser clients must send <code>credentials: 'include'</code>.</li>
    <li><b>Content type:</b> <code>application/json</code> for all request bodies, except the two
        CSV import routes (<code>multipart/form-data</code>) and the recipient opt-out form.</li>
    <li><b>Dates:</b> birthdays are stored as separate <code>birthMonth</code> / <code>birthDay</code> /
        <code>birthYear</code> integers, because a birthday is an annual recurrence and the year is
        often unknown. Computed dates come back as <code>YYYY-MM-DD</code>; timestamps are ISO 8601 UTC.</li>
    <li><b>Time zones:</b> all day arithmetic happens in the account's IANA zone, not the server's.
        &ldquo;Today&rdquo; means today where the user is.</li>
    <li><b>29 February</b> is a real birthday and is accepted. In common years the <i>observed</i>
        occurrence is 28 February, used consistently by the calendar, the schedule and
        <code>daysAway</code>.</li>
    <li><b>Ids</b> are UUIDs. A malformed id fails validation with <code>400</code>, not <code>404</code>.</li>
    <li><b>Soft deletes:</b> deleting a contact hides it and cancels its pending reminders; the row
        survives and can be restored. Only <code>DELETE /me</code> destroys data irreversibly.</li>
    <li><b><code>leadDays</code></b> is fixed at 1 and deliberately not writable — it is a column so
        that a second reminder is a migration rather than a refactor.</li>
  </ul>

  <div class="note">
    <b>Testing with curl.</b> When the deployment runs <code>COOKIE_SAMESITE=none</code>, an
    authenticated <code>POST</code>/<code>PATCH</code>/<code>DELETE</code> from curl is rejected with
    <code>403 csrf_origin_missing</code> — curl sends no <code>Origin</code> header, and the browser
    SameSite guarantee that would otherwise protect the request is gone. Send one explicitly:
    <code>-H "Origin: ${base}"</code>.
  </div>
</section>

<section id="errors">
  <h2>Errors &amp; limits</h2>
  <p class="lead">Every error shares one envelope. Validation failures add a <code>details</code> array naming the offending fields.</p>
<pre>{ "error": { "code": "not_found", "message": "Contact not found" } }

{ "error": { "code": "validation_failed", "message": "Invalid request",
    "details": [ { "path": "birthDay", "message": "There is no day 31 in month 2" } ] } }</pre>
  <div class="tablewrap">
  <table>
    <tr><th>Status</th><th>Code</th><th>Meaning</th></tr>
    <tr><td><code>400</code></td><td><code>validation_failed</code></td><td>Body or query failed schema validation</td></tr>
    <tr><td><code>400</code></td><td><code>bad_request</code></td><td>Valid shape, rejected by a rule — including malformed JSON</td></tr>
    <tr><td><code>400</code></td><td><code>upload_failed</code></td><td>CSV rejected; oversized files give &ldquo;That file is too large&rdquo;</td></tr>
    <tr><td><code>401</code></td><td><code>unauthorized</code></td><td>Missing or expired session</td></tr>
    <tr><td><code>403</code></td><td><code>csrf_origin_mismatch</code></td><td>Origin present but not on the allowlist</td></tr>
    <tr><td><code>403</code></td><td><code>csrf_origin_missing</code></td><td>No Origin at all, under <code>SameSite=None</code></td></tr>
    <tr><td><code>404</code></td><td><code>not_found</code></td><td>No such route, or no such row <i>for this account</i></td></tr>
    <tr><td><code>429</code></td><td><code>rate_limited</code></td><td>See the table below</td></tr>
    <tr><td><code>500</code></td><td><code>internal</code></td><td>Unhandled. Details are logged, never returned</td></tr>
  </table>
  </div>
  <p class="errs">A row belonging to another account returns <code>404</code>, not <code>403</code> — the
     API does not confirm that an id it will not serve exists at all.</p>

  <h5 style="color:var(--fg-mut);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:18px 0 6px">Rate limits</h5>
  <div class="tablewrap">
  <table>
    <tr><th>Scope</th><th>Limit</th><th>Window</th></tr>
    <tr><td>Request magic link</td><td>5</td><td>15 min</td></tr>
    <tr><td>Verify link</td><td>20</td><td>15 min</td></tr>
    <tr><td>Contact writes</td><td>60</td><td>1 min</td></tr>
    <tr><td>CSV import</td><td>10</td><td>15 min</td></tr>
    <tr><td>Recipient links</td><td>30</td><td>15 min</td></tr>
  </table>
  </div>
  <p class="errs">Keyed by client IP, with <code>RateLimit-*</code> headers (draft-7). Body caps:
     JSON 256&nbsp;kb, form 16&nbsp;kb, CSV 2&nbsp;MB and 5,000 rows.</p>
</section>

<section id="health">
  <h2>Health</h2>
  ${ep('GET', '/health', 'public', 'Liveness check', `
      <p>Excluded from request logging, so it is safe to poll — as the free-tier keep-alive ping does every 10 minutes.</p>
      <h5>200</h5>
<pre>{ "ok": true, "status": "up" }</pre>`)}
</section>

<section id="auth">
  <h2>Auth</h2>
  <p class="lead">Request a link, click it, receive a session cookie. Nothing else to manage.</p>

  ${ep('POST', '/auth/magic-link', 'public', 'Email a sign-in link', `
      <p>Body: <code>email</code>*, <code>timezone</code> (IANA name, used only when creating a new account).</p>
      <h5>Request</h5>
<pre>{ "email": "you@example.com", "timezone": "Africa/Lagos" }</pre>
      <h5>202</h5>
<pre>{ "ok": true, "message": "If that address is valid, a sign-in link is on its way." }</pre>
      <p class="errs">Responds <code>202</code> whether or not the address is registered, and whether or
         not delivery succeeded — anything else would make this an account-enumeration oracle.</p>`, 'auth-link')}

  ${ep('GET', '/auth/verify?token=', 'public', 'Consume the link, start a session', `
      <p>Single-use. Always redirects; never returns JSON.</p>
      <div class="tablewrap">
      <table>
        <tr><th>Outcome</th><th>Redirect</th></tr>
        <tr><td>Valid</td><td><code>302</code> to <code>WEB_URL/</code> with <code>Set-Cookie: br_session</code></td></tr>
        <tr><td>Invalid or expired</td><td><code>302</code> to <code>WEB_URL/sign-in?error=invalid_link</code></td></tr>
      </table>
      </div>
      <p class="errs">Links are built against <code>APP_URL</code>, so a wrong value there produces mail
         nobody can sign in from. Tokens last 15 minutes by default.</p>`, 'auth-verify')}

  ${ep('POST', '/auth/logout', 'public', 'Revoke the session', `
      <p>Revokes server-side and clears the cookie. Safe to call without a session.</p>
      <h5>200</h5>
<pre>{ "ok": true }</pre>`, 'auth-logout')}
</section>

<section id="account">
  <h2>Account</h2>

  ${ep('GET', '/me', 'session', 'Current user', `
      <h5>200</h5>
<pre>{ "user": { "id": "8f2b…", "email": "you@example.com", "timezone": "Africa/Lagos",
            "notifyHour": 9, "leadDays": 1, "createdAt": "2026-07-31T09:12:04.101Z" } }</pre>`, 'me-get')}

  ${ep('PATCH', '/me', 'session', 'Change zone or delivery hour', `
      <p>Both optional. <code>notifyHour</code> is 0&ndash;23 in the account's own zone. Returns the updated <code>user</code>.</p>
      <h5>Request</h5>
<pre>{ "timezone": "Europe/London", "notifyHour": 7 }</pre>`, 'me-patch')}

  ${ep('GET', '/me/export', 'session', 'Full JSON export', `
      <p>Everything the account holds, as an attachment: profile, <b>all</b> contacts including
         soft-deleted ones, the last 500 delivery-log entries, and registered push devices.</p>
      <p class="errs">Deleted rows are included deliberately — withholding them would make this a
         summary rather than an export.</p>`, 'me-export')}

  ${ep('DELETE', '/me', 'session', 'Irreversible; cascades', `
      <p>Requires the account's own address as confirmation, case-insensitive. Cascades to contacts,
         notifications, recipients and devices. The session cookie is cleared.</p>
      <h5>Request</h5>
<pre>{ "confirmEmail": "you@example.com" }</pre>
      <h5>200</h5>
<pre>{ "ok": true, "deleted": true }</pre>
      <p class="errs"><b>Errors:</b> <code>400</code> when <code>confirmEmail</code> does not match.</p>`, 'me-delete')}
</section>

<section id="contacts">
  <h2>Contacts</h2>

  ${ep('GET', '/contacts', 'session', 'List, filter and sort', `
      <div class="tablewrap">
      <table>
        <tr><th>Query</th><th>Type</th><th>Default</th></tr>
        <tr><td><code>tag</code></td><td>string &le;50, exact match</td><td>&mdash;</td></tr>
        <tr><td><code>q</code></td><td>string &le;100, name search</td><td>&mdash;</td></tr>
        <tr><td><code>sort</code></td><td><code>next_birthday</code> | <code>name</code> | <code>created_at</code></td><td><code>next_birthday</code></td></tr>
        <tr><td><code>includeDeleted</code></td><td><code>true</code> | <code>false</code></td><td><code>false</code></td></tr>
      </table>
      </div>
      <h5>200</h5>
<pre>{ "contacts": [ {
  "id": "c1a…", "name": "Chidi Okafor",
  "birthMonth": 3, "birthDay": 15, "birthYear": 1996,
  "tag": "family", "notes": null, "photoUrl": null,
  "nextBirthday": "2027-03-15", "daysAway": 227,
  "turningAge": 31, "age": 30,
  "deletedAt": null, "createdAt": "…", "updatedAt": "…"
} ] }</pre>
      <p class="errs"><code>next_birthday</code> ordering is computed in the application rather than in
         SQL, so the leap-year rule lives in exactly one place. Ties break by name.</p>`, 'c-list')}

  ${ep('GET', '/contacts/tags', 'session', 'Distinct tags in use', `
      <h5>200</h5>
<pre>{ "tags": ["family", "work"] }</pre>
      <p class="errs">Declared before <code>/contacts/:id</code> so it is not swallowed by the parameter route.</p>`, 'c-tags')}

  ${ep('GET', '/contacts/:id', 'session', 'One contact', `
      <h5>200</h5>
<pre>{ "contact": { … } }</pre>
      <p class="errs"><b>Errors:</b> <code>404</code> unknown id, or a contact belonging to another account.</p>`, 'c-get')}

  ${ep('POST', '/contacts', 'session', 'Add a contact', `
      <h5>Request</h5>
<pre>{ "name": "Chidi Okafor", "birthMonth": 3, "birthDay": 15,
  "birthYear": 1996, "tag": "family", "notes": "Loves jollof" }</pre>
      <div class="tablewrap">
      <table>
        <tr><th>Field</th><th>Rules</th></tr>
        <tr><td><code>name</code></td><td>required, 1&ndash;200 chars, trimmed</td></tr>
        <tr><td><code>birthMonth</code></td><td>required, 1&ndash;12</td></tr>
        <tr><td><code>birthDay</code></td><td>required, 1&ndash;31, checked against the month</td></tr>
        <tr><td><code>birthYear</code></td><td>optional, 1900&ndash;2100, nullable</td></tr>
        <tr><td><code>tag</code></td><td>optional, &le;50</td></tr>
        <tr><td><code>notes</code></td><td>optional, &le;2000</td></tr>
        <tr><td><code>photoUrl</code></td><td>optional, valid URL, &le;1000</td></tr>
      </table>
      </div>
      <p><code>201</code> with the created contact. If the birthday falls inside the reminder window and
         today's sweep has already run, a reminder is scheduled immediately — otherwise a contact added
         the afternoon before their birthday would get nothing.</p>`, 'c-create')}

  ${ep('PATCH', '/contacts/:id', 'session', 'Update fields', `
      <p>Every field optional. Month and day are validated <b>as a pair against the stored values</b>, so
         you cannot walk a 31 January contact into 31 February in two individually-valid requests.
         Moving the birthday re-runs the catch-up check.</p>`, 'c-patch')}

  ${ep('DELETE', '/contacts/:id', 'session', 'Soft delete', `
      <p>Hides the contact and cancels its pending reminders, reporting how many.</p>
      <h5>200</h5>
<pre>{ "ok": true, "cancelledNotifications": 1 }</pre>`, 'c-delete')}

  ${ep('POST', '/contacts/:id/restore', 'session', 'Un-delete', `
      <p>Re-runs the catch-up check for the same reason a create does — a contact restored the day
         before their birthday needs it.</p>
      <p class="errs"><b>Errors:</b> <code>404</code> if the contact does not exist or was never deleted.</p>`, 'c-restore')}
</section>

<section id="import">
  <h2>CSV import</h2>
  <p class="lead">Two steps: preview the file and confirm the column mapping, then apply it. Both are
     <code>multipart/form-data</code> with the file in a field named <code>file</code>.</p>

  ${ep('POST', '/contacts/import/preview', 'session', 'Headers + suggested mapping', `
      <p>Persists nothing.</p>
      <h5>200</h5>
<pre>{
  "headers": ["Full Name", "DOB", "Group"],
  "sampleRows": [ { "Full Name": "Chidi Okafor", "DOB": "15/03/1996", "Group": "family" } ],
  "totalRows": 128,
  "suggestedMapping": { "name": "Full Name", "birthDate": "DOB", "birthDay": null,
                        "birthMonth": null, "birthYear": null, "tag": "Group", "notes": null }
}</pre>`, 'i-preview')}

  ${ep('POST', '/contacts/import', 'session', 'Apply a confirmed mapping', `
      <p>Send the file again plus a <code>mapping</code> field — a JSON string. Supply either
         <code>birthDate</code> (one whole-date column) or the separate
         <code>birthDay</code>/<code>birthMonth</code>/<code>birthYear</code> columns. Only
         <code>name</code> is required.</p>
      <h5>201</h5>
<pre>{
  "imported": 126, "skippedAsDuplicates": 1, "remindersScheduled": 2,
  "failedRows": [ { "row": 44, "message": "Could not read a date from \\"n/a\\"" } ],
  "contacts": [ … ], "today": "2026-07-31"
}</pre>
      <p class="errs">Unreadable rows are reported rather than aborting the run — one malformed date in a
         300-row export should not cost the other 299. <code>contacts</code> is capped at the first 50.
         Ambiguous slash and dot dates are read <b>day-first</b> (<code>03/04</code> is 3 April); ISO is
         tried first because it is unambiguous.</p>`, 'i-apply')}
</section>

<section id="views">
  <h2>Views</h2>
  <p class="lead">Read-only projections for the UI.</p>

  ${ep('GET', '/upcoming?window=30', 'session', 'Birthdays in the next N days', `
      <p><code>window</code> is 1&ndash;366, default 30.</p>
      <h5>200</h5>
<pre>{ "window": 30, "contacts": [ … ] }</pre>`, 'v-upcoming')}

  ${ep('GET', '/dashboard', 'session', 'Summary buckets', `
      <h5>200</h5>
<pre>{ "totalContacts": 128, "today": [], "tomorrow": [], "thisWeek": [],
  "thisMonth": [], "next": null, "mostRecentlyAdded": null }</pre>
      <p class="errs">Buckets overlap by design — a birthday today is also in <code>thisWeek</code>.
         Every array holds full contact objects.</p>`, 'v-dashboard')}

  ${ep('GET', '/calendar?year=2027', 'session', 'Per-day counts for a heatmap', `
      <p><code>year</code> defaults to the current year in the account's zone. Only days that actually
         have a birthday appear — a heatmap fills the rest with zero.</p>
      <h5>200</h5>
<pre>{ "year": 2027, "total": 128,
  "days": [ { "date": "2027-03-15", "count": 2, "names": ["Ada", "Chidi"] } ],
  "busiestDay": { "date": "2027-03-15", "count": 2, "names": ["Ada", "Chidi"] } }</pre>
      <p class="errs">Keyed on the <i>observed</i> occurrence, so in a common year a 29 February contact
         appears under 28 February — the same day the reminder actually fires.</p>`, 'v-calendar')}
</section>

<section id="notifications">
  <h2>Notifications</h2>

  ${ep('GET', '/notifications', 'session', 'Delivery log — what has happened', `
      <div class="tablewrap">
      <table>
        <tr><th>Query</th><th>Type</th><th>Default</th></tr>
        <tr><td><code>status</code></td><td><code>pending</code> | <code>sent</code> | <code>failed</code> | <code>skipped</code></td><td>all</td></tr>
        <tr><td><code>limit</code></td><td>1&ndash;500</td><td>100</td></tr>
      </table>
      </div>
      <h5>200</h5>
<pre>{ "notifications": [ {
  "id": "…", "contactId": "…", "contactName": "Chidi Okafor",
  "occurrenceYear": 2027, "leadDays": 1, "channel": "email",
  "status": "sent", "scheduledFor": "…", "sentAt": "…",
  "attempts": 1, "error": null
} ] }</pre>
      <p class="errs"><code>skipped</code> means the reminder aged past the 12-hour grace window before it
         could be delivered — a birthday reminder three days late is worse than none.
         <code>failed</code> means the retries were exhausted.</p>`, 'n-log')}

  ${ep('GET', '/notifications/scheduled?window=30', 'session', 'What is coming', `
      <p>Derived from contacts rather than read from the notifications table, because the sweep does not
         claim a row until the morning a reminder is due — a purely table-driven view would show almost nothing.</p>
      <h5>200</h5>
<pre>{ "window": 30, "scheduled": [ {
  "contactId": "…", "contactName": "Chidi Okafor",
  "occurrenceDate": "2027-03-15", "occurrenceYear": 2027,
  "remindOn": "2027-03-14", "remindAt": "2027-03-14T08:00:00.000Z",
  "daysUntilReminder": 226, "turningAge": 31, "claimedStatus": null
} ] }</pre>
      <p class="errs"><code>claimedStatus</code> is <code>null</code> until the sweep claims the reminder.
         <code>pending</code> means it is queued right now.</p>`, 'n-scheduled')}

  ${ep('POST', '/notifications/test', 'session', 'Send yourself a sample', `
      <p>Takes no body. Sends a sample reminder to the signed-in address.</p>
      <h5>200</h5>
<pre>{ "ok": true, "messageId": "&lt;abc@smtp&gt;", "sentTo": "you@example.com" }</pre>
      <p class="errs">Sent directly rather than through the queue, and <b>writes no row</b> — a test send
         must never occupy an idempotency key, or it would suppress the real reminder for that contact and year.</p>`, 'n-test')}

  ${ep('GET', '/notifications/unsubscribe?u=&amp;s=', 'public', 'HTML — opened from email', `
      <p>Authenticated by an HMAC signature rather than a session, because it is opened from a mail client.
         Returns <code>400</code> HTML for a bad signature.</p>
      <p class="errs">Deliberately does not unsubscribe anything on <code>GET</code> — it explains how to
         stop reminders instead. Mail clients prefetch links, and a destructive <code>GET</code> would fire on prefetch.</p>`, 'n-unsub')}
</section>

<section id="recipients">
  <h2>Recipients</h2>
  <p class="lead">Extra addresses that receive copies of the reminders — a partner or sibling who should
     also know. Capped at 5 per account.</p>

  ${ep('GET', '/recipients', 'session', 'List, with the ceiling', `
      <h5>200</h5>
<pre>{ "recipients": [ { "id": "3a91…", "email": "partner@example.com",
                    "label": "Ada", "confirmed": true, "createdAt": "…" } ],
  "max": 5 }</pre>`, 'r-list')}

  ${ep('POST', '/recipients', 'session', 'Add and send a confirmation', `
      <p><code>label</code> is optional, &le;60 chars. The recipient receives nothing else until they confirm.</p>
      <h5>Request</h5>
<pre>{ "email": "partner@example.com", "label": "Ada" }</pre>
      <p class="errs"><b>Errors:</b> <code>400</code> if the address is your own — you already receive
         these — or if the ceiling of 5 is reached.</p>`, 'r-add')}

  ${ep('POST', '/recipients/:id/resend', 'session', 'Re-send the confirmation', `
      <p class="errs"><b>Errors:</b> <code>400</code> if already confirmed · <code>404</code> if the
         recipient belongs to another account.</p>`, 'r-resend')}

  ${ep('DELETE', '/recipients/:id', 'session', 'Remove a recipient', `
      <h5>200</h5>
<pre>{ "ok": true }</pre>`, 'r-delete')}

  <details class="ep" id="r-links">
    <summary><span class="m get">GET</span>
      <span class="url"><span class="b">${base}</span><span class="p">/recipients/confirm</span> &middot; <span class="p">/remove</span></span>
      <span class="role public">public</span><span class="sum">HTML — opened by people with no account</span></summary>
    <div class="body">
      <p>HMAC-signed, taking <code>r</code> (recipient id) and <code>s</code> (signature) in the query string.</p>
      <div class="tablewrap">
      <table>
        <tr><th>Route</th><th>Behaviour</th></tr>
        <tr><td><code>GET /recipients/confirm</code></td><td>Confirms the address. A <code>GET</code> is fine — confirming is not destructive</td></tr>
        <tr><td><code>GET /recipients/remove</code></td><td>Renders a confirmation <b>button</b>. Changes nothing</td></tr>
        <tr><td><code>POST /recipients/remove</code></td><td>Form-urlencoded <code>r</code> and <code>s</code>. Performs the removal</td></tr>
      </table>
      </div>
      <p class="errs">Removal is split across two requests for the same reason unsubscribe is: a mail client
         prefetching the link must not be able to remove someone by accident.</p>
    </div>
  </details>
</section>

<section id="push">
  <h2>Push</h2>
  <p class="lead">Web Push over VAPID. The channel is optional — with no keys configured the server reports
     it disabled rather than failing to start, and email remains the guaranteed channel.</p>

  ${ep('GET', '/push/public-key', 'public', 'VAPID key + whether push is on', `
      <p>Readable without a session so the frontend can decide whether to offer the
         &ldquo;enable notifications&rdquo; prompt before sign-in.</p>
      <h5>200</h5>
<pre>{ "enabled": true, "publicKey": "BCS-izv…" }</pre>
      <p class="errs"><code>publicKey</code> is <code>null</code> when disabled. The key is withheld rather
         than served inertly — handing out a key the server cannot send with would let a browser register a
         subscription that silently never receives anything.</p>`, 'p-key')}

  ${ep('POST', '/push/subscribe', 'session', 'Register a device', `
      <p>The output of <code>PushSubscription.toJSON()</code> in the browser. Upserts, so re-subscribing the
         same device is idempotent.</p>
      <h5>Request</h5>
<pre>{ "endpoint": "https://fcm.googleapis.com/fcm/send/…",
  "keys": { "p256dh": "BN…", "auth": "k9…" } }</pre>
      <h5>201</h5>
<pre>{ "ok": true, "devices": 2 }</pre>
      <p class="errs"><b>Errors:</b> <code>400</code> if push is not configured on the server.</p>`, 'p-sub')}

  ${ep('POST', '/push/unsubscribe', 'session', 'Remove a device', `
      <h5>Request</h5>
<pre>{ "endpoint": "https://fcm.googleapis.com/fcm/send/…" }</pre>
      <h5>200</h5>
<pre>{ "ok": true, "removed": true, "devices": 1 }</pre>`, 'p-unsub')}

  ${ep('GET', '/push/subscriptions', 'session', 'Registered devices', `
      <h5>200</h5>
<pre>{ "enabled": true, "devices": [ { "id": "c7f0…", "endpointTail": "aBc123XyZ890",
                                 "userAgent": "Mozilla/5.0 …", "createdAt": "…" } ] }</pre>
      <p class="errs">Endpoints are <b>never echoed in full</b> — an endpoint is a bearer capability for that
         device. The last 12 characters are enough to tell two devices apart.</p>`, 'p-list')}
</section>

</main>
</div>

<footer>
  <div class="wrap">
    Birthday Reminder API &middot; <code>${base}</code> &middot;
    Liveness at <a href="/health">/health</a> &middot;
    Full reference in <code>docs/API.md</code>.
  </div>
</footer>

</body>
</html>`;
}
