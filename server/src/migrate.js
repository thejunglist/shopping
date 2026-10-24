import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Apply any *.sql files in `dir` that have not been applied yet, in filename
 * order. Each file runs in its own transaction, so a failed migration leaves
 * the database as it was. Migrations are forward-only: there is no "down".
 *
 * Returns the names of the migrations applied by this call.
 */
export function migrate(db, dir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all());
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
    applied.push(file);
  }
  return applied;
}

/** Name of the most recently applied migration, or null on an empty database. */
export function currentSchema(db) {
  const row = db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get();
  return row ? row.name : null;
}
