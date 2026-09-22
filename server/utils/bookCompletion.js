// Auto-marks a book "reading" once its saved progress crosses a start threshold, "read" once it
// crosses a finish threshold, and auto-reverts "read" back to "reading" if the user later starts
// it over. The start/finish thresholds are per-user settings (user_settings.reading_start_pct /
// reading_finish_pct, see server/routes/settings.js) — added after a user reported a book with
// two chapters and change still remaining getting auto-marked "read": CXReader's percentage
// (public/js/cxreader/index.js makePct()) is a content-weighted spine fraction, not a literal
// page count, and back-matter chapters (acknowledgments, author's note, next-book excerpt) count
// toward that weight like any other chapter — for a book with a lighter tail, a fixed 95% mark
// can land inside the real second-to-last chapter. Letting each user tune it (or use per-book
// overrides, once those exist) fixes that without lowering the default for everyone.
//
// Why the forward "read" direction exists: CXReader's percentage never actually reaches 1.0 for
// paginated content — the last page of the last chapter yields (pageCount-1)/pageCount, not 1.
// So a book a user has genuinely finished never satisfies a raw `percentage >= 1` check, and its
// read_status never advances past 'reading' on its own — it lingers in the "Currently reading"
// shelf forever. 0.95 was the original hardcoded value and remains the default.
//
// Why the reverse direction exists: once read_status flips to 'read' (whether by this
// threshold, or the user manually marking it), it stays 'read' forever with nothing to clear
// it — so re-reading a finished book from the start (or picking a partially-read one back up)
// left it permanently invisible in "Currently reading" despite genuine, saved progress.
// Confirmed live: a PDF finished once, then re-opened and read down to 18%, stayed stuck on
// 'read'. RESUME_THRESHOLD sits well below the default finish threshold (hysteresis) so ordinary
// navigation near the very end of a book — jumping back a page or two, re-reading the last
// chapter — can never flap the status back and forth on every save. This one stays a fixed
// internal safety margin, not a user setting — it's about read/re-read hysteresis, unrelated to
// where "finished" itself should sit for a given book.
//
// Called from every route that writes reading_progress.percentage (server/routes/progress.js,
// server/routes/kosync.js — both the internal PUT and the external-facing /syncs/progress PUT).
// Those routes use different hash flavors for the same book (Codexa's own file_hash for the web
// reader, KOReader's partial-MD5 file_hash_md5/kosync_hash override for KOSync clients), so this
// matches against all three rather than assuming one.
const { getDb } = require('../db');
const bookorbit = require('../services/bookorbitSync');
const { logCompletion } = require('./completions');

const FINISHED_THRESHOLD = 0.95; // default reading_finish_pct for a user_settings row that predates this feature
const START_THRESHOLD    = 0;    // default reading_start_pct — "any progress at all"
const RESUME_THRESHOLD   = 0.85; // fixed; see header comment

function maybeMarkBookFinished(userId, documentHash) {
  if (!documentHash) return;
  const db = getDb();
  const progress = db.prepare(
    'SELECT percentage FROM reading_progress WHERE user_id = ? AND document_hash = ?'
  ).get(userId, documentHash);
  if (!progress) return;

  const book = db.prepare(
    'SELECT id, title, author, read_status FROM books WHERE user_id = ? AND (file_hash = ? OR file_hash_md5 = ? OR kosync_hash = ?) LIMIT 1'
  ).get(userId, documentHash, documentHash, documentHash);
  if (!book) return;

  const settings = db.prepare(
    'SELECT reading_start_pct, reading_finish_pct FROM user_settings WHERE user_id = ?'
  ).get(userId);
  const finishThreshold = settings?.reading_finish_pct ?? FINISHED_THRESHOLD;
  const startThreshold  = settings?.reading_start_pct  ?? START_THRESHOLD;

  if (progress.percentage >= finishThreshold) {
    // Never override a status the user already set deliberately.
    if (book.read_status === 'read' || book.read_status === 'abandoned') return;
    logCompletion(db, userId, book, documentHash);
    db.prepare(`UPDATE books SET read_status = 'read', status_modified = strftime('%s','now') WHERE id = ?`).run(book.id);
    bookorbit.triggerSync(userId, book.id);
    return;
  }

  // 'abandoned' stays sticky in both directions — always a deliberate manual choice, unlike
  // 'read'/'reading' which this same function can set on its own.
  if (book.read_status === 'read' && progress.percentage < RESUME_THRESHOLD) {
    db.prepare(`UPDATE books SET read_status = 'reading', status_modified = strftime('%s','now') WHERE id = ?`).run(book.id);
    bookorbit.triggerSync(userId, book.id);
    return;
  }

  // Only moves a book OUT of "not started yet" — never overrides 'reading'/'read' (already
  // further along) or 'abandoned' (always deliberate). A book explicitly marked 'want_to_read'
  // still counts as "not started" here: picking it up and actually reading is exactly the signal
  // this is meant to catch.
  if (progress.percentage >= startThreshold && (book.read_status === '' || book.read_status === 'want_to_read')) {
    db.prepare(`UPDATE books SET read_status = 'reading', status_modified = strftime('%s','now') WHERE id = ?`).run(book.id);
    bookorbit.triggerSync(userId, book.id);
  }
}

module.exports = { maybeMarkBookFinished, logCompletion, FINISHED_THRESHOLD, START_THRESHOLD, RESUME_THRESHOLD };
