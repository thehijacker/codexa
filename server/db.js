const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DB_PATH = path.join(DATA_DIR, 'codexa.db');

// Ensure data directories exist on startup
['books', 'covers', 'fonts', 'tmp'].forEach(dir => {
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
  ];
  for (const [sql, label] of migrations) {
    try {
      database.exec(sql);
      console.log(`[db] Migration: added ${label}`);
    } catch { /* column already exists — ignore */ }
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
}

module.exports = { getDb, initDb, DATA_DIR };
