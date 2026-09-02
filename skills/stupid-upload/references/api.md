# Stupid Upload — API & limits (compact)

Base: `STUPID_UPLOAD_BASE_URL` (default `https://upload.stupidtech.net`).
Advertised machine contract: `/openapi.json`. Use the CLI for the paid path.

## Limits

- Temporary: ≤ 1 MiB, free; expires exactly 24 h after a successful upload.
  20 MiB/day/source reserved at request time.
- Permanent: ≤ 100 MiB, paid via x402; no scheduled expiration (subject to
  uploader deletion, abuse/legal removal, availability).

## Pricing

`$0.01` flat + `$0.002` per started MiB after the first (max `$0.208` / 100 MiB).
`GET /v1/pricing?sizeBytes=N` is advisory; the runtime x402 `402` is authoritative.

| Size          | Price  |
| ------------- | ------ |
| empty – 1 MiB | $0.01  |
| 1MiB+1byte    | $0.012 |
| 10 MiB        | $0.028 |
| 100 MiB       | $0.208 |

## Endpoints

- `POST /v1/uploads/temporary` — reserve a slot (needs a high-entropy
  `Idempotency-Key`). Body `{ filename, contentType, sizeBytes, sha256 }`.
- `POST /v1/uploads/permanent` — paid. Once production enables it, an unpaid
  request returns `402` + `PAYMENT-REQUIRED`; the exact challenge is Base USDC.
  A retry with the same Idempotency-Key returns the existing (funded)
  reservation without charging again. A solved payment is returned as the
  `PAYMENT-SIGNATURE` header (base64 JSON `PaymentPayload`).
- `PUT /v1/uploads/{id}/content` — stream bytes with `Authorization: Bearer
<uploadToken>`, exact `Content-Length`, `application/octet-stream`.
- `GET /v1/uploads/{id}` — status (no secrets).
- `GET /f/{id}/{filename}` / `HEAD` — download with ranges + conditional.
- `DELETE /v1/uploads/{id}` — Bearer `<deleteToken>`, idempotent.
- `POST /v1/feedback` — `{ category, message, rating?, ...}` → `202`.
- `GET /v1/pricing`, `GET /health`, `GET /`, `/docs`, `/openapi.json`.

## Errors

`{ "error": { "code", "message" } }` with codes: `validation_error`,
`invalid_request`, `quota_exceeded`, `unauthorized`, `not_found`, `gone`,
`conflict`, `payload_too_large`, `rate_limited`, `payment_required`,
`integrity_check`, `server_error`.

## Idempotency

`Idempotency-Key` (≥32 high-entropy chars) is required on every reservation
route. Repeats return the existing reservation without consuming quota.

## CLI

The CLI is the `stupid-upload` npm package (`npm i -g stupid-upload`). It emits
stable JSON. The paid path without a key builds the exact EIP-3009 payment via
the `@x402/evm` scheme, asks the wallet to sign via txlink `wallet_sign`
(type `0x01`, account substitution), then submits the replaced signature +
payer as `PAYMENT-SIGNATURE`. Set `STUPID_UPLOAD_PRIVATE_KEY` to sign + settle
automatically instead. Successful uploads are recorded in a local registry
(`STUPID_UPLOAD_STATE_FILE`, default `~/.stupid-upload/uploads.json`, mode
0600): `list` shows them (no tokens) and `delete <id>` uses the recorded delete
token automatically.
