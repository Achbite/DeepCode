#!/usr/bin/env bash
# Host-side macOS package worker for Docker-driven builds.
#
# The Docker dev container cannot produce Darwin .app bundles directly. This
# service lets build.sh submit a file-backed package request from the container,
# while the macOS host performs the actual scripts/package-macos.sh build.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="${DEEPCODE_MACOS_PACKAGE_SERVICE_DIR:-$ROOT_DIR/.build-cache/macos-package-service}"
REQUEST_DIR="$SERVICE_DIR/requests"
STATUS_DIR="$SERVICE_DIR/status"
LOG_DIR="$SERVICE_DIR/logs"
RUN_DIR="$SERVICE_DIR/run"
PID_FILE="$RUN_DIR/service.pid"
SERVICE_STATUS_FILE="$RUN_DIR/service.status"
SERVICE_LOG="$LOG_DIR/service.log"
SCREEN_SESSION="deepcode_macos_package_$(printf '%s' "$ROOT_DIR" | cksum | awk '{ print $1 }')"
SCREEN_RUNNER="$RUN_DIR/screen-runner.sh"
POLL_INTERVAL_SECONDS="${DEEPCODE_MACOS_PACKAGE_SERVICE_POLL_SECONDS:-2}"
STALE_SECONDS="${DEEPCODE_MACOS_PACKAGE_SERVICE_STALE_SECONDS:-30}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/macos-package-service.sh start
  scripts/macos-package-service.sh run
  scripts/macos-package-service.sh stop
  scripts/macos-package-service.sh status [--quiet]
  scripts/macos-package-service.sh submit [--product DeepCode|DeepCode-GUI] [--clean] [--refresh-gui-dist] [--wait] [--timeout-seconds N]

Commands:
  start   Start the macOS host package worker in the background.
  run     Run the package worker in the foreground.
  stop    Stop the background worker.
  status  Report whether the worker process is alive.
  submit  Queue one package request. This command can run inside Docker.
USAGE
}

log() {
  printf '==[macos-package-service]== %s\n' "$*"
}

fail() {
  printf '==[macos-package-service][error]== %s\n' "$*" >&2
  exit 1
}

ensure_dirs() {
  mkdir -p "$REQUEST_DIR" "$STATUS_DIR" "$LOG_DIR" "$RUN_DIR"
}

is_pid_alive() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

service_pid() {
  [ -f "$PID_FILE" ] || return 1
  tr -d '[:space:]' <"$PID_FILE"
}

ensure_macos_host() {
  [ "$(uname -s)" = "Darwin" ] || fail "macOS package service must run on the macOS host."
}

status_cmd() {
  local quiet=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --quiet)
        quiet=1
        shift
        ;;
      *)
        fail "unknown status argument: $1"
        ;;
    esac
  done

  local pid heartbeat_epoch now age
  pid="$(service_pid 2>/dev/null || true)"
  if is_pid_alive "$pid"; then
    [ "$quiet" = "1" ] || log "running pid=$pid dir=$SERVICE_DIR"
    return 0
  fi
  heartbeat_epoch="$(awk -F= '$1 == "updated_at_epoch" { print $2; exit }' "$SERVICE_STATUS_FILE" 2>/dev/null || true)"
  if [ -n "$heartbeat_epoch" ]; then
    now="$(date +%s)"
    age=$((now - heartbeat_epoch))
    if [ "$age" -le "$STALE_SECONDS" ]; then
      [ "$quiet" = "1" ] || log "running heartbeat_age=${age}s dir=$SERVICE_DIR"
      return 0
    fi
  fi
  [ "$quiet" = "1" ] || log "stopped dir=$SERVICE_DIR"
  return 1
}

