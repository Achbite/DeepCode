#!/usr/bin/env bash
# ====================================================================
# DeepCode stage 9 closure + host shell/audit baseline smoke test
#
# 默认完整 smoke 只能在 Docker 内执行：Rust workspace、TS typecheck/build、
# 阶段 9 Kernel/daemon 边界门禁、Kernel daemon API smoke、阶段 10.0
# CLI/TUI smoke、阶段 10 audit tamper tests，以及既有 Skill/MCP
# fail-closed 基础门禁。
#
# 宿主机默认只执行静态脚本与 grep 门禁；如需一次性本地诊断，可显式设置
# DEEPCODE_ALLOW_HOST_TEST=1，但不得把该变量写入用户环境。
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

configure_test_sccache() {
  if [ "${DEEPCODE_DISABLE_SCCACHE:-0}" = "1" ]; then
    unset RUSTC_WRAPPER
    return
  fi

  if command -v sccache >/dev/null 2>&1; then
    export SCCACHE_DIR="${SCCACHE_DIR:-$ROOT_DIR/.build-cache/sccache}"
    mkdir -p "$SCCACHE_DIR"
    export RUSTC_WRAPPER="${RUSTC_WRAPPER:-sccache}"
    info "sccache enabled for test cargo commands: SCCACHE_DIR=$SCCACHE_DIR"
  fi
}

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
  true
}
trap cleanup EXIT

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

search() {
  local pattern="$1"
  shift
  if command -v rg >/dev/null 2>&1; then
    rg -n -- "$pattern" "$@"
  else
    grep -RInE -- "$pattern" "$@"
  fi
}

is_docker_environment() {
  [ -f /.dockerenv ] && return 0
  grep -qaE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null
}

check_static_shell_and_policy_gates() {
  bash -n test.sh
  bash -n build.sh
  local deprecated_build_markers_regex='DEEPCODE_VERSION''_TAG|source''Hash|build-info''\.json|build''Version|release''\.json'
  local version_scan_paths=(build.sh README.md test.sh)
  local optional_doc
  for optional_doc in \
    /mnt/e/Dev-Agent/技术方案/临时上下文存储.md \
    /mnt/e/Dev-Agent/技术方案/开发规划方案.md
  do
    [ -f "$optional_doc" ] && version_scan_paths+=("$optional_doc")
  done
  ! search "$deprecated_build_markers_regex" "${version_scan_paths[@]}" >/dev/null \
    || fail "build version/source hash metadata must stay postponed"
  ! search "deepcode\\.exe" build.sh || fail "Windows CLI must not generate deepcode.exe; use DeepCode.exe for GUI and deepcode-cli.exe/deepcode.cmd for CLI"
  search "DEEPCODE_ALLOW_HOST_BUILD|require_docker_build_environment|is_docker_environment" build.sh >/dev/null
}

host_static_only_gate() {
  info "[host] static-only checks"
  require_tool bash
  require_tool grep
  check_static_shell_and_policy_gates
  pass "host static-only checks passed; run full smoke inside Docker"
}

if ! is_docker_environment && [ "${DEEPCODE_ALLOW_HOST_TEST:-0}" != "1" ]; then
  host_static_only_gate
  exit 0
fi

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
  local attempts="${DEEPCODE_HTTP_WAIT_ATTEMPTS:-600}"
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
assert eval(expr, {"__builtins__": {}, "any": any, "len": len}, {"data": data}), data
PY
  pass "$label"
}

count_log_pattern() {
  local pattern="$1"
  local logfile="$2"
  grep -E "$pattern" "$logfile" 2>/dev/null | wc -l | tr -d ' '
}

