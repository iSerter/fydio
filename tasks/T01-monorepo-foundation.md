# T01 — Monorepo Foundation & Local Supabase Stack

**Status:** Not started
**Depends on:** —
**Blocks:** T02, T03, T04, T05, T06, T07, T08, T09, T10
**Brief reference:** "Suggested implementation" (Next.js + TypeScript + Tailwind, Supabase), plus the infra requirements for Docker dev/prod parity.

---

## 1. Goal

Stand up the Fydio monorepo skeleton and a fully working **self-hosted Supabase stack running in Docker** on the developer machine, with a validated environment-variable contract, a working Next.js web app that authenticates against it, and a green `turbo run lint typecheck test build` pipeline.

After T01 a new contributor can run `pnpm install && pnpm dev:stack && pnpm dev` and get a live Next.js app talking to a local Postgres/Auth/Storage.

---

## 2. Why this position in the plan

Every other task depends on four things existing: a workspace, a runnable database, an env contract, and a CI-grade command pipeline. T02 needs migrations applied somewhere; T03 needs Auth working; T10 needs a Dockerfile that already builds. Doing this first de-risks all downstream work.

---

## 3. Scope

### In scope

- pnpm workspace + Turborepo monorepo with `apps/*` and `packages/*`
- `apps/web`: Next.js 16 App Router, TypeScript strict, Tailwind CSS 4, `output: 'standalone'`
- `apps/extension`: placeholder package (real build in T10)
- Shared packages: `config-typescript`, `config-eslint`, `config-tailwind`, `env`, `supabase`, `domain`, `ui`
- `packages/env`: single zod-validated source of truth for all env vars
- `docker/docker-compose.yml` + `docker-compose.dev.yml`: full self-hosted Supabase stack
- Migration tooling (`supabase` CLI wrappers + `pnpm db:*` tasks)
- Base test harness (Vitest), lint (ESLint 10 flat config), format (Prettier)
- Root `.env.example`, `.gitignore`, `.dockerignore`, `tsconfig.base.json`, `turbo.json`
- CI workflow skeleton (`.github/workflows/ci.yml`)
- `pnpm dev:stack` / `dev:stack:down` / `dev:stack:reset` scripts

### Explicitly out of scope

- Any product feature (profiles, feed, feedback — see T02–T09)
- Business schema (T02)
- Production deploy configuration (T10)
- Edge Functions (T04, T08, T10)

---

## 4. Deliverables

1. `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, root `package.json`
2. `apps/web` Next.js 16 app rendering a "Fydio is running" page + auth status
3. `apps/extension` placeholder
4. 7 shared packages, each building/typechecking independently
5. `docker/docker-compose.yml` (Supabase base) and `docker-compose.dev.yml` (mailpit, exposed ports)
6. `docker/.env.example` with every Supabase secret documented + a generation helper
7. `scripts/` for secret generation, stack health checks, bootstrap
8. CI workflow running lint/typecheck/test/build

---

## 5. Technical design

### 5.1 Workspace layout

```
fydio/
├── apps/
│   ├── web/                     # @fydio/web         Next.js 16
│   └── extension/               # @fydio/extension   Chrome MV3 (stub in T01)
├── packages/
│   ├── config-typescript/       # @fydio/config-typescript
│   ├── config-eslint/           # @fydio/config-eslint
│   ├── config-tailwind/         # @fydio/config-tailwind
│   ├── env/                     # @fydio/env
│   ├── supabase/                # @fydio/supabase
│   ├── domain/                  # @fydio/domain
│   └── ui/                      # @fydio/ui
├── supabase/
│   ├── migrations/              # SQL migrations (source of truth)
│   ├── tests/                   # pgTAP
│   ├── seed.sql
│   └── config.toml
├── docker/
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   ├── .env.example
│   └── README.md
├── scripts/
├── .github/workflows/ci.yml
└── tasks/
```

### 5.2 Root `package.json` (canonical shape)

```json
{
  "name": "fydio",
  "private": true,
  "packageManager": "pnpm@10.5.2",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "validate": "turbo run lint typecheck test build",
    "dev:stack": "docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml --env-file .env up -d --wait",
    "dev:stack:down": "docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml --env-file .env down",
    "dev:stack:reset": "pnpm dev:stack:down && pnpm dev:stack && pnpm db:reset",
    "dev:stack:health": "bash scripts/stack-health.sh",
    "secrets:generate": "bash scripts/generate-secrets.sh",
    "db:migrate": "pnpm --filter @fydio/web db:migrate",
    "db:reset": "pnpm --filter @fydio/web db:reset",
    "db:seed": "pnpm --filter @fydio/web db:seed",
    "db:types": "pnpm --filter @fydio/web db:types",
    "format": "prettier --write \"**/*.{ts,tsx,js,mjs,json,md,css}\"",
    "format:check": "prettier --check \"**/*.{ts,tsx,js,mjs,json,md,css}\""
  },
  "devDependencies": {
    "prettier": "3.9.9",
    "turbo": "2.11.7",
    "typescript": "7.0.2"
  }
}
```

### 5.3 `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "stream",
  "globalDependencies": [".env", "tsconfig.base.json"],
  "globalEnv": ["NODE_ENV", "NEXT_PUBLIC_APP_URL"],
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "!.next/cache/**", "dist/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"], "outputs": [] },
    "clean": { "cache": false },
    "db:migrate": { "cache": false },
    "db:seed": { "cache": false },
    "db:types": { "cache": false, "outputs": ["src/**/*.ts"] }
  }
}
```

> `NODE_ENV` and `NEXT_PUBLIC_APP_URL` are declared in `globalEnv` so Turbo invalidates caches when they change. A stale web build pointed at the wrong Supabase URL is the single most likely first-day failure, and this prevents it silently.

### 5.4 `packages/env` — the contract

A single zod schema; every consumer imports from here. **No other file may read `process.env` directly** (enforced by an ESLint `no-restricted-syntax` rule, scaffolded here).

```ts
// packages/env/src/schema.ts
import { z } from 'zod'

