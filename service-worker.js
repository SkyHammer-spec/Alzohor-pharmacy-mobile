// ── service-worker.js ────────────────────────────────────────────────────
// Only caches the APP SHELL (the code itself), never the data. This means
// the app can always open and show its login/UI even with zero connection
// — actual data freshness/caching (the "last synced at" logic) is handled
// separately in app.js, which deliberately does NOT go through this cache,
// since data needs to always try live-fetch first.

const CACHE_NAME = 'alzouhor-mobile-shell-v4';
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
