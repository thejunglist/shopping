import Database from 'better-sqlite3';

/**
 * Open (or create) the SQLite database with the settings the app relies on.
 * Pass ':memory:' for tests.
 */
export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
