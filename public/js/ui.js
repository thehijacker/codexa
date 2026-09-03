/**
 * ui.js — shared UI helpers (toast, modal confirm, spinner)
 */
import { t } from './i18n.js';

// ── Native status bar appearance sync (Android app only) ─────────────────────
// The Android host never learns which in-app theme is active — the WebView's
// system status/nav bar icon color is whatever the OS last set it to, so a light
// in-app theme on a phone with light-icon system defaults renders invisible
// (white icons on a white bar). Call this whenever a theme is applied/resolved,
// passing the actual background color that theme just set — the Android app
// exposes AndroidCodexa.setStatusBarAppearance(isLight) to flip icon color to
// match. No-op outside the Android app (bridge method won't exist) and no-op on
// older installed APKs that predate this bridge method.
function isLightColor(color) {
  const hex = String(color || '').trim().replace('#', '');
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

// "Check for update" — unregisters the service worker, then reloads with a cache-busting query
// param so the browser's own HTTP cache can't hand back a stale document either. This is the
// in-app equivalent of the only other known fix for a PWA stuck on an old build (removing and
// re-adding the home screen icon). Shared by sidebar.js (Codexa title tap while logged in) and
// login.js (same tap on the sign-in screen) — a stale-cached login page/script talking to an
// already-updated server is exactly the shape of "PWA won't log in until reinstalled".
//
// Deliberately does NOT touch caches.delete() itself — BOOKS_CACHE (downloaded books for
// offline reading) lives in the same Cache Storage as the app-shell cache, and wiping every
// cache here would force a full re-download of every offline book just to pick up a JS/CSS
// change. The freshly-registered service worker's own `activate` handler (sw.js) already does
// the right, narrower thing on its own — it deletes only stale app-shell cache versions and
// explicitly preserves BOOKS_CACHE — so unregister+reload is enough to reach it.
// Reader preferences (fonts, layout, margins, theme, …) live in localStorage/IndexedDB, not
// Cache Storage, so none of this ever touches them regardless.
export async function hardRefreshApp() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch { /* best-effort — still fall through to the reload below */ }
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('_refresh', Date.now());
  window.location.href = url.toString();
}

// Wires the "tap the Codexa title to check for an update" confirm dialog onto any element.
// Shared between sidebar.js (rebuilt twice — initSidebar and the langchange re-render) and
// login.js so all three call sites stay in sync with a single piece of dialog copy/behavior.
export function attachUpdateCheckHandler(el, { skipSelector = null } = {}) {
  el?.addEventListener('click', (e) => {
    if (skipSelector && e.target.closest(skipSelector)) return;
    e.preventDefault();
    confirmDialog(t('sidebar.check_update_confirm'), hardRefreshApp, t('sidebar.check_update_reload'), false);
  });
}

export function syncStatusBarAppearance(bgColor) {
  if (typeof window.AndroidCodexa?.setStatusBarAppearance !== 'function') return;
  const light = isLightColor(bgColor);
  if (light === null) return;
  window.AndroidCodexa.setStatusBarAppearance(light);
}

// ── Toast notifications ──────────────────────────────────────────────────────
function ensureToastContainer() {
  let el = document.getElementById('toast-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-container';
    document.body.appendChild(el);
  }
  return el;
}

export function showToast(message, type = 'info', duration = 2000) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  const eink = document.documentElement.hasAttribute('data-reader-eink');
  setTimeout(() => {
    toast.style.opacity = '0';
    if (!eink) toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), eink ? 0 : 320);
  }, duration);
}

export const toast = {
  success: (msg) => showToast(msg, 'success'),
  error:   (msg) => showToast(msg, 'error'),
  info:    (msg) => showToast(msg, 'info'),
  warn:    (msg) => showToast(msg, 'warn', 7000),
};

