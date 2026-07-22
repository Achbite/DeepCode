#!/usr/bin/env bash
# Repository-static checks exposed as an explicit registered suite.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "${DEEPCODE_TEST_CONTROLLER:-0}" != "1" ] \
  || [ "${DEEPCODE_TEST_SUITE_ID:-}" != "repository.static" ]; then
  printf '%s\n' "static-contracts.sh is an internal runner; use bash ./test.sh --profile static" >&2
  exit 2
fi

for tool in bash; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '[FAIL] %s is required\n' "$tool" >&2
    exit 1
  fi
done

for tool_path in /usr/bin/git /usr/bin/python3; do
  if [ ! -x "$tool_path" ]; then
    printf '[FAIL] %s is required for trusted test governance\n' "$tool_path" >&2
    exit 1
  fi
done

for script in \
  test.sh \
  build.sh \
  scripts/branch-flow.sh \
  scripts/test-branch-flow.sh \
  scripts/check-architecture.sh \
  scripts/cargo-with-fallback.sh \
  scripts/macos-package-service.sh \
  scripts/package-macos.sh \
  scripts/tests/static-contracts.sh \
  scripts/tests/repository-required.sh \
  scripts/tests/session-smoke.sh
do
  bash -n "$script"
done

/usr/bin/python3 -I -S - "$ROOT_DIR/scripts/test-controller.py" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
compile(path.read_text(encoding="utf-8"), str(path), "exec")
PY

/usr/bin/python3 -I -S - "$ROOT_DIR/scripts/test-change-gate.py" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
compile(path.read_text(encoding="utf-8"), str(path), "exec")
PY

/usr/bin/python3 -I -S ./scripts/tests/controller-contracts.py
/usr/bin/python3 -I -S ./scripts/tests/test-change-gate-contracts.py

bash ./scripts/check-architecture.sh
bash ./scripts/test-branch-flow.sh

printf '[PASS] repository static contracts\n'
