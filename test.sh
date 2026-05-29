#!/usr/bin/env bash
# ====================================================================
# DeepCode stage 9 layered smoke test
#
# 默认执行 fast smoke：语法、Rust workspace、TS typecheck/build、阶段 9
# 边界门禁、Kernel daemon API smoke。packaging/slow 通过环境变量启用。
# ====================================================================
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

TEST_PORT="${DEEPCODE_TEST_PORT:-31246}"
PROXY_PORT="${DEEPCODE_PROXY_TEST_PORT:-31247}"
CONFIG_DIR=""
DAEMON_LOG=""
DAEMON_PID=""
PROXY_LOG=""
PROXY_PID=""

pass() { echo -e "\033[32m[PASS]\033[0m $*"; }
fail() { echo -e "\033[31m[FAIL]\033[0m $*"; exit 1; }
info() { echo -e "\033[36m[INFO]\033[0m $*"; }

cleanup() {
  for pid in "$PROXY_PID" "$DAEMON_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  [ -n "$CONFIG_DIR" ] && rm -rf "$CONFIG_DIR"
  [ -n "$DAEMON_LOG" ] && rm -f "$DAEMON_LOG"
  [ -n "$PROXY_LOG" ] && rm -f "$PROXY_LOG"
}
trap cleanup EXIT

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

json_get() {
  python3 - "$@" <<'PY'
import json
import sys
from urllib.request import urlopen

url = sys.argv[1]
with urlopen(url, timeout=5) as response:
    print(response.read().decode("utf-8"))
PY
}

json_post() {
  python3 - "$@" <<'PY'
import json
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
  for _ in $(seq 1 80); do
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
assert eval(expr, {"__builtins__": {}, "any": any, "len": len}, {"data": data}), data
PY
  pass "$label"
}

info "[1/8] tool and shell checks"
require_tool bash
require_tool cargo
require_tool python3
require_tool rg
bash -n test.sh
bash -n build.sh
pass "shell scripts parse"

info "[2/8] Rust format and tests"
cargo fmt --check --all
cargo test --workspace
pass "Rust workspace tests"

info "[3/8] TypeScript protocol/session/gui checks"
if [ "${DEEPCODE_SKIP_TS_CHECKS:-0}" != "1" ]; then
  if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
    pnpm --filter @deepcode/protocol typecheck
    pnpm --filter @deepcode/session-core typecheck
    pnpm --filter @deepcode/client typecheck
    pnpm --filter @deepcode/client build
    pass "TS typecheck and GUI build"
  elif [ "${DEEPCODE_REQUIRE_TS_CHECKS:-0}" = "1" ]; then
    fail "node/pnpm are required because DEEPCODE_REQUIRE_TS_CHECKS=1"
  else
    info "node/pnpm not found; TS checks skipped outside Docker. Set DEEPCODE_REQUIRE_TS_CHECKS=1 to fail closed."
  fi
else
  info "TS checks skipped by DEEPCODE_SKIP_TS_CHECKS=1"
fi

info "[4/8] stage 9 boundary grep gates"
! rg -n "WorkflowDecisionState" crates/deepcode-kernel-runtime/src || fail "runtime must not define WorkflowDecisionState"
! rg -n "match tool_name" crates/deepcode-kernel-runtime/src || fail "runtime must not use match tool_name dispatch"
rg -n "struct RuntimeState" crates/deepcode-kernel-runtime/src/state.rs >/dev/null
rg -n "struct WorkspaceBoundary" crates/deepcode-kernel-policy/src/workspace_boundary.rs >/dev/null
rg -n "trait SkillExecutor" crates/deepcode-kernel-skills/src/executor.rs >/dev/null
! rg -n "DeepCodeKernelRuntime|deepcode-kernel-runtime" crates/deepcode-host-web/src crates/deepcode-host-web/Cargo.toml || fail "host-web must not hold Kernel runtime"
! rg -n "run_agent_workflow|stage_prompt|call_agent_stage_llm|execute_stage_tool_calls|call_llm_profile" crates/deepcode-host-web/src || fail "host-web must not own workflow/provider loop"
rg -n "deepcode-kernel-daemon" Cargo.toml build.sh test.sh crates/deepcode-kernel-daemon/Cargo.toml >/dev/null
rg -n "PlanContractSubmit|SkillTrustApprove|PlanReviewReportProduced|SkillTrustRequested|SkillTrustGranted" crates/deepcode-kernel-abi/src/lib.rs >/dev/null
rg -n "SkillTrustMode|BrokeredScript|DirectHostScript|ScriptBroker" crates/deepcode-kernel-skills/src >/dev/null
rg -n "PlanReviewEngine|PlanReviewReport" crates/deepcode-kernel-workflow/src >/dev/null
pass "stage 9 grep gates"

