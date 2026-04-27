/**
 * api.js — centralised fetch wrapper
 * Reads the JWT from localStorage and attaches it to every request.
 */

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

  // If the server sends 401, clear credentials and redirect to login
  if (res.status === 401) {
    clearToken();
    if (!window.location.pathname.includes('/login.html')) {
      window.location.href = '/login.html';
    }
    throw new Error('Seja je potekla. Prosimo, prijavite se znova.');
  }

  if (!res.ok) {
    let msg = `Napaka ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error || msg;
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
