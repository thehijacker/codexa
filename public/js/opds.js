import { apiFetch, requireAuth } from './api.js';
import { toast, setButtonLoading } from './ui.js';
import { t, initI18n, applyTranslations } from './i18n.js';
import { reloadShelves } from './sidebar.js';

await initI18n();

if (!requireAuth()) throw new Error('not authenticated');

// ── State ─────────────────────────────────────────────────────────────────────
let servers       = [];
let currentServer = null;
let navStack      = [];    // [{title, url, upUrl}]
let _lastFeed     = null;  // last rendered feed, for re-render on lang change

// ── DOM refs ────────────────────────────────────────────────────────────────
const serverList    = document.getElementById('server-list');
const serverEmpty   = document.getElementById('server-empty');
const catalogTitle  = document.getElementById('catalog-title');
const breadcrumb    = document.getElementById('breadcrumb');
const catalogGrid   = document.getElementById('catalog-grid');
const catalogEmpty  = document.getElementById('catalog-empty');
const catalogSearch = document.getElementById('catalog-search');
const btnSearch     = document.getElementById('btn-catalog-search');
const btnUp         = document.getElementById('btn-catalog-up');
const loadingEl     = document.getElementById('catalog-loading');

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
    btn.className = 'server-btn' + (currentServer?.id === s.id ? ' active' : '');
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
  // Mark the active button green on success, red on failure
  const activeBtn = serverList.querySelector('.server-btn.active');
  if (activeBtn) {
    activeBtn.classList.toggle('connected', ok);
    activeBtn.classList.toggle('error',     !ok);
  }
}

async function browseUrl(url) {
  setLoading(true);
  catalogGrid.innerHTML = '';
  catalogEmpty.hidden   = true;
  catalogSearch.value   = '';

  try {
    const params = url ? `?url=${encodeURIComponent(url)}` : '';
    const feed   = await apiFetch(`/opds/browse/${currentServer.id}${params}`);

    if (navStack.length > 0) {
      navStack[navStack.length - 1].title = feed.title || navStack[navStack.length - 1].title;
      navStack[navStack.length - 1].upUrl = feed.up || null;
    }
    renderBreadcrumb();
    renderFeed(feed);
    btnUp.disabled = !feed.up && navStack.length <= 1;
    return true;
  } catch (err) {
    toast.error(t('opds.err_browse', { msg: err.message }));
    return false;
  } finally {
    setLoading(false);
  }
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
      tile.innerHTML = `<span class="nav-tile-icon">📂</span><span class="nav-tile-label">${escHtml(entry.title)}</span>
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
          btn.textContent = '\u2713 ' + t('opds.btn_add').replace(/^\+ /, '');
          btn.disabled    = true;
          btn.className   = 'btn btn-secondary btn-sm';
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

// ── Up button ─────────────────────────────────────────────────────────────────
btnUp.addEventListener('click', () => {
  if (navStack.length > 1) {
    navStack.pop();
    const prev = navStack[navStack.length - 1];
    browseUrl(prev.url);
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
async function doSearch() {
  const q = catalogSearch.value.trim();
  if (!q || !currentServer) return;

  setLoading(true);
  catalogGrid.innerHTML = '';
  catalogEmpty.hidden   = true;

  try {
    const feed = await apiFetch(`/opds/search/${currentServer.id}?q=${encodeURIComponent(q)}`);
    navStack = [
      { title: currentServer.name, url: null },
      { title: t('opds.search_crumb', { q }), url: null },
    ];
    renderBreadcrumb();
    renderFeed(feed);
    btnUp.disabled = false;
  } catch (err) {
    toast.error(t('opds.err_search', { msg: err.message }));
  } finally {
    setLoading(false);
  }
}

btnSearch.addEventListener('click', doSearch);
catalogSearch.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// ── Loading state ─────────────────────────────────────────────────────────────
function setLoading(on) {
  loadingEl.hidden   = !on;
  btnSearch.disabled = on;
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
      <!-- Phase 1: form -->
      <div id="sync-form">
        <div class="form-group">
          <label for="sync-shelf-name">${t('opds.sync_shelf_label')}</label>
          <input type="text" id="sync-shelf-name" maxlength="100" value="${escHtml(folderTitle)}" autofocus />
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
        <div id="sync-progress-book" style="font-size:.78rem;color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('#sync-modal-close').addEventListener('click', close);
  backdrop.querySelector('#sync-modal-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#sync-modal-confirm').addEventListener('click', () => {
    const shelfName = backdrop.querySelector('#sync-shelf-name').value.trim();
    if (!shelfName) return;

    // Switch to progress phase
    backdrop.querySelector('#sync-form').hidden = true;
    backdrop.querySelector('#sync-progress').hidden = false;
    backdrop.querySelector('#sync-modal-close').disabled = true;

    const token   = encodeURIComponent(localStorage.getItem('br_token') || '');
    const params  = new URLSearchParams({
      serverId:  currentServer.id,
      folderUrl: folderUrl || '',
      shelfName,
      token:     localStorage.getItem('br_token') || '',
    });
    const es = new EventSource(`/api/opds/sync-sse?${params.toString()}`);
    let total = 0;

    const fillEl = backdrop.querySelector('#sync-progress-fill');
    const textEl = backdrop.querySelector('#sync-progress-text');
    const bookEl = backdrop.querySelector('#sync-progress-book');

    es.addEventListener('message', e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

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
      const summary = msg.errors
        ? t('opds.sync_done_errors', { added: msg.added, skipped: msg.skipped, errors: msg.errors })
        : t('opds.sync_done', { added: msg.added, skipped: msg.skipped });
        if (msg.staleBooks && msg.staleBooks.length > 0) {
          // Show stale books dialog before closing
          const stale = msg.staleBooks;
          close(); // close progress modal first
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
      es.close();
      toast.error(t('opds.err_sse_disconnected'));
      close();
    };
  });
}

// ── Stale books dialog ────────────────────────────────────────────────────────
function openStaleDialog(staleBooks, shelfId, syncSummary) {
  document.getElementById('stale-modal')?.remove();
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
  backdrop.querySelector('#stale-skip').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#stale-delete').addEventListener('click', async () => {
    const checked = [...backdrop.querySelectorAll('.stale-chk:checked')].map(el => Number(el.value));
    if (!checked.length) { close(); return; }
    let deleted = 0;
    for (const bookId of checked) {
      try {
        await apiFetch(`/books/${bookId}`, { method: 'DELETE' });
        deleted++;
      } catch { /* ignore */ }
    }
    backdrop.remove();
    reloadShelves();
    toast.success(t('opds.stale_deleted', { summary: syncSummary, n: deleted }));
  });
}

// ── Language change ───────────────────────────────────────────────────────────
document.addEventListener('langchange', () => {
  applyTranslations(); // update data-i18n static elements
  if (_lastFeed) {
    catalogGrid.innerHTML = '';
    renderFeed(_lastFeed); // re-render tiles/rows with new language
  }
  // Note: do NOT call renderServerList() here — it would lose connected/error state
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadServers();
