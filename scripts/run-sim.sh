#!/usr/bin/env bash
# Build, install, and launch MathTutor on a simulator with the development API key
# injected from a gitignored .env.local, so the key never has to be retyped in
# Settings. The app side is DEBUG-only; see MathTutor/DebugAPIKeyInjection.swift.
#
# Usage:
#   scripts/run-sim.sh              build, install, launch
#   SKIP_BUILD=1 scripts/run-sim.sh install and launch the last build
#   MATHTUTOR_SIM_DEVICE="iPhone 17" scripts/run-sim.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEME="MathTutor"
BUNDLE_ID="com.nordup.MathTutor"
ENV_FILE="${ROOT}/.env.local"
DERIVED="${ROOT}/build/DerivedData"
DEVICE="${MATHTUTOR_SIM_DEVICE:-iPad Pro 13-inch (M5)}"

KEY="${MATHTUTOR_OPENAI_API_KEY:-}"
if [[ -z "$KEY" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  KEY="${MATHTUTOR_OPENAI_API_KEY:-}"
fi

if [[ -z "$KEY" ]]; then
  cat >&2 <<EOF
No API key found.

Create ${ENV_FILE} containing:

  MATHTUTOR_OPENAI_API_KEY=sk-...

That file is gitignored. Alternatively export MATHTUTOR_OPENAI_API_KEY yourself.
EOF
  exit 1
fi

UDID="$(xcrun simctl list devices available \
  | grep -F "${DEVICE} (" \
  | head -1 \
  | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')"

if [[ -z "$UDID" ]]; then
  echo "No available simulator named '${DEVICE}'. See: xcrun simctl list devices available" >&2
  exit 1
fi

echo "==> Simulator: ${DEVICE} (${UDID})"
xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "==> Building ${SCHEME} (Debug)"
  xcodebuild \
    -project "${ROOT}/MathTutor.xcodeproj" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "id=${UDID}" \
    -derivedDataPath "$DERIVED" \
    build
fi

APP="${DERIVED}/Build/Products/Debug-iphonesimulator/${SCHEME}.app"
if [[ ! -d "$APP" ]]; then
  echo "Built app not found at ${APP}. Run without SKIP_BUILD first." >&2
  exit 1
fi

echo "==> Installing"
xcrun simctl install "$UDID" "$APP"

echo "==> Launching with injected key"
SIMCTL_CHILD_MATHTUTOR_OPENAI_API_KEY="$KEY" \
  xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null

echo "==> Running. The key is seeded into the simulator Keychain and persists across relaunches."
