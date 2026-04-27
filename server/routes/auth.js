const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router      = express.Router();
const SALT_ROUNDS = 12;

function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{3,32}$/.test(u);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function safeUser(user) {
  return { id: user.id, username: user.username, name: user.name || '' };
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

router.post('/register', async (req, res) => {
  try {
    const { name, username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Uporabniško ime in geslo sta obvezna.' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Uporabniško ime mora imeti 3–32 znakov.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Geslo mora imeti vsaj 8 znakov.' });
    }
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
    const db = getDb();
    const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (hasUsers && !isRegistrationEnabled(db)) {
      return res.status(403).json({ error: 'Registracija novih uporabnikov je onemogočena.' });
    }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'Uporabniško ime je zasedeno.' });
    }
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      'INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)'
    ).run(username, cleanName, password_hash);
    db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);
    const newUser = { id: result.lastInsertRowid, username, name: cleanName };
    res.status(201).json({ token: signToken(newUser), user: safeUser(newUser) });
  } catch (err) {
    console.error('[auth] register error:', err.message);
    res.status(500).json({ error: 'Registracija ni uspela.' });
  }
});

router.post('/login', async (req, res) => {
  const DUMMY_HASH = '$2b$12$invalidsaltinvalidsaltinvalid..invalidhashpadding0000000';
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Uporabniško ime in geslo sta obvezna.' });
    }
    const db   = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const hashToCheck = user ? user.password_hash : DUMMY_HASH;
    const valid = await bcrypt.compare(String(password), hashToCheck);
    if (!user || !valid) {
      return res.status(401).json({ error: 'Napačno uporabniško ime ali geslo.' });
    }
    res.json({ token: signToken(user), user: safeUser(user) });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Prijava ni uspela.' });
  }
});

router.get('/me', authenticateToken, (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT id, username, name FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(user), isAdmin: isAdmin(req.user.id) });
});

router.put('/admin/registration', authenticateToken, (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Samo administrator.' });
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Manjka polje enabled.' });
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('registration_enabled', ?)").run(enabled ? '1' : '0');
  res.json({ enabled });
});

module.exports = router;
