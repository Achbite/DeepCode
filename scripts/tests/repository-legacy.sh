#!/usr/bin/env bash
# Transitional required repository runner. Invoke through the repository test.sh.
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "${DEEPCODE_TEST_CONTROLLER:-0}" != "1" ]; then
  printf '%s\n' "repository-legacy.sh is an internal runner; use ./test.sh" >&2
  exit 2
fi

if [ -z "${CARGO_TARGET_DIR:-}" ] && [ -f /.dockerenv ]; then
  export CARGO_TARGET_DIR="$ROOT_DIR/target"
fi
if [ -n "${DEEPCODE_TMPDIR:-}" ]; then
  export TMPDIR="$DEEPCODE_TMPDIR"
elif [ -f /.dockerenv ] && { [ -z "${TMPDIR:-}" ] || [ "${TMPDIR%/}" = "/tmp" ]; }; then
  export TMPDIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target}/.tmp"
fi
mkdir -p "${CARGO_TARGET_DIR:-$ROOT_DIR/target}" "${TMPDIR:-/tmp}"

DEFAULT_TEST_PORT="$((31000 + RANDOM % 20000))"
TEST_PORT="${DEEPCODE_TEST_PORT:-$DEFAULT_TEST_PORT}"
PROXY_PORT="${DEEPCODE_PROXY_TEST_PORT:-$((TEST_PORT + 1))}"
CONFIG_DIR=""
DAEMON_LOG=""
DAEMON_PID=""
PROXY_LOG=""
PROXY_PID=""

pass() { printf '\033[32m[PASS]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m[INFO]\033[0m %s\n' "$*"; }

cleanup() {
  local status="$?"
  local pid
  for pid in "$PROXY_PID" "$DAEMON_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  [ -n "$CONFIG_DIR" ] && rm -rf "$CONFIG_DIR"
  if [ "$status" -eq 0 ]; then
    [ -n "$DAEMON_LOG" ] && rm -f "$DAEMON_LOG"
    [ -n "$PROXY_LOG" ] && rm -f "$PROXY_LOG"
  else
    [ -n "$DAEMON_LOG" ] && info "daemon failure log preserved: $DAEMON_LOG"
    [ -n "$PROXY_LOG" ] && info "Host Web failure log preserved: $PROXY_LOG"
  fi
  return "$status"
}
trap cleanup EXIT

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

is_docker_environment() {
  [ -f /.dockerenv ] && return 0
  grep -qaE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null
}

check_static_contracts() {
  local script
  for script in \
    test.sh \
    build.sh \
    scripts/branch-flow.sh \
    scripts/test-branch-flow.sh \
    scripts/check-architecture.sh \
    scripts/cargo-with-fallback.sh \
    scripts/macos-package-service.sh \
    scripts/package-macos.sh
  do
    bash -n "$script"
  done
  bash ./scripts/check-architecture.sh
  bash ./scripts/test-branch-flow.sh
}

host_static_only_gate() {
  info "host static checks"
  require_tool bash
  require_tool grep
  check_static_contracts
  pass "host static checks passed; run the full suite inside Docker"
}

if ! is_docker_environment && [ "${DEEPCODE_ALLOW_HOST_TEST:-0}" != "1" ]; then
  fail "full legacy suite requires a container; select --profile static for host-only checks or set DEEPCODE_ALLOW_HOST_TEST=1 to opt in to full host execution"
fi

configure_test_sccache() {
  if [ "${DEEPCODE_DISABLE_SCCACHE:-0}" = "1" ]; then
    unset RUSTC_WRAPPER
    return
  fi
  if ! command -v sccache >/dev/null 2>&1; then
    return
  fi

  export SCCACHE_DIR="${SCCACHE_DIR:-${CARGO_TARGET_DIR:-$ROOT_DIR/target}/.sccache}"
  mkdir -p "$SCCACHE_DIR"
  if sccache --start-server >/dev/null 2>&1; then
    export RUSTC_WRAPPER="${RUSTC_WRAPPER:-sccache}"
    info "sccache enabled: SCCACHE_DIR=$SCCACHE_DIR"
  else
    unset RUSTC_WRAPPER
    info "sccache startup failed; continuing with rustc"
  fi
}

