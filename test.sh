#!/usr/bin/env bash
# ====================================================================
# DeepCode 容器内链路测试脚本（根目录版本，进容器后直接 ./test.sh）
# 职责：
#   1. 环境检查：rust / node / pnpm / pkg / mingw / 网络
#   2. 协议包构建：生成 @deepcode/protocol dist 类型
#   3. 静态检查：本阶段相关 protocol + server typecheck（不强依赖前端 Monaco 环境）
#   4. 链路 ping：启动 server → 探测 /api/health → 关闭
#   5. 关键工作区接口烟雾测试：默认空工作区 + 主动打开工作区
#   6. 阶段 6T 自动测试：Agent action parser、fixture runner、权限状态
# 设计要点：
#   - 不长时间挂起，整体目标 < 60s
#   - 任一关键阶段失败立即非零退出，便于 CI 接入
#   - 临时输出统一写入 /tmp/_deepcode_test_*，结束自清理
# ====================================================================
set -euo pipefail

# ---- PATH 防御性 export ----
# Dockerfile.dev 已设 ENV PATH，但 bash -lc / login shell 会被 /etc/profile.d/*.sh 重置 PATH，
# 导致脚本中 rustc / cargo / pnpm / pkg 可能找不到。这里显式拼接必要路径。
export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# 默认端口与 health 路径与 server/src/services/configService.ts、healthRoutes.ts 对齐
TEST_PORT="${DEEPCODE_TEST_PORT:-31246}"
HEALTH_URL="http://127.0.0.1:${TEST_PORT}/api/health"
WS_URL="http://127.0.0.1:${TEST_PORT}/api/workspaces/current"
OPEN_WS_URL="http://127.0.0.1:${TEST_PORT}/api/workspaces/open"
RUNTIME_SHELL_URL="http://127.0.0.1:${TEST_PORT}/api/runtime/shell"
TERMINAL_CAP_URL="http://127.0.0.1:${TEST_PORT}/api/terminal/capabilities"
TERMINAL_SESSIONS_URL="http://127.0.0.1:${TEST_PORT}/api/terminal/sessions"
TERMINAL_EVENTS_URL="http://127.0.0.1:${TEST_PORT}/api/terminal/events"
AGENT_PARSE_URL="http://127.0.0.1:${TEST_PORT}/api/agent/parse-actions"
AGENT_FIXTURE_URL="http://127.0.0.1:${TEST_PORT}/api/agent/fixtures/run"
AGENT_PROMPT_LAYERS_URL="http://127.0.0.1:${TEST_PORT}/api/agent/prompt-layers"
AGENT_SKILLS_URL="http://127.0.0.1:${TEST_PORT}/api/agent/skills"
LOG_FILE="/tmp/_deepcode_server_$$.log"
PID_FILE="/tmp/_deepcode_server_$$.pid"

pass() { echo -e "\033[32m[PASS]\033[0m $*"; }
fail() { echo -e "\033[31m[FAIL]\033[0m $*"; }
info() { echo -e "\033[36m[INFO]\033[0m $*"; }

is_wsl() {
    grep -qi microsoft /proc/version 2>/dev/null || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null
}

require_tool() {
    local tool="$1"
    local hint="$2"
    if command -v "$tool" >/dev/null 2>&1; then
        "$tool" --version
        return 0
    fi
    fail "$tool 未安装"
    if is_wsl; then
        info "当前运行在 WSL；请在 WSL 发行版内安装 $tool，或进入已配置 Node/pnpm/Rust 的 deepcode-dev 容器后执行 ./test.sh。"
        if [ -n "$hint" ]; then
            info "建议：$hint"
        fi
    fi
    return 1
}

cleanup() {
    if [ -f "$PID_FILE" ]; then
        local pid; pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            info "stopping server pid=$pid"
            kill "$pid" 2>/dev/null || true
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi
    rm -f "$LOG_FILE"
}
trap cleanup EXIT

echo "============================================================"
echo " DeepCode link-test  ($(date -Is))"
echo " ROOT_DIR=$ROOT_DIR"
echo " TEST_PORT=$TEST_PORT"
echo "============================================================"

