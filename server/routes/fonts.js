const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { DATA_DIR }          = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router    = express.Router();
const FONTS_DIR = path.join(DATA_DIR, 'fonts');
const ALLOWED   = new Set(['.ttf', '.otf', '.woff', '.woff2']);

router.use(authenticateToken);

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

module.exports = router;
