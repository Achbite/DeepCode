#!/usr/bin/env bash
# ====================================================================
# DeepCode stage 5 closeout three-layer Kernel Host smoke test
#
# 默认入口必须是 Rust Kernel Web Host；TS 仅做 protocol/session-core/client。
# 旧 Node server、pkg 打包链路、TS 工具执行/权限裁决不得进入默认链路。
# ====================================================================
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/deepcode-cargo-target}"
TEST_PORT="${DEEPCODE_TEST_PORT:-31246}"
HEALTH_URL="http://127.0.0.1:${TEST_PORT}/api/health"
KERNEL_COMMANDS_URL="http://127.0.0.1:${TEST_PORT}/api/kernel/commands"
KERNEL_SNAPSHOT_URL="http://127.0.0.1:${TEST_PORT}/api/kernel/snapshot"
KERNEL_EVENTS_URL="http://127.0.0.1:${TEST_PORT}/api/kernel/events/stream"
CURRENT_WS_URL="http://127.0.0.1:${TEST_PORT}/api/workspaces/current"
OPEN_WS_URL="http://127.0.0.1:${TEST_PORT}/api/workspaces/open"
TOOL_EXECUTE_URL="http://127.0.0.1:${TEST_PORT}/api/agent/tools/execute"
TOOLS_URL="http://127.0.0.1:${TEST_PORT}/api/agent/tools"
RUNTIME_SHELL_URL="http://127.0.0.1:${TEST_PORT}/api/runtime/shell"
TERMINAL_CAP_URL="http://127.0.0.1:${TEST_PORT}/api/terminal/capabilities"
FS_LOCATIONS_URL="http://127.0.0.1:${TEST_PORT}/api/fs/initial-locations"
FS_BROWSE_URL="http://127.0.0.1:${TEST_PORT}/api/fs/browse"
USER_SETTINGS_URL="http://127.0.0.1:${TEST_PORT}/api/user-settings"
LLM_PROFILES_URL="http://127.0.0.1:${TEST_PORT}/api/llm/profiles"
BROWSER_STATUS_URL="http://127.0.0.1:${TEST_PORT}/api/browser/runtime-status"
AGENT_SESSIONS_URL="http://127.0.0.1:${TEST_PORT}/api/agent/sessions"
AGENT_WORKFLOW_URL="http://127.0.0.1:${TEST_PORT}/api/agent/workflow-config"
SESSION_STORE_URL="http://127.0.0.1:${TEST_PORT}/api/session-store"
TERMINAL_WARMUP_URL="http://127.0.0.1:${TEST_PORT}/api/terminal/warmup"
TERMINAL_SESSIONS_URL="http://127.0.0.1:${TEST_PORT}/api/terminal/sessions"
LOG_FILE="/tmp/_deepcode_host_web_$$.log"
PID_FILE="/tmp/_deepcode_host_web_$$.pid"
PACKAGE_PORT="${DEEPCODE_PACKAGE_TEST_PORT:-31247}"
PACKAGE_URL="http://127.0.0.1:${PACKAGE_PORT}"
PACKAGE_HEALTH_URL="${PACKAGE_URL}/api/health"
PACKAGE_LOG_FILE="/tmp/_deepcode_package_host_$$.log"
PACKAGE_PID_FILE="/tmp/_deepcode_package_host_$$.pid"
SMOKE_DIR=""
CONFIG_DIR=""
PACKAGE_CONFIG_DIR=""
NODE_SHIM_DIR=""
JQ_SHIM_DIR=""
ROOT_CARGO_LOCK_WAS_PRESENT=0

if [ -f "$ROOT_DIR/Cargo.lock" ]; then
  ROOT_CARGO_LOCK_WAS_PRESENT=1
fi

pass() { echo -e "\033[32m[PASS]\033[0m $*"; }
fail() { echo -e "\033[31m[FAIL]\033[0m $*"; }
info() { echo -e "\033[36m[INFO]\033[0m $*"; }

cleanup() {
  if [ -f "$PACKAGE_PID_FILE" ]; then
    local package_pid
    package_pid="$(cat "$PACKAGE_PID_FILE" 2>/dev/null || true)"
    if [ -n "$package_pid" ] && kill -0 "$package_pid" 2>/dev/null; then
      kill "$package_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$package_pid" 2>/dev/null || true
    fi
    rm -f "$PACKAGE_PID_FILE"
  fi
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  rm -f "$LOG_FILE" "$PACKAGE_LOG_FILE"
  if [ -n "$SMOKE_DIR" ]; then
    rm -rf "$SMOKE_DIR"
  fi
  if [ -n "$CONFIG_DIR" ]; then
    rm -rf "$CONFIG_DIR"
  fi
  if [ -n "$PACKAGE_CONFIG_DIR" ]; then
    rm -rf "$PACKAGE_CONFIG_DIR"
  fi
  if [ -n "$NODE_SHIM_DIR" ]; then
    rm -rf "$NODE_SHIM_DIR"
  fi
  if [ -n "$JQ_SHIM_DIR" ]; then
    rm -rf "$JQ_SHIM_DIR"
  fi
  if [ "$ROOT_CARGO_LOCK_WAS_PRESENT" = "0" ]; then
    rm -f "$ROOT_DIR/Cargo.lock"
  fi
}
trap cleanup EXIT

CONFIG_DIR="$(mktemp -d /tmp/deepcode-stage57-config-XXXXXX)"
PACKAGE_CONFIG_DIR="$(mktemp -d /tmp/deepcode-stage57-package-config-XXXXXX)"

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool is required"
    exit 1
  fi
  "$tool" --version >/dev/null 2>&1 || true
}

