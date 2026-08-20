import { apiFetch, apiUpload } from './api.js';
import { toast, confirmDialog, setButtonLoading, showProgressToast } from './ui.js';
import { t } from './i18n.js';
import { showPanel } from './router.js';
import { setBookorbitNavVisible } from './sidebar.js';

let _initialized    = false;
let _cachedServers  = [];
let _editingServerId = null;

// ── Tabs ────────────────────────────────────────────────────────────────────────
// Registered at module load, not inside initSettings(), because the tab buttons/panels are
// static markup present from page load — showPanel() can dispatch 'panelchange' with a tab
// hint (e.g. from OPDS's "Add server" shortcut) before initSettings() has ever run (a user's
// first-ever visit to Settings), so this can't depend on that lazy init having fired yet.
export function activateSettingsTab(name) {
  document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.settings-tab-panel').forEach(p => { p.hidden = p.dataset.tabPanel !== name; });
}

document.querySelectorAll('.settings-tab').forEach(tabBtn => {
  tabBtn.addEventListener('click', () => activateSettingsTab(tabBtn.dataset.tab));
});

document.addEventListener('panelchange', e => {
  if (e.detail.panel === 'settings' && e.detail.tab) activateSettingsTab(e.detail.tab);
});

export async function initSettings() {
  if (_initialized) return;
  _initialized = true;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const kosyncUrl              = document.getElementById('kosync-url');
const kosyncUsername         = document.getElementById('kosync-username');
const kosyncPassword         = document.getElementById('kosync-password');
const kosyncStatus           = document.getElementById('kosync-status');
const btnTestKosync          = document.getElementById('btn-test-kosync');
const btnSaveKosync          = document.getElementById('btn-save-kosync');
const btnClearKosync         = document.getElementById('btn-clear-kosync');
const kosyncInternalEnabled  = document.getElementById('kosync-internal-enabled');
const kosyncInternalUrlBox   = document.getElementById('kosync-internal-url-box');
const kosyncInternalUrlVal   = document.getElementById('kosync-internal-url-val');
const btnSaveInternal        = document.getElementById('btn-save-internal');
const bookorbitUrl           = document.getElementById('bookorbit-url');
const bookorbitSyncEnabled   = document.getElementById('bookorbit-sync-enabled');
const bookorbitNeedCreds     = document.getElementById('bookorbit-sync-needcreds');
const btnSaveBookorbit       = document.getElementById('btn-save-bookorbit');
const bookorbitAcctUsername  = document.getElementById('bookorbit-account-username');
const bookorbitAcctPassword  = document.getElementById('bookorbit-account-password');
const bookorbitStatus        = document.getElementById('bookorbit-status');
const btnTestBookorbit       = document.getElementById('btn-test-bookorbit');

// ── Load current settings ─────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const s = await apiFetch('/settings');
    kosyncUrl.value      = s.kosync_url      || '';
    kosyncUsername.value = s.kosync_username  || '';
    // password is never returned; show placeholder when set
    kosyncPassword.placeholder = s.has_kosync_password ? t('settings.kosync_pass_saved') : t('settings.kosync_pass_ph');
    updateStatusBadge(s.kosync_url ? null : 'not_configured');
    kosyncInternalEnabled.checked = s.kosync_internal_enabled || false;
    updateInternalUrlBox();
    bookorbitUrl.value = s.bookorbit_url || '';
    setStatusBadge(bookorbitStatus, s.bookorbit_url ? null : 'not_configured');
    bookorbitSyncEnabled.checked = s.bookorbit_sync_enabled || false;
    bookorbitAcctUsername.value = s.bookorbit_account_username || '';
    bookorbitAcctPassword.placeholder = s.has_bookorbit_account_password
      ? t('settings.kosync_pass_saved') : t('settings.kosync_pass_ph');
    updateBookorbitGate(!!s.bookorbit_url && !!s.has_bookorbit_account_password);
  } catch (err) {
    toast.error(t('settings.err_load', { msg: err.message }));
  }
}

// Extended sync needs a BookOrbit server URL + saved account credentials.
function updateBookorbitGate(hasCreds) {
  bookorbitSyncEnabled.disabled = !hasCreds;
  if (bookorbitNeedCreds) bookorbitNeedCreds.hidden = hasCreds;
  if (!hasCreds) bookorbitSyncEnabled.checked = false;
}

function updateInternalUrlBox() {
  const on = kosyncInternalEnabled.checked;
  kosyncInternalUrlBox.hidden = !on;
  if (on) kosyncInternalUrlVal.textContent = window.location.origin;
}

kosyncInternalEnabled.addEventListener('change', updateInternalUrlBox);