json_get() {
  python3 - "$@" <<'PY'
import sys
from urllib.request import urlopen

with urlopen(sys.argv[1], timeout=5) as response:
    print(response.read().decode("utf-8"))
PY
}

json_post() {
  python3 - "$@" <<'PY'
import sys
from urllib.request import Request, urlopen

url = sys.argv[1]
body = sys.argv[2].encode("utf-8")
request = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
with urlopen(request, timeout=5) as response:
    print(response.read().decode("utf-8"))
PY
}

wait_http_ok() {
  local url="$1"
  local label="$2"
  local attempts="${DEEPCODE_HTTP_WAIT_ATTEMPTS:-600}"
  local _
  for _ in $(seq 1 "$attempts"); do
    if python3 - "$url" <<'PY' >/dev/null 2>&1
import sys
from urllib.request import urlopen

with urlopen(sys.argv[1], timeout=1) as response:
    raise SystemExit(0 if response.status == 200 else 1)
PY
    then
      pass "$label"
      return
    fi
    sleep 0.25
  done
  fail "$label timed out"
}

assert_json_expr() {
  local json="$1"
  local expr="$2"
  local label="$3"
  python3 - "$json" "$expr" <<'PY' || fail "$label"
import json
import sys

data = json.loads(sys.argv[1])
expr = sys.argv[2]
assert eval(expr, {"__builtins__": {}, "all": all, "any": any, "len": len}, {"data": data}), data
PY
  pass "$label"
}

info "preflight"
for tool in bash cargo node pnpm python3 grep; do
  require_tool "$tool"
done
check_static_contracts
configure_test_sccache
pass "preflight checks"

info "Rust workspace"
cargo fmt --check --all
cargo test --workspace
pass "Rust workspace"

info "TypeScript builds"
pnpm --filter @deepcode/protocol build
pnpm --filter @deepcode/session-core build
pnpm --filter @deepcode/client build
pass "TypeScript builds"

info "Kernel daemon HTTP integration"
CONFIG_DIR="$(mktemp -d /tmp/deepcode-test-config-XXXXXX)"
DAEMON_LOG="/tmp/deepcode-kernel-daemon-test-$$.log"
DEEPCODE_HOST=127.0.0.1 \
DEEPCODE_PORT="$TEST_PORT" \
DEEPCODE_CONFIG_DIR="$CONFIG_DIR" \
cargo run -q -p deepcode-kernel-daemon >"$DAEMON_LOG" 2>&1 &
DAEMON_PID="$!"
wait_http_ok "http://127.0.0.1:${TEST_PORT}/api/health" "daemon health ready"

health="$(json_get "http://127.0.0.1:${TEST_PORT}/api/health")"
assert_json_expr "$health" 'data["ok"] is True and data["data"]["service"] == "deepcode-kernel-daemon"' "daemon service identity"
DEEPCODE_API_URL="http://127.0.0.1:${TEST_PORT}" cargo run -q -p deepcode-cli -- daemon status >/dev/null
DEEPCODE_API_URL="http://127.0.0.1:${TEST_PORT}" cargo run -q -p deepcode-tui -- --smoke >/dev/null
pass "CLI/TUI use the controlled daemon"

reply="$(json_post "http://127.0.0.1:${TEST_PORT}/api/kernel/commands" '{"command":{"kind":"healthCheck","requestId":"req-health"}}')"
assert_json_expr "$reply" 'data["ok"] is True and any(event["kind"] == "host.status" for event in data["events"]) and data["snapshot"] is not None' "Kernel command health"

snapshot="$(json_get "http://127.0.0.1:${TEST_PORT}/api/kernel/snapshot")"
assert_json_expr "$snapshot" 'data["ok"] is True and data["snapshot"] is not None' "Kernel snapshot"

