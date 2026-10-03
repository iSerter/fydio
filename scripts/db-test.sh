#!/usr/bin/env bash
#
# Run the pgTAP suites in supabase/tests/.
#
# --db-url rather than --local, for the same reason as db-migrate.sh and db-reset.sh:
# the stack is managed by docker compose, not by `supabase start`.
#
# Usage: pnpm db:test

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "${REPO_ROOT}/.env" | tail -n 1)"

if [[ -z "$DATABASE_URL" ]]; then
  echo "error: DATABASE_URL is not set in .env — run: pnpm secrets:generate" >&2
  exit 1
fi

if ! docker compose \
  -f "${REPO_ROOT}/docker/docker-compose.yml" \
  -f "${REPO_ROOT}/docker/docker-compose.dev.yml" \
  --env-file "${REPO_ROOT}/docker/.env" \
  ps --services --filter status=running 2>/dev/null | grep -q '^db$'; then
  echo "error: the db service is not running — start it with: pnpm dev:stack" >&2
  exit 1
fi

# pgTAP must be installed. `supabase test db` installs it itself when the extension is
# absent, but that only happens for a `--local` stack; against `--db-url` the caller
# is responsible, and a missing extension otherwise fails with a confusing
# "function plan(unknown) does not exist".
docker compose \
  -f "${REPO_ROOT}/docker/docker-compose.yml" \
  -f "${REPO_ROOT}/docker/docker-compose.dev.yml" \
  --env-file "${REPO_ROOT}/docker/.env" \
  exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "create extension if not exists pgtap with schema extensions;" >/dev/null

exec supabase test db \
  --db-url "$DATABASE_URL" \
  --workdir "$REPO_ROOT"