setup_node_toolchain() {
  if command -v node >/dev/null 2>&1 \
    && node --version >/dev/null 2>&1 \
    && command -v pnpm >/dev/null 2>&1 \
    && pnpm --version >/dev/null 2>&1; then
    return
  fi

  local windows_node="/mnt/c/Users/kkkdiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
  local windows_pnpm_js="/mnt/c/Program Files/nodejs/node_modules/corepack/dist/pnpm.js"
  if [ ! -x "$windows_node" ] || [ ! -f "$windows_pnpm_js" ]; then
    return
  fi

  local windows_pnpm_js_arg
  windows_pnpm_js_arg="$(wslpath -w "$windows_pnpm_js" 2>/dev/null || true)"
  if [ -z "$windows_pnpm_js_arg" ]; then
    return
  fi

  NODE_SHIM_DIR="$(mktemp -d /tmp/deepcode-node-shim-XXXXXX)"
  cat >"$NODE_SHIM_DIR/node" <<EOF
#!/usr/bin/env bash
exec "$windows_node" "\$@"
EOF
  cat >"$NODE_SHIM_DIR/pnpm" <<EOF
#!/usr/bin/env bash
exec "$windows_node" "$windows_pnpm_js_arg" "\$@"
EOF
  chmod +x "$NODE_SHIM_DIR/node" "$NODE_SHIM_DIR/pnpm"
  export PATH="$NODE_SHIM_DIR:$PATH"
}

