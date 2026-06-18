#!/usr/bin/env bash
# ====================================================================
# DeepCode cross-platform unified build script
# 常规 Linux/Windows 构建在 Docker 中执行；macOS .app 打包入口在 macOS 宿主机执行。
#
# 默认行为：
#   ./build.sh
#     macOS 宿主机：强制刷新前端并打包最新 DeepCode.app / DeepCode-GUI.app。
#     Docker/Linux：完整构建并输出 bin/linux-x64/ 与 bin/win64/，可自动请求 macOS 打包服务。
#
# 分阶段入口：
#   ./build.sh --stage gui      # pnpm + React GUI + Tauri embedded dist
#   ./build.sh --stage deepcode-gui # pnpm + DeepCode-GUI dist
#   ./build.sh --stage macos-package-service # macOS host: start package worker
#   ./build.sh --stage package-macos # macOS host/Docker request: build complete macOS app set
#   ./build.sh --stage package-macos-deepcode-gui # macOS host: build DeepCode-GUI.app package
#   ./build.sh --stage macos-deepcode-gui # compat alias for package-macos-deepcode-gui
#   ./build.sh --stage daemon   # Linux/Windows Rust Kernel daemon
#   ./build.sh --stage cli      # Linux/Windows CLI Host shell
#   ./build.sh --stage tui      # Linux/Windows TUI Host shell
#   ./build.sh --stage kernel   # 兼容入口：daemon + cli + tui
#   ./build.sh --stage tauri    # Windows DeepCode.exe Tauri thin shell
#   ./build.sh --stage deepcode-gui-tauri # Windows DeepCode-GUI.exe Tauri shell
#   ./build.sh --stage package  # 复制已有构建产物到 bin/
#   ./build.sh --stage all      # 等价默认完整构建
#
# 缓存开关：
#   DEEPCODE_DISABLE_SCCACHE=1  禁用 sccache，回退到普通 cargo。
#   DEEPCODE_CARGO_SOURCE=auto|repo|official
#                                  Cargo registry source mode; auto retries registry/TLS failures on the fallback sparse source.
#   DEEPCODE_CARGO_FALLBACK_REGISTRY_URL
#                                  Override the fallback Cargo sparse registry URL; the default official crates.io source uses Cargo's built-in registry.
#   DEEPCODE_CARGO_OFFICIAL_CWD
#                                  Override cwd used for official crates.io fallback; default /tmp/deepcode-cargo-official-cwd.
#   DEEPCODE_CARGO_AUTO_PRIMARY_RETRY
#                                  Cargo retry count for the auto-mode primary source probe; default 0.
#   DEEPCODE_FORCE_BUILD=1      忽略 stage hash，强制执行构建阶段。
#   DEEPCODE_ALLOW_HOST_BUILD=1 显式允许宿主机直接构建（默认 Docker-only）。
#   --clean-cache               清理 macOS 打包缓存后重新打包；保留用户配置和会话数据。
#   --no-kill-running           macOS 打包时不自动结束旧 .app 占用进程。
# ====================================================================
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_ROOT="$ROOT_DIR/bin"
LINUX_DIR="$BIN_ROOT/linux-x64"
WIN_DIR="$BIN_ROOT/win64"
CLIENT_DIR="$ROOT_DIR/userspace/gui"
WINDOWS_TARGET="x86_64-pc-windows-gnu"

fs_type_of() {
  stat -f -c %T "$1" 2>/dev/null || true
}

is_wsl_bind_fs_type() {
  case "$1" in
    v9fs|9p|drvfs|fuseblk)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_native_build_dir() {
  local dir="$1"
  local fs_type
  [ -d "$dir" ] || return 1
  fs_type="$(fs_type_of "$dir")"
  [ -n "$fs_type" ] || return 1
  ! is_wsl_bind_fs_type "$fs_type"
}

docker_cargo_target_default() {
  local target_volume="$ROOT_DIR/target"
  if is_native_build_dir "$target_volume"; then
    printf '%s\n' "$target_volume"
  else
    printf '%s\n' "/tmp/deepcode-cargo-target"
  fi
}

if [ -n "${CARGO_TARGET_DIR:-}" ]; then
  CARGO_TARGET_ROOT="$CARGO_TARGET_DIR"
elif [ -f /.dockerenv ]; then
  CARGO_TARGET_ROOT="$(docker_cargo_target_default)"
else
  CARGO_TARGET_ROOT="$ROOT_DIR/target"
fi
if [ -n "${DEEPCODE_TMPDIR:-}" ]; then
  BUILD_TMPDIR="$DEEPCODE_TMPDIR"
elif [ -f /.dockerenv ] && { [ -z "${TMPDIR:-}" ] || [ "${TMPDIR%/}" = "/tmp" ]; }; then
  BUILD_TMPDIR="/tmp/deepcode-build"
else
  BUILD_TMPDIR="${TMPDIR:-/tmp}"
fi
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$ROOT_DIR/.pnpm-store}"
PNPM_REGISTRY="${DEEPCODE_PNPM_REGISTRY:-https://registry.yarnpkg.com}"
PNPM_NETWORK_CONCURRENCY="${DEEPCODE_PNPM_NETWORK_CONCURRENCY:-4}"
PNPM_FETCH_RETRIES="${DEEPCODE_PNPM_FETCH_RETRIES:-2}"
PNPM_FETCH_RETRY_MINTIMEOUT_MS="${DEEPCODE_PNPM_FETCH_RETRY_MINTIMEOUT_MS:-5000}"
PNPM_FETCH_RETRY_MAXTIMEOUT_MS="${DEEPCODE_PNPM_FETCH_RETRY_MAXTIMEOUT_MS:-15000}"
PNPM_FETCH_TIMEOUT_MS="${DEEPCODE_PNPM_FETCH_TIMEOUT_MS:-30000}"
BUILD_LINUX_TAURI_SHELL="${DEEPCODE_BUILD_LINUX_TAURI_SHELL:-0}"
STAGE_STAMP_DIR="$ROOT_DIR/.build-cache/build-stamps"
CARGO_WITH_FALLBACK="$ROOT_DIR/scripts/cargo-with-fallback.sh"

export CARGO_TARGET_DIR="$CARGO_TARGET_ROOT"
export TMPDIR="$BUILD_TMPDIR"

cd "$ROOT_DIR"
mkdir -p "$CARGO_TARGET_DIR" "$TMPDIR"

