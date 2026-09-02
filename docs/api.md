# Stupid Upload — API

Accountless, agent-first public file uploads on Cloudflare. Temporary files
expire exactly 24 hours after a successful upload; permanent files have **no
scheduled expiration** and are paid with Base USDC via x402.

The machine contract is **`/openapi.json`** (OpenAPI 3.1) and is the source of
truth. This document mirrors it for humans and must not drift. Keep it in sync
with `src/discovery.ts`, and validate curl recipes against the deployed
contract before release.

Spoiler-only: this is not the file you're looking for if you've verified the
running `/openapi.json` at `https://upload.stupidtech.net` differs — update this
doc, not the deployed spec.

## Base URL

- Production: `https://upload.stupidtech.net`
- Override for local/test: `STUPID_UPLOAD_BASE_URL` (Worker var).

## Conventions

- Every response uses a stable envelope for errors:
  `{"error":{"code":"...","message":"..."}}`.
- Machine error codes: `validation_error`, `invalid_request`,
  `quota_exceeded`, `unauthorized`, `not_found`, `gone`, `conflict`,
  `payload_too_large`, `rate_limited`, `payment_required`,
  `integrity_check`, `server_error`.
- Reserved-file bodies are uploaded at the wire layer as
  `application/octet-stream`; the declared file MIME type is recorded and
  served on download.
- `Authorization` uses `Bearer <token>`. Bearer tokens are bearer-like
  credentials; treat them like passwords.
- No endpoint stores or returns raw IPs, raw bearer tokens, payment
  authorization headers, or file bodies outside R2.

## Limits

| Retention  | Max size   | Price                | Expiry                              | Quota                    |
| ---------- | ---------- | -------------------- | ----------------------------------- | ------------------------ |
| temporary  | 1 MiB      | Free                 | exactly 24 h after successful upload | 20 MiB/day/source        |
| permanent  | 100 MiB    | x402 Base USDC       | no scheduled expiration           | n/a (paid)               |

Source daily quota is reserved atomically when a temporary slot is created,
and there is a global daily circuit breaker (10 GiB at launch).

## Pricing

`GET /v1/pricing?sizeBytes=<integer>`

Advisory only. The runtime x402 `402` challenge is authoritative.

- Validates `0 <= sizeBytes <= 104857600`.
- Returns `sizeBytes`, `billableMiB`, `priceUsd`, `priceAtomic`
  (USDC six-decimal), `priceAtomicString`, `limits`, `network`,
  `retention`.

Formula: `$0.01` flat + `$0.002` per started MiB after the first, capped at
`$0.208` for 100 MiB.

| Size             | Permanent price |
| ---------------- | --------------- |
| empty – 1 MiB    | $0.01           |
| 1 MiB + 1 byte   | $0.012          |
| 10 MiB           | $0.028          |
| 100 MiB          | $0.208          |

## Temporary upload

### Reserve — `POST /v1/uploads/temporary`

Header: `Idempotency-Key: <random >= 32 high-entropy chars>` (required).

Body:

```json
{
  "filename": "result.json",
  "contentType": "application/json",
  "sizeBytes": 1234,
  "sha256": "<64 lowercase hex>"
}
```

Fails before reserving if `sizeBytes > 1 MiB` (413). Quota is reserved
atomically; repeating the same `Idempotency-Key` returns the existing
reservation without consuming quota again.

`201` returns the full reservation including `uploadToken`, `deleteToken`,
`uploadUrl`, `publicUrl`, `uploadDeadline`, and `expiresAt`.

Errors: `400` validation, `413` payload too large, `429` `quota_exceeded`.

### PUT /v1/uploads/{id}/content

Stream the bytes.

- `Authorization: Bearer <uploadToken>`
- exact `Content-Length` matching the reservation (chunked rejected)
- `Content-Type: application/octet-stream`
- R2 verifies the SHA-256 while streaming (`integrity_check` on mismatch)

