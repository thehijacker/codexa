import { apiFetch } from './api.js';
import { toast, confirmDialog, setButtonLoading } from './ui.js';
import { initSidebar, reloadShelves, getShelves, setActive } from './sidebar.js';
import { t, initI18n } from './i18n.js';

// ── State ─────────────────────────────────────────────────────────────────────
let books               = [];
let booksLoaded         = false; // true only after first successful loadBooks()
let currentShelfId      = 'all';
let currentShelfBookIds = null; // null = use category logic
let editMode            = false;
let selectedBooks       = new Set();
let seriesFilter        = null; // active series name filter

// ── URL-based shelf navigation (from settings / opds pages) ───────────────────
const urlParams    = new URLSearchParams(location.search);
// Priority: explicit ?shelf= URL param > sessionStorage (return from reader) > localStorage (last used) > 'all'
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

document.getElementById('sort-select').addEventListener('change', applyFilter);

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
      <label class="book-card-checkbox-wrap" title="Izberi">
        <input type="checkbox" class="book-card-checkbox" ${selectedBooks.has(book.id) ? 'checked' : ''} />
      </label>
      <div class="book-card-actions">
        <button class="btn-icon info-btn"   title="Podrobnosti" data-id="${book.id}">ℹ</button>
        <button class="btn-icon delete-btn" title="Izbriši"     data-id="${book.id}">🗑</button>
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
      if (e.target.closest('.delete-btn') || e.target.closest('.info-btn') ||
          e.target.closest('.book-card-checkbox-wrap')) return;
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
      window.location.href = `/readerv2.html?id=${book.id}`;
      sessionStorage.setItem('br_last_shelf', String(currentShelfId));
      sessionStorage.setItem('br_last_search', document.getElementById('search-input')?.value || '');
    });

    card.querySelector('.delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      confirmDialog(
        `${t('library.confirm_del_book', { title: escHtml(book.title) })}`,
        () => deleteBook(book.id)
      );
    });

    card.querySelector('.info-btn').addEventListener('click', e => {
      e.stopPropagation();
      openInfoModal(book);
    });

    grid.appendChild(card);
  });
}

// ── Edit mode ─────────────────────────────────────────────────────────────────
function toggleEditMode() {
  editMode = !editMode;
  selectedBooks.clear();
  document.getElementById('edit-mode-btn').textContent = editMode ? t('common.cancel') : t('library.btn_edit');
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
  document.getElementById('edit-selected-count').textContent = t('library.edit_selected', { n: count });
  document.getElementById('edit-assign-btn').disabled = count === 0;
  document.getElementById('edit-delete-btn').disabled = count === 0;
  const onShelf = typeof currentShelfId === 'number';
  if (removeBtn) {
    removeBtn.disabled = count === 0 || !onShelf;
    removeBtn.classList.toggle('hidden', !onShelf);
  }
}

