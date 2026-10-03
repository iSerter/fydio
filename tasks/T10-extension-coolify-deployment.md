# T10 — Chrome Extension, Docker Production Build & Coolify Deployment

**Status:** Not started
**Depends on:** T08, T09
**Blocks:** —
**Brief reference:** §6 Optional browser companion, §Include "Optional Chrome extension with explicit consent and coarse active-tab duration tracking", §Suggested implementation ("Browser companion: Chrome Manifest V3 extension communicating only with Fydio's authenticated API"; "Hosting"), plus the infra constraint: Docker for dev **and** prod, Coolify v4.11.

---

## 1. Goal

Finish the product with two deliverables:

1. **Optional Chrome MV3 companion** — opt-in, consent-first, reports only a coarse active-tab duration band and a return-to-Fydio signal, and never reads unrelated browsing or automates platform actions.
2. **Production deployment** — Docker for the web app and the full self-hosted Supabase stack, deployed to **Coolify v4.11** via environment variables, with a documented runbook, backups, and health checks.

After T10 Fydio runs on a real server with a real domain, and the extension is loadable in Chrome.

---

## 2. Why last

The extension depends on the telemetry endpoint (T08) and the return-token flow; production packaging depends on every route existing. Deploying last avoids redeploying for late features.

---

## 3. Scope

### In scope

**Extension**

- Manifest V3, unpacked for MVP, store ID env-gated
- Consent flow (explicit, per-purpose, revocable)
- Popup: link back to Fydio, opt-in toggle, consent status
- `tabs` + `activeTab` only — no broad host permissions
- Coarse active-tab duration band reported to `/api/telemetry/duration`
- Return-to-Fydio detection (`return_token` status poll)
- Feedback prompt surface on Fydio (not injected into platform pages)

**Deployment**

- Multi-stage `apps/web/Dockerfile` (Next.js `standalone`, `turbo prune`)
- `docker-compose.prod.yml` (Supabase stack, trimmed, persistent volumes)
- Coolify app resource (web) + Coolify Docker Compose resource (Supabase)
- Full env matrix: dev / Coolify-prod / Edge / example
- Migration + seed + scheduled-task wiring in prod (weekly allowance, credit sweeper)
- Health checks, backups (PG dump), logs
- `docs/` runbook: deploy, migrate, back up, restore, rotate secrets, upgrade Supabase
- README/architecture docs

### Explicitly out of scope

- Chrome Web Store submission (extension ships unpacked; store ID env-gated for later)
- Automated platform interaction — **forbidden** and absent
- Precise tracking, page-content reading, credential capture — **forbidden** and absent
- CI/CD auto-deploy (Coolify webhooks documented but manual deploy is the default)
- Multi-region, autoscaling, CDN tuning

---

## 4. Deliverables

1. `apps/extension` MV3 extension (manifest, service worker, popup, consent store)
2. `apps/web/Dockerfile` — multi-stage, `output: 'standalone'`
3. `docker/docker-compose.prod.yml` — trimmed Supabase for production
4. Coolify setup guide + env matrix
5. Prod migration + scheduled-task wiring
6. Backup/restore scripts
7. `docs/architecture/*`, `docs/runbook/*`, updated `README.md`
8. Tests: extension message handling, band mapping, Dockerfile smoke build

---

## 5. Technical design

### 5.1 Extension architecture (MV3)

```
apps/extension/
├── manifest.json          # MV3, minimal permissions
├── src/
│   ├── background.ts      # service worker: tab listeners + band timing
│   ├── popup.ts           # opt-in toggle + link back
│   ├── consent.ts         # consent state (chrome.storage.local)
│   ├── bands.ts           # raw ms → coarse band mapping
│   └── api.ts             # calls Fydio's authenticated API only
├── public/icons/
└── dist/                  # built output (load unpacked)
```

**Manifest — permissions are the whole privacy story:**

