// BookOrbit native library browser panel — browse Libraries / Smart Scopes /
// Collections / Series / Authors / Book search, and import books into Codexa.
// Mirrors public/js/opds.js's structure (state, section loaders, a bespoke card
// renderer) rather than reusing library.js's book-card component, which isn't
// parameterized for a different data source / action set.
import { apiFetch } from './api.js';
import { toast, setButtonLoading, initSortMenuFor, resyncSortMenu, showBlockingOverlay } from './ui.js';
import { t } from './i18n.js';
import { reloadLibrary, openInfoModal, sanitizeHtml } from './library.js';
import { reloadShelves } from './sidebar.js';
import { showPanel } from './router.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _initialized  = false;
let currentSection = 'libraries'; // libraries | smartScopes | collections | series | authors | search
let sublistCache   = {};          // section -> items[] (cached until panel reload)
let currentItem    = null;        // { id, name } — the selected library/collection/... (null for 'search')
let currentPage    = 0;
const PAGE_SIZE    = 30;
let currentTotal   = 0;
let bookorbitUrl   = ''; // BookOrbit server base URL, for the detail modal's "View on BookOrbit" link
// One-shot "resume where I was" state — saved right before navigating to the reader for a peek
// (see renderPeekButton), restored by initBookorbit() when the reader closes back here via
// /?panel=bookorbit&from=bookorbit (see reader.js's returnToLibrary()/beforeunload).
const RESUME_KEY = 'br_bookorbit_resume';

// Series/Authors are the only sublist sources BookOrbit actually paginates server-side
// (default page size 50); libraries/collections/smart-scopes come back as a flat array.
const SUBLIST_PAGE_SIZE = 50;
let sublistQuery = '';
let sublistPage  = 0;
let sublistTotal = 0;

const SECTION_SOURCE = {
  libraries:   'library',
  smartScopes: 'smartScope',
  collections: 'collection',
  series:      'series',
  authors:     'author',
  search:      'search',
};
const SECTION_LIST_PATH = {
  libraries:   '/bookorbit/libraries',
  smartScopes: '/bookorbit/smart-scopes',
  collections: '/bookorbit/collections',
  series:      '/bookorbit/series',
  authors:     '/bookorbit/authors',
};

// ── DOM refs (assigned in initBookorbit) ──────────────────────────────────────
let sublistEl, titleEl, sortSelect, searchRow, searchInput, btnSearch, loadingEl, gridEl, emptyEl, paginationEl;
let sidebarEl, drawerToggleBtn, drawerCloseBtn, drawerOverlay;
// ignored by 'search' (BookOrbit's book search has no sort control). Persisted across
// reloads/sessions (unlike currentSection/currentPage, which reset each visit).
let currentSort = localStorage.getItem('br_bookorbit_sort') || 'added_desc';

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function coverSrc(boBookId) {
  const token = encodeURIComponent(localStorage.getItem('br_token') || '');
  return `/api/books/bookorbit-cover/${boBookId}?token=${token}`;
}

function setLoading(on) {
  loadingEl.hidden = !on;
  gridEl.hidden = on;
}

// ── Mobile drawer (section nav + sublist) ─────────────────────────────────────
// No-op on desktop — the CSS that makes these classes visible only exists inside the
// max-width:768px media query, so toggling them unconditionally here is harmless.
function openDrawer() {
  sidebarEl.classList.add('bookorbit-drawer-open');
  drawerOverlay.classList.add('visible');
}
function closeDrawer() {
  sidebarEl.classList.remove('bookorbit-drawer-open');
  drawerOverlay.classList.remove('visible');
}

// ── Sections (left pane) ──────────────────────────────────────────────────────
async function selectSection(section) {
  currentSection = section;
  currentItem = null;
  document.querySelectorAll('.bookorbit-nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === section));

  gridEl.innerHTML = `<div class="opds-welcome" style="grid-column:1/-1"><span class="icon">📚</span><span>${escHtml(t('bookorbit.pick_item'))}</span></div>`;
  emptyEl.hidden = true;
  paginationEl.hidden = true;
  titleEl.textContent = '';

  if (section === 'search') {
    sublistEl.innerHTML = '';
    searchRow.hidden = false;
    searchInput.value = '';
    searchInput.placeholder = t('bookorbit.search_books_ph');
    closeDrawer();
    searchInput.focus();
    return;
  }

  searchRow.hidden = section !== 'series' && section !== 'authors';
  searchInput.value = '';
  searchInput.placeholder = t('bookorbit.filter_ph');

  sublistQuery = '';
  await loadSublist(section, '', 0);
}

async function loadSublist(section, q, page) {
  sublistQuery = q;
  sublistPage = page;
  sublistEl.innerHTML = `<div class="imt-empty" style="padding:.5rem">${t('opds.loading')}</div>`;
  try {
    const paged = section === 'series' || section === 'authors';
    const params = new URLSearchParams();
    if (paged) {
      if (q) params.set('q', q);
      params.set('page', String(page));
      params.set('size', String(SUBLIST_PAGE_SIZE));
    }
    const qs = params.toString();
    const data = await apiFetch(`${SECTION_LIST_PATH[section]}${qs ? `?${qs}` : ''}`);
    const items = Array.isArray(data) ? data : (data.items || []);
    sublistTotal = Array.isArray(data) ? items.length : (data.total ?? items.length);
    sublistCache[section] = items;
    renderSublist(items);
    // Tiles only show *before* an item is picked — mirrors OPDS's folder tiles. Re-filtering
    // Series/Authors (doSearchOrFilter) also calls loadSublist while a specific series/author's
    // books are already on screen; skipping this when currentItem is set keeps that book grid in
    // place instead of clobbering it with a fresh tile list.
    if (!currentItem) renderSectionTiles(items);
  } catch (err) {
    sublistEl.innerHTML = `<div class="imt-empty" style="padding:.5rem">${escHtml(t('common.err_prefix') + err.message)}</div>`;
  }
}

// Picking an item — from either the left sublist row or a right-pane tile (see
// renderSectionTiles) — always does exactly this: select it, reflect that in the left list
// (tiles vanish the instant an item is picked, replaced by its books, so they need no active
// state of their own), load its books, and close the mobile drawer.
function selectItem(item) {
  currentItem = { id: item.id, name: item.name };
  sublistEl.querySelectorAll('.bookorbit-sublist-item').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.id) === item.id));
  titleEl.textContent = item.name;
  loadBooks(0);
  closeDrawer();
}

