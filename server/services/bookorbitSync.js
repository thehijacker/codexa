// BookOrbit extended sync — Codexa acts as a second BookOrbit *web reader*.
//
// BookOrbit (the third-party backend the user self-hosts) exposes a CFI-native
// web API that its own Foliate reader uses. Codexa's CXReader is also CFI-based
// (epubcfi), so Codexa talks to that web API directly — NOT the KOReader plugin
// API (which only accepts xpointer/pdf positions and a separate x-auth-key).
//
// Auth:    POST /auth/login {username,password} -> access_token/refresh_token
//          (JWT accepted as `Authorization: Bearer` per BookOrbit jwt.strategy).
// Mapping: books came into Codexa via BookOrbit's OPDS, so the stored
//          book_opds_sources.acq_href is `<base>/opds/<bookId>/download?fileId=<fileId>`.
// Feature endpoints (base = <server>/api/v1):
//   Annotations  GET/POST   /books/:bookId/annotations       PATCH/DELETE .../:id
//   Bookmarks    GET/POST   /books/:bookId/bookmarks         DELETE .../:id (no update route)
//   Sessions     POST       /books/:bookId/sessions          (no boFileId -> BookOrbit infers file & can't take an explicit progressDelta)
//                POST       /books/files/:fileId/sessions    (boFileId known -> explicit progressDelta + endProgress)
//   Read status  PATCH      /books/:id/status
//   Rating       POST       /books/bulk-set-rating
//
// Off unless the user enabled it AND configured BookOrbit account credentials.

const crypto = require('crypto');
const { getDb } = require('../db');
const { runWithUser } = require('../utils/logger');

const TIMEOUT_MS = 15000;
// Idle timeout for fetchAssetStream's book-file download only — a large comic/PDF can
// legitimately take well over TIMEOUT_MS to fully transfer, so that fixed deadline (fine for
// the quick metadata/API calls above) isn't reused there. This is reset on every chunk
// received instead, so it only fires on a genuinely stalled connection, not a slow-but-steady
// large download.
const STREAM_IDLE_TIMEOUT_MS = 30000;
const PACE_MS = 150;        // min spacing between API calls (be gentle on the throttler)
const MAX_429_RETRIES = 4;  // back off and retry when rate-limited

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// BookOrbit web read-status vocabulary (packages/types ReadStatus); Codexa uses
// a clean subset, sent verbatim. '' clears to 'unread'.
const VALID_STATUS = ['want_to_read', 'reading', 'read', 'abandoned'];

// Codexa highlight styles -> BookOrbit annotation styles. Codexa only makes
// color highlights, so everything maps to 'highlight'; foreign styles round-trip
// by being stored verbatim on the way down.
const WEB_STYLES = ['highlight', 'underline', 'strikethrough', 'squiggly', 'invert'];
function toWebStyle(s) {
  if (WEB_STYLES.includes(s)) return s;
  return 'highlight'; // 'lighten' / legacy / empty
}

// ── settings / context ────────────────────────────────────────────────────────
// BookOrbit's KOSync progress lives at <base>/api/v1/koreader; the web API is its
// sibling at <base>/api/v1. Derive the web base from the configured BookOrbit URL
// (still tolerate a pasted koreader-plugin URL or a bare host, for forgiveness).
function normalizeBookorbitUrl(bookorbitUrl) {
  let u = String(bookorbitUrl || '').replace(/\/+$/, '');
  if (!u) return '';
  u = u.replace(/\/koreader$/, '');
  if (!/\/api\/v\d+$/.test(u)) u += '/api/v1';
  return u;
}

// ignoreEnabled lets the settings-page "test connection" button verify credentials
// before the user has flipped the enabled toggle on.
function getContext(userId, { ignoreEnabled = false } = {}) {
  const db = getDb();
  const s = db.prepare(
    'SELECT bookorbit_url, kosync_url, kosync_username, kosync_password_enc, bookorbit_sync_enabled, bookorbit_account_username, bookorbit_account_password_enc FROM user_settings WHERE user_id = ?'
  ).get(userId);
  if (!s || (!ignoreEnabled && s.bookorbit_sync_enabled !== 1)) return null;
  if (!s.bookorbit_url || !s.bookorbit_account_username || !s.bookorbit_account_password_enc) return null;
  const webBase = normalizeBookorbitUrl(s.bookorbit_url);
  if (!webBase) return null;
  let origin;
  try { origin = new URL(webBase).origin; } catch { return null; }
  // KOReader sync sub-account (x-auth-key) — used only to resolve book ids by file hash via
  // /plugin/match-check, entirely optional (OPDS-link mapping is the fallback) and configured
  // independently under KOReader Sync, not required for BookOrbit extended sync to work at all.
  const koreaderBase = String(s.kosync_url || '').replace(/\/+$/, '');
  const koreaderUser = s.kosync_username || '';
  const koreaderKey = s.kosync_password_enc
    ? crypto.createHash('md5').update(String(s.kosync_password_enc)).digest('hex')
    : '';
  return {
    webBase, origin,
    username: s.bookorbit_account_username, password: s.bookorbit_account_password_enc,
    koreaderBase, koreaderUser, koreaderKey,
  };
}