# ---- 1. 环境检查 ----
info "[1/6] tooling versions"
require_tool rustc "使用 rustup 安装 Rust toolchain。" || exit 1
require_tool cargo "使用 rustup 安装 Rust toolchain。" || exit 1
require_tool node "安装 Node.js 20+，例如通过 nvm 安装并启用 LTS/Current 版本。" || exit 1
require_tool pnpm "执行 corepack enable && corepack prepare pnpm@latest --activate。" || exit 1
command -v pkg >/dev/null && pkg --version || info "pkg 未就绪（不影响本测试）"
command -v x86_64-w64-mingw32-gcc >/dev/null \
    && info "mingw-w64: $(x86_64-w64-mingw32-gcc --version | head -n1)" \
    || info "mingw-w64 未就绪（不影响本测试）"
pass "tooling ok"

# ---- 2. 协议包构建 ----
info "[2/6] pnpm --filter @deepcode/protocol build && pnpm --filter @deepcode/agent-core build"
if pnpm --filter @deepcode/protocol build && pnpm --filter @deepcode/agent-core build; then
    pass "protocol/agent-core build ok"
else
    fail "protocol/agent-core build 失败"; exit 2
fi

# ---- 3. 静态类型检查 ----
info "[3/6] protocol + agent-core + server typecheck"
if pnpm --filter @deepcode/protocol typecheck && pnpm --filter @deepcode/agent-core typecheck && pnpm --filter @deepcode/server typecheck; then
    pass "protocol/agent-core/server typecheck ok"
else
    fail "typecheck 失败"; exit 3
fi

# ---- 4. 启动 server 并 ping ----
info "[4/6] start server on port $TEST_PORT"
# 优先用已构建产物（dist/index.js）；不存在则用 tsx 直跑源码
SERVER_ENTRY=""
if [ -f "$ROOT_DIR/server/dist/index.js" ]; then
    SERVER_ENTRY="node $ROOT_DIR/server/dist/index.js"
else
    info "server/dist 不存在，使用 tsx 直跑源码"
    SERVER_ENTRY="pnpm --filter @deepcode/server exec tsx $ROOT_DIR/server/src/index.ts"
fi

DEEPCODE_PORT="$TEST_PORT" \
DEEPCODE_HOST="127.0.0.1" \
DEEPCODE_WORKSPACE="" \
    bash -c "$SERVER_ENTRY" >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# 轮询等待健康端口就绪（最多 20s）
# 双重重定向抓走 stderr，避免首次连接未就绪时 "Couldn't connect" 误导性输出
ready=0
for i in $(seq 1 40); do
    if curl -fsS -o /dev/null -m 1 "$HEALTH_URL" 2>/dev/null; then
        ready=1; break
    fi
    sleep 0.5
done

if [ "$ready" -ne 1 ]; then
    fail "server 启动失败 / health 端点不通；最后 30 行日志："
    tail -n 30 "$LOG_FILE" || true
    exit 4
fi
pass "server up, health endpoint reachable"

# 抓取 health & workspace 响应
HEALTH_BODY="$(curl -fsS -m 2 "$HEALTH_URL" || true)"
WS_BODY="$(curl -fsS -m 2 "$WS_URL" || true)"
info "health  -> $HEALTH_BODY"
info "current -> $WS_BODY"

# ---- 5. 关键接口字段烟雾断言 ----
info "[5/6] smoke assertions"
echo "$HEALTH_BODY" | jq -e '.ok == true' >/dev/null 2>&1 \
    && pass "/api/health 返回 ok=true" \
    || { fail "/api/health 字段断言失败"; exit 5; }

# 默认应为空工作区；后续测试再主动打开 ROOT_DIR。
echo "$WS_BODY" | jq -e '
    .ok == true
    and (.data.current == null)
    and (.data.fallbackUsed | type == "boolean")
' >/dev/null 2>&1 \
    && pass "/api/workspaces/current 默认空工作区结构正确" \
    || { fail "/api/workspaces/current 默认空工作区断言失败"; exit 6; }

OPEN_BODY="$(jq -nc --arg path "$ROOT_DIR" '{path: $path}')"
OPEN_WS_BODY="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$OPEN_BODY" "$OPEN_WS_URL" || true)"
info "open workspace -> $OPEN_WS_BODY"
echo "$OPEN_WS_BODY" | jq -e '
    .ok == true
    and (.data.workspace.name | type == "string")
    and (.data.workspace.id | type == "string")
    and (.data.workspace.folders[0].id | type == "string")
