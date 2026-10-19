#!/usr/bin/env bash
# Runs inside the emulator started by reactivecircus/android-emulator-runner (that action executes the
# `script:` lines one by one, so anything multi-line lives here). Env comes from the workflow:
#   APK_PATH, HABI_E2E_HOOK_KEY, E2E_TAGS, REPORT_DIR, E2E_*_LOT_NAME
set -euo pipefail

: "${APK_PATH:?}" "${HABI_E2E_HOOK_KEY:?}" "${E2E_TAGS:?}" "${REPORT_DIR:?}"
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

adb install -r "$APK_PATH"
adb reverse tcp:8000 tcp:8000   # the app talks to localhost:8000 (eas.json development env)

mkdir -p "$REPORT_DIR"
maestro test \
  --include-tags="$E2E_TAGS" \
  -e E2E_HOOK_KEY="$HABI_E2E_HOOK_KEY" \
  -e E2E_PAY_LOT_NAME="${E2E_PAY_LOT_NAME:-LT-payments-e2e}" \
  -e E2E_WS_LOT_NAME="${E2E_WS_LOT_NAME:-LT-ws0-e2e}" \
  -e E2E_GATE_LOT_NAME="${E2E_GATE_LOT_NAME:-LT-gate-e2e}" \
  --format junit --output "$REPORT_DIR/e2e-junit.xml" \
  --test-output-dir "$REPORT_DIR/artifacts" \
  "$E2E_DIR"
