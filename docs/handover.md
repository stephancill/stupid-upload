# Stupid Upload v1 Plan

## Goal

Build an accountless, agent-first public file upload service on Cloudflare. Temporary files are free and become unavailable exactly 24 hours after upload. Permanent files have no scheduled expiration and cost $0.01 for the first MiB plus $0.002 per additional started MiB, up to 100 MiB, paid with x402 in Base USDC.

"Permanent" must be described publicly as "no scheduled expiration," subject to uploader deletion, abuse/legal removal, and service availability. Do not promise literal eternal retention.

## Product Decisions

- Production host: configurable, with `upload.stupidtech.net` as the expected API/site host.
- Public file host: use a separate configurable host such as `files.upload.stupidtech.net` to isolate untrusted content.
- Payment protocol: x402 only for v1.
- Production payment network: Base mainnet (`eip155:8453`) and USDC through the CDP facilitator.
- Test payment network: Base Sepolia (`eip155:84532`).
- Permanent pricing: `$0.01 + max(0, ceil((sizeBytes - 1,048,576) / 1,048,576)) * $0.002`.
- The permanent price assumes five years of storage cost while retaining files without a scheduled expiry. This is a portfolio pricing assumption, not a five-year deletion policy or guarantee of literal eternal storage.
- Permanent size limit: 100 MiB. Maximum price is therefore $0.208.
- Temporary size limit: 1 MiB per file.
- Temporary source quota: 20 MiB per UTC day, reserved when an upload slot is created.
- Temporary global circuit breaker: 10 GiB reserved per UTC day at launch, configurable as an environment value.
- Pending upload URL lifetime: 15 minutes.
- Access model: public, unlisted, random URLs; no accounts and no directory listing.
- Storage class: R2 Standard. Infrequent Access is inappropriate for 24-hour objects and has a 30-day minimum charge.

Pricing examples:

| Size | Permanent price |
| --- | ---: |
| Empty to 1 MiB | $0.01 |
| 1 MiB + 1 byte | $0.012 |
| 10 MiB | $0.028 |
| 100 MiB | $0.208 |

At the current R2 Standard rate of $0.015/GB-month, five years of raw storage costs approximately $0.00088/MiB. The $0.002 incremental rate provides roughly 2.3 times that cost for request, Worker, payment, and pricing-risk headroom; the $0.01 minimum covers small-object overhead. Revenue is pooled across permanent uploads because files still have no scheduled expiry.

## Stack

- Bun package manager and scripts.
- TypeScript with strict compiler settings.
- Hono on Cloudflare Workers.
- Cloudflare R2 for file bodies.
- Cloudflare D1 for upload reservations, status, quotas, delete credentials, and payment metadata.
- Cloudflare Rate Limiting binding for burst protection; D1 remains authoritative for byte quotas because rate-limit counters are permissive and location-local.
- Zod for all metadata, query, header, and environment validation.
- Official current x402 Hono/EVM packages and CDP facilitator integration. Confirm Worker runtime compatibility against the installed package versions before fixing the exact imports.
- Vitest using the Cloudflare Workers test pool for unit and integration tests.
- Oxfmt and oxlint because no repository tooling exists yet.
- Minimal server-rendered HTML/CSS documentation page; no React application is needed for v1.

## Repository Layout

```text
AGENTS.md
README.md
package.json
tsconfig.json
wrangler.jsonc
.gitignore
.env.example
docs/
  quickstart.md
  implementation-notes.md
  api.md
  cli.md
  operations.md
migrations/
  0001_initial.sql
src/
  index.ts
  app.ts
  config.ts
  pricing.ts
  schemas.ts
  storage.ts
  quota.ts
  security.ts
  discovery.ts
  routes/
    uploads.ts
    files.ts
    feedback.ts
    public.ts
    admin.ts
skills/
  stupid-upload/
    SKILL.md
    package.json
    scripts/
      stupid-upload.ts
    references/
      api.md
test/
  pricing.test.ts
  uploads.test.ts
  files.test.ts
  feedback.test.ts
  cli.test.ts
  discovery.test.ts
```

