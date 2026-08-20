const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DB_PATH = path.join(DATA_DIR, 'codexa.db');

// Ensure data directories exist on startup
['books', 'covers', 'fonts', 'tmp', 'tmp/peek'].forEach(dir => {
  fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
});

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// Closes the DB handle cleanly (checkpoints the WAL file back into codexa.db and releases the
// native handle). Node gives WAL mode no chance to do this on its own — an abrupt process kill
// (the default for SIGTERM with no handler, e.g. every `docker stop`/restart) leaves
// codexa.db-wal/-shm in whatever state they were mid-write, and better-sqlite3 has to recover
// that on the next open. Call this from a graceful-shutdown handler, not on every request path.
function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

function initDb() {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      username       TEXT    UNIQUE NOT NULL,
      name           TEXT    DEFAULT '',
      password_hash  TEXT    NOT NULL,
      created_at     INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id                  INTEGER PRIMARY KEY,
      opds_servers             TEXT    DEFAULT '[]',
      kosync_url               TEXT    DEFAULT '',
      kosync_username          TEXT    DEFAULT '',
      kosync_password_enc      TEXT    DEFAULT '',
      kosync_internal_enabled  INTEGER DEFAULT 0,
      reader_prefs             TEXT    DEFAULT '{}',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS books (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      title          TEXT    NOT NULL,
      author         TEXT    DEFAULT '',
      series_name    TEXT    DEFAULT '',
      series_number  TEXT    DEFAULT '',
      description    TEXT    DEFAULT '',
      file_hash      TEXT    NOT NULL,
      file_hash_md5  TEXT    DEFAULT '',
      kosync_hash    TEXT    DEFAULT '',
      md5_algo_v2    INTEGER DEFAULT 0,
      filename       TEXT    NOT NULL,
      cover_path     TEXT    DEFAULT '',
      file_size      INTEGER DEFAULT 0,
      added_at       INTEGER DEFAULT (strftime('%s', 'now')),
      publisher      TEXT    DEFAULT '',
      language       TEXT    DEFAULT '',
      isbn           TEXT    DEFAULT '',
      genres         TEXT    DEFAULT '',
      pages          TEXT    DEFAULT '',
      UNIQUE (user_id, file_hash),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_progress (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      document_hash  TEXT    NOT NULL,
      cfi_position   TEXT    DEFAULT '',
      percentage     REAL    DEFAULT 0,
      device         TEXT    DEFAULT 'web',
      updated_at     INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE (user_id, document_hash),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shelves (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS book_shelves (
      shelf_id INTEGER NOT NULL,
      book_id  INTEGER NOT NULL,
      added_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (shelf_id, book_id),
      FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id)  REFERENCES books(id)  ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS book_opds_sources (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id  INTEGER NOT NULL,
      book_id  INTEGER NOT NULL,
      acq_href TEXT    NOT NULL,
      UNIQUE(user_id, acq_href),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      book_id    INTEGER NOT NULL,
      cfi        TEXT    NOT NULL,
      pct        REAL    DEFAULT 0,
      label      TEXT    DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id)  ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS annotations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      book_id    INTEGER NOT NULL,
      cfi        TEXT    NOT NULL,
      pct        REAL    DEFAULT 0,
      text       TEXT    DEFAULT '',
      note       TEXT    DEFAULT '',
      color      TEXT    DEFAULT 'yellow',
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      book_id    INTEGER NOT NULL,
      start_ts   INTEGER NOT NULL,
      end_ts     INTEGER,
      pages_nav  INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chapter_visits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      book_id       INTEGER NOT NULL,
      chapter_href  TEXT    NOT NULL,
      chapter_title TEXT    DEFAULT '',
      visited_at    INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    -- Per-book BookOrbit sync state: match map (bo_book_id) plus per-feature
    -- ack watermarks, so an interrupted sync resumes and resends are no-ops.
    CREATE TABLE IF NOT EXISTS bookorbit_sync_state (
      user_id            INTEGER NOT NULL,
      book_id            INTEGER NOT NULL,
      bo_book_id         INTEGER DEFAULT NULL,
      bo_file_id         INTEGER DEFAULT NULL,
      ann_watermark      INTEGER DEFAULT 0,
      sessions_watermark INTEGER DEFAULT 0,
      state_watermark    INTEGER DEFAULT 0,
      last_sync          INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, book_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    -- Named reader-settings snapshots (font/theme/layout etc.), switchable from the
    -- Theme tab. Deliberately excludes dictionary selection, which has its own
    -- global sync + per-book-language-default logic (see user_settings.reader_prefs).
    CREATE TABLE IF NOT EXISTS reader_presets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      prefs      TEXT    NOT NULL DEFAULT '{}',
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  console.log(`[db] SQLite initialized at ${DB_PATH}`);

  // ── Migrations (safe to run on every startup) ─────────────────────────────
  const migrations = [
    [`ALTER TABLE books          ADD COLUMN file_hash_md5            TEXT    DEFAULT ''`,  'books.file_hash_md5'],
    [`ALTER TABLE books          ADD COLUMN series_name              TEXT    DEFAULT ''`,  'books.series_name'],
    [`ALTER TABLE books          ADD COLUMN series_number            TEXT    DEFAULT ''`,  'books.series_number'],
    [`ALTER TABLE books          ADD COLUMN description              TEXT    DEFAULT ''`,  'books.description'],
    [`ALTER TABLE books          ADD COLUMN kosync_hash              TEXT    DEFAULT ''`,  'books.kosync_hash'],
    [`ALTER TABLE books          ADD COLUMN md5_algo_v2              INTEGER DEFAULT 0`,   'books.md5_algo_v2'],
    [`ALTER TABLE books          ADD COLUMN publisher                TEXT    DEFAULT ''`,  'books.publisher'],
    [`ALTER TABLE books          ADD COLUMN language                 TEXT    DEFAULT ''`,  'books.language'],
    [`ALTER TABLE books          ADD COLUMN isbn                     TEXT    DEFAULT ''`,  'books.isbn'],
    [`ALTER TABLE books          ADD COLUMN genres                   TEXT    DEFAULT ''`,  'books.genres'],
    [`ALTER TABLE books          ADD COLUMN pages                    TEXT    DEFAULT ''`,  'books.pages'],
    [`ALTER TABLE user_settings  ADD COLUMN kosync_internal_enabled  INTEGER DEFAULT 0`,   'user_settings.kosync_internal_enabled'],
    [`ALTER TABLE books          ADD COLUMN last_opened_at          INTEGER`, 'books.last_opened_at'],
    [`ALTER TABLE books          ADD COLUMN format                  TEXT    DEFAULT 'epub'`, 'books.format'],
    [`ALTER TABLE shelves        ADD COLUMN opds_server_id          INTEGER DEFAULT NULL`,   'shelves.opds_server_id'],
    [`ALTER TABLE shelves        ADD COLUMN opds_folder_url         TEXT    DEFAULT NULL`,   'shelves.opds_folder_url'],
    [`ALTER TABLE shelves        ADD COLUMN last_synced_at          INTEGER DEFAULT NULL`,   'shelves.last_synced_at'],
    [`ALTER TABLE shelves        ADD COLUMN sort_order              INTEGER DEFAULT 0`,      'shelves.sort_order'],
    // BookOrbit extended sync (highlights, reading log, status & rating)
    [`ALTER TABLE user_settings  ADD COLUMN bookorbit_sync_enabled  INTEGER DEFAULT 0`,      'user_settings.bookorbit_sync_enabled'],
    // BookOrbit web-API account login (separate from the KOReader sync sub-account)
    [`ALTER TABLE user_settings  ADD COLUMN bookorbit_account_username     TEXT DEFAULT ''`, 'user_settings.bookorbit_account_username'],
    [`ALTER TABLE user_settings  ADD COLUMN bookorbit_account_password_enc TEXT DEFAULT ''`, 'user_settings.bookorbit_account_password_enc'],
    [`ALTER TABLE annotations    ADD COLUMN bo_id                   TEXT    DEFAULT ''`,     'annotations.bo_id'],
    [`ALTER TABLE annotations    ADD COLUMN style                   TEXT    DEFAULT 'lighten'`, 'annotations.style'],
    [`ALTER TABLE annotations    ADD COLUMN updated_at              INTEGER`,                 'annotations.updated_at'],
    [`ALTER TABLE annotations    ADD COLUMN deleted                 INTEGER DEFAULT 0`,       'annotations.deleted'],
    [`ALTER TABLE annotations    ADD COLUMN origin                  TEXT    DEFAULT 'web'`,   'annotations.origin'],
    [`ALTER TABLE books          ADD COLUMN read_status             TEXT    DEFAULT ''`,     'books.read_status'],
    [`ALTER TABLE books          ADD COLUMN rating                  INTEGER`,                 'books.rating'],
    [`ALTER TABLE books          ADD COLUMN status_modified         INTEGER`,                 'books.status_modified'],
    [`ALTER TABLE bookorbit_sync_state ADD COLUMN bo_file_id        INTEGER DEFAULT NULL`,    'bookorbit_sync_state.bo_file_id'],
    // Percentage (0-1 fraction) at the start/end of a reading session, so BookOrbit sync can
    // send an explicit progressDelta instead of letting BookOrbit infer one from session history
    // (see bookorbitSync.uploadSessions).
    [`ALTER TABLE reading_sessions ADD COLUMN end_pct              REAL    DEFAULT NULL`,     'reading_sessions.end_pct'],
    [`ALTER TABLE reading_sessions ADD COLUMN start_pct            REAL    DEFAULT NULL`,     'reading_sessions.start_pct'],
    // Bookmark sync tracking (create/delete only — BookOrbit's bookmark API has no update route)
    [`ALTER TABLE bookmarks       ADD COLUMN bo_id                 TEXT    DEFAULT ''`,       'bookmarks.bo_id'],
    [`ALTER TABLE bookmarks       ADD COLUMN deleted                INTEGER DEFAULT 0`,       'bookmarks.deleted'],
    // Shelf <-> BookOrbit collection/smart-scope link, parallel to opds_server_id/opds_folder_url
    // (see server/routes/bookorbit.js sync-sse).
    [`ALTER TABLE shelves         ADD COLUMN bo_collection_id       INTEGER DEFAULT NULL`,     'shelves.bo_collection_id'],
    [`ALTER TABLE shelves         ADD COLUMN bo_smart_scope_id      INTEGER DEFAULT NULL`,     'shelves.bo_smart_scope_id'],
    // BookOrbit's own server URL — extended sync used to piggyback on kosync_url (BookOrbit's
    // KOReader-plugin URL and its web-API base happen to share a host), but that coupling was
    // confusing in Settings (BookOrbit has nothing to do with KOReader Sync) and forced enabling
    // KOReader Sync's own fields just to configure BookOrbit. Now standalone; see backfill below.
    [`ALTER TABLE user_settings   ADD COLUMN bookorbit_url          TEXT    DEFAULT ''`,       'user_settings.bookorbit_url'],
    // Non-null = ephemeral "peek" row (BookOrbit book fetched for a read-only look, never
    // imported) — safe to delete after this unix timestamp or on explicit close signal.
    // See server/utils/peekCleanup.js.
    [`ALTER TABLE books           ADD COLUMN peek_expires_at        INTEGER DEFAULT NULL`,     'books.peek_expires_at'],
    // OIDC-linked accounts (Google/Apple/self-hosted IdP login). NULL provider/sub = local
    // password account. password_hash stays NOT NULL for these too (a random unusable hash is
    // generated at account-creation time) to avoid a table-rebuild migration.
    [`ALTER TABLE users           ADD COLUMN oidc_provider          TEXT    DEFAULT NULL`,     'users.oidc_provider'],
    [`ALTER TABLE users           ADD COLUMN oidc_sub                TEXT    DEFAULT NULL`,     'users.oidc_sub'],
    [`ALTER TABLE users           ADD COLUMN email                   TEXT    DEFAULT NULL`,     'users.email'],
    // Last time this user made an authenticated request — throttled write, see
    // server/middleware/auth.js. Powers the admin panel's per-user activity display.
    [`ALTER TABLE users           ADD COLUMN last_active_at          INTEGER DEFAULT 0`,        'users.last_active_at'],
  ];
  for (const [sql, label] of migrations) {
    try {
      database.exec(sql);
      console.log(`[db] Migration: added ${label}`);
    } catch { /* column already exists — ignore */ }
  }

  // Composite uniqueness for OIDC identities can't be expressed via ADD COLUMN.
  try {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc
        ON users(oidc_provider, oidc_sub) WHERE oidc_provider IS NOT NULL
    `);
  } catch (e) {
    console.warn('[db] idx_users_oidc creation:', e.message);
  }

  // Email is optional (used as a second login identifier and to auto-link an OIDC identity
  // to an existing local account — see server/routes/oidc.js). Always stored lowercased by
  // the app, so a plain unique index is enough (no need for a functional LOWER() index).
  try {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
        ON users(email) WHERE email IS NOT NULL AND email != ''
    `);
  } catch (e) {
    console.warn('[db] idx_users_email creation:', e.message);
  }

  // Backfill last_opened_at from last progress save, else added_at (counts as "opened when added").
  try {
    database.exec(`
      UPDATE books AS b
         SET last_opened_at = COALESCE(
           (SELECT p.updated_at FROM reading_progress p
             WHERE p.user_id = b.user_id AND p.document_hash = b.file_hash),
           b.added_at
         )
       WHERE b.last_opened_at IS NULL
    `);
  } catch (e) {
    console.warn('[db] last_opened_at backfill:', e.message);
  }

  // Seed annotations.updated_at from created_at so pre-existing highlights have
  // a sync timestamp the first time BookOrbit sync is enabled.
  try {
    database.exec(`UPDATE annotations SET updated_at = created_at WHERE updated_at IS NULL`);
  } catch (e) {
    console.warn('[db] annotations.updated_at backfill:', e.message);
  }

  // One-time: users who already had BookOrbit extended sync enabled were relying on kosync_url
  // as BookOrbit's server address. Copy it into the new standalone field so their setup keeps
  // working after the split, without needing to re-enter it.
  try {
    database.exec(`
      UPDATE user_settings
         SET bookorbit_url = kosync_url
       WHERE bookorbit_sync_enabled = 1 AND (bookorbit_url IS NULL OR bookorbit_url = '') AND kosync_url != ''
    `);
  } catch (e) {
    console.warn('[db] bookorbit_url backfill:', e.message);
  }
}

module.exports = { getDb, initDb, closeDb, DATA_DIR };
