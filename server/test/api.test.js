import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

let db;
let app;

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db, migrationsDir);
  app = await buildApp({ db });
});

afterEach(() => db.close());

const call = async (method, url, payload, headers = {}) => {
  const res = await app.inject({ method, url, payload, headers });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

const makeStore = async (name) => (await call('POST', '/api/stores', { name })).body;
const makeItem = async (name, extra = {}) =>
  (await call('POST', '/api/items', { name, category_id: 1, ...extra })).body;

describe('categories and stores', () => {
  it('lists the seeded categories in order', async () => {
    const { status, body } = await call('GET', '/api/categories');
    expect(status).toBe(200);
    expect(body[0].name).toBe('Produce');
    expect(body).toHaveLength(9);
  });

  it('creates, renames and deletes a category', async () => {
    const created = await call('POST', '/api/categories', { name: 'Pet food' });
    expect(created.status).toBe(201);
    expect(created.body.sort_order).toBe(100); // after the last seeded one (90)

    const renamed = await call('PATCH', `/api/categories/${created.body.id}`, { name: 'Pets' });
    expect(renamed.body.name).toBe('Pets');

    expect((await call('DELETE', `/api/categories/${created.body.id}`)).status).toBe(204);
    expect((await call('GET', '/api/categories')).body.map((c) => c.name)).not.toContain('Pets');
  });

  it('rejects a duplicate name and an empty name', async () => {
    expect((await call('POST', '/api/categories', { name: 'Dairy' })).status).toBe(409);
    const empty = await call('POST', '/api/stores', { name: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body.issues[0].path).toBe('name');
  });

  it('refuses to delete a category that has items, and 404s on a missing one', async () => {
    await makeItem('Milk', { category_id: 2 });
    expect((await call('DELETE', '/api/categories/2')).status).toBe(409);
    expect((await call('DELETE', '/api/categories/999')).status).toBe(404);
  });

  it('puts new stores at the end', async () => {
    const a = await makeStore('Aldi');
    const b = await makeStore('Tesco');
    expect(b.sort_order).toBeGreaterThan(a.sort_order);
  });
});

describe('items and prices', () => {
  it('creates an item with prices for several stores', async () => {
    const aldi = await makeStore('Aldi');
    const tesco = await makeStore('Tesco');
    const res = await call('POST', '/api/items', {
      name: 'Milk 2L',
      category_id: 2,
      default_unit: '2L',
      prices: [
        { store_id: aldi.id, price_pence: 145 },
        { store_id: tesco.id, price_pence: 165 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.category_name).toBe('Dairy');
    expect(res.body.prices.map((p) => p.price_pence).sort()).toEqual([145, 165]);
  });

  it('updates a price in place and can remove it', async () => {
    const aldi = await makeStore('Aldi');
    const item = await makeItem('Bread');
    await call('PUT', `/api/items/${item.id}/prices/${aldi.id}`, { price_pence: 110 });
    const updated = await call('PUT', `/api/items/${item.id}/prices/${aldi.id}`, { price_pence: 120 });
    expect(updated.body.prices).toHaveLength(1);
    expect(updated.body.prices[0]).toMatchObject({ store_id: aldi.id, price_pence: 120, source: 'manual' });

    const removed = await call('DELETE', `/api/items/${item.id}/prices/${aldi.id}`);
    expect(removed.body.prices).toEqual([]);
  });

  it('rejects fractional or negative prices', async () => {
    const aldi = await makeStore('Aldi');
    const item = await makeItem('Bread');
    for (const price_pence of [1.5, -1, 'abc']) {
      const res = await call('PUT', `/api/items/${item.id}/prices/${aldi.id}`, { price_pence });
      expect(res.status).toBe(400);
    }
  });

  it('searches by name ignoring case, and treats % literally', async () => {
    await makeItem('Wholemeal Bread');
    await makeItem('Milk');
    expect((await call('GET', '/api/items?q=bread')).body.map((i) => i.name)).toEqual(['Wholemeal Bread']);
    expect((await call('GET', '/api/items?q=%25')).body).toEqual([]);
  });

  it('rejects duplicate names, bad barcodes and unknown categories', async () => {
    await makeItem('Milk');
    expect((await call('POST', '/api/items', { name: 'milk', category_id: 1 })).status).toBe(409);
    expect((await call('POST', '/api/items', { name: 'Eggs', category_id: 1, ean: '12' })).status).toBe(400);
    expect((await call('POST', '/api/items', { name: 'Eggs', category_id: 99 })).status).toBe(409);
  });

  it('updates and clears optional fields with PATCH', async () => {
    const item = await makeItem('Beans', { notes: 'Heinz' });
    const res = await call('PATCH', `/api/items/${item.id}`, { notes: null, default_unit: '400g' });
    expect(res.body).toMatchObject({ notes: null, default_unit: '400g', name: 'Beans' });
  });
});

describe('the weekly list', () => {
  const setup = async () => {
    const aldi = await makeStore('Aldi');
    const tesco = await makeStore('Tesco');
    const milk = await makeItem('Milk', {
      category_id: 2,
      prices: [
        { store_id: aldi.id, price_pence: 145 },
        { store_id: tesco.id, price_pence: 165 },
      ],
    });
    const bread = await makeItem('Bread', {
      category_id: 4,
      prices: [{ store_id: tesco.id, price_pence: 125 }],
    });
    const soap = await makeItem('Soap', { category_id: 8 }); // no price anywhere
    return { aldi, tesco, milk, bread, soap };
  };

  it('creates the current list on first use and reuses it', async () => {
    const first = await call('GET', '/api/lists/current');
    const second = await call('GET', '/api/lists/current');
    expect(first.body).toMatchObject({ kind: 'weekly', status: 'active', items: [] });
    expect(first.body.name).toMatch(/^Week of /);
    expect(second.body.id).toBe(first.body.id);
  });

  it('defaults the store to the cheapest, and adding again raises the quantity', async () => {
    const { aldi, milk } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    const added = await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id }, { 'tailscale-user-login': 'sam@example.com' });
    expect(added.status).toBe(201);
    expect(added.body.items[0]).toMatchObject({ store_id: aldi.id, quantity: 1, added_by: 'sam@example.com' });

    const again = await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id, quantity: 2 });
    expect(again.body.items).toHaveLength(1);
    expect(again.body.items[0].quantity).toBe(3);
  });

  it('prefers the item preferred store over the cheapest', async () => {
    const { tesco, milk } = await setup();
    await call('PATCH', `/api/items/${milk.id}`, { preferred_store_id: tesco.id });
    const list = (await call('GET', '/api/lists/current')).body;
    const added = await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id });
    expect(added.body.items[0].store_id).toBe(tesco.id);
  });

  it('orders items by store, then category', async () => {
    const { milk, bread, soap } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    for (const item of [soap, bread, milk]) await call('POST', `/api/lists/${list.id}/items`, { item_id: item.id });
    const res = (await call('GET', `/api/lists/${list.id}`)).body;
    // Aldi (milk), Tesco (bread), then the item with no store (soap).
    expect(res.items.map((i) => i.name)).toEqual(['Milk', 'Bread', 'Soap']);
  });

  it('totals checked and unchecked items, counts unpriced ones, and tracks the budget', async () => {
    const { milk, bread, soap } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    await call('PATCH', `/api/lists/${list.id}`, { budget_pence: 1000 });
    await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id, quantity: 2 });
    await call('POST', `/api/lists/${list.id}/items`, { item_id: bread.id });
    const withSoap = await call('POST', `/api/lists/${list.id}/items`, { item_id: soap.id });

    expect(withSoap.body.totals).toEqual({
      checked_pence: 0,
      unchecked_pence: 2 * 145 + 125,
      total_pence: 415,
      unpriced_count: 1,
      remaining_pence: 585,
    });

    const milkRow = withSoap.body.items.find((i) => i.name === 'Milk');
    const ticked = await call('PATCH', `/api/lists/${list.id}/items/${milkRow.id}`, { checked: true });
    expect(ticked.body.totals).toMatchObject({ checked_pence: 290, unchecked_pence: 125 });
  });

  it('snapshots the price when ticked, so later price changes do not alter it', async () => {
    const { aldi, milk } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    const added = await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id });
    const rowId = added.body.items[0].id;

    await call('PATCH', `/api/lists/${list.id}/items/${rowId}`, { checked: true });
    await call('PUT', `/api/items/${milk.id}/prices/${aldi.id}`, { price_pence: 199 });
    const after = (await call('GET', `/api/lists/${list.id}`)).body;
    expect(after.items[0].unit_price_pence).toBe(145);

    // Unticking forgets the snapshot; the live price applies again.
    const unticked = await call('PATCH', `/api/lists/${list.id}/items/${rowId}`, { checked: false });
    expect(unticked.body.items[0].unit_price_pence).toBe(199);
  });

  it('lets a till price override the shelf price when ticking', async () => {
    const { milk } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    const rowId = (await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id })).body.items[0].id;
    const res = await call('PATCH', `/api/lists/${list.id}/items/${rowId}`, { checked: true, price_paid_pence: 130 });
    expect(res.body.items[0].unit_price_pence).toBe(130);
  });

  it('removes an item and 404s on a missing one', async () => {
    const { milk } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    const rowId = (await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id })).body.items[0].id;
    expect((await call('DELETE', `/api/lists/${list.id}/items/${rowId}`)).body.items).toEqual([]);
    expect((await call('DELETE', `/api/lists/${list.id}/items/${rowId}`)).status).toBe(404);
  });

  it('completes the list: keeps what was bought, then starts a fresh one with the same budget', async () => {
    const { milk, bread } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    await call('PATCH', `/api/lists/${list.id}`, { budget_pence: 8000 });
    const milkRow = (await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id })).body.items[0];
    await call('POST', `/api/lists/${list.id}/items`, { item_id: bread.id });
    await call('PATCH', `/api/lists/${list.id}/items/${milkRow.id}`, { checked: true });

    const done = await call('POST', `/api/lists/${list.id}/complete`);
    expect(done.body.status).toBe('completed');
    expect(done.body.completed_at).toBeTruthy();
    // Only the ticked item counts as spending; the unbought one has no price.
    expect(done.body.totals).toMatchObject({ total_pence: 145, unpriced_count: 0 });

    expect((await call('POST', `/api/lists/${list.id}/items`, { item_id: bread.id })).status).toBe(409);
    expect((await call('POST', `/api/lists/${list.id}/complete`)).status).toBe(409);

    const next = (await call('GET', '/api/lists/current')).body;
    expect(next.id).not.toBe(list.id);
    expect(next.budget_pence).toBe(8000);
    expect(next.items).toEqual([]);
  });

  it('keeps bought items undeletable, so history stays intact', async () => {
    const { milk } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id });
    expect((await call('DELETE', `/api/items/${milk.id}`)).status).toBe(409);
  });

  it('validates quantities and budgets', async () => {
    const { milk } = await setup();
    const list = (await call('GET', '/api/lists/current')).body;
    expect((await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id, quantity: 0 })).status).toBe(400);
    expect((await call('PATCH', `/api/lists/${list.id}`, { budget_pence: -5 })).status).toBe(400);
    expect((await call('PATCH', `/api/lists/${list.id}`, { budget_pence: null })).body.budget_pence).toBeNull();
    expect((await call('GET', '/api/lists/999')).status).toBe(404);
  });
});
