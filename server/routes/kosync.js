// KOReader kosync-compatible sync server
// Protocol reference: https://github.com/koreader/koreader-sync-server
//
// Public endpoints (KOReader points its sync settings here):
//   POST /users/create
//   GET  /users/auth
//   PUT  /syncs/progress
//   GET  /syncs/progress/:document
//
// Proxy endpoints (web reader uses these to talk to an external kosync server,
// e.g. Booklore/Grimmory, without CORS issues):
//   GET  /api/kosync/remote/:document
//   PUT  /api/kosync/remote/:document
//   GET  /api/kosync/test
//
// Requires Node.js 18+ for the built-in fetch() API.

const express = require('express');
const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const { getDb }             = require('../db');
const { authenticateToken } = require('../middleware/auth');

// ── Basic Auth helper ─────────────────────────────────────────────────────────
function parseBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon   = decoded.indexOf(':');
  if (colon === -1) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const DUMMY_HASH = '$2a$12$dummyhashfortimingprotectionXXXXXXXXXXXXXXXXXXXXXXX';

async function verifyBasicAuth(req) {
  const creds = parseBasicAuth(req);
  if (!creds) {
    await bcrypt.compare('dummy', DUMMY_HASH); // constant-time
    return null;
  }
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(creds.username);
  if (!user) {
    await bcrypt.compare(creds.password, DUMMY_HASH); // prevent timing attack
    return null;
  }
  const valid = await bcrypt.compare(creds.password, user.password_hash);
  return valid ? user : null;
}

// ── kosyncRouter — the public KOReader protocol endpoints ─────────────────────
const kosyncRouter = express.Router();

// POST /users/create
// KOReader registers a new account on this server.
// Returns 409 if username taken (KOReader will then try /users/auth instead).
kosyncRouter.post('/users/create', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'MISSING_FIELD' });
  }

  // Validate same rules as auth.js
  if (!/^[a-z0-9_]{3,32}$/i.test(username)) {
    return res.status(400).json({ error: 'INVALID_USERNAME' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'USERNAME_REGISTERED' });
  }

  try {
    const hash   = await bcrypt.hash(String(password), 12);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run(username, hash);
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);
    res.status(201).json({ username });
  } catch {
    res.status(500).json({ error: 'ERR' });
  }
});

// GET /users/auth
// KOReader verifies credentials via Basic Auth.
kosyncRouter.get('/users/auth', async (req, res) => {
  const user = await verifyBasicAuth(req);
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.json({ authorized: 'OK', username: user.username });
});

// PUT /syncs/progress
// KOReader pushes reading position: { document, progress, percentage, device, device_id }
// "progress" contains the CFI string (or KOReader's own position format).
kosyncRouter.put('/syncs/progress', async (req, res) => {
  const user = await verifyBasicAuth(req);
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED' });
  if (!isInternalEnabled(user.id)) return res.status(503).json({ error: 'DISABLED' });

  const { document, progress, percentage, device, device_id } = req.body || {};
  if (!document || progress === undefined || progress === null) {
    return res.status(400).json({ error: 'MISSING_FIELD' });
  }

  const pct = typeof percentage === 'number' ? percentage : parseFloat(percentage) || 0;
  const dev = String(device || device_id || 'koreader').slice(0, 64);

  const db = getDb();
  db.prepare(`
    INSERT INTO reading_progress (user_id, document_hash, cfi_position, percentage, device, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT (user_id, document_hash) DO UPDATE SET
      cfi_position = excluded.cfi_position,
      percentage   = excluded.percentage,
      device       = excluded.device,
      updated_at   = excluded.updated_at
  `).run(user.id, String(document).slice(0, 255), String(progress), pct, dev);

  res.json({ document, progress, percentage: pct, device: dev });
});

// GET /syncs/progress/:document
// KOReader pulls the latest reading position for a document.
kosyncRouter.get('/syncs/progress/:document', async (req, res) => {
  const user = await verifyBasicAuth(req);
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED' });
  if (!isInternalEnabled(user.id)) return res.status(503).json({ error: 'DISABLED' });

  const db  = getDb();
  const row = db.prepare(
    'SELECT cfi_position, percentage, device, updated_at FROM reading_progress WHERE user_id = ? AND document_hash = ?'
  ).get(user.id, req.params.document);

  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json({
    document:   req.params.document,
    progress:   row.cfi_position,
    percentage: row.percentage,
    device:     row.device,
    timestamp:  row.updated_at,
  });
});

// ── proxyRouter — JWT-protected proxy to external kosync server ───────────────
// Runs server-side so the browser avoids CORS issues with external servers.
const proxyRouter = express.Router();
proxyRouter.use(authenticateToken);

function getExternalSettings(userId) {
  const db = getDb();
  return db.prepare(
    'SELECT kosync_url, kosync_username, kosync_password_enc, kosync_internal_enabled FROM user_settings WHERE user_id = ?'
  ).get(userId);
}

function isInternalEnabled(userId) {
  const db = getDb();
  const s  = db.prepare('SELECT kosync_internal_enabled FROM user_settings WHERE user_id = ?').get(userId);
  return s?.kosync_internal_enabled === 1;
}

