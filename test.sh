#!/usr/bin/env bash
# DeepCode repository test entrypoint. Suite selection and execution live in the controller.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec /usr/bin/python3 -I -S \
  "$ROOT_DIR/scripts/test-controller.py" \
  --registry "$ROOT_DIR/tests/registry.json" \
  "$@"
