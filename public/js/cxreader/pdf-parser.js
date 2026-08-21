// CXReader — PDF parser
// Parses a PDF into the same book-object shape as CbzParser.parse() / EpubParser.parse() —
// pages are handled like comic pages (see the PDF-support plan). Unlike CBZ, a PDF page isn't
// a ready-to-use blob URL: spine[i] is just a { pageNum } reference into the shared pdf.js
// document, and the actual rendering (async, CPU-real page.render()) happens on demand in
// cxreader/index.js's _renderPdfItem/_renderPdfContinuous — this parser only opens the
// document and reads its page count + Info-dictionary metadata.
//
// Two things this file deliberately does NOT do, both confirmed live and both because of how
// build.mjs's Step 3 bundles reader.js (bundle:true, no code-splitting — the same reason
// cxreader/index.js itself always ends up inlined into dist/js/reader.js, per sw.js's own
// comment on that):
//   1. Import pdf.js with a top-level `import ... from`. A STATIC top-level import gets hoisted
//      and eagerly fetched the moment reader.js loads — for EVERY book, not just PDFs — once
//      this file's own (small) code is inlined into that bundle. It's imported dynamically
//      inside parse() instead, so the ~400KB library is only ever fetched the first time a PDF
//      is actually opened; the browser's module cache makes every call after the first free.
//   2. Resolve the vendor files via `new URL(relative, import.meta.url)`. That's only correct
//      if this module keeps its own file's URL as its base — but once inlined into reader.js,
//      import.meta.url there resolves to reader.js's own location, one directory shallower than
//      this file's real one, silently landing one level short (confirmed live: it resolved to
//      /vendor/pdf.worker.min.mjs instead of /js/vendor/pdf.worker.min.mjs). Root-absolute paths
//      side-step that entirely — correct regardless of which file the code ends up living in,
//      consistent with this app's root-only-paths convention (it doesn't support subpath
//      deployment anyway). build.mjs marks both vendor files `external` so esbuild leaves these
//      two paths as literal strings rather than trying to resolve them as local files.
const PDFJS_URL    = '/js/vendor/pdf.min.mjs';
const PDFJS_WORKER = '/js/vendor/pdf.worker.min.mjs';

// Resolve a pdf.js outline entry's `dest` (either a named destination string, or an already-
// explicit [ref, ...] array) down to a 1-based page number — matching spine[i].pageNum above.
async function pdfDestToPageNum(doc, dest) {
  const explicitDest = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  const ref = Array.isArray(explicitDest) ? explicitDest[0] : null;
  if (ref == null) return null;
  const pageIndex = await doc.getPageIndex(ref);
  return pageIndex + 1;
}

// Recursively convert pdf.js's outline tree (title/dest/items) into the { label, href,
// children } shape epub-parser.js's TOC already uses. An outline entry that points at an
// external URL (no dest) rather than a page in this document is kept only if it has children
// worth showing (href stays '' — unclickable, same as epub-parser.js's landmarks-only nodes).
async function pdfOutlineToToc(doc, items) {
  const out = [];
  for (const item of items) {
    const label = (item.title || '').trim();
    if (!label) continue;
    let href = '';
    if (item.dest) {
      try {
        const pageNum = await pdfDestToPageNum(doc, item.dest);
        if (pageNum != null) href = `page-${pageNum}`;
      } catch { /* unresolvable destination — leave href empty, still show the label/children */ }
    }
    const children = item.items?.length ? await pdfOutlineToToc(doc, item.items) : [];
    if (href || children.length) out.push({ label, href, children });
  }
  return out;
}

export class PdfParser {
  async parse(arrayBuffer, filenameHint) {
    // A variable, not a string literal, is what actually matters here — esbuild can only
    // statically analyze (and thus bundle-inline) a literal import() argument; a variable is
    // left as a genuine runtime import() unconditionally, which is what makes point 1 above
    // (the library only fetched on first real use) actually true rather than just intended.
    const pdfjsLib = await import(PDFJS_URL);
    // Idempotent — setting this on every parse() call is harmless (dynamic import() of an
    // already-loaded URL resolves instantly from the module cache, no re-fetch), and simpler
    // than a one-time-init flag for what's a rare call (once per PDF opened).
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

    // pdf.js detaches/consumes the buffer it's given — the caller (cxreader/index.js's open())
    // still holds the original _epubArrayBuffer for its own purposes (offline re-open etc.), so
    // hand pdf.js its own copy rather than risk it being neutered out from under the caller.
    const data = new Uint8Array(arrayBuffer.slice(0));
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

    let title = '', author = '', description = '';
    try {
      const info = (await doc.getMetadata())?.info || {};
      if (info.Title)   title       = String(info.Title).trim();
      if (info.Author)  author      = String(info.Author).trim();
      if (info.Subject) description = String(info.Subject).trim();
    } catch { /* ignore — falls back to filenameHint/empty below */ }
    if (!title) title = (filenameHint || '').replace(/\.pdf$/i, '') || 'PDF';

    const count = doc.numPages;
    const spine = [];
    for (let i = 0; i < count; i++) {
      spine.push({ id: `page-${i + 1}`, index: i, href: `page-${i + 1}`, pageNum: i + 1, mediaType: 'application/pdf' });
    }
    if (!spine.length) throw new Error('[CXReader] PDF: no pages found');

    // PDF outline (bookmarks) → the same { label, href, children } shape epub-parser.js's TOC
    // uses — href is a spine item's own href ("page-N"), so the existing TOC panel/progress-bar
    // chapter markers/active-item highlighting all work unchanged, no PDF-specific UI needed.
    let toc = [];
    try {
      const outline = await doc.getOutline();
      if (outline?.length) toc = await pdfOutlineToToc(doc, outline);
    } catch { /* no outline, or a malformed one — toc stays [] like any PDF without bookmarks */ }

    return {
      spine,
      manifest: new Map(),
      metadata: { title, author, description, series: '', seriesNumber: '', genre: '', language: '', identifier: '' },
      toc,
      opfBase: '',
      spineWeights: spine.map(() => 1),
      isPdf: true,
      _pdfDoc: doc,
      // Cache of already-fetched pdf.js PDFPageProxy objects, keyed by 1-based page number —
      // getPage() is itself cheap-ish but not free, and both paginated and continuous rendering
      // (plus continuous's placeholder-sizing pass) all want the same page object repeatedly.
      _pageCache: new Map(),
    };
  }
}
