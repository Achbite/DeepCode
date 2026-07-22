#!/usr/bin/env bash
# Registered non-authoritative Session smoke runner. Invoke through test.sh.
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "${DEEPCODE_TEST_CONTROLLER:-0}" != "1" ] \
  || [ "${DEEPCODE_TEST_SUITE_ID:-}" != "session.smoke" ]; then
  printf '%s\n' "session-smoke.sh is an internal runner; use bash ./test.sh --profile smoke" >&2
  exit 2
fi

for tool in node pnpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '[FAIL] %s is required\n' "$tool" >&2
    exit 1
  fi
done

printf '[INFO] Session smoke TypeScript build\n'
pnpm --filter @deepcode/protocol build
pnpm --filter @deepcode/session-core build

printf '[INFO] Focused Session agent-loop and historical-defect smoke checks\n'
pnpm --filter @deepcode/session-core test:smoke:internal
printf '[PASS] Session smoke checks\n'
