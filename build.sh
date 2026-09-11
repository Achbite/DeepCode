#!/usr/bin/env bash
# ====================================================================
# DeepCode cross-platform unified build script
# 常规 Linux/Windows 构建在 Docker 中执行；macOS .app 打包入口在 macOS 宿主机执行。
#
# 默认行为：
#   bash ./build.sh
#     macOS：生成 bin/macos-arm64/；前端在 Docker 内编译，原生包在 Mac 上生成。
#     WSL/Linux：在 Docker 内构建当前 Linux 架构目录与 bin/win64/。
#     make shell 会向容器传入宿主平台，容器内使用相同的默认选择。
#
# 分阶段入口：
#   bash ./build.sh --stage gui      # pnpm + React GUI + Tauri embedded dist
#   bash ./build.sh --stage deepcode-gui # pnpm + DeepCode-GUI dist
#   bash ./build.sh --stage macos-package-service # macOS host: start package worker
#   bash ./build.sh --stage package-macos # macOS host/Docker request: build complete macOS app set
#   bash ./build.sh --stage package-macos-deepcode-gui # macOS host: refresh DeepCode-GUI.app and existing sibling apps
#   bash ./build.sh --stage daemon   # Linux/Windows Rust Kernel daemon
#   bash ./build.sh --stage cli      # Linux/Windows CLI Host shell
#   bash ./build.sh --stage tui      # Linux/Windows TUI Host shell
#   bash ./build.sh --stage tauri    # Windows DeepCode.exe Tauri thin shell
#   bash ./build.sh --stage deepcode-gui-tauri # Windows DeepCode-GUI.exe Tauri shell
#   bash ./build.sh --stage package  # 从源码构建当前宿主平台的分发产物
#   bash ./build.sh --stage verify-package-runtime # 只读检查已打包 runtime 是否齐全
#   bash ./build.sh --stage all      # 等价默认完整构建
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
#   --clean-cache               清理 macOS 打包缓存后重新打包；保留用户配置和会话数据。
#   --no-kill-running           macOS 打包时不自动结束旧 .app 占用进程。
# ====================================================================
set -euo pipefail

export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export CI="${CI:-true}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$ROOT_DIR/scripts/source-identity.sh"

is_docker_environment() {
  [ -f /.dockerenv ] && return 0
  grep -qaE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null
}

BUILD_HOST_OS="$(uname -s)"
if is_docker_environment; then
  BUILD_HOST_OS="${DEEPCODE_BUILD_HOST_OS:-Linux}"
fi
case "$BUILD_HOST_OS" in
  Darwin|Linux) ;;
  *) echo "==[build][error]== unsupported build host: $BUILD_HOST_OS" >&2; exit 3 ;;
esac

BIN_ROOT="$ROOT_DIR/bin"
case "$(uname -m)" in
  x86_64|amd64) LINUX_PLATFORM="linux-x64" ;;
  aarch64|arm64) LINUX_PLATFORM="linux-arm64" ;;
  *) echo "==[build][error]== unsupported build architecture: $(uname -m)" >&2; exit 3 ;;
esac
LINUX_DIR="$BIN_ROOT/$LINUX_PLATFORM"
WIN_DIR="$BIN_ROOT/win64"
CLIENT_DIR="$ROOT_DIR/userspace/gui"
WINDOWS_TARGET="x86_64-pc-windows-gnu"
SESSION_BRIDGE_NAME="sessionServiceBridge.js"

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
if [ -n "${PNPM_STORE_DIR:-}" ]; then
  PNPM_STORE_DIR="$PNPM_STORE_DIR"
elif [ -f /.dockerenv ] && [ -d /root/.local/share/pnpm/store ]; then
  PNPM_STORE_DIR="/root/.local/share/pnpm/store"
else
  PNPM_STORE_DIR="$ROOT_DIR/.pnpm-store"
fi
PNPM_REGISTRY="${DEEPCODE_PNPM_REGISTRY:-https://registry.yarnpkg.com}"
PNPM_NETWORK_CONCURRENCY="${DEEPCODE_PNPM_NETWORK_CONCURRENCY:-4}"
PNPM_FETCH_RETRIES="${DEEPCODE_PNPM_FETCH_RETRIES:-2}"
PNPM_FETCH_RETRY_MINTIMEOUT_MS="${DEEPCODE_PNPM_FETCH_RETRY_MINTIMEOUT_MS:-5000}"
PNPM_FETCH_RETRY_MAXTIMEOUT_MS="${DEEPCODE_PNPM_FETCH_RETRY_MAXTIMEOUT_MS:-15000}"
PNPM_FETCH_TIMEOUT_MS="${DEEPCODE_PNPM_FETCH_TIMEOUT_MS:-30000}"
BUILD_LINUX_TAURI_SHELL="${DEEPCODE_BUILD_LINUX_TAURI_SHELL:-0}"
CARGO_WITH_FALLBACK="$ROOT_DIR/scripts/cargo-with-fallback.sh"

export CARGO_TARGET_DIR="$CARGO_TARGET_ROOT"
export TMPDIR="$BUILD_TMPDIR"

cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  bash ./build.sh [--stage all|gui|deepcode-gui|deepcode-gui-tauri|macos-package-service|package-macos|package-macos-deepcode-gui|daemon|cli|tui|tauri|package|verify-package-runtime]...
  bash ./build.sh --stage macos-package-service
  bash ./build.sh --full
  bash ./build.sh --stage package-macos --clean-cache

Default:
  macOS: build current-source macOS apps and shared runtime in bin/macos-arm64/.
  WSL/Linux: build Linux and Windows distribution artifacts in Docker.
  make shell passes the host platform into Docker for the same default selection.
  --full, --stage all and --stage package use this platform selection too.

Environment:
  DEEPCODE_BUILD_HOST_OS            Host OS passed into Docker by make shell.
                                    Darwin selects macOS; Linux selects Linux/Windows.
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
  SCCACHE_DIR                       Override local sccache cache directory.
                                    Docker default prefers CARGO_TARGET_DIR/.sccache
                                    on native Docker volumes, otherwise
                                    falls back to /tmp/deepcode-sccache.
  DEEPCODE_RESET_SCCACHE_SERVER=0   Do not stop an existing Docker sccache
                                    server before first use.
  DEEPCODE_BUILD_LINUX_TAURI_SHELL=1 Build optional Linux Tauri shell.
  DEEPCODE_MACOS_PACKAGE_TIMEOUT_SECONDS
                                      Timeout for macOS package service requests.
  DEEPCODE_MACOS_PRODUCTS=DeepCode-GUI,DeepCode
                                      Comma/space separated macOS app set for package-macos.
  --clean-cache                     Clean macOS package build artifacts without deleting current config/runtime data.
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
  requested_stages=("all")
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
run_verify_package_runtime=0
SCCACHE_SERVER_RESET_DONE=0
SCCACHE_CONFIGURED=0

