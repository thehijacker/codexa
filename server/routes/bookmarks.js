const express = require('express');
const { getDb }            = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

// GET /api/bookmarks/:bookId — list bookmarks for a book, ordered by pct
router.get('/:bookId', (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?')
                 .get(req.params.bookId, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const rows = db.prepare(
    'SELECT id, cfi, pct, label, created_at FROM bookmarks WHERE user_id = ? AND book_id = ? ORDER BY pct ASC'
  ).all(req.user.id, book.id);
  res.json(rows);
});

// POST /api/bookmarks/:bookId — create bookmark
router.post('/:bookId', (req, res) => {
  const { cfi, pct, label } = req.body || {};
  if (!cfi) return res.status(400).json({ error: 'cfi is required' });

  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?')
                 .get(req.params.bookId, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const result = db.prepare(
    'INSERT INTO bookmarks (user_id, book_id, cfi, pct, label) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, book.id, cfi, pct || 0, (label || '').slice(0, 200));

  const row = db.prepare(
    'SELECT id, cfi, pct, label, created_at FROM bookmarks WHERE id = ?'
  ).get(result.lastInsertRowid);
  res.status(201).json(row);
});

// PUT /api/bookmarks/:bookId/:id — update label
router.put('/:bookId/:id', (req, res) => {
  const { label } = req.body || {};
  const db  = getDb();
  const bm  = db.prepare('SELECT id FROM bookmarks WHERE id = ? AND user_id = ?')
                .get(req.params.id, req.user.id);
  if (!bm) return res.status(404).json({ error: 'Bookmark not found' });

  db.prepare('UPDATE bookmarks SET label = ? WHERE id = ?')
    .run((label || '').slice(0, 200), bm.id);
  res.json({ success: true });
});

// DELETE /api/bookmarks/:bookId/:id — delete one bookmark
router.delete('/:bookId/:id', (req, res) => {
  const db = getDb();
  const bm = db.prepare('SELECT id FROM bookmarks WHERE id = ? AND user_id = ?')
               .get(req.params.id, req.user.id);
  if (!bm) return res.status(404).json({ error: 'Bookmark not found' });

  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(bm.id);
  res.status(204).end();
});

module.exports = router;
