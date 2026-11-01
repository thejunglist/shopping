import { z } from 'zod';
import { normalizeEan } from '../barcode.js';
import { id, notFound, pence, setClause } from '../http.js';
import { setManualPrice } from '../prices.js';

const itemBody = z.object({
  name: z.string().trim().min(1).max(120),
  category_id: id,
  default_unit: z.string().trim().max(30).nullish(),
  notes: z.string().trim().max(500).nullish(),
  ean: z
    .string()
    .trim()
    .regex(/^\d{8,14}$/, 'Barcode must be 8 to 14 digits')
    .nullish(),
  preferred_store_id: id.nullish(),
});

const createBody = itemBody.extend({
  prices: z.array(z.object({ store_id: id, price_pence: pence })).max(50).optional(),
});

const columns = ['name', 'category_id', 'default_unit', 'notes', 'ean', 'preferred_store_id'];

/** Load items with their category name and a `prices` array (one per store). */
export function loadItems(db, { itemId = null, q = null, ean = null } = {}) {
  const items = db
    .prepare(
      `SELECT i.id, i.name, i.category_id, c.name AS category_name, i.default_unit, i.notes,
              i.ean, i.preferred_store_id
         FROM items i JOIN categories c ON c.id = i.category_id
        WHERE (@id IS NULL OR i.id = @id)
          AND (@q IS NULL OR instr(lower(i.name), lower(@q)) > 0)
          AND (@ean IS NULL OR ltrim(i.ean, '0') = ltrim(@ean, '0'))
        ORDER BY c.sort_order, c.name COLLATE NOCASE, i.name COLLATE NOCASE`,
    )
    .all({ id: itemId, q, ean });

  const prices = db
    .prepare('SELECT item_id, store_id, price_pence, source, updated_at FROM item_prices')
    .all();
  const byItem = new Map();
  for (const { item_id, ...price } of prices) {
    if (!byItem.has(item_id)) byItem.set(item_id, []);
    byItem.get(item_id).push(price);
  }
  return items.map((item) => ({ ...item, prices: byItem.get(item.id) ?? [] }));
}

export default async function itemRoutes(app, { db }) {
  const requireItem = (itemId) => {
    const [item] = loadItems(db, { itemId });
    if (!item) throw notFound('Item');
    return item;
  };
  const requireStore = (storeId) => {
    if (!db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) throw notFound('Store');
  };

  app.get('/', async (request) => {
    const { q } = z.object({ q: z.string().trim().max(120).optional() }).parse(request.query);
    return loadItems(db, { q: q || null });
  });

  app.get('/:id', async (request) => requireItem(id.parse(request.params.id)));

  app.post('/', async (request, reply) => {
    const { prices = [], ...data } = createBody.parse(request.body);
    if (data.ean) data.ean = normalizeEan(data.ean);
    const itemId = db.transaction(() => {
      const newId = db
        .prepare(
          `INSERT INTO items (name, category_id, default_unit, notes, ean, preferred_store_id)
           VALUES (@name, @category_id, @default_unit, @notes, @ean, @preferred_store_id)`,
        )
        .run({
          default_unit: null,
          notes: null,
          ean: null,
          preferred_store_id: null,
          ...data,
        }).lastInsertRowid;
      for (const price of prices) setManualPrice(db, newId, price.store_id, price.price_pence);
      return newId;
    })();
    return reply.code(201).send(requireItem(itemId));
  });

  app.patch('/:id', async (request) => {
    const itemId = id.parse(request.params.id);
    requireItem(itemId);
    const body = itemBody.partial().parse(request.body);
    if (body.ean) body.ean = normalizeEan(body.ean);
    const { sql, values } = setClause(body, columns);
    if (sql) db.prepare(`UPDATE items SET ${sql} WHERE id = ?`).run(...values, itemId);
    return requireItem(itemId);
  });

  // Items that have been on a list cannot be deleted (409): the spending
  // history refers to them.
  app.delete('/:id', async (request, reply) => {
    const itemId = id.parse(request.params.id);
    requireItem(itemId);
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
    return reply.code(204).send();
  });

  app.put('/:id/prices/:storeId', async (request) => {
    const itemId = id.parse(request.params.id);
    const storeId = id.parse(request.params.storeId);
    const { price_pence } = z.object({ price_pence: pence }).parse(request.body);
    requireItem(itemId);
    requireStore(storeId);
    setManualPrice(db, itemId, storeId, price_pence);
    return requireItem(itemId);
  });

  app.delete('/:id/prices/:storeId', async (request) => {
    const itemId = id.parse(request.params.id);
    const storeId = id.parse(request.params.storeId);
    requireItem(itemId);
    db.prepare('DELETE FROM item_prices WHERE item_id = ? AND store_id = ?').run(itemId, storeId);
    return requireItem(itemId);
  });
}