setup_jq_toolchain() {
  if command -v jq >/dev/null 2>&1 && jq --version >/dev/null 2>&1; then
    return
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return
  fi

  JQ_SHIM_DIR="$(mktemp -d /tmp/deepcode-jq-shim-XXXXXX)"
  cat >"$JQ_SHIM_DIR/jq" <<'PY'
#!/usr/bin/env python3
import json
import sys


def parse_args(argv):
    raw = False
    no_input = False
    args = {}
    filters = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-e", "-c"):
            i += 1
            continue
        if arg == "-r":
            raw = True
            i += 1
            continue
        if arg in ("-n", "-nc", "-cn"):
            no_input = True
            i += 1
            continue
        if arg == "--arg":
            args[argv[i + 1]] = argv[i + 2]
            i += 3
            continue
        filters.append(arg)
        i += 1
    if not filters:
        raise SystemExit(2)
    return raw, no_input, args, filters[-1]


def emit(value, raw):
    if isinstance(value, bool):
        if value:
            return 0
        return 1
    if raw:
        if isinstance(value, list):
            for item in value:
                print("" if item is None else item)
        else:
            print("" if value is None else value)
    else:
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    return 0


def body_for_filter(filter_text, args):
    compact = " ".join(filter_text.split())
    if compact == "{path:$path}":
        return {"path": args["path"]}
    if "write-no-workspace" in compact or "deny-no-workspace" in compact:
        return {
            "toolCall": {
                "id": "write-no-workspace",
                "name": "fs.write",
                "arguments": {"path": "_agent_tmp_should_not_write.txt", "content": "no workspace"},
            }
        }
    if "write-smoke" in compact:
        return {
            "toolCall": {
                "id": "write-smoke",
                "name": "fs.write",
                "arguments": {"path": "_agent_tmp_stage57.txt", "content": "needle from kernel\n"},
            },
        }
    if "read-smoke" in compact:
        return {"toolCall": {"id": "read-smoke", "name": "fs.read", "arguments": {"path": "_agent_tmp_stage57.txt"}}}
    if "search-smoke" in compact:
        return {"toolCall": {"id": "search-smoke", "name": "code.search", "arguments": {"query": "needle"}}}
    if "diff-smoke" in compact:
        return {
            "toolCall": {
                "id": "diff-smoke",
                "name": "fs.diff",
                "arguments": {"path": "_agent_tmp_stage57.txt", "newContent": "needle changed\n"},
            }
        }
    if "delete-smoke" in compact:
        return {
            "toolCall": {"id": "delete-smoke", "name": "fs.delete", "arguments": {"path": "_agent_tmp_stage57.txt"}},
        }
    if "workspaceBinding" in compact and "workflowConfig" in compact:
        open_path = args["openPath"]
        return {
            "content": "这是一个测试请求，返回你的身份信息，然后测试当前agent所有的功能组件，能否新建临时文件读写这个临时文件然后删除这个临时文件",
            "mode": "askBeforeWrite",
            "workflow": "planFirst",
            "profileId": "profile-smoke",
            "workflowConfig": {
                "plan": {"profileId": "profile-smoke"},
                "check": {"profileId": "profile-smoke"},
                "complete": {"profileId": "profile-smoke"},
                "review": {"profileId": "profile-smoke"},
            },
            "workspaceBinding": {
                "workspaceId": "smoke-workspace",
                "workspaceHash": "smoke-hash",
                "openPath": open_path,
                "activeFolderId": "wf-0",
            },
        }
    raise SystemExit(2)


def has_event(data, kind, tool=None, ok=None, channel=None, contains=None):
    for event in data.get("data", {}).get("events", []):
        payload = event.get("payload", {})
        if event.get("kind") != kind:
            continue
        if tool is not None and payload.get("toolName") != tool:
            continue
        if ok is not None and payload.get("ok") is not ok:
            continue
        if channel is not None and payload.get("channel") != channel:
            continue
        if contains is not None and contains not in str(payload.get("content", "")):
            continue
        return True
    return False


def eval_filter(data, filter_text, args):
    compact = " ".join(filter_text.split())
    d = data.get("data", {}) if isinstance(data, dict) else {}

    checks = {
        '.ok == true and .data.service == "deepcode-host-web"': lambda: data.get("ok") is True and d.get("service") == "deepcode-host-web",
        '.ok == true and .data.current == null and (.data.fallbackUsed | type == "boolean")': lambda: data.get("ok") is True and d.get("current") is None and isinstance(d.get("fallbackUsed"), bool),
        '.ok == true and .data.ok == false and .data.code == "no_workspace"': lambda: data.get("ok") is True and d.get("ok") is False and d.get("code") == "no_workspace",
        '.ok == true and .data.workspace.folders[0].id == "wf-0"': lambda: data.get("ok") is True and d.get("workspace", {}).get("folders", [{}])[0].get("id") == "wf-0",
        '.ok == true and (.data | type == "array") and (.data | length >= 1)': lambda: data.get("ok") is True and isinstance(d, list) and len(d) >= 1,
        '.ok == true and (.data.locations | length >= 1) and (.data.locations[0].absolutePath | type == "string")': lambda: data.get("ok") is True and len(d.get("locations", [])) >= 1 and isinstance(d.get("locations", [{}])[0].get("absolutePath"), str),
        '.ok == true and .data.entries[0].type == "directory" and .data.entries[0].name == "bin"': lambda: data.get("ok") is True and d.get("entries", [{}])[0].get("type") == "directory" and d.get("entries", [{}])[0].get("name") == "bin",
        '.ok == true and .data[0].type == "directory" and .data[0].name == "bin"': lambda: data.get("ok") is True and isinstance(d, list) and len(d) >= 1 and d[0].get("type") == "directory" and d[0].get("name") == "bin",
        '.ok == true and .data.created == true and .data.overwritten == false and .data.workspace.source == "code-workspace"': lambda: data.get("ok") is True and d.get("created") is True and d.get("overwritten") is False and d.get("workspace", {}).get("source") == "code-workspace",
        '.ok == true and .data.ok == true and .data.output.saved == true': lambda: data.get("ok") is True and d.get("ok") is True and d.get("output", {}).get("saved") is True,
        '.ok == true and .data.ok == true and (.data.output.content | contains("needle from kernel"))': lambda: data.get("ok") is True and d.get("ok") is True and "needle from kernel" in str(d.get("output", {}).get("content", "")),
        '.ok == true and .data.ok == true and (.data.output.matches | length >= 1)': lambda: data.get("ok") is True and d.get("ok") is True and len(d.get("output", {}).get("matches", [])) >= 1,
        '.ok == true and .data.ok == true and (.data.output.diff | contains("needle changed"))': lambda: data.get("ok") is True and d.get("ok") is True and "needle changed" in str(d.get("output", {}).get("diff", "")),
        '.ok == true and .data.ok == true and .data.output.deleted == true': lambda: data.get("ok") is True and d.get("ok") is True and d.get("output", {}).get("deleted") is True,
        '.ok == true and .data.pendingPermission == true and .data.permission.capability == "cap.fs.write"': lambda: data.get("ok") is True and d.get("pendingPermission") is True and d.get("permission", {}).get("capability") == "cap.fs.write",
        '.ok == true and .data.pendingPermission == true and .data.permission.capability == "cap.fs.delete"': lambda: data.get("ok") is True and d.get("pendingPermission") is True and d.get("permission", {}).get("capability") == "cap.fs.delete",
        '.ok == true and .data.appended == 1': lambda: data.get("ok") is True and d.get("appended") == 1,
        '.ok == true and (.data.events | length >= 1)': lambda: data.get("ok") is True and len(d.get("events", [])) >= 1,
        '.ok == true and (.data.sessions | length >= 1)': lambda: data.get("ok") is True and len(d.get("sessions", [])) >= 1,
        '.ok == true and ([.data.skills[].id] | index("fs.delete") != null)': lambda: data.get("ok") is True and any(skill.get("id") == "fs.delete" for skill in d.get("skills", [])),
        '.data.skills[] | select(.id == "fs.delete") | .modelVisible == false': lambda: any(skill.get("id") == "fs.delete" and skill.get("modelVisible") is False for skill in d.get("skills", [])),
        '.ok == true and .data.agentUsesUnixCommands == true': lambda: data.get("ok") is True and d.get("agentUsesUnixCommands") is True,
        '.ok == true and .data.shell.managedBy == "deepcode-kernel"': lambda: data.get("ok") is True and d.get("shell", {}).get("managedBy") == "deepcode-kernel",
        '.ok == true and .data.settings["workbench.language"] == "zh-CN" and (.data.storePath | type == "string")': lambda: data.get("ok") is True and d.get("settings", {}).get("workbench.language") == "zh-CN" and isinstance(d.get("storePath"), str),
        '.ok == true and (.data.changedKeys | index("workbench.language") != null)': lambda: data.get("ok") is True and "workbench.language" in d.get("changedKeys", []),
        '.ok == true and (.data.profiles | length >= 1) and (.data.defaultProfileId | type == "string")': lambda: data.get("ok") is True and len(d.get("profiles", [])) >= 1 and isinstance(d.get("defaultProfileId"), str),
        '.data.profiles[0].secretRef == "local-secret:profile-smoke"': lambda: d.get("profiles", [{}])[0].get("secretRef") == "local-secret:profile-smoke",
        '.ok == true and .data.ok == true and .data.provider == "openaiCompatible"': lambda: data.get("ok") is True and d.get("ok") is True and d.get("provider") == "openaiCompatible",
        '.ok == true and (.data.assistantMessage.content | type == "string")': lambda: data.get("ok") is True and isinstance(d.get("assistantMessage", {}).get("content"), str),
        '.ok == true and .data.session.mode == "plan"': lambda: data.get("ok") is True and d.get("session", {}).get("mode") == "plan",
        '.ok == true and .data.trace.eventCount >= 1': lambda: data.get("ok") is True and d.get("trace", {}).get("eventCount", 0) >= 1,
        '.ok == true and .data.initialized == true and .data.config.plan != null': lambda: data.get("ok") is True and d.get("initialized") is True and d.get("config", {}).get("plan") is not None,
        '.ok == true and .data.capabilities.status == "available"': lambda: data.get("ok") is True and d.get("capabilities", {}).get("status") == "available",
        '.ok == true and .data.status == "running" and .data.diagnostics.lastAction == "open"': lambda: data.get("ok") is True and d.get("status") == "running" and d.get("diagnostics", {}).get("lastAction") == "open",
        '.ok == true and .data.inspectState == "selecting"': lambda: data.get("ok") is True and d.get("inspectState") == "selecting",
        '.ok == true and .data.snapshot != null': lambda: data.get("ok") is True and d.get("snapshot") is not None,
        '.ok == true and .data.state == "ready"': lambda: data.get("ok") is True and d.get("state") == "ready",
        '.ok == true and (.data.events | length >= 2)': lambda: data.get("ok") is True and len(d.get("events", [])) >= 2,
        '.ok == false and .error == "api_not_implemented"': lambda: data.get("ok") is False and data.get("error") == "api_not_implemented",
        '.ok == true and (.events[] | select(.kind == "host.status")) and .snapshot != null': lambda: data.get("ok") is True and any(event.get("kind") == "host.status" for event in data.get("events", [])) and data.get("snapshot") is not None,
        '.ok == true and .snapshot != null': lambda: data.get("ok") is True and data.get("snapshot") is not None,
    }
    if compact in checks:
        return checks[compact]()
    if compact == '.ok == true and (.data.storePath | startswith($config + "/config/user/local/settings/")) and (.data.storePath | contains("/bin/") | not)':
        store = d.get("storePath", "")
        return data.get("ok") is True and store.startswith(args["config"] + "/config/user/local/settings/") and "/bin/" not in store
    if compact == ".data.session.id":
        return d.get("session", {}).get("id", "")
    if compact == ".data.permission.id":
        return d.get("permission", {}).get("id", "")
    if compact == ".data.id":
        return d.get("id", "")
    if compact == ".ok == true and (.data.sessions[] | select(.id == $id))":
        return data.get("ok") is True and any(item.get("id") == args["id"] for item in d.get("sessions", []))
    if compact == ".ok == true and .data.session.id == $id":
        return data.get("ok") is True and d.get("session", {}).get("id") == args["id"]
    if compact == ".ok == true and .data.id == $id":
        return data.get("ok") is True and d.get("id") == args["id"]
    if compact == '.ok == true and (.data.events[] | select(.kind == "permission_request" and .payload.toolName == "fs.write"))':
        return data.get("ok") is True and has_event(data, "permission_request", tool="fs.write")
    if compact == '.data.events[] | select(.kind == "permission_request" and .payload.toolName == "fs.write") | .payload.id':
        return [event.get("payload", {}).get("id", "") for event in d.get("events", []) if event.get("kind") == "permission_request" and event.get("payload", {}).get("toolName") == "fs.write"]
    if compact == '.ok == true and (.data.events[] | select(.kind == "tool_result" and .payload.toolName == "fs.read" and .payload.ok == true))':
        return data.get("ok") is True and has_event(data, "tool_result", tool="fs.read", ok=True)
    if compact == '.ok == true and (.data.events[] | select(.kind == "tool_result" and .payload.toolName == "fs.write" and .payload.ok == true))':
        return data.get("ok") is True and has_event(data, "tool_result", tool="fs.write", ok=True)
    if compact == '.ok == true and (.data.events[] | select(.kind == "tool_result" and .payload.toolName == "fs.delete" and .payload.ok == true))':
        return data.get("ok") is True and has_event(data, "tool_result", tool="fs.delete", ok=True)
    if compact == '.ok == true and ([.data.events[] | select(.kind == "assistant_msg" and (.payload.channel == "final") and (.payload.content | contains("DeepCode Agent")))] | length == 1)':
        count = 0
        for event in d.get("events", []):
            payload = event.get("payload", {})
            if event.get("kind") == "assistant_msg" and payload.get("channel") == "final" and "DeepCode Agent" in str(payload.get("content", "")):
                count += 1
        return data.get("ok") is True and count == 1
    raise SystemExit(2)


def main():
    raw, no_input, args, filter_text = parse_args(sys.argv[1:])
    if no_input:
        return emit(body_for_filter(filter_text, args), raw)
    source = sys.stdin.read()
    data = json.loads(source) if source.strip() else None
    return emit(eval_filter(data, filter_text, args), raw)


if __name__ == "__main__":
    raise SystemExit(main())
PY
  chmod +x "$JQ_SHIM_DIR/jq"
  export PATH="$JQ_SHIM_DIR:$PATH"
}

