#!/usr/bin/env bash
# DeepCode repository test entrypoint. Suite selection and execution live in the controller.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

printf '%s\n' \
  '[NOTICE] test.sh results are supporting evidence only; they are not fully trusted and do not constitute final acceptance.' >&2

exec /usr/bin/python3 -I -S \
  "$ROOT_DIR/scripts/test-controller.py" \
  "$@"
