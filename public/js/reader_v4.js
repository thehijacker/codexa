import { apiFetch, requireAuth, getToken } from './api.js';
import { toast } from './ui.js';
import { t, initI18n, applyTranslations, getCurrentLang } from './i18n.js';
import ePub from './flow/index.js';

await initI18n();

if (!requireAuth()) throw new Error('not authenticated');
const params = new URLSearchParams(window.location.search);
const bookId = params.get('id');
if (!bookId) { window.location.href = '/'; throw new Error(); }
const BIONIC_RELOAD_KEY = 'br_bionic_reload_state_v1';
const SESSION_KEY = 'br_interrupted_session_v1';
const RESUME_STATE_KEY = 'br_resume_state_v1';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BIONIC_RELOAD_MAX_AGE_MS = 5 * 60 * 1000;
const BIONIC_PREFETCH_RADIUS = 3;
const BIONIC_PREFETCH_CACHE_LIMIT = 7;

// ── Themes ────────────────────────────────────────────────────────────────────
const THEMES = {
  dark:  { bg: '#111111', text: '#e0e0e0', link: '#e94560' },
  light: { bg: '#f9f9f6', text: '#1a1a1a', link: '#c73652' },
  sepia: { bg: '#f1e8d0', text: '#3e2e1a', link: '#8b4513' },
  sepiaDark: { bg: '#c4b090', text: '#2e2014', link: '#7a3a10' },
  midnight:  { bg: '#0f172a', text: '#e2e8f0', link: '#38bdf8' },
  nord:      { bg: '#2e3440', text: '#d8dee9', link: '#88c0d0' },
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
    shadow:     '0 2px 8px rgba(20,20,20,.08), 0 4px 24px rgba(20,20,20,.12), 0 8px 40px rgba(20,20,20,.08)',
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
    shadow:     '0 2px 8px rgba(60,40,20,.08), 0 4px 24px rgba(60,40,20,.12), 0 8px 40px rgba(60,40,20,.08)',
  },
  dark: {
    bg:         '#111111',
    surface:    '#1e1e1e',
    surface2:   '#2a2a2a',
    border:     'rgba(224,224,224,0.12)',
    text:       '#e0e0e0',
    textMuted:  '#909090',
    accent:     '#e94560',
    accentDark: '#c73652',
    shadow:     '0 2px 8px rgba(0,0,0,.3), 0 4px 24px rgba(0,0,0,.4), 0 8px 40px rgba(0,0,0,.25)',
  },
  sepiaDark: {
    bg:         '#c4b090',
    surface:    '#b8a480',
    surface2:   '#ac9870',
    border:     'rgba(46,32,20,0.15)',
    text:       '#2e2014',
    textMuted:  '#6a5040',
    accent:     '#7a3a10',
    accentDark: '#5e2c0a',
    shadow:     '0 2px 8px rgba(40,24,8,.12), 0 4px 24px rgba(40,24,8,.16), 0 8px 40px rgba(40,24,8,.10)',
  },
  midnight: {
    bg:         '#0f172a',
    surface:    '#1e293b',
    surface2:   '#334155',
    border:     'rgba(226,232,240,0.1)',
    text:       '#e2e8f0',
    textMuted:  '#94a3b8',
    accent:     '#38bdf8',
    accentDark: '#0ea5e9',
    shadow:     '0 2px 8px rgba(0,0,0,.4), 0 4px 24px rgba(0,0,0,.5), 0 8px 40px rgba(0,0,0,.35)',
  },
  nord: {
    bg:         '#2e3440',
    surface:    '#3b4252',
    surface2:   '#434c5e',
    border:     'rgba(216,222,233,0.1)',
    text:       '#d8dee9',
    textMuted:  '#9099ab',
    accent:     '#88c0d0',
    accentDark: '#5e81ac',
    shadow:     '0 2px 8px rgba(0,0,0,.25), 0 4px 24px rgba(0,0,0,.35), 0 8px 40px rgba(0,0,0,.22)',
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
  fontSize:         13,
  fontStyle:        'bold',   // 'normal' | 'bold' | 'italic' | 'bold italic'
  defaultPpm:       1.5,      // pages/min before speed samples exist
  positions: {
    tl: ['currentTime', 'pctBook'],
    tc: ['chapterTitle'],
    tr: ['timeLeftChap', 'timeLeftBook'],
    bl: ['chapterPage'],
    bc: ['pagesLeftChap', 'pagesLeftBook'],
    br: [],
  },
  separatorTop:          true,
  separatorBottom:       true,
  separatorThickness:    1,
  showIcons:        {},           // { [statId]: false } to hide icon; default = show all
  bookProgressBar:  { show: false, position: 'bottom', thickness: 3 },
  chapProgressBar:  { show: false, position: 'bottom', thickness: 2 },
};

// Stat definitions — id, icon, translated label (use function to get current lang)
function getStatusStats() {
  return [
    { id: 'chapterPage',   icon: '/images/chapter_page.svg',    label: t('reader.sb_chapter_page') },
    { id: 'bookPage',      icon: '/images/book_page.svg',       label: t('reader.sb_book_page') },
    { id: 'pagesLeftChap', icon: '/images/chapter_end.svg',     label: t('reader.sb_pages_left_chap') },
    { id: 'pagesLeftBook', icon: '/images/book_end.svg',        label: t('reader.sb_pages_left_book') },
    { id: 'pctChapter',    icon: '/images/chapter_progress.svg',label: t('reader.sb_pct_chap') },
    { id: 'pctBook',       icon: '/images/book_progress.svg',   label: t('reader.sb_pct_book') },
    { id: 'timeLeftChap',  icon: '/images/time_end_chapter.svg',label: t('reader.sb_time_left_chap') },
    { id: 'timeLeftBook',  icon: '/images/time_end_book.svg',   label: t('reader.sb_time_left_book') },
    { id: 'currentTime',   icon: '/images/time.svg',            label: t('reader.sb_current_time') },
    { id: 'bookTitle',     icon: '/images/book_title.svg',      label: t('reader.sb_book_title') },
    { id: 'bookAuthor',    icon: '/images/book_author.svg',     label: t('reader.sb_book_author') },
    { id: 'chapterTitle',  icon: '/images/chapter_title.svg',   label: t('reader.sb_chap_title') },
  ];
}

/** Build an <img> tag for a status-bar icon (SVG path → CSS class derived from filename). */
function sbIconHtml(iconSrc) {
  const base = iconSrc.replace('/images/', '').replace('.svg', '');
  const cls  = base.replace(/_/g, '-');
  return `<img src="${iconSrc}" class="nav-icon nav-icon-sb nav-icon-sb-${cls}" alt="">`;
}

/** Escape a string for safe use in HTML text content. */
function sbEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const DEFAULT_PREFS = {
  fontSize:       18,
  fontFamily:     'Georgia, serif',
  lineHeight:     1.6,
  letterSpacing:  0,            // extra letter spacing in tenths of px (0–100 → 0–10px)
  margin:         40,
  spread:         'auto',       // two-page default
  overrideStyles: true,
  theme:          'sepia',
  autoHideHeader: true,
  keepScreenOn:   true,
  eink:           false,        // strip all colors for e-ink displays
  paraIndent:     true,         // paragraph text-indent (first line)
  paraIndentSize: 15,           // indent size when paraIndent=true (em × 10, so 15 = 1.5em)
  paraSpacing:    0,            // extra bottom margin between paragraphs (em × 10, so 0–30)
  mouseWheelNav:  false,        // navigate pages with mouse wheel
  skipOpenProgressCheck: false, // if true, do not restore/sync progress on open
  skipSaveOnClose: false,       // if true, do not auto-save when leaving/closing
  chapHeadSpacing: true,        // override book heading margins to compact spacing
  disableJustify:  false,        // left-align text instead of justified
  hyphenation:    false,         // CSS hyphens: auto inside epub iframe
  hyphenLang:     '',           // empty = keep book's own lang attr; else override e.g. 'en'
  bionicReading:  false,        // emphasize word prefixes for easier scanning
  pageGapShadow:  false,        // show epub.js center-spine box-shadow in two-page mode
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
let lastSentChapterHref = null; // last chapter for which remote progress was pushed
let availableDicts  = null;  // cached GET /api/dictionary response
let pendingNavDirection = null; // 'next' or 'prev' tracking for chapter jump corrections
let pendingWasChapterEnd = true;  // whether goNext() was called from the last page
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
let bionicWordCache = new Map();      // per-word split cache
let bionicPageCache = new Map();      // location index cache window
let bionicPrefetchSeq = 0;
const bionicPrefetchInFlight = new Set();
let bookmarksCache = [];              // loaded bookmarks for current book
let preBookmarkCfi = null;            // position before a bookmark jump (for back/accept)
let annotationsCache = [];            // loaded annotations for current book
let _pendingAnnotation = null;        // {cfiRange, text} waiting for color/note pick
let _editingAnnotationId = null;      // id of annotation being edited in note editor
// Reading statistics tracking
let statsSessionId = null;            // active reading_sessions.id
let sessionPageCount = 0;             // page navigation events in current session

// ── Status bar state ──────────────────────────────────────────────────────────
let currentHref      = '';    // current spine href (updated in updateProgress)
let currentChapPage  = 0;     // current page within chapter (left page in two-page mode)
let currentEndPage   = 0;     // right-page number in two-page mode (0 in single-page)
let currentChapTotal = 0;     // total pages in current chapter
let currentIsTwoPage = false; // true when two pages are visible simultaneously
let chapPageCache    = {};    // { [spineIndex]: totalPages } accumulated as chapters are visited
let lastLocation     = null;  // last location object from updateProgress
// Reading speed tracking: each entry is a { time } recorded on every page turn
let speedSamples     = [];    // up to 25 recent samples

// Space reserved at the bottom of the rendition so the status bar never overlaps text.
// Must match the value used in book.renderTo() — kept here so all resize calls share it.
const RENDITION_BOTTOM_RESERVE = 18;

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
const searchAcceptBtn = document.getElementById('btn-search-accept');
const jumpPctPanel    = document.getElementById('jump-pct-panel');
const jumpPctSlider   = document.getElementById('jump-pct-slider');
const jumpPctValue    = document.getElementById('jump-pct-value');
const fullscreenBtn   = document.getElementById('btn-fullscreen');
const bookmarksSidebar = document.getElementById('bookmarks-sidebar');
const bookmarksListEl  = document.getElementById('bookmarks-list');
const bookmarksBadge   = document.getElementById('bookmarks-badge');
const bookmarkBackBtn  = document.getElementById('btn-bookmark-back');
const bookmarkAcceptBtn = document.getElementById('btn-bookmark-accept');

// ── Prefs ─────────────────────────────────────────────────────────────────────
// Keys that are stored per-book (content appearance).  All others are global.
const PER_BOOK_KEYS = ['fontSize','fontFamily','lineHeight','letterSpacing','margin','theme','overrideStyles','paraIndent','paraIndentSize','paraSpacing','dictionaries','bionicReading','skipOpenProgressCheck','skipSaveOnClose'];

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

function readBionicReloadState() {
  try {
    const raw = sessionStorage.getItem(BIONIC_RELOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.bookId !== bookId) return null;
    if ((Date.now() - Number(parsed.ts || 0)) > BIONIC_RELOAD_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeInterruptedSession() {
  if (!currentBook || !isReady || !currentCfi) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      bookId, title: currentBook.title, author: currentBook.author || '',
      pct: currentPct, cfi: currentCfi, ts: Date.now(),
    }));
  } catch { /* quota */ }
}

function clearInterruptedSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/** Called by library.js before navigating to the reader — tells reader to override restore position. */
function writeResumeState(bId, cfi, pct) {
  try {
    sessionStorage.setItem(RESUME_STATE_KEY, JSON.stringify({ bookId: bId, cfi, pct, ts: Date.now() }));
  } catch { /* quota */ }
}

function clearBionicReloadState() {
  try { sessionStorage.removeItem(BIONIC_RELOAD_KEY); } catch { /* ignore */ }
}

function saveBionicReloadState() {
  const loc = rendition?.currentLocation?.();
  const cfi = currentCfi || loc?.start?.cfi || '';
  const pct = (() => {
    if (book?.locations?.length?.() > 0 && cfi) {
      const p = book.locations.percentageFromCfi(cfi);
      if (p != null) return p;
    }
    if (loc?.start?.percentage != null) return loc.start.percentage;
    return currentPct || 0;
  })();
  try {
    sessionStorage.setItem(BIONIC_RELOAD_KEY, JSON.stringify({
      bookId,
      cfi,
      pct,
      bionicReading: !!prefs.bionicReading,
      ts: Date.now(),
    }));
  } catch { /* ignore */ }
}

function getLocationIndexFromCfi(cfi) {
  if (!cfi || !book?.locations?.length?.()) return null;
  const len = book.locations.length();
  if (!len) return null;
  const pct = book.locations.percentageFromCfi(cfi);
  if (pct == null) return null;
  const idx = Math.round(pct * Math.max(0, len - 1));
  return Math.min(len - 1, Math.max(0, idx));
}