function isEnabled(userId) {
  return getContext(userId) !== null;
}

// ── reachability tracking (in-memory, updated as a side effect of every real
// login()/api() call — no dedicated polling needed) ───────────────────────────
const lastStatus = new Map(); // userId -> { ok, error, at }

function recordStatus(userId, ok, error) {
  lastStatus.set(userId, { ok, error: ok ? null : (error || 'unknown error'), at: Date.now() });
}

// Passive: report the outcome of the most recent call, without making a new request.
// Used by the reader after a chapter/manual push, where an extra round-trip to BookOrbit
// itself would add latency — reachable is null (unknown) until any call has been attempted.
function getLastStatus(userId) {
  const ctx = getContext(userId);
  if (!ctx) return { enabled: false, reachable: null };
  const st = lastStatus.get(userId);
  if (!st) return { enabled: true, reachable: null };
  return { enabled: true, reachable: st.ok, error: st.error, checkedAt: st.at };
}

// Active: actually attempt to reach BookOrbit right now (used by the settings "test
// connection" button and the sidebar's once-per-load health check).
async function checkReachable(userId, opts = {}) {
  const ctx = getContext(userId, opts);
  if (!ctx) return { enabled: false, reachable: null };
  try { if (!tokens.has(userId)) await login(userId, ctx); }
  catch (e) { return { enabled: true, reachable: false, error: e.message }; }
  const r = await api(userId, ctx, 'GET', '/libraries');
  return { enabled: true, reachable: r.ok, error: r.ok ? null : (r.error || `HTTP ${r.status}`) };
}

// ── auth (in-memory token jar per user) ───────────────────────────────────────
const tokens = new Map(); // userId -> { access, refresh }

function extractToken(setCookies, name) {
  for (const c of setCookies || []) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function login(userId, ctx) {
  let res;
  try {
    res = await fetch(`${ctx.webBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: ctx.username, password: ctx.password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    recordStatus(userId, false, err.message);
    throw err;
  }
  if (!res.ok) {
    recordStatus(userId, false, `HTTP ${res.status}`);
    throw new Error(`login failed HTTP ${res.status}`);
  }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const access = extractToken(setCookies, 'access_token');
  const refresh = extractToken(setCookies, 'refresh_token');
  if (!access) {
    recordStatus(userId, false, 'login returned no access_token cookie');
    throw new Error('login returned no access_token cookie');
  }
  tokens.set(userId, { access, refresh });
  recordStatus(userId, true);
}

async function refresh(userId, ctx) {
  const tok = tokens.get(userId);
  if (!tok?.refresh) return login(userId, ctx);
  let res;
  try {
    res = await fetch(`${ctx.webBase}/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `refresh_token=${encodeURIComponent(tok.refresh)}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Network failure (e.g. BookOrbit unreachable) — fall back to a fresh login attempt, which
    // will itself fail cleanly (and record the real error) instead of throwing a raw fetch error.
    return login(userId, ctx);
  }
  if (!res.ok) return login(userId, ctx);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const access = extractToken(setCookies, 'access_token') || tok.access;
  const newRefresh = extractToken(setCookies, 'refresh_token') || tok.refresh;
  tokens.set(userId, { access, refresh: newRefresh });
}

// Authenticated request: paces calls, refreshes once on 401, backs off on 429.
async function api(userId, ctx, method, path, body, state = { refreshed: false, throttled: 0 }) {
  // login()/refresh() already record their own failure status; just make sure a rejection here
  // can never escape as an unhandled promise rejection (login() throws on any network failure,
  // e.g. DNS resolution — this used to crash the whole process on the very first BookOrbit call).
  if (!tokens.has(userId)) {
    try { await login(userId, ctx); }
    catch (err) { return { ok: false, status: 0, error: err.message }; }
  }
  const tok = tokens.get(userId);
  await sleep(PACE_MS);
  let res;
  try {
    res = await fetch(`${ctx.webBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tok.access}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    recordStatus(userId, false, err.message);
    return { ok: false, status: 0, error: err.message };
  }
  if (res.status === 401 && !state.refreshed) {
    try { await refresh(userId, ctx); }
    catch (err) { recordStatus(userId, false, err.message); return { ok: false, status: 0, error: err.message }; }
    return api(userId, ctx, method, path, body, { ...state, refreshed: true });
  }
  if (res.status === 429 && state.throttled < MAX_429_RETRIES) {
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * (state.throttled + 1);
    await sleep(waitMs);
    return api(userId, ctx, method, path, body, { ...state, throttled: state.throttled + 1 });
  }
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { /* empty / non-json */ }
  }
  if (!res.ok) {
    console.warn(`[bookorbit] ${method} ${path} -> HTTP ${res.status}`);
    // A request-specific error (403 permission, 404, validation, etc.) isn't a reachability
    // problem — BookOrbit clearly answered. Only network failures/timeouts (handled above)
    // and outright server errors count as "unreachable" for the health indicator.
    recordStatus(userId, res.status < 500, res.status >= 500 ? `HTTP ${res.status}` : null);
    return { ok: false, status: res.status, data };
  }
  recordStatus(userId, true);
  return { ok: true, status: res.status, data };
}

// ── book id mapping (from the OPDS acquisition href) ──────────────────────────
function parseBoIds(acqHref, origin) {
  if (!acqHref || !acqHref.startsWith(origin)) return null;
  const m = acqHref.match(/\/opds\/(\d+)\/download/);
  if (!m) return null;
  const f = acqHref.match(/[?&]fileId=(\d+)/);
  return { boBookId: parseInt(m[1], 10), boFileId: f ? parseInt(f[1], 10) : 0 };
}

// BookOrbit book ids from this book's stored OPDS acquisition link (no network).
function opdsIdsFor(db, userId, bookId, origin) {
  const rows = db.prepare('SELECT acq_href FROM book_opds_sources WHERE user_id = ? AND book_id = ?').all(userId, bookId);
  for (const r of rows) {
    const ids = parseBoIds(r.acq_href, origin);
    if (ids) return ids;
  }
  return null;
}

// Resolve book ids by partial-MD5 file hash via the KOReader match-check endpoint
// (x-auth-key). Returns Map<hashLower, { boBookId, boFileId }>.
async function matchCheckHashes(ctx, hashes) {
  const out = new Map();
  if (!ctx.koreaderKey || !ctx.koreaderUser || hashes.length === 0) return out;
  const headers = {
    'x-auth-user': ctx.koreaderUser,
    'x-auth-key': ctx.koreaderKey,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  for (let i = 0; i < hashes.length; i += 500) {
    const batch = hashes.slice(i, i + 500);
    let attempt = 0;
    for (;;) {
      await sleep(PACE_MS);
      let res;
      try {
        res = await fetch(`${ctx.koreaderBase}/plugin/match-check`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ deviceId: 'codexa-web', deviceModel: 'Codexa', pluginVersion: '1.0', hashes: batch }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        console.warn('[bookorbit] match-check failed:', err.message);
        break;
      }
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const ra = parseInt(res.headers.get('retry-after') || '', 10);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * (attempt + 1));
        attempt++;
        continue;
      }
      if (!res.ok) {
        console.warn(`[bookorbit] match-check -> HTTP ${res.status}`);
        break;
      }
      const data = await res.json().catch(() => null);
      for (const m of data?.matches || []) {
        if (m.hash && m.bookId) out.set(String(m.hash).toLowerCase(), { boBookId: m.bookId, boFileId: m.bookFileId || 0 });
      }
      break;
    }
  }
  return out;
}

