# Implementation Notes

This document records public-safe implementation decisions and material
changes. Do not include credentials, personal information, private
infrastructure details, or raw user data.

## Status

Delivered phases 1–8 and partial 6 of [handover.md](./handover.md): a
Bun/TypeScript/Hono Worker running with pricing, temporary reservation/upload/
download/HEAD/range, deletion, feedback, quotas, security headers, cleanup
scheduler, discovery endpoints, dynamic x402 pricing, a full OpenAPI 3.1
contract + `docs/api.md`, a standalone Node CLI package, and an npm-dependent
skill (txlink no-key submit + real x402 client signing),
with a Vitest suite (70 tests).
Deployed to production behind `https://upload.stupidtech.net` (D1 + R2
provisioned, migrations applied, secrets set).

Preview-card branding (2026-09-02): re-rendered `public/og.png` (1200×630,
RGB) so the Stupid "ST" logo fills the card instead of a tiny mark on empty
white — paired with `twitter:card=summary`, the centered logo center-crops to a
clear ~120×120 square thumbnail beside the title/description. Added explicit
Open Graph image dimensions/type and `twitter:title`/`twitter:description`/
`twitter:image` tags to `page()` so X serves the logo reliably.

Completed in this pass (2026-09-02):
- **Phase 5** — OpenAPI hardened (full component schemas, download + feedback
  operations, `402` header, `x-bazaar` examples, drift-guard tests) and the
  missing `docs/api.md` added, plus enriched `/docs`, `/` and `/llms.txt`.
- **Phase 7** — oxfmt/oxlint/`tsc --noEmit`/Vitest clean (54 tests), local
  Wrangler smoke passed CLI→Worker (quote → reserve → upload → download →
  status → delete → `410`).
- **Phase 9 prep** — the advisory pricing endpoint was fixed: it previously
  returned `500` because `priceAtomic` was a `BigInt` that `JSON.stringify`
  rejects. Serialized safely; route-level regression tests added.
- **Phase 9 —** the **paid tier is LIVE on Base mainnet** via the Coinbase
  CDP hosted x402 facilitator (challenge side verified live: exact `eip155:8453`
  Base USDC). A final live **settlement** (a real `$0.011`-class payment from a
  funded mainnet USDC account) is the one remaining Phase-9 acceptance item.
- **Phase 10** — deployment/decision log updated (this file).
- **Local upload registry.** The CLI now records every successful upload in a
  local JSON file (`STUPID_UPLOAD_STATE_FILE`, default `~/.stupid-upload/
  uploads.json`, written mode `0600`) so users can `list` recorded uploads and
  `delete <id>` without re-supplying a token (the recorded delete bearer token
  is auto-loaded and the entry removed on success). `list` never echoes tokens.
  Sits purely client-side; no API or data-model change.
- **Node CLI package.** Executable code now lives under `cli/`, builds to a
  Node.js 22 ESM executable, and is published publicly as
  `stupid-upload@0.0.2`. The compact agent skill contains only instructions and
  an API reference; it verifies and globally installs that exact npm version
  before operation.
- **Payment method: EIP-3009 only, via txlink address substitution.** A live
  probe showed the deployed permanent route used the `exact` scheme's
  **EIP-3009** default (`transferWithAuthorization`), which embeds the payer
  `from` in the signed message. An earlier permit2-only pivot unblocked no-key
  signing but required a one-time `USDC.approve(Permit2, MAX)`, real payer
  friction for a one-off agent. txlink's `wallet_sign` now supports **account
  substitution**: any address field set to `0xaa…aa` (all `a`'s) is replaced
  with the connected account's address before signing (EIP-7871, or
  `eth_signTypedData_v4` fallback returning `{ signature, message, account }`).
  `/v1/uploads/permanent` therefore advertises a **single EIP-3009** `exact`
  method and the no-key seam (`submit-exact.ts`) builds the EIP-3009 payload
  with the substitution sentinel as `from`, presents the typed-data to txlink,
  then splices the returned signature + `account` as `PAYMENT-SIGNATURE`. No
  Permit2 allowance is required; the keyed knox flow stays EIP-3009.
