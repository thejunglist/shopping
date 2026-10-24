import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { migrate } from './migrate.js';

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT ?? 3000);
// Localhost only: access comes through `tailscale serve`, which also supplies
// the user header. See app.js.
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = resolve(process.env.DB_PATH ?? resolve(here, '../data/shopping.db'));

// In a release bundle the layout is <release>/server/src and <release>/public.
// In development the built frontend is at <repo>/web/dist.
const bundledWeb = resolve(here, '../../public');
const devWeb = resolve(here, '../../web/dist');
const webRoot = process.env.WEB_DIST ?? (existsSync(bundledWeb) ? bundledWeb : devWeb);

// The deploy script writes the git SHA to <release>/VERSION.
let version = 'dev';
try {
  version = readFileSync(resolve(here, '../../VERSION'), 'utf8').trim() || 'dev';
} catch {
  // No VERSION file: running from a development checkout.
}

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const applied = migrate(db, resolve(here, '../migrations'));

const app = await buildApp({ db, version, webRoot, logger: true });
if (applied.length > 0) app.log.info({ applied }, 'applied migrations');

const shutdown = async (signal) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