const platformKind = z.enum(['instagram', 'tiktok', 'youtube', 'x'])

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- Supabase (server-only) ---
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_JWT_SECRET: z.string().min(32),
  DATABASE_URL: z.string().optional(),

  // --- App ---
  APP_NAME: z.string().default('Fydio'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  // --- Feed ranking tunables ---
  FEED_PAGE_SIZE: z.coerce.number().int().min(5).max(50).default(20),
  FEED_FRIEND_AFFINITY_BOOST: z.coerce.number().default(0.35),
  FEED_FRESHNESS_HALF_LIFE_HOURS: z.coerce.number().default(36),
  FEED_FEEDBACK_NEED_BOOST: z.coerce.number().default(0.15),
  FEED_DIVERSITY_MAX_PER_CREATOR: z.coerce.number().int().default(2),
  FEED_DIVERSITY_MAX_PER_PLATFORM: z.coerce.number().int().default(6),
  FEED_MAX_AGE_HOURS: z.coerce.number().default(720),

  // --- Credits ---
  CREDIT_SUBMISSION_COST: z.coerce.number().int().default(1),
  CREDIT_WEEKLY_STARTER_ALLOWANCE: z.coerce.number().int().default(3),
  CREDIT_PER_DAY_CAP: z.coerce.number().int().default(5),
  CREDIT_PER_CREATOR_CAP: z.coerce.number().int().default(2),
  CREDIT_HOLD_HOURS: z.coerce.number().int().default(48),
  CREDIT_NEW_MEMBER_SUBMISSION_CAP: z.coerce.number().int().default(3),
  CREDIT_NEW_MEMBER_GRACE_DAYS: z.coerce.number().int().default(14),

  // --- Feedback ---
  FEEDBACK_MIN_CHARS: z.coerce.number().int().default(40),
  FEEDBACK_MAX_IMAGES: z.coerce.number().int().default(3),
  FEEDBACK_EDIT_GRACE_HOURS: z.coerce.number().int().default(48),
  RATING_REVISION_WINDOW_HOURS: z.coerce.number().int().default(24),

  // --- Content / platforms ---
  PLATFORM_ALLOWLIST: z.array(platformKind).default(['instagram', 'tiktok', 'youtube', 'x']),
  URL_PREVIEW_TIMEOUT_MS: z.coerce.number().int().default(4000),

  // --- Storage buckets ---
  STORAGE_BUCKET_AVATARS: z.string().default('avatars'),
  STORAGE_BUCKET_COVERS: z.string().default('covers'),
  STORAGE_BUCKET_FEEDBACK: z.string().default('feedback-images'),

  // --- Extension ---
  EXTENSION_ID: z.string().optional(),
  EXTENSION_TOKEN_SECRET: z.string().min(32).optional(),
})

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().default('Fydio'),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_EXTENSION_ID: z.string().optional(),
})
```

Exports:

- `parseServerEnv(input?)` — called from `instrumentation.ts`, fails fast at boot
- `parseClientEnv()` — reads `NEXT_PUBLIC_*` only
- `env` — the lazily-validated server object

**Security rule:** `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `EXTENSION_TOKEN_SECRET` and all tunables are **server-only**. `packages/env` exposes them from `src/server.ts` guarded by `import 'server-only'`, while `src/client.ts` physically cannot re-export them. Turborepo's `globalEnv` hashes tunables so a policy change busts the web build cache.

