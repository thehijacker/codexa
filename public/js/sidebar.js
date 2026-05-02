/**
 * sidebar.js — shared sidebar module used by all pages (library, settings, opds).
 * Handles: rendering, shelf loading, collapse/expand, mobile toggle, logout, active state.
 * Exports: initSidebar, reloadShelves, getShelves, setActive
 */
import { apiFetch, requireAuth, clearToken } from './api.js';
import { t, initIconLangPicker } from './i18n.js';

const LIB_THEME_KEY = 'br_library_theme';
const LIB_THEMES = new Set(['system', 'day', 'night', 'eink']);

let shelves         = [];
let _activePage     = 'library';
let _onShelfSelect  = null;
let _activeShelfId  = 'all';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {'library'|'settings'|'opds'} opts.activePage
 * @param {Function|null} opts.onShelfSelect  called(shelfId) only on library page
 * @param {string|number}  opts.activeShelfId  'all' | 'reading' | shelf-id
 */
export async function initSidebar({ activePage = 'library', onShelfSelect = null, activeShelfId = 'all' } = {}) {
  if (!requireAuth()) return;

  _activePage    = activePage;
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

  // Page-specific active item
  if (activePage === 'settings') {
    sidebar.querySelector('#nav-settings')?.classList.add('sidebar-item-active');
  } else if (activePage === 'opds') {
    sidebar.querySelector('#nav-opds')?.classList.add('sidebar-item-active');
  } else {
    setActive(activeShelfId);
  }

  await reloadShelves();
  if (activePage !== 'library') await loadNavCounts();
}

async function loadNavCounts() {
  try {
    const books = await apiFetch('/books');
    const allEl     = document.getElementById('nav-all-count');
    const readingEl = document.getElementById('nav-reading-count');
    if (allEl)     allEl.textContent     = books.length;
    if (readingEl) readingEl.textContent = books.filter(b => (b.percentage || 0) > 0).length;
  } catch { /* non-critical */ }
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
  document.querySelectorAll('#nav-all-books, #nav-currently-reading, .sidebar-shelf-item')
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
  if (_activePage === 'library') {
    _onShelfSelect?.(shelfId);
    setActive(shelfId);
  } else {
    window.location.href = shelfId === 'all' || shelfId === 'reading'
      ? `/?shelf=${shelfId}`
      : `/?shelf=${shelfId}`;
  }
  closeSidebar();
}

function initSidebarLangPicker(container) {
  initIconLangPicker(container);
}

function buildSidebarHtml() {
  return `
    <div class="sidebar-header">
      <a href="/" class="logo">📚 Codexa</a>
      <button id="sidebar-collapse-btn" class="sidebar-collapse-btn" title="${t('sidebar.collapse')}" aria-label="${t('sidebar.collapse')}">‹</button>
    </div>
    <nav class="sidebar-nav">
      <a href="/" class="sidebar-item" id="nav-currently-reading">
        <span class="sidebar-item-icon">📖</span>
        <span class="sidebar-item-label">${t('sidebar.currently_reading')}</span>
        <span class="shelf-count" id="nav-reading-count"></span>
      </a>
      <a href="/" class="sidebar-item" id="nav-all-books">
        <span class="sidebar-item-icon">📚</span>
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
      <a href="/opds.html" class="sidebar-item" id="nav-opds">
        <span class="sidebar-item-icon">🌐</span>
        <span class="sidebar-item-label">${t('sidebar.online_library')}</span>
      </a>
      <a href="/settings.html" class="sidebar-item" id="nav-settings">
        <span class="sidebar-item-icon">⚙️</span>
        <span class="sidebar-item-label">${t('sidebar.settings')}</span>
      </a>
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-username" id="sidebar-username"></div>
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
        <span class="sidebar-item-icon">↪</span>
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
      <span class="sidebar-item-icon">📂</span>
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
  // Restore active page
  if (_activePage === 'settings') {
    sidebar.querySelector('#nav-settings')?.classList.add('sidebar-item-active');
  } else if (_activePage === 'opds') {
    sidebar.querySelector('#nav-opds')?.classList.add('sidebar-item-active');
  } else {
    setActive(_activeShelfId);
  }
  renderShelves();
  if (_activePage !== 'library') loadNavCounts();
  // Re-attach event listeners
  sidebar.querySelector('#sidebar-collapse-btn')?.addEventListener('click', () => {
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
