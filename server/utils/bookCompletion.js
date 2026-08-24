// Auto-marks a book "read" once its saved progress crosses a completion threshold, and auto-
// reverts it back to "reading" if the user later starts it over.
//
// Why the forward direction exists: CXReader's percentage (public/js/cxreader/index.js
// makePct()) is a fraction of pages read within the spine and never actually reaches 1.0 for
// paginated content — the last page of the last chapter yields (pageCount-1)/pageCount, not 1.
// So a book a user has genuinely finished never satisfies a raw `percentage >= 1` check, and its
// read_status never advances past 'reading' on its own — it lingers in the "Currently reading"
// shelf forever. 0.95 mirrors the threshold already used for "books completed" in
// server/routes/stats.js.
//
// Why the reverse direction exists: once read_status flips to 'read' (whether by this
// threshold, or the user manually marking it), it stays 'read' forever with nothing to clear
// it — so re-reading a finished book from the start (or picking a partially-read one back up)
// left it permanently invisible in "Currently reading" despite genuine, saved progress.
// Confirmed live: a PDF finished once, then re-opened and read down to 18%, stayed stuck on
// 'read'. RESUME_THRESHOLD sits well below FINISHED_THRESHOLD (hysteresis) so ordinary
// navigation near the very end of a book — jumping back a page or two, re-reading the last
// chapter — can never flap the status back and forth on every save.
//
// Called from every route that writes reading_progress.percentage (server/routes/progress.js,
// server/routes/kosync.js — both the internal PUT and the external-facing /syncs/progress PUT).
// Those routes use different hash flavors for the same book (Codexa's own file_hash for the web
// reader, KOReader's partial-MD5 file_hash_md5/kosync_hash override for KOSync clients), so this
// matches against all three rather than assuming one.
const { getDb } = require('../db');
const bookorbit = require('../services/bookorbitSync');

const FINISHED_THRESHOLD = 0.95;
const RESUME_THRESHOLD   = 0.85;

function maybeMarkBookFinished(userId, documentHash) {
  if (!documentHash) return;
  const db = getDb();
  const progress = db.prepare(
    'SELECT percentage FROM reading_progress WHERE user_id = ? AND document_hash = ?'
  ).get(userId, documentHash);
  if (!progress) return;

  const book = db.prepare(
    'SELECT id, read_status FROM books WHERE user_id = ? AND (file_hash = ? OR file_hash_md5 = ? OR kosync_hash = ?) LIMIT 1'
  ).get(userId, documentHash, documentHash, documentHash);
  if (!book) return;

  if (progress.percentage >= FINISHED_THRESHOLD) {
    // Never override a status the user already set deliberately.
    if (book.read_status === 'read' || book.read_status === 'abandoned') return;
    db.prepare(`UPDATE books SET read_status = 'read', status_modified = strftime('%s','now') WHERE id = ?`).run(book.id);
    bookorbit.triggerSync(userId, book.id);
    return;
  }

  // 'abandoned' stays sticky in both directions — always a deliberate manual choice, unlike
  // 'read' which this same function can set on its own.
  if (book.read_status === 'read' && progress.percentage < RESUME_THRESHOLD) {
    db.prepare(`UPDATE books SET read_status = 'reading', status_modified = strftime('%s','now') WHERE id = ?`).run(book.id);
    bookorbit.triggerSync(userId, book.id);
  }
}

module.exports = { maybeMarkBookFinished, FINISHED_THRESHOLD, RESUME_THRESHOLD };
