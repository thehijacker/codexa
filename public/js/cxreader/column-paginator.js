// CXReader — Column (Spread) Paginator
// Lays the chapter out in native CSS multi-columns and turns pages by translating the body
// horizontally. Drives BOTH reading modes: single-column (1 column per spread, used on phones /
// narrow windows) and two-column (2 columns per spread, used on wide screens).
//
// Why CSS multicol for single column too: the browser fragments content into columns at line-box
// boundaries, so a text line is NEVER split across a page — no manual line measuring, no
// clip-path, none of the sub-pixel/FOUT clipping the old translateY paginator suffered on
// e-ink Android WebViews.
//
// Geometry: body is a multicol container with a fixed height (= viewport) and a column-width
// sized so exactly `cols` columns fit across the content area. With column-fill:auto, content
// that doesn't fit spills into additional columns laid out HORIZONTALLY beyond the box;
// html{overflow:hidden} hides them and translateX(-spread*spreadAdvance) reveals each spread.
//
// Page model: one logical "page" === one column, so pageCount/currentPage and CXReader.makePct
// are mode-independent. A spread shows `cols` columns; navigation moves one spread at a time.
// endPage reports the right-hand column (two-column only; 0 in single-column).

export class ColumnPaginator {
  constructor() {
    this._iframe       = null;
    this._viewportH    = 0;
    this._gap          = 0;
    this._cols         = 1;   // columns per spread (1 = single-column, 2 = two-column)
    this._padL         = 0;   // body padding-left (column area starts here)
    this._colAdvance   = 0;   // exact px from one column's start to the next (colW + gap)
    this._spreadAdvance = 0;  // px translateX per spread (cols * colAdvance)
    this._pageCount    = 1;   // total columns
    this._spreadCount  = 1;   // ceil(pageCount / cols)
    this._currentPage  = 1;   // left column of current spread (1-based)
  }

  // Call once after ChapterRenderer.render() returns (images already loaded).
  // opts: { columnGap, columns } — inter-column gap (px) and columns per spread (1 or 2).
  // Returns { pageCount, currentPage }.
  init(iframe, opts = {}) {
    this._iframe = iframe;
    const doc  = iframe.contentDocument;
    const body = doc.body;

    // Reset any previous transform/clip AND column lock BEFORE measuring so geometry is fresh.
    // The lock pins body width to the previous iframe size; clearing it lets body.clientWidth
    // reflect the current iframe size (important after window resize).
    body.style.transform = '';
    body.style.clipPath  = '';
    const prevLock = doc.getElementById('cx-pag-lock');
    if (prevLock) prevLock.textContent = '';

    this._cols = opts.columns === 2 ? 2 : 1;
    this._viewportH = iframe.clientHeight || window.innerHeight;
    this._viewportW = iframe.clientWidth  || window.innerWidth;
    this._currentPage = 1;

    // The body carries horizontal padding from buildEpubCss (the reading margin). Read it from
    // the live layout so the column geometry adapts to whatever margin is in effect, then size
    // each column so exactly `cols` fit inside the content area (contentW = clientWidth − padding).
    const cs   = doc.defaultView.getComputedStyle(body);
    this._padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    // Use the iframe viewport width (not body.clientWidth) so the column layout fills the full
    // viewport regardless of any max-width/width the epub CSS applies to the body element.
    // On old WebViews body.clientWidth can reflect the epub's own body constraint, making bodyW
    // narrower than the iframe — the gap on the right then exposes the next column's first letter.
    const contentW = Math.max(1, this._viewportW - this._padL - padR);

    // Inter-column gap.
    //  • two-column: the requested reading gap between the visible pair.
    //  • single-column: the off-screen neighbour columns start `gap` past the content box, so the
    //    gap MUST be ≥ the body's side padding or the prev/next page peeks into the page margins.
    //    Use max(padL,padR)+1 (the +1 absorbs sub-pixel rounding on fractional-DPR screens).
    this._gap = this._cols === 2
      ? Math.max(0, Math.round(opts.columnGap ?? 0))
      : Math.ceil(Math.max(this._padL, padR)) + 1;

    // INTEGER column geometry. If the browser is left to stretch columns to fill a fractional
    // contentW, its real per-column advance differs from ours by a sub-pixel amount that
    // ACCUMULATES across successive translateX offsets — the right column drifts further right on
    // each spread until it overflows (and the overflow shows on the next page's left). Instead we
    // pin an exact integer column width and constrain the body's content box to hold exactly
    // `cols` of them, so the browser cannot stretch and every advance is an exact integer.
    const colW    = Math.max(1, Math.floor((contentW - this._gap * (this._cols - 1)) / this._cols));
    const usableW = this._cols * colW + this._gap * (this._cols - 1);   // width the columns occupy
    const colWcss = colW;
    const bodyW   = usableW + this._padL + padR;   // border-box width → content box === usableW
    this._colAdvance    = colW + this._gap;        // exact integer
    this._spreadAdvance = this._cols * this._colAdvance;

    // Inject the multicol lock. column-width (not column-count:2) is required so overflow
    // spills into extra horizontal columns instead of being clipped vertically.
    let lockEl = doc.getElementById('cx-pag-lock');
    if (!lockEl) {
      lockEl = doc.createElement('style');
      lockEl.id = 'cx-pag-lock';
      doc.head.appendChild(lockEl);
    }
    // On old WebViews (e.g. Chrome 83), `html{overflow:hidden}` alone does not clip the body's
    // rightward multi-column spill — the html element expands to match the body instead of
    // clipping it. Locking html to the exact iframe viewport size prevents that expansion so
    // overflow:hidden actually clips. Width and height are both set so the html box is a true
    // viewport rectangle regardless of body size.
    lockEl.textContent =
      `html{overflow:hidden!important;width:${this._viewportW}px!important;height:${this._viewportH}px!important;}` +
      'body{' +
        `column-width:${colWcss}px!important;` +
        `column-gap:${this._gap}px!important;` +
        'column-fill:auto!important;' +
        `height:${this._viewportH}px!important;` +
        `width:${bodyW}px!important;max-width:none!important;box-sizing:border-box!important;` +
        'margin:0!important;' +
        'transform-origin:top left!important;will-change:transform;' +
      '}' +
      // buildEpubCss puts ~36px above the text but 0 below, so the top gap looks much larger than
      // the bottom. Trim the column-mode top padding (just enough to clear ascenders on the first
      // line). `html body` outranks buildEpubCss's `body` rule so this wins regardless of order.
      'html body{padding-top:8px!important;}' +
      'img,figure,table,svg,picture{break-inside:avoid;' +
        `max-height:${this._viewportH}px;}`;

    this._pageCount   = this._measureColumnCount(doc, body);
    this._spreadCount = Math.ceil(this._pageCount / this._cols);

    this._applySpread(0);
    return { pageCount: this._pageCount, currentPage: this._currentPage };
  }