echo "============================================================"
echo " DeepCode stage 5 closeout test ($(date -Is))"
echo " ROOT_DIR=$ROOT_DIR"
echo " TEST_PORT=$TEST_PORT"
echo " PACKAGE_PORT=$PACKAGE_PORT"
echo " CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "============================================================"

info "[1/6] tooling"
setup_node_toolchain
setup_jq_toolchain
for tool in rustc cargo node pnpm curl jq; do
  require_tool "$tool"
done
if [ "${DEEPCODE_SKIP_PACKAGING_SMOKE:-0}" != "1" ]; then
  require_tool x86_64-w64-mingw32-gcc
fi
pass "tooling ok"

info "[2/6] Rust kernel workspace"
cargo fmt --check --all
cargo check --workspace
cargo test --workspace
cargo fmt --check --manifest-path shells/tauri/src-tauri/Cargo.toml
cargo check --manifest-path shells/tauri/src-tauri/Cargo.toml
pass "cargo fmt/check/test ok"

info "[3/6] TS user/session/UI packages"
pnpm install --no-frozen-lockfile
pnpm --filter @deepcode/protocol build
pnpm --filter @deepcode/session-core build
pnpm --filter @deepcode/protocol typecheck
pnpm --filter @deepcode/session-core typecheck
pnpm --filter @deepcode/client typecheck
node --input-type=module <<'NODE'
import {
  MemoryTranscriptStore,
  appendUserMessageBeforeKernelDispatch,
  createTranscriptMessage,
  TranscriptChain,
  ProjectionEngine,
} from './userspace/session-core/dist/index.js';

const store = new MemoryTranscriptStore();
const user = await appendUserMessageBeforeKernelDispatch(store, {
  sessionId: 'session-smoke',
  content: 'hello kernel',
});
const progress = createTranscriptMessage({
  sessionId: 'session-smoke',
  parentUuid: user.uuid,
  role: 'assistant',
  channel: 'progress',
  content: 'working',
  visible: false,
});
await store.append(progress);
const final = createTranscriptMessage({
  sessionId: 'session-smoke',
  parentUuid: user.uuid,
  role: 'assistant',
  channel: 'final',
  content: 'done',
});
await store.append(final);
const entries = await store.list('session-smoke');
const chain = TranscriptChain.rebuild(entries, final.uuid);
if (chain.length !== 2 || chain[0].uuid !== user.uuid || chain[1].uuid !== final.uuid) {
  throw new Error('transcript parent chain should exclude invisible progress cards');
}
const cards = new ProjectionEngine().projectKernelEvents([{ kind: 'tool.completed', sequence: 7 }], 'session-smoke');
if (cards.length !== 1 || cards[0].kind !== 'tool') {
  throw new Error('kernel event projection should produce a tool card');
}
NODE
pass "protocol/session-core/client typecheck ok"

