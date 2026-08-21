/**
 * pdf.js — server-side PDF metadata extraction.
 * Deliberately metadata-only (title/author/page count from the PDF's own Info dictionary) —
 * NOT cover thumbnail generation, which would need actually rendering page 1 to a raster
 * image. pdfjs-dist can do that too, but only via `node-canvas`, a native binary dependency —
 * this project's only other native deps (better-sqlite3, bcrypt) are exactly the kind of
 * install/deploy friction (see package.json's `allowScripts`) worth not adding a third
 * instance of just for a library-grid thumbnail. PDFs get a placeholder cover for now (same
 * as any book with no cover_path) — see the PDF-support plan for the full reasoning.
 *
 * pdfjs-dist ships ESM-only (`"main": "build/pdf.mjs"`, no CJS entry) — this file is
 * CommonJS (matching every other server/utils/*.js), so it loads pdf.js via a dynamic
 * `import()` rather than `require()`, same interop pattern Node itself documents for
 * CJS-consuming-ESM. That also makes this module's own export async, unlike
 * extractEpubMetadata/extractCbzMetadata (both synchronous) — callers must await it.
 */

const path = require('path');

let _pdfjsLibPromise = null;
function loadPdfjs() {
  if (!_pdfjsLibPromise) {
    _pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then(mod => {
      // Metadata-only use never actually needs the worker (no page rendering here), but
      // pdf.js still checks this is set before it'll proceed — point it at the same
      // legacy Node-compatible build the main module itself came from.
      mod.GlobalWorkerOptions.workerSrc =
        path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy/build/pdf.worker.mjs');
      return mod;
    });
  }
  return _pdfjsLibPromise;
}

// ── PDF metadata extraction ─────────────────────────────────────────────────
async function extractPdfMetadata(pdfPath, coversDir, fileHash) {
  // title starts empty rather than falling back to the filename (which by the time this runs
  // is always the hash-renamed destination file) — see extractEpubMetadata's comment in
  // server/utils/epub.js for why callers, not this function, own the final fallback.
  const result = {
    title: '', author: '', cover_path: '',
    series_name: '', series_number: '', description: '', publisher: '',
    language: '', isbn: '', genres: '', pages: '',
  };

  let doc = null;
  try {
    const pdfjsLib = await loadPdfjs();
    const fs = require('fs');
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    result.pages = String(doc.numPages);
    const info = (await doc.getMetadata())?.info || {};
    if (info.Title)   result.title  = String(info.Title).trim() || result.title;
    if (info.Author)  result.author = String(info.Author).trim();
    if (info.Subject) result.description = String(info.Subject).trim();
  } catch (err) {
    // Covers both a genuinely corrupt file and an encrypted/password-protected one (pdf.js
    // rejects those outright without a password callback) — either way, metadata just falls
    // back to the filename-derived title above rather than failing the whole upload.
    console.error('[pdf] metadata extraction failed:', err.message);
  } finally {
    try { await doc?.destroy(); } catch { /* ignore */ }
  }

  return result;
}

// PDF magic number (%PDF-) at the start of the file — mirrors isCbrBuffer's pattern in
// server/utils/cbr.js for sniffing actual file content rather than trusting the extension.
function isPdfBuffer(buf) {
  return buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-';
}

module.exports = { extractPdfMetadata, isPdfBuffer };
