import { z } from 'zod';
import { HttpError, id, notFound, pence, userOf } from '../http.js';
import { currentPrice, setManualPrice } from '../prices.js';

const today = () =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' }).format(
    new Date(),
  );

/**
 * A list with its items and totals. Prices shown:
 *  - ticked items: the price snapshot taken when they were ticked;
 *  - unticked items on an active list: the current shelf price at their store;
 *  - unticked items on a completed list: none (they were not bought).
 */
export function loadList(db, listId) {
  const list = db
    .prepare('SELECT id, name, kind, status, budget_pence, created_at, completed_at FROM lists WHERE id = ?')
    .get(listId);
  if (!list) return null;

  const rows = db
    .prepare(
      `SELECT li.id, li.item_id, i.name, i.default_unit, c.id AS category_id, c.name AS category_name,
              li.store_id, s.name AS store_name, li.quantity, li.checked, li.price_paid_pence,
              ip.price_pence AS current_price_pence, li.added_by
         FROM list_items li
         JOIN items i ON i.id = li.item_id
         JOIN categories c ON c.id = i.category_id
         LEFT JOIN stores s ON s.id = li.store_id
         LEFT JOIN item_prices ip ON ip.item_id = li.item_id AND ip.store_id = li.store_id
        WHERE li.list_id = ?
        ORDER BY COALESCE(s.sort_order, 1000000), s.name COLLATE NOCASE,
                 c.sort_order, c.name COLLATE NOCASE, i.name COLLATE NOCASE`,
    )
    .all(listId);

  const live = list.status === 'active';
  const totals = { checked_pence: 0, unchecked_pence: 0, total_pence: 0, unpriced_count: 0 };
  const items = rows.map((row) => {
    const checked = row.checked === 1;
    const unit = checked ? row.price_paid_pence : live ? row.current_price_pence : null;
    const line = unit == null ? null : unit * row.quantity;
    if (line != null) {
      totals[checked ? 'checked_pence' : 'unchecked_pence'] += line;
      totals.total_pence += line;
    } else if (checked || live) {
      totals.unpriced_count += 1;
    }
    return {
      id: row.id,
      item_id: row.item_id,
      name: row.name,
      default_unit: row.default_unit,
      category_id: row.category_id,
      category_name: row.category_name,
      store_id: row.store_id,
      store_name: row.store_name,
      quantity: row.quantity,
      checked,
      unit_price_pence: unit,
      line_total_pence: line,
      added_by: row.added_by,
    };
  });

  return {
    ...list,
    items,
    totals: {
      ...totals,
      remaining_pence: list.budget_pence == null ? null : list.budget_pence - totals.total_pence,
    },
  };
}

