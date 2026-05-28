#!/usr/bin/env bash
# ====================================================================
# DeepCode cross-platform unified build script
#
# 输出统一内核分发目录：
#   bin/linux-x64/
#     deepcode-kernel        Rust Kernel + Web Host
#     deepcode-gui           GUI 入口脚本（共享同一 Kernel）
#     deepcode-cli           CLI 入口脚本（后续接同一 Kernel）
#     deepcode-tui           TUI 入口脚本（后续接同一 Kernel）
#     web/                   React 静态资源
#     config/ packs/         默认配置与 Pack 目录
#
#   bin/win64/
#     deepcode-kernel.exe    Windows GNU 交叉编译产物
#     DeepCode.exe           Windows GUI thin shell（启动同目录 Kernel）
#     WebView2Loader.dll     Tauri/WebView2 loader，DeepCode.exe 运行必需
#     deepcode-cli.bat       CLI 入口脚本（后续接同一 Kernel）
#     deepcode-tui.bat       TUI 入口脚本（后续接同一 Kernel）
#     web/                   React 静态资源
#     config/ packs/         默认配置与 Pack 目录
#
# 旧 Node 服务打包链路不再进入默认构建。
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

export CARGO_TARGET_DIR="$CARGO_TARGET_ROOT"

cd "$ROOT_DIR"

echo "==[build]== DeepCode cross-platform build started at $(date -Is)"
echo "==[build]== ROOT_DIR=$ROOT_DIR"
echo "==[build]== CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "==[build]== PNPM_STORE_DIR=$PNPM_STORE_DIR"
echo "==[build]== DEEPCODE_BUILD_LINUX_TAURI_SHELL=$BUILD_LINUX_TAURI_SHELL"

echo "==[build][1/7]== pnpm install"
pnpm install --no-frozen-lockfile --store-dir "$PNPM_STORE_DIR"

echo "==[build][2/7]== build TS user/session/UI packages"
pnpm --filter @deepcode/protocol build
pnpm --filter @deepcode/session-core build
pnpm --filter @deepcode/client build

echo "==[build][2b/7]== prepare Tauri embedded GUI dist"
TAURI_GUI_DIST="$ROOT_DIR/shells/tauri/dist"
mkdir -p "$TAURI_GUI_DIST"
find "$TAURI_GUI_DIST" -mindepth 1 -delete 2>/dev/null || true
cp -r "$CLIENT_DIR/dist/." "$TAURI_GUI_DIST/"

echo "==[build][3/7]== build Rust kernel web host for Linux"
cargo build --release -p deepcode-host-web

echo "==[build][4/7]== build Rust kernel web host for Windows GNU"
cargo build --release --target "$WINDOWS_TARGET" -p deepcode-host-web

echo "==[build][5/7]== build Windows DeepCode.exe GUI shell"
pnpm --filter @deepcode/tauri-shell tauri:build -- --target "$WINDOWS_TARGET"

echo "==[build][6/7]== prepare bin/linux-x64 and bin/win64 directories"
mkdir -p "$LINUX_DIR" "$WIN_DIR"
find "$LINUX_DIR" -mindepth 1 -delete 2>/dev/null || true
find "$WIN_DIR" -mindepth 1 -delete 2>/dev/null || true

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

prepare_distribution_tree "$LINUX_DIR"
prepare_distribution_tree "$WIN_DIR"

cp -v "$CARGO_TARGET_ROOT/release/deepcode-host-web" "$LINUX_DIR/deepcode-kernel"
chmod +x "$LINUX_DIR/deepcode-kernel"

cp -v "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/deepcode-host-web.exe" "$WIN_DIR/deepcode-kernel.exe"
cp -v "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/DeepCode.exe" "$WIN_DIR/DeepCode.exe"

