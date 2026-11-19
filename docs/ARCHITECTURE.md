# Architecture

FBC Paypoint is a dependency-light Node.js application (Node 22.5+, `pg` only) that serves static pages and a JSON API from one process.

## Project layout

| Path | Role |
| --- | --- |
| `src/server/server.js` | HTTP server, routing, sessions, authentication, rate limiting, state merging rules |
| `src/server/database.js` | SQLite (default) and PostgreSQL/Supabase adapter with one `prepare/run/get/all/transaction` interface |
| `src/server/payment-service.js` | Payment creation, provider webhooks, cash-device events, receipts, credit ledger |
| `public/` | Browser assets served as-is: `kiosk.html`, `index.html` (cashier/VP), `scholastech.html` (Registrar/FellowTech), their JS and CSS, and the logo |
| `scripts/` | Operator tools: staff management, migrations, Windows launcher |
| `db/payments.sql` | SQLite payment ledger schema (applied at startup) |
| `supabase/schema.sql` | PostgreSQL schema, including row-level security lockdown |
| `tests/` | `node --test` suites for the payment service, server, and staff navigation |
| `config/` | Local tunnel configuration (`ngrok.yml`, git-ignored) |
| `private/` | Local credential notes (git-ignored) |
| `data/` | SQLite databases and backups (git-ignored) |
| `docs/` | This documentation |

## Request flow

1. The browser loads a page from `public/` through an explicit allow-list in `server.js` (`FILES`). Nothing else on disk is served.
2. The page calls `/api/...` using `public/api.js`. Sessions are random 256-bit tokens in an HttpOnly, SameSite=Lax cookie; only the SHA-256 hash is stored in the `sessions` table.
3. State-changing requests must carry an `Origin` matching the configured origin.
4. Staff write state through `PUT /api/staff/state`, where `mergeRoleChanges` limits each role to its own changes.
5. Payments go through `payment-service.js`, which writes to the immutable ledger tables and updates account state in one transaction.

## Roles

| Role | Can do |
| --- | --- |
| Student | Sign in with student number only, view own account, start payments |
| Cashier | Record and manage payments and receipts |
| VP for Finance | Approve or reject promissory notes and finance items |
| Registrar | Manage admissions, enrollment, kiosk sign-out, scholarships review, legacy import (no payments) |

## Data stores

- **SQLite** (`data/fbc-paypoint.sqlite`) is the default. Set `SQLITE_DATABASE_PATH` to change it.
- **PostgreSQL/Supabase** is used when `DATABASE_URL` is set. Run `npm run migrate:supabase` to move existing data.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT`, `FBC_HOST` | Listen address (default `127.0.0.1:4177`) |
| `SQLITE_DATABASE_PATH`, `DATABASE_URL` | Database selection |
| `FBC_PUBLIC_BASE_URL`, `FBC_TRUST_HTTPS_PROXY` | Required together for ngrok/reverse-proxy mode |
| `FBC_TLS_CERT_PATH`, `FBC_TLS_KEY_PATH` | Direct HTTPS |
| `FBC_ENABLE_DEMO_GATEWAY` | Local-only free demo gateway; blocked when network-exposed or `NODE_ENV=production` |
| `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` | Digital payments and webhook verification |
| `CASH_DEVICE_ID`, `CASH_DEVICE_HMAC_SECRET` | Cash-device event signing |
| `SENDGRID_*`, `TWILIO_*`, `RECEIPT_FROM_EMAIL` | Receipt delivery |

## Common commands

```powershell
npm.cmd ci                 # install
npm.cmd start              # run server
npm.cmd test               # run all tests
npm.cmd run staff:manage   # create/replace staff accounts
npm.cmd run migrate:credits
npm.cmd run migrate:supabase -- --confirm-empty-target
```

See [PAYMENTS.md](PAYMENTS.md) for payment, webhook, and hardware details and [SECURITY.md](SECURITY.md) for the security model.