- **No-key paid upload (submit seam).** The CLI now completes
  `upload --permanent` without a private key: it drives `@x402/evm`'s
  `ExactEvmScheme` with a capturing signer to mint the canonical EIP-3009
  typed-data and a placeholder payload (`cli/src/submit-exact.ts`), asks a
  wallet to sign via txlink EIP-7871 `wallet_sign`,
  splices the signature + payer `account` into the payload, and re-POSTs it as
  the `PAYMENT-SIGNATURE` header so the CDP facilitator settles `exact`. It
  fails closed on an unsupported payment shape, on a quote above the
  `--max-price-usd`/v1-maximum cap, and on a malformed wallet result. It emits
  one `approvalRequired` JSON line to stderr (never stdout) with the wallet URL
  and polls the txlink result up to `STUPID_UPLOAD_SIGN_TIMEOUT_MS`. Covered by
  `test/submit-exact.test.ts` (3) and updated `test/cli.test.ts` (5).

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
  done by the facilitator. The route advertises `maxTimeoutSeconds: 3600`, so
  official clients produce EIP-3009 authorizations valid for one hour. Because
  the packages lean on Node globals (`Buffer`, ...), `nodejs_compat` is enabled
  in `wrangler.jsonc`.
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
- **Node CLI with real x402 + txlink.** The npm CLI under `cli/` signs and pays
  locally through `@x402/evm` + `@x402/fetch` when
  `STUPID_UPLOAD_PRIVATE_KEY` is set. Without a key, it creates and polls a
  txlink wallet-sign request, then submits the completed x402 payload. The
  repository skill deliberately carries no executable code and pins the npm
  CLI version it installs.

## Change Log

### 2026-09-02 (local upload history)

- The landing page now records every successful upload in browser `localStorage`
  (`stupid-upload.history`) and lists them under a "Your uploads" section that
  is hidden when the list is empty. Each entry shows the filename + public URL
  and a Delete button. Delete issues `DELETE /v1/uploads/{id}` with the
  reservation's bearer delete token (mirroring the CLI's local registry) and
  removes the entry on `200`/`410`. The section re-renders after each upload,
  delete, and on page load.

### 2026-09-02 (wallet QR placement)

- On the landing page, the wallet-approval QR now renders above the approve
  link (previously inline after it) and hides once the txlink `wallet_sign`
  response is received, so the QR doesn't linger after approval.

### 2026-09-02 (inline image previews)

- File responses now serve safe content inline instead of forcing a download.
  `buildFileResponse` passes `isInlineSafe(contentType)` to `contentDisposition`,
  so images (`image/png`, `jpeg`, `gif`, `webp`, `avif`, ...) open in the
  browser rather than downloading, while active content (SVG, HTML, XML, JS)
  remains an attachment as before. No change to the drop already served by
  `contentDisposition`'s `inline` branch. Added `test/files.test.ts` coverage
  for five image types (inline) and SVG (attachment).

### 2026-09-02 (web paid uploads)

- Added an expiry radio group to the landing page: temporary (24 hours, ≤1 MiB)
  or permanent (never, ≤100 MiB).
- Permanent uploads in the browser now fetch a canonical EIP-3009 payment from a
  new `POST /v1/payments/captured` endpoint, ask a wallet to sign it via txlink
  (`wallet_sign` with account substitution), poll for the result, splice the
  returned signature + payer into the `PAYMENT-SIGNATURE` header, and complete
  the upload — the same submit seam the CLI uses, shared in `src/webpay.ts`.
- `webpay.ts` derives the USDC `accepts` (per-network token, USD Coin domain)
  with the same pricing/`maxTimeoutSeconds` the permanent middleware uses, so
  what the page signs matches what the facilitator settles.
- Added webpay capture + HTTP tests (tests: 72 total).
- Moved the landing page client logic to a same-origin `/app.js` (CSP
  `script-src 'self'`), added tolerant parsing of the txlink signature result
  (accepts both a JSON string and a pre-parsed object — a JSON-parse of an
  object caused the `"[object Object]" is not valid JSON` failure), and now
  render the wallet-approval QR from txlink's own `?qr=svg` data-URI endpoint
  instead of shipping a QR library (removed `public/qrcode-generator.js`).
- The paid browser flow now surfaces the facilitator's real rejection reason
  (decoded from the `PAYMENT-REQUIRED` 402 header) rather than a generic
  "Payment was not accepted", so CDP/user-funding failures are actionable.