usage() {
  cat <<'USAGE'
Usage:
  ./build.sh [--stage all|gui|deepcode-gui|deepcode-gui-tauri|macos-package-service|package-macos|package-macos-deepcode-gui|macos-deepcode-gui|daemon|cli|tui|kernel|tauri|package]...
  ./build.sh --stage macos-package-service
  ./build.sh --full
  ./build.sh --stage package-macos --clean-cache

Default:
  macOS host: package latest DeepCode.app and DeepCode-GUI.app.
  Docker/Linux: build regular Linux/Windows distribution artifacts.

Environment:
  CARGO_TARGET_DIR                  Override shared Cargo target directory.
                                    Docker default prefers /workspace/target
                                    when it is a native Docker volume, otherwise
                                    falls back to /tmp/deepcode-cargo-target.
  DEEPCODE_TMPDIR                   Override temporary build directory.
                                    Docker default: /tmp/deepcode-build.
  PNPM_STORE_DIR                    Override pnpm store directory.
  DEEPCODE_PNPM_REGISTRY            Override pnpm registry used by dependency install.
  DEEPCODE_PNPM_NETWORK_CONCURRENCY Override pnpm network concurrency.
  DEEPCODE_PNPM_FETCH_TIMEOUT_MS    Override pnpm fetch timeout in milliseconds.
  DEEPCODE_FORCE_BUILD=1            Ignore stage hash stamps and rebuild.
  DEEPCODE_DISABLE_SCCACHE=1        Disable sccache even when available.
  DEEPCODE_CARGO_SOURCE=auto|repo|official
                                    Cargo registry source mode. Default auto keeps
                                    repo config first and retries registry/TLS
                                    download failures with the fallback sparse source.
  DEEPCODE_CARGO_FALLBACK_REGISTRY_URL
                                    Override fallback Cargo sparse registry URL.
                                    Default official crates.io source uses Cargo's
                                    built-in registry instead of source replacement.
  DEEPCODE_CARGO_OFFICIAL_CWD
                                    Override cwd used for official crates.io
                                    fallback. Default /tmp/deepcode-cargo-official-cwd
                                    avoids project-local .cargo/config.toml.
  DEEPCODE_CARGO_AUTO_PRIMARY_RETRY
                                    Cargo retry count for auto-mode primary source
                                    probe. Default 0 to fail fast into fallback.
  DEEPCODE_ALLOW_HOST_BUILD=1       Allow non-Docker host builds explicitly.
  SCCACHE_DIR                       Override local sccache cache directory.
                                    Docker default prefers CARGO_TARGET_DIR/.sccache
                                    on native Docker volumes, otherwise
                                    falls back to /tmp/deepcode-sccache.
  DEEPCODE_RESET_SCCACHE_SERVER=0   Do not stop an existing Docker sccache
                                    server before first use.
  DEEPCODE_BUILD_LINUX_TAURI_SHELL=1 Build optional Linux Tauri shell.
  DEEPCODE_MACOS_PACKAGE_MODE=auto|off|require
                                      From Docker, submit a macOS package request after full package stage.
  DEEPCODE_MACOS_PACKAGE_WAIT=1       Wait for the host package service request to finish.
  DEEPCODE_MACOS_PACKAGE_TIMEOUT_SECONDS
                                      Timeout for macOS package service requests.
  DEEPCODE_MACOS_PRODUCTS=DeepCode-GUI,DeepCode
                                      Comma/space separated macOS app set for package-macos.
  DEEPCODE_MACOS_PRODUCT=DeepCode-GUI Compatibility alias for a single macOS product.
  --clean-cache                     Clean macOS package build artifacts without deleting config/sessions/archives/kernel data.
  --no-kill-running                 Do not stop processes occupying the target macOS .app bundle before packaging.
USAGE
}

requested_stages=()
clean_cache=0
kill_running="${DEEPCODE_MACOS_KILL_RUNNING:-1}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      IFS=',' read -r -a split_stages <<< "$2"
      requested_stages+=("${split_stages[@]}")
      shift 2
      ;;
    --stage=*)
      IFS=',' read -r -a split_stages <<< "${1#--stage=}"
      requested_stages+=("${split_stages[@]}")
      shift
      ;;
    --full)
      requested_stages+=("all")
      shift
      ;;
    --clean-cache)
      clean_cache=1
      shift
      ;;
    --kill-running)
      kill_running=1
      shift
      ;;
    --no-kill-running)
      kill_running=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "==[build][error]== unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$kill_running" in
  0|1) ;;
  *)
    echo "==[build][error]== invalid DEEPCODE_MACOS_KILL_RUNNING: $kill_running" >&2
    exit 2
    ;;
esac

if [ "${#requested_stages[@]}" -eq 0 ]; then
  if [ "$(uname -s)" = "Darwin" ] && [ ! -f /.dockerenv ]; then
    requested_stages=("package-macos")
  else
    requested_stages=("all")
  fi
fi

run_deps=0
run_gui=0
run_deepcode_gui=0
run_package_macos=0
run_package_macos_deepcode_gui=0
run_macos_package_service=0
run_daemon=0
run_cli=0
run_tui=0
run_tauri=0
run_deepcode_gui_tauri=0
run_package=0
SCCACHE_SERVER_RESET_DONE=0

enable_stage() {
  case "$1" in
    all)
      run_deps=1
      run_gui=1
      run_deepcode_gui=1
      run_daemon=1
      run_cli=1
      run_tui=1
      run_tauri=1
      run_deepcode_gui_tauri=1
      run_package=1
      ;;
    macos-package-service)
      run_macos_package_service=1
      ;;
    deps)
      run_deps=1
      ;;
    gui)
      run_deps=1
      run_gui=1
      ;;
    deepcode-gui)
      run_deps=1
      run_deepcode_gui=1
      ;;
    package-macos)
      run_package_macos=1
      ;;
    package-macos-deepcode-gui)
      run_package_macos_deepcode_gui=1
      ;;
    macos-deepcode-gui)
      run_package_macos_deepcode_gui=1
      ;;
    kernel)
      run_daemon=1
      run_cli=1
      run_tui=1
      ;;
    daemon)
      run_daemon=1
      ;;
    cli)
      run_cli=1
      ;;
    tui)
      run_tui=1
      ;;
    tauri)
      run_deps=1
      run_tauri=1
      ;;
    deepcode-gui-tauri)
      run_deps=1
      run_deepcode_gui=1
      run_deepcode_gui_tauri=1
      ;;
    package)
      run_package=1
      ;;
    *)
      echo "==[build][error]== unsupported stage: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
}

