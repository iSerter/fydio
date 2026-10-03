#!/usr/bin/env bash
#
# Report the Supabase image versions this stack is pinned to, and flag drift from
# upstream.
#
# The compose file is vendored, so nothing would tell us when upstream moves
# except reading their repo by hand. This makes that checkable, and CI can call
# it on a schedule.
#
# Usage: bash scripts/check-supabase-version.sh [--check]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="${REPO_ROOT}/docker/docker-compose.yml"

CHECK_MODE=false
[[ "${1:-}" == "--check" ]] && CHECK_MODE=true

echo "Fydio — pinned Supabase images"
echo

grep -E '^[[:space:]]+image:[[:space:]]+' "$COMPOSE" | sed -E 's/^[[:space:]]*image:[[:space:]]*//' | while read -r image; do
  printf '  %s\n' "$image"
done

echo
echo "Support files under docker/volumes/ come from the same upstream commit."
echo "To upgrade: https://github.com/supabase/supabase/tree/master/docker"

if [[ "$CHECK_MODE" == true ]]; then
  # Compare against upstream's current compose. Network is expected to be
  # unavailable in a sandbox, so a failure here is reported, not fatal.
  UPSTREAM_URL="https://raw.githubusercontent.com/supabase/supabase/master/docker/docker-compose.yml"

  if ! UPSTREAM="$(curl -fsSL --max-time 20 "$UPSTREAM_URL" 2>/dev/null)"; then
    echo
    echo "warning: could not reach upstream to compare; skipping drift check"
    exit 0
  fi

  echo
  echo "Comparing against upstream master..."

  local_upstream=$(printf '%s' "$UPSTREAM" | grep -E '^[[:space:]]+image:[[:space:]]+' | sed -E 's/^[[:space:]]*image:[[:space:]]*//' | sort -u)
  local_pinned=$(grep -E '^[[:space:]]+image:[[:space:]]+' "$COMPOSE" | sed -E 's/^[[:space:]]*image:[[:space:]]*//' | sort -u)

  DRIFT=0
  while read -r image; do
    [[ -z "$image" ]] && continue
    if ! printf '%s\n' "$local_pinned" | grep -qx "$image"; then
      if printf '%s\n' "$local_upstream" | grep -qx "$image"; then
        printf '  BEHIND  %s (upstream moved)\n' "$image"
      else
        printf '  LOCAL   %s (ours only)\n' "$image"
      fi
      DRIFT=1
    fi
  done <<<"$local_upstream"

  if [[ $DRIFT -eq 0 ]]; then
    echo "  all pinned images match upstream master"
  fi
fi