enable_stage() {
  case "$1" in
    all)
      if [ "$BUILD_HOST_OS" = "Darwin" ]; then
        run_package_macos=1
      else
        run_deps=1
        run_gui=1
        run_deepcode_gui=1
        run_daemon=1
        run_cli=1
        run_tui=1
        run_tauri=1
        run_deepcode_gui_tauri=1
        run_package=1
      fi
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
      run_gui=1
      run_tauri=1
      ;;
    deepcode-gui-tauri)
      run_deps=1
      run_deepcode_gui=1
      run_deepcode_gui_tauri=1
      ;;
    package)
      enable_stage all
      ;;
    verify-package-runtime)
      run_verify_package_runtime=1
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
echo "==[build]== host platform: $BUILD_HOST_OS"
echo "==[build]== CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "==[build]== TMPDIR=$TMPDIR"
echo "==[build]== PNPM_STORE_DIR=$PNPM_STORE_DIR"
echo "==[build]== PNPM_REGISTRY=$PNPM_REGISTRY"
echo "==[build]== DEEPCODE_BUILD_LINUX_TAURI_SHELL=$BUILD_LINUX_TAURI_SHELL"
echo "==[build]== clean-cache=$clean_cache"
echo "==[build]== stages: deps=$run_deps gui=$run_gui deepcode-gui=$run_deepcode_gui deepcode-gui-tauri=$run_deepcode_gui_tauri package-macos=$run_package_macos package-macos-deepcode-gui=$run_package_macos_deepcode_gui macos-package-service=$run_macos_package_service daemon=$run_daemon cli=$run_cli tui=$run_tui tauri=$run_tauri package=$run_package verify-package-runtime=$run_verify_package_runtime"

run_macos_package_products_from_host() {
  local products_csv
  local product
  if is_docker_environment; then
    echo "==[build][error]== macOS package stages must run on the macOS host, not inside Docker." >&2
    exit 3
  fi
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "==[build][error]== macOS package stages require a macOS host." >&2
    exit 3
  fi

  products_csv="$(IFS=,; printf '%s' "$*")"
  echo "==[build][package-macos]== package product set on macOS host: $products_csv"
  if [ "$clean_cache" = "1" ]; then
    env DEEPCODE_MACOS_CLEAN=1 DEEPCODE_MACOS_KILL_RUNNING="$kill_running" DEEPCODE_MACOS_PRODUCTS="$products_csv" bash ./scripts/package-macos.sh
  else
    env DEEPCODE_MACOS_KILL_RUNNING="$kill_running" DEEPCODE_MACOS_PRODUCTS="$products_csv" bash ./scripts/package-macos.sh
  fi
  echo ""
  echo "==[build]== DONE"
  for product in "$@"; do
    echo "$BIN_ROOT/macos-arm64/$product.app"
  done
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
  local raw="${DEEPCODE_MACOS_PRODUCTS:-DeepCode-GUI,DeepCode}"
  raw="${raw//,/ }"

  local product
  for product in $raw; do
    add_macos_product "$product"
  done
  add_published_macos_products
  if [ "${#resolved_macos_products[@]}" -eq 0 ]; then
    echo "==[build][error]== empty macOS product list" >&2
    exit 2
  fi
}

add_published_macos_products() {
  [ ! -d "$BIN_ROOT/macos-arm64/DeepCode-GUI.app" ] || add_macos_product "DeepCode-GUI"
  [ ! -d "$BIN_ROOT/macos-arm64/DeepCode.app" ] || add_macos_product "DeepCode"
}

resolve_deepcode_gui_products() {
  resolved_macos_products=()
  add_macos_product "DeepCode-GUI"
  add_published_macos_products
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
  local products_csv
  local timeout="${DEEPCODE_MACOS_PACKAGE_TIMEOUT_SECONDS:-3600}"
  products_csv="$(IFS=,; printf '%s' "$*")"
  local args=(submit --products "$products_csv" --timeout-seconds "$timeout" --wait)
  if [ "$clean_cache" = "1" ]; then
    args+=(--clean)
  fi
  if [ "$kill_running" = "0" ]; then
    args+=(--no-kill-running)
  fi
  if ! macos_package_service_is_running; then
    echo "==[build][error]== macOS package service is not running." >&2
    echo "==[build][error]== Run on the macOS host first: bash ./build.sh --stage macos-package-service" >&2
    exit 3
  fi

  echo "==[build][package-macos]== submit product set to macOS package service: $products_csv"
  bash ./scripts/macos-package-service.sh "${args[@]}"
}

host_macos_stage_count=$((run_package_macos + run_package_macos_deepcode_gui))
if [ "$run_macos_package_service" = "1" ]; then
  if [ "$host_macos_stage_count" -gt 0 ] || [ "$run_deps" = "1" ] || [ "$run_gui" = "1" ] || \
    [ "$run_deepcode_gui" = "1" ] || [ "$run_daemon" = "1" ] || [ "$run_cli" = "1" ] || \
    [ "$run_tui" = "1" ] || [ "$run_tauri" = "1" ] || [ "$run_deepcode_gui_tauri" = "1" ] || \
    [ "$run_package" = "1" ] || [ "$run_verify_package_runtime" = "1" ]; then
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
    [ "$run_tauri" = "1" ] || [ "$run_deepcode_gui_tauri" = "1" ] || [ "$run_package" = "1" ] || \
    [ "$run_verify_package_runtime" = "1" ]; then
    echo "==[build][error]== macOS package stages are host orchestration stages; run them by themselves." >&2
    exit 2
  fi
  if [ "$run_package_macos" = "1" ]; then
    resolve_macos_products
    if is_docker_environment; then
      submit_macos_package_request "${resolved_macos_products[@]}"
    else
      run_macos_package_products_from_host "${resolved_macos_products[@]}"
    fi
  else
    resolve_deepcode_gui_products
    if is_docker_environment; then
      submit_macos_package_request "${resolved_macos_products[@]}"
    else
      run_macos_package_products_from_host "${resolved_macos_products[@]}"
    fi
  fi
  exit 0
fi

if [ "$clean_cache" = "1" ]; then
  echo "==[build][error]== --clean-cache is only supported with --stage package-macos or --stage package-macos-deepcode-gui." >&2
  exit 2
fi

docker_build_stage_count=$((run_deps + run_gui + run_deepcode_gui + run_daemon + run_cli + run_tui + run_tauri + run_deepcode_gui_tauri + run_package))
if [ "$docker_build_stage_count" -gt 0 ]; then
  if ! is_docker_environment; then
    docker_stages="$(IFS=,; printf '%s' "${requested_stages[*]}")"
    echo "==[build]== run selected stages in the development container: $docker_stages"
    exec make --no-print-directory -C "$ROOT_DIR" _build_in_container "DEEPCODE_BUILD_STAGES=$docker_stages"
  fi
  mkdir -p "$CARGO_TARGET_DIR" "$TMPDIR"
fi