for stage in "${requested_stages[@]}"; do
  enable_stage "$stage"
done

build_started_at() {
  if date -Is >/dev/null 2>&1; then
    date -Is
  else
    date -u '+%Y-%m-%dT%H:%M:%SZ'
  fi
}

echo "==[build]== DeepCode cross-platform build started at $(build_started_at)"
echo "==[build]== ROOT_DIR=$ROOT_DIR"
echo "==[build]== CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "==[build]== TMPDIR=$TMPDIR"
echo "==[build]== PNPM_STORE_DIR=$PNPM_STORE_DIR"
echo "==[build]== PNPM_REGISTRY=$PNPM_REGISTRY"
echo "==[build]== DEEPCODE_BUILD_LINUX_TAURI_SHELL=$BUILD_LINUX_TAURI_SHELL"
echo "==[build]== clean-cache=$clean_cache"
echo "==[build]== stages: deps=$run_deps gui=$run_gui deepcode-gui=$run_deepcode_gui deepcode-gui-tauri=$run_deepcode_gui_tauri package-macos=$run_package_macos package-macos-deepcode-gui=$run_package_macos_deepcode_gui macos-package-service=$run_macos_package_service daemon=$run_daemon cli=$run_cli tui=$run_tui tauri=$run_tauri package=$run_package"
mkdir -p "$STAGE_STAMP_DIR"

is_docker_environment() {
  [ -f /.dockerenv ] && return 0
  grep -qaE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null
}

require_docker_build_environment() {
  if is_docker_environment || [ "${DEEPCODE_ALLOW_HOST_BUILD:-0}" = "1" ]; then
    return
  fi
  echo "==[build][error]== build.sh is Docker-only for build/package stages." >&2
  echo "==[build][error]== Run inside the deepcode-dev container, or set DEEPCODE_ALLOW_HOST_BUILD=1 for a one-off local diagnostic build." >&2
  exit 3
}

run_macos_package_from_host() {
  local product="$1"
  local output_app="$2"
  if is_docker_environment; then
    echo "==[build][error]== macOS package stages must run on the macOS host, not inside Docker." >&2
    exit 3
  fi
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "==[build][error]== macOS package stages require a macOS host." >&2
    exit 3
  fi

  echo "==[build][package-macos]== package $product.app on macOS host"
  if [ "$clean_cache" = "1" ]; then
    env DEEPCODE_MACOS_CLEAN=1 DEEPCODE_MACOS_REFRESH_GUI_DIST=1 DEEPCODE_MACOS_KILL_RUNNING="$kill_running" DEEPCODE_MACOS_PRODUCT="$product" bash ./scripts/package-macos.sh
  else
    env DEEPCODE_MACOS_REFRESH_GUI_DIST=1 DEEPCODE_MACOS_KILL_RUNNING="$kill_running" DEEPCODE_MACOS_PRODUCT="$product" bash ./scripts/package-macos.sh
  fi
  echo ""
  echo "==[build]== DONE"
  echo "$BIN_ROOT/macos-arm64/$output_app"
}

declare -a resolved_macos_products=()

add_macos_product() {
  local product="$1"
  local existing
  case "$product" in
    DeepCode|DeepCode-GUI) ;;
    *) echo "==[build][error]== unsupported macOS product: $product" >&2; exit 2 ;;
  esac
  if [ "${#resolved_macos_products[@]}" -gt 0 ]; then
    for existing in "${resolved_macos_products[@]}"; do
      [ "$existing" != "$product" ] || return 0
    done
  fi
  resolved_macos_products+=("$product")
}

resolve_macos_products() {
  resolved_macos_products=()
  local raw="${DEEPCODE_MACOS_PRODUCTS:-}"
  if [ -z "$raw" ]; then
    raw="${DEEPCODE_MACOS_PRODUCT:-DeepCode-GUI,DeepCode}"
  fi
  raw="${raw//,/ }"

  local product
  for product in $raw; do
    case "$product" in
      all|complete|both)
        add_macos_product "DeepCode-GUI"
        add_macos_product "DeepCode"
        ;;
      *)
        add_macos_product "$product"
        ;;
    esac
  done
  if [ "${#resolved_macos_products[@]}" -eq 0 ]; then
    echo "==[build][error]== empty macOS product list" >&2
    exit 2
  fi
}

run_macos_package_products_from_host() {
  local product
  for product in "$@"; do
    case "$product" in
      DeepCode) run_macos_package_from_host "DeepCode" "DeepCode.app" ;;
      DeepCode-GUI) run_macos_package_from_host "DeepCode-GUI" "DeepCode-GUI.app" ;;
      *) echo "==[build][error]== unsupported macOS product: $product" >&2; exit 2 ;;
    esac
  done
}

start_macos_package_service_from_host() {
  if is_docker_environment; then
    echo "==[build][error]== macOS package service must be started on the macOS host, not inside Docker." >&2
    echo "==[build][error]== Run on the host: bash ./build.sh --stage macos-package-service" >&2
    exit 3
  fi
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "==[build][error]== macOS package service requires a macOS host." >&2
    exit 3
  fi
  bash ./scripts/macos-package-service.sh start
  bash ./scripts/macos-package-service.sh status
}

macos_package_service_is_running() {
  bash ./scripts/macos-package-service.sh status --quiet >/dev/null 2>&1
}

submit_macos_package_request() {
  local product="$1"
  local required="${2:-1}"
  local wait="${DEEPCODE_MACOS_PACKAGE_WAIT:-1}"
  local timeout="${DEEPCODE_MACOS_PACKAGE_TIMEOUT_SECONDS:-3600}"
  local args=(submit --product "$product" --timeout-seconds "$timeout")

  args+=(--refresh-gui-dist)
  if [ "$clean_cache" = "1" ]; then
    args+=(--clean)
  fi
  if [ "$kill_running" = "0" ]; then
    args+=(--no-kill-running)
  fi
  if [ "$wait" = "1" ]; then
    args+=(--wait)
  fi

  if ! macos_package_service_is_running; then
    if [ "$required" = "1" ]; then
      echo "==[build][error]== macOS package service is not running." >&2
      echo "==[build][error]== Run on the macOS host first: bash ./build.sh --stage macos-package-service" >&2
      exit 3
    fi
    echo "==[build][package-macos]== macOS package service not running; skip auto package request"
    echo "==[build][package-macos]== Start it on host with: bash ./build.sh --stage macos-package-service"
    return 0
  fi

  echo "==[build][package-macos]== submit $product request to macOS package service"
  bash ./scripts/macos-package-service.sh "${args[@]}"
}

