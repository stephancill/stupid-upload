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

The permanent tier is **live on Base mainnet** (`eip155:8453`) via the
Coinbase CDP hosted x402 facilitator. An unpaid `POST
/v1/uploads/permanent` returns an exact x402 `402` (`eip155:8453`, Base USDC)
that a payment-capable client resolves and settles.

Wiring (all via `wrangler secret`/vars, never the committed public config):
- `STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED=true`,
- `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (Coinbase Developer Platform credentials),
- `STUPID_UPLOAD_PAYMENT_NETWORK=eip155:8453`,
- `STUPID_UPLOAD_PAYMENT_ADDRESS` (the recipient).

The worker signs a CDP JWT per endpoint (`verify`/`settle`/`supported`) from the
CDP key and drives `HTTPFacilitatorClient.createAuthHeaders` ("src/cdp.ts") —
this avoids importing the full multi-chain CDP SDK into the Worker bundle. The
boolean enablement flag is string-safe (see Change Log).

Turn it off by deleting the `STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED` secret.

## Follow-ups (infra-gated)

- **Dedicated file host** `files.upload.stupidtech.net`: today files serve from
  the same origin (`STUPID_UPLOAD_FILES_HOST == the API host`). Isolating
  untrusted content requires a DNS record/zone edit (point the subdomain at the
  Worker) + a custom-domain route + updating `STUPID_UPLOAD_FILES_HOST`. Needs a
  Cloudflare zone editor.
- **R2 lifecycle rule on `temporary/`**: delete objects after ~1 day as
  defense-in-depth behind the Worker's logical 24h expiry. Configured via the
  R2 dashboard/API (needs R2-bucket editor credentials, not the deploy token).
- **Rate Limiting binding** (optional): `LIMITER` is wired in `wrangler.jsonc`
  as an optional binding and the feedback route smooths against it; attach a
  real rate-limit rule when you want burst control above the in-process limiter.

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