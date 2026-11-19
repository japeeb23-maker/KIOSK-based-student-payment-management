# Deployment: Vercel front end + VPS backend

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
