#!/usr/bin/env bash
# Required Host v2 public-path integration. Invoke only through test.sh.
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "${DEEPCODE_TEST_CONTROLLER:-0}" != "1" ] \
  || [ "${DEEPCODE_TEST_SUITE_ID:-}" != "host.v2.integration" ]; then
  printf '%s\n' "host-v2-integration.sh is an internal runner; use bash ./test.sh --suite host.v2.integration" >&2
  exit 2
fi

info() { printf '[INFO] %s\n' "$*"; }
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

for tool in cargo node pnpm python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done

if [ -z "${CARGO_TARGET_DIR:-}" ] && [ -f /.dockerenv ]; then
  export CARGO_TARGET_DIR="$ROOT_DIR/target"
fi
if [ -n "${DEEPCODE_TMPDIR:-}" ]; then
  export TMPDIR="$DEEPCODE_TMPDIR"
elif [ -f /.dockerenv ] && { [ -z "${TMPDIR:-}" ] || [ "${TMPDIR%/}" = "/tmp" ]; }; then
  export TMPDIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target}/.tmp"
fi
mkdir -p "${CARGO_TARGET_DIR:-$ROOT_DIR/target}" "${TMPDIR:-/tmp}"

RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/deepcode-host-v2-run.XXXXXX")"
OWNER_PGIDS="$RUN_ROOT/owned-pgids"
LOG_DIR="$RUN_ROOT/build-logs"
mkdir -p "$LOG_DIR"
: >"$OWNER_PGIDS"
chmod 700 "$RUN_ROOT"
chmod 600 "$OWNER_PGIDS"
export DEEPCODE_HOST_V2_RUN_ROOT="$RUN_ROOT"
export DEEPCODE_HOST_V2_OWNER_PGIDS="$OWNER_PGIDS"

cleanup_started=0

owned_group_alive() {
  local pgid="$1"
  kill -0 -- "-$pgid" >/dev/null 2>&1
}

signal_owned_groups() {
  local signal_name="$1"
  local pgid
  [ -f "$OWNER_PGIDS" ] || return 0
  while IFS= read -r pgid; do
    case "$pgid" in
      ''|*[!0-9]*) continue ;;
    esac
    [ "$pgid" -gt 1 ] || continue
    if owned_group_alive "$pgid"; then
      kill "-$signal_name" -- "-$pgid" >/dev/null 2>&1 || true
    fi
  done <"$OWNER_PGIDS"
}

owned_groups_alive() {
  local pgid
  [ -f "$OWNER_PGIDS" ] || return 1
  while IFS= read -r pgid; do
    case "$pgid" in
      ''|*[!0-9]*) continue ;;
    esac
    [ "$pgid" -gt 1 ] || continue
    if owned_group_alive "$pgid"; then
      return 0
    fi
  done <"$OWNER_PGIDS"
  return 1
}

cleanup_owned_resources() {
  local unused
  if [ "$cleanup_started" -eq 1 ]; then
    return 0
  fi
  cleanup_started=1
  trap - INT TERM
  signal_owned_groups TERM
  for unused in {1..20}; do
    owned_groups_alive || break
    sleep 0.1
  done
  signal_owned_groups KILL
  for unused in {1..20}; do
    owned_groups_alive || break
    sleep 0.05
  done
  if owned_groups_alive; then
    printf '%s\n' \
      "[FAIL] test-owned process groups remain; owner registry retained at $OWNER_PGIDS" >&2
    return 1
  fi
  rm -rf -- "$RUN_ROOT"
}

finish_with_cleanup() {
  local status="$?"
  if ! cleanup_owned_resources; then
    status=1
  fi
  trap - EXIT
  exit "$status"
}

trap finish_with_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

unset \
  CARGO_BUILD_RUSTC_WRAPPER \
  CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER \
  RUSTC_WRAPPER \
  RUSTC_WORKSPACE_WRAPPER
export DEEPCODE_DISABLE_SCCACHE=1

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

info "Host v2 production assets"
run_quiet "Protocol production clean" \
  pnpm --filter @deepcode/protocol clean
rm -f userspace/protocol/tsconfig.tsbuildinfo
run_quiet "Protocol production build" \
  pnpm --filter @deepcode/protocol build
run_quiet "Session production build" \
  pnpm --filter @deepcode/session-core build
run_quiet "Daemon and CLI production build" \
  cargo build --quiet -p deepcode-kernel-daemon -p deepcode-cli
pass "Host v2 production assets"

info "Host workspace, public transport, restart, replay, and owner cleanup"
python3 -B -I -S ./scripts/tests/host-v2-integration.py
pass "Host v2 public-path integration"
