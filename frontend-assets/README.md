# Frontend assets

These two files belong in the **frontend** app's `public/` directory, not in
this repo's build. They live here because the service worker's `push` handler
has to agree with the payload this backend sends — that contract is defined by
`src/services/sender.ts`, so the reference implementation ships alongside it.

Copy both into the Vite app's `public/`, then register the worker:

```ts
const reg = await navigator.serviceWorker.register('/service-worker.js');

// Ask the API for the key rather than hardcoding it — push is disabled
// server-side when VAPID keys are absent, and the UI should respect that.
const { enabled, publicKey } = await fetch(`${API}/push/public-key`).then((r) => r.json());
if (!enabled) return;

const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: publicKey,
});

await fetch(`${API}/push/subscribe`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(sub),          // toJSON() gives {endpoint, keys:{p256dh, auth}}
});
```

Only prompt for notification permission **after** the user has added their
first contact. A permission prompt on first paint is the fastest way to get
permanently denied, and a denied prompt cannot be re-asked.

## Payload contract

`sender.ts` posts this JSON as the push body:

```json
{
  "title": "Tomorrow: Chidi's birthday (turning 31)",
  "body": "Loves jollof. Owes me a call.",
  "url": "https://app.example.com/contacts/<uuid>",
  "tag": "birthday-<contactId>-<occurrenceYear>"
}
```

`tag` collapses repeats: two reminders about the same contact replace each
other on the lock screen rather than stacking. `title` carries the whole
message for the same reason the email subject does (§5.3) — on a lock screen
it is often all that is visible.

## Icons

`manifest.webmanifest` references `/icon-192.png`, `/icon-512.png` and a
`/icon-512-maskable.png`. Supply real ones — the maskable variant needs its
content inside the safe zone (a centre circle of 80% diameter), or Android will
crop it badly.
