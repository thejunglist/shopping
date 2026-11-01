import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

// Real, valid barcodes: EAN-13, and the same product written as a 12-digit UPC-A.
const EAN = '3017620422003';
const UPC = '036000291452';
const EAN_OF_UPC = '0036000291452';

let db;
let app;
let lookupProduct;

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db, migrationsDir);
  lookupProduct = vi.fn(async () => ({ status: 'not_found' }));
  app = await buildApp({ db, lookupProduct });
});

afterEach(() => db.close());

const call = async (method, url, payload, headers = {}) => {
  const res = await app.inject({ method, url, payload, headers });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

const makeStore = async (name) => (await call('POST', '/api/stores', { name })).body;
const makeItem = async (name, extra = {}) =>
  (await call('POST', '/api/items', { name, category_id: 1, ...extra })).body;

describe('GET /api/barcode/:ean', () => {
  it('rejects things that are not barcodes, and misreads', async () => {
    expect((await call('GET', '/api/barcode/abc')).status).toBe(400);
    expect((await call('GET', '/api/barcode/12345')).status).toBe(400);
    const misread = await call('GET', '/api/barcode/3017620422004');
    expect(misread.status).toBe(400);
    expect(misread.body.error).toMatch(/check digit/);
    expect(lookupProduct).not.toHaveBeenCalled();
  });

  it('finds an item you already have, without asking Open Food Facts', async () => {
    await makeItem('Hazelnut spread', { ean: EAN });
    const { status, body } = await call('GET', `/api/barcode/${EAN}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ lookup: 'local', product: null, item: { name: 'Hazelnut spread', ean: EAN } });
    expect(lookupProduct).not.toHaveBeenCalled();
  });

  it('matches a UPC-A and its EAN-13 spelling to the same item', async () => {
    const item = await makeItem('Cola', { ean: UPC }); // saved from the 12-digit form
    expect(item.ean).toBe(EAN_OF_UPC);
    expect((await call('GET', `/api/barcode/${UPC}`)).body.item.name).toBe('Cola');
    expect((await call('GET', `/api/barcode/${EAN_OF_UPC}`)).body.item.name).toBe('Cola');
  });

  it('offers a name and a category for a barcode you have not seen', async () => {
    lookupProduct.mockResolvedValue({
      status: 'found',
      product: { name: 'Ferrero Nutella', brand: 'Ferrero', quantity: '400g', categories: ['en:spreads'] },
    });
    const { body } = await call('GET', `/api/barcode/${EAN}`);
    const tinsAndDry = (await call('GET', '/api/categories')).body.find((c) => c.name === 'Tins & Dry Goods');
    expect(body).toMatchObject({
      item: null,
      lookup: 'found',
      product: { name: 'Ferrero Nutella', quantity: '400g' },
      suggested_category_id: tinsAndDry.id,
    });
  });

  it('suggests no category if the matching one was renamed or deleted', async () => {
    lookupProduct.mockResolvedValue({
      status: 'found',
      product: { name: 'Milk', brand: null, quantity: null, categories: ['en:milks'] },
    });
    const dairy = (await call('GET', '/api/categories')).body.find((c) => c.name === 'Dairy');
    await call('PATCH', `/api/categories/${dairy.id}`, { name: 'Chilled' });
    expect((await call('GET', `/api/barcode/${EAN}`)).body.suggested_category_id).toBeNull();
  });

  it('remembers answers, but retries after a failure', async () => {
    await call('GET', `/api/barcode/${EAN}`);
    await call('GET', `/api/barcode/${EAN}`);
    expect(lookupProduct).toHaveBeenCalledTimes(1); // "not found" is cached

    lookupProduct.mockResolvedValue({ status: 'unavailable' });
    await call('GET', `/api/barcode/${UPC}`);
    const retry = await call('GET', `/api/barcode/${UPC}`);
    expect(lookupProduct).toHaveBeenCalledTimes(3); // "unavailable" is not
    expect(retry.body).toMatchObject({ lookup: 'unavailable', product: null });
    expect(lookupProduct).toHaveBeenLastCalledWith(EAN_OF_UPC); // the normalised barcode is what is sent
  });
});

describe('POST /api/lists/:id/scan', () => {
  const setup = async () => {
    const aldi = await makeStore('Aldi');
    const tesco = await makeStore('Tesco');
    const milk = await makeItem('Milk', {
      category_id: 2,
      ean: EAN,
      prices: [
        { store_id: aldi.id, price_pence: 145 },
        { store_id: tesco.id, price_pence: 165 },
      ],
    });
    const list = (await call('GET', '/api/lists/current')).body;
    return { aldi, tesco, milk, list };
  };

  it('adds the item and ticks it at the store you are in, taking that store\'s price', async () => {
    const { tesco, milk, list } = await setup();
    const { status, body } = await call(
      'POST',
      `/api/lists/${list.id}/scan`,
      { item_id: milk.id, store_id: tesco.id },
      { 'tailscale-user-login': 'sam@example.com' },
    );
    expect(status).toBe(200);
    expect(body.scanned).toMatchObject({ name: 'Milk', status: 'ticked', quantity: 1, store_name: 'Tesco', unit_price_pence: 165 });
    expect(body.list.items[0]).toMatchObject({ checked: true, store_id: tesco.id, added_by: 'sam@example.com' });
    expect(body.list.totals).toMatchObject({ checked_pence: 165, unchecked_pence: 0 });
  });

  it('ticks an item already planned, and moves it to the store you scanned at', async () => {
    const { aldi, tesco, milk, list } = await setup();
    await call('POST', `/api/lists/${list.id}/items`, { item_id: milk.id, store_id: aldi.id });
    const { body } = await call('POST', `/api/lists/${list.id}/scan`, { item_id: milk.id, store_id: tesco.id });
    expect(body.list.items).toHaveLength(1);
    expect(body.list.items[0]).toMatchObject({ checked: true, store_id: tesco.id, unit_price_pence: 165 });
  });

  it('counts a second scan of a ticked item as another one', async () => {
    const { aldi, milk, list } = await setup();
    await call('POST', `/api/lists/${list.id}/scan`, { item_id: milk.id, store_id: aldi.id });
    const again = await call('POST', `/api/lists/${list.id}/scan`, { item_id: milk.id, store_id: aldi.id });
    expect(again.body.scanned).toMatchObject({ status: 'again', quantity: 2 });
    expect(again.body.list.totals.checked_pence).toBe(290);
  });

  it('records the shelf price you read before ticking', async () => {
    const { aldi, milk, list } = await setup();
    const { body } = await call('POST', `/api/lists/${list.id}/scan`, {
      item_id: milk.id,
      store_id: aldi.id,
      price_pence: 155,
    });
    expect(body.scanned.unit_price_pence).toBe(155);
    const item = (await call('GET', `/api/items/${milk.id}`)).body;
    expect(item.prices.find((p) => p.store_id === aldi.id)).toMatchObject({ price_pence: 155, source: 'manual' });
  });

  it('works without a store for an item that has none, and says so in the price', async () => {
    const soap = await makeItem('Soap', { category_id: 8 });
    const list = (await call('GET', '/api/lists/current')).body;
    const { body } = await call('POST', `/api/lists/${list.id}/scan`, { item_id: soap.id });
    expect(body.scanned).toMatchObject({ status: 'ticked', store_id: null, unit_price_pence: null });
    expect(body.list.totals.unpriced_count).toBe(1);
  });

  it('refuses a price with no store, a finished list, and unknown things', async () => {
    const { milk, list } = await setup();
    const soap = await makeItem('Soap', { category_id: 8 });
    expect((await call('POST', `/api/lists/${list.id}/scan`, { item_id: soap.id, price_pence: 99 })).status).toBe(400);
    expect((await call('POST', `/api/lists/${list.id}/scan`, { item_id: 999 })).status).toBe(404);
    expect((await call('POST', `/api/lists/${list.id}/scan`, { item_id: milk.id, store_id: 999 })).status).toBe(404);
    await call('POST', `/api/lists/${list.id}/complete`);
    expect((await call('POST', `/api/lists/${list.id}/scan`, { item_id: milk.id })).status).toBe(409);
  });

  it('keeps one price per tick even if the shelf price changes afterwards', async () => {
    const { aldi, milk, list } = await setup();
    await call('POST', `/api/lists/${list.id}/scan`, { item_id: milk.id, store_id: aldi.id });
    await call('PUT', `/api/items/${milk.id}/prices/${aldi.id}`, { price_pence: 199 });
    const after = (await call('GET', `/api/lists/${list.id}`)).body;
    expect(after.items[0].unit_price_pence).toBe(145);
  });
});
