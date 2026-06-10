/**
 * i18n.js — lightweight internationalisation engine
 *
 * API:
 *   initI18n()              async — call once per page before any UI renders
 *   t(key, params?)         sync  — return translated string, {placeholder} replaced
 *   setLang(code)           async — switch language, re-renders DOM, dispatches 'langchange'
 *   getCurrentLang()        sync  — current language code
 *   applyTranslations()     sync  — walk DOM, apply all data-i18n* attributes
 *   initLangPicker(el)      sync  — append <select> language picker to element
 */

const LANG_KEY  = 'br_lang';
const FALLBACK  = 'sl';
// Bump this when locale files change to bust the localStorage cache
const CACHE_VER = '31';
const CACHE_VER_KEY = 'br_strings_ver';
// New keys added in a release — stale localStorage caches missing these are refetched
const LOCALE_SENTINEL_KEY = 'reader.sb_current_time';

/** Language codes → display names shown in the picker. Add entries here to add languages. */
export const SUPPORTED_LANGS = {
  sl: 'Slovenščina',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  pt: 'Português'
};

let _strings = {};
let _lang    = FALLBACK;
let _enStrings = null;

// ── Public API ────────────────────────────────────────────────────────────────

/** Return translated string for key, replacing {placeholder} tokens. */
export function t(key, params = {}) {
  let str = Object.prototype.hasOwnProperty.call(_strings, key) ? _strings[key] : key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return str;
}

export function getCurrentLang() { return _lang; }

/**
 * Detect saved / browser language, load its locale file, apply to DOM.
 * Must be awaited before using t() or rendering dynamic content.
 */
export async function initI18n() {
  const saved      = localStorage.getItem(LANG_KEY);
  const browserLang = (navigator.language || '').split('-')[0];
  const code = saved
    ? saved
    : Object.prototype.hasOwnProperty.call(SUPPORTED_LANGS, browserLang) ? browserLang : FALLBACK;
  await _load(code);
  document.documentElement.lang = _lang;
  localStorage.setItem(LANG_KEY, _lang);
  applyTranslations();
  // Reveal page — hidden by the inline script in <head> to prevent FOUC
  document.documentElement.style.visibility = '';
}

/**
 * Switch to a different language. Reloads locale, updates DOM, dispatches
 * the 'langchange' CustomEvent so modules can re-render dynamic content.
 */
export async function setLang(code) {
  await _load(code);
  document.documentElement.lang = _lang;
  localStorage.setItem(LANG_KEY, _lang);
  applyTranslations();
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: _lang } }));
}

/**
 * Walk the DOM and apply all data-i18n* attribute bindings.
 * Called automatically by initI18n / setLang; call manually after
 * injecting dynamic HTML that contains data-i18n attributes.
 */
export function applyTranslations() {
  // data-i18n → textContent
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = _strings[el.dataset.i18n];
    if (v !== undefined) el.textContent = v;
  });

  // data-i18n-html → innerHTML (for strings that include HTML tags)
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const v = _strings[el.dataset.i18nHtml];
    if (v !== undefined) el.innerHTML = v;
  });

  // data-i18n-placeholder → placeholder attribute
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const v = _strings[el.dataset.i18nPlaceholder];
    if (v !== undefined) el.placeholder = v;
  });

  // data-i18n-title → title attribute
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const v = _strings[el.dataset.i18nTitle];
    if (v !== undefined) el.title = v;
  });

  // data-i18n-aria-label → aria-label attribute
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const v = _strings[el.dataset.i18nAriaLabel];
    if (v !== undefined) el.setAttribute('aria-label', v);
  });

  // data-i18n-doc-title on <html> → document.title
  const titleKey = document.documentElement.dataset.i18nDocTitle;
  if (titleKey) {
    const v = _strings[titleKey];
    if (v) document.title = `${v} — Codexa`;
  }
}

/**
 * Build a custom styled language dropdown (same look as the sort menu).
 * @param {HTMLElement} container  — cleared and filled with the picker
 * @param {object} opts
 * @param {boolean} opts.opensUpward   — true = list opens above button (sidebar footer)
 * @param {boolean} opts.sidebarMode   — true = handle collapsed-sidebar fixed positioning
 */