// ── per-book sync-state helpers ───────────────────────────────────────────────
function saveMapping(db, userId, bookId, boBookId, boFileId) {
  db.prepare(`
    INSERT INTO bookorbit_sync_state (user_id, book_id, bo_book_id, bo_file_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, book_id) DO UPDATE SET bo_book_id = excluded.bo_book_id, bo_file_id = excluded.bo_file_id
  `).run(userId, bookId, boBookId, boFileId || null);
  return db.prepare('SELECT * FROM bookorbit_sync_state WHERE user_id = ? AND book_id = ?').get(userId, bookId);
}

// Public wrapper for saveMapping — used by the BookOrbit library-browser import route to
// record a freshly-downloaded book as already-owned (bo_book_id/bo_file_id), so subsequent
// browses and the background sync engine both recognize it immediately.
function mapLocalBook(userId, bookId, boBookId, boFileId) {
  return saveMapping(getDb(), userId, bookId, boBookId, boFileId);
}

// Resolve the BookOrbit ids for the requested local books: cached first, then a
// single match-check by file hash for the rest, then OPDS-link fallback.
async function resolveBooks(db, userId, ctx, opts) {
  const candidates = opts.bookId != null
    ? db.prepare("SELECT id, file_hash_md5 FROM books WHERE user_id = ? AND id = ?").all(userId, opts.bookId)
    : db.prepare("SELECT id, file_hash_md5 FROM books WHERE user_id = ?").all(userId);

  const resolved = [];
  const needHash = []; // { bookId, hash }
  for (const b of candidates) {
    const st = db.prepare('SELECT bo_book_id, bo_file_id FROM bookorbit_sync_state WHERE user_id = ? AND book_id = ?').get(userId, b.id);
    if (st?.bo_book_id) { resolved.push({ bookId: b.id, boBookId: st.bo_book_id, boFileId: st.bo_file_id || 0 }); continue; }
    const opds = opdsIdsFor(db, userId, b.id, ctx.origin);
    if (opds) { saveMapping(db, userId, b.id, opds.boBookId, opds.boFileId); resolved.push({ bookId: b.id, ...opds }); continue; }
    if (b.file_hash_md5) needHash.push({ bookId: b.id, hash: String(b.file_hash_md5).toLowerCase() });
  }

  if (needHash.length) {
    const map = await matchCheckHashes(ctx, [...new Set(needHash.map(x => x.hash))]);
    for (const x of needHash) {
      const m = map.get(x.hash);
      if (m) { saveMapping(db, userId, x.bookId, m.boBookId, m.boFileId); resolved.push({ bookId: x.bookId, ...m }); }
    }
  }
  return resolved;
}

