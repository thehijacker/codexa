/**
 * progress-outbox.js — durable queue for reading progress made while offline.
 *
 * When a position save can't reach the server (offline / LAN-without-internet),
 * the reader records the latest position here keyed by bookId. On reconnect
 * (app:network-restored / 'online') or next app load, flushProgressOutbox()
 * pushes each pending position to the app's progress store AND KOReader sync,
 * so offline reading syncs without having to reopen the book.
 *
 * The reader cannot compute the authoritative KOReader docKey while offline
 * (IndexedDB metadata has no file_hash_md5 / kosync_hash), so we store only the
 * stable bits (bookId, pct, cfi, xpointer) and resolve file_hash + docKey from
 * the server at flush time.
 */
import { apiFetch } from './api.js';

const OUTBOX_KEY = 'br_progress_outbox';
const EPS = 0.005;

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '{}') || {}; }
  catch { return {}; }
}
function writeOutbox(map) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

/** Record (or advance) the pending offline position for a book. */
export function queueProgress(entry) {
  if (!entry || entry.bookId == null) return;
  if (!(entry.pct > 0)) return;
  const map  = readOutbox();
  const prev = map[entry.bookId];
  // Never regress a queued position — keep the furthest-forward read.
  if (prev && prev.pct > entry.pct) return;
  map[entry.bookId] = {
    bookId:   Number(entry.bookId),
    fileHash: entry.fileHash || '',
    cfi:      entry.cfi      || '',
    pct:      entry.pct,
    xpointer: entry.xpointer || '',
    ts:       Date.now(),
  };
  writeOutbox(map);
}

/** Remove a book's pending entry (e.g. after a confirmed online sync). */
export function clearProgress(bookId) {
  const map = readOutbox();
  if (map[bookId] != null) { delete map[bookId]; writeOutbox(map); }
}

export function hasPendingProgress() {
  return Object.keys(readOutbox()).length > 0;
}

let _flushing = false;

/**
 * Push every pending offline position to the server + KOReader sync.
 * Idempotent and safe: skips (and clears) entries the server is already at/ahead
 * of, and uses the server's high-water-mark endpoints so it never regresses a
 * position advanced on another device. Returns the count of entries synced.
 */
export async function flushProgressOutbox() {
  if (_flushing) return 0;
  const map = readOutbox();
  const ids = Object.keys(map);
  if (!ids.length) return 0;
  _flushing = true;
  let synced = 0;
  try {
    for (const id of ids) {
      const e = map[id];
      if (!e || !(e.pct > 0)) { delete map[id]; continue; }
      try {
        // Resolve authoritative hashes from the server — robust even if the
        // offline-captured fileHash was empty/stale.
        let fileHash = e.fileHash;
        let docKey   = e.fileHash;
        try {
          const book = await apiFetch(`/books/${e.bookId}`);
          if (book) {
            fileHash = book.file_hash || fileHash;
            docKey   = book.kosync_hash || book.file_hash_md5 || book.file_hash || fileHash;
          }
        } catch { /* lookup failed — fall back to captured fileHash */ }
        if (!fileHash) { delete map[id]; continue; }

        // Skip (and drop) when the server is already at/ahead of this position.
        let serverPct = 0;
        try {
          const sp = await apiFetch(`/progress/${fileHash}`);
          serverPct = sp?.percentage || 0;
        } catch { /* network still down — keep entry, retry later */ throw new Error('offline'); }
        if (e.pct <= serverPct + EPS) { delete map[id]; continue; }

        // 1) App's own progress store (keyed by file_hash). High-water on the server.
        await apiFetch(`/progress/${fileHash}`, {
          method: 'PUT',
          body: JSON.stringify({ cfi_position: e.cfi, percentage: e.pct, device: 'Codexa' }),
        });
        // 2) Internal KOReader sync store (keyed by docKey). Best-effort.
        await apiFetch(`/kosync/internal/${encodeURIComponent(docKey)}`, {
          method: 'PUT',
          body: JSON.stringify({ progress: e.xpointer, percentage: e.pct, device: 'Codexa', device_id: 'codexa-web' }),
        }).catch(() => {});
        // 3) External KOReader sync server (optional; server no-ops if unconfigured). Best-effort.
        await apiFetch(`/kosync/remote/${encodeURIComponent(docKey)}`, {
          method: 'PUT',
          body: JSON.stringify({ document: docKey, progress: e.xpointer, percentage: e.pct, device: 'Codexa', device_id: 'codexa-web' }),
        }).catch(() => {});

        delete map[id];
        synced++;
        console.log('[progress-outbox] flushed bookId', e.bookId, 'pct', Math.round(e.pct * 100) + '%');
      } catch (err) {
        // Still offline / server unreachable for this entry — keep it for next flush.
        console.warn('[progress-outbox] flush deferred for bookId', e.bookId, err?.message || err);
      }
    }
  } finally {
    writeOutbox(map);
    _flushing = false;
  }
  return synced;
}
