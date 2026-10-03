#!/usr/bin/env bash
#
# One-command setup for a clean machine.
#
# Order matters: secrets must exist before the stack starts, and the app cannot
# be built before its workspace packages are built.
#
# Usage:
#   bash scripts/bootstrap.sh          # setup only
#   bash scripts/bootstrap.sh --start  # setup, then start the stack

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

START_STACK=false
[[ "${1:-}" == "--start" ]] && START_STACK=true

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# --- prerequisites ---------------------------------------------------------

step "Checking prerequisites"

command -v node >/dev/null 2>&1 || fail "node is required (>=22)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || fail "node >=22 required, found $(node -v)"
printf '  node        %s\n' "$(node -v)"

command -v pnpm >/dev/null 2>&1 || fail "pnpm is required (run: corepack enable pnpm)"
printf '  pnpm        %s\n' "$(pnpm -v)"

command -v docker >/dev/null 2>&1 || fail "docker is required"
docker info >/dev/null 2>&1 || fail "docker is installed but not running"
printf '  docker      %s\n' "$(docker -v | head -1)"

command -v openssl >/dev/null 2>&1 || fail "openssl is required"
printf '  openssl     %s\n' "$(openssl version)"

if command -v supabase >/dev/null 2>&1; then
  printf '  supabase    %s (optional)\n' "$(supabase --version 2>/dev/null | head -1)"
else
  warn "supabase CLI not found — pnpm db:migrate / db:types will not work"
  warn "install: brew install supabase/tap/supabase"
fi

# --- dependencies ----------------------------------------------------------

step "Installing workspace dependencies"
pnpm install

# --- secrets ---------------------------------------------------------------

step "Generating secrets"
bash scripts/generate-secrets.sh

# --- build -----------------------------------------------------------------

step "Building shared packages"
pnpm turbo run build --filter='./packages/*'

# --- summary ---------------------------------------------------------------

printf '\n\033[1mBootstrap complete.\033[0m\n\n'

if [[ "$START_STACK" == true ]]; then
  step "Starting the local Supabase stack"
  pnpm dev:stack
  pnpm dev:stack:health
else
  cat <<'EOF'
Next steps:

  pnpm dev:stack      # start the local Supabase stack
  pnpm dev:stack:health
  pnpm dev            # start the web app on http://localhost:3000

EOF
fi

cat <<'EOF'
Useful URLs once the stack is up:

  Studio    http://localhost:3002   (user: supabase, password: see docker/.env)
  API       http://localhost:8000
  Mailpit   http://localhost:8025   (captures every Auth email)

EOF