info "[3b/6] legacy default-route gates"
! grep -RInE '"server"|@deepcode/server' pnpm-workspace.yaml package.json
! grep -RInE 'deepcode-server|pkg@|pkg ' build.sh package.json
! grep -RInE 'PermissionGate|ToolRegistry|WorkflowMachine|child_process|spawn\(|exec\(' userspace/session-core/src
! grep -RInE 'HostWorkflowMemory|pending_permissions|execute_tool_call|approved: Option|PermissionEvaluateRequest' crates/deepcode-host-web/src crates/deepcode-kernel-runtime/src
! grep -RInE 'AGENT_WORKFLOW_STAGES|run_agent_workflow|call_agent_stage_llm|execute_stage_tool_calls|drive_temp_lifecycle|stage_prompt|model_visible_tools' crates/deepcode-host-web/src userspace/gui/src userspace/protocol/src
! grep -RInE 'executeAgentTool|evaluateAgentPermission|agentRuntime|toolExecutors|permissionGate' userspace/gui/src
test ! -e userspace/gui/src/services/agentRuntime.ts
test ! -e userspace/gui/src/services/toolExecutors.ts
test ! -e userspace/gui/src/services/permissionGate.ts
test ! -e Dockerfile.tauri
! find client server tauri packages -type f 2>/dev/null | grep .
test -f shells/tauri/src-tauri/Cargo.toml
test -f shells/tauri/src-tauri/src/main.rs
! grep -RInE 'Agent|workflow|tool executor|permission evaluator|session truth|KernelCommand|ToolInvoke|child_process|spawn\(|exec\(' shells/tauri/src-tauri/src
bash -n build.sh
pass "legacy Node server, old TS runtime, Host truth, and thick Tauri gates ok"

info "[4/6] start Rust Axum host"
DEEPCODE_HOST=127.0.0.1 \
DEEPCODE_PORT="$TEST_PORT" \
DEEPCODE_CONFIG_DIR="$CONFIG_DIR" \
DEEPCODE_LLM_MOCK=1 \
cargo run -p deepcode-host-web >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null -m 1 "$HEALTH_URL" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  fail "deepcode-host-web did not become ready"
  tail -n 80 "$LOG_FILE" || true
  exit 5
fi
pass "Rust Web Host is ready"

info "[5/6] API smoke"
HEALTH_BODY="$(curl -fsS -m 2 "$HEALTH_URL")"
echo "$HEALTH_BODY" | jq -e '.ok == true and .data.service == "deepcode-host-web"' >/dev/null
pass "/api/health ok"

KERNEL_HEALTH_BODY="$(curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"requestId":"kernel-health-smoke","command":{"kind":"healthCheck","requestId":"kernel-health-smoke"}}' \
  "$KERNEL_COMMANDS_URL")"
echo "$KERNEL_HEALTH_BODY" | jq -e '.ok == true and (.events[] | select(.kind == "host.status")) and .snapshot != null' >/dev/null
curl -fsS -m 3 "$KERNEL_SNAPSHOT_URL" | jq -e '.ok == true and .snapshot != null' >/dev/null
curl -fsS -m 3 "$KERNEL_EVENTS_URL" | grep -q '^event: kernel'
pass "Kernel Gateway commands/snapshot/events stream ok"

CURRENT_BODY="$(curl -fsS -m 2 "$CURRENT_WS_URL")"
echo "$CURRENT_BODY" | jq -e '.ok == true and .data.current == null and (.data.fallbackUsed | type == "boolean")' >/dev/null
pass "/api/workspaces/current starts empty"

NO_WS_PERMISSION_BODY="$(jq -nc '{
  toolCall: {
    id: "deny-no-workspace",
    name: "fs.write",
    arguments: { path: "_agent_tmp_no_workspace.txt", content: "blocked" }
  }
}')"
NO_WS_PERMISSION_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$NO_WS_PERMISSION_BODY" "$TOOL_EXECUTE_URL")"
echo "$NO_WS_PERMISSION_RESP" | jq -e '.ok == true and .data.ok == false and .data.code == "no_workspace"' >/dev/null
pass "permission preflight denies fs.write without workspace"

SMOKE_DIR="$(mktemp -d /tmp/deepcode-stage57-smoke-XXXXXX)"
mkdir -p "$SMOKE_DIR/bin" "$SMOKE_DIR/.hidden-dir"
printf 'DeepCode stage 5.8 smoke\n' > "$SMOKE_DIR/README.md"
printf 'visible file\n' > "$SMOKE_DIR/a-file.txt"
printf 'hidden file\n' > "$SMOKE_DIR/.hidden-file"
WORKSPACE_FILE="$SMOKE_DIR/CPP_Project.code-workspace"
printf '{\n  "folders": [ { "path": "." } ],\n  "settings": {}\n}\n' > "$WORKSPACE_FILE"
OPEN_BODY="$(jq -nc --arg path "$WORKSPACE_FILE" '{path:$path}')"
OPEN_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$OPEN_BODY" "$OPEN_WS_URL")"
echo "$OPEN_RESP" | jq -e '.ok == true and .data.workspace.folders[0].id == "wf-0"' >/dev/null
pass "workspace.open accepts .code-workspace"

curl -fsS -m 3 "$FS_LOCATIONS_URL" \
  | jq -e '.ok == true and (.data.locations | length >= 1) and (.data.locations[0].absolutePath | type == "string")' >/dev/null
BROWSE_RESP="$(curl -fsS -m 3 -G --data-urlencode "path=$SMOKE_DIR" "$FS_BROWSE_URL")"
echo "$BROWSE_RESP" | jq -e '.ok == true and .data.entries[0].type == "directory" and .data.entries[0].name == "bin"' >/dev/null
pass "workspace browse exposes quick locations and sorted entries"