### 5.5 `packages/supabase` — clients

| Export                        | File             | Purpose                                                                                       |
| ----------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `createBrowserClient()`       | `src/browser.ts` | `@supabase/supabase-js` singleton for Client Components                                       |
| `createServerClient(cookies)` | `src/server.ts`  | `@supabase/ssr` cookie adapter for RSC + Route Handlers                                       |
| `createServiceClient()`       | `src/service.ts` | `service_role` client; **server-only**; bypasses RLS — used by admin ops and server-side jobs |
| `getSessionUser()`            | `src/session.ts` | `getUser()` (never `getSession()`) — server-verified                                          |
| `types`                       | `src/types.ts`   | Generated `Database` type (populated in T02)                                                  |

**Anti-pattern, explicitly banned:** trusting `getSession()` for authorization. All mutations go through Postgres RPCs guarded by RLS, so a forged client-side session cannot escalate.

### 5.6 `packages/domain`

Pure, framework-free, dependency-light TypeScript shared by web and extension:

- `platforms.ts` — `detectPlatform(url)`, `canonicalizeUrl(url)`, per-platform host allowlists
- `constants.ts` — `MAX_PROFILE_HASHTAGS = 5`, `EXACT_CONTENT_HASHTAGS = 3`, `MAX_FEEDBACK_IMAGES = 3`, `MIN_RATING = 1`, `MAX_RATING = 10`, plus the structured feedback tag vocabulary (`hook`, `clarity`, `editing`, `storytelling`, `thumbnail`, `cta`, `audience_fit`)
- `validation.ts` — zod schemas shared by forms and RPC argument validation
- `ranking.ts` — **pure reference implementation** of the ranking formula, unit-tested and mirrored 1:1 by the SQL in T07. Single source of truth for "why an item ranked where it did."
- `credits.ts` / `reputation.ts` — display formatting, and the rule that credits and reputation are never interchangeable (naming lint added in T09)

### 5.7 Docker — Supabase stack

`docker/docker-compose.yml` holds the **shared base** (upstream Supabase compose, trimmed of `vector` and `analytics` so it fits an 8 GB server). `docker-compose.dev.yml` layers dev-only concerns.

Services: `db`, `kong` (API gateway), `auth`, `rest`, `realtime`, `storage`, `imgproxy`, `meta`, `functions`, `studio`. Dev-only: `mailpit`.

Non-negotiables:

- **Named volumes, never bind mounts**, for `db` and Storage's `VOLUME_ROOT_PATH` — Supabase Storage's file backend misbehaves on macOS bind mounts.
- Every service gets a `healthcheck`; `depends_on` uses `condition: service_healthy`.
- `kong` is the only published Supabase port in dev (`8000`); `studio` on `3001`; `mailpit` on `8025`.

Required secrets (documented in `docker/.env.example`, generated by `scripts/generate-secrets.sh`):