```json
{
  "manifest_version": 3,
  "name": "Fydio Companion (optional)",
  "version": "0.1.0",
  "permissions": ["storage", "activeTab", "tabs", "alarms"],
  "host_permissions": ["https://<fydio-domain>/api/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self'" }
}
```

Deliberately **absent**: `webRequest`, `cookies`, `history`, `bookmarks`, `<all_urls>`, `desktopCapture`, `debugger`. The extension never receives a broad browsing permission — it only sees tabs the user explicitly opens from a Fydio click.

**Service worker flow (the only collection path):**

```
User clicks "Open" on a Fydio card
  → web app calls record_outbound_click → returns return_token (server-stored)
  → web page stores token in a short-lived chrome.storage.session entry
  → extension (activeTab) sees the active tab change
     → checks consent is ON
     → starts an alarm; on tab blur/close, computes elapsed active time
     → maps to a coarse band (bands.ts)
     → POSTs { entryId, band, returned } to Fydio's duration endpoint
        (which re-checks consent server-side and stores only the band)
  → extension observes the user returning to the Fydio tab
     → polls the return-token status endpoint → shows the feedback prompt link
```

```ts
// apps/extension/src/bands.ts
export type Band = 'lt_15s' | 's15_60' | 'm1_3' | 'gt_3' | 'unknown'

// Raw duration is used ONLY to pick a band, then discarded. It is never sent.
export function toBand(ms: number): Band {
  if (ms < 0 || !Number.isFinite(ms)) return 'unknown'
  if (ms < 15_000) return 'lt_15s'
  if (ms < 60_000) return 's15_60'
  if (ms < 180_000) return 'm1_3'
  return 'gt_3'
}
```

**Consent (explicit, revocable, first-run):**

```ts
// apps/extension/src/consent.ts
const KEY = 'fydio_duration_consent'
export async function isConsented(): Promise<boolean> {
  const s = await chrome.storage.local.get(KEY)
  return s[KEY]?.granted === true && s[KEY]?.version === CONSENT_VERSION
}
export async function setConsent(granted: boolean) {
  await chrome.storage.local.set({
    [KEY]: { granted, version: CONSENT_VERSION, at: Date.now() },
  })
}
```

The popup shows scope in plain language and links to `/settings/privacy`. Revocation is immediate and also server-side (T08 consent endpoint).

**What the extension never does:** read page content, read other tabs, replay actions, click on the platform, bypass safeguards, collect credentials, or track mobile-app handoffs.

### 5.2 Web Dockerfile (multi-stage, standalone)

`apps/web/Dockerfile`:

```dockerfile
# ---- deps ----
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.5.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json            apps/web/
COPY packages/config-typescript/     packages/config-typescript/
COPY packages/config-eslint/         packages/config-eslint/
COPY packages/config-tailwind/       packages/config-tailwind/
COPY packages/env/package.json        packages/env/
COPY packages/supabase/package.json   packages/supabase/
COPY packages/domain/package.json     packages/domain/
COPY packages/ui/package.json         packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build (pruned to web + deps) ----
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /repo /repo
COPY . .
RUN pnpm turbo prune --scope=@fydio/web --docker
RUN pnpm --filter @fydio/web build

# ---- runner ----
FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

- `turbo prune --docker` keeps the build context minimal (faster, cache-friendly).
- Standalone output → a small self-contained server; no `node_modules` in the final image.
- Non-root `nextjs` user; `HOSTNAME=0.0.0.0` so Coolify's proxy can reach it (a common gotcha — default `localhost` binds are unreachable behind a proxy).

### 5.3 Production Supabase compose (Coolify)

`docker/docker-compose.prod.yml` — the same base as dev, with prod differences:

| Service              | Prod change                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `db`                 | Named volume `fydio_db_data`; `POSTGRES_PASSWORD` from Coolify env; healthcheck            |
| `kong`               | Published on domain `${SUPABASE_PUBLIC_URL}` → `api.<domain>`; only the gateway is exposed |
| `studio`             | Bound to localhost or a separate admin domain; not publicly routed by default              |
| `storage`            | Named volume for `VOLUME_ROOT_PATH`; S3 optional later                                     |
| `auth`               | `GOTRUE_DISABLE_SIGNUP=true`, real `SMTP_*`, `SITE_URL` = app domain                       |
| `functions`          | Bind-mounts `supabase/functions` so deploys are `git pull` + restart                       |
| `vector`/`analytics` | Omitted (trimmed) to fit an 8 GB server                                                    |
| All secrets          | `${VAR}` from Coolify environment variables (never committed)                              |

**Coolify topology (v4.11):**

- **Resource 1 — Docker Compose** (the Supabase stack), from this repo, Base Directory `docker`, Compose Location `docker-compose.yml` + `docker-compose.prod.yml`. Domains set on `kong` (and `studio` if desired). Persistent volumes for `db` and `storage`.
- **Resource 2 — Application** (the web app), Dockerfile build pack, domain `app.<domain>` → port `3000`. Env vars from the Coolify env UI.

Both resources share the same Git repo but deploy independently — the web app can roll forward before or after the DB.

### 5.4 Environment variable matrix

| Var                                               | Dev                     | Coolify prod                     |
| ------------------------------------------------- | ----------------------- | -------------------------------- |
| `SUPABASE_URL`                                    | `http://localhost:8000` | `https://api.<domain>`           |
| `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | generated               | Coolify secrets                  |
| `NEXT_PUBLIC_APP_URL`                             | `http://localhost:3000` | `https://app.<domain>`           |
| `SUPABASE_JWT_SECRET`                             | generated               | Coolify secret (≥32 chars)       |
| `CREDIT_*`, `FEED_*`, `FEEDBACK_*` tunables       | defaults                | Coolify (policy knobs)           |
| `CRON_SECRET`                                     | local                   | Coolify secret (scheduled tasks) |
| `SMTP_*`                                          | Mailpit                 | real provider                    |
| `INSTAGRAM_ACCESS_TOKEN` / `YOUTUBE_API_KEY`      | optional                | optional                         |
| `DATABASE_URL`                                    | local                   | Coolify secret (migrations)      |

All public vars are `NEXT_PUBLIC_*` and validated by `packages/env`; all secrets are server-only and injected at runtime.

### 5.5 Production scheduled tasks

Two recurring jobs (Coolify Cron / `pg_cron` if enabled):

- **Weekly allowance** — call `grant_weekly_allowance()` (idempotent).
- **Credit sweeper** — call `release_held_credits()` hourly to move passed `available_at` credits to available.

Both exposed as `CRON_SECRET`-guarded routes (T05) so Coolify Scheduler can hit them without a DB network path.

### 5.6 Migrations in production

Order-safe deploy:

1. Coolify deploys the Supabase compose (DB up, secrets set).
2. Run migrations against prod (`supabase db push --linked` or `psql` against `DATABASE_URL` from Coolify).
3. Coolify deploys the web app.
4. Seed **not** run in prod.

`/api/health` returns DB connectivity + migration head, so deploy verification is a single curl.

### 5.7 Backups

- `scripts/backup.sh` — `pg_dump` to a timestamped file; document a Coolify cron to write to a mounted volume / S3.
- `scripts/restore.sh` — restore from a dump; document a restore drill in the runbook.
- Storage backup — snapshot the `storage` volume (avatars/covers/feedback images).

### 5.8 Documentation deliverables

- `docs/architecture/data-model.md` (stub from T02, expanded)
- `docs/architecture/ranking.md` (from T07)
- `docs/metrics/success-metrics.md` (from T09)
- `docs/runbook/deploy-coolify.md` — step-by-step Coolify setup
- `docs/runbook/operations.md` — backup, restore, secret rotation, Supabase upgrade
- `docs/extension/privacy.md` — exactly what the extension does and does not do
- `README.md` — quick start, architecture, deploy pointer