FILE_TREE_RESP="$(curl -fsS -m 3 "http://127.0.0.1:${TEST_PORT}/api/files/tree?folderId=wf-0")"
echo "$FILE_TREE_RESP" | jq -e '.ok == true and (.data | type == "array") and (.data | length >= 1)' >/dev/null
echo "$FILE_TREE_RESP" | jq -e '.ok == true and .data[0].type == "directory" and .data[0].name == "bin"' >/dev/null
pass "GUI file tree API returns node array"

SAVE_WORKSPACE_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"fileName":"SavedDeepCode.code-workspace"}' \
  "http://127.0.0.1:${TEST_PORT}/api/workspaces/save-file")"
echo "$SAVE_WORKSPACE_RESP" | jq -e '.ok == true and .data.created == true and .data.overwritten == false and .data.workspace.source == "code-workspace"' >/dev/null
test -f "$SMOKE_DIR/SavedDeepCode.code-workspace"
pass "current folder can be saved and reopened as .code-workspace"

WRITE_BODY="$(jq -nc '{
  toolCall: {
    id: "write-smoke",
    name: "fs.write",
    arguments: { path: "_agent_tmp_stage57.txt", content: "needle from kernel\n" }
  }
}')"
WRITE_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$WRITE_BODY" "$TOOL_EXECUTE_URL")"
echo "$WRITE_RESP" | jq -e '.ok == true and .data.pendingPermission == true and .data.permission.capability == "cap.fs.write"' >/dev/null
WRITE_PERMISSION_ID="$(echo "$WRITE_RESP" | jq -r '.data.permission.id')"
WRITE_RESOLVE_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"decision":"accept"}' \
  "http://127.0.0.1:${TEST_PORT}/api/agent/permissions/${WRITE_PERMISSION_ID}/resolve")"
echo "$WRITE_RESOLVE_RESP" | jq -e '.ok == true and (.data.events[] | select(.kind == "tool_result" and .payload.toolName == "fs.write" and .payload.ok == true))' >/dev/null
grep -q 'needle from kernel' "$SMOKE_DIR/_agent_tmp_stage57.txt"
pass "fs.write goes through kernel syscall"

READ_BODY="$(jq -nc '{toolCall:{id:"read-smoke",name:"fs.read",arguments:{path:"_agent_tmp_stage57.txt"}}}')"
READ_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$READ_BODY" "$TOOL_EXECUTE_URL")"
echo "$READ_RESP" | jq -e '.ok == true and .data.ok == true and (.data.output.content | contains("needle from kernel"))' >/dev/null
pass "fs.read goes through kernel syscall"

SEARCH_BODY="$(jq -nc '{toolCall:{id:"search-smoke",name:"code.search",arguments:{query:"needle"}}}')"
SEARCH_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$SEARCH_BODY" "$TOOL_EXECUTE_URL")"
echo "$SEARCH_RESP" | jq -e '.ok == true and .data.ok == true and (.data.output.matches | length >= 1)' >/dev/null
pass "code.search goes through kernel syscall"

DIFF_BODY="$(jq -nc '{toolCall:{id:"diff-smoke",name:"fs.diff",arguments:{path:"_agent_tmp_stage57.txt",newContent:"needle changed\n"}}}')"
DIFF_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$DIFF_BODY" "$TOOL_EXECUTE_URL")"
echo "$DIFF_RESP" | jq -e '.ok == true and .data.ok == true and (.data.output.diff | contains("needle changed"))' >/dev/null
pass "fs.diff is projected through kernel read syscall"

DELETE_BODY="$(jq -nc '{toolCall:{id:"delete-smoke",name:"fs.delete",arguments:{path:"_agent_tmp_stage57.txt"}}}')"
DELETE_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$DELETE_BODY" "$TOOL_EXECUTE_URL")"
echo "$DELETE_RESP" | jq -e '.ok == true and .data.pendingPermission == true and .data.permission.capability == "cap.fs.delete"' >/dev/null
DELETE_PERMISSION_ID="$(echo "$DELETE_RESP" | jq -r '.data.permission.id')"
DELETE_RESOLVE_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"decision":"accept"}' \
  "http://127.0.0.1:${TEST_PORT}/api/agent/permissions/${DELETE_PERMISSION_ID}/resolve")"
echo "$DELETE_RESOLVE_RESP" | jq -e '.ok == true and (.data.events[] | select(.kind == "tool_result" and .payload.toolName == "fs.delete" and .payload.ok == true))' >/dev/null
test ! -e "$SMOKE_DIR/_agent_tmp_stage57.txt"
pass "fs.delete is hidden but available as controlled syscall"

TOOLS_RESP="$(curl -fsS -m 3 "$TOOLS_URL")"
echo "$TOOLS_RESP" | jq -e '.ok == true and ([.data.skills[].id] | index("fs.delete") != null)' >/dev/null
echo "$TOOLS_RESP" | jq -e '.data.skills[] | select(.id == "fs.delete") | .modelVisible == false' >/dev/null
pass "fs.delete exists but is not model-visible"

curl -fsS -m 3 "$RUNTIME_SHELL_URL" | jq -e '.ok == true and .data.agentUsesUnixCommands == true' >/dev/null
curl -fsS -m 3 "$TERMINAL_CAP_URL" | jq -e '.ok == true and .data.shell.managedBy == "deepcode-kernel"' >/dev/null
pass "runtime shell status is kernel-managed"

info "[5b/6] GUI compatibility API smoke"
curl -fsS -m 3 "$USER_SETTINGS_URL" \
  | jq -e '.ok == true and .data.settings["workbench.language"] == "zh-CN" and (.data.storePath | type == "string")' >/dev/null
curl -fsS -m 3 -X PATCH -H 'Content-Type: application/json' \
  -d '{"patches":{"workbench.language":"zh-CN"}}' "$USER_SETTINGS_URL" \
  | jq -e '.ok == true and (.data.changedKeys | index("workbench.language") != null)' >/dev/null