function spineIndexFromCfi(cfi) {
  const m = String(cfi || '').match(/epubcfi\(\s*\/6\/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const idx = Math.floor(n / 2) - 1;
  return idx >= 0 ? idx : null;
}

function pruneBionicCaches(windowIndexes = null) {
  if (!prefs.bionicReading) {
    bionicPageCache.clear();
    bionicPrefetchInFlight.clear();
    return;
  }
  if (windowIndexes) {
    for (const k of Array.from(bionicPageCache.keys())) {
      if (!windowIndexes.has(k)) bionicPageCache.delete(k);
    }
    return;
  }
  while (bionicPageCache.size > BIONIC_PREFETCH_CACHE_LIMIT) {
    const firstKey = bionicPageCache.keys().next().value;
    bionicPageCache.delete(firstKey);
  }
}

function bionicFocusLength(len) {
  if (len === 0) return 0;
  if (len === 1) return 1;
  const focus = Math.ceil(len * 0.4) + (len < 5 ? 1 : 0);  
  return Math.min(focus, len - 1);
}

function splitBionicWord(word) {
  const cached = bionicWordCache.get(word);
  if (cached) return cached;
  const focus = Math.min(word.length, bionicFocusLength(word.length));
  const split = { lead: word.slice(0, focus), tail: word.slice(focus) };
  bionicWordCache.set(word, split);
  return split;
}

function isBionicWordCore(token) {
  return /^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u.test(token);
}

function splitTokenPunctuation(token) {
  const m = token.match(/^([^\p{L}\p{N}'’-]*)([\p{L}\p{N}'’-]+)([^\p{L}\p{N}'’-]*)$/u);
  if (!m) return { prefix: '', core: token, suffix: '' };
  return { prefix: m[1] || '', core: m[2] || '', suffix: m[3] || '' };
}

function appendBionicTextFragment(doc, fragment, text) {
  if (!text) return;
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/u.test(part)) {
      fragment.appendChild(doc.createTextNode(part));
      continue;
    }
    const { prefix, core, suffix } = splitTokenPunctuation(part);
    const coreLetters = core.replace(/[^\p{L}\p{N}]/gu, '');
    if (coreLetters.length < 3 || !isBionicWordCore(core)) {
      fragment.appendChild(doc.createTextNode(part));
      continue;
    }
    const { lead, tail } = splitBionicWord(core);
    if (prefix) fragment.appendChild(doc.createTextNode(prefix));
    const wrap = doc.createElement('span');
    wrap.className = 'br-bionic-word';
    const focus = doc.createElement('span');
    focus.className = 'br-bionic-focus';
    focus.textContent = lead;
    wrap.appendChild(focus);
    if (tail) wrap.appendChild(doc.createTextNode(tail));
    fragment.appendChild(wrap);
    if (suffix) fragment.appendChild(doc.createTextNode(suffix));
  }
}

function shouldSkipBionicNode(node) {
  if (!node?.parentElement) return true;
  if (!node.nodeValue || !node.nodeValue.trim()) return true;
  const parent = node.parentElement;
  if (parent.closest('script,style,pre,code,kbd,samp,math,ruby,rt,rp,textarea,select,option')) return true;
  if (parent.closest('.br-bionic-word,.br-hl')) return true;
  return false;
}

function collectBionicTextNodes(doc) {
  const out = [];
  if (!doc?.body) return out;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!shouldSkipBionicNode(node)) out.push(node);
    node = walker.nextNode();
  }
  return out;
}

function warmBionicWordCacheFromDocument(doc) {
  const nodes = collectBionicTextNodes(doc);
  nodes.forEach(node => {
    const parts = node.nodeValue.split(/(\s+)/);
    for (const part of parts) {
      if (!part || /^\s+$/u.test(part)) continue;
      const { core } = splitTokenPunctuation(part);
      if (core && isBionicWordCore(core) && core.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) {
        splitBionicWord(core);
      }
    }
  });
}

// Build a bionic-safe CFI by stripping text-node steps and char offsets.
// Handles both simple CFIs and range CFIs (epubcfi(base,start,end)).
// Range CFIs are converted to a simple CFI using base+start with offsets stripped.
function makeBionicSafeCfi(cfi) {
  if (!cfi) return cfi;
  // Range CFI: epubcfi(base,start,end)
  if (cfi.includes(',')) {
    const inner = cfi.slice(8, -1); // strip 'epubcfi(' and ')'
    const c1 = inner.indexOf(',');
    const c2 = inner.indexOf(',', c1 + 1);
    if (c1 !== -1 && c2 !== -1) {
      const base  = inner.slice(0, c1);
      let   start = inner.slice(c1 + 1, c2);
      start = start.replace(/:(\d+)$/, '');                                           // strip :charOffset
      start = start.replace(/\/(\d+)$/, (m, n) => parseInt(n) % 2 === 1 ? '' : m);   // strip odd (text-node) step
      console.log('[bionic] makeBionicSafeCfi: range CFI base:', base, 'start stripped to:', start);
      return `epubcfi(${base}${start})`;
    }
  }
  // Simple CFI
  const s1 = cfi.replace(/:(\d+)\)$/, ')');
  const s2 = s1.replace(/\/(\d+)\)$/, (m, n) => parseInt(n) % 2 === 1 ? ')' : m);
  return s2;
}

// Find a spine item for a given href, using direct lookup first then filename fuzzy match.
// Handles path-prefix mismatches (e.g. TOC has "OEBPS/Text/ch.xhtml" but spine stores "Text/ch.xhtml").
function findSpineItemForHref(href) {
  if (!href) return null;
  const base = href.split('#')[0];
  const direct = book.spine.get(base);
  if (direct) return direct;
  // Fuzzy: match by filename — handles OEBPS/ prefix mismatches and split chapters
  const fname = base.split('/').pop().toLowerCase();
  return (book.spine.spineItems || []).find(s =>
    (s.href || '').split('/').pop().toLowerCase() === fname ||
    (s.canonical || '').split('/').pop().toLowerCase() === fname
  ) || null;
}

function applyBionicToDocument(doc) {
  if (!prefs.bionicReading || !doc?.body) return;
  if (doc.documentElement?.dataset?.brBionicApplied === '1') {
    console.log('[bionic] applyBionicToDocument: already applied, skipping');
    return;
  }
  const nodes = collectBionicTextNodes(doc);
  console.log('[bionic] applyBionicToDocument: transforming', nodes.length, 'text nodes in', doc.location?.href || '(unknown)');
  nodes.forEach(node => {
    const frag = doc.createDocumentFragment();
    appendBionicTextFragment(doc, frag, node.nodeValue || '');
    node.parentNode?.replaceChild(frag, node);
  });
  if (doc.documentElement?.dataset) doc.documentElement.dataset.brBionicApplied = '1';
  console.log('[bionic] applyBionicToDocument: done');
}

function markBionicPageCached(location) {
  const cfi = location?.start?.cfi || currentCfi;
  const idx = getLocationIndexFromCfi(cfi);
  if (idx == null) return;
  bionicPageCache.delete(idx);
  bionicPageCache.set(idx, { ts: Date.now() });
}

function scheduleBionicPrefetchAround(location = null) {
  if (!prefs.bionicReading || !book?.locations?.length?.()) return;
  const currentLoc = location || rendition?.currentLocation?.();
  const idx = getLocationIndexFromCfi(currentLoc?.start?.cfi || currentCfi);
  if (idx == null) return;
  const len = book.locations.length();
  const wanted = [];
  for (let i = idx - BIONIC_PREFETCH_RADIUS; i <= idx + BIONIC_PREFETCH_RADIUS; i++) {
    if (i >= 0 && i < len) wanted.push(i);
  }
  const wantedSet = new Set(wanted);
  pruneBionicCaches(wantedSet);
  const seq = ++bionicPrefetchSeq;
  markBionicPageCached(currentLoc);
  wanted.forEach(pageIdx => {
    if (pageIdx === idx || bionicPageCache.has(pageIdx) || bionicPrefetchInFlight.has(pageIdx)) return;
    bionicPrefetchInFlight.add(pageIdx);
    queueMicrotask(async () => {
      try {
        if (seq !== bionicPrefetchSeq || !prefs.bionicReading || !book?.locations?.length?.()) return;
        const pct = (book.locations.length() <= 1) ? 0 : (pageIdx / (book.locations.length() - 1));
        const cfi = book.locations.cfiFromPercentage(Math.min(0.9999, Math.max(0, pct)));
        const spineIdx = spineIndexFromCfi(cfi);
        const item = (spineIdx != null) ? book.spine.get(spineIdx) : null;
        if (!item) return;
        await item.load(book.load.bind(book));
        if (item.document) warmBionicWordCacheFromDocument(item.document);
        item.unload();
        bionicPageCache.delete(pageIdx);
        bionicPageCache.set(pageIdx, { ts: Date.now(), href: item.href });
        pruneBionicCaches();
      } catch {
        /* ignore prefetch failures */
      } finally {
        bionicPrefetchInFlight.delete(pageIdx);
      }
    });
  });
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
  mix-blend-mode: multiply !important;
}
/* Keep native selection/callout enabled so iOS long-press and selection behave naturally. */
${prefs.eink ? buildEinkCss(theme) : ''}
${prefs.paraIndent ? `p { text-indent: ${(prefs.paraIndentSize / 10).toFixed(1)}em !important; }` : 'p { text-indent: 0 !important; }'}
${prefs.paraSpacing > 0 ? `p { margin-bottom: ${(prefs.paraSpacing / 10).toFixed(1)}em !important; }` : ''}
${prefs.letterSpacing > 0 ? `body, p, li, td, th, span { letter-spacing: ${(prefs.letterSpacing / 10).toFixed(1)}px !important; }` : ''}
${prefs.disableJustify
  ? 'body, p, li, td, th, blockquote { text-align: left !important; }'
  : 'body, p, li, td, th, blockquote { text-align: justify !important; }'}
