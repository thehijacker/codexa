import { apiFetch, requireAuth, getToken } from './api.js';
import { toast } from './ui.js';
import { t, initI18n, applyTranslations, getCurrentLang } from './i18n.js';

await initI18n();

if (!requireAuth()) throw new Error('not authenticated');
const params = new URLSearchParams(window.location.search);
const bookId = params.get('id');
if (!bookId) { window.location.href = '/'; throw new Error(); }

// Prevent the Android hardware Back key from closing the reader.
// Push a history entry on load; re-push whenever popstate fires so the back
// stack never empties. The explicit "back to library" header button navigates
// directly via window.location.href and is unaffected.
history.pushState(null, '', window.location.href);
window.addEventListener('popstate', () => {
  history.pushState(null, '', window.location.href);
});

// ── Themes ────────────────────────────────────────────────────────────────────
// Pixels reserved at the bottom of the epub viewport so content never flows
// behind the status-bar/separator overlay. Must be subtracted from height in
// every rendition.resize() call, not only at initial renderTo().
const BOTTOM_RESERVE = 28;

const THEMES = {
  dark:  { bg: '#1a1a2e', text: '#d8d8e8', link: '#e94560' },
  light: { bg: '#f9f9f6', text: '#1a1a1a', link: '#c73652' },
  sepia: { bg: '#f4ecd8', text: '#3e2e1a', link: '#8b4513' },
};

/** Full shell-UI palette derived from each reader theme — applied to all panels/sidebars. */
const THEME_UI = {
  light: {
    bg:         '#f9f9f6',
    surface:    '#f2f2ef',
    surface2:   '#eaeae6',
    border:     'rgba(26,26,26,0.12)',
    text:       '#1a1a1a',
    textMuted:  '#6b6b6b',
    accent:     '#c73652',
    accentDark: '#a82843',
    shadow:     '0 4px 24px rgba(20,20,20,.12)',
  },
  sepia: {
    bg:         '#f4ecd8',
    surface:    '#eddfca',
    surface2:   '#e5d3b8',
    border:     'rgba(62,46,26,0.15)',
    text:       '#3e2e1a',
    textMuted:  '#7a5e40',
    accent:     '#8b4513',
    accentDark: '#6e360e',
    shadow:     '0 4px 24px rgba(60,40,20,.12)',
  },
  dark: {
    bg:         '#1a1a2e',
    surface:    '#22223a',
    surface2:   '#2a2a46',
    border:     'rgba(216,216,232,0.12)',
    text:       '#d8d8e8',
    textMuted:  '#9a9ab0',
    accent:     '#e94560',
    accentDark: '#c73652',
    shadow:     '0 4px 24px rgba(0,0,0,.4)',
  },
};

