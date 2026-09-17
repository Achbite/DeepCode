#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
[ -f /.dockerenv ] || { printf 'Run native development in the project Docker container.\n' >&2; exit 1; }
bash build.sh --stage ui
cargo build -p deepcode-first-party-tools -p deepcode-kernel-daemon -p deepcode-host-web
NATIVE="${CARGO_TARGET_DIR:-$ROOT_DIR/target}/debug"
export DEEPCODE_KERNEL_DAEMON_BIN="$NATIVE/deepcode-kernel-daemon"
export DEEPCODE_HOST_WEB_BIN="$NATIVE/deepcode-host-web"
export DEEPCODE_CLIENT_DIST="$ROOT_DIR/userspace/gui/dist-deepcode-gui"
export DEEPCODE_SESSION_BRIDGE="$ROOT_DIR/userspace/session-core/dist/sessionServiceBridge.js"
export DEEPCODE_NODE="$(command -v node)"
exec pnpm --filter @deepcode/deepcode-gui-shell tauri:dev
