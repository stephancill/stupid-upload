# Stupid Upload — Operations

Public-facing runbook for the deployed service. No secrets here.

## Production topology

- **Worker**: `stupid-upload` (Cloudflare Workers).
- **Custom domain**: `https://upload.stupidtech.net` (API + site + file serving —
  same origin for now; a dedicated `files.upload.*` isolation host is pending a
  DNS/zone-edit before it can fully resolve).
- **Bindings**: D1 `stupid-upload` (metadata/quota/feedback), R2 bucket
  `stupid-upload` (bodies), hourly cron (`0 * * * *`).
- **Secrets** (wrangler secret, never committed): `STUPID_UPLOAD_HMAC_SECRET`,
  `STUPID_UPLOAD_ADMIN_SECRET`.

## Deploying

```sh
bun install
bun x wrangler d1 migrations apply stupid-upload --remote   # only when D1 schema changes
bun x wrangler deploy
```

Vars live in `wrangler.jsonc`; secrets go to `wrangler secret put`. Periodic
expiry of `temporary/` objects is enforced logically in the Worker cron;
an R2 lifecycle rule on `temporary/` (delete after 1 day) is recommended
defense-in-depth and must be added via the R2 dashboard because it needs
different credentials than the deploy token.

## The paid (permanent) tier

Phase 8 ships permanent **disabled** in production: `POST
/v1/uploads/permanent` returns `501` until Phase 9. Enabling requires:
- `STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED=true`,
- `STUPID_UPLOAD_FACILITATOR_URL` (a mainnet Base facilitator),
- `STUPID_UPLOAD_PAYMENT_NETWORK=eip155:8453`,
- `STUPID_UPLOAD_PAYMENT_ADDRESS` (the recipient).

## Triage / abuse

- `GET /_admin/uploads/:id` with `X-Admin-Secret: $STUPID_UPLOAD_ADMIN_SECRET`
  tombstones an upload. Logs never include secrets/token bodies.
- Feedback is private in D1; review/export via SQL/D1 tooling; there is no
  public read endpoint.

## Observability

Worker `observability` is enabled. `/health` checks process health only.
The scheduled hourly cron runs bounded cleanup and:

- expires temporary rows and deletes their R2 objects,
- retains tombstones for the configured retention,
- purges stale pending reservations.