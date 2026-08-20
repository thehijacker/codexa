// CXReader — Experimental EPUB reader library
// Phase 5: Navigation, TOC, progress save.

import { EpubParser }        from './epub-parser.js';
import { ChapterRenderer }   from './renderer.js';
import { ColumnPaginator }   from './column-paginator.js';
import { CbzParser }         from './cbz-parser.js';
// PdfParser (and, transitively, the ~400KB pdf.min.mjs vendor module) is loaded via a dynamic
// import() inside open() instead — only when a PDF is actually detected, so EPUB/CBZ readers
// (the overwhelming majority of opens) pay zero cost for it, same reasoning as pdf-parser.js's
// own `import * as pdfjsLib` being a plain ESM import rather than a vendored <script> global.
import { FixedPagePaginator } from './fixed-paginator.js';
import { ScrollPaginator }   from './scroll-paginator.js';
import { log } from '../logger.js';

// Resolves once `img` has actually finished decoding and is ready to paint — used by
// _renderCbzItem below to avoid a visible gap while swapping comic pages. img.decode() is
// preferred over the `load` event: `load` can fire before the browser has finished the
// (still real, even for an already-downloaded blob URL) decode work needed to actually
// display a large image, which is exactly the gap this exists to close. Falls back to the
// complete/load-event check (mirroring img-bg-fix.js's same pattern) for engines without
// HTMLImageElement.decode().
function _cxImageReady(img) {
  if (img.decode) return img.decode().catch(() => {});
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise(resolve => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  });
}

// ── PDF rendering constants ─────────────────────────────────────────────────
// Cap on a rendered PDF page canvas's pixel width — crisp at fit-to-screen and moderate zoom
// (comic-viewer.js's zoom is a CSS transform on top of this, same as CBZ) without the memory
// cost of rendering arbitrarily large, e.g. a very high-DPI device times a physically large
// page size. See the PDF-support plan.
const PDF_MAX_CANVAS_W = 2200;
// Continuous PDF windowed rendering: how many pages on either side of the current (topmost-
// visible) page stay rendered as real canvases; everything further away is released back to an
// empty placeholder. Keeps memory bounded regardless of document length — the one genuinely new
// subsystem in the whole PDF feature (CBZ continuous can afford to render the whole book at
// once because a pre-decoded image is cheap; a rendered PDF canvas is not).
const PDF_WINDOW_RADIUS = 2;

export class CXReader {
  constructor() {
    this._parser        = new EpubParser();
    this._renderer      = null;
    this._paginator     = null;
    this._book          = null;
    this._spineIdx      = 0;
    this._containerEl   = null;
    this._readerCss     = '';
    this._twoColumn     = false;  // single-column (vertical) by default
    this._columnGap     = 0;      // px gap between the two columns when two-column is on
    this._isCbz         = false;
    this._isPdf         = false;
    this._isFixedLayout = false;
    this._continuous    = false; // "Continuous" spread mode (prefs.spread==='continuous', see reader.js)
    this._cbzRenderToken = 0; // staleness guard for _renderCbzItem's deferred DOM swap
    this._cbzScrollToken = 0; // staleness guard for _scrollCbzContinuousToIndex's async decode-then-scroll
    this._cbzContinuousWrap = null; // .cx-cbz-continuous-wrap, only set while continuous CBZ is active
    this._cbzContinuousImgs = [];
    // PDF equivalents of the _cbz* fields above — kept separate rather than shared (see the
    // PDF-support plan's stated tradeoff: parallel fields/branches, not a shared abstraction,
    // so the already-working CBZ code paths are never touched).
    this._pdfRenderToken = 0;   // staleness guard for _renderPdfItem's deferred canvas swap
    this._pdfScrollToken = 0;   // staleness guard for _scrollPdfContinuousToIndex
    this._pdfContinuousWrap = null; // .cx-pdf-continuous-wrap, only set while continuous PDF is active
    this._pdfContinuousPages = []; // per-page { el, canvas|null, rendered, viewport1 } placeholders
    this._pdfWindowToken = 0;   // staleness guard for _updatePdfWindow's async render-into-placeholder
    // Fraction scrolled through the current (topmost-visible) spine item — CBZ continuous
    // (_updateCbzContinuousPosition) and EPUB continuous (_syncContinuousSpineIdx) both keep
    // this live as the user scrolls; makePct() uses it in place of the paginator-page-based
    // fraction for any continuous mode, since the paginator itself tracks the whole scrollable
    // span (which for EPUB continuous can be several appended chapters), not just one chapter.
    this._continuousFrac = 0;
    // EPUB continuous mode only: highest spine index appended into the live multi-chapter
    // document so far, and an in-flight guard so a burst of scroll events near the end doesn't
    // trigger overlapping appendChapter() calls — see _maybeAppendNextChapter.
    this._continuousLoadedUpTo = -1;
    this._continuousAppending  = false;
    // Staleness guard for _maybeAppendNextChapter's append loop — bumped alongside every
    // _continuousLoadedUpTo reset (a fresh render/jump), so an in-flight loop from BEFORE that
    // jump stops appending chapters that are no longer relevant to the now-current document.
    this._continuousRenderToken = 0;
    // Called with (iframe) before paginator.init() — use to inject bionic/annotations
    this.onBeforePaginate = null;
  }

  // The CSS-column engine drives both modes: 1 column (single) or 2 columns (spread). It is used
  // for single column too because native column fragmentation never splits a line — unlike the
  // old translateY+clip-path paginator, which clipped lines on e-ink Android WebViews.
  // Continuous mode (this._continuous) swaps in ScrollPaginator instead — fixed-layout EPUB
  // (manga/art-book pages) doesn't offer continuous mode at all, same as it never offered
  // two-column: those pages are pixel-exact single units, not reflowable text or a comic strip.
  _makePaginator() {
    if (this._isFixedLayout) return new FixedPagePaginator(this._twoColumn);
    if (this._isCbz || this._isPdf) return this._continuous ? new ScrollPaginator() : new FixedPagePaginator(this._twoColumn);
    return this._continuous ? new ScrollPaginator() : new ColumnPaginator();
  }

  // init() options for the current layout mode. onScroll/onReachEnd are only consumed by
  // ScrollPaginator (harmless extra fields for the other paginators, which only destructure
  // columns/columnGap). EPUB-only (CBZ continuous wires its own opts directly in
  // _renderCbzContinuous, not through here): onScroll re-fires the relocate event on every
  // throttled scroll tick so the status bar/debounced remote sync stay live during free
  // scrolling, and also drives the two things that make chapter boundaries feel seamless —
  // _maybeAppendNextChapter (grows the live document BEFORE the user reaches the true end) and
  // _syncContinuousSpineIdx (keeps _spineIdx/_continuousFrac correct as the user scrolls past
  // an appended chapter's own start, for makeCfi/makePct/chapter-visit-logging purposes).
  // onReachEnd is now only ever the genuine "nothing left in the whole book to append" case —
  // see _maybeAppendNextChapter's own comment.
  _paginatorOpts() {
    const opts = { columns: this._twoColumn ? 2 : 1, columnGap: this._twoColumn ? this._columnGap : 0 };
    if (this._continuous) {
      opts.onScroll = () => {
        void this._maybeAppendNextChapter();
        this._syncContinuousSpineIdx();
        this._fireRelocated();
      };
      opts.onReachEnd = () => { void this.next(); };
    }
    return opts;
  }