// Right-pane folder tiles for a section's items — mirrors public/js/opds.js's folder tiles
// exactly (same .nav-tile/.nav-tile-grid/.nav-tile-sync-btn classes), shown before a specific
// item is picked. #bookorbit-grid needs no structural change for this: unlike OPDS, a
// BookOrbit section's tiles and its books are never shown at once, so this is a plain innerHTML
// swap — the same one that already happens between the "pick an item" placeholder and book
// cards. The wrapper needs grid-column:1/-1 so it spans the outer grid's full width instead of
// being sized like a single book card (#bookorbit-grid is display:grid via the shared
// .book-grid/.density-* classes); the tiles' own sizing then comes entirely from
// .nav-tile-grid's grid-template-columns, independent of the outer density setting.
// Shared pager for the paginated sublist sections (Series/Authors) — same sublistPage/
// sublistTotal state and loadSublist() calls regardless of which container it's built into.
// Used both in the left sublist (renderSublist) and, for mobile — where the left menu is hidden
// behind the hamburger drawer — under the folder tiles on the right (renderSectionTiles) too.
function buildSublistPager() {
  const paged = currentSection === 'series' || currentSection === 'authors';
  const totalPages = Math.max(1, Math.ceil(sublistTotal / SUBLIST_PAGE_SIZE));
  if (!paged || totalPages <= 1) return null;

  const pager = document.createElement('div');
  pager.className = 'bookorbit-sublist-pager';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'opds-page-btn';
  prevBtn.textContent = '‹';
  prevBtn.disabled = sublistPage <= 0;
  prevBtn.addEventListener('click', () => loadSublist(currentSection, sublistQuery, sublistPage - 1));

  const info = document.createElement('span');
  info.className = 'opds-page-info';
  info.textContent = `${sublistPage + 1} / ${totalPages}`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'opds-page-btn';
  nextBtn.textContent = '›';
  nextBtn.disabled = sublistPage >= totalPages - 1;
  nextBtn.addEventListener('click', () => loadSublist(currentSection, sublistQuery, sublistPage + 1));

  pager.appendChild(prevBtn);
  pager.appendChild(info);
  pager.appendChild(nextBtn);
  return pager;
}

function renderSectionTiles(items) {
  if (!items.length) {
    emptyEl.hidden = false;
    paginationEl.hidden = true;
    return;
  }
  emptyEl.hidden = true;

  const syncable = currentSection === 'collections' || currentSection === 'smartScopes';
  const wrap = document.createElement('div');
  wrap.className = 'nav-tile-grid';
  wrap.style.gridColumn = '1 / -1';

  items.forEach(item => {
    const tile = document.createElement('button');
    tile.className = 'nav-tile';
    tile.innerHTML = `
      <span class="nav-tile-icon-wrap">
        <img src="/images/folder.svg" class="nav-icon nav-icon-folder" alt="">
        ${item.bookCount != null ? `<span class="nav-tile-count">${item.bookCount}</span>` : ''}
      </span>
      <span class="nav-tile-label">${escHtml(item.name)}</span>
      ${syncable ? `<button class="nav-tile-sync-btn" title="${t('bookorbit.sync_title')}">⇅</button>` : ''}
    `;
    tile.addEventListener('click', e => {
      if (e.target.closest('.nav-tile-sync-btn')) return;
      selectItem(item);
    });
    if (syncable) {
      tile.querySelector('.nav-tile-sync-btn').addEventListener('click', e => {
        e.stopPropagation();
        openBookorbitSyncModal(SECTION_SOURCE[currentSection], item.id, item.name);
      });
    }
    wrap.appendChild(tile);
  });

  gridEl.innerHTML = '';
  gridEl.appendChild(wrap);

  // Mirrors the left sublist's own pager (see buildSublistPager) so Series/Authors can still be
  // paged on mobile without opening the drawer. #bookorbit-pagination is otherwise only used by
  // renderPagination() for book results, which never runs at the same time as this (tiles only
  // show before a specific item is picked; book results only show once one is, or while
  // searching) — safe to repurpose the same element for either.
  const pager = buildSublistPager();
  paginationEl.innerHTML = '';
  if (pager) paginationEl.appendChild(pager);
  paginationEl.hidden = !pager;
}

function renderSublist(items) {
  if (!items.length) {
    sublistEl.innerHTML = `<div class="imt-empty" style="padding:.5rem">${t('bookorbit.no_results')}</div>`;
    return;
  }
  sublistEl.innerHTML = '';
  const syncable = currentSection === 'collections' || currentSection === 'smartScopes';
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'bookorbit-sublist-row';

    const btn = document.createElement('button');
    btn.className = 'bookorbit-sublist-item' + (currentItem?.id === item.id ? ' active' : '');
    btn.dataset.id = item.id;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'bookorbit-sublist-name';
    nameSpan.textContent = item.name;
    btn.appendChild(nameSpan);
    // Libraries don't carry a book count in BookOrbit's list response (would need a separate
    // per-library call) — every other section already includes bookCount, show it when present.
    if (item.bookCount != null) {
      const countSpan = document.createElement('span');
      countSpan.className = 'bookorbit-sublist-count';
      countSpan.textContent = item.bookCount;
      btn.appendChild(countSpan);
    }
    btn.addEventListener('click', () => selectItem(item));
    row.appendChild(btn);

    if (syncable) {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'bookorbit-sublist-sync-btn';
      syncBtn.title = t('bookorbit.sync_title');
      syncBtn.textContent = '⇅';
      syncBtn.addEventListener('click', e => {
        e.stopPropagation();
        openBookorbitSyncModal(SECTION_SOURCE[currentSection], item.id, item.name);
      });
      row.appendChild(syncBtn);
    }

    sublistEl.appendChild(row);
  });

  const pager = buildSublistPager();
  if (pager) sublistEl.appendChild(pager);
}

// ── Books (right pane) ────────────────────────────────────────────────────────
async function loadBooks(page) {
  const source = SECTION_SOURCE[currentSection];
  if (source !== 'search' && !currentItem) return;

  currentPage = page;
  setLoading(true);
  gridEl.innerHTML = '';
  emptyEl.hidden = true;

  const params = new URLSearchParams({ source, page: String(page), size: String(PAGE_SIZE) });
  if (currentItem) params.set('id', String(currentItem.id));
  params.set('sort', currentSort);
  const q = searchInput.value.trim();
  if (q) params.set('q', q);

  try {
    const data = await apiFetch(`/bookorbit/books?${params}`);
    currentTotal = data.total || 0;
    renderGrid(data.items || []);
    renderPagination();
  } catch (err) {
    toast.error(t('common.err_prefix') + err.message);
  } finally {
    setLoading(false);
  }
}