${prefs.chapHeadSpacing ? `h1,h2,h3,h4,h5,h6 { margin: 0.2em 0 !important; padding: 0 !important; }
[class*="heading"],[class*="chapter-head"],[class*="chapterHead"],[class*="chapHead"],[class*="title-block"],[class*="titleBlock"] { height:auto !important; min-height:0 !important; padding-top:0 !important; padding-bottom:0 !important; margin-top:0 !important; margin-bottom:0 !important; }
div:has(>h1),div:has(>h2),div:has(>h3),div:has(>h4) { height:auto !important; min-height:0 !important; padding-top:0 !important; padding-bottom:0 !important; margin-top:0 !important; margin-bottom:0 !important; }` : ''}
${prefs.hyphenation ? 'html, body, p, li { hyphens: auto !important; }' : 'html, body, p, li { hyphens: none !important; }'}
/* annotation highlights — rendered as <mark> in the epub DOM */
mark.annot-hl { cursor: pointer; border-radius: 2px; color: inherit; padding: 0; }
mark.annot-yellow { background: rgba(255,204,0,.45); }
mark.annot-green  { background: rgba(0,210,110,.40); }
mark.annot-blue   { background: rgba(30,160,255,.40); }
mark.annot-pink   { background: rgba(255,80,130,.40); }
mark.annot-hl.has-note { text-decoration: underline; text-decoration-style: solid; text-decoration-thickness: 2px; }
/* search highlights — background only, zero layout impact */
mark.br-hl {
  background: rgba(255,200,0,.5) !important;
  color: inherit !important;
  padding: 0 !important; margin: 0 !important;
  border: none !important; border-radius: 0 !important;
  font: inherit !important; line-height: inherit !important;
  display: inline !important;
}
.br-bionic-word {
  font-weight: inherit !important;
}
.br-bionic-focus {
  font-weight: 700 !important;
}
`.trim();
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
  const newCss = buildEpubCss();
  if (!el) {
    el = doc.createElement('style');
    el.id = 'br-custom-styles';
    // Append to body END — comes after epub.js head styles, so our !important wins
    (doc.body || doc.documentElement).appendChild(el);
    el.textContent = newCss;
  } else if (el.textContent !== newCss) {
    // Only update when CSS actually changed — prevents a second ResizeObserver
    // cycle from the 'rendered' re-inject that fires after hooks.content.
    el.textContent = newCss;
  }
  if (prefs.bionicReading) {
    applyBionicToDocument(doc);
    markBionicPageCached(contents.location?.start ? { start: contents.location.start } : rendition?.currentLocation?.());
  }
  // No injected touch relay script needed. Touch handling is done by attachIframeDictionary and attachIframeTouchNav.
  injectAnnotationsIntoContents(contents);
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
  if (document.visibilityState === 'hidden')  writeInterruptedSession();
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
  const safeAreaFill = document.getElementById('safe-area-fill');

  if (prefs.eink) {
    document.documentElement.setAttribute('data-reader-eink', '');
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
    document.documentElement.style.setProperty('--reader-header-bg',          bg);
    document.documentElement.style.setProperty('--reader-header-border',      text);
    document.documentElement.style.setProperty('--reader-header-text',        text);
    document.documentElement.style.setProperty('--reader-header-text-muted',  text);
    if (safeAreaFill) safeAreaFill.style.background = bg;
    epubViewer.style.background = bg;
  } else {
    document.documentElement.removeAttribute('data-reader-eink');
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
    // document.documentElement.style.setProperty('--shadow',            ui.shadow);
    // --shadow is controlled by applyPageShadow() to respect the spine-shadow toggle
    // Header: translucent glass tinted to the page colour
    const headerBg    = hexToRgba(theme.bg,   0.6);
    const headerBdr   = hexToRgba(theme.text, 0.12);
    const headerMuted = hexToRgba(theme.text, 0.55);
    document.documentElement.style.setProperty('--reader-header-bg',          headerBg);
    document.documentElement.style.setProperty('--reader-header-border',      headerBdr);
    document.documentElement.style.setProperty('--reader-header-text',        theme.text);
    document.documentElement.style.setProperty('--reader-header-text-muted',  headerMuted);
    // Safe-area fill: solid (opaque) page colour so the translucent header doesn't leak through
    if (safeAreaFill) safeAreaFill.style.background = theme.bg;
    epubViewer.style.background = theme.bg;
  }
  applyPageShadow();
  // Tag body with current theme name so CSS can target per-theme overrides.
  document.body.dataset.readerTheme = prefs.theme;
  // SVGs loaded as <img> can't use currentColor — drive icon appearance via filter.
  // Dark themes need icons inverted (dark SVG → light); light/sepia themes need none.
  const needsIconInvert = ['dark', 'midnight', 'nord'].includes(prefs.theme);
  document.documentElement.style.setProperty('--nav-icon-filter', needsIconInvert ? 'brightness(0) invert(1)' : 'none');
}

/*
function applyPageShadow() {
  document.getElementById('page-edge-shadow')?.classList.toggle('active', !!prefs.pageGapShadow);
}*/

function applyPageShadow() {
  const on = !!prefs.pageGapShadow;
  document.body.classList.toggle('page-gap-shadow-on', on);
  const ui = THEME_UI[prefs.theme] || THEME_UI.dark;
  // Keep --shadow deterministic (avoid falling back to :root defaults from main.css).
  // But disable shadows entirely in e-ink mode.
  if (prefs.eink) {
    document.documentElement.style.setProperty('--shadow', 'none');
  } else {
    document.documentElement.style.setProperty('--shadow', ui.shadow);
  }
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

// Inject long-press (mobile) and right-click (desktop) dictionary lookup
// into each epub.js iframe page. Uses postMessage to ask the host to show the popup.
function attachIframeDictionary(contents) {
  if (!contents?.document || !contents?.window) return;
  const doc = contents.document;
  const win = contents.window;
  const coarsePointer = !!win.matchMedia?.('(pointer: coarse)')?.matches;
  let pressTimer = null, pressX = 0, pressY = 0, selectionTimer = null, lastSelectionWord = '', lastSelectionTs = 0;

  // iOS: suppress native callout and text-selection takeover inside epub iframes.
  if (isIOS) {
    const iosStyle = doc.createElement('style');
    iosStyle.textContent = '* { -webkit-touch-callout: none !important; -webkit-user-select: none !important; user-select: none !important; }';
    (doc.head || doc.documentElement).appendChild(iosStyle);
  }

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

  function getWordRangeAtPoint(x, y) {
    let node, offset;
    if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer; offset = r.startOffset;
    } else if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode; offset = p.offset;
    } else return null;
    if (node?.nodeType === 1) {
      const walker = doc.createTreeWalker(node, 0x4);
      const t = walker.nextNode();
      if (t) { node = t; offset = 0; }
    }
    if (!node || node.nodeType !== 3) return null;
    const text = node.textContent;
    let s = offset, e = offset;
    while (s > 0 && /[\p{L}\p{N}'\u2019\-]/u.test(text[s - 1])) s--;
    while (e < text.length && /[\p{L}\p{N}'\u2019\-]/u.test(text[e])) e++;
    const word = text.slice(s, e).replace(/^['\u2019\-]+|['\u2019\-]+$/g, '').trim();
    if (!word) return null;
    try {
      const range = doc.createRange();
      range.setStart(node, s);
      range.setEnd(node, e);
      return { word, range };
    } catch { return null; }
  }

  function triggerSelectionLookup() {
    const sel = win.getSelection?.();
    const raw = (sel?.toString() || '').trim();
    if (!raw) return;
    const word = raw.split(/\s+/)[0].replace(/^['\u2019\-]+|['\u2019\-]+$/g, '').trim();
    if (!word) return;
    const now = Date.now();
    if (word === lastSelectionWord && now - lastSelectionTs < 900) return;
    lastSelectionWord = word;
    lastSelectionTs = now;
    window.parent.postMessage({ type: 'dict-lookup', word }, '*');
  }

  doc.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    pressX = t.clientX;
    pressY = t.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressNextTap = true;
      const result = getWordRangeAtPoint(pressX, pressY);
      if (!result) return;
      const { word, range } = result;
      win.getSelection?.()?.removeAllRanges?.();
      let cfiRange = '';
      if (prefs.bionicReading) {
        // Bionic DOM shifts CFI paths — generate a clean CFI from the pre-bionic structure
        cfiRange = cfiFromBionicRange(range, doc, contents) || '';
      } else {
        try { cfiRange = contents.cfiFromRange(range); } catch {}
      }
      if (cfiRange) {
        window.parent.postMessage({ type: 'annotation-select', cfiRange, text: word }, '*');
      } else {
        window.parent.postMessage({ type: 'dict-lookup', word }, '*');
      }
    }, 450);
  }, { passive: true });

  doc.addEventListener('touchmove', (e) => {
    if (Math.abs(e.touches[0].clientX - pressX) > 18 || Math.abs(e.touches[0].clientY - pressY) > 18) {
      clearTimeout(pressTimer); pressTimer = null;
    }
  }, { passive: true });

  doc.addEventListener('touchend', () => {
    if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
  }, { passive: true });

  doc.addEventListener('touchcancel', () => { clearTimeout(pressTimer); pressTimer = null; }, { passive: true });

  if (coarsePointer && !isIOS) {
    doc.addEventListener('selectionchange', () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(triggerSelectionLookup, 120);
    });
  }

  doc.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel     = win.getSelection?.();
    const selText = sel?.toString().trim();
    const word    = selText ? selText.split(/\s+/)[0] : getWordAtPoint(e.clientX, e.clientY);
    if (word) window.parent.postMessage({ type: 'dict-lookup', word }, '*');
  });

  if (!coarsePointer) {
    doc.addEventListener('dblclick', (e) => {
      const sel = win.getSelection?.();
      const selText = sel?.toString().trim();
      const word = selText ? selText.split(/\s+/)[0] : getWordAtPoint(e.clientX, e.clientY);
      if (word) window.parent.postMessage({ type: 'dict-lookup', word }, '*');
    });
  }
}

// Detect whether an <a> element inside the epub iframe is a footnote/endnote reference.
// Pure function — runs in the iframe context, no epub.js API needed.
function isFootnoteLink(anchor) {
  const rawHref = anchor.dataset?.footnoteHref || anchor.dataset?.brLinkHref || anchor.getAttribute('href') || '';
  if (!rawHref.includes('#')) return false;

  // EPUB3 explicit attributes
  const epubType = (anchor.getAttribute('epub:type') ||
    anchor.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || '').toLowerCase();
  const role = (anchor.getAttribute('role') || '').toLowerCase();
  if (epubType.includes('noteref') || role.includes('doc-noteref')) return true;

  // Parent is <sup> — common pattern
  if (anchor.parentElement?.tagName === 'SUP') return true;

  // Anchor CONTAINS a <sup> — e.g. <a href="notes.html#fn"><sup>1</sup></a>
  if (anchor.querySelector('sup')) return true;

  // Class hint on anchor or its parent
  const cls = ((anchor.className || '') + ' ' + (anchor.parentElement?.className || '')).toLowerCase();
  if (/\b(foot|fn|note|ref)\b/.test(cls)) return true;

  // Inspect target element
  const fragId = rawHref.split('#').pop();
  if (fragId) {
    const target = anchor.ownerDocument.getElementById(fragId);
    if (target) {
      const tt = (target.getAttribute('epub:type') ||
        target.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || '').toLowerCase();
      const tr = (target.getAttribute('role') || '').toLowerCase();
      if (/footnote|endnote/.test(tt) || /doc-footnote|doc-endnote/.test(tr)) return true;
      if (target.tagName === 'ASIDE') return true;
    }
  }
  return false;
}

// Inject footnote-link click interception into each epub.js iframe page.
// Uses capture phase so we intercept before epub.js handles the click.
function attachIframeFootnotes(contents) {
  if (!contents?.document) return;
  const doc = contents.document;

  // Remove href from footnote links so desktop browsers don't show URLs on hover.
  // Keep original target in data-footnote-href and preserve keyboard focusability.
  doc.querySelectorAll('a').forEach((anchor) => {
    if (!isFootnoteLink(anchor)) return;
    const rawHref = anchor.dataset?.brLinkHref || anchor.getAttribute('href') || '';
    if (!rawHref) return;
    anchor.dataset.footnoteHref = rawHref;
    anchor.removeAttribute('href');
    anchor.setAttribute('role', 'button');
    anchor.setAttribute('tabindex', '0');
    anchor.style.cursor = 'pointer';
  });

  const openFootnote = (anchor, e) => {
    const rawHref = anchor.dataset.footnoteHref || anchor.dataset.brLinkHref || anchor.getAttribute('href') || '';
    if (!rawHref.includes('#')) return;
    e.preventDefault();
    e.stopPropagation();
    const sameDoc = rawHref.startsWith('#');
    const fragId  = rawHref.split('#').pop();
    window.parent.postMessage({ type: 'footnote-show', rawHref, fragId, sameDoc }, '*');
  };

  doc.addEventListener('click', (e) => {
    const anchor = e.target.closest('a[data-footnote-href], a[href]');
    if (!anchor) return;
    if (!anchor.dataset.footnoteHref && !isFootnoteLink(anchor)) return;
    openFootnote(anchor, e);
  }, { capture: true });

  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const anchor = e.target?.closest?.('a[data-footnote-href]');
    if (!anchor) return;
    openFootnote(anchor, e);
  }, { capture: true });
}

// Strip epub backlinks and dangerous content from a cloned footnote element.
// Returns innerHTML string, or null if nothing meaningful remains.
function _sanitizeFootnoteHtml(el) {
  const clone = el.cloneNode(true);
  // Remove semantic backlinks
  clone.querySelectorAll('[epub\\:type="backlink"], [role="doc-backlink"]').forEach(n => n.remove());
  // Remove bare back-arrow anchors
  clone.querySelectorAll('a').forEach(a => {
    if (/^[↩↑\^⬆←▲🔙]$/.test(a.textContent.trim())) a.remove();
  });
  // Remove scripts and on* attributes
  clone.querySelectorAll('script').forEach(n => n.remove());
  clone.querySelectorAll('*').forEach(n => {
    for (const attr of [...n.attributes]) {
      if (attr.name.startsWith('on')) n.removeAttribute(attr.name);
    }
  });
  const html = clone.innerHTML.trim();
  return html || null;
}

async function showFootnotePopup(fragId, crossDocHref) {
  let targetEl = null;
  if (!crossDocHref) {
    const view = rendition?.manager?.views?.first?.();
    targetEl = view?.document?.getElementById(fragId) ?? null;
  } else {
    // spine.get() breaks when href contains '#' (it switches to getById).
    // Strip fragment, then resolve relative path against current section.
    const crossPath = crossDocHref.split('#')[0];
    let spineItem = book?.spine?.get(crossPath);
    if (!spineItem) {
      const curHref = rendition?.currentLocation()?.start?.href || '';
      const base = curHref.substring(0, curHref.lastIndexOf('/') + 1);
      spineItem = book?.spine?.get(base + crossPath);
    }
    if (!spineItem) {
      const basename = crossPath.split('/').pop();
      spineItem = book?.spine?.items?.find(item =>
        item.href === basename || (item.href || '').endsWith('/' + basename)
      ) ?? null;
    }
    if (spineItem) {
      try {
        await spineItem.load(book.load.bind(book));
        targetEl = spineItem.document?.getElementById(fragId) ?? null;
        spineItem.unload();
      } catch { targetEl = null; }
    }
  }
  if (!targetEl) return;

  // If the id lands on an inline element (e.g. a backlink <a>), use the nearest block ancestor
  const BLOCK_TAGS = new Set(['P','DIV','LI','SECTION','ASIDE','BLOCKQUOTE','DD','DT','ARTICLE']);
  if (!BLOCK_TAGS.has(targetEl.tagName)) {
    const blockParent = targetEl.closest('p,li,div,section,aside,blockquote,dd,dt,article');
    if (blockParent) targetEl = blockParent;
  }

  const html = _sanitizeFootnoteHtml(targetEl);
  if (!html) return;

  const popup   = document.getElementById('footnote-popup');
  const content = document.getElementById('footnote-popup-content');
  if (!popup || !content) return;

  content.innerHTML = html;
  // Sanitize links in the rendered content
  content.querySelectorAll('a[href]').forEach(a => {
    const h = a.getAttribute('href') || '';
    if (h.startsWith('http://') || h.startsWith('https://')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      a.replaceWith(document.createTextNode(a.textContent));
    }
  });
  popup.classList.add('open');
  document.getElementById('footnote-backdrop')?.classList.add('open');
}

function closeFootnotePopup() {
  document.getElementById('footnote-popup')?.classList.remove('open');
  document.getElementById('footnote-backdrop')?.classList.remove('open');
}

// ── Annotations ───────────────────────────────────────────────────────────────

function attachIframeAnnotation(contents) {
  if (!contents?.document) return;
  const doc = contents.document;
  function onSelectionEnd(e) {
    if (e?.button !== undefined && e.button !== 0) return; // ignore right/middle clicks
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const text = sel.toString().trim();
    if (text.length < 2) return;
    let cfiRange;
    if (prefs.bionicReading) {
      cfiRange = cfiFromBionicRange(sel.getRangeAt(0), doc, contents);
    } else {
      try { cfiRange = contents.cfiFromRange(sel.getRangeAt(0)); } catch { return; }
    }
    if (!cfiRange) return;
    window.parent.postMessage({ type: 'annotation-select', cfiRange, text }, '*');
  }
  doc.addEventListener('mouseup', onSelectionEnd);
  doc.addEventListener('touchend', () => setTimeout(() => onSelectionEnd(), 50));
}

// Generate a CFI compatible with the non-bionic DOM, even when bionic is currently active.
// Bionic wraps word prefixes in <span.br-bionic-word> elements, changing the DOM tree but
// not the text content. We temporarily unwrap those spans to get the "original" node structure,
// generate the CFI, then restore the block's innerHTML.
function cfiFromBionicRange(range, doc, contents) {
  // Walk up to the nearest ancestor that is not itself a bionic span
  let block = range.commonAncestorContainer;
  if (block.nodeType !== 1) block = block.parentNode;
  while (block && block !== doc.body) {
    if (!block.classList?.contains('br-bionic-word') && !block.classList?.contains('br-bionic-focus')) break;
    block = block.parentNode;
  }
  if (!block || block === doc.documentElement) return null;

  // Compute char offsets within the block — text content is the same in bionic and clean DOM
  let startChar, endChar;
  try {
    const r1 = doc.createRange();
    r1.setStart(block, 0);
    r1.setEnd(range.startContainer, range.startOffset);
    startChar = r1.toString().length;
    const r2 = doc.createRange();
    r2.setStart(block, 0);
    r2.setEnd(range.endContainer, range.endOffset);
    endChar = r2.toString().length;
  } catch { return null; }

  // Snapshot HTML before modification (preserves existing annotation <mark>s and bionic spans)
  const savedHTML = block.innerHTML;

  // Replace every bionic word-span with a plain text node of its text content
  Array.from(block.querySelectorAll('.br-bionic-word')).forEach(span => {
    span.parentNode.replaceChild(doc.createTextNode(span.textContent), span);
  });
  block.normalize(); // merge adjacent text nodes → reproduces original node structure

  // Rebuild the selection range at the same char offsets in the now-clean block
  let cfi = null;
  try {
    const walker = doc.createTreeWalker(block, 0x4 /* SHOW_TEXT */);
    let pos = 0, sn = null, so = 0, en = null, eo = 0, node;
    while ((node = walker.nextNode())) {
      const len = node.length;
      if (!sn && pos + len > startChar) { sn = node; so = startChar - pos; }
      if (sn && pos + len >= endChar)   { en = node; eo = endChar   - pos; break; }
      pos += len;
    }
    if (sn && en) {
      const cleanRange = doc.createRange();
      cleanRange.setStart(sn, so);
      cleanRange.setEnd(en, eo);
      cfi = contents.cfiFromRange(cleanRange);
    }
  } catch { /* ignore */ }

  // Restore original markup (bionic spans + any pre-existing annotation marks)
  block.innerHTML = savedHTML;

  // innerHTML restore kills event listeners — re-attach click handlers to existing marks
  block.querySelectorAll('mark[data-annot-id]').forEach(mark => {
    const id = parseInt(mark.dataset.annotId);
    if (!id) return;
    mark.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      window.parent.postMessage({ type: 'annotation-click', id }, '*');
    }, { capture: true });
  });

  return cfi;
}

// Find the first occurrence of text in the page by walking text nodes.
// Used as a CFI fallback when bionic mode causes CFI path mismatches.
function findTextRangeInPage(doc, text) {
  if (!text || !doc.body) return null;
  const bodyText = doc.body.textContent;
  const idx = bodyText.indexOf(text);
  if (idx < 0) return null;
  const end = idx + text.length;
  const walker = doc.createTreeWalker(doc.body, 0x4 /* SHOW_TEXT */);
  let pos = 0, sn = null, so = 0, en = null, eo = 0, node;
  while ((node = walker.nextNode())) {
    const len = node.length;
    if (!sn && pos + len > idx)  { sn = node; so = idx - pos; }
    if (sn && pos + len >= end)  { en = node; eo = end - pos; break; }
    pos += len;
  }
  if (!sn || !en) return null;
  try {
    const r = doc.createRange();
    r.setStart(sn, so);
    r.setEnd(en, eo);
    return r;
  } catch { return null; }
}

function showAnnotationToolbar(cfiRange, text) {
  _pendingAnnotation = { cfiRange, text };
  document.getElementById('annot-toolbar')?.classList.add('open');
  document.getElementById('annot-backdrop')?.classList.add('open');
}

function closeAnnotationToolbar() {
  _pendingAnnotation = null;
  document.getElementById('annot-toolbar')?.classList.remove('open');
  document.getElementById('annot-backdrop')?.classList.remove('open');
}

function showAnnotationNoteEditor(annotationId, existingNote) {
  _editingAnnotationId = annotationId;
  const ta = document.getElementById('annot-note-text');
  if (ta) ta.value = existingNote || '';
  document.getElementById('annot-note-editor')?.classList.add('open');
  document.getElementById('annot-backdrop')?.classList.add('open');
  ta?.focus();
}

function closeAnnotationNoteEditor() {
  _editingAnnotationId = null;
  document.getElementById('annot-note-editor')?.classList.remove('open');
  document.getElementById('annot-backdrop')?.classList.remove('open');
}

// Inject <mark> elements for all cached annotations that belong to this contents view.
// Called from injectIntoContents on every page render.
function injectAnnotationsIntoContents(contents) {
  if (!contents?.document || !annotationsCache.length) return;
  const doc = contents.document;
  annotationsCache.forEach(a => {
    if (doc.querySelector(`mark[data-annot-id="${a.id}"]`)) return; // already injected
    try {
      // Resolve CFI to a range; verify it matched the expected text to detect bionic mismatch
      let range = null;
      try { range = contents.range(a.cfi); } catch { /* not on this page */ }
      if (range && a.text) {
        const resolved = range.toString().replace(/\s+/g, ' ').trim();
        const expected = a.text.replace(/\s+/g, ' ').trim();
        if (resolved !== expected) range = null; // bionic/non-bionic mode mismatch
      }
      // Fall back to text search within the page (handles bionic ↔ non-bionic CFI mismatches)
      if (!range && a.text) range = findTextRangeInPage(doc, a.text);
      if (!range) return;

      const mark = doc.createElement('mark');
      mark.className = 'annot-hl annot-' + a.color + (a.note ? ' has-note' : '');
      mark.dataset.annotId = String(a.id);
      mark.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.parent.postMessage({ type: 'annotation-click', id: a.id }, '*');
      }, { capture: true });
      try {
        range.surroundContents(mark);
      } catch {
        // Selection spans element boundary — use extractContents to preserve nesting
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
      }
    } catch { /* annotation not on this page, or CFI parse error — skip silently */ }
  });
}

// Re-apply annotation marks into all currently loaded views (e.g. after loadAnnotations)
function reapplyAnnotations() {
  try {
    const contents = rendition?.getContents?.();
    if (contents?.length) { contents.forEach(injectAnnotationsIntoContents); return; }
  } catch { /* fall through */ }
  try {
    rendition?.manager?.views?.forEach?.(view => {
      if (view?.contents) injectAnnotationsIntoContents(view.contents);
    });
  } catch { /* ignore */ }
}

// Remove <mark> wrappers for a deleted annotation from all loaded views
function removeAnnotationFromDom(id) {
  try {
    const contents = rendition?.getContents?.() || [];
    contents.forEach(c => {
      c.document?.querySelectorAll(`mark[data-annot-id="${id}"]`).forEach(m => {
        while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
        m.remove();
      });
    });
  } catch { /* ignore */ }
  try {
    rendition?.manager?.views?.forEach?.(view => {
      view?.contents?.document?.querySelectorAll(`mark[data-annot-id="${id}"]`).forEach(m => {
        while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
        m.remove();
      });
    });
  } catch { /* ignore */ }
}

function showAnnotationEditSheet(a) {
  const sheet = document.getElementById('annot-edit-sheet');
  if (!sheet) return;
  sheet.dataset.annotId = a.id;
  // Highlight active color button
  sheet.querySelectorAll('.annot-edit-color-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === a.color);
  });
  const noteEl = sheet.querySelector('.annot-edit-note-preview');
  if (noteEl) noteEl.textContent = a.note || '';
  sheet.classList.add('open');
  document.getElementById('annot-backdrop')?.classList.add('open');
}

function closeAnnotationEditSheet() {
  document.getElementById('annot-edit-sheet')?.classList.remove('open');
  document.getElementById('annot-backdrop')?.classList.remove('open');
}

async function createAnnotation(cfiRange, text, color, note) {
  if (!currentBook) return;
  try {
    const a = await apiFetch(`/annotations/${currentBook.id}`, {
      method: 'POST',
      body: JSON.stringify({ cfi: cfiRange, pct: currentPct || 0, color, note: note || '', text }),
    });
    annotationsCache.push(a);
    reapplyAnnotations();
    renderAnnotationList();
    toast(t('reader.annotation_added'));
  } catch {
    /* silent */
  }
}

async function updateAnnotation(id, updates) {
  if (!currentBook) return;
  const a = annotationsCache.find(x => x.id === id);
  if (!a) return;
  try {
    await apiFetch(`/annotations/${currentBook.id}/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
    Object.assign(a, updates);
    // Update mark classes in DOM
    try {
      const contents = rendition?.getContents?.() || [];
      contents.forEach(c => {
        c.document?.querySelectorAll(`mark[data-annot-id="${id}"]`).forEach(m => {
          m.className = 'annot-hl annot-' + a.color + (a.note ? ' has-note' : '');
        });
      });
    } catch { /* ignore */ }
    renderAnnotationList();
  } catch {
    /* silent */
  }
}