// ── Status badge ──────────────────────────────────────────────────────────────
function setStatusBadge(el, reason) {
  el.className = 'kosync-status';
  if (reason === null) {
    // We don't know yet — show neutral
    el.textContent = '';
    return;
  }
  if (reason === 'not_configured') {
    el.classList.add('status-off');
    el.textContent = t('settings.status_not_configured');
  } else if (reason === 'ok') {
    el.classList.add('status-ok');
    el.textContent = t('settings.status_ok');
  } else {
    el.classList.add('status-error');
    el.textContent = t('common.error') + ': ' + reason;
  }
}
function updateStatusBadge(reason) { setStatusBadge(kosyncStatus, reason); }

// ── Test connection ───────────────────────────────────────────────────────────
btnTestKosync.addEventListener('click', async () => {
  const url      = kosyncUrl.value.trim();
  const username = kosyncUsername.value.trim();
  const password = kosyncPassword.value;

  if (!url) {
    toast.error(t('settings.kosync_url_required'));
    return;
  }

  setButtonLoading(btnTestKosync, true, t('settings.btn_testing'));
  try {
    // Save current form values first so the server-side test uses them
    const body = { kosync_url: url, kosync_username: username };
    if (password) body.kosync_password = password;
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (password) {
      kosyncPassword.value       = '';
      kosyncPassword.placeholder = t('settings.kosync_pass_saved');
    }

    const res = await apiFetch('/kosync/test');
    if (res.connected) {
      updateStatusBadge('ok');
      toast.success(t('settings.test_ok'));
    } else {
      updateStatusBadge(res.reason || 'error');
      toast.error(t('settings.test_fail', { reason: res.reason || '?' }));
    }
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  } finally {
    setButtonLoading(btnTestKosync, false, t('settings.btn_test_kosync'));
  }
});

// ── Save KOReader settings ────────────────────────────────────────────────────
btnSaveKosync.addEventListener('click', async () => {
  const url      = kosyncUrl.value.trim();
  const username = kosyncUsername.value.trim();
  const password = kosyncPassword.value; // empty = keep existing

  if (url && !url.startsWith('http')) {
    toast.error(t('settings.kosync_url_required'));
    return;
  }

  setButtonLoading(btnSaveKosync, true, t('settings.btn_saving'));
  try {
    const body = { kosync_url: url, kosync_username: username };
    // Only send password if user typed something new
    if (password) body.kosync_password = password;

    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) });
    kosyncPassword.value       = '';
    kosyncPassword.placeholder = password ? t('settings.kosync_pass_saved') : kosyncPassword.placeholder;
    updateStatusBadge(url ? null : 'not_configured');
    toast.success(t('settings.saved'));
  } catch (err) {
    toast.error(t('settings.err_save', { msg: err.message }));
  } finally {
    setButtonLoading(btnSaveKosync, false, t('settings.btn_save_kosync'));
  }
});

// ── Clear / disconnect ────────────────────────────────────────────────────────
btnClearKosync.addEventListener('click', () => {
  confirmDialog(
    t('settings.confirm_clear'),
    async () => {
      setButtonLoading(btnClearKosync, true, t('settings.btn_removing'));
      try {
        await apiFetch('/settings', {
          method: 'PUT',
          body: JSON.stringify({ kosync_url: '', kosync_username: '', kosync_password: '' }),
        });
        kosyncUrl.value      = '';
        kosyncUsername.value = '';
        kosyncPassword.value       = '';
        kosyncPassword.placeholder = t('settings.kosync_pass_ph');
        updateStatusBadge('not_configured');
        toast.success(t('settings.removed'));
      } catch (err) {
        toast.error(t('common.error_msg', { msg: err.message }));
      } finally {
        setButtonLoading(btnClearKosync, false, t('settings.btn_clear_kosync'));
      }
    },
    'Odstrani',
    true
  );
});

// ── Save internal server toggle ────────────────────────────────────────────────
btnSaveInternal.addEventListener('click', async () => {
  setButtonLoading(btnSaveInternal, true, t('settings.btn_saving'));
  try {
    await apiFetch('/settings', {
      method: 'PUT',
      body: JSON.stringify({ kosync_internal_enabled: kosyncInternalEnabled.checked }),
    });
    toast.success(kosyncInternalEnabled.checked
      ? t('settings.internal_enabled')
      : t('settings.internal_disabled'));
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  } finally {
    setButtonLoading(btnSaveInternal, false, t('settings.btn_save'));
  }
});