Keep helpers only where behavior is reused. The actual route handlers should remain direct and readable rather than introducing service classes.

## API Contract

### Pricing

`GET /v1/pricing?sizeBytes=<integer>`

- Validate `0 <= sizeBytes <= 104857600`.
- Return `sizeBytes`, `billableMiB`, `priceUsd`, `priceAtomic` (USDC six-decimal units), limits, network, and retention options.
- This endpoint is advisory. The runtime x402 `402` challenge is authoritative.

### Create Temporary Upload

`POST /v1/uploads/temporary`

JSON body:

```json
{
  "filename": "result.json",
  "contentType": "application/json",
  "sizeBytes": 1234,
  "sha256": "64 lowercase hex characters"
}
```

- Require a high-entropy `Idempotency-Key` header on every reservation request.
- Require `sizeBytes <= 1 MiB`.
- Hash `CF-Connecting-IP` with an HMAC secret before persistence; never store raw IPs.
- Atomically reserve both the source's 20 MiB daily quota and the global daily budget in D1.
- Repeating the same idempotency key returns the existing reservation without consuming quota again. Treat the idempotency key as a recovery credential and derive stable upload/delete tokens from the reservation ID and a server HMAC secret so a lost creation response can be recovered safely.
- Return `201` with upload ID, bearer upload token, bearer delete token, upload URL, required upload headers, public URL, upload deadline, and expected expiry.

### Create Permanent Upload

`POST /v1/uploads/permanent`

- Accept the same metadata body and `Idempotency-Key` header as the temporary route.
- Use the x402 request adapter's body support for dynamic pricing. The middleware must inspect a cloned/cached JSON body so the handler can parse the original request normally; verify this behavior against the installed package version.
- Require `sizeBytes <= 100 MiB`.
- A request without payment returns an x402 `402` challenge for `$0.01 + $0.002` per additional started MiB after the first, in Base USDC.
- After verified settlement, create the reservation and return the same `201` shape, with `expiresAt: null`, the exact settled price, network, and payment receipt metadata where exposed by the x402 middleware.
- Check for an existing idempotent reservation before invoking x402 so retrying a successfully settled request returns the prior reservation without charging again.
- Payment purchases the upload slot. State that an expired, unused slot is not automatically refunded in v1.

### Upload Bytes

`PUT /v1/uploads/{id}/content`

- Require `Authorization: Bearer <uploadToken>` and compare only a cryptographic token hash stored in D1.
- Require exact `Content-Length` and `Content-Type` values from the reservation. Reject missing or chunked lengths.
- Reject expired, completed, or deleted reservations.
- Stream `request.body` to the R2 binding. Pass the expected SHA-256 through `R2PutOptions.sha256` so R2 verifies integrity while streaming.
- Store safe HTTP metadata and minimal custom metadata on the object.
- Update D1 to `ready` only after R2 succeeds. If the D1 finalization fails, delete the just-written object as compensation and return a loud error.
- Return `201` with canonical public URL, size, SHA-256, retention, expiry, and ETag.

### Status and Download

- `GET /v1/uploads/{id}` returns reservation/file metadata without secrets.
- `GET /f/{id}/{filename}` streams a ready object.
- `HEAD /f/{id}/{filename}` returns the same metadata without a body.
- The random ID is authoritative. Redirect a mismatched filename to the canonical URL or return `404`; choose one behavior and test it. Redirect is preferable for stable links.
- Support conditional requests and byte ranges through R2 for agent resumability.
- Return `404` for unknown IDs and `410 Gone` for known expired/deleted IDs.
- Temporary reads check `expires_at` before touching R2, so availability ends exactly 24 hours after successful upload regardless of delayed physical deletion.
- Permanent responses use long-lived immutable public caching because object URLs never change.
- Temporary responses use `Cache-Control: private, no-store` to prevent cache survival beyond expiry.

### Delete

`DELETE /v1/uploads/{id}`

- Require `Authorization: Bearer <deleteToken>`.
- Delete from R2, mark the D1 row deleted, and make later reads return `410`.
- Deletion is idempotent.

### Feedback

`POST /v1/feedback`

JSON body:

