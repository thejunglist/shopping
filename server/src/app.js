import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { currentSchema } from './migrate.js';
import { lookupOpenFoodFacts } from './barcode.js';
import { userOf } from './http.js';
import resourceRoutes from './routes/resources.js';
import barcodeRoutes from './routes/barcode.js';
import itemRoutes from './routes/items.js';
import listRoutes from './routes/lists.js';

/**
 * Build the Fastify app. Kept separate from index.js so tests can create an
 * app around an in-memory database and call it with `app.inject()`.
 */
export async function buildApp({
  db,
  version = 'dev',
  webRoot = null,
  logger = false,
  // Replaceable so tests never touch the network.
  lookupProduct = lookupOpenFoodFacts,
} = {}) {
  const app = Fastify({ logger });

  // Every error leaves as JSON: { error: "message" }.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.code(400).send({ error: 'Invalid request', issues });
    }
    if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
      const inUse = err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
      return reply.code(409).send({
        error: inUse ? 'That is still in use, or refers to something that does not exist' : 'That already exists',
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });
  });

  // Used by the deploy script and uptime checks. It touches the database, so a
  // broken migration or unreadable db file makes it fail.
  app.get('/healthz', async (_request, reply) => {
    try {
      db.prepare('SELECT 1').pluck().get();
      return { status: 'ok', version, schema: currentSchema(db) };
    } catch (err) {
      app.log.error(err);
      return reply.code(503).send({ status: 'error', version });
    }
  });

  // Who is using the app. `tailscale serve` adds the Tailscale-User-Login
  // header to requests that arrive through it. The server must therefore listen
  // on localhost only: if it were reachable directly, anyone could set this
  // header themselves.
  app.get('/api/me', async (request) => ({ user: userOf(request) }));

  await app.register(resourceRoutes, { prefix: '/api/categories', db, table: 'categories', label: 'Category' });
  await app.register(resourceRoutes, { prefix: '/api/stores', db, table: 'stores', label: 'Store' });
  await app.register(itemRoutes, { prefix: '/api/items', db });
  await app.register(listRoutes, { prefix: '/api/lists', db });
  await app.register(barcodeRoutes, { prefix: '/api/barcode', db, lookupProduct });

  if (webRoot && existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot });
    // Single-page app: unknown non-API routes get index.html.
    app.setNotFoundHandler((request, reply) => {
      const isApi = request.url.startsWith('/api/') || request.url === '/healthz';
      if (request.method === 'GET' && !isApi) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
