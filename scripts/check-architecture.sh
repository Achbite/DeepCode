#!/usr/bin/env bash
# DeepCode 分层依赖方向的稳定检查。
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

# Host adapter 与用户壳通过 daemon/client 合同通信，不能直接依赖进程内
# Kernel Runtime。
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
    'Host 壳不能拥有 Kernel Runtime'
done

# TypeScript Session/UI 只消费协议合同和 daemon API，不能依赖 Rust Kernel
# 实现包。
for manifest in \
  userspace/protocol/package.json \
  userspace/session-core/package.json \
  userspace/gui/package.json
do
  assert_manifest_excludes \
    "$manifest" \
    'deepcode-kernel-(runtime|daemon|tools)' \
    'Userspace 包不能依赖 Kernel 实现 crate'
done

printf '==[architecture]== 分层依赖检查通过\n'