- **Web payment root cause (2026-09-02 late):** EIP-3009 `TransferWithAuthorization`
  signatures must be signed by the exact payer address that USDC recovers. For
  the txlink `wallet_sign` (EIP-7871 account-substitution) flow, the certificate
  `from` placeholder is replaced at sign time, so `recoverTypedDataAddress(sig)`
  must equal the payer actually authorized. When it does not — e.g.
  `invalid_exact_evm_payload_signature` → `invalid_payload: contract call failed:
  execution reverted` (`FiatTokenV2: invalid signature`) — the settlement returns
  the facilitator's real reason, now surfaced in the UI. Verified by replaying a
  completed txlink request: the recorded `account` differed from the signature's
  recovered address, so USDC rejected the authorization.

### 2026-09-02 (CLI 0.0.2)

- Made temporary retention the CLI default: `stupid-upload upload <path>` now
  performs the free 24-hour upload, while `--temporary` remains explicit and
  `--permanent` continues to select paid retention.
- Set the permanent x402 challenge timeout to 3,600 seconds. The official
  client derives EIP-3009 `validBefore` from that value, giving keyed and
  txlink authorization paths the same one-hour expiry.
- Published `stupid-upload@0.0.2` as npm's `latest`, updated and repackaged the
  skill to require that exact version, and verified a clean registry install.
- Deployed the timeout change and verified production returns an exact
  Base-mainnet `402` challenge with `maxTimeoutSeconds: 3600`.
- Replaced the API-oriented root page with minimal one-command CLI usage for
  temporary and permanent uploads, plus a browser interface for free temporary
  uploads. Added static favicon/Open Graph assets and social metadata while
  keeping `/docs` and machine discovery unchanged. Linked the repository agent
  skill directly from the page.

### 2026-09-02 (Node CLI package)

- Moved CLI source and payment helpers from the agent skill to `cli/`, changed
  the runtime from Bun to Node.js 22, and published `stupid-upload@0.0.1` with a
  generated ESM executable.
- Reduced `skills/stupid-upload` to instructions and its compact API reference;
  it now requires and verifies the exact globally installed npm CLI version.
- Added a process-level test for the built Node executable and made the package
  manifest the source of truth for `--version`.
- Verified the registry release through a clean global-prefix install, npm-style
  executable symlink, and a live advisory quote against production.

### 2026-09-02 (live mainnet)

- **First live Base-mainnet settlement — PASSED.** Through knox + the CDP
  facilitator, paid the real $0.01 (10,000 USDC) for an 800-byte permanent
  upload; the server returned a `201` permanent reservation
  (`expiresAt: null`, `priceAtomic: 10000`, `paymentNetwork: eip155:8453`), then
  the full E2E passed on production: `PUT 201` → download bytes match →
  status `ready` → `DELETE 200` → `410`. Phase 9 (live paid tier) is validated.
- **Root cause found + fixed (a real CDP-integration bug):** the CDP facilitator
  rejected our verify requests with `header Content-Type has unexpected
  value` — because we set `content-type` inside `createAuthHeaders`. CDP wants
  that header set only by the `HTTPFacilitatorClient` itself. Removed our
  `content-type` from the CDP auth headers; settlement now clears. Verified
  against the CDP API directly (content-type accepted ⇒ schema validation ⇒
  real settlement).
- Also added `src/payment.ts` debug instrumentation (`instrumentFacilitator`)
  that logs a short, non-sensitive reason when a CDP verify/settle is rejected
  (the protocol otherwise swallows it into a bare `402`) — surfaced this bug.
- **EIP-7871 `wallet_sign` signing round-trip validated** for the no-key CLI
  path: txlink returns `{ signature, message, account }` (account now emitted).
  EIP-7871 is the address-substitution method that replaces the broken
  `eth_signTypedData_v4`-needs-address call. (Signing round-trip works; the
  no-key path still needs a **submit helper** to turn the returned signature+
  account into a settlement — the actual settlement is currently done in-repo
  via knox/the client.)

### 2026-09-02 (late)

