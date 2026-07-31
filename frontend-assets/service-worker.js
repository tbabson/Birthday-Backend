/* eslint-env serviceworker */
/**
 * Birthday Reminder service worker.
 *
 * Two jobs: receive push reminders, and keep the app shell available offline
 * so a cold open on bad mobile data still paints something (§6.6 — Lagos
 * mobile data is the realistic condition).
 *
 * Deploy from the frontend's public/ directory. The push payload contract is
 * defined by the backend's src/services/sender.ts.
 */

const CACHE = 'birthday-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  // Take over immediately rather than waiting for every tab to close — a stale
  // worker that cannot read the current push payload shape is worse than a
  // brief inconsistency.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Network-first for navigation, falling back to the cached shell. Never cache
 * API responses: a stale contact list showing the wrong "days away" is worse
 * than a spinner, and it is other people's personal data sitting in a cache.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request)),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Birthday reminder', body: 'Someone has a birthday tomorrow.' };
  }

  const title = payload.title || 'Birthday reminder';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      // Collapses repeats for the same contact and year.
      tag: payload.tag || 'birthday',
      renotify: false,
      icon: '/icon-192.png',
      badge: '/icon-badge.png',
      data: { url: payload.url || '/' },
      // The whole point is that this is seen the evening before.
      requireInteraction: false,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  // Focus an existing tab if one is open rather than piling up windows.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

/**
 * Push services rotate subscriptions without warning. Without this handler the
 * device silently stops receiving reminders and nobody finds out until a
 * birthday is missed.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: event.oldSubscription?.options?.applicationServerKey })
      .then((subscription) =>
        fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription),
        }),
      ),
  );
});