start_cmd() {
  ensure_macos_host
  ensure_dirs
  command -v screen >/dev/null 2>&1 || fail "screen is required to start the detached macOS package service."

  local pid
  pid="$(service_pid 2>/dev/null || true)"
  if is_pid_alive "$pid"; then
    log "already running pid=$pid"
    return 0
  fi

  screen -S "$SCREEN_SESSION" -X quit >/dev/null 2>&1 || true
  {
    printf '#!/usr/bin/env bash\n'
    printf 'cd %q\n' "$ROOT_DIR"
    printf 'exec bash %q run >>%q 2>&1\n' "$ROOT_DIR/scripts/macos-package-service.sh" "$SERVICE_LOG"
  } >"$SCREEN_RUNNER.tmp"
  mv "$SCREEN_RUNNER.tmp" "$SCREEN_RUNNER"
  chmod +x "$SCREEN_RUNNER"

  screen -dmS "$SCREEN_SESSION" bash "$SCREEN_RUNNER"

  local deadline
  deadline=$(( $(date +%s) + 10 ))
  while true; do
    pid="$(service_pid 2>/dev/null || true)"
    if is_pid_alive "$pid"; then
      log "started pid=$pid screen=$SCREEN_SESSION log=$SERVICE_LOG"
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 1
  done
  fail "screen service did not become ready; log=$SERVICE_LOG"
}

stop_cmd() {
  ensure_dirs
  local pid
  pid="$(service_pid 2>/dev/null || true)"
  if command -v screen >/dev/null 2>&1; then
    screen -S "$SCREEN_SESSION" -X quit >/dev/null 2>&1 || true
  fi
  if is_pid_alive "$pid"; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
  rm -f "$SERVICE_STATUS_FILE"
  log "stopped pid=${pid:-unknown}"
}

write_status() {
  local request_id="$1"
  local state="$2"
  local log_path="$3"
  local message="${4:-}"
  local status_path="$STATUS_DIR/$request_id.status"

  {
    printf 'request_id=%s\n' "$request_id"
    printf 'state=%s\n' "$state"
    printf 'log_path=%s\n' "$log_path"
    printf 'updated_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    if [ -n "$message" ]; then
      printf 'message=%s\n' "$message"
    fi
  } >"$status_path.tmp"
  mv "$status_path.tmp" "$status_path"
}

write_service_heartbeat() {
  {
    printf 'pid=%s\n' "$$"
    printf 'state=running\n'
    printf 'updated_at_epoch=%s\n' "$(date +%s)"
    printf 'updated_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$SERVICE_STATUS_FILE.tmp"
  mv "$SERVICE_STATUS_FILE.tmp" "$SERVICE_STATUS_FILE"
}

parse_status_state() {
  local status_path="$1"
  awk -F= '$1 == "state" { print $2; exit }' "$status_path" 2>/dev/null || true
}

parse_status_log_path() {
  local status_path="$1"
  awk -F= '$1 == "log_path" { print substr($0, index($0, $2)); exit }' "$status_path" 2>/dev/null || true
}

read_request_value() {
  local request_path="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, $2)); exit }' "$request_path"
}

validate_product() {
  case "$1" in
    DeepCode|DeepCode-GUI) ;;
    *) fail "invalid product: $1" ;;
  esac
}

validate_bool() {
  case "$1" in
    0|1) ;;
    *) fail "invalid boolean value: $1" ;;
  esac
}

process_request() {
  local request_path="$1"
  local request_id product clean refresh log_path started_at finished_at exit_code

  request_id="$(basename "$request_path" .request)"
  product="$(read_request_value "$request_path" product)"
  clean="$(read_request_value "$request_path" clean)"
  refresh="$(read_request_value "$request_path" refresh_gui_dist)"
  product="${product:-DeepCode}"
  clean="${clean:-0}"
  refresh="${refresh:-0}"
  validate_product "$product"
  validate_bool "$clean"
  validate_bool "$refresh"

  log_path="$LOG_DIR/$request_id.log"
  write_status "$request_id" "running" "$log_path"
  started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  set +e
  {
    printf '==[macos-package-service]== request=%s product=%s clean=%s refresh_gui_dist=%s started_at=%s\n' \
      "$request_id" "$product" "$clean" "$refresh" "$started_at"
    cd "$ROOT_DIR"
    env \
      DEEPCODE_MACOS_PRODUCT="$product" \
      DEEPCODE_MACOS_CLEAN="$clean" \
      DEEPCODE_MACOS_REFRESH_GUI_DIST="$refresh" \
      DEEPCODE_MACOS_CARGO_OFFLINE="${DEEPCODE_MACOS_CARGO_OFFLINE:-0}" \
      bash ./scripts/package-macos.sh
  } >"$log_path" 2>&1
  exit_code="$?"
  set -e

  finished_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [ "$exit_code" -eq 0 ]; then
    printf '==[macos-package-service]== request=%s finished_at=%s state=done\n' "$request_id" "$finished_at" >>"$log_path"
    write_service_heartbeat
    write_status "$request_id" "done" "$log_path"
  else
    printf '==[macos-package-service]== request=%s finished_at=%s state=failed exit_code=%s\n' \
      "$request_id" "$finished_at" "$exit_code" >>"$log_path"
    write_service_heartbeat
    write_status "$request_id" "failed" "$log_path" "exit_code=$exit_code"
  fi
  rm -f "$request_path"
}

