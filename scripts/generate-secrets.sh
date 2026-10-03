#!/usr/bin/env bash
#
# Generate Supabase stack secrets and the app's .env.
#
# IDEMPOTENT BY DESIGN: a variable that already has a value is left untouched.
# This matters because the JWT secret and the API keys are derived from one
# another — regenerating them separately would invalidate every issued session
# and, worse, could leave Kong validating tokens against a different key than
# the app signs with. So: fill blanks only, never rotate.
#
# Usage:
#   pnpm secrets:generate

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_ENV="${REPO_ROOT}/docker/.env"
APP_ENV="${REPO_ROOT}/.env"

log() { printf '  %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v openssl >/dev/null 2>&1 || fail "openssl is required but was not found on PATH"

# --- helpers ---------------------------------------------------------------

# Read the current value of KEY from an env file (empty string when absent).
env_get() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# Set KEY to VALUE only when it is currently empty. Returns 1 if it wrote.
env_set_if_empty() {
  local file="$1" key="$2" value="$3"
  local current
  current="$(env_get "$file" "$key")"

  if [[ -n "$current" ]]; then
    return 1
  fi

  if grep -q "^${key}=" "$file"; then
    # BSD and GNU sed disagree on -i, so write via a temp file.
    local tmp
    tmp="$(mktemp)"
    sed "s|^${key}=.*|${key}=${value}|" "$file" >"$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi

  return 0
}

# Set KEY unconditionally — only used for values derived from a secret we own.
env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"

  if grep -q "^${key}=" "$file"; then
    sed "s|^${key}=.*|${key}=${value}|" "$file" >"$tmp"
  else
    cat "$file" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi

  mv "$tmp" "$file"
}

# base64url without padding — JWT segments cannot contain + / =
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Mint an HS256 JWT signed with SECRET, matching Supabase's legacy key format.
# $1 secret, $2 role, $3 iat
make_jwt() {
  local secret="$1" role="$2" iat="$3"
  local header payload signature

  header=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  # Keys are pretty-printed JSON in the upstream examples; whitespace is
  # insignificant inside a JWT, so a compact form is equivalent.
  payload=$(printf '{"role":"%s","iss":"supabase-local","iat":%s,"exp":%s}' \
    "$role" "$iat" "$((iat + 315360000))" | b64url)

  signature=$(printf '%s' "${header}.${payload}" \
    | openssl dgst -sha256 -hmac "$secret" -binary | b64url)

  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

# --- bootstrap files -------------------------------------------------------

if [[ ! -f "$STACK_ENV" ]]; then
  log "creating docker/.env from the template"
  cp "${REPO_ROOT}/docker/.env.example" "$STACK_ENV"
else
  log "docker/.env already exists — filling blanks only"
fi

if [[ ! -f "$APP_ENV" ]]; then
  log "creating .env from the template"
  cp "${REPO_ROOT}/.env.example" "$APP_ENV"
else
  log ".env already exists — filling blanks only"
fi

# --- secrets ---------------------------------------------------------------

log "generating secrets (existing values are preserved)"

set_if_generated() {
  local key="$1" value="$2"
  if env_set_if_empty "$STACK_ENV" "$key" "$value"; then
    log "  generated ${key}"
  else
    log "  kept existing ${key}"
  fi
}

set_if_generated POSTGRES_PASSWORD "$(openssl rand -base64 32 | tr -d '\n')"
set_if_generated JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
set_if_generated SECRET_KEY_BASE "$(openssl rand -base64 48 | tr -d '\n')"
set_if_generated REALTIME_DB_ENC_KEY "$(openssl rand -hex 8)"
set_if_generated VAULT_ENC_KEY "$(openssl rand -hex 16)"
set_if_generated PG_META_CRYPTO_KEY "$(openssl rand -base64 24 | tr -d '\n')"
set_if_generated IMGPROXY_KEY "$(openssl rand -hex 16)"

# Studio password stays operator-chosen in the upstream default; generate one so a
# fresh checkout has no placeholder credential.
set_if_generated DASHBOARD_PASSWORD "$(openssl rand -hex 12)"

# The API keys must be signed with the same JWT_SECRET the gateway validates
# against, so they are derived from the secret rather than generated independently.
JWT_SECRET_VALUE="$(env_get "$STACK_ENV" JWT_SECRET)"
IAT="$(date +%s)"

ANON_KEY_VALUE="$(env_get "$STACK_ENV" ANON_KEY)"
if [[ -z "$ANON_KEY_VALUE" ]]; then
  env_set "$STACK_ENV" ANON_KEY "$(make_jwt "$JWT_SECRET_VALUE" anon "$IAT")"
  log "  generated ANON_KEY (signed with JWT_SECRET)"
else
  log "  kept existing ANON_KEY"
fi

SERVICE_ROLE_KEY_VALUE="$(env_get "$STACK_ENV" SERVICE_ROLE_KEY)"
if [[ -z "$SERVICE_ROLE_KEY_VALUE" ]]; then
  env_set "$STACK_ENV" SERVICE_ROLE_KEY "$(make_jwt "$JWT_SECRET_VALUE" service_role "$IAT")"
  log "  generated SERVICE_ROLE_KEY (signed with JWT_SECRET)"
else
  log "  kept existing SERVICE_ROLE_KEY"
fi

# --- mirror into the app env ----------------------------------------------

# The app's env is a view of the stack's env, not an independent source: a
# mismatch here is the single most likely cause of "auth works in Studio but not
# in the app".
#
# Arguments are <stack_key> <app_key>, kept as two names because they differ.
# Reading them positionally off one name is how `SUPABASE_ANON_KEY` once ended
# up holding the *service role* key, which would hand every RLS-restricted table
# away to the browser.
mirror() {
  local stack_key="$1" app_key="$2"
  local value
  value="$(env_get "$STACK_ENV" "$stack_key")"

  if [[ -n "$value" ]] && env_set_if_empty "$APP_ENV" "$app_key" "$value"; then
    log "  mirrored ${app_key} from ${stack_key}"
  fi
}

mirror ANON_KEY SUPABASE_ANON_KEY
mirror SERVICE_ROLE_KEY SUPABASE_SERVICE_ROLE_KEY
mirror ANON_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY
mirror JWT_SECRET SUPABASE_JWT_SECRET

# DATABASE_URL must carry the real password, percent-encoded.
PG_PASSWORD="$(env_get "$STACK_ENV" POSTGRES_PASSWORD)"
PG_HOST_PORT="$(env_get "$STACK_ENV" POSTGRES_HOST_PORT)"
PG_HOST_PORT="${PG_HOST_PORT:-54322}"
if [[ -n "$PG_PASSWORD" ]]; then
  ENCODED_PW="$(printf '%s' "$PG_PASSWORD" | node -e \
    'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(encodeURIComponent(d)))' \
    2>/dev/null || printf '%s' "$PG_PASSWORD")"

  # sslmode=disable: the local Postgres does not terminate TLS, and the CLI
  # defaults to requiring it for any non-localhost-looking host string.
  env_set "$APP_ENV" DATABASE_URL "postgresql://postgres:${ENCODED_PW}@localhost:${PG_HOST_PORT}/postgres?sslmode=disable"
  log "  set DATABASE_URL in .env"
fi

# Warnings for values an operator must change before this is not a dev machine.
if [[ "$(env_get "$STACK_ENV" DASHBOARD_USERNAME)" == "supabase" ]]; then
  warn "DASHBOARD_USERNAME is still the upstream default"
fi

log ""
log "done. Start the stack with: pnpm dev:stack"