// ── System fonts (alphabetical) ───────────────────────────────────────────────
const SYSTEM_FONTS = [
  { label: 'Arial',           value: 'Arial, Helvetica, sans-serif' },
  { label: 'Courier New',     value: '"Courier New", Courier, monospace' },
  { label: 'Garamond',        value: 'Garamond, "EB Garamond", serif' },
  { label: 'Georgia',         value: 'Georgia, serif' },
  { label: 'Palatino',        value: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Trebuchet MS',    value: '"Trebuchet MS", Helvetica, sans-serif' },
  { label: 'Verdana',         value: 'Verdana, Geneva, sans-serif' },
];

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_STATUS_BAR = {
  font:             '',       // '' = inherit UI font
  fontSize:         11,
  fontStyle:        'normal', // 'normal' | 'bold' | 'italic' | 'bold italic'
  defaultPpm:       1.5,      // pages/min before speed samples exist
  positions: {
    tl: ['currentTime', 'pctBook'],
    tc: ['chapterTitle'],
    tr: [],
    bl: ['chapterPage'],
    bc: [],
    br: [],
  },
  separatorTop:          false,
  separatorBottom:       false,
  separatorThickness:    1,
  showIcons:        {},           // { [statId]: false } to hide icon; default = show all
  bookProgressBar:  { show: false, position: 'bottom', thickness: 3 },
  chapProgressBar:  { show: false, position: 'bottom', thickness: 2 },
};

// Stat definitions — id, icon, translated label (use function to get current lang)
function getStatusStats() {
  return [
    { id: 'chapterPage',   icon: '\uD83D\uDCC4', label: t('reader.sb_chapter_page') },
    { id: 'bookPage',      icon: '\uD83D\uDCDA', label: t('reader.sb_book_page') },
    { id: 'pagesLeftChap', icon: '\u23E9',        label: t('reader.sb_pages_left_chap') },
    { id: 'pagesLeftBook', icon: '\u23ED',        label: t('reader.sb_pages_left_book') },
    { id: 'pctChapter',    icon: '\u25D4',        label: t('reader.sb_pct_chap') },
    { id: 'pctBook',       icon: '\u25D5',        label: t('reader.sb_pct_book') },
    { id: 'timeLeftChap',  icon: '\u23F1',        label: t('reader.sb_time_left_chap') },
    { id: 'timeLeftBook',  icon: '\u23F2',        label: t('reader.sb_time_left_book') },
    { id: 'currentTime',   icon: '\uD83D\uDD52', label: t('reader.sb_current_time') },
    { id: 'bookTitle',     icon: '\uD83C\uDFF7',  label: t('reader.sb_book_title') },
    { id: 'bookAuthor',    icon: '\u270D',        label: t('reader.sb_book_author') },
    { id: 'chapterTitle',  icon: '\uD83D\uDCF0', label: t('reader.sb_chap_title') },
  ];
}

const DEFAULT_PREFS = {
  fontSize:       18,
  fontFamily:     'Georgia, serif',
  lineHeight:     1.6,
  margin:         40,
  spread:         'auto',       // two-page default
  overrideStyles: false,
  theme:          'sepia',
  autoHideHeader: true,
  keepScreenOn:   true,
  eink:           false,        // strip all colors for e-ink displays
  paraIndent:     true,         // paragraph text-indent (first line)
  paraSpacing:    0,            // extra bottom margin between paragraphs (em × 10, so 0–30)
  mouseWheelNav:  false,        // navigate pages with mouse wheel
  skipOpenProgressCheck: false, // if true, do not restore/sync progress on open
  skipSaveOnClose: false,       // if true, do not auto-save when leaving/closing
  hyphenation:    true,         // CSS hyphens: auto inside epub iframe
  hyphenLang:     '',           // empty = keep book's own lang attr; else override e.g. 'en'
  pageGapShadow:  true,         // show epub.js center-spine box-shadow in two-page mode
  dictionaries:   [],           // ordered list of dict basenames; empty = use all
  edgePadding:    { top: 0, bottom: 0, left: 0, right: 0 },   // px inset for curved screens
  statusBar:      null,         // deep-merged in loadPrefs()
};

// ── State ─────────────────────────────────────────────────────────────────────
let book, rendition;
let currentBook  = null;
let prefs        = loadPrefs();
let currentCfi   = '';
let currentPct   = 0;
let currentSpineIndex = 0;  // 0-based spine item index, used to generate KOReader xpointer
let lastKnownXPointer = null; // precise xpointer last received from KOReader/server (e.g. /body/DocFragment[5]/body/div/p[21]/text().0)
let lastChapterHref = null;  // chapter-boundary save tracking
let availableDicts  = null;  // cached GET /api/dictionary response
let isReady = false;          // true only after initial position is fully displayed
let openCfi = '';             // CFI at the moment the book was first ready — used to skip no-op kosync pushes
let tocFlatItems = [];
let customFonts  = [];
let fontFaceCSS  = '';
// Search state
let searchAbort = { aborted: false };
let preSearchCfi = null;      // position before first result jump
// Two-phase search navigation state:
//   phase 'first'  – navigated to chapter href, waiting for relocated to re-nav to exact CFI
//   phase 'second' – navigated to exact CFI, waiting for relocated to mark highlights
let searchNav = null; // null | { cfi, navCfi, query, href, phase }

// ── Status bar state ──────────────────────────────────────────────────────────
let currentHref      = '';    // current spine href (updated in updateProgress)
let currentChapPage  = 0;     // current page within chapter (left page in two-page mode)
let currentEndPage   = 0;     // right-page number in two-page mode (0 in single-page)
let currentChapTotal = 0;     // total pages in current chapter (stabilised max for display)
let currentChapRawTotal = 0;  // raw totalPages from epub.js (used for skip detection in goNext)
let currentIsTwoPage = false; // true when two pages are visible simultaneously
let chapPageCache    = {};    // { [spineIndex]: totalPages } accumulated as chapters are visited
let lastLocation     = null;  // last location object from updateProgress
// Reading speed tracking: each entry is a { time } recorded on every page turn
let speedSamples     = [];    // up to 25 recent samples

// ── DOM refs ──────────────────────────────────────────────────────────────────
const readerLayout   = document.querySelector('.reader-layout');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingMsg     = document.getElementById('loading-msg');
const epubViewer     = document.getElementById('epub-viewer');
const bookTitleEl    = document.getElementById('book-title');
const chapterTitleEl = document.getElementById('chapter-title');
const progressFillEl      = document.getElementById('progress-fill');
// Status bar overlay elements
const sbTop           = document.getElementById('sb-top');
const sbBottom        = document.getElementById('sb-bottom');
const sbTl            = document.getElementById('sb-tl');
const sbTc            = document.getElementById('sb-tc');
const sbTr            = document.getElementById('sb-tr');
const sbBl            = document.getElementById('sb-bl');
const sbBc            = document.getElementById('sb-bc');
const sbBr            = document.getElementById('sb-br');
const sbSeparatorTop    = document.getElementById('sb-sep-top');
const sbSeparatorBottom = document.getElementById('sb-sep-bottom');
const sbChapProg      = document.getElementById('sb-chap-prog');
const sbChapProgFill  = document.getElementById('sb-chap-prog-fill');
const sbBookProg      = document.getElementById('sb-book-prog');
const sbBookProgFill  = document.getElementById('sb-book-prog-fill');
const tocSidebar      = document.getElementById('toc-sidebar');
const tocListEl      = document.getElementById('toc-list');
const settingsPanel  = document.getElementById('settings-panel');
const panelBackdrop  = document.getElementById('panel-backdrop');
const searchSidebar   = document.getElementById('search-sidebar');
const searchInput     = document.getElementById('search-input');
const searchSubmitBtn = document.getElementById('search-submit');
const searchStatusEl  = document.getElementById('search-status');
const searchResultsEl = document.getElementById('search-results');
const searchBackBtn   = document.getElementById('btn-search-back');
const fullscreenBtn   = document.getElementById('btn-fullscreen');

// ── Prefs ─────────────────────────────────────────────────────────────────────
// Keys that are stored per-book (content appearance).  All others are global.
const PER_BOOK_KEYS = ['fontSize','fontFamily','lineHeight','margin','theme','overrideStyles','paraIndent','paraSpacing','dictionaries'];

function loadPrefs() {
  try {
    const s = localStorage.getItem('br_reader_prefs');
    const saved = s ? JSON.parse(s) : {};
    const sb = saved.statusBar || {};
    return {
      ...DEFAULT_PREFS,
      ...saved,
      edgePadding: { ...DEFAULT_PREFS.edgePadding, ...(saved.edgePadding || {}) },
      statusBar: {
        ...DEFAULT_STATUS_BAR,
        ...sb,
        positions:       { ...DEFAULT_STATUS_BAR.positions,       ...sb.positions },
        showIcons:       { ...DEFAULT_STATUS_BAR.showIcons,       ...sb.showIcons },
        bookProgressBar: { ...DEFAULT_STATUS_BAR.bookProgressBar, ...sb.bookProgressBar },
        chapProgressBar: { ...DEFAULT_STATUS_BAR.chapProgressBar, ...sb.chapProgressBar },
      },
    };
  } catch { return { ...DEFAULT_PREFS, statusBar: { ...DEFAULT_STATUS_BAR } }; }
}

// Load per-book overrides and apply them onto prefs.
function loadBookPrefs(bookId) {
  if (!bookId) return;
  try {
    const all = JSON.parse(localStorage.getItem('br_book_prefs') || '{}');
    const saved = all[bookId] || {};
    PER_BOOK_KEYS.forEach(k => { if (k in saved) prefs[k] = saved[k]; });
  } catch { /* ignore */ }
  updateBookPrefsIndicator();
}

// Save current per-book overrides (only if they differ from global prefs).
function saveBookPrefs(bookId) {
  if (!bookId) return;
  try {
    const global = loadPrefs();
    const overrides = {};
    PER_BOOK_KEYS.forEach(k => { if (prefs[k] !== global[k]) overrides[k] = prefs[k]; });
    const all = JSON.parse(localStorage.getItem('br_book_prefs') || '{}');
    if (Object.keys(overrides).length) all[bookId] = overrides;
    else delete all[bookId];
    localStorage.setItem('br_book_prefs', JSON.stringify(all));
  } catch { /* ignore */ }
  updateBookPrefsIndicator();
}

function clearBookPrefs(bookId) {
  if (!bookId) return;
  try {
    const all = JSON.parse(localStorage.getItem('br_book_prefs') || '{}');
    delete all[bookId];
    localStorage.setItem('br_book_prefs', JSON.stringify(all));
  } catch { /* ignore */ }
}

function hasBookPrefs(bookId) {
  if (!bookId) return false;
  try {
    const all = JSON.parse(localStorage.getItem('br_book_prefs') || '{}');
    return !!all[bookId] && Object.keys(all[bookId]).length > 0;
  } catch { return false; }
}

function updateBookPrefsIndicator() {
  const btn = document.getElementById('btn-reset-book-prefs');
  if (btn) btn.classList.toggle('hidden', !hasBookPrefs(currentBook?.id));
}

function persistPrefs() {
  // Save global prefs as-is (includes current values which may be book-specific overrides).
  // The per-book layer is stored separately in br_book_prefs; on load, loadBookPrefs() re-applies
  // the overrides so global prefs naturally reflect the last used values for each book context.
  localStorage.setItem('br_reader_prefs', JSON.stringify(prefs));
  // Also track per-book overrides when a book is open
  if (currentBook?.id) saveBookPrefs(currentBook.id);
  apiFetch('/settings', {
    method: 'PUT',
    body: JSON.stringify({ reader_prefs: prefs }),
  }).catch(() => {});
}

// ── Custom font loading ───────────────────────────────────────────────────────
function fontFamilyFromFilename(f) {
  return f
    .replace(/\.(ttf|otf|woff2?)$/i, '')
    .replace(/[-_](Regular|Bold|Italic|BoldItalic|Light|Medium|SemiBold|Black|Thin|ExtraLight|ExtraBold|Heavy|Oblique)$/i, '')
    .replace(/[-_]/g, ' ')
    .trim();
}
function fontFormatFromExt(f) {
  const e = f.split('.').pop().toLowerCase();
  return { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[e] || 'truetype';
}
function fontWeightFromFilename(f) {
  const l = f.toLowerCase();
  if (l.includes('thin'))       return '100';
  if (l.includes('extralight')) return '200';
  if (l.includes('light'))      return '300';
  if (l.includes('semibold'))   return '600';
  if (l.includes('extrabold'))  return '800';
  if (l.includes('black') || l.includes('heavy')) return '900';
  if (l.includes('bold'))       return 'bold';
  return 'normal';
}
function fontStyleFromFilename(f) {
  const l = f.toLowerCase();
  return (l.includes('italic') || l.includes('oblique')) ? 'italic' : 'normal';
}

async function loadCustomFonts() {
  try {
    const files = await apiFetch('/fonts');
    if (!files.length) return;
    const families = {};
    files.forEach(f => {
      const fam = fontFamilyFromFilename(f);
      if (!families[fam]) families[fam] = [];
      families[fam].push(f);
    });
    const cssLines = [];
    Object.entries(families).forEach(([family, ffiles]) => {
      ffiles.forEach(f => {
        cssLines.push(`@font-face {
  font-family: "${family}";
  src: url("/user-fonts/${encodeURIComponent(f)}") format("${fontFormatFromExt(f)}");
  font-weight: ${fontWeightFromFilename(f)};
  font-style: ${fontStyleFromFilename(f)};
}`);
      });
      customFonts.push({ label: family, value: `"${family}", Georgia, serif` });
    });
    fontFaceCSS = cssLines.join('\n');
    customFonts.sort((a, b) => a.label.localeCompare(b.label));
    const hostStyle = document.createElement('style');
    hostStyle.textContent = fontFaceCSS;
    document.head.appendChild(hostStyle);
  } catch (err) {
    console.warn('[reader] Custom fonts not loaded:', err.message);
  }
}

// ── CSS injection ─────────────────────────────────────────────────────────────
// Key insight: we inject at the END of <body> so our styles (with !important)
// appear AFTER epub.js's own layout styles injected in <head>.
// Later same-specificity !important rules win in CSS cascade.
// Returns a CSS string that strips all colour — pure black on white (or white on
// black in dark theme) for e-ink displays.
function buildEinkCss(theme) {
  const bg   = theme.bg   === '#000000' || theme.bg   === '#000' || theme.bg   === 'black' ? '#000' : '#fff';
  const text = bg === '#fff' ? '#000' : '#fff';
  return `
/* ── e-ink mode: strip all colours ───────────────────────── */
html, body, body * {
  background:       ${bg}   !important;
  background-image: none    !important;
  color:            ${text} !important;
  border-color:     ${text} !important;
  box-shadow:       none    !important;
  text-shadow:      none    !important;
}
a, a * { color: ${text} !important; text-decoration: underline !important; }
img     { filter: grayscale(100%) !important; }
`;
}

function buildEpubCss() {
  const theme = THEMES[prefs.theme] || THEMES.dark;
  const fontOverrides = prefs.overrideStyles ? `
body {
  font-size:     ${prefs.fontSize}px !important;
  font-family:   ${prefs.fontFamily} !important;
  line-height:   ${prefs.lineHeight} !important;
}
p, li, td, th, dt, dd, blockquote, span {
  font-size:   ${prefs.fontSize}px !important;
  font-family: ${prefs.fontFamily} !important;
  line-height: ${prefs.lineHeight} !important;
}
h1, h2, h3, h4, h5, h6 {
  font-family: ${prefs.fontFamily} !important;
}` : '';

  return `
${fontFaceCSS}
html {
  background: ${theme.bg} !important;
}
body {
  background:     ${theme.bg} !important;
  color:          ${theme.text} !important;
  padding-left:   ${prefs.margin}px !important;
  padding-right:  ${prefs.margin}px !important;
  padding-top:    max(1.5rem, 28px) !important;
  padding-bottom: 0px !important;
  margin:         0 !important;
  max-width:      100% !important;
  word-wrap:      break-word !important;
  box-sizing:     border-box !important;
  touch-action:   pan-y !important;
}
/* Always enforce theme color on all text — overrides any per-element book CSS */
body * { color: ${theme.text} !important; }
a, a * { color: ${theme.link} !important; }
${fontOverrides}
img {
  max-width:   100% !important;
  max-height:  95vh !important;
  width:       auto !important;
  height:      auto !important;
  object-fit:  contain !important;
  display:     block !important;
  margin-left: auto !important;
  margin-right: auto !important;
  ${prefs.theme !== 'dark' ? 'mix-blend-mode: multiply !important;' : ''}
}
/* Keep native selection/callout enabled so iOS long-press and selection behave naturally. */
${prefs.eink ? buildEinkCss(theme) : ''}
${prefs.paraIndent ? '' : 'p { text-indent: 0 !important; }'}
${prefs.paraSpacing > 0 ? `p { margin-bottom: ${(prefs.paraSpacing / 10).toFixed(1)}em !important; }` : ''}
${prefs.hyphenation ? 'html, body, p, li { hyphens: auto !important; }' : 'html, body, p, li { hyphens: none !important; }'}
/* search highlights — background only, zero layout impact */
mark.br-hl {
  background: rgba(255,200,0,.5) !important;
  color: inherit !important;
  padding: 0 !important; margin: 0 !important;
  border: none !important; border-radius: 0 !important;
  font: inherit !important; line-height: inherit !important;
  display: inline !important;
}
`.trim();
}

// Build a self-contained touch-handler script that runs INSIDE the epub iframe.
// This is required on iOS (WKWebView): event listeners attached to an iframe's
// contentWindow/contentDocument from the parent are never invoked on iOS Chrome/Safari.
// The script is injected as a <script> element so it runs in the iframe's own context.
function buildIframeTouchScript() {
  return `(function() {
  var isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) return;  // Android/Desktop use cross-frame listeners (attachIframeTouchNav)
  if (document.__brBound) return;
  document.__brBound = true;
  var SWIPE_MIN = 24, SWIPE_MAX_VERT = 130, TAP_ZONE = 0.25, LP_MS = 450;
  var startX = 0, startY = 0;
  var pressTimer = null, selTimer = null;
  var longPressOK = false, lastSelWord = '', lastSelTs = 0;
  var coarse = window.matchMedia('(pointer: coarse)').matches;

  function post(msg) { try { window.parent.postMessage(msg, '*'); } catch(e) {} }

  // Word extraction via caret APIs (same logic as host-page getWordAtPoint)
  function wordAt(x, y) {
    var node, off;
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; off = r.startOffset; }
    } else if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; off = p.offset; }
    }
    if (!node) return '';
    if (node.nodeType === 1) {
      var w = document.createTreeWalker(node, 4);
      var tn = w.nextNode(); if (tn) { node = tn; off = 0; }
    }
    if (!node || node.nodeType !== 3) return '';
    var text = node.textContent, s = off, e = off;
    try {
      while (s > 0 && /[\\p{L}\\p{N}'\\u2019\\-]/u.test(text[s-1])) s--;
      while (e < text.length && /[\\p{L}\\p{N}'\\u2019\\-]/u.test(text[e])) e++;
    } catch(_) {
      while (s > 0 && /[\\w\\u00C0-\\u024F'\\u2019\\-]/.test(text[s-1])) s--;
      while (e < text.length && /[\\w\\u00C0-\\u024F'\\u2019\\-]/.test(text[e])) e++;
    }
    return text.slice(s, e).replace(/^['\\u2019\\-]+|['\\u2019\\-]+$/g, '').trim();
  }

  // iOS: suppress native callout / selection takeover so our long-press fires reliably
  if (isIOS) {
    var st = document.createElement('style');
    st.textContent = '* { -webkit-touch-callout: none !important; -webkit-user-select: none !important; user-select: none !important; }';
    (document.head || document.documentElement).appendChild(st);
  }

  document.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) { clearTimeout(pressTimer); return; }
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    longPressOK = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function() {
      longPressOK = true;
      var w = wordAt(startX, startY);
      if (w) post({ type: 'dict-lookup', word: w });
    }, LP_MS);
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    var dx = Math.abs(e.touches[0].clientX - startX);
    var dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 10 || dy > 10) clearTimeout(pressTimer);
    // Claim horizontal swipes on iOS before the browser decides it's a scroll
    if (dx > 8 && dx > dy) { try { if (e.cancelable) e.preventDefault(); } catch(_) {} }
  }, { passive: false });

  document.addEventListener('touchend', function(e) {
    clearTimeout(pressTimer);
    if (longPressOK) { longPressOK = false; return; }
    // Android: clear quick-select popup on any plain tap
    if (coarse && !isIOS) setTimeout(function() {
      var s = window.getSelection(); if (s) s.removeAllRanges();
    }, 0);
    var cx = e.changedTouches[0].clientX, cy = e.changedTouches[0].clientY;
    var dx = cx - startX, dy = cy - startY;
    var ax = Math.abs(dx), ay = Math.abs(dy), W = window.innerWidth;
    if (ay < SWIPE_MAX_VERT && ax > SWIPE_MIN && ax > ay) {
      post({ type: 'br-nav', action: dx < 0 ? 'next' : 'prev' });
    } else if (ax < 10 && ay < 10) {
      if      (cx < W * TAP_ZONE)        post({ type: 'br-nav', action: 'prev' });
      else if (cx > W * (1 - TAP_ZONE))  post({ type: 'br-nav', action: 'next' });
      else                                post({ type: 'br-tap',  cy: cy });
    } else if (dy > 42 && ax < 70) {
      post({ type: 'br-swipe-down' });
    }
  }, { passive: false });

  document.addEventListener('touchcancel', function() {
    clearTimeout(pressTimer);
  }, { passive: true });

  // Android: update dictionary word when the user adjusts selection after long-press
  if (coarse && !isIOS) {
    document.addEventListener('selectionchange', function() {
      if (!longPressOK) return;
      clearTimeout(selTimer);
      selTimer = setTimeout(function() {
        var sel = window.getSelection();
        var raw = (sel ? sel.toString() : '').trim();
        if (!raw) return;
        var w = raw.split(/\\s+/)[0].replace(/^['\\u2019\\-]+|['\\u2019\\-]+$/g, '').trim();
        if (!w) return;
        var now = Date.now();
        if (w === lastSelWord && now - lastSelTs < 900) return;
        lastSelWord = w; lastSelTs = now;
        post({ type: 'dict-lookup', word: w });
      }, 120);
    });
  }
})();`;
}

function injectIntoContents(contents) {
  if (!contents?.document) return;
  const doc = contents.document;
  // Apply hyphenation lang override on the iframe's <html> element
  if (prefs.hyphenation && prefs.hyphenLang) {
    doc.documentElement.lang = prefs.hyphenLang;
  } else if (prefs.hyphenLang === '' && doc.documentElement.dataset.brLangOverridden) {
    // lang was previously forced by us — restore original if stored
    const orig = doc.documentElement.dataset.brOrigLang;
    if (orig !== undefined) doc.documentElement.lang = orig;
    delete doc.documentElement.dataset.brLangOverridden;
  }
  if (prefs.hyphenation && prefs.hyphenLang) {
    if (!doc.documentElement.dataset.brLangOverridden) {
      doc.documentElement.dataset.brOrigLang = doc.documentElement.lang || '';
      doc.documentElement.dataset.brLangOverridden = '1';
    }
    doc.documentElement.lang = prefs.hyphenLang;
  }
  let el = doc.getElementById('br-custom-styles');
  if (!el) {
    el = doc.createElement('style');
    el.id = 'br-custom-styles';
    // Append to body END — comes after epub.js head styles, so our !important wins
    (doc.body || doc.documentElement).appendChild(el);
  }
  el.textContent = buildEpubCss();

  // Inject the touch relay script once per iframe — runs in the iframe's own JS context
  // so touch events fire reliably on iOS (WKWebView ignores cross-frame addEventListener).
  if (!doc.getElementById('br-touch-relay')) {
    const script = doc.createElement('script');
    script.id = 'br-touch-relay';
    script.textContent = buildIframeTouchScript();
    (doc.head || doc.documentElement).appendChild(script);
  }
}

function reapplyStyles() {
  if (!rendition) return;
  try {
    const contents = rendition.getContents();
    if (contents?.length) { contents.forEach(c => injectIntoContents(c)); return; }
  } catch { /* fall through */ }
  try {
    rendition.manager?.views?.forEach?.(view => {
      if (view?.contents) injectIntoContents(view.contents);
    });
  } catch { /* ignore */ }
}

// ── Wake Lock (keep screen always on) ───────────────────────────────────────
let wakeLock = null;
async function acquireWakeLock() {
  if (!prefs.keepScreenOn || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* denied or unsupported */ }
}
async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch { /* ignore */ }
  wakeLock = null;
}
// Re-acquire after tab becomes visible again (wake lock is auto-released on hide)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});

// ── Host page background ──────────────────────────────────────────────────────

/** Convert a 6-digit hex colour + alpha (0–1) to an rgba() string. */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function applyUiTheme() {
  const theme = THEMES[prefs.theme] || THEMES.dark;
  const ui    = THEME_UI[prefs.theme] || THEME_UI.dark;

  if (prefs.eink) {
    // E-ink: force pure black-on-white (or white-on-black) for the whole shell
    const bg   = theme.bg === '#000000' || theme.bg === '#000' || theme.bg === 'black' ? '#000' : '#fff';
    const text = bg === '#fff' ? '#000' : '#fff';
    document.documentElement.style.setProperty('--reader-page-bg',    bg);
    document.documentElement.style.setProperty('--color-bg',          bg);
    document.documentElement.style.setProperty('--color-surface',     bg);
    document.documentElement.style.setProperty('--color-surface2',    bg === '#fff' ? '#f3f3f3' : '#111111');
    document.documentElement.style.setProperty('--color-text',        text);
    document.documentElement.style.setProperty('--color-text-muted',  text);
    document.documentElement.style.setProperty('--color-border',      text);
    document.documentElement.style.setProperty('--color-accent',      text);
    epubViewer.style.background = bg;
  } else {
    // Apply full reader-theme palette to all shell UI (panels, sidebars, inputs …)
    document.documentElement.style.setProperty('--reader-page-bg',    theme.bg);
    document.documentElement.style.setProperty('--color-bg',          ui.bg);
    document.documentElement.style.setProperty('--color-surface',     ui.surface);
    document.documentElement.style.setProperty('--color-surface2',    ui.surface2);
    document.documentElement.style.setProperty('--color-border',      ui.border);
    document.documentElement.style.setProperty('--color-text',        ui.text);
    document.documentElement.style.setProperty('--color-text-muted',  ui.textMuted);
    document.documentElement.style.setProperty('--color-accent',      ui.accent);
    document.documentElement.style.setProperty('--color-accent-dark', ui.accentDark);
    document.documentElement.style.setProperty('--shadow',            ui.shadow);
    epubViewer.style.background = theme.bg;
  }

  // Header: translucent glass tinted to the page colour
  const headerBg    = hexToRgba(theme.bg,   0.6);
  const headerBdr   = hexToRgba(theme.text, 0.12);
  const headerMuted = hexToRgba(theme.text, 0.55);
  document.documentElement.style.setProperty('--reader-header-bg',           headerBg);
  document.documentElement.style.setProperty('--reader-header-border',       headerBdr);
  document.documentElement.style.setProperty('--reader-header-text',         theme.text);
  document.documentElement.style.setProperty('--reader-header-text-muted',   headerMuted);
}

function applyPageShadow() {
  document.getElementById('page-edge-shadow')?.classList.toggle('active', !!prefs.pageGapShadow);
}

// ── FIX: Forward iframe keydown events to host ────────────────────────────────
function attachIframeKeyboard(contents) {
  if (!contents?.window) return;
  contents.window.addEventListener('keydown', (e) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }));
  });
  // Forward wheel events from iframe so mouseWheelNav works when cursor is over text
  contents.window.addEventListener('wheel', (e) => {
    if (!prefs.mouseWheelNav) return;
    document.dispatchEvent(new CustomEvent('br-wheel', { detail: { deltaY: e.deltaY } }));
  }, { passive: true });
}