function _buildLangMenu(container, { opensUpward = false, sidebarMode = false } = {}) {
  if (!container) return;

  const wrap = document.createElement('div');
  wrap.className = 'lang-menu-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lang-menu-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `<img src="/images/language.svg" class="nav-icon nav-icon-language" alt=""><span class="lang-menu-label"></span><span class="lang-menu-caret">▾</span>`;

  const list = document.createElement('div');
  list.className = 'lang-menu-list hidden' + (opensUpward ? ' lang-menu-up' : '');
  list.setAttribute('role', 'listbox');

  function syncLabel() {
    btn.querySelector('.lang-menu-label').textContent = SUPPORTED_LANGS[_lang] || _lang;
  }

  function renderList() {
    syncLabel();
    list.innerHTML = '';
    for (const [code, name] of Object.entries(SUPPORTED_LANGS)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'lang-menu-option' + (code === _lang ? ' active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', code === _lang ? 'true' : 'false');
      item.innerHTML = `<span>${name}</span><span class="lang-menu-check">✓</span>`;
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeList();
        await setLang(code);
      });
      list.appendChild(item);
    }
  }

  function openList() {
    renderList();
    if (sidebarMode && container.closest('.app-sidebar')?.classList.contains('collapsed')) {
      // Escape overflow-x: hidden with position:fixed.
      // The picker is always in the sidebar footer, so always open upward.
      const rect = btn.getBoundingClientRect();
      list.style.cssText = `position:fixed;left:${rect.right + 8}px;bottom:${window.innerHeight - rect.top + 4}px;top:auto;right:auto;`;
    } else {
      list.style.cssText = '';
    }
    list.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }

  function closeList() {
    list.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    list.classList.contains('hidden') ? openList() : closeList();
  });
  document.addEventListener('click', closeList);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeList(); });
  document.addEventListener('langchange', renderList);

  wrap.appendChild(btn);
  wrap.appendChild(list);
  container.innerHTML = '';
  container.appendChild(wrap);

  renderList();
}

/**
 * Sidebar language picker: custom dropdown, opens upward.
 * In collapsed-sidebar mode the list uses position:fixed to escape overflow clipping.
 */
export function initIconLangPicker(container) {
  _buildLangMenu(container, { opensUpward: true, sidebarMode: true });
}

/**
 * Login-page language picker: custom dropdown, opens downward.
 */
export function initLangPicker(container) {
  _buildLangMenu(container, { opensUpward: false, sidebarMode: false });
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _localeUrl(lang) {
  return `/locales/${lang}.json?v=${CACHE_VER}`;
}

function _isLocaleComplete(strings) {
  return strings && Object.prototype.hasOwnProperty.call(strings, LOCALE_SENTINEL_KEY);
}

function _mergeWithEnglish(lang, langStrings) {
  if (lang === 'en') return langStrings;
  return { ..._enStrings, ...langStrings };
}

async function _fetchLocaleFile(lang) {
  const r = await fetch(_localeUrl(lang));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function _getEnglishStrings() {
  if (_enStrings) return _enStrings;

  const cacheKey = 'br_strings_en';
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (_isLocaleComplete(parsed)) {
        _enStrings = parsed;
        return _enStrings;
      }
    }
  } catch { /* corrupt cache */ }

  try {
    _enStrings = await _fetchLocaleFile('en');
    try { localStorage.setItem(cacheKey, JSON.stringify(_enStrings)); } catch { /* storage full */ }
    return _enStrings;
  } catch (err) {
    console.warn('i18n: could not load English locale', err);
    try {
      const swCached = await caches.match('/locales/en.json');
      if (swCached?.ok) {
        _enStrings = await swCached.json();
        return _enStrings;
      }
    } catch { /* ignore */ }
    _enStrings = {};
    return _enStrings;
  }
}

async function _load(code) {
  const lang = Object.prototype.hasOwnProperty.call(SUPPORTED_LANGS, code) ? code : FALLBACK;
  const cacheKey = `br_strings_${lang}`;

  // Invalidate cache if locale files were updated (version bump)
  if (localStorage.getItem(CACHE_VER_KEY) !== CACHE_VER) {
    for (const lc of Object.keys(SUPPORTED_LANGS)) {
      localStorage.removeItem(`br_strings_${lc}`);
    }
    localStorage.setItem(CACHE_VER_KEY, CACHE_VER);
    _enStrings = null;
  }

  await _getEnglishStrings();

  // Try localStorage cache first — but only if it includes recent keys
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (_isLocaleComplete(parsed)) {
        _strings = _mergeWithEnglish(lang, parsed);
        _lang    = lang;
        return;
      }
    }
  } catch { /* corrupt cache — fall through to fetch */ }

  try {
    const langStrings = await _fetchLocaleFile(lang);
    _strings = _mergeWithEnglish(lang, langStrings);
    _lang    = lang;
    try { localStorage.setItem(cacheKey, JSON.stringify(langStrings)); } catch { /* storage full */ }
  } catch (err) {
    console.warn(`i18n: could not load locale "${lang}"`, err);
    // SW cache fallback — handles when SW hasn't claimed this tab yet
    try {
      const swCached = await caches.match(_localeUrl(lang))
        || await caches.match(`/locales/${lang}.json`);
      if (swCached?.ok) {
        const langStrings = await swCached.json();
        _strings = _mergeWithEnglish(lang, langStrings);
        _lang = lang;
        try { localStorage.setItem(cacheKey, JSON.stringify(langStrings)); } catch {}
        return;
      }
    } catch {}
    // Last resort: English strings (avoids showing raw i18n keys)
    _strings = { ..._enStrings };
    _lang = lang;
  }
}
