/**
 * epub.js — server-side EPUB metadata + cover extraction
 * Treats EPUB files as ZIP archives and parses the OPF XML directly.
 */

const AdmZip      = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');

const xmlParser = new XMLParser({
  ignoreAttributes:     false,
  attributeNamePrefix:  '@_',
  textNodeName:         '#text',
  allowBooleanAttributes: true,
  parseAttributeValue:  false,
  processEntities:      false,   // decode manually so entity-encoded HTML doesn't confuse the parser
  isArray: (name) => ['item', 'meta', 'opf:meta', 'dc:creator', 'dc:title'].includes(name),
});

// Decode standard XML/HTML entities (manual, since processEntities is off)
function decodeEntities(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g,            (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// ── File hash ─────────────────────────────────────────────────────────────────
function computeFileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 40);
}

// KOReader partial MD5 — exact port of util.partialMD5 from KOReader Lua source.
// Reads up to 12 sparse 1 KB chunks at offsets: lshift(1024, 2*i) for i = -1..10
// i = -1 → 256, i = 0 → 1024, i = 1 → 4096, … i = 10 → 1073741824
// JS << with negative count is wrong (treats as unsigned mod 32), so we use >> for i < 0.
function computeFileMd5(filePath) {
  console.log('[md5] computing partial MD5 for:', filePath);
  const fd   = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('md5');
  const buf  = Buffer.alloc(1024);
  try {
    for (let i = -1; i <= 10; i++) {
      const offset    = i < 0 ? 0 : (1024 << (2 * i));
      const bytesRead = fs.readSync(fd, buf, 0, 1024, offset);
      console.log(`[md5]   i=${i} offset=${offset} bytesRead=${bytesRead}`);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  const result = hash.digest('hex');
  console.log('[md5] result:', result);
  return result;
}

// ── Get string value from a parsed dc: element ───────────────────────────────
function dcText(val) {
  if (!val) return '';
  const first = Array.isArray(val) ? val[0] : val;
  let text;
  if (typeof first === 'string') text = first.trim();
  else if (typeof first === 'object') text = String(first['#text'] || '').trim();
  else return '';
  return decodeEntities(text);
}

// ── Main extraction function ──────────────────────────────────────────────────
function extractEpubMetadata(epubPath, coversDir, fileHash) {
  const result = { title: path.basename(epubPath, '.epub'), author: '', cover_path: '', series_name: '', series_number: '', description: '' };

  try {
    const zip = new AdmZip(epubPath);

    // 1. Locate the OPF file via META-INF/container.xml
    const containerEntry = zip.getEntry('META-INF/container.xml');
    if (!containerEntry) return result;

    const container = xmlParser.parse(containerEntry.getData().toString('utf8'));
    const rootfiles  = container?.container?.rootfiles?.rootfile;
    const rootfile   = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
    const opfPath    = rootfile?.['@_full-path'];
    if (!opfPath) return result;

    // 2. Parse the OPF file
    const opfEntry = zip.getEntry(opfPath);
    if (!opfEntry) return result;

    const opf      = xmlParser.parse(opfEntry.getData().toString('utf8'));
    const metadata = opf?.package?.metadata;
    if (!metadata) return result;

    // Title
    const titleVal = dcText(metadata['dc:title']);
    if (titleVal) result.title = titleVal;

    // Author (may have multiple creators)
    const creatorVal = dcText(metadata['dc:creator']);
    if (creatorVal) result.author = creatorVal;

    // Description
    const descRaw = metadata['dc:description'];
    if (descRaw) result.description = dcText(descRaw);

    // Collect <meta> elements — may appear as 'meta' or 'opf:meta' depending on namespace
    const metasRaw = [
      ...(Array.isArray(metadata?.meta)       ? metadata.meta       : metadata?.meta       ? [metadata.meta]       : []),
      ...(Array.isArray(metadata?.['opf:meta']) ? metadata['opf:meta'] : metadata?.['opf:meta'] ? [metadata['opf:meta']] : []),
    ];
    // Normalise: strip any 'opf:' prefix from property/name attributes
    const metas = metasRaw.map(m => ({
      ...m,
      '@_property': String(m['@_property'] || '').replace(/^opf:/, ''),
      '@_name':     String(m['@_name']     || '').replace(/^opf:/, ''),
    }));

    // Calibre series tags
    for (const m of metas) {
      if (m['@_name'] === 'calibre:series')        result.series_name   = String(m['@_content'] || '').trim();
      if (m['@_name'] === 'calibre:series_index')  result.series_number = String(m['@_content'] || '').trim();
    }
    // EPUB 3: belongs-to-collection + group-position (linked via refines="#id")
    if (!result.series_name) {
      // Find all collection metas that have an id
      const collections = metas.filter(m => m['@_property'] === 'belongs-to-collection' && m['@_id']);
      for (const col of collections) {
        const colId    = col['@_id'];
        const position = metas.find(m => m['@_property'] === 'group-position' && m['@_refines'] === `#${colId}`);
        result.series_name   = String(col['#text'] || '').trim();
        result.series_number = position ? String(position['#text'] || '').trim() : '';
        if (result.series_name) break;
      }
      // Fallback: no refines — just grab first of each
      if (!result.series_name) {
        const col = metas.find(m => m['@_property'] === 'belongs-to-collection');
        if (col) {
          result.series_name = String(col['#text'] || '').trim();
          const pos = metas.find(m => m['@_property'] === 'group-position');
          if (pos) result.series_number = String(pos['#text'] || '').trim();
        }
      }
    }
    // 3. Find cover image in manifest
    const opfDir   = path.posix.dirname(opfPath); // e.g. "OEBPS" or "."
    const manifest = opf?.package?.manifest?.item || [];
    const items    = Array.isArray(manifest) ? manifest : [manifest];

    // Determine cover item ID from <meta name="cover"> or <meta property="cover-image">
    let coverId  = null;
    for (const m of metas) {
      if (m['@_name'] === 'cover')           { coverId = m['@_content']; break; }
      if (m['@_property'] === 'cover-image') { coverId = String(m['#text'] || '').trim(); break; }
    }

    // Cover must be an actual image item (not an xhtml wrapper page)
    const isImageItem = i => (i['@_media-type'] || '').startsWith('image/');

    let coverItem = null;

    // 1. Highest priority: item with properties="cover-image" that is an image
    coverItem = items.find(i =>
      (i['@_properties'] || '').includes('cover-image') && isImageItem(i)
    );

    // 2. Item whose id matches <meta name="cover"> and is an image
    if (!coverItem && coverId) {
      const byId = items.find(i => i['@_id'] === coverId);
      if (byId && isImageItem(byId)) coverItem = byId;
    }

    // 3. Item with id="cover" or id="cover-image" that is an image
    if (!coverItem) {
      coverItem = items.find(i =>
        ['cover', 'cover-image'].includes((i['@_id'] || '').toLowerCase()) && isImageItem(i)
      );
    }

    // 4. Any image item whose href contains "cover"
    if (!coverItem) {
      coverItem = items.find(i =>
        isImageItem(i) && (i['@_href'] || '').toLowerCase().includes('cover')
      );
    }

    // 5. Last resort: properties="cover-image" even without image media-type declared
    if (!coverItem) {
      coverItem = items.find(i => (i['@_properties'] || '').includes('cover-image'));
    }

    if (coverItem) {
      const coverHref     = coverItem['@_href'];
      const zipCoverPath  = opfDir === '.' ? coverHref
                          : `${opfDir}/${coverHref}`;

      // adm-zip normalises separators — try both slash styles
      const coverEntry = zip.getEntry(zipCoverPath)
                      || zip.getEntry(zipCoverPath.replace(/\//g, '\\'));

      if (coverEntry) {
        const ext          = path.extname(coverHref).toLowerCase() || '.jpg';
        const coverFilename = `${fileHash}${ext}`;
        fs.writeFileSync(path.join(coversDir, coverFilename), coverEntry.getData());
        result.cover_path = coverFilename;
      }
    }
  } catch (err) {
    console.error('[epub] metadata extraction failed:', err.message);
  }

  return result;
}

module.exports = { computeFileHash, computeFileMd5, extractEpubMetadata };
