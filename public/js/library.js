import { apiFetch } from './api.js';
import { toast, confirmDialog, setButtonLoading, showProgressToast } from './ui.js';
import { reloadShelves, getShelves, setActive, updateDownloadedCount, updateNavCounts, setShelfBadge } from './sidebar.js';
import { t } from './i18n.js';
import { showPanel } from './router.js';
import { openSyncModal, openOpdsBrowserAtFolder } from './opds.js';
import { clearProgress } from './progress-outbox.js';
import {
  isOfflineSupported,
  getAllBooks as getOfflineBooks,
  isBookDownloaded,
  downloadBook,
  deleteDownload,
  autoDownloadCurrentlyReading,
  pruneStaleDownloads,
  saveBookMeta,
  getCachedBookIds,
} from './offline.js';

// ── State ─────────────────────────────────────────────────────────────────────
let books               = [];
let booksLoaded         = false; // true only after first successful loadBooks()
let currentShelfId      = 'all';
let currentShelfBookIds = null; // null = use category logic
let currentLinkedOpds   = null; // { serverId, folderUrl, shelfId, shelfName, lastSyncedAt } or null
const _autoSyncCooldown = new Map(); // shelfId → timestamp of last auto-sync
let editMode            = false;
let selectedBooks       = new Set();
let seriesFilter        = null; // active series name filter
let sortBeforeSeriesFilter = null; // sort value saved before auto-switching to series_asc

// ── Card context-menu state ───────────────────────────────────────────────────
let _activeCardMenu = null; // { popup, onOutsideClick, onEsc }

// ── Offline state ─────────────────────────────────────────────────────────────
let isOfflineMode    = false;
let offlineBooks     = [];        // IDB snapshot used when server is unreachable
let downloadedIds    = new Set(); // bookIds currently stored offline
let downloadingIds   = new Set(); // bookIds with an active download in progress
let _offlineRetry    = null;      // setTimeout handle for polling when offline

