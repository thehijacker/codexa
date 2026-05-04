// Codexa Service Worker
// Caches app shell for offline use. EPUB files are NOT cached (too large, user-specific).

const CACHE_VERSION = 'br-v21';
const APP_SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/readerv4.html',
  '/settings.html',
  '/opds.html',
  '/css/main.css',
  '/css/reader.css',
  '/js/api.js',
  '/js/ui.js',
  '/js/library.js',
  '/js/sidebar.js',
  '/js/i18n.js',
  '/js/opds.js',
  '/js/reader_v4.js',
  '/images/codexa.svg',
  '/images/codexa_bw.svg',
  '/images/all_library.svg',
  '/images/all_library_bw.svg',
  '/images/currently_reading.svg',
  '/images/currently_reading_bw.svg',
  '/images/shelf.svg',
  '/images/shelf_bw.svg',
  '/images/settings.svg',
  '/images/settings_bw.svg',
  '/images/logout.svg',
  '/images/logout_bw.svg',
  '/images/language.svg',
  '/images/language_bw.svg',
  '/images/online_library.svg',
  '/images/online_library_bw.svg',
  '/images/book_upload.svg',
  '/images/book_upload_bw.svg',
  '/images/edit.svg',
  '/images/edit_bw.svg',
  '/images/search.svg',
  '/images/search_bw.svg',
  '/images/folder.svg',
  '/images/folder_bw.svg',
  '/images/delete.svg',
  '/images/delete_bw.svg',
  '/images/download.svg',
  '/images/download_bw.svg',
  '/images/read.svg',
  '/images/read_bw.svg',
  '/images/save.svg',
  '/images/save_bw.svg',
  '/images/chapters.svg',
  '/images/chapters_bw.svg',
  '/images/find.svg',
  '/images/find_bw.svg',
  '/images/percentage.svg',
  '/images/percentage_bw.svg',
  '/images/back.svg',
  '/images/back_bw.svg',
  '/images/fullscreen.svg',
  '/images/fullscreen_bw.svg',
  '/images/fullscreen_exit.svg',
  '/images/fullscreen_exit_bw.svg',
  '/images/chapter_page.svg',
  '/images/chapter_page_bw.svg',
  '/images/book_page.svg',
  '/images/book_page_bw.svg',
  '/images/chapter_end.svg',
  '/images/chapter_end_bw.svg',
  '/images/book_end.svg',
  '/images/book_end_bw.svg',
  '/images/chapter_progress.svg',
  '/images/chapter_progress_bw.svg',
  '/images/book_progress.svg',
  '/images/book_progress_bw.svg',
  '/images/time_end_chapter.svg',
  '/images/time_end_chapter_bw.svg',
  '/images/time_end_book.svg',
  '/images/time_end_book_bw.svg',
  '/images/time.svg',
  '/images/time_bw.svg',
  '/images/book_title.svg',
  '/images/book_title_bw.svg',
  '/images/book_author.svg',
  '/images/book_author_bw.svg',
  '/images/chapter_title.svg',
  '/images/chapter_title_bw.svg',
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
