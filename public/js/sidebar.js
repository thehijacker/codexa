/**
 * sidebar.js — shared sidebar module used by all pages (library, settings, opds).
 * Handles: rendering, shelf loading, collapse/expand, mobile toggle, logout, active state.
 * Exports: initSidebar, reloadShelves, getShelves, setActive
 */
import { apiFetch, requireAuth, clearToken } from './api.js';
import { t, initIconLangPicker } from './i18n.js';
import { showPanel, getCurrentPanel } from './router.js';

const LIB_THEME_KEY = 'br_library_theme';
const LIB_THEMES = new Set(['system', 'day', 'night', 'eink']);

let shelves         = [];
let _activePage     = 'library';
let _onShelfSelect  = null;
let _activeShelfId  = 'all';
let _readingCount   = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {Function|null} opts.onShelfSelect  called(shelfId) when a library shelf is selected
 * @param {string|number}  opts.activeShelfId  'all' | 'reading' | shelf-id
 */
export async function initSidebar({ onShelfSelect = null, activeShelfId = 'all' } = {}) {
  if (!requireAuth()) return;

  _onShelfSelect = onShelfSelect;
  _activeShelfId = activeShelfId;

  const sidebar = document.getElementById('app-sidebar');
  if (!sidebar) return;

  sidebar.innerHTML = buildSidebarHtml();
  initLibraryThemeControls(sidebar);
  initSidebarLangPicker(sidebar.querySelector('#sidebar-lang-picker'));

  // Username
  const user = JSON.parse(localStorage.getItem('br_user') || '{}');
  sidebar.querySelector('#sidebar-username').textContent = user.name || user.username || '';

  // Collapse / expand
  const collapseBtn = sidebar.querySelector('#sidebar-collapse-btn');
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    sidebar.classList.add('collapsed');
    collapseBtn.textContent = '›';
    collapseBtn.title = t('sidebar.expand');
  }
  collapseBtn.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 768px)').matches) { closeSidebar(); return; }
    const collapsed = sidebar.classList.toggle('collapsed');
    collapseBtn.textContent = collapsed ? '›' : '‹';
    collapseBtn.title = collapsed ? t('sidebar.expand') : t('sidebar.collapse');
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  });

  // Mobile open / close
  document.getElementById('sidebar-open-btn')?.addEventListener('click', openSidebar);
  document.getElementById('sidebar-overlay')?.addEventListener('click', closeSidebar);

  // Logout
  sidebar.querySelector('#sidebar-logout-btn').addEventListener('click', () => {
    clearToken();
    window.location.href = '/login.html';
  });

  // Nav: Trenutno berem
  sidebar.querySelector('#nav-currently-reading').addEventListener('click', e => {
    e.preventDefault();
    navigate('reading');
  });

  // Nav: Vsa knjižnica
  sidebar.querySelector('#nav-all-books').addEventListener('click', e => {
    e.preventDefault();
    navigate('all');
  });

  // Add shelf button
  sidebar.querySelector('#add-shelf-btn').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('sidebar:addshelf'));
  });

  // Nav: Settings and OPDS panels
  sidebar.querySelector('#nav-settings')?.addEventListener('click', e => {
    e.preventDefault(); showPanel('settings'); closeSidebar();
  });
  sidebar.querySelector('#nav-opds')?.addEventListener('click', e => {
    e.preventDefault(); showPanel('opds'); closeSidebar();
  });

  // Statistics button
  sidebar.querySelector('#sidebar-stats-btn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('sidebar:stats'));
  });

  // Active item will be set by panelchange event; set initial state from router
  const currentPanel = getCurrentPanel() || 'library';
  if (currentPanel === 'settings') {
    sidebar.querySelector('#nav-settings')?.classList.add('sidebar-item-active');
  } else if (currentPanel === 'opds') {
    sidebar.querySelector('#nav-opds')?.classList.add('sidebar-item-active');
  } else {
    setActive(activeShelfId);
  }

  // Update active sidebar item whenever the router switches panels
  document.addEventListener('panelchange', e => {
    _activePage = e.detail.panel;
    if (_activePage === 'settings') {
      document.querySelectorAll('#nav-all-books, #nav-currently-reading, .sidebar-shelf-item, #nav-opds')
        .forEach(el => el.classList.remove('sidebar-item-active'));
      document.getElementById('nav-settings')?.classList.add('sidebar-item-active');
    } else if (_activePage === 'opds') {
      document.querySelectorAll('#nav-all-books, #nav-currently-reading, .sidebar-shelf-item, #nav-settings')
        .forEach(el => el.classList.remove('sidebar-item-active'));
      document.getElementById('nav-opds')?.classList.add('sidebar-item-active');
    } else {
      document.getElementById('nav-settings')?.classList.remove('sidebar-item-active');
      document.getElementById('nav-opds')?.classList.remove('sidebar-item-active');
      setActive(_activeShelfId);
    }
  });

  await loadNavCounts();
  await reloadShelves();
}