```json
{
  "category": "feature_request",
  "message": "A 7-day temporary retention option would be useful.",
  "rating": 4,
  "relatedUploadId": "p_iMmZrdB5V5KUvfUH8L4BAA",
  "requestId": "req_01J...",
  "client": {
    "name": "opencode",
    "version": "2.0"
  }
}
```

- Accept categories `bug`, `feature_request`, `usability`, `pricing`, and `other`.
- Require a plain-text `message` from 1 to 4,000 characters.
- Accept an optional integer `rating` from 1 to 5, related upload ID, server request ID, and bounded client name/version.
- Do not accept arbitrary metadata, attachments, HTML, contact details, or credentials.
- Hash the request source using the same HMAC privacy mechanism as temporary quotas.
- Enforce 5 submissions per minute, 20 per source per UTC day, and a configurable 1,000-submission global daily circuit breaker.
- Store accepted feedback privately in D1 and return `202 Accepted` with `feedbackId`, `status: "accepted"`, and `receivedAt`; do not echo the message.
- Expose no public feedback read/list endpoint. Inspect and export feedback through authenticated Cloudflare/D1 operational tooling in v1.
- Document that users must not submit secrets or personal information. Retain feedback for a configurable 365 days, then purge it with the scheduled Worker.

### Discovery and Documentation

- `GET /` serves a small human-readable page with pricing, limits, privacy/retention wording, and copyable curl examples.
- `GET /docs` serves first-party quick-start, API, CLI, payment, retention, error, and deletion guidance derived from the repository documentation.
- `GET /openapi.json` serves OpenAPI 3.1 with stable operation IDs, exact schemas, examples, `402` response, dynamic price range, and `x-payment-info` for x402.
- `GET /llms.txt` gives concise agent instructions and a complete upload/payment example.
- `GET /.well-known/x402` points to service metadata and `/openapi.json`.
- Document `POST /v1/feedback` in OpenAPI and `llms.txt` with a realistic agent-generated example.
- Register the x402 Bazaar resource-server extension and discovery declaration for the payable route, including input/output examples and schemas.
- `GET /health` checks only process health; do not turn it into an expensive dependency probe.

Repository documentation responsibilities:

- `docs/quickstart.md` covers temporary and paid permanent uploads using curl and the CLI.
- `docs/api.md` documents every route, schema, response, stable error code, rate/size limit, x402 behavior, and idempotency semantics. Treat `/openapi.json` as the canonical machine contract and test examples against it to prevent drift.
- `docs/cli.md` covers installation, environment variables, commands, JSON output, exit codes, payment security, and complete examples.
- `docs/operations.md` covers Cloudflare provisioning, migrations, secrets, deployment, payment settlement, quota changes, feedback review/export, cleanup, abuse removal, and recovery.
- `docs/implementation-notes.md` records implementation and deployment decisions without secrets or personal information and is updated before commits when required by `AGENTS.md`.

## Agent Skill and CLI

Create a repository-local skill at `skills/stupid-upload/`. It must be self-contained so the directory can be installed as an agent skill without relying on source files elsewhere in the repository.

### Skill Structure

- `SKILL.md` has only `name` and a comprehensive trigger-oriented `description` in YAML frontmatter. Its concise imperative body tells agents when to quote, choose temporary versus permanent retention, upload, download, delete, and send feedback.
- `references/api.md` contains the compact API/limits/error details needed during operation. Generate it from or validate it against `/openapi.json` rather than maintaining an unrelated hand-written contract.
- `scripts/stupid-upload.ts` is the deterministic CLI entry point used by the skill.
- `package.json` contains only the runtime dependencies and scripts needed to execute and test the CLI. Use Bun and a `#!/usr/bin/env bun` shebang.
- Do not add a skill-local README, changelog, installation guide, or duplicate prose that belongs in `SKILL.md`, `references/api.md`, or repository `docs/`.

The skill description should trigger for requests to upload or share a local file, create an expiring or permanent public URL, quote upload storage, inspect/download/delete a Stupid Upload file, or submit product feedback.

### CLI Contract

Expose the executable as `stupid-upload`. The repository root package may point its `bin` entry to `skills/stupid-upload/scripts/stupid-upload.ts`, but the script must also work directly from the packaged skill.

