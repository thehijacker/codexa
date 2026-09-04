// OPDS proxy — fetches and normalises OPDS catalogs on behalf of the browser.
// Runs server-side so there are no CORS issues with external servers.
// Supports OPDS 1.x (Atom/XML) and OPDS 2.x (JSON).

const express    = require('express');
const jwt        = require('jsonwebtoken');
const { XMLParser } = require('fast-xml-parser');
const { getDb }             = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// ── Cover proxy — JWT via ?token= so <img src> tags work ─────────────────────
// This route is registered BEFORE authenticateToken middleware.
router.get('/cover', (req, res) => {
  const token = req.query.token || '';
  if (!token) return res.status(401).end();
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).end(); }

  const coverUrl = String(req.query.url || '');
  if (!coverUrl.startsWith('http')) return res.status(400).end();

  const servers = getServers(user.id);
  const server  = getServerById(servers, req.query.server);
  const headers = server ? buildAuthHeaders(server.username, server.password) : {};

  fetch(coverUrl, { headers, signal: AbortSignal.timeout(8000) })
    .then(async r => {
      if (!r.ok) return res.status(404).end();
      const ct = r.headers.get('content-type') || '';
      // Some servers return an HTML auth-redirect page with 200 OK — reject non-image responses
      // so the browser reliably fires onerror and shows the placeholder instead of a blank box.
      if (!ct.startsWith('image/') && !ct.startsWith('application/octet-stream') && ct !== '') {
        return res.status(404).end();
      }
      const buf = await r.arrayBuffer();
      res.set('Content-Type', ct || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(Buffer.from(buf));
    })
    .catch(() => res.status(404).end());
});

