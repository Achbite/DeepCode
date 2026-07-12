#!/usr/bin/env bash
# Stable dependency-direction checks for the DeepCode layer boundaries.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  printf '==[architecture][error]== %s\n' "$*" >&2
  exit 1
}

assert_manifest_excludes() {
  local manifest="$1"
  local pattern="$2"
  local boundary="$3"
  [ -f "$manifest" ] || fail "missing manifest: $manifest"
  if grep -Eq "$pattern" "$manifest"; then
    fail "$boundary: $manifest contains a forbidden dependency"
  fi
}

# Host adapters and user-facing shells communicate through the daemon/client
# contracts. They must not acquire an in-process Kernel Runtime dependency.
for manifest in \
  crates/deepcode-host-web/Cargo.toml \
  crates/deepcode-kernel-client/Cargo.toml \
  shells/cli/Cargo.toml \
  shells/tui/Cargo.toml \
  shells/tauri/src-tauri/Cargo.toml \
  shells/deepcode-gui/src-tauri/Cargo.toml
do
  assert_manifest_excludes \
    "$manifest" \
    'deepcode-kernel-runtime' \
    'Host shell must not own Kernel Runtime'
done

# TypeScript Session/UI packages consume protocol contracts and daemon APIs;
# they must not introduce Rust Kernel implementation packages as dependencies.
for manifest in \
  userspace/protocol/package.json \
  userspace/session-core/package.json \
  userspace/gui/package.json
do
  assert_manifest_excludes \
    "$manifest" \
    'deepcode-kernel-(runtime|daemon|tools|policy)' \
    'Userspace package must not depend on Kernel implementation crates'
done

printf '==[architecture]== dependency boundaries passed\n'