' >/dev/null 2>&1 \
    && pass "/api/workspaces/open 可打开项目根目录" \
    || { fail "/api/workspaces/open 字段断言失败"; exit 7; }

# ---- 6. 阶段 6T Agent 行为格式化脚本测试 ----
info "[6/6] stage 6T Agent action fixture assertions"

SHELL_BODY="$(curl -fsS -m 3 "$RUNTIME_SHELL_URL" || true)"
info "runtime shell -> $SHELL_BODY"
echo "$SHELL_BODY" | jq -e '
    .ok == true
    and (.data.os | type == "string")
    and (.data.preferredShell | type == "string")
    and (.data.problems | type == "array")
' >/dev/null 2>&1 \
    && pass "/api/runtime/shell 返回结构正确" \
    || { fail "/api/runtime/shell 字段断言失败"; exit 8; }

TERMINAL_CAP_BODY="$(curl -fsS -m 3 "$TERMINAL_CAP_URL" || true)"
info "terminal capabilities -> $TERMINAL_CAP_BODY"
echo "$TERMINAL_CAP_BODY" | jq -e '
    .ok == true
    and (.data.defaultShell | type == "string")
    and (.data.agentUsesUnixCommands == true)
    and (.data.shell | type == "object")
' >/dev/null 2>&1 \
    && pass "/api/terminal/capabilities 返回结构正确" \
    || { fail "/api/terminal/capabilities 字段断言失败"; exit 9; }

run_agent_fixture() {
    local fixture="$1"
    local mode="${2:-plan}"
    local execute="${3:-true}"
    local jq_assert="$4"
    local label="$5"
    local timeout="${6:-5}"
    local body
    local response

    body="$(jq -Rs --arg mode "$mode" --argjson execute "$execute" '{content: ., mode: $mode, execute: $execute}' < "$ROOT_DIR/fixtures/agent-actions/$fixture")"
    response="$(curl -fsS -m "$timeout" -H 'Content-Type: application/json' -d "$body" "$AGENT_FIXTURE_URL" || true)"
    info "$label -> $response"
    echo "$response" | jq -e "$jq_assert" >/dev/null 2>&1 \
        && pass "$label" \
        || { fail "$label 断言失败"; exit "$NEXT_FAIL_CODE"; }
    NEXT_FAIL_CODE=$((NEXT_FAIL_CODE + 1))
}

parse_agent_fixture() {
    local fixture="$1"
    local jq_assert="$2"
    local label="$3"
    local body
    local response

    body="$(jq -Rs '{content: ., mode: "plan"}' < "$ROOT_DIR/fixtures/agent-actions/$fixture")"
    response="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$body" "$AGENT_PARSE_URL" || true)"
    info "$label -> $response"
    echo "$response" | jq -e "$jq_assert" >/dev/null 2>&1 \
        && pass "$label" \
        || { fail "$label 断言失败"; exit "$NEXT_FAIL_CODE"; }
    NEXT_FAIL_CODE=$((NEXT_FAIL_CODE + 1))
}

NEXT_FAIL_CODE=10

parse_agent_fixture "001-read-search.deepcode.md" '
    .ok == true
    and (.data.actions | length >= 3)
    and ([.data.actions[].type] | index("fs.read") != null)
    and ([.data.actions[].type] | index("code.search") != null)
' "001 read/search 标签格式解析通过"

run_agent_fixture "001-read-search.deepcode.md" "plan" "true" '
    .ok == true
    and ([.data.observations[].toolName] | index("fs.read") != null)
    and ([.data.observations[].toolName] | index("code.search") != null)
    and ([.data.observations[] | select(.toolName == "fs.read") | .status] | index("ok") != null)
    and ([.data.observations[] | select(.toolName == "code.search") | .status] | index("ok") != null)
' "001 Agent read/search fixture 可执行"

run_agent_fixture "002-shell-propose.deepcode.md" "plan" "true" '
    .ok == true
    and ([.data.observations[].toolName] | index("shell.propose") != null)
    and ([.data.observations[].output.dryRun?] | index(true) != null)
    and ([.data.observations[].output.executed?] | index(false) != null)
