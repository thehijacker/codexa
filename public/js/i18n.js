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
const CACHE_VER = '17';
const CACHE_VER_KEY = 'br_strings_ver';

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
 * Create and append a language-selector <select> to container.
 * Changing the selection calls setLang() — no page reload.
 */
export function initLangPicker(container) {
  if (!container) return;
  container.innerHTML = '';

  const wrap   = document.createElement('div');
  wrap.className = 'lang-picker-wrap';

  const label  = document.createElement('span');
  label.className  = 'lang-picker-label';
  label.dataset.i18n = 'common.language';
  label.textContent  = t('common.language');

  const select = document.createElement('select');
  select.className = 'lang-picker';
  select.setAttribute('aria-label', 'Language');

  for (const [code, name] of Object.entries(SUPPORTED_LANGS)) {
    const opt = document.createElement('option');
    opt.value       = code;
    opt.textContent = name;
    if (code === _lang) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => setLang(select.value));
  // Keep select in sync if language is changed from another picker on the same page
  document.addEventListener('langchange', () => { select.value = _lang; });

  wrap.appendChild(label);
  wrap.appendChild(select);
  container.appendChild(wrap);
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _load(code) {
  const lang = Object.prototype.hasOwnProperty.call(SUPPORTED_LANGS, code) ? code : FALLBACK;
  const cacheKey = `br_strings_${lang}`;

  // Invalidate cache if locale files were updated (version bump)
  if (localStorage.getItem(CACHE_VER_KEY) !== CACHE_VER) {
    for (const lc of Object.keys(SUPPORTED_LANGS)) {
      localStorage.removeItem(`br_strings_${lc}`);
    }
    localStorage.setItem(CACHE_VER_KEY, CACHE_VER);
  }

  // Try localStorage cache first — avoids network round-trip on repeat visits
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      _strings = JSON.parse(cached);
      _lang    = lang;
      return; // Cache hit — synchronous, no fetch needed
    }
  } catch { /* corrupt cache — fall through to fetch */ }

  try {
    const r = await fetch(`/locales/${lang}.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _strings = await r.json();
    _lang    = lang;
    try { localStorage.setItem(cacheKey, JSON.stringify(_strings)); } catch { /* storage full */ }
  } catch (err) {
    console.warn(`i18n: could not load locale "${lang}"`, err);
    if (lang !== FALLBACK) {
      // Attempt fallback locale
      try {
        const fbKey = `br_strings_${FALLBACK}`;
        const fbCached = localStorage.getItem(fbKey);
        if (fbCached) {
          _strings = JSON.parse(fbCached);
        } else {
          const r2 = await fetch(`/locales/${FALLBACK}.json`);
          _strings = await r2.json();
          try { localStorage.setItem(fbKey, JSON.stringify(_strings)); } catch { /* storage full */ }
        }
        _lang = FALLBACK;
      } catch { /* keep existing strings */ }
    }
  }
}
