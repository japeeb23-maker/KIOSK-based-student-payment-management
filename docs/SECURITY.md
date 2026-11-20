# Security

## Controls in place

- **Authentication:** staff passwords are stored as salted scrypt hashes and compared in constant time. Students sign in with their student number only (no PIN), protected by rate limiting and a five-failure lockout per client/student number; this is weaker than a secret credential, so keep student numbers private and use Registrar **Sign out** to revoke sessions. Failed sign-ins return one generic message.
- **Sessions:** random tokens, hashed at rest, HttpOnly + SameSite=Lax cookie, `Secure` over HTTPS.
- **Rate limiting and lockout:** 15 sign-in attempts per minute per client address; 5 failures then a 15-minute lockout per student (per address) and per staff account. Behind a trusted local proxy (`FBC_TRUST_HTTPS_PROXY`), the client address comes from `X-Forwarded-For`. Non-loopback proxies are not trusted for client IPs, so their users may share a rate limit.
- **CSRF:** state-changing routes require a matching `Origin`.
- **Injection and XSS:** all SQL is parameterized; client rendering escapes dynamic values.
- **Static files:** only the allow-listed files in `public/` are served; databases, `.env`, `private/` and `config/` are not reachable.
- **Payments:** provider webhooks and cash-device events use HMAC with timestamp windows and event de-duplication. Ledger tables are append-only (database triggers).
- **Separation of duties:** `mergeRoleChanges` limits each staff role. The Registrar legacy import cannot import payments and can only add Pending notes and "For review" scholarships.
- **Supabase:** every table has row-level security enabled and `anon`/`authenticated` access revoked (end of `supabase/schema.sql`). The server connects as the table owner through `DATABASE_URL`.
- **Demo gateway:** cannot be enabled when network-exposed or in production.

## Operating checklist

1. Never commit `.env`, `data/`, `private/` or `config/ngrok.yml` (all git-ignored). Check before running `git init`.
2. Store the ngrok authtoken in the user-level ngrok config: `ngrok config add-authtoken <TOKEN>`. Rotate it if it was ever shared.
3. Set `PAYMONGO_WEBHOOK_SECRET` before accepting live payments; without it the webhook fails closed.
4. Replace all demo passwords before network use. Known demo passwords are refused over the network.
5. Re-apply `supabase/schema.sql` on the Supabase project to enable the RLS lockdown, and keep the service/database credentials server-side only.
6. When exposing staff pages through ngrok, add tunnel-level protection (OAuth or IP allow-list) in front of `/index.html` and `/scholastech.html`.
7. Back up `data/` before migrations; protect backups like the live database (they contain student PII and credential hashes).
8. Keep dependencies current (`npm audit`).

## Known gaps and recommendations

- No Content-Security-Policy or HSTS headers yet; add them as defense in depth.
- No multi-factor authentication for staff.
- Lockouts are in memory and reset when the server restarts.
- Render proxy mode exposes the application port within its private network. Use it only where untrusted clients cannot connect directly; TLS and origin protections depend on the trusted proxy.
- A person who repeatedly enters wrong passwords can temporarily lock a staff account.

## Reporting

Report suspected vulnerabilities privately to the project maintainer; do not open public issues containing credentials or student data.
