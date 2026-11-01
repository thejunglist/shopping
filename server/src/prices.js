/** Set the current shelf price of an item at a store, as typed in by a person. */
export function setManualPrice(db, itemId, storeId, pricePence) {
  db.prepare(
    `INSERT INTO item_prices (item_id, store_id, price_pence, source, updated_at)
     VALUES (?, ?, ?, 'manual', datetime('now'))
     ON CONFLICT (item_id, store_id) DO UPDATE
       SET price_pence = excluded.price_pence, source = 'manual', updated_at = datetime('now')`,
  ).run(itemId, storeId, pricePence);
}

/** The current price of an item at a store in pence, or null if there is none. */
export function currentPrice(db, itemId, storeId) {
  if (storeId == null) return null;
  return (
    db
      .prepare('SELECT price_pence FROM item_prices WHERE item_id = ? AND store_id = ?')
      .pluck()
      .get(itemId, storeId) ?? null
  );
}
