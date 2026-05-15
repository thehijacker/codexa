import { apiFetch } from './api.js';
import { toast, setButtonLoading } from './ui.js';
import { t, applyTranslations } from './i18n.js';
import { reloadShelves } from './sidebar.js';
import { reloadLibrary } from './library.js';
import { showPanel } from './router.js';

// ── State ─────────────────────────────────────────────────────────────────────
let servers       = [];
let currentServer = null;
let navStack      = [];    // [{title, url, upUrl}]
let _lastFeed     = null;  // last rendered feed, for re-render on lang change
let _initialized  = false;

// Pagination state for current browse level
let pageHistory    = [];  // stack of URLs for each page visited (index = page number - 1)
let currentFeed    = null; // the last loaded feed (has .next, .entries etc.)
let serverStatus   = {};  // id -> 'connected' | 'error' | null

// ── DOM refs (assigned in initOpds) ──────────────────────────────────────────
let serverList, serverEmpty, catalogTitle, breadcrumb, catalogGrid, catalogEmpty,
    catalogSearch, btnSearch, btnUp, loadingEl;

// ── Utility ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function coverSrc(url, serverId) {
  if (!url) return null;
  const token = localStorage.getItem('br_token') || '';
  return `/api/opds/cover?url=${encodeURIComponent(url)}&server=${serverId}&token=${encodeURIComponent(token)}`;
}

// ── Server list ───────────────────────────────────────────────────────────────
async function loadServers() {
  try {
    servers = await apiFetch('/opds/servers');
    renderServerList();
    if (servers.length > 0) openServer(servers[0]);
  } catch (err) {
    toast.error(t('opds.err_load_servers', { msg: err.message }));
  }
}

function renderServerList() {
  serverList.innerHTML = '';
  serverEmpty.hidden = servers.length > 0;

  servers.forEach(s => {
    const btn = document.createElement('button');
    const isActive = currentServer?.id === s.id;
    const status   = isActive ? (serverStatus[s.id] || null) : null;
    btn.className  = 'server-btn'
      + (isActive           ? ' active'    : '')
      + (status === 'connected' ? ' connected' : '')
      + (status === 'error'     ? ' error'     : '');
    btn.innerHTML = `
      <span class="server-name">${escHtml(s.name)}</span>
    `;
    btn.addEventListener('click', () => openServer(s));
    serverList.appendChild(btn);
  });
}

// ── Browse ────────────────────────────────────────────────────────────────────
async function openServer(server) {
  currentServer = server;
  navStack      = [{ title: server.name, url: null }];
  renderServerList();
  const ok = await browseUrl(null);
  // Store connection state so re-renders of the server list preserve it
  serverStatus[server.id] = ok ? 'connected' : 'error';
  renderServerList();
}

async function browseUrl(url) {
  setLoading(true);
  catalogGrid.innerHTML = '';
  catalogEmpty.hidden   = true;
  catalogSearch.value   = '';
  // Reset pagination when navigating to a new folder
  pageHistory = url !== undefined ? [url] : [null];

  try {
    const params = url ? `?url=${encodeURIComponent(url)}` : '';
    const feed   = await apiFetch(`/opds/browse/${currentServer.id}${params}`);
    currentFeed  = feed;

    if (navStack.length > 0) {
      navStack[navStack.length - 1].title = feed.title || navStack[navStack.length - 1].title;
      navStack[navStack.length - 1].upUrl = feed.up || null;
    }
    renderBreadcrumb();
    renderFeed(feed);
    renderPagination();
    btnUp.disabled = !feed.up && navStack.length <= 1;
    return true;
  } catch (err) {
    toast.error(t('opds.err_browse', { msg: err.message }));
    return false;
  } finally {
    setLoading(false);
  }
}

async function gotoPage(url) {
  setLoading(true);
  catalogGrid.innerHTML = '';
  catalogEmpty.hidden   = true;
  try {
    const params = url ? `?url=${encodeURIComponent(url)}` : '';
    const feed   = await apiFetch(`/opds/browse/${currentServer.id}${params}`);
    currentFeed  = feed;
    renderFeed(feed);
    renderPagination();
  } catch (err) {
    toast.error(t('opds.err_browse', { msg: err.message }));
  } finally {
    setLoading(false);
  }
}

