const express = require('express');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// All settings routes require a valid JWT
router.use(authenticateToken);

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db  = getDb();
  let row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);

  if (!row) {
    // User exists (JWT valid) but settings row is missing — create it now
    try {
      db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(req.user.id);
      row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
    } catch {
      return res.status(404).json({ error: 'Settings not found' });
    }
  }

  res.json({
    opds_servers:            JSON.parse(row.opds_servers  || '[]'),
    kosync_url:              row.kosync_url,
    kosync_username:         row.kosync_username,
    has_kosync_password:     row.kosync_password_enc !== '',
    kosync_internal_enabled: row.kosync_internal_enabled === 1,
    reader_prefs:            JSON.parse(row.reader_prefs || '{}'),
  });
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
router.put('/', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);

  if (!row) return res.status(404).json({ error: 'Settings not found' });

  const { opds_servers, kosync_url, kosync_username, kosync_password, kosync_internal_enabled, reader_prefs } = req.body;

  // Only update fields that were explicitly provided
  const next = {
    opds_servers:            opds_servers    !== undefined ? JSON.stringify(opds_servers)    : row.opds_servers,
    kosync_url:              kosync_url      !== undefined ? String(kosync_url)              : row.kosync_url,
    kosync_username:         kosync_username !== undefined ? String(kosync_username)         : row.kosync_username,
    // Empty string means "clear password"; undefined means "keep existing"
    kosync_password_enc:     kosync_password !== undefined ? String(kosync_password)         : row.kosync_password_enc,
    kosync_internal_enabled: kosync_internal_enabled !== undefined ? (kosync_internal_enabled ? 1 : 0) : row.kosync_internal_enabled,
    reader_prefs:            reader_prefs    !== undefined ? JSON.stringify(reader_prefs)    : row.reader_prefs,
  };

  db.prepare(`
    UPDATE user_settings
       SET opds_servers            = ?,
           kosync_url              = ?,
           kosync_username         = ?,
           kosync_password_enc     = ?,
           kosync_internal_enabled = ?,
           reader_prefs            = ?
     WHERE user_id = ?
  `).run(
    next.opds_servers,
    next.kosync_url,
    next.kosync_username,
    next.kosync_password_enc,
    next.kosync_internal_enabled,
    next.reader_prefs,
    req.user.id
  );

  res.json({ success: true });
});

module.exports = router;
