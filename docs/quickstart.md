# Quickstart

This guide covers the v1 API using curl. The permanent (paid) tier lands with
x402 integration; until then the endpoint is not enabled in production.

## Base URL

Default API host: `https://upload.stupidtech.net`. Override for local/testing:
`STUPID_UPLOAD_BASE_URL`.

## Temporary upload (free)

1. Compute the payload's size and SHA-256:
   ```sh
   F=result.json
   SIZE=$(stat -f%z "$F")                      # macOS
   SHA=$(openssl dgst -sha256 -r "$F" | cut -d' ' -f1)
   ```
2. Reserve a slot (repeat the same `Idempotency-Key` to recover the slot):
   ```sh
   IDEM=$(openssl rand -base64 24 | tr '+/' '-_')
   curl -sS -X POST "$STUPID_UPLOAD_BASE_URL/v1/uploads/temporary" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: $IDEM" \
     -d "{\"filename\":\"result.json\",\"contentType\":\"application/json\",\"sizeBytes\":$SIZE,\"sha256\":\"$SHA\"}"
   ```
   The `201` response includes `uploadToken`, `deleteToken`, `uploadUrl`,
   `publicUrl`, `uploadDeadline`, and `expiresAt`.
3. Upload the bytes (exact `Content-Length`, `application/octet-stream`):
   ```sh
   curl -sS -X PUT "$UPLOAD_URL" \
     -H "Authorization: Bearer $UPLOAD_TOKEN" \
     -H "Content-Type: application/octet-stream" \
     -H "Content-Length: $SIZE" \
     --data-binary @"$F"
   ```
4. Download: `curl -sS "$PUBLIC_URL"`. It expires exactly 24 h after step 3.
5. Delete: `curl -sS -X DELETE "$BASE/v1/uploads/$ID" -H "Authorization: Bearer $DELETE_TOKEN"`.

## Permanent upload (paid, x402)

The x402 flow is integrated (Phase 4): an unpaid `POST /v1/uploads/permanent`
returns a `402` with an **exact** Base USDC amount computed from the request's
`sizeBytes`. After complying, the client signs the payment and the facilitator
settles it; then a reservation is created and the `201` response is returned.

1. `POST /v1/uploads/permanent` with the metadata body (includes `sizeBytes`)
   and a high-entropy `Idempotency-Key` → read the `PAYMENT-REQUIRED` header's
   exact amount.
2. Pay it with an x402 client (the npm CLI uses `@x402/evm`) and resend with
   `PAYMENT-SIGNATURE`.
3. On success the `201` reservation includes `expiresAt: null` and the settled
   `priceAtomic`/`paymentNetwork`.

Idempotent recovery: retrying a settled request with the same key returns the
existing reservation without charging again.

### Via the CLI (no key)

Install the Node.js 22+ `stupid-upload` CLI, then run the permanent upload.
Approve the printed wallet URL; the command submits the signed payment and
uploads the file without receiving your private key:

```sh
npm install --global stupid-upload@0.0.2
stupid-upload upload ./report.pdf --permanent --max-price-usd 0.05
```

`--max-price-usd` caps the amount and fails closed before any wallet prompt if
the server's quote exceeds it (default cap is the v1 maximum). Machine output
goes to stdout; a single `approvalRequired` JSON pointing at the wallet URL is
written to stderr.

## Pricing

`GET /v1/pricing?sizeBytes=<integer>` returns advisory pricing. The runtime
x402 challenge is authoritative.

| Size             | Permanent price |
| ---------------- | --------------- |
| empty – 1 MiB    | $0.01           |
| 1 MiB + 1 byte   | $0.012          |
| 10 MiB           | $0.028          |
| 100 MiB          | $0.208          |

## Notes

- Quotas are reserved at reservation time (20 MiB/source/day for temporary).
- An expired, unused slot is not refunded in v1.
- Public URLs are bearer-like: don't upload secrets.