submit_macos_package_requests() {
  local required="$1"
  shift
  local product
  for product in "$@"; do
    submit_macos_package_request "$product" "$required"
  done
}

auto_submit_macos_package_request() {
  if [ "${DEEPCODE_MACOS_PACKAGE_MODE:-auto}" = "off" ]; then
    return 0
  fi
  is_docker_environment || return 0

  local required=0
  if [ "${DEEPCODE_MACOS_PACKAGE_MODE:-auto}" = "require" ]; then
    required=1
  fi
  resolve_macos_products
  submit_macos_package_requests "$required" "${resolved_macos_products[@]}"
}

host_macos_stage_count=$((run_package_macos + run_package_macos_deepcode_gui))
if [ "$run_macos_package_service" = "1" ]; then
  if [ "$host_macos_stage_count" -gt 0 ] || [ "$run_deps" = "1" ] || [ "$run_gui" = "1" ] || \
    [ "$run_deepcode_gui" = "1" ] || [ "$run_daemon" = "1" ] || [ "$run_cli" = "1" ] || \
    [ "$run_tui" = "1" ] || [ "$run_tauri" = "1" ] || [ "$run_deepcode_gui_tauri" = "1" ] || \
    [ "$run_package" = "1" ]; then
    echo "==[build][error]== macos-package-service must run by itself." >&2
    exit 2
  fi
  start_macos_package_service_from_host
  exit 0
fi

if [ "$host_macos_stage_count" -gt 0 ]; then
  if [ "$host_macos_stage_count" -ne 1 ]; then
    echo "==[build][error]== run exactly one macOS package stage at a time." >&2
    exit 2
  fi
  if [ "$run_deps" = "1" ] || [ "$run_gui" = "1" ] || [ "$run_deepcode_gui" = "1" ] || \
    [ "$run_daemon" = "1" ] || [ "$run_cli" = "1" ] || [ "$run_tui" = "1" ] || \
    [ "$run_tauri" = "1" ] || [ "$run_deepcode_gui_tauri" = "1" ] || [ "$run_package" = "1" ]; then
    echo "==[build][error]== macOS package stages are host orchestration stages; run them by themselves." >&2
    exit 2
  fi
  if [ "$run_package_macos" = "1" ]; then
    resolve_macos_products
    if is_docker_environment; then
      submit_macos_package_requests 1 "${resolved_macos_products[@]}"
    else
      run_macos_package_products_from_host "${resolved_macos_products[@]}"
    fi
  else
    if is_docker_environment; then
      submit_macos_package_request "DeepCode-GUI" 1
    else
      run_macos_package_from_host "DeepCode-GUI" "DeepCode-GUI.app"
    fi
  fi
  exit 0
fi

if [ "$clean_cache" = "1" ]; then
  echo "==[build][error]== --clean-cache is only supported with --stage package-macos or --stage package-macos-deepcode-gui." >&2
  exit 2
fi

require_docker_build_environment

configure_sccache() {
  if [ "${DEEPCODE_DISABLE_SCCACHE:-0}" = "1" ]; then
    unset RUSTC_WRAPPER
    echo "==[build][cache]== sccache disabled by DEEPCODE_DISABLE_SCCACHE=1"
    return
  fi

  if command -v sccache >/dev/null 2>&1; then
    if [ -z "${SCCACHE_DIR:-}" ]; then
      if is_docker_environment && is_native_build_dir "$CARGO_TARGET_ROOT"; then
        export SCCACHE_DIR="$CARGO_TARGET_ROOT/.sccache"
      elif is_docker_environment; then
        export SCCACHE_DIR="/tmp/deepcode-sccache"
      else
        export SCCACHE_DIR="$ROOT_DIR/.build-cache/sccache"
      fi
    else
      export SCCACHE_DIR
    fi
    mkdir -p "$SCCACHE_DIR"
    export RUSTC_WRAPPER="${RUSTC_WRAPPER:-sccache}"
    if is_docker_environment && [ "${DEEPCODE_RESET_SCCACHE_SERVER:-1}" = "1" ] && [ "$SCCACHE_SERVER_RESET_DONE" = "0" ]; then
      sccache --stop-server >/dev/null 2>&1 || true
      SCCACHE_SERVER_RESET_DONE=1
      echo "==[build][cache]== sccache server reset for Docker cache path"
    fi
    echo "==[build][cache]== sccache enabled: RUSTC_WRAPPER=$RUSTC_WRAPPER SCCACHE_DIR=$SCCACHE_DIR"
  else
    echo "==[build][cache]== sccache not found; cargo builds continue without RUSTC_WRAPPER"
  fi
}

show_sccache_stats() {
  if command -v sccache >/dev/null 2>&1 && [ "${DEEPCODE_DISABLE_SCCACHE:-0}" != "1" ]; then
    echo "==[build][cache]== sccache stats"
    sccache --show-stats || true
  fi
}

cargo_with_fallback() {
  DEEPCODE_CARGO_MANIFEST_PATH="${DEEPCODE_CARGO_MANIFEST_PATH:-$ROOT_DIR/Cargo.toml}" \
    bash "$CARGO_WITH_FALLBACK" "$@"
}

cargo_with_fallback_executable() {
  local manifest_path="${1:-}"
  local wrapper_dir="$TMPDIR/deepcode-cargo-wrapper"
  local wrapper="$wrapper_dir/cargo"
  local real_cargo
  real_cargo="$(command -v cargo)"
  mkdir -p "$wrapper_dir"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'export DEEPCODE_CARGO_CALLER_CWD="${DEEPCODE_CARGO_CALLER_CWD:-$(pwd)}"\n'
    printf 'export DEEPCODE_CARGO_BIN="${DEEPCODE_CARGO_BIN:-%q}"\n' "$real_cargo"
    if [ -n "$manifest_path" ]; then
      printf 'export DEEPCODE_CARGO_MANIFEST_PATH=%q\n' "$manifest_path"
    fi
    printf 'exec bash %q "$@"\n' "$CARGO_WITH_FALLBACK"
  } >"$wrapper"
  chmod +x "$wrapper"
  printf '%s\n' "$wrapper"
}

run_with_cargo_fallback_shim() {
  local manifest_path="$1"
  shift
  local cargo_wrapper
  local cargo_wrapper_dir
  cargo_wrapper="$(cargo_with_fallback_executable "$manifest_path")"
  cargo_wrapper_dir="$(dirname "$cargo_wrapper")"
  CARGO="$cargo_wrapper" PATH="$cargo_wrapper_dir:$PATH" "$@"
}