---

## 6. Files to create

| Path                                         | Purpose                      |
| -------------------------------------------- | ---------------------------- |
| `apps/extension/manifest.json`               | MV3 manifest                 |
| `apps/extension/src/background.ts`           | Service worker               |
| `apps/extension/src/popup.ts` / `popup.html` | Consent + link               |
| `apps/extension/src/consent.ts`              | Consent store                |
| `apps/extension/src/bands.ts`                | Coarse band mapper           |
| `apps/extension/src/api.ts`                  | Fydio API calls              |
| `apps/extension/scripts/build.mjs`           | Bundle to `dist/`            |
| `apps/web/Dockerfile`                        | Multi-stage standalone build |
| `apps/web/.dockerignore`                     | Build context trim           |
| `docker/docker-compose.prod.yml`             | Production Supabase          |
| `scripts/backup.sh`, `scripts/restore.sh`    | PG backup/restore            |
| `scripts/smoke-prod.sh`                      | Post-deploy health checks    |
| `apps/web/src/app/api/health/route.ts`       | Health: DB + migration head  |
| `docs/architecture/data-model.md`            | Data model doc               |
| `docs/runbook/deploy-coolify.md`             | Coolify setup                |
| `docs/runbook/operations.md`                 | Ops runbook                  |
| `docs/extension/privacy.md`                  | Extension privacy doc        |
| `README.md`                                  | Project README               |
| `tests/extension/bands.test.ts`              | Band mapper tests            |
| `tests/extension/messages.test.ts`           | Worker message handling      |

---

## 7. Implementation steps

- [ ] Build the extension (manifest, background, popup, consent, bands, api) + `build.mjs`
- [ ] Add extension unit tests (bands, consent, message handling)
- [ ] Wire extension → `/api/telemetry/duration` (T08) and return-status poll
- [ ] Write `apps/web/Dockerfile` (deps → prune → build → standalone runner)
- [ ] Verify `docker build` produces a running server (smoke test locally)
- [ ] Write `docker-compose.prod.yml` (trimmed, named volumes, prod env)
- [ ] Write `docker-compose.prod.yml` Kong domain + healthchecks
- [ ] Add `/api/health` (DB + migration head)
- [ ] Write `backup.sh` / `restore.sh` and test a dump/restore cycle
- [ ] Write `smoke-prod.sh` (health, login page, feed loads, submit an entry)
- [ ] Document the Coolify two-resource setup (Compose + App)
- [ ] Document the full env matrix and which vars are Coolify secrets
- [ ] Wire prod scheduled tasks (weekly allowance + credit sweeper) via Coolify cron
- [ ] Document prod migration order (compose → migrate → web)
- [ ] Write `docs/architecture/data-model.md` and `docs/runbook/*`
- [ ] Write `docs/extension/privacy.md` and update `README.md`
- [ ] Run a full local prod-parity rehearsal: bring up prod compose, migrate, seed a staging copy, run the smoke script
- [ ] Update `.env.example` and `docker/.env.example` with prod-keyed comments

---

## 8. Acceptance criteria

- [ ] `docker build` for the web app succeeds and `node apps/web/server.js` serves the app on `0.0.0.0:3000`
- [ ] The production image runs as a non-root user and contains no dev dependencies
- [ ] `turbo prune` reduces the build context (fewer packages copied than the full repo)
- [ ] Prod compose starts with all Supabase services healthy and only Kong exposed
- [ ] `db` and `storage` use named volumes that survive `docker compose down && up`
- [ ] No secret is committed; `docker/.env` and `.env` are gitignored and templated in `.env.example`
- [ ] Coolify app resource builds the Dockerfile and serves on its domain with a valid TLS cert
- [ ] Coolify compose resource starts the Supabase stack and persists data across redeploys
- [ ] `/api/health` returns DB connectivity + current migration head
- [ ] `smoke-prod.sh` passes: health OK, login page loads, feed renders, an entry can be submitted
- [ ] Weekly allowance and credit sweeper run on schedule in prod (verified once manually)
- [ ] A `pg_dump` backup and a restore both succeed in a rehearsal
- [ ] Extension builds, loads unpacked, and its unit tests pass
- [ ] Extension with consent OFF sends no duration events; with consent ON it sends only `{entryId, band, returned}`
- [ ] Extension never requests `<all_urls>`, `webRequest`, `cookies`, or `history` permissions
- [ ] Revoking consent in the extension or in `/settings/privacy` stops all duration reporting immediately
- [ ] Extension privacy doc accurately lists every permission and every data flow

