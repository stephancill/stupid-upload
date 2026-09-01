---
name: stupid-upload
description: Upload, share, quote, inspect, download, or delete files via Stupid Upload, and submit product feedback. Trigger for requests to upload a local file, create an expiring or permanent public URL, quote upload storage cost, inspect/download a Stupid Upload file or its status, delete an uploaded file, or pay a permanent upload (x402 / Base). Read references/api.md for limits, pricing, headers, errors, and the paid (txlink) flow.
---

# Stupid Upload

Accountless, agent-first public file uploads on Cloudflare. Temporary files
expire 24h after upload; permanent files have **no scheduled expiration** and
are paid with Base USDC via x402.

## Guidance

- A user shares / uploads a local file → **quote** it, then decide retention.
- Small (≤1 MiB), anything disposable → **temporary** (free).
- Larger (≤100 MiB) or long-lived → **permanent** (paid). Quote the price first.
- To fetch the current state → **status <id>**; to read bytes → **download**.
- **delete** with the delete token (a bearer credential, keep it off
  shared processes).
- For product feedback → **feedback** (`--category`, `--message`, optional
  `--rating`). Never echo secrets into the message.

## Flow

Use the bundled CLI (see `scripts/stupid-upload.ts`) or the raw HTTP API in
`references/api.md`. Input a `->` tag to a command is fine, e.g.:

```sh
stupid-upload quote ./report.pdf
stupid-upload upload ./report.pdf --temporary
stupid-upload upload ./report.pdf --permanent
```

## Paid uploads & txlink

`upload --permanent` first fetches an exact x402 `402` challenge for the
file's size. Then, when a key is available, the CLI signs locally; this paid
local-signing path is a later E2E and not yet finished the CLI. When **no
private key** is configured, `upload --permanent` creates a **txlink stored
request** and returns:

```json
{
  "status": "awaitingSignature",
  "signatureRequest": { "url": "https://txlink.stupidtech.net/...", "statusUrl": "..." }
}
```

Send `signatureRequest.url` to the user's wallet to approve; poll `statusUrl`
for completion. After the signature is returned you can re-run the same upload
with the same `Idempotency-Key` to pick up the funded slot without a re-pay.

## Secrets & hygiene

- Never print, persist, or log `STUPID_UPLOAD_PRIVATE_KEY` or delete tokens.
- The `delete` delete-token may be passed on a shared system via
  `STUPID_UPLOAD_DELETE_TOKEN` (env) instead of `--token`.
- Public URLs are bearer-like: do not upload secrets to Stupid.
