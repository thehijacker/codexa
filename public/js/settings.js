import { apiFetch, requireAuth } from './api.js';
import { toast, confirmDialog, setButtonLoading } from './ui.js';
import { t, initI18n } from './i18n.js';

await initI18n();

if (!requireAuth()) throw new Error('not authenticated');

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
  } catch (err) {
    toast.error(t('settings.err_load', { msg: err.message }));
  }
}

function updateInternalUrlBox() {
  const on = kosyncInternalEnabled.checked;
  kosyncInternalUrlBox.hidden = !on;
  if (on) kosyncInternalUrlVal.textContent = window.location.origin;
}

kosyncInternalEnabled.addEventListener('change', updateInternalUrlBox);

// ── Status badge ──────────────────────────────────────────────────────────────
function updateStatusBadge(reason) {
  kosyncStatus.className = 'kosync-status';
  if (reason === null) {
    // We don't know yet — show neutral
    kosyncStatus.textContent = '';
    return;
  }
  if (reason === 'not_configured') {
    kosyncStatus.classList.add('status-off');
    kosyncStatus.textContent = t('settings.status_not_configured');
  } else if (reason === 'ok') {
    kosyncStatus.classList.add('status-ok');
    kosyncStatus.textContent = t('settings.status_ok');
  } else {
    kosyncStatus.classList.add('status-error');
    kosyncStatus.textContent = t('common.error') + ': ' + reason;
  }
}

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
// ── Admin: registration toggle ───────────────────────────────────────────
const adminCard    = document.getElementById('admin-card');
const adminRegTgl  = document.getElementById('admin-reg-toggle');
const btnSaveReg   = document.getElementById('btn-save-reg');

async function loadAdminSection() {
  try {
    const { isAdmin, user: _ } = await apiFetch('/auth/me');
    if (!isAdmin) return;
    // Show admin card and load current registration status
    adminCard.hidden = false;
    const { enabled } = await apiFetch('/auth/registration-status');
    adminRegTgl.checked = enabled;
  } catch (_) { /* not admin or error — keep hidden */ }
}

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
// ── Logout ────────────────────────────────────────────────────────────────────
document.getElementById('btn-logout')?.addEventListener('click', () => {
  localStorage.removeItem('br_token');
  localStorage.removeItem('br_user');
  window.location.href = '/login.html';
});

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

let _cachedServers = [];
let _editingServerId = null; // null = add mode, number = edit mode

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
      <a href="/opds.html" class="btn btn-secondary btn-sm" style="white-space:nowrap">${t('settings.opds_open')}</a>
      <button class="btn btn-secondary btn-sm opds-edit-btn">${t('settings.opds_edit')}</button>
      <button class="btn btn-danger btn-sm opds-del-btn">${t('settings.opds_remove')}</button>
    `;
    row.querySelector('.opds-edit-btn').addEventListener('click', () => enterEditMode(s));
    row.querySelector('.opds-del-btn').addEventListener('click', () => deleteOpdsServer(s.id, s.name));
    opdsServerList.appendChild(row);
  });
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
    } catch (err) {
      toast.error(t('common.error_msg', { msg: err.message }));
    } finally {
      setButtonLoading(btnAddOpds, false, t('settings.btn_add_opds'));
    }
  }
});

btnCancelEdit.addEventListener('click', exitEditMode);

document.addEventListener('langchange', () => {
  renderOpdsServers(_cachedServers);
  // Keep form title/button in sync with current mode after language change
  if (_editingServerId !== null) {
    opdsFormTitle.textContent = t('settings.opds_edit_title');
    btnAddOpds.textContent    = t('settings.btn_save_opds_edit');
  } else {
    opdsFormTitle.textContent = t('settings.opds_add_title');
    btnAddOpds.textContent    = t('settings.btn_add_opds');
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings();
loadOpdsServers();
loadAdminSection();
