# Shopping

A phone-first weekly shopping list for two people. It keeps a catalogue of items with a price per store, sorts the list by category, tracks a running total against a weekly budget, and records what you spent. It runs on a home server (Proxmox LXC) and is reachable only over [Tailscale](https://tailscale.com).

> **Status: Phase 1, plus barcode scanning.** The catalogue, per-store prices, weekly list with running total and weekly budget, CSV import and a camera barcode scanner all work. Spending history, recurring suggestions and saved lists are next.

## Stack

| Part | Choice |
| --- | --- |
| Frontend | Vue 3 + Vite |
| Backend | Node 22, Fastify |
| Database | SQLite via `better-sqlite3` (WAL mode, prices in integer pence) |
| Hosting | Debian LXC on Proxmox, `systemd`, `tailscale serve` for HTTPS |
| CI/CD | GitHub Actions: tests on GitHub-hosted runners, deploy from a self-hosted runner |

## Layout

```
server/       Fastify API, SQL migrations, CSV import, tests
web/          Vue frontend (list, items, manage screens)
deploy/       Bundle, deploy and backup scripts; systemd units; sudoers rule
docs/         Deployment guide, CSV import format
.github/      Pipeline and Dependabot config
```

## Development

Requires Node 22 (`nvm use` reads `.nvmrc`).

```sh
npm run install:all     # root, server and web dependencies

npm run dev:server      # API on http://127.0.0.1:3000 (SQLite file in server/data/)
npm run dev:web         # frontend on http://localhost:5173, proxying /api to the server

npm run check           # lint + tests + build, the same as CI
```

Migrations in `server/migrations/*.sql` are applied in filename order when the server starts. They are forward-only.

The server reads who is using the app from the `Tailscale-User-Login` header, which `tailscale serve` adds. In development there is no such header, so the page shows "unknown". To try it, send the header yourself:

```sh
curl -H 'Tailscale-User-Login: me@example.com' http://127.0.0.1:3000/api/me
```

That is also why the server listens on `127.0.0.1` only: if it were reachable directly, anyone could set the header.

## Using it

- **List:** search to add items (each goes to its cheapest or usual store), tick them off as you shop, and watch the total against your weekly budget. Pick a different store on a row if an item is priced at several. "Finish this shop" files the week and starts a new list with the same budget. Ticking records the price at that moment, so history stays right when prices change.
- **Items:** your catalogue, with a price per shop.
- **Scan:** the Scan button on the List screen opens the camera. Choose the shop you are in at the top, then point at a barcode. An item you already have is ticked at that shop's price; if it has no price there yet, you are asked for the shelf price once. A new barcode is looked up for a name, size and a category guess (you check it before saving). A barcode can also be typed in.
- **Manage:** your shops and categories. Their order sets the order of the list, so arrange categories like the aisles you walk.

To load your starting catalogue from a spreadsheet, see [docs/import-format.md](docs/import-format.md).

## Scanning

The scanner reads EAN-13, EAN-8 and UPC-A barcodes, which covers UK groceries. Chrome on Android has a built-in reader; iPhone Safari does not, so the app bundles a small WebAssembly reader (ZXing) and serves it itself, with nothing loaded from a public CDN. The check digit is verified, so a misread cannot tick the wrong item.

- **Needs HTTPS.** Browsers only allow the camera on a secure address, so open the app through your `https://shopping.<tailnet>.ts.net` address. Over plain `http://` or an IP address the scanner explains this and offers typed entry.
- **Names come from [Open Food Facts](https://world.openfoodfacts.org/).** Only the barcode number is sent, only for barcodes you have not saved yet, and the server makes the request (your phone never contacts them). The answer is cached for a day. If they cannot be reached you type the name instead. Their documented limit is 15 product lookups per minute per IP address, far more than scanning by hand reaches. Product data is under the Open Database Licence.
- **Prices are always typed by you.** A barcode identifies a product but never carries its price.
- **Optional settings** (environment variables for the service). Set a contact so Open Food Facts can reach you if your app misbehaves; by default none is sent. On the server:

  ```sh
  sudo systemctl edit shopping
  # add these two lines in the editor, then save:
  #   [Service]
  #   Environment=OFF_CONTACT=you@example.com
  sudo systemctl restart shopping
  ```

  The override lives in its own file, so deploys and `setup.sh` do not remove it. `OFF_PRODUCT_URL` changes the lookup address (it must contain `{ean}`): their documentation lists API v2, which the app uses by default, as deprecated in favour of v3, and the app reads either response format. If lookups ever stop working, try `https://world.openfoodfacts.org/api/v3/product/{ean}`.
- **Updating the reader:** `barcode-detector` and `zxing-wasm` in `web/package.json` must be the same generation (the WebAssembly file has to match the code that loads it). Dependabot is set to update them together in one pull request.

## API

JSON under `/api`: `categories`, `stores`, `items` (with `PUT /items/:id/prices/:storeId`), and `lists` (`GET /lists/current`, then `/lists/:id/items`, `/lists/:id/complete`). Prices are integer pence. Errors are `{ "error": "message" }` with a 400 (invalid), 404 (missing) or 409 (conflict, or still in use) status. Tests in `server/test/` show every call.

## Deployment

Pushing to `main` runs the tests and then deploys to the home server, with a pre-deploy database backup, a health check, and automatic rollback if the new release does not come up. Setup is in [docs/deployment.md](docs/deployment.md).

## Roadmap

1. **Phase 0:** repo, pipeline, first deploy (done)
2. **Phase 1:** catalogue, per-store prices, weekly list with running total (done)
3. **Phase 2:** weekly budget and spending history
4. **Phase 3:** recurring-item suggestions and saved lists
5. **Phase 4:** installable PWA, polish
