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

// Fetch and display app version in the logo and browser title
fetch('/api/version').then(r => r.json()).then(({ version }) => {
  const logoEl = document.querySelector('a.logo');
  if (logoEl) logoEl.innerHTML = `\uD83D\uDCDA Codexa <span class="app-version">v${version}</span>`;
  document.title = `Codexa v${version}`;
}).catch(() => {});

await initI18n();
await initSidebar({ onShelfSelect: selectShelf });
await initRouter({
  library:  initLibrary,
  settings: initSettings,
  opds:     initOpds,
});
