const express = require('express');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

// ── GET /api/shelves ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const shelves = db.prepare(`
    SELECT s.id, s.name, s.created_at, COUNT(bs.book_id) AS book_count
      FROM shelves s
      LEFT JOIN book_shelves bs ON bs.shelf_id = s.id
     WHERE s.user_id = ?
     GROUP BY s.id
     ORDER BY s.created_at ASC
  `).all(req.user.id);
  res.json(shelves);
});

// ── POST /api/shelves ─────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Ime police je obvezno' });
  }
  const db     = getDb();
  const result = db.prepare(
    'INSERT INTO shelves (user_id, name) VALUES (?, ?)'
  ).run(req.user.id, String(name).trim().slice(0, 100));

  const shelf = db.prepare(
    'SELECT id, name, created_at, 0 AS book_count FROM shelves WHERE id = ?'
  ).get(result.lastInsertRowid);
  res.status(201).json(shelf);
});

// ── PUT /api/shelves/:id ──────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Ime police je obvezno' });
  }
  const db    = getDb();
  const shelf = db.prepare(
    'SELECT id FROM shelves WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!shelf) return res.status(404).json({ error: 'Polica ni najdena' });

  db.prepare('UPDATE shelves SET name = ? WHERE id = ?')
    .run(String(name).trim().slice(0, 100), shelf.id);
  res.json({ success: true });
});

// ── DELETE /api/shelves/:id ───────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const db    = getDb();
  const shelf = db.prepare(
    'SELECT id FROM shelves WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!shelf) return res.status(404).json({ error: 'Polica ni najdena' });

  db.prepare('DELETE FROM shelves WHERE id = ?').run(shelf.id);
  res.status(204).end();
});

// ── GET /api/shelves/for-book/:bookId — shelf IDs containing this book ────────
router.get('/for-book/:bookId', (req, res) => {
  const db   = getDb();
  const book = db.prepare(
    'SELECT id FROM books WHERE id = ? AND user_id = ?'
  ).get(req.params.bookId, req.user.id);
  if (!book) return res.status(404).json({ error: 'Knjiga ni najdena' });

  const rows = db.prepare(`
    SELECT bs.shelf_id
      FROM book_shelves bs
      JOIN shelves s ON s.id = bs.shelf_id
     WHERE bs.book_id = ? AND s.user_id = ?
  `).all(req.params.bookId, req.user.id);
  res.json(rows.map(r => r.shelf_id));
});

// ── GET /api/shelves/:id/books ────────────────────────────────────────────────
router.get('/:id/books', (req, res) => {
  const db    = getDb();
  const shelf = db.prepare(
    'SELECT id FROM shelves WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!shelf) return res.status(404).json({ error: 'Polica ni najdena' });

  const rows = db.prepare(`
    SELECT b.id FROM book_shelves bs
      JOIN books b ON b.id = bs.book_id
     WHERE bs.shelf_id = ?
  `).all(shelf.id);
  res.json(rows.map(r => r.id));
});

// ── POST /api/shelves/:id/books ───────────────────────────────────────────────
router.post('/:id/books', (req, res) => {
  const { bookId } = req.body || {};
  if (!bookId) return res.status(400).json({ error: 'bookId je obvezen' });

  const db    = getDb();
  const shelf = db.prepare(
    'SELECT id FROM shelves WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!shelf) return res.status(404).json({ error: 'Polica ni najdena' });

  const book = db.prepare(
    'SELECT id FROM books WHERE id = ? AND user_id = ?'
  ).get(bookId, req.user.id);
  if (!book) return res.status(404).json({ error: 'Knjiga ni najdena' });

  db.prepare(
    'INSERT OR IGNORE INTO book_shelves (shelf_id, book_id) VALUES (?, ?)'
  ).run(shelf.id, book.id);
  res.status(201).json({ success: true });
});

// ── DELETE /api/shelves/:id/books/:bookId ─────────────────────────────────────
router.delete('/:id/books/:bookId', (req, res) => {
  const db    = getDb();
  const shelf = db.prepare(
    'SELECT id FROM shelves WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!shelf) return res.status(404).json({ error: 'Polica ni najdena' });

  db.prepare(
    'DELETE FROM book_shelves WHERE shelf_id = ? AND book_id = ?'
  ).run(shelf.id, req.params.bookId);
  res.status(204).end();
});

module.exports = router;
