import { describe, expect, it, vi } from 'vitest';
import {
  isValidGtin,
  lookupOpenFoodFacts,
  normalizeEan,
  parseProduct,
  suggestCategoryName,
} from '../src/barcode.js';

describe('isValidGtin', () => {
  it.each(['3017620422003', '96385074', '036000291452'])('accepts the real barcode %s', (code) => {
    expect(isValidGtin(code)).toBe(true);
  });

  it('rejects a single misread digit', () => {
    expect(isValidGtin('3017620422004')).toBe(false); // check digit off by one
    expect(isValidGtin('3017620422103')).toBe(false); // a digit in the middle changed
  });

  it.each(['', 'abc', '12345', '30176204220031', '3017620 422003', '301762042200x'])(
    'rejects %j',
    (code) => {
      expect(isValidGtin(code)).toBe(false);
    },
  );
});

describe('normalizeEan', () => {
  it('writes a UPC-A as the equivalent EAN-13', () => {
    expect(normalizeEan('036000291452')).toBe('0036000291452');
  });
  it('leaves EAN-13 and EAN-8 alone, and strips spaces', () => {
    expect(normalizeEan('3017620422003')).toBe('3017620422003');
    expect(normalizeEan('96385074')).toBe('96385074');
    expect(normalizeEan(' 3017620422003 ')).toBe('3017620422003');
  });
});

describe('suggestCategoryName', () => {
  it.each([
    [['en:frozen-foods', 'en:frozen-vegetables'], 'Frozen'], // frozen beats vegetables
    [['en:dairies', 'en:milks'], 'Dairy'],
    [['en:beverages', 'en:waters'], 'Drinks'],
    [['en:plant-based-foods', 'en:fruits-and-vegetables'], 'Produce'],
    [['en:breads'], 'Bakery'],
    [['en:meats', 'en:sausages'], 'Meat & Fish'],
    [['en:canned-foods', 'en:legumes'], 'Tins & Dry Goods'],
    [['en:something-unexpected'], null],
    [[], null],
  ])('%j -> %s', (tags, expected) => {
    expect(suggestCategoryName(tags)).toBe(expected);
  });
});

describe('parseProduct', () => {
  it('reads the v2 shape and puts the brand in front of the name', () => {
    const result = parseProduct({
      code: '1',
      status: 1,
      status_verbose: 'product found',
      product: { product_name: 'Baked Beans', brands: 'Heinz, Other', quantity: ' 415g ', categories_tags: ['en:canned-foods'] },
    });
    expect(result).toEqual({
      status: 'found',
      product: { name: 'Heinz Baked Beans', brand: 'Heinz', quantity: '415g', categories: ['en:canned-foods'] },
    });
  });

  it('reads the v3 shape too', () => {
    const result = parseProduct({
      status: 'success',
      result: { id: 'product_found' },
      product: { product_name_en: 'Semi-skimmed milk', brands: '' },
    });
    expect(result.status).toBe('found');
    expect(result.product).toMatchObject({ name: 'Semi-skimmed milk', brand: null, quantity: null, categories: [] });
  });

  it('does not repeat a brand already in the name', () => {
    const result = parseProduct({ status: 1, product: { product_name: 'Nutella spread', brands: 'Nutella' } });
    expect(result.product.name).toBe('Nutella spread');
  });

  it.each([
    [{ status: 0, status_verbose: 'product not found' }],
    [{ status: 'failure', product: {} }],
    [{ status: 1, product: { product_name: '  ' } }],
    [{ status: 1 }],
    [null],
  ])('treats %j as not found', (data) => {
    expect(parseProduct(data)).toEqual({ status: 'not_found' });
  });
});

describe('lookupOpenFoodFacts', () => {
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it('asks for the barcode with a User-Agent that names the app and contact', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { status: 1, product: { product_name: 'Milk' } }));
    const result = await lookupOpenFoodFacts('3017620422003', { fetchImpl, contact: 'me@example.com' });
    expect(result.status).toBe('found');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toContain('/3017620422003.json?fields=');
    expect(options.headers['User-Agent']).toBe('ShoppingList/0.1 (me@example.com)');
  });

  it('sends nothing about you unless a contact is set', async () => {
    const fetchImpl = vi.fn(async () => reply(404, {}));
    await lookupOpenFoodFacts('3017620422003', { fetchImpl, contact: undefined });
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBe('ShoppingList/0.1 (self-hosted)');
  });

  it('maps 404 to not_found, and other failures to unavailable', async () => {
    const run = (fetchImpl) => lookupOpenFoodFacts('3017620422003', { fetchImpl });
    expect(await run(async () => reply(404, {}))).toEqual({ status: 'not_found' });
    expect(await run(async () => reply(429, {}))).toEqual({ status: 'unavailable' });
    expect(await run(async () => reply(503, {}))).toEqual({ status: 'unavailable' });
    expect(await run(async () => { throw new Error('offline'); })).toEqual({ status: 'unavailable' });
    expect(await run(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }))).toEqual({
      status: 'unavailable',
    });
  });

  it('can use a different address template, such as API v3', async () => {
    const fetchImpl = vi.fn(async () => reply(404, {}));
    await lookupOpenFoodFacts('3017620422003', { fetchImpl, urlTemplate: 'https://example.test/v3/product/{ean}' });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/example\.test\/v3\/product\/3017620422003\?fields=/);
  });
});