async function loadNavCounts() {
  try {
    const books = await apiFetch('/books');
    const allEl     = document.getElementById('nav-all-count');
    const readingEl = document.getElementById('nav-reading-count');
    if (allEl) allEl.textContent = books.length;
    _readingCount = books.filter(b => (b.percentage || 0) > 0).length;
    if (readingEl) readingEl.textContent = _readingCount;
    applyCurrentlyReadingVisibility();
  } catch { /* non-critical */ }
}

function applyCurrentlyReadingVisibility() {
  const navEl = document.getElementById('nav-currently-reading');
  if (!navEl) return;
  navEl.style.display = _readingCount > 0 ? '' : 'none';
}

export async function reloadShelves() {
  try {
    shelves = await apiFetch('/shelves');
    renderShelves();
  } catch { /* not authenticated or network error */ }
}

export function getShelves() { return shelves; }

export function setActive(shelfId) {
  _activeShelfId = shelfId;
  document.querySelectorAll('#nav-all-books, #nav-currently-reading, .sidebar-shelf-item, #nav-settings, #nav-opds')
    .forEach(el => el.classList.remove('sidebar-item-active'));

  if (shelfId === 'all') {
    document.getElementById('nav-all-books')?.classList.add('sidebar-item-active');
  } else if (shelfId === 'reading') {
    document.getElementById('nav-currently-reading')?.classList.add('sidebar-item-active');
  } else {
    document.querySelector(`.sidebar-shelf-item[data-id="${shelfId}"]`)
      ?.classList.add('sidebar-item-active');
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function navigate(shelfId) {
  showPanel('library');
  _onShelfSelect?.(shelfId);
  setActive(shelfId);
  closeSidebar();
}

function initSidebarLangPicker(container) {
  initIconLangPicker(container);
}

function buildSidebarHtml() {
  return `
    <div class="sidebar-header">
      <a href="/" class="logo"><img src="/images/codexa.svg" class="nav-icon nav-icon-codexa" alt="Codexa"> Codexa</a>
      <button id="sidebar-collapse-btn" class="sidebar-collapse-btn" title="${t('sidebar.collapse')}" aria-label="${t('sidebar.collapse')}">‹</button>
    </div>
    <nav class="sidebar-nav">
      <a href="/" class="sidebar-item" id="nav-currently-reading">
        <span class="sidebar-item-icon"><img src="/images/currently_reading.svg" class="nav-icon nav-icon-currently-reading" alt=""></span>
        <span class="sidebar-item-label">${t('sidebar.currently_reading')}</span>
        <span class="shelf-count" id="nav-reading-count"></span>
      </a>
      <a href="/" class="sidebar-item" id="nav-all-books">
        <span class="sidebar-item-icon"><img src="/images/all_library.svg" class="nav-icon nav-icon-all-library" alt=""></span>
        <span class="sidebar-item-label">${t('sidebar.all_library')}</span>
        <span class="shelf-count" id="nav-all-count"></span>
      </a>
      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span class="sidebar-section-title">${t('sidebar.shelves')}</span>
          <button id="add-shelf-btn" class="sidebar-add-btn" title="${t('sidebar.add_shelf')}">+</button>
        </div>
        <div id="shelves-list"></div>
      </div>
      <div class="sidebar-divider"></div>
      <a href="/?panel=opds" class="sidebar-item" id="nav-opds">
        <span class="sidebar-item-icon"><img src="/images/online_library.svg" class="nav-icon nav-icon-online-library" alt=""></span>
        <span class="sidebar-item-label">${t('sidebar.online_library')}</span>
      </a>
      <a href="/?panel=settings" class="sidebar-item" id="nav-settings">
        <span class="sidebar-item-icon"><img src="/images/settings.svg" class="nav-icon nav-icon-settings" alt=""></span>
        <span class="sidebar-item-label">${t('sidebar.settings')}</span>
      </a>
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-username-row">
        <div class="sidebar-username" id="sidebar-username"></div>
        <button class="sidebar-stats-btn" id="sidebar-stats-btn" title="${t('stats.open')}">
          <img src="/images/statistics.svg" class="nav-icon nav-icon-statistics" alt="">
        </button>
      </div>
      <div class="sidebar-theme">
        <span class="sidebar-section-title">${t('sidebar.appearance')}</span>
        <div class="sidebar-theme-group" role="radiogroup" aria-label="${t('sidebar.appearance')}">
          <button class="sidebar-theme-btn" data-theme="day"    aria-pressed="false" title="${t('sidebar.theme_day')}">${t('sidebar.theme_day')}</button>
          <button class="sidebar-theme-btn" data-theme="night"  aria-pressed="false" title="${t('sidebar.theme_night')}">${t('sidebar.theme_night')}</button>
          <button class="sidebar-theme-btn" data-theme="system" aria-pressed="false" title="${t('sidebar.theme_system')}">${t('sidebar.theme_system')}</button>
          <button class="sidebar-theme-btn" data-theme="eink"   aria-pressed="false" title="${t('sidebar.theme_eink')}">${t('sidebar.theme_eink')}</button>
        </div>
      </div>
      <div id="sidebar-lang-picker" class="sidebar-lang-picker"></div>
      <button class="sidebar-item sidebar-item-btn" id="sidebar-logout-btn">
        <span class="sidebar-item-icon"><img src="/images/logout.svg" class="nav-icon nav-icon-logout" alt=""></span>
        <span class="sidebar-item-label">${t('sidebar.logout')}</span>
      </button>
    </div>`;
}

function renderShelves() {
  const list = document.getElementById('shelves-list');
  if (!list) return;
  list.innerHTML = '';
  shelves.forEach(shelf => {
    const item = document.createElement('div');
    item.className = 'sidebar-shelf-item' + (_activeShelfId === shelf.id ? ' sidebar-item-active' : '');
    item.dataset.id = shelf.id;
    item.innerHTML = `
      <span class="sidebar-item-icon"><img src="/images/shelf.svg" class="nav-icon nav-icon-shelf" alt=""></span>
      <span class="sidebar-item-label">${escHtml(shelf.name)}</span>
      <span class="shelf-count">${shelf.book_count}</span>
      <button class="shelf-edit-btn" title="Uredi" data-id="${shelf.id}">✎</button>`;

    item.addEventListener('click', e => {
      if (e.target.closest('.shelf-edit-btn')) return;
      navigate(shelf.id);
    });
    item.querySelector('.shelf-edit-btn').addEventListener('click', e => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('sidebar:editshelf', { detail: shelf }));
    });
    list.appendChild(item);
  });
}

