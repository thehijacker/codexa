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
      user_id              INTEGER PRIMARY KEY,
      opds_servers         TEXT    DEFAULT '[]',
      kosync_url           TEXT    DEFAULT '',
      kosync_username      TEXT    DEFAULT '',
      kosync_password_enc  TEXT    DEFAULT '',
      reader_prefs         TEXT    DEFAULT '{}',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS books (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      title       TEXT    NOT NULL,
      author      TEXT    DEFAULT '',
      file_hash   TEXT    NOT NULL,
      filename    TEXT    NOT NULL,
      cover_path  TEXT    DEFAULT '',
      file_size   INTEGER DEFAULT 0,
      added_at    INTEGER DEFAULT (strftime('%s', 'now')),
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
  `);

  console.log(`[db] SQLite initialized at ${DB_PATH}`);

  // ── Migrations (safe to run on every startup) ─────────────────────────────
  // Add file_hash_md5 column if it doesn't exist (for KOReader kosync matching)
  try {
    database.exec(`ALTER TABLE books ADD COLUMN file_hash_md5 TEXT DEFAULT ''`);
    console.log('[db] Migration: added file_hash_md5 column');
  } catch { /* column already exists — ignore */ }
  
}

module.exports = { getDb, initDb, DATA_DIR };