configure_sccache() {
  if [ "$SCCACHE_CONFIGURED" = "1" ]; then
    return
  fi
  SCCACHE_CONFIGURED=1

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
    if [ "$RUSTC_WRAPPER" = "sccache" ]; then
      local rustc_probe sccache_probe_status
      rustc_probe="$(rustup which rustc 2>/dev/null || command -v rustc || true)"
      sccache_probe_status=0
      sccache --start-server >/dev/null 2>&1 || sccache_probe_status=$?
      if [ "$sccache_probe_status" = "0" ] && [ -n "$rustc_probe" ]; then
        if command -v timeout >/dev/null 2>&1; then
          timeout 20s "$RUSTC_WRAPPER" "$rustc_probe" -vV >/dev/null 2>&1 || sccache_probe_status=$?
        else
          "$RUSTC_WRAPPER" "$rustc_probe" -vV >/dev/null 2>&1 || sccache_probe_status=$?
        fi
      fi
      if [ "$sccache_probe_status" != "0" ]; then
        sccache --stop-server >/dev/null 2>&1 || true
        unset RUSTC_WRAPPER
        echo "==[build][cache]== sccache failed to start; continuing without RUSTC_WRAPPER"
        return
      fi
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

validate_tauri_locked_graph() {
  local manifest_path="$1"
  local stage_name="$2"
  local output_file
  output_file="$(mktemp "$TMPDIR/deepcode-tauri-lock.XXXXXX")"

  echo "==[build][toolchain]== validate $stage_name locked dependency graph"
  if cargo_with_fallback metadata \
    --locked \
    --manifest-path "$manifest_path" \
    --format-version 1 \
    >"$output_file" 2>&1; then
    rm -f "$output_file"
    return 0
  fi

  cat "$output_file" >&2
  rm -f "$output_file"
  echo "==[build][error]== $stage_name Cargo.lock preflight failed: $manifest_path" >&2
  echo "==[build][error]== Keep the committed lockfile compatible with the repository Rust baseline; build.sh does not rewrite dependency locks." >&2
  return 1
}

run_pnpm_install() {
  echo "==[build][deps]== pnpm install"
  pnpm install --frozen-lockfile \
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
    echo "==[build][error]== userspace/gui/dist missing; run bash ./build.sh --stage gui first" >&2
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
    echo "==[build][error]== userspace/gui/dist-deepcode-gui missing; run bash ./build.sh --stage deepcode-gui first" >&2
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
    echo "==[build][error]== Rebuild the dist with bash ./build.sh --stage $stage" >&2
    exit 1
  fi
}

normalize_deepcode_gui_dist() {
  local deepcode_gui_dist="$CLIENT_DIR/dist-deepcode-gui"
  if [ -f "$deepcode_gui_dist/deepcode-gui.html" ]; then
    cp "$deepcode_gui_dist/deepcode-gui.html" "$deepcode_gui_dist/index.html"
  fi
}

FRONTEND_SHARED_READY=0

build_frontend_shared() {
  if [ "$FRONTEND_SHARED_READY" = "1" ]; then
    return
  fi
  echo "==[build][frontend-shared]== build shared userspace packages and check client types"
  pnpm build:userspace-shared
  pnpm --filter @deepcode/client typecheck
  FRONTEND_SHARED_READY=1
}

build_gui() {
  build_frontend_shared
  echo "==[build][gui]== build DeepCode web assets"
  pnpm --filter @deepcode/client build:web
  echo "==[build][gui]== prepare Tauri embedded GUI dist"
  prepare_tauri_dist
}

build_deepcode_gui() {
  build_frontend_shared
  echo "==[build][deepcode-gui]== build DeepCode-GUI web assets"
  pnpm --filter @deepcode/client build:deepcode-gui:web
  normalize_deepcode_gui_dist
  echo "==[build][deepcode-gui]== prepare DeepCode-GUI Tauri embedded dist"
  prepare_deepcode_gui_tauri_dist
}

build_daemon() {
  configure_sccache
  echo "==[build][daemon]== build Rust Kernel daemon and private Host proxy for Linux"
  cargo_with_fallback build --release -p deepcode-first-party-tools -p deepcode-kernel-daemon -p deepcode-host-web
  echo "==[build][daemon]== build Rust Kernel daemon and private Host proxy for Windows GNU"
  cargo_with_fallback build --release --target "$WINDOWS_TARGET" \
    -p deepcode-first-party-tools -p deepcode-kernel-daemon -p deepcode-host-web
  show_sccache_stats
}

build_cli() {
  configure_sccache
  echo "==[build][cli]== build Rust CLI Host shell for Linux"
  cargo_with_fallback build --release -p deepcode-cli
  echo "==[build][cli]== build Rust CLI Host shell for Windows GNU"
  cargo_with_fallback build --release --target "$WINDOWS_TARGET" -p deepcode-cli
  show_sccache_stats
}

build_tui() {
  configure_sccache
  echo "==[build][tui]== build Rust TUI Host shell for Linux"
  cargo_with_fallback build --release -p deepcode-tui
  echo "==[build][tui]== build Rust TUI Host shell for Windows GNU"
  cargo_with_fallback build --release --target "$WINDOWS_TARGET" -p deepcode-tui
  show_sccache_stats
}

build_tauri() {
  configure_sccache
  echo "==[build][tauri]== build Windows DeepCode.exe GUI shell"
  run_with_cargo_fallback_shim "$ROOT_DIR/shells/tauri/src-tauri/Cargo.toml" \
    pnpm --filter @deepcode/tauri-shell tauri:build -- --target "$WINDOWS_TARGET"
  show_sccache_stats
}

build_deepcode_gui_tauri() {
  local runtime_dist="$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/web-deepcode-gui"
  sync_deepcode_gui_runtime_assets "$runtime_dist"
  configure_sccache
  echo "==[build][deepcode-gui-tauri]== build Windows DeepCode-GUI.exe Tauri shell"
  run_with_cargo_fallback_shim "$ROOT_DIR/shells/deepcode-gui/src-tauri/Cargo.toml" \
    pnpm --filter @deepcode/deepcode-gui-shell tauri:build -- --target "$WINDOWS_TARGET"
  show_sccache_stats
}

copy_distribution_default_if_missing() {
  local src="$1"
  local dst="$2"
  [ -f "$dst" ] && return 0
  if [ ! -f "$src" ]; then
    echo "==[build][error]== portable config default missing: $src" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  install -m 644 "$src" "$dst"
}

prepare_distribution_config_root() {
  local dist_dir="$1"
  mkdir -p \
    "$dist_dir/config/user/local/settings" \
    "$dist_dir/config/user/local/secrets" \
    "$dist_dir/runtime/agent-runtime"
  copy_distribution_default_if_missing \
    "$ROOT_DIR/config/defaults/user-settings.json" \
    "$dist_dir/config/user/local/settings/user-settings.json"
  copy_distribution_default_if_missing \
    "$ROOT_DIR/config/defaults/llm-profiles.json" \
    "$dist_dir/config/user/local/settings/llm-profiles.json"
}

distribution_node_source() {
  local platform="$1"
  if [ "$platform" = "win64" ]; then
    printf '%s\n' "${DEEPCODE_WINDOWS_NODE_BIN:-/opt/deepcode-node-win64/node.exe}"
  else
    if [ -n "${DEEPCODE_LINUX_NODE_BIN:-}" ]; then
      printf '%s\n' "$DEEPCODE_LINUX_NODE_BIN"
    else
      command -v node 2>/dev/null || true
    fi
  fi
}

copy_distribution_session_runtime() {
  local dist_dir="$1"
  local platform="$2"
  local session_dist="$ROOT_DIR/userspace/session-core/dist"
  local protocol_dist="$ROOT_DIR/userspace/protocol/dist"
  local session_dst="$dist_dir/session-core"
  local protocol_dst="$dist_dir/node_modules/@deepcode/protocol"
  local node_src
  local node_dst

  require_package_file "$session_dist/$SESSION_BRIDGE_NAME" \
    "run pnpm --filter @deepcode/session-core build first" || exit 1
  require_package_dir "$protocol_dist" \
    "run pnpm --filter @deepcode/protocol build first" || exit 1
  verify_protocol_runtime "$protocol_dist" "source protocol runtime" || exit 1

  rm -rf "$session_dst" "$dist_dir/node_modules" "$dist_dir/node"
  mkdir -p "$session_dst/dist" "$protocol_dst/dist" "$dist_dir/node/bin"
  cp -R "$session_dist/." "$session_dst/dist/"
  cp -R "$protocol_dist/." "$protocol_dst/dist/"
  cp "$ROOT_DIR/userspace/session-core/package.json" "$session_dst/package.json"
  cp "$ROOT_DIR/userspace/protocol/package.json" "$protocol_dst/package.json"
  printf 'import "./dist/%s";\n' "$SESSION_BRIDGE_NAME" > "$session_dst/$SESSION_BRIDGE_NAME"
  chmod 644 "$session_dst/$SESSION_BRIDGE_NAME"
  verify_protocol_runtime "$protocol_dst/dist" "packaged $platform protocol runtime" || exit 1

  node_src="$(distribution_node_source "$platform")"
  if [ ! -f "$node_src" ]; then
    echo "==[build][error]== packaged $platform Node runtime source not found: ${node_src:-<empty>}" >&2
    exit 1
  fi
  if [ "$platform" = "win64" ]; then
    node_dst="$dist_dir/node/bin/node.exe"
    install -m 644 "$node_src" "$node_dst"
  else
    node_dst="$dist_dir/node/bin/node"
    install -m 755 "$node_src" "$node_dst"
    local node_major
    node_major="$("$node_dst" -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"
    if [ "$node_major" -lt 20 ] 2>/dev/null; then
      echo "==[build][error]== packaged Linux Node runtime must be 20+: $("$node_dst" --version 2>/dev/null || printf unknown)" >&2
      exit 1
    fi
  fi
}

runtime_sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  else
    shasum -a 256 | awk '{ print $1 }'
  fi
}