// ── Save BookOrbit extended-sync account + toggle ──────────────────────────────
btnSaveBookorbit.addEventListener('click', async () => {
  const url      = bookorbitUrl.value.trim();
  const username = bookorbitAcctUsername.value.trim();
  const password = bookorbitAcctPassword.value; // empty = keep existing
  setButtonLoading(btnSaveBookorbit, true, t('settings.btn_saving'));
  try {
    const body = {
      bookorbit_url: url,
      bookorbit_account_username: username,
      bookorbit_sync_enabled: bookorbitSyncEnabled.checked,
    };
    if (password) body.bookorbit_account_password = password;
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) });
    bookorbitAcctPassword.value = '';
    const hasCreds = !!url && (!!password || bookorbitAcctPassword.placeholder === t('settings.kosync_pass_saved'));
    updateBookorbitGate(hasCreds);
    if (password) bookorbitAcctPassword.placeholder = t('settings.kosync_pass_saved');
    // Reflect the toggle in the sidebar immediately — otherwise the "BookOrbit" nav item only
    // shows/hides after the next full page load (sidebar.js reads this once at init).
    setBookorbitNavVisible(bookorbitSyncEnabled.checked);
    toast.success(bookorbitSyncEnabled.checked
      ? t('settings.bookorbit_enabled')
      : t('settings.bookorbit_disabled'));
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  } finally {
    setButtonLoading(btnSaveBookorbit, false, t('settings.btn_save'));
  }
});

// ── Test BookOrbit connection ──────────────────────────────────────────────────
btnTestBookorbit.addEventListener('click', async () => {
  const url      = bookorbitUrl.value.trim();
  const username = bookorbitAcctUsername.value.trim();
  const password = bookorbitAcctPassword.value;

  if (!url || !username) {
    toast.error(t('settings.kosync_url_required'));
    return;
  }

  setButtonLoading(btnTestBookorbit, true, t('settings.btn_testing'));
  try {
    // Save current form values first so the server-side test uses them (mirrors the
    // KOSync test button) — does NOT flip the enabled toggle, so testing is safe before
    // switching extended sync on.
    const body = { bookorbit_url: url, bookorbit_account_username: username };
    if (password) body.bookorbit_account_password = password;
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (password) {
      bookorbitAcctPassword.value       = '';
      bookorbitAcctPassword.placeholder = t('settings.kosync_pass_saved');
    }

    const res = await apiFetch('/bookorbit/test');
    if (res.reachable) {
      setStatusBadge(bookorbitStatus, 'ok');
      toast.success(t('settings.test_ok'));
    } else {
      setStatusBadge(bookorbitStatus, res.error || 'error');
      toast.error(t('settings.test_fail', { reason: res.error || '?' }));
    }
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  } finally {
    setButtonLoading(btnTestBookorbit, false, t('settings.btn_test_kosync'));
  }
});
// ── Admin: registration toggle ───────────────────────────────────────────
const adminCard    = document.getElementById('admin-card');
const adminRegTgl  = document.getElementById('admin-reg-toggle');
const btnSaveReg   = document.getElementById('btn-save-reg');

async function loadAdminFonts() {
  const list = document.getElementById('admin-fonts-list');
  if (!list) return;
  let files;
  try { files = await apiFetch('/fonts'); } catch { files = []; }
  if (!files.length) {
    list.innerHTML = `<p style="color:var(--color-text-muted);font-size:.85rem;margin:0">${t('reader.no_custom_fonts')}</p>`;
    return;
  }
  const families = {};
  files.forEach(f => {
    const fam = f.replace(/\.(ttf|otf|woff2?)$/i, '')
      .replace(/[-_](Regular|Bold|Italic|BoldItalic|Light|Medium|SemiBold|Black|Thin|ExtraLight|ExtraBold|Heavy|Oblique)$/i, '')
      .replace(/[-_]/g, ' ').trim();
    if (!families[fam]) families[fam] = [];
    families[fam].push(f);
  });
  list.innerHTML = Object.keys(families).map(fam => `
    <div class="admin-user-row" data-fam="${escHtml(fam)}">
      <div class="admin-user-info"><span class="admin-user-name">${escHtml(fam)}</span></div>
      <button class="btn btn-danger btn-sm">${t('common.delete')}</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-fam]').forEach(row => {
    row.querySelector('button').addEventListener('click', async () => {
      const fam   = row.dataset.fam;
      const toDelete = files.filter(f => {
        const fFam = f.replace(/\.(ttf|otf|woff2?)$/i, '')
          .replace(/[-_](Regular|Bold|Italic|BoldItalic|Light|Medium|SemiBold|Black|Thin|ExtraLight|ExtraBold|Heavy|Oblique)$/i, '')
          .replace(/[-_]/g, ' ').trim();
        return fFam === fam;
      });
      try {
        for (const filename of toDelete) {
          await apiFetch(`/fonts/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        }
        await loadAdminFonts();
      } catch (err) {
        toast.error(t('common.error_msg', { msg: err.message }));
      }
    });
  });
}

// Path-encodes a dictionary id (e.g. "en-en/merriam-webster") for use after /dictionary/ in a URL.
function encodeDictId(id) {
  return id.split('/').map(encodeURIComponent).join('/');
}

