const express    = require('express');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');
const { getDb, DATA_DIR } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const BOOKS_DIR  = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

const router      = express.Router();
const SALT_ROUNDS = 12;

// Rate-limit sensitive auth endpoints: 10 attempts per 15 minutes per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'error.too_many_attempts' },
});

function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{3,32}$/.test(u);
}

// Not full RFC 5322 validation — just enough to catch typos. Emails are only ever an
// optional second login identifier / OIDC account-linking key, not verified via a sent link.
function isValidEmail(e) {
  return typeof e === 'string' && e.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function normalizeEmail(e) {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '1y' }
  );
}

function safeUser(user) {
  return { id: user.id, username: user.username, name: user.name || '', email: user.email || '' };
}

function isAdmin(userId) {
  const db  = getDb();
  const row = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  return row && row.id === userId;
}

function isRegistrationEnabled(db) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'registration_enabled'").get();
  return !row || row.value !== '0';
}

router.get('/registration-status', (req, res) => {
  const db = getDb();
  const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const enabled  = !hasUsers || isRegistrationEnabled(db);
  res.json({ enabled });
});

router.post('/register', authLimiter, async (req, res) => {
  try {
    const { name, username, password, email } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'error.credentials_required' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'error.username_invalid' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'error.password_too_short' });
    }
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
    let cleanEmail = null;
    if (typeof email === 'string' && email.trim() !== '') {
      cleanEmail = normalizeEmail(email);
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'error.email_invalid' });
      }
    }
    const db = getDb();
    const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (hasUsers && !isRegistrationEnabled(db)) {
      return res.status(403).json({ error: 'error.registration_disabled' });
    }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'error.username_taken' });
    }
    if (cleanEmail && db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) {
      return res.status(409).json({ error: 'error.email_taken' });
    }
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      'INSERT INTO users (username, name, password_hash, email) VALUES (?, ?, ?, ?)'
    ).run(username, cleanName, password_hash, cleanEmail);
    db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);
    const newUser = { id: result.lastInsertRowid, username, name: cleanName, email: cleanEmail };
    res.status(201).json({ token: signToken(newUser), user: safeUser(newUser) });
  } catch (err) {
    console.error('[auth] register error:', err.message);
    res.status(500).json({ error: 'error.register_failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const DUMMY_HASH = '$2b$12$invalidsaltinvalidsaltinvalid..invalidhashpadding0000000';
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'error.credentials_required' });
    }
    const db   = getDb();
    // Accept either the username or the account's email in the same field.
    const user = db.prepare(
      'SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)'
    ).get(username, normalizeEmail(username));
    const hashToCheck = user ? user.password_hash : DUMMY_HASH;
    const valid = await bcrypt.compare(String(password), hashToCheck);
    if (!user || !valid) {
      return res.status(401).json({ error: 'error.wrong_credentials' });
    }
    res.json({ token: signToken(user), user: safeUser(user) });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'error.login_failed' });
  }
});

router.get('/me', authenticateToken, (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT id, username, name, email FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(user), isAdmin: isAdmin(req.user.id) });
});

router.put('/admin/registration', authenticateToken, (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'error.admin_only' });
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'error.admin_only' });
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('registration_enabled', ?)").run(enabled ? '1' : '0');
  res.json({ enabled });
});

// ── Change own password ───────────────────────────────────────────────────────
router.put('/password', authenticateToken, async (req, res) => {
  try {
    const { password, password2 } = req.body;
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'error.password_too_short' });
    }
    if (password !== password2) {
      return res.status(400).json({ error: 'error.password_mismatch' });
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const db   = getDb();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] change password error:', err.message);
    res.status(500).json({ error: 'error.password_change_failed' });
  }
});

// ── Change own email ──────────────────────────────────────────────────────────
// Setting this lets the account also log in by email, and lets a future OIDC login
// (Google/self-hosted IdP/...) whose provider asserts a verified matching email auto-link
// to this existing account instead of creating a new one — see server/routes/oidc.js.
router.put('/email', authenticateToken, (req, res) => {
  try {
    const { email } = req.body;
    const db = getDb();
    if (typeof email !== 'string' || email.trim() === '') {
      // Empty value clears it (e.g. to stop using it for login / OIDC linking).
      db.prepare('UPDATE users SET email = NULL WHERE id = ?').run(req.user.id);
      return res.json({ email: '' });
    }
    const cleanEmail = normalizeEmail(email);
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ error: 'error.email_invalid' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(cleanEmail, req.user.id);
    if (existing) {
      return res.status(409).json({ error: 'error.email_taken' });
    }
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(cleanEmail, req.user.id);
    res.json({ email: cleanEmail });
  } catch (err) {
    console.error('[auth] change email error:', err.message);
    res.status(500).json({ error: 'error.email_change_failed' });
  }
});

