import { z } from 'zod';
import { id, notFound, setClause } from '../http.js';

const body = z.object({
  name: z.string().trim().min(1).max(60),
  sort_order: z.number().int().min(0).max(100_000),
});

/**
 * CRUD for the two simple lookup tables, categories and stores. `table` is
 * always a constant from app.js, never request input.
 */
export default async function resourceRoutes(app, { db, table, label }) {
  const get = (rowId) =>
    db.prepare(`SELECT id, name, sort_order FROM ${table} WHERE id = ?`).get(rowId);

  app.get('/', async () =>
    db.prepare(`SELECT id, name, sort_order FROM ${table} ORDER BY sort_order, name COLLATE NOCASE`).all(),
  );

  app.post('/', async (request, reply) => {
    const data = body.partial({ sort_order: true }).parse(request.body);
    // New rows go to the end unless an order is given.
    const sort =
      data.sort_order ?? db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 10 FROM ${table}`).pluck().get();
    const rowId = db.prepare(`INSERT INTO ${table} (name, sort_order) VALUES (?, ?)`).run(data.name, sort)
      .lastInsertRowid;
    return reply.code(201).send(get(rowId));
  });

  app.patch('/:id', async (request) => {
    const rowId = id.parse(request.params.id);
    if (!get(rowId)) throw notFound(label);
    const { sql, values } = setClause(body.partial().parse(request.body), ['name', 'sort_order']);
    if (sql) db.prepare(`UPDATE ${table} SET ${sql} WHERE id = ?`).run(...values, rowId);
    return get(rowId);
  });

  app.delete('/:id', async (request, reply) => {
    const rowId = id.parse(request.params.id);
    if (!get(rowId)) throw notFound(label);
    // A category that still has items is refused by the foreign key (409).
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rowId);
    return reply.code(204).send();
  });
}
