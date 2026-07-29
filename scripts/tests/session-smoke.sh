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
  communication|tools|paths|loop) ;;
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

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deepcode-session-smoke.XXXXXX")"
trap 'rm -rf "$LOG_DIR"' EXIT

run_quiet() {
  local label="$1"
  shift
  local log_path="$LOG_DIR/$(printf '%s' "$label" | tr ' /' '__').log"
  if "$@" >"$log_path" 2>&1; then
    return 0
  fi
  while IFS= read -r line; do
    printf '[FAIL] %s\n' "$line" >&2
  done <"$log_path"
  printf '[FAIL] %s\n' "$label" >&2
  exit 1
}

printf '[INFO] Session smoke group=%s: TypeScript build\n' "$GROUP"
run_quiet "Protocol production build" \
  pnpm --filter @deepcode/protocol build
run_quiet "Session production build" \
  pnpm --filter @deepcode/session-core build
[ ! -e userspace/session-core/dist/__tests__ ] || {
  printf '[FAIL] Session production output contains test assets\n' >&2
  exit 1
}

printf '[INFO] Session smoke group=%s: registered runtime-path checks\n' "$GROUP"
node "userspace/session-core/tests/smoke/runner.mjs" "$GROUP"
