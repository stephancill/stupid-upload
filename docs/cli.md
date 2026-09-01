# Stupid Upload — CLI

The `stupid-upload` CLI is a deterministic JSON tool bundled in the
self-contained skill at `skills/stupid-upload`. It's invoked with bun
(`scripts/stupid-upload.ts`) and emits stable JSON to stdout. Structured
errors go to stderr with a documented exit code, so agents can parse output
without scraping prose.

## Install

The skill is self-contained; from the skill directory run with bun:

```sh
bun ./scripts/stupid-upload.ts <command>
# or, from an environment where it's on PATH:
stupid-upload <command>
```

## Environment

- `STUPID_UPLOAD_BASE_URL` — API base (default `https://upload.stupidtech.net`).
- `TXLINK_BASE_URL` — txlink host for signature requests (default
  `https://txlink.stupidtech.net`).
- `STUPID_UPLOAD_PRIVATE_KEY` — when set, `upload --permanent` signs and pays
  locally via `@x402/evm` + `@x402/fetch` (`wrapFetchWithPayment`): the CLI
  auto-pays the server's x402 challenge and returns the paid reservation.
  Needs a funded Base Sepolia account (and a live, reachable facilitator);
  never read the key from a CLI flag.

## Commands

```text
stupid-upload quote <path>
stupid-upload upload <path> --temporary
stupid-upload upload <path> --permanent
stupid-upload status <id>
stupid-upload delete <id> [--token <delete-token>]
stupid-upload feedback --category <category> --message <text> [--rating 1-5]
```

## Output

- Exit `0` only on success. Nonzero: `1` usage, `2` validation, `3` quota,
  `4` payment, `5` network, `6` integrity, `7` server.
- Temporary upload success prints the reservation, including `publicUrl`,
  `uploadToken`, `deleteToken`, `expiresAt`.
- Paid (`--permanent`):
  - with `STUPID_UPLOAD_PRIVATE_KEY` set, signs + pays via `@x402/fetch`'s
    `wrapFetchWithPayment` and returns the settled reservation in one call;
  - without a key, returns an `awaitingSignature` object with the txlink
    `signatureRequest.url` and `statusUrl`. Approve in a wallet, poll
    `statusUrl`, then retry with the same `Idempotency-Key` to claim the slot
    without re-paying.

## Examples

```sh
stupid-upload quote ./report.pdf
stupid-upload upload ./report.pdf --temporary
stupid-upload upload ./report.pdf --permanent   # -> returns signatureRequest.url
stupid-upload status p_8A...
stupid-upload feedback --category bug --message "xyz"
```

## Security

- Never pass a private key or delete token on the command line of a shared
  system; prefer `STUPID_UPLOAD_PRIVATE_KEY` / `STUPID_UPLOAD_DELETE_TOKEN`.
- `feedback` never includes local paths, env values, or file contents beyond
  the message you provide.