Commands:

```text
stupid-upload quote <path>
stupid-upload upload <path> --temporary
stupid-upload upload <path> --permanent
stupid-upload status <id>
stupid-upload head <url-or-id>
stupid-upload download <url-or-id> --output <path>
stupid-upload delete <id> --token <delete-token>
stupid-upload feedback --category <category> --message <text> [--rating <1-5>] [--upload-id <id>] [--request-id <id>]
```

CLI behavior:

- Default `STUPID_UPLOAD_BASE_URL` to the production API and allow overriding it for local/test deployments.
- Emit stable JSON to stdout by default so agents do not parse decorative text. Reserve stderr for structured errors and diagnostics; provide an optional `--human` format only if it remains low maintenance.
- Exit `0` only on success and use documented nonzero exit codes for validation, quota, payment, network, integrity, and server errors.
- For upload commands, inspect the file, determine or accept `--content-type`, compute SHA-256 locally, create a cryptographically random idempotency key, reserve the slot, stream the bytes, and output the final public URL, deletion token, size, hash, retention, expiry, and payment receipt.
- Temporary upload needs no credentials and must fail before reservation if the file exceeds 1 MiB.
- Permanent upload obtains the x402 challenge and pays/retries automatically with the official x402 client and viem. Read the payer key only from `STUPID_UPLOAD_PRIVATE_KEY`; never accept it as a command-line flag, print it, persist it, or include it in errors.
- Before paying, print nothing interactive in default JSON mode. Enforce a default maximum authorized amount equal to the documented v1 maximum and support `--max-price-usd` so agents can set a lower spending cap. Fail closed if the challenge network, token, recipient, or amount differs from the quote/runtime expectations.
- Honor `Idempotency-Key` recovery so a network failure after settlement does not cause another payment.
- `download` writes atomically through a temporary file, verifies advertised length/hash when available, and does not overwrite unless `--force` is supplied.
- `delete` accepts the token via `--token` for basic use and `STUPID_UPLOAD_DELETE_TOKEN` for callers that want to avoid process arguments. Document the environment form as safer on shared systems.
- `feedback` calls the anonymous feedback endpoint and never silently includes local paths, environment values, file contents, or payment data.
- Support `--help` and `--version`. Defer stdin uploads until size/hash-safe spooling is deliberately implemented.

### Skill and CLI Validation

- Initialize the skill using the skill-creator tooling, remove generated examples that are not needed, and keep `SKILL.md` below 500 lines.
- Validate and package it with the skill-creator `quick_validate.py` and `package_skill.py` workflows. Produce a `stupid-upload.skill` artifact for installation testing without committing generated artifacts unless repository policy explicitly calls for it.
- Test the CLI parser, JSON output, exit codes, hash/size calculation, spending cap, unexpected x402 terms, idempotent retry, temporary upload, testnet permanent upload, download integrity, deletion, and feedback.
- Install the packaged skill into a clean temporary agent environment and run one end-to-end temporary workflow plus a Base Sepolia paid workflow.
- Keep CLI/API schemas aligned by importing generated types from the checked-in OpenAPI schema when practical, or by contract tests against a local Worker when cross-package imports would make the skill non-self-contained.

## Data Model

Create an `uploads` table with:

- `id` random 128-bit base64url primary key.
- `object_key` unique R2 key (`temporary/<id>` or `permanent/<id>`).
- `filename`, normalized for display and `Content-Disposition` but never used as the storage key.
- `content_type`, `size_bytes`, and lowercase hex `sha256`.
- `retention` (`temporary` or `permanent`).
- `status` (`pending`, `ready`, `deleted`, `expired`).
- `source_hash` and `idempotency_key`, with a suitable uniqueness constraint.
- `upload_token_hash` and `delete_token_hash`; never persist raw bearer tokens.
- `upload_expires_at`, `expires_at`, `created_at`, `completed_at`, and `deleted_at` as integer epoch seconds.
- `price_atomic`, `payment_network`, and nullable payment receipt/transaction identifier.

