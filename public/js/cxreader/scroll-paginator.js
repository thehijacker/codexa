// CXReader — Scroll (Continuous) Paginator
// Drives "Continuous" mode: natural vertical scrolling instead of column/page turning. Used
// for EPUB (target = the chapter iframe) and for continuous CBZ (target = the plain stacked-
// images container, see cxreader/index.js's _renderCbzContinuous) — the underlying tracking
// logic (measure scrollHeight/viewportHeight, report a virtual "page", react to scroll) is
// identical either way, so one class serves both rather than duplicating it.
//
// Page model: same interface contract as ColumnPaginator/FixedPagePaginator
// (pageCount/currentPage/endPage/isTwoColumn/isAtStart/isAtEnd/goToPage/goToLastPage/next/
// prev/goToElement/goToRange) so every existing consumer — bookmarks, search/annotation
// back-navigation, resume-on-open, the status bar, TOC/percent jump — keeps working
// unmodified. "Page" here is defined as ONE VIEWPORT HEIGHT of scrolled content (not a real
// layout page) specifically so that every one of those consumers, which only ever stores/
// restores/displays a plain page INTEGER, keeps doing exactly that without any changes.
//
// goToElement()/goToRange() (footnote/search/annotation jumps) don't need to snap to that
// virtual-page grid at all, unlike the column paginator — native scroll can go to any pixel,
// so those land more precisely here than in paginated mode, not less.

const END_EPSILON = 4; // px slack for "reached the bottom" (sub-pixel scroll rounding)

export class ScrollPaginator {
  constructor() {
    this._scrollEl   = null;
    this._eventTarget = null; // where 'scroll' listeners are attached (may differ from _scrollEl)
    this._viewportH  = 0;
    this._contentH   = 0;
    this._pageCount  = 1;
    this._currentPage = 1;
    this._onScroll   = null;
    this._onReachEnd = null;
    this._endFired   = false;
    this._listener   = null;
    this._rafPending = false;
  }

  // target: either a chapter iframe (EPUB) or a plain scrollable container element (CBZ).
  // opts: { onScroll, onReachEnd } — both optional callbacks, invoked at most once per
  // animation frame (see _handleScroll). onReachEnd is edge-triggered (fires once per
  // transition into "at the bottom", not on every scroll event while already there) so the
  // caller (CXReader.next(), for EPUB chapter auto-advance) doesn't get called repeatedly.
  init(target, opts = {}) {
    this._cleanup();

    const isIframe = !!target?.contentDocument;
    if (isIframe) {
      const doc = target.contentDocument;
      if (!doc?.body) return { pageCount: 1, currentPage: 1 };
      // Natural flow: no column lock, no transform/clip-path paginator tricks — just let the
      // iframe's own document scroll. Shares the #cx-pag-lock element id with ColumnPaginator
      // so switching layout modes mid-chapter (see CXReader.setLayout) cleanly overwrites
      // whichever lock CSS was there before, on the same element.
      let lockEl = doc.getElementById('cx-pag-lock');
      if (!lockEl) { lockEl = doc.createElement('style'); lockEl.id = 'cx-pag-lock'; doc.head.appendChild(lockEl); }
      lockEl.textContent =
        'html{overflow-y:auto!important;overflow-x:hidden!important;}' +
        'body{transform:none!important;clip-path:none!important;will-change:auto!important;}';
      doc.body.style.transform = '';
      doc.body.style.clipPath  = '';
      this._scrollEl    = doc.scrollingElement || doc.documentElement;
      this._eventTarget = doc; // scroll on the root element fires on `document`, not the element, in most engines
    } else {
      if (!target) return { pageCount: 1, currentPage: 1 };
      this._scrollEl    = target;
      this._eventTarget = target;
    }

    this._onScroll   = typeof opts.onScroll   === 'function' ? opts.onScroll   : null;
    this._onReachEnd = typeof opts.onReachEnd === 'function' ? opts.onReachEnd : null;
    this._endFired   = false;

    this._measure();
    this._scrollEl.scrollTop = 0;
    this._currentPage = 1;

    this._listener = () => this._handleScroll();
    this._eventTarget.addEventListener('scroll', this._listener, { passive: true });

    return { pageCount: this._pageCount, currentPage: this._currentPage };
  }

