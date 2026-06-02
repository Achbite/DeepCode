#!/usr/bin/env bash
# ====================================================================
# DeepCode cross-platform unified build script
# 注意 build 环境为 Docker 中。
#
# 默认行为：
#   ./build.sh
#     完整构建并输出 bin/linux-x64/ 与 bin/win64/。
#
# 分阶段入口：
#   ./build.sh --stage gui      # pnpm + React GUI + Tauri embedded dist
#   ./build.sh --stage daemon   # Linux/Windows Rust Kernel daemon
#   ./build.sh --stage cli      # Linux/Windows CLI Host shell
#   ./build.sh --stage tui      # Linux/Windows TUI Host shell
#   ./build.sh --stage kernel   # 兼容入口：daemon + cli + tui
#   ./build.sh --stage tauri    # Windows DeepCode.exe Tauri thin shell
#   ./build.sh --stage package  # 复制已有构建产物到 bin/
#   ./build.sh --stage all      # 等价默认完整构建
#
# 缓存开关：
#   DEEPCODE_DISABLE_SCCACHE=1  禁用 sccache，回退到普通 cargo。
#   DEEPCODE_FORCE_BUILD=1      忽略 stage hash，强制执行构建阶段。
#   DEEPCODE_ALLOW_HOST_BUILD=1 显式允许宿主机直接构建（默认 Docker-only）。
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
CARGO_TARGET_ROOT="${CARGO_TARGET_DIR:-$ROOT_DIR/target}"
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$ROOT_DIR/.pnpm-store}"
BUILD_LINUX_TAURI_SHELL="${DEEPCODE_BUILD_LINUX_TAURI_SHELL:-0}"
STAGE_STAMP_DIR="$ROOT_DIR/.build-cache/build-stamps"

export CARGO_TARGET_DIR="$CARGO_TARGET_ROOT"

cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  ./build.sh [--stage all|gui|daemon|cli|tui|kernel|tauri|package]...
  ./build.sh --full

Environment:
  CARGO_TARGET_DIR                  Override shared Cargo target directory.
  PNPM_STORE_DIR                    Override pnpm store directory.
  DEEPCODE_FORCE_BUILD=1            Ignore stage hash stamps and rebuild.
  DEEPCODE_DISABLE_SCCACHE=1        Disable sccache even when available.
  DEEPCODE_ALLOW_HOST_BUILD=1       Allow non-Docker host builds explicitly.
  SCCACHE_DIR                       Override local sccache cache directory.
  DEEPCODE_BUILD_LINUX_TAURI_SHELL=1 Build optional Linux Tauri shell.
USAGE
}

requested_stages=()
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

if [ "${#requested_stages[@]}" -eq 0 ]; then
  requested_stages=("all")
fi

run_deps=0
run_gui=0
run_daemon=0
run_cli=0
run_tui=0
run_tauri=0
run_package=0

enable_stage() {
  case "$1" in
    all)
      run_deps=1
      run_gui=1
      run_daemon=1
      run_cli=1
      run_tui=1
      run_tauri=1
      run_package=1
      ;;
    deps)
      run_deps=1
      ;;
    gui)
      run_deps=1
      run_gui=1
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

echo "==[build]== DeepCode cross-platform build started at $(date -Is)"
echo "==[build]== ROOT_DIR=$ROOT_DIR"
echo "==[build]== CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "==[build]== PNPM_STORE_DIR=$PNPM_STORE_DIR"
echo "==[build]== DEEPCODE_BUILD_LINUX_TAURI_SHELL=$BUILD_LINUX_TAURI_SHELL"
echo "==[build]== stages: deps=$run_deps gui=$run_gui daemon=$run_daemon cli=$run_cli tui=$run_tui tauri=$run_tauri package=$run_package"
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

require_docker_build_environment

configure_sccache() {
  if [ "${DEEPCODE_DISABLE_SCCACHE:-0}" = "1" ]; then
    unset RUSTC_WRAPPER
    echo "==[build][cache]== sccache disabled by DEEPCODE_DISABLE_SCCACHE=1"
    return
  fi

  if command -v sccache >/dev/null 2>&1; then
    export SCCACHE_DIR="${SCCACHE_DIR:-$ROOT_DIR/.build-cache/sccache}"
    mkdir -p "$SCCACHE_DIR"
    export RUSTC_WRAPPER="${RUSTC_WRAPPER:-sccache}"
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
      kernel)
        tracked_files Cargo.toml crates/deepcode-kernel-abi crates/deepcode-kernel-core \
          crates/deepcode-kernel-runtime crates/deepcode-kernel-policy crates/deepcode-kernel-ledger \
          crates/deepcode-kernel-prompt crates/deepcode-kernel-config crates/deepcode-kernel-workflow \
          crates/deepcode-kernel-context crates/deepcode-kernel-skills crates/deepcode-kernel-audit \
          crates/deepcode-kernel-client crates/deepcode-kernel-daemon shells/cli shells/tui
        ;;
      daemon)
        tracked_files Cargo.toml crates/deepcode-kernel-abi crates/deepcode-kernel-core \
          crates/deepcode-kernel-runtime crates/deepcode-kernel-policy crates/deepcode-kernel-ledger \
          crates/deepcode-kernel-prompt crates/deepcode-kernel-config crates/deepcode-kernel-workflow \
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
  pnpm install --no-frozen-lockfile --store-dir "$PNPM_STORE_DIR"
}

