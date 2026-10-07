# Fydio

**Curated Feeds** — a private, interest-led discovery network for creators and the
people whose work they trust. Discover relevant content from people you know, open it
in its original context, and give feedback that helps them improve.

This repository is at **T10**: full product implementation, including the optional Chrome MV3 companion extension, standalone Next.js Dockerfile, Coolify v4.11 production compose overlay, operational runbooks, and automated backup/restore/smoke tooling.

---

## Quick start

```bash
# One command: checks prerequisites, installs, generates secrets, starts the stack.
pnpm bootstrap --start

# Or, step by step:
pnpm install          # install workspace dependencies
pnpm secrets:generate # create .env and docker/.env with real secrets
pnpm dev:stack        # start the local Supabase stack (waits until healthy)
pnpm dev              # start the web app on http://localhost:3000
```

Then open:

| Service      | URL                   | Notes                                             |
| ------------ | --------------------- | ------------------------------------------------- |
| Web app      | http://localhost:3000 | renders "Fydio is running" plus live stack health |
| Studio       | http://localhost:3002 | user `supabase`, password in `docker/.env`        |
| Supabase API | http://localhost:8000 | the only Supabase port the app talks to           |
| Mailpit      | http://localhost:8025 | captures every Auth email                         |

Verify everything at once:

```bash
pnpm dev:stack:health   # 10 checks: containers, HTTP, Postgres, JWT consistency
```

---

## Requirements

- Node **>= 22**
- pnpm **10.5.2** (`corepack enable`)
- Docker with Compose v2+
- `openssl`
- Optional: the Supabase CLI (`brew install supabase/tap/supabase`) for `pnpm db:*`

---

## Layout

```
fydio/
├── apps/
│   ├── web/                # @fydio/web — Next.js 16 App Router
│   └── extension/          # @fydio/extension — Chrome MV3 (placeholder in T01)
├── packages/
│   ├── config-typescript/  # shared tsconfig presets
│   ├── config-eslint/      # shared flat ESLint configs
│   ├── config-tailwind/    # shared Tailwind v4 theme tokens
│   ├── env/                # zod-validated environment contract
│   ├── supabase/           # browser / server / service clients
│   ├── domain/             # platform parsing, URL canonicalization, ranking
│   └── ui/                 # shared primitives + `cn()`
├── supabase/               # migrations (source of truth), config.toml, seed.sql
├── docker/                 # the self-hosted Supabase stack
├── scripts/                # secret generation, health checks, bootstrap
└── tasks/                  # the implementation plan
```

---

## Commands

| Command                                | What it does                                            |
| -------------------------------------- | ------------------------------------------------------- |
| `pnpm dev`                             | run all dev servers                                     |
| `pnpm validate`                        | **lint + typecheck + test + build** — the CI gate       |
| `pnpm format` / `format:check`         | Prettier                                                |
| `pnpm dev:stack`                       | start the local Supabase stack and wait for health      |
| `pnpm dev:stack:down`                  | stop it                                                 |
| `pnpm dev:stack:reset`                 | destroy volumes, recreate, re-apply migrations          |
| `pnpm dev:stack:health`                | verify the stack is genuinely usable                    |
| `pnpm dev:stack:logs`                  | tail all stack logs                                     |
| `pnpm secrets:generate`                | create/fill `.env` and `docker/.env` (idempotent)       |
| `pnpm db:migrate`                      | apply pending migrations                                |
| `pnpm db:reset`                        | drop, re-apply migrations, re-seed                      |
| `pnpm db:seed`                         | run `supabase/seed.sql`                                 |
| `pnpm db:types`                        | regenerate `packages/supabase/src/types.generated.ts`   |
| `pnpm bootstrap`                       | one-command setup                                       |
| `pnpm --filter @fydio/extension build` | bundle Chrome MV3 companion extension to `dist/`        |
| `bash scripts/smoke-prod.sh`           | run post-deploy production health checks                |
| `bash scripts/backup.sh`               | dump public/auth/storage database to timestamped file   |
| `bash scripts/restore.sh <f>`          | restore database from dump with permission verification |

---

## The environment contract

`packages/env` is the **only** place allowed to read `process.env`. Everything else
imports `getServerEnv()` / `getClientEnv()`, which return validated, typed values.

This is enforced by the `fydio/no-process-env` lint rule, not by convention:

```
error  Do not read process.env here. Use getServerEnv()/getClientEnv()
       from @fydio/env so the value is validated and typed.
```

