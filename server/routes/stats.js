const express = require('express');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const bookorbit = require('../services/bookorbitSync');

const router = express.Router();
router.use(authenticateToken);

// POST /api/stats/session — open a new reading session, returns { id }
router.post('/session', (req, res) => {
  const { book_id, start_ts } = req.body || {};
  if (!book_id) return res.status(400).json({ error: 'book_id required' });
  const db = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(book_id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  const result = db.prepare(
    'INSERT INTO reading_sessions (user_id, book_id, start_ts) VALUES (?, ?, ?)'
  ).run(req.user.id, book.id, start_ts || Math.floor(Date.now() / 1000));
  res.status(201).json({ id: result.lastInsertRowid });
});

// PATCH /api/stats/session/:id — close / update session
router.patch('/session/:id', (req, res) => {
  const { end_ts, pages_nav, end_pct, start_pct } = req.body || {};
  const db = getDb();
  const sess = db.prepare('SELECT id, book_id FROM reading_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  db.prepare('UPDATE reading_sessions SET end_ts = ?, pages_nav = ?, end_pct = ?, start_pct = ? WHERE id = ?')
    .run(end_ts || Math.floor(Date.now() / 1000), pages_nav || 0, end_pct ?? null, start_pct ?? null, sess.id);
  bookorbit.triggerSync(req.user.id, sess.book_id); // upload the closed session to BookOrbit
  res.json({ success: true });
});

// POST /api/stats/session/complete — records an already-finished reading-session chunk in one
// call (start+end+pages together), instead of the open-then-later-close two-step the plain
// POST/PATCH pair above needs. Exists for offline resilience: the client only ever builds this
// from a chunk it has ALREADY finished tracking locally (see reader.js's buildSessionRecord /
// rotateStatsSession) — unlike the old model, the very first network call for a reading session
// can fail with nothing lost, since there was never anything that HAD to succeed before reading
// could be tracked at all. The client keeps retrying this same call from a local queue until it
// lands. client_id makes it safe to deliver the same chunk twice (a keepalive fetch on page-unload
// whose outcome can't be observed, followed by the same chunk being flushed again later).
router.post('/session/complete', (req, res) => {
  const { book_id, client_id, start_ts, end_ts, pages_nav, start_pct, end_pct } = req.body || {};
  if (!book_id || !start_ts || !end_ts) {
    return res.status(400).json({ error: 'book_id, start_ts and end_ts are required' });
  }
  const db = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(book_id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  const info = db.prepare(`
    INSERT INTO reading_sessions (user_id, book_id, client_id, start_ts, end_ts, pages_nav, start_pct, end_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, client_id) DO NOTHING
  `).run(req.user.id, book.id, client_id || null, start_ts, end_ts, pages_nav || 0, start_pct ?? null, end_pct ?? null);
  if (info.changes > 0) bookorbit.triggerSync(req.user.id, book.id); // upload the closed session to BookOrbit
  res.status(201).json({ success: true });
});

// POST /api/stats/chapter — log a chapter visit
router.post('/chapter', (req, res) => {
  const { book_id, chapter_href, chapter_title } = req.body || {};
  if (!book_id || !chapter_href) return res.status(400).json({ error: 'book_id and chapter_href required' });
  const db = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(book_id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  db.prepare(
    'INSERT INTO chapter_visits (user_id, book_id, chapter_href, chapter_title) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, book.id, chapter_href, chapter_title || '');
  res.status(201).json({ success: true });
});

// A session counts as real reading only when the user navigated at least 2 pages
// and spent at least 60 seconds — filters out quick open/close testing behaviour.
const REAL_SESSION = 'end_ts IS NOT NULL AND pages_nav >= 2 AND (end_ts - start_ts) >= 60';

// GET /api/stats — aggregate stats for the current user
// Every time/session/page figure is live reading_sessions PLUS book_stats_archive: the archive
// holds the rolled-up totals of books that have since been deleted (see trg_books_archive_stats
// in server/db.js), which would otherwise vanish from these numbers along with the book's
// cascade-deleted session rows.
router.get('/', (req, res) => {
  const db  = getDb();
  const uid = req.user.id;

  const live = db.prepare(
    `SELECT COUNT(*) as total, COALESCE(SUM(end_ts - start_ts), 0) as total_secs, COALESCE(SUM(pages_nav), 0) as total_pages FROM reading_sessions WHERE user_id = ? AND ${REAL_SESSION}`
  ).get(uid);
  const archived = db.prepare(
    'SELECT COALESCE(SUM(sessions), 0) as total, COALESCE(SUM(total_secs), 0) as total_secs, COALESCE(SUM(pages), 0) as total_pages FROM book_stats_archive WHERE user_id = ?'
  ).get(uid);
  const totalSessions = live.total + archived.total;
  const totalSecs     = live.total_secs + archived.total_secs;
  const totalPages    = live.total_pages + archived.total_pages;

  // Distinct by content hash so a book that was deleted and re-added (live sessions + an archive
  // row under the same hash) still counts once.
  const booksStarted = db.prepare(
    `SELECT COUNT(*) as n FROM (
       SELECT b.file_hash AS h FROM reading_sessions rs JOIN books b ON b.id = rs.book_id
        WHERE rs.user_id = ? AND ${REAL_SESSION}
       UNION
       SELECT document_hash FROM book_stats_archive WHERE user_id = ?
     )`
  ).get(uid, uid);

  // Reads from the book_completions log (see server/utils/bookCompletion.js), not a live join
  // against reading_progress/books — a finished book keeps counting even after it's deleted or
  // re-hashed, since that join has no way to find it once it's gone.
  const booksCompleted = db.prepare(
    'SELECT COUNT(DISTINCT document_hash) as n FROM book_completions WHERE user_id = ?'
  ).get(uid);

  const liveTop = db.prepare(
    `SELECT b.id, b.file_hash AS hash, b.title, b.author, b.cover_path,
            COUNT(rs.id) as session_count,
            SUM(rs.end_ts - rs.start_ts) as total_secs,
            MAX(rs.start_ts) as last_read
     FROM reading_sessions rs
     JOIN books b ON b.id = rs.book_id
     WHERE rs.user_id = ? AND ${REAL_SESSION}
     GROUP BY rs.book_id
     ORDER BY total_secs DESC
     LIMIT 20`
  ).all(uid);
  const archivedTop = db.prepare(
    `SELECT document_hash AS hash, title, author,
            SUM(sessions) as session_count, SUM(total_secs) as total_secs, MAX(last_read) as last_read
     FROM book_stats_archive
     WHERE user_id = ?
     GROUP BY document_hash
     ORDER BY total_secs DESC
     LIMIT 20`
  ).all(uid);
  // Merge by hash (a re-added book has both), then take the overall top 5. A deleted book has no
  // id/cover any more — the UI falls back to its placeholder.
  const merged = new Map();
  for (const r of liveTop) merged.set(r.hash, { ...r });
  for (const r of archivedTop) {
    const cur = merged.get(r.hash);
    if (cur) {
      cur.session_count += r.session_count;
      cur.total_secs    += r.total_secs;
      cur.last_read      = Math.max(cur.last_read || 0, r.last_read || 0);
    } else {
      merged.set(r.hash, { id: null, cover_path: null, ...r });
    }
  }
  const topBooks = [...merged.values()]
    .sort((a, b) => b.total_secs - a.total_secs)
    .slice(0, 5)
    .map(({ hash, ...rest }) => rest);

  res.json({
    total_sessions:   totalSessions,
    total_secs:       totalSecs,
    avg_session_secs: totalSessions ? Math.round(totalSecs / totalSessions) : 0,
    total_pages:      totalPages,
    books_started:    booksStarted.n        || 0,
    books_completed:  booksCompleted.n      || 0,
    top_books:        topBooks,
  });
});

// GET /api/stats/completions — every distinct book the user has finished, newest first, from the
// permanent book_completions log (so deleted books still appear, by their snapshotted title).
// `times` > 1 means it was finished more than once (re-read). total_secs is the real reading time
// recorded for it, live + archived.
router.get('/completions', (req, res) => {
  const db  = getDb();
  const uid = req.user.id;
  const rows = db.prepare(
    `SELECT document_hash AS hash, MAX(completed_at) AS completed_at, COUNT(*) AS times, title, author
       FROM book_completions
      WHERE user_id = ?
      GROUP BY document_hash
      ORDER BY completed_at DESC
      LIMIT 500`
  ).all(uid);

  const liveBook = db.prepare('SELECT id, title, author, cover_path FROM books WHERE user_id = ? AND file_hash = ? LIMIT 1');
  const liveSecs = db.prepare(
    `SELECT COALESCE(SUM(rs.end_ts - rs.start_ts), 0) AS s FROM reading_sessions rs
       JOIN books b ON b.id = rs.book_id
      WHERE rs.user_id = ? AND b.file_hash = ? AND ${REAL_SESSION}`
  );
  const archSecs = db.prepare('SELECT COALESCE(SUM(total_secs), 0) AS s FROM book_stats_archive WHERE user_id = ? AND document_hash = ?');
  // BookOrbit's cross-device totals (cached by bookorbitSync.backfillFinishedStats / per-book sync).
  // They already include what Codexa pushed, so they're a separate "all devices" figure.
  const boStats = db.prepare('SELECT total_seconds, total_sessions, by_source, finished_on FROM bookorbit_book_stats WHERE user_id = ? AND document_hash = ? AND fetched_at IS NOT NULL');

  res.json(rows.map(r => {
    const book = liveBook.get(uid, r.hash);
    const bo   = boStats.get(uid, r.hash);
    return {
      title:        book?.title  || r.title,
      author:       book ? (book.author || '') : (r.author || ''),
      completed_at: r.completed_at,
      times:        r.times,
      total_secs:   liveSecs.get(uid, r.hash).s + archSecs.get(uid, r.hash).s,
      book_id:      book?.id ?? null,
      cover_path:   book?.cover_path ?? null,
      bo_total_secs: bo ? bo.total_seconds  : null,
      bo_sessions:   bo ? bo.total_sessions : null,
      bo_sources:    bo ? JSON.parse(bo.by_source || '[]') : [],
      bo_finished_on: bo?.finished_on ?? null,
    };
  }));
});

// GET /api/stats/sessions/:bookId — per-book reading sessions (newest first). The cap is generous on
// purpose: the Reading tab sums these into its total and per-day totals, so a low cap (it was 50)
// silently under-counted long books and could cut the oldest day in half.
router.get('/sessions/:bookId', (req, res) => {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT start_ts, end_ts, pages_nav, start_pct, end_pct
    FROM reading_sessions
    WHERE user_id = ? AND book_id = ? AND ${REAL_SESSION}
    ORDER BY start_ts DESC LIMIT 1000
  `).all(req.user.id, req.params.bookId);
  res.json(rows);
});

// GET /api/stats/history — chapter visit history grouped by book (last 50 visits per book)
router.get('/history', (req, res) => {
  const db  = getDb();
  const uid = req.user.id;

  const visits = db.prepare(
    `SELECT cv.id, cv.book_id, b.title as book_title, b.cover_path,
            cv.chapter_href, cv.chapter_title, cv.visited_at
     FROM chapter_visits cv
     JOIN books b ON b.id = cv.book_id
     WHERE cv.user_id = ?
     ORDER BY cv.visited_at DESC
     LIMIT 500`
  ).all(uid);

  // Group by book
  const byBook = {};
  for (const v of visits) {
    if (!byBook[v.book_id]) {
      byBook[v.book_id] = { book_id: v.book_id, book_title: v.book_title, cover_path: v.cover_path, visits: [] };
    }
    if (byBook[v.book_id].visits.length < 50) {
      byBook[v.book_id].visits.push({ id: v.id, chapter_href: v.chapter_href, chapter_title: v.chapter_title, visited_at: v.visited_at });
    }
  }
  res.json(Object.values(byBook));
});

// DELETE /api/stats/history/:bookId — clear chapter history for one book
router.delete('/history/:bookId', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM chapter_visits WHERE user_id = ? AND book_id = ?').run(req.user.id, req.params.bookId);
  res.status(204).end();
});

// DELETE /api/stats/history — clear all chapter history
router.delete('/history', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM chapter_visits WHERE user_id = ?').run(req.user.id);
  res.status(204).end();
});

// DELETE /api/stats — reset all stats (sessions + chapter visits)
router.delete('/', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM reading_sessions WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM book_stats_archive WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM chapter_visits WHERE user_id = ?').run(req.user.id);
  res.status(204).end();
});

module.exports = router;
