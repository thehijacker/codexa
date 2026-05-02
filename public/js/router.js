const PANELS = ['library', 'settings', 'opds'];
const _inits  = {};
let _current  = null;

export function getCurrentPanel() { return _current; }

export async function showPanel(name, pushState = true) {
  if (!PANELS.includes(name)) name = 'library';

  PANELS.forEach(p => {
    const el = document.getElementById(`panel-${p}`);
    if (el) el.hidden = (p !== name);
  });

  // Drive body class for OPDS overflow behaviour
  document.querySelector('.app-body')?.classList.toggle('opds-active', name === 'opds');

  _current = name;

  const url = name === 'library' ? '/' : `/?panel=${name}`;
  if (pushState && (location.pathname + location.search !== url)) {
    history.pushState({ panel: name }, '', url);
  }

  document.dispatchEvent(new CustomEvent('panelchange', { detail: { panel: name } }));

  if (_inits[name]) {
    const fn = _inits[name];
    delete _inits[name]; // init each panel once
    await fn();
  }
}

export async function initRouter(initMap) {
  for (const [name, fn] of Object.entries(initMap)) {
    _inits[name] = fn;
  }

  window.addEventListener('popstate', e => {
    const p = e.state?.panel || new URLSearchParams(location.search).get('panel') || 'library';
    showPanel(p, false);
  });

  const params  = new URLSearchParams(location.search);
  const initial = params.get('panel') || 'library';
  await showPanel(initial, false);
}
