import { useState, useEffect, useCallback, useRef } from 'react';
import { usePublication, StatefulReader, useEpubNavigator } from '@edrlab/thorium-web/epub';

async function fetchAccessToken(bookId, jwt) {
  const r = await fetch(`/api/readium/${bookId}/access-token`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) throw new Error(`access-token ${r.status}`);
  const { token } = await r.json();
  return token;
}

// ── Themes ────────────────────────────────────────────────────────────────────
const THEMES = {
  dark:  { bg: '#1a1a2e', text: '#d8d8e8', link: '#e94560',
           ui: '#22223a', border: 'rgba(216,216,232,0.12)', muted: '#9a9ab0', accent: '#e94560' },
  light: { bg: '#f9f9f6', text: '#1a1a1a', link: '#c73652',
           ui: '#f2f2ef', border: 'rgba(26,26,26,0.12)',   muted: '#6b6b6b', accent: '#c73652' },
  sepia: { bg: '#f4ecd8', text: '#3e2e1a', link: '#8b4513',
           ui: '#eddfca', border: 'rgba(62,46,26,0.15)',   muted: '#7a5e40', accent: '#8b4513' },
};

const PREFS_KEY = 'br_v3_prefs';
const DEFAULT_PREFS = {
  fontSize: 1.0,
  theme: 'sepia',
  lineHeight: null,
  fontFamily: '',
  textAlign: null,
  hyphens: false,
  scroll: false,
  columnCount: null,
  wordSpacing: null,
  letterSpacing: null,
  paragraphIndent: null,
  paragraphSpacing: null,
};

// ── Font utilities ────────────────────────────────────────────────────────────
const SYSTEM_FONTS = [
  { label: 'Default',         value: '' },
  { label: 'Georgia',         value: 'Georgia, serif' },
  { label: 'Palatino',        value: '"Palatino Linotype", Palatino, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Arial',           value: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana',         value: 'Verdana, Geneva, sans-serif' },
  { label: 'Courier New',     value: '"Courier New", Courier, monospace' },
];

function fontFamilyFromFilename(f) {
  return f
    .replace(/\.(ttf|otf|woff2?)$/i, '')
    .replace(/[-_ ]?(bold[-_ ]?italic|bolditalic|extrabold|extralight|semibold|ultralight|ultrabold|bold|italic|oblique|regular|light|thin|medium|black|heavy|condensed|expanded)$/i, '')
    .replace(/[-_]/g, ' ')
    .trim();
}
function fontWeightFromFilename(f) {
  const l = f.toLowerCase();
  if (/thin/.test(l))                                    return '100';
  if (/extralight|extra.light|ultralight|ultra.light/.test(l)) return '200';
  if (/light/.test(l))                                   return '300';
  if (/medium/.test(l))                                  return '500';
  if (/semibold|semi.bold|demibold/.test(l))             return '600';
  if (/extrabold|extra.bold|ultrabold|ultra.bold/.test(l)) return '800';
  if (/black|heavy/.test(l))                             return '900';
  if (/bold/.test(l))                                    return 'bold';
  return 'normal';
}
function fontStyleFromFilename(f) {
  return /italic|oblique/i.test(f) ? 'italic' : 'normal';
}
function fontFormatFromExt(f) {
  const e = f.split('.').pop().toLowerCase();
  return { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[e] || 'truetype';
}

function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p) { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); }

// CSS injected to suppress Thorium's built-in chrome.
const THORIUM_HIDE_CSS = `
  .thorium_web_reader_app_topBar,
  .thorium_web_reader_app_barOverlay,
  .thorium_web_reader_app_headerOverlay,
  .thorium_web_reader_app_bottomBar,
  .thorium_web_reader_app_footerOverlay,
  .thorium_web_reader_paginatedArrow_container,
  .thorium_web_reader_app_leftDock,
  .thorium_web_reader_app_rightDock,
  .thorium_web_docking_resizeHandle {
    display: none !important;
  }

  .thorium_web_reader_app_main {
    width: 100% !important;
    height: 100% !important;
    display: flex !important;
  }

  .thorium_web_reader_app_shell {
    flex: 1 1 0 !important;
    min-width: 0 !important;
    height: 100% !important;
    display: flex !important;
    flex-direction: column !important;
  }

  .thorium_web_reader_app_wrapper {
    flex: 1 1 0 !important;
    min-height: 0 !important;
    width: 100% !important;
  }

  .thorium_web_reader_app_iframeContainer {
    width: 100% !important;
    height: 100% !important;
  }

  .readium-navigator-iframe {
    width: 100% !important;
    height: 100% !important;
    pointer-events: auto !important;
  }
`;