  // Replace this._paginator with a fresh instance from _makePaginator(), destroying the old
  // one first — ScrollPaginator (unlike Column/FixedPage) holds a real scroll listener, so
  // every place that swaps paginators needs this instead of a bare assignment or it leaks.
  _replacePaginator() {
    this._paginator?.destroy?.();
    this._paginator = this._makePaginator();
  }

  // Init the paginator for the current layout. Use this everywhere instead of calling
  // this._paginator.init() directly.
  _initPaginator(iframe) {
    if (!iframe?.contentDocument?.body) return null;
    // Self-correcting, not just create-if-missing: a few call paths (setLayout's preset
    // fast-path in reader.js sets this._continuous directly rather than going through
    // setLayout(), specifically to avoid double-repaginating — see its own comment) can leave
    // this._paginator as the WRONG class for the current this._continuous. Checking here,
    // centrally, is more robust than trying to keep every caller's ordering perfectly in sync.
    const wantScroll = this._continuous && !this._isCbz && !this._isPdf && !this._isFixedLayout;
    if (!this._paginator || wantScroll !== (this._paginator instanceof ScrollPaginator)) {
      this._replacePaginator();
    }
    const res = this._paginator.init(iframe, this._paginatorOpts());
    this._scheduleFontReflow();
    return res;
  }

  // Page breaks are measured from line positions. If a web font is still swapping in (FOUT —
  // common on Android with custom fonts), the FIRST measurement uses fallback metrics; when the
  // real font arrives every line shifts and the breaks no longer match the render (a line gets
  // clipped with empty space below it). We must re-measure once the layout settles — exactly
  // what a manual resize does by hand.
  //
  // document.fonts.status / .ready are unreliable for this: the set reports 'loaded' (nothing
  // pending) at the very moment BEFORE a just-referenced face starts loading, and .ready can
  // resolve before the swap. So instead we re-check at a few intervals and re-paginate only when
  // the content height actually changed — robust to fonts, late images, any reflow, and cheap
  // (a no-op once the height is stable, so steady-state page turns pay nothing).
  _scheduleFontReflow() {
    const iframe = this._renderer?.iframe;
    const doc    = iframe?.contentDocument;
    if (!doc?.body) return;
    const token  = (this._reflowToken = (this._reflowToken || 0) + 1);
    // The column engine grows horizontally (scrollWidth) as content reflows, and the iframe
    // height can also change once status bars settle — track both as the "layout settled" signal.
    let baseW    = doc.body.scrollWidth;
    let baseH    = doc.body.scrollHeight;

    const remeasure = () => {
      if (token !== this._reflowToken || !this._paginator) return;
      const fr = this._renderer?.iframe;
      const d  = fr?.contentDocument;
      if (!fr || fr !== iframe || !d?.body) return;
      if (Math.abs(d.body.scrollWidth - baseW) < 1 &&
          Math.abs(d.body.scrollHeight - baseH) < 1) return;   // no layout shift — breaks stand
      baseW = d.body.scrollWidth;
      baseH = d.body.scrollHeight;
      const saved  = this._paginator.currentPage;
      const before = this._paginator.pageCount;
      this.onBeforePaginate?.(fr);
      // Re-measure with the SAME engine; do NOT route through _initPaginator (that would
      // re-schedule this reflow and could loop).
      this._paginator.init(fr, this._paginatorOpts());
      this._paginator.goToPage(Math.min(saved, this._paginator.pageCount));
      // Re-fire only if the total changed, so the status bar updates without churn.
      if (this._paginator.pageCount !== before) this._fireRelocated();
    };

    doc.fonts?.ready?.then(() => requestAnimationFrame(remeasure)).catch(() => {});
    setTimeout(remeasure, 200);
    setTimeout(remeasure, 500);
    setTimeout(remeasure, 1000);
  }

  // EPUB continuous mode: called on every throttled scroll tick (see _paginatorOpts). Once the
  // user is within one screen of the bottom of everything currently loaded, appends the next
  // chapter's content directly into the same live document (renderer.js's appendChapter) —
  // BEFORE they'd otherwise hit the true end and get bounced to a freshly-reset chapter. This
  // is what makes scrolling flow across a chapter boundary instead of jumping/resetting: by the
  // time the user actually scrolls that far, the next chapter's text is already sitting right
  // there to keep scrolling into.
  //
  // this._continuousAppending guards against a burst of scroll events triggering overlapping
  // appends while one is already in flight (each append is async — fetch + stylesheet/resource
  // rewriting). this._continuousLoadedUpTo tracks the highest spine index already appended,
  // reset to the current chapter alone on every FRESH render (renderChapter/goToSpineItem/the
  // next()/prev() chapter-boundary fallbacks — see each of their own this._continuousLoadedUpTo
  // assignments) so a TOC jump or search/bookmark restore correctly starts this over rather
  // than thinking stale, pre-jump chapters are still the "next" ones to append.
  // A LOOP, not a single append: a short chapter (a title/copyright/dedication page, well
  // under one viewport tall) leaves the document still "near the end" even after appending
  // it, so a run of several short chapters in a row all need pulling in before there's
  // actually enough scrollable content for isNearEnd to go false. Without looping, only the
  // FIRST short chapter in such a run would ever get appended automatically — every one after
  // it would only be reachable via the boundary-jump fallback (a hard cut, not a scroll) —
  // confirmed live. Also called proactively right after every fresh render (see each
  // this._continuousLoadedUpTo assignment elsewhere in this file), not only on scroll: a
  // chapter that doesn't scroll at all never fires a 'scroll' event in the first place, so
  // waiting for onScroll alone would never pre-fill it.
  async _maybeAppendNextChapter() {
    if (!this._continuous || this._isCbz || this._isPdf || this._isFixedLayout) return;
    if (this._continuousAppending) return;
    if (!(this._paginator instanceof ScrollPaginator)) return;
    const token = this._continuousRenderToken;
    this._continuousAppending = true;
    try {
      while (this._paginator.isNearEnd) {
        const nextIdx = this._continuousLoadedUpTo + 1;
        if (nextIdx >= (this._book?.spine.length || 0)) break; // true end of book
        const wrap = await this._renderer.appendChapter(this._book.spine[nextIdx], nextIdx, 'after');
        // A fresh render/jump superseded this one while we were awaiting — that one owns the
        // document now; appending into it further would be touching a document we no longer
        // recognize as current (possibly even the wrong chapter's iframe entirely).
        if (token !== this._continuousRenderToken) return;
        if (!wrap) break; // renderer's iframe went away mid-await (destroyed) — abandon
        this._continuousLoadedUpTo = nextIdx;
        this._paginator.remeasure(); // scrollHeight just grew — pageCount needs to reflect that
        log(`[CXReader] continuous: appended chapter ${nextIdx}`);
      }
    } finally {
      this._continuousAppending = false;
    }
  }

