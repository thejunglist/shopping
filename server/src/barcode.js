// Barcode helpers: validation, normalising, and product lookup by barcode.

/**
 * GTIN check digit: from the right, ignoring the check digit itself, weight the
 * digits 3, 1, 3, 1... and the sum plus the check digit must be a multiple of
 * 10. Camera decoders occasionally misread a digit; this catches almost all of
 * those, so a misread cannot silently tick the wrong item.
 * Valid lengths: 8 (EAN-8), 12 (UPC-A), 13 (EAN-13), 14 (GTIN-14).
 */
export function isValidGtin(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * One spelling per product. A UPC-A (12 digits) is an EAN-13 with a leading
 * zero, and scanners report the same product either way, so both become 13
 * digits. EAN-8 and GTIN-14 are left as they are.
 */
export function normalizeEan(code) {
  const digits = String(code).replace(/\s/g, '');
  return digits.length === 12 || digits.length === 13 ? digits.padStart(13, '0') : digits;
}

// Open Food Facts category tags -> the default category names. The first
// pattern that matches wins, so "frozen" is checked before "vegetables". The
// route only uses a suggestion if a category with that name still exists.
const CATEGORY_HINTS = [
  [/frozen/, 'Frozen'],
  [/fruits|vegetables|salads|potatoes|herbs/, 'Produce'],
  [/dairies|milks|cheeses|yogurts|butters|creams|eggs/, 'Dairy'],
  [/meats|poultry|fishes|seafood|sausages|bacon|hams/, 'Meat & Fish'],
  [/breads|bakery|pastries|cakes|buns/, 'Bakery'],
  [/beverages|waters|juices|sodas|beers|wines|coffees|teas|drinks/, 'Drinks'],
  [/canned|pasta|rice|cereals|breakfast|snacks|sauces|spices|legumes|biscuits|chocolates|confectioneries|flours|spreads/, 'Tins & Dry Goods'],
];

export function suggestCategoryName(categoryTags = []) {
  const text = categoryTags.join(' ');
  for (const [pattern, name] of CATEGORY_HINTS) if (pattern.test(text)) return name;
  return null;
}

const DEFAULT_URL = 'https://world.openfoodfacts.org/api/v2/product/{ean}.json';
const FIELDS = 'product_name,product_name_en,brands,quantity,categories_tags';

/**
 * Look a barcode up on Open Food Facts. Never throws: the answer is
 *   { status: 'found', product: { name, brand, quantity, categories } }
 *   { status: 'not_found' }     they have no such product
 *   { status: 'unavailable' }   network error, timeout, rate limit, server error
 *
 * Open Food Facts asks apps to send a User-Agent of the form
 * "AppName/Version (Contact)". Set OFF_CONTACT to your own email or URL so they
 * can reach you; nothing about you is sent unless you set it. Their documented
 * limit is 15 product reads per minute per IP, which a person scanning by hand
 * will not reach, and results are cached by the route anyway.
 *
 * The documentation marks API v2 as deprecated in favour of v3. The parser
 * below accepts either response shape, so moving to v3 is a matter of setting
 * OFF_PRODUCT_URL to the v3 address (keep the {ean} placeholder).
 */
export async function lookupOpenFoodFacts(
  ean,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 4000,
    urlTemplate = process.env.OFF_PRODUCT_URL ?? DEFAULT_URL,
    contact = process.env.OFF_CONTACT,
  } = {},
) {
  const url = `${urlTemplate.replace('{ean}', encodeURIComponent(ean))}?fields=${FIELDS}`;
  const userAgent = `ShoppingList/0.1 (${contact || 'self-hosted'})`;
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { status: 'not_found' };
    if (!response.ok) return { status: 'unavailable' };
    return parseProduct(await response.json());
  } catch {
    return { status: 'unavailable' };
  }
}

/** Accepts the v2 shape (status: 1) and the v3 shape (status: "success"). */
export function parseProduct(data) {
  const product = data?.product;
  const ok = data?.status === 1 || data?.status === 'success' || data?.result?.id === 'product_found';
  if (!ok || typeof product !== 'object' || product === null) return { status: 'not_found' };

  const productName = (product.product_name_en || product.product_name || '').trim();
  if (!productName) return { status: 'not_found' };
  const brand = (product.brands ?? '').split(',')[0].trim() || null;
  // "Heinz" + "Baked Beans" reads better on a list than "Baked Beans" alone,
  // unless the name already includes the brand.
  const name =
    brand && !productName.toLowerCase().includes(brand.toLowerCase())
      ? `${brand} ${productName}`
      : productName;
  return {
    status: 'found',
    product: {
      name,
      brand,
      quantity: (product.quantity ?? '').trim() || null,
      categories: Array.isArray(product.categories_tags) ? product.categories_tags : [],
    },
  };
}
