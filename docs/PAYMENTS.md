# Payment integration

The kiosk's payment API is backend-authoritative. The browser may start a transaction and read its status, but it cannot write `PAID`. Existing student payment writes through `POST /api/student/payments` return `410 Gone`.

For local demos only, `FBC_ENABLE_DEMO_GATEWAY=true` enables a simulated `FREE_GATEWAY` payment method. It marks a demo transaction paid immediately and creates a demo receipt; it does not collect or transfer real money. The server rejects it in production or when bound to the network. Live digital payments still require a configured provider.

## Database and state

`db/payments.sql` creates the transaction, immutable cash-event and receipt ledgers, provider webhook inbox, credit ledger, idempotent OR sequence, and durable digital-receipt outbox. The payment settlement transaction updates both these tables and the existing Paypoint account state atomically.

The state path is:

- Digital: `INITIALIZING` → `PENDING` → `PAID`; only a valid PayMongo `payment.paid` event can settle it.
- Cash: `CASH_ACCEPTING` → `PAID`, or `CHANGE_PENDING` → `PAID`; only HMAC-authenticated cash-device events can record bills or change results. The acceptor may take a bill larger than the remainder; dispense change or credit any shortage.
- Cancelled, timed-out, and insufficient-change cash is itemized in the student credit ledger. Unsupported/late bills are credited, not discarded.
- If another payment reduces the balance before a confirmed payment settles, the remaining balance is paid and the excess is recorded as student credit. Credits are recorded in the ledger; automatic application to future assessments is not implemented.

`GET /api/student/transactions/:transactionId` is scoped to the signed-in student. It returns receipt data and an ESC/POS payload (base64) only after the backend has committed `PAID`.

## Configuration

Set secrets through the process environment or a secret manager; do not commit them:

| Variable | Purpose |
| --- | --- |
| `PAYMONGO_SECRET_KEY` | Server-side PayMongo API authentication. |
| `PAYMONGO_WEBHOOK_SECRET` | Verify PayMongo's `Paymongo-Signature` header. |
| `FBC_PUBLIC_BASE_URL` | Public HTTPS base URL used as the wallet return URL. |
| `FBC_HOST`, `PORT` | Bind address and port; defaults to `127.0.0.1` and `4177`. |
| `FBC_TLS_CERT_PATH`, `FBC_TLS_KEY_PATH` | Certificate chain and private-key file paths required for network access. |
| `FBC_TRUST_HTTPS_PROXY` | Set to `true` only behind a trusted HTTPS proxy; requires `FBC_PUBLIC_BASE_URL`. |
| `FBC_ALLOW_NETWORK_PROXY` | Explicitly allow a production `0.0.0.0` HTTP binding behind a trusted HTTPS proxy, such as Render. See [DEPLOYMENT.md](DEPLOYMENT.md). |
| `CASH_DEVICE_ID` | The single configured bill-acceptor identity. |
| `CASH_DEVICE_HMAC_SECRET` | Authenticate bill-acceptor events and acceptance queries. |
| `SENDGRID_API_KEY`, `RECEIPT_FROM_EMAIL` | Optional SendGrid email receipt delivery. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Optional SMS receipt delivery for students with a phone number. |

Expose `/api/webhooks/paymongo` to PayMongo through HTTPS. Configure the webhook secret in both PayMongo and the server. PayMongo signature timestamps have a five-minute acceptance window. The handler verifies HMAC-SHA256 over `timestamp + "." + exact raw request body`, compares signatures in constant time, checks the event ID for replay, and validates PHP amount/currency before settlement.

Cash hardware sends JSON to `/api/hardware/cash/events` with headers `X-Cash-Device-Id`, `X-Cash-Timestamp` (Unix seconds), and `X-Cash-Signature` (`sha256=<hex>`). The signature is HMAC-SHA256 over `timestamp + "." + deviceId + "." + exact raw request body`. Event types are `CASH_INSERTED`, `CASH_CANCELLED`, `CHANGE_DISPENSED`, and `INSUFFICIENT_CHANGE`; every event includes a unique `eventId` and `transactionId`. Monetary event values are integer PHP centavos in `amountMinor`. The acceptor checks `/api/hardware/cash/acceptance` using the same signed-request format before enabling bills.

## Student sign-in and network access

Students sign in with their roster student number only (touchscreen keypad or keyboard); there is no PIN. The server resolves the student number to the internal student ID and binds the session to that ID. Failures return one generic message. Sign-in is rate limited per client address (15 attempts per minute) and per client-address/student-number pair (five failures, then a 15-minute lockout). Because a student number is the only credential, treat it as semi-secret and see [SECURITY.md](SECURITY.md).

The server binds to loopback by default. To serve other devices, configure `FBC_HOST`, `PORT`, `FBC_PUBLIC_BASE_URL`, `FBC_TLS_CERT_PATH`, and `FBC_TLS_KEY_PATH` in the server process environment. The base URL must be an HTTPS origin matching the URL students use. Each device must resolve that hostname and trust its certificate; The private key remains on the server. The server deliberately refuses non-loopback HTTP; simply opening a LAN IP over HTTP is not supported.

For an HTTPS tunnel such as ngrok, keep the server bound to loopback and start it with `FBC_TRUST_HTTPS_PROXY=true` and `FBC_PUBLIC_BASE_URL` set to the exact public HTTPS origin. The proxy must terminate HTTPS and forward only to the loopback server. Public sessions use Secure cookies; local HTTP access remains available. Demo payments and known demo passwords are disabled in this mode. Rate limits see the proxy as one client, so users share the same per-address limits. Keep the tunnel private or restrict access to authorized users: it exposes the application to the internet.

