/* ─── Theme ──────────────────────────────────────────────────────────────── */

const THEMES      = ['system', 'light', 'dark'];
const THEME_ICONS  = { system: '⊙', light: '☀', dark: '☾' };
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };

let currentTheme = localStorage.getItem('codexa-docs-theme') || 'system';

function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove('theme-light', 'theme-dark');
  if (theme === 'light') html.classList.add('theme-light');
  if (theme === 'dark')  html.classList.add('theme-dark');
  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.textContent = THEME_ICONS[theme];
    btn.title = `Theme: ${THEME_LABELS[theme]} — click to change`;
    btn.setAttribute('aria-label', `Theme: ${THEME_LABELS[theme]}, click to change`);
  }
}

function cycleTheme() {
  currentTheme = THEMES[(THEMES.indexOf(currentTheme) + 1) % THEMES.length];
  localStorage.setItem('codexa-docs-theme', currentTheme);
  applyTheme(currentTheme);
}

/* ─── Collapsible nav groups ─────────────────────────────────────────────── */

const NAV_STATE_KEY = 'codexa-docs-nav';
let openSections = new Set();

function loadNavState() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_STATE_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveNavState() {
  localStorage.setItem(NAV_STATE_KEY, JSON.stringify([...openSections]));
}

function setGroupOpen(sectionId, open) {
  const li = document.querySelector(`#nav-links > ul > li[data-group-id="${sectionId}"]`);
  if (!li) return;
  li.classList.toggle('open', open);
  if (open) openSections.add(sectionId);
  else       openSections.delete(sectionId);
  saveNavState();
}

function toggleGroup(sectionId) {
  const li = document.querySelector(`#nav-links > ul > li[data-group-id="${sectionId}"]`);
  if (!li) return;
  setGroupOpen(sectionId, !li.classList.contains('open'));
}

function initCollapsible() {
  openSections = loadNavState();

  // Suppress transitions while applying saved state so sections appear
  // immediately open — no slide-down animation on every page load.
  const navLinks = document.getElementById('nav-links');
  navLinks.classList.add('no-transition');

  document.querySelectorAll('#nav-links > ul > li').forEach(li => {
    const sub  = li.querySelector(':scope > .nav-sub');
    const link = li.querySelector(':scope > a[data-section]');
    if (!sub || !link) return;

    const id = link.dataset.section;
    li.dataset.groupId = id;

    // Wrap the section link in a flex row so the toggle sits on the right
    const row = document.createElement('div');
    row.className = 'nav-row';
    li.insertBefore(row, link);
    row.appendChild(link);

    const btn = document.createElement('button');
    btn.className   = 'nav-toggle';
    btn.title       = 'Expand / collapse';
    btn.innerHTML   = '&#9658;'; // ▶
    row.appendChild(btn);

    // Apply saved state (default: collapsed)
    if (openSections.has(id)) li.classList.add('open');

    // Toggle button: expand/collapse without navigating
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleGroup(id);
    });
  });

  // Re-enable transitions after the initial paint so user interactions animate normally
  requestAnimationFrame(() => requestAnimationFrame(() => {
    navLinks.classList.remove('no-transition');
  }));
}

/* ─── Navigation ─────────────────────────────────────────────────────────── */

let currentSection = null;
let activeNavLink  = null;

function setActiveLink(link) {
  if (activeNavLink) activeNavLink.classList.remove('active');
  activeNavLink = link || null;
  if (activeNavLink) {
    activeNavLink.classList.add('active');
    activeNavLink.scrollIntoView({ block: 'nearest' });
  }
}

