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

## Requisites

This skill uses the **`stupid-upload` npm CLI**. Ensure it is installed before
invoking it (or rely on an agent runtime that provides it):

```sh
npm i -g stupid-upload     # or: npx stupid-upload ...
```

The CLI is a single Node binary; it records your uploads in
`~/.stupid-upload/uploads.json` so you can `list` and `delete <id>` without
digging for tokens. The raw HTTP contract lives in `references/api.md` if you
need to call the API directly.

## Flow

Use the CLI (or the raw HTTP API in `references/api.md`). For example:

```sh
stupid-upload quote ./report.pdf
stupid-upload upload ./report.pdf --temporary
stupid-upload upload ./report.pdf --permanent
```

## Paid uploads

`upload --permanent` first fetches an exact x402 `402` challenge for the
file's size.

- If `STUPID_UPLOAD_PRIVATE_KEY` is set, the CLI signs and pays locally.
- Without a key, the CLI drives the EIP-3009 payment through a capturing
  signer, asks a wallet to sign the transfer via **txlink** (`wallet_sign` with
  account substitution), then submits the `PAYMENT-SIGNATURE`. It prints one
  `approvalRequired` JSON line to **stderr** (with the approval url) and waits
  (bounded by `STUPID_UPLOAD_SIGN_TIMEOUT_MS`); after the wallet approves it
  completes the upload in one invocation.

A run interrupted after settlement can be retried with the same
`Idempotency-Key` to pick up the funded slot without re-paying.

## Secrets & hygiene

- Never print, persist, or log `STUPID_UPLOAD_PRIVATE_KEY` or delete tokens.
- The `delete` delete-token may be passed on a shared system via
  `STUPID_UPLOAD_DELETE_TOKEN` (env) instead of `--token`.
- Public URLs are bearer-like: do not upload secrets to Stupid.