// ── GET /api/opds/sync-sse — stream sync progress via SSE ─────────────────────
// Auth via ?token=JWT — must stay BEFORE router.use(authenticateToken)
router.get('/sync-sse', async (req, res) => {
  // Authenticate via token query param
  const token = req.query.token || '';
  if (!token) return res.status(401).end();
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).end(); }

  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const done = (obj) => {
    send(obj);
    if (!res.writableEnded) res.end();
  };

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const { serverId, folderUrl, shelfName } = req.query;
  const limitParam = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const force  = req.query.force  === '1';
  const silent = req.query.silent === '1';
  if (serverId === undefined || serverId === null) return done({ type: 'error', message: 'error.server_id_required' });
  if (!req.query.shelfId && (!shelfName || !String(shelfName).trim())) return done({ type: 'error', message: 'error.shelf_name_required' });

  const servers = getServers(user.id);
  const server  = getServerById(servers, serverId);
  if (!server) return done({ type: 'error', message: 'error.server_not_found' });

  const targetUrl = folderUrl ? resolveUrl(String(folderUrl), server.url) : server.url;

  try {
    const feed = await fetchAllOpdsPages(targetUrl, server);
    feed.entries = feed.entries.map(e => ({
      ...e,
      acqHref: resolveUrl(e.acqHref, targetUrl),
      navHref: resolveUrl(e.navHref, targetUrl),
    }));

    const allBookEntries = feed.entries.filter(e => !e.isNav && e.acqHref);
    const bookEntries = (limitParam && limitParam > 0)
      ? allBookEntries.slice(0, limitParam)
      : allBookEntries;
    if (!bookEntries.length) return done({ type: 'done', added: 0, skipped: 0, refreshed: 0, errors: 0, shelfId: null });

    send({ type: 'start', total: bookEntries.length });

    const fs   = require('fs');
    const path = require('path');
    const { DATA_DIR }                                                           = require('../db');
    const { computeFileHash, computeFileMd5, extractEpubMetadata, extractCbzMetadata } = require('../utils/epub');
    const { isCbrBuffer, convertCbrToCbz }                                      = require('../utils/cbr');
    const { isPdfBuffer, extractPdfMetadata }                                   = require('../utils/pdf');
    const db         = getDb();
    const TMP_DIR    = path.join(DATA_DIR, 'tmp');
    const BOOKS_DIR  = path.join(DATA_DIR, 'books');
    const COVERS_DIR = path.join(DATA_DIR, 'covers');
    const userDir    = path.join(BOOKS_DIR, String(user.id));
    fs.mkdirSync(userDir, { recursive: true });

    const cleanName = String(shelfName).trim().slice(0, 100);
    const fixedShelfId = req.query.shelfId ? parseInt(req.query.shelfId, 10) : null;
    let shelf;
    if (fixedShelfId) {
      shelf = db.prepare('SELECT id FROM shelves WHERE id = ? AND user_id = ?').get(fixedShelfId, user.id);
      if (!shelf) return done({ type: 'error', message: 'error.shelf_not_found' });
    } else {
      shelf = db.prepare('SELECT id FROM shelves WHERE user_id = ? AND name = ?').get(user.id, cleanName);
    }

    // Collect pre-existing book IDs in the shelf (to detect stale books after sync)
    const preExistingBookIds = new Set();
    if (shelf) {
      db.prepare('SELECT book_id FROM book_shelves WHERE shelf_id = ?')
        .all(shelf.id)
        .forEach(row => preExistingBookIds.add(row.book_id));
    }

    if (!shelf) {
      const r = db.prepare('INSERT INTO shelves (user_id, name) VALUES (?, ?)').run(user.id, cleanName);
      shelf = { id: r.lastInsertRowid };
    }

    // Record OPDS origin and sync timestamp so the shelf stays linked to its source folder
    db.prepare('UPDATE shelves SET opds_server_id = ?, opds_folder_url = ?, last_synced_at = ? WHERE id = ?')
      .run(parseInt(serverId, 10), folderUrl || null, Math.floor(Date.now() / 1000), shelf.id);

    const headers = buildAuthHeaders(server.username, server.password);
    let added = 0, skipped = 0, refreshed = 0, errors = 0;
    const syncedBookIds = new Set(); // track all book IDs touched by this sync
    // All acquisition URLs present in the feed (full list, not the limited slice) — used for stale detection fallback
    const feedAcqHrefs = new Set(allBookEntries.map(e => e.acqHref).filter(Boolean));

    for (let i = 0; i < bookEntries.length; i++) {
      if (cancelled) break;
      const entry = bookEntries[i];
      send({ type: 'progress', current: i + 1, total: bookEntries.length, book: entry.title || '' });
      try {
        // Fast path: skip download if we already processed this acqHref (skipped when force=true)
        if (!force && entry.acqHref) {
          const src = db.prepare('SELECT book_id FROM book_opds_sources WHERE user_id = ? AND acq_href = ?').get(user.id, entry.acqHref);
          if (src) {
            db.prepare('INSERT OR IGNORE INTO book_shelves (shelf_id, book_id) VALUES (?, ?)').run(shelf.id, src.book_id);
            syncedBookIds.add(src.book_id);
            skipped++;
            continue;
          }
        }

        const r = await fetch(entry.acqHref, { headers, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        let buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 100) throw new Error('error.file_empty');

        let format = 'epub';
        if (isPdfBuffer(buf)) {
          format = 'pdf';
        } else if (isCbrBuffer(buf)) {
          console.log('[opds/sse] converting CBR → CBZ:', entry.title);
          buf = await convertCbrToCbz(buf);
          format = 'cbz';
        }

        const tmpPath = path.join(TMP_DIR, `sse_${Date.now()}_${user.id}.tmp`);
        fs.writeFileSync(tmpPath, buf);
        try {
          const fileHash    = computeFileHash(tmpPath);
          const fileHashMd5 = computeFileMd5(tmpPath);

          // Force mode: if we already own a book from this URL, overwrite its file and re-extract metadata
          if (force && entry.acqHref) {
            const src = db.prepare('SELECT book_id FROM book_opds_sources WHERE user_id = ? AND acq_href = ?').get(user.id, entry.acqHref);
            if (src) {
              const existingBook = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(src.book_id, user.id);
              if (existingBook) {
                const destPath = path.join(userDir, existingBook.filename || (existingBook.file_hash + '.epub'));
                try { fs.renameSync(tmpPath, destPath); }
                catch { fs.copyFileSync(tmpPath, destPath); fs.unlinkSync(tmpPath); }
                const isPdfExisting = format === 'pdf' || existingBook.format === 'pdf' || existingBook.filename?.endsWith('.pdf');
                const isCbzExisting = existingBook.format === 'cbz' || existingBook.filename?.endsWith('.cbz');
                const meta = isPdfExisting ? await extractPdfMetadata(destPath, COVERS_DIR, existingBook.file_hash)
                  : isCbzExisting
                  ? extractCbzMetadata(destPath, COVERS_DIR, existingBook.file_hash)
                  : extractEpubMetadata(destPath, COVERS_DIR, existingBook.file_hash);
                if (!meta.cover_path && entry.cover) {
                  meta.cover_path = await fetchCoverToFile(resolveUrl(entry.cover, targetUrl), headers, COVERS_DIR, existingBook.file_hash);
                }
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
                  fileHashMd5,
                  meta.cover_path,
                  meta.description || '', meta.description || '',
                  meta.publisher   || '', meta.publisher   || '',
                  meta.language    || '', meta.language    || '',
                  meta.isbn        || '', meta.isbn        || '',
                  meta.genres      || '', meta.genres      || '',
                  meta.pages || 0,  meta.pages || 0,
                  existingBook.id
                );
                db.prepare('INSERT OR IGNORE INTO book_shelves (shelf_id, book_id) VALUES (?, ?)').run(shelf.id, existingBook.id);
                syncedBookIds.add(existingBook.id);
                refreshed++;
                continue;
              }
            }
          }

          let book = db.prepare('SELECT id FROM books WHERE user_id = ? AND file_hash = ?').get(user.id, fileHash);
          if (!book) {
            const ext      = format === 'pdf' ? '.pdf' : format === 'cbz' ? '.cbz' : '.epub';
            const filename = `${fileHash}${ext}`;
            const destPath = path.join(userDir, filename);
            try { fs.renameSync(tmpPath, destPath); }
            catch { fs.copyFileSync(tmpPath, destPath); fs.unlinkSync(tmpPath); }
            const meta = format === 'pdf' ? await extractPdfMetadata(destPath, COVERS_DIR, fileHash)
              : format === 'cbz'
              ? extractCbzMetadata(destPath, COVERS_DIR, fileHash)
              : extractEpubMetadata(destPath, COVERS_DIR, fileHash);
            if (!meta.cover_path && entry.cover) {
              meta.cover_path = await fetchCoverToFile(resolveUrl(entry.cover, targetUrl), headers, COVERS_DIR, fileHash);
            }
            const bookTitle  = meta.title  || entry.title  || 'Unknown';
            const bookAuthor = meta.author || entry.author || '';
            const fileSize   = fs.statSync(destPath).size;
            const ins = db.prepare(`
              INSERT INTO books (user_id, title, author, series_name, series_number, description,
                                 file_hash, file_hash_md5, filename, cover_path, file_size,
                                 publisher, language, isbn, genres, pages, format)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(user.id, bookTitle, bookAuthor,
                   meta.series_name || '', meta.series_number || '', meta.description || entry.summary || '',
                   fileHash, fileHashMd5, filename, meta.cover_path, fileSize,
                   meta.publisher || '', meta.language || '', meta.isbn || '', meta.genres || '', meta.pages || null, format);
            book = { id: ins.lastInsertRowid };
            added++;
          } else {
            try { fs.unlinkSync(tmpPath); } catch { /* already saved */ }
            skipped++;
          }
          if (entry.acqHref) {
            db.prepare('INSERT OR IGNORE INTO book_opds_sources (user_id, book_id, acq_href) VALUES (?, ?, ?)').run(user.id, book.id, entry.acqHref);
          }
          db.prepare('INSERT OR IGNORE INTO book_shelves (shelf_id, book_id) VALUES (?, ?)').run(shelf.id, book.id);
          syncedBookIds.add(book.id);
        } catch (innerErr) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw innerErr;
        }
      } catch (err) {
        console.error('[opds/sync-sse] error for entry:', entry.title, err.message);
        errors++;
      }
    }

    // Detect stale books: in shelf before sync but NOT touched by this sync.
    // Skipped for silent (background) syncs — only shown on manual sync.
    const staleBooks = [];
    let autoRemoved = 0;
    if (!silent && preExistingBookIds.size > 0) {
      const unlinkFromShelf = db.prepare('DELETE FROM book_shelves WHERE shelf_id = ? AND book_id = ?');
      for (const bookId of preExistingBookIds) {
        if (syncedBookIds.has(bookId)) continue;
        // Fallback: check if any known acq_href for this book is in the current feed
        const sources = db.prepare('SELECT acq_href FROM book_opds_sources WHERE user_id = ? AND book_id = ?').all(user.id, bookId);
        const appearsInFeed = sources.some(s => feedAcqHrefs.has(s.acq_href));
        if (appearsInFeed) continue;
        const b = db.prepare('SELECT id, title, author FROM books WHERE id = ?').get(bookId);
        if (!b) continue;
        const { cnt: otherShelfCount } = db.prepare(
          'SELECT COUNT(*) AS cnt FROM book_shelves WHERE book_id = ? AND shelf_id != ?'
        ).get(bookId, shelf.id) || { cnt: 0 };
        if (otherShelfCount > 0) {
          // Still present on at least one other shelf — unlinking from just THIS shelf is always
          // safe (nothing is lost), so do it automatically instead of making the user click
          // through a "Delete" dialog for a book they may still be actively reading elsewhere.
          // See the identical fix + rationale in server/routes/bookorbit.js's own sync-sse.
          unlinkFromShelf.run(shelf.id, bookId);
          autoRemoved++;
          continue;
        }
        staleBooks.push({ ...b, otherShelfCount });
      }
    }

    done({ type: 'done', added, skipped, refreshed, errors, shelfId: shelf.id, staleBooks, autoRemoved });
  } catch (err) {
    console.error('[opds] sync-sse error:', err.message);
    done({ type: 'error', message: err.message });
  }
});

router.use(authenticateToken);

// ── Helpers ───────────────────────────────────────────────────────────────────
function getServers(userId) {
  const db  = getDb();
  const row = db.prepare('SELECT opds_servers FROM user_settings WHERE user_id = ?').get(userId);
  try { return JSON.parse(row?.opds_servers || '[]'); } catch { return []; }
}

function buildAuthHeaders(username, password) {
  const headers = { 'Accept': 'application/atom+xml, application/xml, application/json, */*' };
  if (username) {
    const creds = Buffer.from(`${username}:${password || ''}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  }
  return headers;
}

// Fallback cover source for a freshly-downloaded book: used only when our own extraction
// (extractEpubMetadata/extractCbzMetadata — and PDF, which never even attempts extraction, see
// server/utils/pdf.js) came back with no cover_path. The OPDS server already serves a cover for
// every catalog entry (that's what renders the browse-grid thumbnails via the /cover proxy
// above), so this is strictly additive, not a replacement for extraction — an embedded cover is
// still preferred when we can get one, since it's guaranteed to match the actual downloaded file.
// Same content-type/size/timeout guards as the /cover proxy route, just persisted to disk
// instead of streamed to the browser. Failure is always silent (return '') — a missing cover
// here just falls back to the placeholder, same as any book with no cover_path.
async function fetchCoverToFile(coverUrl, headers, coversDir, fileHash) {
  if (!coverUrl) return '';
  try {
    const r = await fetch(coverUrl, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/') && !ct.startsWith('application/octet-stream') && ct !== '') return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) return ''; // too small to be a real cover — likely an error page/pixel
    const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg';
    const filename = `${fileHash}${ext}`;
    require('fs').writeFileSync(require('path').join(coversDir, filename), buf);
    return filename;
  } catch (err) {
    console.warn('[opds] cover fallback fetch failed:', err.message);
    return '';
  }
}

function getServerById(servers, id) {
  const idx = parseInt(id, 10);
  if (isNaN(idx) || idx < 0 || idx >= servers.length) return null;
  return servers[idx];
}

// Annotate book entries with the local book id already tracked for them (if any), so the
// client can show Read/Peek immediately instead of only discovering ownership reactively via
// a 409 from the download route. Matches the same acq_href key used everywhere else in this
// file (see book_opds_sources inserts/lookups below).
function annotateLocalOwnership(entries, userId) {
  const db   = getDb();
  const rows = db.prepare('SELECT acq_href, book_id FROM book_opds_sources WHERE user_id = ?').all(userId);
  const map  = new Map(rows.map(r => [r.acq_href, r.book_id]));
  return entries.map(e => ({
    ...e,
    localBookId: (e.acqHref && map.get(e.acqHref)) || null,
  }));
}

// ── OPDS 1.x XML parser config ────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes:       false,
  attributeNamePrefix:    '@_',
  textNodeName:           '#text',
  allowBooleanAttributes: true,
  processEntities:        false,
  isArray: (name) => ['entry', 'link', 'author', 'category', 'dc:subject', 'Url'].includes(name),
});

// Strip HTML tags from a string (for book summaries that contain markup)
function stripHtml(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Decode common XML/HTML entities in text values (processEntities is off to avoid limit errors)
function decodeEntities(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// ── Normalise a parsed OPDS 1.x feed to a common format ──────────────────────
function normaliseAtomFeed(feed) {
  const channel = feed?.feed || {};
  const entries = (channel.entry || []).map(e => {
    const links = e.link || [];
    const acqLink = links.find(l =>
      (l['@_rel'] || '').includes('acquisition') ||
      (l['@_type'] || '').includes('epub')
    );
    const navLink = links.find(l =>
      (l['@_rel'] || '') === 'subsection' ||
      (l['@_type'] || '').includes('opds-catalog')
    );
    const coverLink = links.find(l =>
      (l['@_rel'] || '').includes('thumbnail') ||
      (l['@_rel'] || '').includes('image') ||
      (l['@_rel'] || '').toLowerCase() === 'cover'
    );
    const titleVal   = e.title?.['#text'] || e.title || '';
    const authorVal   = e.author?.[0]?.name?.['#text'] || e.author?.[0]?.name || '';
    const summaryVal  = e.summary?.['#text'] || e.summary || e.content?.['#text'] || '';
    return {
      id:       e.id?.['#text'] || e.id || '',
      title:    decodeEntities(typeof titleVal   === 'object' ? (titleVal['#text']   || '') : String(titleVal)),
      author:   decodeEntities(typeof authorVal  === 'object' ? '' : String(authorVal)),
      summary:  stripHtml(decodeEntities(typeof summaryVal === 'object' ? '' : String(summaryVal))),
      cover:    decodeEntities(coverLink?.['@_href'] || ''),
      acqHref:  decodeEntities(acqLink?.['@_href']  || ''),
      acqType:  decodeEntities(acqLink?.['@_type']  || ''),
      navHref:  decodeEntities(navLink?.['@_href']  || ''),
      isNav:    !!navLink && !acqLink,
    };
  });

  const selfLink = (channel.link || []).find(l => (l['@_rel'] || '') === 'self');
  const upLink   = (channel.link || []).find(l => (l['@_rel'] || '') === 'up');
  const nextLink = (channel.link || []).find(l => (l['@_rel'] || '') === 'next');
  const titleVal = channel.title?.['#text'] || channel.title || '';
  return {
    version: 1,
    title:   decodeEntities(typeof titleVal === 'object' ? (titleVal['#text'] || 'Katalog') : String(titleVal)),
    self:    selfLink?.['@_href'] || '',
    up:      upLink?.['@_href']  || '',
    next:    decodeEntities(nextLink?.['@_href'] || ''),
    entries,
  };
}

// ── Normalise OPDS 2.x JSON to the same format ────────────────────────────────
function normaliseOpds2Feed(data) {
  const publications = data.publications || [];
  const navigation   = data.navigation   || [];

  const entries = [
    ...navigation.map(n => ({
      id:      n.href || '',
      title:   n.title || '',
      author:  '',
      summary: '',
      cover:   '',
      acqHref: '',
      acqType: '',
      navHref: n.href || '',
      isNav:   true,
    })),
    ...publications.map(p => {
      const links    = p.links || [];
      const images   = p.images || [];
      const acqLink  = links.find(l => l.rel?.includes('acquisition') || (l.type || '').includes('epub'));
      const coverImg = images[0];
      const authors  = (p.metadata?.author || []);
      const authorStr = Array.isArray(authors)
        ? authors.map(a => (typeof a === 'string' ? a : a.name || '')).join(', ')
        : String(authors);
      return {
        id:      p.metadata?.identifier || '',
        title:   p.metadata?.title || '',
        author:  authorStr,
        summary: p.metadata?.description || '',
        cover:   coverImg?.href || '',
        acqHref: acqLink?.href  || '',
        acqType: acqLink?.type  || '',
        navHref: '',
        isNav:   false,
      };
    }),
  ];

  const upLink   = (data.links || []).find(l => l.rel === 'up');
  const nextLink = (data.links || []).find(l => l.rel === 'next');
  return {
    version: 2,
    title:   data.metadata?.title || 'Katalog',
    self:    '',
    up:      upLink?.href || '',
    next:    decodeEntities(nextLink?.href || ''),
    entries,
  };
}

// ── Proxy fetch helper ────────────────────────────────────────────────────────
async function fetchOpds(url, server) {
  const headers = buildAuthHeaders(server.username, server.password);
  const res     = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct   = res.headers.get('content-type') || '';
  const buf  = await res.arrayBuffer();
  const body = Buffer.from(buf).toString('utf8');

  // OPDS 2.x returns JSON
  if (ct.includes('json')) {
    return normaliseOpds2Feed(JSON.parse(body));
  }
  // OPDS 1.x returns Atom XML
  const parsed = xmlParser.parse(body);
  return normaliseAtomFeed(parsed);
}

// Fetch all paginated OPDS pages and merge entries into the first feed object.
async function fetchAllOpdsPages(startUrl, server, maxPages = 20) {
  const first = await fetchOpds(startUrl, server);
  const visitedUrls = new Set([startUrl]);
  let nextHref = first.next ? resolveUrl(first.next, startUrl) : '';
  let page = 1;
  while (nextHref && page < maxPages) {
    if (visitedUrls.has(nextHref)) {
      break;
    }
    visitedUrls.add(nextHref);
    const more = await fetchOpds(nextHref, server);
    // Resolve acqHref/navHref relative to the page URL, then merge
    for (const e of more.entries) {
      first.entries.push({
        ...e,
        acqHref: resolveUrl(e.acqHref, nextHref),
        navHref: resolveUrl(e.navHref, nextHref),
      });
    }
    nextHref = more.next ? resolveUrl(more.next, nextHref) : '';
    page++;
  }
  return first;
}

// Resolve relative URLs against the server's base URL
function resolveUrl(href, base) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  try { return new URL(href, base).href; } catch { return href; }
}

// ── GET /api/opds/sync-count — pre-flight count for sync-to-shelf modal ────────
router.get('/sync-count', async (req, res) => {
  const { serverId, folderUrl } = req.query;
  if (serverId === undefined || serverId === null)
    return res.status(400).json({ error: 'error.server_id_required' });

  const servers = getServers(req.user.id);
  const server  = getServerById(servers, serverId);
  if (!server) return res.status(404).json({ error: 'error.server_not_found' });

  const targetUrl = folderUrl ? resolveUrl(String(folderUrl), server.url) : server.url;
  try {
    const feed = await fetchAllOpdsPages(targetUrl, server);
    feed.entries = feed.entries.map(e => ({
      ...e,
      acqHref: resolveUrl(e.acqHref, targetUrl),
    }));
    const bookEntries = feed.entries.filter(e => !e.isNav && e.acqHref);
    const total = bookEntries.length;

    // Count how many the user already has via tracked OPDS sources
    const db = getDb();
    let alreadyHave = 0;
    for (const e of bookEntries) {
      if (!e.acqHref) continue;
      const src = db.prepare('SELECT 1 FROM book_opds_sources WHERE user_id = ? AND acq_href = ?').get(req.user.id, e.acqHref);
      if (src) alreadyHave++;
    }
    res.json({ total, alreadyHave });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/opds/servers ─────────────────────────────────────────────────────
router.get('/servers', (req, res) => {
  const servers = getServers(req.user.id);
  // Never return passwords to the client
  res.json(servers.map((s, i) => ({
    id:   i,
    name: s.name,
    url:  s.url,
    username: s.username,
    has_password: !!s.password,
  })));
});

// ── GET /api/opds/health — reachability of every configured server ───────────
// A lightweight parallel check (not a full feed fetch/parse) so the server list can be
// color-coded immediately, not just for whichever server the user happens to click.
router.get('/health', async (req, res) => {
  const servers = getServers(req.user.id);
  const checkedAt = Date.now();
  const results = await Promise.all(servers.map(async (s, i) => {
    try {
      const r = await fetch(s.url, {
        headers: buildAuthHeaders(s.username, s.password),
        signal:  AbortSignal.timeout(5000),
      });
      return [i, { reachable: r.ok, checkedAt }];
    } catch {
      return [i, { reachable: false, checkedAt }];
    }
  }));
  res.json(Object.fromEntries(results));
});

// ── POST /api/opds/servers ────────────────────────────────────────────────────
router.post('/servers', (req, res) => {
  const { name, url, username, password } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'error.name_url_required' });
  if (!url.startsWith('http')) return res.status(400).json({ error: 'error.url_must_start_http' });

  const db      = getDb();
  const servers = getServers(req.user.id);
  servers.push({
    name:     String(name).slice(0, 80),
    url:      String(url).trim(),
    username: String(username || ''),
    password: String(password || ''),
  });
  db.prepare('UPDATE user_settings SET opds_servers = ? WHERE user_id = ?')
    .run(JSON.stringify(servers), req.user.id);
  res.status(201).json({ id: servers.length - 1, name, url, username, has_password: !!password });
});

// ── PUT /api/opds/servers/:id ─────────────────────────────────────────────────
router.put('/servers/:id', (req, res) => {
  const db      = getDb();
  const servers = getServers(req.user.id);
  const server  = getServerById(servers, req.params.id);
  if (!server) return res.status(404).json({ error: 'error.server_not_found' });

  const { name, url, username, password } = req.body || {};
  if (name)     server.name     = String(name).slice(0, 80);
  if (url)      server.url      = String(url).trim();
  if (username !== undefined) server.username = String(username);
  if (password)               server.password = String(password); // empty = keep existing

  db.prepare('UPDATE user_settings SET opds_servers = ? WHERE user_id = ?')
    .run(JSON.stringify(servers), req.user.id);
  res.json({ success: true });
});

// ── DELETE /api/opds/servers/:id ──────────────────────────────────────────────
router.delete('/servers/:id', (req, res) => {
  const db      = getDb();
  const servers = getServers(req.user.id);
  const idx     = parseInt(req.params.id, 10);
  if (isNaN(idx) || idx < 0 || idx >= servers.length) {
    return res.status(404).json({ error: 'error.server_not_found' });
  }
  servers.splice(idx, 1);
  db.prepare('UPDATE user_settings SET opds_servers = ? WHERE user_id = ?')
    .run(JSON.stringify(servers), req.user.id);
  res.json({ success: true });
});

// ── GET /api/opds/browse/:id — fetch & parse a catalog URL ───────────────────
// ?url=... overrides the server root URL (for sub-catalog navigation)
router.get('/browse/:id', async (req, res) => {
  const servers = getServers(req.user.id);
  const server  = getServerById(servers, req.params.id);
  if (!server) return res.status(404).json({ error: 'error.server_not_found' });

  const rawUrl    = req.query.url ? String(req.query.url) : server.url;
  const targetUrl = resolveUrl(rawUrl, server.url);

  try {
    const feed = await fetchOpds(targetUrl, server);
    // Resolve all relative hrefs against the fetched URL
    feed.entries = feed.entries.map(e => ({
      ...e,
      cover:   resolveUrl(e.cover,   targetUrl),
      acqHref: resolveUrl(e.acqHref, targetUrl),
      navHref: resolveUrl(e.navHref, targetUrl),
    }));
    feed.entries = annotateLocalOwnership(feed.entries, req.user.id);
    feed.up = resolveUrl(feed.up, targetUrl);
    res.json(feed);
  } catch (err) {
    console.warn('[opds] browse error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/opds/search/:id — search catalog ────────────────────────────────
// ?q=search+term
router.get('/search/:id', async (req, res) => {
  const servers = getServers(req.user.id);
  const server  = getServerById(servers, req.params.id);
  if (!server) return res.status(404).json({ error: 'error.server_not_found' });

  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'error.search_query_required' });

  const headers = buildAuthHeaders(server.username, server.password);

  try {
    // Step 1: fetch root feed to find the search link
    const rootRes    = await fetch(server.url, { headers, signal: AbortSignal.timeout(8000) });
    const rootText   = await rootRes.text();
    const rootParsed = xmlParser.parse(rootText);
    const rootLinks  = rootParsed?.feed?.link || [];
    const searchLink = rootLinks.find(l =>
      (l['@_rel'] || '').includes('search')
    );

    let searchUrl;
    if (searchLink?.['@_href']) {
      const searchHref = decodeEntities(resolveUrl(searchLink['@_href'], server.url));
      const searchType = searchLink['@_type'] || '';

      if (searchType.includes('opensearchdescription') || searchHref.endsWith('.opds') || searchHref.endsWith('.xml')) {
        // It's an OpenSearch description document — fetch it to get the actual template
        try {
          const osRes    = await fetch(searchHref, { headers, signal: AbortSignal.timeout(8000) });
          const osText   = await osRes.text();
          const osParsed = xmlParser.parse(osText);
          // <Url type="application/atom+xml" template="..."/>
          const urls = osParsed?.OpenSearchDescription?.Url || [];
          const urlEl = (Array.isArray(urls) ? urls : [urls]).find(u =>
            (u['@_type'] || '').includes('atom') ||
            (u['@_type'] || '').includes('opds') ||
            u['@_template']
          );
          const tmpl = urlEl?.['@_template'] || '';
          if (tmpl.includes('{searchTerms}')) {
            searchUrl = resolveUrl(tmpl.replace('{searchTerms}', encodeURIComponent(q)), searchHref);
          }
        } catch (e) {
          console.warn('[opds] OpenSearch doc fetch failed:', e.message);
        }
      } else if (searchHref.includes('{searchTerms}')) {
        searchUrl = searchHref.replace('{searchTerms}', encodeURIComponent(q));
      } else {
        searchUrl = `${searchHref}${searchHref.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`;
      }
    }

    // Fallback if no search link or failed to resolve
    if (!searchUrl) {
      const base = server.url.replace(/\/$/, '');
      searchUrl  = `${base}/search?q=${encodeURIComponent(q)}`;
    }

    const feed = await fetchOpds(searchUrl, server);
    feed.entries = feed.entries.map(e => ({
      ...e,
      cover:   resolveUrl(e.cover,   searchUrl),
      acqHref: resolveUrl(e.acqHref, searchUrl),
      navHref: resolveUrl(e.navHref, searchUrl),
    }));
    feed.entries = annotateLocalOwnership(feed.entries, req.user.id);
    res.json(feed);
  } catch (err) {
    console.warn('[opds] search error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/opds/cover — see top of file (registered before JWT middleware) ─

// ── POST /api/opds/sync — browse a folder URL, download all books to a shelf ──
// body: { serverId, folderUrl, shelfName }
router.post('/sync', async (req, res) => {
  const { serverId, folderUrl, shelfName } = req.body || {};
  if (serverId === undefined || serverId === null) {
    return res.status(400).json({ error: 'error.server_id_required' });
  }
  if (!shelfName || !String(shelfName).trim()) {
    return res.status(400).json({ error: 'error.shelf_name_required' });
  }

  const servers = getServers(req.user.id);
  const server  = getServerById(servers, serverId);
  if (!server) return res.status(404).json({ error: 'error.server_not_found' });

  const targetUrl = folderUrl ? resolveUrl(String(folderUrl), server.url) : server.url;

  try {
    const feed = await fetchOpds(targetUrl, server);
    feed.entries = feed.entries.map(e => ({
      ...e,
      acqHref: resolveUrl(e.acqHref, targetUrl),
      navHref: resolveUrl(e.navHref, targetUrl),
    }));

    const bookEntries = feed.entries.filter(e => !e.isNav && e.acqHref);
    if (!bookEntries.length) {
      return res.json({ added: 0, skipped: 0, errors: 0, shelfId: null });
    }

    const fs   = require('fs');
    const path = require('path');
    const { DATA_DIR }                                                           = require('../db');
    const { computeFileHash, computeFileMd5, extractEpubMetadata, extractCbzMetadata } = require('../utils/epub');
    const { isCbrBuffer, convertCbrToCbz }                                      = require('../utils/cbr');
    const { isPdfBuffer, extractPdfMetadata }                                   = require('../utils/pdf');
    const db        = getDb();
    const TMP_DIR   = path.join(DATA_DIR, 'tmp');
    const BOOKS_DIR = path.join(DATA_DIR, 'books');
    const COVERS_DIR = path.join(DATA_DIR, 'covers');
    const userDir   = path.join(BOOKS_DIR, String(req.user.id));
    fs.mkdirSync(userDir, { recursive: true });

    // Create or find shelf by name
    const cleanName = String(shelfName).trim().slice(0, 100);
    let shelf = db.prepare(
      'SELECT id FROM shelves WHERE user_id = ? AND name = ?'
    ).get(req.user.id, cleanName);
    if (!shelf) {
      const r = db.prepare(
        'INSERT INTO shelves (user_id, name) VALUES (?, ?)'
      ).run(req.user.id, cleanName);
      shelf = { id: r.lastInsertRowid };
    }

    const headers = buildAuthHeaders(server.username, server.password);
    let added = 0, skipped = 0, errors = 0;

    for (const entry of bookEntries) {
      try {
        // Fast path: skip download if we already processed this acqHref
        if (entry.acqHref) {
          const src = db.prepare('SELECT book_id FROM book_opds_sources WHERE user_id = ? AND acq_href = ?').get(req.user.id, entry.acqHref);
          if (src) {
            db.prepare('INSERT OR IGNORE INTO book_shelves (shelf_id, book_id) VALUES (?, ?)').run(shelf.id, src.book_id);
            skipped++;
            continue;
          }
        }

        const r = await fetch(entry.acqHref, { headers, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        let buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 100) throw new Error('error.file_empty');

        let format = 'epub';
        if (isPdfBuffer(buf)) {
          format = 'pdf';
        } else if (isCbrBuffer(buf)) {
          console.log('[opds/sync] converting CBR → CBZ:', entry.title);
          buf = await convertCbrToCbz(buf);
          format = 'cbz';
        }

        const tmpPath = path.join(TMP_DIR, `sync_${Date.now()}_${req.user.id}.tmp`);
        fs.writeFileSync(tmpPath, buf);

        try {
          const fileHash    = computeFileHash(tmpPath);
          const fileHashMd5 = computeFileMd5(tmpPath);

          let book = db.prepare(
            'SELECT id FROM books WHERE user_id = ? AND file_hash = ?'
          ).get(req.user.id, fileHash);

          if (!book) {
            const ext      = format === 'pdf' ? '.pdf' : format === 'cbz' ? '.cbz' : '.epub';
            const filename = `${fileHash}${ext}`;
            const destPath = path.join(userDir, filename);
            try { fs.renameSync(tmpPath, destPath); }
            catch { fs.copyFileSync(tmpPath, destPath); fs.unlinkSync(tmpPath); }

            const meta = format === 'pdf' ? await extractPdfMetadata(destPath, COVERS_DIR, fileHash)
              : format === 'cbz'
              ? extractCbzMetadata(destPath, COVERS_DIR, fileHash)
              : extractEpubMetadata(destPath, COVERS_DIR, fileHash);
            if (!meta.cover_path && entry.cover) {
              meta.cover_path = await fetchCoverToFile(resolveUrl(entry.cover, targetUrl), headers, COVERS_DIR, fileHash);
            }
            const bookTitle  = meta.title  || entry.title  || 'Unknown';
            const bookAuthor = meta.author || entry.author || '';
            const fileSize   = fs.statSync(destPath).size;

            const ins = db.prepare(`
              INSERT INTO books (user_id, title, author, series_name, series_number, description, file_hash, file_hash_md5, filename, cover_path, file_size,
                                 publisher, language, isbn, genres, pages, format)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(req.user.id, bookTitle, bookAuthor,
                   meta.series_name || '', meta.series_number || '', meta.description || entry.summary || '',
                   fileHash, fileHashMd5, filename, meta.cover_path, fileSize,
                   meta.publisher || '', meta.language || '', meta.isbn || '', meta.genres || '', meta.pages || null, format);
            book = { id: ins.lastInsertRowid };
            added++;
          } else {
            try { fs.unlinkSync(tmpPath); } catch { /* already saved */ }
            skipped++;
          }

          if (entry.acqHref) {
            db.prepare('INSERT OR IGNORE INTO book_opds_sources (user_id, book_id, acq_href) VALUES (?, ?, ?)').run(req.user.id, book.id, entry.acqHref);
          }
          db.prepare(
            'INSERT OR IGNORE INTO book_shelves (shelf_id, book_id) VALUES (?, ?)'
          ).run(shelf.id, book.id);
        } catch (innerErr) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw innerErr;
        }
      } catch (err) {
        console.error('[opds/sync] error for entry:', entry.title, err.message);
        errors++;
      }
    }

    res.json({ added, skipped, errors, shelfId: shelf.id });
  } catch (err) {
    console.error('[opds] sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/opds/download/:id — download epub to user library ───────────────
// body: { href, title, author, cover }
router.post('/download/:id', async (req, res) => {
  const servers = getServers(req.user.id);
  const server  = getServerById(servers, req.params.id);
  if (!server) return res.status(404).json({ error: 'error.server_not_found' });

  const { href, title, author, cover } = req.body || {};
  if (!href) return res.status(400).json({ error: 'error.href_required' });

  const resolvedHref = resolveUrl(href, server.url);

  try {
    const headers = buildAuthHeaders(server.username, server.password);
    const r       = await fetch(resolvedHref, { headers, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const ct    = r.headers.get('content-type') || '';
    const ctLow = ct.toLowerCase();
    if (!ctLow.includes('epub') && !ctLow.includes('octet') &&
        !ctLow.includes('zip')  && !ctLow.includes('rar')   &&
        !ctLow.includes('cbr')  && !ctLow.includes('cbz')   &&
        !ctLow.includes('pdf')) {
      console.warn('[opds] unexpected content-type:', ct);
      throw new Error('error.unexpected_content_type');
    }

    const fs   = require('fs');
    const path = require('path');
    const { DATA_DIR }                                                      = require('../db');
    const { computeFileHash, computeFileMd5, extractEpubMetadata, extractCbzMetadata } = require('../utils/epub');
    const { isCbrBuffer, convertCbrToCbz }                                 = require('../utils/cbr');
    const { isPdfBuffer, extractPdfMetadata }                              = require('../utils/pdf');
    const db       = getDb();
    const TMP_DIR  = path.join(DATA_DIR, 'tmp');
    const BOOKS_DIR = path.join(DATA_DIR, 'books');
    const COVERS_DIR = path.join(DATA_DIR, 'covers');
    const userDir  = path.join(BOOKS_DIR, String(req.user.id));
    fs.mkdirSync(userDir, { recursive: true });

    let buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) throw new Error('error.file_empty');

    let format = 'epub';
    if (isPdfBuffer(buf)) {
      format = 'pdf';
    } else if (isCbrBuffer(buf)) {
      console.log('[opds] converting CBR → CBZ...');
      buf = await convertCbrToCbz(buf);
      format = 'cbz';
    } else if (ctLow.includes('cbz') || ctLow.includes('comicbook+zip')) {
      format = 'cbz';
    }

    const tmpPath = path.join(TMP_DIR, `opds_${Date.now()}_${req.user.id}.tmp`);
    fs.writeFileSync(tmpPath, buf);

    try {
      const fileHash    = computeFileHash(tmpPath);
      const fileHashMd5 = computeFileMd5(tmpPath);

      const existing = db.prepare('SELECT id FROM books WHERE user_id = ? AND file_hash = ?').get(req.user.id, fileHash);
      if (existing) {
        fs.unlinkSync(tmpPath);
        // Backfill the source link even here — the book may have reached the library through a
        // route that never recorded one (manual upload, BookOrbit import, a different OPDS
        // server mirroring the same file, ...). Without this, the *next* browse/search of this
        // same acqHref would still show "Add" and hit this same 409 fallback again.
        db.prepare('INSERT OR IGNORE INTO book_opds_sources (user_id, book_id, acq_href) VALUES (?, ?, ?)')
          .run(req.user.id, existing.id, resolvedHref);
        return res.status(409).json({ error: 'error.book_already_in_library', id: existing.id });
      }

      const ext      = format === 'pdf' ? '.pdf' : format === 'cbz' ? '.cbz' : '.epub';
      const filename = `${fileHash}${ext}`;
      const destPath = path.join(userDir, filename);
      try { fs.renameSync(tmpPath, destPath); }
      catch { fs.copyFileSync(tmpPath, destPath); fs.unlinkSync(tmpPath); }

      const meta = format === 'pdf' ? await extractPdfMetadata(destPath, COVERS_DIR, fileHash)
        : format === 'cbz'
        ? extractCbzMetadata(destPath, COVERS_DIR, fileHash)
        : extractEpubMetadata(destPath, COVERS_DIR, fileHash);
      if (!meta.cover_path && cover) {
        meta.cover_path = await fetchCoverToFile(resolveUrl(cover, server.url), headers, COVERS_DIR, fileHash);
      }
      const bookTitle  = meta.title  || title  || 'Unknown';
      const bookAuthor = meta.author || author || '';
      const fileSize   = fs.statSync(destPath).size;

      const result = db.prepare(`
        INSERT INTO books (user_id, title, author, series_name, series_number, description, file_hash, file_hash_md5, filename, cover_path, file_size,
                           publisher, language, isbn, genres, pages, format)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, bookTitle, bookAuthor, meta.series_name || '', meta.series_number || '', meta.description || '',
             fileHash, fileHashMd5, filename, meta.cover_path, fileSize,
             meta.publisher || '', meta.language || '', meta.isbn || '', meta.genres || '', meta.pages || null, format);

      // Without this, a book added via this single-book "Add"/Download button (as opposed to
      // the bulk "Sync to shelf" flow, which already does this) never gets a book_opds_sources
      // row — so annotateLocalOwnership() can never proactively detect it on a later browse/
      // search, and the card would show "Add" again until the file_hash duplicate check below
      // catches it reactively (409) on a second click.
      db.prepare('INSERT OR IGNORE INTO book_opds_sources (user_id, book_id, acq_href) VALUES (?, ?, ?)')
        .run(req.user.id, result.lastInsertRowid, resolvedHref);

      res.status(201).json({ id: result.lastInsertRowid, title: bookTitle, author: bookAuthor, file_hash: fileHash });
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  } catch (err) {
    console.error('[opds] download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/opds/peek/:id — fetch a book for a read-only "peek" without downloading it ─────
// Mirrors server/routes/bookorbit.js's createBookOrbitPeek: a normal `books` row flagged
// ephemeral via `peek_expires_at` (see server/utils/peekCleanup.js — already generic, not
// BookOrbit-specific), so the reader's existing GET /:id / :id/file routes and isPeekMode gating
// work completely unchanged. Deliberately duplicates the download route's fetch/content-type/
// CBR-conversion prologue rather than sharing it, to keep that well-tested real-download path
// untouched. Unlike a real download, this never runs metadata extraction/cover generation — the
// client already has title/author from the browse/search entry it rendered.
async function createOpdsPeek(userId, server, { href, title, author }) {
  const resolvedHref = resolveUrl(href, server.url);
  const headers = buildAuthHeaders(server.username, server.password);
  const r = await fetch(resolvedHref, { headers, signal: AbortSignal.timeout(60000) });
  if (!r.ok) return { ok: false, status: 502, error: `HTTP ${r.status}` };

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('epub') && !ct.includes('octet') &&
      !ct.includes('zip')  && !ct.includes('rar')   &&
      !ct.includes('cbr')  && !ct.includes('cbz')   &&
      !ct.includes('pdf')) {
    return { ok: false, status: 502, error: 'error.unexpected_content_type' };
  }

  const fs   = require('fs');
  const path = require('path');
  const { DATA_DIR }                      = require('../db');
  const { computeFileHash }               = require('../utils/epub');
  const { isCbrBuffer, convertCbrToCbz }  = require('../utils/cbr');
  const { isPdfBuffer }                   = require('../utils/pdf');
  const { peekFilePath, PEEK_TTL_SECONDS } = require('../utils/peekCleanup');
  const db      = getDb();
  const TMP_DIR = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) return { ok: false, status: 502, error: 'error.file_empty' };

  let format = 'epub';
  if (isPdfBuffer(buf)) {
    format = 'pdf';
  } else if (isCbrBuffer(buf)) {
    buf = await convertCbrToCbz(buf);
    format = 'cbz';
  } else if (ct.includes('cbz') || ct.includes('comicbook+zip')) {
    format = 'cbz';
  }

  const stagingPath = path.join(TMP_DIR, `opds_peek_${Date.now()}_${userId}_${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(stagingPath, buf);

  try {
    const fileHash = computeFileHash(stagingPath);

    // Already really downloaded — return the real book instead of creating anything ephemeral,
    // backfilling the source link if this acqHref specifically was never recorded (same fix as
    // POST /download/:id above).
    const existing = db.prepare('SELECT id FROM books WHERE user_id = ? AND file_hash = ? AND peek_expires_at IS NULL').get(userId, fileHash);
    if (existing) {
      fs.unlinkSync(stagingPath);
      db.prepare('INSERT OR IGNORE INTO book_opds_sources (user_id, book_id, acq_href) VALUES (?, ?, ?)')
        .run(userId, existing.id, resolvedHref);
      return { ok: true, id: existing.id, ephemeral: false };
    }

    // Synthetic, structurally distinct from any real SHA-256 hex hash — can never collide with
    // UNIQUE(user_id, file_hash) against a real book, even from a concurrent second peek of the
    // same book (each gets its own timestamp+random suffix). Mirrors createBookOrbitPeek exactly.
    const peekHash = `peek_opds_${Date.now()}_${userId}_${Math.random().toString(36).slice(2)}`;
    const ext      = format === 'pdf' ? '.pdf' : format === 'cbz' ? '.cbz' : '.epub';
    const filename = `${peekHash}${ext}`;
    const destPath = peekFilePath(userId, filename);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try { fs.renameSync(stagingPath, destPath); }
    catch { fs.copyFileSync(stagingPath, destPath); fs.unlinkSync(stagingPath); }

    const fileSize = fs.statSync(destPath).size;
    const result = db.prepare(`
      INSERT INTO books (user_id, title, author, file_hash, filename, cover_path, file_size, format, peek_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, title || 'Unknown', author || '', peekHash, filename, '', fileSize, format,
           Math.floor(Date.now() / 1000) + PEEK_TTL_SECONDS);

    return { ok: true, id: result.lastInsertRowid, ephemeral: true };
  } catch (err) {
    try { fs.unlinkSync(stagingPath); } catch { /* ignore */ }
    return { ok: false, status: 500, error: err.message };
  }
}

router.post('/peek/:id', async (req, res) => {
  const servers = getServers(req.user.id);
  const server  = getServerById(servers, req.params.id);
  if (!server) return res.status(404).json({ error: 'error.server_not_found' });

  const { href, title, author } = req.body || {};
  if (!href) return res.status(400).json({ error: 'error.href_required' });

  try {
    const result = await createOpdsPeek(req.user.id, server, { href, title, author });
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
    res.status(201).json({ id: result.id, ephemeral: result.ephemeral });
  } catch (err) {
    console.error('[opds] peek error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
