import { beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importCsv } from '../src/importCsv.js';
import { migrate } from '../src/migrate.js';
import { parsePence } from '../src/money.js';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

describe('parsePence', () => {
  it.each([
    ['1.25', 125],
    ['£1.25', 125],
    ['2', 200],
    ['0.5', 50],
    ['1.15', 115], // a float multiply would give 114.99999999999999
    ['1,299.00', 129900],
    [' 0.89 ', 89],
  ])('reads %s as %i pence', (input, expected) => {
    expect(parsePence(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.999', '-1', '1.2.3', null, undefined])('rejects %s', (input) => {
    expect(parsePence(input)).toBeNull();
  });
});

describe('importCsv', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db, migrationsDir);
  });

  const csv = `name,category,store,price,unit,ean
Semi-skimmed milk 2L,Dairy,Aldi,1.45,2L,
Semi-skimmed milk 2L,Dairy,Tesco,£1.65,2L,
Wholemeal bread,Bakery,Tesco,1.25,loaf,5000000000001
Bananas,Greengrocer,Aldi,0.89,,
`;

  it('creates items, stores, categories and per-store prices', () => {
    const summary = importCsv(db, csv);
    expect(summary).toMatchObject({
      rows: 4,
      itemsCreated: 3,
      itemsUpdated: 1, // the second milk row finds the item the first one made
      pricesSet: 4,
      categoriesCreated: 1, // Greengrocer; Dairy and Bakery are seeded
      storesCreated: 2,
      errors: [],
    });
    const milk = db
      .prepare(
        `SELECT s.name AS store, ip.price_pence AS pence, ip.source
           FROM item_prices ip JOIN items i ON i.id = ip.item_id JOIN stores s ON s.id = ip.store_id
          WHERE i.name = 'Semi-skimmed milk 2L' ORDER BY s.name`,
      )
      .all();
    expect(milk).toEqual([
      { store: 'Aldi', pence: 145, source: 'import' },
      { store: 'Tesco', pence: 165, source: 'import' },
    ]);
  });

  it('is safe to run twice, and updates prices on the second run', () => {
    importCsv(db, csv);
    const second = importCsv(db, csv.replace('1.45', '1.50'));
    expect(second).toMatchObject({ itemsCreated: 0, itemsUpdated: 4, categoriesCreated: 0, storesCreated: 0 });
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(3);
    expect(db.prepare('SELECT price_pence FROM item_prices WHERE price_pence = 150').pluck().get()).toBe(150);
  });

  it('matches names, categories and stores ignoring case', () => {
    importCsv(db, 'name,category,store,price\nMilk,dairy,aldi,1\nmilk,DAIRY,ALDI,2\n');
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM stores').pluck().get()).toBe(1);
    expect(db.prepare('SELECT price_pence FROM item_prices').pluck().get()).toBe(200);
  });

  it('reports bad rows by row number and still imports the good ones', () => {
    const summary = importCsv(
      db,
      `name,category,store,price,ean
Good,Dairy,Aldi,1.00,
,Dairy,Aldi,1.00,
No category,,Aldi,1.00,
Free price,Dairy,Aldi,lots,
No store,Dairy,,1.00,
Bad barcode,Dairy,Aldi,1.00,123
Also good,Dairy,Aldi,2.00,
`,
    );
    expect(summary.errors).toEqual([
      { row: 3, message: 'missing name' },
      { row: 4, message: 'missing category' },
      { row: 5, message: '"lots" is not a price' },
      { row: 6, message: 'a price needs a store' },
      { row: 7, message: 'barcode "123" must be 8 to 14 digits' },
    ]);
    expect(summary.itemsCreated).toBe(2);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(2);
  });

  it('does not leave a half-created category behind when a row fails', () => {
    importCsv(db, 'name,category,store,price\nBroken,New category,Aldi,lots\n');
    expect(db.prepare("SELECT COUNT(*) FROM categories WHERE name = 'New category'").pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM stores').pluck().get()).toBe(0);
  });

  it('reports a duplicate barcode as a row error', () => {
    const summary = importCsv(
      db,
      'name,category,ean\nA,Dairy,5000000000001\nB,Dairy,5000000000001\n',
    );
    expect(summary.itemsCreated).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].row).toBe(3);
  });

  it('saves nothing on a dry run, but still reports what would happen', () => {
    const summary = importCsv(db, csv, { dryRun: true });
    expect(summary.itemsCreated).toBe(3);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM stores').pluck().get()).toBe(0);
  });

  it('copes with a BOM, quoted commas and blank lines', () => {
    const summary = importCsv(db, '﻿name,category\n"Beans, baked",Tins & Dry Goods\n\n');
    expect(summary.itemsCreated).toBe(1);
    expect(db.prepare('SELECT name FROM items').pluck().get()).toBe('Beans, baked');
  });

  it('requires the name and category columns', () => {
    expect(() => importCsv(db, 'item,type\nMilk,Dairy\n')).toThrow(/"name" column/);
  });
});
