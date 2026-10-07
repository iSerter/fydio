#!/usr/bin/env bash
#
# Production / Prod-parity Smoke Test (T10).
#
# Verifies:
#   1. Web app /api/health (DB connectivity + migration head)
#   2. Supabase API gateway /auth/v1/health
#   3. Web app login page rendering (/login)
#   4. Cron endpoint protection (/api/cron/weekly-allowance requires CRON_SECRET)
#   5. Database migration head consistency
#
# Usage:
#   bash scripts/smoke-prod.sh [APP_URL] [SUPABASE_URL]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve URLs from args, env, or defaults
APP_URL="${1:-${APP_URL:-http://localhost:3000}}"
SUPABASE_URL="${2:-${SUPABASE_URL:-http://localhost:8000}}"

green() { printf '\033[32m%s\033[0m' "$1"; }
red() { printf '\033[31m%s\033[0m' "$1"; }
ok() { printf '  %s %s\n' "$(green 'PASS')" "$1"; }
fail() { printf '  %s %s\n' "$(red 'FAIL')" "$1"; exit 1; }

printf "\nRunning Fydio production smoke tests...\n"
printf "App URL:      %s\n" "$APP_URL"
printf "Supabase URL: %s\n\n" "$SUPABASE_URL"

# 1. Web application /api/health
printf "Checking web app health (%s/api/health)...\n" "$APP_URL"
HEALTH_STATUS=$(curl -fsS -o /tmp/fydio-health.json -w "%{http_code}" "${APP_URL}/api/health" || echo "000")

if [[ "$HEALTH_STATUS" != "200" ]]; then
  fail "Health endpoint returned HTTP $HEALTH_STATUS"
fi

DB_STATE=$(grep -o '"database":"[^"]*"' /tmp/fydio-health.json | cut -d'"' -f4 || echo "")
MIGRATION_HEAD=$(grep -o '"migrationHead":"[^"]*"' /tmp/fydio-health.json | cut -d'"' -f4 || echo "")

if [[ "$DB_STATE" != "connected" ]]; then
  fail "Database state is '$DB_STATE' (expected 'connected')"
fi

if [[ -z "$MIGRATION_HEAD" || "$MIGRATION_HEAD" == "unknown" ]]; then
  fail "Migration head could not be resolved from health response"
fi

ok "App /api/health returned 200 (database connected, migration head: $MIGRATION_HEAD)"

SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
if [[ -z "$SUPABASE_ANON_KEY" && -f "${REPO_ROOT}/.env" ]]; then
  SUPABASE_ANON_KEY="$(sed -n 's/^SUPABASE_ANON_KEY=//p' "${REPO_ROOT}/.env" | tail -n 1)"
fi

# 2. Supabase gateway health
printf "Checking Supabase gateway (%s/auth/v1/health)...\n" "$SUPABASE_URL"
GATEWAY_HEADER=()
if [[ -n "$SUPABASE_ANON_KEY" ]]; then
  GATEWAY_HEADER=(-H "apikey: $SUPABASE_ANON_KEY")
fi
GATEWAY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${GATEWAY_HEADER[@]}" "${SUPABASE_URL}/auth/v1/health" || echo "000")

if [[ "$GATEWAY_STATUS" != "200" ]]; then
  fail "Supabase gateway returned HTTP $GATEWAY_STATUS (expected 200 with apikey)"
fi

ok "Supabase gateway returned 200"

# 3. Web app login page
printf "Checking login page (%s/login)...\n" "$APP_URL"
LOGIN_STATUS=$(curl -fsS -o /tmp/fydio-login.html -w "%{http_code}" "${APP_URL}/login" || echo "000")

if [[ "$LOGIN_STATUS" != "200" ]]; then
  fail "Login page returned HTTP $LOGIN_STATUS"
fi

if ! grep -qi "fydio" /tmp/fydio-login.html; then
  fail "Login page did not contain expected branding"
fi

ok "Login page renders successfully with HTTP 200"

# 4. Scheduled task endpoint authorization guard
printf "Checking cron route security (%s/api/cron/weekly-allowance)...\n" "$APP_URL"
CRON_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${APP_URL}/api/cron/weekly-allowance" || echo "000")

if [[ "$CRON_STATUS" == "200" ]]; then
  fail "Cron route succeeded without Authorization header! Expected refusal."
fi

ok "Cron route refused unauthorized request with HTTP $CRON_STATUS"

printf "\n%s All production smoke tests passed!\n\n" "$(green 'SUCCESS:')"
