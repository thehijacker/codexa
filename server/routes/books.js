const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { getDb, DATA_DIR }              = require('../db');
const { authenticateToken }            = require('../middleware/auth');
const { computeFileHash, computeFileMd5, extractEpubMetadata, extractCbzMetadata } = require('../utils/epub');
const { isCbrBuffer, convertCbrToCbz } = require('../utils/cbr');

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
    const name = file.originalname.toLowerCase();
    const ok = file.mimetype === 'application/epub+zip'
            || file.mimetype === 'application/x-cbz'
            || file.mimetype === 'application/x-cbr'
            || file.mimetype === 'application/zip'
            || file.mimetype === 'application/rar'
            || file.mimetype === 'application/x-rar-compressed'
            || name.endsWith('.epub')
            || name.endsWith('.cbz')
            || name.endsWith('.cbr');
    cb(ok ? null : new Error('error.epub_required'), ok);
  },
});

// ── GET /api/books ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db    = getDb();
  const books = db.prepare(`
    SELECT b.id, b.title, b.author, b.series_name, b.series_number, b.file_hash, b.file_hash_md5, b.cover_path, b.file_size, b.added_at,
           COALESCE(b.last_opened_at, b.added_at) AS last_opened_at,
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

// ── POST /api/books/:id/opened — record that the user opened this book ─────────
router.post('/:id/opened', (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });
  db.prepare(`UPDATE books SET last_opened_at = strftime('%s', 'now') WHERE id = ?`).run(book.id);
  res.json({ success: true });
});

// ── GET /api/books/:id ─────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db   = getDb();
  const book = db.prepare(
    'SELECT * FROM books WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' }); {
    if (!book.file_hash_md5) {
      const filePath = path.join(BOOKS_DIR, String(req.user.id), book.filename);
      if (fs.existsSync(filePath)) {
        try {
          const md5 = computeFileMd5(filePath);
          db.prepare('UPDATE books SET file_hash_md5 = ? WHERE id = ?').run(md5, book.id);
          book.file_hash_md5 = md5;
        } catch (e) { console.error('[books] MD5 recompute error:', e.message); }
      }
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

  const isCbzFile = book.filename?.endsWith('.cbz') || book.format === 'cbz';
  res.setHeader('Content-Type', isCbzFile ? 'application/x-cbz' : 'application/epub+zip');
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
    fname += isCbzFile ? '.cbz' : '.epub';
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
    // Detect and convert CBR → CBZ BEFORE hashing so the stored hash matches the CBZ content.
    const origName = req.file.originalname.toLowerCase();
    let isCbz = origName.endsWith('.cbz');
    if (origName.endsWith('.cbr') || isCbrBuffer(fs.readFileSync(tmpPath).slice(0, 8))) {
      console.log('[books] converting CBR → CBZ...');
      const cbzBuf = await convertCbrToCbz(fs.readFileSync(tmpPath));
      fs.writeFileSync(tmpPath, cbzBuf);
      isCbz = true;
    }

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

    const ext      = isCbz ? '.cbz' : '.epub';
    const format   = isCbz ? 'cbz'  : 'epub';
    const filename = `${fileHash}${ext}`;
    const destPath = path.join(userDir, filename);

    // Move from tmp to permanent location (cross-device safe)
    try {
      fs.renameSync(tmpPath, destPath);
    } catch {
      fs.copyFileSync(tmpPath, destPath);
      fs.unlinkSync(tmpPath);
    }

    const { title, author, cover_path, series_name, series_number, description, publisher, language, isbn, genres, pages } =
      isCbz ? extractCbzMetadata(destPath, COVERS_DIR, fileHash)
             : extractEpubMetadata(destPath, COVERS_DIR, fileHash);
    const fileSize = fs.statSync(destPath).size;

    const result = db.prepare(`
      INSERT INTO books (user_id, title, author, series_name, series_number, description, publisher, language, isbn, genres, pages, file_hash, file_hash_md5, filename, cover_path, file_size, format)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, title, author, series_name, series_number, description, publisher, language, isbn, genres, pages, fileHash, fileHashMd5, filename, cover_path, fileSize, format);

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

