# Fydio — local Supabase stack

A self-hosted Supabase stack, vendored from
[`supabase/supabase`](https://github.com/supabase/supabase/tree/master/docker) and
trimmed to run on a laptop.

```bash
pnpm dev:stack          # start (waits until healthy)
pnpm dev:stack:health   # verify
pnpm dev:stack:logs     # tail logs
pnpm dev:stack:down    # stop
pnpm dev:stack:reset   # destroy volumes and rebuild from scratch
```

---

## Files

| File                     | Purpose                                     |
| ------------------------ | ------------------------------------------- |
| `docker-compose.yml`     | the shared base — **publishes no ports**    |
| `docker-compose.dev.yml` | dev overlay — publishes ports, adds Mailpit |
| `.env.example`           | every secret, with generation commands      |
| `volumes/`               | vendored upstream support files (see below) |

The split matters: the base file is usable unchanged for a single-host deployment
behind a reverse proxy, where only the proxy should reach the stack.

---

## Ports

| Service                  | Host port   | Override                                            |
| ------------------------ | ----------- | --------------------------------------------------- |
| API gateway (Kong/Envoy) | 8000        | `API_GW_HTTP_PORT`                                  |
| Postgres                 | 54322       | `POSTGRES_HOST_PORT`                                |
| Pooler (pgbouncer)       | 54324, 6543 | `POOLER_HOST_PORT`, `POOLER_PROXY_PORT_TRANSACTION` |
| Studio                   | 3002        | `STUDIO_HOST_PORT`                                  |
| Mailpit SMTP / UI        | 1025 / 8025 | `MAILPIT_SMTP_HOST_PORT`, `MAILPIT_UI_HOST_PORT`    |

Non-default defaults are deliberate: ports 3001 and 5432 are commonly taken by other
projects on a shared machine. Override in `docker/.env` if these collide too.

---

## What differs from upstream, and why

Every deviation is a fix for something that actually broke during T01.

1. **`vector` and `analytics` removed.** The two heaviest services. Fydio ships no log
   pipeline and no analytics API, and they cost roughly a gigabyte of RAM.
2. **Named volumes for `db` PGDATA and Storage.** Upstream bind-mounts both. On macOS
   the Storage file backend is unreliable over a bind mount — uploads land in the
   container's overlay filesystem and disappear on rebuild — and a bind-mounted
   Postgres cluster can be corrupted by an unclean shutdown.
3. **`_supabase.sql` mounted as `96-` in `init-scripts/`.** Upstream mounts it into
   `migrations/`, which runs _after_ the init scripts. The consequence is that
   `99-pooler.sql` connects to a `_supabase` database that does not exist yet, fails,
   and aborts the remaining scripts — silently leaving the `authenticator` role with
   the wrong password. PostgREST then refuses every connection. Mounting it earlier
   fixes the ordering.
4. **`logs.sql` not mounted.** It bootstraps the Logflare/analytics schemas, and
   Fydio runs neither.
5. **Healthchecks rewritten per image.** Upstream assumes `curl` exists. It does not:
   `gotrue` and `storage-api` ship `wget`, `imgproxy` and `postgres-meta` ship no HTTP
   client at all, and `edge-runtime` ships no `node`. Each probe now uses a tool its
   image actually has.
6. **`METRICS_JWT_SECRET` added to `realtime`.** Required; the container crashes on
   boot without it.
7. **`command: start --main-service …` on `functions`.** Without it the edge runtime
   prints its CLI help and exits, so it never serves anything.
8. **Container names namespaced `fydio-*`.** So this stack can run alongside another
   Supabase stack on the same machine.
9. **`GOTRUE_SMTP_MAX_FREQUENCY: "1000000h"`.** It is a Go `time.Duration`, not a
   count — a bare number fails to parse and Auth crash-loops.

---

## Pinned images

```
supabase/studio:2026.09.07-sha-7996410
envoyproxy/envoy:v1.39.1
supabase/gotrue:v2.196.0
postgrest/postgrest:v14.17
supabase/realtime:v2.134.10
supabase/storage-api:v1.74.0
darthsim/imgproxy:v3.31.4
supabase/postgres-meta:v0.99.0
supabase/edge-runtime:v1.76.2
supabase/postgres:17.6.1.136
supabase/supavisor:2.9.12
axllent/mailpit:v1.28.4
```

To see what has drifted from upstream:

```bash
bash scripts/check-supabase-version.sh --check
```

### Upgrading

`volumes/` must be re-vendored alongside `docker-compose.yml` or the stack will
misbehave in ways that look like configuration bugs:

```bash
for f in volumes/api/envoy/envoy.yaml volumes/api/envoy/cds.yaml \
         volumes/api/envoy/lds.template.yaml volumes/api/envoy/docker-entrypoint.sh \
         volumes/db/realtime.sql volumes/db/webhooks.sql volumes/db/roles.sql \
         volumes/db/jwt.sql volumes/db/_supabase.sql volumes/db/logs.sql \
         volumes/db/pooler.sql volumes/pooler/pooler.exs volumes/functions/main/index.ts; do
  mkdir -p "$(dirname "$f")"
  curl -sSL -o "$f" "https://raw.githubusercontent.com/supabase/supabase/master/docker/$f"
done
```

---

## Secrets

`pnpm secrets:generate` fills **only the blanks** — re-running never rotates a live
secret. Length requirements that the services enforce:

| Variable              | Requirement      | Generation                |
| --------------------- | ---------------- | ------------------------- |
| `POSTGRES_PASSWORD`   | non-empty        | `openssl rand -base64 32` |
| `JWT_SECRET`          | >= 32 chars      | `openssl rand -base64 48` |
| `SECRET_KEY_BASE`     | >= 64 chars      | `openssl rand -base64 48` |
| `REALTIME_DB_ENC_KEY` | exactly 16 chars | `openssl rand -hex 8`     |
| `VAULT_ENC_KEY`       | exactly 32 chars | `openssl rand -hex 16`    |
| `PG_META_CRYPTO_KEY`  | >= 32 chars      | `openssl rand -base64 24` |
| `IMGPROXY_KEY`        | —                | `openssl rand -hex 16`    |

`ANON_KEY` and `SERVICE_ROLE_KEY` are minted locally and signed with the same
`JWT_SECRET`, so the gateway and the app always agree.

> The compose files read **`docker/.env`**, not the app's `.env`. Passing the wrong
> `--env-file` yields empty secrets and a Postgres that refuses to initialise.

---

## Troubleshooting

**`Database is uninitialized and superuser password is not specified`**
The stack is reading the wrong env file. Confirm it uses `--env-file docker/.env`.

**PostgREST: `password authentication failed for user "authenticator"`**
`99-roles.sql` did not run, usually because an earlier init script failed. Check
`docker logs fydio-db` for a psql error, then `pnpm dev:stack:reset`.

**A service is stuck at `health: starting`**
The healthcheck assumes a binary its image does not ship. `docker inspect
--format '{{json .State.Health}}' fydio-<service>` prints the exact failure.

**Everything works but the app says `Unreachable`**
The page probes `/auth/v1/health`, which the gateway answers with 401 unless an
`apikey` header is sent. If the keys drifted, re-run `pnpm secrets:generate`.