async function deleteAnnotation(id) {
  if (!currentBook) return;
  try {
    await apiFetch(`/annotations/${currentBook.id}/${id}`, { method: 'DELETE' });
    annotationsCache = annotationsCache.filter(x => x.id !== id);
    removeAnnotationFromDom(id);
    renderAnnotationList();
    toast(t('reader.annotation_deleted'));
  } catch {
    /* silent */
  }
}

async function loadAnnotations(bookId) {
  try {
    annotationsCache = await apiFetch(`/annotations/${bookId}`);
    reapplyAnnotations();
    renderAnnotationList();
  } catch {
    annotationsCache = [];
  }
}

function renderAnnotationList() {
  const listEl = document.getElementById('annotations-list');
  if (!listEl) return;
  if (!annotationsCache.length) {
    listEl.innerHTML = `<div class="annotations-empty">${t('reader.annotations_empty')}</div>`;
    return;
  }
  listEl.innerHTML = '';
  [...annotationsCache].sort((a, b) => a.pct - b.pct).forEach(a => {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    const excerpt = a.text || '';
    const excerptShort = excerpt.slice(0, 80) + (excerpt.length > 80 ? '…' : '');
    const noteText = a.note || '';
    const noteShort = noteText.slice(0, 60) + (noteText.length > 60 ? '…' : '');
    item.innerHTML = `
      <div class="annotation-item-body">
        <span class="annotation-color-dot" style="background:var(--annot-dot-${escapeHtml(a.color)})"></span>
        <div class="annotation-item-text">
          <div class="annotation-item-excerpt">${escapeHtml(excerptShort)}</div>
          ${noteText ? `<div class="annotation-item-note">${escapeHtml(noteShort)}</div>` : ''}
          <div class="annotation-item-pct">${Math.round((a.pct || 0) * 100)}%</div>
        </div>
      </div>
      <button class="annotation-delete-btn btn-icon-sm" title="${t('reader.annotation_delete')}">🗑</button>`;
    item.querySelector('.annotation-item-body').addEventListener('click', () => {
      closePanels();
      rendition?.display(a.cfi).catch(() => {});
    });
    item.querySelector('.annotation-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteAnnotation(a.id);
    });
    listEl.appendChild(item);
  });
}

function openAnnotations() {
  const sidebar = document.getElementById('annotations-sidebar');
  if (!sidebar) return;
  sidebar.classList.add('open');
  tocSidebar.classList.remove('open');
  settingsPanel.classList.remove('open');
  bookmarksSidebar.classList.remove('open');
  panelBackdrop.classList.add('visible');
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
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
    const val      = computeStatValue(id);
    if (!val) return '';
    const iconSrc  = STAT_ICON[id];
    const showIcon = prefs.statusBar.showIcons[id] !== false;   // default true
    const prefix   = (iconSrc && showIcon) ? sbIconHtml(iconSrc) + '\u202F' : '';
    return prefix + sbEsc(val);
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
  currentChapPage  = startPage;
  currentEndPage   = endPage;
  currentChapTotal = stableTotal || totalPages;
  currentIsTwoPage = isTwoPage;
  if (stableTotal > 0) chapPageCache[currentSpineIndex] = stableTotal;

  const pos = prefs.statusBar.positions;
  // In two-page mode, chapterPage is always placed at the outermost slots
  // (tl/tr for top, bl/br for bottom), honouring only the row (top vs bottom)
  // from the configured position and ignoring left/center/right.
  const chapInTop    = isTwoPage && (pos.tl.includes('chapterPage') || pos.tc.includes('chapterPage') || pos.tr.includes('chapterPage'));
  const chapInBottom = isTwoPage && (pos.bl.includes('chapterPage') || pos.bc.includes('chapterPage') || pos.br.includes('chapterPage'));

  // Pre-build chapter page strings (used for both top & bottom if needed)
  const cpIconSrc = STAT_ICON['chapterPage'];
  const cpImg     = (cpIconSrc && prefs.statusBar.showIcons['chapterPage'] !== false)
                    ? sbIconHtml(cpIconSrc) + '\u202F' : '';
  const leftVal   = startPage > 0 ? cpImg + startPage + '/' + stableTotal : '';
  const rightVal  = endPage   > 0 ? cpImg + endPage   + '/' + stableTotal : '';

  // ── Top row ──────────────────────────────────────────────────────────────
  if (chapInTop) {
    const tlOther = computeSlot(pos.tl.filter(id => id !== 'chapterPage'));
    const tcSlot  = computeSlot(pos.tc.filter(id => id !== 'chapterPage'));
    const trOther = computeSlot(pos.tr.filter(id => id !== 'chapterPage'));
    sbTl.innerHTML = [leftVal,  tlOther].filter(Boolean).join('  |  ');
    sbTc.innerHTML = tcSlot;
    sbTr.innerHTML = [trOther, rightVal].filter(Boolean).join('  |  ');
  } else {
    sbTl.innerHTML = computeSlot(pos.tl);
    sbTc.innerHTML = computeSlot(pos.tc);
    sbTr.innerHTML = computeSlot(pos.tr);
  }

  // ── Bottom row ───────────────────────────────────────────────────────────
  if (chapInBottom) {
    sbBottom.classList.add('two-page');
    const blOther = computeSlot(pos.bl.filter(id => id !== 'chapterPage'));
    const bcSlot  = computeSlot(pos.bc.filter(id => id !== 'chapterPage'));
    const brOther = computeSlot(pos.br.filter(id => id !== 'chapterPage'));
    sbBl.innerHTML = [leftVal,  blOther].filter(Boolean).join('  |  ');
    sbBc.innerHTML = bcSlot;
    sbBr.innerHTML = [brOther, rightVal].filter(Boolean).join('  |  ');
  } else {
    sbBottom.classList.remove('two-page');
    sbBl.innerHTML = computeSlot(pos.bl);
    sbBc.innerHTML = computeSlot(pos.bc);
    sbBr.innerHTML = computeSlot(pos.br);
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
    if (ids.includes('currentTime')) el.innerHTML = computeSlot(ids);
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
      rendition.resize(epubViewer.clientWidth, Math.max(200, epubViewer.clientHeight - RENDITION_BOTTOM_RESERVE));
    }, 30);
  }
}

// Apply CSS variables for status bar font/size/style
function resolveStatusBarFont(fontName) {
  if (!fontName) return '';
  const allFonts = [...SYSTEM_FONTS, ...customFonts];
  const match = allFonts.find(f => f.value === fontName || f.label === fontName);
  if (match) return match.value;
  if (fontName.includes(',') || fontName.includes('"') || fontName.includes("'")) return fontName;
  if (/\s/.test(fontName)) return `"${fontName}"`;
  return fontName;
}

function applyStatusBarStyles() {
  const sb   = prefs.statusBar;
  const root = document.documentElement;
  const inheritedFont = prefs.fontFamily || 'inherit';
  const selectedFont = sb.font ? resolveStatusBarFont(sb.font) : inheritedFont;
  const fontValue = selectedFont === 'inherit' ? 'inherit' : selectedFont;
  root.style.setProperty('--sb-font', fontValue);
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
    sbBookProg.style.bottom  = bookCfg.position === 'bottom' ? 'calc(env(safe-area-inset-bottom, 0px) + var(--edge-pad-bottom, 0px))' : 'auto';
  }

  if (sbChapProg) {
    sbChapProg.style.display = chapCfg.show ? '' : 'none';
    sbChapProg.style.height  = chapCfg.thickness + 'px';
    const edgeVar   = chapCfg.position === 'top' ? 'var(--edge-pad-top, 0px)' : 'calc(env(safe-area-inset-bottom, 0px) + var(--edge-pad-bottom, 0px))';
    const chapOffset = bothSame
      ? `calc(${edgeVar} + ${bookCfg.thickness + 1}px)`
      : edgeVar;
    sbChapProg.style.top     = chapCfg.position === 'top'    ? chapOffset : 'auto';
    sbChapProg.style.bottom  = chapCfg.position === 'bottom' ? chapOffset : 'auto';
  }

  updateBookProgressBar();
  updateChapProgressBar();
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