---

## 9. Tests

- **Extension unit**: `toBand` boundaries (0, 14.9s, 15s, 59.9s, 60s, 179.9s, 180s, NaN); consent grant/revoke/version; worker message handling (open/close/return); no-raw-duration-leaves-the-worker assertion.
- **Docker**: `docker build` succeeds; container health; `curl localhost:3000` inside the container returns HTML; image size is reasonable (<500 MB).
- **Backup/restore**: dump → drop schema → restore → row count matches.
- **Smoke (prod rehearsal)**: run `smoke-prod.sh` against the prod-parity compose; assert exit 0.
- **Security**: grep the extension bundle to confirm absent permissions and that no request body contains a raw duration.

---

## 10. Verification commands

```bash
# Build + run the web image locally
docker build -f apps/web/Dockerfile -t fydio-web .
docker run --rm -p 3000:3000 --env-file .env fydio-web &
curl -fsS http://localhost:3000/api/health

# Extension
pnpm --filter @fydio/extension build
pnpm --filter @fydio/extension test
node -e "const m=require('./apps/extension/dist/manifest.json'); const bad=['<all_urls>','webRequest','cookies','history']; const perms=[...Object.keys(m.permissions||{}),...(m.host_permissions||[])]; console.log('forbidden perms present:', bad.filter(b=>perms.some(p=>p.includes(b))));"  # expect none

# Prod-parity stack (local)
docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml --env-file docker/.env up -d --wait
bash scripts/smoke-prod.sh

# Backup/restore rehearsal
bash scripts/backup.sh && bash scripts/restore.sh /tmp/fydio-*.sql

# Deploy (Coolify) — post-deploy verification
curl -fsS https://api.<domain>/auth/v1/health
curl -fsS https://app.<domain>/api/health | jq
```

---

## 11. Risks & mitigations

| Risk                                                                | Mitigation                                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Full Supabase stack exceeds the Coolify server                      | Trim `vector`/`analytics`; document 4 CPU / 8 GB minimum; keep Studio unpublished                                |
| Two Coolify resources drift (web ahead of DB)                       | Deploy order documented (compose → migrate → web); health checks catch mismatches; migrations are additive-first |
| Secrets leak via logs or committed env                              | All secrets from Coolify env UI / gitignored `.env`; CI scans for committed secrets; logs avoid env dumps        |
| Extension over-reaches permissions                                  | Manifest intentionally minimal; a unit test asserts no broad permissions; privacy doc reviewed                   |
| Self-hosted Supabase upgrade breaks the stack                       | Pin a Supabase release; document the upgrade + backup procedure; never `latest` in prod compose                  |
| `HOSTNAME` default binds to localhost, unreachable behind the proxy | Explicit `HOSTNAME=0.0.0.0` in the runner                                                                        |
| Standalone build misses static assets                               | Dockerfile explicitly copies `.next/static` and `public` into the runner                                         |
| Scheduled tasks silently stop                                       | Cron responses logged; a dashboard check surfaces overdue sweeps; manual invocation documented                   |

---

## 12. Definition of done

Fydio is deployable to Coolify as two Dockerized resources with no committed secrets and a verified health/migration path, and the optional extension adds opt-in, coarse, private return-and-duration assistance without reading unrelated browsing or automating any platform action.
