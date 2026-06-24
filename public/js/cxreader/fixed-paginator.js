// Stub paginator for single-image spine items (CBZ pages, fixed-layout EPUB pages).
// Always returns false from next()/prev() so the caller advances the spine index directly.
export class FixedPagePaginator {
  constructor(twoColumn = false) { this._twoColumn = twoColumn; }
  init()            { return this; }
  get pageCount()   { return 1; }
  get currentPage() { return 1; }
  get endPage()     { return 1; }
  get isTwoColumn() { return this._twoColumn; }
  get isAtEnd()     { return true; }
  get isAtStart()   { return true; }
  next()            { return false; }
  prev()            { return false; }
  goToPage()        { return 1; }
  goToLastPage()    {}
  goToElement()     {}
  goToRange()       {}
}
