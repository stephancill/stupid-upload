# AGENTS.md

Rules for AI agents working in this repository.

## Stack

- Bun (package manager, scripts, runtime-local tooling).
- TypeScript, strict compiler settings (see `tsconfig.json`).
- Hono on Cloudflare Workers with R2 (file bodies), D1 (metadata/quota),
  and (later) the Rate Limiting binding.
- Zod for all runtime validation.
- Vitest for tests. Oxfmt for formatting; oxlint for linting.

## Before making changes

- Read `docs/` for planning and API contracts:
  - `docs/handover.md` — the approved v1 specification.
  - `docs/implementation-notes.md` — recorded decisions and the change log.
- Read `relevant` docs for any feature you alter (pricing, quotas, x402).
- Prefer documenting a material decision in `docs/implementation-notes.md`
  over leaving an implicit one in code.

## Committing

- Format with `bun run format`, lint with `bun run lint`, typecheck with
  `bun run typecheck`, and run `bun run test` before committing.
- Update `docs/implementation-notes.md` (change log + decisions) when a commit
  makes a material change. Do not include secrets or personal information.
- Use Conventional Commits (e.g. `feat:`, `fix:`, `chore:`).

## Environment & secrets

- `.env.example` documents every required/optional variable. Do not commit
  `.env` or `.env.local`. `wrangler.jsonc` declares the bindings; secrets go in
  `wrangler secret put` / CI secrets, never the committed config.
- `STUPID_UPLOAD_HMAC_SECRET` hashes privacy-sensitive inputs (client IPs) and
  the admin secret protects the abuse/legal takedown endpoint.
- Cloudflare automatically deploys production from `main`. Do not run a manual
  production deploy unless the user explicitly requests it.

## Commands

- `bun run dev` — local Wrangler dev server.
- `bun run test` — Vitest suite.
- `bun run typecheck` — `tsc --noEmit`.
- `bun run lint` — oxlint.
- `bun run format` — oxfmt.

## Conventions

- Prefer named function parameters over positional ones.
- Validate all request metadata/query/header inputs with Zod.
- Never store or log raw IPs, bearer tokens, payment headers, or file bodies.
- Serve active content as attachments; keep file responses optimised with
  `X-Content-Type-Options: nosniff` and safe `Content-Disposition`.