function renderGrid(items) {
  if (!items.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  items.forEach(book => {
    const card = document.createElement('div');
    card.className = 'bookorbit-card';

    const coverHtml = book.hasCover
      ? `<img class="bookorbit-card-cover" src="${coverSrc(book.boBookId)}" alt="" loading="lazy">`
      : `<div class="bookorbit-card-cover bookorbit-card-cover-ph">📖</div>`;

    const seriesLabel = book.seriesName
      ? `${book.seriesName}${book.seriesIndex != null ? ` #${book.seriesIndex}` : ''}`
      : '';

    card.innerHTML = `
      <div class="bookorbit-card-cover-wrap">
        ${coverHtml}
        ${book.seriesIndex != null ? `<div class="bookorbit-card-series-badge">#${escHtml(book.seriesIndex)}</div>` : ''}
        <div class="bookorbit-card-actions"></div>
      </div>
      <div class="bookorbit-card-info">
        <div class="bookorbit-card-title" title="${escHtml(book.title || '')}">${escHtml(book.title || '')}</div>
        ${book.authors?.length ? `<div class="bookorbit-card-author">${escHtml(book.authors.join(', '))}</div>` : ''}
        ${seriesLabel ? `<div class="bookorbit-card-series">${escHtml(seriesLabel)}</div>` : ''}
      </div>
    `;

    const actionsEl = card.querySelector('.bookorbit-card-actions');
    renderCardActions(actionsEl, book);
    renderDownloadedBadge(card.querySelector('.bookorbit-card-cover-wrap'), book);

    // Touch devices have no hover — first tap reveals the action icons instead.
    card.addEventListener('click', e => {
      if (e.target.closest('.bookorbit-card-actions')) return;
      if (!window.matchMedia('(pointer: coarse)').matches) return;
      const wasTapped = card.classList.contains('tapped');
      document.querySelectorAll('.bookorbit-card.tapped').forEach(c => c.classList.remove('tapped'));
      if (!wasTapped) card.classList.add('tapped');
    });

    gridEl.appendChild(card);
  });
}

// In-place cover download-progress overlay, driven by the import-sse route below — the exact
// same markup/CSS classes as public/js/library.js's offline-download progress bar
// (.book-download-progress / -pct / -track / -bar) so "Add to Codexa" and "download for
// offline" look identical, just anchored to a .bookorbit-card-cover-wrap instead of a
// .book-card. CSS is shared/generic already, so no new styles are needed.
function showCoverProgress(coverWrapEl) {
  coverWrapEl.querySelector('.book-download-progress')?.remove();
  const el = document.createElement('div');
  el.className = 'book-download-progress';
  el.innerHTML = `<span class="book-download-progress-pct">0%</span><div class="book-download-progress-track"><div class="book-download-progress-bar" style="width:0%"></div></div>`;
  coverWrapEl.appendChild(el);
  return el;
}
function updateCoverProgress(el, loaded, total) {
  if (!el?.isConnected) return;
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  el.querySelector('.book-download-progress-pct').textContent = pct + '%';
  el.querySelector('.book-download-progress-bar').style.width = pct + '%';
}
function hideCoverProgress(el) {
  el?.remove();
}

// "Already in your Codexa library" badge — same visual treatment as the main library grid's
// offline badge (public/js/library.js _makeCard), just a different meaning here (downloaded
// into Codexa at all, vs. cached for offline reading).
function renderDownloadedBadge(coverWrapEl, book) {
  coverWrapEl.querySelector('.book-offline-badge')?.remove();
  if (!book.localBookId) return;
  const badge = document.createElement('div');
  badge.className = 'book-offline-badge';
  badge.title = t('bookorbit.badge_downloaded');
  badge.textContent = '✓';
  coverWrapEl.appendChild(badge);
}

// Compact icon-only buttons overlaid on the cover (hover to reveal on desktop, tap on touch),
// matching the main library grid's card-hover actions (public/js/library.js _makeCard).
// Always-visible peek icon at the bottom-right of the cover, separate from the top-right hover
// action row (which was overflowing the cover once a 4th icon — peek for not-yet-owned books —
// was added there). Mirrors public/js/library.js's .book-card-peek-btn placement exactly.
function renderPeekButton(coverWrapEl, book) {
  coverWrapEl.querySelector('.bookorbit-card-peek-btn')?.remove();

  if (book.localBookId) {
    const link = document.createElement('a');
    link.className = 'bookorbit-card-peek-btn';
    link.href = `/reader.html?id=${book.localBookId}&peek=1&from=bookorbit`;
    link.title = t('opds.btn_peek');
    link.innerHTML = `<img src="/images/peek.svg" class="nav-icon nav-icon-peek" alt="">`;
    link.addEventListener('click', () => saveResumeState()); // let the reader send us back here on close
    coverWrapEl.appendChild(link);
    return;
  }

  // Peek a not-yet-owned book: server fetches it into a short-lived ephemeral "books" row (never
  // lands in the permanent library, auto-cleaned on close or by the background sweep — see
  // server/utils/peekCleanup.js), then we navigate to the same read-only reader URL scheme as an
  // already-owned book's peek link above.
  const primaryFile = book.files?.[0];
  const btn = document.createElement('button');
  btn.className = 'bookorbit-card-peek-btn';
  btn.innerHTML = `<img src="/images/peek.svg" class="nav-icon nav-icon-peek" alt="">`;
  if (!primaryFile) {
    btn.disabled = true;
    btn.title = t('bookorbit.no_file');
  } else {
    btn.title = t('opds.btn_peek');
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      btn.classList.add('bookorbit-btn-busy');
      // The server does the actual download from BookOrbit here — this request only resolves
      // once that finishes, so there's no client-visible byte progress to show (unlike the
      // reader's own file fetch, which streams and reports %). A blocking overlay at least makes
      // it clear something is happening and blocks other taps while it's in flight; the slow-
      // download message kicks in if it's still running after a few seconds.
      let cancelled = false;
      const overlay = showBlockingOverlay(t('bookorbit.peek_downloading'), () => {
        cancelled = true;
        btn.disabled = false;
        btn.classList.remove('bookorbit-btn-busy');
      });
      const slowTimer = setTimeout(() => overlay.setMessage(t('common.download_slow_hint')), 8000);
      try {
        const result = await apiFetch(`/bookorbit/books/${book.boBookId}/peek`, {
          method: 'POST',
          body: JSON.stringify({
            fileId: primaryFile.id, format: primaryFile.format,
            title: book.title, author: book.authors?.[0],
            seriesName: book.seriesName, seriesIndex: book.seriesIndex,
            language: book.language,
          }),
        });
        clearTimeout(slowTimer);
        if (cancelled) {
          // User already backed out — don't yank them into the reader. The server did finish the
          // download though, so clean up the ephemeral row now instead of waiting for the TTL sweep.
          apiFetch(`/books/${result.id}/peek-cleanup`, { method: 'POST' }).catch(() => {});
          return;
        }
        overlay.dismiss();
        saveResumeState(); // let the reader send us back here on close
        window.location.href = `/reader.html?id=${result.id}&peek=1&from=bookorbit`;
      } catch (err) {
        clearTimeout(slowTimer);
        if (!cancelled) {
          overlay.dismiss();
          toast.error(err.message);
          btn.disabled = false;
          btn.classList.remove('bookorbit-btn-busy');
        }
      }
    });
  }
  coverWrapEl.appendChild(btn);
}

function renderCardActions(actionsEl, book) {
  actionsEl.innerHTML = '';
  renderPeekButton(actionsEl.closest('.bookorbit-card-cover-wrap'), book);

  if (book.localBookId) {
    const infoBtn = document.createElement('button');
    infoBtn.className = 'btn-icon';
    infoBtn.title = t('opds.btn_book_info');
    infoBtn.textContent = 'ℹ';
    infoBtn.addEventListener('click', e => {
      e.stopPropagation();
      openInfoModal({ id: book.localBookId }).catch(() => {});
    });
    actionsEl.appendChild(infoBtn);

    appendCollectionsButton(actionsEl, book);
    return;
  }

  const primaryFile = book.files?.[0];
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-icon';
  addBtn.innerHTML = `<img src="/images/add_to_codexa.svg" class="nav-icon nav-icon-add-to-codexa" alt="">`;
  if (!primaryFile) {
    addBtn.disabled = true;
    addBtn.title = t('bookorbit.no_file');
  } else {
    addBtn.title = t('bookorbit.btn_add');
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      addBtn.disabled = true;
      addBtn.classList.add('bookorbit-btn-busy');
      const coverWrapEl  = actionsEl.closest('.bookorbit-card-cover-wrap');
      const progressEl   = showCoverProgress(coverWrapEl);

      const finish = () => {
        hideCoverProgress(progressEl);
        addBtn.disabled = false;
        addBtn.classList.remove('bookorbit-btn-busy');
      };

      const params = new URLSearchParams({
        fileId: primaryFile.id, format: primaryFile.format || '',
        title: book.title || '', author: book.authors?.[0] || '',
        seriesName: book.seriesName || '', seriesIndex: book.seriesIndex ?? '',
        language: book.language || '', token: localStorage.getItem('br_token') || '',
      });
      const es = new EventSource(`/api/bookorbit/books/${book.boBookId}/import-sse?${params}`);

      es.onmessage = evt => {
        let data;
        try { data = JSON.parse(evt.data); } catch { return; }
        if (data.type === 'progress') {
          updateCoverProgress(progressEl, data.loaded, data.total);
        } else if (data.type === 'done') {
          es.close();
          finish();
          toast.success(t('opds.toast_book_added', { title: book.title }));
          book.localBookId = data.id;
          renderCardActions(actionsEl, book);
          renderDownloadedBadge(coverWrapEl, book);
          reloadLibrary().catch(e2 => console.error('[bookorbit] reloadLibrary failed:', e2));
        } else if (data.type === 'error') {
          es.close();
          finish();
          if (data.id) {
            toast.info(t('opds.err_already_in_library'));
            book.localBookId = data.id;
            renderCardActions(actionsEl, book);
            renderDownloadedBadge(coverWrapEl, book);
          } else {
            toast.error(t(data.message));
          }
        }
      };
      es.onerror = () => {
        es.close();
        finish();
        toast.error(t('bookorbit.import_failed'));
      };
    });
  }
  actionsEl.appendChild(addBtn);

  const infoBtn = document.createElement('button');
  infoBtn.className = 'btn-icon';
  infoBtn.title = t('opds.btn_book_info');
  infoBtn.textContent = 'ℹ';
  infoBtn.addEventListener('click', e => {
    e.stopPropagation();
    openBookorbitDetailModal(book);
  });
  actionsEl.appendChild(infoBtn);

  appendCollectionsButton(actionsEl, book);
}

function appendCollectionsButton(actionsEl, book) {
  const btn = document.createElement('button');
  btn.className = 'btn-icon';
  btn.title = t('bookorbit.btn_collections');
  btn.innerHTML = `<img src="/images/collections.svg" class="nav-icon nav-icon-collections" alt="">`;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    openCollectionsModal(book);
  });
  actionsEl.appendChild(btn);
}

// ── Collections membership editor ─────────────────────────────────────────────
// Lets the user assign/unassign this BookOrbit book to/from collections without
// ever opening BookOrbit itself. Same "checklist + Save, diff against original" UX
// as the main library's shelves tab (public/js/library.js's #info-modal-save).
async function openCollectionsModal(book) {
  document.getElementById('bookorbit-collections-modal')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'bookorbit-collections-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:360px">
      <button class="modal-close" id="boc-close" aria-label="${escHtml(t('common.close'))}">&times;</button>
      <h2>${escHtml(book.title || '')}</h2>
      <div class="info-modal-section-title">${t('bookorbit.collections_title')}</div>
      <div id="boc-list" class="info-modal-shelves"><div class="imt-empty">${t('opds.loading')}</div></div>
      <div style="margin-top:.75rem">
        <button class="btn btn-primary btn-sm" id="boc-save">${t('bookorbit.btn_save_collections')}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('#boc-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  const listEl = backdrop.querySelector('#boc-list');
  let collections = [];
  try {
    collections = await apiFetch(`/bookorbit/books/${book.boBookId}/collections`);
  } catch (err) {
    listEl.innerHTML = `<div class="imt-empty">${escHtml(t('common.err_prefix') + err.message)}</div>`;
    return;
  }

  if (!collections.length) {
    listEl.innerHTML = `<div class="imt-empty">${t('bookorbit.no_collections')}</div>`;
  } else {
    listEl.innerHTML = collections.map(c => `
      <label class="info-modal-shelf-row">
        <input type="checkbox" class="boc-chk" value="${c.id}" ${c.member ? 'checked' : ''} />
        <span>${escHtml(c.name)}</span>
      </label>`).join('');
  }

  const originalMemberIds = new Set(collections.filter(c => c.member).map(c => c.id));

  backdrop.querySelector('#boc-save').addEventListener('click', async btnEvent => {
    const saveBtn = btnEvent.currentTarget;
    const checked = new Set([...backdrop.querySelectorAll('.boc-chk:checked')].map(el => Number(el.value)));
    const toAdd    = [...checked].filter(id => !originalMemberIds.has(id));
    const toRemove = [...originalMemberIds].filter(id => !checked.has(id));
    setButtonLoading(saveBtn, true);
    try {
      for (const collectionId of toAdd)
        await apiFetch(`/bookorbit/books/${book.boBookId}/collections/${collectionId}`, { method: 'PUT' });
      for (const collectionId of toRemove)
        await apiFetch(`/bookorbit/books/${book.boBookId}/collections/${collectionId}`, { method: 'DELETE' });
      toast.success(t('bookorbit.collections_saved'));
      close();
      // Refresh the left list's book-count badges — they were fetched once when the Collections
      // section was selected and never told about a membership change made through this modal.
      // Safe to call while a collection's books are open: loadSublist only re-renders the left
      // list and (per its own guard) skips the right-pane tiles whenever currentItem is set, so
      // it won't touch the book grid the user is currently looking at.
      if ((toAdd.length || toRemove.length) && currentSection === 'collections') {
        loadSublist(currentSection, sublistQuery, sublistPage);
      }
      // If the currently-open collection lost or gained this book, refresh its grid too.
      if (currentItem && (toAdd.includes(currentItem.id) || toRemove.includes(currentItem.id))) {
        loadBooks(currentPage);
      }
    } catch (err) {
      toast.error(t('common.err_prefix') + err.message);
      setButtonLoading(saveBtn, false);
    }
  });
}

// Full-size cover preview — mirrors library.js's openCoverPreview, which is hardwired to local
// books' /covers/:path and isn't reusable as-is, so this is a small BookOrbit-sourced sibling
// reusing the same generic .cover-preview-overlay/.cover-preview-img classes.
function openBookorbitCoverPreview(book) {
  if (!book.hasCover) return;
  document.getElementById('cover-preview-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cover-preview-overlay';
  overlay.className = 'cover-preview-overlay';
  overlay.innerHTML = `<img src="${coverSrc(book.boBookId)}" alt="" class="cover-preview-img" />`;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

// ── Book detail modal (for books not yet downloaded into Codexa) ─────────────
// Codexa's own info modal (library.js openInfoModal) only works for local books — it re-fetches
// GET /api/books/:id, which doesn't exist until the book is imported. This is the BookOrbit-side
// equivalent: same visual language (reuses .info-modal-* / .imt-meta-* classes) but sourced
// entirely from BookOrbit's GET /books/:id via our /bookorbit/books/:id/detail proxy.
// Related-tab card renderer, same shape as library.js's own loadRelatedTab() card builder —
// links out to BookOrbit itself (no recursive modal-opening) when the server URL is known.
function relatedCardHtml(b) {
  const boLink = bookorbitUrl ? `${bookorbitUrl.replace(/\/+$/, '')}/book/${b.boBookId}` : null;
  const inner = `
    <div class="imt-related-cover-wrap">
      ${b.hasCover
        ? `<img class="imt-related-cover" src="${coverSrc(b.boBookId)}" alt="" loading="lazy" />`
        : `<div class="imt-related-cover imt-related-cover-ph">\u{1F4D6}</div>`}
      ${b.seriesIndex != null ? `<span class="imt-related-series-badge">#${escHtml(String(b.seriesIndex))}</span>` : ''}
    </div>
    <div class="imt-related-title">${escHtml(b.title || '')}</div>
    ${b.authors?.length ? `<div class="imt-related-author">${escHtml(b.authors.join(', '))}</div>` : ''}`;

  return boLink
    ? `<a class="imt-related-card" href="${escHtml(boLink)}" target="_blank" rel="noopener" title="${escHtml(b.title || '')}">${inner}</a>`
    : `<div class="imt-related-card" title="${escHtml(b.title || '')}">${inner}</div>`;
}

async function openBookorbitDetailModal(book) {
  document.getElementById('bookorbit-detail-modal')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'bookorbit-detail-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal info-modal" role="dialog" aria-modal="true">
      <button class="modal-close" id="bod-close" aria-label="${escHtml(t('common.close'))}">&times;</button>
      <div class="info-modal-header">
        <div class="info-modal-cover-wrap">
          ${book.hasCover
            ? `<img class="info-modal-cover info-modal-cover-clickable" src="${coverSrc(book.boBookId)}" alt="" />`
            : `<div class="info-modal-cover info-modal-cover-ph">\u{1F4D6}</div>`}
        </div>
        <div class="info-modal-hero">
          <h3 class="info-modal-title">${escHtml(book.title || '')}</h3>
          <div class="info-modal-author">${escHtml((book.authors || []).join(', ') || t('library.unknown_author'))}</div>
          ${bookorbitUrl ? `
          <div class="info-modal-actions">
            <a class="imt-action-btn" href="${escHtml(bookorbitUrl.replace(/\/+$/, ''))}/book/${book.boBookId}" target="_blank" rel="noopener" title="${t('library.btn_view_bookorbit')}"><img src="/images/bookorbit.svg" class="nav-icon nav-icon-bookorbit" alt="${t('library.btn_view_bookorbit')}"></a>
          </div>` : ''}
        </div>
      </div>

      <div class="info-modal-tabs" role="tablist">
        <button class="imt-tab active" data-tab="details" role="tab">${t('library.tab_details')}</button>
        <button class="imt-tab" data-tab="related" role="tab">${t('library.tab_related')}</button>
      </div>

      <div class="info-modal-tab-content">
        <div class="imt-panel" id="bod-details"><div class="imt-empty" style="padding:1rem 0">${t('opds.loading')}</div></div>
        <div class="imt-panel" id="bod-related" style="display:none"><div id="bod-related-inner"><div class="imt-empty" style="padding:1rem 0">${t('opds.loading')}</div></div></div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('#bod-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.info-modal-cover-clickable')?.addEventListener('click', e => {
    e.stopPropagation();
    openBookorbitCoverPreview(book);
  });

  // ── Details tab (loads immediately) ─────────────────────────────────────────
  const detailsEl = backdrop.querySelector('#bod-details');
  try {
    const d = await apiFetch(`/bookorbit/books/${book.boBookId}/detail`);
    const seriesLabel = d.seriesName ? `${d.seriesName}${d.seriesIndex != null ? ` #${d.seriesIndex}` : ''}` : '';
    const metaRows = [
      d.publisher      && [t('library.info_publisher'), escHtml(d.publisher)],
      d.language       && [t('library.info_language'), escHtml(d.language)],
      d.pageCount      && [t('library.info_pages'), escHtml(String(d.pageCount))],
      (d.isbn13 || d.isbn10) && [t('library.info_isbn'), escHtml(d.isbn13 || d.isbn10)],
      d.publishedYear  && [t('bookorbit.info_published_year'), escHtml(String(d.publishedYear))],
    ].filter(Boolean);

    detailsEl.innerHTML = `
      ${seriesLabel ? `<div class="info-modal-series">${escHtml(seriesLabel)}</div>` : ''}
      ${d.genres?.length ? `<div class="info-modal-genres" style="margin-top:.3rem">${d.genres.map(g => `<span class="genre-pill">${escHtml(g)}</span>`).join('')}</div>` : ''}
      ${metaRows.length ? `<div class="imt-meta-grid" style="margin-top:.75rem">${metaRows.map(([label, val]) => `<div class="imt-meta-pair"><span class="imt-meta-label">${label}</span><span>${val}</span></div>`).join('')}</div>` : ''}
      ${d.description ? `<div class="info-modal-section-title" style="margin-top:.75rem">${t('library.info_desc')}</div><div class="info-modal-desc">${sanitizeHtml(d.description)}</div>` : ''}
    `;
  } catch (err) {
    detailsEl.innerHTML = `<div class="imt-empty">${escHtml(t('common.err_prefix') + err.message)}</div>`;
  }

  // ── Related tab (lazy — same recommendation engine as library.js's own Related tab) ──────────
  let relatedLoaded = false;
  async function loadRelatedTab() {
    const inner = backdrop.querySelector('#bod-related-inner');
    try {
      const data = await apiFetch(`/bookorbit/books/${book.boBookId}/related`);
      const sections = [];
      if (data.seriesBooks?.length) {
        sections.push(`
          <div class="imt-section-title">${t('library.related_series')}</div>
          <div class="imt-related-scroller">${data.seriesBooks.map(relatedCardHtml).join('')}</div>`);
      }
      if (data.authorBooks?.length) {
        sections.push(`
          <div class="imt-section-title" style="margin-top:.75rem">${t('library.related_by_author')}</div>
          <div class="imt-related-scroller">${data.authorBooks.map(relatedCardHtml).join('')}</div>`);
      }
      if (data.recommendations?.length) {
        sections.push(`
          <div class="imt-section-title" style="margin-top:.75rem">${t('library.related_more_like_this')}</div>
          <div class="imt-related-scroller">${data.recommendations.map(relatedCardHtml).join('')}</div>`);
      }
      inner.innerHTML = sections.length ? sections.join('') : `<div class="imt-empty">${t('library.related_empty')}</div>`;
    } catch (err) {
      inner.innerHTML = `<div class="imt-empty">${escHtml(t('common.err_prefix') + err.message)}</div>`;
    }
  }

  backdrop.querySelectorAll('.imt-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tab;
      backdrop.querySelectorAll('.imt-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
      backdrop.querySelectorAll('.imt-panel').forEach(p => { p.style.display = p.id === `bod-${id}` ? '' : 'none'; });
      if (id === 'related' && !relatedLoaded) { relatedLoaded = true; loadRelatedTab(); }
    });
  });
}

// ── Sync a collection/smart-scope into a Codexa shelf (SSE progress) ─────────
// Simplified sibling of opds.js's openSyncModal: no force-refresh option (BookOrbit files
// don't need it the way OPDS re-syncs can) and no stale-books dialog (server does an
// additive-only sync — see server/routes/bookorbit.js sync-sse).
export function openBookorbitSyncModal(source, id, name, existingShelfId = null) {
  document.getElementById('bookorbit-sync-modal')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'bookorbit-sync-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:420px">
      <button class="modal-close" id="bos-close">&times;</button>
      <h2>${t('bookorbit.sync_modal_title')}</h2>
      <p style="font-size:.85rem;color:var(--color-text-muted);margin-bottom:1.25rem;line-height:1.5">
        ${t('bookorbit.sync_modal_hint', { name: escHtml(name) })}
      </p>
      <div id="bos-scanning" style="text-align:center;padding:1.5rem 0;color:var(--color-text-muted);font-size:.9rem">
        <span class="spinner" style="margin-right:.5rem"></span>${t('opds.sync_scanning')}
      </div>
      <div id="bos-form" hidden>
        <div id="bos-count-info" style="font-size:.85rem;color:var(--color-text-muted);margin-bottom:1rem;padding:.55rem .75rem;background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--radius)"></div>
        <div class="form-group" style="margin-bottom:.9rem">
          <label for="bos-shelf-name">${t('opds.sync_shelf_label')}</label>
          <input type="text" id="bos-shelf-name" maxlength="100" value="${escHtml(name)}" autofocus />
        </div>
        <div class="form-group" style="margin-bottom:.25rem">
          <label for="bos-limit">${t('opds.sync_limit_label')}</label>
          <input type="number" id="bos-limit" min="1" max="9999" placeholder="${t('opds.sync_limit_placeholder')}" style="width:140px" />
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="bos-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary"   id="bos-confirm">${t('opds.btn_sync_confirm')}</button>
        </div>
      </div>
      <div id="bos-progress" hidden>
        <div id="bos-progress-text" style="font-size:.85rem;color:var(--color-text-muted);margin-bottom:.5rem">${t('opds.sync_starting')}</div>
        <div class="book-progress-bar" style="height:8px;margin-bottom:.5rem">
          <div id="bos-progress-fill" class="book-progress-fill" style="width:0%"></div>
        </div>
        <div id="bos-progress-book" style="font-size:.78rem;color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:1rem"></div>
        <div style="text-align:right">
          <button class="btn btn-secondary btn-sm" id="bos-abort-btn">${t('opds.sync_abort')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('#bos-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  apiFetch(`/bookorbit/sync-count?${new URLSearchParams({ source, id })}`)
    .then(data => {
      backdrop.querySelector('#bos-scanning').hidden = true;
      const formEl    = backdrop.querySelector('#bos-form');
      const countInfo = backdrop.querySelector('#bos-count-info');
      const newBooks  = data.total - data.alreadyHave;
      countInfo.innerHTML = t('opds.sync_count_info', { total: data.total, alreadyHave: data.alreadyHave, newBooks });
      formEl.hidden = false;
      backdrop.querySelector('#bos-shelf-name').focus();
    })
    .catch(err => {
      backdrop.querySelector('#bos-scanning').innerHTML = `<span style="color:var(--color-danger)">${t('common.error_msg', { msg: err.message })}</span>`;
    });

  backdrop.querySelector('#bos-cancel')?.addEventListener('click', close);

  backdrop.querySelector('#bos-confirm').addEventListener('click', () => {
    const shelfName = backdrop.querySelector('#bos-shelf-name').value.trim();
    if (!shelfName) return;
    const limitVal = backdrop.querySelector('#bos-limit').value.trim();
    const limit = limitVal ? parseInt(limitVal, 10) : null;

    backdrop.querySelector('#bos-form').hidden = true;
    backdrop.querySelector('#bos-progress').hidden = false;
    backdrop.querySelector('#bos-close').disabled = true;

    const params = new URLSearchParams({ source, id, shelfName, token: localStorage.getItem('br_token') || '' });
    if (limit && limit > 0) params.set('limit', limit);
    if (existingShelfId) params.set('shelfId', String(existingShelfId));

    const es = new EventSource(`/api/bookorbit/sync-sse?${params}`);
    let total = 0;
    let aborted = false;

    const fillEl = backdrop.querySelector('#bos-progress-fill');
    const textEl = backdrop.querySelector('#bos-progress-text');
    const bookEl = backdrop.querySelector('#bos-progress-book');
    const abortBtn = backdrop.querySelector('#bos-abort-btn');

    abortBtn.addEventListener('click', () => {
      aborted = true;
      es.close();
      backdrop.querySelector('#bos-close').disabled = false;
      abortBtn.disabled = true;
      textEl.textContent = t('opds.sync_aborted');
      bookEl.textContent = '';
      reloadShelves();
      reloadLibrary();
    });

    es.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'start') {
        total = msg.total;
        textEl.textContent = `0 / ${total}`;
      } else if (msg.type === 'progress') {
        total = msg.total || total;
        const pct = total ? Math.round((msg.current / total) * 100) : 0;
        fillEl.style.width = pct + '%';
        textEl.textContent = `${msg.current} / ${total}`;
        bookEl.textContent = msg.book || '';
      } else if (msg.type === 'done') {
        es.close();
        reloadShelves();
        reloadLibrary();
        const summary = msg.errors
          ? t('opds.sync_done_errors', { added: msg.added, skipped: msg.skipped, errors: msg.errors })
          : t('opds.sync_done', { added: msg.added, skipped: msg.skipped });
        if (msg.staleBooks && msg.staleBooks.length > 0) {
          const stale = msg.staleBooks;
          close();
          openBookorbitStaleDialog(stale, msg.shelfId, summary);
        } else {
          toast.success(summary);
          close();
        }
      } else if (msg.type === 'error') {
        es.close();
        toast.error(t('common.error_msg', { msg: msg.message }));
        close();
      }
    });

    es.onerror = () => {
      if (aborted) return;
      es.close();
      toast.error(t('opds.err_sse_disconnected'));
      close();
    };
  });
}

// ── Stale books dialog ────────────────────────────────────────────────────────
// Mirrors opds.js's openStaleDialog — books that were on the synced shelf before this sync but
// are no longer in the linked BookOrbit collection/smart scope/library. Reuses the generic
// opds.stale_* strings (title/keep/delete/also_in_shelves/deleted aren't source-specific) except
// for the hint text, which has its own bookorbit.stale_hint wording.
// syncSummary is optional — omitted (falsy) when this is called for a single-book
// "immediate" removal (see library.js's Collections tab) rather than after a full shelf
// sync, in which case the toast messages are skipped and onDone (if given) fires instead
// so the caller can refresh its own already-open UI (reloadShelves/reloadLibrary alone
// won't touch e.g. a book-info modal's in-memory shelf-membership state).
export function openBookorbitStaleDialog(staleBooks, shelfId, syncSummary, onDone) {
  document.getElementById('bookorbit-stale-modal')?.remove();
  const otherCounts = new Map(staleBooks.map(b => [b.id, b.otherShelfCount || 0]));

  const backdrop = document.createElement('div');
  backdrop.id        = 'bookorbit-stale-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:480px">
      <button class="modal-close" id="bo-stale-close">&times;</button>
      <h2>${t('opds.stale_title')}</h2>
      <p style="font-size:.85rem;color:var(--color-text-muted);margin-bottom:1rem;line-height:1.5">
        ${t('bookorbit.stale_hint')}
      </p>
      <div class="info-modal-shelves" style="max-height:220px;overflow-y:auto;margin-bottom:1rem">
        ${staleBooks.map(b => `
          <label class="info-modal-shelf-row">
            <input type="checkbox" class="bo-stale-chk" value="${b.id}" checked />
            <span>${escHtml(b.title)}</span>
            ${b.author ? `<span style="font-size:.78rem;color:var(--color-text-muted)">${escHtml(b.author)}</span>` : ''}
            ${(b.otherShelfCount || 0) > 0 ? `<span style="font-size:.72rem;color:var(--color-accent);margin-left:auto">${t('opds.stale_also_in_shelves')}</span>` : ''}
          </label>`).join('')}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="bo-stale-skip">${t('opds.stale_keep')}</button>
        <button class="btn btn-danger"    id="bo-stale-delete">${t('opds.stale_delete')}</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  const close = () => { backdrop.remove(); if (syncSummary) toast.success(syncSummary); onDone?.(); };

  backdrop.querySelector('#bo-stale-close').addEventListener('click', close);
  backdrop.querySelector('#bo-stale-skip').addEventListener('click', async () => {
    for (const bookId of otherCounts.keys()) {
      try {
        await apiFetch(`/shelves/${shelfId}/books/${bookId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    backdrop.remove();
    reloadShelves();
    reloadLibrary();
    if (syncSummary) toast.success(syncSummary);
    onDone?.();
  });
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#bo-stale-delete').addEventListener('click', async () => {
    const checked = [...backdrop.querySelectorAll('.bo-stale-chk:checked')].map(el => Number(el.value));
    if (!checked.length) { close(); return; }
    let handled = 0;
    for (const bookId of checked) {
      try {
        if (otherCounts.get(bookId) > 0) {
          await apiFetch(`/shelves/${shelfId}/books/${bookId}`, { method: 'DELETE' });
        } else {
          await apiFetch(`/books/${bookId}`, { method: 'DELETE' });
        }
        handled++;
      } catch { /* ignore */ }
    }
    backdrop.remove();
    reloadShelves();
    reloadLibrary();
    if (syncSummary) toast.success(t('opds.stale_deleted', { summary: syncSummary, n: handled }));
    onDone?.();
  });
}

