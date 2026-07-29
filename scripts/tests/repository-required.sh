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
pnpm --filter @deepcode/protocol build
pnpm --filter @deepcode/session-core clean
DEEPCODE_SESSION_PACKAGE="$ROOT_DIR/userspace/session-core" \
  pnpm --filter @deepcode/session-core exec node --input-type=module - <<'NODE'
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const packageRoot = process.env.DEEPCODE_SESSION_PACKAGE;
if (!packageRoot) throw new Error('DEEPCODE_SESSION_PACKAGE is required');
const configPath = path.join(packageRoot, 'tsconfig.json');
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
if (loaded.error) {
  throw new Error(ts.formatDiagnostic(loaded.error, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => '\n',
  }));
}
const parsed = ts.parseJsonConfigFileContent(
  loaded.config,
  ts.sys,
  packageRoot,
  undefined,
  configPath
);
const testSegment = `${path.sep}src${path.sep}__tests__${path.sep}`;
const productionRoots = parsed.fileNames.filter(
  (fileName) => !path.normalize(fileName).includes(testSegment)
);
if (!productionRoots.length || productionRoots.some((fileName) => fileName.includes(testSegment))) {
  throw new Error('Session production root selection is empty or contains test assets');
}
const program = ts.createProgram({
  rootNames: productionRoots,
  options: parsed.options,
  projectReferences: parsed.projectReferences,
});
const emit = program.emit();
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics];
if (diagnostics.length || emit.emitSkipped) {
  const detail = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => '\n',
  });
  throw new Error(detail || 'Session production emit was skipped');
}
NODE
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
