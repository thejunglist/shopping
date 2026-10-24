// Import items and prices from a CSV file into the database.
//
//   node scripts/import-csv.js items.csv [--dry-run]
//
// Uses the same DB_PATH as the server, defaulting to server/data/shopping.db.
// On the home server:  sudo -u shopping DB_PATH=/var/lib/shopping/shopping.db \
//   node /opt/shopping/current/server/scripts/import-csv.js items.csv
// Format: see docs/import-format.md.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importCsv } from '../src/importCsv.js';
import { migrate } from '../src/migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((arg) => !arg.startsWith('--'));

if (!file) {
  console.error('usage: node scripts/import-csv.js <file.csv> [--dry-run]');
  process.exit(2);
}

const dbPath = resolve(process.env.DB_PATH ?? resolve(here, '../data/shopping.db'));
const db = openDb(dbPath);
migrate(db, resolve(here, '../migrations'));

let summary;
try {
  summary = importCsv(db, readFileSync(file, 'utf8'), { dryRun });
} catch (err) {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
}

console.log(`${dryRun ? 'Dry run (nothing saved)' : 'Imported'} ${file} into ${dbPath}`);
console.log(`  rows read:          ${summary.rows}`);
console.log(`  items created:      ${summary.itemsCreated}`);
console.log(`  items updated:      ${summary.itemsUpdated}`);
console.log(`  prices set:         ${summary.pricesSet}`);
console.log(`  categories created: ${summary.categoriesCreated}`);
console.log(`  stores created:     ${summary.storesCreated}`);
for (const { row, message } of summary.errors) console.error(`  row ${row}: ${message}`);
db.close();
process.exit(summary.errors.length > 0 ? 1 : 0);