// ── URL-based shelf navigation (from settings / opds pages) ───────────────────
const urlParams    = new URLSearchParams(location.search);
// Priority: explicit ?shelf= URL param > sessionStorage (return from reader) > localStorage (last used) > 'all'
const returningFromReader = !!sessionStorage.getItem('br_last_shelf');
const initialShelf  = urlParams.get('shelf') || sessionStorage.getItem('br_last_shelf') || localStorage.getItem('br_active_shelf') || 'all';
const initialSearch = sessionStorage.getItem('br_last_search') || '';
sessionStorage.removeItem('br_last_shelf');
sessionStorage.removeItem('br_last_search');
// Restore book info modal when returning from a bookmark/highlight jump
const returnBookId = Number(sessionStorage.getItem('br_return_book_id')) || 0;
const returnTab    = sessionStorage.getItem('br_return_tab') || '';
sessionStorage.removeItem('br_return_book_id');
sessionStorage.removeItem('br_return_tab');
if (urlParams.has('shelf')) history.replaceState(null, '', '/');

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes) {
  if (!bytes) return '';
  return bytes < 1024 * 1024
    ? (bytes / 1024).toFixed(1) + ' KB'
    : (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function sanitizeHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('script,style,iframe,object,embed,form,input,button,link').forEach(el => el.remove());
  tmp.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (href && !/^(https?:|\/|#)/.test(href)) el.removeAttribute('href');
    }
  });
  return tmp.innerHTML;
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortBooks(list) {
  const order = document.getElementById('sort-select')?.value || 'added_desc';
  const sorted = [...list];
  // In "Currently Reading" view, default to last-read order when the user hasn't overridden the sort
  if (currentShelfId === 'reading' && order === 'added_desc') {
    return sorted.sort((a, b) =>
      (b.last_opened_at || b.added_at || 0) - (a.last_opened_at || a.added_at || 0));
  }
  switch (order) {
    case 'added_desc':    sorted.sort((a, b) => b.added_at - a.added_at); break;
    case 'added_asc':     sorted.sort((a, b) => a.added_at - b.added_at); break;
    case 'title_asc':     sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
    case 'title_desc':    sorted.sort((a, b) => b.title.localeCompare(a.title)); break;
    case 'author_asc':    sorted.sort((a, b) => (a.author || '').localeCompare(b.author || '')); break;
    case 'progress_desc': sorted.sort((a, b) => (b.percentage || 0) - (a.percentage || 0)); break;
    case 'opened_desc':   sorted.sort((a, b) =>
      (b.last_opened_at || b.added_at || 0) - (a.last_opened_at || a.added_at || 0)); break;
    case 'series_asc':    sorted.sort((a, b) => {
      const sc = (a.series_name || '').localeCompare(b.series_name || '');
      if (sc !== 0) return sc;
      const an = parseFloat(a.series_number) || 0;
      const bn = parseFloat(b.series_number) || 0;
      return an - bn;
    }); break;
  }
  return sorted;
}

function initSortMenu() {
  const select = document.getElementById('sort-select');
  const btn = document.getElementById('sort-menu-btn');
  const label = document.getElementById('sort-menu-label');
  const list = document.getElementById('sort-menu-list');
  if (!select || !btn || !label || !list) return;

  function syncLabel() {
    const selected = select.options[select.selectedIndex];
    label.textContent = selected?.textContent || 'Razvrsti';
    list.querySelectorAll('.sort-menu-option').forEach(opt => {
      const active = opt.dataset.value === select.value;
      opt.classList.toggle('active', active);
      opt.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function closeMenu() {
    list.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    list.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }

  list.innerHTML = '';
  Array.from(select.options).forEach(option => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'sort-menu-option';
    item.dataset.value = option.value;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
    item.innerHTML = `<span>${escHtml(option.textContent || '')}</span><span class="sort-menu-check">✓</span>`;
    item.addEventListener('click', () => {
      if (select.value === option.value) {
        closeMenu();
        return;
      }
      select.value = option.value;
      syncLabel();
      closeMenu();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    list.appendChild(item);
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (list.classList.contains('hidden')) openMenu();
    else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!list.classList.contains('hidden') && !e.target.closest('.sort-menu-wrap')) closeMenu();
  });
  document.addEventListener('touchend', (e) => {
    if (!list.classList.contains('hidden') && !e.target.closest('.sort-menu-wrap')) closeMenu();
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  select.addEventListener('change', syncLabel);
  syncLabel();
}

// ── Render grid ───────────────────────────────────────────────────────────────
function renderGrid(list) {
  const grid       = document.getElementById('book-grid');
  const emptyState = document.getElementById('empty-state');
  grid.innerHTML   = '';
  grid.classList.toggle('edit-mode', editMode);

  if (!list.length) {
    // Don't show the empty-state message until we know books have been fetched —
    // avoids a brief "library is empty" flash while the API request is in flight.
    if (booksLoaded) emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  list.forEach(book => {
    const pct   = Math.round((book.percentage || 0) * 100);
    const cover = book.cover_path
      ? `<img class="book-cover" src="/covers/${book.cover_path}" alt="" loading="lazy" />`
      : `<div class="book-cover-placeholder">📖</div>`;

    const isDownloaded  = downloadedIds.has(book.id);
    const isDownloading = downloadingIds.has(book.id);
    let offlineBtn = '';
    if (isOfflineSupported && !isOfflineMode) {
      if (isDownloading) {
        offlineBtn = `<button class="btn-icon offline-btn downloading" disabled title="${t('library.downloading')}" data-id="${book.id}"><span class="spinner spinner-sm"></span></button>`;
      } else if (isDownloaded) {
        offlineBtn = `<button class="btn-icon offline-btn offline-btn-delete" title="${t('library.btn_delete_offline')}" data-id="${book.id}"><img src="/images/delete.svg" class="nav-icon nav-icon-delete" alt=""></button>`;
      } else {
        offlineBtn = `<button class="btn-icon offline-btn offline-btn-download" title="${t('library.btn_download_offline')}" data-id="${book.id}"><img src="/images/download.svg" class="nav-icon nav-icon-download" alt=""></button>`;
      }
    }

    const card = document.createElement('div');
    card.className  = 'book-card';
    card.dataset.id = book.id;
    if (selectedBooks.has(book.id)) card.classList.add('selected');

    card.innerHTML = `
      <div class="book-cover-area">
        ${cover}
        ${isDownloaded ? '<div class="book-offline-badge" title="Offline available">✓</div>' : ''}
        <a class="book-card-peek-btn" href="/readerv4.html?id=${book.id}&peek=1" title="${t('library.btn_peek')}"><img src="/images/peek.svg" class="nav-icon nav-icon-peek" alt="${t('library.btn_peek')}"></a>
      </div>
      <label class="book-card-checkbox-wrap" title="${t('library.btn_cover_select')}">
        <input type="checkbox" class="book-card-checkbox" ${selectedBooks.has(book.id) ? 'checked' : ''} />
      </label>
      <div class="book-card-actions">
        ${book.cover_path ? `<button class="btn-icon cover-preview-btn" title="${t('library.btn_cover_preview')}" data-id="${book.id}"><img src="/images/zoom.svg" class="nav-icon nav-icon-zoom" alt=""></button>` : ''}
        <button class="btn-icon info-btn"  title="${t('library.btn_cover_info')}" data-id="${book.id}">ℹ</button>
        ${offlineBtn}
        <button class="btn-icon read-btn"  title="${t('library.btn_read')}" data-id="${book.id}"><img src="/images/read.svg" class="nav-icon nav-icon-read" alt=""></button>
      </div>
      <div class="book-info">
        <div class="book-title">${escHtml(book.title)}</div>
        <div class="book-author">${escHtml(book.author || t('library.unknown_author'))}</div>
        ${book.series_name ? `<div class="book-series">${escHtml(book.series_name)}${book.series_number ? ` <span class="book-series-num">#${escHtml(book.series_number)}</span>` : ''}</div>` : ''}
        <div class="book-progress-bar">
          <div class="book-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="book-progress-text">${pct > 0 ? t('library.pct_read', { n: pct }) : t('library.not_started')}</div>
      </div>
      <button class="book-card-menu-btn" data-id="${book.id}" aria-label="More options">⋮</button>`;

    const checkbox = card.querySelector('.book-card-checkbox');

    card.querySelector('.book-card-checkbox-wrap').addEventListener('click', e => {
      e.stopPropagation();
      toggleBookSelect(book.id, checkbox.checked);
    });

    card.querySelector('.book-card-menu-btn').addEventListener('click', e => {
      e.stopPropagation();
      openCardMenu(book, e.currentTarget);
    });

    card.addEventListener('click', e => {
      if (e.target.closest('.read-btn') || e.target.closest('.info-btn') ||
          e.target.closest('.cover-preview-btn') || e.target.closest('.book-card-checkbox-wrap') ||
          e.target.closest('.book-card-peek-btn') || e.target.closest('.book-card-menu-btn')) return;
      if (editMode) {
        const newChecked = !checkbox.checked;
        checkbox.checked = newChecked;
        toggleBookSelect(book.id, newChecked);
        return;
      }
      // Touch devices: first tap reveals action icons, second tap opens the book
      if (window.matchMedia('(pointer: coarse)').matches && !card.classList.contains('tapped')) {
        document.querySelectorAll('.book-card.tapped').forEach(c => c.classList.remove('tapped'));
        card.classList.add('tapped');
        return;
      }
      window.location.href = `/readerv4.html?id=${book.id}`;
      sessionStorage.setItem('br_last_shelf', String(currentShelfId));
      sessionStorage.setItem('br_last_search', document.getElementById('search-input')?.value || '');
    });

    card.querySelector('.read-btn').addEventListener('click', e => {
      e.stopPropagation();
      sessionStorage.setItem('br_last_shelf', String(currentShelfId));
      sessionStorage.setItem('br_last_search', document.getElementById('search-input')?.value || '');
      window.location.href = `/readerv4.html?id=${book.id}`;
    });

    card.querySelector('.info-btn').addEventListener('click', e => {
      e.stopPropagation();
      openInfoModal(book);
    });

    card.querySelector('.cover-preview-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openCoverPreview(book);
    });

    card.querySelector('.offline-btn-download')?.addEventListener('click', async e => {
      e.stopPropagation();
      downloadingIds.add(book.id);
      applyFilter();
      try {
        await downloadBook(book, getToken());
        downloadedIds.add(book.id);
        toast.success(t('library.toast_downloaded'));
        updateDownloadedCount(downloadedIds.size);
      } catch (err) {
        console.error('[offline] download failed:', err.message);
        toast.error(t('library.toast_download_err'));
      } finally {
        downloadingIds.delete(book.id);
        applyFilter();
      }
    });

    card.querySelector('.offline-btn-delete')?.addEventListener('click', e => {
      e.stopPropagation();
      confirmDialog(
        t('library.btn_delete_offline'),
        async () => {
          await deleteDownload(book.id);
          downloadedIds.delete(book.id);
          toast.success(t('library.toast_deleted_offline'));
          updateDownloadedCount(downloadedIds.size);
          applyFilter();
        },
        t('library.btn_delete_offline'),
        true
      );
    });

    grid.appendChild(card);
  });
}

// ── Edit mode ─────────────────────────────────────────────────────────────────
function toggleEditMode() {
  editMode = !editMode;
  selectedBooks.clear();
  const editBtnLabel = document.getElementById('edit-mode-btn').querySelector('span[data-i18n]');
  if (editBtnLabel) editBtnLabel.textContent = editMode ? t('common.cancel') : t('library.btn_edit');
  document.getElementById('edit-toolbar').classList.toggle('hidden', !editMode);
  updateEditToolbar();
  applyFilter();
}

function toggleBookSelect(bookId, selected) {
  if (selected) selectedBooks.add(bookId);
  else           selectedBooks.delete(bookId);
  document.querySelector(`.book-card[data-id="${bookId}"]`)
    ?.classList.toggle('selected', selected);
  updateEditToolbar();
}

function updateEditToolbar() {
  const count     = selectedBooks.size;
  const removeBtn = document.getElementById('edit-remove-btn');
  const reextractBtn = document.getElementById('edit-reextract-btn');
  const selectAllBtn = document.getElementById('edit-select-all-btn');
  document.getElementById('edit-selected-count').textContent = t('library.edit_selected', { n: count });
  document.getElementById('edit-assign-btn').disabled = count === 0;
  document.getElementById('edit-delete-btn').disabled = count === 0;
  const onShelf = typeof currentShelfId === 'number';
  if (removeBtn) {
    removeBtn.disabled = count === 0 || !onShelf;
    removeBtn.classList.toggle('hidden', !onShelf);
  }
  if (reextractBtn) {
    reextractBtn.classList.toggle('hidden', currentShelfId !== 'all');
  }
  if (selectAllBtn) {
    const visibleIds = [...document.querySelectorAll('.book-card[data-id]')].map(c => Number(c.dataset.id));
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedBooks.has(id));
    selectAllBtn.textContent = allSelected ? t('library.btn_deselect_all') : t('library.btn_select_all');
    selectAllBtn.dataset.allSelected = allSelected ? '1' : '0';
  }
}


// ── Bulk assign modal ─────────────────────────────────────────────────────────
function openBulkAssignModal() {
  document.getElementById('bulk-assign-modal')?.remove();
  const allShelves = getShelves();
  if (!allShelves.length) { toast.error(t('library.err_no_shelves')); return; }

  const backdrop = document.createElement('div');
  backdrop.id        = 'bulk-assign-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:360px">
      <button class="modal-close" id="bam-close">&times;</button>
      <h2>${t('library.bulk_title')}</h2>
      <p style="font-size:.82rem;color:var(--color-text-muted);margin-bottom:1rem">
        ${t('library.bulk_desc', { n: selectedBooks.size })}
      </p>
      <div class="info-modal-shelves">
        ${allShelves.map(s => `
          <label class="info-modal-shelf-row">
            <input type="checkbox" class="bam-shelf-chk" value="${s.id}" />
            <span>${escHtml(s.name)}</span>
            <span class="shelf-book-count">(${s.book_count})</span>
          </label>`).join('')}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="bam-cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary"   id="bam-confirm">${t('library.btn_assign')}</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('#bam-close').addEventListener('click', close);
  backdrop.querySelector('#bam-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#bam-confirm').addEventListener('click', async () => {
    const checked = [...backdrop.querySelectorAll('.bam-shelf-chk:checked')].map(el => Number(el.value));
    if (!checked.length) return;
    for (const shelfId of checked) {
      for (const bookId of selectedBooks) {
        try {
          await apiFetch(`/shelves/${shelfId}/books`, {
            method: 'POST',
            body: JSON.stringify({ bookId }),
          });
        } catch { /* ignore duplicates */ }
      }
    }
    toast.success(t('library.toast_assigned', { n: selectedBooks.size, shelves: checked.length }));
    close();
    await reloadShelves();
  });
}

// ── Card context menu (three-dots button) ─────────────────────────────────────
function closeCardMenu() {
  if (!_activeCardMenu) return;
  const { popup, onOutsideClick, onEsc } = _activeCardMenu;
  popup.remove();
  document.removeEventListener('click', onOutsideClick, true);
  document.removeEventListener('keydown', onEsc);
  _activeCardMenu = null;
}

function openCardMenu(book, btn) {
  closeCardMenu();

  const isEink        = document.documentElement.dataset.libTheme === 'eink';
  const isDownloaded  = downloadedIds.has(book.id);
  const isDownloading = downloadingIds.has(book.id);

  let offlineItem = '';
  if (isOfflineSupported && !isOfflineMode) {
    if (isDownloading) {
      offlineItem = `<button class="bcm-item" disabled><span class="spinner spinner-sm"></span>${t('library.downloading')}</button>`;
    } else if (isDownloaded) {
      offlineItem = `<button class="bcm-item bcm-offline-delete"><img src="/images/delete.svg" class="nav-icon bcm-icon nav-icon-delete" alt="">${t('library.btn_delete_offline')}</button>`;
    } else {
      offlineItem = `<button class="bcm-item bcm-offline-download"><img src="/images/download.svg" class="nav-icon bcm-icon nav-icon-download" alt="">${t('library.btn_download_offline')}</button>`;
    }
  }

  const popup = document.createElement('div');
  popup.className = 'book-card-menu-popup' + (isEink ? ' no-anim' : '');
  popup.innerHTML = `
    <button class="bcm-item bcm-read">
      <img src="/images/read.svg" class="nav-icon bcm-icon nav-icon-read" alt="">
      ${t('library.btn_read')}
    </button>
    <a class="bcm-item" href="/readerv4.html?id=${book.id}&peek=1">
      <img src="/images/peek.svg" class="nav-icon bcm-icon nav-icon-peek" alt="">
      ${t('library.btn_peek')}
    </a>
    <button class="bcm-item bcm-info">
      <span class="bcm-icon-char">ℹ</span>
      ${t('library.btn_cover_info')}
    </button>
    ${offlineItem}
    ${isOfflineMode ? '' : `
    <a class="bcm-item" href="/api/books/${book.id}/file?download=1&token=${getToken()}" download>
      <img src="/images/download.svg" class="nav-icon bcm-icon nav-icon-download" alt="">
      ${t('library.btn_download')}
    </a>
    <button class="bcm-item bcm-delete">
      <img src="/images/delete.svg" class="nav-icon bcm-icon nav-icon-delete" alt="">
      ${t('library.btn_del_book')}
    </button>`}
  `;
  document.body.appendChild(popup);

  // Position: right-align popup to button, open upward by default
  const rect   = btn.getBoundingClientRect();
  const popupH = popup.offsetHeight;
  const enoughRoomAbove = rect.top >= popupH + 6;
  popup.style.right = (window.innerWidth - rect.right) + 'px';
  if (enoughRoomAbove) {
    popup.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  } else {
    popup.style.top           = (rect.bottom + 4) + 'px';
    popup.style.transformOrigin = 'top right';
  }

  // Item handlers
  popup.querySelector('.bcm-read').addEventListener('click', () => {
    sessionStorage.setItem('br_last_shelf', String(currentShelfId));
    sessionStorage.setItem('br_last_search', document.getElementById('search-input')?.value || '');
    closeCardMenu();
    window.location.href = `/readerv4.html?id=${book.id}`;
  });

  popup.querySelector('.bcm-info').addEventListener('click', () => {
    closeCardMenu();
    openInfoModal(book);
  });

  popup.querySelector('.bcm-delete')?.addEventListener('click', () => {
    closeCardMenu();
    confirmDialog(
      t('library.confirm_del_book', { title: escHtml(book.title) }),
      () => deleteBook(book.id)
    );
  });

  popup.querySelector('.bcm-offline-download')?.addEventListener('click', async () => {
    closeCardMenu();
    downloadingIds.add(book.id);
    applyFilter();
    try {
      await downloadBook(book, getToken());
      downloadedIds.add(book.id);
      toast.success(t('library.toast_downloaded'));
      updateDownloadedCount(downloadedIds.size);
    } catch (err) {
      console.error('[offline] download failed:', err.message);
      toast.error(t('library.toast_download_err'));
    } finally {
      downloadingIds.delete(book.id);
      applyFilter();
    }
  });

  popup.querySelector('.bcm-offline-delete')?.addEventListener('click', () => {
    closeCardMenu();
    confirmDialog(
      t('library.btn_delete_offline'),
      async () => {
        await deleteDownload(book.id);
        downloadedIds.delete(book.id);
        toast.success(t('library.toast_deleted_offline'));
        updateDownloadedCount(downloadedIds.size);
        applyFilter();
      },
      t('library.btn_delete_offline'),
      true
    );
  });

  // Close on outside click (capture phase so card stopPropagation doesn't block it)
  const onOutsideClick = (e) => {
    if (!popup.contains(e.target) && e.target !== btn) closeCardMenu();
  };
  const onEsc = (e) => { if (e.key === 'Escape') closeCardMenu(); };
  _activeCardMenu = { popup, onOutsideClick, onEsc };
  // Defer so this same click event doesn't immediately trigger the outside-click handler
  setTimeout(() => {
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onEsc);
  }, 0);
}

// ── Cover preview overlay ────────────────────────────────────────────────────
function openCoverPreview(book) {
  if (!book.cover_path) return;
  document.getElementById('cover-preview-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'cover-preview-overlay';
  overlay.className = 'cover-preview-overlay';
  overlay.innerHTML = `<img src="/covers/${book.cover_path}" alt="" class="cover-preview-img" />`;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey  = e => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

// ── Book info modal ───────────────────────────────────────────────────────────
async function openInfoModal(book, startTab = '') {
  document.getElementById('book-info-modal')?.remove();

  let fullBook = book;
  try {
    fullBook = await apiFetch(`/books/${book.id}`);
    saveBookMeta({ ...fullBook, percentage: book.percentage || 0 }).catch(() => {});
  } catch { /* use cached */ }

  let bookShelfIds = new Set();
  if (!isOfflineMode) {
    try {
      const ids = await apiFetch(`/shelves/for-book/${book.id}`);
      bookShelfIds = new Set(ids);
    } catch { /* ignore */ }
  }

  const allShelves  = getShelves();
  const token       = encodeURIComponent(localStorage.getItem('br_token') || '');
  const progressPct = Math.round((book.percentage || 0) * 100);

  // ── HTML helpers ─────────────────────────────────────────────────────────────
  const fmtDate    = (ts) => ts ? new Date(ts * 1000).toLocaleDateString() : '—';
  const fmtClock   = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
  const fmtTime = (secs) => {
    if (!secs) return '0m';
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const colorDot = (c) => {
    const map = { yellow: '#f5c518', green: '#4caf50', blue: '#2196f3', pink: '#e91e63' };
    return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${map[c] || map.yellow};flex-shrink:0"></span>`;
  };

  const metaRows = [
    fullBook.publisher      && [t('library.info_publisher'),   escHtml(fullBook.publisher)],
    fullBook.language       && [t('library.info_language'),    escHtml(fullBook.language)],
    fullBook.pages          && [t('library.info_pages'),       escHtml(String(fullBook.pages))],
    fullBook.isbn           && [t('library.info_isbn'),        escHtml(fullBook.isbn)],
    fullBook.file_size      && [t('library.info_file_size'),   formatSize(fullBook.file_size)],
    fullBook.added_at       && [t('library.info_added'),       fmtDate(fullBook.added_at)],
    fullBook.last_opened_at && [t('library.info_last_opened'), fmtDate(fullBook.last_opened_at)],
  ].filter(Boolean);

  const backdrop = document.createElement('div');
  backdrop.id        = 'book-info-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal info-modal" role="dialog" aria-modal="true">
      <button class="modal-close" id="info-modal-close" aria-label="${t('common.close')}">&times;</button>

      <div class="info-modal-header">
        <div class="info-modal-cover-wrap">
          ${fullBook.cover_path
            ? `<img class="info-modal-cover info-modal-cover-clickable" src="/covers/${fullBook.cover_path}" alt="" />`
            : `<div class="info-modal-cover info-modal-cover-ph">\u{1F4D6}</div>`}
          <span class="book-format-badge book-format-badge--${escHtml(fullBook.format || 'epub')}">${escHtml((fullBook.format || 'epub').toUpperCase())}</span>
        </div>
        <div class="info-modal-hero">
          <h3 class="info-modal-title">${escHtml(fullBook.title)}</h3>
          <div class="info-modal-author">${escHtml(fullBook.author || t('library.unknown_author'))}</div>
          ${fullBook.series_name ? `<div class="info-modal-series"><button class="series-filter-btn" data-series="${escHtml(fullBook.series_name)}" title="${t('library.series_filter_title')}">${escHtml(fullBook.series_name)}${fullBook.series_number ? ` #${escHtml(fullBook.series_number)}` : ''}</button></div>` : ''}
          ${fullBook.genres ? `<div class="info-modal-genres" style="margin-top:.3rem">${fullBook.genres.split(',').map(g => g.trim()).filter(Boolean).map(g => `<span class="genre-pill">${escHtml(g)}</span>`).join('')}</div>` : ''}
          <div class="info-modal-actions">
            <a class="imt-action-btn imt-btn-read" href="/readerv4.html?id=${fullBook.id}" title="${t('library.btn_read')}"><img src="/images/read.svg" class="nav-icon nav-icon-read" alt="${t('library.btn_read')}"></a>
            <a class="imt-action-btn" href="/readerv4.html?id=${fullBook.id}&peek=1" title="${t('library.btn_peek')}"><img src="/images/peek.svg" class="nav-icon nav-icon-peek" alt="${t('library.btn_peek')}"></a>
            ${isOfflineSupported && !isOfflineMode ? (downloadedIds.has(fullBook.id)
              ? `<button class="imt-action-btn" id="info-modal-offline" title="${t('library.btn_delete_offline')}"><img src="/images/delete.svg" class="nav-icon nav-icon-delete" alt="${t('library.btn_delete_offline')}"></button>`
              : `<button class="imt-action-btn" id="info-modal-offline" title="${t('library.btn_download_offline')}"><img src="/images/download.svg" class="nav-icon nav-icon-download" alt="${t('library.btn_download_offline')}"></button>`) : ''}
            ${isOfflineMode ? '' : `<a class="imt-action-btn" href="/api/books/${fullBook.id}/file?download=1&token=${token}" download title="${t('library.btn_download')}"><img src="/images/download.svg" class="nav-icon nav-icon-download" alt="${t('library.btn_download')}"></a>`}
            ${isOfflineMode ? '' : `<button class="imt-action-btn imt-delete-btn" id="info-modal-delete" title="${t('library.btn_del_book')}"><img src="/images/delete.svg" class="nav-icon nav-icon-delete" alt="${t('library.btn_del_book')}"></button>`}
          </div>
        </div>
      </div>

      <div class="info-modal-tabs" role="tablist">
        <button class="imt-tab active" data-tab="details" role="tab">${t('library.tab_details')}</button>
        ${isOfflineMode ? '' : `<button class="imt-tab" data-tab="shelves" role="tab">${t('library.tab_shelves')}</button>`}
        ${isOfflineMode ? '' : `<button class="imt-tab" data-tab="kosync" role="tab">${t('library.tab_kosync')}</button>`}
        <button class="imt-tab" data-tab="reading" role="tab">${t('library.tab_reading')}</button>
      </div>

      <div class="info-modal-tab-content">

        <div class="imt-panel" id="imt-details">
          ${progressPct > 0 ? `
          <div class="info-modal-section-title">${t('library.info_progress')}</div>
          <div class="info-modal-progress-row">
            <div class="info-modal-progress-bar-wrap"><div class="info-modal-progress-bar-fill" style="width:${progressPct}%"></div></div>
            <span class="info-modal-progress-pct">${progressPct}%</span>
            ${isOfflineMode ? '' : `<button class="btn btn-secondary btn-sm" id="info-modal-reset-progress" style="margin-left:auto">${t('library.btn_reset_progress')}</button>`}
          </div>` : ''}
          ${metaRows.length ? `
          <div class="imt-meta-grid">
            ${metaRows.map(([label, val]) => `<div class="imt-meta-pair"><span class="imt-meta-label">${label}</span><span>${val}</span></div>`).join('')}
          </div>` : ''}
          ${fullBook.description ? `
          <div class="info-modal-section-title" style="margin-top:.75rem">${t('library.info_desc')}</div>
          <div class="info-modal-desc">${sanitizeHtml(fullBook.description)}</div>` : ''}
        </div>

        ${isOfflineMode ? '' : `
        <div class="imt-panel" id="imt-shelves" style="display:none">
          ${allShelves.length
            ? `<div class="info-modal-shelves">${allShelves.map(s => `
                <label class="info-modal-shelf-row">
                  <input type="checkbox" class="shelf-chk" value="${s.id}" ${bookShelfIds.has(s.id) ? 'checked' : ''} />
                  <span>${escHtml(s.name)}</span>
                  <span class="shelf-book-count">(${s.book_count})</span>
                </label>`).join('')}
              </div>
              <div style="margin-top:.75rem">
                <button class="btn btn-primary btn-sm" id="info-modal-save">${t('library.btn_save_shelves')}</button>
              </div>`
            : `<div class="imt-empty">${t('library.info_no_shelves')}</div>`}
        </div>`}

        ${isOfflineMode ? '' : `
        <div class="imt-panel" id="imt-kosync" style="display:none">
          <div class="info-modal-kosync-body" style="padding-top:.25rem">
            <div class="info-modal-kosync-row">
              <span class="info-modal-kosync-label">${t('library.kosync_computed_md5')}</span>
              <span class="info-modal-kosync-value" id="ik-md5">${escHtml(fullBook.file_hash_md5 || '—')}</span>
            </div>
            <div class="info-modal-kosync-row" id="ik-override-row" style="${fullBook.kosync_hash ? '' : 'display:none'}">
              <span class="info-modal-kosync-label">${t('library.kosync_override')}</span>
              <span class="info-modal-kosync-value" id="ik-override-val">${escHtml(fullBook.kosync_hash || '')}</span>
              <span class="info-modal-kosync-badge">${t('library.kosync_active')}</span>
            </div>
            <div class="info-modal-kosync-edit">
              <input class="info-modal-kosync-input" id="ik-input" maxlength="32" spellcheck="false" autocomplete="off"
                placeholder="${t('library.kosync_placeholder')}"
                value="${escHtml(fullBook.kosync_hash || fullBook.file_hash_md5 || '')}" />
              <div class="info-modal-kosync-error" id="ik-error" style="display:none"></div>
              <div class="info-modal-kosync-btns">
                <button class="btn btn-primary btn-sm" id="ik-save">${t('library.kosync_save')}</button>
                <button class="btn btn-secondary btn-sm" id="ik-clear" style="${fullBook.kosync_hash ? '' : 'display:none'}">${t('library.kosync_clear')}</button>
              </div>
            </div>
            <div class="info-modal-kosync-divider"></div>
            <div style="font-size:.82rem;font-weight:600;margin-bottom:.35rem">${t('library.kosync_replace_epub')}</div>
            <div class="info-modal-kosync-opds-row">
              <select class="info-modal-kosync-server-select" id="ik-server">
                <option value="">${t('library.kosync_loading_servers')}</option>
              </select>
              <input class="info-modal-kosync-search-input" id="ik-q"
                placeholder="${t('library.kosync_search_placeholder')}"
                value="${escHtml(fullBook.title || '')}" />
              <button class="btn btn-secondary btn-sm" id="ik-search">${t('library.kosync_search')}</button>
            </div>
            <div class="info-modal-kosync-results" id="ik-results"></div>
          </div>
        </div>`}

        <div class="imt-panel" id="imt-reading" style="display:none">
          <div id="imt-reading-inner"><div class="imt-empty" style="padding:1rem 0">Loading…</div></div>
        </div>

      </div>
    </div>`;

  document.body.appendChild(backdrop);

  // ── Tab switching ─────────────────────────────────────────────────────────────
  let readingLoaded = false;

  const switchTab = (id) => {
    backdrop.querySelectorAll('.imt-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    backdrop.querySelectorAll('.imt-panel').forEach(p => { p.style.display = p.id === `imt-${id}` ? '' : 'none'; });
    if (id === 'reading' && !readingLoaded) { readingLoaded = true; loadReadingTab(); }
  };

  backdrop.querySelectorAll('.imt-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Save return state when a Jump link is clicked so the library re-opens this modal on back.
  backdrop.addEventListener('click', e => {
    if (e.target.closest('.imt-jump-btn')) {
      try {
        sessionStorage.setItem('br_return_book_id', String(fullBook.id));
        sessionStorage.setItem('br_return_tab',     'reading');
        sessionStorage.setItem('br_last_shelf',     String(currentShelfId));
        sessionStorage.setItem('br_last_search',    document.getElementById('search-input')?.value || '');
      } catch { /* ignore */ }
    }
  });

  // If opened with a requested tab (e.g. returning from a jump), activate it now.
  if (startTab) switchTab(startTab);

  // ── Prevent wheel scroll from leaking through the semi-transparent backdrop area
  const tabContent = backdrop.querySelector('.info-modal-tab-content');
  backdrop.addEventListener('wheel', e => {
    if (tabContent?.contains(e.target)) return;
    e.preventDefault();
  }, { passive: false });

  // ── Close ─────────────────────────────────────────────────────────────────────
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown);
  };
  const onKeyDown = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKeyDown);
  backdrop.querySelector('#info-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  // ── Header action handlers ────────────────────────────────────────────────────
  backdrop.querySelector('.info-modal-cover-clickable')?.addEventListener('click', e => {
    e.stopPropagation();
    openCoverPreview(fullBook);
  });

  backdrop.querySelector('.series-filter-btn')?.addEventListener('click', () => {
    close();
    filterBySeries(fullBook.series_name);
  });

  backdrop.querySelector('#info-modal-delete')?.addEventListener('click', () => {
    close();
    confirmDialog(
      `${t('library.confirm_del_book', { title: escHtml(fullBook.title) })}`,
      () => deleteBook(fullBook.id)
    );
  });

  backdrop.querySelector('#info-modal-offline')?.addEventListener('click', async () => {
    if (downloadedIds.has(fullBook.id)) {
      close();
      confirmDialog(
        t('library.btn_delete_offline'),
        async () => {
          await deleteDownload(fullBook.id);
          downloadedIds.delete(fullBook.id);
          toast.success(t('library.toast_deleted_offline'));
          updateDownloadedCount(downloadedIds.size);
          applyFilter();
        },
        t('library.btn_delete_offline'),
        true
      );
    } else {
      downloadingIds.add(fullBook.id);
      applyFilter();
      try {
        await downloadBook(fullBook, getToken());
        downloadedIds.add(fullBook.id);
        toast.success(t('library.toast_downloaded'));
        updateDownloadedCount(downloadedIds.size);
      } catch (err) {
        console.error('[offline] download failed:', err.message);
        toast.error(t('library.toast_download_err'));
      } finally {
        downloadingIds.delete(fullBook.id);
        applyFilter();
        close();
      }
    }
  });

  // ── Details tab handlers ──────────────────────────────────────────────────────
  backdrop.querySelector('#info-modal-reset-progress')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      // App's own progress store. force=1 so 0% overwrites the high-water mark.
      await apiFetch(`/progress/${fullBook.file_hash}?force=1`, {
        method: 'PUT',
        body: JSON.stringify({ cfi_position: '', percentage: 0, device: 'web', force: true }),
      });
      // Also reset KOReader sync (internal store + external server) to 0%.
      const docKey = fullBook.kosync_hash || fullBook.file_hash_md5;
      if (docKey) {
        const dk = encodeURIComponent(docKey);
        // Internal store: force=1 so it bypasses the high-water mark too.
        await apiFetch(`/kosync/internal/${dk}?force=1`, {
          method: 'PUT',
          body: JSON.stringify({ progress: '', percentage: 0, device: 'web' }),
        }).catch(() => {});
        // External server (no-ops if unconfigured). Best-effort.
        await apiFetch(`/kosync/remote/${dk}`, {
          method: 'PUT',
          body: JSON.stringify({ document: docKey, progress: '', percentage: 0, device: 'web', device_id: 'codexa-web' }),
        }).catch(() => {});
      }
      // Drop any pending offline position so it can't resync the old spot later.
      clearProgress(fullBook.id);
      const cached = books.find(b => b.id === fullBook.id);
      if (cached) { cached.percentage = 0; cached.cfi_position = ''; }
      applyFilter();
      const card = document.querySelector(`.book-card[data-id="${fullBook.id}"]`);
      if (card) {
        card.querySelector('.book-progress-fill').style.width = '0%';
        card.querySelector('.book-progress-text').textContent = t('library.not_started');
      }
      backdrop.querySelector('.info-modal-progress-row')?.previousElementSibling?.remove();
      backdrop.querySelector('.info-modal-progress-row')?.remove();
      toast.success(t('library.toast_progress_reset'));
    } catch (err) {
      toast.error(t('common.err_prefix') + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ── Shelves tab handler ───────────────────────────────────────────────────────
  backdrop.querySelector('#info-modal-save')?.addEventListener('click', async () => {
    const checked  = new Set([...backdrop.querySelectorAll('.shelf-chk:checked')].map(el => Number(el.value)));
    const toAdd    = [...checked].filter(id => !bookShelfIds.has(id));
    const toRemove = [...bookShelfIds].filter(id => !checked.has(id));
    try {
      for (const shelfId of toAdd)
        await apiFetch(`/shelves/${shelfId}/books`, { method: 'POST', body: JSON.stringify({ bookId: fullBook.id }) });
      for (const shelfId of toRemove)
        await apiFetch(`/shelves/${shelfId}/books/${fullBook.id}`, { method: 'DELETE' });
      toast.success(t('library.toast_shelves_saved'));
      close();
      await reloadShelves();
      await refreshShelfFilter();
    } catch (err) { toast.error(t('common.err_prefix') + err.message); }
  });

  // ── KOSync tab handlers ───────────────────────────────────────────────────────
  if (!isOfflineMode) {
    const ikInput   = backdrop.querySelector('#ik-input');
    const ikError   = backdrop.querySelector('#ik-error');
    const ikSave    = backdrop.querySelector('#ik-save');
    const ikClear   = backdrop.querySelector('#ik-clear');
    const ikServer  = backdrop.querySelector('#ik-server');
    const ikQ       = backdrop.querySelector('#ik-q');
    const ikSearch  = backdrop.querySelector('#ik-search');
    const ikResults = backdrop.querySelector('#ik-results');

    const ikValidate  = (val) => /^[0-9a-fA-F]{32}$/.test(val.trim());
    const ikShowError = (msg) => { ikError.textContent = msg; ikError.style.display = msg ? '' : 'none'; };

    let serversLoaded = false;
    const ikLoadServers = async () => {
      if (serversLoaded) return; serversLoaded = true;
      try {
        const servers = await apiFetch('/opds/servers');
        ikServer.innerHTML = servers?.length
          ? servers.map((s, i) => `<option value="${i}">${escHtml(s.name || s.url)}</option>`).join('')
          : `<option value="">${t('library.kosync_no_servers')}</option>`;
      } catch { ikServer.innerHTML = `<option value="">${t('library.kosync_no_servers')}</option>`; }
    };

    backdrop.querySelectorAll('.imt-tab[data-tab="kosync"]').forEach(b => b.addEventListener('click', ikLoadServers));

    ikInput?.addEventListener('input', () => {
      const v = ikInput.value.trim();
      if (v && !ikValidate(v)) ikShowError(t('library.kosync_invalid_md5'));
      else ikShowError('');
    });

    ikSave?.addEventListener('click', async () => {
      const v = ikInput.value.trim().toLowerCase();
      if (!ikValidate(v)) { ikShowError(t('library.kosync_invalid_md5')); return; }
      ikShowError('');
      setButtonLoading(ikSave, true);
      try {
        await apiFetch(`/books/${fullBook.id}`, { method: 'PATCH', body: JSON.stringify({ kosync_hash: v }) });
        fullBook.kosync_hash = v;
        backdrop.querySelector('#ik-override-val').textContent = v;
        backdrop.querySelector('#ik-override-row').style.display = '';
        ikClear.style.display = '';
        toast.success(t('library.kosync_saved'));
      } catch (err) { toast.error(t('common.err_prefix') + err.message); }
      finally { setButtonLoading(ikSave, false, t('library.kosync_save')); }
    });

    ikClear?.addEventListener('click', async () => {
      setButtonLoading(ikClear, true);
      try {
        await apiFetch(`/books/${fullBook.id}`, { method: 'PATCH', body: JSON.stringify({ kosync_hash: '' }) });
        fullBook.kosync_hash = '';
        backdrop.querySelector('#ik-override-row').style.display = 'none';
        ikClear.style.display = 'none';
        ikInput.value = fullBook.file_hash_md5 || '';
        toast.success(t('library.kosync_cleared'));
      } catch (err) { toast.error(t('common.err_prefix') + err.message); }
      finally { setButtonLoading(ikClear, false, t('library.kosync_clear')); }
    });

    const ikDoSearch = async () => {
      const serverId = ikServer.value;
      const q = ikQ.value.trim();
      if (!q || serverId === '') return;
      setButtonLoading(ikSearch, true);
      ikResults.innerHTML = '';
      try {
        const feed    = await apiFetch(`/opds/search/${encodeURIComponent(serverId)}?q=${encodeURIComponent(q)}`);
        const entries = feed?.entries || [];
        if (!entries.length) {
          ikResults.innerHTML = `<div class="info-modal-kosync-no-results">${t('library.kosync_no_results')}</div>`;
        } else {
          ikResults.innerHTML = entries.map(e => `
            <div class="info-modal-kosync-result">
              ${e.cover ? `<img class="info-modal-kosync-result-cover" src="${escHtml(e.cover)}" alt="" loading="lazy" />` : '<div class="info-modal-kosync-result-cover" style="background:var(--color-surface2)"></div>'}
              <div class="info-modal-kosync-result-meta">
                <div class="info-modal-kosync-result-title">${escHtml(e.title || '?')}</div>
                <div class="info-modal-kosync-result-author">${escHtml(e.author || '')}</div>
              </div>
              ${e.acqHref ? `<button class="btn btn-primary btn-sm ik-replace-btn" data-href="${escHtml(e.acqHref)}">${t('library.kosync_replace_btn')}</button>` : ''}
            </div>`).join('');
        }
      } catch (err) {
        ikResults.innerHTML = `<div class="info-modal-kosync-no-results">${t('common.err_prefix')}${err.message}</div>`;
      }
      setButtonLoading(ikSearch, false, t('library.kosync_search'));
    };

    ikSearch?.addEventListener('click', ikDoSearch);
    ikQ?.addEventListener('keydown', e => { if (e.key === 'Enter') ikDoSearch(); });

    ikResults?.addEventListener('click', async e => {
      const btn = e.target.closest('.ik-replace-btn');
      if (!btn) return;
      const href = btn.dataset.href;
      if (!href) return;
      setButtonLoading(btn, true);
      try {
        const result = await apiFetch(`/books/${fullBook.id}/file`, {
          method: 'PATCH',
          body: JSON.stringify({ href, serverId: Number(ikServer.value) }),
        });
        fullBook.file_hash_md5 = result.file_hash_md5;
        fullBook.kosync_hash   = '';
        fullBook.cover_path    = result.cover_path;
        backdrop.querySelector('#ik-md5').textContent = result.file_hash_md5;
        backdrop.querySelector('#ik-override-row').style.display = 'none';
        ikClear.style.display = 'none';
        ikInput.value = result.file_hash_md5;
        // Refresh the cover image in the still-open modal (?v= busts cache if hash unchanged)
        const coverImg = backdrop.querySelector('.info-modal-cover');
        if (coverImg instanceof HTMLImageElement && result.cover_path) {
          coverImg.src = `/covers/${result.cover_path}?v=${Date.now()}`;
        }
        if (navigator.serviceWorker?.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'DELETE_BOOK', bookId: fullBook.id });
        }
        toast.success(t('library.kosync_replace_done', { md5: result.file_hash_md5 }));
        setButtonLoading(btn, false, '✓');
        void loadBooks();
      } catch (err) {
        toast.error(t('common.err_prefix') + err.message);
        setButtonLoading(btn, false, t('library.kosync_replace_btn'));
      }
    });
  }

  // ── Reading tab — lazy load ───────────────────────────────────────────────────
  async function loadReadingTab() {
    const inner = backdrop.querySelector('#imt-reading-inner');
    try {
      const [sessions, bookmarks, annotations] = await Promise.all([
        apiFetch(`/stats/sessions/${fullBook.id}`).catch(() => []),
        apiFetch(`/bookmarks/${fullBook.id}`).catch(() => []),
        apiFetch(`/annotations/${fullBook.id}`).catch(() => []),
      ]);

      const totalSecs = sessions.reduce((s, r) => s + ((r.end_ts || 0) - (r.start_ts || 0)), 0);

      inner.innerHTML = `
        <div class="imt-section-title">${t('library.reading_bookmarks')}</div>
        <div id="imt-bm-list">
        ${bookmarks.length
          ? bookmarks.map(bm => {
              const label = (bm.label || '—').replace(/\s*·\s*\d+(\.\d+)?%\s*$/, '').trim() || '—';
              return `
            <div class="imt-reading-row" data-bm="${bm.id}">
              <span class="imt-reading-pct">${Math.round(bm.pct * 100)}%</span>
              <span class="imt-reading-text">${escHtml(label)}</span>
              <a class="btn btn-secondary btn-xs imt-jump-btn"
                href="/readerv4.html?id=${fullBook.id}&peek=1&jumpcfi=${encodeURIComponent(bm.cfi)}"
                title="${t('library.btn_jump')}">${t('library.btn_jump')}</a>
              <button class="imt-del-btn" data-type="bookmarks" data-id="${bm.id}" title="${t('common.delete')}">×</button>
            </div>`;}).join('')
          : `<div class="imt-empty">${t('library.reading_no_bookmarks')}</div>`}
        </div>

        <div class="imt-section-title" style="margin-top:.75rem">${t('library.reading_highlights')}</div>
        <div id="imt-ann-list">
        ${annotations.length
          ? annotations.map(a => `
            <div class="imt-reading-row" data-ann="${a.id}">
              <span class="imt-reading-pct">${Math.round(a.pct * 100)}%</span>
              <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${{ yellow: '#f5c518', green: '#4caf50', blue: '#2196f3', pink: '#e91e63' }[a.color] || '#f5c518'};flex-shrink:0"></span>
              <span class="imt-reading-text">${escHtml(a.text || '')}${a.note ? `<em class="imt-reading-note"> — ${escHtml(a.note)}</em>` : ''}</span>
              <a class="btn btn-secondary btn-xs imt-jump-btn"
                href="/readerv4.html?id=${fullBook.id}&peek=1&jumpcfi=${encodeURIComponent(a.cfi)}"
                title="${t('library.btn_jump')}">${t('library.btn_jump')}</a>
              <button class="imt-del-btn" data-type="annotations" data-id="${a.id}" title="${t('common.delete')}">×</button>
            </div>`).join('')
          : `<div class="imt-empty">${t('library.reading_no_highlights')}</div>`}
        </div>

        <div class="imt-section-title" style="margin-top:.75rem">${t('library.reading_sessions')}</div>
        ${sessions.length ? `
          <div class="imt-reading-summary">${t('library.reading_total_time')}: <strong>${fmtTime(totalSecs)}</strong> &nbsp;&middot;&nbsp; ${sessions.length} ${t('library.reading_sessions').toLowerCase()}</div>
          <div class="imt-session-list">
            <div class="imt-session-header">
              <span>${t('library.session_col_date')}</span>
              <span>${t('library.session_col_dur')}</span>
              <span>${t('library.session_col_pages')}</span>
            </div>
            ${sessions.map(r => `
              <div class="imt-session-row">
                <span class="imt-session-date">${fmtDate(r.start_ts)}<span class="imt-session-time">${fmtClock(r.start_ts)} – ${fmtClock(r.end_ts)}</span></span>
                <span class="imt-session-dur">${fmtTime((r.end_ts || r.start_ts) - r.start_ts)}</span>
                <span class="imt-session-pages">${r.pages_nav ? `${r.pages_nav} ${t('library.session_pages_abbr')}` : '—'}</span>
              </div>`).join('')}
          </div>`
          : `<div class="imt-empty">${t('library.reading_no_sessions')}</div>`}`;

      inner.addEventListener('click', async e => {
        const btn = e.target.closest('.imt-del-btn');
        if (!btn) return;
        const { type, id } = btn.dataset;
        btn.disabled = true;
        try {
          await apiFetch(`/${type}/${fullBook.id}/${id}`, { method: 'DELETE' });
          const row  = btn.closest('.imt-reading-row');
          const list = row.parentElement;
          row.remove();
          if (!list.querySelector('.imt-reading-row')) {
            const key = type === 'bookmarks' ? 'library.reading_no_bookmarks' : 'library.reading_no_highlights';
            list.innerHTML = `<div class="imt-empty">${t(key)}</div>`;
          }
        } catch (err) {
          toast.error(t('common.err_prefix') + err.message);
          btn.disabled = false;
        }
      });

    } catch (err) {
      inner.innerHTML = `<div class="imt-empty">${t('common.err_prefix')}${err.message}</div>`;
    }
  }
}

// ── Shelf selection ───────────────────────────────────────────────────────────
export async function selectShelf(shelfId) {
  currentShelfId = shelfId;
  seriesFilter   = null;
  updateSeriesFilterBar();
  setActive(shelfId);
  localStorage.setItem('br_active_shelf', String(shelfId));

  const titleEl = document.getElementById('page-title');
  if (shelfId === 'all') {
    titleEl.innerHTML = `<img src="/images/all_library.svg" class="nav-icon nav-icon-all-library" alt=""> ${t('sidebar.all_library')}`;
    currentShelfBookIds = null;
    currentLinkedOpds = null;
  } else if (shelfId === 'reading') {
    titleEl.innerHTML = `<img src="/images/currently_reading.svg" class="nav-icon nav-icon-currently-reading" alt=""> ${t('sidebar.currently_reading')}`;
    currentShelfBookIds = null;
    currentLinkedOpds = null;
  } else if (shelfId === 'downloaded') {
    titleEl.innerHTML = `<img src="/images/download.svg" class="nav-icon nav-icon-download" alt=""> ${t('sidebar.downloaded')}`;
    currentShelfBookIds = null;
    currentLinkedOpds = null;
  } else {
    const shelf = getShelves().find(s => s.id === shelfId);
    const shelfIcon = shelf?.opds_folder_url ? 'opds_shelf' : 'shelf';
    const shelfIconClass = shelf?.opds_folder_url ? 'nav-icon nav-icon-shelf nav-icon-opds-shelf' : 'nav-icon nav-icon-shelf';
    titleEl.innerHTML = `<img src="/images/${shelfIcon}.svg" class="${shelfIconClass}" alt=""> ${escHtml(shelf ? shelf.name : 'Polica')}`;
    currentLinkedOpds = shelf?.opds_folder_url
      ? { serverId: shelf.opds_server_id, folderUrl: shelf.opds_folder_url,
          shelfId: shelf.id, shelfName: shelf.name, lastSyncedAt: shelf.last_synced_at || null }
      : null;
    if (currentLinkedOpds) {
      setShelfBadge(shelf.id, 0); // clear badge when user opens the shelf
      _updateSyncDateDisplay(currentLinkedOpds.lastSyncedAt);
      _autoSyncLinkedShelf(currentLinkedOpds); // fire-and-forget background sync
    }
    await refreshShelfFilter(false);
  }

  const banner = document.getElementById('opds-shelf-banner');
  if (banner) banner.classList.toggle('hidden', !currentLinkedOpds);

  if (editMode) toggleEditMode();
  applyFilter();
}

async function refreshShelfFilter(andApply = true) {
  if (typeof currentShelfId === 'number') {
    try {
      const ids = await apiFetch(`/shelves/${currentShelfId}/books`);
      currentShelfBookIds = new Set(ids);
    } catch { currentShelfBookIds = new Set(); }
  } else {
    currentShelfBookIds = null;
  }
  if (andApply) applyFilter();
}

function filterBySeries(seriesName) {
  const select = document.getElementById('sort-select');
  if (seriesName) {
    // Auto-switch to series sort, remembering current sort to restore later
    if (select && select.value !== 'series_asc') {
      sortBeforeSeriesFilter = select.value;
      select.value = 'series_asc';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else if (sortBeforeSeriesFilter !== null) {
    // Restore previous sort when clearing the series filter
    if (select) {
      select.value = sortBeforeSeriesFilter;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sortBeforeSeriesFilter = null;
  }
  seriesFilter = seriesName || null;
  document.getElementById('search-input').value = '';
  updateSeriesFilterBar();
  applyFilter();
}

function updateSeriesFilterBar() {
  const bar  = document.getElementById('series-filter-bar');
  const name = document.getElementById('series-filter-name');
  if (!bar) return;
  if (seriesFilter) {
    bar.classList.remove('hidden');
    name.textContent = seriesFilter;
  } else {
    bar.classList.add('hidden');
    name.textContent = '';
  }
}

function applyFilter() {
  const allCountEl = document.getElementById('nav-all-count');
  const readingCountEl = document.getElementById('nav-reading-count');
  const sourceBooks = isOfflineMode ? offlineBooks : books;
  if (allCountEl)     allCountEl.textContent     = sourceBooks.length;
  if (readingCountEl) readingCountEl.textContent = sourceBooks.filter(b => { const p = b.percentage || 0; return p > 0 && p < 1; }).length;

  const q = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
  let list = sourceBooks;

  if (currentShelfId === 'reading') {
    list = list.filter(b => { const p = b.percentage || 0; return p > 0 && p < 1; });
  } else if (currentShelfId === 'downloaded') {
    list = isOfflineMode ? offlineBooks : list.filter(b => downloadedIds.has(b.id));
  } else if (currentShelfBookIds !== null) {
    list = list.filter(b => currentShelfBookIds.has(b.id));
  }

  if (seriesFilter) {
    list = list.filter(b => b.series_name === seriesFilter);
  } else if (q) {
    list = list.filter(b =>
      b.title.toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q) ||
      (b.series_name || '').toLowerCase().includes(q)
    );
  }

  renderGrid(sortBooks(list));
}


// ── Statistics dialog ─────────────────────────────────────────────────────────
async function openStatsDialog() {
  document.getElementById('stats-modal')?.remove();

  let stats = null;
  let history = [];
  try {
    [stats, history] = await Promise.all([
      apiFetch('/stats'),
      apiFetch('/stats/history'),
    ]);
  } catch (err) {
    toast.error(t('common.err_prefix') + err.message);
    return;
  }

  function fmtDuration(secs) {
    if (!secs || secs < 60) return `${secs || 0}s`;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  const summaryCards = [
    { label: t('stats.total_time'),    value: fmtDuration(stats.total_secs) },
    { label: t('stats.sessions'),      value: stats.total_sessions },
    { label: t('stats.avg_session'),   value: fmtDuration(stats.avg_session_secs) },
    { label: t('stats.pages_nav'),     value: stats.total_pages },
    { label: t('stats.books_started'), value: stats.books_started },
    { label: t('stats.books_done'),    value: stats.books_completed },
  ];

  const summaryHtml = `
    <div class="stats-summary-grid">
      ${summaryCards.map(c => `
        <div class="stats-card">
          <div class="stats-card-value">${c.value}</div>
          <div class="stats-card-label">${c.label}</div>
        </div>`).join('')}
    </div>`;

  const topBooksHtml = stats.top_books?.length ? `
    <div class="stats-section-title">${t('stats.top_books')}</div>
    <div class="stats-top-books">
      ${stats.top_books.map(b => `
        <div class="stats-book-row">
          ${b.cover_path ? `<img src="/covers/${escHtml(b.cover_path)}" class="stats-book-cover" alt="">` : '<div class="stats-book-cover-ph">📖</div>'}
          <div class="stats-book-info">
            <div class="stats-book-title">${escHtml(b.title)}</div>
            <div class="stats-book-meta">${escHtml(b.author || '')} · ${fmtDuration(b.total_secs)}</div>
          </div>
        </div>`).join('')}
    </div>` : '';

  const historyHtml = history.length ? `
    <div class="stats-section-title" style="margin-top:1.25rem">${t('stats.chapter_history')}</div>
    <div class="stats-history-list">
      ${history.map(bk => `
        <details class="stats-history-book">
          <summary class="stats-history-summary">
            <span class="stats-history-book-title">${escHtml(bk.book_title)}</span>
            <span class="stats-history-count">${bk.visits.length}</span>
            <button class="btn btn-sm btn-secondary stats-clear-book-btn" data-book-id="${bk.book_id}" title="${t('stats.clear_book_history')}" onclick="event.preventDefault();event.stopPropagation()">×</button>
          </summary>
          <ul class="stats-history-items">
            ${bk.visits.map(v => `
              <li class="stats-history-item">
                <span class="stats-history-chapter">${escHtml(v.chapter_title || v.chapter_href)}</span>
                <span class="stats-history-date">${new Date(v.visited_at * 1000).toLocaleDateString()}</span>
              </li>`).join('')}
          </ul>
        </details>`).join('')}
    </div>` : '';

  const backdrop = document.createElement('div');
  backdrop.id        = 'stats-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal stats-modal" role="dialog" aria-modal="true">
      <button class="modal-close" id="stats-modal-close" aria-label="${t('common.close')}">&times;</button>
      <h3 class="stats-modal-title">
        <img src="/images/statistics.svg" class="nav-icon nav-icon-statistics" alt="" style="width:1.1rem;height:1.1rem;margin-right:.4rem;vertical-align:middle">
        ${t('stats.title')}
      </h3>
      ${summaryHtml}
      ${topBooksHtml}
      ${historyHtml}
      <div class="stats-footer">
        <button class="btn btn-secondary" id="stats-clear-history-btn">${t('stats.clear_history')}</button>
        <button class="btn btn-danger"    id="stats-reset-btn">${t('stats.reset_all')}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const statsModalEl = backdrop.querySelector('.stats-modal');
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown);
  };
  const onKeyDown = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKeyDown);
  // Prevent wheel events from scrolling the page behind the modal
  backdrop.addEventListener('wheel', e => {
    if (!statsModalEl || !statsModalEl.contains(e.target)) e.preventDefault();
  }, { passive: false });
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('touchmove', e => { if (e.target === backdrop) e.preventDefault(); }, { passive: false });
  document.getElementById('stats-modal-close').addEventListener('click', close);

  // Clear history for one book
  backdrop.querySelectorAll('.stats-clear-book-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const bookId = btn.dataset.bookId;
      try {
        await apiFetch(`/stats/history/${bookId}`, { method: 'DELETE' });
        close();
        openStatsDialog();
      } catch (e) {
        toast.error(t('common.err_prefix') + e.message);
      }
    });
  });

  document.getElementById('stats-clear-history-btn').addEventListener('click', () => {
    confirmDialog(t('stats.confirm_clear_history'), async () => {
      try {
        await apiFetch('/stats/history', { method: 'DELETE' });
        close(); openStatsDialog();
      } catch (e) { toast.error(t('common.err_prefix') + e.message); }
    }, t('stats.clear_history'), false);
  });

  document.getElementById('stats-reset-btn').addEventListener('click', () => {
    confirmDialog(t('stats.confirm_reset'), async () => {
      try {
        await apiFetch('/stats', { method: 'DELETE' });
        close(); openStatsDialog();
      } catch (e) { toast.error(t('common.err_prefix') + e.message); }
    }, t('stats.reset_all'), true);
  });
}

// ── Add shelf modal ───────────────────────────────────────────────────────────
function openAddShelfModal() {
  document.getElementById('shelf-modal')?.remove();
  const backdrop = document.createElement('div');
  backdrop.id        = 'shelf-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:360px">
      <button class="modal-close" id="shelf-modal-close">&times;</button>
      <h2>${t('library.modal_add_shelf_title')}</h2>
      <div class="form-group">
        <label for="shelf-name-input">${t('library.shelf_name_label')}</label>
        <input type="text" id="shelf-name-input" maxlength="100" placeholder="${t('library.shelf_name_placeholder')}" autofocus />
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="shelf-modal-cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary"   id="shelf-modal-confirm">${t('library.shelf_btn_create')}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('#shelf-modal-close').addEventListener('click', close);
  backdrop.querySelector('#shelf-modal-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  const input = backdrop.querySelector('#shelf-name-input');
  const save  = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      await apiFetch('/shelves', { method: 'POST', body: JSON.stringify({ name }) });
      toast.success(t('library.toast_shelf_created', { name }));
      close();
      await reloadShelves();
    } catch (err) { toast.error(t('common.err_prefix') + err.message); }
  };
  backdrop.querySelector('#shelf-modal-confirm').addEventListener('click', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
}

// ── Edit shelf modal ──────────────────────────────────────────────────────────
function openShelfEditModal(shelf) {
  document.getElementById('shelf-edit-modal')?.remove();
  const backdrop = document.createElement('div');
  backdrop.id        = 'shelf-edit-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:360px">
      <button class="modal-close" id="shelf-edit-close">&times;</button>
      <h2>${t('library.modal_edit_shelf_title')}</h2>
      <div class="form-group">
        <label for="shelf-edit-input">${t('library.shelf_name_label')}</label>
        <input type="text" id="shelf-edit-input" maxlength="100" value="${escHtml(shelf.name)}" autofocus />
      </div>
      ${shelf.opds_folder_url ? `
      <div style="margin-top:1.25rem;margin-bottom:.75rem">
        <button class="btn btn-sm btn-outline" id="shelf-edit-unlink">${t('library.opds_unlink')}</button>
      </div>` : ''}
      <div class="modal-footer" style="justify-content:space-between">
        <button class="btn btn-danger" id="shelf-edit-delete">${t('library.shelf_btn_delete')}</button>
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-secondary" id="shelf-edit-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary"   id="shelf-edit-save">${t('common.save')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('#shelf-edit-close').addEventListener('click', close);
  backdrop.querySelector('#shelf-edit-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#shelf-edit-save').addEventListener('click', async () => {
    const name = backdrop.querySelector('#shelf-edit-input').value.trim();
    if (!name) return;
    try {
      await apiFetch(`/shelves/${shelf.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      toast.success(t('library.toast_shelf_renamed'));
      if (currentShelfId === shelf.id) document.getElementById('page-title').innerHTML = `<img src="/images/shelf.svg" class="nav-icon nav-icon-shelf" alt=""> ${escHtml(name)}`;
      close();
      await reloadShelves();
    } catch (err) { toast.error(t('common.err_prefix') + err.message); }
  });

  backdrop.querySelector('#shelf-edit-delete').addEventListener('click', () => {
    close();
    confirmDialog(
      `${t('library.confirm_delete_shelf', { name: escHtml(shelf.name) })}`,
      async () => {
        try {
          await apiFetch(`/shelves/${shelf.id}`, { method: 'DELETE' });
          toast.success(t('library.toast_shelf_deleted'));
          if (currentShelfId === shelf.id) await selectShelf('all');
          await reloadShelves();
        } catch (err) { toast.error(t('common.err_prefix') + err.message); }
      }
    );
  });

  backdrop.querySelector('#shelf-edit-unlink')?.addEventListener('click', () => {
    close();
    confirmDialog(t('library.opds_unlink_confirm'), async () => {
      try {
        await apiFetch(`/shelves/${shelf.id}/opds-link`, { method: 'DELETE' });
        toast.success(t('library.opds_unlinked'));
        if (currentShelfId === shelf.id) {
          currentLinkedOpds = null;
          document.getElementById('opds-shelf-banner')?.classList.add('hidden');
          document.getElementById('page-title').innerHTML =
            `<img src="/images/shelf.svg" class="nav-icon nav-icon-shelf" alt=""> ${escHtml(shelf.name)}`;
        }
        await reloadShelves();
      } catch (err) { toast.error(t('common.err_prefix') + err.message); }
    });
  });
}

// ── OPDS-linked shelf helpers ─────────────────────────────────────────────────
function _formatSyncDate(unixSecs) {
  if (!unixSecs) return '';
  const d = new Date(unixSecs * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  const dateStr = sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return t('library.opds_last_synced', { date: dateStr });
}

function _updateSyncDateDisplay(ts) {
  const el = document.getElementById('opds-shelf-sync-date');
  if (el) el.textContent = ts ? _formatSyncDate(ts) : '';
}

function _autoSyncLinkedShelf(linked) {
  const now = Date.now();
  const last = _autoSyncCooldown.get(linked.shelfId) || 0;
  if (now - last < 60 * 60 * 1000) return; // one sync per shelf per hour
  _autoSyncCooldown.set(linked.shelfId, now);

  const params = new URLSearchParams({
    serverId:  String(linked.serverId),
    folderUrl: linked.folderUrl,
    shelfId:   String(linked.shelfId),
    shelfName: linked.shelfName,
    silent:    '1',
    token:     getToken(),
  });
  const es = new EventSource(`/api/opds/sync-sse?${params}`);
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'done') {
        es.close();
        const newBooks = msg.added || 0;
        const nowSec = Math.floor(Date.now() / 1000);
        if (currentShelfId === linked.shelfId) {
          _updateSyncDateDisplay(nowSec);
          if (newBooks > 0) loadBooks();
        }
        if (newBooks > 0 && currentShelfId !== linked.shelfId) {
          setShelfBadge(linked.shelfId, newBooks);
        }
      } else if (msg.type === 'error') {
        es.close();
      }
    } catch { /* ignore parse errors */ }
  };
  es.onerror = () => es.close();
}

// ── Offline helpers ───────────────────────────────────────────────────────────
function getToken() {
  return localStorage.getItem('br_token') || '';
}

async function refreshDownloadedIds() {
  if (!isOfflineSupported) return;
  try {
    // A book is "downloaded" only if its EPUB blob is actually cached.
    downloadedIds = await getCachedBookIds();
    updateDownloadedCount(downloadedIds.size);
  } catch { /* non-critical */ }
}

function showOfflineBanner() {
  if (document.getElementById('offline-mode-banner')) return;
  const grid = document.getElementById('book-grid');
  if (!grid?.parentElement) return;
  const banner = document.createElement('div');
  banner.id = 'offline-mode-banner';
  banner.className = 'offline-banner';
  banner.innerHTML = `<span data-i18n="library.offline_mode_banner">${t('library.offline_mode_banner')}</span>`;
  grid.parentElement.insertBefore(banner, grid);
}

// ── Load books ────────────────────────────────────────────────────────────────
async function loadBooks() {
  try {
    books = await apiFetch('/books');
    // Clear offline state when we successfully reach the server
    const wasOffline = isOfflineMode;
    isOfflineMode = false;
    if (_offlineRetry) { clearTimeout(_offlineRetry); _offlineRetry = null; }
    document.body.classList.remove('is-offline');
    document.getElementById('offline-mode-banner')?.remove();
    booksLoaded = true;
    if (!returningFromReader && !urlParams.has('shelf') && localStorage.getItem('br_auto_open_last') === 'true') {
      const lastRead = books
        .filter(b => (b.percentage || 0) > 0 && (b.percentage || 0) < 1 && b.progress_updated_at)
        .sort((a, b) => b.progress_updated_at - a.progress_updated_at)[0];
      if (lastRead) { sessionStorage.setItem('br_last_shelf', String(currentShelfId)); window.location.href = `/readerv4.html?id=${lastRead.id}`; return; }
    }
    // Refresh offline state, then auto-download currently-reading books silently
    await refreshDownloadedIds();
    // Background: remove cached books that are no longer in the library, then re-count.
    pruneStaleDownloads(new Set(books.map(b => b.id)))
      .then(() => refreshDownloadedIds())
      .catch(() => {});
    autoDownloadCurrentlyReading(books, getToken()).catch(() => {});
    if (wasOffline) {
      reloadShelves().catch(() => {});
      document.dispatchEvent(new CustomEvent('app:network-restored'));
    }
    applyFilter();
    // Re-open book info modal when returning from a bookmark/highlight jump
    if (returnBookId) {
      const rb = books.find(b => b.id === returnBookId);
      if (rb) openInfoModal(rb, returnTab || 'reading').catch(() => {});
    }
  } catch (err) {
    // Server unreachable — try loading from IndexedDB
    try {
      // Only books with an actually-cached EPUB blob are usable offline. IDB may
      // also hold metadata-only entries (opened but never downloaded) — exclude
      // those so the grid never shows un-openable, cover-less books.
      const cachedIds = await getCachedBookIds();
      const allMeta = await getOfflineBooks();
      offlineBooks = allMeta.filter(b => cachedIds.has(b.id));
      if (offlineBooks.length > 0) {
        isOfflineMode = true;
        booksLoaded = true;
        document.body.classList.add('is-offline');
        downloadedIds = new Set(cachedIds);
        updateDownloadedCount(downloadedIds.size);
        updateNavCounts(offlineBooks.length, offlineBooks.filter(b => (b.percentage || 0) > 0).length);
        showOfflineBanner();
        applyFilter();
        // Retry every 30s so we self-heal when internet returns even without an 'online' event
        if (!_offlineRetry) _offlineRetry = setTimeout(() => { _offlineRetry = null; loadBooks().catch(() => {}); }, 30_000);
        return;
      }
    } catch { /* IDB also unavailable */ }
    toast.error(err.message);
  }
}

// Called by external modules (e.g. opds.js) after syncing to refresh the book grid.
export async function reloadLibrary() {
  await loadBooks();
  await refreshShelfFilter();
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function deleteBook(id) {
  try {
    await apiFetch(`/books/${id}`, { method: 'DELETE' });
    deleteDownload(id);        // remove EPUB from SW cache + IDB (fire-and-forget)
    downloadedIds.delete(id);  // keep in-memory set in sync immediately
    toast.success(t('library.toast_book_deleted'));
    await loadBooks();
    await reloadShelves();
    await refreshShelfFilter();
  } catch (err) { toast.error(err.message); }
}

// ── Upload ────────────────────────────────────────────────────────────────────
let dropZone, fileInput, uploadBtn, uploadMenu, uploadStatus;

function showDropZone() {
  dropZone.classList.toggle('hidden');
  if (!dropZone.classList.contains('hidden')) dropZone.scrollIntoView({ behavior: 'smooth' });
}

async function handleFiles(fileList) {
  const epubs = [...fileList].filter(f => f.name.endsWith('.epub') || f.name.endsWith('.cbz') || f.name.endsWith('.cbr'));
  if (!epubs.length) { toast.error(t('library.err_not_epub')); return; }

  setButtonLoading(uploadBtn, true, '+ Dodaj knjigo ▾');
  uploadStatus.classList.remove('hidden');
  dropZone.classList.add('hidden');

  let uploaded = 0, failed = 0;
  for (const file of epubs) {
    uploadStatus.innerHTML = `<div class="alert alert-info" style="background:var(--color-surface2)">
      ${t('library.upload_progress', { name: escHtml(file.name), n: uploaded + failed + 1, total: epubs.length })}</div>`;
    const formData = new FormData();
    formData.append('epub', file);
    try {
      const r = await fetch('/api/books', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('br_token')}` },
        body: formData,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const code = body.error || '';
        const translated = t(code);
        throw new Error((translated !== code && code) ? translated : (code || t('error.http_error', { status: r.status })));
      }
      uploaded++;
    } catch (err) { failed++; console.error('Upload failed:', file.name, err.message); }
  }

  uploadStatus.innerHTML = `<div class="alert alert-${failed ? 'error' : 'success'}">
    ${t('library.upload_result', { uploaded, failed })}</div>`;
  setTimeout(() => { uploadStatus.classList.add('hidden'); uploadStatus.innerHTML = ''; }, 4000);
  setButtonLoading(uploadBtn, false, '+ Dodaj knjigo ▾');
  fileInput.value = '';
  await loadBooks();
  await reloadShelves();
}

// ── Init ──────────────────────────────────────────────────────────────────────
let _initialized = false;

async function checkInterruptedSession() {
  const SESSION_KEY = 'br_interrupted_session_v1';
  const MAX_AGE = 24 * 60 * 60 * 1000;
  let session = null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && (Date.now() - Number(parsed.ts || 0)) < MAX_AGE) session = parsed;
    }
  } catch { /* ignore */ }
  if (!session) return;

  // Verify the book still exists before showing the restore banner
  try {
    await apiFetch(`/books/${session.bookId}`);
  } catch {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'session-restore-banner';
  banner.className = 'session-restore-banner';
  const pctStr = session.pct > 0 ? ` · ${Math.round(session.pct * 100)}%` : '';
  const authorStr = session.author ? ` — ${session.author}` : '';
  banner.innerHTML = `
    <span class="session-restore-text">
      <strong>${session.title}</strong>${authorStr}${pctStr}
    </span>
    <div class="session-restore-actions">
      <button class="btn btn-primary btn-sm" id="session-restore-btn">${t('library.session_resume')}</button>
      <button class="btn btn-ghost btn-sm" id="session-dismiss-btn">${t('library.session_dismiss')}</button>
    </div>`;

  const grid = document.getElementById('book-grid');
  if (grid?.parentElement) grid.parentElement.insertBefore(banner, grid);

  document.getElementById('session-restore-btn').addEventListener('click', () => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    // Write resume hint to sessionStorage so reader can restore exact position
    if (session.cfi) {
      try {
        sessionStorage.setItem('br_resume_state_v1', JSON.stringify({
          bookId: session.bookId, cfi: session.cfi, pct: session.pct, ts: Date.now(),
        }));
      } catch { /* quota */ }
    }
    banner.remove();
    window.location.href = `/readerv4.html?id=${session.bookId}`;
  });
  document.getElementById('session-dismiss-btn').addEventListener('click', () => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    banner.remove();
  });
}

export async function initLibrary() {
  if (_initialized) return;
  _initialized = true;

  // Register early so we never miss an online/offline event during async setup
  window.addEventListener('online',  () => loadBooks().catch(() => {}));
  window.addEventListener('offline', () => loadBooks().catch(() => {}));

  // SW download progress messages
  if (isOfflineSupported) {
    navigator.serviceWorker?.addEventListener('message', e => {
      const { type, bookId } = e.data || {};
      if (type === 'CACHE_BOOK_DONE') {
        downloadingIds.delete(bookId);
        downloadedIds.add(bookId);
        updateDownloadedCount(downloadedIds.size);
        applyFilter();
      } else if (type === 'CACHE_BOOK_ERROR') {
        downloadingIds.delete(bookId);
        applyFilter();
      }
    });
  }

  // DOM refs
  dropZone     = document.getElementById('drop-zone');
  fileInput    = document.getElementById('file-input');
  uploadBtn    = document.getElementById('upload-btn');
  uploadMenu   = document.getElementById('upload-menu');
  uploadStatus = document.getElementById('upload-status');

  // Sort
  const savedSort = localStorage.getItem('library-sort');
  if (savedSort) {
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect && Array.from(sortSelect.options).some(o => o.value === savedSort))
      sortSelect.value = savedSort;
  }
  initSortMenu();
  document.getElementById('sort-select').addEventListener('change', () => {
    if (sortBeforeSeriesFilter === null)
      localStorage.setItem('library-sort', document.getElementById('sort-select').value);
    applyFilter();
  });

  // Grid density
  let gridDensity = localStorage.getItem('br_grid_density') || 'normal';
  function applyGridDensity() {
    const grid = document.getElementById('book-grid');
    if (!grid) return;
    grid.classList.remove('density-compact', 'density-normal', 'density-large');
    grid.classList.add('density-' + gridDensity);
    document.querySelectorAll('.density-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.density === gridDensity));
  }
  applyGridDensity();
  document.querySelectorAll('.density-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      gridDensity = btn.dataset.density;
      localStorage.setItem('br_grid_density', gridDensity);
      applyGridDensity();
    });
  });

  // Edit mode
  document.getElementById('edit-mode-btn').addEventListener('click', () => {
    if (isOfflineMode) return;
    toggleEditMode();
  });
  document.getElementById('edit-select-all-btn').addEventListener('click', () => {
    const visibleCards = [...document.querySelectorAll('.book-card[data-id]')];
    const allSelected  = visibleCards.every(c => selectedBooks.has(Number(c.dataset.id)));
    if (allSelected) {
      // Deselect all
      visibleCards.forEach(c => {
        const id = Number(c.dataset.id);
        selectedBooks.delete(id);
        c.classList.remove('selected');
        const chk = c.querySelector('.book-card-checkbox');
        if (chk) chk.checked = false;
      });
    } else {
      // Select all visible
      visibleCards.forEach(c => {
        const id = Number(c.dataset.id);
        selectedBooks.add(id);
        c.classList.add('selected');
        const chk = c.querySelector('.book-card-checkbox');
        if (chk) chk.checked = true;
      });
    }
    updateEditToolbar();
  });
  document.getElementById('edit-assign-btn').addEventListener('click', () => {
    if (!selectedBooks.size) return;
    openBulkAssignModal();
  });
  document.getElementById('edit-remove-btn')?.addEventListener('click', () => {
    if (!selectedBooks.size || typeof currentShelfId !== 'number') return;
    confirmDialog(
      t('library.confirm_remove_from_shelf', { n: selectedBooks.size }),
      async () => {
        for (const bookId of selectedBooks) {
          try { await apiFetch(`/shelves/${currentShelfId}/books/${bookId}`, { method: 'DELETE' }); } catch { /* skip */ }
        }
        toast.success(t('library.toast_removed_from_shelf'));
        selectedBooks.clear();
        await loadBooks();
        await reloadShelves();
        await refreshShelfFilter();
      }
    );
  });
  document.getElementById('edit-delete-btn').addEventListener('click', () => {
    if (!selectedBooks.size) return;
    confirmDialog(
      t('library.confirm_del_books', { n: selectedBooks.size }),
      async () => {
        const ids = [...selectedBooks];
        const total = ids.length;
        const progress = total > 1 ? showProgressToast(t('library.deleting_progress')) : null;
        let done = 0;
        for (const bookId of ids) {
          try { await apiFetch(`/books/${bookId}`, { method: 'DELETE' }); } catch { /* skip */ }
          done++;
          if (progress) progress.update(done, total);
        }
        if (progress) progress.dismiss();
        toast.success(t('library.toast_books_deleted'));
        selectedBooks.clear();
        editMode = false;
        document.getElementById('edit-mode-btn').querySelector('span[data-i18n]').textContent = t('library.btn_edit');
        document.getElementById('edit-toolbar').classList.add('hidden');
        await loadBooks();
        await reloadShelves();
        applyFilter();
      }
    );
  });

  document.getElementById('edit-reextract-btn').addEventListener('click', () => {
    confirmDialog(
      t('library.confirm_reextract'),
      async () => {
        const btn = document.getElementById('edit-reextract-btn');
        const origText = btn.textContent;
        setButtonLoading(btn, true);
        try {
          const result = await apiFetch('/books/reextract-all', { method: 'POST' });
          toast.success(t('library.toast_reextract_done', { updated: result.updated, total: result.total }));
          await loadBooks();
        } catch (err) {
          toast.error(t('common.err_prefix') + err.message);
        } finally {
          setButtonLoading(btn, false);
          btn.textContent = origText;
        }
      },
      t('library.btn_reextract_confirm'),
      false
    );
  });

  // Search + series filter
  document.getElementById('search-input').addEventListener('input', () => {
    seriesFilter = null;
    updateSeriesFilterBar();
    applyFilter();
  });
  document.getElementById('series-filter-clear')?.addEventListener('click', () => {
    filterBySeries(null);
  });

  // Sidebar events
  document.addEventListener('sidebar:addshelf',  ()  => openAddShelfModal());
  document.addEventListener('sidebar:editshelf', e   => openShelfEditModal(e.detail));
  document.addEventListener('sidebar:stats',     ()  => openStatsDialog());

  // Upload
  uploadBtn.addEventListener('click', e => { e.stopPropagation(); uploadMenu.classList.toggle('hidden'); });
  document.addEventListener('click', () => uploadMenu.classList.add('hidden'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.book-card'))
      document.querySelectorAll('.book-card.tapped').forEach(c => c.classList.remove('tapped'));
  });
  document.getElementById('upload-file-btn').addEventListener('click', () => {
    uploadMenu.classList.add('hidden');
    showDropZone();
  });
  document.getElementById('upload-opds-btn')?.addEventListener('click', () => {
    uploadMenu.classList.add('hidden');
    showPanel('opds');
  });

  // OPDS-linked shelf banner buttons
  document.getElementById('opds-shelf-go-btn')?.addEventListener('click', () => {
    if (!currentLinkedOpds) return;
    openOpdsBrowserAtFolder(currentLinkedOpds.serverId, currentLinkedOpds.folderUrl);
  });
  document.getElementById('opds-shelf-sync-btn')?.addEventListener('click', () => {
    if (!currentLinkedOpds) return;
    openSyncModal(currentLinkedOpds.folderUrl, currentLinkedOpds.shelfName, currentLinkedOpds.shelfId, currentLinkedOpds.serverId);
  });
  document.getElementById('empty-upload-btn').addEventListener('click', showDropZone);
  // The visible content is wrapped in a <label for="file-input">, so tapping it
  // opens the chooser via native label activation (reliable on old WebViews, where
  // a programmatic fileInput.click() often does nothing). Only the thin padding ring
  // around the label — where e.target is the drop-zone itself — uses the JS fallback.
  dropZone.addEventListener('click', (e) => { if (e.target === dropZone) fileInput.click(); });
  fileInput.addEventListener('change', () => handleFiles(fileInput.files));
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  // Initial shelf
  if (initialShelf !== 'all') {
    const resolvedShelf = (initialShelf === 'reading' || initialShelf === 'downloaded')
      ? initialShelf
      : Number(initialShelf);
    await selectShelf(resolvedShelf);
  } else {
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.innerHTML = `<img src="/images/all_library.svg" class="nav-icon nav-icon-all-library" alt=""> ${t('sidebar.all_library')}`;
  }
  if (initialSearch) {
    const searchEl = document.getElementById('search-input');
    if (searchEl) searchEl.value = initialSearch;
  }

  loadBooks();
  checkInterruptedSession();
}

// Re-render language-dependent content when language changes
document.addEventListener('langchange', () => {
  if (!_initialized) return;
  // Update hidden <option> textContent
  document.querySelectorAll('#sort-select option[data-i18n]').forEach(opt => {
    const v = t(opt.dataset.i18n);
    if (v) opt.textContent = v;
  });
  // Sync the visible custom sort-menu list items from the updated <option> text
  const select = document.getElementById('sort-select');
  const menuItems = document.querySelectorAll('#sort-menu-list .sort-menu-option');
  if (select && menuItems.length) {
    Array.from(select.options).forEach((opt, i) => {
      const item = menuItems[i];
      if (item) item.querySelector('span')?.replaceWith(Object.assign(document.createElement('span'), { textContent: opt.textContent }));
    });
    // Update the visible button label to match the selected option
    const label = document.getElementById('sort-menu-label');
    if (label) label.textContent = select.options[select.selectedIndex]?.textContent || '';
  }
  const titleEl = document.getElementById('page-title');
  if (titleEl) {
    if (currentShelfId === 'all') titleEl.innerHTML = `<img src="/images/all_library.svg" class="nav-icon nav-icon-all-library" alt=""> ${t('sidebar.all_library')}`;
    else if (currentShelfId === 'reading') titleEl.innerHTML = `<img src="/images/currently_reading.svg" class="nav-icon nav-icon-currently-reading" alt=""> ${t('sidebar.currently_reading')}`;
    else if (currentShelfId === 'downloaded') titleEl.innerHTML = `<img src="/images/download.svg" class="nav-icon nav-icon-download" alt=""> ${t('sidebar.downloaded')}`;
  }
  if (editMode) {
    updateEditToolbar();
    const editBtn = document.getElementById('edit-mode-btn');
    if (editBtn) editBtn.textContent = t('common.cancel');
  }
  applyFilter();
});
