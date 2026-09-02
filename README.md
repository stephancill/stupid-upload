# Stupid Upload

Accountless, agent-first public file uploads on Cloudflare Workers.

Temporary files are free and become unavailable exactly 24 hours after upload.
Permanent files have **no scheduled expiration** and are paid with Base USDC via
x402 (subject to uploader deletion, abuse/legal removal, and service
availability — never a literal eternal-storage promise).

- **Temporary:** free, ≤ 1 MiB, 24 h expiry, 20 MiB/day/source.
- **Permanent:** paid, ≤ 100 MiB, `$0.01` flat + `$0.002` per started MiB
  beyond the first (max `$0.208`).
- **Access:** public, unlisted, random URLs; no accounts, no listing.

## Repo layout

```text
src/                  Hono Worker (app, routes, pricing, quota, security, ...)
cli/                  Node CLI package published to npm
migrations/           D1 schema
test/                 Vitest suite
docs/                 handover, api, implementation notes, quickstart, ...
skills/stupid-upload/  Agent instructions and compact API reference
AGENTS.md             agent rules
wrangler.jsonc        Worker bindings (R2, D1, rate limit)
```

## Prereqs

- [Bun] ≥ 1.x
- A Cloudflare account (for deploy; not needed to run tests)

[Bun]: https://bun.sh

## Install

```sh
bun install
```

## Commands

| Task          | Command               |
| ------------- | --------------------- |
| Dev server    | `bun run dev`         |
| Tests         | `bun run test`        |
| Typecheck     | `bun run typecheck`   |
| Lint          | `bun run lint`        |
| Format        | `bun run format`      |

## CLI & agent skill

A Node CLI is published on npm as `stupid-upload` (source in `cli/`). The agent
skill under `skills/stupid-upload` requires the pinned npm package:

```sh
npm i -g stupid-upload@0.0.2
stupid-upload quote ./file
stupid-upload upload ./file
```

See `docs/cli.md` and the skill's `SKILL.md`/`references/api.md`. The paid
`upload --permanent` path signs via txlink (`wallet_sign` with account
substitution) when no private key is configured, routing approval to a human
wallet and settling automatically.

## Local dev

```sh
bun install
bun run dev
```

`.env.example` documents the environment variables. Copy it to your local
environment file (e.g. `.dev.vars`), fill in `STUPID_UPLOAD_HMAC_SECRET` and
`STUPID_UPLOAD_ADMIN_SECRET`, then start the dev server.

See `docs/quickstart.md` for a curl walkthrough and `docs/api.md` for the
machine-level contract. `/openapi.json` on a running worker is the canonical
openapi schema.