// ── annotations (full two-way reconcile per book) ─────────────────────────────
async function syncAnnotations(userId, ctx, m, state) {
  const db = getDb();
  const since = state.ann_watermark || 0;

  const local = db.prepare('SELECT * FROM annotations WHERE user_id = ? AND book_id = ?').all(userId, m.bookId);
  const remoteRes = await api(userId, ctx, 'GET', `/books/${m.boBookId}/annotations`);
  if (!remoteRes.ok) return;
  const remote = Array.isArray(remoteRes.data) ? remoteRes.data : (remoteRes.data?.items || []);
  const remoteById = new Map(remote.map(r => [String(r.id), r]));
  const localByBo = new Map();
  for (const a of local) if (a.bo_id) localByBo.set(String(a.bo_id), a);

  // 1. Push local deletes, new highlights and edits (Codexa is authoritative for web-origin).
  let pushed = 0, pulled = 0;
  for (const a of local) {
    if (a.deleted) {
      if (a.bo_id) {
        const res = await api(userId, ctx, 'DELETE', `/books/${m.boBookId}/annotations/${a.bo_id}`);
        if (res.ok || res.status === 404) { db.prepare('DELETE FROM annotations WHERE id = ?').run(a.id); pushed++; }
      } else {
        db.prepare('DELETE FROM annotations WHERE id = ?').run(a.id); // never reached server
      }
      continue;
    }
    if (!a.bo_id) {
      if (!a.text) continue; // BookOrbit requires non-empty highlight text
      const res = await api(userId, ctx, 'POST', `/books/${m.boBookId}/annotations`, {
        cfi: a.cfi, text: a.text, color: a.color || 'yellow',
        style: toWebStyle(a.style), note: a.note || null,
        chapterTitle: null, bookFileId: m.boFileId || undefined,
      });
      if (res.ok && res.data?.id) {
        db.prepare("UPDATE annotations SET bo_id = ? WHERE id = ?").run(String(res.data.id), a.id);
        pushed++;
      }
    } else if ((a.updated_at || 0) > since) {
      const res = await api(userId, ctx, 'PATCH', `/books/${m.boBookId}/annotations/${a.bo_id}`, {
        color: a.color || 'yellow', style: toWebStyle(a.style), note: a.note || null,
      });
      if (res.ok) pushed++;
    }
  }

  // 2. Pull remote: insert ones Codexa lacks; remove ones deleted on the server.
  const insert = db.prepare(`
    INSERT INTO annotations (user_id, book_id, cfi, pct, text, note, color, style, bo_id, origin, updated_at, deleted)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, strftime('%s','now'), 0)
  `);
  for (const r of remote) {
    if (!r.cfi) continue; // Codexa can only place CFI-anchored highlights
    if (!localByBo.has(String(r.id))) {
      // Skip if a web-origin one we just created round-trips (matched by bo_id above).
      insert.run(userId, m.bookId, r.cfi, r.text || '', r.note || '', r.color || 'yellow',
        r.style || 'highlight', String(r.id), r.origin || 'web');
      pulled++;
    }
  }
  for (const [boId, a] of localByBo) {
    if (!remoteById.has(boId) && !a.deleted) {
      db.prepare('DELETE FROM annotations WHERE id = ?').run(a.id); // deleted on the server
      pulled++;
    }
  }

  if (pushed || pulled) console.log(`[bookorbit] book ${m.bookId}: annotations pushed ${pushed}, pulled/removed ${pulled}`);
  db.prepare('UPDATE bookorbit_sync_state SET ann_watermark = strftime(\'%s\',\'now\'), last_sync = strftime(\'%s\',\'now\') WHERE user_id = ? AND book_id = ?')
    .run(userId, m.bookId);
}