// A session counts as real reading only when the user navigated at least 2 pages and spent
// at least 60 seconds — same definition stats.js's own REAL_SESSION uses for the per-user
// Statistics modal; kept as a local copy since stats.js doesn't export it.
const ADMIN_REAL_SESSION = 'end_ts IS NOT NULL AND pages_nav >= 2 AND (end_ts - start_ts) >= 60';
const ADMIN_ACTIVITY_DAYS = 7;

// ── Admin: list non-admin users ───────────────────────────────────────────────
router.get('/admin/users', authenticateToken, (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'error.admin_only' });
  const db      = getDb();
  const adminId = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get()?.id;
  const users   = db.prepare(
    'SELECT id, username, name, created_at, last_active_at FROM users WHERE id != ? ORDER BY created_at ASC'
  ).all(adminId);
  const bookCounts = db.prepare(
    'SELECT user_id, COUNT(*) AS cnt FROM books WHERE user_id != ? GROUP BY user_id'
  ).all(adminId);
  const countMap = Object.fromEntries(bookCounts.map(r => [r.user_id, r.cnt]));

  // Currently reading: the book from each user's most recent real-or-not session, plus its
  // reading_progress percentage if one exists. SQLite's documented MAX()-aggregate extension
  // (bare columns in a query with a single min()/max() are drawn from that same winning row)
  // is what makes the plain JOIN-then-GROUP BY below pick the right book/pct pair per user,
  // rather than needing a window function or per-user subquery.
  const currentlyReading = db.prepare(
    `SELECT rs.user_id, MAX(rs.start_ts) AS last_ts, b.title, b.author, rp.percentage
     FROM reading_sessions rs
     JOIN books b ON b.id = rs.book_id
     LEFT JOIN reading_progress rp ON rp.document_hash = b.file_hash AND rp.user_id = rs.user_id
     WHERE rs.user_id != ?
     GROUP BY rs.user_id`
  ).all(adminId);
  const currentlyReadingMap = Object.fromEntries(currentlyReading.map(r => [r.user_id, {
    title: r.title, author: r.author, percentage: r.percentage ?? null,
  }]));

  // Last N days of reading time per user, bucketed by UTC calendar day — powers the admin
  // panel's per-user activity dots (modeled visually on bookorbitDash.js's streak dots).
  const weekAgo = Math.floor(Date.now() / 1000) - ADMIN_ACTIVITY_DAYS * 86400;
  const recentSessions = db.prepare(
    `SELECT user_id, start_ts, end_ts FROM reading_sessions WHERE start_ts >= ? AND ${ADMIN_REAL_SESSION}`
  ).all(weekAgo);
  const todayBucket = Math.floor(Date.now() / 1000 / 86400);
  const dailySecsByUser = {}; // user_id → [oldest ... today] seconds array, length ADMIN_ACTIVITY_DAYS
  for (const s of recentSessions) {
    const bucket = Math.floor(s.start_ts / 86400);
    const idx = ADMIN_ACTIVITY_DAYS - 1 - (todayBucket - bucket);
    if (idx < 0 || idx >= ADMIN_ACTIVITY_DAYS) continue;
    if (!dailySecsByUser[s.user_id]) dailySecsByUser[s.user_id] = new Array(ADMIN_ACTIVITY_DAYS).fill(0);
    dailySecsByUser[s.user_id][idx] += (s.end_ts - s.start_ts);
  }

  res.json(users.map(u => {
    const daily = dailySecsByUser[u.id] || new Array(ADMIN_ACTIVITY_DAYS).fill(0);
    return {
      ...u,
      book_count:        countMap[u.id] || 0,
      currently_reading: currentlyReadingMap[u.id] || null,
      daily_secs:        daily,
      today_secs:        daily[daily.length - 1],
    };
  }));
});

// ── Admin: delete a user and all their data/files ─────────────────────────────
router.delete('/admin/users/:id', authenticateToken, (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'error.admin_only' });
  const db        = getDb();
  const adminId   = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get()?.id;
  const targetId  = parseInt(req.params.id, 10);
  if (targetId === adminId) return res.status(400).json({ error: 'error.cannot_delete_admin' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'error.user_not_found' });

  // Collect files before deleting DB records
  const books = db.prepare('SELECT filename, cover_path FROM books WHERE user_id = ?').all(targetId);

  // Delete user (cascades all DB records via foreign keys)
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

  // Remove book files and covers
  for (const book of books) {
    try { fs.unlinkSync(path.join(BOOKS_DIR, String(targetId), book.filename)); } catch { /* gone */ }
    if (book.cover_path) {
      try { fs.unlinkSync(path.join(COVERS_DIR, book.cover_path)); } catch { /* gone */ }
    }
  }
  // Remove the user's book directory
  try { fs.rmdirSync(path.join(BOOKS_DIR, String(targetId))); } catch { /* gone or non-empty */ }

  res.status(204).end();
});

// Exposed for server/routes/oidc.js, which mints the same kind of app JWT and follows the
// same username/user-row conventions for its own auto-provisioned accounts.
module.exports = Object.assign(router, { signToken, safeUser, isValidUsername, normalizeEmail, isRegistrationEnabled, SALT_ROUNDS, authLimiter });