distribution_source_fingerprint() {
  deepcode_source_fingerprint "$ROOT_DIR"
}

PACKAGE_BUILD_COMMIT=""
PACKAGE_BUILD_TIME_UTC=""
PACKAGE_SOURCE_DIRTY=""
PACKAGE_SOURCE_STATUS_HASH=""
PACKAGE_SOURCE_FINGERPRINT=""
PACKAGE_PRODUCT_VERSION=""

prepare_distribution_build_identity() {
  [ -z "$PACKAGE_BUILD_COMMIT" ] || return 0
  PACKAGE_BUILD_COMMIT="$(deepcode_source_commit "$ROOT_DIR" 2>/dev/null || printf unknown)"
  PACKAGE_BUILD_TIME_UTC="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  local source_dirty
  source_dirty="$(deepcode_source_dirty "$ROOT_DIR")"
  if [ "$source_dirty" = "1" ]; then
    PACKAGE_SOURCE_DIRTY=true
  else
    PACKAGE_SOURCE_DIRTY=false
  fi
  PACKAGE_SOURCE_STATUS_HASH="$(deepcode_source_status_hash "$ROOT_DIR")"
  PACKAGE_SOURCE_FINGERPRINT="$(distribution_source_fingerprint)"
  PACKAGE_PRODUCT_VERSION="$(awk -F '"' '/"version"[[:space:]]*:/ { print $4; exit }' "$ROOT_DIR/package.json")"
}

write_distribution_build_info() {
  local dist_dir="$1"
  local product="$2"
  prepare_distribution_build_identity
  cat > "$dist_dir/build-info.json" <<JSON
{
  "buildCommit": "$PACKAGE_BUILD_COMMIT",
  "buildTimeUtc": "$PACKAGE_BUILD_TIME_UTC",
  "sourceDirty": $PACKAGE_SOURCE_DIRTY,
  "sourceStatusHash": "$PACKAGE_SOURCE_STATUS_HASH",
  "sourceFingerprint": "$PACKAGE_SOURCE_FINGERPRINT",
  "sessionBridge": "$SESSION_BRIDGE_NAME",
  "product": "$product",
  "productVersion": "$PACKAGE_PRODUCT_VERSION"
}
JSON
}

prepare_distribution_tree() {
  local dist_dir="$1"
  local platform="$2"
  prepare_distribution_config_root "$dist_dir"
  mkdir -p "$dist_dir/web" "$dist_dir/web-deepcode-gui"
  copy_distribution_session_runtime "$dist_dir" "$platform"
  write_distribution_build_info "$dist_dir" "$platform"

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
  require_package_dir "$CLIENT_DIR/dist" "run bash ./build.sh --stage gui first" || missing=1
  require_package_dir "$CLIENT_DIR/dist-deepcode-gui" "run bash ./build.sh --stage deepcode-gui first" || missing=1
  require_package_file "$ROOT_DIR/userspace/session-core/dist/$SESSION_BRIDGE_NAME" \
    "run pnpm --filter @deepcode/session-core build first" || missing=1
  require_package_file "$ROOT_DIR/userspace/session-core/package.json" \
    "Session runtime package metadata is missing" || missing=1
  require_package_dir "$ROOT_DIR/userspace/protocol/dist" \
    "run pnpm --filter @deepcode/protocol build first" || missing=1
  require_package_file "$ROOT_DIR/userspace/protocol/package.json" \
    "protocol runtime package metadata is missing" || missing=1
  require_package_file "$ROOT_DIR/config/defaults/user-settings.json" \
    "portable user settings default is missing" || missing=1
  require_package_file "$ROOT_DIR/config/defaults/llm-profiles.json" \
    "portable LLM Profile default is missing" || missing=1
  local linux_node_source windows_node_source
  linux_node_source="$(distribution_node_source "$LINUX_PLATFORM")"
  windows_node_source="$(distribution_node_source win64)"
  require_package_file "$linux_node_source" \
    "Linux Node 20+ runtime is required for the Session service" || missing=1
  require_package_file "$windows_node_source" \
    "Windows node.exe runtime is required for the Session service" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/release/deepcode-first-party-provider" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/release/deepcode-host-web" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/release/deepcode-cli" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/release/deepcode-tui" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-kernel-daemon.exe" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-first-party-provider.exe" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-host-web.exe" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-cli.exe" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-tui.exe" "run bash ./build.sh --stage daemon --stage cli --stage tui first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode.exe" "run bash ./build.sh --stage tauri first" || missing=1
  require_package_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode-GUI.exe" "run bash ./build.sh --stage deepcode-gui-tauri first" || missing=1
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

verify_runtime_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    echo "==[build][verify-package-runtime][error]== missing $label: $path" >&2
    return 1
  fi
  echo "==[build][verify-package-runtime]== ok $label: $path"
}

verify_runtime_executable() {
  local path="$1"
  local label="$2"
  if [ ! -x "$path" ]; then
    echo "==[build][verify-package-runtime][error]== missing executable $label: $path" >&2
    return 1
  fi
  echo "==[build][verify-package-runtime]== ok $label: $path"
}