// ── Deep-link into the BookOrbit browser at a specific collection/smart-scope ─
// Mirrors opds.js's openOpdsBrowserAtFolder — used by the linked-shelf banner's
// "Open in BookOrbit" button (public/js/library.js).
export async function openBookorbitBrowserAt(source, id, name) {
  await showPanel('bookorbit'); // ensures initBookorbit has run
  const section = source === 'collection' ? 'collections' : source === 'smartScope' ? 'smartScopes' : null;
  if (!section) return;
  await selectSection(section);
  currentItem = { id, name };
  titleEl.textContent = name;
  sublistEl.querySelectorAll('.bookorbit-sublist-item').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.id) === Number(id));
  });
  loadBooks(0);
  closeDrawer();
}

function renderPagination() {
  paginationEl.innerHTML = '';
  const totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
  if (totalPages <= 1) { paginationEl.hidden = true; return; }
  paginationEl.hidden = false;

  const prevBtn = document.createElement('button');
  prevBtn.className = 'opds-page-btn';
  prevBtn.textContent = '‹ ' + t('opds.page_prev');
  prevBtn.disabled = currentPage <= 0;
  prevBtn.addEventListener('click', () => loadBooks(currentPage - 1));

  const info = document.createElement('span');
  info.className = 'opds-page-info';
  info.textContent = t('opds.page_info', { page: currentPage + 1, count: currentTotal });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'opds-page-btn';
  nextBtn.textContent = t('opds.page_next') + ' ›';
  nextBtn.disabled = currentPage >= totalPages - 1;
  nextBtn.addEventListener('click', () => loadBooks(currentPage + 1));

  paginationEl.appendChild(prevBtn);
  paginationEl.appendChild(info);
  paginationEl.appendChild(nextBtn);
}

