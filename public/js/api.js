/**
 * api.js — centralised fetch wrapper
 * Reads the JWT from localStorage and attaches it to every request.
 */
import { t } from './i18n.js';

const API_BASE = '/api';

export function getToken() {
  return localStorage.getItem('br_token');
}

export function setToken(token) {
  localStorage.setItem('br_token', token);
}

export function clearToken() {
  localStorage.removeItem('br_token');
  localStorage.removeItem('br_user');
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  // If the server sends 401 AND we had a token, it means the session expired.
  // If there was no token (e.g. a login attempt with wrong credentials), fall
  // through to the normal error handler so body.error is translated correctly.
  if (res.status === 401) {
    const hadToken = !!getToken();
    if (hadToken) {
      clearToken();
      if (!window.location.pathname.includes('/login.html')) {
        window.location.href = '/login.html';
      }
      throw new Error(t('error.session_expired'));
    }
  }

  if (!res.ok) {
    let msg = t('error.http_error', { status: res.status });
    try {
      const body = await res.json();
      // body.error may be an i18n key (e.g. 'error.wrong_credentials') or a plain message
      if (body.error) {
        const translated = t(body.error);
        msg = (translated !== body.error) ? translated : body.error;
      }
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  // 204 No Content
  if (res.status === 204) return null;

  return res.json();
}

export function requireAuth() {
  const token = getToken();
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}
