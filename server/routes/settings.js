const express = require('express');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const bookorbit = require('../services/bookorbitSync');

const router = express.Router();

// All settings routes require a valid JWT
router.use(authenticateToken);

// Dictionary selection has its own global sync + per-book-language-default logic
// (see reader.js renderDictSettings/showDictPopup) — presets never capture or apply it.
const DICTIONARY_KEYS = ['dictionaries', 'dictionaryOrder', 'dictionaryMeta'];
function stripDictionaryKeys(prefs) {
  const out = { ...(prefs || {}) };
  for (const k of DICTIONARY_KEYS) delete out[k];
  return out;
}

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
    kosync_external_enabled: row.kosync_external_enabled !== 0,
    bookorbit_sync_enabled:  row.bookorbit_sync_enabled === 1,
    bookorbit_url:           row.bookorbit_url || '',
    bookorbit_account_username: row.bookorbit_account_username || '',
    has_bookorbit_account_password: (row.bookorbit_account_password_enc || '') !== '',
    reader_prefs:            JSON.parse(row.reader_prefs || '{}'),
    reading_start_pct:       row.reading_start_pct  ?? 0,
    reading_finish_pct:      row.reading_finish_pct ?? 0.95,
  });
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
router.put('/', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);

  if (!row) return res.status(404).json({ error: 'Settings not found' });

  const { opds_servers, kosync_url, kosync_username, kosync_password, kosync_internal_enabled,
          kosync_external_enabled,
          bookorbit_sync_enabled, bookorbit_url, bookorbit_account_username, bookorbit_account_password,
          reader_prefs, reading_start_pct, reading_finish_pct } = req.body;

  // Both 0-1 fractions (same convention as reading_progress.percentage), consumed by
  // maybeMarkBookFinished (server/utils/bookCompletion.js). Reject out-of-range or inverted
  // values here rather than silently clamping — a wrong-order pair would otherwise (harmlessly,
  // per that function's branch logic, but still surprisingly) just never mark anything "reading"
  // before "read".
  for (const [name, val] of [['reading_start_pct', reading_start_pct], ['reading_finish_pct', reading_finish_pct]]) {
    if (val !== undefined && (typeof val !== 'number' || Number.isNaN(val) || val < 0 || val > 1)) {
      return res.status(400).json({ error: 'error.invalid_threshold' });
    }
  }
  const nextStartPct  = reading_start_pct  !== undefined ? reading_start_pct  : row.reading_start_pct;
  const nextFinishPct = reading_finish_pct !== undefined ? reading_finish_pct : row.reading_finish_pct;
  if (nextStartPct >= nextFinishPct) {
    return res.status(400).json({ error: 'error.threshold_order' });
  }

  // Only update fields that were explicitly provided
  const next = {
    opds_servers:            opds_servers    !== undefined ? JSON.stringify(opds_servers)    : row.opds_servers,
    kosync_url:              kosync_url      !== undefined ? String(kosync_url)              : row.kosync_url,
    kosync_username:         kosync_username !== undefined ? String(kosync_username)         : row.kosync_username,
    // Empty string means "clear password"; undefined means "keep existing"
    kosync_password_enc:     kosync_password !== undefined ? String(kosync_password)         : row.kosync_password_enc,
    kosync_internal_enabled: kosync_internal_enabled !== undefined ? (kosync_internal_enabled ? 1 : 0) : row.kosync_internal_enabled,
    kosync_external_enabled: kosync_external_enabled !== undefined ? (kosync_external_enabled ? 1 : 0) : row.kosync_external_enabled,
    bookorbit_sync_enabled:  bookorbit_sync_enabled  !== undefined ? (bookorbit_sync_enabled  ? 1 : 0) : row.bookorbit_sync_enabled,
    bookorbit_url:                  bookorbit_url              !== undefined ? String(bookorbit_url)              : row.bookorbit_url,
    bookorbit_account_username:     bookorbit_account_username !== undefined ? String(bookorbit_account_username) : row.bookorbit_account_username,
    bookorbit_account_password_enc: bookorbit_account_password !== undefined ? String(bookorbit_account_password) : row.bookorbit_account_password_enc,
    reader_prefs:            reader_prefs    !== undefined ? JSON.stringify(reader_prefs)    : row.reader_prefs,
    reading_start_pct:       nextStartPct,
    reading_finish_pct:      nextFinishPct,
  };

  db.prepare(`
    UPDATE user_settings
       SET opds_servers            = ?,
           kosync_url              = ?,
           kosync_username         = ?,
           kosync_password_enc     = ?,
           kosync_internal_enabled = ?,
           kosync_external_enabled = ?,
           bookorbit_sync_enabled  = ?,
           bookorbit_url                  = ?,
           bookorbit_account_username     = ?,
           bookorbit_account_password_enc = ?,
           reader_prefs            = ?,
           reading_start_pct       = ?,
           reading_finish_pct      = ?
     WHERE user_id = ?
  `).run(
    next.opds_servers,
    next.kosync_url,
    next.kosync_username,
    next.kosync_password_enc,
    next.kosync_internal_enabled,
    next.kosync_external_enabled,
    next.bookorbit_sync_enabled,
    next.bookorbit_url,
    next.bookorbit_account_username,
    next.bookorbit_account_password_enc,
    next.reader_prefs,
    next.reading_start_pct,
    next.reading_finish_pct,
    req.user.id
  );

  // Kick an initial reconcile only when the toggle is newly turned on.
  if (row.bookorbit_sync_enabled !== 1 && next.bookorbit_sync_enabled === 1) bookorbit.triggerSync(req.user.id);

  res.json({ success: true });
});

