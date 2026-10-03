#!/usr/bin/env bash
#
# Verify the local Supabase stack is actually usable.
#
# `docker compose up --wait` already waits for healthchecks; this goes further and
# checks the things a green container status does not prove:
#   • the gateway actually answers through Kong/Envoy
#   • Studio answers
#   • Postgres accepts the password from our .env
#   • the JWT the app will present verifies against JWT_SECRET
#
# That last one is the failure the task warns about: a mismatch between the keys
# Kong validates and the keys the app signs with looks like "auth is broken" with
# no obvious cause.
#
# Usage:
#   pnpm dev:stack:health

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_ENV="${REPO_ROOT}/docker/.env"

# The stack's variables come from docker/.env — NOT the app's .env. Pointing
# compose at the app env is the bug that makes every container start with an
# empty POSTGRES_PASSWORD.
COMPOSE=(docker compose
  -f "${REPO_ROOT}/docker/docker-compose.yml"
  -f "${REPO_ROOT}/docker/docker-compose.dev.yml"
  --env-file "$STACK_ENV")

PASS=0
FAIL=0
SKIP=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red() { printf '\033[31m%s\033[0m' "$1"; }
yellow() { printf '\033[33m%s\033[0m' "$1"; }

ok() { printf '  %s %s\n' "$(green 'PASS')" "$1"; PASS=$((PASS + 1)); }
no() {
  printf '  %s %s\n' "$(red 'FAIL')" "$1"
  if [[ $# -ge 2 && -n "$2" ]]; then
    printf '       %s\n' "$2"
  fi
  FAIL=$((FAIL + 1))
}
sk() {
  printf '  %s %s\n' "$(yellow 'SKIP')" "$1"
  SKIP=$((SKIP + 1))
}

# Read a variable from the stack's env file (empty string when absent).
env_get() {
  local key="$1"
  [[ -f "$STACK_ENV" ]] || return 0
  sed -n "s/^${key}=//p" "$STACK_ENV" | tail -n 1
}

printf '\nFydio — local Supabase stack health\n\n'

# --- container state -------------------------------------------------------

RUNNING=$("${COMPOSE[@]}" ps --services --filter status=running 2>/dev/null | wc -l | tr -d ' ')
EXPECTED_SERVICES=(db studio api-gw auth rest realtime storage imgproxy meta functions supavisor mailpit)
TOTAL=${#EXPECTED_SERVICES[@]}

if [[ "$RUNNING" -eq "$TOTAL" ]]; then
  ok "all ${TOTAL} services running"
else
  no "only ${RUNNING}/${TOTAL} services running" "run: pnpm dev:stack"
fi

# --- health status ---------------------------------------------------------

UNHEALTHY=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null \
  | awk '$2 != "" && $2 != "healthy" { print $1 " (" $2 ")" }' \
  | paste -sd', ' -)

if [[ -z "$UNHEALTHY" ]]; then
  ok "every service reports healthy"
else
  no "unhealthy: ${UNHEALTHY}"
fi

# --- HTTP endpoints -------------------------------------------------------

API_PORT="$(env_get API_GW_HTTP_PORT)"
API_PORT="${API_PORT:-8000}"
STUDIO_PORT="$(env_get STUDIO_HOST_PORT)"
STUDIO_PORT="${STUDIO_PORT:-3002}"
MAILPIT_PORT="$(env_get MAILPIT_UI_HOST_PORT)"
MAILPIT_PORT="${MAILPIT_PORT:-8025}"

# $1 label, $2 url, $3 expected code ("" to accept any), $4 optional apikey.
check_http() {
  local name="$1" url="$2" expect="${3:-}" apikey="${4:-}"
  local body code status

  if [[ -n "$apikey" ]]; then
    body=$(curl -fsS --max-time 10 -H "apikey: ${apikey}" -w '\n%{http_code}' "$url" 2>/dev/null)
  else
    body=$(curl -fsS --max-time 10 -w '\n%{http_code}' "$url" 2>/dev/null)
  fi
  status=$?

  if [[ $status -ne 0 ]]; then
    no "$name — unreachable" "$url"
    return
  fi

  code="${body##*$'\n'}"
  if [[ -n "$expect" && "$code" != "$expect" ]]; then
    no "$name — HTTP ${code}, expected ${expect}" "$url"
    return
  fi

  ok "$name — HTTP ${code}"
}

# Kong/Envoy rejects unauthenticated calls with 401, so this needs the anon key
# even though /health is nominally open.
ANON_KEY_HEALTH="$(env_get ANON_KEY)"
check_http "Auth health through the gateway" "http://localhost:${API_PORT}/auth/v1/health" "200" "$ANON_KEY_HEALTH"
check_http "Studio" "http://localhost:${STUDIO_PORT}/" ""
check_http "Mailpit" "http://localhost:${MAILPIT_PORT}/api/v1/info" ""

# --- database connectivity ------------------------------------------------

PG_HOST_PORT="$(env_get POSTGRES_HOST_PORT)"
PG_HOST_PORT="${PG_HOST_PORT:-54322}"

if "${COMPOSE[@]}" exec -T db pg_isready -U postgres -q 2>/dev/null; then
  ok "Postgres accepts connections"

  # The password from .env must work, not just any password.
  PW="$(env_get POSTGRES_PASSWORD)"
  # The password must be passed into the container's environment; a local
  # PGPASSWORD prefix would not reach `docker compose exec`.
  if [[ -n "$PW" ]] && "${COMPOSE[@]}" exec -T -e PGPASSWORD="$PW" db \
    psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok "Postgres accepts the password from .env"
  else
    no "Postgres rejects the password from .env" "docker/.env may be out of sync with the running volume"
  fi
else
  no "Postgres not accepting connections"
fi

# --- key consistency ------------------------------------------------------

# Verify a JWT signature the way the gateway will.
#
# Implemented in Node rather than an `openssl dgst` pipeline because openssl's
# stdin handling produced a signature that disagreed with Node's own HMAC — and
# Node's implementation is the one PostgREST and Kong actually use. A health
# check that verifies with the wrong algorithm is worse than no check.
verify_jwt() {
  local token="$1" secret="$2"

  TOKEN="$token" SECRET="$secret" node -e '
    const c = require("crypto")
    const [h, p, s] = process.env.TOKEN.split(".")
    const expected = c.createHmac("sha256", process.env.SECRET).update(`${h}.${p}`).digest("base64url")
    process.stdout.write(expected === s ? "match" : "mismatch")
  ' 2>/dev/null
}

# The keys the gateway validates must verify against the secret the app signs
# with. A mismatch here presents as "auth silently does nothing".
JWT_SECRET_VALUE="$(env_get JWT_SECRET)"

if [[ -z "$JWT_SECRET_VALUE" ]]; then
  sk "JWT_SECRET not set — run: pnpm secrets:generate"
else
  for var in ANON_KEY SERVICE_ROLE_KEY; do
    VALUE="$(env_get "$var")"

    if [[ -z "$VALUE" ]]; then
      sk "${var} not set"
      continue
    fi

    if [[ "$(verify_jwt "$VALUE" "$JWT_SECRET_VALUE")" == "match" ]]; then
      ok "${var} verifies against JWT_SECRET"
    else
      no "${var} does not verify against JWT_SECRET" \
        "the gateway and the app would disagree on every token"
    fi
  done
fi

# The app's anon key must equal the stack's, or the browser presents a key the
# gateway rejects with a message that reads like an auth bug.
APP_ANON="$(sed -n 's/^NEXT_PUBLIC_SUPABASE_ANON_KEY=//p' "${REPO_ROOT}/.env" | tail -n 1)"
STACK_ANON="$(env_get ANON_KEY)"
if [[ -n "$APP_ANON" && -n "$STACK_ANON" ]]; then
  if [[ "$APP_ANON" == "$STACK_ANON" ]]; then
    ok "app and stack anon keys match"
  else
    no "app and stack anon keys differ" "re-run: pnpm secrets:generate"
  fi
else
  sk "app anon key not set"
fi

# --- summary --------------------------------------------------------------

printf '\n  %s passed, %s failed, %s skipped\n\n' \
  "$(green "$PASS")" "$([[ $FAIL -gt 0 ]] && red "$FAIL" || echo 0)" "$SKIP"

if [[ $FAIL -gt 0 ]]; then
  printf 'Logs: pnpm dev:stack:logs\n\n'
  exit 1
fi

printf '\nReady. Start the app with: pnpm dev\n\n'
