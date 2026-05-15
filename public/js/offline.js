/**
 * offline.js — IndexedDB metadata store + Service Worker download coordinator.
 * Manages which books are available for offline reading.
 */

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
      downloadStatus: book.downloadStatus || 'complete',
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

export async function isBookDownloaded(bookId) {
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
    console.log('[offline] SW message received:', type, bookId);
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
 * Silently download any "Currently Reading" books that aren't yet cached.
 */
export async function autoDownloadCurrentlyReading(books, token) {
  if (!isOfflineSupported) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  if (!registration?.active) return;

  const currentlyReading = books.filter(b => {
    const p = b.percentage || 0;
    return p > 0 && p < 1;
  });
  if (!currentlyReading.length) return;

  const existing = await getAllBooks().catch(() => []);
  const doneIds  = new Set(existing.filter(b => b.downloadStatus === 'complete').map(b => b.id));

  for (const book of currentlyReading) {
    if (doneIds.has(book.id)) continue;
    downloadBook(book, token).catch(() => {});
  }
}
