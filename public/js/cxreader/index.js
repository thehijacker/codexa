// CXReader — Experimental EPUB reader library
// Phase 5: Navigation, TOC, progress save.

import { EpubParser }        from './epub-parser.js';
import { ChapterRenderer }   from './renderer.js';
import { ColumnPaginator }   from './column-paginator.js';
import { CbzParser }         from './cbz-parser.js';
import { FixedPagePaginator } from './fixed-paginator.js';
import { log } from '../logger.js';

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
    this._isFixedLayout = false;
    this._cbzPadTop     = 0;
    this._cbzPadBot     = 0;
    // Called with (iframe) before paginator.init() — use to inject bionic/annotations
    this.onBeforePaginate = null;
  }

  // The CSS-column engine drives both modes: 1 column (single) or 2 columns (spread). It is used
  // for single column too because native column fragmentation never splits a line — unlike the
  // old translateY+clip-path paginator, which clipped lines on e-ink Android WebViews.
  _makePaginator() {
    return (this._isCbz || this._isFixedLayout)
      ? new FixedPagePaginator(this._twoColumn)
      : new ColumnPaginator();
  }

  // init() options for the current layout mode.
  _paginatorOpts() {
    return { columns: this._twoColumn ? 2 : 1, columnGap: this._twoColumn ? this._columnGap : 0 };
  }

  // Init the paginator for the current layout. Use this everywhere instead of calling
  // this._paginator.init() directly.
  _initPaginator(iframe) {
    if (!this._paginator) this._paginator = this._makePaginator();
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

  // Switch column mode / gap. Stores the setting and, if a chapter is live, re-paginates at
  // the current reading position (preserved by fraction so it survives the engine swap).
  setLayout({ twoColumn, columnGap } = {}) {
    if (typeof twoColumn === 'boolean') this._twoColumn = twoColumn;
    if (typeof columnGap === 'number')  this._columnGap = columnGap;
    if (this._isCbz && this._containerEl && this._paginator) {
      // In two-column mode, snap to the start of the nearest spread (even index).
      if (this._twoColumn) this._spineIdx = Math.floor(this._spineIdx / 2) * 2;
      this._paginator = this._makePaginator();
      this._renderCbzItem(this._spineIdx);
      this._fireRelocated();
      return;
    }
    const iframe = this._renderer?.iframe;
    if (!iframe || !this._paginator) return;
    const prevCount = this._paginator.pageCount || 1;
    const frac = prevCount > 1 ? (this._paginator.currentPage - 1) / prevCount : 0;
    this.onBeforePaginate?.(iframe);
    this._initPaginator(iframe);
    const target = Math.max(1, Math.floor(frac * this._paginator.pageCount) + 1);
    this._paginator.goToPage(target);
    this._fireRelocated();
  }

  async open(arrayBuffer) {
    log('[CXReader] open() parsing...');
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
    this._paginator = this._makePaginator();

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
      this._renderCbzItem(this._spineIdx);
      this._fireRelocated();
      return null;
    }

    const iframe = await this._renderer.render(spineItem, containerEl, readerCss, this._fixedLayoutOpts());
    this.onBeforePaginate?.(iframe);
    this._initPaginator(iframe);
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
      this._renderCbzItem(idx);
      this._paginator = this._makePaginator();
      this._fireRelocated();
      return;
    }

    const iframe = await this._renderer.render(
      this._book.spine[idx], this._containerEl, this._readerCss, this._fixedLayoutOpts()
    );
    this.onBeforePaginate?.(iframe);
    this._initPaginator(iframe);
    if (page > 1) this._paginator.goToPage(page);
    this._fireRelocated();
  }

  // Navigate to chapter containing href (path with optional #fragment — fragment ignored).
  async goToHref(href) {
    if (!this._book || !this._containerEl) return;
    const idx = this._spineIndexForHref((href || '').split('#')[0]);
    if (idx >= 0) await this.goToSpineItem(idx);
  }

  // Navigate to spine item identified by an epubcfi string (spine component only).
  async goToCfi(cfi) {
    if (!this._book || !this._containerEl) return;
    const m = String(cfi).match(/^epubcfi\(\/6\/(\d+)!/);
    if (m) {
      const idx = Math.max(0, Math.floor(parseInt(m[1], 10) / 2) - 1);
      await this.goToSpineItem(idx);
      return;
    }
    // Treat as href fallback (e.g. chapter.xhtml)
    if (cfi && !cfi.startsWith('epubcfi(')) await this.goToHref(cfi);
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
  makePct() {
    const total      = this._book?.spine.length || 1;
    const pageCount  = this._paginator?.pageCount || 1;
    const page       = this._paginator?.currentPage || 1;
    const fracWithin = pageCount > 1 ? (page - 1) / pageCount : 0;
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
      if (this._spineIdx >= this._book.spine.length - 1) return;
      const step = this._twoColumn ? 2 : 1;
      this._spineIdx = Math.min(this._spineIdx + step, this._book.spine.length - 1);
      this._renderCbzItem(this._spineIdx);
      this._paginator = this._makePaginator();
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
      this._fireRelocated();
    }
  }

  async prev() {
    if (!this._paginator || !this._book) return;
    if (this._isCbz) {
      if (this._spineIdx <= 0) return;
      const step = this._twoColumn ? 2 : 1;
      this._spineIdx = Math.max(0, this._spineIdx - step);
      this._renderCbzItem(this._spineIdx);
      this._paginator = this._makePaginator();
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
      this._paginator.goToLastPage();
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
  }

  // Navigate to the page containing the annotation <mark> with the given id.
  // Call AFTER goToCfi() so the chapter and its marks are already rendered.
  scrollToAnnotation(annotId) {
    const iframe = this._renderer?.iframe;
    if (!iframe?.contentDocument || !this._paginator) return;
    const sel  = `mark[data-annot-id="${CSS.escape(String(annotId))}"]`;
    const mark = iframe.contentDocument.querySelector(sel);
    if (!mark) return;
    // Page/spread 0 has no transform, so the mark's client rect is in natural body coords.
    this._paginator.goToElement(mark);
    this._fireRelocated();
  }

  // Navigate to the page containing range (character-exact, for search results).
  // Call AFTER goToSpineItem() so the chapter is rendered and the paginator is at spread 0.
  scrollToRange(range) {
    if (!range || !this._paginator) return;
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
    this._paginator.goToPage(target);
    this._fireRelocated();
  }

  // Jump directly to a specific page within the current chapter.
  // Used to restore an exact saved page (more precise than seekToPercent when pageCount matches).
  seekToPage(n) {
    if (!this._paginator) return;
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
    this._paginator = null;
    log('[CXReader] destroy()');
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _fixedLayoutOpts() {
    if (!this._isFixedLayout) return null;
    return { pageWidth: this._book.pageWidth || 0, pageHeight: this._book.pageHeight || 0 };
  }

  _renderCbzItem(idx) {
    this._containerEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cx-cbz-wrap';
    wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--reader-page-bg,#000);box-sizing:border-box;';

    const showTwo = this._twoColumn && idx + 1 < this._book.spine.length;
    const addImg = (i) => {
      const img = document.createElement('img');
      img.src = this._book.spine[i].blobUrl;
      img.style.cssText = showTwo
        ? 'max-width:50%;max-height:100%;object-fit:contain;'
        : 'max-width:100%;max-height:100%;object-fit:contain;';
      wrap.appendChild(img);
    };
    addImg(idx);
    if (showTwo) addImg(idx + 1);

    this._containerEl.appendChild(wrap);
    this._applyCurrentCbzInset();
  }

  // Apply measured status-bar inset so the image(s) sit between the two bars.
  setCbzInset(top, bot) {
    this._cbzPadTop = top || 0;
    this._cbzPadBot = bot || 0;
    this._applyCurrentCbzInset();
  }

  _applyCurrentCbzInset() {
    const wrap = this._containerEl?.querySelector('.cx-cbz-wrap');
    if (!wrap) return;
    const t = this._cbzPadTop, b = this._cbzPadBot;
    wrap.style.top    = t ? `${t}px` : '0';
    wrap.style.bottom = b ? `${b}px` : '0';
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
    this._containerEl.dispatchEvent(new CustomEvent('cx-relocated', {
      bubbles: false,
      detail: {
        spineIndex: this._spineIdx,
        href:       this._book.spine[this._spineIdx]?.href ?? '',
        page:       this._paginator?.currentPage ?? 1,
        pageCount:  this._paginator?.pageCount   ?? 1,
        endPage:    this._paginator?.endPage     ?? this._paginator?.currentPage ?? 1,
        twoColumn:  this._paginator?.isTwoColumn ?? false,
      },
    }));
  }
}