// Re-render sidebar when language changes
document.addEventListener('langchange', () => {
  const sidebar = document.getElementById('app-sidebar');
  if (!sidebar) return;
  // Preserve username that was already set
  const username = sidebar.querySelector('#sidebar-username')?.textContent || '';
  sidebar.innerHTML = buildSidebarHtml();
  initLibraryThemeControls(sidebar);
  initSidebarLangPicker(sidebar.querySelector('#sidebar-lang-picker'));
  const unameEl = sidebar.querySelector('#sidebar-username');
  if (unameEl) unameEl.textContent = username;
  // Restore active panel
  if (_activePage === 'settings') {
    sidebar.querySelector('#nav-settings')?.classList.add('sidebar-item-active');
  } else if (_activePage === 'opds') {
    sidebar.querySelector('#nav-opds')?.classList.add('sidebar-item-active');
  } else {
    setActive(_activeShelfId);
  }
  renderShelves();
  applyCurrentlyReadingVisibility();
  if (_activePage !== 'library') loadNavCounts();
  // Re-attach event listeners (sidebar HTML was replaced)
  sidebar.querySelector('#sidebar-collapse-btn')?.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 768px)').matches) { closeSidebar(); return; }
    const collapseBtn = sidebar.querySelector('#sidebar-collapse-btn');
    const collapsed = sidebar.classList.toggle('collapsed');
    collapseBtn.textContent = collapsed ? '›' : '‹';
    collapseBtn.title = collapsed ? t('sidebar.expand') : t('sidebar.collapse');
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  });
  sidebar.querySelector('#sidebar-logout-btn')?.addEventListener('click', () => {
    clearToken(); window.location.href = '/login.html';
  });
  sidebar.querySelector('#nav-currently-reading')?.addEventListener('click', e => {
    e.preventDefault(); navigate('reading');
  });
  sidebar.querySelector('#nav-all-books')?.addEventListener('click', e => {
    e.preventDefault(); navigate('all');
  });
  sidebar.querySelector('#add-shelf-btn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('sidebar:addshelf'));
  });
  sidebar.querySelector('#nav-settings')?.addEventListener('click', e => {
    e.preventDefault(); showPanel('settings'); closeSidebar();
  });
  sidebar.querySelector('#nav-opds')?.addEventListener('click', e => {
    e.preventDefault(); showPanel('opds'); closeSidebar();
  });
  sidebar.querySelector('#sidebar-stats-btn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('sidebar:stats'));
  });
});