Create a `daily_usage` table keyed by `(scope, subject_hash, utc_day)` with `reserved_bytes` and `upload_count`. Use one conditional UPSERT/RETURNING statement to reserve quota without read-then-write races. `scope` distinguishes source and global budgets.

Create a private `feedback` table with `id`, category, message, nullable rating/upload/request/client fields, `source_hash`, `status` (`new`, `reviewed`, or `closed`), and creation/update timestamps. Index creation time and triage status. Use daily usage scopes for source and global feedback counters rather than storing raw IP addresses.

Index upload status/expiration for scheduled cleanup. Keep expired/deleted tombstones for a short configurable period so links return `410`, then purge metadata.

## Security and Abuse Controls

- Validate all values with Zod and return stable JSON error codes plus human-readable messages.
- Accept only `application/octet-stream` bodies at the protocol layer while recording the declared file content type, or require the declared content type exactly; settle this during implementation based on R2 checksum behavior and document the required curl headers.
- Limit filename bytes and reject control characters, path separators, bidi controls, and invalid content types.
- Use constant-time comparisons for bearer-token hashes.
- Add burst limits per source to reservation and upload routes, while keeping D1 quotas authoritative.
- Apply separate burst and authoritative daily limits to feedback submissions so feedback cannot become a spam or D1 cost vector.
- Never expose the R2 bucket publicly; all downloads pass through the Worker.
- Serve active content (`text/html`, SVG, XML, JavaScript, and unknown executable types) as attachments.
- Add `X-Content-Type-Options: nosniff`, a restrictive CSP, safe `Content-Disposition`, and appropriate cross-origin headers on file responses.
- Allow CORS for public GET/HEAD and documented API calls without allowing credentials.
- Add an admin deletion endpoint protected by a separately stored secret for abuse/legal takedowns. Log admin deletions without logging secrets.
- Publish acceptable-use, privacy, retention, and abuse-contact text before production launch. State that public URLs are bearer-like and must not be used for secrets.
- Use structured logs without file bodies, raw tokens, raw IP addresses, payment headers, or full presigned/authenticated URLs.

## Expiration and Cleanup

- Set `expires_at` to exactly 24 hours after a temporary upload successfully completes, not after slot reservation.
- Run a scheduled Worker hourly. In bounded batches, mark expired rows, delete matching R2 objects, and remove stale pending reservations.
- Configure an R2 lifecycle rule on `temporary/` as a defense-in-depth deletion mechanism after one day. Logical expiry in the Worker remains authoritative because R2 lifecycle removal can lag by up to 24 hours.
- Keep the default incomplete multipart cleanup even though v1 does not use multipart uploads.
- Periodically purge old quota rows and tombstones.
- Purge feedback after its configured 365-day retention period.

## Delivery Phases

1. Scaffold Bun/TypeScript/Hono Worker, repository `AGENTS.md`, implementation notes, Wrangler bindings, D1 migration, lint/format/test scripts, and environment schema.
2. Implement and unit-test pricing, IDs/tokens, metadata validation, quota reservation, and security headers.
3. Implement temporary reservation, authenticated streaming upload with SHA-256 enforcement, status, download/HEAD/range behavior, deletion, feedback collection, and cleanup cron.
4. Integrate x402 dynamic pricing on Base Sepolia, persist available receipt metadata, and test unpaid and paid permanent reservations.
5. Add OpenAPI, `llms.txt`, `.well-known/x402`, Bazaar discovery metadata, hosted/repository documentation, and tested curl recipes.
6. Build the self-contained `skills/stupid-upload` skill and CLI, validate/package the skill, and run CLI contract tests against the local Worker and Base Sepolia.
7. Run oxfmt, oxlint, TypeScript checks, unit/integration tests, local Wrangler smoke tests, and documentation example checks.
8. Provision production R2/D1/rate-limit bindings and secrets, configure lifecycle/CORS/domains, deploy, and test temporary expiry behavior.
9. Switch x402 to Base mainnet, execute one real $0.01 payment through the CLI, upload/download/delete a file, verify settlement, and confirm Bazaar indexing.
10. Validate production discovery/documents and record deployment/operational details in `docs/implementation-notes.md` without personal information or secrets.