// ── Reader-settings presets ────────────────────────────────────────────────────
// Named snapshots of reader_prefs (minus dictionary keys), switchable from the
// reader's Theme tab and available on any device (stored server-side, not localStorage).

router.get('/presets', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, name, prefs, updated_at FROM reader_presets WHERE user_id = ? ORDER BY name COLLATE NOCASE'
  ).all(req.user.id);
  res.json(rows.map(r => ({ id: r.id, name: r.name, prefs: JSON.parse(r.prefs || '{}'), updated_at: r.updated_at })));
});

router.post('/presets', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const db = getDb();
  const prefs = JSON.stringify(stripDictionaryKeys(req.body.prefs));
  const info = db.prepare(
    'INSERT INTO reader_presets (user_id, name, prefs) VALUES (?, ?, ?)'
  ).run(req.user.id, name, prefs);
  const row = db.prepare('SELECT id, name, prefs, updated_at FROM reader_presets WHERE id = ?').get(info.lastInsertRowid);
  res.json({ id: row.id, name: row.name, prefs: JSON.parse(row.prefs), updated_at: row.updated_at });
});

router.put('/presets/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM reader_presets WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Preset not found' });

  const name  = req.body.name  !== undefined ? String(req.body.name).trim().slice(0, 60) : row.name;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const prefs = req.body.prefs !== undefined ? JSON.stringify(stripDictionaryKeys(req.body.prefs)) : row.prefs;

  db.prepare(
    `UPDATE reader_presets SET name = ?, prefs = ?, updated_at = strftime('%s','now') WHERE id = ? AND user_id = ?`
  ).run(name, prefs, req.params.id, req.user.id);

  const updated = db.prepare('SELECT id, name, prefs, updated_at FROM reader_presets WHERE id = ?').get(req.params.id);
  res.json({ id: updated.id, name: updated.name, prefs: JSON.parse(updated.prefs), updated_at: updated.updated_at });
});

router.delete('/presets/:id', (req, res) => {
  const db = getDb();
  const info = db.prepare('DELETE FROM reader_presets WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Preset not found' });
  res.json({ success: true });
});

module.exports = router;