session_store_index="$(json_get "http://127.0.0.1:${TEST_PORT}/api/session-store/index")"
assert_json_expr "$session_store_index" 'data["ok"] is True and data["data"]["conversationArchiveRoot"].endswith("conversation-archives")' "session store archive root"
assert_json_expr "$session_store_index" "data[\"ok\"] is True and data[\"data\"][\"conversationArchiveRoot\"] == \"$CONFIG_DIR/conversation-archives\"" "isolated config root"

archive_session_create="$(json_post "http://127.0.0.1:${TEST_PORT}/api/agent/sessions" '{"title":"Archive Smoke","workspaceId":"wf-archive","workspaceHash":"hash-archive"}')"
archive_session_id="$(python3 - "$archive_session_create" <<'PY'
import json
import sys
print(json.loads(sys.argv[1])["data"]["session"]["id"])
PY
)"
scoped_session_a="$(json_post "http://127.0.0.1:${TEST_PORT}/api/agent/sessions" '{"title":"Workspace A","workspaceId":"wf-a","workspaceHash":"hash-a"}')"
scoped_session_b="$(json_post "http://127.0.0.1:${TEST_PORT}/api/agent/sessions" '{"title":"Workspace B","workspaceId":"wf-b","workspaceHash":"hash-b"}')"
scoped_session_a_id="$(python3 - "$scoped_session_a" <<'PY'
import json
import sys
print(json.loads(sys.argv[1])["data"]["session"]["id"])
PY
)"
scoped_session_b_id="$(python3 - "$scoped_session_b" <<'PY'
import json
import sys
print(json.loads(sys.argv[1])["data"]["session"]["id"])
PY
)"

scoped_list_a="$(json_get "http://127.0.0.1:${TEST_PORT}/api/agent/sessions?workspaceId=wf-a&workspaceHash=hash-a")"
assert_json_expr "$scoped_list_a" "data[\"ok\"] is True and data[\"data\"][\"currentSessionId\"] == \"$scoped_session_a_id\" and all(session.get(\"workspaceId\") == \"wf-a\" for session in data[\"data\"][\"sessions\"]) and not any(session.get(\"workspaceId\") == \"wf-b\" for session in data[\"data\"][\"sessions\"])" "workspace-scoped session list"
scoped_current_b="$(json_get "http://127.0.0.1:${TEST_PORT}/api/agent/sessions/current?workspaceId=wf-b&workspaceHash=hash-b")"
assert_json_expr "$scoped_current_b" "data[\"ok\"] is True and data[\"data\"][\"session\"][\"id\"] == \"$scoped_session_b_id\" and data[\"data\"][\"session\"][\"workspaceId\"] == \"wf-b\"" "workspace-scoped current session"
json_post "http://127.0.0.1:${TEST_PORT}/api/agent/sessions/${scoped_session_a_id}/archive" '{"archived":true}' >/dev/null
scoped_current_b_after_archive="$(json_get "http://127.0.0.1:${TEST_PORT}/api/agent/sessions/current?workspaceId=wf-b&workspaceHash=hash-b")"
assert_json_expr "$scoped_current_b_after_archive" "data[\"ok\"] is True and data[\"data\"][\"session\"][\"id\"] == \"$scoped_session_b_id\"" "archiving another workspace preserves current session"

