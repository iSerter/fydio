#!/usr/bin/env bash
#
# Create a timestamped PostgreSQL backup dump of the Fydio database.
#
# Usage:
#   bash scripts/backup.sh [destination_file]
#
# Examples:
#   bash scripts/backup.sh
#   bash scripts/backup.sh /tmp/fydio-backup.sql

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TARGET_FILE="${1:-/tmp/fydio-backup-${TIMESTAMP}.sql}"

# Prefer DATABASE_URL if available in environment or .env
DATABASE_URL="${DATABASE_URL:-}"
if [[ -z "$DATABASE_URL" && -f "${REPO_ROOT}/.env" ]]; then
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "${REPO_ROOT}/.env" | tail -n 1)"
fi

echo "Creating database backup -> ${TARGET_FILE}..."

mkdir -p "$(dirname "$TARGET_FILE")"

if [[ -n "$DATABASE_URL" ]] && command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL" \
    --clean --if-exists --no-owner --no-privileges \
    --schema=public --schema=supabase_migrations --schema=auth --schema=storage \
    > "$TARGET_FILE"
else
  # Use docker compose with the superuser role
  docker compose \
    -f "${REPO_ROOT}/docker/docker-compose.yml" \
    --env-file "${REPO_ROOT}/docker/.env" \
    exec -T db pg_dump -U supabase_admin \
    --clean --if-exists --no-owner --no-privileges \
    --schema=public --schema=supabase_migrations --schema=auth --schema=storage \
    postgres > "$TARGET_FILE"
fi

if [[ ! -s "$TARGET_FILE" ]]; then
  echo "error: backup file was not created or is empty: ${TARGET_FILE}" >&2
  exit 1
fi

BYTES="$(wc -c < "$TARGET_FILE" | tr -d ' ')"
echo "Backup complete: ${TARGET_FILE} (${BYTES} bytes)"