export default async function listRoutes(app, { db }) {
  const requireList = (listId) => {
    const list = db.prepare('SELECT id, status FROM lists WHERE id = ?').get(listId);
    if (!list) throw notFound('List');
    return list;
  };
  const requireActive = (listId) => {
    const list = requireList(listId);
    if (list.status !== 'active') throw new HttpError(409, 'This list is already completed');
    return list;
  };
  // The weekly list people are shopping from. Created on first use, and again
  // after one is completed, carrying the previous budget forward.
  app.get('/current', async () => {
    let listId = db
      .prepare("SELECT id FROM lists WHERE kind = 'weekly' AND status = 'active' ORDER BY id DESC LIMIT 1")
      .pluck()
      .get();
    if (!listId) {
      const budget = db
        .prepare("SELECT budget_pence FROM lists WHERE kind = 'weekly' ORDER BY id DESC LIMIT 1")
        .pluck()
        .get();
      listId = db
        .prepare('INSERT INTO lists (name, budget_pence) VALUES (?, ?)')
        .run(`Week of ${today()}`, budget ?? null).lastInsertRowid;
    }
    return loadList(db, listId);
  });

  app.get('/:id', async (request) => {
    const list = loadList(db, id.parse(request.params.id));
    if (!list) throw notFound('List');
    return list;
  });

  app.patch('/:id', async (request) => {
    const listId = id.parse(request.params.id);
    requireList(listId);
    const data = z
      .object({ name: z.string().trim().min(1).max(80), budget_pence: pence.nullable() })
      .partial()
      .parse(request.body);
    if (data.name !== undefined) db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(data.name, listId);
    if (data.budget_pence !== undefined) {
      db.prepare('UPDATE lists SET budget_pence = ? WHERE id = ?').run(data.budget_pence, listId);
    }
    return loadList(db, listId);
  });

  app.post('/:id/items', async (request, reply) => {
    const listId = id.parse(request.params.id);
    requireActive(listId);
    const data = z
      .object({
        item_id: id,
        store_id: id.nullable().optional(),
        quantity: z.number().int().min(1).max(99).default(1),
      })
      .parse(request.body);

    const item = db.prepare('SELECT id, preferred_store_id FROM items WHERE id = ?').get(data.item_id);
    if (!item) throw notFound('Item');

    // Store: the one asked for, else the item's preferred store, else the cheapest one.
    let storeId = data.store_id;
    if (storeId === undefined) {
      storeId =
        item.preferred_store_id ??
        db
          .prepare('SELECT store_id FROM item_prices WHERE item_id = ? ORDER BY price_pence, store_id LIMIT 1')
          .pluck()
          .get(item.id) ??
        null;
    }
    if (storeId != null && !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) {
      throw notFound('Store');
    }

    db.prepare(
      `INSERT INTO list_items (list_id, item_id, store_id, quantity, added_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (list_id, item_id) DO UPDATE SET quantity = MIN(99, quantity + excluded.quantity)`,
    ).run(listId, item.id, storeId, data.quantity, userOf(request));
    return reply.code(201).send(loadList(db, listId));
  });

  app.patch('/:id/items/:listItemId', async (request) => {
    const listId = id.parse(request.params.id);
    const listItemId = id.parse(request.params.listItemId);
    requireActive(listId);
    const current = db
      .prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ?')
      .get(listItemId, listId);
    if (!current) throw notFound('List item');

    const data = z
      .object({
        quantity: z.number().int().min(1).max(99),
        checked: z.boolean(),
        store_id: id.nullable(),
        price_paid_pence: pence.nullable(),
      })
      .partial()
      .parse(request.body);

    const storeId = data.store_id !== undefined ? data.store_id : current.store_id;
    if (storeId != null && !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) {
      throw notFound('Store');
    }
    const checked = data.checked !== undefined ? data.checked : current.checked === 1;

    // Ticking snapshots the shelf price, so spending history stays right if the
    // price changes later. A price typed in at the till wins over the shelf price.
    let paid = current.price_paid_pence;
    if (!checked) paid = null;
    else if (data.price_paid_pence !== undefined) paid = data.price_paid_pence;
    else if (current.checked === 0 || storeId !== current.store_id) paid = currentPrice(db, current.item_id, storeId);

    db.prepare(
      'UPDATE list_items SET quantity = ?, store_id = ?, checked = ?, price_paid_pence = ? WHERE id = ?',
    ).run(data.quantity ?? current.quantity, storeId, checked ? 1 : 0, paid, listItemId);
    return loadList(db, listId);
  });

  app.delete('/:id/items/:listItemId', async (request) => {
    const listId = id.parse(request.params.id);
    const listItemId = id.parse(request.params.listItemId);
    requireActive(listId);
    const { changes } = db
      .prepare('DELETE FROM list_items WHERE id = ? AND list_id = ?')
      .run(listItemId, listId);
    if (changes === 0) throw notFound('List item');
    return loadList(db, listId);
  });

  // Scanning an item's barcode means "I have just put this in my basket": it is
  // added to the list if it was not there, and ticked with the price at the
  // store you are in. Scanning a ticked item again counts another one.
  // `price_pence` records the shelf price you read, for that store, first.
  app.post('/:id/scan', async (request) => {
    const listId = id.parse(request.params.id);
    requireActive(listId);
    const data = z
      .object({
        item_id: id,
        store_id: id.nullable().optional(),
        price_pence: pence.optional(),
      })
      .parse(request.body);

    const item = db.prepare('SELECT id, name, preferred_store_id FROM items WHERE id = ?').get(data.item_id);
    if (!item) throw notFound('Item');
    const existing = db
      .prepare('SELECT * FROM list_items WHERE list_id = ? AND item_id = ?')
      .get(listId, item.id);

    // The store you scanned at; otherwise wherever the item was already
    // planned for, its usual store, or the cheapest one.
    let storeId = data.store_id;
    if (storeId === undefined) {
      storeId =
        existing?.store_id ??
        item.preferred_store_id ??
        db
          .prepare('SELECT store_id FROM item_prices WHERE item_id = ? ORDER BY price_pence, store_id LIMIT 1')
          .pluck()
          .get(item.id) ??
        null;
    }
    if (storeId != null && !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) {
      throw notFound('Store');
    }
    if (data.price_pence !== undefined && storeId == null) {
      throw new HttpError(400, 'A price needs a store');
    }

    let status;
    db.transaction(() => {
      if (data.price_pence !== undefined) setManualPrice(db, item.id, storeId, data.price_pence);
      const price = currentPrice(db, item.id, storeId);
      if (!existing) {
        db.prepare(
          `INSERT INTO list_items (list_id, item_id, store_id, quantity, checked, price_paid_pence, added_by)
           VALUES (?, ?, ?, 1, 1, ?, ?)`,
        ).run(listId, item.id, storeId, price, userOf(request));
        status = 'ticked';
      } else if (!existing.checked) {
        db.prepare('UPDATE list_items SET store_id = ?, checked = 1, price_paid_pence = ? WHERE id = ?').run(
          storeId,
          price,
          existing.id,
        );
        status = 'ticked';
      } else {
        db.prepare(
          'UPDATE list_items SET quantity = MIN(99, quantity + 1), price_paid_pence = COALESCE(price_paid_pence, ?) WHERE id = ?',
        ).run(price, existing.id);
        status = 'again';
      }
    })();

    const list = loadList(db, listId);
    const row = list.items.find((i) => i.item_id === item.id);
    return {
      list,
      scanned: {
        list_item_id: row.id,
        name: item.name,
        status,
        quantity: row.quantity,
        store_id: row.store_id,
        store_name: row.store_name,
        unit_price_pence: row.unit_price_pence,
      },
    };
  });

  // Finish the shop. The next GET /current starts a fresh list.
  app.post('/:id/complete', async (request) => {
    const listId = id.parse(request.params.id);
    requireActive(listId);
    db.prepare("UPDATE lists SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(listId);
    return loadList(db, listId);
  });
}