WEBVIEW2_LOADER_DLL="$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/WebView2Loader.dll"
if [ ! -f "$WEBVIEW2_LOADER_DLL" ]; then
  WEBVIEW2_LOADER_DLL="$(find "$CARGO_TARGET_ROOT/$WINDOWS_TARGET/release/build" \
    -path '*/out/x64/WebView2Loader.dll' \
    -type f \
    | head -n 1)"
fi
if [ ! -f "$WEBVIEW2_LOADER_DLL" ]; then
  echo "==[build][error]== WebView2Loader.dll was not found in Windows Tauri build output" >&2
  exit 1
fi
cp -v "$WEBVIEW2_LOADER_DLL" "$WIN_DIR/WebView2Loader.dll"

echo "==[build][7/7]== generate host launchers"
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

cat > "$LINUX_DIR/deepcode-cli" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEEPCODE_HOST="${DEEPCODE_HOST:-127.0.0.1}"
export DEEPCODE_PORT="${DEEPCODE_PORT:-31245}"
exec "$SCRIPT_DIR/deepcode-kernel" "$@"
LAUNCHER
chmod +x "$LINUX_DIR/deepcode-cli"

cat > "$LINUX_DIR/deepcode-tui" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEEPCODE_HOST="${DEEPCODE_HOST:-127.0.0.1}"
export DEEPCODE_PORT="${DEEPCODE_PORT:-31245}"
exec "$SCRIPT_DIR/deepcode-kernel" "$@"
LAUNCHER
chmod +x "$LINUX_DIR/deepcode-tui"

cat > "$WIN_DIR/deepcode-cli.bat" <<'LAUNCHER'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if not defined DEEPCODE_HOST set "DEEPCODE_HOST=127.0.0.1"
if not defined DEEPCODE_PORT set "DEEPCODE_PORT=31245"
"%SCRIPT_DIR%deepcode-kernel.exe" %*
LAUNCHER

cat > "$WIN_DIR/deepcode-tui.bat" <<'LAUNCHER'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if not defined DEEPCODE_HOST set "DEEPCODE_HOST=127.0.0.1"
if not defined DEEPCODE_PORT set "DEEPCODE_PORT=31245"
"%SCRIPT_DIR%deepcode-kernel.exe" %*
LAUNCHER

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
  deepcode-kernel       Rust Kernel + Web Host
  $gui_entry
  deepcode-cli          CLI host launcher placeholder over the same Kernel
  deepcode-tui          TUI host launcher placeholder over the same Kernel

Windows GUI runtime:
  DeepCode.exe requires WebView2Loader.dll next to the executable. The portable
  distribution includes that loader DLL. The Microsoft Edge WebView2 Evergreen
  Runtime is still expected to be installed on the target Windows system.

Optional desktop shell:
  Tauri thin shell source lives in shells/tauri. It embeds the same React GUI as
  the browser host, starts or connects to the same-dir Kernel Host in the
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

write_readme "$LINUX_DIR" "linux-x64"
write_readme "$WIN_DIR" "win64"

if [ "$BUILD_LINUX_TAURI_SHELL" = "1" ]; then
  echo "==[build][opt]== build Linux Tauri thin shell"
  pnpm --filter @deepcode/tauri-shell tauri:build
  TAURI_RELEASE="$CARGO_TARGET_ROOT/release/DeepCode"
  if [ -x "$TAURI_RELEASE" ]; then
    cp -v "$TAURI_RELEASE" "$LINUX_DIR/DeepCode"
    chmod +x "$LINUX_DIR/DeepCode"
  else
    echo "==[build][opt]== Tauri shell build completed, but no Linux release binary was found at $TAURI_RELEASE"
  fi
else
  echo "==[build][opt]== Linux Tauri shell build skipped; set DEEPCODE_BUILD_LINUX_TAURI_SHELL=1 to enable"
fi

echo ""
echo "==[build]== DONE"
find "$LINUX_DIR" "$WIN_DIR" -maxdepth 2 -type f | sort
