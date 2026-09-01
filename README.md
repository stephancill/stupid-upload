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
migrations/           D1 schema
test/                 Vitest suite
docs/                 handover, api, implementation notes, quickstart, ...
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

A self-contained CLI + skill ships under `skills/stupid-upload`:

```sh
bun skills/stupid-upload/scripts/stupid-upload.ts quote ./file
bun skills/stupid-upload/scripts/stupid-upload.ts upload ./file --temporary
```

See `docs/cli.md` and the skill's `SKILL.md`/`references/api.md`. The paid
`upload --permanent` path returns a **txlink signature request URL** when no
private key is configured, so an agent without a signer can route approval to
a human and poll for the result.

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