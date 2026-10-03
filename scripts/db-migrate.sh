#!/usr/bin/env bash
#
# Apply pending migrations to the local stack.
#
# Uses `supabase db push --db-url` rather than `--local`. `--local` resolves the
# connection from `supabase/config.toml` and expects a CLI-managed stack, while
# Fydio runs its own compose file. `--db-url` points the CLI at the same database
# either way and still gives ordered, checksummed migrations recorded in
# `supabase_migrations.schema_migrations` — which is what an auditable credit
# ledger needs.
#
# Usage: pnpm db:migrate

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "${REPO_ROOT}/.env" | tail -n 1)"

if [[ -z "$DATABASE_URL" ]]; then
  echo "error: DATABASE_URL is not set in .env — run: pnpm secrets:generate" >&2
  exit 1
fi

echo "Applying migrations to the local stack..."
exec supabase db push \
  --db-url "$DATABASE_URL" \
  --include-all \
  --workdir "${REPO_ROOT}"