async function loadAdminDicts() {
  const list = document.getElementById('admin-dicts-list');
  if (!list) return;
  let dicts;
  try { dicts = await apiFetch('/dictionary'); } catch { dicts = []; }
  if (!dicts.length) {
    list.innerHTML = `<p style="color:var(--color-text-muted);font-size:.85rem;margin:0">${t('reader.dict_no_dicts_short')}</p>`;
    return;
  }
  list.innerHTML = dicts.map(d => `
    <div class="admin-user-row" data-dict-id="${escHtml(d.id)}">
      <div class="admin-user-info">
        <span class="admin-user-name">${escHtml(d.name)}</span>
        ${d.wordcount ? `<span class="admin-user-meta">${d.wordcount.toLocaleString()} ${t('reader.dict_words')}</span>` : ''}
      </div>
      <div class="dict-lang-inputs">
        <input type="text" class="dict-lang-from" value="${escHtml(d.lang_from || '')}" maxlength="10"
          placeholder="${t('settings.dict_lang_placeholder')}"
          title="${t('settings.dict_lang_from')}" aria-label="${t('settings.dict_lang_from')}">
        <span class="dict-lang-sep">→</span>
        <input type="text" class="dict-lang-to" value="${escHtml(d.lang_to || '')}" maxlength="10"
          placeholder="${t('settings.dict_lang_placeholder')}"
          title="${t('settings.dict_lang_to')}" aria-label="${t('settings.dict_lang_to')}">
      </div>
      <button class="btn btn-danger btn-sm">${t('common.delete')}</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-dict-id]').forEach(row => {
    const id = row.dataset.dictId;
    row.querySelector('button').addEventListener('click', async () => {
      try {
        await apiFetch(`/dictionary/${encodeDictId(id)}`, { method: 'DELETE' });
        await Promise.all([loadAdminDicts(), loadDictPrefs()]);
      } catch (err) {
        toast.error(t('common.error_msg', { msg: err.message }));
      }
    });
    // Sets this dictionary's global default language (applies to every user who hasn't set
    // their own per-user override in the Dictionaries tab) — moves it into/out of a
    // "<lang_from>-<lang_to>/" folder server-side, see PUT /api/dictionary/*.
    // Commits on focusout of the *pair* (not per-field 'change') — a per-field 'change' fires as
    // soon as you tab/click from "from" into "to", saving a still-half-filled value and
    // rebuilding the whole list mid-edit, which wiped out whatever hadn't been saved yet. Only
    // save once focus actually leaves both inputs, using both of their values at that point.
    const langWrap   = row.querySelector('.dict-lang-inputs');
    const fromInput  = row.querySelector('.dict-lang-from');
    const toInput    = row.querySelector('.dict-lang-to');
    const initialFrom = fromInput.value.trim().toLowerCase();
    const initialTo   = toInput.value.trim().toLowerCase();

    async function commitLangChange() {
      const fromVal = fromInput.value.trim().toLowerCase();
      const toVal   = toInput.value.trim().toLowerCase();
      if (fromVal === initialFrom && toVal === initialTo) return; // nothing actually changed
      try {
        await apiFetch(`/dictionary/${encodeDictId(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ lang_from: fromVal || null, lang_to: toVal || null }),
        });
        await Promise.all([loadAdminDicts(), loadDictPrefs()]);
      } catch (err) {
        toast.error(t('common.error_msg', { msg: err.message }));
      }
    }
    langWrap.addEventListener('focusout', (e) => {
      if (langWrap.contains(e.relatedTarget)) return; // focus moved to the other lang input — not done yet
      commitLangChange();
    });
    [fromInput, toInput].forEach(inp => {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    });
  });
}

