// BookOrbit native library browser — read-only browse (libraries/smart scopes/
// collections/series/authors/search) plus "import to Codexa". Distinct from
// server/services/bookorbitSync.js, which is the background push/pull sync engine;
// this file is a thin proxy translating BookOrbit's own API into the shapes the
// client's bookorbit.js panel expects. Off unless BookOrbit sync is enabled
// (server/services/bookorbitSync.js's getContext()/isEnabled()).
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { getDb, DATA_DIR }              = require('../db');
const { authenticateToken }            = require('../middleware/auth');
const { computeFileHash, computeFileMd5, extractEpubMetadata, extractCbzMetadata } = require('../utils/epub');
const { isCbrBuffer, convertCbrToCbz } = require('../utils/cbr');
const { isPdfBuffer, extractPdfMetadata } = require('../utils/pdf');
const { peekFilePath, PEEK_TTL_SECONDS } = require('../utils/peekCleanup');
const bookorbit = require('../services/bookorbitSync');

const router     = express.Router();
const BOOKS_DIR  = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const TMP_DIR    = path.join(DATA_DIR, 'tmp');

router.use(authenticateToken);

function requireContext(req, res) {
  const ctx = bookorbit.getContext(req.user.id);
  if (!ctx) { res.status(403).json({ error: 'error.bookorbit_not_enabled' }); return null; }
  return ctx;
}

// GET /api/bookorbit/test — settings-page "test connection" button. Ignores the enabled
// toggle so credentials can be verified before switching extended sync on.
router.get('/test', async (req, res) => {
  res.json(await bookorbit.checkReachable(req.user.id, { ignoreEnabled: true }));
});

// GET /api/bookorbit/health — active reachability check honoring the enabled toggle.
// Used once per app load to show a warning badge if BookOrbit is enabled but unreachable.
router.get('/health', async (req, res) => {
  res.json(await bookorbit.checkReachable(req.user.id));
});

// GET /api/bookorbit/last-status — passive, no network call: reports the outcome of the
// most recent BookOrbit request (updated as a side effect of every login()/api() call).
// Used by the reader after a chapter/manual push, where a fresh probe would add latency.
router.get('/last-status', (req, res) => {
  res.json(bookorbit.getLastStatus(req.user.id));
});

// Thin GET proxy for the simple "list everything" endpoints. Forwards `q`/`page`/`size` when
// present — series and authors are genuinely paginated server-side (default page size 50);
// libraries/collections/smart-scopes ignore page/size since BookOrbit returns them as a flat,
// unpaginated array.
function proxyList(boPath) {
  return async (req, res) => {
    const ctx = requireContext(req, res);
    if (!ctx) return;
    const params = new URLSearchParams();
    if (req.query.q) params.set('q', String(req.query.q));
    if (req.query.page != null) params.set('page', String(parseInt(req.query.page, 10) || 0));
    if (req.query.size != null) params.set('size', String(Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 50))));
    const qs = params.toString();
    const r = await bookorbit.api(req.user.id, ctx, 'GET', `${boPath}${qs ? `?${qs}` : ''}`);
    if (!r.ok) return res.status(502).json({ error: 'error.bookorbit_unreachable' });
    res.json(r.data);
  };
}

// getDetail() (GET /books/:id) returns authors as [{id,name,sortName}], unlike the BookCard-shaped
// list endpoints (library/collection/series/author query results) which already give plain names.
function mapAuthorNames(authors) {
  return Array.isArray(authors) ? authors.map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean) : [];
}

// /books/search returns a lightweight typeahead row ({id, title, seriesName, libraryName, ...})
// with no cover/files/authors — unlike every other list source here, which returns full BookCard
// rows. Fetch each hit's full detail so search results get the same cover/download affordances
// as browsing a library/collection/etc. Sequential (not Promise.all) to stay gentle on the
// throttler, same spirit as api()'s own pacing/backoff.
async function enrichSearchResults(userId, ctx, rows) {
  const out = [];
  for (const row of rows) {
    const r = await bookorbit.api(userId, ctx, 'GET', `/books/${row.id}`);
    if (!r.ok || !r.data) continue; // skip anything we can't fetch full detail for
    const d = r.data;
    out.push({
      id: d.id,
      title: d.title || row.title,
      authors: mapAuthorNames(d.authors),
      seriesName: d.seriesName ?? row.seriesName ?? null,
      seriesIndex: d.seriesIndex ?? null,
      rating: d.rating ?? null,
      hasCover: d.coverSource != null,
      publisher: d.publisher ?? null,
      pageCount: d.pageCount ?? null,
      language: d.language ?? null,
      addedAt: d.addedAt ?? null,
      files: Array.isArray(d.files) ? d.files : [],
    });
  }
  return out;
}

