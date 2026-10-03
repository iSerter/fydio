#!/usr/bin/env bash
#
# Run supabase/seed.sql against the local database.
#
# Piped through the container's own psql rather than a host `psql`, which keeps
# the requirement to have Postgres client tools installed off contributors'
# machines.
#
# Usage: pnpm db:seed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED_FILE="${REPO_ROOT}/supabase/seed.sql"

COMPOSE=(docker compose
  -f "${REPO_ROOT}/docker/docker-compose.yml"
  -f "${REPO_ROOT}/docker/docker-compose.dev.yml"
  --env-file "${REPO_ROOT}/docker/.env")

if [[ ! -f "$SEED_FILE" ]]; then
  echo "error: ${SEED_FILE} not found" >&2
  exit 1
fi

if ! "${COMPOSE[@]}" ps --services --filter status=running 2>/dev/null | grep -q '^db$'; then
  echo "error: the db service is not running — start it with: pnpm dev:stack" >&2
  exit 1
fi

echo "Applying ${SEED_FILE}..."
"${COMPOSE[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres <"$SEED_FILE"
echo "Seed applied."
