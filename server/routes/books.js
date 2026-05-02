const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { getDb, DATA_DIR }              = require('../db');
const { authenticateToken }            = require('../middleware/auth');
const { computeFileHash, computeFileMd5, extractEpubMetadata } = require('../utils/epub');

const router    = express.Router();
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const TMP_DIR   = path.join(DATA_DIR, 'tmp');

router.use(authenticateToken);

// ── Multer: land uploaded files in tmp first ───────────────────────────────────
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/epub+zip'
            || file.originalname.toLowerCase().endsWith('.epub');
    cb(ok ? null : new Error('error.epub_required'), ok);
  },
});

// ── GET /api/books ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db    = getDb();
  const books = db.prepare(`
    SELECT b.id, b.title, b.author, b.series_name, b.series_number, b.file_hash, b.file_hash_md5, b.cover_path, b.file_size, b.added_at,
           COALESCE(p.percentage, 0)    AS percentage,
           COALESCE(p.cfi_position, '') AS cfi_position,
           p.updated_at                AS progress_updated_at
      FROM books b
      LEFT JOIN reading_progress p
             ON p.user_id = b.user_id AND p.document_hash = b.file_hash
     WHERE b.user_id = ?
     ORDER BY b.added_at DESC
  `).all(req.user.id);
  res.json(books);
});

// ── GET /api/books/:id ─────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db   = getDb();
  const book = db.prepare(
    'SELECT * FROM books WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' }); {
    const filePath = path.join(BOOKS_DIR, String(req.user.id), book.filename);
    if (fs.existsSync(filePath)) {
      try {
        const md5 = computeFileMd5(filePath);
        db.prepare('UPDATE books SET file_hash_md5 = ? WHERE id = ?').run(md5, book.id);
        book.file_hash_md5 = md5;
      } catch (e) { console.error('[books] MD5 recompute error:', e.message); }
    }
  }

  res.json(book);
});

// ── GET /api/books/:id/file — serve EPUB to the reader ────────────────────────
router.get('/:id/file', (req, res) => {
  const db   = getDb();
  const book = db.prepare(
    'SELECT * FROM books WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });

  const filePath = path.join(BOOKS_DIR, String(req.user.id), book.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'error.book_file_not_found' });
  }

  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Accept-Ranges', 'bytes');

  // ?download=1 → trigger browser Save-As with a nice human-readable filename
  if (req.query.download === '1') {
    const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
    const title    = sanitize(book.title)  || 'book';
    const author   = sanitize(book.author) || 'Unknown';
    let   fname    = `${author} - ${title}`;
    if (book.series_name) {
      const sName = sanitize(book.series_name);
      const sNum  = sanitize(book.series_number);
      fname += ` (${sName}${sNum ? ` #${sNum}` : ''})`;
    }
    fname += '.epub';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  }

  res.sendFile(filePath);
});

