# stupid-upload

CLI for [Stupid Upload](https://upload.stupidtech.net) — an accountless,
agent-first public file upload service on Cloudflare.

- **Temporary** uploads: free, ≤ 1 MiB, expire 24 h.
- **Permanent** uploads: ≤ 100 MiB, no scheduled expiration, paid in Base USDC
  via [x402](https://x402.org) — payable from your own wallet or a private key.

## Install

```sh
npm i -g stupid-upload
# or use without installing:
npx stupid-upload --help
```

## Usage

```sh
stupid-upload quote ./report.pdf
stupid-upload upload ./report.pdf --temporary
stupid-upload upload ./report.pdf --permanent [--max-price-usd 0.05]
stupid-upload list                # locally-recorded uploads
stupid-upload status <id>
stupid-upload download <url-or-id> --output <path>
stupid-upload delete <id>         # uses the recorded delete token
stupid-upload feedback --category <c> --message <m> [--rating 1-5]
```

- Stable JSON on stdout; structured errors on stderr; documented exit codes.
- `upload --permanent` without `STUPID_UPLOAD_PRIVATE_KEY` asks a wallet to sign
  via txlink (EIP-3009, account substitution) and settles automatically.
- Successful uploads are recorded in `~/.stupid-upload/uploads.json` (mode 0600) so `list` / `delete <id>` work without re-supplying tokens.

## Environment

- `STUPID_UPLOAD_BASE_URL` — API base (default `https://upload.stupidtech.net`).
- `STUPID_UPLOAD_PRIVATE_KEY` — set to sign + auto-pay permanent uploads locally.
- `STUPID_UPLOAD_DELETE_TOKEN`, `STUPID_UPLOAD_STATE_FILE`,
  `STUPID_UPLOAD_SIGN_TIMEOUT_MS`, `TXLINK_BASE_URL` — see `--help`.

Never pass a private key or delete token on a shared command line.