`201` returns canonical public URL, size, SHA-256, retention, expiry, ETag.
If D1 finalization fails after R2 succeeded, the object is compensated
(deleted) and a loud error is returned.

## Permanent (paid) upload

### POST /v1/uploads/permanent

Same metadata body as temporary. `sizeBytes <= 100 MiB`.

1. An unpaid request returns **`402`** with an exact Base USDC amount in the
   `PAYMENT-REQUIRED` header, computed from `sizeBytes`. Its
   `maxTimeoutSeconds` is 3600, producing a one-hour EIP-3009 authorization.
2. The client pays (x402) and the facilitator settles it.
3. After settled, a reservation is created and the **`201`** is returned with
   `expiresAt: null`, the exact settled price, and payment network.

Idempotent short-circuit: a retry with the same `Idempotency-Key` returns the
existing funded reservation without charging again.

An expired, unused paid slot is not automatically refunded in v1. Payment
purchases the slot.

The production permanent tier is enabled on Base mainnet. See
`docs/operations.md`.

## Status

### GET /v1/uploads/{id}

Returns reservation/file metadata without secrets or payment authorization
data. `expired`/`deleted` → `410`, unknown → `404`.

### HEAD /f/{id}/{filename}

Metadata without a body; same headers as GET.

## Download

### GET /f/{id}/{filename}

Streams a ready object. A mismatched filename redirects (301) to the
canonical URL. Supports ETag conditional requests and byte ranges for agent
resumability.

- unknown → `404`
- known expired/deleted → `410 Gone`
- temporary reads check expiry before touching R2 (availability ends at
  exactly 24h regardless of delayed physical deletion)
- permanent → `Cache-Control: public, max-age=31536000, immutable`
- temporary → `Cache-Control: private, no-store`
- active content (`text/html`, SVG, XML, JavaScript, unknown executable)
  is served as an attachment; safe headers include
  `X-Content-Type-Options: nosniff`, a restrictive CSP, and safe
  `Content-Disposition`.

## Delete

### DELETE /v1/uploads/{id}

`Authorization: Bearer <deleteToken>`. Deletes from R2, marks the row
deleted, and later reads return `410`. Idempotent.

## Feedback

### POST /v1/feedback

```json
{
  "category": "feature_request",
  "message": "A 7-day temporary retention option would be useful.",
  "rating": 4,
  "relatedUploadId": "p_iMm5d...",
  "requestId": "req_01J...",
  "client": { "name": "opencode", "version": "2.0" }
}
```

- category: `bug | feature_request | usability | pricing | other`
- `message`: plain text, 1..4000 chars
- optional `rating` 1..5, `relatedUploadId`, `requestId`, bounded `client`
- no arbitrary metadata, attachments, HTML, contact details, or credentials.

Returns `202` with `feedbackId`, `status: "accepted"`, `receivedAt` — never
echoes the message. There is no public read/list endpoint. Retention is
configurable (365 days default), then purged by the scheduler.

Never submit secrets or personal information.

## Discovery

- `GET /` — landing page with pricing, limits, retention/privacy wording.
- `GET /docs` — documentation hub.
- `GET /openapi.json` — canonical contract.
- `GET /llms.txt` — agent instructions + a complete example.
- `GET /.well-known/x402` — x402 resource-server discovery metadata.
- `GET /health` — process health (not a dependency probe).

## Idempotency

- Reservation routes require a high-entropy `Idempotency-Key` (≥32 chars).
- Repeats return the existing reservation without re-charging or re-reserving
  quota.
- The key is a recovery credential; derivation of upload/delete tokens is
  server-side from the reservation ID.

## Retention & deletion wording

"Permanent" means **no scheduled expiration**, subject to uploader deletion,
abuse/legal removal, and service availability. It is not a guarantee of
literal eternal retention. Temporary files are unavailable exactly 24 hours
after a successful upload.
