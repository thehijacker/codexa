import { apiFetch } from './api.js';
import { toast, setButtonLoading, showBlockingOverlay } from './ui.js';
import { t, applyTranslations } from './i18n.js';
import { reloadShelves } from './sidebar.js';
import { reloadLibrary, openInfoModal } from './library.js';
import { showPanel } from './router.js';

// ── State ─────────────────────────────────────────────────────────────────────
let servers       = [];
let currentServer = null;
// [{title, url, upUrl, children}] — the single source of truth for breadcrumb, the "Up" button,
// AND the left folder tree: navStack[i].children is the list of nav (folder) entries visible
// when navStack[i] was browsed, i.e. exactly the sibling list shown under that depth in the
// tree. Since the tree only ever shows ONE expanded path (the current breadcrumb), there is no
// separate tree-expand state to keep in sync — it's derived straight from this array.
let navStack      = [];
let _lastFeed     = null;  // last rendered feed, for re-render on lang change
let _initialized  = false;

// Pagination state for current browse level
let pageHistory    = [];  // stack of URLs for each page visited (index = page number - 1)
let currentFeed    = null; // the last loaded feed (has .next, .entries etc.)
let serverHealth   = {};  // id -> { reachable, checkedAt } — from GET /opds/health, all servers

// ── DOM refs (assigned in initOpds) ──────────────────────────────────────────
let serverList, serverEmpty, folderTree, catalogTitle, breadcrumb,
    catalogGrid, opdsWelcome, navTilesEl, bookGridEl, catalogEmpty,
    catalogSearch, btnSearch, btnUp, loadingEl,
    sidebarEl, drawerToggle, drawerClose, drawerOverlay;

// ── Utility ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function coverSrc(url, serverId) {
  if (!url) return null;
  const token = localStorage.getItem('br_token') || '';
  return `/api/opds/cover?url=${encodeURIComponent(url)}&server=${serverId}&token=${encodeURIComponent(token)}`;
}

// ── Folder-path cache (root→folder breadcrumb/tree chains) ──────────────────
// Persisted in localStorage, keyed by serverId+folder URL, so a repeat "Open in OPDS" (or
// revisiting any folder you've browsed before) is instant instead of re-running the
// resolveFolderPath breadth-first search every time. Populated two ways: automatically by every
// successful browseUrl() (ordinary browsing organically fills this in for free), and explicitly
// after resolveFolderPath() resolves a fresh deep link. Always paired with a real browseUrl()
// call for the actual content, so a stale cached ancestor structure only affects the tree's
// display of sibling folders — the books/subfolders you actually see are always fetched fresh.
const FOLDER_PATH_CACHE_KEY = 'br_opds_folder_paths';
const FOLDER_PATH_CACHE_MAX = 200; // oldest entries evicted first (FIFO via object key order)

function loadFolderPathCache() {
  try { return JSON.parse(localStorage.getItem(FOLDER_PATH_CACHE_KEY) || '{}'); } catch { return {}; }
}

function cacheFolderPath(serverId, targetUrl, chain) {
  if (targetUrl == null) return; // the root itself needs no caching
  try {
    const cache = loadFolderPathCache();
    cache[`${serverId}::${targetUrl}`] = chain.map(l => ({ title: l.title, url: l.url, children: l.children }));
    const keys = Object.keys(cache);
    if (keys.length > FOLDER_PATH_CACHE_MAX) {
      for (const k of keys.slice(0, keys.length - FOLDER_PATH_CACHE_MAX)) delete cache[k];
    }
    localStorage.setItem(FOLDER_PATH_CACHE_KEY, JSON.stringify(cache));
  } catch { /* storage full/unavailable — non-critical, just means no speedup next time */ }
}

function getCachedFolderPath(serverId, targetUrl) {
  return loadFolderPathCache()[`${serverId}::${targetUrl}`] || null;
}

// ── Mobile off-canvas drawer (mirrors bookorbit.js's openDrawer/closeDrawer) ──
function openDrawer() {
  sidebarEl.classList.add('opds-drawer-open');
  drawerOverlay.classList.add('visible');
}
function closeDrawer() {
  sidebarEl.classList.remove('opds-drawer-open');
  drawerOverlay.classList.remove('visible');
}

