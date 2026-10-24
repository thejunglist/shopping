import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

let db;
let webRoot;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db, migrationsDir);
  webRoot = mkdtempSync(join(tmpdir(), 'shopping-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Shopping</title>');
});

afterEach(() => {
  db.close();
  rmSync(webRoot, { recursive: true, force: true });
});

describe('GET /healthz', () => {
  it('reports ok with the version and schema', async () => {
    const app = await buildApp({ db, version: 'abc123' });
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      version: 'abc123',
      schema: '003_unique_names.sql',
    });
  });

  it('returns 503 when the database is unavailable', async () => {
    const app = await buildApp({ db, version: 'abc123' });
    db.close();
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('error');
    db = openDb(':memory:'); // so afterEach can close something
  });
});

describe('GET /api/me', () => {
  it('returns the Tailscale user when the header is present', async () => {
    const app = await buildApp({ db });
    const res = await app.inject({
      url: '/api/me',
      headers: { 'tailscale-user-login': 'alex@example.com' },
    });
    expect(res.json()).toEqual({ user: 'alex@example.com' });
  });

  it('returns null without the header', async () => {
    const app = await buildApp({ db });
    const res = await app.inject('/api/me');
    expect(res.json()).toEqual({ user: null });
  });
});

describe('static frontend', () => {
  it('serves index.html at the root and for unknown client routes', async () => {
    const app = await buildApp({ db, webRoot });
    for (const url of ['/', '/lists/42']) {
      const res = await app.inject(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<title>Shopping</title>');
    }
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const app = await buildApp({ db, webRoot });
    const res = await app.inject('/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
  });

  it('works without a built frontend', async () => {
    const app = await buildApp({ db, webRoot: join(webRoot, 'missing') });
    const res = await app.inject('/');
    expect(res.statusCode).toBe(404);
  });
});