// Renders a showProgressToast() counter as MB — dictionary ZIPs especially can be large
// enough that a raw byte counter (or no feedback at all, which is what this replaced) leaves
// the upload looking hung for a while.
function formatMB(loaded, total) {
  return `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
}

let _adminUploadsBound = false;
function bindAdminUploads() {
  if (_adminUploadsBound) return;
  _adminUploadsBound = true;

  document.getElementById('admin-font-upload')?.addEventListener('change', async function() {
    const files = Array.from(this.files);
    if (!files.length) return;
    this.value = '';
    for (const file of files) {
      const progress = showProgressToast(`${t('reader.uploading')} ${file.name}…`, formatMB);
      const fd = new FormData();
      fd.append('fonts', file);
      try {
        await apiUpload('/fonts', fd, (loaded, total) => progress.update(loaded, total));
        progress.dismiss(true);
        toast.success(file.name);
      } catch (e) {
        progress.dismiss(true);
        toast.error(`${file.name}: ${e.message}`);
      }
    }
    await loadAdminFonts();
  });

  document.getElementById('admin-dict-upload')?.addEventListener('change', async function() {
    const files = Array.from(this.files);
    if (!files.length) return;
    this.value = '';
    for (const file of files) {
      const progress = showProgressToast(`${t('reader.uploading')} ${file.name}…`, formatMB);
      const fd = new FormData();
      fd.append('dict', file);
      try {
        const result = await apiUpload('/dictionary', fd, (loaded, total) => progress.update(loaded, total));
        progress.dismiss(true);
        const r = result.results?.[0];
        if (r?.error) toast.error(`${file.name}: ${r.error}`);
        else toast.success(file.name);
      } catch (e) {
        progress.dismiss(true);
        toast.error(`${file.name}: ${e.message}`);
      }
    }
    // Also refresh the Dictionaries tab's own separate list (#settings-dict-list) — otherwise a
    // freshly uploaded dictionary doesn't show up there until Settings is reopened.
    await Promise.all([loadAdminDicts(), loadDictPrefs()]);
  });
}

// ── Dictionary preferences (all users) ───────────────────────────────────────
let _dictPrefsData  = { dicts: [], readerPrefs: {} };

async function saveDictPrefs() {
  try {
    await apiFetch('/settings', {
      method: 'PUT',
      body: JSON.stringify({ reader_prefs: _dictPrefsData.readerPrefs }),
    });
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  }
}

async function loadDictPrefs() {
  const container = document.getElementById('settings-dict-list');
  if (!container) return;

  let dicts = [], readerPrefs = {};
  try {
    [dicts, readerPrefs] = await Promise.all([
      apiFetch('/dictionary'),
      apiFetch('/settings').then(s => {
        try { return typeof s.reader_prefs === 'string' ? JSON.parse(s.reader_prefs) : (s.reader_prefs || {}); }
        catch { return {}; }
      }),
    ]);
  } catch { dicts = []; }

  _dictPrefsData = { dicts, readerPrefs };

  if (!dicts.length) {
    container.innerHTML = `<p style="color:var(--color-text-muted);font-size:.85rem;margin:0">${t('reader.dict_no_dicts_short')}</p>`;
    return;
  }

  const savedOrder = Array.isArray(readerPrefs.dictionaryOrder) && readerPrefs.dictionaryOrder.length
    ? readerPrefs.dictionaryOrder : dicts.map(d => d.id);
  const allIds  = dicts.map(d => d.id);
  const ordered = [...savedOrder.filter(id => allIds.includes(id)), ...allIds.filter(id => !savedOrder.includes(id))];

  function buildSettingsRow(id) {
    const d = dicts.find(x => x.id === id);
    if (!d) return null;
    const meta = readerPrefs.dictionaryMeta?.[id] || {};
    const lf = meta.lang_from ?? d.lang_from ?? '';
    const lt = meta.lang_to   ?? d.lang_to   ?? '';
    const row = document.createElement('div');
    row.className  = 'dict-settings-item';
    row.dataset.id = id;
    row.innerHTML = `
      <div class="dict-settings-name" style="flex:1">
        <span>${escHtml(d.name)}</span>
        ${d.wordcount ? `<span class="dict-settings-count">${d.wordcount.toLocaleString()} ${t('reader.dict_words')}</span>` : ''}
      </div>
      <div class="dict-lang-inputs">
        <input type="text" class="dict-lang-from" value="${escHtml(lf)}" maxlength="10"
          placeholder="${t('settings.dict_lang_placeholder')}"
          title="${t('settings.dict_lang_from')}" aria-label="${t('settings.dict_lang_from')}">
        <span class="dict-lang-sep">→</span>
        <input type="text" class="dict-lang-to" value="${escHtml(lt)}" maxlength="10"
          placeholder="${t('settings.dict_lang_placeholder')}"
          title="${t('settings.dict_lang_to')}" aria-label="${t('settings.dict_lang_to')}">
      </div>
      <div class="dict-order-btns">
        <button class="dict-order-btn" data-dir="up"   title="${t('reader.dict_move_up')}"   aria-label="${t('reader.dict_move_up')}">&#8593;</button>
        <button class="dict-order-btn" data-dir="down" title="${t('reader.dict_move_down')}" aria-label="${t('reader.dict_move_down')}">&#8595;</button>
      </div>`;

    function onLangChange() {
      const fromVal = row.querySelector('.dict-lang-from').value.trim().toLowerCase() || null;
      const toVal   = row.querySelector('.dict-lang-to').value.trim().toLowerCase()   || null;
      if (!_dictPrefsData.readerPrefs.dictionaryMeta)
        _dictPrefsData.readerPrefs.dictionaryMeta = {};
      if (fromVal || toVal) {
        _dictPrefsData.readerPrefs.dictionaryMeta[id] = { lang_from: fromVal, lang_to: toVal };
      } else {
        delete _dictPrefsData.readerPrefs.dictionaryMeta[id];
      }
      saveDictPrefs();
    }
    row.querySelector('.dict-lang-from').addEventListener('change', onLangChange);
    row.querySelector('.dict-lang-to').addEventListener('change',   onLangChange);

    row.querySelectorAll('.dict-order-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dir  = btn.dataset.dir;
        const rows = Array.from(container.children);
        const idx  = rows.indexOf(row);
        if (dir === 'up'   && idx > 0)             container.insertBefore(row, rows[idx - 1]);
        if (dir === 'down' && idx < rows.length - 1) container.insertBefore(rows[idx + 1], row);
        updateSettingsBtnState();
        // Persist new order
        _dictPrefsData.readerPrefs.dictionaryOrder =
          Array.from(container.children).map(el => el.dataset.id);
        saveDictPrefs();
      });
    });
    return row;
  }

  function updateSettingsBtnState() {
    const rows = Array.from(container.children);
    rows.forEach((r, i) => {
      r.querySelector('[data-dir="up"]').disabled   = (i === 0);
      r.querySelector('[data-dir="down"]').disabled = (i === rows.length - 1);
    });
  }

  container.innerHTML = '';
  ordered.forEach(id => {
    const row = buildSettingsRow(id);
    if (row) container.appendChild(row);
  });
  updateSettingsBtnState();
}

async function loadAdminSection() {
  try {
    const { isAdmin, user: _ } = await apiFetch('/auth/me');
    if (!isAdmin) return;
    adminCard.hidden = false;
    document.getElementById('settings-tab-admin').hidden = false;
    const { enabled } = await apiFetch('/auth/registration-status');
    adminRegTgl.checked = enabled;
    await loadAdminUsers();
    await loadAdminFonts();
    await loadAdminDicts();
    bindAdminUploads();
  } catch (_) { /* not admin or error — keep hidden */ }
}

// Relative "last active" label — this codebase's convention is a small local formatter per
// file (see e.g. reader.js's fmtTs for the sync dialog) rather than a shared date-fmt util.
function fmtRelativeActive(unixSecs) {
  if (!unixSecs) return t('settings.admin_never_active');
  const mins = Math.floor((Date.now() / 1000 - unixSecs) / 60);
  if (mins < 3)   return t('settings.admin_active_now');
  if (mins < 60)  return t('settings.admin_active_mins_ago',  { n: mins });
  if (mins < 1440) return t('settings.admin_active_hours_ago', { n: Math.floor(mins / 60) });
  return t('settings.admin_active_days_ago', { n: Math.floor(mins / 1440) });
}

// 7-day reading-activity dots, modeled visually on bookorbitDash.js's .bod-streak-dots
// (own small CSS class here, not a shared one — that panel is BookOrbit-account-wide,
// this is per-user-in-this-Codexa-instance, different data source and audience).
function adminActivityDotsHtml(dailySecs) {
  if (!dailySecs?.length) return '';
  return `<div class="admin-activity-dots">${dailySecs.map(secs =>
    `<span class="admin-activity-dot${secs > 0 ? ' filled' : ''}"></span>`).join('')}</div>`;
}

async function loadAdminUsers() {
  const list = document.getElementById('admin-users-list');
  if (!list) return;
  try {
    const users = await apiFetch('/auth/admin/users');
    if (!users.length) {
      list.innerHTML = `<p style="color:var(--color-text-muted);font-size:.85rem;margin:0" data-i18n="settings.admin_users_empty">${t('settings.admin_users_empty')}</p>`;
      return;
    }
    list.innerHTML = users.map(u => {
      const reading = u.currently_reading
        ? `<span class="admin-user-meta">${t('settings.admin_currently_reading', { title: escHtml(u.currently_reading.title) })}</span>`
        : '';
      return `
      <div class="admin-user-row" data-id="${u.id}">
        <div class="admin-user-info">
          <span class="admin-user-name">${escHtml(u.username)}</span>
          <span class="admin-user-meta">${t('settings.admin_users_books', { n: u.book_count })} &middot; ${fmtRelativeActive(u.last_active_at)}</span>
          ${reading}
          ${adminActivityDotsHtml(u.daily_secs)}
        </div>
        <button class="btn btn-danger btn-sm admin-user-delete-btn" data-id="${u.id}" data-username="${escHtml(u.username)}">${t('common.delete')}</button>
      </div>
    `;
    }).join('');
    list.querySelectorAll('.admin-user-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteAdminUser(Number(btn.dataset.id), btn.dataset.username));
    });
  } catch (err) {
    toast.error(t('settings.admin_err_load_users', { msg: err.message }));
  }
}

function deleteAdminUser(id, username) {
  confirmDialog(
    t('settings.admin_users_delete_confirm', { username }),
    async () => {
      try {
        await apiFetch(`/auth/admin/users/${id}`, { method: 'DELETE' });
        toast.success(t('settings.admin_users_deleted'));
        await loadAdminUsers();
      } catch (err) {
        toast.error(t('settings.admin_err_delete_user', { msg: err.message }));
      }
    },
    t('common.delete'),
    true
  );
}

document.getElementById('btn-reextract-all')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-reextract-all');
  setButtonLoading(btn, true);
  try {
    const result = await apiFetch('/books/reextract-all', { method: 'POST' });
    toast.success(t('library.toast_reextract_done', { updated: result.updated, total: result.total }));
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  } finally {
    setButtonLoading(btn, false, t('settings.btn_reextract_all'));
  }
});

btnSaveReg?.addEventListener('click', async () => {
  setButtonLoading(btnSaveReg, true, t('settings.btn_saving'));
  try {
    const { enabled } = await apiFetch('/auth/admin/registration', {
      method: 'PUT',
      body: JSON.stringify({ enabled: adminRegTgl.checked }),
    });
    adminRegTgl.checked = enabled;
    toast.success(enabled ? t('settings.admin_reg_enabled') : t('settings.admin_reg_disabled'));
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  } finally {
    setButtonLoading(btnSaveReg, false, t('settings.btn_save'));
  }
});
// ── Account email ─────────────────────────────────────────────────────────────
const accountEmail = document.getElementById('account-email');
const btnSaveEmail = document.getElementById('btn-save-email');

async function loadAccountEmail() {
  if (!accountEmail) return;
  try {
    const { user } = await apiFetch('/auth/me');
    accountEmail.value = user.email || '';
  } catch (_) { /* ignore — leave blank */ }
}

btnSaveEmail?.addEventListener('click', async () => {
  setButtonLoading(btnSaveEmail, true, t('settings.btn_saving'));
  try {
    const { email } = await apiFetch('/auth/email', {
      method: 'PUT',
      body: JSON.stringify({ email: accountEmail.value.trim() }),
    });
    accountEmail.value = email;
    toast.success(t('settings.email_save_success'));
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  } finally {
    setButtonLoading(btnSaveEmail, false, t('settings.email_save_btn'));
  }
});

// ── Change password ───────────────────────────────────────────────────────────
const btnChangePw = document.getElementById('btn-change-pw');
btnChangePw?.addEventListener('click', async () => {
  const pw1 = document.getElementById('pw-new').value;
  const pw2 = document.getElementById('pw-confirm').value;
  if (pw1.length < 8) { toast.error(t('settings.change_pw_short')); return; }
  if (pw1 !== pw2)    { toast.error(t('settings.change_pw_mismatch')); return; }
  setButtonLoading(btnChangePw, true, t('settings.btn_saving'));
  try {
    await apiFetch('/auth/password', { method: 'PUT', body: JSON.stringify({ password: pw1, password2: pw2 }) });
    document.getElementById('pw-new').value     = '';
    document.getElementById('pw-confirm').value = '';
    toast.success(t('settings.change_pw_success'));
  } catch (err) {
    toast.error(t('common.error_msg', { msg: err.message }));
  } finally {
    setButtonLoading(btnChangePw, false, t('settings.change_pw_btn'));
  }
});

// ── General settings (localStorage only) ─────────────────────────────────────
const autoOpenToggle = document.getElementById('auto-open-last-toggle');
if (autoOpenToggle) {
  autoOpenToggle.checked = localStorage.getItem('br_auto_open_last') === 'true';
  autoOpenToggle.addEventListener('change', () => {
    localStorage.setItem('br_auto_open_last', String(autoOpenToggle.checked));
  });
}

// ── OPDS server management ────────────────────────────────────────────────────
const opdsServerList = document.getElementById('opds-server-list');
const opdsEmpty      = document.getElementById('opds-empty');
const opdsAddDetails = document.getElementById('opds-add-details');
const opdsName       = document.getElementById('opds-name');
const opdsUrl        = document.getElementById('opds-url');
const opdsUsername   = document.getElementById('opds-username');
const opdsPassword   = document.getElementById('opds-password');
const btnAddOpds     = document.getElementById('btn-add-opds-server');

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadOpdsServers() {
  try {
    const servers = await apiFetch('/opds/servers');
    renderOpdsServers(servers);
  } catch (err) {
    toast.error(t('settings.err_load_opds', { msg: err.message }));
  }
}

const opdsFormTitle   = document.getElementById('opds-form-title');
const btnCancelEdit   = document.getElementById('btn-cancel-opds-edit');

function enterEditMode(s) {
  _editingServerId    = s.id;
  opdsName.value      = s.name;
  opdsUrl.value       = s.url;
  opdsUsername.value  = s.username || '';
  opdsPassword.value  = '';
  opdsFormTitle.textContent       = t('settings.opds_edit_title');
  btnAddOpds.textContent          = t('settings.btn_save_opds_edit');
  btnCancelEdit.hidden            = false;
  opdsAddDetails.setAttribute('open', '');
  opdsName.focus();
}

function exitEditMode() {
  _editingServerId    = null;
  opdsName.value = opdsUrl.value = opdsUsername.value = opdsPassword.value = '';
  opdsFormTitle.textContent = t('settings.opds_add_title');
  btnAddOpds.textContent    = t('settings.btn_add_opds');
  btnCancelEdit.hidden      = true;
  opdsAddDetails.removeAttribute('open');
}

function renderOpdsServers(servers) {
  _cachedServers = servers;
  opdsServerList.innerHTML = '';
  opdsEmpty.hidden = servers.length > 0;

  servers.forEach(s => {
    const row = document.createElement('div');
    row.className = 'opds-server-row';
    row.style.cssText = 'display:flex;align-items:center;gap:.75rem;padding:.6rem 0;border-bottom:1px solid var(--color-border)';
    row.innerHTML = `
      <div style="flex:1;min-width:0;font-weight:600;font-size:.875rem">${escHtml(s.name)}</div>
      <button class="btn btn-secondary btn-sm opds-open-btn" style="white-space:nowrap">${t('settings.opds_open')}</button>
      <button class="btn btn-secondary btn-sm opds-edit-btn">${t('settings.opds_edit')}</button>
      <button class="btn btn-danger btn-sm opds-del-btn">${t('settings.opds_remove')}</button>
    `;
    row.querySelector('.opds-open-btn').addEventListener('click', () => showPanel('opds'));
    row.querySelector('.opds-edit-btn').addEventListener('click', () => enterEditMode(s));
    row.querySelector('.opds-del-btn').addEventListener('click', () => deleteOpdsServer(s.id, s.name));
    opdsServerList.appendChild(row);
  });
}

function notifyOpdsServersChanged() {
  document.dispatchEvent(new CustomEvent('opdsserverschanged'));
}

async function deleteOpdsServer(id, name) {
  confirmDialog(
    t('settings.opds_confirm_remove', { name }),
    async () => {
      try {
        await apiFetch(`/opds/servers/${id}`, { method: 'DELETE' });
        toast.success(t('settings.opds_removed'));
        if (_editingServerId === id) exitEditMode();
        loadOpdsServers();
        notifyOpdsServersChanged();
      } catch (err) {
        toast.error(t('common.error_msg', { msg: err.message }));
      }
    },
    t('settings.opds_remove'),
    true
  );
}

btnAddOpds.addEventListener('click', async () => {
  const name     = opdsName.value.trim();
  const url      = opdsUrl.value.trim();
  const username = opdsUsername.value.trim();
  const password = opdsPassword.value;

  if (!name) { toast.error(t('settings.opds_err_name')); opdsName.focus(); return; }
  if (!url)  { toast.error(t('settings.opds_err_url')); opdsUrl.focus(); return; }
  if (!url.startsWith('http')) { toast.error(t('settings.opds_err_url_fmt')); return; }

  if (_editingServerId !== null) {
    // ── Edit existing server ──
    setButtonLoading(btnAddOpds, true, t('settings.btn_saving'));
    try {
      await apiFetch(`/opds/servers/${_editingServerId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, url, username, ...(password ? { password } : {}) }),
      });
      exitEditMode();
      toast.success(t('settings.opds_saved', { name }));
      loadOpdsServers();
      notifyOpdsServersChanged();
    } catch (err) {
      toast.error(t('common.error_msg', { msg: err.message }));
    } finally {
      setButtonLoading(btnAddOpds, false, t('settings.btn_save_opds_edit'));
    }
  } else {
    // ── Add new server ──
    setButtonLoading(btnAddOpds, true, t('settings.btn_adding'));
    try {
      await apiFetch('/opds/servers', {
        method: 'POST',
        body: JSON.stringify({ name, url, username, password }),
      });
      exitEditMode();
      toast.success(t('settings.opds_added', { name }));
      loadOpdsServers();
      notifyOpdsServersChanged();
    } catch (err) {
      toast.error(t('common.error_msg', { msg: err.message }));
    } finally {
      setButtonLoading(btnAddOpds, false, t('settings.btn_add_opds'));
    }
  }
});

btnCancelEdit.addEventListener('click', exitEditMode);

  // ── Init ──────────────────────────────────────────────────────────────────────
  loadSettings();
  loadOpdsServers();
  loadDictPrefs();
  loadAdminSection();
  loadAccountEmail();

  document.addEventListener('langchange', () => {
    loadDictPrefs();
    renderOpdsServers(_cachedServers);
    if (_editingServerId !== null) {
      document.getElementById('opds-form-title').textContent = t('settings.opds_edit_title');
      document.getElementById('btn-add-opds-server').textContent = t('settings.btn_save_opds_edit');
    } else {
      document.getElementById('opds-form-title').textContent = t('settings.opds_add_title');
      document.getElementById('btn-add-opds-server').textContent = t('settings.btn_add_opds');
    }
    if (!document.getElementById('admin-card').hidden) {
      loadAdminUsers();
      loadAdminFonts();
      loadAdminDicts();
    }
  });
} // end initSettings