pass "user settings config API is wired"

curl -fsS -m 3 "$LLM_PROFILES_URL" \
  | jq -e '.ok == true and (.data.profiles | length >= 1) and (.data.defaultProfileId | type == "string")' >/dev/null
LLM_PATCH_RESP="$(curl -fsS -m 3 -X PATCH -H 'Content-Type: application/json' \
  -d '{"defaultProfileId":"profile-smoke","profiles":[{"id":"profile-smoke","name":"Smoke Profile","kind":"openaiCompatible","baseUrl":"https://api.deepseek.com","model":"deepseek-v4-pro","maxOutputTokens":384000.0,"enabled":true}],"secrets":{"profile-smoke":"sk-smoke-secret"}}' \
  "$LLM_PROFILES_URL")"
echo "$LLM_PATCH_RESP" | jq -e --arg config "$CONFIG_DIR" \
  '.ok == true and (.data.storePath | startswith($config + "/config/user/local/settings/")) and (.data.storePath | contains("/bin/") | not)' >/dev/null
echo "$LLM_PATCH_RESP" | jq -e '.data.profiles[0].secretRef == "local-secret:profile-smoke"' >/dev/null
test -f "$CONFIG_DIR/config/user/local/settings/llm-profiles.json"
test -f "$CONFIG_DIR/config/user/local/secrets/llm-secrets.json"
! grep -q 'sk-smoke-secret' "$CONFIG_DIR/config/user/local/settings/llm-profiles.json"
grep -q 'sk-smoke-secret' "$CONFIG_DIR/config/user/local/secrets/llm-secrets.json"
pass "LLM profile config API writes to user config and stores secretRef only in profiles"

curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"profileId":"profile-smoke"}' \
  "http://127.0.0.1:${TEST_PORT}/api/llm/probe" \
  | jq -e '.ok == true and .data.ok == true and .data.provider == "openaiCompatible"' >/dev/null
curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"profileId":"profile-smoke","messages":[{"role":"user","content":"ping"}]}' \
  "http://127.0.0.1:${TEST_PORT}/api/llm/chat" \
  | jq -e '.ok == true and (.data.assistantMessage.content | type == "string")' >/dev/null
pass "LLM probe/chat are wired through Rust Host provider layer"

SESSION_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d '{"initialMode":"plan"}' "$AGENT_SESSIONS_URL")"
SESSION_ID="$(echo "$SESSION_RESP" | jq -r '.data.session.id')"
test -n "$SESSION_ID"
echo "$SESSION_RESP" | jq -e '.ok == true and .data.session.mode == "plan"' >/dev/null
curl -fsS -m 3 "$AGENT_SESSIONS_URL" | jq -e --arg id "$SESSION_ID" '.ok == true and (.data.sessions[] | select(.id == $id))' >/dev/null
curl -fsS -m 3 "http://127.0.0.1:${TEST_PORT}/api/agent/sessions/current" | jq -e --arg id "$SESSION_ID" '.ok == true and .data.session.id == $id' >/dev/null
curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"events":[{"kind":"assistant_msg","payload":{"channel":"progress","content":"session store smoke"}}]}' \
  "${SESSION_STORE_URL}/${SESSION_ID}/projection" \
  | jq -e '.ok == true and .data.appended == 1' >/dev/null
curl -fsS -m 3 "${SESSION_STORE_URL}/${SESSION_ID}/projection" \
  | jq -e '.ok == true and (.data.events | length >= 1)' >/dev/null
curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"entry":{"type":"message","uuid":"transcript-smoke","sessionId":"'"$SESSION_ID"'","role":"user","channel":"user","content":"transcript smoke","kernelEventRefs":[],"visible":true,"createdAt":"smoke"}}' \
  "${SESSION_STORE_URL}/${SESSION_ID}/transcript" \
  | jq -e '.ok == true and .data.entryCount >= 1' >/dev/null
curl -fsS -m 3 "${SESSION_STORE_URL}/${SESSION_ID}/transcript" \
  | jq -e '.ok == true and (.data.entries[] | select(.uuid == "transcript-smoke"))' >/dev/null
curl -fsS -m 3 "${SESSION_STORE_URL}/index" \
  | jq -e '.ok == true and (.data.sessions | length >= 1)' >/dev/null
pass "Rust session storage API persists projection and transcript events"
AGENT_MESSAGE_BODY="$(jq -nc --arg openPath "$WORKSPACE_FILE" '{
  content: "这是一个测试请求，返回你的身份信息，然后测试当前agent所有的功能组件，能否新建临时文件读写这个临时文件然后删除这个临时文件",
  mode: "askBeforeWrite",
  workflow: "planFirst",
  profileId: "profile-smoke",
  workflowConfig: {
    plan: { profileId: "profile-smoke" },
    check: { profileId: "profile-smoke" },
    complete: { profileId: "profile-smoke" },
    review: { profileId: "profile-smoke" }
  },
  workspaceBinding: {
    workspaceId: "smoke-workspace",
    workspaceHash: "smoke-hash",
    openPath: $openPath,
    activeFolderId: "wf-0"
  }
}')"
AGENT_MESSAGE_RESP="$(curl -fsS -m 10 -H 'Content-Type: application/json' \
  -d "$AGENT_MESSAGE_BODY" \
  "http://127.0.0.1:${TEST_PORT}/api/agent/sessions/${SESSION_ID}/messages")"
echo "$AGENT_MESSAGE_RESP" | jq -e '.ok == true and (.data.events[] | select(.kind == "permission_request" and .payload.toolName == "fs.write"))' >/dev/null
PERMISSION_ID="$(echo "$AGENT_MESSAGE_RESP" | jq -r '.data.events[] | select(.kind == "permission_request" and .payload.toolName == "fs.write") | .payload.id' | tail -n 1)"
test -n "$PERMISSION_ID"
AGENT_RESUME_RESP="$(curl -fsS -m 10 -H 'Content-Type: application/json' \
  -d '{"decision":"accept"}' \
  "http://127.0.0.1:${TEST_PORT}/api/agent/permissions/${PERMISSION_ID}/resolve")"