prepare_tauri_dist() {
  local tauri_gui_dist="$ROOT_DIR/shells/tauri/dist"
  test -d "$CLIENT_DIR/dist" || {
    echo "==[build][error]== userspace/gui/dist missing; run ./build.sh --stage gui first" >&2
    exit 1
  }
  mkdir -p "$tauri_gui_dist"
  find "$tauri_gui_dist" -mindepth 1 -delete 2>/dev/null || true
  cp -r "$CLIENT_DIR/dist/." "$tauri_gui_dist/"
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

build_daemon() {
  if stage_should_skip daemon \
    "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" \
    "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-kernel-daemon.exe"; then
    return
  fi
  configure_sccache
  echo "==[build][daemon]== build Rust Kernel daemon for Linux"
  cargo build --release -p deepcode-kernel-daemon
  echo "==[build][daemon]== build Rust Kernel daemon for Windows GNU"
  cargo build --release --target "$WINDOWS_TARGET" -p deepcode-kernel-daemon
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
  cargo build --release -p deepcode-cli
  echo "==[build][cli]== build Rust CLI Host shell for Windows GNU"
  cargo build --release --target "$WINDOWS_TARGET" -p deepcode-cli
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
  cargo build --release -p deepcode-tui
  echo "==[build][tui]== build Rust TUI Host shell for Windows GNU"
  cargo build --release --target "$WINDOWS_TARGET" -p deepcode-tui
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
  pnpm --filter @deepcode/tauri-shell tauri:build -- --target "$WINDOWS_TARGET"
  mark_stage_built tauri
  show_sccache_stats
}

prepare_distribution_tree() {
  local dist_dir="$1"
  mkdir -p \
    "$dist_dir/config/global/prompts" \
    "$dist_dir/config/global/skills" \
    "$dist_dir/config/global/ruler" \
    "$dist_dir/packs" \
    "$dist_dir/web"

  if [ -d "$CLIENT_DIR/dist" ]; then
    cp -r "$CLIENT_DIR/dist/." "$dist_dir/web/"
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

write_readme() {
  local dist_dir="$1"
  local platform="$2"
  local gui_entry="deepcode-gui          Linux GUI host launcher"
  if [ "$platform" = "win64" ]; then
    gui_entry="DeepCode.exe          Windows GUI thin shell, starts the same-dir Kernel on a free localhost port"
  fi
  cat > "$dist_dir/README.txt" <<README
DeepCode Unified Distribution ($platform)
=========================================

This folder is one DeepCode host distribution. GUI, CLI, and TUI entries share
the same Rust Kernel binary, bundled config directory, packs directory, and web assets.
User session composition lives in the TS session-core package; all sensitive
workspace, process, skill, and context operations must enter the Kernel through
syscalls.

Writable user settings and LLM profile data are stored outside this distribution:
  Linux:   \$XDG_CONFIG_HOME/deepcode/config or ~/.config/deepcode/config
  Windows: %APPDATA%\DeepCode\config
Set DEEPCODE_CONFIG_DIR to override the writable configuration root.

Entries:
  deepcode-kernel       Rust Kernel Daemon + localhost API
  $gui_entry
  deepcode              CLI Host Shell MVP over KernelClient (Linux)
  deepcode-cli          CLI Host Shell MVP over KernelClient
  deepcode-tui          TUI Host Shell MVP over KernelClient
  deepcode.cmd          Windows CLI command alias for deepcode-cli.exe

Windows GUI runtime:
  DeepCode.exe requires WebView2Loader.dll next to the executable. The portable
  distribution includes that loader DLL. The Microsoft Edge WebView2 Evergreen
  Runtime is still expected to be installed on the target Windows system.

Optional desktop shell:
  Tauri thin shell source lives in shells/tauri. It embeds the same React GUI as
  the browser host, starts or connects to the same-dir Kernel Daemon in the
  background, and does not contain Agent runtime. Windows distribution includes
  DeepCode.exe. The desktop shell chooses an available localhost port by
  default; set DEEPCODE_PORT to force a fixed port such as 31245.

Run the Linux GUI launcher or force DEEPCODE_PORT=31245, then open:
  http://127.0.0.1:31245/

Codex internal browser, Chrome, or any regular browser can open that URL. The
browser is only a Host client; the Kernel remains the fact source.

Health check:
  http://127.0.0.1:31245/api/health
README
}

package_distribution() {
  echo "==[build][package]== prepare bin/linux-x64 and bin/win64 directories"
  mkdir -p "$LINUX_DIR" "$WIN_DIR"
  find "$LINUX_DIR" -mindepth 1 -delete 2>/dev/null || true
  find "$WIN_DIR" -mindepth 1 -delete 2>/dev/null || true

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

  local webview2_loader_dll="$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/WebView2Loader.dll"
  if [ ! -f "$webview2_loader_dll" ]; then
    webview2_loader_dll="$(find "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/build" \
      -path '*/out/x64/WebView2Loader.dll' \
      -type f \
      | head -n 1)"
  fi
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

if [ "$run_package" = "1" ]; then
  package_distribution
fi

echo ""
echo "==[build]== DONE"
if [ -d "$LINUX_DIR" ] || [ -d "$WIN_DIR" ]; then
  find "$LINUX_DIR" "$WIN_DIR" -maxdepth 2 -type f 2>/dev/null | sort || true
fi
