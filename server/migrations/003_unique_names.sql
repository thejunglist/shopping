-- Item names are unique regardless of case (the CSV import and the list search
-- both match on name), and an item appears once per list: adding it again
-- bumps the quantity.

CREATE UNIQUE INDEX idx_items_name ON items (name COLLATE NOCASE);
CREATE UNIQUE INDEX idx_list_items_unique ON list_items (list_id, item_id);