// Build hairline chapter markers on the jump-to-% slider.
// Called after TOC and/or locations are available; safe to call multiple times.
function buildChapterMarkers() {
  const container = document.getElementById('sb-chap-markers');
  if (!container) return;
  container.innerHTML = '';
  // Only top-level TOC entries (depth 0) — no need to mark every sub-section
  const topLevel = tocFlatItems.filter(t => t.depth === 0);
  if (topLevel.length < 2) return;
  const spineItems = book?.spine?.spineItems || [];
  const spineTotal = spineItems.length || 1;

  topLevel.forEach(({ href }, i) => {
    if (i === 0) return; // first chapter starts at 0% — no marker needed
    const hrefBase = (href || '').split('#')[0];
    let pct = null;

    // Prefer accurate percentage from epub.js locations table
    if (book?.locations?.length() > 0) {
      const spineItem = book.spine.get(hrefBase);
      if (spineItem?.cfiBase) {
        pct = book.locations.percentageFromCfi(`epubcfi(${spineItem.cfiBase}!/4/1:0)`);
      }
    }
    // Fallback: spine-index ratio (no locations needed)
    if (pct == null) {
      const idx = spineItems.findIndex(s => {
        const sh = (s.href || '').split('#')[0];
        return sh === hrefBase || sh.endsWith('/' + hrefBase.split('/').pop());
      });
      if (idx > 0) pct = idx / spineTotal;
    }

    if (pct == null || pct <= 0.001 || pct >= 0.999) return;
    const marker = document.createElement('div');
    marker.className = 'sb-chap-marker';
    marker.style.left = (pct * 100).toFixed(2) + '%';
    container.appendChild(marker);
  });
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
      rendition.resize(epubViewer.clientWidth, Math.max(200, epubViewer.clientHeight - RENDITION_BOTTOM_RESERVE));
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
// Track whether the mouse is currently inside the header bar
let isMouseOverHeader = false;
document.querySelector('.reader-header').addEventListener('mouseenter', () => { isMouseOverHeader = true; });
// Hide header as soon as mouse leaves the header bar itself
document.querySelector('.reader-header').addEventListener('mouseleave', () => {
  isMouseOverHeader = false;
  if (!prefs.autoHideHeader) return;
  if (!tocSidebar.classList.contains('open') && jumpPctPanel.style.display === 'none') {
    readerLayout.classList.remove('header-peek');
  }
});

// ── TOC ───────────────────────────────────────────────────────────────────────
function buildTocRecursive(toc, depth, fragment) {
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
        // Resolve via spine — findSpineItemForHref handles path-prefix mismatches
        const spineItem = findSpineItemForHref(hrefBase);
        // For chapter-level entries (depth <= 1), use spineItem.href without anchor so
        // epub.js navigates to the start of the chapter file. display(spineIndex) would
        // restore the last-cached position (which can be mid-chapter from a previous visit),
        // while display(href) without a fragment always goes to the beginning.
        // Sub-section entries (depth > 1) keep their anchors for precise positioning.
        const displayTarget = spineItem?.index != null
          ? (anchor && depth > 1 ? `${spineItem.href}#${anchor}` : spineItem.href)
          : item.href;
        console.log(`[nav] TOC | depth=${depth} anchor="${anchor||''}" target=${JSON.stringify(displayTarget)}`);
        try {
          await rendition.display(displayTarget);
          const loc = rendition?.currentLocation?.();
          console.log(`[nav] TOC-landed | page=${loc?.start?.displayed?.page}/${loc?.start?.displayed?.total} href="${loc?.start?.href?.split('/').pop()}"`);
          scheduleBionicPrefetchAround(loc);
        } catch (e) {
          // Last-resort: if primary href failed, try raw TOC href
          if (item.href && displayTarget !== item.href) {
            try {
              await rendition.display(item.href);
              const loc = rendition?.currentLocation?.();
              console.log(`[nav] TOC-landed | page=${loc?.start?.displayed?.page}/${loc?.start?.displayed?.total} href="${loc?.start?.href?.split('/').pop()}"`);
              scheduleBionicPrefetchAround(loc);
            } catch (e2) {}
          }
        }
      }, 80);
    });

    fragment.appendChild(btn);
    tocFlatItems.push({ label: item.label, href: item.href, depth, button: btn });
    if (item.subitems?.length) buildTocRecursive(item.subitems, depth + 1, fragment);
  });
}

