// CXReader — Scroll-window Paginator
// Wraps a rendered chapter iframe and provides deterministic page navigation.
// Approach: html{overflow:hidden} blocks viewport scrolling; body translates upward to "turn
// pages"; body{clip-path:inset()} hides the first line of the next page when the break lands
// before idealEnd so no line is ever split across two pages.

export class Paginator {
  constructor() {
    this._iframe      = null;
    this._viewportH   = 0;
    this._naturalH    = 0;
    this._pageBreaks  = [0];  // integer body-y cut point where each page starts
    this._pageCount   = 1;
    this._currentPage = 1;
  }

  // Call once after ChapterRenderer.render() returns (images already loaded).
  // Returns { pageCount, currentPage }.
  init(iframe, _opts) {  // _opts accepted for interface parity with ColumnPaginator (unused)
    this._iframe    = iframe;
    const doc       = iframe.contentDocument;
    if (!doc?.body) return { pageCount: 1, currentPage: 1 };
    const body      = doc.body;

    // Reset any previous transform/clip BEFORE measuring so positions are in natural coords
    body.style.transform = '';
    body.style.clipPath  = '';

    this._viewportH = iframe.clientHeight || window.innerHeight;
    // scrollHeight is intrinsic height regardless of overflow — measure FIRST
    this._naturalH  = Math.max(body.scrollHeight, body.offsetHeight, this._viewportH);
    this._currentPage = 1;

    // Inject overflow lock so body transform fully controls visible content
    let lockEl = doc.getElementById('cx-pag-lock');
    if (!lockEl) {
      lockEl = doc.createElement('style');
      lockEl.id = 'cx-pag-lock';
      doc.head.appendChild(lockEl);
    }
    lockEl.textContent = 'html{overflow:hidden!important;}body{transform-origin:top left!important;will-change:transform;}';

    this._pageBreaks = this._computePageBreaks(doc, this._naturalH, this._viewportH);
    this._pageCount  = this._pageBreaks.length;

    this._applyTransform(1);
    return { pageCount: this._pageCount, currentPage: this._currentPage };
  }

  get pageCount()   { return this._pageCount; }
  get currentPage() { return this._currentPage; }
  // Uniform interface with ColumnPaginator: single-column has no separate "right" page.
  get endPage()     { return this._currentPage; }
  get isTwoColumn() { return false; }
  get isAtEnd()     { return this._currentPage >= this._pageCount; }
  get isAtStart()   { return this._currentPage <= 1; }

  goToPage(n) {
    this._currentPage = Math.max(1, Math.min(n, this._pageCount));
    this._applyTransform(this._currentPage);
    return this._currentPage;
  }

  goToLastPage() { return this.goToPage(this._pageCount); }

  // Navigate to the page whose start offset is ≤ bodyY (natural document y-coordinate).
  goToBodyY(bodyY) {
    if (!this._pageBreaks?.length) return this.goToPage(1);
    let page = 1;
    for (let i = this._pageBreaks.length - 1; i >= 0; i--) {
      if (this._pageBreaks[i] <= bodyY) { page = i + 1; break; }
    }
    return this.goToPage(page);
  }

  // Navigate to the page containing el (used for annotation/footnote jumps). Uniform with
  // ColumnPaginator.goToElement; single-column keys off the element's vertical position.
  goToElement(el) {
    if (!el) return this.goToPage(1);
    return this.goToBodyY(el.getBoundingClientRect().top);
  }

  // Returns true if advanced, false if already at boundary (caller handles chapter change)
  next() {
    if (this._currentPage >= this._pageCount) return false;
    this.goToPage(this._currentPage + 1);
    return true;
  }

