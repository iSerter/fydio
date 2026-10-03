#!/usr/bin/env bash
#
# Regenerate the Supabase `Database` type from the local stack.
#
# Writes to a temp file and only moves it into place on success, so a failed
# generation cannot leave a truncated file that breaks every downstream build.
#
# Usage: pnpm db:types

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${REPO_ROOT}/packages/supabase/src/types.generated.ts"

DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "${REPO_ROOT}/.env" | tail -n 1)"

if [[ -z "$DATABASE_URL" ]]; then
  echo "error: DATABASE_URL is not set in .env — run: pnpm secrets:generate" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Generating types from the local database..."
supabase gen types typescript \
  --db-url "$DATABASE_URL" \
  --schema public \
  --workdir "${REPO_ROOT}" >"$TMP"

if [[ ! -s "$TMP" ]]; then
  echo "error: type generation produced no output" >&2
  exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT

echo "Wrote ${OUT#"${REPO_ROOT}/"}"