tracked_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -- "$@"
  else
    find "$@" -type f 2>/dev/null || true
  fi
}

find_existing_files() {
  local path
  for path in "$@"; do
    if [ -f "$path" ]; then
      printf '%s\n' "$path"
    elif [ -d "$path" ]; then
      find "$path" -type f 2>/dev/null || true
    fi
  done
}

stage_hash() {
  local stage="$1"
  {
    case "$stage" in
      gui)
        tracked_files package.json pnpm-lock.yaml userspace/protocol userspace/session-core userspace/gui \
          | grep -Ev '(^|/)(dist|node_modules)/' || true
        ;;
      deepcode-gui)
        tracked_files package.json pnpm-lock.yaml userspace/protocol userspace/session-core userspace/gui shells/deepcode-gui \
          | grep -Ev '(^|/)(dist|dist-deepcode-gui|node_modules)/' || true
        find_existing_files \
          userspace/gui/deepcode-gui.html \
          userspace/gui/vite.deepcode-gui.config.ts \
          userspace/gui/src/deepcode-gui \
          shells/deepcode-gui \
          | grep -Ev '(^|/)(dist|dist-deepcode-gui|node_modules|target)/' || true
        ;;
      kernel)
        tracked_files Cargo.toml crates/deepcode-kernel-abi crates/deepcode-kernel-core \
          crates/deepcode-kernel-runtime crates/deepcode-kernel-policy crates/deepcode-kernel-ledger \
          crates/deepcode-kernel-config crates/deepcode-kernel-workflow \
          crates/deepcode-kernel-context crates/deepcode-kernel-skills crates/deepcode-kernel-audit \
          crates/deepcode-kernel-client crates/deepcode-kernel-daemon shells/cli shells/tui
        ;;
      daemon)
        tracked_files Cargo.toml crates/deepcode-kernel-abi crates/deepcode-kernel-core \
          crates/deepcode-kernel-runtime crates/deepcode-kernel-policy crates/deepcode-kernel-ledger \
          crates/deepcode-kernel-config crates/deepcode-kernel-workflow \
          crates/deepcode-kernel-context crates/deepcode-kernel-skills crates/deepcode-kernel-audit \
          crates/deepcode-kernel-daemon
        ;;
      cli)
        tracked_files Cargo.toml crates/deepcode-kernel-abi crates/deepcode-kernel-client shells/cli
        ;;
      tui)
        tracked_files Cargo.toml crates/deepcode-kernel-abi crates/deepcode-kernel-client shells/tui
        ;;
      tauri)
        tracked_files package.json pnpm-lock.yaml shells/tauri
        find_existing_files "$CLIENT_DIR/dist" "$ROOT_DIR/shells/tauri/dist"
        ;;
      deepcode-gui-tauri)
        tracked_files package.json pnpm-lock.yaml shells/deepcode-gui
        find_existing_files "$CLIENT_DIR/dist-deepcode-gui" "$ROOT_DIR/shells/deepcode-gui/dist"
        ;;
      *)
        return 1
        ;;
    esac
  } \
    | while IFS= read -r path; do
        [ -f "$path" ] && printf '%s\n' "$path"
      done \
    | LC_ALL=C sort -u \
    | xargs -r sha256sum \
    | sha256sum \
    | awk '{print $1}'
}