## Verification Matrix

- Pricing boundaries: 0, 1 byte, 1 MiB, 1 MiB + 1 byte, 100 MiB, and 100 MiB + 1 byte.
- Metadata failures: invalid size, hash, filename, MIME type, mismatched query/body size, and duplicate idempotency key.
- Quotas: source boundary, global boundary, concurrent reservation attempts, and UTC-day rollover.
- Upload authorization: missing/wrong token, expired slot, incorrect length/type/hash, replay after completion, and compensation after finalization failure.
- File access: ready/pending/unknown/expired/deleted, canonical filename, HEAD, ranges, ETag conditions, and security/cache headers.
- Payment: unpaid dynamic `402`, correct Base/USDC amount at each size tier, invalid/replayed payment, successful testnet settlement, and receipt response.
- Cleanup: exact logical expiry, stale pending reservations, batched R2 deletion, tombstone behavior, and idempotent cron retries.
- Feedback: schema boundaries, stable `202` response, source/global rate limits, no public reads, private logging behavior, and retention cleanup.
- Discovery: OpenAPI 3.1 schema validity, `402` declaration, exact examples, `.well-known/x402`, `llms.txt`, and Bazaar listing after successful production settlement.
- Documentation: curl examples execute successfully, hosted and repository docs agree with OpenAPI, all links resolve, and no example contains a real secret or personal information.
- Skill/CLI: skill validation and packaging, clean-environment installation, stable JSON/error output, all command workflows, payment term/spend checks, and end-to-end temporary/testnet permanent uploads.

## Launch Acceptance Criteria

- An unauthenticated agent can discover the API, reserve and upload a <=1 MiB temporary file, receive a public URL, and retrieve it without browser-specific steps.
- The temporary URL returns `410` at or after exactly 24 hours, even if R2 has not physically removed the object yet.
- A payment-capable agent receives an exact size-based x402 challenge, pays Base USDC, uploads up to 100 MiB once, and receives a no-scheduled-expiry URL.
- No endpoint stores or logs raw IPs, bearer tokens, payment authorization headers, or file contents outside R2.
- Source and global free quotas fail closed under concurrent reservation tests.
- Active user content cannot execute in the API/site origin and is served with safe headers.
- An unauthenticated agent can submit bounded product feedback, while spam controls and private storage prevent the endpoint from exposing feedback or becoming an unbounded write path.
- An agent can install `skills/stupid-upload`, invoke its bundled CLI without manually constructing HTTP or x402 headers, and complete quote/upload/status/download/delete/feedback workflows using machine-readable output.
- First-party hosted and repository documentation covers both direct API usage and the CLI, with examples verified against the deployed contract.
- Formatting, linting, type checking, tests, local smoke tests, one testnet payment, and one production $0.01 payment all pass.

## Deferred from v1

- Accounts, dashboards, private files, password protection, custom expirations, custom domains, file replacement, folders, and list APIs.
- MPP/Torch payments, Solana payments, cards, subscriptions, bundles, and prepaid balances.
- Files over 100 MiB and direct presigned/multipart upload flows.
- Automated malware scanning and content classification. Launch instead with attachment handling, takedown tooling, quotas, and explicit acceptable-use terms.

## Follow-up: no-key `upload --permanent` submit (handed off)

**Status (2026-09-02):** the live paid tier works end-to-end on Base mainnet via
a keyed payer (knox / `@x402/fetch`): a real $0.01 settlement, then upload →
download → delete, was verified in production. What is **not** done is the
**no-key** `upload --permanent` path actually settling — the CLI can now sign
the correct message and receive a real EIP-7871 signature + payer `account`
back from txlink, but it cannot yet turn that signature into a CDP `exact`
settlement. Hand to an engineer to build the "submit" seam.

### Background facts (verified)