  // EPUB continuous mode: keeps _spineIdx/_continuousFrac correct as the user scrolls through
  // (possibly several appended) chapters in the live document — same idea as CBZ continuous's
  // _updateCbzContinuousPosition, just scanning appendChapter's .cx-continuous-chapter wrapper
  // elements (tagged data-spine-idx) instead of stacked images.
  _syncContinuousSpineIdx() {
    const doc = this._renderer?.iframe?.contentDocument;
    if (!doc?.body) return;
    const scrollEl  = doc.scrollingElement || doc.documentElement;
    const scrollTop = scrollEl.scrollTop || 0;
    const viewportH = this._paginator?.viewportHeight || scrollEl.clientHeight || 1;
    const wraps     = doc.querySelectorAll('.cx-continuous-chapter');
    // WHICH chapter counts as "current" switches once its boundary has scrolled up to the
    // MIDDLE of the viewport, not the instant it merely reaches the top edge — matching where
    // a reader's eyes actually are while reading, so "pages left" only rolls over to the next
    // chapter once the reader has genuinely reached its text, not the moment it first peeks
    // into view at the very bottom of the screen. Confirmed live this reads far better than a
    // plain top-edge crossing. (_continuousFrac/chapter-relative paging below still use the
    // real scrollTop, not this line — only the chapter-boundary decision uses it.)
    const switchLine = scrollTop + viewportH / 2;

    // The ORIGINAL chapter (from renderChapter/goToSpineItem, before any append) is never
    // itself wrapped in a .cx-continuous-chapter marker — only appendChapter's own chapters
    // are. Its extent is everything before the first appended wrapper (or the whole document,
    // if nothing has been appended yet).
    const firstWrapTop = wraps.length ? wraps[0].offsetTop : (scrollEl.scrollHeight || 1);
    if (switchLine < firstWrapTop) {
      // Still within the original chapter — _spineIdx is already correct (set by whichever
      // fresh-render call landed here); just keep _continuousFrac/chapter-relative paging live.
      this._continuousFrac = firstWrapTop > 0 ? Math.max(0, Math.min(1, scrollTop / firstWrapTop)) : 0;
      this._setContinuousChapterPaging(scrollTop, firstWrapTop, viewportH);
      return;
    }

    let current = wraps[0];
    for (const w of wraps) {
      if (w.offsetTop <= switchLine) current = w; else break;
    }
    const idx = parseInt(current.dataset.spineIdx, 10);
    if (Number.isNaN(idx)) return;
    this._spineIdx = idx;
    const h = current.offsetHeight || 1;
    const within = scrollTop - current.offsetTop; // real reading position, not the switch line
    this._continuousFrac = Math.max(0, Math.min(1, within / h));
    this._setContinuousChapterPaging(within, h, viewportH);
  }

  // Chapter-relative page/pageCount for the status bar's "page X of Y" / "pages left" slots —
  // see _fireRelocated, which uses these instead of the paginator's own pageCount/currentPage
  // for EPUB continuous mode. The paginator tracks the WHOLE scrollable span (however many
  // chapters have been appended so far), so without this, "pages left" would jump the instant
  // the next chapter gets appended — its extra length landing in pageCount immediately — long
  // before the user has actually scrolled anywhere near it. Confirmed live.
  _setContinuousChapterPaging(withinChapterScrollTop, chapterHeight, viewportH) {
    const pageCount = Math.max(1, Math.ceil((chapterHeight || 1) / viewportH));
    const page = Math.max(1, Math.min(pageCount, Math.floor(withinChapterScrollTop / viewportH) + 1));
    this._continuousChapterPage      = page;
    this._continuousChapterPageCount = pageCount;
  }

  // Switch column mode / gap / continuous-vs-paginated. Stores the setting and, if a chapter
  // is live, re-paginates at the current reading position (preserved by fraction so it
  // survives the engine swap either direction).
  setLayout({ twoColumn, columnGap, continuous } = {}) {
    if (typeof twoColumn === 'boolean') this._twoColumn = twoColumn;
    if (typeof columnGap === 'number')  this._columnGap = columnGap;
    const continuousChanged = typeof continuous === 'boolean' && continuous !== this._continuous;
    if (typeof continuous === 'boolean') this._continuous = continuous;

    if (this._isCbz && this._containerEl && this._paginator) {
      // In two-column mode, snap to the start of the nearest spread (even index). Harmless
      // no-op for continuous mode, which ignores _twoColumn entirely (see _renderCbzContinuous).
      if (this._twoColumn) this._spineIdx = Math.floor(this._spineIdx / 2) * 2;
      this._replacePaginator();
      if (this._continuous) this._renderCbzContinuous();
      else this._renderCbzItem(this._spineIdx);
      this._fireRelocated();
      return;
    }
    if (this._isPdf && this._containerEl && this._paginator) {
      if (this._twoColumn) this._spineIdx = Math.floor(this._spineIdx / 2) * 2;
      this._replacePaginator();
      if (this._continuous) this._renderPdfContinuous();
      else this._renderPdfItem(this._spineIdx);
      this._fireRelocated();
      return;
    }
    const iframe = this._renderer?.iframe;
    if (!iframe || !this._paginator) return;
    const prevCount = this._paginator.pageCount || 1;
    const frac = prevCount > 1 ? (this._paginator.currentPage - 1) / prevCount : 0;
    // Swapping paginator CLASS (ColumnPaginator <-> ScrollPaginator) needs a fresh instance —
    // a plain twoColumn/columnGap change reuses the existing one via _initPaginator below.
    if (continuousChanged) this._replacePaginator();
    this.onBeforePaginate?.(iframe);
    this._initPaginator(iframe);
    const target = Math.max(1, Math.floor(frac * this._paginator.pageCount) + 1);
    this._paginator.goToPage(target);
    this._fireRelocated();
  }

  async open(arrayBuffer, filenameHint) {
    log('[CXReader] open() parsing...');
    // Content-sniffed, not extension-based (same principle as the CBZ-vs-EPUB check below) —
    // check the first 5 bytes for the `%PDF-` magic number BEFORE attempting JSZip.loadAsync(),
    // which would otherwise just throw on a non-ZIP file.
    const head = new Uint8Array(arrayBuffer.slice(0, 5));
    this._isPdf = head.length === 5 && String.fromCharCode(...head) === '%PDF-';
    if (this._isPdf) {
      log('[CXReader] open() detected PDF');
      const { PdfParser } = await import('./pdf-parser.js');
      this._book = await new PdfParser().parse(arrayBuffer, filenameHint);
      this._renderer = null;
    } else {
      const zip = await JSZip.loadAsync(arrayBuffer);
      this._isCbz = !zip.file('META-INF/container.xml');
      if (this._isCbz) {
        log('[CXReader] open() detected CBZ');
        this._book = await new CbzParser().parse(zip);
        this._renderer = null;
      } else {
        this._book = await this._parser.parse(arrayBuffer);
        this._isFixedLayout = !!this._book.isFixedLayout;
        this._renderer = new ChapterRenderer(this._book.manifest);
      }
    }
    // Deliberately NOT creating this._paginator here: reader.js calls setLayout({continuous})
    // right after open() but before the first renderChapter() to decide single/two-column/
    // continuous BEFORE the first render — creating a paginator now, before that call, would
    // pick the wrong class (continuous defaults to false until setLayout says otherwise) and
    // nothing between here and the first real render needs one yet. _initPaginator() and
    // _renderCbzContinuous()/_renderCbzItem's own _replacePaginator() calls create the right
    // one lazily, once _continuous is actually known.

    // Precompute cumulative weights for content-proportional percentage calculation.
    const raw = this._book.spineWeights || [];
    this._weights     = raw.length === this._book.spine.length ? raw : [];
    this._totalWeight = this._weights.reduce((s, w) => s + w, 0) || 0;
    this._cumWts      = [];
    let cum = 0;
    for (const w of this._weights) { this._cumWts.push(cum); cum += w; }

    log('[CXReader] open() done:', this._book.metadata.title);
    return this._book;
  }