// ── POST /api/books — upload ───────────────────────────────────────────────────
router.post('/', upload.single('epub'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'error.epub_required' });
  }

  const tmpPath = req.file.path;
  const userDir = path.join(BOOKS_DIR, String(req.user.id));
  fs.mkdirSync(userDir, { recursive: true });

  try {
    const fileHash    = computeFileHash(tmpPath);
    const fileHashMd5 = computeFileMd5(tmpPath);
    const db       = getDb();

    // Reject duplicates
    if (db.prepare(
      'SELECT id FROM books WHERE user_id = ? AND file_hash = ?'
    ).get(req.user.id, fileHash)) {
      fs.unlinkSync(tmpPath);
      return res.status(409).json({ error: 'error.book_already_in_library' });
    }

    const filename = `${fileHash}.epub`;
    const destPath = path.join(userDir, filename);

    // Move from tmp to permanent location (cross-device safe)
    try {
      fs.renameSync(tmpPath, destPath);
    } catch {
      fs.copyFileSync(tmpPath, destPath);
      fs.unlinkSync(tmpPath);
    }

    const { title, author, cover_path, series_name, series_number, description } = extractEpubMetadata(destPath, COVERS_DIR, fileHash);
    const fileSize = fs.statSync(destPath).size;

    const result = db.prepare(`
      INSERT INTO books (user_id, title, author, series_name, series_number, description, file_hash, file_hash_md5, filename, cover_path, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, title, author, series_name, series_number, description, fileHash, fileHashMd5, filename, cover_path, fileSize);

    res.status(201).json({ id: result.lastInsertRowid, title, author, series_name, series_number, cover_path, file_hash: fileHash, file_hash_md5: fileHashMd5 });
  } catch (err) {
    // Best-effort cleanup of temp file
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    console.error('[books] upload error:', err.message);
    res.status(500).json({ error: 'error.book_upload_failed' });
  }
});

// ── PATCH /api/books/:id — update mutable fields (kosync_hash) ────────────────
router.patch('/:id', (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });

  const { kosync_hash } = req.body;
  if (kosync_hash === undefined) return res.status(400).json({ error: 'error.no_update_fields' });

  // Validate: must be empty string or 32-char hex MD5
  const h = String(kosync_hash).trim().toLowerCase();
  if (h !== '' && !/^[0-9a-f]{32}$/.test(h)) {
    return res.status(400).json({ error: 'kosync_hash mora biti 32-mestni MD5 hex ali prazen niz' });
  }

  db.prepare('UPDATE books SET kosync_hash = ? WHERE id = ?').run(h, book.id);
  res.json({ success: true, kosync_hash: h });
});

// ── POST /api/books/reextract-all — re-extract metadata for books missing description/cover
router.post('/reextract-all', (req, res) => {
  const db    = getDb();
  const books = db.prepare(
    "SELECT * FROM books WHERE user_id = ? AND (description = '' OR description IS NULL OR cover_path = '' OR cover_path IS NULL)"
  ).all(req.user.id);

  let updated = 0, failed = 0;
  for (const book of books) {
    const epubPath = path.join(BOOKS_DIR, String(req.user.id), book.filename);
    if (!fs.existsSync(epubPath)) { failed++; continue; }
    try {
      if (book.cover_path) {
        try { fs.unlinkSync(path.join(COVERS_DIR, book.cover_path)); } catch { /* already gone */ }
      }
      const meta = extractEpubMetadata(epubPath, COVERS_DIR, book.file_hash);
      db.prepare('UPDATE books SET cover_path = ?, description = ? WHERE id = ?')
        .run(meta.cover_path, meta.description || book.description || '', book.id);
      updated++;
    } catch { failed++; }
  }
  res.json({ total: books.length, updated, failed });
});

// ── POST /api/books/:id/reextract-cover ──────────────────────────────────────
router.post('/:id/reextract-cover', (req, res) => {
  const db   = getDb();
  const book = db.prepare(
    'SELECT * FROM books WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });

  const epubPath = path.join(BOOKS_DIR, String(req.user.id), book.filename);
  if (!fs.existsSync(epubPath)) {
    return res.status(404).json({ error: 'error.epub_not_found' });
  }

  // Remove old cover file if it existed
  if (book.cover_path) {
    try { fs.unlinkSync(path.join(COVERS_DIR, book.cover_path)); } catch { /* already gone */ }
  }

  const meta = extractEpubMetadata(epubPath, COVERS_DIR, book.file_hash);
  db.prepare('UPDATE books SET cover_path = ?, description = ? WHERE id = ?')
    .run(meta.cover_path, meta.description || book.description || '', book.id);
  res.json({ cover_path: meta.cover_path, description: meta.description });
});

// ── DELETE /api/books/:id ─────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const db   = getDb();
  const book = db.prepare(
    'SELECT * FROM books WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });

  // Remove epub file
  const filePath = path.join(BOOKS_DIR, String(req.user.id), book.filename);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }

  // Remove cover
  if (book.cover_path) {
    try { fs.unlinkSync(path.join(COVERS_DIR, book.cover_path)); } catch { /* already gone */ }
  }

  // Remove book + its progress rows (CASCADE handles progress)
  db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
  res.status(204).end();
});

// ── Multer error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'error.file_too_large' });
  }
  res.status(400).json({ error: err.message || 'error.book_upload_failed' });
});

module.exports = router;