| Variable                                              | Purpose                       | Generation                                      |
| ----------------------------------------------------- | ----------------------------- | ----------------------------------------------- |
| `POSTGRES_PASSWORD`                                   | DB superuser                  | `openssl rand -base64 32`                       |
| `JWT_SECRET`                                          | Legacy HS256 signing key      | `openssl rand -base64 48` (≥32 chars)           |
| `ANON_KEY` / `SERVICE_ROLE_KEY`                       | Legacy HS256 API keys         | `utils/generate-keys.sh` from the Supabase repo |
| `SECRET_KEY_BASE`                                     | Realtime/Supavisor encryption | `openssl rand -base64 48` (≥64 chars)           |
| `REALTIME_DB_ENC_KEY`                                 | Realtime field encryption     | `openssl rand -hex 8` (exactly 16 chars)        |
| `VAULT_ENC_KEY`                                       | Supavisor config encryption   | `openssl rand -hex 16` (32 chars)               |
| `PG_META_CRYPTO_KEY`                                  | Studio connection strings     | `openssl rand -base64 24` (≥32 chars)           |
| `IMGPROXY_KEY`                                        | Image proxy URL signing       | `openssl rand -hex 16`                          |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`           | Studio login                  | manual                                          |
| `SITE_URL`, `SUPABASE_PUBLIC_URL`, `API_EXTERNAL_URL` | Public URLs                   | manual                                          |
| `SMTP_*`                                              | Auth email delivery           | Mailpit in dev; real provider in prod           |

`scripts/generate-secrets.sh` is **idempotent** — it only fills blanks, so re-running never rotates a live secret.

### 5.8 Migration tooling

Migrations live in `supabase/migrations/*.sql` and are applied with the Supabase CLI against the local stack's Postgres:

```json
// apps/web/package.json
"db:migrate": "supabase db push --local --include-all",
"db:reset":   "supabase db reset --local",
"db:seed":    "supabase db reset --local && psql \"$DATABASE_URL\" -f supabase/seed.sql",
"db:types":   "supabase gen types typescript --local > ../packages/supabase/src/types.generated.ts"
```

Rationale: `supabase db push --local` gives ordered, checksummed, reviewable SQL migrations with a real history table — exactly what a credit ledger that must be auditable requires.

---

## 6. Files to create

| Path                             | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `pnpm-workspace.yaml`            | `apps/*`, `packages/*`                                             |
| `turbo.json`                     | Task graph                                                         |
| `tsconfig.base.json`             | Strict TS base                                                     |
| `package.json`                   | Root scripts + devDeps                                             |
| `.npmrc`                         | `strict-peer-dependencies=false`, `auto-install-peers=true`        |
| `.gitignore`                     | `node_modules`, `.next`, `.turbo`, `.env`, `dist`, `*.tsbuildinfo` |
| `.dockerignore`                  | Trim build context                                                 |
| `.prettierrc`, `.prettierignore` | Formatting                                                         |
| `eslint.config.mjs`              | Root flat config                                                   |
| `.env.example`                   | Web env template (no secrets)                                      |
| `docker/.env.example`            | Supabase stack secrets template                                    |
| `docker/docker-compose.yml`      | Supabase base stack                                                |
| `docker-compose.dev.yml`         | Dev overlay (mailpit, ports)                                       |
| `docker/README.md`               | Stack operations notes                                             |
| `supabase/config.toml`           | CLI project config                                                 |
| `supabase/migrations/.gitkeep`   | Migration home                                                     |
| `supabase/seed.sql`              | Baseline smoke seed                                                |
| `scripts/generate-secrets.sh`    | Idempotent secret generation                                       |
| `scripts/stack-health.sh`        | Wait for + verify all services healthy                             |
| `scripts/bootstrap.sh`           | One-command dev setup                                              |
| `packages/config-typescript/*`   | `base.json`, `library.json`, `nextjs.json`                         |
| `packages/config-eslint/*`       | `base.js`, `nextjs.js`                                             |
| `packages/config-tailwind/*`     | Shared preset                                                      |
| `packages/env/*`                 | zod env contract                                                   |
| `packages/supabase/*`            | Clients                                                            |
| `packages/domain/*`              | Constants, platform parsing, ranking                               |
| `packages/ui/*`                  | Tailwind preset + primitives                                       |
| `apps/web/*`                     | Next.js 16 app                                                     |
| `apps/extension/*`               | Placeholder                                                        |
| `.github/workflows/ci.yml`       | Lint/typecheck/test/build                                          |

---

## 7. Implementation steps

- [ ] `pnpm init`, author `package.json`, pin `packageManager` to `pnpm@10.5.2`
- [ ] Create `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`, `.prettierrc`, `.prettierignore`
- [ ] Author `tsconfig.base.json` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `moduleResolution: bundler`
- [ ] Build `@fydio/config-typescript` (`base`, `library`, `nextjs`) and wire `apps/web` + all `packages/*`
- [ ] Build `@fydio/config-eslint` (flat config + typescript-eslint) and the root `eslint.config.mjs`
- [ ] Build `@fydio/config-tailwind` (Tailwind 4 preset: theme tokens, dark mode)
- [ ] Build `@fydio/env` — zod schemas + `server.ts` / `client.ts` split, fail-fast on bad input
- [ ] Build `@fydio/supabase` — browser/server/service clients, `getSessionUser()`
- [ ] Build `@fydio/domain` — constants, `detectPlatform`, `canonicalizeUrl`, ranking reference implementation, validation schemas
- [ ] Build `@fydio/ui` — `cn()` via `clsx` + `tailwind-merge`, base primitives
- [ ] Scaffold `apps/web` (TS, Tailwind, App Router, `src/`), set `output: 'standalone'`
- [ ] Add `apps/web/instrumentation.ts` calling `parseServerEnv()` at boot
- [ ] Add a landing page rendering the env-validated app name and a live Supabase connectivity check
- [ ] Create `apps/extension` placeholder with a `manifest.json` stub and a `build` task producing `dist/`
- [ ] Write `docker/docker-compose.yml` (Supabase base) and `docker-compose.dev.yml`
- [ ] Write `scripts/generate-secrets.sh` (idempotent) and run it to produce `.env` + `docker/.env`
- [ ] Write `scripts/stack-health.sh` polling each container's health status
- [ ] Add `supabase/config.toml`; verify `supabase db push --local` and `supabase gen types --local` work against the running stack
- [ ] Write `supabase/seed.sql` with a `select 1` smoke check (real seeds land in T02)
- [ ] Add root `turbo.json`; confirm `turbo run build lint typecheck test` passes across all packages
- [ ] Add `.github/workflows/ci.yml`: `pnpm install --frozen-lockfile` → `pnpm validate`
- [ ] Document the dev workflow in `README.md`

---

## 8. Acceptance criteria

- [ ] `pnpm install` completes with zero peer-dependency errors
- [ ] `turbo run lint typecheck test build` exits 0 from a clean clone
- [ ] `pnpm dev:stack` brings up all Supabase services and `--wait` returns without timeout
- [ ] `pnpm dev:stack:health` reports every service `healthy`
- [ ] `curl http://localhost:8000/auth/v1/health` returns healthy through Kong
- [ ] `supabase db push --local` and `supabase gen types typescript --local` succeed
- [ ] `NEXT_PUBLIC_SUPABASE_URL=not-a-url pnpm --filter @fydio/web dev` fails fast with a readable zod error
- [ ] `@fydio/env` client entry cannot import `SUPABASE_SERVICE_ROLE_KEY` (proven by a negative test)
- [ ] `apps/web` production build emits `.next/standalone/` (verified fully in T10)
- [ ] No `process.env` access outside `packages/env` and Next.js config files

---

## 9. Tests

- **Unit** (`packages/env`): valid schema parses; each required var missing → typed error; bad URL rejected; numeric coercion works; client schema cannot see server vars.
- **Unit** (`packages/domain`): `detectPlatform` on 20+ real URL shapes (short links, `youtu.be`, `/reel/`, `/p/`, `x.com` vs `twitter.com`, query/fragment stripping); `canonicalizeUrl` idempotency.
- **Unit** (`packages/domain/ranking.ts`): pure formula tests — freshness decay halving, friend boost, diversity penalties. These are the reference the SQL in T07 must match.
- **Integration**: Vitest creates a Supabase client against the running dev stack and asserts `/auth/v1/health`.
- **CI**: `pnpm validate` is the single required status check.

---

## 10. Verification commands

```bash
pnpm install
pnpm secrets:generate
pnpm dev:stack
pnpm dev:stack:health
curl -fsS http://localhost:8000/auth/v1/health
curl -fsS http://localhost:3001/api/platform/health   # Supabase Studio
pnpm --filter @fydio/web db:migrate
pnpm --filter @fydio/web db:types
pnpm validate
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml ps
```

---

## 11. Risks & mitigations

| Risk                                                                | Mitigation                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Full Supabase stack is RAM-hungry on a laptop                       | Trim `vector` + `analytics`; document a `--profile full` opt-in. Target 8 GB Docker memory                                 |
| Storage file backend broken on macOS bind mounts                    | Use **named volumes** only                                                                                                 |
| Upstream compose drift breaks our stack                             | Pin the Supabase release in `docker/README.md`; add `scripts/check-supabase-version.sh`                                    |
| JWT/key mismatch between Kong and the app                           | One `generate-secrets.sh` source for `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`; assert consistency in `stack-health.sh` |
| Turbo cache serves a web build built against the wrong Supabase URL | Declare `NODE_ENV` + `NEXT_PUBLIC_APP_URL` in `globalEnv`; read the URL from `@fydio/env`                                  |
| TypeScript 7.0.2 is a major version bump                            | Pin exactly; if `next` lags on TS7, pin TS `5.x` for `apps/web` only and document the split                                |

---

## 12. Definition of done

A new contributor can run the bootstrap script on a clean machine and reach a running app backed by a healthy Supabase stack, with `pnpm validate` green in CI. No product logic yet — this task exists purely to make tasks 02–10 cheap.