// ── bookmarks (full two-way reconcile per book, mirrors syncAnnotations) ──────
// BookOrbit's bookmark API has no update route (GET/POST/DELETE only), so there is nothing
// to PATCH — a bookmark is either created, deleted, or left alone.
async function syncBookmarks(userId, ctx, m) {
  const db = getDb();

  const local = db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND book_id = ?').all(userId, m.bookId);
  const remoteRes = await api(userId, ctx, 'GET', `/books/${m.boBookId}/bookmarks`);
  if (!remoteRes.ok) return;
  const remote = Array.isArray(remoteRes.data) ? remoteRes.data : (remoteRes.data?.items || []);
  const remoteById = new Map(remote.map(r => [String(r.id), r]));
  const localByBo = new Map();
  for (const b of local) if (b.bo_id) localByBo.set(String(b.bo_id), b);

  let pushed = 0, pulled = 0;
  for (const b of local) {
    if (b.deleted) {
      if (b.bo_id) {
        const res = await api(userId, ctx, 'DELETE', `/books/${m.boBookId}/bookmarks/${b.bo_id}`);
        if (res.ok || res.status === 404) { db.prepare('DELETE FROM bookmarks WHERE id = ?').run(b.id); pushed++; }
      } else {
        db.prepare('DELETE FROM bookmarks WHERE id = ?').run(b.id); // never reached server
      }
      continue;
    }
    if (!b.bo_id) {
      if (!b.cfi) continue; // BookOrbit requires cfi or positionSeconds; Codexa bookmarks are always CFI
      const title = (b.label || '').trim() || `${Math.round((b.pct || 0) * 100)}%`;
      const res = await api(userId, ctx, 'POST', `/books/${m.boBookId}/bookmarks`, { cfi: b.cfi, title });
      if (res.ok && res.data?.id) {
        db.prepare('UPDATE bookmarks SET bo_id = ? WHERE id = ?').run(String(res.data.id), b.id);
        pushed++;
      }
    }
  }

  const insert = db.prepare(`
    INSERT INTO bookmarks (user_id, book_id, cfi, pct, label, bo_id, deleted)
    VALUES (?, ?, ?, 0, ?, ?, 0)
  `);
  for (const r of remote) {
    if (!r.cfi) continue; // Codexa can only place CFI-anchored bookmarks
    if (!localByBo.has(String(r.id))) {
      insert.run(userId, m.bookId, r.cfi, r.title || '', String(r.id));
      pulled++;
    }
  }
  for (const [boId, b] of localByBo) {
    if (!remoteById.has(boId) && !b.deleted) {
      db.prepare('DELETE FROM bookmarks WHERE id = ?').run(b.id); // deleted on the server
      pulled++;
    }
  }

  if (pushed || pulled) console.log(`[bookorbit] book ${m.bookId}: bookmarks pushed ${pushed}, pulled/removed ${pulled}`);
}

// ── reading sessions (one-way up; only "real" sessions) ───────────────────────
// When boFileId is known, sessions go to the fileId-scoped endpoint so we can send an
// explicit progressDelta computed from our own start/end percentages. This matters because
// BookOrbit's bookId-scoped "manual session" endpoint has no progressDelta field — it derives
// one from the previous session it knows about, which is wrong (usually way overstated) the
// first time a book's sessions start carrying endProgress, since BookOrbit has no earlier
// baseline to diff against. Falls back to the bookId-scoped endpoint when boFileId is unknown.
async function uploadSessions(userId, ctx, m, state) {
  const db = getDb();
  const wm = state.sessions_watermark || 0;
  const sessions = db.prepare(
    'SELECT id, start_ts, end_ts, pages_nav, start_pct, end_pct FROM reading_sessions WHERE user_id = ? AND book_id = ? AND end_ts IS NOT NULL AND id > ? ORDER BY id'
  ).all(userId, m.bookId, wm);

  let maxId = wm;
  for (const s of sessions) {
    maxId = Math.max(maxId, s.id);
    const dur = (s.end_ts || 0) - (s.start_ts || 0);
    if (dur < 60 || (s.pages_nav || 0) < 2) continue; // skip non-real sessions

    const endProgress = s.end_pct != null ? Math.round(s.end_pct * 10000) / 100 : null;
    let res;
    if (m.boFileId) {
      const progressDelta = (s.start_pct != null && s.end_pct != null)
        ? Math.max(-100, Math.min(100, Math.round((s.end_pct - s.start_pct) * 10000) / 100))
        : null;
      const body = {
        sessionId: `cxa:${m.boFileId}:${s.id}`,
        startedAt: new Date(s.start_ts * 1000).toISOString(),
        endedAt: new Date(s.end_ts * 1000).toISOString(),
        durationSeconds: dur,
      };
      if (progressDelta != null) body.progressDelta = progressDelta;
      if (endProgress != null) body.endProgress = endProgress;
      res = await api(userId, ctx, 'POST', `/books/files/${m.boFileId}/sessions`, body);
    } else {
      const durationMinutes = Math.max(1, Math.min(1440, Math.round(dur / 60)));
      const body = { startedAt: new Date(s.start_ts * 1000).toISOString(), durationMinutes };
      if (endProgress != null) body.endProgress = endProgress;
      res = await api(userId, ctx, 'POST', `/books/${m.boBookId}/sessions`, body);
    }
    if (!res.ok) { maxId = s.id - 1; break; } // retry this one next run
  }
  if (maxId > wm) {
    db.prepare('UPDATE bookorbit_sync_state SET sessions_watermark = ? WHERE user_id = ? AND book_id = ?')
      .run(maxId, userId, m.bookId);
  }
}

