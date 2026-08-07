#!/usr/bin/env bash
# Build, install, and launch MathTutor on a simulator against a local backend.
#
# The device token is *compiled in*, not injected: this runs
# scripts/sync-backend-config.sh first, which writes the gitignored
# MathTutor/Config/Backend.local.xcconfig from .env.local. The base URL is the
# one thing still passed at launch, as a DEBUG-only override of
# BackendConfiguration.permanentBaseURL, so a simulator run can point at
# http://localhost:8080 without editing that constant.
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

# Compiles the token into the build. Exits nonzero with its own instructions
# when there is no token to find, so this script does not repeat them.
"${ROOT}/scripts/sync-backend-config.sh"

BACKEND_URL="${MATHTUTOR_BACKEND_URL:-}"
if [[ -z "$BACKEND_URL" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  BACKEND_URL="${MATHTUTOR_BACKEND_URL:-}"
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

if [[ -n "$BACKEND_URL" ]]; then
  echo "==> Launching against ${BACKEND_URL}"
  SIMCTL_CHILD_MATHTUTOR_BACKEND_URL="$BACKEND_URL" \
    xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
else
  echo "==> Launching against the shipped address"
  xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
fi

echo "==> Running. The token is in the build; the base URL override lasts only for this launch."
