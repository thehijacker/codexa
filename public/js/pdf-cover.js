// PDF cover-thumbnail generation — shared by library.js (right after a manual upload) and
// reader.js (backfill the first time an already-imported PDF, e.g. from OPDS or BookOrbit, is
// opened with no cover yet).
//
// Deliberately CLIENT-SIDE, not server-side. pdf.js needs a real Canvas to rasterize a page, and
// the server-side option — pdfjs-dist plus a native canvas binding (@napi-rs/canvas) — was
// tried and rejected: it SEGFAULTED the whole Node process on a real-world test PDF (a crash
// that takes down every user's session, not just a failed cover), on top of being exactly the
// native-binary deployment risk this project already avoids (better-sqlite3/bcrypt are the only
// two it accepts, and both need the `allowScripts` carve-out because of it). The browser's own
// Canvas is the same one already proven safe — it's what renders every PDF page a reader
// actually looks at.
const PDFJS_URL    = '/js/vendor/pdf.min.mjs';
const PDFJS_WORKER = '/js/vendor/pdf.worker.min.mjs';
const MAX_W = 600; // thumbnail-sized — plenty for a library-grid card; keeps the upload small

let _pdfjsLibPromise = null;
function loadPdfjs() {
  if (!_pdfjsLibPromise) {
    _pdfjsLibPromise = import(PDFJS_URL).then(mod => {
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return mod;
    });
  }
  return _pdfjsLibPromise;
}

// Renders page 1 of an ALREADY-OPEN pdf.js document to a JPEG Blob (null if rendering failed).
export async function renderPdfCoverBlob(pdfDoc) {
  const page = await pdfDoc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(MAX_W / vp1.width, 2); // never upscale a tiny/already-small page much
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

// Opens a raw PDF ArrayBuffer just far enough to render its cover — used by library.js right
// after upload, where nothing has parsed the file client-side yet (unlike reader.js, which
// already has a live pdf.js document from actually opening the book).
export async function renderPdfCoverBlobFromBytes(arrayBuffer) {
  const pdfjsLib = await loadPdfjs();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
  try {
    return await renderPdfCoverBlob(doc);
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

// Uploads a rendered cover for a book that doesn't have one yet. `apiFetchFn` is the caller's
// own apiFetch import (api.js isn't re-exported here to avoid a second module instance) — throws
// on failure same as apiFetch itself; every caller wraps this in its own try/catch and ignores
// the result on failure, since a missing cover is cosmetic, never worth surfacing as an error.
export async function uploadPdfCover(apiFetchFn, bookId, blob) {
  const fd = new FormData();
  fd.append('cover', blob, 'cover.jpg');
  const data = await apiFetchFn(`/books/${bookId}/cover`, { method: 'POST', body: fd });
  return data?.cover_path || null;
}