// Desktop-only dictionary wiring: right-click and double-click inside the epub iframe.
// Touch handling (long-press, swipe, edge-tap) is done by the iframe-injected script
// (buildIframeTouchScript) which runs in the iframe's own JS context and therefore
// works on iOS WKWebView where cross-frame addEventListener is silently ignored.
function attachIframeDictionary(contents) {
  if (!contents?.document || !contents?.window) return;
  const doc = contents.document;
  const win = contents.window;
  const coarsePointer = !!win.matchMedia?.('(pointer: coarse)')?.matches;
  if (coarsePointer) return; // touch devices: handled by the injected iframe script

  function getWordAtPoint(x, y) {
    let node, offset;
    if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (!r) return '';
      node = r.startContainer; offset = r.startOffset;
    } else if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (!p) return '';
      node = p.offsetNode; offset = p.offset;
    } else return '';
    if (node?.nodeType === 1) {
      const walker = doc.createTreeWalker(node, 0x4);
      const t = walker.nextNode();
      if (t) { node = t; offset = 0; }
    }
    if (!node || node.nodeType !== 3) return '';
    const text = node.textContent;
    let s = offset, e = offset;
    while (s > 0 && /[\p{L}\p{N}'\u2019\-]/u.test(text[s - 1])) s--;
    while (e < text.length && /[\p{L}\p{N}'\u2019\-]/u.test(text[e])) e++;
    return text.slice(s, e).replace(/^['\u2019\-]+|['\u2019\-]+$/g, '').trim();
  }

  doc.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel  = win.getSelection?.();
    const sel0 = sel?.toString().trim();
    const word = sel0 ? sel0.split(/\s+/)[0] : getWordAtPoint(e.clientX, e.clientY);
    if (word) window.parent.postMessage({ type: 'dict-lookup', word }, '*');
  });

  doc.addEventListener('dblclick', (e) => {
    const sel  = win.getSelection?.();
    const sel0 = sel?.toString().trim();
    const word = sel0 ? sel0.split(/\s+/)[0] : getWordAtPoint(e.clientX, e.clientY);
    if (word) window.parent.postMessage({ type: 'dict-lookup', word }, '*');
  });
}

// ── Cross-frame touch navigation (Android / Desktop) ─────────────────────────
// iOS uses the injected-script relay (buildIframeTouchScript) because WKWebView
// silently drops cross-frame addEventListener calls.  On every other platform
// cross-frame listeners work reliably and avoid epub.js event-ordering conflicts.
const _navAttached = new WeakSet();

