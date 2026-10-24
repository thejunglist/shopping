-- Core schema. Prices are integer pence. Migrations are forward-only.

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stores (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE items (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  category_id        INTEGER NOT NULL REFERENCES categories (id),
  default_unit       TEXT,
  notes              TEXT,
  ean                TEXT,
  preferred_store_id INTEGER REFERENCES stores (id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_items_category ON items (category_id);
CREATE UNIQUE INDEX idx_items_ean ON items (ean) WHERE ean IS NOT NULL;

-- One current shelf price per item per store.
CREATE TABLE item_prices (
  item_id     INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  store_id    INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  price_pence INTEGER NOT NULL CHECK (price_pence >= 0),
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'scraped')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, store_id)
);

CREATE TABLE lists (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'weekly' CHECK (kind IN ('weekly', 'template')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  budget_pence INTEGER CHECK (budget_pence IS NULL OR budget_pence >= 0),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- price_paid_pence is a snapshot taken when the item is ticked off, so
-- spending history stays correct after shelf prices change.
CREATE TABLE list_items (
  id               INTEGER PRIMARY KEY,
  list_id          INTEGER NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  item_id          INTEGER NOT NULL REFERENCES items (id),
  store_id         INTEGER REFERENCES stores (id) ON DELETE SET NULL,
  quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  checked          INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  price_paid_pence INTEGER CHECK (price_paid_pence IS NULL OR price_paid_pence >= 0),
  added_by         TEXT
);

CREATE INDEX idx_list_items_list ON list_items (list_id);

CREATE TABLE recurring_items (
  id        INTEGER PRIMARY KEY,
  item_id   INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  store_id  INTEGER REFERENCES stores (id) ON DELETE SET NULL,
  quantity  INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('weekly', 'fortnightly', 'monthly'))
);
