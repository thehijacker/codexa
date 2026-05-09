const express = require('express');
const { getDb }             = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

const VALID_COLORS = ['yellow', 'green', 'blue', 'pink'];

// GET /api/annotations/:bookId — list all annotations for a book, ordered by pct
router.get('/:bookId', (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?')
                 .get(req.params.bookId, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const rows = db.prepare(
    'SELECT id, cfi, pct, text, note, color, created_at FROM annotations WHERE user_id = ? AND book_id = ? ORDER BY pct ASC'
  ).all(req.user.id, book.id);
  res.json(rows);
});

// POST /api/annotations/:bookId — create annotation
router.post('/:bookId', (req, res) => {
  const { cfi, pct, color, note, text } = req.body || {};
  if (!cfi) return res.status(400).json({ error: 'cfi is required' });

  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?')
                 .get(req.params.bookId, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const safeColor = VALID_COLORS.includes(color) ? color : 'yellow';
  const result = db.prepare(
    'INSERT INTO annotations (user_id, book_id, cfi, pct, text, note, color) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, book.id, cfi, pct || 0, (text || '').slice(0, 500), (note || '').slice(0, 1000), safeColor);

  const row = db.prepare(
    'SELECT id, cfi, pct, text, note, color, created_at FROM annotations WHERE id = ?'
  ).get(result.lastInsertRowid);
  res.status(201).json(row);
});

// PUT /api/annotations/:bookId/:id — update note and/or color
router.put('/:bookId/:id', (req, res) => {
  const { note, color } = req.body || {};
  const db = getDb();
  const an = db.prepare('SELECT id, note, color FROM annotations WHERE id = ? AND user_id = ?')
               .get(req.params.id, req.user.id);
  if (!an) return res.status(404).json({ error: 'Annotation not found' });

  const newNote  = note  !== undefined ? (note  || '').slice(0, 1000) : an.note;
  const newColor = VALID_COLORS.includes(color) ? color : an.color;
  db.prepare('UPDATE annotations SET note = ?, color = ? WHERE id = ?')
    .run(newNote, newColor, an.id);
  res.json({ success: true });
});

// DELETE /api/annotations/:bookId/:id — delete one annotation
router.delete('/:bookId/:id', (req, res) => {
  const db = getDb();
  const an = db.prepare('SELECT id FROM annotations WHERE id = ? AND user_id = ?')
               .get(req.params.id, req.user.id);
  if (!an) return res.status(404).json({ error: 'Annotation not found' });

  db.prepare('DELETE FROM annotations WHERE id = ?').run(an.id);
  res.status(204).end();
});

module.exports = router;
