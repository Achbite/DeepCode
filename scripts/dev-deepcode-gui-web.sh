#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEEPCODE_HOST:-127.0.0.1}"
GUI_PORT="${DEEPCODE_GUI_DEV_PORT:-5174}"
HOST_PORT="${DEEPCODE_HOST_PORT:-31245}"
DAEMON_PORT="${DEEPCODE_DAEMON_PORT:-31246}"
CONFIG_SOURCE="${DEEPCODE_DEV_CONFIG_SOURCE:-}"
RUNTIME_ROOT="${DEEPCODE_DEV_CONFIG_ROOT:-}"
RUNTIME_ROOT_OWNED=0
DAEMON_PID=""
HOST_PID=""
VITE_PID=""

fail() {
  printf '[deepcode-gui-web][error] %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

port_is_free() {
  ! /usr/bin/nc -z "$HOST" "$1" >/dev/null 2>&1
}

stop_owned_process() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" >/dev/null 2>&1 || return 0
  kill -TERM "$pid" >/dev/null 2>&1 || true
  local attempt=0
  while kill -0 "$pid" >/dev/null 2>&1 && [ "$attempt" -lt 20 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
  done
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
  wait "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_owned_process "$VITE_PID"
  stop_owned_process "$HOST_PID"
  stop_owned_process "$DAEMON_PID"
  if [ "$RUNTIME_ROOT_OWNED" = "1" ] && [ -n "$RUNTIME_ROOT" ]; then
    case "$RUNTIME_ROOT" in
      "${TMPDIR:-/tmp}"/deepcode-gui-web.*) rm -rf -- "$RUNTIME_ROOT" ;;
      *) printf '[deepcode-gui-web][warning] 未清理非预期临时目录：%s\n' "$RUNTIME_ROOT" >&2 ;;
    esac
  fi
  exit "$status"
}

wait_for_health() {
  local pid="$1"
  local url="$2"
  local header_name="$3"
  local header_value="$4"
  local log_path="$5"
  local attempt=0
  while [ "$attempt" -lt 120 ]; do
    kill -0 "$pid" >/dev/null 2>&1 || {
      tail -n 40 "$log_path" >&2 || true
      return 1
    }
    if /usr/bin/curl --silent --show-error --fail \
      --header "$header_name: $header_value" \
      "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done
  tail -n 40 "$log_path" >&2 || true
  return 1
}

trap cleanup EXIT INT TERM

[ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ] || [ "$HOST" = "::1" ] \
  || fail "Web 开发 Host 只能监听 loopback"
valid_port "$GUI_PORT" || fail "DEEPCODE_GUI_DEV_PORT 必须是 1-65535 的整数"
valid_port "$HOST_PORT" || fail "DEEPCODE_HOST_PORT 必须是 1-65535 的整数"
valid_port "$DAEMON_PORT" || fail "DEEPCODE_DAEMON_PORT 必须是 1-65535 的整数"
[ "$GUI_PORT" != "$HOST_PORT" ] && [ "$GUI_PORT" != "$DAEMON_PORT" ] \
  && [ "$HOST_PORT" != "$DAEMON_PORT" ] || fail "GUI、Host 和 daemon 端口必须互不相同"

require_command node
require_command curl

if [ "${DEEPCODE_DEV_SKIP_BUILD:-0}" != "1" ]; then
  require_command pnpm
  require_command cargo
fi

for port in "$GUI_PORT" "$HOST_PORT" "$DAEMON_PORT"; do
  port_is_free "$port" || fail "端口已被占用：$HOST:$port"
done

if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/deepcode-gui-web.XXXXXX")"
  RUNTIME_ROOT_OWNED=1
else
  mkdir -p "$RUNTIME_ROOT"
  RUNTIME_ROOT="$(cd "$RUNTIME_ROOT" && pwd)"
fi
chmod 700 "$RUNTIME_ROOT"
mkdir -p "$RUNTIME_ROOT/logs"

if [ -n "$CONFIG_SOURCE" ]; then
  [ -d "$CONFIG_SOURCE/config/user/local" ] \
    || fail "DEEPCODE_DEV_CONFIG_SOURCE 不包含 config/user/local：$CONFIG_SOURCE"
  mkdir -p "$RUNTIME_ROOT/config/user/local"
  cp -R "$CONFIG_SOURCE/config/user/local/." "$RUNTIME_ROOT/config/user/local/"
fi

cd "$ROOT_DIR"
if [ "${DEEPCODE_DEV_SKIP_BUILD:-0}" != "1" ]; then
  pnpm --filter @deepcode/protocol build
  pnpm --filter @deepcode/session-core build
  cargo build -p deepcode-kernel-daemon -p deepcode-host-web
fi