// BookOrbit's own /books/search always orders by title ascending server-side and accepts no
// sort param at all (SearchBooksDto only has q/limit) — so to honor the client's sort choice for
// search results, sort the (already fetched, <=20 item) array ourselves instead.
function sortSearchItems(items, sortKey) {
  const arr = [...items];
  switch (sortKey) {
    case 'default':    break; // leave BookOrbit's own title-ascending search order untouched
    case 'title_asc':  arr.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
    case 'title_desc': arr.sort((a, b) => (b.title || '').localeCompare(a.title || '')); break;
    case 'author_asc': arr.sort((a, b) => (a.authors?.[0] || '').localeCompare(b.authors?.[0] || '')); break;
    case 'added_asc':  arr.sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || '')); break;
    case 'series_asc':
      arr.sort((a, b) => (a.seriesName || '').localeCompare(b.seriesName || '') || ((a.seriesIndex ?? 0) - (b.seriesIndex ?? 0)));
      break;
    case 'random':
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      break;
    case 'added_desc':
    default:
      arr.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  }
  return arr;
}

router.get('/libraries',    proxyList('/libraries'));
router.get('/smart-scopes', proxyList('/smart-scopes'));
router.get('/collections',  proxyList('/collections'));
router.get('/series',       proxyList('/series'));
router.get('/authors',      proxyList('/authors'));

// Unified sort keys the client can send, mapped to whatever vocabulary each BookOrbit endpoint
// actually accepts. Libraries/collections/smart-scopes go through the full BookQuery `sort`
// array (SORT_FIELDS in @bookorbit/types); series/authors use their own simpler `sort`+`order`
// query params with a narrower field set (no `author`/`random`) — unsupported keys there just
// fall back to that endpoint's own default (seriesIndex/asc for series, addedAt/desc for authors).
// 'default' is intentionally absent from both maps below — some collections/smart scopes are
// already curated in a specific order server-side, so this key deliberately sends no sort
// override at all and just passes through whatever order BookOrbit itself returns.
const BOOK_QUERY_SORT = {
  added_desc:  [{ field: 'addedAt', dir: 'desc' }],
  added_asc:   [{ field: 'addedAt', dir: 'asc' }],
  title_asc:   [{ field: 'title', dir: 'asc' }],
  title_desc:  [{ field: 'title', dir: 'desc' }],
  author_asc:  [{ field: 'author', dir: 'asc' }],
  // Group by series name, then order each series' books by their position within it —
  // both 'series' and 'seriesIndex' are valid BookQuery SORT_FIELDS.
  series_asc:  [{ field: 'series', dir: 'asc' }, { field: 'seriesIndex', dir: 'asc' }],
  random:      [{ field: 'random', dir: 'asc' }],
};
const SIMPLE_SORT = {
  added_desc: { sort: 'addedAt', order: 'desc' },
  added_asc:  { sort: 'addedAt', order: 'asc' },
  title_asc:  { sort: 'title', order: 'asc' },
  title_desc: { sort: 'title', order: 'desc' },
  // Only valid for the /series/:id/books endpoint (ListSeriesBooksDto's SERIES_BOOK_SORTS) — it's
  // also that endpoint's own default. NOT valid for /authors/:id/books (ListAuthorBooksDto has no
  // seriesIndex sort field, an author's books can span unrelated series) — guarded below.
  series_asc: { sort: 'seriesIndex', order: 'asc' },
};

