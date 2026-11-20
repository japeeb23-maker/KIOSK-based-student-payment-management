# Deployment

## Render: whole application

Render hosts both the static pages and Node API as one web service. Use a Supabase PostgreSQL database for persistent records; production refuses the local SQLite database. To transfer an existing SQLite database, back it up and follow the migration instructions in [PAYMENTS.md](PAYMENTS.md) before the first Render start. The migration requires an empty target and does not merge records.

1. Connect the repository to Render and create a Node web service from the project root.
2. Set the build command to `npm ci` and the start command to `npm start`. Use Node 22.5 or later; set `NODE_VERSION` to `22` if necessary. Set the health check path to `/health`.
3. Add these environment variables in Render, using the service's actual HTTPS origin with no trailing path:

        ```text
        NODE_ENV=production
        FBC_HOST=0.0.0.0
        FBC_TRUST_HTTPS_PROXY=true
        FBC_ALLOW_NETWORK_PROXY=true
        FBC_PUBLIC_BASE_URL=https://your-service.onrender.com
        DATABASE_URL=<Supabase PostgreSQL connection string>
        ```

        Render supplies `PORT`. Enter `DATABASE_URL` and any payment secrets in Render's environment settings, not in Git or a browser. Configure PayMongo and webhook secrets before accepting real payments; see [PAYMENTS.md](PAYMENTS.md).
4. Deploy and check `https://your-service.onrender.com/health` and `https://your-service.onrender.com/api/kiosk/config`. Both should return 200. Open the Render URL for the kiosk and verify sign-in and sign-out.

`FBC_ALLOW_NETWORK_PROXY` permits HTTP on the container network only for a trusted HTTPS-terminating proxy. Do not use it when the application port is directly reachable from untrusted networks. It does not trust forwarded client IPs from non-loopback connections, so rate limits may be shared by all users behind Render's proxy. Student-number-only sign-in is weak; review [SECURITY.md](SECURITY.md) and restrict access before exposing real student records. A new database starts empty and has no staff accounts; provision them as described in the README.

## Vercel front end + VPS backend

Vercel serves only the static files in `public/`. The Node server (`src/server/server.js`) must run on a VPS, with Caddy providing HTTPS. This matches the server's rule that it binds to loopback only and trusts an HTTPS proxy.

```text
Browser -> https://paypointkiosk.vercel.app
        -> /api/* rewrite -> https://api.example.edu.ph (Caddy) -> 127.0.0.1:4177 (Node)
```

## 1. VPS

1. Install Node.js 22.5 or later and Caddy. Create a `fbc` user and copy the project to `/opt/fbc-paypoint`, then run `npm ci --omit=dev`.
2. Point a DNS record for your API hostname (for example `api.example.edu.ph`) at the VPS.
3. Create `/etc/fbc-paypoint.env` (mode 600, owned by root):

   ```ini
   FBC_HOST=127.0.0.1
   PORT=4177
   NODE_ENV=production
   FBC_PUBLIC_BASE_URL=https://paypointkiosk.vercel.app
   FBC_TRUST_HTTPS_PROXY=true
   N8N_HEADER_NAME=...
   N8N_HEADER_VALUE=...
   KIOSK_ID=...
   ```

   `FBC_PUBLIC_BASE_URL` is the origin the browser sees (the Vercel domain), not the VPS hostname; the server uses it for its origin check. Add the PayMongo and `DATABASE_URL` values from [PAYMENTS.md](PAYMENTS.md) as needed. Do not use the demo gateway.
4. Install [deploy/fbc-paypoint.service](../deploy/fbc-paypoint.service) into `/etc/systemd/system/`, then `systemctl enable --now fbc-paypoint`.
5. Put your hostname in [deploy/Caddyfile](../deploy/Caddyfile), install it as `/etc/caddy/Caddyfile`, and `systemctl reload caddy`. Check `https://<api-host>/health`.
6. Provision staff accounts with `npm run staff:manage` (see the README) and back up `data/`.

## 2. Vercel

Copy [deploy/vercel.json.example](../deploy/vercel.json.example) to `vercel.json` in the project root, replace the destination host with your API hostname, commit, and redeploy. Then open `https://paypointkiosk.vercel.app/kiosk.html`; `/api/kiosk/config` should return 200.

## Notes

- Rate limits use the client address forwarded by the proxy; behind Vercel and Caddy this may be a Vercel address. Review [SECURITY.md](SECURITY.md) before relying on per-client limits.
- Staff pages are public static files on Vercel; the API still requires a session, but add the access protection in the SECURITY checklist.
- Verify that sign-in cookies are set through the rewrite before going live.
