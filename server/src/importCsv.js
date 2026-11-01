import { parse } from 'csv-parse/sync';
import { normalizeEan } from './barcode.js';
import { parsePence } from './money.js';

/**
 * Import items and prices from CSV text. Columns (header row required, any
 * order, case-insensitive):
 *
 *   name      required
 *   category  required; created if it does not exist yet
 *   store     optional; created if it does not exist yet
 *   price     optional, in pounds ("1.25" or "£1.25"); needs a store
 *   unit      optional, e.g. "2L"
 *   ean       optional barcode, 8 to 14 digits
 *
 * One row per item and store: repeat the item on several rows to price it at
 * several stores. Importing again updates items and prices in place, so it is
 * safe to re-run. A bad row is reported and skipped; the rest still import.
 * With { dryRun: true } nothing is saved.
 */
export function importCsv(db, text, { dryRun = false } = {}) {
  const records = parse(text, {
    columns: (header) => header.map((name) => String(name).trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  });

  const summary = {
    rows: records.length,
    itemsCreated: 0,
    itemsUpdated: 0,
    pricesSet: 0,
    categoriesCreated: 0,
    storesCreated: 0,
    errors: [],
  };

  if (records.length > 0) {
    for (const column of ['name', 'category']) {
      if (!(column in records[0])) throw new Error(`The CSV needs a "${column}" column`);
    }
  }

  const findId = (table, name) =>
    db.prepare(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`).pluck().get(name);
  const createLookup = (table, name) =>
    db
      .prepare(
        `INSERT INTO ${table} (name, sort_order)
         VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM ${table}))`,
      )
      .run(name).lastInsertRowid;

  // Each row is its own savepoint, so one bad row cannot spoil the others.
  const importRow = db.transaction((row) => {
    const name = row.name ?? '';
    const categoryName = row.category ?? '';
    const storeName = row.store ?? '';
    const unit = row.unit || null;
    const ean = row.ean ? normalizeEan(row.ean) : null;
    const priceText = row.price ?? '';

    if (!name) throw new Error('missing name');
    if (!categoryName) throw new Error('missing category');
    if (ean && !/^\d{8,14}$/.test(ean)) throw new Error(`barcode "${ean}" must be 8 to 14 digits`);
    let price = null;
    if (priceText !== '') {
      price = parsePence(priceText);
      if (price === null) throw new Error(`"${priceText}" is not a price`);
      if (!storeName) throw new Error('a price needs a store');
    }

    let categoryId = findId('categories', categoryName);
    if (!categoryId) {
      categoryId = createLookup('categories', categoryName);
      summary.categoriesCreated += 1;
    }
    let storeId = null;
    if (storeName) {
      storeId = findId('stores', storeName);
      if (!storeId) {
        storeId = createLookup('stores', storeName);
        summary.storesCreated += 1;
      }
    }

    const existing = findId('items', name);
    let itemId = existing;
    if (existing) {
      db.prepare(
        `UPDATE items SET category_id = ?, default_unit = COALESCE(?, default_unit),
                ean = COALESCE(?, ean) WHERE id = ?`,
      ).run(categoryId, unit, ean, existing);
      summary.itemsUpdated += 1;
    } else {
      itemId = db
        .prepare('INSERT INTO items (name, category_id, default_unit, ean) VALUES (?, ?, ?, ?)')
        .run(name, categoryId, unit, ean).lastInsertRowid;
      summary.itemsCreated += 1;
    }

    if (price !== null) {
      db.prepare(
        `INSERT INTO item_prices (item_id, store_id, price_pence, source, updated_at)
         VALUES (?, ?, ?, 'import', datetime('now'))
         ON CONFLICT (item_id, store_id) DO UPDATE
           SET price_pence = excluded.price_pence, source = 'import', updated_at = datetime('now')`,
      ).run(itemId, storeId, price);
      summary.pricesSet += 1;
    }
  });

  // The CSV counts rows from 1 with the header as row 1, like a spreadsheet.
  const run = db.transaction(() => {
    records.forEach((record, index) => {
      try {
        importRow(record);
      } catch (err) {
        summary.errors.push({ row: index + 2, message: err.message });
      }
    });
    if (dryRun) throw new DryRun();
  });
  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return summary;
}

class DryRun extends Error {}