// GET /api/bookorbit/books?source=library|smartScope|collection|series|author|search&id=&q=&sort=&page=&size=
// Normalizes every source's book list to { items, total, page, size } and annotates each
// item with `localBookId` (already-owned in Codexa) via a single batch lookup.
router.get('/books', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;

  const { source, id, q, sort: sortKey } = req.query;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 30));

  let result;
  try {
    if (source === 'library') {
      if (!id) return res.status(400).json({ error: 'error.id_required' });
      const body = { pagination: { page, size } };
      if (q) body.q = String(q);
      if (BOOK_QUERY_SORT[sortKey]) body.sort = BOOK_QUERY_SORT[sortKey];
      const r = await bookorbit.api(req.user.id, ctx, 'POST', `/libraries/${id}/books`, body);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      result = r.data;
    } else if (source === 'collection' || source === 'smartScope') {
      if (!id) return res.status(400).json({ error: 'error.id_required' });
      // Use the full .../books/query endpoint (not the simpler .../books GET) — BookOrbit's
      // simple GET wrapper hardcodes an empty sort server-side, so it can't honor a sort choice.
      const boPath = source === 'collection' ? `/collections/${id}/books/query` : `/smart-scopes/${id}/books/query`;
      const body = { pagination: { page, size } };
      if (q) body.q = String(q);
      if (BOOK_QUERY_SORT[sortKey]) body.sort = BOOK_QUERY_SORT[sortKey];
      const r = await bookorbit.api(req.user.id, ctx, 'POST', boPath, body);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      result = r.data;
    } else if (source === 'series' || source === 'author') {
      if (!id) return res.status(400).json({ error: 'error.id_required' });
      const boPath = source === 'series' ? `/series/${id}/books` : `/authors/${id}/books`;
      const params = new URLSearchParams({ page: String(page), size: String(size) });
      // 'series_asc' (seriesIndex sort) would 400 against the authors endpoint — see SIMPLE_SORT
      // comment above. Falling through to no sort param there just uses that endpoint's own default.
      const simple = (source === 'author' && sortKey === 'series_asc') ? null : SIMPLE_SORT[sortKey];
      if (simple) { params.set('sort', simple.sort); params.set('order', simple.order); }
      const r = await bookorbit.api(req.user.id, ctx, 'GET', `${boPath}?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      result = r.data;
    } else if (source === 'search') {
      if (!q) return res.status(400).json({ error: 'error.q_required' });
      const params = new URLSearchParams({ q: String(q), limit: String(Math.min(20, size)) });
      const r = await bookorbit.api(req.user.id, ctx, 'GET', `/books/search?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rawRows = Array.isArray(r.data) ? r.data : [];
      const items = sortSearchItems(await enrichSearchResults(req.user.id, ctx, rawRows), sortKey);
      result = { items, total: items.length, page: 0, size: items.length };
    } else {
      return res.status(400).json({ error: 'error.invalid_source' });
    }
  } catch (err) {
    return res.status(502).json({ error: 'error.bookorbit_unreachable', detail: err.message });
  }

  const rawItems = Array.isArray(result.items) ? result.items : [];
  const boIds = rawItems.map(b => b.id).filter(Boolean);
  const localByBoId = new Map();
  if (boIds.length) {
    const db = getDb();
    const placeholders = boIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT bo_book_id, book_id FROM bookorbit_sync_state WHERE user_id = ? AND bo_book_id IN (${placeholders})`
    ).all(req.user.id, ...boIds);
    for (const row of rows) localByBoId.set(row.bo_book_id, row.book_id);
  }

  const items = rawItems.map(b => ({
    boBookId: b.id,
    title: b.title,
    authors: b.authors || [],
    seriesName: b.seriesName || null,
    seriesIndex: b.seriesIndex ?? null,
    rating: b.rating ?? null,
    hasCover: !!b.hasCover,
    publisher: b.publisher || null,
    pageCount: b.pageCount ?? null,
    language: b.language || null,
    files: (b.files || []).map(f => ({ id: f.id, format: f.format })),
    localBookId: localByBoId.get(b.id) || null,
  }));

  res.json({ items, total: result.total ?? items.length, page: result.page ?? page, size: result.size ?? size });
});

// GET /api/bookorbit/books/:boBookId/collections — every collection + whether this book
// belongs to it (proxies GET /collections?bookIds=<id>, which annotates each collection with
// memberCount — 0 or 1 for a single book). Lets the client render a checklist.
router.get('/books/:boBookId/collections', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;
  const boBookId = parseInt(req.params.boBookId, 10);
  const r = await bookorbit.api(req.user.id, ctx, 'GET', `/collections?bookIds=${boBookId}`);
  if (!r.ok) return res.status(502).json({ error: 'error.bookorbit_unreachable' });
  const items = (Array.isArray(r.data) ? r.data : []).map(c => ({
    id: c.id,
    name: c.name,
    member: (c.memberCount || 0) > 0,
  }));
  res.json(items);
});

// GET /api/bookorbit/books/:boBookId/detail — rich book detail (description, genres, publisher,
// language, page count, ISBNs, series, rating) straight from BookOrbit's own GET /books/:id, so
// the client can show a proper info dialog even for books never downloaded into Codexa.
router.get('/books/:boBookId/detail', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;
  const boBookId = parseInt(req.params.boBookId, 10);
  const r = await bookorbit.api(req.user.id, ctx, 'GET', `/books/${boBookId}`);
  if (!r.ok || !r.data) return res.status(502).json({ error: 'error.bookorbit_unreachable' });
  const d = r.data;
  res.json({
    title: d.title || null,
    subtitle: d.subtitle || null,
    description: d.description || null,
    authors: mapAuthorNames(d.authors),
    genres: Array.isArray(d.genres) ? d.genres : [],
    tags: Array.isArray(d.tags) ? d.tags : [],
    seriesName: d.seriesName ?? null,
    seriesIndex: d.seriesIndex ?? null,
    publisher: d.publisher ?? null,
    publishedYear: d.publishedYear ?? null,
    language: d.language ?? null,
    pageCount: d.pageCount ?? null,
    isbn13: d.isbn13 ?? null,
    isbn10: d.isbn10 ?? null,
    rating: d.rating ?? null,
    hasCover: d.coverSource != null,
  });
});

// GET /api/bookorbit/books/:boBookId/related — same recommendation engine + series/author
// lookups as the local book info modal's Related tab (server/routes/books.js's
// GET /api/books/:id/related), but keyed directly by BookOrbit's own book id since a book
// browsed here may not be imported into Codexa (no local mapping to resolve).
router.get('/books/:boBookId/related', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;
  const boBookId = parseInt(req.params.boBookId, 10);
  const data = await bookorbit.getRelatedByBoId(req.user.id, ctx, boBookId);
  res.json(data);
});

// PUT/DELETE /api/bookorbit/books/:boBookId/collections/:collectionId — add/remove this book
// from a collection. This is the feature that removes the need to open BookOrbit at all for
// collection assignment.
router.put('/books/:boBookId/collections/:collectionId', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;
  const boBookId = parseInt(req.params.boBookId, 10);
  const r = await bookorbit.api(req.user.id, ctx, 'POST', `/collections/${req.params.collectionId}/books`, { bookIds: [boBookId] });
  if (!r.ok) return res.status(502).json({ error: 'error.bookorbit_unreachable' });
  res.status(204).end();
});

router.delete('/books/:boBookId/collections/:collectionId', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;
  const boBookId = parseInt(req.params.boBookId, 10);
  const r = await bookorbit.api(req.user.id, ctx, 'DELETE', `/collections/${req.params.collectionId}/books`, { bookIds: [boBookId] });
  if (!r.ok) return res.status(502).json({ error: 'error.bookorbit_unreachable' });
  res.status(204).end();
});

// Download a BookOrbit file into Codexa's own library. Mirrors POST /api/opds/download/:id
// (server/routes/opds.js), but the source is BookOrbit's Bearer-token file endpoint instead of
// an OPDS Basic-auth acquisition link. Shared by the single-book import route and the bulk
// collection/smart-scope sync route below — never writes to `res` itself, just returns a result.
const SUPPORTED_FORMATS = new Set(['epub', 'cbz', 'cbr', 'pdf']);

async function importBookOrbitFile(userId, ctx, { boBookId, fileId, format, title, author }) {
  const clientFormat = String(format || '').toLowerCase();
  if (clientFormat && !SUPPORTED_FORMATS.has(clientFormat)) {
    return { ok: false, status: 400, error: 'error.epub_required' };
  }

  const asset = await bookorbit.fetchAsset(userId, ctx, `/books/files/${fileId}/download`);
  if (!asset.ok) return { ok: false, status: 502, error: 'error.bookorbit_unreachable' };

  const buf = asset.buffer;
  if (!buf || buf.length < 100) return { ok: false, status: 502, error: 'error.file_empty' };

  const db = getDb();
  const userDir = path.join(BOOKS_DIR, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let workBuf = buf;
  let outFormat = 'epub';
  const ctLower = (asset.contentType || '').toLowerCase();
  const isPdf = isPdfBuffer(workBuf);
  if (isPdf || ctLower.includes('pdf') || clientFormat === 'pdf') {
    outFormat = 'pdf';
  } else if (isCbrBuffer(workBuf)) {
    workBuf = await convertCbrToCbz(workBuf);
    outFormat = 'cbz';
  } else if (ctLower.includes('cbz') || ctLower.includes('comicbook+zip') || clientFormat === 'cbz') {
    outFormat = 'cbz';
  }
  // EPUB/CBZ are both ZIP containers ('PK' signature); anything defaulting to 'epub' that isn't
  // actually a PDF or a ZIP isn't a real book file at all — most likely BookOrbit's own download
  // endpoint returned an error page/JSON body instead of the asset (confirmed possible: this
  // endpoint's fetchAsset() doesn't itself validate content, so a 200-with-wrong-body slips
  // through as "ok"). Failing clearly here beats writing that response to disk as a fake
  // ".epub"/".pdf" and only discovering it's not a real book once the reader tries to open it.
  if (outFormat === 'epub' && !isPdf && !(workBuf.length >= 2 && workBuf[0] === 0x50 && workBuf[1] === 0x4b)) {
    return { ok: false, status: 502, error: 'error.bookorbit_invalid_file' };
  }

  const tmpPath = path.join(TMP_DIR, `bo_${Date.now()}_${userId}_${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmpPath, workBuf);

  try {
    const fileHash    = computeFileHash(tmpPath);
    const fileHashMd5 = computeFileMd5(tmpPath);

    // Excludes ephemeral peek rows (defense-in-depth — a peek row's file_hash is a synthetic
    // "peek_..." string that can never match a real content hash anyway, see createBookOrbitPeek).
    const existing = db.prepare('SELECT id FROM books WHERE user_id = ? AND file_hash = ? AND peek_expires_at IS NULL').get(userId, fileHash);
    if (existing) {
      fs.unlinkSync(tmpPath);
      bookorbit.mapLocalBook(userId, existing.id, boBookId, Number(fileId));
      return { ok: false, status: 409, error: 'error.book_already_in_library', id: existing.id, alreadyOwned: true };
    }

    const ext      = outFormat === 'pdf' ? '.pdf' : outFormat === 'cbz' ? '.cbz' : '.epub';
    const filename = `${fileHash}${ext}`;
    const destPath = path.join(userDir, filename);
    try { fs.renameSync(tmpPath, destPath); }
    catch { fs.copyFileSync(tmpPath, destPath); fs.unlinkSync(tmpPath); }

    const meta = outFormat === 'pdf' ? await extractPdfMetadata(destPath, COVERS_DIR, fileHash)
      : outFormat === 'cbz'
      ? extractCbzMetadata(destPath, COVERS_DIR, fileHash)
      : extractEpubMetadata(destPath, COVERS_DIR, fileHash);
    const bookTitle  = meta.title  || title  || 'Unknown';
    const bookAuthor = meta.author || author || '';
    const fileSize   = fs.statSync(destPath).size;

    const result = db.prepare(`
      INSERT INTO books (user_id, title, author, series_name, series_number, description, file_hash, file_hash_md5, filename, cover_path, file_size,
                         publisher, language, isbn, genres, pages, format)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, bookTitle, bookAuthor, meta.series_name || '', meta.series_number || '', meta.description || '',
           fileHash, fileHashMd5, filename, meta.cover_path || '', fileSize,
           meta.publisher || '', meta.language || '', meta.isbn || '', meta.genres || '', meta.pages || null, outFormat);

    const newBookId = result.lastInsertRowid;
    bookorbit.mapLocalBook(userId, newBookId, boBookId, Number(fileId));

    return { ok: true, id: newBookId, title: bookTitle, author: bookAuthor };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, status: 500, error: err.message };
  }
}

router.post('/books/:boBookId/import', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;

  const boBookId = parseInt(req.params.boBookId, 10);
  const { fileId, format, title, author } = req.body || {};
  if (!fileId) return res.status(400).json({ error: 'error.file_id_required' });

  try {
    const result = await importBookOrbitFile(req.user.id, ctx, { boBookId, fileId, format, title, author });
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error, id: result.id });
    res.status(201).json({ id: result.id, title: result.title, author: result.author });
  } catch (err) {
    console.error('[bookorbit] import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetch a BookOrbit book for a read-only "peek" without importing it. Deliberately duplicates
// importBookOrbitFile's fetch/CBR-conversion prologue rather than sharing it, to keep that
// well-tested real-import path untouched. Unlike a real import, this never runs metadata
// extraction/cover generation (the client already has title/author/series from the BookOrbit
// card it rendered) and never lands in BOOKS_DIR — the file stays under peekCleanup.js's PEEK_DIR
// and the books row is flagged via peek_expires_at so it's excluded from the library grid and
// reclaimed (row + file) by the background sweep in server/index.js, or sooner via the reader's
// close-signal route (POST /api/books/:id/peek-cleanup in server/routes/books.js).
async function createBookOrbitPeek(userId, ctx, { boBookId, fileId, format, title, author, seriesName, seriesIndex, language }) {
  const clientFormat = String(format || '').toLowerCase();
  if (clientFormat && !SUPPORTED_FORMATS.has(clientFormat)) {
    return { ok: false, status: 400, error: 'error.epub_required' };
  }

  const asset = await bookorbit.fetchAsset(userId, ctx, `/books/files/${fileId}/download`);
  if (!asset.ok) return { ok: false, status: 502, error: 'error.bookorbit_unreachable' };

  const buf = asset.buffer;
  if (!buf || buf.length < 100) return { ok: false, status: 502, error: 'error.file_empty' };

  const db = getDb();
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let workBuf = buf;
  let outFormat = 'epub';
  const ctLower = (asset.contentType || '').toLowerCase();
  const isPdf = isPdfBuffer(workBuf);
  if (isPdf || ctLower.includes('pdf') || clientFormat === 'pdf') {
    outFormat = 'pdf';
  } else if (isCbrBuffer(workBuf)) {
    workBuf = await convertCbrToCbz(workBuf);
    outFormat = 'cbz';
  } else if (ctLower.includes('cbz') || ctLower.includes('comicbook+zip') || clientFormat === 'cbz') {
    outFormat = 'cbz';
  }
  // EPUB/CBZ are both ZIP containers ('PK' signature); anything defaulting to 'epub' that isn't
  // actually a PDF or a ZIP isn't a real book file at all — most likely BookOrbit's own download
  // endpoint returned an error page/JSON body instead of the asset (confirmed possible: this
  // endpoint's fetchAsset() doesn't itself validate content, so a 200-with-wrong-body slips
  // through as "ok"). Failing clearly here beats writing that response to disk as a fake
  // ".epub"/".pdf" and only discovering it's not a real book once the reader tries to open it.
  if (outFormat === 'epub' && !isPdf && !(workBuf.length >= 2 && workBuf[0] === 0x50 && workBuf[1] === 0x4b)) {
    return { ok: false, status: 502, error: 'error.bookorbit_invalid_file' };
  }

  const stagingPath = path.join(TMP_DIR, `bo_peek_${Date.now()}_${userId}_${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(stagingPath, workBuf);

  try {
    const fileHash = computeFileHash(stagingPath);

    // Already really downloaded — return the real book instead of creating anything ephemeral.
    const existing = db.prepare('SELECT id FROM books WHERE user_id = ? AND file_hash = ? AND peek_expires_at IS NULL').get(userId, fileHash);
    if (existing) {
      fs.unlinkSync(stagingPath);
      bookorbit.mapLocalBook(userId, existing.id, boBookId, Number(fileId));
      return { ok: true, id: existing.id, ephemeral: false };
    }

    // Synthetic, structurally distinct from any real SHA-256 hex hash — can never collide with
    // UNIQUE(user_id, file_hash) against a real book, even from a concurrent second peek of the
    // same book (each gets its own timestamp+random suffix). Deliberately NOT setting
    // file_hash_md5 (left at its default '') — bookorbitSync.js's resolveBooks() only attempts a
    // BookOrbit hash-match lookup when file_hash_md5 is truthy, so leaving it empty means
    // POST /api/books/:id/opened's triggerSync() never wastes a round-trip on this row, and this
    // row's transient reading_sessions can never get synced into BookOrbit before cleanup runs.
    const peekHash = `peek_${boBookId}_${fileId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const ext      = outFormat === 'pdf' ? '.pdf' : outFormat === 'cbz' ? '.cbz' : '.epub';
    const filename = `${peekHash}${ext}`;
    const destPath = peekFilePath(userId, filename);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try { fs.renameSync(stagingPath, destPath); }
    catch { fs.copyFileSync(stagingPath, destPath); fs.unlinkSync(stagingPath); }

    const fileSize = fs.statSync(destPath).size;
    const result = db.prepare(`
      INSERT INTO books (user_id, title, author, series_name, series_number, file_hash, filename, cover_path, file_size, format, language, peek_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, title || 'Unknown', author || '', seriesName || '', seriesIndex != null ? String(seriesIndex) : '',
           peekHash, filename, '', fileSize, outFormat, language || '', Math.floor(Date.now() / 1000) + PEEK_TTL_SECONDS);

    return { ok: true, id: result.lastInsertRowid, ephemeral: true };
  } catch (err) {
    try { fs.unlinkSync(stagingPath); } catch { /* ignore */ }
    return { ok: false, status: 500, error: err.message };
  }
}

router.post('/books/:boBookId/peek', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;

  const boBookId = parseInt(req.params.boBookId, 10);
  const { fileId, format, title, author, seriesName, seriesIndex, language } = req.body || {};
  if (!fileId) return res.status(400).json({ error: 'error.file_id_required' });

  try {
    const result = await createBookOrbitPeek(req.user.id, ctx, { boBookId, fileId, format, title, author, seriesName, seriesIndex, language });
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
    res.status(201).json({ id: result.id, ephemeral: result.ephemeral });
  } catch (err) {
    console.error('[bookorbit] peek error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Sync a whole collection/smart-scope into a Codexa shelf (mirrors OPDS folder sync) ──
// Additive-only for v1: downloads books not yet owned and links them (+ the shelf) to their
// BookOrbit origin. No staleness detection (books removed from the collection upstream aren't
// pruned from the shelf) — a reasonable first cut, same simplification called out in the plan.

function bookOrbitListPath(source, id) {
  if (source === 'collection') return `/collections/${id}/books`;
  if (source === 'smartScope') return `/smart-scopes/${id}/books`;
  return null;
}

// Fetch every book in a collection/smart-scope across all pages (BookOrbit paginates at 100/page).
async function fetchAllBookOrbitBooks(userId, ctx, source, id) {
  const boPath = bookOrbitListPath(source, id);
  if (!boPath) return [];
  const all = [];
  let page = 0;
  const size = 100;
  for (;;) {
    const r = await bookorbit.api(userId, ctx, 'GET', `${boPath}?${new URLSearchParams({ page: String(page), size: String(size) })}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    all.push(...items);
    if (items.length < size) break;
    page++;
  }
  return all;
}

// GET /api/bookorbit/sync-count?source=collection|smartScope&id= — preflight counts for the
// sync modal (total books vs. already owned), same purpose as GET /api/opds/sync-count.
router.get('/sync-count', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;
  const { source, id } = req.query;
  if (!id || !bookOrbitListPath(source, id)) return res.status(400).json({ error: 'error.invalid_source' });

  try {
    const books = await fetchAllBookOrbitBooks(req.user.id, ctx, source, id);
    const boIds = books.map(b => b.id).filter(Boolean);
    let alreadyHave = 0;
    if (boIds.length) {
      const db = getDb();
      const placeholders = boIds.map(() => '?').join(',');
      alreadyHave = db.prepare(
        `SELECT COUNT(*) AS n FROM bookorbit_sync_state WHERE user_id = ? AND bo_book_id IN (${placeholders})`
      ).get(req.user.id, ...boIds).n;
    }
    res.json({ total: books.length, alreadyHave });
  } catch (err) {
    res.status(502).json({ error: 'error.bookorbit_unreachable', detail: err.message });
  }
});

// GET /api/bookorbit/sync-sse?source=&id=&shelfName=&shelfId=&limit=&token= — stream sync
// progress via SSE. Unlike opds.js's sync-sse, this doesn't need to sit before
// authenticateToken — that middleware already accepts the JWT via ?token= as a fallback to
// the Authorization header, which is all EventSource needs (it can't set custom headers).
router.get('/sync-sse', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;

  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const done = (obj) => { send(obj); if (!res.writableEnded) res.end(); };

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const { source, id, shelfName } = req.query;
  const limitParam = req.query.limit ? parseInt(req.query.limit, 10) : null;
  if (!id || !bookOrbitListPath(source, id)) return done({ type: 'error', message: 'error.invalid_source' });
  if (!req.query.shelfId && (!shelfName || !String(shelfName).trim())) return done({ type: 'error', message: 'error.shelf_name_required' });

  try {
    const allBooks = await fetchAllBookOrbitBooks(req.user.id, ctx, source, id);
    const books = (limitParam && limitParam > 0) ? allBooks.slice(0, limitParam) : allBooks;
    if (!books.length) return done({ type: 'done', added: 0, skipped: 0, errors: 0, shelfId: null });

    send({ type: 'start', total: books.length });

    const db = getDb();
    const cleanName = String(shelfName || '').trim().slice(0, 100);
    const fixedShelfId = req.query.shelfId ? parseInt(req.query.shelfId, 10) : null;
    let shelf;
    if (fixedShelfId) {
      shelf = db.prepare('SELECT id FROM shelves WHERE id = ? AND user_id = ?').get(fixedShelfId, req.user.id);
      if (!shelf) return done({ type: 'error', message: 'error.shelf_not_found' });
    } else {
      shelf = db.prepare('SELECT id FROM shelves WHERE user_id = ? AND name = ?').get(req.user.id, cleanName);
      if (!shelf) {
        const r = db.prepare('INSERT INTO shelves (user_id, name) VALUES (?, ?)').run(req.user.id, cleanName);
        shelf = { id: r.lastInsertRowid };
      }
    }

    db.prepare(`UPDATE shelves SET bo_collection_id = ?, bo_smart_scope_id = ?, last_synced_at = ? WHERE id = ?`).run(
      source === 'collection' ? Number(id) : null,
      source === 'smartScope' ? Number(id) : null,
      Math.floor(Date.now() / 1000),
      shelf.id,
    );

    // Collect pre-existing book IDs in the shelf (to detect stale books after sync — same
    // approach as opds.js's sync-sse: anything that was on the shelf before but isn't touched
    // by this sync is a candidate for "no longer in the source").
    const preExistingBookIds = new Set();
    db.prepare('SELECT book_id FROM book_shelves WHERE shelf_id = ?')
      .all(shelf.id)
      .forEach(row => preExistingBookIds.add(row.book_id));

    let added = 0, skipped = 0, errors = 0;
    const syncedBookIds = new Set(); // track all book IDs touched by this sync
    const localByBoId = new Map();
    const boIds = books.map(b => b.id).filter(Boolean);
    if (boIds.length) {
      const placeholders = boIds.map(() => '?').join(',');
      db.prepare(`SELECT bo_book_id, book_id FROM bookorbit_sync_state WHERE user_id = ? AND bo_book_id IN (${placeholders})`)
        .all(req.user.id, ...boIds)
        .forEach(row => localByBoId.set(row.bo_book_id, row.book_id));
    }

    const addToShelf = db.prepare('INSERT OR IGNORE INTO book_shelves (shelf_id, book_id) VALUES (?, ?)');

    for (let i = 0; i < books.length; i++) {
      if (cancelled) break;
      const b = books[i];
      send({ type: 'progress', current: i + 1, total: books.length, book: b.title || '' });

      const existingLocalId = localByBoId.get(b.id);
      if (existingLocalId) {
        addToShelf.run(shelf.id, existingLocalId);
        syncedBookIds.add(existingLocalId);
        skipped++;
        continue;
      }

      const primaryFile = (b.files || [])[0];
      if (!primaryFile) { errors++; continue; }

      try {
        const result = await importBookOrbitFile(req.user.id, ctx, {
          boBookId: b.id, fileId: primaryFile.id, format: primaryFile.format,
          title: b.title, author: (b.authors || [])[0],
        });
        if (result.ok) {
          addToShelf.run(shelf.id, result.id);
          syncedBookIds.add(result.id);
          added++;
        } else if (result.alreadyOwned && result.id) {
          addToShelf.run(shelf.id, result.id);
          syncedBookIds.add(result.id);
          skipped++;
        } else {
          errors++;
        }
      } catch (err) {
        console.error('[bookorbit/sync-sse] error for book:', b.title, err.message);
        errors++;
      }
    }

    // Detect stale books: in shelf before sync but NOT touched by this sync (i.e. no longer in
    // the BookOrbit collection/smart scope/library). Fallback: if a limit truncated this sync run,
    // a book might still genuinely be in the source but beyond the limited slice — check its
    // bo_book_id against the FULL unlimited listing (allBooks) before calling it stale.
    const staleBooks = [];
    if (preExistingBookIds.size > 0) {
      const allBoIds = new Set(allBooks.map(b => b.id));
      for (const bookId of preExistingBookIds) {
        if (syncedBookIds.has(bookId)) continue;
        const state = db.prepare('SELECT bo_book_id FROM bookorbit_sync_state WHERE user_id = ? AND book_id = ?').get(req.user.id, bookId);
        if (state?.bo_book_id != null && allBoIds.has(state.bo_book_id)) continue;
        const bk = db.prepare('SELECT id, title, author FROM books WHERE id = ?').get(bookId);
        if (bk) {
          const { cnt: otherShelfCount } = db.prepare(
            'SELECT COUNT(*) AS cnt FROM book_shelves WHERE book_id = ? AND shelf_id != ?'
          ).get(bookId, shelf.id) || { cnt: 0 };
          staleBooks.push({ ...bk, otherShelfCount });
        }
      }
    }

    done({ type: 'done', added, skipped, errors, shelfId: shelf.id, staleBooks });
  } catch (err) {
    console.error('[bookorbit] sync-sse error:', err.message);
    done({ type: 'error', message: err.message });
  }
});

// ── BookOrbit Dash — account-wide reading stats, powered by BookOrbit's own ──
// /dashboard/widgets/* endpoints (the same ones its web client uses). Distinct from Codexa's own
// local /api/stats: these numbers cover the whole BookOrbit account (KOReader/Kobo/manual
// sessions too, plus concepts Codexa has no equivalent of like a yearly reading goal), not just
// activity that happened inside Codexa.

// GET /api/bookorbit/dashboard — fetches every widget in parallel. Each is independent — one
// widget failing (or legitimately returning null, e.g. highlight-of-the-day with zero
// annotations) doesn't blank the rest of the page; only a total connectivity failure 502s.
const DASHBOARD_WIDGETS = {
  readingGoal:       '/dashboard/widgets/reading-goal',
  readingStreak:      '/dashboard/widgets/reading-streak',
  currentlyReading:   '/dashboard/widgets/currently-reading',
  libraryOverview:    '/dashboard/widgets/library-overview',
  highlightOfTheDay:  '/dashboard/widgets/highlight-of-the-day',
};

router.get('/dashboard', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;

  const entries = await Promise.all(
    Object.entries(DASHBOARD_WIDGETS).map(async ([key, p]) => [key, await bookorbit.api(req.user.id, ctx, 'GET', p)])
  );

  const out = {};
  let anyOk = false;
  for (const [key, r] of entries) {
    out[key] = r.ok ? r.data : null;
    anyOk = anyOk || r.ok;
  }
  if (!anyOk) return res.status(502).json({ error: 'error.bookorbit_unreachable' });

  // Annotate currentlyReading books + the highlight-of-the-day book with localBookId, same batch
  // lookup as GET /books above, so the client can link straight into the reader for anything
  // already downloaded instead of always falling back to a non-interactive row.
  const boIds = [
    ...(out.currentlyReading?.books || []).map(b => b.bookId),
    out.highlightOfTheDay?.bookId,
  ].filter(Boolean);
  if (boIds.length) {
    const db = getDb();
    const placeholders = boIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT bo_book_id, book_id FROM bookorbit_sync_state WHERE user_id = ? AND bo_book_id IN (${placeholders})`
    ).all(req.user.id, ...boIds);
    const localByBoId = new Map(rows.map(r => [r.bo_book_id, r.book_id]));
    if (out.currentlyReading?.books) {
      out.currentlyReading.books = out.currentlyReading.books.map(b => ({ ...b, localBookId: localByBoId.get(b.bookId) || null }));
    }
    if (out.highlightOfTheDay) {
      out.highlightOfTheDay.localBookId = localByBoId.get(out.highlightOfTheDay.bookId) || null;
    }
  }

  res.json(out);
});

// PUT /api/bookorbit/dashboard/goal — body: { goalBooks: number|null }. null clears the goal.
router.put('/dashboard/goal', async (req, res) => {
  const ctx = requireContext(req, res);
  if (!ctx) return;

  const goalBooks = req.body?.goalBooks ?? null;
  if (goalBooks !== null && (!Number.isInteger(goalBooks) || goalBooks < 0)) {
    return res.status(400).json({ error: 'error.invalid_goal' });
  }

  const r = await bookorbit.api(req.user.id, ctx, 'PATCH', '/users/me/settings', {
    settings: { dashboardConfig: { readingGoal: goalBooks } },
  });
  if (!r.ok) return res.status(502).json({ error: 'error.bookorbit_unreachable' });
  res.status(204).end();
});

module.exports = router;