run_build_baseline_probe() {
  local stamp out_dir log_dir report
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out_dir="$ROOT_DIR/.deepcode/build-baselines"
  log_dir="$out_dir/logs"
  report="$out_dir/${stamp}-baseline.md"
  local dirty_detail="$log_dir/${stamp}-dirty-first-20.md"
  mkdir -p "$log_dir"
  : >"$dirty_detail"

  cat >"$report" <<REPORT
# DeepCode Build Baseline ${stamp}

## Environment

- root: \`$ROOT_DIR\`
- cargo target: \`${CARGO_TARGET_DIR:-$ROOT_DIR/target}\`
- rustc: \`$(rustc --version 2>/dev/null || echo unavailable)\`
- cargo: \`$(cargo --version 2>/dev/null || echo unavailable)\`
- pnpm: \`$(pnpm --version 2>/dev/null || echo unavailable)\`
- sccache: \`$(sccache --version 2>/dev/null || echo unavailable)\`
- sccache disabled: \`${DEEPCODE_DISABLE_SCCACHE:-0}\`

## Scenarios

| Scenario | Exit | Seconds | Fresh | Dirty | Compiling | Log |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
REPORT

  run_build_scenario() {
    local key="$1"
    local label="$2"
    shift 2
    local logfile="$log_dir/${stamp}-${key}.log"
    local start end status fresh dirty compiling

    info "build bench: $label"
    start="$(date +%s)"
    set +e
    "$@" >"$logfile" 2>&1
    status="$?"
    set -e
    end="$(date +%s)"

    fresh="$(count_log_pattern '^[[:space:]]*Fresh ' "$logfile")"
    dirty="$(count_log_pattern '^[[:space:]]*Dirty ' "$logfile")"
    compiling="$(count_log_pattern '^[[:space:]]*Compiling ' "$logfile")"

    printf '| %s | %s | %s | %s | %s | %s | `%s` |\n' \
      "$label" "$status" "$((end - start))" "$fresh" "$dirty" "$compiling" \
      "${logfile#$ROOT_DIR/}" >>"$report"

    {
      printf '### %s\n\n' "$label"
      grep -E '^[[:space:]]*Dirty ' "$logfile" 2>/dev/null | head -n 20 || true
      printf '\n'
    } >>"$dirty_detail"
  }

  run_build_scenario "cargo-first" "cargo release first" \
    cargo build -vv --release -p deepcode-kernel-daemon -p deepcode-cli -p deepcode-tui

  run_build_scenario "cargo-repeat" "cargo release repeat" \
    cargo build -vv --release -p deepcode-kernel-daemon -p deepcode-cli -p deepcode-tui

  touch "$ROOT_DIR/crates/deepcode-kernel-runtime/src/lib.rs"
  run_build_scenario "cargo-runtime-touch" "cargo release after runtime touch" \
    cargo build -vv --release -p deepcode-kernel-daemon -p deepcode-cli -p deepcode-tui

  if command -v pnpm >/dev/null 2>&1; then
    if [ -f "$ROOT_DIR/userspace/gui/src/App.tsx" ]; then
      touch "$ROOT_DIR/userspace/gui/src/App.tsx"
    elif [ -f "$ROOT_DIR/userspace/gui/package.json" ]; then
      touch "$ROOT_DIR/userspace/gui/package.json"
    fi
    run_build_scenario "gui-touch" "pnpm gui build after gui touch" \
      pnpm --filter @deepcode/client build
  else
    printf '| pnpm gui build after gui touch | skipped | 0 | 0 | 0 | 0 | `pnpm unavailable` |\n' >>"$report"
  fi

  cat >>"$report" <<'REPORT'

## Dirty first 20

REPORT
  cat "$dirty_detail" >>"$report"

  cat >>"$report" <<'REPORT'

## Notes

- `touch` scenarios only update file mtimes; they should not create Git diffs.
- Cargo counts are parsed from verbose cargo output and are intended for trend comparison, not exact dependency accounting.
- If `sccache` is available, inspect hit rate with `sccache --show-stats`.
REPORT

  pass "build baseline report written to ${report#$ROOT_DIR/}"
}

info "[1/8] tool and shell checks"
require_tool bash
require_tool cargo
require_tool python3
require_tool grep
configure_test_sccache
check_static_shell_and_policy_gates
pass "shell scripts parse"

info "[2/8] Rust format and tests"
cargo fmt --check --all
cargo test -p deepcode-kernel-client -p deepcode-cli -p deepcode-tui -p deepcode-kernel-audit
cargo test --workspace
cargo run -q -p deepcode-cli -- --help >/dev/null
printf '/help\n/quit\n' | cargo run -q -p deepcode-cli >/dev/null
cargo run -q -p deepcode-tui -- --smoke >/dev/null
printf '/help\n/quit\n' | cargo run -q -p deepcode-tui >/dev/null
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

info "[4/8] stage 9/10 boundary grep gates"
for runtime_module in \
  dispatch state workspace tools workflow llm context permissions temp_artifacts obligations
do
  test -f "crates/deepcode-kernel-runtime/src/${runtime_module}.rs" \
    || fail "missing runtime module ${runtime_module}.rs"
done
for daemon_module in \
  prelude api_response state ipc static_assets kernel_api workspace_api settings_api \
  session_store agent_api agent_loop event_projection llm_transport terminal_api \
  browser_api skill_api utils
do
  test -f "crates/deepcode-kernel-daemon/src/${daemon_module}.rs" \
    || fail "missing daemon module ${daemon_module}.rs"
done
daemon_main_lines="$(wc -l < crates/deepcode-kernel-daemon/src/main.rs | tr -d ' ')"
[ "$daemon_main_lines" -le 260 ] || fail "daemon main.rs must stay facade-sized, got ${daemon_main_lines} lines"
! search "KernelCommand::" crates/deepcode-kernel-runtime/src/lib.rs \
  || fail "runtime lib.rs must not contain KernelCommand dispatch arms"
! search "fn (dispatch|workspace_|tool_invoke|execute_bound_tool|llm_response_submit|permission_resolve|run_start|run_resume|context_attach_reference|record_change_operation_for_tool)" crates/deepcode-kernel-runtime/src/lib.rs \
  || fail "runtime lib.rs must remain facade-only"
! search "pub\\(crate\\).*workspace_current|async fn workspace_current|pub\\(crate\\).*call_openai_compatible_profile|call_anthropic_profile|call_ollama_profile|drive_kernel_agent_loop|append_session_projection_jsonl|scan_skill_mount_dir|safe_asset_path" crates/deepcode-kernel-daemon/src/main.rs \
  || fail "daemon main.rs must not contain moved handler/provider/storage/static/skill-scan implementations"
search "pub fn dispatch" crates/deepcode-kernel-runtime/src/dispatch.rs >/dev/null
search "struct RuntimeState" crates/deepcode-kernel-runtime/src/state.rs >/dev/null
search "fn workspace_open" crates/deepcode-kernel-runtime/src/workspace.rs >/dev/null
search "fn tool_invoke" crates/deepcode-kernel-runtime/src/tools.rs >/dev/null
search "fn run_start" crates/deepcode-kernel-runtime/src/workflow.rs >/dev/null
search "fn llm_response_submit" crates/deepcode-kernel-runtime/src/llm.rs >/dev/null
search "fn context_attach_reference" crates/deepcode-kernel-runtime/src/context.rs >/dev/null
search "fn permission_resolve" crates/deepcode-kernel-runtime/src/permissions.rs >/dev/null
search "fn is_kernel_owned_temp_cleanup" crates/deepcode-kernel-runtime/src/temp_artifacts.rs >/dev/null
search "fn record_change_operation_for_tool" crates/deepcode-kernel-runtime/src/obligations.rs >/dev/null
search "fn workspace_current|fn workspace_open" crates/deepcode-kernel-daemon/src/workspace_api.rs >/dev/null
search "fn user_settings_get|fn llm_profiles_get" crates/deepcode-kernel-daemon/src/settings_api.rs >/dev/null
search "fn append_session_projection_jsonl|fn session_store_projection_append" crates/deepcode-kernel-daemon/src/session_store.rs >/dev/null
search "fn drive_kernel_agent_loop|fn call_llm_profile" crates/deepcode-kernel-daemon/src/agent_loop.rs >/dev/null
search "fn call_openai_compatible_profile|fn call_anthropic_profile|fn call_ollama_profile" crates/deepcode-kernel-daemon/src/llm_transport.rs >/dev/null
search "fn safe_asset_path|fn gui_asset" crates/deepcode-kernel-daemon/src/static_assets.rs >/dev/null
search "fn skill_mount_scan|fn scan_skill_mount_dir" crates/deepcode-kernel-daemon/src/skill_api.rs >/dev/null
search "fn run_length_prefixed_ipc|fn run_stdio_ipc" crates/deepcode-kernel-daemon/src/ipc.rs >/dev/null
if awk '/daemon\)/,/;;/' build.sh | grep -E 'shells/(cli|tui)' >/dev/null; then
  fail "daemon build hash must not include CLI/TUI shell sources"
fi
search "build_daemon|build_cli|build_tui" build.sh >/dev/null
! search "WorkflowDecisionState" crates/deepcode-kernel-runtime/src || fail "runtime must not define WorkflowDecisionState"
! search "match tool_name" crates/deepcode-kernel-runtime/src || fail "runtime must not use match tool_name dispatch"
search "struct WorkspaceBoundary" crates/deepcode-kernel-policy/src/workspace_boundary.rs >/dev/null
search "trait SkillExecutor" crates/deepcode-kernel-skills/src/executor.rs >/dev/null
! search "DeepCodeKernelRuntime|deepcode-kernel-runtime" crates/deepcode-host-web/src crates/deepcode-host-web/Cargo.toml || fail "host-web must not hold Kernel runtime"
! search "run_agent_workflow|stage_prompt|call_agent_stage_llm|execute_stage_tool_calls|call_llm_profile" crates/deepcode-host-web/src || fail "host-web must not own workflow/provider loop"
search "deepcode-kernel-daemon" Cargo.toml build.sh test.sh crates/deepcode-kernel-daemon/Cargo.toml >/dev/null
search "PlanContractSubmit|SkillTrustApprove|McpRiskAcknowledgmentSubmit|PlanReviewReportProduced|SkillTrustRequested|SkillTrustGranted|McpRiskAcknowledgmentRequired" crates/deepcode-kernel-abi/src/lib.rs >/dev/null
search "AuditVerify|AuditQuery|AuditVerifyCompleted|AuditDegradedEntered|AuditSegmentRotated" crates/deepcode-kernel-abi/src/lib.rs >/dev/null
search "SkillTrustMode|BrokeredScript|DirectHostScript|ScriptBroker|ScriptBrokerPolicy|capability_for_broker_method" crates/deepcode-kernel-skills/src >/dev/null
search "struct SkillManifest|enum WorkspaceAccess|fn hash_skill_material|fn scan_skill_manifest|struct SkillRiskReport|model_visible_skill_descriptors" crates/deepcode-kernel-skills/src >/dev/null
search "struct McpConnectorDescriptor|struct McpToolBinding|struct McpRiskAcknowledgment|fn model_visible_mcp_tools" crates/deepcode-kernel-skills/src >/dev/null
! search "TODO\\(stage-9\\): Move LLM provider transport" crates/deepcode-kernel-daemon/src/main.rs || fail "daemon LLM transport must not keep stale stage-9 migration TODOs"
test -f fixtures/skill-mcp-smoke/README.md || fail "missing Skill/MCP smoke fixture README"
test -f fixtures/skill-mcp-smoke/skills/text-echo-declarative/skill.manifest.json || fail "missing declarative text skill fixture"
test -f fixtures/skill-mcp-smoke/skills/text-transform-brokered/skill.manifest.json || fail "missing brokered text skill fixture"
test -f fixtures/skill-mcp-smoke/skills/text-transform-brokered/transform.py || fail "missing brokered text skill script fixture"
test -f fixtures/skill-mcp-smoke/mcp/mcp-text-tools/connector.json || fail "missing MCP text tools connector fixture"
test -f fixtures/skill-mcp-smoke/mcp/mcp-text-tools/binding-acknowledged.json || fail "missing MCP acknowledged binding fixture"
test -f crates/deepcode-kernel-skills/tests/skill_mcp_smoke.rs || fail "missing Skill/MCP smoke integration test"
search "fn skill_trust_approve|model_visible_skill_descriptors" crates/deepcode-kernel-runtime/src/tools.rs >/dev/null
search "PlanReviewEngine|PlanReviewReport" crates/deepcode-kernel-workflow/src >/dev/null
search "SignedAuditEntryV1|AuditSegmentSealV1|AuditVerifier" crates/deepcode-kernel-audit/src >/dev/null
search "struct HttpKernelClient|send_prompt|daemon_status" crates/deepcode-kernel-client/src/lib.rs >/dev/null
search "enum Command|DaemonStatus|Ask" shells/cli/src/main.rs >/dev/null
search "run_interactive|/help|/status|/ask <prompt>|/quit" shells/cli/src/main.rs >/dev/null
search "ratatui|crossterm|CardModel|struct Renderer|audit-status|command_help|/help|/status|/ask <prompt>|/quit" shells/tui/src >/dev/null
! search "DeepCodeKernelRuntime|deepcode-kernel-runtime" crates/deepcode-kernel-client/src shells/cli/src shells/tui/src || fail "CLI/TUI/client must not reference Kernel runtime"
search "\\[profile\\.dev\\]" Cargo.toml >/dev/null
search "\\[profile\\.release\\]" Cargo.toml >/dev/null
search "incremental = true" Cargo.toml >/dev/null
search "DEEPCODE_DISABLE_SCCACHE|RUSTC_WRAPPER|sccache --show-stats|--stage" build.sh >/dev/null
search '"frontendDist": "../dist"' shells/tauri/src-tauri/tauri.conf.json >/dev/null
search "prepare_tauri_dist|shells/tauri/dist" build.sh shells/tauri/README.md >/dev/null
! search "waitForKernel|window.location.replace" build.sh shells/tauri/src-tauri/tauri.conf.json shells/tauri/README.md \
  || fail "Tauri shell must load the full GUI dist directly without boot-page redirect"
! search "boot-ui" build.sh shells/tauri/src-tauri/tauri.conf.json shells/tauri/README.md \
  || fail "Tauri shell must not keep boot-ui in its default launch path"
test ! -e shells/tauri/boot-ui/index.html || fail "Tauri boot-ui intermediate page must be removed"
search "\\.deepcode/build-baselines/" .gitignore >/dev/null
search "\\.build-cache|\\.deepcode/build-baselines|\\.pnpm-store" .dockerignore >/dev/null
search "run_build_baseline_probe|cargo release repeat|cargo release after runtime touch|build-baselines" test.sh >/dev/null
search "--mount=type=cache|sccache|SCCACHE_DIR" Dockerfile.dev >/dev/null
pass "stage 9/10/10.5/11/12 grep gates"

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
DEEPCODE_API_URL="http://127.0.0.1:${TEST_PORT}" cargo run -q -p deepcode-cli -- daemon status >/dev/null
DEEPCODE_API_URL="http://127.0.0.1:${TEST_PORT}" cargo run -q -p deepcode-tui -- --smoke >/dev/null
pass "CLI/TUI Host shell smoke"

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

info "[6b/8] Kernel daemon framed IPC smoke"
ipc_reply="$(
  printf '%s\n' '{"command":{"kind":"healthCheck","requestId":"req-ipc-health"}}' \
  | DEEPCODE_DAEMON_IPC_STDIO=1 \
    DEEPCODE_LEDGER_BACKEND=memory \
    cargo run -q -p deepcode-kernel-daemon
)"
assert_json_expr "$ipc_reply" 'data["ok"] is True and any(event["kind"] == "host.status" for event in data["events"])' "daemon stdio IPC health"

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
assert_json_expr "$framed_ipc_reply" 'data["ok"] is True and any(event["kind"] == "host.status" for event in data["events"])' "daemon length-prefixed IPC health"

info "[7/8] optional packaging smoke"
if [ "${DEEPCODE_SKIP_PACKAGING_SMOKE:-1}" = "0" ]; then
  ./build.sh
  test -x "$ROOT_DIR/bin/linux-x64/deepcode-kernel"
  test -x "$ROOT_DIR/bin/linux-x64/deepcode"
  test -x "$ROOT_DIR/bin/linux-x64/deepcode-cli"
  test -x "$ROOT_DIR/bin/linux-x64/deepcode-tui"
  test -f "$ROOT_DIR/bin/win64/deepcode-kernel.exe"
  test -f "$ROOT_DIR/bin/win64/deepcode-cli.exe"
  test -f "$ROOT_DIR/bin/win64/deepcode-tui.exe"
  test -f "$ROOT_DIR/bin/win64/deepcode.cmd"
  test -f "$ROOT_DIR/bin/win64/DeepCode.exe"
  test -f "$ROOT_DIR/bin/win64/WebView2Loader.dll"
  "$ROOT_DIR/bin/linux-x64/deepcode" --help >/dev/null
  "$ROOT_DIR/bin/linux-x64/deepcode-cli" --help >/dev/null
  "$ROOT_DIR/bin/linux-x64/deepcode-tui" --smoke >/dev/null
  pass "packaging smoke"
else
  info "packaging smoke skipped; set DEEPCODE_SKIP_PACKAGING_SMOKE=0 to enable"
fi

info "[7b/8] optional build baseline probe"
if [ "${DEEPCODE_RUN_BUILD_BENCH:-0}" = "1" ]; then
  run_build_baseline_probe
  pass "build baseline probe"
else
  info "build baseline probe skipped; set DEEPCODE_RUN_BUILD_BENCH=1 to enable"
fi

if command -v sccache >/dev/null 2>&1 && [ "${DEEPCODE_DISABLE_SCCACHE:-0}" != "1" ]; then
  info "sccache stats"
  sccache --show-stats || true
else
  info "sccache stats unavailable or disabled"
fi

info "[8/8] done"
pass "DeepCode stage 9/10/10.5/11/12 fast smoke passed"
