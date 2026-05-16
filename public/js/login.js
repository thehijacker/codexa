import { apiFetch, setToken } from '/js/api.js';
import { setButtonLoading }  from '/js/ui.js';
import { initI18n, t, initIconLangPicker } from '/js/i18n.js';

(async () => {
  await initI18n();
  initIconLangPicker(document.getElementById('lang-picker-login'));

  // Apply e-ink theme when running inside the Android app with e-ink mode enabled
  if (typeof window.AndroidCodexa?.isEinkMode === 'function' && window.AndroidCodexa.isEinkMode()) {
    document.documentElement.setAttribute('data-lib-theme', 'eink');
  }

  // E-ink toggle row (only visible inside Android app)
  if (typeof window.AndroidCodexa?.isEinkMode === 'function') {
    const row    = document.getElementById('eink-toggle-row');
    const toggle = document.getElementById('login-eink-toggle');
    if (row && toggle) {
      row.style.display = 'flex';
      toggle.checked = window.AndroidCodexa.isEinkMode();
      toggle.addEventListener('change', () => {
        if (typeof window.AndroidCodexa?.setEinkMode === 'function') {
          window.AndroidCodexa.setEinkMode(toggle.checked);
        }
        if (toggle.checked) {
          document.documentElement.setAttribute('data-lib-theme', 'eink');
        } else {
          document.documentElement.removeAttribute('data-lib-theme');
        }
      });
    }
  }

  // Redirect if already logged in
  const existingToken = localStorage.getItem('br_token');
  if (existingToken) { window.location.href = '/'; return; }

  // ── Check registration status ─────────────────────────────────────────────
  try {
    const data = await apiFetch('/auth/registration-status');
    if (!data.enabled) {
      const regBtn = document.querySelector('[data-tab="register"]');
      if (regBtn) regBtn.style.display = 'none';
    }
  } catch (_) { /* silently ignore */ }

  // ── Tabs ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn, .tab-panel').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  function showAlert(id, message, type = 'error') {
    const el = document.getElementById(id);
    el.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
  }
  function clearAlert(id) {
    document.getElementById(id).innerHTML = '';
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert('login-alert');
    const btn      = document.getElementById('login-btn');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    if (!username || !password) {
      showAlert('login-alert', t('login.err_fill_all'));
      return;
    }

    setButtonLoading(btn, true);
    try {
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(data.token);
      localStorage.setItem('br_user', JSON.stringify(data.user));
      window.location.href = '/';
    } catch (err) {
      showAlert('login-alert', err.message);
      setButtonLoading(btn, false, t('login.btn_submit'));
    }
  });

  // Scroll focused input above keyboard on old Android (keyboard doesn't push content up)
  document.querySelectorAll('input').forEach(input => {
    input.addEventListener('focus', () => {
      setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350);
    });
  });

  // ── Register ──────────────────────────────────────────────────────────────
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert('register-alert');
    const btn      = document.getElementById('register-btn');
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;

    if (!username || !password || !password2) {
      showAlert('register-alert', t('login.err_fill_all'));
      return;
    }
    if (password !== password2) {
      showAlert('register-alert', t('login.err_no_match'));
      return;
    }
    if (password.length < 8) {
      showAlert('register-alert', t('login.err_pass_short'));
      return;
    }

    setButtonLoading(btn, true);
    try {
      const name = document.getElementById('reg-name').value.trim();
      const data = await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, username, password }),
      });
      setToken(data.token);
      localStorage.setItem('br_user', JSON.stringify(data.user));
      window.location.href = '/';
    } catch (err) {
      showAlert('register-alert', err.message);
      setButtonLoading(btn, false, t('login.reg_btn'));
    }
  });
})();
