#!/usr/bin/env bash
#
# Drop, re-apply migrations, and re-seed the local database.
#
# Uses `supabase db reset --db-url` rather than `--local`. `--local` resolves the
# connection from supabase/config.toml and expects a stack the CLI started itself;
# Fydio runs its own compose file, so the CLI has no such stack to find. This mirrors
# the reasoning already in db-migrate.sh, and both scripts read DATABASE_URL from the
# same .env so there is one source of truth for the connection.
#
# Usage: pnpm db:reset

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

echo "Resetting the local database..."
exec supabase db reset \
  --db-url "$DATABASE_URL" \
  --workdir "$REPO_ROOT" \
  --yes