function getWordAtPointInFrame(doc, x, y) {
  if (!doc) return '';
  let node, offset;
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (!r) return '';
    node = r.startContainer; offset = r.startOffset;
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (!p) return '';
    node = p.offsetNode; offset = p.offset;
  } else return '';
  if (node?.nodeType === 1) {
    const walker = doc.createTreeWalker(node, 0x4);
    const tn = walker.nextNode();
    if (tn) { node = tn; offset = 0; }
  }
  if (!node || node.nodeType !== 3) return '';
  const text = node.textContent;
  let s = offset, e = offset;
  while (s > 0 && /[\p{L}\p{N}'’\-]/u.test(text[s - 1])) s--;
  while (e < text.length && /[\p{L}\p{N}'’\-]/u.test(text[e])) e++;
  return text.slice(s, e).replace(/^[''\-]+|[''\-]+$/g, '').trim();
}

function attachIframeTouchNav(view) {
  if (isIOS) return;
  const win = view?.contents?.window;
  const doc = view?.contents?.document;
  if (!win || _navAttached.has(win)) return;
  _navAttached.add(win);

  let sx = 0, sy = 0, pressTimer = null, longPressActive = false;

  win.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { clearTimeout(pressTimer); return; }
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    longPressActive = false;
    pressTimer = setTimeout(() => {
      longPressActive = true;
      const word = getWordAtPointInFrame(doc, sx, sy);
      if (word) showDictPopup(word);
    }, 550);
  }, { passive: true });

  win.addEventListener('touchmove', (e) => {
    const dx = Math.abs(e.touches[0].clientX - sx);
    const dy = Math.abs(e.touches[0].clientY - sy);
    if (dx > 10 || dy > 10) clearTimeout(pressTimer);
  }, { passive: true });

  win.addEventListener('touchend', (e) => {
    clearTimeout(pressTimer);
    if (longPressActive) { longPressActive = false; return; }
    const t  = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const W  = win.innerWidth;

    if (prefs.autoHideHeader && dy > SWIPE_DOWN_OPEN && ax < 70) {
      readerLayout.classList.toggle('header-peek');
      return;
    }
    if (ax < 10 && ay < 10) {
      if (prefs.autoHideHeader && t.clientY + currentIframeTop < TOP_REVEAL_ZONE + 20) {
        readerLayout.classList.add('header-peek');
        return;
      }
      const zone = TAP_ZONE * W;
      if (t.clientX < zone)      { goPrev(); return; }
      if (t.clientX > W - zone)  { goNext(); return; }
      if (prefs.autoHideHeader) readerLayout.classList.toggle('header-peek');
      return;
    }
    if (ax > SWIPE_THRESHOLD && ay < SWIPE_MAX_VERT) {
      if (dx < 0) goNext(); else goPrev();
    }
  }, { passive: false });

  win.addEventListener('touchcancel', () => {
    clearTimeout(pressTimer);
    longPressActive = false;
  }, { passive: true });
}

// ── Status bar engine ─────────────────────────────────────────────────────────

// Reading speed: record each page turn; ignore gaps > 5 minutes
function trackReadingSpeed() {
  if (!isReady) return;
  const now  = Date.now();
  const last = speedSamples[speedSamples.length - 1];
  if (last && now - last.time > 5 * 60 * 1000) speedSamples = [];
  speedSamples.push({ time: now });
  if (speedSamples.length > 25) speedSamples = speedSamples.slice(-25);
}

// Pages per minute based on recent samples
function getPagesPerMinute() {
  if (speedSamples.length < 3) return prefs.statusBar.defaultPpm || 1.5;
  const oldest  = speedSamples[0];
  const newest  = speedSamples[speedSamples.length - 1];
  const elapsed = (newest.time - oldest.time) / 60000;
  if (elapsed < 0.3) return prefs.statusBar.defaultPpm || 1.5;
  return Math.max(0.05, Math.min(15, (speedSamples.length - 1) / elapsed));
}

// Format minutes as HH:MM
function formatEta(pages) {
  if (!pages || pages <= 0) return '';
  const ppm   = getPagesPerMinute();
  if (!ppm) return '';
  const total = Math.round(pages / ppm);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Average chapter length in pages (from cache)
function averageChapPages() {
  const vals = Object.values(chapPageCache);
  return vals.length ? Math.max(1, Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)) : 20;
}

// Estimated book pages
function estimateBookTotal() {
  const len = book?.spine?.spineItems?.length || book?.spine?.length || 1;
  let total = 0;
  for (let i = 0; i < len; i++) total += chapPageCache[i] || averageChapPages();
  return Math.max(1, total);
}

function estimateBookPage() {
  let pages = 0;
  for (let i = 0; i < currentSpineIndex; i++) pages += chapPageCache[i] || averageChapPages();
  return pages + currentChapPage;
}

function estimateBookPagesLeft() {
  return Math.max(0, estimateBookTotal() - estimateBookPage());
}

// Lookup icon for a stat id
const STAT_ICON = Object.fromEntries(getStatusStats().map(s => [s.id, s.icon]));

// Compute the text value of a single stat (no icon — icon added by computeSlot)
function computeStatValue(id) {
  switch (id) {
    case 'chapterPage':
      return currentChapTotal > 0 ? currentChapPage + '/' + currentChapTotal : '';
    case 'bookPage': {
      const bp = estimateBookPage(), bt = estimateBookTotal();
      return bp > 0 ? bp + '/' + bt : '';
    }
    case 'pagesLeftChap':
      return currentChapTotal > 0 ? String(Math.max(0, currentChapTotal - currentChapPage)) : '';
    case 'pagesLeftBook':
      return String(estimateBookPagesLeft());
    case 'pctChapter':
      return currentChapTotal > 0 ? Math.round((currentChapPage / currentChapTotal) * 100) + '%' : '';
    case 'pctBook':
      return Math.round(currentPct * 100) + '%';
    case 'timeLeftChap':
      return formatEta(Math.max(0, currentChapTotal - currentChapPage));
    case 'timeLeftBook':
      return formatEta(estimateBookPagesLeft());
    case 'currentTime': {
      const now = new Date();
      return now.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
    }
    case 'bookTitle':
      return currentBook?.title || '';
    case 'bookAuthor':
      return currentBook?.author || '';
    case 'chapterTitle':
      return chapterLabelFromHref(currentHref);
    default:
      return '';
  }
}

// Build the text for one position slot (join multiple stats with ' | ', each with its icon)
function computeSlot(ids) {
  if (!ids?.length) return '';
  return ids.map(id => {
    const val  = computeStatValue(id);
    if (!val) return '';
    const icon     = STAT_ICON[id];
    const showIcon = prefs.statusBar.showIcons[id] !== false;   // default true
    return (icon && showIcon) ? icon + '\u202F' + val : val;    // NARROW NO-BREAK SPACE
  }).filter(Boolean).join('  |  ');
}

// Update all overlay slots from current state
function updateStatusBar(location) {
  const startPage  = location?.start?.displayed?.page  ?? 0;
  const totalPages = location?.start?.displayed?.total ?? 0;
  const endPage    = location?.end?.displayed?.page    ?? 0;
  const isTwoPage  = startPage > 0 && endPage > 0 && endPage !== startPage;

  // Update chapter page vars & cache.
  // Use the maximum total ever seen for this chapter: epub.js grows displayed.total
  // as it discovers more pages when navigating forward, so the first time you land
  // on a chapter it may report a lower total than after you have navigated deeper.
  // Keeping the max prevents the percentage from going *down* when navigating back.
  const stableTotal = Math.max(totalPages, chapPageCache[currentSpineIndex] || 0);
  currentChapPage     = startPage;
  currentEndPage      = endPage;
  currentChapTotal    = stableTotal || totalPages;
  currentChapRawTotal = totalPages; // unmodified — used for chapter-skip detection
  currentIsTwoPage    = isTwoPage;
  if (stableTotal > 0) chapPageCache[currentSpineIndex] = stableTotal;

  const pos = prefs.statusBar.positions;
  // In two-page mode, chapterPage is always placed at the outermost slots
  // (tl/tr for top, bl/br for bottom), honouring only the row (top vs bottom)
  // from the configured position and ignoring left/center/right.
  const chapInTop    = isTwoPage && (pos.tl.includes('chapterPage') || pos.tc.includes('chapterPage') || pos.tr.includes('chapterPage'));
  const chapInBottom = isTwoPage && (pos.bl.includes('chapterPage') || pos.bc.includes('chapterPage') || pos.br.includes('chapterPage'));

  // Pre-build chapter page strings (used for both top & bottom if needed)
  const cpIcon   = prefs.statusBar.showIcons['chapterPage'] !== false ? STAT_ICON['chapterPage'] + '\u202F' : '';
  const leftVal  = startPage > 0 ? cpIcon + startPage + '/' + totalPages : '';
  const rightVal = endPage   > 0 ? cpIcon + endPage   + '/' + totalPages : '';

  // ── Top row ──────────────────────────────────────────────────────────────
  if (chapInTop) {
    const tlOther = computeSlot(pos.tl.filter(id => id !== 'chapterPage'));
    const tcSlot  = computeSlot(pos.tc.filter(id => id !== 'chapterPage'));
    const trOther = computeSlot(pos.tr.filter(id => id !== 'chapterPage'));
    sbTl.textContent = [leftVal,  tlOther].filter(Boolean).join('  |  ');
    sbTc.textContent = tcSlot;
    sbTr.textContent = [trOther, rightVal].filter(Boolean).join('  |  ');
  } else {
    sbTl.textContent = computeSlot(pos.tl);
    sbTc.textContent = computeSlot(pos.tc);
    sbTr.textContent = computeSlot(pos.tr);
  }

  // ── Bottom row ───────────────────────────────────────────────────────────
  if (chapInBottom) {
    sbBottom.classList.add('two-page');
    const blOther = computeSlot(pos.bl.filter(id => id !== 'chapterPage'));
    const bcSlot  = computeSlot(pos.bc.filter(id => id !== 'chapterPage'));
    const brOther = computeSlot(pos.br.filter(id => id !== 'chapterPage'));
    sbBl.textContent = [leftVal,  blOther].filter(Boolean).join('  |  ');
    sbBc.textContent = bcSlot;
    sbBr.textContent = [brOther, rightVal].filter(Boolean).join('  |  ');
  } else {
    sbBottom.classList.remove('two-page');
    sbBl.textContent = computeSlot(pos.bl);
    sbBc.textContent = computeSlot(pos.bc);
    sbBr.textContent = computeSlot(pos.br);
  }

  updateChapProgressBar();
  updateBookProgressBar();
}

// Re-render only the slots that contain 'currentTime' (called by setInterval)
function refreshStatusBarTime() {
  const pos = prefs.statusBar.positions;
  const pairs = [[sbTl, pos.tl], [sbTc, pos.tc], [sbTr, pos.tr],
                 [sbBl, pos.bl], [sbBc, pos.bc], [sbBr, pos.br]];
  pairs.forEach(([el, ids]) => {
    if (ids.includes('currentTime')) el.textContent = computeSlot(ids);
  });
}
setInterval(refreshStatusBarTime, 30000);

// Apply CSS vars for edge inset (curved phone screens)
function applyEdgePadding() {
  const p = prefs.edgePadding;
  const root = document.documentElement;
  root.style.setProperty('--edge-pad-top',    p.top    + 'px');
  root.style.setProperty('--edge-pad-right',  p.right  + 'px');
  root.style.setProperty('--edge-pad-bottom', p.bottom + 'px');
  root.style.setProperty('--edge-pad-left',   p.left   + 'px');
  // Resize epub.js rendition so it fills the updated viewer area
  if (rendition) {
    setTimeout(() => {
      rendition.resize(epubViewer.clientWidth, Math.max(200, epubViewer.clientHeight - BOTTOM_RESERVE));
    }, 30);
  }
}

// Apply CSS variables for status bar font/size/style
function applyStatusBarStyles() {
  const sb   = prefs.statusBar;
  const root = document.documentElement;
  // '' means "inherit from book font" — use prefs.fontFamily so the status bar
  // actually renders in the same typeface as the epub text, not the host-page default.
  root.style.setProperty('--sb-font', sb.font ? `"${sb.font}"` : prefs.fontFamily);
  root.style.setProperty('--sb-font-size',   sb.fontSize + 'px');
  root.style.setProperty('--sb-font-weight', sb.fontStyle.includes('bold')   ? 'bold'   : 'normal');
  root.style.setProperty('--sb-font-style',  sb.fontStyle.includes('italic') ? 'italic' : 'normal');

  // Separators
  const thick = sb.separatorThickness + 'px';
  if (sbSeparatorTop) {
    sbSeparatorTop.style.display = sb.separatorTop    ? '' : 'none';
    sbSeparatorTop.style.height  = thick;
  }
  if (sbSeparatorBottom) {
    sbSeparatorBottom.style.display = sb.separatorBottom ? '' : 'none';
    sbSeparatorBottom.style.height  = thick;
  }

  // Progress bars
  applyProgressBarLayout();
}

function applyProgressBarLayout() {
  const sb      = prefs.statusBar;
  const chapCfg = sb.chapProgressBar;
  const bookCfg = sb.bookProgressBar;

  // When both bars are shown on the same edge, stack them so neither hides the other.
  // Book bar sits flush at the edge; chapter bar is offset by book bar thickness.
  const bothSame = chapCfg.show && bookCfg.show && chapCfg.position === bookCfg.position;

  if (sbBookProg) {
    sbBookProg.style.display = bookCfg.show ? '' : 'none';
    sbBookProg.style.height  = bookCfg.thickness + 'px';
    sbBookProg.style.top     = bookCfg.position === 'top'    ? 'var(--edge-pad-top, 0px)'    : 'auto';
    sbBookProg.style.bottom  = bookCfg.position === 'bottom' ? 'var(--edge-pad-bottom, 0px)' : 'auto';
  }

  if (sbChapProg) {
    sbChapProg.style.display = chapCfg.show ? '' : 'none';
    sbChapProg.style.height  = chapCfg.thickness + 'px';
    const edgeVar   = chapCfg.position === 'top' ? 'var(--edge-pad-top, 0px)' : 'var(--edge-pad-bottom, 0px)';
    const chapOffset = bothSame
      ? `calc(${edgeVar} + ${bookCfg.thickness + 1}px)`
      : edgeVar;
    sbChapProg.style.top     = chapCfg.position === 'top'    ? chapOffset : 'auto';
    sbChapProg.style.bottom  = chapCfg.position === 'bottom' ? chapOffset : 'auto';
  }
}

function updateChapProgressBar() {
  if (!prefs.statusBar.chapProgressBar.show || !sbChapProgFill) return;
  const pct = currentChapTotal > 0 ? (currentChapPage / currentChapTotal) * 100 : 0;
  sbChapProgFill.style.width = pct + '%';
}

function updateBookProgressBar() {
  if (!prefs.statusBar.bookProgressBar.show || !sbBookProgFill) return;
  sbBookProgFill.style.width = (currentPct * 100) + '%';
}

// ── Auto-hide header ──────────────────────────────────────────────────────────
function applyAutoHide() {
  readerLayout.classList.toggle('autohide-header', prefs.autoHideHeader);
  if (!prefs.autoHideHeader) {
    readerLayout.classList.remove('header-peek');
  }
  // Resize rendition since available height changes
  if (rendition) {
    setTimeout(() => {
      rendition.resize(epubViewer.clientWidth, Math.max(200, epubViewer.clientHeight - BOTTOM_RESERVE));
    }, 50);
  }
}

// Show header when mouse enters the thin sensor zone at very top of page
document.getElementById('header-sensor').addEventListener('mouseenter', () => {
  if (!prefs.autoHideHeader) return;
  readerLayout.classList.add('header-peek');
});
document.getElementById('header-sensor').addEventListener('touchstart', () => {
  if (!prefs.autoHideHeader) return;
  readerLayout.classList.add('header-peek');
}, { passive: true });
document.getElementById('header-sensor').addEventListener('click', () => {
  if (!prefs.autoHideHeader) return;
  readerLayout.classList.add('header-peek');
});
// Hide header as soon as mouse leaves the header bar itself
document.querySelector('.reader-header').addEventListener('mouseleave', () => {
  if (!prefs.autoHideHeader) return;
  if (!tocSidebar.classList.contains('open')) {
    readerLayout.classList.remove('header-peek');
  }
});

// ── TOC ───────────────────────────────────────────────────────────────────────
function buildToc(toc, depth = 0) {
  toc.forEach(item => {
    const btn = document.createElement('button');
    btn.className   = `toc-item toc-depth-${depth}`;
    btn.textContent = item.label;
    btn.title       = item.label;

    btn.addEventListener('click', () => {
      closePanels();
      // Delay so panel animation finishes and viewer has correct dimensions
      setTimeout(async () => {
        const [hrefBase, anchor] = (item.href || '').split('#');
        // Resolve via spine for reliable path matching
        const spineItem = book.spine.get(hrefBase);
        let displayHref;
        if (spineItem) {
          displayHref = anchor ? `${spineItem.href}#${anchor}` : spineItem.href;
        } else {
          displayHref = item.href;
        }
        try {
          await rendition.display(displayHref);
        } catch {
          try { await rendition.display(item.href); } catch { /* silent */ }
        }
      }, 80);
    });

    tocListEl.appendChild(btn);
    tocFlatItems.push({ label: item.label, href: item.href, depth, button: btn });
    if (item.subitems?.length) buildToc(item.subitems, depth + 1);
  });
}

function updateActiveTocItem(href) {
  if (!href) return;
  // Strip _split_NNN suffix — epub.js splits large chapters but TOC only lists _split_000
  const norm  = h => (h || '').split('#')[0].replace(/_split_\d+(\.\w+)$/, '$1').toLowerCase();
  const base  = norm(href).split('/').pop();
  let anyActive = false;
  tocFlatItems.forEach(({ href: ih, button }) => {
    const ib     = norm(ih || '').split('/').pop();
    const active = !!(base && ib && (base === ib || base.includes(ib) || ib.includes(base)));
    button.classList.toggle('active', active);
    if (active) anyActive = true;
  });
  if (!anyActive) {
    console.warn('[toc-debug] NO MATCH for spine href:', href,
      '| base:', base,
      '\nTOC hrefs:', tocFlatItems.map(t => t.href).join(' | '));
  }
}

function chapterLabelFromHref(href) {
  if (!href || !tocFlatItems.length) return '';
  // Normalize: decode URI, strip anchor/query, collapse backslash, lowercase,
  // and strip _split_NNN suffix so split-chapter spine files match TOC entries.
  const norm = (h) => decodeURIComponent(h || '')
    .split('#')[0].split('?')[0]
    .replace(/\\/g, '/')
    .replace(/_split_\d+(\.\w+)$/, '$1')
    .toLowerCase()
    .replace(/^\//, '');
  const n = norm(href);
  // 1. Exact full-path match
  let match = tocFlatItems.find(({ href: ih }) => norm(ih) === n);
  if (match) return match.label;
  // 2. One path is a suffix of the other (different leading directories)
  match = tocFlatItems.find(({ href: ih }) => {
    const t = norm(ih);
    return (n.endsWith('/' + t) || t.endsWith('/' + n));
  });
  if (match) return match.label;
  // 3. Filename-only exact match (same file, different directory structure)
  const base = n.split('/').pop();
  match = tocFlatItems.find(({ href: ih }) => base && norm(ih).split('/').pop() === base);
  return match?.label || '';
}

// ── Panels ────────────────────────────────────────────────────────────────────
function openToc() {
  tocSidebar.classList.add('open');
  settingsPanel.classList.remove('open');
  panelBackdrop.classList.add('visible');
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
  // Scroll active item to center of #toc-list after the slide-in transition (250ms)
  setTimeout(() => {
    const active = tocListEl.querySelector('.toc-item.active');
    if (!active) return;
    // offsetTop is relative to tocListEl because it's the offset parent (position:relative via flex)
    const itemTop    = active.offsetTop;
    const itemHeight = active.offsetHeight;
    const listHeight = tocListEl.clientHeight;
    tocListEl.scrollTop = itemTop - (listHeight / 2) + (itemHeight / 2);
  }, 280);
}
function openSettings() {
  settingsPanel.classList.add('open');
  tocSidebar.classList.remove('open');
  panelBackdrop.classList.add('visible');
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek'); // hide bar when settings opens
  renderDictSettings(); // lazy-load dictionary list
}
function closePanels() {
  const activeEl = document.activeElement;
  const searchHadFocus = !!activeEl && searchSidebar.contains(activeEl);
  tocSidebar.classList.remove('open');
  settingsPanel.classList.remove('open');
  searchSidebar.classList.remove('open');
  panelBackdrop.classList.remove('visible');
  if (searchHadFocus && typeof activeEl.blur === 'function') activeEl.blur();
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
}

function hasOpenPanel() {
  return tocSidebar.classList.contains('open')
    || searchSidebar.classList.contains('open')
    || settingsPanel.classList.contains('open');
}

async function returnToLibrary() {
  if (!prefs.skipSaveOnClose) {
    await saveProgress(); // await so updated_at is committed before library reloads
  }
  isReady = false;          // block beforeunload from double-saving
  window.location.href = '/';
}

function isFullscreenActive() {
  return !!document.fullscreenElement;
}

function isFullscreenSupported() {
  return !!document.fullscreenEnabled
    && typeof document.documentElement.requestFullscreen === 'function';
}

function syncFullscreenButton() {
  if (!fullscreenBtn) return;
  if (!isFullscreenSupported() || window.matchMedia('(pointer: coarse)').matches) {
    fullscreenBtn.classList.add('hidden');
    return;
  }
  fullscreenBtn.classList.remove('hidden');
  fullscreenBtn.textContent = isFullscreenActive() ? '\uD83D\uDDD7' : '\u26F6';
  fullscreenBtn.title = isFullscreenActive() ? t('reader.btn_fullscreen_exit') : t('reader.btn_fullscreen');
}

async function toggleFullscreen() {
  if (!isFullscreenSupported()) return;
  try {
    if (isFullscreenActive()) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    toast.error(t('reader.err_no_fullscreen'));
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
function openSearch() {
  searchSidebar.classList.add('open');
  tocSidebar.classList.remove('open');
  settingsPanel.classList.remove('open');
  panelBackdrop.classList.add('visible');
  if (prefs.autoHideHeader) readerLayout.classList.add('header-peek');
  setTimeout(() => searchInput.focus(), 280);
}

function clearSearchHighlights() {
  searchNav = null;
  // Remove DOM marks from all currently rendered sections
  if (rendition) {
    try {
      const contents = rendition.getContents();
      contents?.forEach(content => {
        content.document?.querySelectorAll('mark.br-hl').forEach(m => {
          m.replaceWith(content.document.createTextNode(m.textContent));
        });
      });
    } catch { /* ignore */ }
  }
}

// Highlight the last searched query in the current rendered iframe by wrapping
// matched text nodes in <mark class="br-hl"> elements.
// Uses only background-color so inline dimensions are unchanged (no reflow).
function applyDomSearchHighlight(query) {
  if (!query || !rendition) return;
  try {
    const contents = rendition.getContents();
    if (!contents?.length) return;
    const reEsc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re    = new RegExp(`(${reEsc})`, 'gi');
    contents.forEach(content => {
      const doc = content.document;
      if (!doc?.body) return;
      // Remove stale marks
      doc.querySelectorAll('mark.br-hl').forEach(m => {
        m.replaceWith(doc.createTextNode(m.textContent));
      });
      // Walk text nodes and wrap matches
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement?.closest('script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      });
      const hits = [];
      let node;
      while ((node = walker.nextNode())) {
        if (re.test(node.textContent)) { hits.push(node); re.lastIndex = 0; }
      }
      hits.forEach(textNode => {
        if (!textNode.parentNode) return;
        const parts = textNode.textContent.split(re);
        if (parts.length <= 1) return;
        const frag = doc.createDocumentFragment();
        parts.forEach((part, i) => {
          if (i % 2 === 0) {
            if (part) frag.appendChild(doc.createTextNode(part));
          } else {
            const mark = doc.createElement('mark');
            mark.className = 'br-hl';
            mark.textContent = part;
            frag.appendChild(mark);
          }
        });
        textNode.replaceWith(frag);
      });
    });
  } catch(e) { console.warn('[search] DOM highlight error:', e); }
}

function highlightExcerpt(excerpt, query) {
  const e = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const escaped = e(excerpt);
  const re = new RegExp(e(query).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
  return escaped.replace(re, m => `<mark>${m}</mark>`);
}

// Extract the start-point of a range CFI for reliable navigation.
// Range format: epubcfi(base,startOffset,endOffset)
// Location format: epubcfi(base+startOffset)
function cfiRangeToStart(cfi) {
  // Matches: epubcfi( anything , /something , /something )
  const m = String(cfi).match(/^epubcfi\((.+),(\/.+),(\/.+)\)$/);
  if (!m) return cfi; // not a range — already a location CFI
  return `epubcfi(${m[1]}${m[2]})`;
}

async function jumpToSearchResult(cfi, href, query) {
  // Save position before first jump so user can return
  if (!preSearchCfi && currentCfi) {
    preSearchCfi = currentCfi;
    searchBackBtn.style.display = '';
  }
  closePanels();
  clearSearchHighlights();

  const navCfi = cfiRangeToStart(cfi);

  // Determine if the target is in the currently-loaded chapter.
  // If so, styles are already injected — skip phase 'first' and go directly to the CFI.
  const targetItem  = book.spine.get(href);
  const sameChapter = targetItem && (targetItem.index === currentSpineIndex);

  if (sameChapter) {
    // Styles already applied — navigate straight to the exact position.
    searchNav = { cfi, navCfi, query, href, phase: 'second' };
    try { await rendition.display(navCfi); } catch { try { await rendition.display(cfi); } catch {} }
  } else {
    // Different chapter: navigate to its start first so epub.js loads + injects our styles,
    // then phase 'first' relocated handler will re-navigate to the exact CFI.
    searchNav = { cfi, navCfi, query, href, phase: 'first' };
    try { await rendition.display(href); } catch {
      // href failed — fall through to direct CFI navigation
      searchNav.phase = 'second';
      try { await rendition.display(navCfi); } catch {}
    }
  }
}

async function runSearch(query) {
  searchResultsEl.innerHTML = '';
  searchStatusEl.textContent = t('reader.search_running');

  const abort = { aborted: false };
  searchAbort.aborted = true;   // abort any previous search
  searchAbort = abort;

  // Collect all spine sections
  const sections = [];
  book.spine.each(item => sections.push(item));

  let total = 0;
  for (let i = 0; i < sections.length; i++) {
    if (abort.aborted) return;
    const item = sections[i];
    searchStatusEl.textContent = t('reader.search_progress', { n: i + 1, total: sections.length });
    try {
      await item.load(book.load.bind(book));
      const matches = item.find(query);
      item.unload();
      if (abort.aborted) return;
      if (matches.length) {
        const chapterLabel = chapterLabelFromHref(item.href) || item.href.split('/').pop();
        matches.forEach(({ cfi, excerpt }) => {
          total++;
          const div = document.createElement('div');
          div.className = 'search-result';
          div.innerHTML = `
            <div class="search-result-chapter">${esc(chapterLabel)}</div>
            <div class="search-result-excerpt">${highlightExcerpt(excerpt, query)}</div>
          `;
          div.addEventListener('click', () => jumpToSearchResult(cfi, item.href, query));
          searchResultsEl.appendChild(div);
        });
      }
    } catch { /* spine item unloadable — skip */ }
  }

  if (abort.aborted) return;
  if (total === 0) {
    searchStatusEl.textContent = t('reader.search_none');
  } else {
    searchStatusEl.textContent = total === 1 ? t('reader.search_count_1') : total < 5 ? t('reader.search_count_2_4', { n: total }) : t('reader.search_count', { n: total });
  }
}

// ── Dictionary ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadAvailableDicts() {
  if (availableDicts !== null) return availableDicts;
  try { availableDicts = await apiFetch('/dictionary'); }
  catch { availableDicts = []; }
  return availableDicts;
}

async function renderDictSettings() {
  const container = document.getElementById('dict-settings-list');
  if (!container) return;
  const dicts = await loadAvailableDicts();
  if (!dicts.length) {
    container.innerHTML = '<div style="font-size:.82rem;color:var(--color-text-muted)">' +
      t('reader.dict_no_dicts') + '</div>';
    return;
  }

  // Build ordered list: saved order first, then any new dicts appended at end.
  const saved   = Array.isArray(prefs.dictionaries) && prefs.dictionaries.length ? prefs.dictionaries : [];
  const allIds  = dicts.map(d => d.id);
  const ordered = [...saved.filter(id => allIds.includes(id)), ...allIds.filter(id => !saved.includes(id))];
  // enabled set: if nothing saved yet, enable all
  const enabled = new Set(saved.length ? saved : allIds);

  function saveOrder() {
    const items = container.querySelectorAll('.dict-settings-item');
    prefs.dictionaries = Array.from(items)
      .filter(el => el.querySelector('input[type="checkbox"]').checked)
      .map(el => el.querySelector('input[type="checkbox"]').value);
    persistPrefs();
  }

  function buildRow(id) {
    const d   = dicts.find(x => x.id === id);
    if (!d) return null;
    const row = document.createElement('div');
    row.className   = 'dict-settings-item';
    row.dataset.id  = id;
    row.innerHTML = `
      <input type="checkbox" value="${esc(id)}" ${enabled.has(id) ? 'checked' : ''}>
      <div class="dict-settings-name" style="flex:1">
        <span>${esc(d.name)}</span>
        ${d.wordcount ? `<span class="dict-settings-count">${d.wordcount.toLocaleString()} ${t('reader.dict_words')}</span>` : ''}
      </div>
      <div class="dict-order-btns">
        <button class="dict-order-btn" data-dir="up"   title="${t('reader.dict_move_up')}"   aria-label="${t('reader.dict_move_up')}">&#8593;</button>
        <button class="dict-order-btn" data-dir="down" title="${t('reader.dict_move_down')}" aria-label="${t('reader.dict_move_down')}">&#8595;</button>
      </div>`;
    row.querySelector('input[type="checkbox"]').addEventListener('change', saveOrder);
    row.querySelectorAll('.dict-order-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dir  = btn.dataset.dir;
        const rows = Array.from(container.children);
        const idx  = rows.indexOf(row);
        if (dir === 'up'   && idx > 0)             container.insertBefore(row, rows[idx - 1]);
        if (dir === 'down' && idx < rows.length - 1) container.insertBefore(rows[idx + 1], row);
        // Re-evaluate button state after move
        updateOrderBtnState();
        saveOrder();
      });
    });
    return row;
  }

  function updateOrderBtnState() {
    const rows = Array.from(container.children);
    rows.forEach((row, i) => {
      row.querySelector('[data-dir="up"]').disabled   = (i === 0);
      row.querySelector('[data-dir="down"]').disabled = (i === rows.length - 1);
    });
  }

  container.innerHTML = '';
  ordered.forEach(id => {
    const row = buildRow(id);
    if (row) container.appendChild(row);
  });
  updateOrderBtnState();
}

async function showDictPopup(word) {
  if (!word) return;
  const popup     = document.getElementById('dict-popup');
  const backdrop  = document.getElementById('dict-backdrop');
  const wordEl    = document.getElementById('dict-popup-word');
  const resultsEl = document.getElementById('dict-popup-results');

  // Intercept <a> clicks inside definitions — look up that word instead of navigating
  if (!resultsEl._dictLinksAttached) {
    resultsEl._dictLinksAttached = true;
    resultsEl.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      // Prefer link text over href (href is often an internal dict reference, not a word)
      const target = a.textContent.trim().replace(/^[^a-zA-Z\u00C0-\u017E]+|[^a-zA-Z\u00C0-\u017E]+$/g, '').trim();
      if (target) showDictPopup(target);
    });
  }

  wordEl.textContent = word;
  resultsEl.innerHTML = '<div class="dict-loading">Iščem\u2026</div>';
  backdrop.classList.add('open');
  popup.classList.add('open');
  popup.setAttribute('aria-hidden', 'false');

  const dicts   = await loadAvailableDicts();
  const enabled = Array.isArray(prefs.dictionaries) && prefs.dictionaries.length
    ? prefs.dictionaries
    : dicts.map(d => d.id);

  if (!enabled.length) {
    resultsEl.innerHTML = '<div class="dict-empty">' + t('reader.dict_no_dicts_short') + '</div>';
    return;
  }

  try {
    const data = await apiFetch(`/dictionary/lookup?word=${encodeURIComponent(word)}&dicts=${enabled.join(',')}`);
    if (!data.results.length) {
      resultsEl.innerHTML = `<div class="dict-empty">${t('reader.dict_not_found', { word: esc(word) })}</div>`;
    } else {
      resultsEl.innerHTML = data.results.map((r, i) => {
        // HTML type: render as HTML but strip any <script>/<style> for safety.
        // Plain text type (m/g/others): escape and preserve newlines.
        let defHtml;
        if (r.type === 'h') {
          const clean = r.definition
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '');
          defHtml = `<div class="dict-result-def html-def">${clean}</div>`;
        } else {
          defHtml = `<div class="dict-result-def">${esc(r.definition).replace(/\n/g, '<br>')}</div>`;
        }
        return `${i > 0 ? '<hr class="dict-hr">' : ''}
          <div class="dict-result">
            <div class="dict-result-source">
              ${esc(r.dictName)}${r.matchedForm && r.matchedForm !== word.toLowerCase() ? ` <span class="dict-matched-form">\u2192 ${esc(r.word)}</span>` : ''}
            </div>
            ${defHtml}
          </div>`;
      }).join('');
    }
  } catch {
    resultsEl.innerHTML = '<div class="dict-empty">' + t('reader.dict_error') + '</div>';
  }
}