// ── PATCH /api/books/:id/file — download epub from OPDS and replace local file ──
router.patch('/:id/file', async (req, res) => {
  const { href, serverId } = req.body;
  if (!href || serverId === undefined) {
    return res.status(400).json({ error: 'error.missing_fields' });
  }

  const db   = getDb();
  const book = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });

  // Retrieve OPDS server credentials from user settings
  const settingsRow = db.prepare('SELECT opds_servers FROM user_settings WHERE user_id = ?').get(req.user.id);
  let servers = [];
  try { servers = JSON.parse(settingsRow?.opds_servers || '[]'); } catch { servers = []; }
  const idx = parseInt(serverId, 10);
  const server = (!isNaN(idx) && idx >= 0 && idx < servers.length) ? servers[idx] : null;
  if (!server) return res.status(400).json({ error: 'error.opds_server_not_found' });

  const headers = { Accept: 'application/epub+zip, */*' };
  if (server.username) {
    const creds = Buffer.from(`${server.username}:${server.password || ''}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  }

  const tmpPath = path.join(TMP_DIR, `replace-${Date.now()}-${Math.random().toString(36).slice(2)}.epub`);
  let fileHandle;
  try {
    const r = await fetch(href, { headers, signal: AbortSignal.timeout(120000) });
    if (!r.ok) return res.status(502).json({ error: `error.opds_download_failed_${r.status}` });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('epub') && !ct.includes('octet-stream')) {
      return res.status(502).json({ error: 'error.opds_not_epub' });
    }

    // Stream to temp file
    fileHandle = fs.createWriteStream(tmpPath);
    const reader = r.body.getReader();
    await new Promise((resolve, reject) => {
      fileHandle.on('error', reject);
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) { fileHandle.end(); return; }
        if (!fileHandle.write(value)) fileHandle.once('drain', pump);
        else pump();
      }).catch(reject);
      fileHandle.once('finish', resolve);
      pump();
    });

    const newMd5 = computeFileMd5(tmpPath);
    const destDir = path.join(BOOKS_DIR, String(req.user.id));
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, book.file_hash + '.epub');
    fs.renameSync(tmpPath, destPath);

    // Re-extract all metadata from the new file so genres, description, etc. stay current.
    // Title and author are intentionally preserved in case the user edited them manually.
    const meta = extractEpubMetadata(destPath, COVERS_DIR, book.file_hash);
    db.prepare(`UPDATE books SET
      file_hash_md5 = ?, kosync_hash = '',
      cover_path  = ?,
      description = CASE WHEN ? != '' THEN ? ELSE description END,
      publisher   = CASE WHEN ? != '' THEN ? ELSE publisher   END,
      language    = CASE WHEN ? != '' THEN ? ELSE language    END,
      isbn        = CASE WHEN ? != '' THEN ? ELSE isbn        END,
      genres      = CASE WHEN ? != '' THEN ? ELSE genres      END,
      pages       = CASE WHEN ? > 0   THEN ? ELSE pages       END
    WHERE id = ?`).run(
      newMd5,
      meta.cover_path,
      meta.description || '', meta.description || '',
      meta.publisher   || '', meta.publisher   || '',
      meta.language    || '', meta.language    || '',
      meta.isbn        || '', meta.isbn        || '',
      meta.genres      || '', meta.genres      || '',
      meta.pages       || 0,  meta.pages       || 0,
      book.id
    );
    res.json({ file_hash_md5: newMd5, cover_path: meta.cover_path });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    console.error('[books] replace file error:', err.message);
    res.status(500).json({ error: 'error.book_replace_failed' });
  }
});

// ── POST /api/books/reextract-all — re-extract metadata for all books
router.post('/reextract-all', (req, res) => {
  const db    = getDb();
  const books = db.prepare(
    'SELECT * FROM books WHERE user_id = ?'
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
      db.prepare('UPDATE books SET cover_path = ?, description = ?, publisher = ?, language = ?, isbn = ?, genres = ?, pages = ? WHERE id = ?')
        .run(meta.cover_path, meta.description || book.description || '', meta.publisher || book.publisher || '', meta.language || book.language || '', meta.isbn || book.isbn || '', meta.genres || book.genres || '', meta.pages || book.pages || '', book.id);
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
  db.prepare('UPDATE books SET cover_path = ?, description = ?, publisher = ?, language = ?, isbn = ?, genres = ?, pages = ? WHERE id = ?')
    .run(meta.cover_path, meta.description || book.description || '', meta.publisher || book.publisher || '', meta.language || book.language || '', meta.isbn || book.isbn || '', meta.genres || book.genres || '', meta.pages || book.pages || '', book.id);
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
