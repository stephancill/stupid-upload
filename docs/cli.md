# Stupid Upload — CLI

The `stupid-upload` CLI is a deterministic JSON tool published to npm as the
`stupid-upload` package (Node ≥22) and also lives at `cli/` in this repository.
It emits stable JSON to stdout; structured errors go to stderr with a
documented exit code, so agents can parse output without scraping prose.

## Install / run

From npm (recommended):

```sh
npm i -g stupid-upload@0.0.2
stupid-upload <command>
# or, without installing:
npx --yes stupid-upload@0.0.2 <command>
```

From the repository:

```sh
cd cli && npm run build     # bundles to cli/dist/stupid-upload.mjs
node ./dist/stupid-upload.mjs <command>
```

## Environment

- `STUPID_UPLOAD_BASE_URL` — API base (default `https://upload.stupidtech.net`).
- `TXLINK_BASE_URL` — txlink host for signature requests (default
  `https://txlink.stupidtech.net`).
- `STUPID_UPLOAD_PRIVATE_KEY` — when set, `upload --permanent` signs and pays
  locally via `@x402/evm` + `@x402/fetch` (`wrapFetchWithPayment`): the CLI
  auto-pays the server's x402 challenge and returns the paid reservation.
  Needs a funded Base account (and a live, reachable facilitator); never read
  the key from a CLI flag.
- `STUPID_UPLOAD_SIGN_TIMEOUT_MS` — how long `upload --permanent` waits for a
  human to approve the no-key txlink signature (default 5 minutes).
- `STUPID_UPLOAD_STATE_FILE` — local upload-registry JSON path (default
  `~/.stupid-upload/uploads.json`). Holds bearer delete tokens, so it's created
  mode `0600`; keep it private and never share or commit it.

## Commands

```text
stupid-upload quote <path>
stupid-upload upload <path> [--temporary]
stupid-upload upload <path> --permanent [--max-price-usd <n>]
stupid-upload status <id>
stupid-upload list
stupid-upload delete <id> [--token <delete-token>]
stupid-upload feedback --category <category> --message <text> [--rating 1-5]
```

## Local registry

Every successful `upload` is recorded in the local registry (default
`~/.stupid-upload/uploads.json`, override with `STUPID_UPLOAD_STATE_FILE`). Each
entry stores the upload id, source path, public URL, size/hash, retention and
the bearer delete token.

- `stupid-upload list` prints the recorded uploads (public fields only — never
  delete tokens).
- `stupid-upload delete <id>` deletes using the **recorded** delete token when
  neither `--token` nor `STUPID_UPLOAD_DELETE_TOKEN` is given, and removes the
  entry from the list on success.

The state file holds bearer delete credentials: it is written with mode `0600`.
Keep it private, add it to `.gitignore` if the CLI ever runs inside a repo, and
rotate by deleting the file (you'll lose the convenience of token-less deletes).

`--max-price-usd` (permanent) caps the quoted payment at `n` US dollars; it
fails closed before any wallet is invoked if the server's x402 amount exceeds
the cap. Default cap is the v1 maximum ($0.2085).

`upload <path>` defaults to temporary retention; `--temporary` remains an
explicit equivalent. EIP-3009 authorizations for permanent uploads expire one
hour after creation (`maxTimeoutSeconds: 3600`).

## Output

- Exit `0` only on success. Nonzero: `1` usage, `2` validation, `3` quota,
  `4` payment, `5` network, `6` integrity, `7` server.
- Temporary upload success prints the reservation, including `publicUrl`,
  `uploadToken`, `deleteToken`, `expiresAt`.
- Paid (`--permanent`):
  - with `STUPID_UPLOAD_PRIVATE_KEY` set, signs + pays via `@x402/fetch`'s
    `wrapFetchWithPayment` and returns the settled reservation in one call;
  - without a key, the CLI builds the exact x402 payment via the **submit
    seam** (`cli/src/submit-exact.ts`): it drives the `@x402/evm` scheme, asks a
    wallet to sign the EIP-3009 transfer over txlink (`wallet_sign`, account
    substitution), then splices the returned signature + `account` into the
    payload and re-POSTs it as the `PAYMENT-SIGNATURE` header so the
    facilitator settles `exact`. You
    approve the payment in your wallet; the command then completes the
    upload and prints the reservation. It prints a structured
    `approvalRequired` JSON line to **stderr** with the wallet URL, then polls
    `statusUrl` until signed or the timeout elapses. A settled `402` means CDP
    rejected the signature; the reason (when the server echoes it on the
    `payment-required` header) is surfaced as the error.

## Examples

```sh
stupid-upload quote ./report.pdf
stupid-upload upload ./report.pdf
stupid-upload upload ./report.pdf --permanent   # prints a wallet url, then settles
stupid-upload upload ./media/video.mp4 --permanent --max-price-usd 0.05
stupid-upload status p_8A...
stupid-upload feedback --category bug --message "xyz"
```

## Security

- Never pass a private key or delete token on the command line of a shared
  system; prefer `STUPID_UPLOAD_PRIVATE_KEY` / `STUPID_UPLOAD_DELETE_TOKEN`.
- `feedback` never includes local paths, env values, or file contents beyond
  the message you provide.