verify_runtime_dir() {
  local path="$1"
  local label="$2"
  if [ ! -d "$path" ]; then
    echo "==[build][verify-package-runtime][error]== missing $label: $path" >&2
    return 1
  fi
  echo "==[build][verify-package-runtime]== ok $label: $path"
}

verify_protocol_runtime() {
  local dist_dir="$1"
  local label="$2"
  local required
  local failed=0
  for required in index.js localAgent.js tools.js; do
    verify_runtime_file "$dist_dir/$required" "$label $required" || failed=1
  done
  if [ -d "$dist_dir" ] && find "$dist_dir" -maxdepth 1 -type f \
    -name 'agent.*' -print -quit | grep -q .; then
    echo "==[build][verify-package-runtime][error]== $label contains a retired Agent protocol module" >&2
    failed=1
  fi
  return "$failed"
}

verify_llm_profiles_current() {
  local profiles_path="$1"
  local node_bin="$2"
  local label="$3"
  if [ ! -f "$profiles_path" ]; then
    echo "==[build][verify-package-runtime][error]== missing $label: $profiles_path" >&2
    return 1
  fi
  if [ ! -x "$node_bin" ]; then
    echo "==[build][verify-package-runtime][error]== cannot validate $label without packaged Node: $node_bin" >&2
    return 1
  fi
  if ! "$node_bin" - "$profiles_path" <<'NODE'
const fs = require('node:fs');

const path = process.argv[2];
const rootFields = new Set(['profiles', 'defaultProfileId']);
const profileFields = new Set([
  'id',
  'name',
  'kind',
  'providerFlavor',
  'baseUrl',
  'model',
  'contextWindowTokens',
  'maxOutputTokens',
  'temperature',
  'reasoningEffort',
  'thinking',
  'hostedWebSearch',
  'secretRef',
  'enabled',
]);
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTrimmedNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isOptionalTrimmedNonEmptyString(record, field) {
  return !(field in record) || isTrimmedNonEmptyString(record[field]);
}

function isLocalSecretRef(value) {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  const prefix = 'local-secret:';
  if (!value.startsWith(prefix)) return false;
  const key = value.slice(prefix.length);
  return key.length > 0 && key.trim() === key;
}

function isOptionalPositiveInteger(record, field) {
  if (!(field in record)) return true;
  const value = record[field];
  return Number.isInteger(value) && value > 0 && value <= 1_000_000_000;
}

function reject(message) {
  throw new Error(message);
}

try {
  const config = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!isRecord(config)) reject('root must be an object');
  const rootKeys = Object.keys(config);
  if (
    rootKeys.length !== rootFields.size
    || rootKeys.some((field) => !rootFields.has(field))
  ) {
    reject('root must contain only profiles and defaultProfileId');
  }
  if (!Array.isArray(config.profiles)) reject('profiles must be an array');

  const profilesById = new Map();
  for (const [index, profile] of config.profiles.entries()) {
    if (!isRecord(profile)) reject(`profiles[${index}] must be an object`);
    if (Object.keys(profile).some((field) => !profileFields.has(field))) {
      reject(`profiles[${index}] contains an unsupported field`);
    }
    for (const field of ['id', 'name', 'model']) {
      if (!isTrimmedNonEmptyString(profile[field])) {
        reject(`profiles[${index}].${field} must be a trimmed non-empty string`);
      }
    }
    if (profilesById.has(profile.id)) reject(`duplicate profile id: ${profile.id}`);
    profilesById.set(profile.id, profile);
    if (typeof profile.enabled !== 'boolean') {
      reject(`profiles[${index}].enabled must be a boolean`);
    }
    if (!['openaiCompatible', 'responses', 'anthropic', 'ollama'].includes(profile.kind)) {
      reject(`profiles[${index}].kind is unsupported`);
    }
    if (
      'providerFlavor' in profile
      && !['openai', 'deepseek', 'zhipu', 'moonshot'].includes(profile.providerFlavor)
    ) {
      reject(`profiles[${index}].providerFlavor is unsupported`);
    }
    if (!isOptionalTrimmedNonEmptyString(profile, 'baseUrl')) {
      reject(`profiles[${index}].baseUrl must be a trimmed non-empty string when present`);
    }
    if ('secretRef' in profile && !isLocalSecretRef(profile.secretRef)) {
      reject(`profiles[${index}].secretRef must be local-secret:<trimmed non-empty key>`);
    }
    for (const field of ['contextWindowTokens', 'maxOutputTokens']) {
      if (!isOptionalPositiveInteger(profile, field)) {
        reject(`profiles[${index}].${field} must be a bounded positive integer when present`);
      }
    }
    if (
      Number.isInteger(profile.contextWindowTokens)
      && Number.isInteger(profile.maxOutputTokens)
      && profile.maxOutputTokens >= profile.contextWindowTokens
    ) {
      reject(`profiles[${index}].maxOutputTokens must be below contextWindowTokens`);
    }
    if (
      'temperature' in profile
      && (typeof profile.temperature !== 'number' || !Number.isFinite(profile.temperature))
    ) {
      reject(`profiles[${index}].temperature must be finite when present`);
    }
    if (
      'reasoningEffort' in profile
      && !['low', 'medium', 'high', 'max'].includes(profile.reasoningEffort)
    ) {
      reject(`profiles[${index}].reasoningEffort is unsupported`);
    }
    if (
      'thinking' in profile
      && !['enabled', 'disabled'].includes(profile.thinking)
    ) {
      reject(`profiles[${index}].thinking is unsupported`);
    }
    if (
      'hostedWebSearch' in profile
      && (profile.hostedWebSearch !== 'web_search' || profile.kind !== 'responses')
    ) {
      reject(`profiles[${index}].hostedWebSearch requires responses and web_search`);
    }
  }

  if (
    config.defaultProfileId !== null
    && (
      !isTrimmedNonEmptyString(config.defaultProfileId)
      || profilesById.get(config.defaultProfileId)?.enabled !== true
    )
  ) {
    reject('defaultProfileId must be null or reference an enabled profile by exact id');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
  then
    echo "==[build][verify-package-runtime][error]== $label is not current: $profiles_path" >&2
    return 1
  fi
  echo "==[build][verify-package-runtime]== ok $label: $profiles_path"
}

verify_frontend_package_assets() {
  local dist_dir="$1"
  local label="$2"
  verify_runtime_file "$dist_dir/index.html" "$label index.html" || return 1
  if ! grep -q '<script[^>]*type="module"[^>]*assets/' "$dist_dir/index.html"; then
    echo "==[build][verify-package-runtime][error]== $label index.html has no production module entry: $dist_dir/index.html" >&2
    return 1
  fi
  echo "==[build][verify-package-runtime]== ok $label production assets"
}

runtime_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

build_info_string_field() {
  local path="$1"
  local field="$2"
  awk -F '"' -v key="\"$field\"" 'index($0, key) > 0 { print $4; exit }' "$path"
}

verify_distribution_build_identity() {
  local dist_dir="$1"
  local product="$2"
  local build_info="$dist_dir/build-info.json"
  local field value
  local failed=0
  verify_runtime_file "$build_info" "$product build-info" || return 1
  for field in buildCommit buildTimeUtc sourceStatusHash sourceFingerprint productVersion; do
    value="$(build_info_string_field "$build_info" "$field")"
    if [ -z "$value" ]; then
      echo "==[build][verify-package-runtime][error]== $product build-info has no $field" >&2
      failed=1
    fi
  done
  value="$(build_info_string_field "$build_info" sessionBridge)"
  if [ "$value" != "$SESSION_BRIDGE_NAME" ]; then
    echo "==[build][verify-package-runtime][error]== $product build-info sessionBridge=$value" >&2
    failed=1
  fi
  value="$(build_info_string_field "$build_info" product)"
  if [ "$value" != "$product" ]; then
    echo "==[build][verify-package-runtime][error]== $product build-info product=$value" >&2
    failed=1
  fi
  return "$failed"
}

verify_macos_app_identity() {
  local app_dir="$1"
  local product="$2"
  local root_kernel="$BIN_ROOT/macos-arm64/deepcode-kernel"
  local root_build_info="$BIN_ROOT/macos-arm64/build-info.json"
  local app_kernel="$app_dir/Contents/MacOS/deepcode-kernel"
  local app_build_info="$app_dir/Contents/MacOS/build-info.json"
  local field root_value app_value
  local failed=0

  [ -x "$root_kernel" ] || return 1
  [ -f "$root_build_info" ] || return 1
  [ -x "$app_kernel" ] || return 1
  verify_runtime_file "$app_build_info" "macOS $product bundled build-info" || return 1
  if [ "$(runtime_sha256 "$root_kernel")" != "$(runtime_sha256 "$app_kernel")" ]; then
    echo "==[build][verify-package-runtime][error]== macOS shared kernel and $product bundled kernel differ" >&2
    failed=1
  fi
  for field in buildCommit sourceFingerprint sessionBridge; do
    root_value="$(build_info_string_field "$root_build_info" "$field")"
    app_value="$(build_info_string_field "$app_build_info" "$field")"
    if [ -z "$root_value" ] || [ "$root_value" != "$app_value" ]; then
      echo "==[build][verify-package-runtime][error]== $product build-info $field does not match the shared package" >&2
      failed=1
    fi
  done
  root_value="$(build_info_string_field "$root_build_info" sessionBridge)"
  if [ "$root_value" != "$SESSION_BRIDGE_NAME" ]; then
    echo "==[build][verify-package-runtime][error]== macOS build-info sessionBridge=$root_value" >&2
    failed=1
  fi
  app_value="$(build_info_string_field "$app_build_info" product)"
  if [ "$app_value" != "$product" ]; then
    echo "==[build][verify-package-runtime][error]== $product build-info product=$app_value" >&2
    failed=1
  fi
  if [ "$failed" = "0" ]; then
    echo "==[build][verify-package-runtime]== ok macOS $product release identity"
  fi
  return "$failed"
}

verify_linux_package_runtime() {
  local missing=0
  [ -d "$LINUX_DIR" ] || return 2
  echo "==[build][verify-package-runtime]== check $LINUX_PLATFORM package"
  verify_runtime_executable "$LINUX_DIR/deepcode-kernel" "linux kernel" || missing=1
  verify_runtime_executable "$LINUX_DIR/deepcode-first-party-provider" "linux first-party provider" || missing=1
  verify_runtime_executable "$LINUX_DIR/deepcode-host-web" "linux private Host proxy" || missing=1
  verify_runtime_executable "$LINUX_DIR/deepcode-cli" "linux cli" || missing=1
  verify_runtime_executable "$LINUX_DIR/deepcode-tui" "linux tui" || missing=1
  verify_runtime_file "$LINUX_DIR/session-core/$SESSION_BRIDGE_NAME" "linux Session bridge" || missing=1
  verify_protocol_runtime \
    "$LINUX_DIR/node_modules/@deepcode/protocol/dist" \
    "linux protocol runtime" || missing=1
  verify_runtime_executable "$LINUX_DIR/node/bin/node" "linux packaged node" || missing=1
  verify_runtime_dir "$LINUX_DIR/runtime/agent-runtime" "linux Agent Runtime root" || missing=1
  verify_llm_profiles_current \
    "$LINUX_DIR/config/user/local/settings/llm-profiles.json" \
    "$LINUX_DIR/node/bin/node" \
    "linux LLM Profile store" || missing=1
  verify_distribution_build_identity "$LINUX_DIR" "$LINUX_PLATFORM" || missing=1
  verify_frontend_package_assets "$LINUX_DIR/web" "linux editor web" || missing=1
  verify_frontend_package_assets "$LINUX_DIR/web-deepcode-gui" "linux DeepCode-GUI web" || missing=1
  return "$missing"
}

verify_windows_package_runtime() {
  local missing=0
  local validation_node=""
  [ -d "$WIN_DIR" ] || return 2
  echo "==[build][verify-package-runtime]== check win64 package"
  verify_runtime_file "$WIN_DIR/deepcode-kernel.exe" "windows kernel" || missing=1
  verify_runtime_file "$WIN_DIR/deepcode-first-party-provider.exe" "windows first-party provider" || missing=1
  verify_runtime_file "$WIN_DIR/deepcode-host-web.exe" "windows private Host proxy" || missing=1
  verify_runtime_file "$WIN_DIR/deepcode-cli.exe" "windows cli" || missing=1
  verify_runtime_file "$WIN_DIR/deepcode-tui.exe" "windows tui" || missing=1
  verify_runtime_file "$WIN_DIR/DeepCode.exe" "windows editor shell" || missing=1
  verify_runtime_file "$WIN_DIR/DeepCode-GUI.exe" "windows DeepCode-GUI shell" || missing=1
  verify_runtime_file "$WIN_DIR/WebView2Loader.dll" "windows WebView2 loader" || missing=1
  verify_runtime_file "$WIN_DIR/session-core/$SESSION_BRIDGE_NAME" "windows Session bridge" || missing=1
  verify_protocol_runtime \
    "$WIN_DIR/node_modules/@deepcode/protocol/dist" \
    "windows protocol runtime" || missing=1
  verify_runtime_file "$WIN_DIR/node/bin/node.exe" "windows packaged node" || missing=1
  verify_runtime_dir "$WIN_DIR/runtime/agent-runtime" "windows Agent Runtime root" || missing=1
  if [ -x "$LINUX_DIR/node/bin/node" ]; then
    validation_node="$LINUX_DIR/node/bin/node"
  elif command -v node >/dev/null 2>&1; then
    validation_node="$(command -v node)"
  fi
  verify_llm_profiles_current \
    "$WIN_DIR/config/user/local/settings/llm-profiles.json" \
    "$validation_node" \
    "windows LLM Profile store" || missing=1
  verify_distribution_build_identity "$WIN_DIR" "win64" || missing=1
  verify_frontend_package_assets "$WIN_DIR/web" "windows editor web" || missing=1
  verify_frontend_package_assets "$WIN_DIR/web-deepcode-gui" "windows DeepCode-GUI web" || missing=1
  return "$missing"
}

verify_macos_package_runtime() {
  local macos_dir="$BIN_ROOT/macos-arm64"
  local missing=0
  local checked_app=0
  local validation_node=""
  [ -d "$macos_dir" ] || return 2
  echo "==[build][verify-package-runtime]== check existing macos-arm64 package structure (does not rebuild the package)"
  verify_runtime_executable "$macos_dir/deepcode-kernel" "macOS shared kernel" || missing=1
  verify_runtime_executable "$macos_dir/deepcode-first-party-provider" "macOS shared first-party provider" || missing=1
  verify_runtime_executable "$macos_dir/DeepCode-CLI.command" "macOS CLI launcher" || missing=1
  verify_runtime_executable "$macos_dir/DeepCode-TUI.command" "macOS TUI launcher" || missing=1
  verify_runtime_executable "$macos_dir/libexec/DeepCode-CLI" "macOS CLI host" || missing=1
  verify_runtime_executable "$macos_dir/libexec/DeepCode-TUI" "macOS TUI host" || missing=1
  verify_runtime_file "$macos_dir/build-info.json" "macOS shared build-info" || missing=1
  verify_runtime_file "$macos_dir/session-core/$SESSION_BRIDGE_NAME" "macOS Session bridge" || missing=1
  verify_protocol_runtime \
    "$macos_dir/node_modules/@deepcode/protocol/dist" \
    "macOS protocol runtime" || missing=1
  verify_runtime_executable "$macos_dir/node/bin/node" "macOS packaged node" || missing=1
  # The profile check only parses JSON. A Linux compile container must use a
  # Node binary for its own architecture instead of executing the packaged
  # Darwin runtime; the Darwin binary itself is validated by the host package.
  if [ "$(uname -s)" = "Darwin" ] && [ -x "$macos_dir/node/bin/node" ]; then
    validation_node="$macos_dir/node/bin/node"
  elif [ -x "$LINUX_DIR/node/bin/node" ]; then
    validation_node="$LINUX_DIR/node/bin/node"
  elif command -v node >/dev/null 2>&1; then
    validation_node="$(command -v node)"
  fi
  verify_llm_profiles_current \
    "$macos_dir/config/user/local/settings/llm-profiles.json" \
    "$validation_node" \
    "macOS LLM Profile store" || missing=1

  if [ -d "$macos_dir/DeepCode.app" ]; then
    checked_app=1
    verify_runtime_executable "$macos_dir/DeepCode.app/Contents/MacOS/DeepCode" "macOS DeepCode app shell" || missing=1
    verify_runtime_executable "$macos_dir/DeepCode.app/Contents/MacOS/deepcode-kernel" "macOS DeepCode bundled kernel" || missing=1
    verify_runtime_executable "$macos_dir/DeepCode.app/Contents/MacOS/deepcode-first-party-provider" "macOS DeepCode bundled first-party provider" || missing=1
    verify_runtime_executable "$macos_dir/DeepCode.app/Contents/MacOS/deepcode-host-web" "macOS DeepCode private Host proxy" || missing=1
    verify_frontend_package_assets "$macos_dir/DeepCode.app/Contents/MacOS/web" "macOS DeepCode bundled web" || missing=1
    verify_macos_app_identity "$macos_dir/DeepCode.app" "DeepCode" || missing=1
  fi
  if [ -d "$macos_dir/DeepCode-GUI.app" ]; then
    checked_app=1
    verify_runtime_executable "$macos_dir/DeepCode-GUI.app/Contents/MacOS/DeepCode-GUI" "macOS DeepCode-GUI app shell" || missing=1
    verify_runtime_executable "$macos_dir/DeepCode-GUI.app/Contents/MacOS/deepcode-kernel" "macOS DeepCode-GUI bundled kernel" || missing=1
    verify_runtime_executable "$macos_dir/DeepCode-GUI.app/Contents/MacOS/deepcode-first-party-provider" "macOS DeepCode-GUI bundled first-party provider" || missing=1
    verify_runtime_executable "$macos_dir/DeepCode-GUI.app/Contents/MacOS/deepcode-host-web" "macOS DeepCode-GUI private Host proxy" || missing=1
    verify_frontend_package_assets "$macos_dir/DeepCode-GUI.app/Contents/MacOS/web-deepcode-gui" "macOS DeepCode-GUI bundled web" || missing=1
    verify_macos_app_identity "$macos_dir/DeepCode-GUI.app" "DeepCode-GUI" || missing=1
  fi
  if [ "$checked_app" = "0" ]; then
    echo "==[build][verify-package-runtime][error]== macOS package root exists but no .app bundle was found in $macos_dir" >&2
    missing=1
  fi
  return "$missing"
}

verify_package_runtime() {
  local checked=0
  local missing=0
  if verify_linux_package_runtime; then
    checked=1
  else
    case "$?" in
      2) ;;
      *) checked=1; missing=1 ;;
    esac
  fi
  if verify_windows_package_runtime; then
    checked=1
  else
    case "$?" in
      2) ;;
      *) checked=1; missing=1 ;;
    esac
  fi
  if verify_macos_package_runtime; then
    checked=1
  else
    case "$?" in
      2) ;;
      *) checked=1; missing=1 ;;
    esac
  fi

  if [ "$checked" = "0" ]; then
    echo "==[build][verify-package-runtime][error]== no package directory found under $BIN_ROOT" >&2
    echo "==[build][verify-package-runtime][error]== run bash ./build.sh --stage package or ./build.sh --stage package-macos first" >&2
    exit 1
  fi
  if [ "$missing" = "1" ]; then
    exit 1
  fi
}

