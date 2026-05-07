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
  ];
  for (const [sql, label] of migrations) {
    try {
      database.exec(sql);
      console.log(`[db] Migration: added ${label}`);
    } catch { /* column already exists — ignore */ }
  }
}

module.exports = { getDb, initDb, DATA_DIR };