/**
 * Shows a persistent toast with a progress bar.
 * `formatCount` optionally formats the current/total counter text (default "current / total"
 * as-is — pass one to e.g. render byte counts as MB). Returns an object with `update(current,
 * total)` and `dismiss()`.
 */
export function showProgressToast(label, formatCount) {
  const container = ensureToastContainer();
  const el = document.createElement('div');
  el.className = 'toast toast-progress';
  el.innerHTML =
    `<span class="toast-progress-label">${label}</span>` +
    `<div class="toast-progress-track"><div class="toast-progress-bar" style="width:0%"></div></div>` +
    `<span class="toast-progress-counter"></span>`;
  container.appendChild(el);
  return {
    update(current, total) {
      const pct = total ? Math.round((current / total) * 100) : 0;
      el.querySelector('.toast-progress-bar').style.width = pct + '%';
      el.querySelector('.toast-progress-counter').textContent =
        formatCount ? formatCount(current, total) : `${current} / ${total}`;
    },
    // instant: skip the fade and remove right away — use when a follow-up toast (e.g. a
    // success/error result) is about to appear immediately after, so the two don't overlap
    // on screen for the ~300ms the fade would otherwise take.
    dismiss(instant = false) {
      if (instant) { el.remove(); return; }
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 320);
    },
  };
}

// ── Blocking overlay (spinner + message + cancel) ────────────────────────────
// For actions that wait on a server-side operation with no client-visible byte
// progress (e.g. the server fetching a not-yet-owned book from a remote OPDS/
// BookOrbit catalog before a "peek"). Covers the whole viewport like
// confirmDialog's backdrop so nothing else is clickable while it's up.
// Cancel is intentionally "soft" — it never calls AbortController.abort() on the
// underlying request. Passing a signal to fetch() is known to hang indefinitely
// on some old WebView builds (see the NOTE in api.js), so cancelling here just
// hides the overlay and hands control back to the caller; the in-flight request
// is left to resolve or fail on its own and the caller decides what to do with
// a late result (see bookorbit.js/opds.js peek handlers).
export function showBlockingOverlay(message, onCancel) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop blocking-overlay';
  backdrop.innerHTML = `
    <div class="modal blocking-overlay-box" role="alertdialog" aria-modal="true" aria-live="polite">
      <span class="spinner"></span>
      <p class="blocking-overlay-msg"></p>
      <button class="btn btn-secondary" id="blocking-overlay-cancel">${t('common.cancel')}</button>
    </div>`;
  document.body.appendChild(backdrop);
  const msgEl = backdrop.querySelector('.blocking-overlay-msg');
  msgEl.textContent = message;
  backdrop.querySelector('#blocking-overlay-cancel').addEventListener('click', () => {
    backdrop.remove();
    onCancel?.();
  });
  return {
    setMessage(msg) { msgEl.textContent = msg; },
    dismiss() { backdrop.remove(); },
  };
}

