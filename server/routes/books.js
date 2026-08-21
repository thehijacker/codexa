const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { getDb, DATA_DIR }              = require('../db');
const { authenticateToken }            = require('../middleware/auth');
const { computeFileHash, computeFileMd5, extractEpubMetadata, extractCbzMetadata } = require('../utils/epub');
const { isCbrBuffer, convertCbrToCbz } = require('../utils/cbr');
const { extractPdfMetadata, isPdfBuffer } = require('../utils/pdf');
const { PEEK_TTL_SECONDS, peekFilePath, deletePeekRow } = require('../utils/peekCleanup');
const bookorbit = require('../services/bookorbitSync');

// Aligned with BookOrbit's ReadStatus vocabulary so values sync 1:1.
const VALID_READ_STATUS = ['', 'want_to_read', 'reading', 'read', 'abandoned'];

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
    // KEPUB (Kobo's EPUB variant) needs no separate handling anywhere past this filter — it's a
    // standard EPUB/ZIP container (same META-INF/container.xml, OPF, spine) with extra inert
    // <span> wrappers Kobo uses for its own reading-position tracking, so CXReader.open()'s
    // existing content-sniffed EPUB detection and extractEpubMetadata already handle it
    // unmodified. Kobo names files "X.kepub.epub" (already matches .epub below) or bare
    // "X.kepub" (needs its own check, and has no registered browser mimetype to match on).
    const ok = file.mimetype === 'application/epub+zip'
            || file.mimetype === 'application/x-kepub+zip'
            || file.mimetype === 'application/x-cbz'
            || file.mimetype === 'application/x-cbr'
            || file.mimetype === 'application/zip'
            || file.mimetype === 'application/rar'
            || file.mimetype === 'application/x-rar-compressed'
            || file.mimetype === 'application/pdf'
            || name.endsWith('.epub')
            || name.endsWith('.kepub')
            || name.endsWith('.cbz')
            || name.endsWith('.cbr')
            || name.endsWith('.pdf');
    cb(ok ? null : new Error('error.epub_required'), ok);
  },
});

// ── GET /api/books ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db    = getDb();
  const books = db.prepare(`
    SELECT b.id, b.title, b.author, b.series_name, b.series_number, b.file_hash, b.file_hash_md5, b.cover_path, b.file_size, b.added_at, b.genres,
           b.read_status, b.rating,
           COALESCE(b.last_opened_at, b.added_at) AS last_opened_at,
           COALESCE(p.percentage, 0)    AS percentage,
           COALESCE(p.cfi_position, '') AS cfi_position,
           p.updated_at                AS progress_updated_at
      FROM books b
      LEFT JOIN reading_progress p
             ON p.user_id = b.user_id AND p.document_hash = b.file_hash
     WHERE b.user_id = ? AND b.peek_expires_at IS NULL
     ORDER BY b.added_at DESC
  `).all(req.user.id);
  res.json(books);
});

// ── POST /api/books/:id/opened — record that the user opened this book ─────────
router.post('/:id/opened', (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT id, peek_expires_at FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });
  db.prepare(`UPDATE books SET last_opened_at = strftime('%s', 'now') WHERE id = ?`).run(book.id);
  // Ephemeral peek rows are never mapped into BookOrbit (no bookorbit_sync_state row, no
  // file_hash_md5 — see createBookOrbitPeek in server/routes/bookorbit.js), so a sync attempt can
  // only ever resolve to "not in your BookOrbit library" — skip it instead of logging noise.
  if (!book.peek_expires_at) bookorbit.triggerSync(req.user.id, book.id); // pull BookOrbit changes + push pending local
  res.json({ success: true });
});

// ── PUT /api/books/:id/read-status — set read status (synced to BookOrbit) ─────
router.put('/:id/read-status', (req, res) => {
  const { status } = req.body || {};
  if (!VALID_READ_STATUS.includes(status)) return res.status(400).json({ error: 'error.invalid_status' });
  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });
  db.prepare(`UPDATE books SET read_status = ?, status_modified = strftime('%s','now') WHERE id = ?`)
    .run(status, book.id);
  bookorbit.triggerSync(req.user.id, book.id);
  res.json({ success: true });
});

