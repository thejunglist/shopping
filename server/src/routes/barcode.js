import { isValidGtin, normalizeEan, suggestCategoryName } from '../barcode.js';
import { HttpError } from '../http.js';
import { loadItems } from './items.js';

const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

/**
 * GET /api/barcode/:ean tells the scan screen what to do with a barcode:
 *   item     the item you already have with this barcode, or null
 *   product  a name, brand and size from Open Food Facts when it is new to you
 *   lookup   'local' | 'found' | 'not_found' | 'unavailable'
 *   suggested_category_id   a guess at the category for a new item, or null
 *
 * Only the barcode is sent to Open Food Facts, and only for barcodes you have
 * not saved yet. The browser never talks to them directly.
 */
export default async function barcodeRoutes(app, { db, lookupProduct }) {
  const cache = new Map();

  const lookup = async (ean) => {
    const hit = cache.get(ean);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
    const result = await lookupProduct(ean);
    // A failed lookup is not remembered, so the next scan tries again.
    if (result.status !== 'unavailable') {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(ean, { at: Date.now(), result });
    }
    return result;
  };

  app.get('/:ean', async (request) => {
    const raw = String(request.params.ean).replace(/\s/g, '');
    if (!/^\d{8,14}$/.test(raw)) throw new HttpError(400, 'A barcode is 8 to 14 digits');
    if (!isValidGtin(raw)) {
      throw new HttpError(400, 'That barcode does not add up (check digit). Try scanning it again');
    }

    const ean = normalizeEan(raw);
    const [item] = loadItems(db, { ean });
    if (item) return { ean, item, product: null, suggested_category_id: null, lookup: 'local' };

    const result = await lookup(ean);
    let categoryId = null;
    if (result.status === 'found') {
      const hint = suggestCategoryName(result.product.categories);
      if (hint) {
        categoryId =
          db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').pluck().get(hint) ?? null;
      }
    }
    return {
      ean,
      item: null,
      product:
        result.status === 'found'
          ? { name: result.product.name, brand: result.product.brand, quantity: result.product.quantity }
          : null,
      suggested_category_id: categoryId,
      lookup: result.status,
    };
  });
}