The contract is split by trust boundary:

- `@fydio/env/server` — server-only, guarded by `import 'server-only'`
- `@fydio/env/client` — browser-visible, `NEXT_PUBLIC_*` keys only
- `@fydio/env` — schemas and types only, never live parsed values

A malformed value fails at boot with a message that names the variable:

```
Server environment failed validation:
  • NEXT_PUBLIC_SUPABASE_URL: Invalid URL

Missing required variable(s): NEXT_PUBLIC_SUPABASE_URL
Check your .env (copy it from .env.example) and restart.
```

`apps/web/src/instrumentation.ts` validates on startup, so a misconfigured deployment
fails immediately rather than on the first request that needs a variable.

> **One `.env`.** Next.js only reads `.env` from the app directory, so
> `apps/web/.env` is a symlink to the root `.env`. There is still exactly one source
> of truth, and `pnpm secrets:generate` writes to it.

---

## Supabase stack

Self-hosted, vendored from `supabase/supabase`, trimmed for a laptop:
`vector` and `analytics` are removed, and the database and Storage use **named
volumes** rather than bind mounts (Supabase Storage's file backend is unreliable on
macOS bind mounts).

See [`docker/README.md`](docker/README.md) for operations notes and the pinned image
versions.

### Secrets

`pnpm secrets:generate` fills in **only the blanks** — it never rotates a live
secret, so it is safe to re-run. The `ANON_KEY` and `SERVICE_ROLE_KEY` are signed
with the same `JWT_SECRET` the gateway validates against; `pnpm dev:stack:health`
asserts that, because a mismatch there presents as "auth silently does nothing".

---

## Testing

```bash
pnpm test          # all packages
pnpm validate      # the full CI gate
```

| Package           | Covers                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `@fydio/env`      | schema validation, defaults, bounds, and the negative test proving the client entry cannot see server secrets |
| `@fydio/domain`   | `detectPlatform` on 30+ real URL shapes, URL canonicalization idempotency, the ranking formula                |
| `@fydio/ui`       | `cn()` conflict resolution                                                                                    |
| `@fydio/supabase` | live-stack health through the gateway (skipped when no stack is running)                                      |

The live-stack test skips cleanly in CI, which has no Supabase stack.

---

## Conventions

- **TypeScript strict**, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  These are why a fair amount of code has explicit guards — they catch real bugs.
- **`verbatimModuleSyntax`** — type-only imports must say `import type`.
- Formatting is Prettier; linting is ESLint 10 flat config.

### A note on TypeScript

The repo pins **TypeScript 5.9.3**, not 7.x. TypeScript 7 is the native Go port and
no longer ships a JavaScript compiler API, which `typescript-eslint` requires; the
tooling caps support at `<6.1.0`, and `eslint-config-next` depends on it. Revisit when
typescript-eslint ships TS 7 support.

---

## Deployment & Operations

Fydio is deployable to Coolify v4.11 as two resources from this repository:

1. **Supabase Compose** (`docker/docker-compose.yml` + `docker/docker-compose.prod.yml`) — Database, Auth, Storage, and Kong API gateway with named persistent volumes.
2. **Next.js Web Application** (`apps/web/Dockerfile`) — Multi-stage standalone Node 22 Alpine build with non-root runtime.

Detailed operational runbooks:

- [Coolify Deployment Runbook](docs/runbook/deploy-coolify.md) — Two-resource setup, environment variables, cron scheduling, and TLS.
- [Operations & Runbook](docs/runbook/operations.md) — Backups, restores, secret rotations, and zero-downtime upgrades.
- [Database Architecture & Data Model](docs/architecture/data-model.md) — Production schema, RLS policies, RPCs, and indexes.

---

## Chrome Companion Extension

The companion extension (`apps/extension/`) is an optional Manifest V3 extension providing return-to-tab detection and coarse duration mapping:

- **Strict Privacy Invariant**: Raw duration is immediately mapped into 5 coarse bands (`lt_15s`, `s15_60`, `m1_3`, `gt_3`, `unknown`). Raw timestamps are never stored or transmitted.
- **Minimal Permissions**: Restricted strictly to `["storage", "activeTab", "tabs", "alarms"]`.
- [Extension Privacy Documentation](docs/extension/privacy.md) — Complete permission breakdown and data flow guarantees.

---

## License

MIT — see [LICENSE](LICENSE).
