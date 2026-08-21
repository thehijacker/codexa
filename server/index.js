require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const { initDb, closeDb, DATA_DIR } = require('./db');

const authRoutes     = require('./routes/auth');
const oidcRoutes     = require('./routes/oidc');
const settingsRoutes = require('./routes/settings');
const booksRoutes    = require('./routes/books');
const progressRoutes = require('./routes/progress');
const fontsRoutes    = require('./routes/fonts');
const { kosyncRouter, proxyRouter } = require('./routes/kosync');
const opdsRoutes       = require('./routes/opds');
const dictionaryRoutes = require('./routes/dictionary');
const shelvesRoutes    = require('./routes/shelves');
const bookmarksRoutes    = require('./routes/bookmarks');
const annotationsRoutes  = require('./routes/annotations');
const statsRoutes        = require('./routes/stats');
const bookorbitRoutes    = require('./routes/bookorbit');
const bookorbitSync      = require('./services/bookorbitSync');
const { installConsolePrefix } = require('./utils/logger');

// Prefix every log line with a local timestamp + the current user (when known).
installConsolePrefix();

const app  = express();
const PORT = process.env.PORT || 3000;
const { version } = require('../package.json');

const DIST_DIR   = path.join(__dirname, '../dist');
const PUBLIC_DIR = path.join(__dirname, '../public');
const SERVE_DIR  = fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : PUBLIC_DIR;

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

// Gzip every response (JS/CSS/HTML/JSON) — nothing was compressing these before, so every asset
// (main.css, reader.js, etc.) was going out over the wire at full size on every request.
// Placed before static/route handlers so it wraps all of them; a reverse proxy in front (see
// README's "Self-Hosting Behind a Reverse Proxy") may also compress, which is harmless — this
// just guarantees it happens even for users running Codexa directly with no proxy at all.
//
// EXCEPT text/event-stream: the `compressible` mime lookup this package uses under the hood
// actually says SSE is compressible, so without this override every SSE route (BookOrbit/OPDS
// sync progress, the "Add to Codexa" download-progress bar) gets silently wrapped in a gzip
// Transform stream that buffers output until enough has accumulated — the client saw nothing
// but 0% for the whole download, then got the final result all at once. Worse, on a long enough
// gap with zero bytes actually reaching the browser, EventSource's own auto-reconnect kicked in
// and re-ran the entire import from scratch, downloading (and re-inserting) the same book twice.
// compression()'s own default filter is otherwise fine — only override the one content-type.
app.use(compression({
  filter: (req, res) => {
    // Express's res.set('Content-Type', 'text/event-stream') auto-appends "; charset=utf-8",
    // so this has to be a prefix check, not strict equality (confirmed live — a strict === here
    // silently never matched and gzip kept right on buffering the SSE stream).
    if (String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Browser-friendly module fallback for vendored Flow imports
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (path.extname(req.path)) return next();

  const publicDir = SERVE_DIR;

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

// ── Debug flag injection ──────────────────────────────────────────────────────
// Injects the DEBUG flag into HTML files (window.__DEBUG) and sw.js (__DEBUG).
// Set DEBUG=true in .env to enable verbose frontend console logging.
const CLIENT_DEBUG = process.env.DEBUG === 'true';
const _htmlSnippet = `<script>window.__DEBUG=${CLIENT_DEBUG};</script>`;
const _swSnippet   = `const __DEBUG=${CLIENT_DEBUG};\n`;

app.use((req, res, next) => {
  const filePath = path.resolve(SERVE_DIR, '.' + req.path);
  if (!filePath.startsWith(SERVE_DIR) || !fs.existsSync(filePath)) return next();

  if (req.path.endsWith('.html')) {
    const html = fs.readFileSync(filePath, 'utf8').replace('<head>', '<head>\n  ' + _htmlSnippet);
    return res.type('html').send(html);
  }
  if (req.path === '/sw.js') {
    const js = fs.readFileSync(filePath, 'utf8');
    return res.type('js').send(_swSnippet + js);
  }
  next();
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(SERVE_DIR));
// Expose extracted covers and user-uploaded fonts to the browser
app.use('/covers',     express.static(path.join(DATA_DIR, 'covers')));
app.use('/user-fonts', express.static(path.join(DATA_DIR, 'fonts')));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/auth/oidc', oidcRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/books',    booksRoutes);
app.use('/api/shelves',  shelvesRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/fonts',    fontsRoutes);
app.use('/api/kosync',     proxyRouter);   // JWT-protected proxy to external server
app.use('/api/opds',       opdsRoutes);
app.use('/api/dictionary', dictionaryRoutes);
app.use('/api/bookmarks',    bookmarksRoutes);
app.use('/api/annotations',  annotationsRoutes);
app.use('/api/stats',        statsRoutes);
app.use('/api/bookorbit',    bookorbitRoutes);

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

const server = app.listen(PORT, () => {
  console.log(`[server] Codexa running on http://localhost:${PORT}`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
// Without this, SIGTERM (every `docker stop`/restart) kills the process immediately —
// better-sqlite3 never gets to checkpoint its WAL file, which has been implicated in
// native-addon crashes (Assertion failed in RemoveEnvironmentCleanupHook) on the next start.
// server.close() alone isn't enough to bound the wait: opds.js and bookorbit.js hold
// long-lived SSE connections open that it would otherwise wait on indefinitely, so a
// force-exit timer backs it up — either way, closeDb() runs before the process actually exits.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down...`);

  const forceExitTimer = setTimeout(() => {
    console.warn('[server] shutdown timed out waiting for connections to drain, forcing exit');
    closeDb();
    process.exit(1);
  }, 5000);

  server.close(() => {
    clearTimeout(forceExitTimer);
    closeDb();
    console.log('[server] shutdown complete');
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── BookOrbit extended sync — periodic background reconcile ───────────────────
// Event-driven triggers (on highlight/session/status change) sync just the
// affected book promptly. This loop is the only FULL sweep — it backfills
// server-side / other-device changes for every opted-in user, so it runs
// infrequently and paces its requests. No-op for users without sync enabled.
const { getDb } = require('./db');
const BOOKORBIT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
// Stagger each user's full sweep instead of firing them all in the same tick — every
// opted-in user hitting BookOrbit at once (each doing several requests per book) was enough
// concurrent load to trip 502s on BookOrbit's own end (seen in its logs as a failed
// match-check right as the burst starts) and to slow down Codexa's own page loads while the
// sweep was in flight. Spreading starts out over the interval keeps the same total work but
// avoids the concurrent spike.
const BOOKORBIT_SYNC_STAGGER_MS = 45 * 1000;
setInterval(() => {
  let users;
  try {
    users = getDb().prepare('SELECT user_id FROM user_settings WHERE bookorbit_sync_enabled = 1').all();
  } catch { return; }
  users.forEach((u, i) => {
    setTimeout(() => bookorbitSync.triggerSync(u.user_id), i * BOOKORBIT_SYNC_STAGGER_MS).unref();
  });
}, BOOKORBIT_SYNC_INTERVAL_MS).unref();

// ── Ephemeral "peek" book cleanup — background sweep ──────────────────────────
// The reader signals a clean close via POST /api/books/:id/peek-cleanup (best-effort), but a
// forced close/crash can't be trusted to fire that. This sweep is the actual guarantee: any
// ephemeral peek row (+ its temp file) past its expiry gets reclaimed regardless.
const { sweepExpiredPeeks } = require('./utils/peekCleanup');
const PEEK_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
sweepExpiredPeeks(); // reclaim anything already expired across a restart
setInterval(sweepExpiredPeeks, PEEK_SWEEP_INTERVAL_MS).unref();