function buildToc(toc) {
  tocFlatItems = [];
  tocListEl.classList.add('is-building');
  tocListEl.innerHTML = '';

  const fragment = document.createDocumentFragment();
  buildTocRecursive(toc, 0, fragment);
  tocListEl.appendChild(fragment);

  // Reveal only after full list is in DOM to avoid visible style churn.
  requestAnimationFrame(() => {
    tocListEl.classList.remove('is-building');
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
  const centerActiveTocItem = () => {
    const active = tocListEl.querySelector('.toc-item.active');
    if (!active) return false;
    const itemTop = active.offsetTop;
    const itemHeight = active.offsetHeight;
    const listHeight = tocListEl.clientHeight;
    tocListEl.scrollTop = itemTop - (listHeight / 2) + (itemHeight / 2);
    return true;
  };

  // Pre-position the list before the sidebar becomes visible to avoid a visible jump.
  centerActiveTocItem();

  tocSidebar.classList.add('open');
  settingsPanel.classList.remove('open');
  panelBackdrop.classList.add('visible');
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
  // Fallback recenter after slide-in in case TOC updates while opening.
  setTimeout(() => {
    centerActiveTocItem();
  }, 280);
}
function openSettings() {
  settingsPanel.classList.add('open');
  tocSidebar.classList.remove('open');
  bookmarksSidebar.classList.remove('open');
  panelBackdrop.classList.add('visible');
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek'); // hide bar when settings opens
  renderDictSettings(); // lazy-load dictionary list
}
function openBookmarks() {
  bookmarksSidebar.classList.add('open');
  tocSidebar.classList.remove('open');
  settingsPanel.classList.remove('open');
  panelBackdrop.classList.add('visible');
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
}
function closeJumpPanel() {
  jumpPctPanel.style.display = 'none';
  // Re-evaluate auto-hide: hide header unless something else is keeping it open
  if (prefs.autoHideHeader && !tocSidebar.classList.contains('open') && !bookmarksSidebar.classList.contains('open') && !isMouseOverHeader) {
    readerLayout.classList.remove('header-peek');
  }
}
function closePanels() {
  const activeEl = document.activeElement;
  const searchHadFocus = !!activeEl && searchSidebar.contains(activeEl);
  tocSidebar.classList.remove('open');
  settingsPanel.classList.remove('open');
  searchSidebar.classList.remove('open');
  bookmarksSidebar.classList.remove('open');
  document.getElementById('annotations-sidebar')?.classList.remove('open');
  panelBackdrop.classList.remove('visible');
  closeJumpPanel();
  if (searchHadFocus && typeof activeEl.blur === 'function') activeEl.blur();
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
}

function hasOpenPanel() {
  return tocSidebar.classList.contains('open')
    || searchSidebar.classList.contains('open')
    || settingsPanel.classList.contains('open')
    || bookmarksSidebar.classList.contains('open')
    || document.getElementById('annotations-sidebar')?.classList.contains('open');
}

async function returnToLibrary() {
  clearInterruptedSession();
  if (!prefs.skipSaveOnClose) {
    await saveProgress(); // await so updated_at is committed before library reloads
  }
  await endStatsSession();
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
  if (!isFullscreenSupported()) {
    fullscreenBtn.classList.add('hidden');
    return;
  }
  fullscreenBtn.classList.remove('hidden');
  const img = fullscreenBtn.querySelector('img.nav-icon-fullscreen');
  if (img) {
    img.src = isFullscreenActive() ? '/images/fullscreen_exit.svg' : '/images/fullscreen.svg';
  }
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
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
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
    searchBackBtn.style.display   = '';
    searchAcceptBtn.style.display = '';
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
  resultsEl.innerHTML = `<div class="dict-loading">${t('reader.dict_loading')}</div>`;
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
        // Also auto-detect HTML content: some dicts declare sametypesequence=m but
        // actually contain HTML/markup (common in community StarDict dictionaries).
        const looksLikeHtml = r.type !== 'h' && /<[a-zA-Z][^>]*>/.test(r.definition);
        let defHtml;
        if (r.type === 'h' || looksLikeHtml) {
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

// Receive messages from iframe contexts (origin may vary on iOS/blob views).
window.addEventListener('message', (e) => {
  if (e.data?.type === 'dict-lookup') {
    const word = String(e.data.word || '').trim();
    if (!word || word.length > 120) return;
    showDictPopup(word);
  }
  if (e.data?.type === 'footnote-show') {
    const { fragId, sameDoc, rawHref } = e.data;
    if (fragId) showFootnotePopup(fragId, sameDoc ? null : rawHref);
  }
  if (e.data?.type === 'annotation-select') {
    const { cfiRange, text } = e.data;
    if (cfiRange && text) {
      closeFootnotePopup();
      showAnnotationToolbar(cfiRange, text);
    }
  }
  if (e.data?.type === 'annotation-click') {
    const a = annotationsCache.find(x => x.id === e.data.id);
    if (a) showAnnotationEditSheet(a);
  }
});

document.getElementById('footnote-backdrop')?.addEventListener('click', closeFootnotePopup);
document.getElementById('footnote-popup-close')?.addEventListener('click', closeFootnotePopup);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFootnotePopup();
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
  const piSizeRow = document.getElementById('para-indent-size-row');
  const piSizeEl  = document.getElementById('para-indent-size-slider');
  const piSizeVl  = document.getElementById('para-indent-size-value');
  if (piSizeRow) piSizeRow.style.display = prefs.paraIndent ? '' : 'none';
  if (piSizeEl)  piSizeEl.value = prefs.paraIndentSize;
  if (piSizeVl)  piSizeVl.textContent = (prefs.paraIndentSize / 10).toFixed(1) + 'em';
  const psEl = document.getElementById('para-spacing-slider');
  const psVl = document.getElementById('para-spacing-value');
  if (psEl) psEl.value = prefs.paraSpacing;
  if (psVl) psVl.textContent = (prefs.paraSpacing / 10).toFixed(1) + 'em';
  const lsEl = document.getElementById('letter-spacing-slider');
  const lsVl = document.getElementById('letter-spacing-value');
  if (lsEl) lsEl.value = prefs.letterSpacing;
  if (lsVl) lsVl.textContent = (prefs.letterSpacing / 10).toFixed(1) + 'px';
  const chEl = document.getElementById('chap-head-spacing-toggle');
  if (chEl) chEl.checked = prefs.chapHeadSpacing;
  const djEl = document.getElementById('disable-justify-toggle');
  if (djEl) djEl.checked = prefs.disableJustify;
  const mwEl = document.getElementById('mouse-wheel-nav-toggle');
  if (mwEl) mwEl.checked = prefs.mouseWheelNav;
  const hypEl  = document.getElementById('hyphenation-toggle');
  if (hypEl) hypEl.checked = prefs.hyphenation;
  const hypLangEl = document.getElementById('hyphen-lang-select');
  if (hypLangEl) { hypLangEl.value = prefs.hyphenLang; hypLangEl.closest('.setting-row').style.display = prefs.hyphenation ? '' : 'none'; }
  const bionicEl = document.getElementById('bionic-reading-toggle');
  if (bionicEl) bionicEl.checked = prefs.bionicReading;
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

  const cpIconSrc = STAT_ICON['chapterPage'];
  const cpIcon    = (cpIconSrc && prefs.statusBar.showIcons['chapterPage'] !== false) ? sbIconHtml(cpIconSrc) + '\u202F' : '';
  const leftVal  = currentChapPage > 0 ? cpIcon + currentChapPage + '/' + currentChapTotal : '';
  const rightVal = currentEndPage  > 0 ? cpIcon + currentEndPage  + '/' + currentChapTotal : '';

  if (chapInTop) {
    const tlOther = computeSlot(pos.tl.filter(id => id !== 'chapterPage'));
    const tcSlot  = computeSlot(pos.tc.filter(id => id !== 'chapterPage'));
    const trOther = computeSlot(pos.tr.filter(id => id !== 'chapterPage'));
    sbTl.innerHTML = [leftVal,  tlOther].filter(Boolean).join('  |  ');
    sbTc.innerHTML = tcSlot;
    sbTr.innerHTML = [trOther, rightVal].filter(Boolean).join('  |  ');
  } else {
    sbTl.innerHTML = computeSlot(pos.tl);
    sbTc.innerHTML = computeSlot(pos.tc);
    sbTr.innerHTML = computeSlot(pos.tr);
  }

  if (chapInBottom) {
    sbBottom.classList.add('two-page');
    const blOther = computeSlot(pos.bl.filter(id => id !== 'chapterPage'));
    const bcSlot  = computeSlot(pos.bc.filter(id => id !== 'chapterPage'));
    const brOther = computeSlot(pos.br.filter(id => id !== 'chapterPage'));
    sbBl.innerHTML = [leftVal,  blOther].filter(Boolean).join('  |  ');
    sbBc.innerHTML = bcSlot;
    sbBr.innerHTML = [brOther, rightVal].filter(Boolean).join('  |  ');
    sbBottom.classList.toggle('two-page-no-center', !bcSlot);
  } else {
    sbBottom.classList.remove('two-page');
    sbBottom.classList.remove('two-page-no-center');
    sbBl.innerHTML = computeSlot(pos.bl);
    sbBc.innerHTML = computeSlot(pos.bc);
    sbBr.innerHTML = computeSlot(pos.br);
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
    const iconHtml  = sbIconHtml(icon);
    const row       = document.createElement('div');
    row.className   = 'sb-item-row';
    row.dataset.id  = id;
    row.innerHTML   = `
      <div class="sb-item-header">
        <span class="sb-item-icon">${iconHtml}</span>
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
      opt.value = f.value;
      opt.textContent = f.label;
      sel.appendChild(opt);
    });
  const initialValue = prefs.statusBar.font || '';
  sel.value = initialValue;
  if (!sel.value && initialValue) {
    const fallback = Array.from(sel.options).find(o => o.textContent === initialValue);
    if (fallback) sel.value = fallback.value;
  }
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
    const sizeRow = document.getElementById('para-indent-size-row');
    if (sizeRow) sizeRow.style.display = prefs.paraIndent ? '' : 'none';
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('para-indent-size-slider')?.addEventListener('input', (e) => {
    prefs.paraIndentSize = parseInt(e.target.value);
    const vl = document.getElementById('para-indent-size-value');
    if (vl) vl.textContent = (prefs.paraIndentSize / 10).toFixed(1) + 'em';
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('para-spacing-slider')?.addEventListener('input', (e) => {
    prefs.paraSpacing = parseInt(e.target.value);
    const vl = document.getElementById('para-spacing-value');
    if (vl) vl.textContent = (prefs.paraSpacing / 10).toFixed(1) + 'em';
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('letter-spacing-slider')?.addEventListener('input', (e) => {
    prefs.letterSpacing = parseFloat(e.target.value);
    const vl = document.getElementById('letter-spacing-value');
    if (vl) vl.textContent = (prefs.letterSpacing / 10).toFixed(1) + 'px';
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('chap-head-spacing-toggle')?.addEventListener('change', (e) => {
    prefs.chapHeadSpacing = e.target.checked;
    reapplyStyles(); persistPrefs();
  });
  document.getElementById('disable-justify-toggle')?.addEventListener('change', (e) => {
    prefs.disableJustify = e.target.checked;
    console.log('[justify] toggle changed → disableJustify:', prefs.disableJustify);
    reapplyStyles();
    // Debug: log computed text-align on first <p> in iframe after styles applied
    setTimeout(() => {
      try {
        const views = rendition?.manager?.views?.asArray?.() || rendition?.manager?.views || [];
        const view = Array.isArray(views) ? views[0] : views?.get?.(0);
        const doc = view?.contents?.document || rendition?.getContents?.()[0]?.document;
        if (doc) {
          const p = doc.querySelector('p');
          const styleEl = doc.getElementById('br-custom-styles');
          console.log('[justify] br-custom-styles in iframe:', styleEl ? styleEl.textContent.slice(0, 300) : '(not found)');
          if (p) {
            const computed = doc.defaultView?.getComputedStyle(p);
            console.log('[justify] first <p> computed text-align:', computed?.textAlign);
            console.log('[justify] first <p> inline style text-align:', p.style.textAlign);
            // Log all stylesheets affecting the iframe
            const sheets = [...(doc.styleSheets || [])];
            sheets.forEach((sheet, i) => {
              try {
                const rules = [...sheet.cssRules].map(r => r.cssText).join('\n');
                if (rules.includes('text-align') || rules.includes('justify')) {
                  console.log(`[justify] stylesheet[${i}] href:`, sheet.href || '(inline)', '\n', rules.slice(0, 500));
                }
              } catch { /* cross-origin */ }
            });
          }
        }
      } catch (e) { console.warn('[justify] debug error:', e.message); }
    }, 200);
    persistPrefs();
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
  document.getElementById('bionic-reading-toggle')?.addEventListener('change', (e) => {
    prefs.bionicReading = e.target.checked;
    persistPrefs();
    saveBionicReloadState();
    location.reload();
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
  } else {
    // Still track spine index even during init for accurate xpointer on first save
    currentSpineIndex = location?.start?.index ?? currentSpineIndex;
  }
  const d = Math.round(pct * 100);
  progressFillEl.style.width = d + '%';
  const href = location?.start?.href || '';
  const oldChapterHref = lastChapterHref;
  console.log(
    `[nav] relocated | dir=${pendingNavDirection||'—'} ready=${isReady}` +
    ` | ${href === oldChapterHref ? 'same-chap' : ('CHAP→' + (href||'?').split('/').pop())}` +
    ` | p=${location?.start?.displayed?.page}/${location?.start?.displayed?.total}` +
    ` end=${location?.end?.displayed?.page}` +
    ` | cfi=…${(cfi||'').slice(-25)}`
  );
  chapterTitleEl.textContent = chapterLabelFromHref(href);
  currentHref = href;
  updateActiveTocItem(href);
  // Save on chapter boundary (when spine item changes).
  // Push remote for any chapter change regardless of direction (forward or TOC jump).
  // Suppress remote push while a bookmark jump is pending (user hasn't accepted yet).
  if (isReady && oldChapterHref !== null && href && href !== oldChapterHref) {
    const alreadySent = href === lastSentChapterHref;
    const bookmarkPending = !!preBookmarkCfi;
    saveProgress({
      forceRemote: !alreadySent && !bookmarkPending,
      allowRemote: !alreadySent && !bookmarkPending,
    });
    writeInterruptedSession();
    if (!alreadySent && !bookmarkPending) {
      lastSentChapterHref = href;
    }
    // Log chapter visit for statistics (fire-and-forget)
    if (currentBook) {
      logChapterVisit(currentBook.id, href, chapterLabelFromHref(href));
    }
  }
  if (href) lastChapterHref = href;

  // Status bar overlays (replacing old page info overlays)
  if (isReady) lastLocation = location;
  trackReadingSpeed();
  updateStatusBar(location);
  scheduleBionicPrefetchAround(location);

  if (
    pendingNavDirection === 'next' &&
    isReady &&
    href &&
    oldChapterHref &&
    href !== oldChapterHref
  ) {
    pendingNavDirection = null;
    const landedPage = location?.start?.displayed?.page ?? 1;
    console.log(
      `[nav] chap-advance | wasEnd=${pendingWasChapterEnd} landedPage=${landedPage}` +
      ` | → ${!pendingWasChapterEnd ? 'FIX-GOBACK' : 'OK'}`
    );
    if (!pendingWasChapterEnd) {
      console.log(`[nav] FIX-GOBACK | prev()`);
      rendition?.prev();
    }
  } else {
    pendingNavDirection = null;
  }
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
          updateStatusBar(lastLocation || rendition?.currentLocation());
        }
      }
      buildChapterMarkers(); // refine markers now that accurate locations are available
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
          updateStatusBar(lastLocation || rendition?.currentLocation());
        }
      }
      buildChapterMarkers(); // refine markers now that accurate locations are available
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
  let safeCfi = jumpCfi;
  if (prefs.bionicReading && jumpCfi) {
    safeCfi = makeBionicSafeCfi(jumpCfi);
  }
  if (safeCfi) {
    try {
      await rendition.display(safeCfi);
    } catch (e) { }
  }
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
  scheduleBionicPrefetchAround(finalLoc || rendition?.currentLocation?.());
}

// ── External + internal kosync ────────────────────────────────────────────────
// KOReader identifies books by MD5 of file content — use file_hash_md5 so our
// entries in Grimmory line up with what KOReader stores there.
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

async function saveProgress({ forceRemote = false, allowRemote = true } = {}) {
  if (!currentBook || !isReady) return;
  const cfi = currentCfi || '';
  const pct = currentPct || 0;
  if (!cfi && pct === 0) return;
  console.log('[pos] SAVE cfi:', cfi.slice(0,60), 'pct:', (pct*100).toFixed(2)+'%');
  const docKey = externalDocKey();
  const posChanged = cfi !== openCfi;
  const shouldPushRemote = !prefs.skipSaveOnClose && (forceRemote || (allowRemote && posChanged));
  console.log('[kosync] saveProgress docKey:', docKey, 'cfi:', cfi.slice(0, 40), 'pct:', Math.round(pct * 100) + '%', shouldPushRemote ? '' : '(no remote push)');
  const saves = [
    apiFetch(`/progress/${currentBook.file_hash}`, {
      method: 'PUT',
      body: JSON.stringify({ cfi_position: cfi, percentage: pct, device: 'web' }),
    }),
  ];
  if (shouldPushRemote) {
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
  if (!prefs.skipSaveOnClose && posChanged) {
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

  // If the remote xpointer exactly matches our last-pushed xpointer, both readers
  // are at the same paragraph — skip the dialog even if percentages differ (they
  // are on different scales and the mismatch is expected, not a real position gap).
  // NOTE: this optimisation only makes sense when comparing an EXTERNAL position
  // (ext) with what the web reader last wrote to the internal store (int).
  // When best === int (KOReader pushes directly here, no external server), both
  // sides would be the same object → always a match → dialog never shows.
  // In that case set localXPointer to null so we fall through to the pct check.
  const localXPointer = (best !== int) ? (int?.progress || null) : null;
  const xpointerMatch = !!(localXPointer && best.progress && localXPointer === best.progress);
  console.log('[kosync] xpointerMatch:', xpointerMatch, 'local:', localXPointer, 'remote:', best.progress);

  const pctDiffers = Math.abs((best.percentage || 0) - localPct) > 0.01;
  if (!xpointerMatch && pctDiffers) {
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
    height:         Math.max(200, (epubViewer.clientHeight || (window.innerHeight - 55)) - RENDITION_BOTTOM_RESERVE),
    spread:         spreadMode,
    minSpreadWidth: 800,
    manager:        'default',
    gap:            prefs.margin * 2,
    allowScriptedContent: true,
  });

  // Attach keyboard forwarding via content hook (runs on every page load)
  // Also inject our styles early here — before first paint — to avoid the
  // flash of unstyled/wrong-size text when crossing chapter boundaries.
  rendition.hooks.content.register((contents) => {
    attachIframeKeyboard(contents);
    attachIframeDictionary(contents);
    attachIframeFootnotes(contents);
    attachIframeAnnotation(contents);
    injectIntoContents(contents);
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
    // epub.js can silently re-paginate after 'relocated' fires (e.g. discovering
    // blank structural pages at the chapter start), updating currentLocation() without
    // emitting another 'relocated'. Poll after a short settle window and sync the
    // status bar if the internal page moved — prevents misleading page-number jumps
    // on the next user-initiated NEXT press.
    setTimeout(() => {
      if (!isReady) return;
      const loc = rendition?.currentLocation?.();
      const p = loc?.start?.displayed?.page;
      if (p && p !== currentChapPage) {
        console.log(
          `[nav] repaginate | ${currentChapPage}→${p}/${currentChapTotal}` +
          ` chap="${currentHref?.split('/').pop()}"`
        );
        currentChapPage  = p;
        currentEndPage   = loc.end?.displayed?.page ?? currentEndPage;
        currentChapTotal = Math.max(loc.start?.displayed?.total ?? 0, currentChapTotal);
        if (chapPageCache[currentSpineIndex] < currentChapTotal) chapPageCache[currentSpineIndex] = currentChapTotal;
        updateStatusBar(loc);
      }
    }, 180);
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
function goNext() {
  pendingNavDirection = 'next';
  sessionPageCount++;
  // Capture whether we are truly at the last page at call-time. The library can
  // advance the chapter prematurely if a CSS expand shrinks scrollWidth between
  // this call and when manager.next() actually runs (async via rAF queue).
  // We use both tracked state and live DOM state; OR avoids false positives from
  // stale tracked values and from missed repagination poll updates.
  const _lL = rendition?.currentLocation?.();
  const _liveEnd   = _lL?.end?.displayed?.page;
  const _liveTotal = _lL?.start?.displayed?.total;
  pendingWasChapterEnd =
    currentEndPage === 0 || currentChapTotal === 0 ||
    currentEndPage >= currentChapTotal - 1 ||
    (!!_liveEnd && !!_liveTotal && _liveEnd >= _liveTotal - 1);
  console.log(
    `[nav] NEXT | tracked end=${currentEndPage}/${currentChapTotal}` +
    ` live end=${_liveEnd}/${_liveTotal} wasEnd=${pendingWasChapterEnd}`
  );
  rendition?.next();
}
function goPrev() {
  console.log(`[nav] PREV | page=${currentChapPage}/${currentChapTotal}`);
  pendingNavDirection = 'prev'; sessionPageCount++; rendition?.prev();
}

// ── Touch / swipe navigation ──────────────────────────────────────────────────
const SWIPE_THRESHOLD = 24;   // min px horizontal distance
const SWIPE_MAX_VERT  = 130;  // max vertical drift allowed
const TAP_MAX_DRIFT   = 20;   // max px movement still counted as a tap
const TOP_REVEAL_ZONE = 92;   // px from top where tap reveals header
const SWIPE_DOWN_OPEN = 42;   // px downward swipe to reveal header
const SWIPE_UP_CLOSE  = 30;   // px upward swipe to hide header when open
// iOS detection (Chrome/Safari on iPhone/iPad use WebKit with different iframe touch behaviour)
const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let touchStartX = 0;
let touchStartY = 0;
let suppressNextTap = false; // set by long-press dict lookup to prevent navigation on touchend

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
    if (!readerLayout.classList.toggle('header-peek')) closeJumpPanel();
    return;
  }
  if (prefs.autoHideHeader && dy < -SWIPE_UP_CLOSE && absDx < 70 && readerLayout.classList.contains('header-peek')) {
    readerLayout.classList.remove('header-peek');
    closeJumpPanel();
    return;
  }
  if (absDx < TAP_MAX_DRIFT && absDy < TAP_MAX_DRIFT) {
    if (prefs.autoHideHeader && y < TOP_REVEAL_ZONE + 20) {
      readerLayout.classList.add('header-peek');
      return;
    }
    const x         = e.changedTouches[0].clientX;
    const leftZone  = prefs.edgePadding.left  + prefs.margin;
    const rightZone = prefs.edgePadding.right + prefs.margin;
    if (leftZone  > 0 && x < leftZone)                        { goPrev(); return; }
    if (rightZone > 0 && x > window.innerWidth - rightZone)   { goNext(); return; }
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

// Per-page: forward touch events from inside the epub iframe into our handlers
function attachIframeTouchNav(view) {
  const win = view?.contents?.window;
  if (!win) return;
  // No tap-to-page navigation on mobile; swipe-only navigation.
  let iframeOffX = 0, iframeOffY = 0;

  win.addEventListener('touchstart', (e) => {
    const iframe = view.element?.querySelector('iframe') || view.element;
    iframeOffX   = iframe ? iframe.getBoundingClientRect().left : 0;
    iframeOffY   = iframe ? iframe.getBoundingClientRect().top  : 0;
    touchStartX  = e.changedTouches[0].clientX + iframeOffX;
    touchStartY  = e.changedTouches[0].clientY + iframeOffY;
  }, { passive: false });

  win.addEventListener('touchmove', (e) => {
    const dx = Math.abs(e.touches[0].clientX + iframeOffX - touchStartX);
    const dy = Math.abs(e.touches[0].clientY + iframeOffY - touchStartY);
    if (dx > 8 && dx > dy) e.preventDefault();
  }, { passive: false });

  win.addEventListener('touchend', (e) => {
    if (suppressNextTap) {
      suppressNextTap = false;
      if (e.cancelable) e.preventDefault();
      return;
    }
    const cx     = e.changedTouches[0].clientX + iframeOffX;
    const cy     = e.changedTouches[0].clientY + iframeOffY;
    const dx     = cx - touchStartX;
    const dy     = cy - touchStartY;
    const absDx  = Math.abs(dx);
    const absDy  = Math.abs(dy);
    if (prefs.autoHideHeader && dy > SWIPE_DOWN_OPEN && absDx < 70) {
      if (e.cancelable) e.preventDefault();
      if (!readerLayout.classList.toggle('header-peek')) closeJumpPanel();
      return;
    }
    if (prefs.autoHideHeader && dy < -SWIPE_UP_CLOSE && absDx < 70 && readerLayout.classList.contains('header-peek')) {
      if (e.cancelable) e.preventDefault();
      readerLayout.classList.remove('header-peek');
      closeJumpPanel();
      return;
    }
    if (absDx < TAP_MAX_DRIFT && absDy < TAP_MAX_DRIFT) {
      // Tap in the margin (between text and screen edge) → navigate
      const leftZone  = prefs.edgePadding.left  + prefs.margin;
      const rightZone = prefs.edgePadding.right + prefs.margin;
      if (leftZone > 0 && cx < leftZone) {
        if (e.cancelable) e.preventDefault();
        goPrev();
        return;
      }
      if (rightZone > 0 && cx > window.innerWidth - rightZone) {
        if (e.cancelable) e.preventDefault();
        goNext();
        return;
      }
      // Tap outside margin — reveal/toggle header
      if (prefs.autoHideHeader && cy < TOP_REVEAL_ZONE + 20) {
        if (e.cancelable) e.preventDefault();
        readerLayout.classList.add('header-peek');
      }
      return;
    }
    if (absDx > SWIPE_THRESHOLD && absDy < SWIPE_MAX_VERT) {
      if (e.cancelable) e.preventDefault();
      if (dx < 0) goNext();
      else        goPrev();
    }
  }, { passive: false });
}

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
async function resizeRenditionToViewer() {
  if (!rendition) return;
  const pctBeforeResize = currentPct;
  rendition.resize(epubViewer.clientWidth, Math.max(200, epubViewer.clientHeight - RENDITION_BOTTOM_RESERVE));
  if (isReady && pctBeforeResize > 0 && book.locations?.length() > 0) {
    await seekToPercentage(pctBeforeResize);
  }
}

window.addEventListener('resize', debounce(() => {
  void resizeRenditionToViewer();
}, 300));

// ── Reading statistics ────────────────────────────────────────────────────────
async function startStatsSession(bookId) {
  try {
    const res = await apiFetch('/stats/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: bookId, start_ts: Math.floor(Date.now() / 1000) }),
    });
    statsSessionId = res?.id || null;
    sessionPageCount = 0;
    console.log('[stats] session started id:', statsSessionId);
  } catch (e) {
    console.warn('[stats] failed to start session:', e.message);
  }
}

function endStatsSessionBackground() {
  if (!statsSessionId) return;
  const id  = statsSessionId;
  const pgs = sessionPageCount;
  statsSessionId   = null;
  sessionPageCount = 0;
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  fetch(`/api/stats/session/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ end_ts: Math.floor(Date.now() / 1000), pages_nav: pgs }),
    keepalive: true,
  }).catch(() => {});
}

