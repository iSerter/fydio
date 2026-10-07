#!/usr/bin/env bash
#
# Restore a PostgreSQL database dump into the Fydio database.
#
# Usage:
#   bash scripts/restore.sh <dump_file.sql>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 1 || -z "$1" ]]; then
  echo "Usage: bash scripts/restore.sh <dump_file.sql>" >&2
  exit 1
fi

DUMP_FILE="$1"

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "error: dump file not found: ${DUMP_FILE}" >&2
  exit 1
fi

DATABASE_URL="${DATABASE_URL:-}"
if [[ -z "$DATABASE_URL" && -f "${REPO_ROOT}/.env" ]]; then
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "${REPO_ROOT}/.env" | tail -n 1)"
fi

echo "Restoring database from ${DUMP_FILE}..."

if [[ -n "$DATABASE_URL" ]] && command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < "$DUMP_FILE" >/dev/null
else
  docker compose \
    -f "${REPO_ROOT}/docker/docker-compose.yml" \
    --env-file "${REPO_ROOT}/docker/.env" \
    exec -T db psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$DUMP_FILE" >/dev/null
fi

echo "Restore finished. Re-applying default schema permissions..."

if [[ -n "$DATABASE_URL" ]] && command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; GRANT ALL ON SCHEMA public TO postgres, supabase_admin;" >/dev/null
else
  docker compose \
    -f "${REPO_ROOT}/docker/docker-compose.yml" \
    --env-file "${REPO_ROOT}/docker/.env" \
    exec -T db psql -U supabase_admin -d postgres -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; GRANT ALL ON SCHEMA public TO postgres, supabase_admin;" >/dev/null
fi

echo "Verifying database connectivity..."

if [[ -n "$DATABASE_URL" ]] && command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -c "select count(*) from information_schema.tables where table_schema = 'public';" >/dev/null
else
  docker compose \
    -f "${REPO_ROOT}/docker/docker-compose.yml" \
    --env-file "${REPO_ROOT}/docker/.env" \
    exec -T db psql -U supabase_admin -d postgres -c "select count(*) from information_schema.tables where table_schema = 'public';" >/dev/null
fi

echo "Database restored and verified successfully."