' "002 shell.propose fixture 只生成建议不执行"

README_HASH_BEFORE="$(sha256sum "$ROOT_DIR/README.md" 2>/dev/null | awk '{print $1}' || echo missing)"
run_agent_fixture "003-patch-plan.deepcode.md" "plan" "true" '
    .ok == true
    and ([.data.observations[].toolName] | index("patch.plan") != null)
    and ([.data.observations[].status] | index("needsApproval") != null)
' "003 patch.plan fixture 进入审批状态"
README_HASH_AFTER="$(sha256sum "$ROOT_DIR/README.md" 2>/dev/null | awk '{print $1}' || echo missing)"
[ "$README_HASH_BEFORE" = "$README_HASH_AFTER" ] \
    && pass "patch.plan 未写盘" \
    || { fail "patch.plan 修改了 README.md"; exit "$NEXT_FAIL_CODE"; }
NEXT_FAIL_CODE=$((NEXT_FAIL_CODE + 1))

run_agent_fixture "004-invalid-action.deepcode.md" "plan" "true" '
    .ok == true
    and ([.data.observations[].status] | index("error") != null)
' "004 invalid fixture 被结构化拒绝"

parse_agent_fixture "005-skill-ruler-context.deepcode.md" '
    .ok == true
    and ([.data.actions[].type] == ["fs.list", "final"])
' "005 skill/ruler context fixture 解析 fs.list/final"

run_agent_fixture "005-skill-ruler-context.deepcode.md" "plan" "true" '
    .ok == true
    and ([.data.observations[].toolName] == ["fs.list", "final"])
    and ([.data.observations[].status] == ["ok", "ok"])
' "005 skill/ruler context fixture 可执行"

run_agent_fixture "006-agent-mini-loop.deepcode.md" "plan" "true" '
    .ok == true
    and ([.data.parse.actions[].type] == ["fs.read", "code.search", "shell.propose", "patch.plan", "final"])
    and ([.data.observations[].toolName] == ["fs.read", "code.search", "shell.propose", "patch.plan", "final"])
    and ([.data.observations[].status] == ["ok", "ok", "ok", "needsApproval", "ok"])
    and (.data.observations[2].output.executed == false)
' "006 Agent mini loop 顺序与状态正确"

run_agent_fixture "002-shell-propose.deepcode.md" "readOnly" "true" '
    .ok == true
    and ([.data.observations[].toolName] | index("shell.propose") != null)
    and ([.data.observations[].status] | index("blocked") != null)
' "readOnly 模式阻止 shell.propose"

PACKAGE_HASH_BEFORE="$(sha256sum "$ROOT_DIR/package.json" | awk '{print $1}')"
WRITE_FIXTURE_CONTENT='<final>write permission test</final>
```deepcode-action
{
  "version": 1,
  "mode": "askBeforeWrite",
  "actions": [
    {
      "type": "fs.write",
      "path": "package.json",
      "content": "changed\n"
    }
  ]
}
```'
WRITE_FIXTURE_BODY="$(jq -nc --arg content "$WRITE_FIXTURE_CONTENT" '{content: $content, mode: "askBeforeWrite", execute: true}')"
WRITE_FIXTURE_RESP="$(curl -fsS -m 3 -H 'Content-Type: application/json' -d "$WRITE_FIXTURE_BODY" "$AGENT_FIXTURE_URL" || true)"
info "askBeforeWrite unapproved write -> $WRITE_FIXTURE_RESP"
echo "$WRITE_FIXTURE_RESP" | jq -e '
    .ok == true
    and ([.data.observations[].toolName] | index("fs.write") != null)
    and ([.data.observations[].status] | index("needsApproval") != null)
' >/dev/null 2>&1 \
    && pass "askBeforeWrite 未审批 fs.write 进入 needsApproval" \
    || { fail "askBeforeWrite fs.write 断言失败"; exit "$NEXT_FAIL_CODE"; }
NEXT_FAIL_CODE=$((NEXT_FAIL_CODE + 1))
PACKAGE_HASH_AFTER="$(sha256sum "$ROOT_DIR/package.json" | awk '{print $1}')"
[ "$PACKAGE_HASH_BEFORE" = "$PACKAGE_HASH_AFTER" ] \
    && pass "askBeforeWrite 未审批 fs.write 未写盘" \
    || { fail "askBeforeWrite 未审批 fs.write 修改了文件"; exit "$NEXT_FAIL_CODE"; }