  get pageCount()      { return this._pageCount; }
  get currentPage()    { return this._currentPage; }
  // CXReader (EPUB continuous mode) needs this to compute a CHAPTER-relative page/pageCount
  // for the status bar — this paginator's own pageCount/currentPage track the whole scrollable
  // span (however many chapters have been appended so far), not just the current one.
  get viewportHeight() { return this._viewportH; }
  get endPage()     { return 0; }       // no two-column concept in continuous mode
  get isTwoColumn() { return false; }
  get isAtEnd()     { return this._distanceFromEnd() <= END_EPSILON; }
  get isAtStart()   { return (this._scrollEl?.scrollTop || 0) <= END_EPSILON; }
  // Within one screen of the bottom — used by CXReader (EPUB continuous mode) to trigger
  // appending the next chapter's content BEFORE the user actually reaches the end, so
  // scrolling never has to stop and jump to a freshly-loaded chapter; see
  // _maybeAppendNextChapter in cxreader/index.js.
  get isNearEnd()   { return this._distanceFromEnd() <= this._viewportH; }

  // Re-measure scrollHeight/pageCount after the DOM changed underneath (e.g. a chapter was
  // just appended) WITHOUT resetting scroll position or re-attaching listeners — unlike
  // init(), which is for starting fresh on a new target.
  remeasure() { this._measure(); }

  goToPage(n) {
    if (!this._scrollEl) return this._currentPage;
    const page = Math.max(1, Math.min(n, this._pageCount));
    this._scrollEl.scrollTop = (page - 1) * this._viewportH;
    this._currentPage = page;
    return this._currentPage;
  }

  goToLastPage() { return this.goToPage(this._pageCount); }

  // "Jump by one screen" — the meaning ArrowLeft/Right/Space/PageUp/Down and the on-screen
  // nav arrows keep having in continuous mode (see reader.js), layered on top of free scroll.
  next() {
    if (this.isAtEnd) return false;
    this.goToPage(this._currentPage + 1);
    return true;
  }

  prev() {
    if (this.isAtStart) return false;
    this.goToPage(Math.max(1, this._currentPage - 1));
    return true;
  }

  // Scroll straight to the element/range's real pixel offset — no virtual-page snapping,
  // see the file header comment for why this is more precise here than in paginated mode.
  goToElement(el) {
    if (!el || !this._scrollEl) return this.goToPage(1);
    const target = this._bodyY(el.getBoundingClientRect().top);
    this._scrollEl.scrollTop = Math.max(0, target);
    this._syncFromScroll();
    return this._currentPage;
  }

  goToRange(range) {
    const rects = range?.getClientRects?.();
    if (!rects?.length) return this.goToPage(1);
    const target = this._bodyY(rects[0].top);
    this._scrollEl.scrollTop = Math.max(0, target);
    this._syncFromScroll();
    return this._currentPage;
  }

  destroy() { this._cleanup(); }

  // ── Private ───────────────────────────────────────────────────────────────────

  // getBoundingClientRect().top is relative to the current viewport, not the scrolled
  // document — add the current scroll offset to get an absolute scroll-target position.
  _bodyY(clientTop) { return (this._scrollEl?.scrollTop || 0) + clientTop; }

  _measure() {
    if (!this._scrollEl) return;
    this._viewportH = this._scrollEl.clientHeight || window.innerHeight || 1;
    this._contentH  = Math.max(this._scrollEl.scrollHeight, this._viewportH);
    this._pageCount = Math.max(1, Math.ceil(this._contentH / this._viewportH));
  }

  _distanceFromEnd() {
    if (!this._scrollEl) return 0;
    return this._contentH - (this._scrollEl.scrollTop + this._viewportH);
  }

  _syncFromScroll() {
    if (!this._scrollEl) return;
    this._currentPage = Math.min(
      this._pageCount,
      Math.floor((this._scrollEl.scrollTop || 0) / this._viewportH) + 1
    );
  }

  // rAF-throttled: scroll events can fire many times per frame, but nothing downstream
  // (status bar text, debounced remote sync) needs updates faster than a frame.
  _handleScroll() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      if (!this._scrollEl) return;
      this._syncFromScroll();
      this._onScroll?.();
      const atEnd = this._distanceFromEnd() <= END_EPSILON;
      if (atEnd && !this._endFired) {
        this._endFired = true;
        this._onReachEnd?.();
      } else if (!atEnd) {
        this._endFired = false;
      }
    });
  }

  _cleanup() {
    if (this._listener && this._eventTarget) {
      this._eventTarget.removeEventListener('scroll', this._listener);
    }
    this._listener = null;
    this._eventTarget = null;
  }
}