json_post "http://127.0.0.1:${TEST_PORT}/api/agent/sessions/${archive_session_id}/events" '{"events":[{"kind":"user_msg","payload":{"content":"archive smoke","kernelEvent":{"runId":"run-smoke"},"actionBundleDraft":{"version":"1"},"apiToken":"secret-token"}}]}' >/dev/null
archive_reply="$(json_get "http://127.0.0.1:${TEST_PORT}/api/session-store/${archive_session_id}/archive")"
assert_json_expr "$archive_reply" 'data["ok"] is True and len(data["data"]["archives"]) >= 1 and any(any(file["path"] == "projection.jsonl" for file in archive["files"]) and any(file["path"] == "exports/complete.md" for file in archive["files"]) for archive in data["data"]["archives"])' "conversation archive exports"
test -d "$CONFIG_DIR/conversation-archives" || fail "conversation archive root was not created"
find "$CONFIG_DIR/conversation-archives" -name projection.jsonl -print -quit | grep -q . || fail "conversation archive projection.jsonl was not created"
! grep -R "secret-token" "$CONFIG_DIR/conversation-archives" >/dev/null || fail "conversation archive leaked a sensitive token"
pass "session/archive integration"

info "Host Web development adapter"
PROXY_LOG="/tmp/deepcode-host-web-proxy-test-$$.log"
DEEPCODE_HOST=127.0.0.1 \
DEEPCODE_PORT="$PROXY_PORT" \
DEEPCODE_DAEMON_PORT="$TEST_PORT" \
DEEPCODE_HOST_WEB_SPAWN_DAEMON=0 \
cargo run -q -p deepcode-host-web >"$PROXY_LOG" 2>&1 &
PROXY_PID="$!"
wait_http_ok "http://127.0.0.1:${PROXY_PORT}/api/health" "Host Web proxy health ready"
proxy_health="$(json_get "http://127.0.0.1:${PROXY_PORT}/api/health")"
assert_json_expr "$proxy_health" 'data["ok"] is True and data["data"]["service"] == "deepcode-kernel-daemon"' "Host Web proxies daemon health"

info "Kernel daemon IPC transport"
ipc_reply="$(
  printf '%s\n' '{"command":{"kind":"healthCheck","requestId":"req-ipc-health"}}' \
  | DEEPCODE_DAEMON_IPC_STDIO=1 \
    DEEPCODE_LEDGER_BACKEND=memory \
    cargo run -q -p deepcode-kernel-daemon
)"
assert_json_expr "$ipc_reply" 'data["ok"] is True and any(event["kind"] == "host.status" for event in data["events"])' "daemon stdio IPC"

framed_ipc_reply="$(
  DEEPCODE_DAEMON_IPC_STDIO=1 \
  DEEPCODE_DAEMON_IPC_FRAMED=1 \
  DEEPCODE_LEDGER_BACKEND=memory \
  python3 - <<'PY'
import json
import os
import struct
import subprocess
import sys

payload = json.dumps({"command": {"kind": "healthCheck", "requestId": "req-ipc-framed-health"}}).encode("utf-8")
process = subprocess.Popen(
    ["cargo", "run", "-q", "-p", "deepcode-kernel-daemon"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=os.environ.copy(),
)
stdout, stderr = process.communicate(struct.pack(">I", len(payload)) + payload, timeout=30)
if process.returncode not in (0, None):
    sys.stderr.write(stderr.decode("utf-8", errors="replace"))
    raise SystemExit(process.returncode)
if len(stdout) < 4:
    sys.stderr.write(stderr.decode("utf-8", errors="replace"))
    raise SystemExit("missing framed reply")
length = struct.unpack(">I", stdout[:4])[0]
print(stdout[4:4 + length].decode("utf-8"))
PY
)"
assert_json_expr "$framed_ipc_reply" 'data["ok"] is True and any(event["kind"] == "host.status" for event in data["events"])' "daemon framed IPC"

if [ "${DEEPCODE_VERIFY_PACKAGES:-0}" = "1" ]; then
  info "existing package runtime verification"
  bash ./build.sh --stage verify-package-runtime
  pass "package runtime verification"
else
  info "package runtime verification skipped; set DEEPCODE_VERIFY_PACKAGES=1 to inspect existing artifacts"
fi

if command -v sccache >/dev/null 2>&1 && [ "${DEEPCODE_DISABLE_SCCACHE:-0}" != "1" ]; then
  info "sccache stats"
  sccache --show-stats || true
fi

pass "DeepCode repository verification passed"