function showSection(id, pushState = true, scrollTarget = null) {
  if (document.body.classList.contains('searching')) clearSearch();

  document.querySelectorAll('section').forEach(s => s.classList.remove('active'));

  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
    currentSection = id;
    if (pushState) history.pushState({ section: id }, '', '#' + id);
  }

  document.getElementById('nav').classList.remove('open');
  document.getElementById('nav-overlay').classList.remove('open');

  if (scrollTarget) {
    requestAnimationFrame(() => {
      document.getElementById(scrollTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } else {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

function initNav() {
  document.querySelectorAll('a[data-section]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const id       = link.dataset.section;
      const scrollTo = link.dataset.scroll || null;
      setActiveLink(link);
      if (scrollTo) setGroupOpen(id, true); // subsection: always expand parent
      else          toggleGroup(id);         // section link: toggle
      showSection(id, true, scrollTo);
    });
  });

  window.addEventListener('popstate', e => {
    const id = (e.state && e.state.section) || sectionFromHash();
    if (id) {
      const link = document.querySelector(`a[data-section="${id}"]:not([data-scroll])`);
      setActiveLink(link);
      setGroupOpen(id, true);
      showSection(id, false);
    }
  });

  const id   = sectionFromHash() || 'about';
  const link = document.querySelector(`a[data-section="${id}"]:not([data-scroll])`);
  setActiveLink(link);
  setGroupOpen(id, true);
  showSection(id, false);
}

function sectionFromHash() {
  const hash = location.hash.replace('#', '').trim();
  return hash && document.getElementById(hash) ? hash : null;
}

/* ─── Hamburger ──────────────────────────────────────────────────────────── */

function initHamburger() {
  const hamburger = document.getElementById('hamburger');
  const nav       = document.getElementById('nav');
  const overlay   = document.getElementById('nav-overlay');
  hamburger.addEventListener('click', () => {
    nav.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay.addEventListener('click', () => {
    nav.classList.remove('open');
    overlay.classList.remove('open');
  });
}

/* ─── Search ─────────────────────────────────────────────────────────────── */

let matchNodes  = [];
let matchIndex  = -1;
let searchTimer = null;

function initSearch() {
  const input    = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value), 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); advanceMatch(); }
    if (e.key === 'Escape') { clearSearch(); input.blur(); }
  });
  clearBtn.addEventListener('click', () => { input.value = ''; clearSearch(); input.focus(); });
}

function runSearch(query) {
  const clearBtn = document.getElementById('search-clear');
  const count    = document.getElementById('search-count');
  clearMarks();
  const q = query.trim();
  if (!q) { clearSearch(); return; }

  clearBtn.classList.add('visible');
  document.body.classList.add('searching');

  const regex = new RegExp(escapeRegex(q), 'gi');
  let total = 0;
  document.querySelectorAll('section').forEach(section => {
    const hits = markTextNodes(section, regex);
    section.classList.toggle('has-match', hits > 0);
    total += hits;
  });

  matchNodes = Array.from(document.querySelectorAll('mark'));
  matchIndex = matchNodes.length > 0 ? 0 : -1;
  highlightCurrent();
  count.textContent = total > 0 ? `${total}` : '0';
}

function markTextNodes(root, regex) {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const tag = node.parentElement?.tagName;
      if (['SCRIPT', 'STYLE', 'MARK'].includes(tag)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach(node => {
    const text = node.textContent;
    if (!regex.test(text)) return;
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = regex.lastIndex;
      count++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
  return count;
}

function advanceMatch() {
  if (!matchNodes.length) return;
  matchNodes[matchIndex]?.classList.remove('current-match');
  matchIndex = (matchIndex + 1) % matchNodes.length;
  highlightCurrent();
}

function highlightCurrent() {
  if (matchIndex < 0 || !matchNodes.length) return;
  const m = matchNodes[matchIndex];
  m.classList.add('current-match');
  m.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearMarks() {
  document.querySelectorAll('mark').forEach(m => {
    const p = m.parentNode;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  });
  matchNodes = [];
  matchIndex = -1;
}

function clearSearch() {
  clearMarks();
  document.body.classList.remove('searching');
  document.querySelectorAll('section').forEach(s => s.classList.remove('has-match'));
  document.getElementById('search-clear').classList.remove('visible');
  document.getElementById('search-count').textContent = '';
  if (currentSection) document.getElementById(currentSection)?.classList.add('active');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─── Lightbox ───────────────────────────────────────────────────────────── */

function initLightbox() {
  const lb  = document.createElement('div');
  lb.id     = 'lightbox';
  const img = document.createElement('img');
  img.id    = 'lightbox-img';
  lb.appendChild(img);
  document.body.appendChild(lb);

  function open(src, alt) {
    img.src = src;
    img.alt = alt || '';
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    lb.classList.remove('open');
    document.body.style.overflow = '';
  }

  document.querySelectorAll('#content figure img').forEach(image => {
    image.addEventListener('click', () => open(image.src, image.alt));
  });

  lb.addEventListener('click', close);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
}

/* ─── Copy buttons ───────────────────────────────────────────────────────── */

function initCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pre = btn.closest('.code-block').querySelector('pre');
      navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
      });
    });
  });
}

/* ─── Boot ───────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  document.getElementById('theme-btn')?.addEventListener('click', cycleTheme);
  initCollapsible(); // must run before initNav so nav-row wrappers exist
  initNav();
  initHamburger();
  initSearch();
  initCopyButtons();
  initLightbox();
});
