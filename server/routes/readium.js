/**
 * Readium RWPM streamer — serves EPUB books as Readium Web Publication Manifests.
 *
 * Auth model:
 *  - GET /api/readium/:bookId/manifest.json  — JWT-protected (same middleware as all other routes)
 *  - GET /api/readium/:token/:bookId/res/*   — HMAC token embedded in path so relative
 *    sub-resources (CSS, images) referenced from within XHTML chapters inherit auth
 *    naturally via the browser's URL resolution, without needing any JS or headers.
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const AdmZip   = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const { getDb, DATA_DIR }       = require('../db');
const { authenticateToken }     = require('../middleware/auth');

const router    = express.Router();
const BOOKS_DIR = path.join(DATA_DIR, 'books');

// ── MIME map for EPUB resources ───────────────────────────────────────────────
const MIME = {
  '.xhtml': 'application/xhtml+xml',
  '.html':  'text/html',
  '.htm':   'text/html',
  '.css':   'text/css',
  '.js':    'application/javascript',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.png':   'image/png',
  '.gif':   'image/gif',
  '.svg':   'image/svg+xml',
  '.webp':  'image/webp',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ncx':   'application/x-dtbncx+xml',
  '.opf':   'application/oebps-package+xml',
  '.mp3':   'audio/mpeg',
  '.mp4':   'audio/mp4',
  '.xml':   'application/xml',
  '.json':  'application/json',
};
function getMime(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// ── Per-book HMAC access token (stateless, embedded in resource URL path) ─────
// Using the path means relative sub-resources naturally inherit the token.
function bookAccessToken(userId, bookId) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`readium:${userId}:${bookId}`)
    .digest('hex')
    .slice(0, 32);
}

// ── XML parser ────────────────────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes:       false,
  attributeNamePrefix:    '@_',
  textNodeName:           '#text',
  allowBooleanAttributes: true,
  parseAttributeValue:    false,
  processEntities:        false,
  isArray: (name) => ['item', 'itemref', 'navPoint', 'meta'].includes(name),
});

// Separate parser for EPUB3 nav XHTML (nav + li must always be arrays).
const navXmlParser = new XMLParser({
  ignoreAttributes:       false,
  attributeNamePrefix:    '@_',
  textNodeName:           '#text',
  allowBooleanAttributes: true,
  parseAttributeValue:    false,
  processEntities:        false,
  isArray: (name) => ['nav', 'li'].includes(name),
});

// ── Base URL (prefer PUBLIC_URL env var; fall back to request headers) ────────
// PUBLIC_URL must be set when the server is behind a reverse proxy, otherwise
// the manifest will contain LAN addresses that the browser's CSP will reject.
function getBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}`;
}

// ── Simple in-memory caches ───────────────────────────────────────────────────
const manifestCache = new Map();  // `${userId}:${bookId}` → { mtime, manifest }
const zipCache      = new Map();  // bookId → { mtime, zip }

function getCachedZip(bookId, filePath) {
  const mtime = fs.statSync(filePath).mtimeMs;
  const hit   = zipCache.get(bookId);
  if (hit && hit.mtime === mtime) return hit.zip;
  const zip = new AdmZip(filePath);
  zipCache.set(bookId, { zip, mtime });
  return zip;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v))     return getText(v[0]);
  return String(v['#text'] || '').trim();
}

function encodePath(absHref) {
  return absHref.split('/').map(encodeURIComponent).join('/');
}

function resUrl(RES, absHref) {
  return `${RES}/${encodePath(absHref)}`;
}

// ── EPUB → RWPM conversion ────────────────────────────────────────────────────
function buildManifest(book, userId, filePath, baseUrl) {
  const zip = getCachedZip(book.id, filePath);

  // 1. container.xml → OPF path
  const contEntry = zip.getEntry('META-INF/container.xml');
  if (!contEntry) throw new Error('Invalid EPUB: missing META-INF/container.xml');
  const cont      = xmlParser.parse(contEntry.getData().toString('utf8'));
  const rootfiles = cont?.container?.rootfiles?.rootfile;
  const rootfile  = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
  const opfPath   = rootfile?.['@_full-path'];
  if (!opfPath) throw new Error('EPUB container.xml has no full-path');

  // 2. OPF
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`EPUB OPF not found at ${opfPath}`);
  const opf    = xmlParser.parse(opfEntry.getData().toString('utf8'));
  const pkg    = opf?.package;
  const meta   = pkg?.metadata || {};
  const opfDir = path.posix.dirname(opfPath); // 'OEBPS', '.', etc.

  // 3. Manifest items
  const rawItems = pkg?.manifest?.item;
  const itemList = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
  const items = {};
  for (const it of itemList) {
    if (!it['@_id'] || !it['@_href']) continue;
    const absHref = (opfDir === '.') ? it['@_href'] : `${opfDir}/${it['@_href']}`;
    items[it['@_id']] = {
      href:       it['@_href'],
      absHref,
      mediaType:  it['@_media-type'] || '',
      properties: it['@_properties'] || '',
    };
  }

  // 4. Reading order (spine)
  const token = bookAccessToken(userId, book.id);
  const RES   = `${baseUrl}/api/readium/${token}/${book.id}/res`;

  const rawRefs = pkg?.spine?.itemref;
  const refList = Array.isArray(rawRefs) ? rawRefs : (rawRefs ? [rawRefs] : []);
  const roHrefs = new Set();
  const readingOrder = refList
    .map(ref => {
      const item = items[ref['@_idref']];
      if (!item) return null;
      const href = resUrl(RES, item.absHref);
      roHrefs.add(href);
      return {
        href,
        type: item.mediaType || 'application/xhtml+xml',
        ...(item.properties ? { properties: item.properties } : {}),
      };
    })
    .filter(Boolean);

  // 5. Resources (non-spine items)
  const resources = Object.values(items)
    .filter(it => !roHrefs.has(resUrl(RES, it.absHref)))
    .map(it => ({
      href: resUrl(RES, it.absHref),
      type: it.mediaType || getMime(it.href),
    }));

  // 6. TOC — prefer EPUB3 nav document; fall back to NCX for EPUB2
  const toc = buildNavToc(zip, opfDir, items, RES) || buildNcxToc(zip, opfDir, items, RES);

  // 7. Positions link (HMAC-token path so the navigator can fetch without JWT)
  const posHref = `${baseUrl}/api/readium/${token}/${book.id}/positions.json`;

  return {
    '@context': ['https://readium.org/webpub-manifest/context.jsonld'],
    metadata: {
      '@type':              'http://schema.org/Book',
      title:                getText(meta['dc:title'])    || book.title,
      author:               getText(meta['dc:creator'])  ? [{ name: getText(meta['dc:creator']) }] : undefined,
      language:             getText(meta['dc:language']) || 'en',
      identifier:           getText(meta['dc:identifier']) || String(book.id),
      readingProgression:   'ltr',
    },
    links: [
      { rel: 'self',      href: `${baseUrl}/api/readium/${token}/${book.id}/manifest.json`, type: 'application/webpub+json' },
      { rel: 'alternate', href: posHref, type: 'application/vnd.readium.position-list+json' },
    ],
    readingOrder,
    resources,
    toc,
  };
}

// ── Positions list generation ─────────────────────────────────────────────────
// Approximates positions by assuming a fixed number of pages per spine item.
// Good enough for progress tracking; accurate page counts require content analysis.
const PAGES_PER_ITEM = 5;

function buildPositions(readingOrder) {
  const total = readingOrder.length * PAGES_PER_ITEM;
  let globalPos = 1;
  const positions = [];
  for (const item of readingOrder) {
    for (let p = 0; p < PAGES_PER_ITEM; p++) {
      positions.push({
        href:  item.href,
        type:  item.type,
        locations: {
          position:         globalPos,
          progression:      p / PAGES_PER_ITEM,
          totalProgression: (globalPos - 1) / total,
        },
      });
      globalPos++;
    }
  }
  return { total, positions };
}

// ── EPUB3 navigation document (nav.xhtml) ─────────────────────────────────────
// Recursively searches the parsed XML object for a <nav epub:type="…"> element.
function findNavElement(obj, epubType) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findNavElement(item, epubType);
      if (found) return found;
    }
    return null;
  }
  const type = obj['@_epub:type'] || '';
  if (type.split(/\s+/).includes(epubType)) return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('@_') || key === '#text') continue;
    const found = findNavElement(obj[key], epubType);
    if (found) return found;
  }
  return null;
}

function parseNavList(ol, resolveHref) {
  if (!ol) return [];
  const root = Array.isArray(ol) ? ol[0] : ol;
  if (!root) return [];
  const lis = Array.isArray(root.li) ? root.li : (root.li ? [root.li] : []);
  return lis
    .map(li => {
      const a = li.a;
      if (!a) return null;
      const href     = (typeof a === 'object' ? a['@_href'] : '') || '';
      const rawTitle = typeof a === 'string' ? a : (a['#text'] || '');
      const title    = String(rawTitle).trim();
      const resolvedHref = resolveHref(href);
      const item = { title: title || href, href: resolvedHref };
      if (li.ol) {
        const children = parseNavList(li.ol, resolveHref);
        if (children.length) item.children = children;
      }
      return item;
    })
    .filter(Boolean);
}

function buildNavToc(zip, opfDir, items, RES) {
  const navItem = Object.values(items).find(
    i => i.properties && i.properties.split(/\s+/).includes('nav')
  );
  if (!navItem) return null;
  const entry = zip.getEntry(navItem.absHref)
             || zip.getEntry(navItem.absHref.replace(/\//g, '\\'));
  if (!entry) return null;
  try {
    const navDoc = navXmlParser.parse(entry.getData().toString('utf8'));
    const navDir = path.posix.dirname(navItem.absHref);
    const tocNav = findNavElement(navDoc, 'toc');
    if (!tocNav) return null;
    const resolveHref = (href) => {
      if (!href) return '';
      const src = href.split('#')[0]; // strip anchor — reading order hrefs have none
      if (!src) return '';
      // Normalize to remove any ../ so paths match the reading order hrefs exactly
      const abs = path.posix.normalize((navDir === '.') ? src : `${navDir}/${src}`);
      return resUrl(RES, abs);
    };
    const result = parseNavList(tocNav.ol, resolveHref);
    return result.length ? result : null;
  } catch {
    return null;
  }
}

function buildNcxToc(zip, opfDir, items, RES) {
  const ncxItem = Object.values(items).find(
    i => i.mediaType === 'application/x-dtbncx+xml' || i.href.endsWith('.ncx')
  );
  if (!ncxItem) return [];
  const entry = zip.getEntry(ncxItem.absHref)
             || zip.getEntry(ncxItem.absHref.replace(/\//g, '\\'));
  if (!entry) return [];
  try {
    const ncx = xmlParser.parse(entry.getData().toString('utf8'));
    return parseNavPoints(ncx?.ncx?.navMap?.navPoint, opfDir, RES);
  } catch {
    return [];
  }
}

function parseNavPoints(points, opfDir, RES) {
  if (!points) return [];
  if (!Array.isArray(points)) points = [points];
  return points
    .map(pt => {
      const rawLabel = pt?.navLabel?.text;
      const label = typeof rawLabel === 'string'
        ? rawLabel.trim()
        : String(rawLabel?.['#text'] || '').trim();
      if (!label) return null;

      const rawSrc = (typeof pt?.content === 'object' ? pt.content?.['@_src'] : pt?.content) || '';
      const src    = rawSrc.split('#')[0];
      const abs    = (opfDir === '.') ? src : `${opfDir}/${src}`;

      const result = { title: label, href: resUrl(RES, abs) };
      if (pt?.navPoint) {
        const children = parseNavPoints(pt.navPoint, opfDir, RES);
        if (children.length) result.children = children;
      }
      return result;
    })
    .filter(Boolean);
}

// ── Route: exchange JWT for a stateless HMAC access token ────────────────────
// The client calls this once (with Authorization header) to get a token that
// can be embedded in the manifest URL path — so NO JWT ever appears in URLs,
// avoiding the CSP query-string bug in Readium's iframe sandbox.
router.get('/:bookId/access-token', authenticateToken, (req, res) => {
  const db   = getDb();
  const book = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?')
    .get(req.params.bookId, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json({ token: bookAccessToken(req.user.id, book.id) });
});

// ── Route: manifest (HMAC token in path, no JWT in URL) ───────────────────────
router.get('/:accessToken/:bookId/manifest.json', (req, res) => {
  const { accessToken, bookId } = req.params;

  if (!/^[0-9a-f]{32}$/.test(accessToken)) return res.status(403).end();

  const db   = getDb();
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) return res.status(404).end();

  const expected = bookAccessToken(book.user_id, book.id);
  if (!crypto.timingSafeEqual(
    Buffer.from(accessToken, 'hex'),
    Buffer.from(expected,     'hex')
  )) return res.status(403).end();

  const filePath = path.join(BOOKS_DIR, String(book.user_id), book.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const mtime    = fs.statSync(filePath).mtimeMs;
  const cacheKey = `${book.user_id}:${book.id}`;
  const hit      = manifestCache.get(cacheKey);

  let manifest;
  if (hit && hit.mtime === mtime) {
    manifest = hit.manifest;
  } else {
    try {
      manifest = buildManifest(book, book.user_id, filePath, getBaseUrl(req));
      manifestCache.set(cacheKey, { manifest, mtime });
    } catch (err) {
      console.error('[readium] manifest error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Content-Type', 'application/webpub+json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.json(manifest);
});

// ── Route: positions list ─────────────────────────────────────────────────────
router.get('/:accessToken/:bookId/positions.json', (req, res) => {
  const { accessToken, bookId } = req.params;

  if (!/^[0-9a-f]{32}$/.test(accessToken)) return res.status(403).end();

  const db   = getDb();
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) return res.status(404).end();

  const expected = bookAccessToken(book.user_id, book.id);
  if (!crypto.timingSafeEqual(
    Buffer.from(accessToken, 'hex'),
    Buffer.from(expected,     'hex')
  )) return res.status(403).end();

  // Reuse cached manifest if available; otherwise build it now so positions
  // work even when the client requests positions before the manifest is cached.
  const cacheKey = `${book.user_id}:${book.id}`;
  let hit = manifestCache.get(cacheKey);
  if (!hit) {
    const filePath = path.join(BOOKS_DIR, String(book.user_id), book.filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    try {
      const mtime    = fs.statSync(filePath).mtimeMs;
      const manifest = buildManifest(book, book.user_id, filePath, getBaseUrl(req));
      manifestCache.set(cacheKey, { manifest, mtime });
      hit = manifestCache.get(cacheKey);
    } catch (err) {
      console.error('[readium] positions manifest error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  const result = buildPositions(hit.manifest.readingOrder);
  res.setHeader('Content-Type', 'application/vnd.readium.position-list+json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(result);
});

// ── Route: resource streaming ─────────────────────────────────────────────────
router.get('/:accessToken/:bookId/res/*', (req, res) => {
  const { accessToken, bookId } = req.params;
  const resourcePath = req.params[0];

  // Fast-reject invalid tokens before hitting the database
  if (!/^[0-9a-f]{32}$/.test(accessToken)) return res.status(403).end();

  const db   = getDb();
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) return res.status(404).end();

  const expected = bookAccessToken(book.user_id, book.id);
  if (!crypto.timingSafeEqual(
    Buffer.from(accessToken, 'hex'),
    Buffer.from(expected,     'hex')
  )) return res.status(403).end();

  const filePath = path.join(BOOKS_DIR, String(book.user_id), book.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const zip = getCachedZip(book.id, filePath);

  // Decode each path segment individually
  const decoded = resourcePath.split('/').map(s => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).join('/');

  const entry = zip.getEntry(resourcePath)
             || zip.getEntry(decoded)
             || zip.getEntry(decoded.replace(/\//g, '\\'));
  if (!entry) {
    console.warn('[readium] not in ZIP:', resourcePath);
    return res.status(404).end();
  }

  const data     = entry.getData();
  const mimeType = getMime(decoded);

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  // For HTML/XHTML: inject a <base> tag so that relative sub-resource URLs
  // (../Images/cover.jpg etc.) resolve through our authenticated resource route
  // when Thorium fetches and renders the chapter in a srcdoc iframe.
  if (mimeType.includes('html')) {
    let html = data.toString('utf-8');
    if (!/<base\s/i.test(html)) {
      const dir        = path.posix.dirname(decoded);
      const encodedDir = dir.split('/').map(encodeURIComponent).join('/');
      const baseHref   = `${getBaseUrl(req)}/api/readium/${accessToken}/${bookId}/res/${encodedDir}/`;
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${baseHref}"/>`);
    }
    return res.send(Buffer.from(html));
  }

  res.send(data);
});

module.exports = router;
