# Implementation Notes

This document records public-safe implementation decisions and material
changes. Do not include credentials, personal information, private
infrastructure details, or raw user data.

## Status

Delivered phases 1–4, partial 6, and deployment of 8 of [handover.md](./handover.md):
a Bun/TypeScript/Hono Worker running with pricing, temporary reservation/upload/
download/HEAD/range, deletion, feedback, quotas, security headers, cleanup
scheduler, discovery endpoints, dynamic x402 pricing, and a self-contained CLI
+ skill (txlink fallback + real x402 client signing), with a Vitest suite.
Deployed to production behind `https://upload.stupidtech.net` (D1 + R2
provisioned, migrations applied, secrets set). Phases 5, 7, 9–10 (OpenAPI/API
validation, skill packaging, the mainnet paid tier, and its verification) are
deferred.

## Decisions

- **Build for Cloudflare Workers** using Hono, R2 (bodies) and D1 (metadata,
  quota, feedback), with Zod validation everywhere and strict TypeScript.
- **Free temporary uploads** expire exactly 24 h after a successful upload;
  logical expiry (D1 status) is authoritative, R2 lifecycle is defense-in-depth.
- **x402 with Base USDC** for no-scheduled-expiry uploads, now integrated (Phase 4):
  `src/payment.ts` uses the current official packages (`@x402/hono`,
  `@x402/core`, `@x402/evm`) with `HTTPFacilitatorClient` and `ExactEvmScheme`
  on the configured Base network. The permanent route price is **dynamic**: the
  Hono adapter's `getBody()` reads the request `sizeBytes` (Hono caches the raw
  body, so the handler re-reads it) to mint an exact USDC `402`. Settlement is
  done by the facilitator. Because the packages lean on Node globals
  (`Buffer`, ...), `nodejs_compat` is enabled in `wrangler.jsonc`.
- **Idempotent recovery defend-pay**: a request whose idempotency key already
  has a permanent reservation is short-circuited before the payment middleware
  runs, so a retried settlement is not charged twice.
- **Deterministic tokens.** Upload/delete bearer tokens are derived from the
  reservation id + server HMAC secret via `crypto.subtle` (async HMAC-SHA-256
  then a stored SHA-256 snapshot). Stored token hashes are compared in
  constant time; raw tokens are never persisted or logged.
- **Quotas fail closed.** Reservation and feedback limits use atomic guarded
  UPSERT/RETURNING against D1 `daily_usage`; no race window between read and
  write. Feedback additionally uses an in-process per-minute burst limiter
  (a Cloudflare Rate Limiting binding can be layered on).
- **Polyglot body handling.** The upload byte path accepts
  `application/octet-stream` at the wire layer and records the declared file
  content type; it requires exact `Content-Length` and rejects chunked.
- **Stable error envelope** `{ error: { code, message } }` with machine codes
  (`not_found`, `gone`, `quota_exceeded`, `conflict`, ...).
- **Active content is served as attachments** and responses get
  `X-Content-Type-Options`, restrictive CSP, and safe `Content-Disposition`.
- **Temporary (POST) routes require a high-entropy `Idempotency-Key`**; a
  repeat returns the existing reservation without consuming quota again.
- Handlers live in `src/app.ts` rather than a `routes/` tree because the
  handlers share small helpers; revisit the split in a later phase if it grows.
- **Test strategy differs from the handover** for now: rather than the
  Cloudflare Vitest pool (whose API was incompatible at the pinned versions),
  tests run against a purpose-built in-memory D1/R2 double
  (`test/helpers/fake.ts`) that mirrors exactly the SQL we issue. The x402
  unpaid `402` challenge is tested against a stubbed facilitator `/supported`;
  a funded paid-to-settlement End-to-End is deferred to phases 6/9.
