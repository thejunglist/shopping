# CSV import format

Seed the catalogue from a spreadsheet. Export it as CSV (UTF-8) with a header row.

| Column | Required | Notes |
| --- | --- | --- |
| `name` | yes | Item name. Matched case-insensitively, so re-importing updates rather than duplicates. |
| `category` | yes | Created if it does not exist. |
| `store` | no | Created if it does not exist. |
| `price` | no | Shelf price in pounds: `1.25` or `£1.25`. Needs a `store`. |
| `unit` | no | For example `2L` or `loaf`. |
| `ean` | no | Barcode, 8 to 14 digits. Used later to match prices across stores. |

One row per item **and store**. To price milk at two shops, give it two rows.

```csv
name,category,store,price,unit,ean
Semi-skimmed milk 2L,Dairy,Aldi,1.45,2L,
Semi-skimmed milk 2L,Dairy,Tesco,1.65,2L,
Wholemeal bread,Bakery,Tesco,1.25,loaf,
Bananas,Produce,Aldi,0.89,,
```

Check a file without saving anything, then import it:

```sh
cd server
node scripts/import-csv.js ../items.csv --dry-run
node scripts/import-csv.js ../items.csv
```

Bad rows are listed with their row number (the header is row 1) and skipped; the rest still import.
The command exits with an error if any row was skipped. Re-running is safe.
`*.csv` is git-ignored, so your real prices stay out of the public repository.