- **Paid tier is LIVE on Base mainnet (Phase 9, challenge side).** Switched the
  facilitator from the public `x402.org` (Sepolia-only) to the **Coinbase CDP
  hosted x402 facilitator**, which supports `eip155:8453` `exact` (confirmed via
  `GET /platform/v2/x402/supported`: `kinds[].network === "eip155:8453"`).
  Implemented light-in-Worker CDP auth in `src/cdp.ts`: sign a per-endpoint CDP
  JWT (Ed25519) with `generateJwt` from `@coinbase/cdp-sdk/auth` and feed
  `HTTPFacilitatorClient.createAuthHeaders` — avoiding the multi-chain CDP SDK
  `./x402` facade (whose static `@x402/svm` import would not bundle). CDP creds
  are `wrangler` secrets (`CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`).
- **Verified live:** unpaid `POST /v1/uploads/permanent` now returns a real
  `402` — `network eip155:8453`, `asset 0x8335…2913` (Base USDC), `amount
  28000` ($0.028 for 10 MiB), `payTo` the configured recipient. Pricing, temp
  uploads, and `/health` still return `200`/`201`.
- Removed the now-misleading `STUPID_UPLOAD_FACILITATOR_URL` secret (CDP creds
  supersede it). Note: a real mainnet **settlement** still needs a caller with
  funded mainnet USDC; the challenge/verify/settle machinery is shared with the
  already-live Sepolia run described below.

### 2026-09-02

- **Phase 5 (complete):** hardened `src/discovery.ts` — the OpenAPI 3.1
  contract now has full component schemas (`UploadMetadata`, `Error`,
  `Reservation`, `UploadComplete`, `Feedback`, `FeedbackResponse`, `Pricing`),
  all operations with stable `operationId`s + responses (including
  `GET /f/{id}/{filename}`, `HEAD`, `/v1/feedback`, `/health`), the `402`
  `PAYMENT-REQUIRED` header, and a Bazaar `x-bazaar` request/response example
  on the permanent route. Added the missing `docs/api.md` and enriched `/docs`,
  `/llms.txt`. Added drift-guard tests tying `docs/api.md` to `/openapi.json`.
- **Phase 7:** full local validation. Format/oxlint/`tsc --noEmit` clean;
  suite at **54 tests**. Ran a local Wrangler smoke test: CLI → Worker
  quote/reserve/upload/download/status/delete/`410` end-to-end — and it found
  a real bug (below).
- **Material fix: advisory pricing returned `500`.** `POST-/…/v1/pricing`
  passed the raw `priceTemporary`/`pricePermanent` results (containing a
  `BigInt` `priceAtomic`) straight to `c.json`, which `JSON.stringify` can't
  serialize — every size, temp or permanent, failed. `app.ts` now rounds the
  numeric payload through a BigInt-safe serializer; HTTP-level regression tests
  were added to `test/pricing.test.ts`.
- **Phase 10:** updated this Status + Change Log. `docs/operations.md` still
  records the pending Phase 9 (production paid tier) enablement steps and the
  `files.upload.*` host / R2 `temporary/` lifecycle follow-ups.
- Deferred: production mainnet paid tier (`501` until Phase 9 — needs a funded
  Base-mainnet account, a reachable mainnet facilitator, and
  `STUPID_UPLOAD_PAYMENT_ADDRESS`).

- **Deployed** the pricing/OpenAPI/docs fix to production
  (`upload.stupidtech.net`) and re-verified live. On enabling the paid tier, the
  production Worker exposed a **real footgun in `z.coerce.boolean()`**: setting
  `STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED=false`… actually coerced to `true`
  (any non-empty string is `Boolean`-truthy), so the flag could never be turned
  off once present. `src/config.ts` now uses a string-safe `boolField()`
  (parses `true/1/false/0`, else default) and `test/config.test.ts` guards it.
- **Mainnet paid tier blocker (material):** `https://x402.org/facilitator`
  only supports EVM on **Base Sepolia (`eip155:84532`)** — its `/supported`
  list has no `eip155:8453` (Base mainnet) `exact`/`upto`/`batch-settlement`
  kind. Enabling against it returned `500 RouteConfigurationError: Facilitator
  does not support scheme exact on network eip155:8453`. The paid tier is
  therefore still gated off (`501`) until a facilitator that settles on Base
  mainnet is available (self-hosted or otherwise). The build is fully wired;
  only the network-backed facilitator + a funded recipient are missing.

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
