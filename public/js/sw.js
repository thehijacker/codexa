// Codexa Service Worker
// Caches app shell for offline use. EPUB files are NOT cached (too large, user-specific).

const CACHE_VERSION = 'br-v11';
const APP_SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/reader.html',
  '/settings.html',
  '/opds.html',
  '/css/main.css',
  '/css/reader.css',
  '/js/api.js',
  '/js/ui.js',
  '/js/library.js',
  '/js/reader.js',
  '/icons/android-chrome-192x192.png',
  '/icons/android-chrome-512x512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32x32.png',
  '/manifest.json',
];

// ── Install: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API/EPUB, cache-first for app shell ──────────────
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept API calls, EPUB files, covers — always network
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/covers/') ||
      url.pathname.startsWith('/user-fonts/') ||
      url.hostname !== self.location.hostname) {
    return;
  }

  // Cache-first for app shell assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(response => {
        if (response.ok && e.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached); // offline fallback
      return cached || networkFetch;
    })
  );
});