For example, start the local server from PowerShell with the tunnel's current origin:

```powershell
$env:FBC_PUBLIC_BASE_URL = "https://<your-ngrok-host>"
$env:FBC_TRUST_HTTPS_PROXY = "true"
.\start-fbc-paypoint.bat
```

Set these variables again when starting the launcher from a new PowerShell window; update the URL if the tunnel's origin changes.

Staff state writes use a revision check. If another device changes the same records, saving returns a conflict and reloads the latest state instead of overwriting it. Use the Refresh button to see other devices' changes. Manual cashier entries are payment records, not official receipts.

## Staff accounts

The server preserves existing staff accounts and does not create default credentials. Before network use, replace any known demo passwords. To create a staff account, initialize the database, then set `FBC_STAFF_USERNAME`, `FBC_STAFF_ROLE` (`cashier`, `vp`, or `registrar`), `FBC_STAFF_LABEL`, and `FBC_STAFF_PASSWORD` (at least 12 characters) in a private process environment and run `npm.cmd run staff:manage`. For an existing username, pass `-- --replace`; this also revokes its active staff sessions. Clear the password environment variable afterward. Do not put credentials in source files or command arguments. Known demo passwords are rejected when the server is bound to the network.

The kiosk menu links separately to the Registrar dashboard and FellowTech. The Registrar dashboard requires a registrar account; FellowTech provides the shared school-management overview. Both use the same backend records and staff session.

## Student sign-in

Students sign in with the student number only. A Registrar can sign a student out of every active kiosk session from the Student records page (**Sign out**). New enrollments receive an 8-digit numeric student number (2-digit year plus 6 random digits). The legacy `student_credentials` table is no longer used. Google sign-in has been removed and `GOOGLE_CLIENT_ID` is no longer used.

## Existing credit ledger migration

Before deploying this payment-service version against an existing database, stop all application instances and take a verified database backup. The old ledger permits only one credit of each type per transaction; the migration removes that restriction while retaining existing credits and SQLite ledger triggers and indexes.

With the same `DATABASE_URL` (or `SQLITE_DATABASE_PATH`) used by the application, run:

```powershell
npm.cmd run migrate:credits -- --confirm-migration
```

Without either variable the command targets `data\fbc-paypoint.sqlite`. Run it against each database that will use the updated service. It is safe to rerun after success. Do not start the updated service against an unmigrated ledger.

## Client flow

1. A signed-in student starts `/api/student/transactions` with `assessmentId`, decimal PHP `amount`, `method` (`QRPH`, `GCASH`, or `MAYA`), and a unique `Idempotency-Key`; cash uses `/api/student/cash-transactions`.
2. The backend snapshots the fee lines, creates the provider intent using provider-side idempotency, and returns QR/redirect instructions. It never treats a browser redirect as a payment confirmation.
3. The kiosk polls the scoped transaction-status endpoint. `usePaymentStatus` is the TypeScript polling hook for same-origin kiosk deployments.
4. On committed `PAID`, the kiosk displays the official OR and offers browser printing. The status API also returns ESC/POS bytes for an integrated printer; the browser does not send those bytes directly to hardware. Digital delivery jobs are queued durably and retried independently of the kiosk response.

## Supabase migration and server startup

The backend uses SQLite for local development and Supabase PostgreSQL when `DATABASE_URL` is set. In production, the server refuses to start without `DATABASE_URL`. The connection string is server-only; never add it to frontend code, commit it, or send it in chat.

1. Back up the SQLite database and stop the backend before migrating. Do not copy only `fbc-paypoint.sqlite` while the server is running; SQLite may have committed data in its `-wal` file.
2. In a PowerShell window opened at the project folder, set the Supabase connection string in that window (replace the example with the URI from Supabase **Connect**):

   ```powershell
   $env:DATABASE_URL = 'postgresql://...'
   ```

   Optionally set a non-default source database path:

   ```powershell
   $env:SQLITE_DATABASE_PATH = 'C:\path\to\fbc-paypoint.sqlite'
   ```

3. Run the one-time import. It reads a consistent, WAL-aware SQLite snapshot and refuses to import if the Supabase application tables contain data other than the unused default payment-sequence row. It does not overwrite existing records.

   ```powershell
   npm.cmd run migrate:supabase -- --confirm-empty-target
   ```

   Review the table row counts printed after success. If it reports a non-empty target, stop; do not clear tables to force the import.
4. Start the server from the same PowerShell window so it inherits `DATABASE_URL`:

   ```powershell
   npm.cmd start
   ```

   Schema creation is automatic for empty databases. No demo staff or student records are seeded; import existing data first or create staff accounts using the instructions above.

These commands set the secret only for the current PowerShell process and its child processes. Do not place credentials in `package.json`, source files, or a committed `.env` file. A local server without `DATABASE_URL` continues to use `data\fbc-paypoint.sqlite`.

Before enabling live payments, configure Supabase backups and access policies, deploy behind TLS, configure the hardware and payment-provider credentials, and complete PayMongo test-mode, webhook replay, cash acceptor, printer, and delivery-provider tests. A local demo server with no provider credentials intentionally rejects digital checkout rather than simulating success.
