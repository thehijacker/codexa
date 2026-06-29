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
  const { end_ts, pages_nav } = req.body || {};
  const db = getDb();
  const sess = db.prepare('SELECT id, book_id FROM reading_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  db.prepare('UPDATE reading_sessions SET end_ts = ?, pages_nav = ? WHERE id = ?')
    .run(end_ts || Math.floor(Date.now() / 1000), pages_nav || 0, sess.id);
  bookorbit.triggerSync(req.user.id, sess.book_id); // upload the closed session to BookOrbit
  res.json({ success: true });
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
router.get('/', (req, res) => {
  const db  = getDb();
  const uid = req.user.id;

  const sessions = db.prepare(
    `SELECT COUNT(*) as total, SUM(end_ts - start_ts) as total_secs, SUM(pages_nav) as total_pages FROM reading_sessions WHERE user_id = ? AND ${REAL_SESSION}`
  ).get(uid);

  const avgRow = db.prepare(
    `SELECT AVG(end_ts - start_ts) as avg_secs FROM reading_sessions WHERE user_id = ? AND ${REAL_SESSION}`
  ).get(uid);

  const booksStarted = db.prepare(
    'SELECT COUNT(DISTINCT book_id) as n FROM reading_sessions WHERE user_id = ?'
  ).get(uid);

  const booksCompleted = db.prepare(
    `SELECT COUNT(*) as n FROM reading_progress rp
     JOIN books b ON b.file_hash = rp.document_hash AND b.user_id = rp.user_id
     WHERE rp.user_id = ? AND rp.percentage >= 0.95`
  ).get(uid);

  const topBooks = db.prepare(
    `SELECT b.id, b.title, b.author, b.cover_path,
            COUNT(rs.id) as session_count,
            SUM(rs.end_ts - rs.start_ts) as total_secs,
            MAX(rs.start_ts) as last_read
     FROM reading_sessions rs
     JOIN books b ON b.id = rs.book_id
     WHERE rs.user_id = ? AND ${REAL_SESSION}
     GROUP BY rs.book_id
     ORDER BY total_secs DESC
     LIMIT 5`
  ).all(uid);

  res.json({
    total_sessions:   sessions.total        || 0,
    total_secs:       sessions.total_secs   || 0,
    avg_session_secs: Math.round(avgRow.avg_secs || 0),
    total_pages:      sessions.total_pages  || 0,
    books_started:    booksStarted.n        || 0,
    books_completed:  booksCompleted.n      || 0,
    top_books:        topBooks,
  });
});

// GET /api/stats/sessions/:bookId — per-book reading sessions (newest first, max 50)
router.get('/sessions/:bookId', (req, res) => {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT start_ts, end_ts, pages_nav
    FROM reading_sessions
    WHERE user_id = ? AND book_id = ? AND ${REAL_SESSION}
    ORDER BY start_ts DESC LIMIT 50
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
  db.prepare('DELETE FROM chapter_visits WHERE user_id = ?').run(req.user.id);
  res.status(204).end();
});

module.exports = router;
