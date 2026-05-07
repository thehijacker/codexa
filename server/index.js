require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { initDb, DATA_DIR } = require('./db');

const authRoutes     = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const booksRoutes    = require('./routes/books');
const progressRoutes = require('./routes/progress');
const fontsRoutes    = require('./routes/fonts');
const { kosyncRouter, proxyRouter } = require('./routes/kosync');
const opdsRoutes       = require('./routes/opds');
const dictionaryRoutes = require('./routes/dictionary');
const shelvesRoutes    = require('./routes/shelves');
const bookmarksRoutes  = require('./routes/bookmarks');
const statsRoutes      = require('./routes/stats');

const app  = express();
const PORT = process.env.PORT || 3000;
const { version } = require('../package.json');

// ── Startup ──────────────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 64) {
  console.error('[fatal] JWT_SECRET is missing or too short (must be ≥64 chars). Set it in .env');
  process.exit(1);
}

initDb();

// ── Middleware ────────────────────────────────────────────────────────────────
// Trust the first proxy hop (nginx/traefik/etc.) so express-rate-limit can
// read the real client IP from X-Forwarded-For correctly.
app.set('trust proxy', 1);

if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Browser-friendly module fallback for vendored Flow imports
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (path.extname(req.path)) return next();

  const publicDir = path.join(__dirname, '../public');

  if (req.path.startsWith('/js/flow/')) {
    const filePath = path.join(publicDir, `${req.path}.js`);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }

    const indexPath = path.join(publicDir, req.path, 'index.js');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
  }

  if (req.path.startsWith('/js/utils/')) {
    const rewritten = `/js/flow${req.path.slice('/js'.length)}`;
    const filePath = path.join(publicDir, `${rewritten}.js`);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    const indexPath = path.join(publicDir, rewritten, 'index.js');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
  }

  if (req.path === '/js/mapping') {
    const filePath = path.join(publicDir, 'js/flow/mapping.js');
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }

  next();
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
// Expose extracted covers and user-uploaded fonts to the browser
app.use('/covers',     express.static(path.join(DATA_DIR, 'covers')));
app.use('/user-fonts', express.static(path.join(DATA_DIR, 'fonts')));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/books',    booksRoutes);
app.use('/api/shelves',  shelvesRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/fonts',    fontsRoutes);
app.use('/api/kosync',     proxyRouter);   // JWT-protected proxy to external server
app.use('/api/opds',       opdsRoutes);
app.use('/api/dictionary', dictionaryRoutes);
app.use('/api/bookmarks',  bookmarksRoutes);
app.use('/api/stats',      statsRoutes);

// KOReader kosync protocol — must be AFTER /api routes to avoid shadowing
// KOReader devices point their sync settings to this server's base URL.
app.use(kosyncRouter);

// ── Public metadata ─────────────────────────────────────────────────────────
app.get('/api/version', (_req, res) => res.json({ version }));

// ── 404 for unknown /api/* paths ──────────────────────────────────────────────
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[server] Codexa running on http://localhost:${PORT}`);
});