write_readme() {
  local dist_dir="$1"
  local platform="$2"
  local gui_entries=""
  if [ "$platform" = "win64" ]; then
    gui_entries="  DeepCode.exe          Windows Editor shell, starts the same-dir Kernel on a free localhost port
  DeepCode-GUI.exe      Windows DeepCode-GUI shell, shares the same Kernel and config"
  fi
  cat > "$dist_dir/README.txt" <<README
DeepCode Unified Distribution ($platform)
=========================================

This folder is one DeepCode host distribution. GUI, CLI, and TUI entries share
the same Rust Kernel binary, private desktop Host proxy, bundled Session runtime,
and configuration directory.
Editor assets live in web/. DeepCode-GUI assets live in web-deepcode-gui/.
The single Agent Loop and projection reducer live in the TS session-core package;
all tool effects enter the Rust Kernel through its local execution port.

Writable package-local data is preserved across package refreshes:
  config/user/local/settings/     User settings and LLM profiles.
  config/user/local/secrets/      Local secret references. Do not share.
  runtime/agent-runtime/         Catalog, Session journal, and ToolRecord stores.

Packaged Tauri desktop shells set DEEPCODE_CONFIG_DIR to this package root.
Direct CLI/daemon runs use the OS config root unless DEEPCODE_CONFIG_DIR is set.

Entries:
  deepcode-kernel       Rust Kernel Daemon + localhost API
  deepcode-first-party-provider  Out-of-process GitHub, arXiv, and PDF tools
  deepcode-host-web     Private desktop Host proxy
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
  shell embeds its matching React dist and owns the same-dir Kernel Daemon plus
  private Host proxy process tree. The Windows distribution includes
  DeepCode.exe and DeepCode-GUI.exe. The desktop shell
  chooses available localhost ports by default; set DEEPCODE_PORT to force the
  proxy port to a fixed value such as 31245.

The Linux portable distribution exposes CLI/TUI and the runtime sidecars.
Desktop GUI use requires the optional Tauri shell build. Ordinary browser
contexts intentionally receive no private Host bootstrap or capability.
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
  echo "==[build][package]== clean $platform generated outputs; preserve config/runtime/agent-runtime"

  clear_package_generated_dir "$dist_dir/web"
  clear_package_generated_dir "$dist_dir/web-deepcode-gui"
  rm -rf "$dist_dir/session-core" "$dist_dir/node_modules" "$dist_dir/node"

  local files=(
    "$dist_dir/README.txt"
    "$dist_dir/build-info.json"
    "$dist_dir/deepcode"
    "$dist_dir/deepcode-cli"
    "$dist_dir/deepcode-gui"
    "$dist_dir/deepcode-host-web"
    "$dist_dir/deepcode-first-party-provider"
    "$dist_dir/deepcode-kernel"
    "$dist_dir/deepcode-tui"
    "$dist_dir/DeepCode"
    "$dist_dir/deepcode-cli.bat"
    "$dist_dir/deepcode-tui.bat"
    "$dist_dir/deepcode.cmd"
    "$dist_dir/deepcode-cli.exe"
    "$dist_dir/deepcode-host-web.exe"
    "$dist_dir/deepcode-first-party-provider.exe"
    "$dist_dir/deepcode-kernel.exe"
    "$dist_dir/deepcode-tui.exe"
    "$dist_dir/DeepCode.exe"
    "$dist_dir/DeepCode-GUI.exe"
    "$dist_dir/WebView2Loader.dll"
  )
  rm -f "${files[@]}"
}

