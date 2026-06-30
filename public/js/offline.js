/**
 * offline.js — IndexedDB metadata store + Service Worker download coordinator.
 * Manages which books are available for offline reading.
 */

import { log } from './logger.js';

const DB_NAME  = 'codexa-offline';
const DB_VER   = 1;
const STORE    = 'books';

export const isOfflineSupported =
  'serviceWorker' in navigator && 'caches' in window && 'indexedDB' in window;

let _db = null;

// Pending download promises keyed by bookId
const _pending = new Map();

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
    req.onerror    = e => reject(e.target.error);
  });
}

export async function saveBookMeta(book) {
  const db = await openDB();
  // downloadStatus must reflect whether the EPUB blob is actually cached.
  // Callers that only persist metadata (opening a book, info modal, background
  // refresh) pass no downloadStatus — those must NOT claim 'complete', otherwise
  // the reader's auto-download guard thinks the book is already cached and never
  // stores the blob. Preserve any existing status; default new entries to 'meta'.
  let status = book.downloadStatus;
  if (!status) {
    try {
      const existing = await getBookMeta(book.id);
      status = existing?.downloadStatus || 'meta';
    } catch { status = 'meta'; }
  }
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      id:             book.id,
      title:          book.title          || '',
      author:         book.author         || '',
      cover_path:     book.cover_path     || null,
      file_hash:      book.file_hash      || '',
      percentage:     book.percentage     || 0,
      file_size:      book.file_size      || 0,
      cachedAt:       Date.now(),
      downloadStatus: status,
      description:    book.description    || null,
      genres:         book.genres         || null,
      pages:          book.pages          || null,
      publisher:      book.publisher      || null,
      language:       book.language       || null,
    });
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function getBookMeta(bookId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(Number(bookId));
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function getAllBooks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function removeBook(bookId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(Number(bookId));
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
}

const BOOKS_CACHE_NAME = 'codexa-books-v2';

/** Load a previously downloaded EPUB from the service-worker books cache. */
export async function fetchOfflineBookFile(bookId) {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(BOOKS_CACHE_NAME);
    const res = await cache.match(`/offline/books/${Number(bookId)}/epub`);
    if (!res?.ok) return null;
    return res.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Return a Set of bookIds whose EPUB blob is actually present in the books cache.
 * This is the source of truth for "is this book available offline" — IndexedDB
 * downloadStatus can drift out of sync (e.g. metadata saved without a blob).
 */
export async function getCachedBookIds() {
  const ids = new Set();
  if (!('caches' in window)) return ids;
  try {
    const cache = await caches.open(BOOKS_CACHE_NAME);
    const keys = await cache.keys();
    for (const req of keys) {
      const m = new URL(req.url).pathname.match(/^\/offline\/books\/(\d+)\/epub$/);
      if (m) ids.add(Number(m[1]));
    }
  } catch { /* ignore */ }
  return ids;
}

export async function isBookDownloaded(bookId) {
  // Truth is the actual cached blob, not the IndexedDB flag.
  if ('caches' in window) {
    try {
      const cache = await caches.open(BOOKS_CACHE_NAME);
      const res = await cache.match(`/offline/books/${Number(bookId)}/epub`);
      if (res) return true;
    } catch { /* fall through to IDB */ }
  }
  try {
    const meta = await getBookMeta(Number(bookId));
    return meta?.downloadStatus === 'complete';
  } catch {
    return false;
  }
}

export async function setDownloadStatus(bookId, status) {
  try {
    const meta = await getBookMeta(Number(bookId));
    if (!meta) return;
    await saveBookMeta({ ...meta, downloadStatus: status });
  } catch { /* non-critical */ }
}

// ── SW message listener ───────────────────────────────────────────────────────

if (isOfflineSupported) {
  navigator.serviceWorker.addEventListener('message', e => {
    const { type, bookId, message } = e.data || {};
    log('[offline] SW message received:', type, bookId);
    if (type === 'CACHE_BOOK_DONE' || type === 'CACHE_BOOK_ERROR') {
      const handlers = _pending.get(bookId);
      _pending.delete(bookId);
      if (type === 'CACHE_BOOK_DONE') handlers?.resolve();
      else handlers?.reject(new Error(message || 'Download failed'));
    }
  });
}

// ── Download / delete ─────────────────────────────────────────────────────────

/**
 * Download a book's EPUB and cover to the device via the service worker.
 * Saves metadata to IndexedDB on completion.
 */
export async function downloadBook(book, token) {
  if (!isOfflineSupported) throw new Error('Offline not supported');

  // Use the active SW from the registration — more reliable than .controller,
  // which is null when the page was loaded before the SW took control.
  const registration = await navigator.serviceWorker.ready;
  const sw = registration.active;
  if (!sw) throw new Error('Service worker not active — reload the page');

  await saveBookMeta({ ...book, downloadStatus: 'downloading' });

  return new Promise((resolve, reject) => {
    let timer;

    const onDone = async () => {
      clearTimeout(timer);
      try { await saveBookMeta({ ...book, downloadStatus: 'complete' }); } catch { /* ignore */ }
      resolve();
    };

    const onError = async (err) => {
      clearTimeout(timer);
      await setDownloadStatus(book.id, 'error');
      reject(err);
    };

    _pending.set(book.id, { resolve: onDone, reject: onError });

    // 5-minute timeout guard
    timer = setTimeout(() => {
      if (_pending.has(book.id)) {
        _pending.delete(book.id);
        onError(new Error('Download timed out'));
      }
    }, 5 * 60 * 1000);

    sw.postMessage({
      type:      'CACHE_BOOK',
      bookId:    book.id,
      token,
      coverPath: book.cover_path || null,
    });
  });
}

/**
 * Remove a book from local offline storage.
 */
export async function deleteDownload(bookId) {
  if (!isOfflineSupported) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const sw = registration?.active;
  if (sw) sw.postMessage({ type: 'DELETE_BOOK', bookId: Number(bookId) });
  await removeBook(bookId);
}

/**
 * Silently purge IndexedDB entries and SW cache for books no longer in the library.
 * Pass a Set of book IDs that are currently in the user's library (the source of truth).
 * Runs entirely in the background — never throws, never blocks the caller.
 */
export async function pruneStaleDownloads(liveIds) {
  if (!isOfflineSupported) return;
  const stored = await getAllBooks();
  const stale  = stored.filter(b => !liveIds.has(b.id));
  if (!stale.length) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const sw = registration?.active;
  for (const entry of stale) {
    if (sw) sw.postMessage({ type: 'DELETE_BOOK', bookId: Number(entry.id) });
    await removeBook(entry.id);
    log('[offline] pruned stale download bookId:', entry.id, entry.title || '');
  }
}

/**
 * Silently download any "Currently Reading" books that aren't yet cached.
 */
export async function autoDownloadCurrentlyReading(books, token) {
  if (!isOfflineSupported) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  if (!registration?.active) return;

  // Skip auto-download for a book that was just opened in peek mode
  let lastPeekId = null;
  try {
    const v = sessionStorage.getItem('br_last_peek_book_id');
    if (v) { lastPeekId = Number(v); sessionStorage.removeItem('br_last_peek_book_id'); }
  } catch { /* ignore */ }

  const currentlyReading = books.filter(b => {
    const p = b.percentage || 0;
    return p > 0 && p < 1;
  });
  if (!currentlyReading.length) return;

  // Base "already cached" on the real blob cache, not the IDB flag, so books
  // whose status drifted to 'complete' without a blob get re-downloaded.
  const doneIds = await getCachedBookIds();

  for (const book of currentlyReading) {
    if (doneIds.has(book.id)) continue;
    if (lastPeekId && book.id === lastPeekId) continue;
    downloadBook(book, token).catch(() => {});
  }
}
