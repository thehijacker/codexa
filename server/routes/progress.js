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
router.put('/:hash', (req, res) => {
  const { cfi_position, percentage, device } = req.body;

  if (typeof percentage !== 'undefined' && (typeof percentage !== 'number' || percentage < 0 || percentage > 1)) {
    return res.status(400).json({ error: 'percentage mora biti število med 0 in 1' });
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO reading_progress (user_id, document_hash, cfi_position, percentage, device, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT (user_id, document_hash) DO UPDATE SET
      cfi_position = excluded.cfi_position,
      percentage   = excluded.percentage,
      device       = excluded.device,
      updated_at   = excluded.updated_at
  `).run(
    req.user.id,
    req.params.hash,
    String(cfi_position || ''),
    typeof percentage === 'number' ? percentage : 0,
    String(device || 'web').slice(0, 64)
  );

  res.json({ success: true });
});

module.exports = router;