  // Render a spine item by index; containerEl and readerCss are stored for transitions.
  async renderChapter(spineIdx, containerEl, readerCss) {
    if (!this._book) throw new Error('[CXReader] call open() first');
    this._containerEl = containerEl;
    this._readerCss   = readerCss;
    this._spineIdx    = Math.max(0, Math.min(spineIdx, this._book.spine.length - 1));
    const spineItem   = this._book.spine[this._spineIdx];
    log(`[CXReader] renderChapter ${this._spineIdx}: ${spineItem.href}`);

    if (this._isCbz) {
      // First-ever render for this book: this._paginator hasn't been created yet (see the
      // comment in open()) — _renderCbzContinuous() creates the right one itself when needed
      // (defensive against paginator-type mismatches from any call ordering), but the plain
      // FixedPagePaginator case needs it explicitly here.
      if (this._continuous) this._renderCbzContinuous();
      else { this._renderCbzItem(this._spineIdx); this._replacePaginator(); }
      this._fireRelocated();
      return null;
    }
    if (this._isPdf) {
      if (this._continuous) this._renderPdfContinuous();
      else { this._renderPdfItem(this._spineIdx); this._replacePaginator(); }
      this._fireRelocated();
      return null;
    }

    const iframe = await this._renderer.render(spineItem, containerEl, readerCss, this._fixedLayoutOpts());
    this.onBeforePaginate?.(iframe);
    this._initPaginator(iframe);
    this._continuousLoadedUpTo = this._spineIdx; // fresh document — nothing appended yet
    this._continuousRenderToken++;
    if (this._continuous) {
      this._syncContinuousSpineIdx(); // seed chapter-relative paging before the first fire
      void this._maybeAppendNextChapter(); // pre-fill if this chapter alone doesn't fill the screen
    }
    this._fireRelocated();
    return iframe;
  }

  // Navigate to a specific spine item, optionally at a given page (1-based).
  async goToSpineItem(spineIdx, page = 1) {
    if (!this._book || !this._containerEl) return;
    const idx = Math.max(0, Math.min(spineIdx, this._book.spine.length - 1));
    this._spineIdx = idx;
    log(`[CXReader] goToSpineItem ${idx}`);

    if (this._isCbz) {
      if (this._continuous) {
        // The whole book is already one continuous scroll — no re-render needed, just
        // scroll the already-rendered stack to this page's image (built fresh only if this
        // is the very first render, e.g. book-open landing partway through).
        // _scrollCbzContinuousToIndex fires its own _fireRelocated() once the (possibly
        // async, if images need decoding first) scroll actually lands — awaited here so
        // this method's own caller sees the real final position, not a stale one.
        if (!this._cbzContinuousWrap) this._renderCbzContinuous();
        else await this._scrollCbzContinuousToIndex(idx);
      } else {
        this._renderCbzItem(idx);
        this._replacePaginator();
        this._fireRelocated();
      }
      return;
    }

    if (this._isPdf) {
      if (this._continuous) {
        if (!this._pdfContinuousWrap) this._renderPdfContinuous();
        else await this._scrollPdfContinuousToIndex(idx);
      } else {
        this._renderPdfItem(idx);
        this._replacePaginator();
        this._fireRelocated();
      }
      return;
    }

    const iframe = await this._renderer.render(
      this._book.spine[idx], this._containerEl, this._readerCss, this._fixedLayoutOpts()
    );
    this.onBeforePaginate?.(iframe);
    this._initPaginator(iframe);
    this._continuousLoadedUpTo = idx; // fresh document — nothing appended yet
    this._continuousRenderToken++;
    if (page > 1) this._paginator.goToPage(page);
    if (this._continuous) {
      this._syncContinuousSpineIdx(); // seed chapter-relative paging before the first fire
      void this._maybeAppendNextChapter(); // pre-fill if this chapter alone doesn't fill the screen
    }
    this._fireRelocated();
  }

  // Navigate to chapter containing href (path with optional #fragment — fragment ignored).
  async goToHref(href, page = 1) {
    if (!this._book || !this._containerEl) return;
    const idx = this._spineIndexForHref((href || '').split('#')[0]);
    if (idx >= 0) await this.goToSpineItem(idx, page);
  }

