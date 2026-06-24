import { initI18n } from './i18n.js';
import { initSidebar } from './sidebar.js';
import { initRouter } from './router.js';
import { initLibrary, selectShelf } from './library.js';
import { initSettings } from './settings.js';
import { initOpds } from './opds.js';
import { requireAuth } from './api.js';
import { flushProgressOutbox } from './progress-outbox.js';

if (!requireAuth()) {
  window.location.href = '/login.html';
  throw new Error('not authenticated');
}

// Don't let the WebView restore a stale scroll position from a previous visit — on
// old Android WebViews this leaves the page scrolled up under the status bar until a
// later reflow corrects it (it looked like the page "jumped down" once books loaded).
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

function fetchAndShowVersion() {
  fetch('/api/version').then(r => r.json()).then(({ version }) => {
    document.title = `Codexa v${version}`;
    document.querySelectorAll('a.logo').forEach(logo => {
      const ver = logo.querySelector('.app-version');
      if (ver) { ver.textContent = `v${version}`; }
      else { logo.insertAdjacentHTML('beforeend', ` <span class="app-version">v${version}</span>`); }
    });
  }).catch(() => {});
}
fetchAndShowVersion();

// Toggle is-offline class so CSS can show/hide the offline icon and version number.
// Note: body.is-offline is also set/cleared by library.js based on actual API
// reachability, which is more reliable than navigator.onLine on desktop.
function syncOfflineClass() {
  document.body.classList.toggle('is-offline', !navigator.onLine);
  if (navigator.onLine) fetchAndShowVersion();
}
window.addEventListener('online',  syncOfflineClass);
window.addEventListener('offline', syncOfflineClass);
syncOfflineClass();

// Push any reading progress made while offline to the server + KOSync. Triggered
// on reconnect and once on load. app:network-restored is the most reliable signal
// (library.js fires it only after the API is confirmed reachable); 'online' is a
// backup for LAN/desktop. Idempotent — safe to call repeatedly.
function flushOfflineProgress() {
  flushProgressOutbox().then(n => { if (n) console.log('[app] synced', n, 'offline progress entr' + (n === 1 ? 'y' : 'ies')); }).catch(() => {});
}
window.addEventListener('online', flushOfflineProgress);
document.addEventListener('app:network-restored', flushOfflineProgress);
flushOfflineProgress();

// Fired by library.js when the API becomes reachable after an offline period,
// even when navigator.onLine was already true (LAN-connected, no internet).
document.addEventListener('app:network-restored', fetchAndShowVersion);

(async () => {
  await initI18n();
  await initSidebar({ onShelfSelect: selectShelf });
  // Force an early layout pass + reset scroll so the mobile header's safe-area
  // padding settles immediately after the sidebar/header render, instead of only
  // once the book grid fills in (old WebViews report env(safe-area-inset-*) as 0
  // until a content layout runs).
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    void document.body.offsetHeight; // reflow nudge
  });
  await initRouter({
    library:  initLibrary,
    settings: initSettings,
    opds:     initOpds,
  });
})();