// ── read status + rating (push on local change; adopt remote when local empty) ─
async function syncBookState(userId, ctx, m, state) {
  const db = getDb();
  const b = db.prepare('SELECT read_status, rating, status_modified FROM books WHERE id = ?').get(m.bookId);
  if (!b) return;
  const wm = state.state_watermark || 0;

  if ((b.status_modified || 0) > wm) {
    if (b.read_status && VALID_STATUS.includes(b.read_status)) {
      await api(userId, ctx, 'PATCH', `/books/${m.boBookId}/status`, { status: b.read_status });
    } else if (!b.read_status) {
      await api(userId, ctx, 'PATCH', `/books/${m.boBookId}/status`, { status: 'unread' });
    }
    if (b.rating != null) {
      await api(userId, ctx, 'POST', '/books/bulk-set-rating', { bookIds: [m.boBookId], rating: b.rating });
    }
    db.prepare('UPDATE bookorbit_sync_state SET state_watermark = ? WHERE user_id = ? AND book_id = ?')
      .run(b.status_modified, userId, m.bookId);
  } else if (!b.read_status && b.rating == null) {
    // Local never set — adopt BookOrbit's value once.
    const res = await api(userId, ctx, 'GET', `/books/${m.boBookId}`);
    if (res.ok && res.data) {
      // BookOrbit's GET /books/:id returns readStatus as an object
      // ({ status, source, startedAt, ... }); older shapes may send a bare string.
      const rsRaw = res.data.readStatus;
      const rs = typeof rsRaw === 'string' ? rsRaw : rsRaw?.status;
      const rt = res.data.rating;
      if ((rs && VALID_STATUS.includes(rs)) || rt != null) {
        db.prepare('UPDATE books SET read_status = ?, rating = ?, status_modified = strftime(\'%s\',\'now\') WHERE id = ?')
          .run(VALID_STATUS.includes(rs) ? rs : '', rt != null ? rt : null, m.bookId);
      }
    }
  }
}

// ── recommendations / series lookups (on-demand, read-only, single book) ─────
function mapRecBook(b) {
  return {
    boBookId: b.id,
    title: b.title,
    authors: b.authors || [],
    hasCover: !!b.hasCover,
    seriesIndex: b.seriesIndex ?? null,
  };
}

const EMPTY_RELATED = { enabled: true, mapped: false, recommendations: [], seriesBooks: [], nextInSeries: null, authorBooks: [] };

// Shared by getRecommendations() (local bookId, used by the local book info modal's Related tab)
// and getRelatedByBoId() (direct boBookId, used by the BookOrbit library's own detail modal for
// books that may not be imported into Codexa yet — there's no local mapping to resolve there).
async function fetchRelated(userId, ctx, boBookId) {
  const [recRes, seriesRes, authorRes] = await Promise.all([
    api(userId, ctx, 'GET', `/books/${boBookId}/recommendations`),
    api(userId, ctx, 'GET', `/books/${boBookId}/series-books`),
    api(userId, ctx, 'GET', `/books/${boBookId}/author-books`),
  ]);

  const recommendations = (recRes.ok && Array.isArray(recRes.data) ? recRes.data : []).map(mapRecBook);

  const seriesRaw = seriesRes.ok && Array.isArray(seriesRes.data) ? seriesRes.data : [];
  const idx = seriesRaw.findIndex(b => b.id === boBookId);
  const nextInSeries = idx >= 0 && idx + 1 < seriesRaw.length ? mapRecBook(seriesRaw[idx + 1]) : null;
  const seriesBooks = seriesRaw.filter(b => b.id !== boBookId).map(mapRecBook);

  const authorBooks = (authorRes.ok && Array.isArray(authorRes.data) ? authorRes.data : [])
    .filter(b => b.id !== boBookId).map(mapRecBook);

  return { recommendations, seriesBooks, nextInSeries, authorBooks };
}

async function getRecommendations(userId, bookId) {
  const ctx = getContext(userId);
  if (!ctx) return { ...EMPTY_RELATED, enabled: false };
  const db = getDb();
  const resolved = await resolveBooks(db, userId, ctx, { bookId });
  const m = resolved[0];
  if (!m) return EMPTY_RELATED;

  try { if (!tokens.has(userId)) await login(userId, ctx); }
  catch { return EMPTY_RELATED; }

  const related = await fetchRelated(userId, ctx, m.boBookId);
  return { enabled: true, mapped: true, ...related };
}

// For a book identified directly by its BookOrbit id (catalog browsing in bookorbit.js — the
// caller already has boBookId in hand, no local bookId->boBookId resolution needed).
async function getRelatedByBoId(userId, ctx, boBookId) {
  try { if (!tokens.has(userId)) await login(userId, ctx); }
  catch { return { recommendations: [], seriesBooks: [], nextInSeries: null, authorBooks: [] }; }
  return fetchRelated(userId, ctx, boBookId);
}