// ── Resume state (mirrors bookorbit.js's saveResumeState/restoreResumeState) ─
// Lets closing a book found via OPDS come back to the same server/folder instead of the
// default library view (reader.js reads ?from=opds the same way it already reads
// ?from=bookorbit).
const RESUME_KEY = 'br_opds_resume';

function saveResumeState() {
  if (!currentServer) return;
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({
      serverId: currentServer.id,
      path: navStack.map(l => ({ title: l.title, url: l.url })),
    }));
  } catch { /* ignore */ }
}

// One-shot: restores server + breadcrumb path and re-browses the current (last) level. Ancestor
// levels' folder-tree rows stay empty until the user visits them via Up/breadcrumb (which
// re-fetches and populates .children then) — re-fetching every ancestor up front just to fill in
// the tree isn't worth a cascade of extra requests on every resume.
async function restoreResumeState() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null'); } catch { saved = null; }
  sessionStorage.removeItem(RESUME_KEY);
  if (!saved || !Array.isArray(saved.path) || !saved.path.length) return false;

  const server = servers.find(s => s.id === saved.serverId);
  if (!server) return false;

  currentServer = server;
  navStack = saved.path.map(l => ({ title: l.title, url: l.url, upUrl: null, children: null }));
  renderServerList();

  // The tree renders by recursing from depth 0 down through each level's .children — a single
  // missing link anywhere in that chain (every ancestor starts as null right after a resume)
  // hides the *entire* tree, not just that one level. Fetch every ancestor's sibling list in
  // parallel so the chain is unbroken; the deepest level gets its .children (and the right-pane
  // content) from the normal browseUrl call below.
  const ancestors = navStack.slice(0, -1);
  await Promise.all(ancestors.map(async level => {
    try {
      const params = level.url ? `?url=${encodeURIComponent(level.url)}` : '';
      const feed = await apiFetch(`/opds/browse/${currentServer.id}${params}`);
      level.children = feed.entries.filter(e => e.isNav);
    } catch { /* leave children null — that row just won't show, the rest of the tree still will */ }
  }));

  await browseUrl(navStack[navStack.length - 1].url);
  return true;
}

// ── Server list ───────────────────────────────────────────────────────────────
async function loadServers() {
  try {
    servers = await apiFetch('/opds/servers');
    renderServerList();
    checkServerHealth(); // fire-and-forget — colors the list once results arrive
  } catch (err) {
    toast.error(t('opds.err_load_servers', { msg: err.message }));
  }
}

// Batch reachability check for every configured server (not just whichever one is open) —
// mirrors BookOrbit's GET /bookorbit/health pattern.
async function checkServerHealth() {
  try {
    serverHealth = await apiFetch('/opds/health');
  } catch {
    serverHealth = {};
  }
  renderServerList();
}