  // Count columns deterministically from the rightmost rendered content rather than scrollWidth
  // (whose treatment of trailing padding varies across browsers). At spread 0 the body has no
  // transform, so client rects are in natural body-x coordinates.
  _measureColumnCount(doc, body) {
    let maxRight = 0;
    const range = doc.createRange();
    range.selectNodeContents(body);
    for (const r of range.getClientRects()) {
      if (r.width > 0 && r.height > 0) maxRight = Math.max(maxRight, r.right);
    }
    // Atomic blocks (images/tables) may sit outside the text range — include them too.
    for (const el of body.querySelectorAll('img, figure, table, picture, svg')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) maxRight = Math.max(maxRight, r.right);
    }
    if (maxRight <= 0) return 1;
    // Count by which column the rightmost REAL content sits IN (floor of its offset over the
    // column step), not by rounding a width. This ignores empty trailing blocks that the
    // browser may push into a blank extra column, and never under-counts a short last page.
    const lastCol = Math.max(0, Math.floor((maxRight - this._padL) / this._colAdvance));
    return lastCol + 1;
  }

  get pageCount()    { return this._pageCount; }
  get currentPage()  { return this._currentPage; }
  // Right-hand column of the current spread (two-column only); 0 in single-column or when the
  // last spread has only a left column. 0 makes the reader leave the right status slot blank.
  get endPage()      { if (this._cols < 2) return 0; const r = this._currentPage + 1; return r <= this._pageCount ? r : 0; }
  get isTwoColumn()  { return this._cols === 2; }
  get isAtEnd()      { return this._spreadIndex() >= this._spreadCount - 1; }
  get isAtStart()    { return this._spreadIndex() <= 0; }

  // Navigate so that page n (a column index) is visible. Snaps to the spread containing it.
  goToPage(n) {
    const page = Math.max(1, Math.min(n, this._pageCount));
    const spread = Math.floor((page - 1) / this._cols);
    this._applySpread(spread);
    return this._currentPage;
  }

  goToLastPage() { return this.goToPage(this._pageCount); }

  // Returns true if advanced, false if already at the last spread (caller changes chapter).
  next() {
    if (this.isAtEnd) return false;
    this._applySpread(this._spreadIndex() + 1);
    return true;
  }

  prev() {
    if (this.isAtStart) return false;
    this._applySpread(this._spreadIndex() - 1);
    return true;
  }

  // Navigate to the spread containing el (used for annotation/footnote jumps). In column flow
  // an element's position is identified by its horizontal offset, so we use rect.left — valid
  // because spread 0 has no transform, making getBoundingClientRect().left the natural body-x.
  goToElement(el) {
    if (!el) return this.goToPage(1);
    const x = el.getBoundingClientRect().left;
    const col = Math.round((x - this._padL) / this._colAdvance); // 0-based column
    return this.goToPage(Math.max(0, col) + 1);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _spreadIndex() { return Math.floor((this._currentPage - 1) / this._cols); }

  _applySpread(spread) {
    const s = Math.max(0, Math.min(spread, this._spreadCount - 1));
    this._currentPage = Math.min(this._cols * s + 1, this._pageCount);
    const body = this._iframe?.contentDocument?.body;
    if (!body) return;
    // Each spread advances by `cols` columns. translateX is resolved in the body's local
    // coordinate space, so the offset is exact regardless of prior transforms.
    const offset = Math.round(s * this._spreadAdvance);
    body.style.transform = offset === 0 ? '' : `translateX(-${offset}px)`;
  }
}