// ── PUT /api/books/:id/rating — set star rating 1-5 or null (synced) ───────────
router.put('/:id/rating', (req, res) => {
  let { rating } = req.body || {};
  if (rating === '' || rating === 0) rating = null;
  if (rating !== null && rating !== undefined) {
    rating = parseInt(rating, 10);
    if (Number.isNaN(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'error.invalid_rating' });
  }
  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });
  db.prepare(`UPDATE books SET rating = ?, status_modified = strftime('%s','now') WHERE id = ?`)
    .run(rating ?? null, book.id);
  bookorbit.triggerSync(req.user.id, book.id);
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

  // BookOrbit book id, if this book is mapped — lets the client build a deep link to the book
  // on the BookOrbit server (bookorbit_url from GET /api/settings + /book/:bo_book_id).
  const boState = db.prepare('SELECT bo_book_id FROM bookorbit_sync_state WHERE user_id = ? AND book_id = ?').get(req.user.id, book.id);
  book.bo_book_id = boState?.bo_book_id ?? null;

  res.json(book);
});

// ── GET /api/books/:id/file — serve EPUB to the reader ────────────────────────
router.get('/:id/file', (req, res) => {
  const db   = getDb();
  const book = db.prepare(
    'SELECT * FROM books WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });

  const filePath = book.peek_expires_at
    ? peekFilePath(req.user.id, book.filename)
    : path.join(BOOKS_DIR, String(req.user.id), book.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'error.book_file_not_found' });
  }

  // Reopened peek link — push the expiry back out so an active-but-idle reread doesn't get
  // swept mid-session (light second line of defense; the main guarantee is the reader's own
  // close signal / the background sweep in server/index.js).
  if (book.peek_expires_at) {
    db.prepare('UPDATE books SET peek_expires_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) + PEEK_TTL_SECONDS, book.id);
  }

  const isCbzFile = book.filename?.endsWith('.cbz') || book.format === 'cbz';
  const isPdfFile = book.filename?.endsWith('.pdf') || book.format === 'pdf';
  res.setHeader('Content-Type', isPdfFile ? 'application/pdf' : (isCbzFile ? 'application/x-cbz' : 'application/epub+zip'));
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
    fname += isPdfFile ? '.pdf' : (isCbzFile ? '.cbz' : '.epub');
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
    let isPdf = origName.endsWith('.pdf') || isPdfBuffer(fs.readFileSync(tmpPath).slice(0, 8));
    if (!isPdf && (origName.endsWith('.cbr') || isCbrBuffer(fs.readFileSync(tmpPath).slice(0, 8)))) {
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

    const ext      = isPdf ? '.pdf' : (isCbz ? '.cbz' : '.epub');
    const format   = isPdf ? 'pdf'  : (isCbz ? 'cbz'  : 'epub');
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
      isPdf ? await extractPdfMetadata(destPath, COVERS_DIR, fileHash)
      : isCbz ? extractCbzMetadata(destPath, COVERS_DIR, fileHash)
             : extractEpubMetadata(destPath, COVERS_DIR, fileHash);
    const fileSize = fs.statSync(destPath).size;

    // The extractor leaves title empty when the file itself has no title metadata (e.g. a CBZ
    // with no ComicInfo.xml <Title>). Fall back to the originally-uploaded filename (not the
    // hash-renamed destPath) rather than showing the file hash as the title.
    const origBase  = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const bookTitle = title || origBase || 'Unknown';

    const result = db.prepare(`
      INSERT INTO books (user_id, title, author, series_name, series_number, description, publisher, language, isbn, genres, pages, file_hash, file_hash_md5, filename, cover_path, file_size, format)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, bookTitle, author, series_name, series_number, description, publisher, language, isbn, genres, pages, fileHash, fileHashMd5, filename, cover_path, fileSize, format);

    res.status(201).json({ id: result.lastInsertRowid, title: bookTitle, author, series_name, series_number, cover_path, file_hash: fileHash, file_hash_md5: fileHashMd5 });
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

// ── POST /api/books/:id/cover — client-rendered cover thumbnail (PDF only, see pdf-cover.js) ──
// EPUB/CBZ covers come out of the file itself at import time (extractEpubMetadata/
// extractCbzMetadata) — a PDF's "cover" is just its first page, which needs actually rendering,
// and this project deliberately does that in the browser (see public/js/pdf-cover.js's header
// comment: the server-side native-canvas option segfaulted the whole process on a real test
// file). Idempotent by design — a book that already has a cover just gets a 200 no-op, so
// reader.js can call this speculatively on every PDF open without needing to track state itself.
const uploadCover = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB — a 600px-wide JPEG thumbnail is a few hundred KB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/webp';
    cb(ok ? null : new Error('error.invalid_cover_image'), ok);
  },
});
router.post('/:id/cover', uploadCover.single('cover'), (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT id, file_hash, cover_path FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });
  if (!req.file) return res.status(400).json({ error: 'error.invalid_cover_image' });
  if (book.cover_path) return res.json({ success: true, cover_path: book.cover_path }); // already has one — no-op

  const ext = req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg';
  const coverFilename = `${book.file_hash}${ext}`;
  try {
    fs.mkdirSync(COVERS_DIR, { recursive: true });
    fs.writeFileSync(path.join(COVERS_DIR, coverFilename), req.file.buffer);
  } catch (err) {
    console.error('[books] cover write failed:', err.message);
    return res.status(500).json({ error: 'error.cover_save_failed' });
  }
  db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(coverFilename, book.id);
  res.json({ success: true, cover_path: coverFilename });
});

// ── PATCH /api/books/:id/file — replace local file with a fresh copy from OPDS or BookOrbit ──
// Two request shapes: { href, serverId } for an OPDS acquisition link (Basic-auth fetch), or
// { source:'bookorbit', boBookId, fileId } for a BookOrbit file (Bearer-token fetch via the
// existing bookorbitSync service — see server/routes/bookorbit.js's import/peek routes for the
// same fetch pattern). Both converge on the same hash/move/re-extract-metadata flow below.
router.patch('/:id/file', async (req, res) => {
  const { href, serverId, source, boBookId, fileId, format } = req.body || {};
  const isBookorbit = source === 'bookorbit';
  if (isBookorbit) {
    if (!fileId) return res.status(400).json({ error: 'error.missing_fields' });
  } else if (!href || serverId === undefined) {
    return res.status(400).json({ error: 'error.missing_fields' });
  }

  const db   = getDb();
  const book = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });

  let server = null;
  if (!isBookorbit) {
    // Retrieve OPDS server credentials from user settings
    const settingsRow = db.prepare('SELECT opds_servers FROM user_settings WHERE user_id = ?').get(req.user.id);
    let servers = [];
    try { servers = JSON.parse(settingsRow?.opds_servers || '[]'); } catch { servers = []; }
    const idx = parseInt(serverId, 10);
    server = (!isNaN(idx) && idx >= 0 && idx < servers.length) ? servers[idx] : null;
    if (!server) return res.status(400).json({ error: 'error.opds_server_not_found' });
  }

  const tmpPath = path.join(TMP_DIR, `replace-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  let fileHandle;
  // The new file's format — preserved from the book being replaced (for OPDS this is normally
  // epub, but a book originally added as a PDF keeps its own format on a re-sync too); for
  // BookOrbit, CBR gets normalized to CBZ the same way import/peek do.
  let outFormat = (book.filename?.endsWith('.pdf') || book.format === 'pdf') ? 'pdf'
    : (book.filename?.endsWith('.cbz') || book.format === 'cbz') ? 'cbz' : 'epub';
  try {
    if (isBookorbit) {
      const ctx = bookorbit.getContext(req.user.id);
      if (!ctx) return res.status(403).json({ error: 'error.bookorbit_not_enabled' });
      const asset = await bookorbit.fetchAsset(req.user.id, ctx, `/books/files/${fileId}/download`);
      if (!asset.ok) return res.status(502).json({ error: 'error.bookorbit_unreachable' });
      let workBuf = asset.buffer;
      if (!workBuf || workBuf.length < 100) return res.status(502).json({ error: 'error.file_empty' });
      if (isCbrBuffer(workBuf)) { workBuf = await convertCbrToCbz(workBuf); outFormat = 'cbz'; }
      else if (String(format || '').toLowerCase() === 'cbz') { outFormat = 'cbz'; }
      fs.writeFileSync(tmpPath, workBuf);
    } else {
      const headers = { Accept: 'application/epub+zip, */*' };
      if (server.username) {
        const creds = Buffer.from(`${server.username}:${server.password || ''}`).toString('base64');
        headers['Authorization'] = `Basic ${creds}`;
      }
      const r = await fetch(href, { headers, signal: AbortSignal.timeout(120000) });
      if (!r.ok) return res.status(502).json({ error: `error.opds_download_failed_${r.status}` });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('epub') && !ct.includes('octet-stream') && !ct.includes('pdf')) {
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
    }

    const newMd5 = computeFileMd5(tmpPath);
    const destDir = path.join(BOOKS_DIR, String(req.user.id));
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    // Reuse the book's existing filename (already "<file_hash>.<ext>") rather than hardcoding
    // .epub — keeps this correct for CBZ books too, and for a BookOrbit replace whose format
    // matches what's already stored.
    const destPath = path.join(destDir, book.filename);
    fs.renameSync(tmpPath, destPath);

    if (isBookorbit && boBookId) bookorbit.mapLocalBook(req.user.id, book.id, Number(boBookId), Number(fileId));

    // Re-extract all metadata from the new file so genres, description, etc. stay current.
    // Title and author are intentionally preserved in case the user edited them manually.
    const meta = outFormat === 'pdf' ? await extractPdfMetadata(destPath, COVERS_DIR, book.file_hash)
      : outFormat === 'cbz'
      ? extractCbzMetadata(destPath, COVERS_DIR, book.file_hash)
      : extractEpubMetadata(destPath, COVERS_DIR, book.file_hash);
    // PDFs never get a cover from extraction (metadata-only — see server/utils/pdf.js); their
    // cover comes from the client-side render-and-upload flow, so don't clear an existing one.
    const newCoverPath = outFormat === 'pdf' ? (book.cover_path || '') : meta.cover_path;
    db.prepare(`UPDATE books SET
      file_hash_md5 = ?, kosync_hash = '',
      cover_path  = ?,
      description = CASE WHEN ? != '' THEN ? ELSE description END,
      publisher   = CASE WHEN ? != '' THEN ? ELSE publisher   END,
      language    = CASE WHEN ? != '' THEN ? ELSE language    END,
      isbn        = CASE WHEN ? != '' THEN ? ELSE isbn        END,
      genres      = CASE WHEN ? != '' THEN ? ELSE genres      END,
      pages       = CASE WHEN ? > 0   THEN ? ELSE pages       END,
      series_name   = CASE WHEN ? != '' THEN ? ELSE series_name   END,
      series_number = CASE WHEN ? != '' THEN ? ELSE series_number END
    WHERE id = ?`).run(
      newMd5,
      newCoverPath,
      meta.description || '', meta.description || '',
      meta.publisher   || '', meta.publisher   || '',
      meta.language    || '', meta.language    || '',
      meta.isbn        || '', meta.isbn        || '',
      meta.genres      || '', meta.genres      || '',
      meta.pages       || 0,  meta.pages       || 0,
      meta.series_name   || '', meta.series_name   || '',
      meta.series_number || '', meta.series_number || '',
      book.id
    );
    res.json({ file_hash_md5: newMd5, cover_path: newCoverPath });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    console.error('[books] replace file error:', err.message);
    res.status(500).json({ error: 'error.book_replace_failed' });
  }
});

// Re-extract metadata for one book, dispatching to the right format-specific extractor —
// mirrors the isPdf/isCbz/epub three-way already used by the main upload handler above.
// PDFs never get a cover from extraction (extractPdfMetadata is metadata-only — see
// server/utils/pdf.js); their cover comes from the client-side render-and-upload flow
// (POST /:id/cover), so this must NOT unlink/clear an existing PDF cover_path.
async function reextractBookMetadata(book, filePath) {
  const isPdf = book.filename?.endsWith('.pdf') || book.format === 'pdf';
  const isCbz = book.filename?.endsWith('.cbz') || book.format === 'cbz';

  if (!isPdf && book.cover_path) {
    try { fs.unlinkSync(path.join(COVERS_DIR, book.cover_path)); } catch { /* already gone */ }
  }

  const meta = isPdf ? await extractPdfMetadata(filePath, COVERS_DIR, book.file_hash)
    : isCbz ? extractCbzMetadata(filePath, COVERS_DIR, book.file_hash)
    : extractEpubMetadata(filePath, COVERS_DIR, book.file_hash);

  return {
    cover_path:    isPdf ? book.cover_path : meta.cover_path,
    description:   meta.description   || book.description   || '',
    publisher:     meta.publisher     || book.publisher     || '',
    language:      meta.language      || book.language      || '',
    isbn:          meta.isbn          || book.isbn          || '',
    genres:        meta.genres        || book.genres        || '',
    pages:         meta.pages         || book.pages         || '',
    series_name:   meta.series_name   || book.series_name   || '',
    series_number: meta.series_number || book.series_number || '',
  };
}

// ── POST /api/books/reextract-all — re-extract metadata for the given books ──────────────
// Scoped to an explicit selection (bookIds) — never silently touches the whole library.
router.post('/reextract-all', async (req, res) => {
  const db  = getDb();
  const ids = Array.isArray(req.body?.bookIds)
    ? [...new Set(req.body.bookIds.map(Number).filter(Number.isFinite))]
    : null;
  if (!ids || !ids.length) return res.status(400).json({ error: 'error.no_books_selected' });

  const placeholders = ids.map(() => '?').join(',');
  const books = db.prepare(`SELECT * FROM books WHERE user_id = ? AND id IN (${placeholders})`)
    .all(req.user.id, ...ids);

  let updated = 0, failed = 0;
  for (const book of books) {
    const filePath = path.join(BOOKS_DIR, String(req.user.id), book.filename);
    if (!fs.existsSync(filePath)) { failed++; continue; }
    try {
      const f = await reextractBookMetadata(book, filePath);
      db.prepare('UPDATE books SET cover_path = ?, description = ?, publisher = ?, language = ?, isbn = ?, genres = ?, pages = ?, series_name = ?, series_number = ? WHERE id = ?')
        .run(f.cover_path, f.description, f.publisher, f.language, f.isbn, f.genres, f.pages, f.series_name, f.series_number, book.id);
      updated++;
    } catch { failed++; }
  }
  res.json({ total: books.length, updated, failed });
});

// ── POST /api/books/:id/reextract-cover ──────────────────────────────────────
router.post('/:id/reextract-cover', async (req, res) => {
  const db   = getDb();
  const book = db.prepare(
    'SELECT * FROM books WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });

  const filePath = path.join(BOOKS_DIR, String(req.user.id), book.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'error.epub_not_found' });
  }

  const f = await reextractBookMetadata(book, filePath);
  db.prepare('UPDATE books SET cover_path = ?, description = ?, publisher = ?, language = ?, isbn = ?, genres = ?, pages = ?, series_name = ?, series_number = ? WHERE id = ?')
    .run(f.cover_path, f.description, f.publisher, f.language, f.isbn, f.genres, f.pages, f.series_name, f.series_number, book.id);
  res.json({ cover_path: f.cover_path, description: f.description });
});

// GET /api/books/:id/related — BookOrbit "more like this" + series info.
// Only meaningful when BookOrbit extended sync is enabled and this book is mapped to a
// BookOrbit book; otherwise responds with `enabled: false` / empty lists so the client can
// simply hide the section.
router.get('/:id/related', async (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'error.book_not_found' });
  if (!bookorbit.isEnabled(req.user.id)) return res.json({ enabled: false, mapped: false, recommendations: [], seriesBooks: [], nextInSeries: null });

  try {
    res.json(await bookorbit.getRecommendations(req.user.id, book.id));
  } catch (e) {
    res.json({ enabled: true, mapped: false, recommendations: [], seriesBooks: [], nextInSeries: null });
  }
});

// GET /api/books/bookorbit-cover/:boBookId — proxy a cover thumbnail for a BookOrbit-side book
// (used to render "more like this" / series cards, which reference books outside this library).
router.get('/bookorbit-cover/:boBookId', async (req, res) => {
  if (!bookorbit.isEnabled(req.user.id)) return res.status(404).end();
  try {
    const asset = await bookorbit.getCover(req.user.id, req.params.boBookId);
    if (!asset.ok) return res.status(404).end();
    res.set('Content-Type', asset.contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(asset.buffer);
  } catch {
    res.status(404).end();
  }
});

// ── POST /api/books/:id/peek-cleanup — reader's close-signal for an ephemeral peek book ────────
// Fired (best-effort, keepalive) from reader.js's beforeunload handler. Safe to call
// unconditionally: no-ops on a missing or non-ephemeral row, so stale client state can never
// delete a real book. The actual guarantee against a forced close/crash is the background sweep
// (server/index.js), not this route.
router.post('/:id/peek-cleanup', (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!book || !book.peek_expires_at) return res.status(204).end();
  deletePeekRow(db, book);
  res.status(204).end();
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