function renderServerList() {
  serverList.innerHTML = '';
  serverEmpty.hidden = servers.length > 0;

  servers.forEach(s => {
    const btn = document.createElement('button');
    const isActive = currentServer?.id === s.id;
    const health   = serverHealth[s.id];
    btn.className  = 'server-btn'
      + (isActive ? ' active' : '')
      + (health?.reachable === true  ? ' reachable'   : '')
      + (health?.reachable === false ? ' unreachable' : '');
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
  navStack      = [{ title: server.name, url: null, upUrl: null, children: null }];
  renderServerList();
  await browseUrl(null);
}

// Navigate into a nav (folder) entry that is a child of navStack[parentDepth]. Shared by both
// the left folder tree's rows and the right pane's folder tiles, so both stay in sync — clicking
// either one is exactly the same navigation.
function navigateToFolder(entry, parentDepth) {
  navStack = navStack.slice(0, parentDepth + 1);
  navStack.push({ title: entry.title, url: entry.navHref, upUrl: null, children: null });
  closeDrawer();
  browseUrl(entry.navHref);
}

async function browseUrl(url) {
  setLoading(true);
  catalogEmpty.hidden = true;
  catalogSearch.value = '';
  // Reset pagination when navigating to a new folder
  pageHistory = url !== undefined ? [url] : [null];

  try {
    const params = url ? `?url=${encodeURIComponent(url)}` : '';
    const feed   = await apiFetch(`/opds/browse/${currentServer.id}${params}`);
    currentFeed  = feed;

    if (navStack.length > 0) {
      const level = navStack[navStack.length - 1];
      // Prefer whatever title this level already has (set correctly from the parent's own entry
      // list — see navigateToFolder/resolveFolderPath) over the folder's own self-reported feed
      // title, which some OPDS servers report generically (e.g. the same name for every leaf
      // feed) regardless of the folder's real name. Only fall back to feed.title when nothing
      // better is known yet (e.g. the very first root browse).
      level.title    = level.title || feed.title;
      level.upUrl    = feed.up || null;
      level.children = feed.entries.filter(e => e.isNav);
    }
    renderBreadcrumb();
    renderFolderTree();
    renderFeed(feed);
    renderPagination();
    btnUp.disabled = !feed.up && navStack.length <= 1;
    cacheFolderPath(currentServer.id, url, navStack); // organically speeds up future deep links
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
  catalogEmpty.hidden = true;
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

// ── Folder tree (left sidebar, below the server list) ────────────────────────
function renderFolderTree() {
  folderTree.innerHTML = '';
  if (!currentServer) return;
  renderTreeLevel(0);
}

// Recursive: a child's own children (the next level down) must render directly beneath that
// specific row — appending each level as a whole flat batch (all of level 0, then all of level
// 1, ...) put every subfolder list at the very end regardless of which sibling was clicked.
function renderTreeLevel(depth) {
  const level = navStack[depth];
  if (!level?.children) return; // not yet fetched (e.g. an ancestor left over from a resume)
  const activeUrl = navStack[depth + 1]?.url ?? null;

  level.children.forEach(entry => {
    const isActive = entry.navHref === activeUrl;

    const row = document.createElement('div');
    row.className = 'opds-tree-row';
    row.style.paddingLeft = `${Math.min(depth, 6) * 14}px`;

    const item = document.createElement('button');
    item.className = 'opds-tree-item' + (isActive ? ' active' : '');
    item.innerHTML = `<img src="/images/folder.svg" class="nav-icon nav-icon-folder" alt=""><span class="opds-tree-name">${escHtml(entry.title)}</span>`;
    item.addEventListener('click', () => navigateToFolder(entry, depth));
    row.appendChild(item);

    const syncBtn = document.createElement('button');
    syncBtn.className = 'opds-tree-sync-btn';
    syncBtn.title = t('opds.sync_title');
    syncBtn.textContent = '⇅'; // icon-only, matching BookOrbit's .bookorbit-sublist-sync-btn
    syncBtn.addEventListener('click', e => {
      e.stopPropagation();
      openSyncModal(entry.navHref, entry.title);
    });
    row.appendChild(syncBtn);

    folderTree.appendChild(row);

    if (isActive) renderTreeLevel(depth + 1);
  });
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

// ── Right pane: folder tiles + book-card grid ────────────────────────────────
// Nav entries → folder tiles (unchanged from before); book entries → a density-aware card grid
// (replacing the old flat expandable .book-row list) mirroring bookorbit.js's card component.
function renderFeed(feed) {
  _lastFeed = feed;

  const navEntries  = feed.entries?.filter(e => e.isNav)  || [];
  const bookEntries = feed.entries?.filter(e => !e.isNav) || [];

  opdsWelcome.hidden = true;
  catalogEmpty.hidden = !!(navEntries.length || bookEntries.length);

  // — Navigation tiles —
  navTilesEl.hidden = navEntries.length === 0;
  navTilesEl.innerHTML = '';
  navEntries.forEach(entry => {
    const tile = document.createElement('button');
    tile.className = 'nav-tile';
    tile.innerHTML = `<img src="/images/folder.svg" class="nav-icon nav-icon-folder" alt=""><span class="nav-tile-label">${escHtml(entry.title)}</span>
      <button class="nav-tile-sync-btn" title="${t('opds.sync_title')}">${t('opds.btn_sync_short')}</button>`;
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.nav-tile-sync-btn')) return;
      navigateToFolder(entry, navStack.length - 1);
    });
    tile.querySelector('.nav-tile-sync-btn').addEventListener('click', e => {
      e.stopPropagation();
      openSyncModal(entry.navHref, entry.title);
    });
    navTilesEl.appendChild(tile);
  });

  // — Book cards —
  bookGridEl.hidden = bookEntries.length === 0;
  bookGridEl.innerHTML = '';
  bookEntries.forEach(entry => bookGridEl.appendChild(renderBookCard(entry)));
}

function coverPlaceholder() {
  const ph = document.createElement('div');
  ph.className = 'opds-card-cover opds-card-cover-ph';
  ph.textContent = '📖';
  return ph;
}

function renderBookCard(entry) {
  const card = document.createElement('div');
  card.className = 'opds-card';

  const coverWrap = document.createElement('div');
  coverWrap.className = 'opds-card-cover-wrap';

  const imgSrc = coverSrc(entry.cover, currentServer.id);
  if (imgSrc) {
    const img = document.createElement('img');
    img.className = 'opds-card-cover';
    img.src = imgSrc;
    img.loading = 'lazy';
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(coverPlaceholder()), { once: true });
    coverWrap.appendChild(img);
  } else {
    coverWrap.appendChild(coverPlaceholder());
  }

  const actions = document.createElement('div');
  actions.className = 'opds-card-actions';
  coverWrap.appendChild(actions);
  renderCardActions(actions, entry);

  card.appendChild(coverWrap);

  const info = document.createElement('div');
  info.className = 'opds-card-info';
  info.innerHTML = `
    <div class="opds-card-title" title="${escHtml(entry.title)}">${escHtml(entry.title)}</div>
    ${entry.author ? `<div class="opds-card-author">${escHtml(entry.author)}</div>` : ''}
  `;
  card.appendChild(info);

  // Touch devices have no hover — first tap reveals the action icons instead.
  card.addEventListener('click', e => {
    if (e.target.closest('.opds-card-actions') || e.target.closest('.opds-card-peek-btn')) return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    const wasTapped = card.classList.contains('tapped');
    document.querySelectorAll('.opds-card.tapped').forEach(c => c.classList.remove('tapped'));
    if (!wasTapped) card.classList.add('tapped');
  });

  return card;
}

// Always-visible peek icon, bottom-right of the cover — mirrors bookorbit.js's renderPeekButton:
// a real link straight to the reader for an already-downloaded book, or (for a not-yet-downloaded
// one) a button that fetches it into a short-lived ephemeral "books" row first (server:
// createOpdsPeek in server/routes/opds.js — never lands in the permanent library, auto-cleaned on
// close or by the background sweep, see server/utils/peekCleanup.js) then navigates to the same
// read-only reader URL scheme.
function renderPeekButton(coverWrapEl, entry) {
  coverWrapEl.querySelector('.opds-card-peek-btn')?.remove();

  if (entry.localBookId) {
    const link = document.createElement('a');
    link.className = 'opds-card-peek-btn';
    link.href = `/reader.html?id=${entry.localBookId}&peek=1&from=opds`;
    link.title = t('opds.btn_peek');
    link.innerHTML = `<img src="/images/peek.svg" class="nav-icon nav-icon-peek" alt="">`;
    link.addEventListener('click', () => saveResumeState());
    coverWrapEl.appendChild(link);
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'opds-card-peek-btn';
  btn.innerHTML = `<img src="/images/peek.svg" class="nav-icon nav-icon-peek" alt="">`;
  if (!entry.acqHref) {
    btn.disabled = true;
    btn.title = t('bookorbit.no_file');
  } else {
    btn.title = t('opds.btn_peek');
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      btn.classList.add('opds-btn-busy');
      // See bookorbit.js's identical peek handler for why this needs a blocking overlay instead
      // of real byte progress: the download happens server-side (OPDS acquisition), so the
      // client only sees a single request resolve at the end, with no intermediate progress.
      let cancelled = false;
      const overlay = showBlockingOverlay(t('bookorbit.peek_downloading'), () => {
        cancelled = true;
        btn.disabled = false;
        btn.classList.remove('opds-btn-busy');
      });
      const slowTimer = setTimeout(() => overlay.setMessage(t('common.download_slow_hint')), 8000);
      try {
        const result = await apiFetch(`/opds/peek/${currentServer.id}`, {
          method: 'POST',
          body: JSON.stringify({ href: entry.acqHref, title: entry.title, author: entry.author }),
        });
        clearTimeout(slowTimer);
        if (cancelled) {
          apiFetch(`/books/${result.id}/peek-cleanup`, { method: 'POST' }).catch(() => {});
          return;
        }
        overlay.dismiss();
        saveResumeState();
        window.location.href = `/reader.html?id=${result.id}&peek=1&from=opds`;
      } catch (err) {
        clearTimeout(slowTimer);
        if (!cancelled) {
          overlay.dismiss();
          toast.error(err.message);
          btn.disabled = false;
          btn.classList.remove('opds-btn-busy');
        }
      }
    });
  }
  coverWrapEl.appendChild(btn);
}

function renderCardActions(actionsEl, entry) {
  actionsEl.innerHTML = '';
  renderPeekButton(actionsEl.closest('.opds-card-cover-wrap'), entry);

  if (entry.localBookId) {
    const readBtn = document.createElement('a');
    readBtn.className = 'btn-icon';
    readBtn.href = `/reader.html?id=${entry.localBookId}&from=opds`;
    readBtn.title = t('library.btn_read');
    readBtn.innerHTML = `<img src="/images/read.svg" class="nav-icon nav-icon-read" alt="">`;
    readBtn.addEventListener('click', () => saveResumeState());
    actionsEl.appendChild(readBtn);

    const infoBtn = document.createElement('button');
    infoBtn.className = 'btn-icon';
    infoBtn.title = t('opds.btn_book_info');
    infoBtn.textContent = 'ℹ';
    infoBtn.addEventListener('click', e => {
      e.stopPropagation();
      openInfoModal({ id: entry.localBookId }).catch(() => {});
    });
    actionsEl.appendChild(infoBtn);
    return;
  }

  if (entry.acqHref) {
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn-icon';
    dlBtn.title = t('opds.btn_add');
    dlBtn.textContent = '+';
    dlBtn.style.fontWeight = '700';
    dlBtn.style.fontSize = '1.2rem';
    dlBtn.addEventListener('click', async e => {
      e.stopPropagation();
      dlBtn.disabled = true;
      dlBtn.classList.add('opds-btn-busy');
      try {
        const data = await apiFetch(`/opds/download/${currentServer.id}`, {
          method: 'POST',
          body: JSON.stringify({ href: entry.acqHref, title: entry.title, author: entry.author, cover: entry.cover }),
        });
        toast.success(t('opds.toast_book_added', { title: entry.title }));
        entry.localBookId = data.id;
        renderCardActions(actionsEl, entry);
        reloadLibrary().catch(e2 => console.error('[opds] reloadLibrary failed:', e2));
      } catch (err) {
        const bookId = err.data?.id;
        if (bookId) {
          toast.info(t('opds.err_already_in_library'));
          entry.localBookId = bookId;
          renderCardActions(actionsEl, entry);
        } else {
          toast.error(err.message);
          dlBtn.disabled = false;
          dlBtn.classList.remove('opds-btn-busy');
        }
      }
    });
    actionsEl.appendChild(dlBtn);
  }

  const infoBtn = document.createElement('button');
  infoBtn.className = 'btn-icon';
  infoBtn.title = t('opds.btn_book_info');
  infoBtn.textContent = 'ℹ';
  infoBtn.addEventListener('click', e => {
    e.stopPropagation();
    openOpdsDetailModal(entry);
  });
  actionsEl.appendChild(infoBtn);
}

// ── Lightweight detail modal (books not yet downloaded) ──────────────────────
// Mirrors bookorbit.js's openBookorbitDetailModal, but needs no extra fetch or metadata grid —
// an OPDS entry already carries everything it will ever have (title/author/summary/cover;
// confirmed via normaliseAtomFeed/normaliseOpds2Feed in server/routes/opds.js). If the book is
// already in the library, Info opens the full tabbed openInfoModal instead (see renderCardActions).
function openOpdsDetailModal(entry) {
  document.getElementById('opds-detail-modal')?.remove();
  const imgSrc = coverSrc(entry.cover, currentServer.id);

  const backdrop = document.createElement('div');
  backdrop.id = 'opds-detail-modal';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal info-modal" role="dialog" aria-modal="true">
      <button class="modal-close" id="ood-close" aria-label="${escHtml(t('common.close'))}">&times;</button>
      <div class="info-modal-header">
        <div class="info-modal-cover-wrap">
          ${imgSrc
            ? `<img class="info-modal-cover info-modal-cover-clickable" src="${escHtml(imgSrc)}" alt="" />`
            : `<div class="info-modal-cover info-modal-cover-ph">\u{1F4D6}</div>`}
        </div>
        <div class="info-modal-hero">
          <h3 class="info-modal-title">${escHtml(entry.title || '')}</h3>
          <div class="info-modal-author">${escHtml(entry.author || t('library.unknown_author'))}</div>
        </div>
      </div>
      <div class="info-modal-tab-content" style="max-height:40vh;overflow-y:auto">
        ${entry.summary
          ? `<div class="info-modal-desc">${escHtml(entry.summary)}</div>`
          : `<div class="imt-empty">${t('opds.no_description')}</div>`}
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('#ood-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.info-modal-cover-clickable')?.addEventListener('click', e => {
    e.stopPropagation();
    openOpdsCoverPreview(imgSrc);
  });
}

// Full-size cover preview — mirrors bookorbit.js's openBookorbitCoverPreview (itself a sibling of
// library.js's openCoverPreview, which is hardwired to local books' /covers/:path).
function openOpdsCoverPreview(imgSrc) {
  if (!imgSrc) return;
  document.getElementById('cover-preview-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cover-preview-overlay';
  overlay.className = 'cover-preview-overlay';
  overlay.innerHTML = `<img src="${escHtml(imgSrc)}" alt="" class="cover-preview-img" />`;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
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
  catalogEmpty.hidden = true;

  try {
    const feed = await apiFetch(`/opds/search/${currentServer.id}?q=${encodeURIComponent(q)}`);
    currentFeed  = feed;
    pageHistory  = [];  // search results are a single, non-pageable set
    // Append a synthetic search-crumb level on top of wherever the user already was, instead of
    // replacing navStack outright — that used to wipe every real level's cached .children,
    // leaving the folder tree blank until "Up" was pressed. Replace (not stack) an existing
    // search-crumb if searching again while already in search mode.
    const basePath = navStack[navStack.length - 1]?.isSearch ? navStack.slice(0, -1) : navStack;
    navStack = [...basePath, { title: t('opds.search_crumb', { q }), url: null, upUrl: null, children: null, isSearch: true }];
    renderBreadcrumb();
    renderFolderTree();
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
export function openSyncModal(folderUrl, folderTitle, existingShelfId = null, serverId = null) {
  const effectiveServerId = serverId ?? currentServer?.id;
  if (effectiveServerId == null) { console.warn('[opds] openSyncModal: no server selected'); return; }
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
        <div style="display:flex;align-items:flex-start;gap:.6rem;margin:.75rem 0 .1rem">
          <input type="checkbox" id="sync-force" style="margin-top:.18rem;flex-shrink:0">
          <label for="sync-force" style="font-size:.85rem;cursor:pointer">
            <span style="font-weight:600">${t('opds.sync_force_label')}</span>
            <span style="display:block;font-size:.78rem;color:var(--color-text-muted);margin-top:.15rem">${t('opds.sync_force_hint')}</span>
          </label>
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
  apiFetch(`/opds/sync-count?serverId=${encodeURIComponent(effectiveServerId)}&folderUrl=${encodeURIComponent(folderUrl || '')}`)
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
    const force     = backdrop.querySelector('#sync-force').checked;

    // Switch to progress phase
    backdrop.querySelector('#sync-form').hidden = true;
    backdrop.querySelector('#sync-progress').hidden = false;
    backdrop.querySelector('#sync-modal-close').disabled = true;

    const params  = new URLSearchParams({
      serverId:  effectiveServerId,
      folderUrl: folderUrl || '',
      shelfName,
      token:     localStorage.getItem('br_token') || '',
    });
    if (limit && limit > 0) params.set('limit', limit);
    if (force) params.set('force', '1');
    if (existingShelfId) params.set('shelfId', String(existingShelfId));

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
        let summary = msg.refreshed
          ? t('opds.sync_done_force', { added: msg.added, refreshed: msg.refreshed, errors: msg.errors || 0 })
          : msg.errors
            ? t('opds.sync_done_errors', { added: msg.added, skipped: msg.skipped, errors: msg.errors })
            : t('opds.sync_done', { added: msg.added, skipped: msg.skipped });
        // Books auto-unlinked from this shelf because they're still present on another one
        // (e.g. moved to a different linked shelf) — no dialog needed, just note it happened.
        if (msg.autoRemoved) summary += ' ' + t('opds.stale_auto_removed', { n: msg.autoRemoved });
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
    renderFeed(_lastFeed);
    renderPagination();
  }
  renderFolderTree();
  // Note: do NOT call renderServerList() here — it would lose reachable/unreachable state
});

// ── OPDS servers changed (added / edited / deleted in Settings) ───────────────
document.addEventListener('opdsserverschanged', async () => {
  if (!_initialized) return;
  try {
    servers = await apiFetch('/opds/servers');
    // Re-check health from scratch rather than trying to prune the old map by id — server "id"
    // is really just an array index, which shifts on delete, so pruning by stale id could
    // silently misattribute a leftover health entry to the wrong server.
    checkServerHealth();
    // If the current server was removed, open the first available one
    if (currentServer && !servers.find(s => s.id === currentServer.id)) {
      if (servers.length > 0) {
        openServer(servers[0]);
      } else {
        currentServer = null;
        navStack = [];
        opdsWelcome.hidden = false;
        navTilesEl.hidden = true;
        bookGridEl.hidden = true;
        renderBreadcrumb();
        renderFolderTree();
      }
    } else {
      renderServerList();
    }
  } catch { /* ignore */ }
});

// Reconstructs the full root→target breadcrumb/tree path for a deep link that only knows the
// target folder's own URL (e.g. a linked shelf's stored opds_folder_url) — used by
// openOpdsBrowserAtFolder below. Deliberately does NOT use the OPDS `up` link to walk backward —
// `up` is optional per spec and plenty of servers omit it below the top level, which silently
// collapses the walk to just one hop (reproducing the original 2-level bug). Instead this
// breadth-first searches *forward* from the root using navHref links only, since every folder is
// guaranteed reachable that way — it's how normal browsing already works. Bounded to MAX_DEPTH
// levels and de-duplicates visited URLs as a cycle guard.
async function resolveFolderPath(server, targetUrl) {
  const MAX_DEPTH = 5;
  const rootFeed = await apiFetch(`/opds/browse/${server.id}`);
  const rootChildren = rootFeed.entries.filter(e => e.isNav);
  const rootLevel = { title: server.name, url: null, upUrl: null, children: rootChildren };

  let frontier = [{ path: [rootLevel], children: rootChildren }];
  const visited = new Set();

  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    // Check this depth's already-fetched children for the target before fetching anything new.
    for (const { path, children } of frontier) {
      const match = children.find(e => e.navHref === targetUrl);
      if (match) {
        const feed = await apiFetch(`/opds/browse/${server.id}?url=${encodeURIComponent(targetUrl)}`);
        return [...path, { title: match.title, url: targetUrl, upUrl: null, children: feed.entries.filter(e => e.isNav) }];
      }
    }

    const candidates = [];
    for (const { path, children } of frontier) {
      for (const entry of children) {
        if (visited.has(entry.navHref)) continue;
        visited.add(entry.navHref);
        candidates.push({ entry, path });
      }
    }
    if (!candidates.length) break;

    const fetched = await Promise.all(candidates.map(async ({ entry, path }) => {
      try {
        const feed = await apiFetch(`/opds/browse/${server.id}?url=${encodeURIComponent(entry.navHref)}`);
        return { entry, path, children: feed.entries.filter(e => e.isNav) };
      } catch {
        return { entry, path, children: [] };
      }
    }));

    frontier = fetched.map(({ path, entry, children }) => ({
      path: [...path, { title: entry.title, url: entry.navHref, upUrl: null, children }],
      children,
    }));
  }

  throw new Error(`folder not found within ${MAX_DEPTH} levels`);
}

// ── Deep-link into OPDS browser at a specific server + folder URL ────────────
export async function openOpdsBrowserAtFolder(serverId, folderUrl) {
  await showPanel('opds'); // ensures initOpds/loadServers completes first
  const server = servers.find(s => s.id === parseInt(serverId, 10));
  if (!server) return;
  currentServer = server;

  const cached = getCachedFolderPath(server.id, folderUrl);
  if (cached) {
    // Instant — skip the breadth-first search entirely. browseUrl() below still fetches the
    // target folder's own content fresh either way, and re-writes this same cache entry, so a
    // stale cached ancestor structure (if the catalog was reorganized) self-heals on next visit.
    navStack = cached.map(l => ({ title: l.title, url: l.url, upUrl: null, children: l.children }));
  } else {
    try {
      navStack = await resolveFolderPath(server, folderUrl);
    } catch {
      // Fall back to the old flat guess (still gets you to the right content, just without a
      // full breadcrumb/tree — better than failing the whole deep link over a transient error).
      navStack = [
        { title: server.name, url: null, upUrl: null, children: null },
        { title: '', url: folderUrl, upUrl: null, children: null },
      ];
    }
  }
  renderServerList();
  browseUrl(folderUrl);
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initOpds() {
  if (_initialized) return;
  _initialized = true;

  serverList    = document.getElementById('server-list');
  serverEmpty   = document.getElementById('server-empty');
  folderTree    = document.getElementById('opds-folder-tree');
  catalogTitle  = document.getElementById('catalog-title');
  breadcrumb    = document.getElementById('breadcrumb');
  catalogGrid   = document.getElementById('catalog-grid');
  opdsWelcome   = document.getElementById('opds-welcome');
  navTilesEl    = document.getElementById('opds-nav-tiles');
  bookGridEl    = document.getElementById('opds-book-grid');
  catalogEmpty  = document.getElementById('catalog-empty');
  catalogSearch = document.getElementById('catalog-search');
  btnSearch     = document.getElementById('btn-catalog-search');
  btnUp         = document.getElementById('btn-catalog-up');
  loadingEl     = document.getElementById('catalog-loading');
  sidebarEl     = document.getElementById('opds-sidebar');
  drawerToggle  = document.getElementById('opds-drawer-toggle');
  drawerClose   = document.getElementById('opds-drawer-close');
  drawerOverlay = document.getElementById('opds-drawer-overlay');

  btnUp.addEventListener('click', () => {
    if (navStack.length > 1) {
      navStack.pop();
      const prev = navStack[navStack.length - 1];
      browseUrl(prev.url);
    }
  });

  btnSearch.addEventListener('click', doSearch);
  catalogSearch.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  document.getElementById('btn-opds-go-settings')?.addEventListener('click', () => showPanel('settings', true, { tab: 'opds' }));
  document.querySelector('.btn-opds-settings-link')?.addEventListener('click', () => showPanel('settings', true, { tab: 'opds' }));

  drawerToggle.addEventListener('click', openDrawer);
  drawerClose.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);

  await loadServers();
  const restored = await restoreResumeState();
  if (!restored) {
    if (servers.length > 0) await openServer(servers[0]);
    // Start open on mobile — nothing to browse yet until a server/folder is picked. Skipped on a
    // successful resume (returning from a peek in the reader): we're already landing on a
    // specific folder, so re-opening the drawer would just cover the results we're returning to.
    openDrawer();
  }
}