info "[5/8] Kernel daemon HTTP smoke"
CONFIG_DIR="$(mktemp -d /tmp/deepcode-stage9-config-XXXXXX)"
DAEMON_LOG="/tmp/deepcode-kernel-daemon-test-$$.log"
DEEPCODE_HOST=127.0.0.1 \
DEEPCODE_PORT="$TEST_PORT" \
DEEPCODE_CONFIG_DIR="$CONFIG_DIR" \
cargo run -q -p deepcode-kernel-daemon >"$DAEMON_LOG" 2>&1 &
DAEMON_PID="$!"
wait_http_ok "http://127.0.0.1:${TEST_PORT}/api/health" "daemon health ready"

health="$(json_get "http://127.0.0.1:${TEST_PORT}/api/health")"
assert_json_expr "$health" 'data["ok"] is True and data["data"]["service"] == "deepcode-kernel-daemon"' "daemon service identity"

reply="$(json_post "http://127.0.0.1:${TEST_PORT}/api/kernel/commands" '{"command":{"kind":"healthCheck","requestId":"req-health"}}')"
assert_json_expr "$reply" 'data["ok"] is True and any(event["kind"] == "host.status" for event in data["events"]) and data["snapshot"] is not None' "kernel command health"

snapshot="$(json_get "http://127.0.0.1:${TEST_PORT}/api/kernel/snapshot")"
assert_json_expr "$snapshot" 'data["ok"] is True and data["snapshot"] is not None' "kernel snapshot"

info "[6/8] Host-web dev proxy smoke"
PROXY_LOG="/tmp/deepcode-host-web-proxy-test-$$.log"
DEEPCODE_HOST=127.0.0.1 \
DEEPCODE_PORT="$PROXY_PORT" \
DEEPCODE_DAEMON_PORT="$TEST_PORT" \
DEEPCODE_HOST_WEB_SPAWN_DAEMON=0 \
cargo run -q -p deepcode-host-web >"$PROXY_LOG" 2>&1 &
PROXY_PID="$!"
wait_http_ok "http://127.0.0.1:${PROXY_PORT}/api/health" "host-web proxy health ready"
proxy_health="$(json_get "http://127.0.0.1:${PROXY_PORT}/api/health")"
assert_json_expr "$proxy_health" 'data["ok"] is True and data["data"]["service"] == "deepcode-kernel-daemon"' "host-web proxies daemon health"

info "[7/8] optional packaging smoke"
if [ "${DEEPCODE_SKIP_PACKAGING_SMOKE:-1}" = "0" ]; then
  ./build.sh
  test -x "$ROOT_DIR/bin/linux-x64/deepcode-kernel"
  test -f "$ROOT_DIR/bin/win64/deepcode-kernel.exe"
  test -f "$ROOT_DIR/bin/win64/DeepCode.exe"
  test -f "$ROOT_DIR/bin/win64/WebView2Loader.dll"
  pass "packaging smoke"
else
  info "packaging smoke skipped; set DEEPCODE_SKIP_PACKAGING_SMOKE=0 to enable"
fi

info "[8/8] done"
pass "DeepCode stage 9 fast smoke passed"
