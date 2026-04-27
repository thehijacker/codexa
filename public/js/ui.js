/**
 * ui.js — shared UI helpers (toast, modal confirm, spinner)
 */
import { t } from './i18n.js';

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

export function showToast(message, type = 'info', duration = 3500) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 320);
  }, duration);
}

export const toast = {
  success: (msg) => showToast(msg, 'success'),
  error:   (msg) => showToast(msg, 'error'),
  info:    (msg) => showToast(msg, 'info'),
};

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
