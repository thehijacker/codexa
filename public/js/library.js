import { apiFetch } from './api.js';
import { toast, confirmDialog, setButtonLoading, showProgressToast } from './ui.js';
import { reloadShelves, getShelves, setActive } from './sidebar.js';
import { t } from './i18n.js';
import { showPanel } from './router.js';

// ── State ─────────────────────────────────────────────────────────────────────
let books               = [];
let booksLoaded         = false; // true only after first successful loadBooks()
let currentShelfId      = 'all';
let currentShelfBookIds = null; // null = use category logic
let editMode            = false;
let selectedBooks       = new Set();
let seriesFilter        = null; // active series name filter
let sortBeforeSeriesFilter = null; // sort value saved before auto-switching to series_asc

// ── URL-based shelf navigation (from settings / opds pages) ───────────────────
const urlParams    = new URLSearchParams(location.search);
// Priority: explicit ?shelf= URL param > sessionStorage (return from reader) > localStorage (last used) > 'all'
const returningFromReader = !!sessionStorage.getItem('br_last_shelf');
const initialShelf  = urlParams.get('shelf') || sessionStorage.getItem('br_last_shelf') || localStorage.getItem('br_active_shelf') || 'all';
const initialSearch = sessionStorage.getItem('br_last_search') || '';
sessionStorage.removeItem('br_last_shelf');
sessionStorage.removeItem('br_last_search');
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
    return sorted.sort((a, b) => (b.progress_updated_at || 0) - (a.progress_updated_at || 0));
  }
  switch (order) {
    case 'added_desc':    sorted.sort((a, b) => b.added_at - a.added_at); break;
    case 'added_asc':     sorted.sort((a, b) => a.added_at - b.added_at); break;
    case 'title_asc':     sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
    case 'title_desc':    sorted.sort((a, b) => b.title.localeCompare(a.title)); break;
    case 'author_asc':    sorted.sort((a, b) => (a.author || '').localeCompare(b.author || '')); break;
    case 'progress_desc': sorted.sort((a, b) => (b.percentage || 0) - (a.percentage || 0)); break;
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
    if (!e.target.closest('.sort-menu-wrap')) closeMenu();
  });
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

    const card = document.createElement('div');
    card.className  = 'book-card';
    card.dataset.id = book.id;
    if (selectedBooks.has(book.id)) card.classList.add('selected');

    card.innerHTML = `
      ${cover}
      <label class="book-card-checkbox-wrap" title="${t('library.btn_cover_select')}">
        <input type="checkbox" class="book-card-checkbox" ${selectedBooks.has(book.id) ? 'checked' : ''} />
      </label>
      <div class="book-card-actions">
        ${book.cover_path ? `<button class="btn-icon cover-preview-btn" title="${t('library.btn_cover_preview')}" data-id="${book.id}">👁</button>` : ''}
        <button class="btn-icon info-btn"  title="${t('library.btn_cover_info')}" data-id="${book.id}">ℹ</button>
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
      </div>`;

    const checkbox = card.querySelector('.book-card-checkbox');

    card.querySelector('.book-card-checkbox-wrap').addEventListener('click', e => {
      e.stopPropagation();
      toggleBookSelect(book.id, checkbox.checked);
    });

    card.addEventListener('click', e => {
      if (e.target.closest('.read-btn') || e.target.closest('.info-btn') ||
          e.target.closest('.cover-preview-btn') || e.target.closest('.book-card-checkbox-wrap')) return;
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
async function openInfoModal(book) {
  document.getElementById('book-info-modal')?.remove();

  let fullBook = book;
  try { fullBook = await apiFetch(`/books/${book.id}`); } catch { /* use cached */ }

  let bookShelfIds = new Set();
  try {
    const ids = await apiFetch(`/shelves/for-book/${book.id}`);
    bookShelfIds = new Set(ids);
  } catch { /* ignore */ }

  const allShelves = getShelves();
  const coverHtml  = fullBook.cover_path
    ? `<img class="info-modal-cover info-modal-cover-clickable" src="/covers/${fullBook.cover_path}" alt="" />`
    : `<div class="info-modal-cover info-modal-cover-ph">📖</div>`;  

  const shelvesHtml = allShelves.length
    ? `<div class="info-modal-section-title">${t('library.info_shelves')}</div>
       <div class="info-modal-shelves">${allShelves.map(s => `
         <label class="info-modal-shelf-row">
           <input type="checkbox" class="shelf-chk" value="${s.id}" ${bookShelfIds.has(s.id) ? 'checked' : ''} />
           <span>${escHtml(s.name)}</span>
           <span class="shelf-book-count">(${s.book_count})</span>
         </label>`).join('')}
       </div>`
    : `<div style="font-size:.82rem;color:var(--color-text-muted);margin-top:.75rem">${t('library.info_no_shelves')}</div>`;

  // Use the list-level book object for percentage — fullBook (from GET /api/books/:id)
  // does not join reading_progress, so it always returns 0.
  const progressPct = Math.round((book.percentage || 0) * 100);
  const progressHtml = progressPct > 0 ? `
    <div class="info-modal-section-title" style="margin-top:1rem">${t('library.info_progress') || 'Reading Progress'}</div>
    <div class="info-modal-progress-row">
      <div class="info-modal-progress-bar-wrap">
        <div class="info-modal-progress-bar-fill" style="width:${progressPct}%"></div>
      </div>
      <span class="info-modal-progress-pct">${progressPct}%</span>
      <button class="btn btn-secondary btn-sm" id="info-modal-reset-progress" style="margin-left:auto;white-space:nowrap">${t('library.btn_reset_progress') || 'Reset to 0%'}</button>
    </div>` : '';

  const descTitleHtml   = fullBook.description
    ? `<div class="info-modal-section-title" style="margin-top:1rem">${t('library.info_desc')}</div>`
    : '';
  const descContentHtml = fullBook.description
    ? `<div class="info-modal-desc">${sanitizeHtml(fullBook.description)}</div>`
    : '';

  const genresHtml = fullBook.genres
    ? `<div class="info-modal-genres">${fullBook.genres.split(',').map(g => g.trim()).filter(Boolean).map(g => `<span class="genre-pill">${escHtml(g)}</span>`).join('')}</div>`
    : '';

  const inlineMetaParts = [
    fullBook.publisher && `<span><span class="info-meta-label">${t('library.info_publisher')}:</span>\u00a0${escHtml(fullBook.publisher)}</span>`,
    fullBook.language  && `<span><span class="info-meta-label">${t('library.info_language')}:</span>\u00a0${escHtml(fullBook.language)}</span>`,
    fullBook.pages     && `<span><span class="info-meta-label">${t('library.info_pages')}:</span>\u00a0${escHtml(fullBook.pages)}</span>`,
    fullBook.isbn      && `<span><span class="info-meta-label">${t('library.info_isbn')}:</span>\u00a0${escHtml(fullBook.isbn)}</span>`,
  ].filter(Boolean);
  const inlineMetaHtml = inlineMetaParts.length
    ? `<div class="info-modal-extra">${inlineMetaParts.join('')}</div>`
    : '';

  const token    = encodeURIComponent(localStorage.getItem('br_token') || '');
  const backdrop = document.createElement('div');
  backdrop.id        = 'book-info-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal info-modal" role="dialog" aria-modal="true">
      <button class="modal-close" id="info-modal-close" aria-label="${t('common.close')}">&times;</button>
      <div class="info-modal-top">
        ${coverHtml}
        <div class="info-modal-meta">
          <h3 class="info-modal-title">${escHtml(fullBook.title)}</h3>
          <div class="info-modal-author">${escHtml(fullBook.author || t('library.unknown_author'))}</div>
          ${fullBook.series_name ? `<div class="info-modal-series"><button class="series-filter-btn" data-series="${escHtml(fullBook.series_name)}" title="${t('library.series_filter_title')}">${escHtml(fullBook.series_name)}${fullBook.series_number ? ` #${escHtml(fullBook.series_number)}` : ''}</button></div>` : ''}
          ${fullBook.file_size ? `<div class="info-modal-filesize">${formatSize(fullBook.file_size)}</div>` : ''}
          ${genresHtml}
          ${inlineMetaHtml}
        </div>
      </div>
      ${progressHtml}
      ${descTitleHtml}
      ${descContentHtml ? `<div class="info-modal-body">${descContentHtml}</div>` : ''}
      ${shelvesHtml}
      <div class="modal-footer info-modal-footer">
        <button class="btn btn-danger"    id="info-modal-delete"><img src="/images/delete.svg" class="nav-icon nav-icon-delete" alt=""> ${t('library.btn_del_book')}</button>
        <a      class="btn btn-secondary" id="info-modal-download"
                href="/api/books/${fullBook.id}/file?download=1&token=${token}" download><img src="/images/download.svg" class="nav-icon nav-icon-download" alt=""> ${t('library.btn_download')}</a>
        <a      class="btn btn-read"      id="info-modal-read"
                href="/readerv4.html?id=${fullBook.id}"><img src="/images/read.svg" class="nav-icon nav-icon-read" alt=""> ${t('library.btn_read')}</a>
        <button class="btn btn-primary"   id="info-modal-save"><img src="/images/save.svg" class="nav-icon nav-icon-save" alt=""> ${t('library.btn_save_shelves')}</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  // Scroll-fade mask on the body section
  const bodyEl = backdrop.querySelector('.info-modal-body');
  if (bodyEl) {
    const updateFade = () => {
      const { scrollTop, scrollHeight, clientHeight } = bodyEl;
      const canUp   = scrollTop > 2;
      const canDown = scrollTop + clientHeight < scrollHeight - 2;
      let g;
      if      (canUp && canDown) g = 'linear-gradient(to bottom, transparent 0%, black 10%, black 88%, transparent 100%)';
      else if (canUp)            g = 'linear-gradient(to bottom, transparent 0%, black 10%)';
      else if (canDown)          g = 'linear-gradient(to bottom, black 0%, black 88%, transparent 100%)';
      else                       g = 'none';
      bodyEl.style.maskImage       = g;
      bodyEl.style.webkitMaskImage = g;
    };
    bodyEl.addEventListener('scroll', updateFade, { passive: true });
    updateFade();
  }

  // Prevent mouse-wheel and touch-scroll from leaking through to the page behind the backdrop.
  // Allow wheel/touch when it's inside the description body (which handles its own scroll).
  backdrop.addEventListener('wheel', e => {
    if (!bodyEl || !bodyEl.contains(e.target)) e.preventDefault();
  }, { passive: false });
  backdrop.addEventListener('touchmove', e => {
    if (e.target === backdrop) e.preventDefault();
  }, { passive: false });

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown);
  };
  const onKeyDown = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKeyDown);
  backdrop.querySelector('#info-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  if (fullBook.cover_path) {
    backdrop.querySelector('.info-modal-cover-clickable')?.addEventListener('click', e => {
      e.stopPropagation();
      openCoverPreview(fullBook);
    });
  }

  backdrop.querySelector('.series-filter-btn')?.addEventListener('click', () => {
    close();
    filterBySeries(fullBook.series_name);
  });

  backdrop.querySelector('#info-modal-reset-progress')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await apiFetch(`/progress/${fullBook.file_hash}`, {
        method: 'PUT',
        body: JSON.stringify({ cfi_position: '', percentage: 0, device: 'web' }),
      });
      // Update the in-memory book object and re-render the library (removes it from "Currently Reading")
      const cached = books.find(b => b.id === fullBook.id);
      if (cached) { cached.percentage = 0; cached.cfi_position = ''; }
      applyFilter();
      // Refresh the card's progress bar inline (applyFilter re-renders, but keep for instant feedback)
      const card = document.querySelector(`.book-card[data-id="${fullBook.id}"]`);
      if (card) {
        card.querySelector('.book-progress-fill').style.width = '0%';
        card.querySelector('.book-progress-text').textContent = t('library.not_started');
      }
      // Hide the entire progress section in the modal (progress is now 0)
      backdrop.querySelectorAll('.info-modal-section-title, .info-modal-progress-row').forEach(el => {
        if (el.classList.contains('info-modal-progress-row') ||
            (el.classList.contains('info-modal-section-title') && el.nextElementSibling?.classList.contains('info-modal-progress-row'))) {
          el.remove();
        }
      });
      toast.success(t('library.toast_progress_reset') || 'Reading progress reset to 0%');
    } catch (err) {
      toast.error(t('common.err_prefix') + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  backdrop.querySelector('#info-modal-delete').addEventListener('click', () => {
    close();
    confirmDialog(
      `${t('library.confirm_del_book', { title: escHtml(fullBook.title) })}`,
      () => deleteBook(fullBook.id)
    );
  });

  backdrop.querySelector('#info-modal-save').addEventListener('click', async () => {
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
  } else if (shelfId === 'reading') {
    titleEl.innerHTML = `<img src="/images/currently_reading.svg" class="nav-icon nav-icon-currently-reading" alt=""> ${t('sidebar.currently_reading')}`;
    currentShelfBookIds = null;
  } else {
    const shelf = getShelves().find(s => s.id === shelfId);
    titleEl.innerHTML = `<img src="/images/shelf.svg" class="nav-icon nav-icon-shelf" alt=""> ${escHtml(shelf ? shelf.name : 'Polica')}`;
    await refreshShelfFilter(false);
  }

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
  if (allCountEl)     allCountEl.textContent     = books.length;
  if (readingCountEl) readingCountEl.textContent = books.filter(b => { const p = b.percentage || 0; return p > 0 && p < 1; }).length;

  const q = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
  let list = books;

  if (currentShelfId === 'reading') {
    list = list.filter(b => { const p = b.percentage || 0; return p > 0 && p < 1; });
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
      <div class="modal-footer" style="justify-content:space-between">
        <button class="btn btn-danger"    id="shelf-edit-delete">${t('library.shelf_btn_delete')}</button>
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
}

// ── Load books ────────────────────────────────────────────────────────────────
async function loadBooks() {
  try {
    books = await apiFetch('/books');
    booksLoaded = true;
    if (!returningFromReader && !urlParams.has('shelf') && localStorage.getItem('br_auto_open_last') === 'true') {
      const lastRead = books
        .filter(b => (b.percentage || 0) > 0 && (b.percentage || 0) < 1 && b.progress_updated_at)
        .sort((a, b) => b.progress_updated_at - a.progress_updated_at)[0];
      if (lastRead) { sessionStorage.setItem('br_last_shelf', String(currentShelfId)); window.location.href = `/readerv4.html?id=${lastRead.id}`; return; }
    }
    applyFilter();
  } catch (err) {
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
  const epubs = [...fileList].filter(f => f.name.endsWith('.epub'));
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
    ${t('library.upload_result', { ok: uploaded, err: failed })}</div>`;
  setTimeout(() => { uploadStatus.classList.add('hidden'); uploadStatus.innerHTML = ''; }, 4000);
  setButtonLoading(uploadBtn, false, '+ Dodaj knjigo ▾');
  fileInput.value = '';
  await loadBooks();
  await reloadShelves();
}

// ── Init ──────────────────────────────────────────────────────────────────────
let _initialized = false;

function checkInterruptedSession() {
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

  // DOM refs
  dropZone     = document.getElementById('drop-zone');
  fileInput    = document.getElementById('file-input');
  uploadBtn    = document.getElementById('upload-btn');
  uploadMenu   = document.getElementById('upload-menu');
  uploadStatus = document.getElementById('upload-status');

  // Sort
  initSortMenu();
  document.getElementById('sort-select').addEventListener('change', applyFilter);

  // Edit mode
  document.getElementById('edit-mode-btn').addEventListener('click', toggleEditMode);
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
  document.getElementById('empty-upload-btn').addEventListener('click', showDropZone);
  dropZone.addEventListener('click', () => fileInput.click());
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
    await selectShelf(
      initialShelf === 'reading' ? 'reading' : Number(initialShelf)
    );
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
  }
  if (editMode) {
    updateEditToolbar();
    const editBtn = document.getElementById('edit-mode-btn');
    if (editBtn) editBtn.textContent = t('common.cancel');
  }
  applyFilter();
});
