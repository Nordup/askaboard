#!/usr/bin/env bash
# Blocks test-suite runs from Claude sessions.
#
# Reason: several Claude sessions share this Mac. Concurrent `xcodebuild test`
# and `pytest` runs saturate the CPU, contend on DerivedData, and contend on
# the shared Neon test branch. Every build/code cycle gets much slower.
#
# Escape hatch for the user: start ONE session with the tests allowed:
#     CLAUDE_ALLOW_TESTS=1 claude
# The variable is read from this hook's own environment, so a model cannot
# get past the block by putting the variable in front of the command.
#
# The check looks at the EXECUTABLE position of each command segment only.
# `grep pytest ...` or `ls server/tests` stay allowed; only real runs block.

set -uo pipefail
set -f # no globbing while tokenizing

# The designated session runs tests normally.
if [ -n "${CLAUDE_ALLOW_TESTS:-}" ]; then
  exit 0
fi

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null)
[ -z "$cmd" ] && exit 0

is_test=0

while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  # shellcheck disable=SC2086
  set -- $seg
  [ $# -eq 0 ] && continue

  # Step past env assignments and wrapper commands to reach the real executable.
  while [ $# -gt 0 ]; do
    case "$1" in
      *=*)
        shift
        continue
        ;;
    esac
    case "$(basename -- "$1")" in
      env | time | nice | caffeinate | sudo | xcrun | npx | uvx | command | exec)
        shift
        continue
        ;;
      uv | poetry | pipenv | pdm | hatch | rye)
        if [ "${2:-}" = "run" ]; then
          shift 2
          continue
        fi
        break
        ;;
    esac
    break
  done
  [ $# -eq 0 ] && continue

  case "$(basename -- "$1")" in
    pytest | py.test | xctest)
      is_test=1
      ;;
    python | python3)
      printf '%s' "$*" | grep -Eq '(^|[[:space:]])-m[[:space:]]+py\.?test([[:space:]]|$)' && is_test=1
      ;;
    swift)
      [ "${2:-}" = "test" ] && is_test=1
      ;;
    xcodebuild)
      printf '%s' "$*" | grep -Eq '(^|[[:space:]])(test|test-without-building|build-for-testing)([[:space:]]|$)' && is_test=1
      ;;
  esac
done <<EOF
$(printf '%s' "$cmd" | tr ';|&\n' '\n\n\n\n')
EOF

if [ "$is_test" -eq 1 ]; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "BLOCKED: test-suite runs are disabled in this project. Several Claude sessions share this Mac, and parallel test runs make every build/code cycle far slower for the user. Do NOT retry this command. Do NOT work around it by calling the test binary, xctest, or a runner script directly. Write the tests, then hand the user the exact command in a bash code block and let them run it themselves."
  }
}
JSON
fi

exit 0
