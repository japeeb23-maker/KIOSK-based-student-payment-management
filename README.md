# FBC Paypoint

FBC Paypoint provides a student payment kiosk, staff finance tools, a Registrar dashboard, and the FellowTech school-management overview. These interfaces share the backend and student records.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): project layout, request flow, roles, configuration, and commands.
- [Payments](docs/PAYMENTS.md): payment ledger, providers, hardware, migration, and deployment.
- [Deployment](docs/DEPLOYMENT.md): hosting the front end on Vercel with the backend on a VPS.
- [Security](docs/SECURITY.md): security controls, operating checklist, and known gaps.

## Requirements

- Node.js 22.5 or later, with built-in SQLite support.
- npm, included with Node.js.
- A modern browser.

## Start locally

Open PowerShell in this project folder and install dependencies:

```powershell
npm.cmd ci
```

Start the application using the Windows launcher:

```powershell
.\scripts\start-fbc-paypoint.bat
```

The launcher opens the student kiosk at [http://127.0.0.1:4177/](http://127.0.0.1:4177/). Alternatively, run `npm.cmd start` and open that URL manually. Keep the server running while using the application. Check [http://127.0.0.1:4177/health](http://127.0.0.1:4177/health) if it does not open.

By default, the server listens only on this computer and stores data in `data\fbc-paypoint.sqlite`. The database is initialized on first startup. Do not open the HTML files directly from File Explorer.

## Configuration (`.env`)

The server loads `.env` from the project root at startup. Copy the template and fill it in:

```powershell
Copy-Item .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `N8N_HEADER_NAME` | Name of the auth header the n8n webhook expects (for example `X-Api-Key`) |
| `N8N_HEADER_VALUE` | Secret value for that header |
| `KIOSK_ID` | This kiosk's identifier, added to every forwarded request |

`.env` is git-ignored. Restart the server after changing it.

## Payment request relay (`POST /api/pay`)

The kiosk frontend calls `POST /api/pay` with a JSON object body. The server adds `kioskId` (from `KIOSK_ID`, overriding any client-supplied value), attaches the `N8N_HEADER_NAME`/`N8N_HEADER_VALUE` header, and forwards it to `https://japheth30.app.n8n.cloud/webhook/fbc-kiosk-payment-request`. The n8n status code and body are returned unchanged. The header name and value never reach the browser.

- A student must be signed in (session cookie), and the request must come from the app's own origin.
- Missing configuration returns 503; an unreachable n8n returns 502.

```javascript
const response = await fetch("/api/pay", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ amount: 100 })
});
```

## Portals

The kiosk's menu links to each staff area:

| Area | Local address |
| --- | --- |
| Student kiosk | [Student sign-in](http://127.0.0.1:4177/) |
| Registrar | [Registrar dashboard](http://127.0.0.1:4177/scholastech.html?portal=registrar) |
| FellowTech | [School-management overview](http://127.0.0.1:4177/scholastech.html) |
| Cashier | [Cashier sign-in](http://127.0.0.1:4177/index.html?staffRole=cashier) |
| VP for Finance | [VP sign-in](http://127.0.0.1:4177/index.html?staffRole=vp) |

Staff areas require an authorized account. If a different role is already signed in, a role-specific link prompts for the appropriate account.

## Accounts

The application does not create default staff credentials. Start the server once to initialize the database before provisioning accounts. Use the same database configuration for the server and management commands.

Staff accounts for the cashier, VP for Finance, and Registrar roles are stored in the application database as salted password hashes. They remain available across application code changes and restarts as long as the same database is retained; replacing or deleting the database will remove them. Back up the database before migrations or resets. The local-only [staff credentials README](private/STAFF_CREDENTIALS.md) contains the provisioned sign-in details and is ignored by Git.

To create a registrar account in PowerShell, replace the example ID and label:

```powershell
$env:FBC_STAFF_USERNAME = "REGISTRAR1"
$env:FBC_STAFF_ROLE = "registrar" # registrar, cashier, or vp
$env:FBC_STAFF_LABEL = "Registrar"
$env:FBC_STAFF_PASSWORD = [System.Net.NetworkCredential]::new("", (Read-Host "Staff password" -AsSecureString)).Password
npm.cmd run staff:manage
Remove-Item Env:FBC_STAFF_PASSWORD
```

Usernames are 3-64 letters, numbers, underscores, or hyphens; passwords must be at least 12 characters. To replace an existing account and revoke its sessions, use `npm.cmd run staff:manage -- --replace`.

Students sign in at the kiosk with their student number only, using the on-screen keypad or a keyboard. Registrars can sign a student out of kiosk sessions from Student records. Do not commit credentials, database connection strings, or ngrok tokens.

The local-only `private/Student_Credentials.md` lists student numbers and is ignored by Git. Keep it private.

## Remote access with ngrok

An ngrok HTTPS tunnel exposes the application to the internet; restrict access to authorized users. Keep the server bound to loopback and use a trusted tunnel. Install and configure ngrok separately, keeping its authtoken private. If using the project's `config/ngrok.yml`, it is ignored by Git.

1. Start the tunnel in one terminal:

   ```powershell
   ngrok http 4177 --config .\config\ngrok.yml
   ```

2. In another PowerShell window, use the exact HTTPS origin shown by ngrok and start the server:

   ```powershell
   $env:FBC_PUBLIC_BASE_URL = "https://<your-ngrok-host>"
   $env:FBC_TRUST_HTTPS_PROXY = "true"
   .\scripts\start-fbc-paypoint.bat
   ```

   Restart an already-running server with these settings; otherwise remote sign-in will fail with `Request origin is not allowed`. Set them again in each new server-starting terminal, and update the origin if ngrok changes it.

Remote mode disables demo payments and known demo passwords. Rate limits use the client address forwarded by the tunnel. See [PAYMENTS.md](PAYMENTS.md#student-sign-in-and-network-access) for network security and TLS details.

## Tests and payment setup

Run the backend and navigation tests with:

```powershell
npm.cmd test
```


### Local payment demo

The local demo at `http://127.0.0.1:4190/` uses `data\fbc-paypoint-demo.sqlite`, a separate snapshot of the local database. Choose **Free demo gateway** when paying. Payments change only the demo copy and do not transfer money. The copied records reflect the time of the snapshot; subsequent live changes are not synced.

To restart the existing demo from PowerShell:

```powershell
Remove-Item Env:DATABASE_URL, Env:FBC_PUBLIC_BASE_URL, Env:FBC_TRUST_HTTPS_PROXY, Env:FBC_TLS_CERT_PATH, Env:FBC_TLS_KEY_PATH, Env:PAYMONGO_SECRET_KEY, Env:PAYMONGO_WEBHOOK_SECRET, Env:PAYMONGO_API_BASE, Env:CASH_DEVICE_ID, Env:CASH_DEVICE_HMAC_SECRET, Env:SENDGRID_API_KEY, Env:RECEIPT_FROM_EMAIL, Env:TWILIO_ACCOUNT_SID, Env:TWILIO_AUTH_TOKEN, Env:TWILIO_FROM_NUMBER -ErrorAction SilentlyContinue
$env:FBC_HOST = "127.0.0.1"
$env:PORT = "4190"
$env:NODE_ENV = "development"
$env:SQLITE_DATABASE_PATH = (Join-Path (Get-Location) "data\fbc-paypoint-demo.sqlite")
$env:FBC_ENABLE_DEMO_GATEWAY = "true"
npm.cmd start
```

Keep the demo on loopback; it must not be exposed through ngrok. Its database is ignored by Git but contains private student records and must be protected like the original. This command assumes the demo database already exists. Browsers share cookies across ports on the same host, so use a separate browser profile for the demo to avoid replacing a live local session.