stage_should_skip() {
  local stage="$1"
  shift

  if [ "${DEEPCODE_FORCE_BUILD:-0}" = "1" ]; then
    return 1
  fi

  local artifact
  for artifact in "$@"; do
    [ -e "$artifact" ] || return 1
  done

  local stamp_file="$STAGE_STAMP_DIR/${stage}.sha256"
  local current_hash
  current_hash="$(stage_hash "$stage")"
  if [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$current_hash" ]; then
    echo "==[build][$stage]== unchanged; skipping stage (set DEEPCODE_FORCE_BUILD=1 to rebuild)"
    return 0
  fi
  return 1
}

mark_stage_built() {
  local stage="$1"
  stage_hash "$stage" >"$STAGE_STAMP_DIR/${stage}.sha256"
}

run_pnpm_install() {
  echo "==[build][deps]== pnpm install"
  pnpm install --no-frozen-lockfile \
    --store-dir "$PNPM_STORE_DIR" \
    --registry "$PNPM_REGISTRY" \
    --network-concurrency "$PNPM_NETWORK_CONCURRENCY" \
    --fetch-retries "$PNPM_FETCH_RETRIES" \
    --fetch-retry-mintimeout "$PNPM_FETCH_RETRY_MINTIMEOUT_MS" \
    --fetch-retry-maxtimeout "$PNPM_FETCH_RETRY_MAXTIMEOUT_MS" \
    --fetch-timeout "$PNPM_FETCH_TIMEOUT_MS"
}

prepare_tauri_dist() {
  local tauri_gui_dist="$ROOT_DIR/shells/tauri/dist"
  test -d "$CLIENT_DIR/dist" || {
    echo "==[build][error]== userspace/gui/dist missing; run ./build.sh --stage gui first" >&2
    exit 1
  }
  validate_frontend_dist "$CLIENT_DIR/dist" "DeepCode" "gui"
  mkdir -p "$tauri_gui_dist"
  find "$tauri_gui_dist" -mindepth 1 -delete 2>/dev/null || true
  cp -r "$CLIENT_DIR/dist/." "$tauri_gui_dist/"
}

prepare_deepcode_gui_tauri_dist() {
  local deepcode_gui_dist="$CLIENT_DIR/dist-deepcode-gui"
  local tauri_gui_dist="$ROOT_DIR/shells/deepcode-gui/dist"
  normalize_deepcode_gui_dist
  test -d "$deepcode_gui_dist" || {
    echo "==[build][error]== userspace/gui/dist-deepcode-gui missing; run ./build.sh --stage deepcode-gui first" >&2
    exit 1
  }
  validate_frontend_dist "$deepcode_gui_dist" "DeepCode-GUI" "deepcode-gui"
  mkdir -p "$tauri_gui_dist"
  find "$tauri_gui_dist" -mindepth 1 -delete 2>/dev/null || true
  cp -r "$deepcode_gui_dist/." "$tauri_gui_dist/"
}

sync_deepcode_gui_runtime_assets() {
  local runtime_dist="$1"
  normalize_deepcode_gui_dist
  validate_frontend_dist "$CLIENT_DIR/dist-deepcode-gui" "DeepCode-GUI" "deepcode-gui"
  mkdir -p "$runtime_dist"
  find "$runtime_dist" -mindepth 1 -delete 2>/dev/null || true
  cp -r "$CLIENT_DIR/dist-deepcode-gui/." "$runtime_dist/"
}

validate_frontend_dist() {
  local dist_dir="$1"
  local label="$2"
  local stage="$3"
  local index_file="$dist_dir/index.html"

  if [ ! -f "$index_file" ]; then
    echo "==[build][error]== $label frontend dist missing index.html at $index_file" >&2
    exit 1
  fi
  if ! grep -q '<script[^>]*type="module"[^>]*assets/' "$index_file"; then
    echo "==[build][error]== $label frontend dist index.html has no production module entry." >&2
    echo "==[build][error]== Rebuild the dist with DEEPCODE_FORCE_BUILD=1 bash ./build.sh --stage $stage" >&2
    exit 1
  fi
}

normalize_deepcode_gui_dist() {
  local deepcode_gui_dist="$CLIENT_DIR/dist-deepcode-gui"
  if [ -f "$deepcode_gui_dist/deepcode-gui.html" ]; then
    cp "$deepcode_gui_dist/deepcode-gui.html" "$deepcode_gui_dist/index.html"
  fi
}

build_gui() {
  if stage_should_skip gui "$CLIENT_DIR/dist/index.html" "$ROOT_DIR/shells/tauri/dist/index.html"; then
    return
  fi
  echo "==[build][gui]== build TS user/session/UI packages"
  pnpm --filter @deepcode/protocol build
  pnpm --filter @deepcode/session-core build
  pnpm --filter @deepcode/client build
  echo "==[build][gui]== prepare Tauri embedded GUI dist"
  prepare_tauri_dist
  mark_stage_built gui
}

build_deepcode_gui() {
  if stage_should_skip deepcode-gui "$CLIENT_DIR/dist-deepcode-gui/index.html" "$ROOT_DIR/shells/deepcode-gui/dist/index.html"; then
    return
  fi
  echo "==[build][deepcode-gui]== build TS protocol/session-core/DeepCode-GUI packages"
  pnpm --filter @deepcode/protocol build
  pnpm --filter @deepcode/session-core build
  pnpm --filter @deepcode/client build:deepcode-gui
  normalize_deepcode_gui_dist
  echo "==[build][deepcode-gui]== prepare DeepCode-GUI Tauri embedded dist"
  prepare_deepcode_gui_tauri_dist
  mark_stage_built deepcode-gui
}

build_daemon() {
  if stage_should_skip daemon \
    "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" \
    "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-kernel-daemon.exe"; then
    return
  fi
  configure_sccache
  echo "==[build][daemon]== build Rust Kernel daemon for Linux"
  cargo_with_fallback build --release -p deepcode-kernel-daemon
  echo "==[build][daemon]== build Rust Kernel daemon for Windows GNU"
  cargo_with_fallback build --release --target "$WINDOWS_TARGET" -p deepcode-kernel-daemon
  mark_stage_built daemon
  show_sccache_stats
}

build_cli() {
  if stage_should_skip cli \
    "$CARGO_TARGET_ROOT/release/deepcode-cli" \
    "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-cli.exe" \
    ; then
    return
  fi
  configure_sccache
  echo "==[build][cli]== build Rust CLI Host shell for Linux"
  cargo_with_fallback build --release -p deepcode-cli
  echo "==[build][cli]== build Rust CLI Host shell for Windows GNU"
  cargo_with_fallback build --release --target "$WINDOWS_TARGET" -p deepcode-cli
  mark_stage_built cli
  show_sccache_stats
}

build_tui() {
  if stage_should_skip tui \
    "$CARGO_TARGET_ROOT/release/deepcode-tui" \
    "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-tui.exe"; then
    return
  fi
  configure_sccache
  echo "==[build][tui]== build Rust TUI Host shell for Linux"
  cargo_with_fallback build --release -p deepcode-tui
  echo "==[build][tui]== build Rust TUI Host shell for Windows GNU"
  cargo_with_fallback build --release --target "$WINDOWS_TARGET" -p deepcode-tui
  mark_stage_built tui
  show_sccache_stats
}

build_kernel() {
  build_daemon
  build_cli
  build_tui
}

build_tauri() {
  if [ ! -d "$CLIENT_DIR/dist" ]; then
    echo "==[build][tauri]== GUI dist missing; building GUI first"
    build_gui
  else
    prepare_tauri_dist
  fi
  if stage_should_skip tauri "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode.exe"; then
    return
  fi
  configure_sccache
  echo "==[build][tauri]== build Windows DeepCode.exe GUI shell"
  run_with_cargo_fallback_shim "$ROOT_DIR/shells/tauri/src-tauri/Cargo.toml" \
    pnpm --filter @deepcode/tauri-shell tauri:build -- --target "$WINDOWS_TARGET"
  mark_stage_built tauri
  show_sccache_stats
}

build_deepcode_gui_tauri() {
  if [ ! -d "$CLIENT_DIR/dist-deepcode-gui" ]; then
    echo "==[build][deepcode-gui-tauri]== DeepCode-GUI dist missing; building DeepCode-GUI first"
    build_deepcode_gui
  else
    prepare_deepcode_gui_tauri_dist
  fi
  local runtime_dist="$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/web-deepcode-gui"
  sync_deepcode_gui_runtime_assets "$runtime_dist"
  if stage_should_skip deepcode-gui-tauri "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode-GUI.exe"; then
    return
  fi
  configure_sccache
  echo "==[build][deepcode-gui-tauri]== build Windows DeepCode-GUI.exe Tauri shell"
  run_with_cargo_fallback_shim "$ROOT_DIR/shells/deepcode-gui/src-tauri/Cargo.toml" \
    pnpm --filter @deepcode/deepcode-gui-shell tauri:build -- --target "$WINDOWS_TARGET"
  mark_stage_built deepcode-gui-tauri
  show_sccache_stats
}

prepare_distribution_tree() {
  local dist_dir="$1"
  mkdir -p \
    "$dist_dir/config/global/prompts" \
    "$dist_dir/config/global/skills" \
    "$dist_dir/config/global/ruler" \
    "$dist_dir/config/user/local/settings" \
    "$dist_dir/config/user/local/secrets" \
    "$dist_dir/sessions" \
    "$dist_dir/conversation-archives" \
    "$dist_dir/kernel" \
    "$dist_dir/packs" \
    "$dist_dir/web" \
    "$dist_dir/web-deepcode-gui"

  if [ -d "$CLIENT_DIR/dist" ]; then
    cp -r "$CLIENT_DIR/dist/." "$dist_dir/web/"
  fi
  if [ -d "$CLIENT_DIR/dist-deepcode-gui" ]; then
    normalize_deepcode_gui_dist
    cp -r "$CLIENT_DIR/dist-deepcode-gui/." "$dist_dir/web-deepcode-gui/"
  fi
}

copy_required_file() {
  local src="$1"
  local dst="$2"
  local hint="$3"
  if [ ! -f "$src" ]; then
    echo "==[build][error]== missing artifact: $src" >&2
    echo "==[build][error]== $hint" >&2
    exit 1
  fi
  cp -v "$src" "$dst"
}

require_package_file() {
  local src="$1"
  local hint="$2"
  if [ ! -f "$src" ]; then
    echo "==[build][error]== missing artifact before package cleanup: $src" >&2
    echo "==[build][error]== $hint" >&2
    return 1
  fi
}

require_package_dir() {
  local src="$1"
  local hint="$2"
  if [ ! -d "$src" ]; then
    echo "==[build][error]== missing artifact directory before package cleanup: $src" >&2
    echo "==[build][error]== $hint" >&2
    return 1
  fi
}

find_webview2_loader_dll() {
  local webview2_loader_dll="$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/WebView2Loader.dll"
  if [ -f "$webview2_loader_dll" ]; then
    printf '%s\n' "$webview2_loader_dll"
    return 0
  fi
  local build_dir="$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/build"
  if [ -d "$build_dir" ]; then
    find "$build_dir" \
      -path '*/out/x64/WebView2Loader.dll' \
      -type f \
      | head -n 1
  fi
  return 0
}

validate_package_inputs() {
  local missing=0
  require_package_dir "$CLIENT_DIR/dist" "run ./build.sh --stage gui first" || missing=1
  require_package_dir "$CLIENT_DIR/dist-deepcode-gui" "run ./build.sh --stage deepcode-gui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" "run ./build.sh --stage kernel first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/release/deepcode-cli" "run ./build.sh --stage kernel first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/release/deepcode-tui" "run ./build.sh --stage kernel first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-kernel-daemon.exe" "run ./build.sh --stage kernel first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-cli.exe" "run ./build.sh --stage kernel first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-tui.exe" "run ./build.sh --stage kernel first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode.exe" "run ./build.sh --stage tauri first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode-GUI.exe" "run ./build.sh --stage deepcode-gui-tauri first" || missing=1
  local webview2_loader_dll
  webview2_loader_dll="$(find_webview2_loader_dll)"
  if [ ! -f "$webview2_loader_dll" ]; then
    echo "==[build][error]== WebView2Loader.dll was not found before package cleanup" >&2
    missing=1
  fi
  if [ "$missing" = "1" ]; then
    exit 1
  fi
}

write_readme() {
  local dist_dir="$1"
  local platform="$2"
  local gui_entries="  deepcode-gui          Linux GUI host launcher"
  if [ "$platform" = "win64" ]; then
    gui_entries="  DeepCode.exe          Windows Editor shell, starts the same-dir Kernel on a free localhost port
  DeepCode-GUI.exe      Windows DeepCode-GUI shell, shares the same Kernel and config"
  fi
  cat > "$dist_dir/README.txt" <<README
DeepCode Unified Distribution ($platform)
=========================================

This folder is one DeepCode host distribution. GUI, CLI, and TUI entries share
the same Rust Kernel binary, bundled config directory, and packs directory.
Editor assets live in web/. DeepCode-GUI assets live in web-deepcode-gui/.
User session composition lives in the TS session-core package; all sensitive
workspace, process, skill, and context operations must enter the Kernel through
syscalls.

Writable package-local data is preserved across package refreshes:
  config/user/local/settings/     User settings, LLM profiles, workflow config.
  config/user/local/secrets/      Local secret references. Do not share.
  sessions/                       Session projection and transcript cache.
  conversation-archives/          Conversation archive exports and debug packages.
  kernel/                         Kernel ledger and runtime records.

Packaged Tauri desktop shells set DEEPCODE_CONFIG_DIR to this package root.
Direct CLI/daemon runs use the OS config root unless DEEPCODE_CONFIG_DIR is set.

Entries:
  deepcode-kernel       Rust Kernel Daemon + localhost API
$gui_entries
  deepcode              CLI Host Shell MVP over KernelClient (Linux)
  deepcode-cli          CLI Host Shell MVP over KernelClient
  deepcode-tui          TUI Host Shell MVP over KernelClient
  deepcode.cmd          Windows CLI command alias for deepcode-cli.exe

Windows GUI runtime:
  DeepCode.exe and DeepCode-GUI.exe require WebView2Loader.dll next to the
  executable. The portable distribution includes that loader DLL. The Microsoft
  Edge WebView2 Evergreen Runtime is still expected to be installed on the
  target Windows system.

Optional desktop shell:
  Tauri thin shell source lives in shells/tauri and shells/deepcode-gui. Each
  shell embeds its matching React dist, starts or connects to the same-dir
  Kernel Daemon in the background, and does not contain Agent runtime. Windows
  distribution includes DeepCode.exe and DeepCode-GUI.exe. The desktop shell
  chooses an available localhost port by default; set DEEPCODE_PORT to force a
  fixed port such as 31245.

Run the Linux GUI launcher or force DEEPCODE_PORT=31245, then open:
  http://127.0.0.1:31245/

The internal browser, Chrome, or any regular browser can open that URL. The
browser is only a Host client; the Kernel remains the fact source.

Health check:
  http://127.0.0.1:31245/api/health
README
}

clear_package_generated_dir() {
  local path="$1"
  mkdir -p "$path"
  find "$path" -mindepth 1 -delete 2>/dev/null || true
}

clean_package_generated_outputs() {
  local dist_dir="$1"
  local platform="$2"
  echo "==[build][package]== clean $platform generated outputs; preserve config/sessions/conversation-archives/kernel"

  clear_package_generated_dir "$dist_dir/web"
  clear_package_generated_dir "$dist_dir/web-deepcode-gui"
  clear_package_generated_dir "$dist_dir/packs"

  local files=(
    "$dist_dir/README.txt"
    "$dist_dir/build-info.json"
    "$dist_dir/deepcode"
    "$dist_dir/deepcode-cli"
    "$dist_dir/deepcode-gui"
    "$dist_dir/deepcode-kernel"
    "$dist_dir/deepcode-tui"
    "$dist_dir/DeepCode"
    "$dist_dir/deepcode-cli.bat"
    "$dist_dir/deepcode-tui.bat"
    "$dist_dir/deepcode.cmd"
    "$dist_dir/deepcode-cli.exe"
    "$dist_dir/deepcode-kernel.exe"
    "$dist_dir/deepcode-tui.exe"
    "$dist_dir/DeepCode.exe"
    "$dist_dir/DeepCode-GUI.exe"
    "$dist_dir/WebView2Loader.dll"
  )
  rm -f "${files[@]}"
}

package_distribution() {
  echo "==[build][package]== prepare bin/linux-x64 and bin/win64 directories"
  validate_package_inputs
  mkdir -p "$LINUX_DIR" "$WIN_DIR"
  clean_package_generated_outputs "$LINUX_DIR" "linux-x64"
  clean_package_generated_outputs "$WIN_DIR" "win64"

  prepare_distribution_tree "$LINUX_DIR"
  prepare_distribution_tree "$WIN_DIR"

  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" "$LINUX_DIR/deepcode-kernel" \
    "run ./build.sh --stage kernel first"
  chmod +x "$LINUX_DIR/deepcode-kernel"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-cli" "$LINUX_DIR/deepcode-cli" \
    "run ./build.sh --stage kernel first"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-cli" "$LINUX_DIR/deepcode" \
    "run ./build.sh --stage kernel first"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-tui" "$LINUX_DIR/deepcode-tui" \
    "run ./build.sh --stage kernel first"
  chmod +x "$LINUX_DIR/deepcode-cli" "$LINUX_DIR/deepcode" "$LINUX_DIR/deepcode-tui"

  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-kernel-daemon.exe" "$WIN_DIR/deepcode-kernel.exe" \
    "run ./build.sh --stage kernel first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-cli.exe" "$WIN_DIR/deepcode-cli.exe" \
    "run ./build.sh --stage kernel first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-tui.exe" "$WIN_DIR/deepcode-tui.exe" \
    "run ./build.sh --stage kernel first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode.exe" "$WIN_DIR/DeepCode.exe" \
    "run ./build.sh --stage tauri first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode-GUI.exe" "$WIN_DIR/DeepCode-GUI.exe" \
    "run ./build.sh --stage deepcode-gui-tauri first"
  validate_frontend_dist "$WIN_DIR/web-deepcode-gui" "DeepCode-GUI packaged assets" "deepcode-gui"

  local webview2_loader_dll
  webview2_loader_dll="$(find_webview2_loader_dll)"
  if [ ! -f "$webview2_loader_dll" ]; then
    echo "==[build][error]== WebView2Loader.dll was not found in Windows Tauri build output" >&2
    exit 1
  fi
  cp -v "$webview2_loader_dll" "$WIN_DIR/WebView2Loader.dll"

  echo "==[build][package]== generate host launchers"
  cat > "$LINUX_DIR/deepcode-gui" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEEPCODE_CLIENT_DIST="${DEEPCODE_CLIENT_DIST:-$SCRIPT_DIR/web}"
export DEEPCODE_HOST="${DEEPCODE_HOST:-127.0.0.1}"
export DEEPCODE_PORT="${DEEPCODE_PORT:-31245}"
"$SCRIPT_DIR/deepcode-kernel" "$@"
LAUNCHER
  chmod +x "$LINUX_DIR/deepcode-gui"

  cat > "$WIN_DIR/deepcode-cli.bat" <<'LAUNCHER'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if not defined DEEPCODE_HOST set "DEEPCODE_HOST=127.0.0.1"
if not defined DEEPCODE_PORT set "DEEPCODE_PORT=31245"
"%SCRIPT_DIR%deepcode-cli.exe" %*
LAUNCHER

  cat > "$WIN_DIR/deepcode-tui.bat" <<'LAUNCHER'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if not defined DEEPCODE_HOST set "DEEPCODE_HOST=127.0.0.1"
if not defined DEEPCODE_PORT set "DEEPCODE_PORT=31245"
"%SCRIPT_DIR%deepcode-tui.exe" %*
LAUNCHER

  cat > "$WIN_DIR/deepcode.cmd" <<'LAUNCHER'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if not defined DEEPCODE_HOST set "DEEPCODE_HOST=127.0.0.1"
if not defined DEEPCODE_PORT set "DEEPCODE_PORT=31245"
"%SCRIPT_DIR%deepcode-cli.exe" %*
LAUNCHER

  write_readme "$LINUX_DIR" "linux-x64"
  write_readme "$WIN_DIR" "win64"

  if [ "$BUILD_LINUX_TAURI_SHELL" = "1" ]; then
    echo "==[build][opt]== build Linux Tauri thin shell"
    configure_sccache
    run_with_cargo_fallback_shim "$ROOT_DIR/shells/tauri/src-tauri/Cargo.toml" \
      pnpm --filter @deepcode/tauri-shell tauri:build
    local tauri_release="$CARGO_TARGET_ROOT/release/DeepCode"
    if [ -x "$tauri_release" ]; then
      cp -v "$tauri_release" "$LINUX_DIR/DeepCode"
      chmod +x "$LINUX_DIR/DeepCode"
    else
      echo "==[build][opt]== Tauri shell build completed, but no Linux release binary was found at $tauri_release"
    fi
  else
    echo "==[build][opt]== Linux Tauri shell build skipped; set DEEPCODE_BUILD_LINUX_TAURI_SHELL=1 to enable"
  fi
}

if [ "$run_deps" = "1" ]; then
  run_pnpm_install
fi

if [ "$run_gui" = "1" ]; then
  build_gui
fi

if [ "$run_deepcode_gui" = "1" ]; then
  build_deepcode_gui
fi

if [ "$run_daemon" = "1" ]; then
  build_daemon
fi

if [ "$run_cli" = "1" ]; then
  build_cli
fi

if [ "$run_tui" = "1" ]; then
  build_tui
fi

if [ "$run_tauri" = "1" ]; then
  build_tauri
fi

if [ "$run_deepcode_gui_tauri" = "1" ]; then
  build_deepcode_gui_tauri
fi

if [ "$run_package" = "1" ]; then
  package_distribution
  auto_submit_macos_package_request
fi

echo ""
echo "==[build]== DONE"
if [ -d "$LINUX_DIR" ] || [ -d "$WIN_DIR" ]; then
  find "$LINUX_DIR" "$WIN_DIR" -maxdepth 2 -type f 2>/dev/null | sort || true
fi