package_distribution() {
  echo "==[build][package]== prepare bin/$LINUX_PLATFORM and bin/win64 directories"
  validate_package_inputs
  mkdir -p "$LINUX_DIR" "$WIN_DIR"
  clean_package_generated_outputs "$LINUX_DIR" "$LINUX_PLATFORM"
  clean_package_generated_outputs "$WIN_DIR" "win64"

  prepare_distribution_tree "$LINUX_DIR" "$LINUX_PLATFORM"
  prepare_distribution_tree "$WIN_DIR" "win64"

  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" "$LINUX_DIR/deepcode-kernel" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-first-party-provider" "$LINUX_DIR/deepcode-first-party-provider" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-host-web" "$LINUX_DIR/deepcode-host-web" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  chmod +x "$LINUX_DIR/deepcode-kernel" "$LINUX_DIR/deepcode-first-party-provider" "$LINUX_DIR/deepcode-host-web"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-cli" "$LINUX_DIR/deepcode-cli" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-cli" "$LINUX_DIR/deepcode" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-tui" "$LINUX_DIR/deepcode-tui" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  chmod +x "$LINUX_DIR/deepcode-cli" "$LINUX_DIR/deepcode" "$LINUX_DIR/deepcode-tui"

  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-kernel-daemon.exe" "$WIN_DIR/deepcode-kernel.exe" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-first-party-provider.exe" "$WIN_DIR/deepcode-first-party-provider.exe" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-host-web.exe" "$WIN_DIR/deepcode-host-web.exe" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-cli.exe" "$WIN_DIR/deepcode-cli.exe" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-tui.exe" "$WIN_DIR/deepcode-tui.exe" \
    "run bash ./build.sh --stage daemon --stage cli --stage tui first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode.exe" "$WIN_DIR/DeepCode.exe" \
    "run bash ./build.sh --stage tauri first"
  copy_required_file "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode-GUI.exe" "$WIN_DIR/DeepCode-GUI.exe" \
    "run bash ./build.sh --stage deepcode-gui-tauri first"
  validate_frontend_dist "$WIN_DIR/web-deepcode-gui" "DeepCode-GUI packaged assets" "deepcode-gui"

  local webview2_loader_dll
  webview2_loader_dll="$(find_webview2_loader_dll)"
  if [ ! -f "$webview2_loader_dll" ]; then
    echo "==[build][error]== WebView2Loader.dll was not found in Windows Tauri build output" >&2
    exit 1
  fi
  cp -v "$webview2_loader_dll" "$WIN_DIR/WebView2Loader.dll"

  echo "==[build][package]== generate host launchers"
  cat > "$WIN_DIR/deepcode-cli.bat" <<'LAUNCHER'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if not defined DEEPCODE_HOST set "DEEPCODE_HOST=127.0.0.1"
"%SCRIPT_DIR%deepcode-cli.exe" %*
LAUNCHER

  cat > "$WIN_DIR/deepcode-tui.bat" <<'LAUNCHER'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if not defined DEEPCODE_HOST set "DEEPCODE_HOST=127.0.0.1"
"%SCRIPT_DIR%deepcode-tui.exe" %*
LAUNCHER

  cat > "$WIN_DIR/deepcode.cmd" <<'LAUNCHER'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if not defined DEEPCODE_HOST set "DEEPCODE_HOST=127.0.0.1"
"%SCRIPT_DIR%deepcode-cli.exe" %*
LAUNCHER

  write_readme "$LINUX_DIR" "$LINUX_PLATFORM"
  write_readme "$WIN_DIR" "win64"

  if [ "$BUILD_LINUX_TAURI_SHELL" = "1" ]; then
    echo "==[build][opt]== build Linux Tauri thin shell"
    configure_sccache
    run_with_cargo_fallback_shim "$ROOT_DIR/shells/tauri/src-tauri/Cargo.toml" \
      pnpm --filter @deepcode/tauri-shell tauri:build
    local tauri_release="$CARGO_TARGET_ROOT/release/DeepCode"
    copy_required_file "$tauri_release" "$LINUX_DIR/DeepCode" \
      "Linux Tauri shell build did not produce its release binary"
    chmod +x "$LINUX_DIR/DeepCode"
  else
    echo "==[build][opt]== Linux Tauri shell build skipped; set DEEPCODE_BUILD_LINUX_TAURI_SHELL=1 to enable"
  fi
}

if [ "$run_tauri" = "1" ] || { [ "$run_package" = "1" ] && [ "$BUILD_LINUX_TAURI_SHELL" = "1" ]; }; then
  validate_tauri_locked_graph \
    "$ROOT_DIR/shells/tauri/src-tauri/Cargo.toml" \
    "tauri"
fi

if [ "$run_deepcode_gui_tauri" = "1" ]; then
  validate_tauri_locked_graph \
    "$ROOT_DIR/shells/deepcode-gui/src-tauri/Cargo.toml" \
    "deepcode-gui-tauri"
fi

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
fi

if [ "$run_verify_package_runtime" = "1" ]; then
  verify_package_runtime
fi

echo ""
echo "==[build]== DONE"
if [ "$run_package" = "1" ]; then
  echo "==[build]== updated distributions: $LINUX_DIR, $WIN_DIR"
  find "$LINUX_DIR" "$WIN_DIR" -maxdepth 2 -type f 2>/dev/null | sort || true
else
  [ "$run_gui" != "1" ] || printf '%s\n' "$CLIENT_DIR/dist"
  [ "$run_deepcode_gui" != "1" ] || printf '%s\n' "$CLIENT_DIR/dist-deepcode-gui"
fi
