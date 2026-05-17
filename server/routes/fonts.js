const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { DATA_DIR }          = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router    = express.Router();
const FONTS_DIR = path.join(DATA_DIR, 'fonts');
const TMP_DIR   = path.join(DATA_DIR, 'tmp');
const ALLOWED   = new Set(['.ttf', '.otf', '.woff', '.woff2']);

router.use(authenticateToken);

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ALLOWED.has(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('error.invalid_font_format'), ok);
  },
});

// GET /api/fonts — list font files available on the server
router.get('/', (_req, res) => {
  try {
    const files = fs.readdirSync(FONTS_DIR)
      .filter(f => ALLOWED.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    res.json(files);
  } catch {
    res.json([]);
  }
});

// POST /api/fonts — upload one or many font files
router.post('/', upload.array('fonts', 50), (req, res) => {
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });
  const saved = [];
  for (const file of req.files) {
    const safeName = path.basename(file.originalname).replace(/[^\w.\-]/g, '_');
    const dest     = path.join(FONTS_DIR, safeName);
    fs.renameSync(file.path, dest);
    saved.push(safeName);
  }
  res.json({ saved });
});

// DELETE /api/fonts/:filename
router.delete('/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const target   = path.resolve(FONTS_DIR, safeName);
  if (!target.startsWith(path.resolve(FONTS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'error.invalid_path' });
  }
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'error.not_found' });
  fs.unlinkSync(target);
  res.json({ ok: true });
});

module.exports = router;