document.getElementById('edit-mode-btn').addEventListener('click', toggleEditMode);

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
      for (const bookId of selectedBooks) {
        try { await apiFetch(`/books/${bookId}`, { method: 'DELETE' }); } catch { /* skip */ }
      }
      toast.success(t('library.toast_books_deleted'));
      selectedBooks.clear();
      editMode = false;
      document.getElementById('edit-mode-btn').textContent = t('library.btn_edit');
      document.getElementById('edit-toolbar').classList.add('hidden');
      await loadBooks();
      await reloadShelves();
      applyFilter();
    }
  );
});

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
    ? `<img class="info-modal-cover" src="/covers/${fullBook.cover_path}" alt="" />`
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

  const descHtml = fullBook.description
    ? `<div class="info-modal-section-title" style="margin-top:1rem">${t('library.info_desc')}</div>
       <div class="info-modal-desc">${sanitizeHtml(fullBook.description)}</div>`
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
        </div>
      </div>
      ${descHtml}
      ${shelvesHtml}
      <div class="modal-footer info-modal-footer">
        <button class="btn btn-danger"    id="info-modal-delete">${t('library.btn_del_book')}</button>
        <a      class="btn btn-secondary" id="info-modal-download"
                href="/api/books/${fullBook.id}/file?download=1&token=${token}" download>${t('library.btn_download')}</a>
        <button class="btn btn-primary"   id="info-modal-save">${t('library.btn_save_shelves')}</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('#info-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('.series-filter-btn')?.addEventListener('click', () => {
    close();
    filterBySeries(fullBook.series_name);
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
async function selectShelf(shelfId) {
  currentShelfId = shelfId;
  seriesFilter   = null;
  updateSeriesFilterBar();
  setActive(shelfId);
  localStorage.setItem('br_active_shelf', String(shelfId));

  const titleEl = document.getElementById('page-title');
  if (shelfId === 'all') {
    titleEl.textContent     = t('sidebar.all_library');
    currentShelfBookIds = null;
  } else if (shelfId === 'reading') {
    titleEl.textContent     = t('sidebar.currently_reading');
    currentShelfBookIds = null;
  } else {
    const shelf = getShelves().find(s => s.id === shelfId);
    titleEl.textContent = shelf ? shelf.name : 'Polica';
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
  const q = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
  let list = books;

  if (currentShelfId === 'reading') {
    list = list.filter(b => (b.percentage || 0) > 0);
  } else if (currentShelfId === 'all') {
    list = list.filter(b => (b.percentage || 0) === 0);
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

document.getElementById('search-input').addEventListener('input', () => {
  seriesFilter = null;
  updateSeriesFilterBar();
  applyFilter();
});

document.getElementById('series-filter-clear')?.addEventListener('click', () => {
  filterBySeries(null);
});

// ── Sidebar events ────────────────────────────────────────────────────────────
document.addEventListener('sidebar:addshelf',  ()  => openAddShelfModal());
document.addEventListener('sidebar:editshelf', e   => openShelfEditModal(e.detail));

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
      if (currentShelfId === shelf.id) document.getElementById('page-title').textContent = name;
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
    applyFilter();
  } catch (err) {
    toast.error(err.message);
  }
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
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const uploadBtn    = document.getElementById('upload-btn');
const uploadMenu   = document.getElementById('upload-menu');
const uploadStatus = document.getElementById('upload-status');

uploadBtn.addEventListener('click', e => { e.stopPropagation(); uploadMenu.classList.toggle('hidden'); });
document.addEventListener('click', () => uploadMenu.classList.add('hidden'));
// Dismiss tapped card state when touching outside any book card (mobile UX)
document.addEventListener('click', (e) => {
  if (!e.target.closest('.book-card'))
    document.querySelectorAll('.book-card.tapped').forEach(c => c.classList.remove('tapped'));
});
document.getElementById('upload-file-btn').addEventListener('click', () => {
  uploadMenu.classList.add('hidden');
  showDropZone();
});
function showDropZone() {
  dropZone.classList.toggle('hidden');
  if (!dropZone.classList.contains('hidden')) dropZone.scrollIntoView({ behavior: 'smooth' });
}
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
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || `Napaka ${r.status}`);
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
await initI18n();
initSortMenu();
await initSidebar({
  activePage:    'library',
  onShelfSelect: selectShelf,
  activeShelfId: initialShelf === 'reading' ? 'reading'
               : initialShelf !== 'all'     ? Number(initialShelf)
               : 'all',
});

if (initialShelf !== 'all') {
  await selectShelf(
    initialShelf === 'reading' ? 'reading' : Number(initialShelf)
  );
}

if (initialSearch) {
  const searchEl = document.getElementById('search-input');
  if (searchEl) searchEl.value = initialSearch;
}

loadBooks();

// Re-render language-dependent content when language changes
document.addEventListener('langchange', () => {
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
    if (currentShelfId === 'all') titleEl.textContent = t('sidebar.all_library');
    else if (currentShelfId === 'reading') titleEl.textContent = t('sidebar.currently_reading');
  }
  applyFilter();
});