function renderPagination() {
  let bar = document.getElementById('opds-pagination');
  if (!bar) return;
  bar.innerHTML = '';

  const feed     = currentFeed;
  const pageNum  = pageHistory.length; // 1-based current page
  const hasNext  = !!(feed?.next);
  const hasPrev  = pageHistory.length > 1;
  const bookCount = (feed?.entries || []).filter(e => !e.isNav).length;

  // Only show pagination if there's something to paginate
  if (!hasNext && !hasPrev) { bar.hidden = true; return; }
  bar.hidden = false;

  const prevBtn = document.createElement('button');
  prevBtn.className = 'opds-page-btn';
  prevBtn.textContent = '‹ ' + t('opds.page_prev');
  prevBtn.disabled = !hasPrev;
  prevBtn.addEventListener('click', async () => {
    pageHistory.pop(); // remove current
    const prevUrl = pageHistory[pageHistory.length - 1];
    await gotoPage(prevUrl);
  });

  const info = document.createElement('span');
  info.className   = 'opds-page-info';
  info.textContent = t('opds.page_info', { page: pageNum, count: bookCount });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'opds-page-btn';
  nextBtn.textContent = t('opds.page_next') + ' ›';
  nextBtn.disabled = !hasNext;
  nextBtn.addEventListener('click', async () => {
    const nextUrl = resolveClientUrl(feed.next);
    pageHistory.push(nextUrl);
    await gotoPage(nextUrl);
  });

  bar.appendChild(prevBtn);
  bar.appendChild(info);
  bar.appendChild(nextBtn);
}

// Resolve a next URL that may be relative — use the last page URL as base
function resolveClientUrl(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  const base = pageHistory[pageHistory.length - 1] || '';
  try { return new URL(href, base).href; } catch { return href; }
}

// Nav entries → folder tiles; book entries → expandable list rows
function renderFeed(feed) {
  _lastFeed = feed;
  if (!feed.entries?.length) {
    catalogEmpty.hidden = false;
    return;
  }

  const navEntries  = feed.entries.filter(e => e.isNav);
  const bookEntries = feed.entries.filter(e => !e.isNav);

  // — Navigation tiles grid —
  if (navEntries.length) {
    const grid = document.createElement('div');
    grid.className = 'nav-tile-grid';
    navEntries.forEach(entry => {
      const tile = document.createElement('button');
      tile.className = 'nav-tile';
      tile.innerHTML = `<img src="/images/folder.svg" class="nav-icon nav-icon-folder" alt=""><span class="nav-tile-label">${escHtml(entry.title)}</span>
        <button class="nav-tile-sync-btn" title="${t('opds.sync_title')}">${t('opds.btn_sync_short')}</button>`;
      tile.addEventListener('click', (e) => {
        if (e.target.closest('.nav-tile-sync-btn')) return;
        navStack.push({ title: entry.title, url: entry.navHref, upUrl: null });
        browseUrl(entry.navHref);
      });
      tile.querySelector('.nav-tile-sync-btn').addEventListener('click', e => {
        e.stopPropagation();
        openSyncModal(entry.navHref, entry.title);
      });
      grid.appendChild(tile);
    });
    catalogGrid.appendChild(grid);
  }

  // — Book list rows —
  bookEntries.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'book-row';

    const imgSrc = coverSrc(entry.cover, currentServer.id);
    const thumbHtml = imgSrc
      ? `<img class="book-row-thumb" src="${escHtml(imgSrc)}" alt="" loading="lazy" onerror="this.className='book-row-thumb book-row-no-cover'">`
      : `<div class="book-row-thumb book-row-no-cover">📖</div>`;

    row.innerHTML = `
      <div class="book-row-main">
        ${thumbHtml}
        <div class="book-row-info">
          <div class="book-row-title">${escHtml(entry.title)}</div>
          ${entry.author ? `<div class="book-row-author">${escHtml(entry.author)}</div>` : ''}
        </div>
        <div class="book-row-actions">
          ${entry.acqHref ? `<button class="btn btn-primary btn-sm btn-add">${t('opds.btn_add')}</button>` : ''}
        </div>
      </div>
      <div class="book-row-detail" hidden>
        ${entry.summary ? `<p class="book-row-summary">${escHtml(entry.summary)}</p>` : `<em>${t('opds.no_description')}</em>`}
      </div>
    `;

    // Click row (not button) to expand/collapse details
    row.querySelector('.book-row-main').addEventListener('click', e => {
      if (e.target.closest('.book-row-actions')) return;
      const detail = row.querySelector('.book-row-detail');
      detail.hidden = !detail.hidden;
      row.classList.toggle('expanded', !detail.hidden);
    });

    // Add to library
    if (entry.acqHref) {
      const btn = row.querySelector('.btn-add');
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        setButtonLoading(btn, true, t('opds.btn_downloading'));
        try {
          await apiFetch(`/opds/download/${currentServer.id}`, {
            method: 'POST',
            body: JSON.stringify({ href: entry.acqHref, title: entry.title, author: entry.author }),
          });
          toast.success(t('opds.toast_book_added', { title: entry.title }));
          btn.textContent = '✓ ' + t('opds.btn_add').replace(/^\+ /, '');
          btn.disabled    = true;
          btn.className   = 'btn btn-secondary btn-sm';
          reloadLibrary().catch(e => console.error('[opds] reloadLibrary failed:', e));
        } catch (err) {
          const msg = err.message?.includes('v vaši') || err.message?.includes('already') ? t('opds.err_already_in_library') : err.message;
          toast.error(msg);
          setButtonLoading(btn, false, t('opds.btn_add'));
        }
      });
    }

    catalogGrid.appendChild(row);
  });
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────
function renderBreadcrumb() {
  breadcrumb.innerHTML = '';
  catalogTitle.textContent = currentServer?.name || '';

  navStack.forEach((item, i) => {
    const span = document.createElement('span');
    if (i < navStack.length - 1) {
      span.className = 'crumb';
      const btn = document.createElement('button');
      btn.className   = 'crumb-btn';
      btn.textContent = item.title;
      btn.addEventListener('click', () => {
        navStack = navStack.slice(0, i + 1);
        browseUrl(item.url);
      });
      span.appendChild(btn);
      const sep = document.createElement('span');
      sep.className   = 'crumb-sep';
      sep.textContent = ' › ';
      span.appendChild(sep);
    } else {
      span.className   = 'crumb crumb-current';
      span.textContent = item.title;
    }
    breadcrumb.appendChild(span);
  });
}