// Fetch a BookOrbit-hosted image (thumbnail) through our own server so the browser never
// needs BookOrbit's JWT directly. Shares the same token jar as api().
async function fetchAsset(userId, ctx, path) {
  // Same "never let login()/refresh() throw past us" guard as api() — every current caller
  // happens to wrap this in its own try/catch, but that shouldn't be the only thing standing
  // between a BookOrbit network failure and a process-crashing unhandled rejection.
  if (!tokens.has(userId)) {
    try { await login(userId, ctx); } catch { return { ok: false }; }
  }
  const doFetch = () => {
    const tok = tokens.get(userId);
    return fetch(`${ctx.webBase}${path}`, {
      headers: { authorization: `Bearer ${tok.access}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };
  let res;
  try { res = await doFetch(); } catch { return { ok: false }; }
  if (res.status === 401) {
    try { await refresh(userId, ctx); } catch { return { ok: false }; }
    try { res = await doFetch(); } catch { return { ok: false }; }
  }
  if (!res.ok) return { ok: false, status: res.status };
  const buffer = Buffer.from(await res.arrayBuffer());
  // See fetchAssetStream's identical check below for why this matters even here.
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > 0 && buffer.length < total) {
    console.warn(`[bookorbit] download incomplete: got ${buffer.length} of ${total} bytes for ${path}`);
    return { ok: false, incomplete: true, loaded: buffer.length, total };
  }
  return { ok: true, contentType: res.headers.get('content-type') || 'image/jpeg', buffer };
}

// Same as fetchAsset, but reads the response body incrementally and reports {loaded, total}
// via onProgress as chunks arrive — used for the "Add to Codexa" book-file download, where the
// client wants a real byte progress bar (see server/routes/bookorbit.js's import-sse route).
// fetchAsset itself stays untouched (still used for small, progress-irrelevant assets like
// cover thumbnails) rather than growing an optional-callback parameter everywhere.
//
// `abandonSignal` is optional: the caller's own "client went away" signal (e.g. the import-sse
// route's req.on('close')). Wiring it into the same controller that drives the idle timeout
// means a client disconnect stops this download immediately, instead of it running to
// completion in the background against nobody — which was the root cause of a real crash (see
// import-sse's own comment).
async function fetchAssetStream(userId, ctx, path, onProgress, abandonSignal) {
  if (!tokens.has(userId)) {
    try { await login(userId, ctx); } catch { return { ok: false }; }
  }
  // An idle timeout (armed here, re-armed on every chunk below), not AbortSignal.timeout's
  // fixed deadline — see STREAM_IDLE_TIMEOUT_MS above for why.
  const controller = new AbortController();
  if (abandonSignal) {
    if (abandonSignal.aborted) controller.abort();
    else abandonSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let idleTimer;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
  };
  const doFetch = () => {
    const tok = tokens.get(userId);
    armIdleTimer();
    return fetch(`${ctx.webBase}${path}`, {
      headers: { authorization: `Bearer ${tok.access}` },
      signal: controller.signal,
    });
  };
  let res;
  try { res = await doFetch(); } catch { clearTimeout(idleTimer); return { ok: false }; }
  if (res.status === 401) {
    try { await refresh(userId, ctx); } catch { clearTimeout(idleTimer); return { ok: false }; }
    try { res = await doFetch(); } catch { clearTimeout(idleTimer); return { ok: false }; }
  }
  if (!res.ok) { clearTimeout(idleTimer); return { ok: false, status: res.status }; }

  const total = Number(res.headers.get('content-length')) || 0;
  const contentType = res.headers.get('content-type') || 'application/octet-stream';

  if (!res.body?.getReader) {
    // No streamable body (shouldn't happen with Node's fetch) — fall back to buffering whole.
    const buffer = Buffer.from(await res.arrayBuffer());
    clearTimeout(idleTimer);
    onProgress?.(buffer.length, total || buffer.length);
    // See the streaming path's identical check below for why this matters.
    if (total > 0 && buffer.length < total) {
      console.warn(`[bookorbit] download incomplete: got ${buffer.length} of ${total} bytes for ${path}`);
      return { ok: false, incomplete: true, loaded: buffer.length, total };
    }
    return { ok: true, contentType, buffer };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimer(); // got data — connection is alive, push the deadline back out
      chunks.push(value);
      loaded += value.length;
      onProgress?.(loaded, total);
    }
  } catch {
    return { ok: false }; // stalled connection (idle timeout) or other stream error
  } finally {
    clearTimeout(idleTimer);
  }

  // A response body can end "cleanly" (reader.read() reporting done:true, no error thrown) while
  // still being short of what the server itself declared via Content-Length — confirmed live as
  // the real shape of the "book with no cover" reports: BookOrbit's connection got torn down
  // partway (by an intermediate proxy/CDN hop enforcing its own timeout, not necessarily
  // BookOrbit itself) in a way Node's fetch didn't surface as a stream error, so the truncated
  // buffer sailed straight through as a "successful" download, got written to disk, and handed
  // to the ZIP/EPUB parser as if it were the whole file — a truncated ZIP's central directory is
  // exactly the kind of thing that can produce a book with metadata but no cover (the cover
  // entry, wherever it lived in the archive, never arrived), and re-parsing that same malformed
  // file on every retry is the leading suspect for the crash it also causes. This length check
  // is the only reliable place left to catch it before those bytes are ever written or parsed.
  if (total > 0 && loaded < total) {
    console.warn(`[bookorbit] download incomplete: got ${loaded} of ${total} bytes for ${path}`);
    return { ok: false, incomplete: true, loaded, total };
  }
  return { ok: true, contentType, buffer: Buffer.concat(chunks.map(c => Buffer.from(c))) };
}

async function getCover(userId, boBookId) {
  const ctx = getContext(userId);
  if (!ctx) return { ok: false };
  return fetchAsset(userId, ctx, `/books/${boBookId}/thumbnail`);
}

// ── orchestrator ──────────────────────────────────────────────────────────────
const running = new Set();

// opts.bookId — sync only that book (used by mutation triggers). Without it,
// runSync does a full reconcile sweep (the periodic background pass).
async function runSync(userId, opts = {}) {
  if (running.has(userId)) return;
  const ctx = getContext(userId);
  if (!ctx) return;
  // Ephemeral peek rows (server/utils/peekCleanup.js) are never mapped into BookOrbit and never
  // will be — skip silently instead of doing a doomed lookup that just logs "not in your
  // BookOrbit library" noise. Centralized here (rather than at each triggerSync call site —
  // books.js's /opened, annotations.js, bookmarks.js) so it covers all of them.
  if (opts.bookId != null) {
    const peek = getDb().prepare('SELECT peek_expires_at FROM books WHERE id = ?').get(opts.bookId);
    if (peek?.peek_expires_at) return;
  }
  running.add(userId);
  const username = getDb().prepare('SELECT username FROM users WHERE id = ?').get(userId)?.username || `user${userId}`;
  // Tag every log line emitted by this background sweep with the user it runs for.
  await runWithUser(username, async () => {
    try {
      const db = getDb();
      const books = await resolveBooks(db, userId, ctx, opts);
      if (books.length === 0) {
        if (opts.bookId != null) console.log(`[bookorbit] book ${opts.bookId} is not in your BookOrbit library (skipping)`);
        else console.log(`[bookorbit] user ${userId}: no books matched to this BookOrbit server`);
        return;
      }
      // Verify auth up front so a bad password fails loudly once, not per book.
      try { if (!tokens.has(userId)) await login(userId, ctx); }
      catch (e) { console.warn(`[bookorbit] user ${userId}: ${e.message}`); return; }

      for (const m of books) {
        try {
          const state = db.prepare('SELECT * FROM bookorbit_sync_state WHERE user_id = ? AND book_id = ?').get(userId, m.bookId) || {};
          await syncAnnotations(userId, ctx, m, state);
          await syncBookmarks(userId, ctx, m);
          await uploadSessions(userId, ctx, m, state);
          await syncBookState(userId, ctx, m, state);
        } catch (e) {
          console.warn(`[bookorbit] book ${m.bookId}:`, e.message);
        }
      }
      if (opts.bookId == null) console.log(`[bookorbit] user ${userId}: full sync complete (${books.length} books)`);
      else console.log(`[bookorbit] user ${userId}: synced book ${opts.bookId}`);
    } catch (e) {
      console.warn(`[bookorbit] user ${userId} sync error:`, e.message);
    } finally {
      running.delete(userId);
    }
  });
}

// bookId scopes the sync to one book; omit it for a full sweep.
function triggerSync(userId, bookId) {
  setImmediate(() => { runSync(userId, bookId != null ? { bookId } : {}).catch(() => {}); });
}

// ── live progress push (session-independent) ──────────────────────────────────
// Pushes just the current reading percentage via BookOrbit's own SaveProgressDto
// endpoint (POST /books/files/:fileId/progress) — unlike uploadSessions(), this
// doesn't wait for a closed reading_sessions row, so it can fire on every chapter
// change / manual KOSync push, not just when the reader is closed.
async function pushProgress(userId, bookId, percentage) {
  // Every exit point logs *why*, unlike before — this was entirely silent (no log on success,
  // and triggerProgressPush's .catch(() => {}) swallowed any failure too), so there was no way
  // to tell whether it was working, or silently skipping at one of the early returns below.
  try {
    const ctx = getContext(userId);
    if (!ctx) { console.warn(`[bookorbit] user ${userId}: progress push skipped for book ${bookId} — BookOrbit not configured/enabled`); return; }
    const db = getDb();
    const resolved = await resolveBooks(db, userId, ctx, { bookId });
    const m = resolved[0];
    if (!m || !m.boFileId) { console.warn(`[bookorbit] user ${userId}: progress push skipped for book ${bookId} — not mapped to a BookOrbit file (book not in your BookOrbit library?)`); return; }
    try { if (!tokens.has(userId)) await login(userId, ctx); }
    catch (e) { console.warn(`[bookorbit] user ${userId}: progress push skipped for book ${bookId} — login failed: ${e.message}`); return; }
    const pct = Math.max(0, Math.min(100, Math.round(percentage * 10000) / 100));
    await api(userId, ctx, 'POST', `/books/files/${m.boFileId}/progress`, { percentage: pct });
    console.log(`[bookorbit] user ${userId}: pushed live progress ${pct}% for book ${bookId}`);
  } catch (e) {
    console.warn(`[bookorbit] user ${userId}: progress push error for book ${bookId}:`, e.message);
  }
}

function triggerProgressPush(userId, bookId, percentage) {
  setImmediate(() => { pushProgress(userId, bookId, percentage).catch(() => {}); });
}

module.exports = {
  runSync,
  triggerSync,
  isEnabled,
  getContext,
  normalizeBookorbitUrl,
  parseBoIds,
  VALID_STATUS,
  getRecommendations,
  getRelatedByBoId,
  getCover,
  api,
  fetchAsset,
  fetchAssetStream,
  mapLocalBook,
  pushProgress,
  triggerProgressPush,
  getLastStatus,
  checkReachable,
};
