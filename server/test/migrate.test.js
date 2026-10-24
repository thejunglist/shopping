import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { currentSchema, migrate } from '../src/migrate.js';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

describe('migrations', () => {
  it('applies every migration to a fresh database', () => {
    const db = openDb(':memory:');
    const applied = migrate(db, migrationsDir);
    expect(applied).toEqual(['001_init.sql', '002_seed_categories.sql', '003_unique_names.sql']);
    expect(currentSchema(db)).toBe('003_unique_names.sql');
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db, migrationsDir);
    expect(migrate(db, migrationsDir)).toEqual([]);
  });

  it('seeds the default categories in order', () => {
    const db = openDb(':memory:');
    migrate(db, migrationsDir);
    const names = db.prepare('SELECT name FROM categories ORDER BY sort_order').pluck().all();
    expect(names).toHaveLength(9);
    expect(names[0]).toBe('Produce');
    expect(names).toContain('Meat & Fish');
  });
});

describe('schema constraints', () => {
  const setup = () => {
    const db = openDb(':memory:');
    migrate(db, migrationsDir);
    const store = db.prepare("INSERT INTO stores (name) VALUES ('Aldi')").run().lastInsertRowid;
    const item = db
      .prepare("INSERT INTO items (name, category_id) VALUES ('Milk', 2)")
      .run().lastInsertRowid;
    return { db, store, item };
  };

  it('keeps one price per item and store', () => {
    const { db, store, item } = setup();
    const insert = db.prepare(
      'INSERT INTO item_prices (item_id, store_id, price_pence) VALUES (?, ?, ?)',
    );
    insert.run(item, store, 145);
    expect(() => insert.run(item, store, 150)).toThrow();
  });

  it('rejects negative prices', () => {
    const { db, store, item } = setup();
    expect(() =>
      db
        .prepare('INSERT INTO item_prices (item_id, store_id, price_pence) VALUES (?, ?, ?)')
        .run(item, store, -1),
    ).toThrow();
  });

  it('enforces unique barcodes but allows items without one', () => {
    const { db } = setup();
    const insert = db.prepare('INSERT INTO items (name, category_id, ean) VALUES (?, 1, ?)');
    insert.run('Beans', '5000000000001');
    insert.run('Bread', null);
    insert.run('Rolls', null);
    expect(() => insert.run('Other beans', '5000000000001')).toThrow();
  });

  it('refuses to delete an item that appears on a list', () => {
    const { db, item } = setup();
    const list = db.prepare("INSERT INTO lists (name) VALUES ('Week 1')").run().lastInsertRowid;
    db.prepare('INSERT INTO list_items (list_id, item_id) VALUES (?, ?)').run(list, item);
    expect(() => db.prepare('DELETE FROM items WHERE id = ?').run(item)).toThrow();
  });
});