async function endStatsSession() {
  if (!statsSessionId) return;
  const id  = statsSessionId;
  const pgs = sessionPageCount;
  statsSessionId   = null;
  sessionPageCount = 0;
  try {
    await apiFetch(`/stats/session/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ end_ts: Math.floor(Date.now() / 1000), pages_nav: pgs }),
    });
  } catch (e) {
    console.warn('[stats] failed to end session:', e.message);
  }
}

function logChapterVisit(bookId, href, title) {
  if (!bookId || !href) return;
  apiFetch('/stats/chapter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ book_id: bookId, chapter_href: href, chapter_title: title || '' }),
  }).catch(() => {});
}

// ── Bookmarks ─────────────────────────────────────────────────────────────────
function updateBookmarkBadge() {
  const n = bookmarksCache.length;
  bookmarksBadge.textContent = n > 9 ? '9+' : String(n);
  bookmarksBadge.classList.toggle('hidden', n === 0);
}

function renderBookmarkList() {
  if (!bookmarksCache.length) {
    bookmarksListEl.innerHTML = `<div class="bookmarks-empty">${t('reader.bookmarks_empty')}</div>`;
    return;
  }
  bookmarksListEl.innerHTML = '';
  bookmarksCache.forEach(bm => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    item.dataset.id = String(bm.id);

    const pctText = `${Math.round(bm.pct * 100)}%`;
    const dateText = bm.created_at
      ? new Date(bm.created_at * 1000).toLocaleDateString()
      : '';

    item.innerHTML = `
      <div class="bookmark-info">
        <span class="bookmark-label">${escapeHtml(bm.label || pctText)}</span>
        <span class="bookmark-meta">${escapeHtml(pctText)}${dateText ? ' · ' + escapeHtml(dateText) : ''}</span>
      </div>
      <div class="bookmark-actions">
        <button class="bookmark-action-btn edit" title="${t('reader.bookmark_edit')}">✎</button>
        <button class="bookmark-action-btn delete" title="${t('reader.bookmark_delete')}">×</button>
      </div>`;

    // Click on info → jump (save position so user can go back / accept)
    item.querySelector('.bookmark-info').addEventListener('click', () => {
      if (!bm.cfi) return;
      // Save current position for back button, same pattern as search navigation
      if (!preBookmarkCfi && currentCfi) {
        preBookmarkCfi = currentCfi;
        bookmarkBackBtn.style.display   = '';
        bookmarkAcceptBtn.style.display = '';
      }
      closePanels();
      rendition?.display(bm.cfi).catch(() => {});
    });

    // Edit label
    item.querySelector('.bookmark-action-btn.edit').addEventListener('click', () => {
      const labelEl = item.querySelector('.bookmark-label');
      const current = labelEl.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'bookmark-label-input';
      input.value = current;
      labelEl.replaceWith(input);
      input.focus();
      const save = async () => {
        const newLabel = input.value.trim() || pctText;
        try {
          await apiFetch(`/bookmarks/${currentBook.id}/${bm.id}`, {
            method: 'PUT',
            body: JSON.stringify({ label: newLabel }),
          });
          bm.label = newLabel;
        } catch { /* revert silently */ }
        renderBookmarkList();
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
      });
    });

    // Delete
    item.querySelector('.bookmark-action-btn.delete').addEventListener('click', async () => {
      try {
        await apiFetch(`/bookmarks/${currentBook.id}/${bm.id}`, { method: 'DELETE' });
        bookmarksCache = bookmarksCache.filter(b => b.id !== bm.id);
        renderBookmarkList();
        updateBookmarkBadge();
        toast.success(t('reader.bookmark_deleted'));
      } catch (err) {
        toast.error(err.message || t('reader.bookmark_err_delete'));
      }
    });

    bookmarksListEl.appendChild(item);
  });
}

async function loadBookmarks(bookId) {
  try {
    bookmarksCache = await apiFetch(`/bookmarks/${bookId}`);
    renderBookmarkList();
    updateBookmarkBadge();
  } catch {
    bookmarksCache = [];
  }
}

async function addBookmark() {
  if (!currentBook || !rendition) return;
  const loc   = rendition.currentLocation();
  const cfi   = loc?.start?.cfi || currentCfi;
  const pct   = currentPct;
  const chapter = chapterTitleEl.textContent || '';
  const label = `${chapter ? chapter + ' · ' : ''}${Math.round(pct * 100)}%`;

  try {
    const bm = await apiFetch(`/bookmarks/${currentBook.id}`, {
      method: 'POST',
      body: JSON.stringify({ cfi, pct, label }),
    });
    bookmarksCache.push(bm);
    bookmarksCache.sort((a, b) => a.pct - b.pct);
    renderBookmarkList();
    updateBookmarkBadge();
    toast.success(t('reader.bookmark_added'));
  } catch (err) {
    toast.error(err.message || t('reader.bookmark_err_add'));
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Button wiring ─────────────────────────────────────────────────────────────

// Annotation toolbar
document.getElementById('annot-backdrop')?.addEventListener('click', () => {
  closeAnnotationToolbar();
  closeAnnotationNoteEditor();
  closeAnnotationEditSheet();
});
document.getElementById('annot-btn-cancel')?.addEventListener('click', closeAnnotationToolbar);
document.querySelectorAll('.annot-color-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const color = btn.dataset.color;
    if (!color || !_pendingAnnotation) return;
    const { cfiRange, text } = _pendingAnnotation;
    closeAnnotationToolbar();
    await createAnnotation(cfiRange, text, color, '');
  });
});
document.getElementById('annot-btn-note')?.addEventListener('click', () => {
  if (!_pendingAnnotation) return;
  const pending = _pendingAnnotation;
  closeAnnotationToolbar();
  _pendingAnnotation = pending; // restore after close nulled it
  showAnnotationNoteEditor(null, '');
});

// Annotation note editor (creation mode)
document.getElementById('annot-note-cancel')?.addEventListener('click', closeAnnotationNoteEditor);
document.getElementById('annot-note-save')?.addEventListener('click', async () => {
  const note = (document.getElementById('annot-note-text')?.value || '').trim();
  if (_editingAnnotationId !== null) {
    // Edit mode
    await updateAnnotation(_editingAnnotationId, { note });
    closeAnnotationNoteEditor();
  } else if (_pendingAnnotation) {
    // Create mode — color defaults to yellow when opened via Note button directly
    const { cfiRange, text } = _pendingAnnotation;
    closeAnnotationNoteEditor();
    await createAnnotation(cfiRange, text, 'yellow', note);
  }
});

// Annotation edit sheet (for existing annotations)
document.getElementById('annot-edit-close')?.addEventListener('click', closeAnnotationEditSheet);
document.getElementById('annot-edit-note-btn')?.addEventListener('click', () => {
  const id = parseInt(document.getElementById('annot-edit-sheet')?.dataset.annotId);
  const a  = annotationsCache.find(x => x.id === id);
  if (!a) return;
  closeAnnotationEditSheet();
  showAnnotationNoteEditor(id, a.note || '');
});
document.getElementById('annot-edit-delete-btn')?.addEventListener('click', async () => {
  const id = parseInt(document.getElementById('annot-edit-sheet')?.dataset.annotId);
  closeAnnotationEditSheet();
  await deleteAnnotation(id);
});
document.querySelectorAll('.annot-edit-color-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const color = btn.dataset.color;
    const sheet = document.getElementById('annot-edit-sheet');
    const id = parseInt(sheet?.dataset.annotId);
    if (!color || !id) return;
    sheet.querySelectorAll('.annot-edit-color-btn').forEach(b => b.classList.toggle('active', b === btn));
    await updateAnnotation(id, { color });
  });
});

// Dictionary button inside annotation toolbar
document.getElementById('annot-btn-dict')?.addEventListener('click', () => {
  const text = _pendingAnnotation?.text || '';
  const word = text.split(/\s+/)[0].replace(/^['’-]+|['’-]+$/g, '').trim();
  closeAnnotationToolbar();
  if (word) showDictPopup(word);
});

// Annotations sidebar
document.getElementById('btn-annotations')?.addEventListener('click', () =>
  document.getElementById('annotations-sidebar')?.classList.contains('open') ? closePanels() : openAnnotations());
document.getElementById('annotations-close')?.addEventListener('click', closePanels);

document.getElementById('btn-back').addEventListener('click', () => { void returnToLibrary(); });
document.getElementById('btn-toc').addEventListener('click', () =>
  tocSidebar.classList.contains('open') ? closePanels() : openToc());
document.getElementById('btn-bookmarks').addEventListener('click', () =>
  bookmarksSidebar.classList.contains('open') ? closePanels() : openBookmarks());
document.getElementById('bookmarks-close').addEventListener('click', closePanels);
document.getElementById('btn-add-bookmark').addEventListener('click', () => { void addBookmark(); });
document.getElementById('btn-search').addEventListener('click', () =>
  searchSidebar.classList.contains('open') ? closePanels() : openSearch());
document.getElementById('btn-search-back').addEventListener('click', async () => {
  if (!preSearchCfi) return;
  clearSearchHighlights();
  const cfi = preSearchCfi;
  preSearchCfi = null;
  searchBackBtn.style.display   = 'none';
  searchAcceptBtn.style.display = 'none';
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
  await rendition.display(cfi);
});
document.getElementById('btn-search-accept').addEventListener('click', () => {
  clearSearchHighlights();
  preSearchCfi = null;
  searchBackBtn.style.display   = 'none';
  searchAcceptBtn.style.display = 'none';
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
});
// Bookmark navigation back/accept — same pattern as search
document.getElementById('btn-bookmark-back').addEventListener('click', async () => {
  if (!preBookmarkCfi) return;
  const cfi = preBookmarkCfi;
  preBookmarkCfi = null;
  bookmarkBackBtn.style.display   = 'none';
  bookmarkAcceptBtn.style.display = 'none';
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
  await rendition.display(cfi);
});
document.getElementById('btn-bookmark-accept').addEventListener('click', () => {
  preBookmarkCfi = null;
  bookmarkBackBtn.style.display   = 'none';
  bookmarkAcceptBtn.style.display = 'none';
  if (prefs.autoHideHeader) readerLayout.classList.remove('header-peek');
  // Now that the user accepted the position, push progress normally
  void saveProgress({ forceRemote: true });
});
document.getElementById('btn-jump-pct').addEventListener('click', () => {
  if (jumpPctPanel.style.display !== 'none') {
    closeJumpPanel();
    return;
  }
  jumpPctSlider.value = String(Math.round(currentPct * 100));
  jumpPctValue.textContent = `${jumpPctSlider.value}%`;
  jumpPctPanel.style.display = '';
});
jumpPctSlider.addEventListener('input', () => {
  jumpPctValue.textContent = `${jumpPctSlider.value}%`;
});
jumpPctSlider.addEventListener('change', async () => {
  await seekToPercentage(parseInt(jumpPctSlider.value, 10) / 100);
});
document.addEventListener('mousedown', e => {
  if (jumpPctPanel.style.display === 'none') return;
  // Ignore clicks on btn-jump-pct (or any descendant — pointer-events:none on img
  // means the button is always the target, but use closest() as extra safety).
  if (e.target.closest?.('#btn-jump-pct')) return;
  // Ignore epub.js internal focus/mousedown events targeting the viewer.
  if (e.target.closest?.('#epub-viewer') || e.target === epubViewer) return;
  if (!jumpPctPanel.contains(e.target)) {
    closeJumpPanel();
  }
});
document.getElementById('search-close').addEventListener('click', closePanels);
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
document.getElementById('btn-prev').addEventListener('click', e => { e.stopPropagation(); goPrev(); });
document.getElementById('btn-next').addEventListener('click', e => { e.stopPropagation(); goNext(); });

// ── Chapter navigation buttons on book progress bar ────────────────────────────
function findCurrentTocChapIdx() {
  const norm = h => (h || '').split('#')[0].replace(/_split_\d+(\.\w+)$/, '$1').toLowerCase();
  const base = norm(currentHref).split('/').pop();
  const tops = tocFlatItems.filter(t => t.depth === 0);
  let found = -1;
  tops.forEach((t, i) => {
    const tb = norm(t.href || '').split('/').pop();
    if (base && tb && (base === tb || base.includes(tb) || tb.includes(base))) found = i;
  });
  return { tops, idx: found };
}
// Close the jump panel automatically after chapter nav button navigation.
// This matches TOC behaviour and avoids the panel being stuck open with
// the header invisible (autohide removes header-peek on close but epub.js
// sometimes re-focuses the iframe making btn-jump-pct unreachable).
document.getElementById('btn-prev-chap')?.addEventListener('click', () => {
  const { tops, idx } = findCurrentTocChapIdx();
  const target = idx > 0 ? tops[idx - 1] : (idx === 0 ? tops[0] : null);
  if (!target) return;
  const spineItem = findSpineItemForHref((target.href || '').split('#')[0]);
  const displayTarget = spineItem?.index != null ? spineItem.index : target.href;
  console.log(`[nav] PREV-CHAP | from="${currentHref?.split('/').pop()}" → "${displayTarget}"`);
  rendition?.display(displayTarget).then(() => {
    const loc = rendition?.currentLocation?.();
    console.log(`[nav] CHAP-landed | page=${loc?.start?.displayed?.page}/${loc?.start?.displayed?.total} href="${loc?.start?.href?.split('/').pop()}"`);
    scheduleBionicPrefetchAround(loc);
  }).catch(() => {});
});
document.getElementById('btn-next-chap')?.addEventListener('click', () => {
  const { tops, idx } = findCurrentTocChapIdx();
  if (idx < 0 || idx >= tops.length - 1) return;
  const target = tops[idx + 1];
  const spineItem = findSpineItemForHref((target.href || '').split('#')[0]);
  const displayTarget = spineItem?.index != null ? spineItem.index : target.href;
  console.log(`[nav] NEXT-CHAP | from="${currentHref?.split('/').pop()}" → "${displayTarget}"`);
  rendition?.display(displayTarget).then(() => {
    const loc = rendition?.currentLocation?.();
    console.log(`[nav] CHAP-landed | page=${loc?.start?.displayed?.page}/${loc?.start?.displayed?.total} href="${loc?.start?.href?.split('/').pop()}"`);
    scheduleBionicPrefetchAround(loc);
  }).catch(() => {});
});
document.querySelector('.nav-zone-prev')?.addEventListener('click', goPrev);
document.querySelector('.nav-zone-next')?.addEventListener('click', goNext);
document.querySelector('.nav-zone-prev')?.addEventListener('touchend', (e) => { if (e.cancelable) e.preventDefault(); goPrev(); }, { passive: false });
document.querySelector('.nav-zone-next')?.addEventListener('touchend', (e) => { if (e.cancelable) e.preventDefault(); goNext(); }, { passive: false });
document.getElementById('btn-prev').addEventListener('keydown', e => { if (e.key === 'Enter') goPrev(); });
document.getElementById('btn-next').addEventListener('keydown', e => { if (e.key === 'Enter') goNext(); });
window.addEventListener('beforeunload', () => {
  if (!prefs.skipSaveOnClose) saveProgressBackground();
  endStatsSessionBackground();
});
document.addEventListener('fullscreenchange', async () => {
  syncFullscreenButton();

  // Keep layout height in sync on desktop after fullscreen toggle.
  document.documentElement.style.setProperty('--layout-h', window.innerHeight + 'px');

  // Wait two frames so flex layout + CSS vars settle before measuring epubViewer.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await resizeRenditionToViewer();
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  console.log('[reader] v4.2026-05-08.10');
  applyUiTheme();
  applyPageShadow();
  applyAutoHide();
  syncFullscreenButton();
  await loadCustomFonts();
  // First-ever open: apply defaults based on current library theme / available fonts
  if (!localStorage.getItem('br_reader_prefs')) {
    const bookerly = customFonts.find(f => f.label.toLowerCase().includes('bookerly'));
    if (bookerly) prefs.fontFamily = bookerly.value;
    if (localStorage.getItem('br_library_theme') === 'eink') prefs.eink = true;
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
        buildChapterMarkers(); // place markers using spine-index fallback; will be refined by initLocations
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
    const bionicReloadState = readBionicReloadState();
    let reloadStartPct = null;
    let skipOpenSync = false;
    if (bionicReloadState && bionicReloadState.bookId === bookId && bionicReloadState.bionicReading === !!prefs.bionicReading) {
      if (bionicReloadState.cfi) startCfi = bionicReloadState.cfi;
      if (typeof bionicReloadState.pct === 'number') reloadStartPct = bionicReloadState.pct;
      // Do NOT skip KOSync for bionic reloads — only skip for resume-reading opens
      clearBionicReloadState();
    }
    // Session restore: library.js writes a resume hint to sessionStorage before navigating here
    let resumeStartPct = null;
    try {
      const raw = sessionStorage.getItem(RESUME_STATE_KEY);
      sessionStorage.removeItem(RESUME_STATE_KEY);
      if (raw) {
        const rs = JSON.parse(raw);
        if (rs && rs.bookId === bookId && rs.cfi) {
          if (!startCfi) startCfi = rs.cfi;
          if (typeof rs.pct === 'number') resumeStartPct = rs.pct;
          skipOpenSync = true; // user explicitly chose this exact position — skip remote sync
          console.log('[session-restore] using saved cfi:', rs.cfi.slice(0, 60), 'pct:', ((rs.pct||0)*100).toFixed(2)+'%');
        }
      }
    } catch { /* ignore */ }
    try {
      localProgress = await apiFetch(`/progress/${currentBook.file_hash}`).catch(() => null);
      console.log('[reader] localProgress:', localProgress?.cfi_position?.slice(0, 60), 'pct:', localProgress?.percentage);
      if (!startCfi && localProgress?.cfi_position) startCfi = localProgress.cfi_position;
      // Pre-load locations from cache so seekToPercentage works immediately after startRendition
      if (localProgress?.percentage != null) {
        const locsKey    = `br_locs_${currentBook.file_hash}`;
        const cachedLocs = localStorage.getItem(locsKey);
        if (cachedLocs) { try { book.locations.load(cachedLocs); } catch { localStorage.removeItem(locsKey); } }
      }
    } catch { /* start from beginning */ }

    // Bionic replaces text nodes with <span> trees. Any CFI that encodes a text-node
    // step (e.g. epubcfi(/6/14!/4[id]/794/3:143)) is invalid on the transformed DOM —
    // epub.js toRange() throws DOMException. For ALL bionic opens (cold start or reload)
    // reduce the CFI to the chapter href so epub.js opens safely at the chapter start;
    // seekToPercentage() below restores the exact position via the saved percentage.
    if (prefs.bionicReading && startCfi) {
      const m = String(startCfi).match(/^epubcfi\(\/6\/(\d+)!/);
      if (m) {
        const spineIdx = Math.floor(parseInt(m[1], 10) / 2) - 1;
        const item = spineIdx >= 0 ? book.spine.get(spineIdx) : null;
        if (item?.href) {
          console.log('[bionic] reduced startCfi to chapter href:', item.href);
          startCfi = item.href;
        }
      }
    }

    await startRendition(startCfi);
    // Capture the page-start CFI epub.js actually rendered.
    {
      const loc = rendition.currentLocation();
      if (loc?.start?.cfi) currentCfi = loc.start.cfi;
      if (loc?.start?.percentage != null) currentPct = loc.start.percentage;
      console.log('[pos] after startRendition currentCfi:', currentCfi.slice(0,60));
    }
    book.ready.then(() => initLocations()).catch(() => {});
    loadingOverlay.classList.add('hidden');

    // epub.js display(cfi) with char-offset CFIs snaps to wrong page — seek forward by pct.
    if (reloadStartPct != null && book.locations.length() > 0) {
      console.log('[pos] seeking to bionic-toggle pct:', (reloadStartPct * 100).toFixed(2) + '%');
      await seekToPercentage(reloadStartPct);
      console.log('[pos] after bionic seek currentCfi:', currentCfi.slice(0, 60));
    } else if (resumeStartPct != null && book.locations.length() > 0) {
      console.log('[pos] seeking to session-restore pct:', (resumeStartPct * 100).toFixed(2) + '%');
      await seekToPercentage(resumeStartPct);
      console.log('[pos] after session-restore seek currentCfi:', currentCfi.slice(0, 60));
    } else if (localProgress?.percentage != null && book.locations.length() > 0) {
      console.log('[pos] seeking to saved pct:', (localProgress.percentage*100).toFixed(2)+'%');
      await seekToPercentage(localProgress.percentage);
      console.log('[pos] after seek currentCfi:', currentCfi.slice(0,60));
    }

    // Check remote/internal sync AFTER book is visible
    const syncTarget = (prefs.skipOpenProgressCheck || skipOpenSync) ? null : await syncOnOpen(localProgress);
    if (syncTarget?.percentage != null) {
      try {
        // Any DocFragment-based xpointer — navigate to the correct spine item directly.
        // External reader percentages use a different scale than epub.js locations, so
        // using seekToPercentage(externalPct) reliably lands in the wrong position.
        // For paragraph-level xpointers we also try a best-effort inline CFI first.
        const dfMatch = syncTarget.progress?.match(/^\/body\/DocFragment\[(\d+)\]/);
        if (dfMatch) {
          const spineIdx  = parseInt(dfMatch[1]) - 1; // DocFragment is 1-based
          const spineItem = book.spine.get(spineIdx);
          if (spineItem?.href) {
            // Try best-effort CFI from paragraph index: /body/p[M] → epubcfi(/6/N*2!/4/M*2)
            // Skip CFI display when bionic is on — bionic transforms the DOM so epub.js
            // toRange() will crash on any element-path CFI that no longer matches.
            const paraMatch = !prefs.bionicReading && syncTarget.progress.match(/\/p\[(\d+)\]/);
            let navigated = false;
            if (paraMatch) {
              const guessCfi = `epubcfi(/6/${(spineIdx + 1) * 2}!/4/${parseInt(paraMatch[1]) * 2})`;
              console.log('[kosync] trying best-effort CFI', guessCfi);
              try { await rendition.display(guessCfi); navigated = true; } catch { navigated = false; }
            }
            if (!navigated) {
              console.log('[kosync] navigating to spine item', spineIdx, spineItem.href, '(chapter start — no position recovery yet)');
              console.log('[kosync] NOTE: bionic is', prefs.bionicReading ? 'ON' : 'OFF', '— will seek by pct after display if bionic');
              await rendition.display(spineItem.href);
              const locAfterNav = rendition.currentLocation();
              console.log('[kosync] after display(href) cfi:', locAfterNav?.start?.cfi?.slice(0,80), 'pct:', ((locAfterNav?.start?.percentage||0)*100).toFixed(2)+'%');
              if (prefs.bionicReading && book.locations.length() > 0) {
                console.log('[kosync] bionic ON — doing seekToPercentage(', (syncTarget.percentage*100).toFixed(2)+'%', ') after chapter nav');
                await seekToPercentage(syncTarget.percentage);
              }
            }
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
          // No DocFragment info (no xpointer or unknown format) — fall back to percentage
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

    // Capture final position after all navigation (local seek + sync) is complete.
    // The `relocated` event is suppressed while isReady=false, so any navigation
    // that happened above (seekToPercentage / sync jump) may not have updated
    // currentCfi/currentPct yet — read them directly from the rendition now.
    {
      const loc = rendition.currentLocation();
      if (loc?.start?.cfi) currentCfi = loc.start.cfi;
      if (book.locations?.length() > 0) {
        // Locations already generated (cached) — most accurate
        const pct = book.locations.percentageFromCfi(currentCfi);
        if (pct != null) currentPct = pct;
      } else if (localProgress?.percentage > 0) {
        // No locations cache — use server-saved percentage immediately.
        // This is the most reliable fallback: it's our own DB value and is
        // always available. epub.js returns 0 (not null) when locations aren't
        // loaded, so we check this BEFORE loc.start.percentage to avoid 0 winning.
        currentPct = localProgress.percentage;
      } else if (syncTarget?.percentage != null) {
        // Sync jump target — positions differed so user chose to jump here.
        currentPct = syncTarget.percentage;
      } else if (loc?.start?.percentage > 0) {
        // epub.js estimate — only trust it when > 0 (0 means locations not loaded)
        currentPct = loc.start.percentage;
      } else if (loc?.start?.index != null) {
        // Last resort: rough spine-position estimate
        const total = book.spine?.spineItems?.length || book.spine?.length || 1;
        currentPct = (loc.start.index + 1) / total;
      }
      console.log('[pos] final position before isReady cfi:', currentCfi.slice(0,60), 'pct:', (currentPct*100).toFixed(2)+'%');
    }
    // Only allow saves after the initial position (local or synced) is fully displayed
    console.log('[pos] isReady=true, currentCfi:', currentCfi.slice(0,60));
    isReady = true;
    openCfi = currentCfi; // snapshot position-on-open for change detection
        // Load bookmarks and annotations for this book (non-blocking)
    void loadBookmarks(currentBook.id);
    void loadAnnotations(currentBook.id);
    // Start a stats session (non-blocking)
    void startStatsSession(currentBook.id);    
    // Final chapter-name refresh — by now TOC and relocated have both fired
    if (lastChapterHref) {
      chapterTitleEl.textContent = chapterLabelFromHref(lastChapterHref);
    }
    // Immediately render correct pctBook (and other stats) into the status bar.
    // Without this, pctBook stays 0% until the next relocated event or 30s clock tick.
    updateStatusBar(rendition.currentLocation());
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