// ── Loading state ─────────────────────────────────────────────────────────────
function setLoading(on) {
  loadingEl.hidden   = !on;
  btnSearch.disabled = on;
}

// ── Search ────────────────────────────────────────────────────────────────────
async function doSearch() {
  const q = catalogSearch.value.trim();
  if (!q || !currentServer) return;

  setLoading(true);
  catalogGrid.innerHTML = '';
  catalogEmpty.hidden   = true;

  try {
    const feed = await apiFetch(`/opds/search/${currentServer.id}?q=${encodeURIComponent(q)}`);
    currentFeed  = feed;
    pageHistory  = [];  // search results are a single, non-pageable set
    navStack = [
      { title: currentServer.name, url: null },
      { title: t('opds.search_crumb', { q }), url: null },
    ];
    renderBreadcrumb();
    renderFeed(feed);
    renderPagination();
    btnUp.disabled = false;
  } catch (err) {
    toast.error(t('opds.err_search', { msg: err.message }));
  } finally {
    setLoading(false);
  }
}

// ── OPDS Sync to shelf (SSE progress) ───────────────────────────────────────
function openSyncModal(folderUrl, folderTitle) {
  document.getElementById('sync-modal')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id        = 'sync-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:420px">
      <button class="modal-close" id="sync-modal-close">&times;</button>
      <h2>${t('opds.sync_modal_title')}</h2>
      <p style="font-size:.85rem;color:var(--color-text-muted);margin-bottom:1.25rem;line-height:1.5">
        ${t('opds.sync_modal_hint', { folder: escHtml(folderTitle) })}
      </p>
      <!-- Phase 0: scanning spinner -->
      <div id="sync-scanning" style="text-align:center;padding:1.5rem 0;color:var(--color-text-muted);font-size:.9rem">
        <span class="spinner" style="margin-right:.5rem"></span>${t('opds.sync_scanning')}
      </div>
      <!-- Phase 1: form (shown after count is known) -->
      <div id="sync-form" hidden>
        <div id="sync-count-info" style="font-size:.85rem;color:var(--color-text-muted);margin-bottom:1rem;padding:.55rem .75rem;background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--radius)"></div>
        <div class="form-group" style="margin-bottom:.9rem">
          <label for="sync-shelf-name">${t('opds.sync_shelf_label')}</label>
          <input type="text" id="sync-shelf-name" maxlength="100" value="${escHtml(folderTitle)}" autofocus />
        </div>
        <div class="form-group" style="margin-bottom:.25rem">
          <label for="sync-limit">${t('opds.sync_limit_label')}</label>
          <input type="number" id="sync-limit" min="1" max="9999" placeholder="${t('opds.sync_limit_placeholder')}" style="width:140px" />
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="sync-modal-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary"   id="sync-modal-confirm">${t('opds.btn_sync_confirm')}</button>
        </div>
      </div>
      <!-- Phase 2: progress -->
      <div id="sync-progress" hidden>
        <div id="sync-progress-text" style="font-size:.85rem;color:var(--color-text-muted);margin-bottom:.5rem">${t('opds.sync_starting')}</div>
        <div class="book-progress-bar" style="height:8px;margin-bottom:.5rem">
          <div id="sync-progress-fill" class="book-progress-fill" style="width:0%"></div>
        </div>
        <div id="sync-progress-book" style="font-size:.78rem;color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:1rem"></div>
        <div style="text-align:right">
          <button class="btn btn-secondary btn-sm" id="sync-abort-btn">${t('opds.sync_abort')}</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('#sync-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  // ── Phase 0: pre-fetch count ──────────────────────────────────────────────
  apiFetch(`/opds/sync-count?serverId=${encodeURIComponent(currentServer.id)}&folderUrl=${encodeURIComponent(folderUrl || '')}`)
    .then(data => {
      backdrop.querySelector('#sync-scanning').hidden = true;
      const formEl    = backdrop.querySelector('#sync-form');
      const countInfo = backdrop.querySelector('#sync-count-info');
      const newBooks  = data.total - data.alreadyHave;
      countInfo.innerHTML = t('opds.sync_count_info', {
        total:       data.total,
        alreadyHave: data.alreadyHave,
        newBooks,
      });
      formEl.hidden = false;
      backdrop.querySelector('#sync-shelf-name').focus();
    })
    .catch(err => {
      const scanEl = backdrop.querySelector('#sync-scanning');
      scanEl.innerHTML = `<span style="color:var(--color-danger)">${t('common.error_msg', { msg: err.message })}</span>`;
    });

  backdrop.querySelector('#sync-modal-cancel')?.addEventListener('click', close);

  // ── Phase 1 → 2: start sync ───────────────────────────────────────────────
  backdrop.querySelector('#sync-modal-confirm').addEventListener('click', () => {
    const shelfName = backdrop.querySelector('#sync-shelf-name').value.trim();
    if (!shelfName) return;
    const limitVal  = backdrop.querySelector('#sync-limit').value.trim();
    const limit     = limitVal ? parseInt(limitVal, 10) : null;

    // Switch to progress phase
    backdrop.querySelector('#sync-form').hidden = true;
    backdrop.querySelector('#sync-progress').hidden = false;
    backdrop.querySelector('#sync-modal-close').disabled = true;

    const params  = new URLSearchParams({
      serverId:  currentServer.id,
      folderUrl: folderUrl || '',
      shelfName,
      token:     localStorage.getItem('br_token') || '',
    });
    if (limit && limit > 0) params.set('limit', limit);

    const es = new EventSource(`/api/opds/sync-sse?${params.toString()}`);
    let total = 0;
    let aborted = false;

    const fillEl  = backdrop.querySelector('#sync-progress-fill');
    const textEl  = backdrop.querySelector('#sync-progress-text');
    const bookEl  = backdrop.querySelector('#sync-progress-book');
    const abortBtn = backdrop.querySelector('#sync-abort-btn');

    abortBtn.addEventListener('click', () => {
      aborted = true;
      es.close();
      backdrop.querySelector('#sync-modal-close').disabled = false;
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
          openStaleDialog(stale, msg.shelfId, summary);
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
function openStaleDialog(staleBooks, shelfId, syncSummary) {
  document.getElementById('stale-modal')?.remove();
  // Quick lookup: bookId -> otherShelfCount
  const otherCounts = new Map(staleBooks.map(b => [b.id, b.otherShelfCount || 0]));

  const backdrop = document.createElement('div');
  backdrop.id        = 'stale-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:480px">
      <button class="modal-close" id="stale-close">&times;</button>
      <h2>${t('opds.stale_title')}</h2>
      <p style="font-size:.85rem;color:var(--color-text-muted);margin-bottom:1rem;line-height:1.5">
        ${t('opds.stale_hint')}
      </p>
      <div class="info-modal-shelves" style="max-height:220px;overflow-y:auto;margin-bottom:1rem">
        ${staleBooks.map(b => `
          <label class="info-modal-shelf-row">
            <input type="checkbox" class="stale-chk" value="${b.id}" checked />
            <span>${escHtml(b.title)}</span>
            ${b.author ? `<span style="font-size:.78rem;color:var(--color-text-muted)">${escHtml(b.author)}</span>` : ''}
            ${(b.otherShelfCount || 0) > 0 ? `<span style="font-size:.72rem;color:var(--color-accent);margin-left:auto">${t('opds.stale_also_in_shelves')}</span>` : ''}
          </label>`).join('')}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="stale-skip">${t('opds.stale_keep')}</button>
        <button class="btn btn-danger"    id="stale-delete">${t('opds.stale_delete')}</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  const close = () => { backdrop.remove(); toast.success(syncSummary); };

  backdrop.querySelector('#stale-close').addEventListener('click', close);
  backdrop.querySelector('#stale-skip').addEventListener('click', async () => {
    for (const bookId of otherCounts.keys()) {
      try {
        await apiFetch(`/shelves/${shelfId}/books/${bookId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    backdrop.remove();
    reloadShelves();
    reloadLibrary();
    toast.success(syncSummary);
  });
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#stale-delete').addEventListener('click', async () => {
    const checked = [...backdrop.querySelectorAll('.stale-chk:checked')].map(el => Number(el.value));
    if (!checked.length) { close(); return; }
    let handled = 0;
    for (const bookId of checked) {
      try {
        if (otherCounts.get(bookId) > 0) {
          // Book lives on other shelves too — only remove it from this synced shelf
          await apiFetch(`/shelves/${shelfId}/books/${bookId}`, { method: 'DELETE' });
        } else {
          // Book is exclusive to this shelf — delete it from the library entirely
          await apiFetch(`/books/${bookId}`, { method: 'DELETE' });
        }
        handled++;
      } catch { /* ignore */ }
    }
    backdrop.remove();
    reloadShelves();
    reloadLibrary();
    toast.success(t('opds.stale_deleted', { summary: syncSummary, n: handled }));
  });
}

// ── Language change ───────────────────────────────────────────────────────────
document.addEventListener('langchange', () => {
  if (!_initialized) return;
  applyTranslations();
  if (_lastFeed) {
    catalogGrid.innerHTML = '';
    renderFeed(_lastFeed);
    renderPagination();
  }
  // Note: do NOT call renderServerList() here — it would lose connected/error state
});

// ── OPDS servers changed (added / edited / deleted in Settings) ───────────────
document.addEventListener('opdsserverschanged', async () => {
  if (!_initialized) return;
  try {
    const updated = await apiFetch('/opds/servers');
    // Drop status entries for removed servers
    const updatedIds = new Set(updated.map(s => s.id));
    for (const id of Object.keys(serverStatus)) {
      if (!updatedIds.has(Number(id))) delete serverStatus[id];
    }
    servers = updated;
    renderServerList();
    // If the current server was removed, open the first available one
    if (currentServer && !servers.find(s => s.id === currentServer.id)) {
      if (servers.length > 0) openServer(servers[0]);
      else { currentServer = null; catalogGrid.innerHTML = ''; navStack = []; renderBreadcrumb(); }
    }
  } catch { /* ignore */ }
});

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initOpds() {
  if (_initialized) return;
  _initialized = true;

  serverList    = document.getElementById('server-list');
  serverEmpty   = document.getElementById('server-empty');
  catalogTitle  = document.getElementById('catalog-title');
  breadcrumb    = document.getElementById('breadcrumb');
  catalogGrid   = document.getElementById('catalog-grid');
  catalogEmpty  = document.getElementById('catalog-empty');
  catalogSearch = document.getElementById('catalog-search');
  btnSearch     = document.getElementById('btn-catalog-search');
  btnUp         = document.getElementById('btn-catalog-up');
  loadingEl     = document.getElementById('catalog-loading');

  btnUp.addEventListener('click', () => {
    if (navStack.length > 1) {
      navStack.pop();
      const prev = navStack[navStack.length - 1];
      browseUrl(prev.url);
    }
  });

  btnSearch.addEventListener('click', doSearch);
  catalogSearch.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  document.getElementById('btn-opds-go-settings')?.addEventListener('click', () => showPanel('settings'));
  document.querySelector('.btn-opds-settings-link')?.addEventListener('click', () => showPanel('settings'));

  await loadServers();
}