  prev() {
    if (this._currentPage <= 1) return false;
    this.goToPage(this._currentPage - 1);
    return true;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  // Build the integer cut point where each page starts (body-y of its first visible pixel).
  //
  // A page only keeps a line if its box plus a descender clearance fits in the viewport, and the
  // cut between two pages is a SINGLE point placed in the inter-line clean band. Because the same
  // cut point is both this page's clip-bottom and the next page's translate-top, no glyph ink is
  // ever split/duplicated across the boundary — and a line is dropped to the next page (one line
  // less) rather than clipped. See the loop below for the clean-gap vs tight-spacing cases.
  _computePageBreaks(doc, naturalH, viewportH) {
    if (viewportH <= 0) return [0];

    // Use Range.getClientRects() on text block contents — unlike element.getClientRects()
    // (which returns one rect for the whole block), Range gives one rect per VISUAL LINE.
    // This lets the snap algorithm break mid-paragraph at a clean line boundary instead of
    // treating large paragraphs as all-or-nothing units.
    const BLOCK = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre';
    const rects = [];
    for (const el of doc.body.querySelectorAll(BLOCK)) {
      // Skip elements nested inside another matching element to avoid double-counting
      // (e.g. <pre> inside <blockquote> — process the <pre> only, not the outer).
      if (el.parentElement?.closest(BLOCK)) continue;
      const range = doc.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) {
        if (r.height > 0) rects.push({ top: r.top, bottom: r.bottom });
      }
    }
    // Images, tables, etc. are atomic — keep them as single rects
    for (const el of doc.body.querySelectorAll('img, figure, table, picture')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0) rects.push({ top: r.top, bottom: r.bottom });
    }
    rects.sort((a, b) => a.top - b.top);

    // Merge overlapping rects that belong to the same visual line (e.g. multiple inline
    // elements — <em>, <a>, etc. — each produce their own rect for the same line).
    const lines = [];
    for (const r of rects) {
      const last = lines[lines.length - 1];
      if (last && r.top < last.bottom) {
        last.bottom = Math.max(last.bottom, r.bottom); // extend to tallest inline box
      } else {
        lines.push({ top: r.top, bottom: r.bottom });
      }
    }

    // Descender/ink clearance, sized from the median line height. Reserved at the bottom of
    // every page so the last line's box AND its descenders sit inside the viewport — a line
    // only stays on the page if it clears the bottom by `clear` (this is the "show one line
    // less rather than clip" guarantee).
    const lineHs  = lines.map(l => l.bottom - l.top).filter(h => h > 0).sort((a, b) => a - b);
    const medianH = lineHs.length ? lineHs[Math.floor(lineHs.length / 2)] : 0;
    const clear   = Math.round(medianH * 0.15);

    const starts = [0];
    let pos = 0;

    while (pos + viewportH < naturalH) {
      const idealEnd = pos + viewportH - clear;       // leave `clear` px at the bottom edge
      const minSnap  = pos + (viewportH - clear) * 0.5;

      // Index of the last line that fully fits (with clearance) and is past the half-page mark.
      let fit = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].top >= idealEnd) break;
        if (lines[i].bottom > idealEnd) continue;     // overshoots — belongs on the next page
        if (lines[i].bottom >= minSnap) fit = i;
      }

      // Single cut point used for BOTH this page's bottom and the next page's top, placed in the
      // inter-line clean band so no glyph ink is ever duplicated across the boundary:
      //  • clean gap → cut `clear` px below this line (past its descenders, above the next line);
      //  • tight/contiguous → cut at the next line's top (its overlap, if any, is hidden once).
      let br;
      if (fit >= 0) {
        const nextTop = fit + 1 < lines.length ? lines[fit + 1].top : naturalH;
        br = Math.round(Math.min(nextTop, lines[fit].bottom + clear));
      } else {
        br = Math.round(idealEnd);                     // no line fits (e.g. a very tall image)
      }
      starts.push(br);
      pos = br;
    }

    return starts;
  }

  _applyTransform(page) {
    const body = this._iframe?.contentDocument?.body;
    if (!body) return;
    const pageStart = this._pageBreaks?.[page - 1] ?? 0;          // integer cut point
    const nextStart = this._pageBreaks?.[page] ?? this._naturalH; // integer cut point
    // clip-path is resolved in the body's local coordinate space BEFORE the transform is applied,
    // so inset(0 0 Xpx 0) clips at body y = (naturalH - X) = nextStart regardless of how far the
    // body is translated. html{overflow:hidden} (set in init) blocks viewport scrolling.
    // This page's clip-bottom and the next page's translate-top are the SAME integer cut point,
    // so no pixel is ever both shown here and shown on the next page → no duplicated glyph ink.
    const insetBot = Math.max(0, Math.round(this._naturalH) - nextStart);
    body.style.transform = pageStart === 0 ? '' : `translateY(-${pageStart}px)`;
    body.style.clipPath  = insetBot > 0 ? `inset(0 0 ${insetBot}px 0)` : '';
  }
}
