# Shopping

A phone-first weekly shopping list for two people. It keeps a catalogue of items with a price per store, sorts the list by category, tracks a running total against a weekly budget, and records what you spent. It runs on a home server (Proxmox LXC) and is reachable only over [Tailscale](https://tailscale.com).

> **Status: Phase 1.** The catalogue, per-store prices, weekly list with running total and weekly budget, and CSV import all work. Spending history, recurring suggestions and saved lists are next.

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
- **Manage:** your shops and categories. Their order sets the order of the list, so arrange categories like the aisles you walk.

To load your starting catalogue from a spreadsheet, see [docs/import-format.md](docs/import-format.md).

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
