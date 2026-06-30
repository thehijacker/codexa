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
//   Annotations  GET/POST   /books/:bookId/annotations   PATCH/DELETE .../:id
//   Sessions     POST       /books/:bookId/sessions
//   Read status  PATCH      /books/:id/status
//   Rating       POST       /books/bulk-set-rating
//
// Off unless the user enabled it AND configured BookOrbit account credentials.

const crypto = require('crypto');
const { getDb } = require('../db');
const { runWithUser } = require('../utils/logger');

const TIMEOUT_MS = 15000;
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
// sibling at <base>/api/v1. Derive the web base from the configured kosync URL.
function webBaseFromKosyncUrl(kosyncUrl) {
  let u = String(kosyncUrl || '').replace(/\/+$/, '');
  if (!u) return '';
  u = u.replace(/\/koreader$/, '');
  if (!/\/api\/v\d+$/.test(u)) u += '/api/v1';
  return u;
}

function getContext(userId) {
  const db = getDb();
  const s = db.prepare(
    'SELECT kosync_url, kosync_username, kosync_password_enc, bookorbit_sync_enabled, bookorbit_account_username, bookorbit_account_password_enc FROM user_settings WHERE user_id = ?'
  ).get(userId);
  if (!s || s.bookorbit_sync_enabled !== 1) return null;
  if (!s.kosync_url || !s.bookorbit_account_username || !s.bookorbit_account_password_enc) return null;
  const webBase = webBaseFromKosyncUrl(s.kosync_url);
  if (!webBase) return null;
  let origin;
  try { origin = new URL(webBase).origin; } catch { return null; }
  // KOReader sync sub-account (x-auth-key) — used only to resolve book ids by file
  // hash via /plugin/match-check. Optional; OPDS-link mapping is the fallback.
  const koreaderBase = String(s.kosync_url).replace(/\/+$/, '');
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
  const res = await fetch(`${ctx.webBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username: ctx.username, password: ctx.password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`login failed HTTP ${res.status}`);
  }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const access = extractToken(setCookies, 'access_token');
  const refresh = extractToken(setCookies, 'refresh_token');
  if (!access) throw new Error('login returned no access_token cookie');
  tokens.set(userId, { access, refresh });
}

async function refresh(userId, ctx) {
  const tok = tokens.get(userId);
  if (!tok?.refresh) return login(userId, ctx);
  const res = await fetch(`${ctx.webBase}/auth/refresh`, {
    method: 'POST',
    headers: { cookie: `refresh_token=${encodeURIComponent(tok.refresh)}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return login(userId, ctx);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const access = extractToken(setCookies, 'access_token') || tok.access;
  const newRefresh = extractToken(setCookies, 'refresh_token') || tok.refresh;
  tokens.set(userId, { access, refresh: newRefresh });
}

// Authenticated request: paces calls, refreshes once on 401, backs off on 429.
async function api(userId, ctx, method, path, body, state = { refreshed: false, throttled: 0 }) {
  if (!tokens.has(userId)) await login(userId, ctx);
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
    return { ok: false, status: 0, error: err.message };
  }
  if (res.status === 401 && !state.refreshed) {
    await refresh(userId, ctx);
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
    return { ok: false, status: res.status, data };
  }
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

// ── reading sessions (one-way up; only "real" sessions) ───────────────────────
async function uploadSessions(userId, ctx, m, state) {
  const db = getDb();
  const wm = state.sessions_watermark || 0;
  const sessions = db.prepare(
    'SELECT id, start_ts, end_ts, pages_nav FROM reading_sessions WHERE user_id = ? AND book_id = ? AND end_ts IS NOT NULL AND id > ? ORDER BY id'
  ).all(userId, m.bookId, wm);

  let maxId = wm;
  for (const s of sessions) {
    maxId = Math.max(maxId, s.id);
    const dur = (s.end_ts || 0) - (s.start_ts || 0);
    if (dur < 60 || (s.pages_nav || 0) < 2) continue; // skip non-real sessions
    const durationMinutes = Math.max(1, Math.min(1440, Math.round(dur / 60)));
    const res = await api(userId, ctx, 'POST', `/books/${m.boBookId}/sessions`, {
      startedAt: new Date(s.start_ts * 1000).toISOString(),
      durationMinutes,
    });
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

// ── orchestrator ──────────────────────────────────────────────────────────────
const running = new Set();

// opts.bookId — sync only that book (used by mutation triggers). Without it,
// runSync does a full reconcile sweep (the periodic background pass).
async function runSync(userId, opts = {}) {
  if (running.has(userId)) return;
  const ctx = getContext(userId);
  if (!ctx) return;
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

module.exports = {
  runSync,
  triggerSync,
  isEnabled,
  getContext,
  webBaseFromKosyncUrl,
  parseBoIds,
  VALID_STATUS,
};
