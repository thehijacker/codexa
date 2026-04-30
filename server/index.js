require('dotenv').config();
const express = require('express');
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
const readiumRoutes    = require('./routes/readium');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Startup ──────────────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('[fatal] JWT_SECRET is missing or too short. Set it in .env');
  process.exit(1);
}

initDb();

// ── Middleware ────────────────────────────────────────────────────────────────
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
// Expose extracted covers and user-uploaded fonts to the browser
app.use('/covers',     express.static(path.join(DATA_DIR, 'covers')));
app.use('/user-fonts', express.static(path.join(DATA_DIR, 'fonts')));
// Thorium Web locale files (loaded by i18next-http-backend at /locales/:lng/:ns.json)
app.use('/locales', express.static(
  path.join(__dirname, '../node_modules/@edrlab/thorium-web/dist/locales'),
  { maxAge: '1d' }
));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/books',    booksRoutes);
app.use('/api/shelves',  shelvesRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/fonts',    fontsRoutes);
app.use('/api/kosync',   proxyRouter);   // JWT-protected proxy to external server
app.use('/api/opds',       opdsRoutes);
app.use('/api/dictionary', dictionaryRoutes);
app.use('/api/readium',   readiumRoutes);

// KOReader kosync protocol — must be AFTER /api routes to avoid shadowing
// KOReader devices point their sync settings to this server's base URL.
app.use(kosyncRouter);

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
