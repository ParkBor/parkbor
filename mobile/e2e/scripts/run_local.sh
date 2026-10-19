#!/usr/bin/env bash
# Local runner: loads mobile/e2e/.env.e2e into `maestro test -e` arguments.
#   bash mobile/e2e/scripts/run_local.sh --include-tags=smoke
# Extra arguments are passed to `maestro test` before the flow directory.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${E2E_ENV_FILE:-$E2E_DIR/.env.e2e}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy e2e.env.example)"; exit 1; }
command -v maestro >/dev/null || { echo "maestro CLI not found (README: Install)"; exit 1; }

args=()
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  args+=(-e "$line")
done < "$ENV_FILE"

# A flow file among the arguments runs just that flow; otherwise the whole directory runs.
target=("$E2E_DIR")
for arg in "$@"; do
  case "$arg" in *.yaml) target=() ;; esac
done

exec maestro test "${args[@]}" "$@" "${target[@]}"
