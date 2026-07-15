// ── service-worker.js ────────────────────────────────────────────────────
// Only caches the APP SHELL (the code itself), never the data. This means
// the app can always open and show its login/UI even with zero connection
// — actual data freshness/caching (the "last synced at" logic) is handled
// separately in app.js, which deliberately does NOT go through this cache,
// since data needs to always try live-fetch first.

const CACHE_NAME = 'alzouhor-mobile-shell-v14';
const SHELL_FILES = [
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Clean up any old cache versions from previous deployments.
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept Google Drive data requests — those must always go to
  // the network directly, so app.js's own online/offline + cache logic
  // (which shows "last synced at HH:MM") works correctly. Only the app's
  // own shell files are served from this cache.
  if (url.hostname.includes('drive.google.com')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// ── Push notifications ──────────────────────────────────────────────────
// Fired by the OS/browser when the push server sends a notification — this
// runs even if the PWA itself isn't open, as long as the service worker is
// still registered (which it stays, once the app has been opened at least
// once and notification permission was granted).
self.addEventListener('push', (event) => {
  let payload = { title: 'Al Zouhor Pharmacy', body: 'New alert', tag: 'general' };
  try { payload = event.data.json(); } catch (e) { /* fall back to default above */ }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,          // same tag replaces the previous notification of that type instead of stacking endlessly
      icon: './icon-192.png',
      badge: './icon-192.png',
      renotify: true,
    })
  );
});

// Tapping the notification focuses an existing open tab if there is one,
// otherwise opens a new one — standard PWA notification-click pattern.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