  // Navigate to spine item identified by an epubcfi string (spine component only).
  // `page` (1-based, within the target chapter) is optional — makeCfi() itself only ever
  // encodes the chapter, not a page, so callers that captured a real in-chapter position
  // separately (see currentChapPage in reader.js) should pass it through here rather than
  // silently landing on page 1 of the chapter.
  async goToCfi(cfi, page = 1) {
    if (!this._book || !this._containerEl) return;
    const m = String(cfi).match(/^epubcfi\(\/6\/(\d+)!/);
    if (m) {
      const idx = Math.max(0, Math.floor(parseInt(m[1], 10) / 2) - 1);
      await this.goToSpineItem(idx, page);
      return;
    }
    // Treat as href fallback (e.g. chapter.xhtml)
    if (cfi && !cfi.startsWith('epubcfi(')) await this.goToHref(cfi, page);
  }

  // Percentage → spine item using content-proportional weights (falls back to uniform).
  async goToPct(pct) {
    if (!this._book || !this._containerEl) return;
    const total = this._book.spine.length;
    let idx = Math.min(total - 1, Math.max(0, Math.floor(pct * total)));
    if (this._totalWeight > 0) {
      const target = pct * this._totalWeight;
      for (let i = 0; i < total; i++) {
        if ((this._cumWts[i] ?? 0) + (this._weights[i] ?? 1) > target) { idx = i; break; }
      }
    }
    await this.goToSpineItem(idx);
  }

  // Generate a minimal spine-level CFI compatible with epub.js format.
  makeCfi() {
    const n = (this._spineIdx + 1) * 2;
    return `epubcfi(/6/${n}!/4/2/1:0)`;
  }

  // Book percentage: content-proportional using spine file sizes (falls back to uniform).
  // Continuous mode is the one case where _spineIdx isn't the paginator's own notion of
  // position — the paginator tracks the WHOLE scrollable span as one unit (one CBZ's worth of
  // stacked images, or however many EPUB chapters have been appended so far), not just the
  // current spine item — see _updateCbzContinuousPosition / _syncContinuousSpineIdx, which
  // keep _spineIdx/_continuousFrac live as the user scrolls, so this stays on the same
  // spine-weighted formula every other mode already uses.
  makePct() {
    const total = this._book?.spine.length || 1;
    let fracWithin;
    if (this._continuous) {
      fracWithin = this._continuousFrac || 0;
    } else {
      const pageCount = this._paginator?.pageCount || 1;
      const page      = this._paginator?.currentPage || 1;
      fracWithin = pageCount > 1 ? (page - 1) / pageCount : 0;
    }
    if (this._totalWeight > 0) {
      const before = this._cumWts[this._spineIdx] ?? 0;
      const wt     = this._weights[this._spineIdx] ?? 1;
      return (before + wt * fracWithin) / this._totalWeight;
    }
    return (this._spineIdx + fracWithin) / total;
  }

  // Chapter-level book percentage for a spine-level CFI (epubcfi(/6/N!...)).
  // Used to place externally-synced annotations (which carry no percentage) in
  // the annotation list. Returns null when the CFI can't be parsed.
  pctForCfi(cfi) {
    const m = /epubcfi\(\/6\/(\d+)/.exec(String(cfi || ''));
    if (!m || !this._book) return null;
    const total = this._book.spine.length || 1;
    const idx = Math.max(0, Math.min(total - 1, Math.floor(parseInt(m[1], 10) / 2) - 1));
    if (this._totalWeight > 0) return (this._cumWts[idx] ?? 0) / this._totalWeight;
    return idx / total;
  }

  async next() {
    if (!this._paginator || !this._book) return;
    if (this._isCbz) {
      if (this._continuous) {
        // No "next chapter" concept — the whole book is already one continuous scroll, so
        // this is just "jump forward one screen" (see ScrollPaginator.next()); at the very
        // end it correctly no-ops instead of trying to advance past the last image.
        if (this._paginator.next()) this._fireRelocated();
        return;
      }
      if (this._spineIdx >= this._book.spine.length - 1) return;
      const step = this._twoColumn ? 2 : 1;
      this._spineIdx = Math.min(this._spineIdx + step, this._book.spine.length - 1);
      this._renderCbzItem(this._spineIdx);
      this._replacePaginator();
      this._fireRelocated();
      return;
    }
    if (this._isPdf) {
      if (this._continuous) {
        if (this._paginator.next()) this._fireRelocated();
        return;
      }
      if (this._spineIdx >= this._book.spine.length - 1) return;
      const step = this._twoColumn ? 2 : 1;
      this._spineIdx = Math.min(this._spineIdx + step, this._book.spine.length - 1);
      this._renderPdfItem(this._spineIdx);
      this._replacePaginator();
      this._fireRelocated();
      return;
    }
    if (this._paginator.next()) { this._fireRelocated(); return; }
    // At last page — advance to next chapter
    if (this._spineIdx + 1 < this._book.spine.length) {
      this._spineIdx++;
      log(`[CXReader] chapter → ${this._spineIdx}`);
      const iframe = await this._renderer.render(
        this._book.spine[this._spineIdx], this._containerEl, this._readerCss, this._fixedLayoutOpts()
      );
      this.onBeforePaginate?.(iframe);
      this._initPaginator(iframe);
      this._continuousLoadedUpTo = this._spineIdx; // fresh document — nothing appended yet
      this._continuousRenderToken++;
      if (this._continuous) {
        this._syncContinuousSpineIdx(); // seed chapter-relative paging before the first fire
        void this._maybeAppendNextChapter(); // pre-fill if this chapter alone doesn't fill the screen
      }
      this._fireRelocated();
    }
  }

  async prev() {
    if (!this._paginator || !this._book) return;
    if (this._isCbz) {
      if (this._continuous) {
        if (this._paginator.prev()) this._fireRelocated();
        return;
      }
      if (this._spineIdx <= 0) return;
      const step = this._twoColumn ? 2 : 1;
      this._spineIdx = Math.max(0, this._spineIdx - step);
      this._renderCbzItem(this._spineIdx);
      this._replacePaginator();
      this._fireRelocated();
      return;
    }
    if (this._isPdf) {
      if (this._continuous) {
        if (this._paginator.prev()) this._fireRelocated();
        return;
      }
      if (this._spineIdx <= 0) return;
      const step = this._twoColumn ? 2 : 1;
      this._spineIdx = Math.max(0, this._spineIdx - step);
      this._renderPdfItem(this._spineIdx);
      this._replacePaginator();
      this._fireRelocated();
      return;
    }
    if (this._paginator.prev()) { this._fireRelocated(); return; }
    // At first page — go to previous chapter's last page
    if (this._spineIdx > 0) {
      this._spineIdx--;
      log(`[CXReader] chapter ← ${this._spineIdx}`);
      const iframe = await this._renderer.render(
        this._book.spine[this._spineIdx], this._containerEl, this._readerCss, this._fixedLayoutOpts()
      );
      this.onBeforePaginate?.(iframe);
      this._initPaginator(iframe);
      this._continuousLoadedUpTo = this._spineIdx; // fresh document — nothing appended yet
      this._continuousRenderToken++;
      this._paginator.goToLastPage();
      if (this._continuous) {
        this._syncContinuousSpineIdx(); // seed chapter-relative paging before the first fire
        // Landed at this chapter's END (goToLastPage above) — pre-fill forward from here too,
        // same as any other fresh render, so scrolling back down stays seamless rather than
        // needing another round of on-scroll appends to recreate what prev() just left behind.
        void this._maybeAppendNextChapter();
      }
      this._fireRelocated();
    }
  }

  // Update reader CSS in-place and re-measure pagination (handles font/theme changes).
  // @font-face declarations (in cx-reader-fonts) are only updated when they change — keeping
  // them stable avoids FOUT each time the user toggles a setting like text alignment.
  reapplyCss(newCss) {
    if (this._isFixedLayout) return;
    const iframe = this._renderer?.iframe;
    if (!iframe?.contentDocument) return;
    const doc = iframe.contentDocument;

    const CX_FONTS_MARKER = '/* cx-fonts-end */';
    const markerIdx = newCss.indexOf(CX_FONTS_MARKER);
    const fontsSection = markerIdx >= 0 ? newCss.slice(0, markerIdx) : '';
    const prefsSection = markerIdx >= 0 ? newCss.slice(markerIdx + CX_FONTS_MARKER.length) : newCss;

    const fontsEl = doc.getElementById('cx-reader-fonts');
    if (fontsEl && fontsSection !== undefined && fontsEl.textContent !== fontsSection) {
      fontsEl.textContent = fontsSection;
    }
    const el = doc.getElementById('cx-reader-css');
    if (el) el.textContent = prefsSection;
    this._readerCss = newCss;
    this.onBeforePaginate?.(iframe);
    const savedPage = this._paginator?.currentPage || 1;
    this._initPaginator(iframe);
    this._paginator?.goToPage(savedPage);
    this._fireRelocated();
  }

  // Cancel any settle-timers still pending from _scheduleFontReflow() (see there). Those
  // timers compare the current layout size against a snapshot taken right after the chapter's
  // initial pagination — but scrollToRange/scrollToAnnotation/seekToPercent/seekToPage all
  // reposition WITHIN an already-rendered chapter, often followed by a DOM mutation (e.g.
  // search-result highlight marks) that nudges scrollWidth/scrollHeight just enough for every
  // remaining timer to think a real layout shift happened. Each one then redoes onBeforePaginate
  // (a full-chapter <p> scan, plus a full bionic-reading re-wrap if that pref is on) and a full
  // paginator re-measure — up to 4 times over the following second, entirely on the main thread.
  // On a real device that's long enough for touch input to be dropped outright, so once we've
  // deliberately repositioned, the stale checks are cancelled rather than left to keep firing.
  _cancelPendingReflow() {
    this._reflowToken = (this._reflowToken || 0) + 1;
  }

  // Navigate to the page containing the annotation <mark> with the given id.
  // Call AFTER goToCfi() so the chapter and its marks are already rendered.
  scrollToAnnotation(annotId) {
    const iframe = this._renderer?.iframe;
    if (!iframe?.contentDocument || !this._paginator) return;
    const sel  = `mark[data-annot-id="${CSS.escape(String(annotId))}"]`;
    const mark = iframe.contentDocument.querySelector(sel);
    if (!mark) return;
    this._cancelPendingReflow();
    // Page/spread 0 has no transform, so the mark's client rect is in natural body coords.
    this._paginator.goToElement(mark);
    this._fireRelocated();
  }

  // Navigate to the page containing range (character-exact, for search results).
  // Call AFTER goToSpineItem() so the chapter is rendered and the paginator is at spread 0.
  scrollToRange(range) {
    if (!range || !this._paginator) return;
    this._cancelPendingReflow();
    this._paginator.goToRange(range);
    this._fireRelocated();
  }

  // Seek to the page within the CURRENT chapter that best matches pct (0..1).
  // Used at open-time to restore within-chapter position from the saved percentage, since
  // CXReader CFIs are chapter-level only and cannot encode a page number.
  seekToPercent(pct) {
    if (!this._book || !this._paginator) return;
    const total     = this._book.spine.length;
    const pageCount = this._paginator.pageCount;
    if (total <= 0 || pageCount <= 1) return;
    let page0;
    if (this._totalWeight > 0) {
      const before = this._cumWts[this._spineIdx] ?? 0;
      const wt     = (this._weights[this._spineIdx] ?? 1) || 1;
      page0 = ((pct * this._totalWeight - before) / wt) * pageCount;
    } else {
      page0 = (pct * total - this._spineIdx) * pageCount;
    }
    const target = Math.max(1, Math.min(pageCount, Math.round(page0) + 1));
    if (target === this._paginator.currentPage) return;
    this._cancelPendingReflow();
    this._paginator.goToPage(target);
    this._fireRelocated();
  }

  // Jump directly to a specific page within the current chapter.
  // Used to restore an exact saved page (more precise than seekToPercent when pageCount matches).
  seekToPage(n) {
    if (!this._paginator) return;
    this._cancelPendingReflow();
    this._paginator.goToPage(n);
    this._fireRelocated();
  }

  // Re-init paginator at the current page without firing cx-relocated.
  // Used when the viewport inset changes after the first render (status bars measured).
  reinitPaginator() {
    const iframe = this._renderer?.iframe;
    if (!iframe || !this._paginator) return;
    const savedPage = this._paginator.currentPage;
    this.onBeforePaginate?.(iframe);
    this._initPaginator(iframe);
    this._paginator.goToPage(Math.min(savedPage, this._paginator.pageCount));
  }

  get book()      { return this._book; }
  get metadata()  { return this._book?.metadata ?? null; }
  get spine()     { return this._book?.spine ?? []; }
  get toc()       { return this._book?.toc ?? []; }
  // Per-spine-item content weight (uncompressed file size as a text-length proxy), already
  // computed at open() for the content-proportional percentage calculation — exposed so callers
  // can estimate an unvisited chapter's page count proportionally instead of guessing flat.
  get spineWeights() { return this._weights ?? []; }
  get spineIdx()  { return this._spineIdx; }
  get page()      { return this._paginator?.currentPage ?? 1; }
  get pageCount() { return this._paginator?.pageCount ?? 1; }
  // Right-hand page of the current spread; 0 when the last spread has only a left column.
  get endPage()   { return this._paginator?.endPage ?? this._paginator?.currentPage ?? 1; }
  get isTwoColumn() { return this._paginator?.isTwoColumn ?? false; }
  get iframe()    { return this._renderer?.iframe ?? null; }

  destroy() {
    this._renderer?.destroy();
    this._parser.revokeBlobUrls();
    if (this._isCbz && this._book?._blobUrls) {
      for (const url of this._book._blobUrls.values()) URL.revokeObjectURL(url);
      this._book._blobUrls.clear();
    }
    if (this._isPdf && this._book?._pdfDoc) {
      // Releases the whole document's worth of parsed/cached page data (fonts, decoded
      // streams) — matters far more here than for CBZ's blob URLs, since a PDF document keeps
      // real memory alive internally, not just revocable object URLs.
      try { this._book._pdfDoc.destroy(); } catch { /* ignore */ }
      this._book._pageCache?.clear();
    }
    this._paginator?.destroy?.(); // ScrollPaginator holds a real scroll listener — release it
    this._paginator = null;
    this._cbzContinuousWrap = null;
    this._cbzContinuousImgs = [];
    this._pdfContinuousWrap = null;
    this._pdfContinuousPages = [];
    // Invalidate any _renderCbzItem/_scrollCbzContinuousToIndex still mid-decode so their
    // deferred DOM swap/scroll becomes a no-op instead of touching a container this instance
    // no longer owns.
    this._cbzRenderToken++;
    this._cbzScrollToken++;
    this._pdfRenderToken++;
    this._pdfScrollToken++;
    this._pdfWindowToken++;
    this._continuousRenderToken++; // stop any in-flight _maybeAppendNextChapter loop too
    log('[CXReader] destroy()');
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _fixedLayoutOpts() {
    if (!this._isFixedLayout) return null;
    return { pageWidth: this._book.pageWidth || 0, pageHeight: this._book.pageHeight || 0 };
  }

  // Full-bleed immersive rendering — status bars overlay on top of the image (see
  // reader.js's comic-mode wiring + comic-viewer.js) rather than reserving space for
  // themselves, so the wrap always fills the entire container. Background is a plain
  // CSS rule (`.cx-cbz-wrap` in reader.css, unconditional black) rather than inline
  // style — letterboxing should read as "cinema black," not the reading theme's page
  // colour. comic-viewer.js looks this element up live (by class, not a cached
  // reference) on every gesture, since it's fully replaced on every page turn.
  //
  // The new wrap is built and its image(s) decoded OFF-DOM first, and only swapped into
  // _containerEl once decode() resolves — NOT built straight into the (cleared) container the
  // way this used to work. Clearing the container up front left a real gap, however brief,
  // with no image painted at all (just the black background peeking through) between the old
  // page disappearing and the new one finishing its (still-async, even for an
  // already-downloaded blob URL) decode — visible as a black flash on every page turn,
  // confirmed live on both desktop and mobile. Keeping the OLD wrap on screen right up until
  // the new one is actually ready to paint removes that gap entirely, regardless of how long
  // decoding takes.
  _renderCbzItem(idx) {
    const token = ++this._cbzRenderToken;
    const wrap = document.createElement('div');
    const showTwo = this._twoColumn && idx + 1 < this._book.spine.length;
    wrap.className = showTwo ? 'cx-cbz-wrap two-page' : 'cx-cbz-wrap';

    const imgs = [];
    const addImg = (i) => {
      const img = document.createElement('img');
      img.src = this._book.spine[i].blobUrl;
      img.className = 'cx-cbz-img';
      // Belt-and-suspenders against the browser's native image drag-and-drop hijacking
      // comic-viewer.js's click-drag-to-pan (see the -webkit-user-drag rule in reader.css,
      // which alone isn't enough on Firefox — this HTML attribute is what it actually
      // honours).
      img.draggable = false;
      wrap.appendChild(img);
      imgs.push(img);
    };
    addImg(idx);
    if (showTwo) addImg(idx + 1);

    Promise.all(imgs.map(_cxImageReady)).then(() => {
      // A newer render started (fast swipes/taps) before this one finished decoding —
      // drop it; the newer one owns the container now.
      if (token !== this._cbzRenderToken) return;
      this._containerEl.innerHTML = '';
      this._containerEl.appendChild(wrap);
    });
  }

  // Continuous mode: every spine page stacked vertically with no gap, full container width
  // (the standard "webtoon" convention — the only choice that avoids side letterbox bars
  // between images that "no gaps" implies avoiding), scrolled natively. Unlike _renderCbzItem
  // this renders the WHOLE book in one pass rather than per-page — CbzParser has already
  // preloaded every page as a blob URL regardless of mode, so there's no extra loading cost,
  // only decode cost, which `loading="lazy"`/`decoding="async"` defer to the browser rather
  // than hand-rolling a windowed/virtualized scroller (a reasonable v1 simplification; worth
  // revisiting only if a very large comic proves slow to scroll in practice).
  _renderCbzContinuous() {
    // Defensive: make sure _paginator is really a ScrollPaginator before using it — the class
    // is decided by this._continuous, which can be set (via setLayout, see its own comment)
    // at a point where no paginator has been created yet, or where an existing one is stale
    // from before continuous mode was turned on.
    if (!(this._paginator instanceof ScrollPaginator)) this._replacePaginator();

    this._containerEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cx-cbz-continuous-wrap';
    const imgs = [];
    this._book.spine.forEach((item, i) => {
      const img = document.createElement('img');
      img.src = item.blobUrl;
      img.className = 'cx-cbz-img cx-cbz-continuous-img';
      img.draggable = false;
      img.loading   = i < 2 ? 'eager' : 'lazy';
      img.decoding  = 'async';
      wrap.appendChild(img);
      imgs.push(img);
    });
    this._containerEl.appendChild(wrap);
    this._cbzContinuousWrap = wrap;
    this._cbzContinuousImgs = imgs;

    this._paginator.init(this._containerEl, {
      onScroll: () => { this._updateCbzContinuousPosition(); this._fireRelocated(); },
      // No onReachEnd here — unlike EPUB's per-chapter iframe, the WHOLE book is already one
      // continuous scroll, so there's no "next chapter" to auto-advance into.
    });
    void this._scrollCbzContinuousToIndex(this._spineIdx);
  }

  // Scrolls the already-rendered continuous stack so page `idx` sits at the top of the
  // viewport — used both for the initial landing position (including resuming deep into a
  // book, e.g. reopening at 80%) and for goToSpineItem (TOC-less for CBZ today, but kept
  // correct for consistency / future use) jumping within an already-open continuous book
  // instead of re-rendering.
  //
  // Async and awaits every image up to `idx` being actually decoded first: offsetTop is only
  // meaningful once an image has real intrinsic dimensions, and images beyond the first couple
  // start as loading="lazy" (deferred decode/layout) for scroll performance on very large
  // comics — landing straight on a deep page would otherwise measure against still-collapsed
  // (~0-height) images before it and land far too short. Forcing loading='eager' here (rather
  // than relying on decode() to implicitly un-defer a lazy image, whose interaction is less
  // predictable across engines) makes this correct regardless of browser quirks.
  async _scrollCbzContinuousToIndex(idx) {
    const imgs = this._cbzContinuousImgs;
    if (!imgs?.[idx] || !this._containerEl) return;
    const token = ++this._cbzScrollToken;
    for (let i = 0; i <= idx; i++) imgs[i].loading = 'eager';
    await Promise.all(imgs.slice(0, idx + 1).map(_cxImageReady));
    // Superseded while awaiting — either a full re-render (imgs array replaced) or a newer
    // jump request for a different index (fast navigation). Either way, that one owns the
    // final scroll position now, not this stale call.
    if (token !== this._cbzScrollToken || this._cbzContinuousImgs !== imgs) return;
    this._containerEl.scrollTop = imgs[idx].offsetTop;
    this._spineIdx = idx;
    this._continuousFrac = 0;
    this._updateCbzContinuousPosition();
    this._fireRelocated();
  }

  // Keeps _spineIdx/_continuousFrac live as the user scrolls — the one thing continuous
  // CBZ needs beyond what ScrollPaginator already tracks generically, since the paginator
  // treats the whole stacked scroll as one unit while _spineIdx (feeding makeCfi/makePct/
  // chapter-visit logging) needs to know WHICH image is currently topmost. A plain linear
  // scan is fine here: at most a few hundred cheap offsetTop reads, already rAF-throttled by
  // ScrollPaginator's own onScroll call.
  _updateCbzContinuousPosition() {
    const imgs = this._cbzContinuousImgs;
    if (!imgs?.length || !this._containerEl) return;
    const scrollTop = this._containerEl.scrollTop;
    let idx = 0;
    for (let i = 0; i < imgs.length; i++) {
      if (imgs[i].offsetTop <= scrollTop + 1) idx = i; else break;
    }
    this._spineIdx = idx;
    const h = imgs[idx].offsetHeight || 1;
    this._continuousFrac = Math.max(0, Math.min(1, (scrollTop - imgs[idx].offsetTop) / h));
  }

  // ── PDF rendering ────────────────────────────────────────────────────────────
  // Everything below mirrors the CBZ methods above (same structure, same class names on the
  // DOM it builds — comic-viewer.js's zoom/pan and its CSS need zero changes as a result) except
  // for the one genuinely new piece, windowed continuous rendering — see PDF_WINDOW_RADIUS.

  // pdf.js PDFPageProxy for a 1-based page number, cached on the book object (see pdf-parser.js)
  // since both paginated and continuous rendering (plus continuous's placeholder-sizing pass)
  // can all want the same page repeatedly.
  async _getPdfPage(pageNum) {
    const cache = this._book._pageCache;
    if (cache.has(pageNum)) return cache.get(pageNum);
    const page = await this._book._pdfDoc.getPage(pageNum);
    cache.set(pageNum, page);
    return page;
  }

  // Renders one page to a freshly-created <canvas>, at a resolution derived from the current
  // container width × devicePixelRatio (capped at PDF_MAX_CANVAS_W). Zoom beyond that is a CSS
  // transform on the already-rendered canvas — comic-viewer.js's zoom, unchanged — so some
  // softness at extreme zoom is an accepted, CBZ-consistent trade-off, not a regression.
  async _renderPdfCanvas(pageNum, targetWidthPx) {
    const page = await this._getPdfPage(pageNum);
    const vp1  = page.getViewport({ scale: 1 });
    const dpr  = window.devicePixelRatio || 1;
    const wantW = (targetWidthPx || this._containerEl?.clientWidth || window.innerWidth || 1000) * dpr;
    const scale = Math.min(wantW, PDF_MAX_CANVAS_W) / vp1.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.draggable = false; // matches _renderCbzItem's img.draggable=false — see its own comment
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }

  // Paginated PDF — mirrors _renderCbzItem exactly: build the new page(s) off-DOM, only swap
  // into _containerEl once actually ready to paint, so a page turn never shows a black gap.
  // Unlike CBZ (an already-decoded blob URL, cheap), a PDF page is a real async render — the
  // token guard matters more here, since a fast swipe can genuinely leave a slow prior render
  // still in flight when a newer one starts.
  _renderPdfItem(idx) {
    const token = ++this._pdfRenderToken;
    const showTwo = this._twoColumn && idx + 1 < this._book.spine.length;
    const wrap = document.createElement('div');
    wrap.className = showTwo ? 'cx-cbz-wrap two-page' : 'cx-cbz-wrap';

    const pageNums = [this._book.spine[idx].pageNum];
    if (showTwo) pageNums.push(this._book.spine[idx + 1].pageNum);

    Promise.all(pageNums.map(pn => this._renderPdfCanvas(pn))).then(canvases => {
      // A newer render started (fast swipes/taps) before this one finished — drop it; the
      // newer one owns the container now.
      if (token !== this._pdfRenderToken) return;
      for (const c of canvases) { c.className = 'cx-cbz-img'; wrap.appendChild(c); }
      this._containerEl.innerHTML = '';
      this._containerEl.appendChild(wrap);
    }).catch(err => {
      if (token !== this._pdfRenderToken) return;
      console.error('[CXReader] PDF page render failed:', err);
    });
  }

  // Continuous mode: every page stacked vertically, same "webtoon" convention as
  // _renderCbzContinuous — but rendering every page's canvas up front (as CBZ does with its
  // already-cheap pre-decoded images) would be real, unbounded CPU/memory cost for a PDF. So
  // this only builds correctly-sized PLACEHOLDERS up front (from a cheap page.getViewport({
  // scale:1}) call — dimensions only, no pixels rendered) so total scroll height is accurate
  // immediately; _updatePdfWindow() below fills in real canvases near the current scroll
  // position and releases ones that scroll away.
  async _renderPdfContinuous() {
    // Fire-and-forget from every call site (mirrors _renderCbzContinuous, called the same way)
    // — genuinely async here (unlike CBZ's sync version) because of the placeholder-sizing
    // pass below, so a caught, logged failure (corrupt/encrypted PDF) beats an unhandled
    // rejection.
    try {
      if (!(this._paginator instanceof ScrollPaginator)) this._replacePaginator();

      this._containerEl.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'cx-cbz-continuous-wrap';
      const token = ++this._pdfWindowToken;

      const pdfPages = await Promise.all(this._book.spine.map(item => this._getPdfPage(item.pageNum)));
      if (token !== this._pdfWindowToken) return; // superseded (re-render/destroy) mid-await

      const pages = pdfPages.map(page => {
        const vp1 = page.getViewport({ scale: 1 });
        const slot = document.createElement('div');
        // cx-cbz-img gives it the continuous wrap's width:100%/height:auto rule; aspect-ratio
        // (not the canvas's own intrinsic size, since there's no canvas here yet) is what makes
        // height:auto resolve to the right value before anything has actually been rendered.
        slot.className = 'cx-cbz-img cx-pdf-slot';
        slot.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
        wrap.appendChild(slot);
        return { el: slot, rendered: false };
      });
      this._containerEl.appendChild(wrap);
      this._pdfContinuousWrap = wrap;
      this._pdfContinuousPages = pages;

      this._paginator.init(this._containerEl, {
        onScroll: () => {
          this._updatePdfContinuousPosition();
          void this._updatePdfWindow();
          this._fireRelocated();
        },
        // No onReachEnd — same reasoning as CBZ continuous: the whole document is already one
        // continuous scroll, there's no "next chapter" to auto-advance into.
      });
      await this._scrollPdfContinuousToIndex(this._spineIdx);
    } catch (err) {
      console.error('[CXReader] PDF continuous render failed:', err);
    }
  }

  // Scrolls the already-rendered continuous stack so page `idx` sits at the top of the
  // viewport. Unlike CBZ (where offsetTop is only meaningful once a real image has decoded —
  // see _scrollCbzContinuousToIndex's own comment), the placeholder <div>s here are already
  // correctly sized from their own scale-1 viewport aspect-ratio, so no decode wait is needed
  // before scrolling.
  async _scrollPdfContinuousToIndex(idx) {
    const pages = this._pdfContinuousPages;
    if (!pages?.[idx] || !this._containerEl) return;
    this._containerEl.scrollTop = pages[idx].el.offsetTop;
    this._spineIdx = idx;
    this._continuousFrac = 0;
    this._updatePdfContinuousPosition();
    void this._updatePdfWindow();
    this._fireRelocated();
  }

  // Keeps _spineIdx/_continuousFrac live as the user scrolls — same role as
  // _updateCbzContinuousPosition, just scanning the placeholder <div>s instead of stacked
  // images (their offsetTop/offsetHeight are correct regardless of whether that slot's canvas
  // has actually been rendered yet, since sizing comes from the aspect-ratio CSS, not content).
  _updatePdfContinuousPosition() {
    const pages = this._pdfContinuousPages;
    if (!pages?.length || !this._containerEl) return;
    const scrollTop = this._containerEl.scrollTop;
    let idx = 0;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].el.offsetTop <= scrollTop + 1) idx = i; else break;
    }
    this._spineIdx = idx;
    const h = pages[idx].el.offsetHeight || 1;
    this._continuousFrac = Math.max(0, Math.min(1, (scrollTop - pages[idx].el.offsetTop) / h));
  }