// ── Custom overlay ────────────────────────────────────────────────────────────
function Overlay({ title, publication, prefs, onUpdatePrefs, accessToken, bookId }) {
  const [headerVisible, setHeaderVisible] = useState(true);
  const [settingsOpen, setSettingsOpen]   = useState(false);
  const [tocOpen, setTocOpen]             = useState(false);
  const [searchOpen, setSearchOpen]       = useState(false);
  const [searchQuery, setSearchQuery]     = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchStatus, setSearchStatus]   = useState('');
  const [hasPreSearchPos, setHasPreSearchPos] = useState(false);
  const hideTimer = useRef(null);

  const { submitPreferences, goLink, go, goLeft, goRight, goBackward, goForward, currentLocator } = useEpubNavigator();

  const theme = THEMES[prefs.theme] || THEMES.sepia;

  // Keep _readium_blockEvents permanently false — Thorium sets it true because
  // our layout CSS prevents its ResizeObserver from firing the "ready" signal.
  useEffect(() => {
    try {
      Object.defineProperty(window, '_readium_blockEvents', {
        configurable: true, enumerable: true,
        get: () => false, set: () => {},
      });
    } catch {}
  }, []);


  const buildNavPrefs = useCallback((p) => {
    const t = THEMES[p.theme] || THEMES.sepia;
    return {
      fontSize:        p.fontSize  ?? 1.0,
      lineHeight:      p.lineHeight ?? null,
      fontFamily:      p.fontFamily || null,
      textAlign:       p.textAlign ?? null,
      hyphens:         typeof p.hyphens === 'boolean' ? p.hyphens : null,
      scroll:          typeof p.scroll === 'boolean' ? p.scroll : null,
      columnCount:     p.columnCount != null ? p.columnCount : null,
      wordSpacing:     p.wordSpacing ?? null,
      letterSpacing:   p.letterSpacing ?? null,
      paragraphIndent: p.paragraphIndent ?? null,
      paragraphSpacing:p.paragraphSpacing ?? null,
      backgroundColor: t.bg,
      textColor:       t.text,
      linkColor:       t.link,
    };
  }, []);

  const applyPrefs = useCallback((p) => {
    const result = submitPreferences(buildNavPrefs(p));
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }, [submitPreferences, buildNavPrefs]);

  const navCooldown       = useRef(false);
  const overlayRef        = useRef(null);
  const initialRevealDone = useRef(false);
  const preSearchLocator  = useRef(null);
  const searchAbortRef    = useRef(null);
  const searchInputRef    = useRef(null);

  const showOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.style.transition    = 'none';
    overlay.style.opacity       = '1';
    overlay.style.pointerEvents = 'auto';
  }, []);

  // delay: how long to hold the opaque overlay after Thorium's callback fires.
  // Backward navigation needs more time — Thorium has to reposition to chapter end
  // before we reveal, otherwise the repositioning blinks through the fade.
  const hideOverlay = useCallback((delay = 250) => {
    setTimeout(() => {
      const overlay = overlayRef.current;
      if (overlay) {
        overlay.style.transition    = 'opacity 0.3s ease';
        overlay.style.opacity       = '0';
        overlay.style.pointerEvents = 'none';
      }
      setTimeout(() => { navCooldown.current = false; }, 350);
    }, delay);
  }, []);

  const navigate = useCallback((direction) => {
    if (navCooldown.current) return;
    navCooldown.current = true;
    window._readium_blockEvents = false;

    const doChapterNav = () => {
      showOverlay();
      const fn = direction < 0 ? goBackward : goForward;
      // Backward: hold overlay longer so Thorium can finish repositioning to chapter end
      const delay = direction < 0 ? 450 : 250;
      let settled = false;
      fn(false, () => { if (!settled) { settled = true; hideOverlay(delay); } });
      setTimeout(() => { if (!settled) { settled = true; hideOverlay(delay); } }, 800);
    };

    if (prefs.scroll) {
      doChapterNav();
    } else {
      const pageFn = direction < 0 ? goLeft : goRight;
      let settled = false;
      pageFn(false, (ok) => {
        if (settled) return;
        settled = true;
        if (ok) {
          navCooldown.current = false;
        } else {
          doChapterNav();
        }
      });
      setTimeout(() => { if (!settled) { settled = true; doChapterNav(); } }, 450);
    }
  }, [showOverlay, hideOverlay, goLeft, goRight, goBackward, goForward, prefs.scroll]);

  // One-time initial reveal: Thorium's ready signal never fires because our CSS
  // layout prevents its ResizeObserver from triggering. We poll until we find
  // the hidden first iframe and reveal it with an inline style (no !important),
  // then stop — Thorium manages opacity normally for all subsequent transitions.
  useEffect(() => {
    let pollId;
    const tryReveal = () => {
      if (initialRevealDone.current || navCooldown.current) return;
      const iframes = document.querySelectorAll('.readium-navigator-iframe');
      if (!iframes.length) return;
      let revealed = false;
      iframes.forEach(iframe => {
        if (parseFloat(getComputedStyle(iframe).opacity) < 0.5) {
          iframe.style.opacity = '1';
          iframe.style.visibility = 'visible';
          revealed = true;
        }
      });
      if (revealed) {
        initialRevealDone.current = true;
        clearInterval(pollId);
      }
    };
    pollId = setInterval(tryReveal, 150);
    const giveUp = setTimeout(() => clearInterval(pollId), 8000);
    return () => { clearInterval(pollId); clearTimeout(giveUp); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Active chapter tracking ───────────────────────────────────────────────────
  const [activeHref, setActiveHref] = useState(null);

  useEffect(() => {
    const id = setInterval(() => {
      const loc = currentLocator?.();
      if (!loc?.href) return;
      const href = loc.href.split('#')[0];
      setActiveHref(prev => prev === href ? prev : href);
    }, 500);
    return () => clearInterval(id);
  }, [currentLocator]);

  // ── Custom fonts ──────────────────────────────────────────────────────────────
  const [customFonts, setCustomFonts] = useState([]);
  const [fontFaceCSS, setFontFaceCSS] = useState('');

  useEffect(() => {
    const jwt = localStorage.getItem('br_token');
    if (!jwt) return;
    fetch('/api/fonts', { headers: { Authorization: `Bearer ${jwt}` } })
      .then(r => r.ok ? r.json() : [])
      .then(files => {
        if (!files.length) return;
        const families = {};
        files.forEach(f => {
          const fam = fontFamilyFromFilename(f);
          if (!families[fam]) families[fam] = [];
          families[fam].push(f);
        });
        const cssLines = [];
        const fonts = [];
        Object.entries(families).forEach(([family, ffiles]) => {
          ffiles.forEach(f => {
            cssLines.push(
              `@font-face { font-family: "${family}"; src: url("/user-fonts/${encodeURIComponent(f)}") format("${fontFormatFromExt(f)}"); font-weight: ${fontWeightFromFilename(f)}; font-style: ${fontStyleFromFilename(f)}; }`
            );
          });
          fonts.push({ label: family, value: `"${family}", Georgia, serif` });
        });
        setFontFaceCSS(cssLines.join('\n'));
        setCustomFonts(fonts);
      })
      .catch(() => {});
  }, []);

  // Inject @font-face declarations into every epub iframe so custom fonts render.
  // Runs whenever fontFaceCSS changes and re-runs when new iframes are added.
  useEffect(() => {
    if (!fontFaceCSS) return;
    const inject = () => {
      document.querySelectorAll('iframe').forEach(f => {
        try {
          const doc = f.contentDocument;
          if (!doc?.head) return;
          let el = doc.getElementById('v3-custom-fonts');
          if (!el) {
            el = doc.createElement('style');
            el.id = 'v3-custom-fonts';
            doc.head.appendChild(el);
          }
          el.textContent = fontFaceCSS;
        } catch {}
      });
    };
    inject();
    const observer = new MutationObserver(() => setTimeout(inject, 300));
    const container = document.querySelector('.thorium_web_reader_app_iframeContainer');
    if (container) observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [fontFaceCSS]);

  // Auto-advance when the reader scrolls past the end of a chapter.
  // Re-attaches whenever Thorium swaps the active iframe (style attribute change).
  useEffect(() => {
    let scrollCleanup = () => {};
    const attachToIframe = () => {
      scrollCleanup();
      const f = document.querySelector('iframe');
      if (!f) return;
      try {
        const win = f.contentWindow;
        const doc = f.contentDocument;
        if (!win || !doc) return;
        const onScroll = () => {
          const { scrollY, innerHeight } = win;
          if (scrollY + innerHeight >= doc.documentElement.scrollHeight - 20) navigate(1);
        };
        win.addEventListener('scroll', onScroll, { passive: true });
        scrollCleanup = () => win.removeEventListener('scroll', onScroll);
      } catch {}
    };
    attachToIframe();
    const observer = new MutationObserver(() => setTimeout(attachToIframe, 300));
    const container = document.querySelector('.thorium_web_reader_app_iframeContainer');
    if (container) observer.observe(container, { attributes: true, subtree: true, attributeFilter: ['style'] });
    return () => { observer.disconnect(); scrollCleanup(); };
  }, [navigate]);

  const updatePrefs = useCallback((patch) => {
    const next = { ...prefs, ...patch };
    savePrefs(next);
    onUpdatePrefs(next);
    applyPrefs(next);
  }, [prefs, onUpdatePrefs, applyPrefs]);

  // Keep a ref so the stable onKey closure always calls the current navigate.
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  // Keyboard navigation — attached to both the main window and every epub iframe
  // contentWindow, so it keeps working after the user clicks inside the text
  // (which moves browser focus into the iframe document).
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft')  navigateRef.current(-1);
      if (e.key === 'ArrowRight') navigateRef.current(1);
    };

    window.addEventListener('keydown', onKey);

    const attachToIframes = () => {
      document.querySelectorAll('.readium-navigator-iframe, iframe').forEach(f => {
        try {
          const win = f.contentWindow;
          const doc = f.contentDocument;
          if (win) win.addEventListener('keydown', onKey, true);
          if (doc) doc.addEventListener('keydown', onKey, true);
        } catch {}
      });
    };
    attachToIframes();

    const observer = new MutationObserver(() => setTimeout(attachToIframes, 200));
    const container = document.querySelector('.thorium_web_reader_app_iframeContainer');
    if (container) observer.observe(container, { childList: true, subtree: true });

    return () => {
      window.removeEventListener('keydown', onKey);
      document.querySelectorAll('.readium-navigator-iframe, iframe').forEach(f => {
        try {
          const win = f.contentWindow;
          const doc = f.contentDocument;
          if (win) win.removeEventListener('keydown', onKey, true);
          if (doc) doc.removeEventListener('keydown', onKey, true);
        } catch {}
      });
      observer.disconnect();
    };
  }, []); // stable — navigate is read through navigateRef

  // Poll until navigator accepts initial preferences
  useEffect(() => {
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      applyPrefs(prefs);
      if (tries >= 15) clearInterval(interval);
    }, 400);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Search ────────────────────────────────────────────────────────────────────

  const clearSearchHighlights = useCallback(() => {
    document.querySelectorAll('iframe').forEach(f => {
      try {
        const doc = f.contentDocument;
        if (!doc?.body) return;
        doc.querySelectorAll('mark.v3-hl').forEach(mark => {
          const text = mark.ownerDocument.createTextNode(mark.textContent);
          mark.parentNode.replaceChild(text, mark);
        });
        doc.body.normalize();
      } catch {}
    });
  }, []);

  const applySearchHighlight = useCallback((query) => {
    if (!query) return;
    const lq = query.toLowerCase();
    document.querySelectorAll('iframe').forEach(f => {
      try {
        const doc = f.contentDocument;
        if (!doc?.body) return;
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null, false);
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) {
          if (n.nodeValue.toLowerCase().includes(lq)) nodes.push(n);
        }
        nodes.forEach(textNode => {
          const parent = textNode.parentNode;
          if (!parent || ['SCRIPT', 'STYLE', 'MARK'].includes(parent.nodeName)) return;
          const text = textNode.nodeValue;
          const ltext = text.toLowerCase();
          const parts = [];
          let last = 0;
          let idx;
          while ((idx = ltext.indexOf(lq, last)) !== -1) {
            if (idx > last) parts.push(doc.createTextNode(text.slice(last, idx)));
            const mark = doc.createElement('mark');
            mark.className = 'v3-hl';
            mark.style.cssText = 'background:#ff0;color:#000;border-radius:2px;';
            mark.textContent = text.slice(idx, idx + lq.length);
            parts.push(mark);
            last = idx + lq.length;
          }
          if (last < text.length) parts.push(doc.createTextNode(text.slice(last)));
          if (parts.length > 1) {
            const frag = doc.createDocumentFragment();
            parts.forEach(p => frag.appendChild(p));
            parent.replaceChild(frag, textNode);
          }
        });
      } catch {}
    });
  }, []);

  const runSearch = useCallback(async (query) => {
    if (!query.trim() || !publication) return;
    const abort = { aborted: false };
    searchAbortRef.current = abort;
    setSearchResults([]);
    setSearchStatus('Searching…');

    const items = publication.manifest?.readingOrder?.items || [];
    const tocMap = {};
    const flattenToc = (arr) => {
      if (!arr) return;
      arr.forEach(item => {
        if (item.href) tocMap[item.href.split('#')[0]] = item.title || item.label || '';
        const ch = item.children?.items ?? (Array.isArray(item.children) ? item.children : []);
        if (ch.length) flattenToc(ch);
      });
    };
    flattenToc(publication.manifest?.toc?.items || []);

    const baseUrl = `${window.location.origin}/api/readium/${accessToken}/${bookId}/`;
    const lq = query.toLowerCase();
    const allResults = [];

    for (let i = 0; i < items.length; i++) {
      if (abort.aborted) break;
      const item = items[i];
      const href = item.href || '';
      const chapterHref = href.split('#')[0];
      const chapterTitle = tocMap[chapterHref] || href || `Section ${i + 1}`;

      try {
        const url = new URL(href, baseUrl).href;
        const resp = await fetch(url);
        if (!resp.ok || abort.aborted) continue;
        const html = await resp.text();
        if (abort.aborted) break;

        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const text = (parsed.body?.textContent || '').replace(/\s+/g, ' ').trim();
        const ltext = text.toLowerCase();
        let pos = 0;
        let count = 0;
        let idx;
        while ((idx = ltext.indexOf(lq, pos)) !== -1 && count < 5) {
          const start = Math.max(0, idx - 60);
          const end   = Math.min(text.length, idx + lq.length + 60);
          const excerpt = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
          allResults.push({ id: `${i}-${count}`, href: chapterHref, chapterTitle, excerpt, matchText: text.slice(idx, idx + lq.length), item });
          pos = idx + lq.length;
          count++;
        }
      } catch {}

      if (!abort.aborted) setSearchStatus(`Searching… ${i + 1}/${items.length}`);
    }

    if (!abort.aborted) {
      setSearchResults(allResults);
      setSearchStatus(allResults.length
        ? `${allResults.length} result${allResults.length !== 1 ? 's' : ''}`
        : 'No results found.');
    }
  }, [publication, accessToken, bookId]);

  const jumpToSearchResult = useCallback((result, query) => {
    if (navCooldown.current) return;
    if (!preSearchLocator.current) {
      preSearchLocator.current = currentLocator?.();
      setHasPreSearchPos(true);
    }
    navCooldown.current = true;
    showOverlay();
    clearSearchHighlights();
    goLink(result.item, false, () => {
      setTimeout(() => {
        applySearchHighlight(query);
        hideOverlay(300);
      }, 150);
    });
  }, [showOverlay, clearSearchHighlights, goLink, applySearchHighlight, hideOverlay, currentLocator]);

  const handleSearchBack = useCallback(() => {
    if (!preSearchLocator.current || navCooldown.current) return;
    navCooldown.current = true;
    showOverlay();
    clearSearchHighlights();
    const loc = preSearchLocator.current;
    preSearchLocator.current = null;
    setHasPreSearchPos(false);
    if (typeof go === 'function') {
      go(loc, false, () => hideOverlay(300));
    } else {
      hideOverlay(300);
    }
  }, [go, showOverlay, clearSearchHighlights, hideOverlay]);

  // Focus search input when panel opens
  useEffect(() => {
    if (searchOpen) setTimeout(() => searchInputRef.current?.focus(), 100);
  }, [searchOpen]);

  // ── Auto-hide header ──────────────────────────────────────────────────────────
  const showHeader = useCallback(() => {
    setHeaderVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!settingsOpen && !searchOpen) setHeaderVisible(false);
    }, 3500);
  }, [settingsOpen, searchOpen]);

  useEffect(() => {
    hideTimer.current = setTimeout(() => setHeaderVisible(false), 3500);
    return () => clearTimeout(hideTimer.current);
  }, []);

  const handleSettingsToggle = useCallback(() => {
    setSearchOpen(false);
    setSettingsOpen(o => {
      const next = !o;
      if (!next) {
        hideTimer.current = setTimeout(() => setHeaderVisible(false), 2500);
      } else {
        clearTimeout(hideTimer.current);
      }
      return next;
    });
    showHeader();
  }, [showHeader]);

  const handleSearchToggle = useCallback(() => {
    setSettingsOpen(false);
    setSearchOpen(o => {
      const next = !o;
      if (next) clearTimeout(hideTimer.current);
      else hideTimer.current = setTimeout(() => setHeaderVisible(false), 2500);
      return next;
    });
    showHeader();
  }, [showHeader]);

  const headerBg = `${theme.bg}cc`;
  const S = {
    wrap: {
      position: 'absolute', inset: 0, pointerEvents: 'none',
      fontFamily: 'system-ui, sans-serif',
    },
    sensor: {
      position: 'absolute', top: 0, left: 0, right: 0, height: 8,
      pointerEvents: 'auto', cursor: 'default', zIndex: 200,
    },
    header: {
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
      pointerEvents: 'auto',
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '6px 12px',
      background: headerBg,
      backdropFilter: 'blur(8px)',
      borderBottom: `1px solid ${theme.border}`,
      color: theme.text,
      transition: 'transform 0.25s ease',
      transform: headerVisible ? 'translateY(0)' : 'translateY(-100%)',
    },
    btnIcon: {
      background: 'none', border: 'none', cursor: 'pointer',
      color: theme.text, padding: '6px 8px', borderRadius: 6,
      fontSize: 16, lineHeight: 1, flexShrink: 0,
    },
    title: {
      flex: 1, textAlign: 'center', overflow: 'hidden',
      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      fontSize: 14, color: theme.muted, letterSpacing: '0.02em',
    },
    navLeft: {
      position: 'absolute', top: '10%', left: 0, bottom: '10%', width: '4%',
      minWidth: 44, maxWidth: 52,
      pointerEvents: 'auto', cursor: 'default', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
    },
    navRight: {
      position: 'absolute', top: '10%', right: 0, bottom: '10%', width: '4%',
      minWidth: 44, maxWidth: 52,
      pointerEvents: 'auto', cursor: 'default', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    },
    navArrow: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '100%', height: '100%',
      fontSize: 28, color: theme.text, opacity: 0, padding: '8px 0',
      transition: 'opacity 0.15s', userSelect: 'none', cursor: 'pointer',
    },
    panel: {
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 300,
      zIndex: 150, pointerEvents: 'auto',
      background: theme.ui, color: theme.text,
      borderLeft: `1px solid ${theme.border}`,
      boxShadow: '-4px 0 24px rgba(0,0,0,.2)',
      display: 'flex', flexDirection: 'column',
      transform: settingsOpen ? 'translateX(0)' : 'translateX(100%)',
      transition: 'transform 0.25s ease',
    },
    searchPanel: {
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 320,
      zIndex: 150, pointerEvents: 'auto',
      background: theme.ui, color: theme.text,
      borderLeft: `1px solid ${theme.border}`,
      boxShadow: '-4px 0 24px rgba(0,0,0,.2)',
      display: 'flex', flexDirection: 'column',
      transform: searchOpen ? 'translateX(0)' : 'translateX(100%)',
      transition: 'transform 0.25s ease',
    },
    searchInputRow: {
      padding: '12px 16px',
      borderBottom: `1px solid ${theme.border}`,
      display: 'flex', gap: 8,
    },
    searchInput: {
      flex: 1, padding: '8px 10px', borderRadius: 6, fontSize: 14,
      border: `1px solid ${theme.border}`,
      background: theme.bg, color: theme.text,
      outline: 'none',
    },
    searchSubmitBtn: {
      padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
      border: 'none', background: theme.accent, color: '#fff', flexShrink: 0,
      fontWeight: 600,
    },
    searchStatus: {
      fontSize: 12, color: theme.muted, padding: '6px 16px',
      borderBottom: `1px solid ${theme.border}`,
    },
    searchResults: {
      flex: 1, overflowY: 'auto',
    },
    searchResult: {
      padding: '12px 16px', cursor: 'pointer',
      borderBottom: `1px solid ${theme.border}`,
    },
    searchResultTitle: {
      fontSize: 11, fontWeight: 700, color: theme.accent,
      marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em',
    },
    searchResultExcerpt: {
      fontSize: 13, color: theme.text, lineHeight: 1.5,
    },
    panelHead: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px',
      borderBottom: `1px solid ${theme.border}`,
    },
    panelTitle: { margin: 0, fontSize: 16, fontWeight: 600 },
    panelBody: { padding: 16, overflowY: 'auto', flex: 1 },
    row: { marginBottom: 20 },
    label: { display: 'block', fontSize: 12, color: theme.muted, marginBottom: 6, letterSpacing: '0.05em', textTransform: 'uppercase' },
    slider: { width: '100%', accentColor: theme.accent },
    themeRow: { display: 'flex', gap: 8 },
    themeBtn: (name) => ({
      flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      border: `2px solid ${prefs.theme === name ? theme.accent : theme.border}`,
      background: THEMES[name].bg, color: THEMES[name].text,
      fontWeight: prefs.theme === name ? 700 : 400,
    }),
    fontGrid: {
      display: 'flex', flexWrap: 'wrap', gap: 6,
    },
    fontBtn: (fontValue, previewFont) => ({
      padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
      fontFamily: previewFont || 'inherit',
      border: `2px solid ${prefs.fontFamily === fontValue ? theme.accent : theme.border}`,
      background: prefs.fontFamily === fontValue ? theme.accent + '22' : 'transparent',
      color: theme.text,
      whiteSpace: 'nowrap',
    }),
    fontDivider: {
      fontSize: 11, color: theme.muted, textTransform: 'uppercase',
      letterSpacing: '0.05em', margin: '8px 0 6px',
    },
    optionBtn: (active) => ({
      padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      border: `2px solid ${active ? theme.accent : theme.border}`,
      background: active ? theme.accent + '22' : 'transparent',
      color: theme.text,
      whiteSpace: 'nowrap',
      minWidth: 64,
    }),
    closeBtn: {
      background: 'none', border: 'none', cursor: 'pointer',
      color: theme.muted, fontSize: 20, lineHeight: 1, padding: 4,
    },
    headerLeft: { display: 'flex', alignItems: 'center', gap: 8 },
    headerRight: { display: 'flex', alignItems: 'center', gap: 4 },
    tocBackdrop: {
      position: 'absolute', inset: 0, zIndex: 150,
      pointerEvents: tocOpen ? 'auto' : 'none',
      opacity: tocOpen ? 1 : 0,
      background: 'rgba(0,0,0,0.25)',
      transition: 'opacity 0.25s',
    },
    tocPanel: {
      position: 'absolute', top: 0, left: 0, bottom: 0,
      width: 320, zIndex: 160, padding: 16,
      pointerEvents: 'auto',
      background: theme.bg, color: theme.text,
      boxShadow: '4px 0 24px rgba(0,0,0,0.15)',
      transform: tocOpen ? 'translateX(0)' : 'translateX(-100%)',
      transition: 'transform 0.25s ease',
      overflowY: 'auto',
    },
    tocPanelHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
    tocPanelTitle: { margin: 0, fontSize: 16, fontWeight: 700 },
    tocItem: (active) => ({
      width: '100%', textAlign: 'left',
      padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
      fontSize: 14, lineHeight: 1.4,
      border: `1px solid ${active ? theme.accent : theme.border}`,
      background: active ? `${theme.accent}22` : 'none',
      color: active ? theme.accent : theme.text,
      fontWeight: active ? 600 : 400,
    }),
    tocEmpty: {
      color: theme.muted, fontSize: 13, marginTop: 10,
    },
    backdrop: {
      position: 'absolute', inset: 0, zIndex: 140,
      pointerEvents: (settingsOpen || searchOpen) ? 'auto' : 'none',
      opacity: (settingsOpen || searchOpen) ? 1 : 0,
      background: 'rgba(0,0,0,0.3)',
      transition: 'opacity 0.25s',
    },
  };

  const NavArrow = ({ children, side, onClick }) => {
    const [hovered, setHovered] = useState(false);
    const stop = (e) => e.stopPropagation();
    return (
      <div
        style={side === 'left' ? S.navLeft : S.navRight}
        onClick={(e) => { stop(e); onClick(); }}
        onMouseDown={stop}
        onMouseUp={stop}
        onTouchStart={stop}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span style={{ ...S.navArrow, opacity: hovered ? 0.5 : 0 }}>{children}</span>
      </div>
    );
  };

  const tocItems = publication?.manifest?.toc?.items || publication?.manifest?.readingOrder?.items || [];

  const renderTocItems = (items, level = 0) => {
    if (!items || items.length === 0) return null;
    return items.map((item) => {
      const title = item.title || item.label || item.href || 'Untitled';
      const childItems = item.children?.items ?? (Array.isArray(item.children) ? item.children : null);
      const isActive = !!activeHref && item.href === activeHref;
      return (
        <div key={`${item.href}-${title}`} style={{ marginLeft: level * 14, marginBottom: 4 }}>
          <button
            style={S.tocItem(isActive)}
            onClick={() => {
              if (!item.href || !goLink || navCooldown.current) return;
              setTocOpen(false);
              setSearchOpen(false);
              navCooldown.current = true;
              showOverlay();
              goLink(item, false, () => { hideOverlay(300); });
            }}
          >
            {title}
          </button>
          {renderTocItems(childItems, level + 1)}
        </div>
      );
    });
  };

  const renderExcerpt = (excerpt, query) => {
    if (!query) return excerpt;
    const lq = query.toLowerCase();
    const parts = [];
    let remaining = excerpt;
    let key = 0;
    while (remaining.length > 0) {
      const idx = remaining.toLowerCase().indexOf(lq);
      if (idx === -1) { parts.push(<span key={key++}>{remaining}</span>); break; }
      if (idx > 0) parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
      parts.push(
        <mark key={key++} style={{ background: '#ff0', color: '#000', borderRadius: 2 }}>
          {remaining.slice(idx, idx + lq.length)}
        </mark>
      );
      remaining = remaining.slice(idx + lq.length);
    }
    return parts;
  };

  return (
    <div style={S.wrap} onMouseMove={showHeader} onTouchStart={showHeader}>
      <div style={S.sensor} onMouseEnter={showHeader} onTouchStart={showHeader} />

      <header style={S.header}>
        <div style={S.headerLeft}>
          <button style={S.btnIcon} onClick={() => { setTocOpen(true); setSearchOpen(false); setSettingsOpen(false); }} title="Table of contents">☰</button>
        </div>
        <div style={S.title}>{title}</div>
        <div style={S.headerRight}>
          {hasPreSearchPos && (
            <button style={S.btnIcon} onClick={handleSearchBack} title="Back to position before search">↩</button>
          )}
          <button style={{ ...S.btnIcon, color: searchOpen ? theme.accent : theme.text }} onClick={handleSearchToggle} title="Search">🔍</button>
          <button style={S.btnIcon} onClick={handleSettingsToggle} title="Reading settings">⚙</button>
          <button style={S.btnIcon} onClick={() => { window.location.href = '/index.html'; }} title="Back to library">←</button>
        </div>
      </header>

      <NavArrow side="left"  onClick={() => navigate(-1)}>‹</NavArrow>
      <NavArrow side="right" onClick={() => navigate(1)}>›</NavArrow>

      {/* Chapter-transition overlay — appears instantly, fades out after new chapter renders */}
      <div ref={overlayRef} style={{
        position: 'absolute', inset: 0, zIndex: 10,
        background: theme.bg, opacity: 0, pointerEvents: 'none',
      }} />

      <div style={S.backdrop} onClick={() => { setSettingsOpen(false); setSearchOpen(false); }} />
      <div style={S.tocBackdrop} onClick={() => setTocOpen(false)} />

      <aside style={S.tocPanel}>
        <div style={S.tocPanelHeader}>
          <h2 style={S.tocPanelTitle}>Table of contents</h2>
          <button style={S.closeBtn} onClick={() => setTocOpen(false)}>×</button>
        </div>
        {tocItems.length > 0 ? renderTocItems(tocItems) : (
          <div style={S.tocEmpty}>No table of contents available.</div>
        )}
      </aside>

      {/* Search panel */}
      <aside style={S.searchPanel}>
        <div style={S.panelHead}>
          <h2 style={S.panelTitle}>Search</h2>
          <button style={S.closeBtn} onClick={() => setSearchOpen(false)}>×</button>
        </div>
        <form
          style={S.searchInputRow}
          onSubmit={(e) => {
            e.preventDefault();
            if (searchAbortRef.current) searchAbortRef.current.aborted = true;
            runSearch(searchQuery);
          }}
        >
          <input
            ref={searchInputRef}
            style={S.searchInput}
            type="text"
            placeholder="Search in book…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          <button type="submit" style={S.searchSubmitBtn}>Go</button>
        </form>
        {searchStatus ? <div style={S.searchStatus}>{searchStatus}</div> : null}
        <div style={S.searchResults}>
          {searchResults.map(result => (
            <div
              key={result.id}
              style={S.searchResult}
              onClick={() => jumpToSearchResult(result, searchQuery)}
              onMouseEnter={e => { e.currentTarget.style.background = theme.bg; }}
              onMouseLeave={e => { e.currentTarget.style.background = ''; }}
            >
              <div style={S.searchResultTitle}>{result.chapterTitle}</div>
              <div style={S.searchResultExcerpt}>{renderExcerpt(result.excerpt, searchQuery)}</div>
            </div>
          ))}
        </div>
      </aside>

      {/* Settings panel */}
      <aside style={S.panel}>
        <div style={S.panelHead}>
          <h2 style={S.panelTitle}>Reading settings</h2>
          <button style={S.closeBtn} onClick={() => setSettingsOpen(false)}>×</button>
        </div>
        <div style={S.panelBody}>

          <div style={S.row}>
            <span style={S.label}>Theme</span>
            <div style={S.themeRow}>
              {['light', 'sepia', 'dark'].map(name => (
                <button key={name} style={S.themeBtn(name)}
                  onClick={() => updatePrefs({ theme: name })}>
                  {name.charAt(0).toUpperCase() + name.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div style={S.row}>
            <span style={S.label}>Font family</span>
            <div style={S.fontGrid}>
              {SYSTEM_FONTS.map(({ label, value }) => (
                <button
                  key={label}
                  style={S.fontBtn(value, value)}
                  onClick={() => updatePrefs({ fontFamily: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            {customFonts.length > 0 && (
              <>
                <div style={S.fontDivider}>Custom fonts</div>
                <div style={S.fontGrid}>
                  {customFonts.map(({ label, value }) => (
                    <button
                      key={label}
                      style={S.fontBtn(value, value)}
                      onClick={() => updatePrefs({ fontFamily: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={S.row}>
            <label style={S.label}>
              Font size — {Math.round((prefs.fontSize ?? 1.0) * 100)}%
            </label>
            <input
              type="range" style={S.slider}
              min="0.7" max="2.5" step="0.05"
              value={prefs.fontSize ?? 1.0}
              onChange={e => updatePrefs({ fontSize: parseFloat(e.target.value) })}
            />
          </div>

          <div style={S.row}>
            <label style={S.label}>
              Line height — {prefs.lineHeight != null ? prefs.lineHeight.toFixed(1) : 'auto'}
            </label>
            <input
              type="range" style={S.slider}
              min="1.0" max="2.5" step="0.1"
              value={prefs.lineHeight ?? 1.5}
              onChange={e => updatePrefs({ lineHeight: parseFloat(e.target.value) })}
            />
            {prefs.lineHeight != null && (
              <button
                style={{ ...S.closeBtn, fontSize: 12, display: 'block', marginTop: 4, color: theme.accent }}
                onClick={() => updatePrefs({ lineHeight: null })}
              >
                Reset to auto
              </button>
            )}
          </div>

          <div style={S.row}>
            <span style={S.label}>Text alignment</span>
            <div style={S.themeRow}>
              <button style={S.optionBtn(prefs.textAlign == null)} onClick={() => updatePrefs({ textAlign: null })}>Publisher</button>
              <button style={S.optionBtn(prefs.textAlign === 'start')} onClick={() => updatePrefs({ textAlign: 'start' })}>Left</button>
              <button style={S.optionBtn(prefs.textAlign === 'justify')} onClick={() => updatePrefs({ textAlign: 'justify' })}>Justify</button>
            </div>
          </div>

          <div style={S.row}>
            <span style={S.label}>Hyphenation</span>
            <button style={S.optionBtn(prefs.hyphens)} onClick={() => updatePrefs({ hyphens: !prefs.hyphens })}>
              {prefs.hyphens ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          <div style={S.row}>
            <span style={S.label}>Layout</span>
            <div style={S.themeRow}>
              <button style={S.optionBtn(!prefs.scroll)} onClick={() => updatePrefs({ scroll: false })}>Paginated</button>
              <button style={S.optionBtn(prefs.scroll)} onClick={() => updatePrefs({ scroll: true })}>Scroll</button>
            </div>
          </div>

          <div style={S.row}>
            <span style={S.label}>Columns</span>
            <div style={S.themeRow}>
              <button style={S.optionBtn(prefs.columnCount == null)} onClick={() => updatePrefs({ columnCount: null })}>Auto</button>
              <button style={S.optionBtn(prefs.columnCount === 1)} onClick={() => updatePrefs({ columnCount: 1 })}>1</button>
              <button style={S.optionBtn(prefs.columnCount === 2)} onClick={() => updatePrefs({ columnCount: 2 })}>2</button>
            </div>
          </div>

          <div style={S.row}>
            <label style={S.label}>
              Word spacing — {prefs.wordSpacing != null ? `${prefs.wordSpacing.toFixed(2)}rem` : 'auto'}
            </label>
            <input
              type="range" style={S.slider}
              min="0" max="0.5" step="0.05"
              value={prefs.wordSpacing ?? 0}
              onChange={e => {
                const value = parseFloat(e.target.value);
                updatePrefs({ wordSpacing: Number.isFinite(value) ? value : null });
              }}
            />
            {prefs.wordSpacing != null && (
              <button
                style={{ ...S.closeBtn, fontSize: 12, display: 'block', marginTop: 4, color: theme.accent }}
                onClick={() => updatePrefs({ wordSpacing: null })}
              >
                Reset
              </button>
            )}
          </div>

          <div style={S.row}>
            <label style={S.label}>
              Letter spacing — {prefs.letterSpacing != null ? `${prefs.letterSpacing.toFixed(2)}rem` : 'auto'}
            </label>
            <input
              type="range" style={S.slider}
              min="0" max="0.25" step="0.01"
              value={prefs.letterSpacing ?? 0}
              onChange={e => {
                const value = parseFloat(e.target.value);
                updatePrefs({ letterSpacing: Number.isFinite(value) ? value : null });
              }}
            />
            {prefs.letterSpacing != null && (
              <button
                style={{ ...S.closeBtn, fontSize: 12, display: 'block', marginTop: 4, color: theme.accent }}
                onClick={() => updatePrefs({ letterSpacing: null })}
              >
                Reset
              </button>
            )}
          </div>

          <div style={S.row}>
            <label style={S.label}>
              Paragraph indent — {prefs.paragraphIndent != null ? `${prefs.paragraphIndent.toFixed(2)}rem` : 'auto'}
            </label>
            <input
              type="range" style={S.slider}
              min="0" max="1" step="0.05"
              value={prefs.paragraphIndent ?? 0}
              onChange={e => {
                const value = parseFloat(e.target.value);
                updatePrefs({ paragraphIndent: Number.isFinite(value) ? value : null });
              }}
            />
            {prefs.paragraphIndent != null && (
              <button
                style={{ ...S.closeBtn, fontSize: 12, display: 'block', marginTop: 4, color: theme.accent }}
                onClick={() => updatePrefs({ paragraphIndent: null })}
              >
                Reset
              </button>
            )}
          </div>

          <div style={S.row}>
            <label style={S.label}>
              Paragraph spacing — {prefs.paragraphSpacing != null ? `${prefs.paragraphSpacing.toFixed(2)}rem` : 'auto'}
            </label>
            <input
              type="range" style={S.slider}
              min="0" max="1" step="0.05"
              value={prefs.paragraphSpacing ?? 0}
              onChange={e => {
                const value = parseFloat(e.target.value);
                updatePrefs({ paragraphSpacing: Number.isFinite(value) ? value : null });
              }}
            />
            {prefs.paragraphSpacing != null && (
              <button
                style={{ ...S.closeBtn, fontSize: 12, display: 'block', marginTop: 4, color: theme.accent }}
                onClick={() => updatePrefs({ paragraphSpacing: null })}
              >
                Reset
              </button>
            )}
          </div>

        </div>
      </aside>
    </div>
  );
}

// ── Inner reader — only rendered once accessToken is available ────────────────
function ReaderInner({ bookId, accessToken }) {
  const manifestUrl = `${window.location.origin}/api/readium/${accessToken}/${bookId}/manifest.json`;

  const { publication, localDataKey, isLoading, error } = usePublication({
    url: manifestUrl,
    onError: (err) => console.error('[v3] usePublication error:', err),
  });

  // Prefs live here so the background color reacts to theme changes from Overlay.
  const [prefs, setPrefs] = useState(loadPrefs);
  const theme = THEMES[prefs.theme] || THEMES.sepia;

  const handleUpdatePrefs = useCallback((next) => {
    setPrefs(next);
  }, []);

  const title = (() => {
    const t = publication?.manifest?.metadata?.title;
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t?.getTranslation === 'function') return t.getTranslation('en') || '';
    return String(t) || '';
  })();

  const S = {
    error:  { padding: '2rem', background: theme.bg, color: theme.text,
              fontFamily: 'sans-serif', minHeight: '100vh' },
    link:   { color: theme.link },
    center: { display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100vh', background: theme.bg, color: theme.text, fontFamily: 'sans-serif' },
    wrap:   { width: '100vw', height: '100vh', overflow: 'hidden',
              background: theme.bg, position: 'relative' },
  };

  if (isLoading) return <div style={S.center}>Loading book…</div>;

  if (error) {
    return (
      <div style={S.error}>
        <p>Failed to open book: {String(error)}</p>
        <a href="/index.html" style={S.link}>← Library</a>
      </div>
    );
  }

  if (!publication) return null;

  return (
    <div style={S.wrap}>
      <style>{THORIUM_HIDE_CSS}</style>
      <StatefulReader publication={publication} localDataKey={localDataKey} />
      <Overlay
        title={title}
        publication={publication}
        prefs={prefs}
        onUpdatePrefs={handleUpdatePrefs}
        accessToken={accessToken}
        bookId={bookId}
      />
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function Reader() {
  const params = new URLSearchParams(window.location.search);
  const bookId = params.get('id');
  const jwt    = localStorage.getItem('br_token');

  const [accessToken, setAccessToken] = useState(null);
  const [tokenError, setTokenError]   = useState(null);

  useEffect(() => {
    if (!bookId || !jwt) return;
    fetchAccessToken(bookId, jwt)
      .then(setAccessToken)
      .catch(err => setTokenError(err.message));
  }, [bookId, jwt]);

  const prefs = loadPrefs();
  const theme = THEMES[prefs.theme] || THEMES.sepia;

  const S = {
    error:  { padding: '2rem', background: theme.bg, color: theme.text,
              fontFamily: 'sans-serif', minHeight: '100vh' },
    link:   { color: theme.link },
    center: { display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100vh', background: theme.bg, color: theme.text, fontFamily: 'sans-serif' },
  };

  if (!bookId || !jwt) {
    return (
      <div style={S.error}>
        Not authenticated.{' '}
        <a href={`/login.html?next=${encodeURIComponent(window.location.href)}`} style={S.link}>
          Log in
        </a>
      </div>
    );
  }

  if (tokenError) {
    return (
      <div style={S.error}>
        <p>Auth error: {tokenError}</p>
        <a href="/index.html" style={S.link}>← Library</a>
      </div>
    );
  }

  if (!accessToken) return <div style={S.center}>Loading book…</div>;

  return <ReaderInner bookId={bookId} accessToken={accessToken} />;
}
