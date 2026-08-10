#!/usr/bin/env bash
# Required Session v2 orchestration contracts. Invoke only through test.sh.
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "${DEEPCODE_TEST_CONTROLLER:-0}" != "1" ] \
  || [ "${DEEPCODE_TEST_SUITE_ID:-}" != "session.v2.contracts" ]; then
  printf '%s\n' "session-v2-contracts.sh is an internal runner; use bash ./test.sh --suite session.v2.contracts" >&2
  exit 2
fi

info() { printf '[INFO] %s\n' "$*"; }
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deepcode-session-v2.XXXXXX")"
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
  fail "$label"
}

for tool in node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done

info "Session v2 production packages"
run_quiet "Protocol production build" \
  pnpm --filter @deepcode/protocol build
run_quiet "Session production build" \
  pnpm --filter @deepcode/session-core build
run_quiet "GUI TypeScript build" \
  pnpm --filter @deepcode/client build:types
[ ! -e userspace/session-core/dist/__tests__ ] \
  || fail "Session production output contains test assets"
pass "Session v2 production packages"

info "TypeScript consumption of shared Kernel-Session v2 wire vectors"
node userspace/protocol/tests/kernel-v2-wire-contract.mjs
pass "TypeScript consumption of shared Kernel-Session v2 wire vectors"

info "Session v2 orchestration, recovery, and review contracts"
node userspace/session-core/tests/v2/runner.mjs
pass "Session v2 orchestration, recovery, and review contracts"

info "GUI canonical progress and Session switching contracts"
node userspace/gui/tests/agent-session-store-contracts.mjs
pass "GUI canonical progress and Session switching contracts"
