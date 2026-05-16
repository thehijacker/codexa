import { initI18n } from './i18n.js';
import { initSidebar } from './sidebar.js';
import { initRouter } from './router.js';
import { initLibrary, selectShelf } from './library.js';
import { initSettings } from './settings.js';
import { initOpds } from './opds.js';
import { requireAuth } from './api.js';

if (!requireAuth()) {
  window.location.href = '/login.html';
  throw new Error('not authenticated');
}

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
// Fired by library.js when the API becomes reachable after an offline period,
// even when navigator.onLine was already true (LAN-connected, no internet).
document.addEventListener('app:network-restored', fetchAndShowVersion);

(async () => {
  await initI18n();
  await initSidebar({ onShelfSelect: selectShelf });
  await initRouter({
    library:  initLibrary,
    settings: initSettings,
    opds:     initOpds,
  });
})();

