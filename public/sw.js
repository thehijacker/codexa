// Codexa Service Worker
// Caches app shell for offline use. EPUBs are cached on demand in BOOKS_CACHE.

const CACHE_VERSION = 'br-v20260618007';
const BOOKS_CACHE   = 'codexa-books-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/readerv4.html',
  '/settings.html',
  '/opds.html',
  '/css/main.css',
  '/css/reader.css',
  '/js/app.js',
  '/js/login.js',
  '/js/router.js',
  '/js/settings.js',
  '/js/offline.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/library.js',
  '/js/sidebar.js',
  '/js/i18n.js',
  '/js/opds.js',
  '/locales/en.json',
  '/locales/de.json',
  '/locales/es.json',
  '/locales/fr.json',
  '/locales/it.json',
  '/locales/pt.json',
  '/locales/sl.json',
  '/images/codexa.svg',
  '/images/codexa_bw.svg',
  '/images/all_library.svg',
  '/images/all_library_bw.svg',
  '/images/currently_reading.svg',
  '/images/currently_reading_bw.svg',
  '/images/dictionary.svg',
  '/images/dictionary_bw.svg',
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
  '/images/bookmark.svg',
  '/images/bookmark_bw.svg',
  '/images/highlight.svg',
  '/images/highlight_bw.svg',
  '/images/statistics.svg',
  '/images/statistics_bw.svg',
  '/images/offline.svg',
  '/images/offline_bw.svg',
  '/images/peek.svg',
  '/images/peek_bw.svg',
  '/images/zoom.svg',
  '/images/zoom_bw.svg',
  '/images/battery.svg',
  '/images/battery_bw.svg',
  '/images/battery_charging.svg',
  '/images/battery_charging_bw.svg',
  '/images/copy.svg',
  '/images/copy_bw.svg',
  '/images/add_note.svg',
  '/images/add_note_bw.svg',
  '/images/close.svg',
  '/images/close_bw.svg',
  '/images/density_compact.svg',
  '/images/density_compact_bw.svg',
  '/images/density_normal.svg',
  '/images/density_normal_bw.svg',
  '/images/density_large.svg',
  '/images/density_large_bw.svg',
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

// ── Activate: remove old app-shell caches (preserve books cache) ──────────────
self.addEventListener('activate', (e) => {
  console.log('[sw] activate version:', CACHE_VERSION);
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== BOOKS_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: books cache → network, cache-first for app shell ──────────────────
let _swVersionLogged = false;
self.addEventListener('fetch', (e) => {
  if (!_swVersionLogged) { _swVersionLogged = true; console.log('[sw] fetch version:', CACHE_VERSION); }
  const url = new URL(e.request.url);

  // Intercept EPUB file requests — serve from books cache when available
  const fileMatch = url.pathname.match(/^\/api\/books\/(\d+)\/file$/);
  if (fileMatch && url.hostname === self.location.hostname) {
    const bookId = parseInt(fileMatch[1], 10);
    e.respondWith(
      caches.open(BOOKS_CACHE).then(c =>
        c.match(`/offline/books/${bookId}/epub`).then(cached => cached || fetch(e.request))
      )
    );
    return;
  }

  // Intercept cover requests — serve from books cache when available
  if (url.pathname.startsWith('/covers/') && url.hostname === self.location.hostname) {
    e.respondWith(
      caches.open(BOOKS_CACHE).then(c =>
        c.match(e.request).then(cached => cached || fetch(e.request))
      )
    );
    return;
  }

  // Cache user fonts: network-first so updates apply, cache fallback for offline
  if (url.pathname.startsWith('/user-fonts/') && url.hostname === self.location.hostname) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request).then(r => r || Response.error()))
    );
    return;
  }

  // Cross-origin: let browser handle natively (SW can't intercept these anyway).
  if (url.hostname !== self.location.hostname) {
    return;
  }

  // API calls: let the browser handle natively. On Chrome 83 Android WebView,
  // routing through e.respondWith(fetch(e.request)) causes the response to hang
  // silently. Native bypass (same as br-v51) is safe here because reader_v4.js
  // is also bypassed, so there is no large SW IPC transfer that would corrupt routing.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Never serve the reader bundle via SW respondWith. On Chrome 83 Android WebView,
  // transferring a large file (287 KB) through the SW IPC corrupts the native-fetch
  // routing — any subsequent SW-returned-without-respondWith fetch hangs silently.
  // The HTML loads the bundle with a ?v= cache-buster so the browser's own HTTP
  // cache handles freshness; the SW APP_SHELL entry (without ?v=) never matched anyway.
  if (url.pathname === '/js/reader_v4.js') {
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
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// ── Messages: book download / delete ─────────────────────────────────────────
self.addEventListener('message', (e) => {
  if (!e.data?.type) return;
  if (e.data.type === 'CACHE_BOOK')   e.waitUntil(handleCacheBook(e));
  if (e.data.type === 'DELETE_BOOK')  e.waitUntil(handleDeleteBook(e));
});

async function handleCacheBook(e) {
  const { bookId, token, coverPath } = e.data;
  // e.source is the WindowClient that sent the message — use it directly.
  // self.clients.get() only finds *controlled* clients, which may not include
  // this tab if the SW just activated and hasn't claimed it yet.
  const sourceClient = e.source;

  function notify(type, extra = {}) {
    const msg = { type, bookId, ...extra };
    if (sourceClient) {
      try { sourceClient.postMessage(msg); return; } catch { /* fall through */ }
    }
    // Fallback: broadcast to all windows including uncontrolled ones
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(cs => cs.forEach(c => c.postMessage(msg)));
  }

  try {
    console.log('[sw] CACHE_BOOK start bookId:', bookId);
    const res = await fetch(`/api/books/${bookId}/file`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const total = parseInt(res.headers.get('content-length') || '0', 10);
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      notify('DOWNLOAD_PROGRESS', { loaded, total });
    }

    // Reassemble and cache
    const buf = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }

    const booksCache = await caches.open(BOOKS_CACHE);
    await booksCache.put(
      `/offline/books/${bookId}/epub`,
      new Response(buf.buffer, {
        headers: {
          'Content-Type':   'application/epub+zip',
          'Content-Length': String(loaded),
        },
      })
    );

    // Cache cover image if provided (non-fatal)
    if (coverPath) {
      try {
        const coverRes = await fetch(`/covers/${coverPath}`);
        if (coverRes.ok) await booksCache.put(`/covers/${coverPath}`, coverRes);
      } catch { /* cover caching is non-critical */ }
    }

    console.log('[sw] CACHE_BOOK done bookId:', bookId);
    notify('CACHE_BOOK_DONE');
  } catch (err) {
    console.error('[sw] CACHE_BOOK error bookId:', bookId, err.message);
    notify('CACHE_BOOK_ERROR', { message: err.message });
  }
}

async function handleDeleteBook(e) {
  const { bookId } = e.data;
  try {
    const booksCache = await caches.open(BOOKS_CACHE);
    await booksCache.delete(`/offline/books/${bookId}/epub`);
  } catch { /* ignore */ }
}
