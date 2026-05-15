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
};

/**
 * Shows a persistent toast with a progress bar.
 * Returns an object with `update(current, total, label)` and `dismiss()`.
 */
export function showProgressToast(label) {
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
      el.querySelector('.toast-progress-counter').textContent = `${current} / ${total}`;
    },
    dismiss() {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 320);
    },
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