run_cmd() {
  ensure_macos_host
  ensure_dirs
  printf '%s\n' "$$" >"$PID_FILE"
  write_service_heartbeat
  log "run loop pid=$$ dir=$SERVICE_DIR"

  while true; do
    write_service_heartbeat
    local request_path
    for request_path in "$REQUEST_DIR"/*.request; do
      [ -f "$request_path" ] || continue
      process_request "$request_path"
    done
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

submit_cmd() {
  ensure_dirs
  local product="DeepCode"
  local clean=0
  local refresh=0
  local wait=0
  local timeout_seconds="${DEEPCODE_MACOS_PACKAGE_TIMEOUT_SECONDS:-3600}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --product)
        [ "$#" -ge 2 ] || fail "--product requires a value"
        product="$2"
        shift 2
        ;;
      --clean)
        clean=1
        shift
        ;;
      --refresh-gui-dist)
        refresh=1
        shift
        ;;
      --wait)
        wait=1
        shift
        ;;
      --timeout-seconds)
        [ "$#" -ge 2 ] || fail "--timeout-seconds requires a value"
        timeout_seconds="$2"
        shift 2
        ;;
      *)
        fail "unknown submit argument: $1"
        ;;
    esac
  done
  validate_product "$product"
  validate_bool "$clean"
  validate_bool "$refresh"
  case "$timeout_seconds" in
    ''|*[!0-9]*) fail "invalid timeout seconds: $timeout_seconds" ;;
  esac

  local request_id request_tmp request_path status_path deadline state log_path now
  request_id="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  request_tmp="$REQUEST_DIR/$request_id.request.tmp"
  request_path="$REQUEST_DIR/$request_id.request"
  status_path="$STATUS_DIR/$request_id.status"
  {
    printf 'product=%s\n' "$product"
    printf 'clean=%s\n' "$clean"
    printf 'refresh_gui_dist=%s\n' "$refresh"
    printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$request_tmp"
  mv "$request_tmp" "$request_path"
  log "queued request=$request_id product=$product"

  if [ "$wait" != "1" ]; then
    return 0
  fi

  deadline=$(( $(date +%s) + timeout_seconds ))
  while true; do
    if [ -f "$status_path" ]; then
      state="$(parse_status_state "$status_path")"
      log_path="$(parse_status_log_path "$status_path")"
      case "$state" in
        done)
          log "request=$request_id done log=$log_path"
          return 0
          ;;
        failed)
          log "request=$request_id failed log=$log_path"
          if [ -n "$log_path" ] && [ -f "$log_path" ]; then
            tail -n 80 "$log_path" >&2 || true
          fi
          return 1
          ;;
      esac
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      fail "request=$request_id timed out after ${timeout_seconds}s"
    fi
    sleep 2
  done
}

cmd="${1:-}"
if [ -z "$cmd" ]; then
  usage
  exit 2
fi
shift

case "$cmd" in
  start) start_cmd "$@" ;;
  run) run_cmd "$@" ;;
  stop) stop_cmd "$@" ;;
  status) status_cmd "$@" ;;
  submit) submit_cmd "$@" ;;
  -h|--help|help) usage ;;
  *) fail "unknown command: $cmd" ;;
esac