// KOReader kosync protocol uses custom headers, NOT HTTP Basic Auth.
// x-auth-user = username plain text
// x-auth-key  = MD5 hex of password (as KOReader sends it)
function buildKoreaderHeaders(username, password) {
  return {
    'x-auth-user': username,
    'x-auth-key':  crypto.createHash('md5').update(String(password)).digest('hex'),
    'Content-Type': 'application/json',
  };
}

// GET /api/kosync/test
// Test connection to the configured external kosync server.
proxyRouter.get('/test', async (req, res) => {
  const s = getExternalSettings(req.user.id);
  if (!s?.kosync_url) return res.json({ connected: false, reason: 'not_configured' });

  const url = `${s.kosync_url.replace(/\/$/, '')}/users/auth`;
  try {
    const r = await fetch(url, {
      headers: buildKoreaderHeaders(s.kosync_username, s.kosync_password_enc),
      signal:  AbortSignal.timeout(6000),
    });
    if (r.ok) {
      res.json({ connected: true });
    } else {
      res.json({ connected: false, reason: `HTTP ${r.status}` });
    }
  } catch (err) {
    res.json({ connected: false, reason: err.message });
  }
});

// GET /api/kosync/remote/:document
// Fetch progress from external kosync server for a given document hash.
// Returns null (not an error) when external server is not configured or unreachable.
proxyRouter.get('/remote/:document', async (req, res) => {
  const s = getExternalSettings(req.user.id);
  if (!s?.kosync_url) {
    console.log('[kosync] remote GET: skipped — no kosync_url configured');
    return res.json(null);
  }

  const url = `${s.kosync_url.replace(/\/$/, '')}/syncs/progress/${encodeURIComponent(req.params.document)}`;
  console.log('[kosync] remote GET:', url);
  try {
    const r = await fetch(url, {
      headers: buildKoreaderHeaders(s.kosync_username, s.kosync_password_enc),
      signal:  AbortSignal.timeout(5000),
    });
    console.log('[kosync] remote GET response:', r.status);
    if (r.status === 404) return res.json(null);
    if (!r.ok)            return res.json(null);
    const data = await r.json();
    console.log('[kosync] remote GET data:', JSON.stringify(data));
    res.json(data);
  } catch (err) {
    console.warn('[kosync] remote GET error:', err.message);
    res.json(null); // external unreachable — silent
  }
});

// PUT /api/kosync/remote/:document
// Push progress to external kosync server. Fire-and-forget from the reader's
// perspective — errors are logged server-side but not returned as failures.
proxyRouter.put('/remote/:document', async (req, res) => {
  const s = getExternalSettings(req.user.id);
  if (!s?.kosync_url) {
    console.log('[kosync] remote PUT: skipped — no kosync_url configured');
    return res.json({ skipped: true });
  }

  const url = `${s.kosync_url.replace(/\/$/, '')}/syncs/progress`;
  console.log('[kosync] remote PUT:', url, JSON.stringify(req.body));
  try {
    const r = await fetch(url, {
      method:  'PUT',
      headers: buildKoreaderHeaders(s.kosync_username, s.kosync_password_enc),
      body:   JSON.stringify(req.body),
      signal: AbortSignal.timeout(5000),
    });
    console.log('[kosync] remote PUT response:', r.status);
    res.json({ pushed: r.ok, status: r.status });
  } catch (err) {
    console.warn('[kosync] push to external failed:', err.message);
    res.json({ pushed: false });
  }
});

// GET /api/kosync/internal/:document
// Read the internal KOReader sync progress for the current user (by MD5 hash).
// Returns null when internal server is disabled or no entry exists.
proxyRouter.get('/internal/:document', (req, res) => {
  if (!isInternalEnabled(req.user.id)) return res.json(null);
  const db  = getDb();
  const row = db.prepare(
    'SELECT cfi_position, percentage, device, updated_at FROM reading_progress WHERE user_id = ? AND document_hash = ?'
  ).get(req.user.id, req.params.document);
  if (!row) return res.json(null);
  res.json({
    document:   req.params.document,
    progress:   row.cfi_position,
    percentage: row.percentage,
    device:     row.device,
    timestamp:  row.updated_at,
  });
});

// PUT /api/kosync/internal/:document
// Write the web reader's current position into the internal KOReader sync store.
// Used so KOReader devices picking up from this server get the web reader's position.
proxyRouter.put('/internal/:document', (req, res) => {
  if (!isInternalEnabled(req.user.id)) return res.json({ skipped: true });
  const { progress, percentage, device } = req.body;
  const pct = typeof percentage === 'number' ? percentage : parseFloat(percentage) || 0;
  const dev = String(device || 'web').slice(0, 64);
  const db  = getDb();
  db.prepare(`
    INSERT INTO reading_progress (user_id, document_hash, cfi_position, percentage, device, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT (user_id, document_hash) DO UPDATE SET
      cfi_position = excluded.cfi_position,
      percentage   = excluded.percentage,
      device       = excluded.device,
      updated_at   = excluded.updated_at
  `).run(req.user.id, req.params.document, String(progress || ''), pct, dev);
  res.json({ pushed: true });
});

module.exports = { kosyncRouter, proxyRouter };