  // The one meaningfully new subsystem in the whole PDF feature (see the PDF-support plan):
  // renders real canvases for pages within PDF_WINDOW_RADIUS of the current page and releases
  // (clears, back to an empty placeholder) canvases for pages that have scrolled further away
  // than that — keeps memory bounded no matter how long the document is. Driven off the same
  // onScroll hook that updates position (_renderPdfContinuous's onScroll above), plus called
  // proactively right after every fresh render/jump lands, same as _maybeAppendNextChapter's own
  // "also called proactively, not only on scroll" reasoning.
  async _updatePdfWindow() {
    const pages = this._pdfContinuousPages;
    if (!pages?.length) return;
    const token = ++this._pdfWindowToken;
    const center = this._spineIdx;
    const lo = Math.max(0, center - PDF_WINDOW_RADIUS);
    const hi = Math.min(pages.length - 1, center + PDF_WINDOW_RADIUS);

    // Release pages that scrolled out of the window — keeps the placeholder <div> (same
    // aspect-ratio, same scroll position) so nothing jumps, just drops its rendered canvas.
    pages.forEach((p, i) => {
      if ((i < lo || i > hi) && p.rendered) {
        p.el.innerHTML = '';
        p.rendered = false;
      }
    });

    // Render pages newly inside the window, nearest-to-center first (so a fast scroll settles
    // visually from the middle out), sequentially (not Promise.all) to bound peak CPU — this
    // targets the same lower-power e-ink devices the rest of this app is built for.
    const toRender = [];
    for (let i = lo; i <= hi; i++) if (!pages[i].rendered) toRender.push(i);
    toRender.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));

    for (const i of toRender) {
      if (token !== this._pdfWindowToken) return; // superseded by a newer scroll/window update
      const item = this._book.spine[i];
      try {
        const canvas = await this._renderPdfCanvas(item.pageNum);
        if (token !== this._pdfWindowToken) return; // superseded mid-render — newer call owns this now
        if (pages[i].rendered) continue; // already filled some other way — nothing to do
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        pages[i].el.style.position = 'relative';
        pages[i].el.innerHTML = '';
        pages[i].el.appendChild(canvas);
        pages[i].rendered = true;
      } catch (err) {
        console.error(`[CXReader] PDF continuous: page ${item.pageNum} render failed:`, err);
      }
    }
  }

  _spineIndexForHref(hrefBase) {
    if (!hrefBase || !this._book) return -1;
    const tail = hrefBase.replace(/^.*\//, '');
    for (let i = 0; i < this._book.spine.length; i++) {
      const sh = this._book.spine[i].href.split('#')[0];
      if (sh === hrefBase || sh.replace(/^.*\//, '') === tail) return i;
    }
    return -1;
  }

  _fireRelocated() {
    if (!this._containerEl) return;
    // EPUB continuous mode reports CHAPTER-relative page/pageCount (see
    // _setContinuousChapterPaging) rather than the paginator's own — which spans however many
    // chapters have been appended into the live document so far, not just the current one.
    const continuousEpub = this._continuous && !this._isCbz && !this._isPdf && !this._isFixedLayout;
    const page      = continuousEpub ? (this._continuousChapterPage      ?? 1) : (this._paginator?.currentPage ?? 1);
    const pageCount = continuousEpub ? (this._continuousChapterPageCount ?? 1) : (this._paginator?.pageCount   ?? 1);
    this._containerEl.dispatchEvent(new CustomEvent('cx-relocated', {
      bubbles: false,
      detail: {
        spineIndex: this._spineIdx,
        href:       this._book.spine[this._spineIdx]?.href ?? '',
        page,
        pageCount,
        endPage:    this._paginator?.endPage ?? page,
        twoColumn:  this._paginator?.isTwoColumn ?? false,
      },
    }));
  }
}