DAEMON_BIN="$ROOT_DIR/target/debug/deepcode-kernel-daemon"
HOST_BIN="$ROOT_DIR/target/debug/deepcode-host-web"
SESSION_BRIDGE="$ROOT_DIR/userspace/session-core/dist/sessionServiceBridge.js"
VITE_BIN="$ROOT_DIR/userspace/gui/node_modules/vite/bin/vite.js"
NODE_BIN="$(command -v node)"
[ -x "$DAEMON_BIN" ] || fail "缺少 daemon：$DAEMON_BIN"
[ -x "$HOST_BIN" ] || fail "缺少 Host：$HOST_BIN"
[ -f "$SESSION_BRIDGE" ] || fail "缺少 Session bridge：$SESSION_BRIDGE"
[ -f "$VITE_BIN" ] || fail "缺少 Vite：$VITE_BIN"

random_hex() {
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
}

SHELL_TOKEN="dchost_$(random_hex)"
UI_TOKEN="dcui_$(random_hex)"
INSTANCE_ID="dcinstance_$(random_hex)"

env -u DEEPCODE_HOST_UI_TOKEN \
  DEEPCODE_HOST="$HOST" \
  DEEPCODE_PORT="$DAEMON_PORT" \
  DEEPCODE_CONFIG_DIR="$RUNTIME_ROOT" \
  DEEPCODE_SESSION_BRIDGE="$SESSION_BRIDGE" \
  DEEPCODE_NODE="$NODE_BIN" \
  DEEPCODE_HOST_SHELL_TOKEN="$SHELL_TOKEN" \
  DEEPCODE_HOST_INSTANCE_ID="$INSTANCE_ID" \
  "$DAEMON_BIN" >"$RUNTIME_ROOT/logs/daemon.log" 2>&1 &
DAEMON_PID=$!
wait_for_health \
  "$DAEMON_PID" \
  "http://$HOST:$DAEMON_PORT/api/health" \
  "x-deepcode-host-shell-token" \
  "$SHELL_TOKEN" \
  "$RUNTIME_ROOT/logs/daemon.log" \
  || fail "Kernel daemon 启动失败"

env \
  DEEPCODE_HOST="$HOST" \
  DEEPCODE_PORT="$HOST_PORT" \
  DEEPCODE_DAEMON_HOST="$HOST" \
  DEEPCODE_DAEMON_PORT="$DAEMON_PORT" \
  DEEPCODE_HOST_WEB_SPAWN_DAEMON=0 \
  DEEPCODE_HOST_UI_TOKEN="$UI_TOKEN" \
  DEEPCODE_HOST_SHELL_TOKEN="$SHELL_TOKEN" \
  DEEPCODE_HOST_INSTANCE_ID="$INSTANCE_ID" \
  "$HOST_BIN" >"$RUNTIME_ROOT/logs/host-web.log" 2>&1 &
HOST_PID=$!
wait_for_health \
  "$HOST_PID" \
  "http://$HOST:$HOST_PORT/api/health" \
  "x-deepcode-host-ui-token" \
  "$UI_TOKEN" \
  "$RUNTIME_ROOT/logs/host-web.log" \
  || fail "Host Web 启动失败"

(
  cd "$ROOT_DIR/userspace/gui"
  exec env \
    DEEPCODE_HOST="$HOST" \
    DEEPCODE_HOST_PORT="$HOST_PORT" \
    DEEPCODE_GUI_DEV_PORT="$GUI_PORT" \
    DEEPCODE_HOST_UI_TOKEN="$UI_TOKEN" \
    "$NODE_BIN" "$VITE_BIN" --config vite.deepcode-gui.config.ts
) >"$RUNTIME_ROOT/logs/vite.log" 2>&1 &
VITE_PID=$!

attempt=0
while [ "$attempt" -lt 120 ]; do
  kill -0 "$VITE_PID" >/dev/null 2>&1 || {
    tail -n 40 "$RUNTIME_ROOT/logs/vite.log" >&2 || true
    fail "Vite 启动失败"
  }
  if /usr/bin/curl --silent --show-error --fail "http://$HOST:$GUI_PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
  attempt=$((attempt + 1))
done
[ "$attempt" -lt 120 ] || {
  tail -n 40 "$RUNTIME_ROOT/logs/vite.log" >&2 || true
  fail "Vite 启动超时"
}

printf '[deepcode-gui-web] 同源 GUI 已启动：http://%s:%s/\n' "$HOST" "$GUI_PORT"
printf '[deepcode-gui-web] runtime：%s\n' "$RUNTIME_ROOT"
printf '[deepcode-gui-web] PIDs：daemon=%s host=%s vite=%s\n' "$DAEMON_PID" "$HOST_PID" "$VITE_PID"
printf '[deepcode-gui-web] Ctrl+C 将只停止上述进程并清理本次临时 runtime。\n'

while kill -0 "$DAEMON_PID" >/dev/null 2>&1 \
  && kill -0 "$HOST_PID" >/dev/null 2>&1 \
  && kill -0 "$VITE_PID" >/dev/null 2>&1; do
  sleep 1
done
fail "开发拓扑中的进程提前退出；日志位于 $RUNTIME_ROOT/logs"
