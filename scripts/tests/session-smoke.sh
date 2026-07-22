#!/usr/bin/env bash
# Registered non-authoritative Session smoke group runner. Invoke through test.sh.
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "$#" -ne 1 ]; then
  printf '%s\n' "session-smoke.sh requires one controller-selected group" >&2
  exit 2
fi

GROUP="$1"
case "$GROUP" in
  communication|tools|paths|authorization) ;;
  *)
    printf '[FAIL] unknown Session smoke group: %s\n' "$GROUP" >&2
    exit 2
    ;;
esac

EXPECTED_SUITE_ID="session.smoke.$GROUP"
if [ "${DEEPCODE_TEST_CONTROLLER:-0}" != "1" ] \
  || [ "${DEEPCODE_TEST_SUITE_ID:-}" != "$EXPECTED_SUITE_ID" ] \
  || [ "${DEEPCODE_TEST_SMOKE_GROUP:-}" != "$GROUP" ] \
  || [ -z "${DEEPCODE_TEST_CASE_IDS:-}" ]; then
  printf '%s\n' "session-smoke.sh is an internal runner; use bash ./test.sh --profile smoke" >&2
  exit 2
fi

for tool in node pnpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '[FAIL] %s is required\n' "$tool" >&2
    exit 1
  fi
done

printf '[INFO] Session smoke group=%s: TypeScript build\n' "$GROUP"
pnpm --filter @deepcode/protocol build
pnpm --filter @deepcode/session-core build

printf '[INFO] Session smoke group=%s: registered runtime-path checks\n' "$GROUP"
node "userspace/session-core/dist/__tests__/smoke/runner.js" "$GROUP"