echo "$AGENT_RESUME_RESP" | jq -e '.ok == true and (.data.events[] | select(.kind == "tool_result" and .payload.toolName == "fs.read" and .payload.ok == true))' >/dev/null
echo "$AGENT_RESUME_RESP" | jq -e '.ok == true and (.data.events[] | select(.kind == "tool_result" and .payload.toolName == "fs.delete" and .payload.ok == true))' >/dev/null
echo "$AGENT_RESUME_RESP" | jq -e '.ok == true and ([.data.events[] | select(.kind == "assistant_msg" and (.payload.channel == "final") and (.payload.content | contains("DeepCode Agent")))] | length == 1)' >/dev/null
test ! -e "$SMOKE_DIR/_agent_tmp_functional_test.txt"
curl -fsS -m 3 "http://127.0.0.1:${TEST_PORT}/api/agent/sessions/${SESSION_ID}/trace" \
  | jq -e '.ok == true and .data.trace.eventCount >= 1' >/dev/null
curl -fsS -m 3 "$AGENT_WORKFLOW_URL" | jq -e '.ok == true and .data.initialized == true and .data.config.plan != null' >/dev/null
pass "agent LLM workflow, permission resume, temp lifecycle, and final review are wired"

curl -fsS -m 3 "$BROWSER_STATUS_URL" \
  | jq -e '.ok == true and .data.capabilities.status == "available"' >/dev/null
curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"url":"http://127.0.0.1:31249/"}' \
  "http://127.0.0.1:${TEST_PORT}/api/browser/open" \
  | jq -e '.ok == true and .data.status == "running" and .data.diagnostics.lastAction == "open"' >/dev/null
curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"inspectState":"selecting"}' \
  "http://127.0.0.1:${TEST_PORT}/api/browser/inspect-mode" \
  | jq -e '.ok == true and .data.inspectState == "selecting"' >/dev/null
curl -fsS -m 3 "http://127.0.0.1:${TEST_PORT}/api/browser/panel-snapshot" \
  | jq -e '.ok == true and .data.snapshot != null' >/dev/null
pass "internal browser skeleton API is wired"

curl -fsS -m 3 "$TERMINAL_WARMUP_URL" | jq -e '.ok == true and .data.state == "ready"' >/dev/null
TERM_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d '{"name":"smoke"}' "$TERMINAL_SESSIONS_URL")"
TERM_ID="$(echo "$TERM_RESP" | jq -r '.data.id')"
test -n "$TERM_ID"
curl -fsS -m 3 -H 'Content-Type: application/json' \
  -d '{"data":"echo smoke\n"}' \
  "http://127.0.0.1:${TEST_PORT}/api/terminal/sessions/${TERM_ID}/input" \
  | jq -e --arg id "$TERM_ID" '.ok == true and .data.id == $id' >/dev/null
curl -fsS -m 3 "http://127.0.0.1:${TEST_PORT}/api/terminal/events?sessionId=${TERM_ID}" \
  | jq -e '.ok == true and (.data.events | length >= 2)' >/dev/null
pass "terminal compatibility API is wired"

curl -fsS -m 3 -X POST -H 'Content-Type: application/json' -d '{}' \
  "http://127.0.0.1:${TEST_PORT}/api/unknown/route" \
  | jq -e '.ok == false and .error == "api_not_implemented"' >/dev/null
pass "unimplemented /api routes return JSON instead of HTTP 405"

if [ "${DEEPCODE_SKIP_PACKAGING_SMOKE:-0}" = "1" ]; then
  info "[6/6] unified build smoke skipped by DEEPCODE_SKIP_PACKAGING_SMOKE=1"
  echo "============================================================"
  pass "DeepCode stage 5 closeout fast test passed"
  echo "============================================================"
  exit 0
fi

info "[6/6] unified build smoke"
./build.sh
test -x "$ROOT_DIR/bin/linux-x64/deepcode-kernel"
test -x "$ROOT_DIR/bin/linux-x64/deepcode-gui"
test -x "$ROOT_DIR/bin/linux-x64/deepcode-cli"
test -x "$ROOT_DIR/bin/linux-x64/deepcode-tui"
test -d "$ROOT_DIR/bin/linux-x64/web"
test -f "$ROOT_DIR/bin/win64/deepcode-kernel.exe"
test -f "$ROOT_DIR/bin/win64/deepcode-gui.bat"
test -f "$ROOT_DIR/bin/win64/deepcode-cli.bat"
test -f "$ROOT_DIR/bin/win64/deepcode-tui.bat"
test -d "$ROOT_DIR/bin/win64/web"
pass "bin/linux-x64 and bin/win64 distributions generated"

DEEPCODE_HOST=127.0.0.1 \
DEEPCODE_PORT="$PACKAGE_PORT" \
DEEPCODE_CLIENT_DIST="$ROOT_DIR/bin/linux-x64/web" \
DEEPCODE_CONFIG_DIR="$PACKAGE_CONFIG_DIR" \
DEEPCODE_LLM_MOCK=1 \
"$ROOT_DIR/bin/linux-x64/deepcode-kernel" >"$PACKAGE_LOG_FILE" 2>&1 &
echo $! > "$PACKAGE_PID_FILE"

package_ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null -m 1 "$PACKAGE_HEALTH_URL" 2>/dev/null; then
    package_ready=1
    break
  fi
  sleep 0.5
done

if [ "$package_ready" -ne 1 ]; then
  fail "packaged linux host did not become ready"
  tail -n 80 "$PACKAGE_LOG_FILE" || true
  exit 6
fi

curl -fsS -m 3 "$PACKAGE_URL/" | grep -q '<div id="root"'
curl -fsS -m 3 "$PACKAGE_HEALTH_URL" | jq -e '.ok == true and .data.service == "deepcode-host-web"' >/dev/null
pass "packaged linux GUI is served by Rust host for browser clients"

echo "============================================================"
pass "DeepCode stage 5 closeout test passed"
echo "============================================================"