// ── Search / filter (shared toolbar input) ────────────────────────────────────
function doSearchOrFilter() {
  if (currentSection === 'series' || currentSection === 'authors') {
    loadSublist(currentSection, searchInput.value.trim(), 0);
    return;
  }
  loadBooks(0);
  closeDrawer(); // book-search results are ready — get them out from behind the drawer
}

// ── Resume state (peek round-trip to the reader and back) ─────────────────────
function saveResumeState() {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({
      section: currentSection,
      itemId:  currentItem?.id ?? null,
      itemName: currentItem?.name ?? '',
      page:    currentPage,
      sort:    currentSort,
      query:   searchInput?.value || '',
    }));
  } catch { /* storage full/unavailable — resume just won't happen, non-critical */ }
}

async function restoreResumeState() {
  let raw;
  try { raw = sessionStorage.getItem(RESUME_KEY); } catch { return false; }
  if (!raw) return false;
  try { sessionStorage.removeItem(RESUME_KEY); } catch { /* ignore */ }
  let state;
  try { state = JSON.parse(raw); } catch { return false; }
  if (!state?.section) return false;

  if (state.sort) {
    currentSort = state.sort;
    sortSelect.value = currentSort;
    resyncSortMenu('bookorbit-sort-select', 'bookorbit-sort-menu-list', 'bookorbit-sort-menu-label');
  }

  await selectSection(state.section);

  if (state.section === 'search') {
    searchInput.value = state.query || '';
    if (searchInput.value) loadBooks(state.page || 0);
    return true;
  }

  if (state.itemId != null) {
    currentItem = { id: state.itemId, name: state.itemName };
    titleEl.textContent = state.itemName;
    sublistEl.querySelectorAll('.bookorbit-sublist-item').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.id) === Number(state.itemId));
    });
    loadBooks(state.page || 0);
  }
  return true;
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initBookorbit() {
  if (_initialized) return;
  _initialized = true;

  const refreshBookorbitUrl = () => apiFetch('/settings').then(s => { bookorbitUrl = s.bookorbit_url || ''; }).catch(() => {});
  refreshBookorbitUrl();
  // The URL can change from Settings while this panel sits open in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshBookorbitUrl();
  });

  sublistEl    = document.getElementById('bookorbit-sublist');
  titleEl      = document.getElementById('bookorbit-title');
  sortSelect   = document.getElementById('bookorbit-sort-select');
  searchRow    = document.getElementById('bookorbit-search-row');
  searchInput  = document.getElementById('bookorbit-search-input');
  btnSearch    = document.getElementById('btn-bookorbit-search');
  loadingEl    = document.getElementById('bookorbit-loading');
  gridEl       = document.getElementById('bookorbit-grid');
  emptyEl      = document.getElementById('bookorbit-empty');
  paginationEl = document.getElementById('bookorbit-pagination');
  sidebarEl       = document.getElementById('bookorbit-sidebar');
  drawerToggleBtn = document.getElementById('bookorbit-drawer-toggle');
  drawerCloseBtn  = document.getElementById('bookorbit-drawer-close');
  drawerOverlay   = document.getElementById('bookorbit-drawer-overlay');

  drawerToggleBtn.addEventListener('click', openDrawer);
  drawerCloseBtn.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);

  document.querySelectorAll('.bookorbit-nav-item').forEach(btn => {
    btn.addEventListener('click', () => selectSection(btn.dataset.section));
  });

  sortSelect.value = currentSort;
  initSortMenuFor('bookorbit-sort-select', 'bookorbit-sort-menu-btn', 'bookorbit-sort-menu-label', 'bookorbit-sort-menu-list');
  sortSelect.addEventListener('change', () => {
    currentSort = sortSelect.value;
    try { localStorage.setItem('br_bookorbit_sort', currentSort); } catch { /* storage full/unavailable */ }
    if (currentItem || SECTION_SOURCE[currentSection] === 'search') loadBooks(0);
  });
  document.addEventListener('langchange', () => {
    resyncSortMenu('bookorbit-sort-select', 'bookorbit-sort-menu-list', 'bookorbit-sort-menu-label');
  });

  btnSearch.addEventListener('click', doSearchOrFilter);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearchOrFilter(); });

  openDrawer(); // start open — on mobile there's nothing to browse until a section/item is picked
  if (!(await restoreResumeState())) await selectSection('libraries');
}
