const express = require('express');
const { getDb }             = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

// ── GET /api/progress/:hash ────────────────────────────────────────────────────
router.get('/:hash', (req, res) => {
  const db  = getDb();
  const row = db.prepare(
    'SELECT cfi_position, percentage, device, updated_at FROM reading_progress WHERE user_id = ? AND document_hash = ?'
  ).get(req.user.id, req.params.hash);

  if (!row) return res.json({ cfi_position: '', percentage: 0, device: 'web' });
  res.json(row);
});

// ── PUT /api/progress/:hash ────────────────────────────────────────────────────
// By default this is a high-water-mark endpoint: progress only moves forward.
// Pass ?force=1 (or body { force: true }) to overwrite unconditionally (e.g. restart book).
router.put('/:hash', (req, res) => {
  const { cfi_position, percentage, device, force: bodyForce } = req.body;
  const forceOverwrite = bodyForce === true || req.query.force === '1';

  if (typeof percentage !== 'undefined' && (typeof percentage !== 'number' || percentage < 0 || percentage > 1)) {
    return res.status(400).json({ error: 'percentage mora biti število med 0 in 1' });
  }

  const db  = getDb();
  const pct = typeof percentage === 'number' ? percentage : 0;

  if (forceOverwrite) {
    // Unconditional overwrite — used when the user deliberately resets/jumps position
    db.prepare(`
      INSERT INTO reading_progress (user_id, document_hash, cfi_position, percentage, device, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT (user_id, document_hash) DO UPDATE SET
        cfi_position = excluded.cfi_position,
        percentage   = excluded.percentage,
        device       = excluded.device,
        updated_at   = excluded.updated_at
    `).run(req.user.id, req.params.hash, String(cfi_position || ''), pct, String(device || 'web').slice(0, 64));
  } else {
    // High-water mark: only advance the stored position, never go backwards.
    // Any device pushing a stale/lower percentage is silently ignored on the pct field.
    db.prepare(`
      INSERT INTO reading_progress (user_id, document_hash, cfi_position, percentage, device, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT (user_id, document_hash) DO UPDATE SET
        cfi_position = CASE WHEN excluded.percentage >= reading_progress.percentage
                            THEN excluded.cfi_position ELSE reading_progress.cfi_position END,
        percentage   = MAX(reading_progress.percentage, excluded.percentage),
        device       = CASE WHEN excluded.percentage >= reading_progress.percentage
                            THEN excluded.device ELSE reading_progress.device END,
        updated_at   = CASE WHEN excluded.percentage >= reading_progress.percentage
                            THEN excluded.updated_at ELSE reading_progress.updated_at END
    `).run(req.user.id, req.params.hash, String(cfi_position || ''), pct, String(device || 'web').slice(0, 64));
  }

  db.prepare(`
    UPDATE books SET last_opened_at = strftime('%s', 'now')
     WHERE user_id = ? AND file_hash = ?
  `).run(req.user.id, req.params.hash);

  res.json({ success: true });
});

module.exports = router;