NEXT_FAIL_CODE=$((NEXT_FAIL_CODE + 1))

SESSIONS_BEFORE="$(curl -fsS -m 3 "$TERMINAL_SESSIONS_URL" || true)"
run_agent_fixture "007-shell-exec.deepcode.md" "plan" "true" '
    .ok == true
    and ([.data.observations[].toolName] | index("shell.exec") != null)
    and ([.data.observations[].status] | index("blocked") != null)
' "plan 模式阻止 shell.exec"

run_agent_fixture "007-shell-exec.deepcode.md" "askBeforeWrite" "true" '
    .ok == true
    and ([.data.observations[].toolName] | index("shell.exec") != null)
    and ([.data.observations[].status] | index("needsApproval") != null)
' "askBeforeWrite 未审批 shell.exec 进入 needsApproval"

SHELL_EXEC_APPROVED_BODY="$(jq -Rs '{content: ., mode: "askBeforeWrite", execute: true, approveAll: true}' < "$ROOT_DIR/fixtures/agent-actions/007-shell-exec.deepcode.md")"
SHELL_EXEC_APPROVED_RESP="$(curl -fsS -m 10 -H 'Content-Type: application/json' -d "$SHELL_EXEC_APPROVED_BODY" "$AGENT_FIXTURE_URL" || true)"
info "approved shell.exec -> $SHELL_EXEC_APPROVED_RESP"
echo "$SHELL_EXEC_APPROVED_RESP" | jq -e '
    .ok == true
    and ([.data.observations[].toolName] | index("shell.exec") != null)
    and ([.data.observations[].status] | index("ok") != null)
    and ([.data.observations[].output.executed?] | index(true) != null)
    and ([.data.observations[].output.stdout? | strings] | map(contains("deepcode-agent-shell")) | index(true) != null)
    and ([.data.observations[].output.cleanupStatus? | strings] | length >= 1)
' >/dev/null 2>&1 \
    && pass "askBeforeWrite 已审批 shell.exec 使用 Agent 临时 shell 执行并清理" \
    || { fail "askBeforeWrite 已审批 shell.exec 断言失败"; exit "$NEXT_FAIL_CODE"; }
NEXT_FAIL_CODE=$((NEXT_FAIL_CODE + 1))

SESSIONS_AFTER="$(curl -fsS -m 3 "$TERMINAL_SESSIONS_URL" || true)"
BEFORE_COUNT="$(echo "$SESSIONS_BEFORE" | jq '.data.sessions | length' 2>/dev/null || echo -1)"
AFTER_COUNT="$(echo "$SESSIONS_AFTER" | jq '.data.sessions | length' 2>/dev/null || echo -2)"
[ "$BEFORE_COUNT" = "$AFTER_COUNT" ] \
    && pass "Agent 临时 shell 未污染用户终端 session 列表" \
    || { fail "Agent shell 修改了用户终端 session 数量 before=$BEFORE_COUNT after=$AFTER_COUNT"; exit "$NEXT_FAIL_CODE"; }
NEXT_FAIL_CODE=$((NEXT_FAIL_CODE + 1))

PROMPT_LAYERS_BODY="$(curl -fsS -m 3 "$AGENT_PROMPT_LAYERS_URL" || true)"
SKILLS_BODY="$(curl -fsS -m 3 "$AGENT_SKILLS_URL" || true)"
info "prompt layers -> $PROMPT_LAYERS_BODY"
info "skills -> $SKILLS_BODY"
echo "$PROMPT_LAYERS_BODY" | jq -e '.ok == true and (.data.layers | type == "array") and (.data.layers | length >= 1)' >/dev/null 2>&1 \
    && pass "prompt layers 接口可用" \
    || { fail "prompt layers 断言失败"; exit 18; }
echo "$SKILLS_BODY" | jq -e '.ok == true and (.data.skills | type == "array")' >/dev/null 2>&1 \
    && pass "skills 接口可用" \
    || { fail "skills 断言失败"; exit 19; }

echo ""
echo "============================================================"
pass "ALL CHECKS PASSED"
echo "============================================================"