export function openSidebar() {
  document.getElementById('app-sidebar')?.classList.add('open');
  document.getElementById('sidebar-overlay')?.classList.add('visible');
}

export function closeSidebar() {
  document.getElementById('app-sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
}

function getLibraryTheme() {
  const saved = localStorage.getItem(LIB_THEME_KEY) || 'system';
  return LIB_THEMES.has(saved) ? saved : 'system';
}

function setLibraryTheme(theme) {
  const mode = LIB_THEMES.has(theme) ? theme : 'system';
  localStorage.setItem(LIB_THEME_KEY, mode);
  applyLibraryTheme(mode);
}

function applyLibraryTheme(theme) {
  const html = document.documentElement;
  const body = document.body;
  if (!body || !body.classList.contains('sidebar-layout')) return;
  if (theme === 'system') {
    body.removeAttribute('data-lib-theme');
    html.removeAttribute('data-lib-theme');
  } else {
    body.setAttribute('data-lib-theme', theme);
    html.setAttribute('data-lib-theme', theme);
  }
}

function syncLibraryThemeButtons(sidebar, theme) {
  sidebar.querySelectorAll('.sidebar-theme-btn').forEach(btn => {
    const active = btn.dataset.theme === theme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function initLibraryThemeControls(sidebar) {
  const theme = getLibraryTheme();
  applyLibraryTheme(theme);
  syncLibraryThemeButtons(sidebar, theme);
  sidebar.querySelectorAll('.sidebar-theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.theme;
      setLibraryTheme(next);
      syncLibraryThemeButtons(sidebar, next);
    });
  });
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
