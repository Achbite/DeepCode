#!/usr/bin/env bash
# ====================================================================
# DeepCode 容器内链路测试脚本（根目录版本，进容器后直接 ./test.sh）
# 职责：
#   1. 环境检查：rust / node / pnpm / pkg / mingw / 网络
#   2. 静态检查：pnpm typecheck（不强依赖 lint）
#   3. 链路 ping：启动 server → 探测 /api/health → 关闭
#   4. 关键工作区接口烟雾测试：/api/workspaces/current
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
LOG_FILE="/tmp/_deepcode_server_$$.log"
PID_FILE="/tmp/_deepcode_server_$$.pid"

pass() { echo -e "\033[32m[PASS]\033[0m $*"; }
fail() { echo -e "\033[31m[FAIL]\033[0m $*"; }
info() { echo -e "\033[36m[INFO]\033[0m $*"; }

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
info "[1/4] tooling versions"
rustc --version || { fail "rustc 未安装"; exit 1; }
cargo --version || { fail "cargo 未安装"; exit 1; }
node --version  || { fail "node 未安装";  exit 1; }
pnpm --version  || { fail "pnpm 未安装";  exit 1; }
command -v pkg >/dev/null && pkg --version || info "pkg 未就绪（不影响本测试）"
command -v x86_64-w64-mingw32-gcc >/dev/null \
    && info "mingw-w64: $(x86_64-w64-mingw32-gcc --version | head -n1)" \
    || info "mingw-w64 未就绪（不影响本测试）"
pass "tooling ok"

# ---- 2. 静态类型检查 ----
info "[2/4] pnpm -r typecheck"
if pnpm -r --if-present typecheck; then
    pass "typecheck ok"
else
    fail "typecheck 失败"; exit 2
fi

# ---- 3. 启动 server 并 ping ----
info "[3/4] start server on port $TEST_PORT"
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
    exit 3
fi
pass "server up, health endpoint reachable"

# 抓取 health & workspace 响应
HEALTH_BODY="$(curl -fsS -m 2 "$HEALTH_URL" || true)"
WS_BODY="$(curl -fsS -m 2 "$WS_URL" || true)"
info "health  -> $HEALTH_BODY"
info "current -> $WS_BODY"

# ---- 4. 关键接口字段烟雾断言 ----
info "[4/4] smoke assertions"
echo "$HEALTH_BODY" | jq -e '.ok == true' >/dev/null 2>&1 \
    && pass "/api/health 返回 ok=true" \
    || { fail "/api/health 字段断言失败"; exit 4; }

# WorkspaceState 结构（全量字段来自 protocol/workspace.ts）：
#   data.current   = WorkspaceSpec   { id, name, source, folders[], ... }
#   data.fallbackUsed: boolean
#   data.lastError:    string | null
# 烟雾断言需覆盖关键字段： current.name、current.id、folders[0].id 与 fallbackUsed 存在
echo "$WS_BODY" | jq -e '
    .ok == true
    and (.data.current.name | type == "string")
    and (.data.current.id   | type == "string")
    and (.data.current.folders[0].id | type == "string")
    and (.data.fallbackUsed | type == "boolean")
' >/dev/null 2>&1 \
    && pass "/api/workspaces/current 返回结构正确" \
    || { fail "/api/workspaces/current 字段断言失败"; exit 5; }

echo ""
echo "============================================================"
pass "ALL CHECKS PASSED"
echo "============================================================"