- **CLI with real x402 + a txlink fallback (Phase 6, partial).** The
  self-contained `skills/stupid-upload` ships a Bun CLI plus client-side
  payment modules (`scripts/txlink.ts`, `scripts/pay.ts`). With
  `STUPID_UPLOAD_PRIVATE_KEY`, `upload`
  --permanent` signs and pays locally via `@x402/evm` + `@x402/fetch`
  `wrapFetchWithPayment` (`skills/stupid-upload/scripts/pay.ts`). Without a
  key, the CLI posts the x402 payment to txlink's stored request API and
  returns `signatureRequest.url` + `statusUrl`, so a no-key agent can hand the
  approval to a human and poll for it. The skill was validated and packaged to
  `dist/stupid-upload.skill` (git-ignored) with the skill-creator tooling.
  Live settlement of a signed path still needs a funded Base Sepolia account
  + a reachable facilitator (verification pending).

## Change Log

### 2026-09-01

- Phase 4: wired the x402 permanent payment middleware (`src/payment.ts`) into
  `POST /v1/uploads/permanent`, with dynamic per-size Base USDC pricing,
  idempotent settlement short-circuit, and price/network persisted on the
  reservation. Added `test/payment.test.ts`. Final suite: 44 tests.
- Phase 6 (partial): added the self-contained `skills/stupid-upload` CLI +
  txlink connector with `upload --permanent` txlink signature-request
  fallback, and then wired the real signed path via `@x402/fetch`
  `wrapFetchWithPayment` (`scripts/pay.ts`). CLI tests (stubbed facilitator +
  txlink) and the x402-fetcher build test bring the suite to 47 tests across 8
  files.
- Phase 6 (verify): confirmed knox ↔ server integration by running the paid
  route against a local instance behind a mini facilitator and `knox --dry-run
  --protocol x402` — knox parsed the server's exact dynamic `402` into the
  correct `{ chainId, asset, amount, payTo, method }` intent with no funds
  spent.
- Phase 6 (live, real settlement): ran the full paid flow over **Base Sepolia**
  via knox + the live `https://x402.org/facilitator`. Two live `exact`
  payments (`knox tx list` → `success`) paid **10000 USDC (atomic, ~$0.01)**
  to `payTo`; the server settled the permanent reservation
  (`expiresAt: null`, `priceAtomic: 10000`, `paymentNetwork: eip155:84532`),
  the 11-byte file uploaded (`PUT 201`) and downloaded back as `hello world`
  from the public URL. Confirms the whole stack (dynamic 402, knox payer,
  facilitator verify+settle, reservation, streaming upload, retrieval).
- Server change surfaced by the live run: the paid route no longer hard-
  requires a caller `Idempotency-Key` (generic x402 clients don't send one); a
  synthesized per-request key keeps `(source, key)` unique. The temporary route
  still requires it.
- Phase 8 (production deploy): provisioned D1 (`stupid-upload`, WEUR) and R2
  (`stupid-upload`), applied the migration remotely, set the two secrets, and
  deployed the worker behind the custom domain `https://upload.stupidtech.net`
  (workers.dev + custom domain both live). Verified end-to-end on prod:
  temp reservation → `PUT` bytes → public download with `nosniff`.
- Permanent (paid) tier is **disabled in prod** (returns `501`) until Phase 9
  (Base mainnet + a reachable mainnet facilitator + recipient address). A
  dedicated `files.upload.*` isolation host and the R2 `temporary/`
  lifecycle rule are noted as follow-ups (both need either zone/ R2
  credentials beyond the deploy token). See `docs/operations.md`.

- Initialized the implementation notes.
- Scaffolded the Bun/TypeScript/Hono worker, `wrangler.jsonc` bindings (R2,
  D1, Rate Limiting placeholder, hourly cron), strict `tsconfig`, formatting/
  linting/typecheck/test scripts, `.env.example`, `.gitignore`, `AGENTS.md`,
  and `README.md`.
- Added the D1 migration (`migrations/0001_initial.sql`) with `uploads`,
  `daily_usage`, and `feedback` tables.
- Implemented pricing, ids/token derivation, metadata validation, quotas, and
  the security header/content-type helpers (`pricing.ts`, `crypto.ts`,
  `tokens.ts`, `schemas.ts`, `quota.ts`, `security.ts`) with unit tests.
- Implemented temporary reservation, streaming authenticated upload with
  SHA-256 enforcement, status, download/HEAD/range, verify+cache headers,
  deletion, feedback collection, and the scheduled cleanup cron (Phase 3).
- Added a landing page, `/docs`, `/openapi.json`, `/llms.txt`, and
  `/.well-known/x402` discovery routes (validation added in a later phase).
- Finalized 40 passing tests across pricing, uploads, files, feedback,
  quotas, and discovery; oxfmt, oxlint, and `tsc --noEmit` are clean.
  Recording that x402, permanent-upload payment, and the skill/CLI remain
  deferred to phases 4–7.