- The `exact` payment is a Permit2-`witness` transfer, **not** a plain permit.
  In `@x402/evm` the signed type is `PermitWitnessTransferFrom` over the
  `PERMIT2` domain:
  - `PermitWitnessTransferFrom = [ permitted(TokenPermissions), spender(address),
    nonce(uint256), deadline(uint256), witness(Witness) ]`
  - `TokenPermissions = [ token(address), amount(uint256) ]`,
    `Witness = [ to(address), validAfter(uint256) ]`
  - `message = { permitted:{token, amount}, spender, nonce, deadline,
    witness:{ to: payTo, validAfter } }`
  - `domain = { name: "PERMIT2", chainId, verifyingContract }`
    (`PERMIT2_ADDRESS = 0x000000000022D47F00301126dDE24F6a78BA3`; the `spender`
    is the x402 exact proxy on Base).
  - Chain base mainnet `eip155:8453`.
- No payer address is in the signed message, so EIP-7871 `wallet_sign`
  (`request.type: "0x01"`, omit `address`) lets txlink substitute the connected
  wallet — this already works, and txlink returns `{ result: { signature,
  message, account } }`.
- The server reads the solved payment from a **`PAYMENT-SIGNATURE`** header
  (JSON → base64), decoded via `decodePaymentSignatureHeader` in `@x402/core`.
  The final payment is a v2 `PaymentPayload` object (`x402Version: 2` +
  `payload` + `accepted`).
- The CLI currently builds `permit2TypedData(...)` in
  `skills/stupid-upload/scripts/stupid-upload.ts` (already the correct
  witness struct) and submits the wallet-sign via txlink — but it does **not**
  construct/submit the `PaymentPayload`.
- Live knox settlement already proves the server + CDP facilitator accept the
  canonical `exact` payment.

### The approach (the seam)

1. `@x402/evm`'s `ExactEvmScheme` builds **and signs** the permit in one
   `createPayment(...)` call. To external-sign without a private key, pass a
   **capturing signer** `{ address, publicClient, signTypedData(td) }` that
   returns a unique 65-byte placeholder and records `td` (the exact typed-data,
   incl. nonce/deadline/spender). Call
   `x402Client().register("eip155:8453", scheme).createPayment(<decoded
   paymentRequired>)`.
2. Present the captured typed-data to the wallet via EIP-7871 `wallet_sign`;
   txlink returns the real 65-byte `signature` + `account`.
3. Substitute the placeholder signature with the real one inside
   `payload` (JSON replace), attach `accepted` (the chosen requirement), encode
   the payment to the `PAYMENT-SIGNATURE` header (base64 JSON), and re-POST the
   original `/v1/uploads/permanent` body + the same `Idempotency-Key`.
4. A `201` returns the reservation; then `PUT` content / download / delete as
   usual. A `402` means CDP rejected — read the reason: instrumentation
   (`instrumentFacilitator` in `src/payment.ts`) logs a short reason on
   rejection; otherwise `wrangler tail` + a knox retry shows CDP's exact error.

### Caveats / validation

- The `payload`/`spender` above only pin the shape; the exact `PaymentPayload`
  fields (`accepted`) are scheme-derived, so test against the live CDP and
  iterate (a rejected permit is safe — no funds move). Use the authenticated
  `wrangler tail` instrumentation to read the CDP error.
- The payer (account that signs) must hold ≥ ~$0.01 Base USDC; the recipient is
  `STUPID_UPLOAD_PAYMENT_ADDRESS` (set in prod).
- Do **not** hand-write the payload; drive it from the `@x402` stack so
  nonce/spender/domain derive exactly.
- After it works, add a contract/unit test (stubbed facilitator) mirroring the
  `402 → submit` flow (see `test/payment.test.ts`).

### Files to touch

- `skills/stupid-upload/scripts/stupid-upload.ts` — the no-key `--permanent`
  branch: after the wallet signature, call the submit seam instead of returning
  `awaitingSignature`.
- new `skills/stupid-upload/scripts/submit-exact.ts` — capture signer,
  placeholder→signature substitution, `PAYMENT-SIGNATURE` encode + re-POST.
- `skills/stupid-upload/references/api.md` + `docs/cli.md` — document the no-key
  submit + EIP-7871 signing flow.
- `docs/quickstart.md` — CLI paid example.

Run `bun run format && bun run lint && bun run typecheck && bun run test` before
committing; update `docs/implementation-notes.md`.
