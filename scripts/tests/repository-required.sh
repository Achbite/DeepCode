#!/usr/bin/env bash
# Required production build and atomic-cutover contracts. Invoke through test.sh.
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "${DEEPCODE_TEST_CONTROLLER:-0}" != "1" ] \
  || [ "${DEEPCODE_TEST_SUITE_ID:-}" != "repository.required" ]; then
  printf '%s\n' "repository-required.sh is an internal runner; use bash ./test.sh --profile required" >&2
  exit 2
fi

info() { printf '[INFO] %s\n' "$*"; }
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

for tool in cargo git node pnpm python3; do
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

unset \
  CARGO_BUILD_RUSTC_WRAPPER \
  CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER \
  RUSTC_WRAPPER \
  RUSTC_WORKSPACE_WRAPPER
export DEEPCODE_DISABLE_SCCACHE=1

info "Rust production workspace"
cargo fmt --check --all
cargo check --quiet --workspace
pass "Rust production workspace"

info "TypeScript production packages"
pnpm --filter @deepcode/protocol clean
rm -f userspace/protocol/tsconfig.tsbuildinfo
pnpm --filter @deepcode/protocol build
if find userspace/protocol/dist -maxdepth 1 -type f \
  \( -name 'kernel.*' -o -name 'kernelAbiV1.*' \) -print -quit | grep -q .; then
  fail "Protocol production output contains retired Kernel ABI modules"
fi
pnpm --filter @deepcode/session-core build
[ ! -e userspace/session-core/dist/__tests__ ] \
  || fail "Session production output contains test assets"
pnpm --filter @deepcode/client build
pass "TypeScript production packages"

info "CLI production entrypoint"
cargo run --quiet -p deepcode-cli -- --help >/dev/null
pass "CLI production entrypoint"

info "Kernel-Session v2 legacy-cutover semantics"
python3 -I -S ./scripts/tests/legacy-cutover-contracts.py

info "Repository whitespace integrity"
git diff --check
pass "Repository whitespace integrity"

pass "repository production and cutover contracts"
