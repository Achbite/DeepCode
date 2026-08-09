#!/usr/bin/env bash
# Required Kernel v2 contracts. Invoke only through the repository controller.
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "${DEEPCODE_TEST_CONTROLLER:-0}" != "1" ] \
  || [ "${DEEPCODE_TEST_SUITE_ID:-}" != "kernel.v2.contracts" ]; then
  printf '%s\n' "kernel-v2-contracts.sh is an internal runner; use bash ./test.sh --suite kernel.v2.contracts" >&2
  exit 2
fi

info() { printf '[INFO] %s\n' "$*"; }
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

command -v cargo >/dev/null 2>&1 || fail "cargo is required"

if [ -z "${CARGO_TARGET_DIR:-}" ] && [ -f /.dockerenv ]; then
  export CARGO_TARGET_DIR="$ROOT_DIR/target"
fi
if [ -n "${DEEPCODE_TMPDIR:-}" ]; then
  export TMPDIR="$DEEPCODE_TMPDIR"
elif [ -f /.dockerenv ] && { [ -z "${TMPDIR:-}" ] || [ "${TMPDIR%/}" = "/tmp" ]; }; then
  export TMPDIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target}/.tmp"
fi
mkdir -p "${CARGO_TARGET_DIR:-$ROOT_DIR/target}" "${TMPDIR:-/tmp}"

unset \
  CARGO_BUILD_RUSTC_WRAPPER \
  CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER \
  RUSTC_WRAPPER \
  RUSTC_WORKSPACE_WRAPPER
export DEEPCODE_DISABLE_SCCACHE=1

info "Kernel v2 ABI wire contracts"
cargo test --quiet -p deepcode-kernel-abi
pass "Kernel v2 ABI wire contracts"

info "Kernel v2 canonical fact-store contracts"
cargo test --quiet -p deepcode-kernel-ledger --lib
cargo test --quiet -p deepcode-kernel-ledger --test v2_ledger_contract
pass "Kernel v2 canonical fact-store contracts"

info "Kernel v2 registry contracts"
cargo test --quiet -p deepcode-kernel-tools --test v2_registry_contract
pass "Kernel v2 registry contracts"

info "Kernel v2 Settings and trust-policy contracts"
cargo test --quiet -p deepcode-kernel-policy --lib
pass "Kernel v2 Settings and trust-policy contracts"

info "Kernel v2 grant, invocation, replay, and recovery contracts"
cargo test --quiet -p deepcode-kernel-runtime --lib
pass "Kernel v2 grant, invocation, replay, and recovery contracts"

info "Kernel v2 client, daemon admission, and CLI boundary contracts"
cargo test --quiet -p deepcode-kernel-client --lib
cargo test --quiet -p deepcode-kernel-daemon --bin deepcode-kernel-daemon
cargo test --quiet -p deepcode-cli --bin deepcode-cli
pass "Kernel v2 client, daemon admission, and CLI boundary contracts"

info "CLI production entrypoint"
cargo run --quiet -p deepcode-cli -- --help >/dev/null
pass "CLI production entrypoint"