// ── Confirm dialog ───────────────────────────────────────────────────────────
export function confirmDialog(message, onConfirm, confirmLabel = null, danger = true) {
  const label = confirmLabel ?? t('common.delete');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:380px">
      <p style="margin-bottom:1.5rem">${message}</p>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="dlg-cancel">${t('common.cancel')}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="dlg-confirm">${label}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  function close() { backdrop.remove(); }

  backdrop.querySelector('#dlg-cancel').addEventListener('click', close);
  backdrop.querySelector('#dlg-confirm').addEventListener('click', () => {
    close();
    onConfirm();
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
}

// ── Button loading state ─────────────────────────────────────────────────────
export function setButtonLoading(btn, loading, originalLabel) {
  if (loading) {
    btn.dataset.origLabel = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>`;
    btn.disabled = true;
  } else {
    btn.innerHTML = originalLabel || btn.dataset.origLabel || '';
    btn.disabled = false;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Checkmark dropdown (button + list) ────────────────────────────────────────
// Builds a custom checkmark dropdown (button + list) driven by a hidden native <select> — the
// select stays the single source of truth (its value changes and dispatches a real 'change'
// event, so existing `select.addEventListener('change', ...)` code elsewhere needs no changes).
// Shared across the library grid's sort menu, the BookOrbit browser's sort menu, the book info
// modal's status dropdown, and the reader's settings-panel dropdowns — one implementation instead
// of near-identical copies in each.
// `scope` is where the "click/tap outside to close" and Escape listeners get attached — defaults
// to document for persistent toolbar/panel menus (main/BookOrbit sort, reader settings), which
// only ever get initialized once per page load so a document-level listener is harmless. Pass a
// modal's own backdrop element instead for a dropdown inside a dynamically created-and-destroyed
// dialog (e.g. the book info modal's status dropdown): its markup is rebuilt from scratch on every
// open, and document-level listeners would never get cleaned up, leaking three more on every
// open. Listeners on the backdrop die with it when it's removed, so no cleanup call is needed.
// Safe to call more than once for the same selectId/btnId/listId (e.g. after a <select>'s options
// are (re)populated asynchronously, like the info modal's KOSync-server picker) — the list is
// always rebuilt fresh from the select's current options, but the interaction listeners are only
// ever attached once (tracked via btn.dataset.wired), so repeat calls don't stack duplicates.
export function initSortMenuFor(selectId, btnId, labelId, listId, scope = document) {
  const select = document.getElementById(selectId);
  const btn = document.getElementById(btnId);
  const label = document.getElementById(labelId);
  const list = document.getElementById(listId);
  if (!select || !btn || !label || !list) return;

  function syncLabel() {
    const selected = select.options[select.selectedIndex];
    label.textContent = selected?.textContent || '';
    list.querySelectorAll('.sort-menu-option').forEach(opt => {
      const active = opt.dataset.value === select.value;
      opt.classList.toggle('active', active);
      opt.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function closeMenu() {
    list.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    list.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }

  list.innerHTML = '';
  Array.from(select.options).forEach(option => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'sort-menu-option';
    item.dataset.value = option.value;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
    item.innerHTML = `<span>${escHtml(option.textContent || '')}</span><span class="sort-menu-check">✓</span>`;
    item.addEventListener('click', () => {
      if (select.value === option.value) {
        closeMenu();
        return;
      }
      select.value = option.value;
      syncLabel();
      closeMenu();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    list.appendChild(item);
  });

  if (btn.dataset.wired) { syncLabel(); return; }
  btn.dataset.wired = '1';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (list.classList.contains('hidden')) openMenu();
    else closeMenu();
  });
  scope.addEventListener('click', (e) => {
    if (!list.classList.contains('hidden') && !e.target.closest('.sort-menu-wrap')) closeMenu();
  });
  scope.addEventListener('touchend', (e) => {
    if (!list.classList.contains('hidden') && !e.target.closest('.sort-menu-wrap')) closeMenu();
  }, { passive: true });
  scope.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  select.addEventListener('change', syncLabel);
  syncLabel();
}

// Custom sort-menu list items are plain DOM built once at init time (not a live binding to the
// <select>'s options), so anything that changes the underlying select's value or option text
// without going through the dropdown's own click handling — a language switch re-translating
// option text, or code elsewhere setting `select.value` directly — needs this to manually re-copy
// the current option text into the button label (and, for a language switch, into each menu item
// too).
export function resyncSortMenu(selectId, listId, labelId) {
  const select = document.getElementById(selectId);
  const menuItems = document.querySelectorAll(`#${listId} .sort-menu-option`);
  if (select && menuItems.length) {
    Array.from(select.options).forEach((opt, i) => {
      const item = menuItems[i];
      if (item) item.querySelector('span')?.replaceWith(Object.assign(document.createElement('span'), { textContent: opt.textContent }));
    });
  }
  const label = document.getElementById(labelId);
  if (label && select) label.textContent = select.options[select.selectedIndex]?.textContent || '';
}