function closeDictPopup() {
  // Clear text selection so highlighted word is removed after dictionary closes.
  try { window.getSelection?.()?.removeAllRanges?.(); } catch { /* ignore */ }
  try {
    rendition?.getContents?.().forEach(c => {
      try { c.window?.getSelection?.()?.removeAllRanges?.(); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  document.getElementById('dict-popup')?.classList.remove('open');
  document.getElementById('dict-backdrop')?.classList.remove('open');
  document.getElementById('dict-popup')?.setAttribute('aria-hidden', 'true');
}

// Receive messages from the injected iframe touch-relay script and dict lookups.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d?.type) return;

  if (d.type === 'dict-lookup') {
    const word = String(d.word || '').trim();
    if (!word || word.length > 120) return;
    showDictPopup(word);
    return;
  }

  // Navigation posted by the iframe touch-relay script (swipe or edge tap)
  if (d.type === 'br-nav') {
    if (d.action === 'next') goNext();
    else if (d.action === 'prev') goPrev();
    return;
  }

  // Center tap inside the iframe — decide whether to toggle/reveal the header
  if (d.type === 'br-tap') {
    if (prefs.autoHideHeader) {
      const absY = (d.cy || 0) + currentIframeTop;
      if (absY < TOP_REVEAL_ZONE + 20) readerLayout.classList.add('header-peek');
      else readerLayout.classList.toggle('header-peek');
    }
    return;
  }

  // Downward swipe inside the iframe — toggle header
  if (d.type === 'br-swipe-down') {
    if (prefs.autoHideHeader) readerLayout.classList.toggle('header-peek');
    return;
  }
});

// ── Settings UI ───────────────────────────────────────────────────────────────
function populateFontSelect() {
  const sel = document.getElementById('font-family-select');
  sel.innerHTML = '';
  [...SYSTEM_FONTS, ...customFonts]
    .sort((a, b) => a.label.localeCompare(b.label))
    .forEach(f => {
      const opt = document.createElement('option');
      opt.value       = f.value;
      opt.textContent = f.label;
      sel.appendChild(opt);
    });
  const exact  = Array.from(sel.options).find(o => o.value === prefs.fontFamily);
  if (exact) {
    sel.value = prefs.fontFamily;
  } else {
    const first  = prefs.fontFamily.split(',')[0].replace(/"/g, '').trim();
    const approx = Array.from(sel.options).find(o =>
      o.value.split(',')[0].replace(/"/g, '').trim() === first);
    if (approx) sel.value = approx.value;
  }
}

function syncSettingsUi() {
  document.getElementById('font-size-slider').value        = prefs.fontSize;
  document.getElementById('font-size-value').textContent   = prefs.fontSize + 'px';
  document.getElementById('line-height-slider').value      = prefs.lineHeight;
  document.getElementById('line-height-value').textContent = prefs.lineHeight;
  document.getElementById('margin-slider').value           = prefs.margin;
  document.getElementById('margin-value').textContent      = prefs.margin + 'px';
  document.getElementById('override-styles-toggle').checked  = prefs.overrideStyles;
  document.getElementById('autohide-header-toggle').checked  = prefs.autoHideHeader;
  document.getElementById('keep-screen-on-toggle').checked   = prefs.keepScreenOn;
  document.getElementById('eink-toggle').checked             = prefs.eink;
  const openCheckEl = document.getElementById('skip-open-progress-toggle');
  if (openCheckEl) openCheckEl.checked = prefs.skipOpenProgressCheck;
  const saveOnCloseEl = document.getElementById('skip-save-on-close-toggle');
  if (saveOnCloseEl) saveOnCloseEl.checked = prefs.skipSaveOnClose;
  document.querySelectorAll('.theme-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === prefs.theme));
  document.querySelectorAll('.spread-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.spread === prefs.spread));
  // Edge padding
  ['top','bottom','left','right'].forEach(side => {
    const el = document.getElementById('edge-pad-' + side);
    const vl = document.getElementById('edge-pad-' + side + '-value');
    if (el) el.value = prefs.edgePadding[side];
    if (vl) vl.textContent = prefs.edgePadding[side] + 'px';
  });
  // Paragraph options
  const piEl = document.getElementById('para-indent-toggle');
  if (piEl) piEl.checked = prefs.paraIndent;
  const psEl = document.getElementById('para-spacing-slider');
  const psVl = document.getElementById('para-spacing-value');
  if (psEl) psEl.value = prefs.paraSpacing;
  if (psVl) psVl.textContent = (prefs.paraSpacing / 10).toFixed(1) + 'em';
  const mwEl = document.getElementById('mouse-wheel-nav-toggle');
  if (mwEl) mwEl.checked = prefs.mouseWheelNav;
  const hypEl  = document.getElementById('hyphenation-toggle');
  if (hypEl) hypEl.checked = prefs.hyphenation;
  const hypLangEl = document.getElementById('hyphen-lang-select');
  if (hypLangEl) { hypLangEl.value = prefs.hyphenLang; hypLangEl.closest('.setting-row').style.display = prefs.hyphenation ? '' : 'none'; }
  const pgShadowEl = document.getElementById('page-gap-shadow-toggle');
  if (pgShadowEl) pgShadowEl.checked = prefs.pageGapShadow;
  syncStatusBarSettings();
}

// ── Status bar settings UI ────────────────────────────────────────────────────
// Re-render all status slots from cached state (doesn't need a location object).
// Used for immediate live updates when settings change.
function renderStatusSlots() {
  const pos          = prefs.statusBar.positions;
  const isTwoPage    = currentIsTwoPage;   // authoritative state, not DOM class
  const chapInTop    = isTwoPage && (pos.tl.includes('chapterPage') || pos.tc.includes('chapterPage') || pos.tr.includes('chapterPage'));
  const chapInBottom = isTwoPage && (pos.bl.includes('chapterPage') || pos.bc.includes('chapterPage') || pos.br.includes('chapterPage'));

  const cpIcon   = prefs.statusBar.showIcons['chapterPage'] !== false ? STAT_ICON['chapterPage'] + '\u202F' : '';
  const leftVal  = currentChapPage > 0 ? cpIcon + currentChapPage + '/' + currentChapTotal : '';
  const rightVal = currentEndPage  > 0 ? cpIcon + currentEndPage  + '/' + currentChapTotal : '';

  if (chapInTop) {
    const tlOther = computeSlot(pos.tl.filter(id => id !== 'chapterPage'));
    const tcSlot  = computeSlot(pos.tc.filter(id => id !== 'chapterPage'));
    const trOther = computeSlot(pos.tr.filter(id => id !== 'chapterPage'));
    sbTl.textContent = [leftVal,  tlOther].filter(Boolean).join('  |  ');
    sbTc.textContent = tcSlot;
    sbTr.textContent = [trOther, rightVal].filter(Boolean).join('  |  ');
  } else {
    sbTl.textContent = computeSlot(pos.tl);
    sbTc.textContent = computeSlot(pos.tc);
    sbTr.textContent = computeSlot(pos.tr);
  }

  if (chapInBottom) {
    sbBottom.classList.add('two-page');
    const blOther = computeSlot(pos.bl.filter(id => id !== 'chapterPage'));
    const bcSlot  = computeSlot(pos.bc.filter(id => id !== 'chapterPage'));
    const brOther = computeSlot(pos.br.filter(id => id !== 'chapterPage'));
    sbBl.textContent = [leftVal,  blOther].filter(Boolean).join('  |  ');
    sbBc.textContent = bcSlot;
    sbBr.textContent = [brOther, rightVal].filter(Boolean).join('  |  ');
    sbBottom.classList.toggle('two-page-no-center', !bcSlot);
  } else {
    sbBottom.classList.remove('two-page');
    sbBottom.classList.remove('two-page-no-center');
    sbBl.textContent = computeSlot(pos.bl);
    sbBc.textContent = computeSlot(pos.bc);
    sbBr.textContent = computeSlot(pos.br);
  }
}

function renderSbItems() {
  const container = document.getElementById('sb-items-list');
  if (!container) return;
  container.innerHTML = '';

  // Build reverse-lookup: stat id → position key
  const posOf = {};
  for (const [pos, ids] of Object.entries(prefs.statusBar.positions)) {
    ids.forEach(id => { posOf[id] = pos; });
  }

  getStatusStats().forEach(({ id, icon, label }) => {
    const curPos    = posOf[id] || 'off';
    const iconOn    = prefs.statusBar.showIcons[id] !== false;  // default true
    const row       = document.createElement('div');
    row.className   = 'sb-item-row';
    row.dataset.id  = id;
    row.innerHTML   = `
      <div class="sb-item-header">
        <span class="sb-item-icon">${icon}</span>
        <span class="sb-item-label">${label}</span>
        <label class="sb-icon-toggle" title="${t('reader.sb_icon_show')}">
          <input type="checkbox" class="sb-icon-chk" ${iconOn ? 'checked' : ''}>
          <span class="sb-icon-toggle-label">${t('reader.sb_icon_label')}</span>
        </label>
      </div>
      <select class="sb-item-pos">
        <option value="off">${t('reader.sb_pos_off')}</option>
        <option value="tl">${t('reader.sb_pos_tl')}</option>
        <option value="tc">${t('reader.sb_pos_tc')}</option>
        <option value="tr">${t('reader.sb_pos_tr')}</option>
        <option value="bl">${t('reader.sb_pos_bl')}</option>
        <option value="bc">${t('reader.sb_pos_bc')}</option>
        <option value="br">${t('reader.sb_pos_br')}</option>
      </select>`;
    row.querySelector('select').value = curPos;

    row.querySelector('select').addEventListener('change', (e) => {
      const newPos = e.target.value;
      for (const pos of Object.keys(prefs.statusBar.positions)) {
        prefs.statusBar.positions[pos] = prefs.statusBar.positions[pos].filter(x => x !== id);
      }
      if (newPos !== 'off') prefs.statusBar.positions[newPos].push(id);
      persistPrefs();
      renderStatusSlots();
    });

    row.querySelector('.sb-icon-chk').addEventListener('change', (e) => {
      prefs.statusBar.showIcons[id] = e.target.checked;
      persistPrefs();
      renderStatusSlots();
    });

    container.appendChild(row);
  });
}

function syncStatusBarSettings() {
  const sb = prefs.statusBar;

  // Font size slider
  const szSlider = document.getElementById('sb-font-size-slider');
  const szValue  = document.getElementById('sb-font-size-value');
  if (szSlider) { szSlider.value = sb.fontSize; }
  if (szValue)  { szValue.textContent = sb.fontSize + 'px'; }

  // Style buttons
  document.getElementById('sb-style-normal')?.classList.toggle('active', sb.fontStyle === 'normal');
  document.getElementById('sb-style-bold')?.classList.toggle('active',   sb.fontStyle === 'bold' || sb.fontStyle === 'bold italic');
  document.getElementById('sb-style-italic')?.classList.toggle('active', sb.fontStyle === 'italic' || sb.fontStyle === 'bold italic');

  // Font select (populated by populateSbFontSelect)
  const sbFontSel = document.getElementById('sb-font-select');
  if (sbFontSel) sbFontSel.value = sb.font || '';

  // Separator
  const anySep     = sb.separatorTop || sb.separatorBottom;
  const sepTopToggle    = document.getElementById('sb-sep-top-toggle');
  const sepBottomToggle = document.getElementById('sb-sep-bottom-toggle');
  const sepThickRow     = document.getElementById('sb-sep-thick-row');
  const sepThickSlider  = document.getElementById('sb-sep-thick-slider');
  const sepThickValue   = document.getElementById('sb-sep-thick-value');
  if (sepTopToggle)    sepTopToggle.checked          = sb.separatorTop;
  if (sepBottomToggle) sepBottomToggle.checked       = sb.separatorBottom;
  if (sepThickRow)     sepThickRow.style.display     = anySep ? '' : 'none';
  if (sepThickSlider)  sepThickSlider.value          = sb.separatorThickness;
  if (sepThickValue)   sepThickValue.textContent     = sb.separatorThickness + 'px';

  // Book progress bar
  const bookProgToggle = document.getElementById('sb-book-prog-toggle');
  const bookProgOpts   = document.getElementById('sb-book-prog-opts');
  const bookProgPos    = document.getElementById('sb-book-prog-pos');
  const bookProgThickSlider = document.getElementById('sb-book-prog-thick-slider');
  const bookProgThickValue  = document.getElementById('sb-book-prog-thick-value');
  if (bookProgToggle) bookProgToggle.checked         = sb.bookProgressBar.show;
  if (bookProgOpts)   bookProgOpts.style.display     = sb.bookProgressBar.show ? '' : 'none';
  if (bookProgPos)    bookProgPos.value               = sb.bookProgressBar.position;
  if (bookProgThickSlider) bookProgThickSlider.value = sb.bookProgressBar.thickness;
  if (bookProgThickValue)  bookProgThickValue.textContent = sb.bookProgressBar.thickness + 'px';

  // Chapter progress bar
  const chapProgToggle = document.getElementById('sb-chap-prog-toggle');
  const chapProgOpts   = document.getElementById('sb-chap-prog-opts');
  const chapProgPos    = document.getElementById('sb-chap-prog-pos');
  const chapProgThickSlider = document.getElementById('sb-chap-prog-thick-slider');
  const chapProgThickValue  = document.getElementById('sb-chap-prog-thick-value');
  if (chapProgToggle) chapProgToggle.checked         = sb.chapProgressBar.show;
  if (chapProgOpts)   chapProgOpts.style.display     = sb.chapProgressBar.show ? '' : 'none';
  if (chapProgPos)    chapProgPos.value               = sb.chapProgressBar.position;
  if (chapProgThickSlider) chapProgThickSlider.value = sb.chapProgressBar.thickness;
  if (chapProgThickValue)  chapProgThickValue.textContent = sb.chapProgressBar.thickness + 'px';
}

function populateSbFontSelect() {
  const sel = document.getElementById('sb-font-select');
  if (!sel) return;
  sel.innerHTML = `<option value="">${t('reader.sb_font_inherit')}</option>`;
  [...SYSTEM_FONTS, ...customFonts]
    .sort((a, b) => a.label.localeCompare(b.label))
    .forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.label;
      opt.textContent = f.label;
      sel.appendChild(opt);
    });
  sel.value = prefs.statusBar.font || '';
}

function initStatusBarSettings() {
  renderSbItems();

  // Font select
  document.getElementById('sb-font-select')?.addEventListener('change', (e) => {
    prefs.statusBar.font = e.target.value;
    applyStatusBarStyles(); persistPrefs();
  });

  // Font size
  document.getElementById('sb-font-size-slider')?.addEventListener('input', (e) => {
    prefs.statusBar.fontSize = parseInt(e.target.value);
    document.getElementById('sb-font-size-value').textContent = prefs.statusBar.fontSize + 'px';
    applyStatusBarStyles(); persistPrefs();
  });

  // Style buttons (toggle independently; bold+italic = 'bold italic')
  function updateFontStyle(bold, italic) {
    if (bold && italic) prefs.statusBar.fontStyle = 'bold italic';
    else if (bold)      prefs.statusBar.fontStyle = 'bold';
    else if (italic)    prefs.statusBar.fontStyle = 'italic';
    else                prefs.statusBar.fontStyle = 'normal';
    syncStatusBarSettings();
    applyStatusBarStyles(); persistPrefs();
  }
  document.getElementById('sb-style-normal')?.addEventListener('click', () => {
    updateFontStyle(false, false);
  });
  document.getElementById('sb-style-bold')?.addEventListener('click', () => {
    const cur = prefs.statusBar.fontStyle;
    const italic = cur.includes('italic');
    const bold   = !cur.includes('bold');
    updateFontStyle(bold, italic);
  });
  document.getElementById('sb-style-italic')?.addEventListener('click', () => {
    const cur = prefs.statusBar.fontStyle;
    const bold   = cur.includes('bold');
    const italic = !cur.includes('italic');
    updateFontStyle(bold, italic);
  });

  // Separators
  function updateSepThickRow() {
    const show = prefs.statusBar.separatorTop || prefs.statusBar.separatorBottom;
    document.getElementById('sb-sep-thick-row').style.display = show ? '' : 'none';
  }
  document.getElementById('sb-sep-top-toggle')?.addEventListener('change', (e) => {
    prefs.statusBar.separatorTop = e.target.checked;
    updateSepThickRow();
    applyStatusBarStyles(); persistPrefs();
  });
  document.getElementById('sb-sep-bottom-toggle')?.addEventListener('change', (e) => {
    prefs.statusBar.separatorBottom = e.target.checked;
    updateSepThickRow();
    applyStatusBarStyles(); persistPrefs();
  });
  document.getElementById('sb-sep-thick-slider')?.addEventListener('input', (e) => {
    prefs.statusBar.separatorThickness = parseInt(e.target.value);
    document.getElementById('sb-sep-thick-value').textContent = prefs.statusBar.separatorThickness + 'px';
    applyStatusBarStyles(); persistPrefs();
  });

  // Book progress bar
  document.getElementById('sb-book-prog-toggle')?.addEventListener('change', (e) => {
    prefs.statusBar.bookProgressBar.show = e.target.checked;
    document.getElementById('sb-book-prog-opts').style.display = e.target.checked ? '' : 'none';
    applyProgressBarLayout(); persistPrefs();
  });
  document.getElementById('sb-book-prog-pos')?.addEventListener('change', (e) => {
    prefs.statusBar.bookProgressBar.position = e.target.value;
    applyProgressBarLayout(); persistPrefs();
  });
  document.getElementById('sb-book-prog-thick-slider')?.addEventListener('input', (e) => {
    prefs.statusBar.bookProgressBar.thickness = parseInt(e.target.value);
    document.getElementById('sb-book-prog-thick-value').textContent = prefs.statusBar.bookProgressBar.thickness + 'px';
    applyProgressBarLayout(); persistPrefs();
  });

  // Chapter progress bar
  document.getElementById('sb-chap-prog-toggle')?.addEventListener('change', (e) => {
    prefs.statusBar.chapProgressBar.show = e.target.checked;
    document.getElementById('sb-chap-prog-opts').style.display = e.target.checked ? '' : 'none';
    applyProgressBarLayout(); persistPrefs();
  });
  document.getElementById('sb-chap-prog-pos')?.addEventListener('change', (e) => {
    prefs.statusBar.chapProgressBar.position = e.target.value;
    applyProgressBarLayout(); persistPrefs();
  });
  document.getElementById('sb-chap-prog-thick-slider')?.addEventListener('input', (e) => {
    prefs.statusBar.chapProgressBar.thickness = parseInt(e.target.value);
    document.getElementById('sb-chap-prog-thick-value').textContent = prefs.statusBar.chapProgressBar.thickness + 'px';
    applyProgressBarLayout(); persistPrefs();
  });
}

function initSettingsUi() {
  populateFontSelect();
  populateSbFontSelect();

  document.getElementById('btn-reset-book-prefs')?.addEventListener('click', () => {
    if (!currentBook?.id) return;
    clearBookPrefs(currentBook.id);
    // Reload global prefs and re-apply
    const global = loadPrefs();
    PER_BOOK_KEYS.forEach(k => { prefs[k] = global[k]; });
    syncSettingsUi();
    reapplyStyles();
    applyUiTheme();
    applyPageShadow();
    updateBookPrefsIndicator();
  });

  document.getElementById('font-size-slider').addEventListener('input', (e) => {
    prefs.fontSize = parseInt(e.target.value);
    document.getElementById('font-size-value').textContent = prefs.fontSize + 'px';
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('line-height-slider').addEventListener('input', (e) => {
    prefs.lineHeight = parseFloat(parseFloat(e.target.value).toFixed(1));
    document.getElementById('line-height-value').textContent = prefs.lineHeight;
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('margin-slider').addEventListener('input', (e) => {
    prefs.margin = parseInt(e.target.value);
    document.getElementById('margin-value').textContent = prefs.margin + 'px';
    reapplyStyles();
    // Margins in paginated mode are controlled via epub.js gap (not body padding).
    // gap = margin * 2 → epub.js sets body padding-left/right = gap/2 = margin.
    if (rendition?.manager) {
      rendition.manager.settings.gap = prefs.margin * 2;
      rendition.manager.updateLayout();
    }
    persistPrefs();
  });
  document.getElementById('font-family-select').addEventListener('change', (e) => {
    prefs.fontFamily = e.target.value;
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('override-styles-toggle').addEventListener('change', (e) => {
    prefs.overrideStyles = e.target.checked;
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('autohide-header-toggle').addEventListener('change', (e) => {
    prefs.autoHideHeader = e.target.checked;
    applyAutoHide(); persistPrefs();
  });
  document.getElementById('keep-screen-on-toggle').addEventListener('change', (e) => {
    prefs.keepScreenOn = e.target.checked;
    if (prefs.keepScreenOn) acquireWakeLock(); else releaseWakeLock();
    persistPrefs();
  });

  document.getElementById('eink-toggle').addEventListener('change', (e) => {
    prefs.eink = e.target.checked;
    applyUiTheme(); reapplyStyles(); persistPrefs();
  });

  // Paragraph options
  document.getElementById('para-indent-toggle')?.addEventListener('change', (e) => {
    prefs.paraIndent = e.target.checked;
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('para-spacing-slider')?.addEventListener('input', (e) => {
    prefs.paraSpacing = parseInt(e.target.value);
    const vl = document.getElementById('para-spacing-value');
    if (vl) vl.textContent = (prefs.paraSpacing / 10).toFixed(1) + 'em';
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('mouse-wheel-nav-toggle')?.addEventListener('change', (e) => {
    prefs.mouseWheelNav = e.target.checked;
    persistPrefs();
  });
  document.getElementById('skip-open-progress-toggle')?.addEventListener('change', (e) => {
    prefs.skipOpenProgressCheck = e.target.checked;
    persistPrefs();
  });
  document.getElementById('skip-save-on-close-toggle')?.addEventListener('change', (e) => {
    prefs.skipSaveOnClose = e.target.checked;
    persistPrefs();
  });
  document.getElementById('hyphenation-toggle')?.addEventListener('change', (e) => {
    prefs.hyphenation = e.target.checked;
    const langRow = document.getElementById('hyphen-lang-select')?.closest('.setting-row');
    if (langRow) langRow.style.display = prefs.hyphenation ? '' : 'none';
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('hyphen-lang-select')?.addEventListener('change', (e) => {
    prefs.hyphenLang = e.target.value;
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('page-gap-shadow-toggle')?.addEventListener('change', (e) => {
    prefs.pageGapShadow = e.target.checked;
    applyPageShadow(); persistPrefs();
  });

  // Edge padding sliders
  ['top','bottom','left','right'].forEach(side => {
    document.getElementById('edge-pad-' + side)?.addEventListener('input', (e) => {
      prefs.edgePadding[side] = parseInt(e.target.value);
      document.getElementById('edge-pad-' + side + '-value').textContent = prefs.edgePadding[side] + 'px';
      applyEdgePadding(); persistPrefs();
    });
  });

  document.getElementById('btn-download').addEventListener('click', () => {
    if (!currentBook?.id) return;
    if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
    const token = localStorage.getItem('br_token') || '';
    window.location.href = `/api/books/${currentBook.id}/file?download=1&token=${encodeURIComponent(token)}`;
  });

  // Dictionary popup close
  document.getElementById('dict-popup-close').addEventListener('click', closeDictPopup);
  document.getElementById('dict-backdrop').addEventListener('click', closeDictPopup);

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      prefs.theme = btn.dataset.theme;
      applyUiTheme(); reapplyStyles(); syncSettingsUi(); persistPrefs();
    });
  });
  document.querySelectorAll('.spread-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      prefs.spread = btn.dataset.spread;
      syncSettingsUi(); persistPrefs();
      if (rendition) {
        const savedCfi = currentCfi;
        rendition.destroy();
        await startRendition(savedCfi);
      }
    });
  });

  syncSettingsUi();
  initStatusBarSettings();
  applyStatusBarStyles();
  applyEdgePadding();
  applyPageShadow();

  // Kick off loading the status-bar font early so it's ready when the loading
  // overlay is removed. document.fonts.load() is a no-op if already loaded.
  {
    const sbFont = prefs.statusBar.font ? `"${prefs.statusBar.font}"` : prefs.fontFamily;
    const primary = sbFont.split(',')[0].trim().replace(/['"]/g, '');
    if (primary) document.fonts.load(`${prefs.statusBar.fontSize || 11}px "${primary}"`).catch(() => {});
  }
}

// ── Progress ──────────────────────────────────────────────────────────────────
function updateProgress(location) {
  const cfi = location?.start?.cfi;
  let pct   = 0;
  if (cfi && book.locations?.length() > 0) {
    pct = book.locations.percentageFromCfi(cfi) || 0;
  } else {
    const idx   = location?.start?.index || 0;
    const total = book.spine?.spineItems?.length || book.spine?.length || 1;
    pct = idx / total;
  }
  // Only update save-state after init is done — during startup, relocated fires
  // with page-start CFI which is earlier than the exact saved character offset.
  if (isReady) {
    currentCfi        = cfi || '';
    currentPct        = pct;
    currentSpineIndex = location?.start?.index ?? currentSpineIndex;
    console.log('[pos] relocated (ready) cfi:', (cfi||'').slice(0,60));
  } else {
    // Still track spine index even during init for accurate xpointer on first save
    currentSpineIndex = location?.start?.index ?? currentSpineIndex;
    console.log('[pos] relocated (NOT ready, ignored) cfi:', (cfi||'').slice(0,60));
  }
  const d = Math.round(pct * 100);
  progressFillEl.style.width = d + '%';
  const href = location?.start?.href || '';
  chapterTitleEl.textContent = chapterLabelFromHref(href);
  currentHref = href;
  updateActiveTocItem(href);
  // Save on chapter boundary (when spine item changes)
  if (isReady && lastChapterHref !== null && href && href !== lastChapterHref) {
    saveProgress();
  }
  if (href) lastChapterHref = href;

  // Status bar overlays (replacing old page info overlays)
  if (isReady) lastLocation = location;
  trackReadingSpeed();
  updateStatusBar(location);
}

function initLocations() {
  const key    = `br_locs_${currentBook.file_hash}`;
  const cached = localStorage.getItem(key);
  if (cached) {
    try {
      book.locations.load(cached);
      // Refresh percentage display only — do NOT navigate or overwrite currentCfi
      if (currentCfi && book.locations.length() > 0) {
        const pct = book.locations.percentageFromCfi(currentCfi);
        if (pct != null && isReady) {
          currentPct = pct;
          progressFillEl.style.width  = Math.round(pct * 100) + '%';
        }
      }
      return;
    } catch { localStorage.removeItem(key); /* corrupt — regenerate */ }
  }
  setTimeout(() => {
    book.locations.generate(1000).then(() => {
      try { localStorage.setItem(key, book.locations.save()); } catch { /* quota */ }
      // Refresh percentage display only — do NOT navigate
      if (currentCfi && book.locations.length() > 0) {
        const pct = book.locations.percentageFromCfi(currentCfi);
        if (pct != null && isReady) {
          currentPct = pct;
          progressFillEl.style.width  = Math.round(pct * 100) + '%';
        }
      }
    }).catch(() => {});
  }, 1500);
}

function scheduleProgressSave() {
  // no-op — chapter-boundary + close saving replaces the debounce
}

// Navigate to a percentage using jump + forward seek.
// cfiFromPercentage returns range CFIs that display() mishandles, so we
// jump close then advance with next() until percentage matches.
async function seekToPercentage(targetPct) {
  if (!book.locations?.length()) return;
  const jumpCfi = book.locations.cfiFromPercentage(targetPct);
  if (jumpCfi) { try { await rendition.display(jumpCfi); } catch { /* ignore */ } }
  for (let step = 0; step < 20; step++) {
    const loc    = rendition.currentLocation();
    const locCfi = loc?.start?.cfi;
    if (!locCfi) break;
    const curPct = book.locations.percentageFromCfi(locCfi) || 0;
    if (curPct >= targetPct - 0.005) break;
    await rendition.next();
  }
  const finalLoc = rendition.currentLocation();
  if (finalLoc?.start?.cfi) currentCfi = finalLoc.start.cfi;
  if (finalLoc?.start?.percentage != null) currentPct = finalLoc.start.percentage;
}

// ── External + internal kosync ────────────────────────────────────────────────
// KOReader identifies books by MD5 of file content — use file_hash_md5 so our
// entries in Grimmory/Booklore line up with what KOReader stores there.
function externalDocKey() {
  // Priority: user-supplied KOReader hash > computed MD5 > SHA-256 fallback
  return currentBook.kosync_hash || currentBook.file_hash_md5 || currentBook.file_hash;
}

// Generate a KOReader-compatible xpointer for the current position.
// If we have a precise xpointer received from KOReader for the current chapter,
// re-use it so KOReader can navigate to the exact paragraph, not just chapter start.
// Falls back to chapter-start xpointer when on a different chapter or no cached value.
function koReaderXPointer() {
  if (lastKnownXPointer) {
    const m = lastKnownXPointer.match(/\/body\/DocFragment\[(\d+)\]/);
    if (m && parseInt(m[1]) === currentSpineIndex + 1) {
      return lastKnownXPointer;
    }
  }
  return '/body/DocFragment[' + (currentSpineIndex + 1) + ']/body';
}

async function fetchRemoteProgress(docKey) {
  try { return await apiFetch(`/kosync/remote/${encodeURIComponent(docKey)}`); }
  catch { return null; }
}

async function fetchInternalProgress(docKey) {
  try { return await apiFetch(`/kosync/internal/${encodeURIComponent(docKey)}`); }
  catch { return null; }
}

function pushRemoteProgress(docKey, xpointer, pct) {
  return apiFetch(`/kosync/remote/${encodeURIComponent(docKey)}`, {
    method: 'PUT',
    body: JSON.stringify({
      document:   docKey,
      progress:   xpointer,
      percentage: pct,
      device:     'web',
      device_id:  'codexa-web',
    }),
  }).catch(() => {});
}

function pushInternalProgress(docKey, xpointer, pct) {
  return apiFetch(`/kosync/internal/${encodeURIComponent(docKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ progress: xpointer, percentage: pct, device: 'web', device_id: 'codexa-web' }),
  }).catch(() => {});
}

async function saveProgress() {
  if (!currentBook || !isReady) return;
  const cfi = currentCfi || '';
  const pct = currentPct || 0;
  if (!cfi && pct === 0) return;
  console.log('[pos] SAVE cfi:', cfi.slice(0,60), 'pct:', (pct*100).toFixed(2)+'%');
  const docKey = externalDocKey();
  const posChanged = cfi !== openCfi;
  console.log('[kosync] saveProgress docKey:', docKey, 'cfi:', cfi.slice(0, 40), 'pct:', Math.round(pct * 100) + '%', posChanged ? '' : '(no change — skipping remote push)');
  const saves = [
    apiFetch(`/progress/${currentBook.file_hash}`, {
      method: 'PUT',
      body: JSON.stringify({ cfi_position: cfi, percentage: pct, device: 'web' }),
    }),
  ];
  if (posChanged) {
    saves.push(pushRemoteProgress(docKey, koReaderXPointer(), pct));
    saves.push(pushInternalProgress(docKey, koReaderXPointer(), pct));
  }
  await Promise.allSettled(saves);
}

// Fire-and-forget version used when navigating away — uses keepalive:true so
// the browser keeps the requests alive even after the page unloads.
function saveProgressBackground() {
  if (!currentBook || !isReady) return;
  const cfi = currentCfi || '';
  const pct = currentPct || 0;
  if (!cfi && pct === 0) return;
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const opts = (body) => ({ method: 'PUT', headers, body: JSON.stringify(body), keepalive: true });
  const docKey = externalDocKey();
  const xp     = koReaderXPointer();
  const posChanged = cfi !== openCfi;
  fetch(`/api/progress/${currentBook.file_hash}`, opts({ cfi_position: cfi, percentage: pct, device: 'web' })).catch(() => {});
  if (posChanged) {
    fetch(`/api/kosync/remote/${encodeURIComponent(docKey)}`,   opts({ document: docKey, progress: xp, percentage: pct, device: 'web', device_id: 'codexa-web' })).catch(() => {});
    fetch(`/api/kosync/internal/${encodeURIComponent(docKey)}`, opts({ progress: xp, percentage: pct, device: 'web', device_id: 'codexa-web' })).catch(() => {});
  }
}

// ── KOReader sync-on-open dialog ──────────────────────────────────────────────
function showSyncDialog(best, localPct, localTime) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const rPct   = parseFloat(((best.percentage || 0) * 100).toFixed(2));
    const lPct   = parseFloat(((localPct        || 0) * 100).toFixed(2));
    const fmtTs  = (ts) => ts ? new Date(ts * 1000).toLocaleString(getCurrentLang()) : t('reader.sync_dlg_unknown_time');
    const rDate  = fmtTs(best.timestamp);
    const lDate  = fmtTs(localTime);
    const rNewer = (best.timestamp || 0) > (localTime || 0);
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:460px">
        <h3 style="margin:0 0 1rem;font-size:1rem;font-weight:600">${t('reader.sync_dlg_title')}</h3>
        <table style="width:100%;font-size:.85rem;border-collapse:collapse;margin-bottom:1.5rem">
          <thead>
            <tr style="color:var(--color-text-muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em">
              <th style="text-align:left;padding:.3rem 0">${t('reader.sync_dlg_col_device')}</th>
              <th style="text-align:right;padding:.3rem 0">${t('reader.sync_dlg_col_pos')}</th>
              <th style="text-align:right;padding:.3rem 0">${t('reader.sync_dlg_col_time')}</th>
            </tr>
          </thead>
          <tbody>
            <tr style="${rNewer ? 'font-weight:600' : ''}">
              <td style="padding:.3rem 0">${best.device || 'KOReader'} ${rNewer ? '★' : ''}</td>
              <td style="text-align:right">${rPct}%</td>
              <td style="text-align:right;color:var(--color-text-muted);font-size:.78rem">${rDate}</td>
            </tr>
            <tr style="${!rNewer ? 'font-weight:600' : ''}">
              <td style="padding:.3rem 0">${t('reader.sync_dlg_this_reader')} ${!rNewer ? '★' : ''}</td>
              <td style="text-align:right">${lPct}%</td>
              <td style="text-align:right;color:var(--color-text-muted);font-size:.78rem">${lDate}</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="sync-dlg-ignore">${t('reader.sync_dlg_keep', { pct: lPct })}</button>
          <button class="btn btn-primary"   id="sync-dlg-yes">${t('reader.sync_dlg_jump', { pct: rPct })}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const close = (ok) => { backdrop.remove(); resolve(ok); };
    backdrop.querySelector('#sync-dlg-yes').addEventListener('click',    () => close(true));
    backdrop.querySelector('#sync-dlg-ignore').addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
  });
}

// Check external + internal sources; prompt user if a newer position exists.
// Called AFTER the rendition is visible so the user sees the book while deciding.
async function syncOnOpen(localProgress) {
  const docKey = externalDocKey();
  console.log('[kosync] syncOnOpen docKey:', docKey);
  const [extResult, intResult] = await Promise.allSettled([
    fetchRemoteProgress(docKey),
    fetchInternalProgress(docKey),
  ]);
  const ext = extResult.status === 'fulfilled' ? extResult.value : null;
  const int = intResult.status === 'fulfilled' ? intResult.value : null;
  console.log('[kosync] remote:', ext, 'internal:', int);

  // Pick the freshest remote source
  let best = null;
  if (ext?.progress) best = ext;
  if (int?.progress && (!best || (int.timestamp || 0) > (best.timestamp || 0))) best = int;
  if (!best?.progress) {
    console.log('[kosync] no remote progress found');
    return null;
  }

  // Cache the precise xpointer so we can push it back unchanged when on the same chapter.
  // This prevents overwriting KOReader's /body/DocFragment[N]/body/div/p[M]/text().K
  // with a coarser chapter-start xpointer.
  if (best.progress.startsWith('/body/DocFragment[')) {
    lastKnownXPointer = best.progress;
  }

  const localPct  = localProgress?.percentage  || 0;
  const localTime = localProgress?.updated_at  || 0;
  const bestTime  = best.timestamp             || 0;
  console.log('[kosync] best:', best.device, Math.round((best.percentage||0)*100)+'%', 'ts:', bestTime, 'localTime:', localTime);

  // If the remote xpointer is a plain chapter-start reference (DocFragment[N]/body with
  // no paragraph detail), check whether it points to the chapter we're already on.
  // Percentage algorithms differ between clients, so 26% vs 24% can mean the same
  // chapter start — no point offering a sync to the position we're already at.
  const dfOnlyMatch = best.progress?.match(/^\/body\/DocFragment\[(\d+)\]\/body$/);
  if (dfOnlyMatch) {
    const remoteSpineIdx = parseInt(dfOnlyMatch[1]) - 1; // DocFragment is 1-based
    if (remoteSpineIdx === currentSpineIndex) {
      console.log('[kosync] remote is chapter-start of current chapter — skipping dialog');
      return null;
    }
  }

  // Always show dialog when positions differ by more than 1% — user decides.
  // ★ in the dialog marks whichever timestamp is newer.
  const pctDiffers = Math.abs((best.percentage || 0) - localPct) > 0.01;
  if (pctDiffers) {
    const doSync = await showSyncDialog(best, localPct, localTime);
    // Return both percentage and the xpointer string so the caller can navigate
    // directly to a spine item when the xpointer is a DocFragment-only reference.
    if (doSync) return { percentage: best.percentage, progress: best.progress };
  }
  return null;
}

// ── Rendition ─────────────────────────────────────────────────────────────────
function isMobileScreen() { return window.innerWidth < 640; }

async function startRendition(displayCfi = null) {
  // On small screens always force single-page, regardless of user preference
  const spreadMode = (prefs.spread === 'auto' && !isMobileScreen()) ? 'auto' : 'none';
  // Reserve 38px at the bottom so epub content doesn't flow behind the
  // status-bar / separator overlays. In CSS multi-column mode padding-bottom
  // on the body only applies to the last column, so the only reliable way to
  // leave space on every page is to shorten the column height here.
  rendition = book.renderTo('epub-viewer', {
    width:          epubViewer.clientWidth  || window.innerWidth,
    height:         Math.max(200, (epubViewer.clientHeight || (window.innerHeight - 55)) - BOTTOM_RESERVE),
    spread:         spreadMode,
    minSpreadWidth: 800,
    manager:        'default',
    gap:            prefs.margin * 2,
  });

  // Attach keyboard forwarding via content hook (runs on every page load).
  // Hide the body before injecting CSS, then wait for fonts to finish loading
  // before revealing — eliminates the flash of wrong font family (FOUT).
  // epub.js awaits promises returned by hooks.content callbacks.
  rendition.hooks.content.register(async (contents) => {
    const doc = contents?.document;
    if (doc?.body) doc.body.style.visibility = 'hidden';

    attachIframeKeyboard(contents);
    attachIframeDictionary(contents);
    injectIntoContents(contents);

    // iOS WebKit (Safari/Chrome) can stall on fonts.ready inside blob-URL iframes.
    // Race against a 1 s timeout so the body is always revealed and rendered fires.
    try {
      await Promise.race([
        doc?.fonts?.ready ?? Promise.resolve(),
        new Promise(r => setTimeout(r, 1000)),
      ]);
    } catch { /* unsupported */ }
    if (doc?.body) doc.body.style.visibility = '';
  });

  // 'rendered' fires AFTER epub.js finishes its own content setup.
  // Re-inject in the next tick to ensure our !important overrides win over
  // any late epub.js style mutations (belt-and-suspenders; no visible reflow
  // because hooks.content already applied the same CSS above).
  rendition.on('rendered', (_section, view) => {
    setTimeout(() => {
      if (view?.contents) injectIntoContents(view.contents);
    }, 0);
    attachIframeTouchNav(view);
    // Track the iframe's Y offset in the page so the parent can convert
    // the cy value from br-tap postMessages into absolute page coordinates.
    const iframe = view.element?.querySelector?.('iframe') || view.element;
    if (iframe?.getBoundingClientRect) {
      currentIframeTop = iframe.getBoundingClientRect().top;
    }
  });
    
  rendition.on('relocated', updateProgress);
  rendition.on('relocated', () => {
    if (!searchNav) return;
    if (searchNav.phase === 'first') {
      // Chapter is now loaded and our styles are being injected (setTimeout 0 in rendered).
      // Wait 350ms for font/layout reflow, then navigate to the exact CFI position.
      const { navCfi } = searchNav;
      searchNav.phase = 'second';
      setTimeout(() => { rendition.display(navCfi).catch(() => {}); }, 350);
    } else if (searchNav.phase === 'second') {
      // We are now on the correct page with correct styles applied.
      const { query } = searchNav;
      searchNav = null;
      // Wait for the paginated column layout to fully settle, then mark the text.
      setTimeout(() => applyDomSearchHighlight(query), 300);
    }
  });

  try {
    await rendition.display(displayCfi || undefined);
  } catch {
    await rendition.display();
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function goNext() { rendition?.next(); }
function goPrev() { rendition?.prev(); }

// ── Touch / swipe navigation ──────────────────────────────────────────────────
const SWIPE_THRESHOLD = 24;   // min px horizontal distance
const SWIPE_MAX_VERT  = 130;  // max vertical drift allowed
const TAP_ZONE        = 0.25; // 25% edge on each side for tap-to-page
const TOP_REVEAL_ZONE = 92;   // px from top where tap reveals header
const SWIPE_DOWN_OPEN = 42;   // px downward swipe to reveal header
// iOS detection (Chrome/Safari on iPhone/iPad use WebKit with different iframe touch behaviour)
const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let touchStartX = 0;
let touchStartY = 0;
let suppressNextTap = false;
let currentIframeTop = 0; // iframe's top offset from page top, updated on each rendered event

function handleTouchStart(e) {
  touchStartX = e.changedTouches[0].clientX;
  touchStartY = e.changedTouches[0].clientY;
}
function handleTouchEnd(e) {
  if (suppressNextTap) { suppressNextTap = false; return; }
  const dx    = e.changedTouches[0].clientX - touchStartX;
  const dy    = e.changedTouches[0].clientY - touchStartY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const y     = e.changedTouches[0].clientY;
  if (prefs.autoHideHeader && dy > SWIPE_DOWN_OPEN && absDx < 70) {
    readerLayout.classList.toggle('header-peek');
    return;
  }
  if (absDx < 10 && absDy < 10) {
    if (prefs.autoHideHeader && y < TOP_REVEAL_ZONE + 20) {
      readerLayout.classList.add('header-peek');
      return;
    }
    const x    = e.changedTouches[0].clientX;
    const w    = window.innerWidth;
    const zone = TAP_ZONE * w;
    if (x < zone)     { goPrev(); return; }
    if (x > w - zone) { goNext(); return; }
    if (prefs.autoHideHeader) readerLayout.classList.toggle('header-peek');
    return;
  }
  if (absDx > SWIPE_THRESHOLD && absDy < SWIPE_MAX_VERT) {
    if (dx < 0) goNext();
    else        goPrev();
  }
}
// Attach to the host container — covers the area outside the iframe (nav zones etc)
epubViewer.addEventListener('touchstart', handleTouchStart, { passive: true });
epubViewer.addEventListener('touchend',   handleTouchEnd,   { passive: false });

// Touch navigation from inside the iframe is now handled by buildIframeTouchScript()
// injected via injectIntoContents(). Navigation arrives via postMessage (br-nav,
// br-tap, br-swipe-down) and is processed in the window 'message' listener above.

document.addEventListener('keydown', (e) => {
  const key = String(e.key || '').toLowerCase();
  // ESC should always close an open panel, even when focus is inside an input.
  if (key === 'escape') {
    e.preventDefault();
    if (hasOpenPanel()) {
      closePanels();
    } else {
      void returnToLibrary();
    }
    return;
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case 'ArrowRight': case ' ': case 'PageDown':
      e.preventDefault(); goNext(); break;
    case 'ArrowLeft': case 'PageUp':
      e.preventDefault(); goPrev(); break;
    default:
      break;
  }
  switch (key) {
    case 'k':
      e.preventDefault();
      openToc();
      break;
    case 'i':
      e.preventDefault();
      openSearch();
      break;
    case 's':
      e.preventDefault();
      openSettings();
      break;
    case 'f':
      e.preventDefault();
      void toggleFullscreen();
      break;
    default:
      break;
  }
});

// ── Mouse wheel navigation ────────────────────────────────────────────────────
let wheelCooldown = false;
function handleWheel(deltaY) {
  if (!prefs.mouseWheelNav || !isReady) return;
  if (wheelCooldown) return;
  wheelCooldown = true;
  setTimeout(() => { wheelCooldown = false; }, 400);
  if (deltaY > 0) goNext(); else goPrev();
}
epubViewer.addEventListener('wheel', (e) => { handleWheel(e.deltaY); }, { passive: true });
document.addEventListener('br-wheel', (e) => { handleWheel(e.detail.deltaY); });

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
window.addEventListener('resize', debounce(async () => {
  if (!rendition) return;
  const pctBeforeResize = currentPct;
  rendition.resize(epubViewer.clientWidth, Math.max(200, epubViewer.clientHeight - BOTTOM_RESERVE));
  if (isReady && pctBeforeResize > 0 && book.locations?.length() > 0) {
    await seekToPercentage(pctBeforeResize);
  }
}, 300));

// ── Button wiring ─────────────────────────────────────────────────────────────
document.getElementById('btn-back').addEventListener('click', () => { void returnToLibrary(); });
document.getElementById('btn-toc').addEventListener('click', () =>
  tocSidebar.classList.contains('open') ? closePanels() : openToc());
document.getElementById('btn-search').addEventListener('click', () =>
  searchSidebar.classList.contains('open') ? closePanels() : openSearch());
document.getElementById('btn-search-back').addEventListener('click', async () => {
  if (!preSearchCfi) return;
  clearSearchHighlights();
  const cfi = preSearchCfi;
  preSearchCfi = null;
  searchBackBtn.style.display = 'none';
  await rendition.display(cfi);
});document.getElementById('search-close').addEventListener('click', closePanels);
document.getElementById('search-submit').addEventListener('click', () => {
  const q = searchInput.value.trim();
  if (q.length >= 2) runSearch(q);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const q = searchInput.value.trim();
    if (q.length >= 2) runSearch(q);
  }
});
document.getElementById('btn-settings').addEventListener('click', () =>
  settingsPanel.classList.contains('open') ? closePanels() : openSettings());
document.getElementById('btn-fullscreen').addEventListener('click', () => { void toggleFullscreen(); });
document.getElementById('toc-close').addEventListener('click',      closePanels);
document.getElementById('settings-close').addEventListener('click', closePanels);
panelBackdrop.addEventListener('click', closePanels);
document.getElementById('btn-prev').addEventListener('click', goPrev);
document.getElementById('btn-next').addEventListener('click', goNext);
document.querySelector('.nav-zone-prev')?.addEventListener('click', goPrev);
document.querySelector('.nav-zone-next')?.addEventListener('click', goNext);
document.querySelector('.nav-zone-prev')?.addEventListener('touchend', (e) => { e.preventDefault(); goPrev(); }, { passive: false });
document.querySelector('.nav-zone-next')?.addEventListener('touchend', (e) => { e.preventDefault(); goNext(); }, { passive: false });
document.getElementById('btn-prev').addEventListener('keydown', e => { if (e.key === 'Enter') goPrev(); });
document.getElementById('btn-next').addEventListener('keydown', e => { if (e.key === 'Enter') goNext(); });
window.addEventListener('beforeunload', () => {
  if (!prefs.skipSaveOnClose) saveProgressBackground();
});
document.addEventListener('fullscreenchange', syncFullscreenButton);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  applyUiTheme();
  applyPageShadow();
  applyAutoHide();
  syncFullscreenButton();
  await loadCustomFonts();
  // First-ever open: prefer Bookerly if available in user fonts
  if (!localStorage.getItem('br_reader_prefs')) {
    const bookerly = customFonts.find(f => f.label.toLowerCase().includes('bookerly'));
    if (bookerly) prefs.fontFamily = bookerly.value;
  }
  initSettingsUi();
  acquireWakeLock();

  try {
    loadingMsg.textContent = t('reader.loading_book');
    currentBook = await apiFetch(`/books/${bookId}`);
    bookTitleEl.textContent = currentBook.title;
    document.title = `${currentBook.title} — Codexa`;
    loadBookPrefs(currentBook.id);
    syncSettingsUi();
  } catch (err) {
    loadingMsg.textContent = t('reader.err_no_book');
    toast.error(err.message);
    return;
  }

  let arrayBuffer;
  try {
    loadingMsg.textContent = t('reader.loading_file');
    const res = await fetch(`/api/books/${bookId}/file`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    arrayBuffer = await res.arrayBuffer();
  } catch (err) {
    loadingMsg.textContent = t('reader.err_download');
    toast.error(err.message);
    return;
  }

  try {
    loadingMsg.textContent = t('reader.loading_open');
    book = ePub(arrayBuffer);

    book.loaded.navigation.then(nav => {
      if (nav?.toc?.length) {
        buildToc(nav.toc);
        // TOC may load after first 'relocated' — refresh chapter overlays now
        const href = lastChapterHref || '';
        if (href) {
          chapterTitleEl.textContent = chapterLabelFromHref(href);
        }
      } else {
        tocListEl.innerHTML = '<div class="toc-empty">' + t('reader.toc_none') + '</div>';
      }
    }).catch(() => {
      tocListEl.innerHTML = '<div class="toc-empty">' + t('reader.toc_none') + '</div>';
    });

    let startCfi      = null;
    let localProgress = null;
    try {
      localProgress = await apiFetch(`/progress/${currentBook.file_hash}`).catch(() => null);
      console.log('[reader] localProgress:', localProgress?.cfi_position?.slice(0, 60), 'pct:', localProgress?.percentage);
      if (localProgress?.cfi_position) startCfi = localProgress.cfi_position;
      // Pre-load locations from cache so seekToPercentage works immediately after startRendition
      if (localProgress?.percentage != null) {
        const locsKey    = `br_locs_${currentBook.file_hash}`;
        const cachedLocs = localStorage.getItem(locsKey);
        if (cachedLocs) { try { book.locations.load(cachedLocs); } catch { localStorage.removeItem(locsKey); } }
      }
    } catch { /* start from beginning */ }

    await startRendition(startCfi);
    // Capture the page-start CFI epub.js actually rendered.
    {
      const loc = rendition.currentLocation();
      if (loc?.start?.cfi) currentCfi = loc.start.cfi;
      if (loc?.start?.percentage != null) currentPct = loc.start.percentage;
      console.log('[pos] after startRendition currentCfi:', currentCfi.slice(0,60));
    }
    book.ready.then(() => initLocations()).catch(() => {});
    // Wait for host-page fonts (status bar) before revealing, with a 1 s cap so
    // iOS (which can stall on fonts.ready) doesn't freeze the loading overlay.
    try {
      await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1000))]);
    } catch { /* unsupported */ }
    loadingOverlay.classList.add('hidden');

    // epub.js display(cfi) with char-offset CFIs snaps to wrong page — seek forward by pct.
    if (localProgress?.percentage != null && book.locations.length() > 0) {
      console.log('[pos] seeking to saved pct:', (localProgress.percentage*100).toFixed(2)+'%');
      await seekToPercentage(localProgress.percentage);
      console.log('[pos] after seek currentCfi:', currentCfi.slice(0,60));
    }

    // Check remote/internal sync AFTER book is visible
    const syncTarget = prefs.skipOpenProgressCheck ? null : await syncOnOpen(localProgress);
    if (syncTarget?.percentage != null) {
      try {
        // If the xpointer is a plain chapter-start (DocFragment[N]/body with no paragraph
        // detail), navigate directly to that spine item. This avoids the byte-vs-char
        // percentage mismatch that causes the reader to land one page past the chapter start
        // (noticeable in two-page spread mode).
        const dfMatch = syncTarget.progress?.match(/^\/body\/DocFragment\[(\d+)\]\/body$/);
        if (dfMatch) {
          const spineIdx  = parseInt(dfMatch[1]) - 1; // DocFragment is 1-based
          const spineItem = book.spine.get(spineIdx);
          if (spineItem?.href) {
            console.log('[kosync] navigating to spine item', spineIdx, spineItem.href);
            await rendition.display(spineItem.href);
          } else {
            console.warn('[kosync] spine item not found for index', spineIdx, '— falling back to pct');
            const key    = `br_locs_${currentBook.file_hash}`;
            const cached = localStorage.getItem(key);
            if (cached) { try { book.locations.load(cached); } catch { localStorage.removeItem(key); } }
            if (!book.locations.length()) {
              await book.locations.generate(1000);
              try { localStorage.setItem(key, book.locations.save()); } catch { /* quota */ }
            }
            if (book.locations.length() > 0) await seekToPercentage(syncTarget.percentage);
          }
        } else {
          // Paragraph-level xpointer or no progress string — use percentage
          const key    = `br_locs_${currentBook.file_hash}`;
          const cached = localStorage.getItem(key);
          if (cached) { try { book.locations.load(cached); } catch { localStorage.removeItem(key); } }
          if (!book.locations.length()) {
            await book.locations.generate(1000);
            try { localStorage.setItem(key, book.locations.save()); } catch { /* quota */ }
          }
          if (book.locations.length() > 0) await seekToPercentage(syncTarget.percentage);
        }
      } catch (e) { console.warn('[kosync] navigate failed:', e.message); }
    }

    // Only allow saves after the initial position (local or synced) is fully displayed
    console.log('[pos] isReady=true, currentCfi:', currentCfi.slice(0,60));
    isReady = true;
    openCfi = currentCfi; // snapshot position-on-open for change detection
    // Final chapter-name refresh — by now TOC and relocated have both fired
    if (lastChapterHref) {
      chapterTitleEl.textContent = chapterLabelFromHref(lastChapterHref);
    }
  } catch (err) {
    console.error('[reader]', err);
    loadingMsg.textContent = t('reader.err_open', { msg: err.message });
    toast.error(t('reader.err_no_open'));
  }
}

init();

// Re-render settings panel content when language changes
document.addEventListener('langchange', () => {
  applyTranslations();
  syncFullscreenButton();
  renderSbItems();
  renderDictSettings();
  populateSbFontSelect();
});
