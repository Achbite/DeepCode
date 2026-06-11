#!/usr/bin/env bash
# Build a local macOS arm64 DeepCode distribution.
#
# This script is intentionally host-side: Tauri macOS .app bundles and Darwin
# binaries must be produced on macOS, while the regular Docker build remains
# the default Linux/Windows development path.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/userspace/gui"
BUILD_COMMIT="${DEEPCODE_BUILD_COMMIT:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')}"
PRODUCT="${DEEPCODE_MACOS_PRODUCT:-DeepCode}"
case "$PRODUCT" in
  DeepCode)
    APP_NAME="DeepCode"
    BUNDLE_ID="com.achbite.deepcode"
    TAURI_DIR="$ROOT_DIR/shells/tauri"
    TAURI_BIN_NAME="DeepCode"
    CLIENT_DIST_DIR="$CLIENT_DIR/dist"
    WEB_DIR_NAME="web"
    BIN_DIR="$ROOT_DIR/bin/macos-arm64"
    DOCKER_GUI_STAGE="gui"
    DEFAULT_PORT="31245"
    TUI_COMMAND_NAME="DeepCode-TUI.command"
    COPY_ROOT_WEB_DIST="1"
    WRITE_TUI_LAUNCHER="1"
    ;;
  DeepCode-GUI)
    APP_NAME="DeepCode-GUI"
    BUNDLE_ID="com.achbite.deepcode.gui"
    TAURI_DIR="$ROOT_DIR/shells/deepcode-gui"
    TAURI_BIN_NAME="DeepCode-GUI"
    CLIENT_DIST_DIR="$CLIENT_DIR/dist-deepcode-gui"
    WEB_DIR_NAME="web-deepcode-gui"
    BIN_DIR="$ROOT_DIR/bin/macos-arm64"
    DOCKER_GUI_STAGE="deepcode-gui"
    DEFAULT_PORT="31246"
    TUI_COMMAND_NAME=""
    COPY_ROOT_WEB_DIST="0"
    WRITE_TUI_LAUNCHER="0"
    ;;
  *)
    printf '==[macos-package][error]== unsupported DEEPCODE_MACOS_PRODUCT: %s\n' "$PRODUCT" >&2
    exit 2
    ;;
esac
TAURI_SRC_DIR="$TAURI_DIR/src-tauri"
CARGO_TARGET_ROOT="${DEEPCODE_MACOS_CARGO_TARGET_DIR:-$ROOT_DIR/target/macos-arm64}"
RUST_TOOLCHAIN="${DEEPCODE_MACOS_RUST_TOOLCHAIN:-1.88.0}"
NODE_MAJOR="${DEEPCODE_MACOS_NODE_MAJOR:-22}"
NODE_HOME="${DEEPCODE_MACOS_NODE_HOME:-$HOME/.local/deepcode-node}"
PNPM_VERSION="${DEEPCODE_MACOS_PNPM_VERSION:-9.15.9}"
BOOTSTRAP="${DEEPCODE_MACOS_BOOTSTRAP:-1}"
BUILD_GUI_ON_HOST="${DEEPCODE_MACOS_BUILD_GUI_ON_HOST:-0}"
REFRESH_GUI_DIST="${DEEPCODE_MACOS_REFRESH_GUI_DIST:-0}"
SEED_CARGO_REGISTRY="${DEEPCODE_MACOS_SEED_CARGO_REGISTRY:-1}"
CARGO_OFFLINE="${DEEPCODE_MACOS_CARGO_OFFLINE:-1}"
TAURI_NETWORK_FALLBACK="${DEEPCODE_MACOS_TAURI_NETWORK_FALLBACK:-1}"
CLEAN_PACKAGE_CACHE="${DEEPCODE_MACOS_CLEAN:-0}"

export CARGO_TARGET_DIR="$CARGO_TARGET_ROOT"

usage() {
  cat <<USAGE
Usage:
  scripts/package-macos.sh [--clean]

Environment:
  DEEPCODE_MACOS_PRODUCT=DeepCode|DeepCode-GUI
  DEEPCODE_MACOS_CLEAN=1        Clean macOS package build artifacts before rebuilding.
  DEEPCODE_MACOS_REFRESH_GUI_DIST=1
                                Rebuild GUI dist through the Docker dev container when available.

Clean keeps package-local user data:
  bin/macos-arm64/config
  bin/macos-arm64/sessions
  bin/macos-arm64/conversation-archives
  bin/macos-arm64/kernel
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --clean)
      CLEAN_PACKAGE_CACHE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '==[macos-package][error]== unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$CLEAN_PACKAGE_CACHE" = "1" ]; then
  REFRESH_GUI_DIST=1
fi

log() {
  printf '==[macos-package]== %s\n' "$*"
}

fail() {
  printf '==[macos-package][error]== %s\n' "$*" >&2
  exit 1
}

running_processes_for_path() {
  local target="$1"
  ps -axo pid=,command= | DEEPCODE_PROCESS_TARGET="$target" awk 'index($0, ENVIRON["DEEPCODE_PROCESS_TARGET"]) > 0 { print }'
}

fail_if_target_app_is_running() {
  local app_bin="$BIN_DIR/$APP_NAME.app/Contents/MacOS/$TAURI_BIN_NAME"
  local kernel_bin="$BIN_DIR/$APP_NAME.app/Contents/MacOS/deepcode-kernel"
  local matches=""

  if [ -e "$app_bin" ]; then
    matches="$(running_processes_for_path "$app_bin" || true)"
  fi
  if [ -e "$kernel_bin" ]; then
    local kernel_matches
    kernel_matches="$(running_processes_for_path "$kernel_bin" || true)"
    if [ -n "$kernel_matches" ]; then
      if [ -n "$matches" ]; then
        matches="$matches
$kernel_matches"
      else
        matches="$kernel_matches"
      fi
    fi
  fi

  if [ -n "$matches" ]; then
    printf '%s\n' "$matches" >&2
    fail "$APP_NAME.app is still running from $BIN_DIR. Quit it before packaging so the new Kernel is used."
  fi
}

clean_macos_package_cache() {
  log "clean macOS package build artifacts for $PRODUCT"
  log "preserve package-local user data: config/, sessions/, conversation-archives/, kernel/"

  rm -rf "$BIN_DIR/$APP_NAME.app" "$BIN_DIR/$WEB_DIR_NAME" "$TAURI_DIR/dist"
  if [ -n "$TUI_COMMAND_NAME" ]; then
    rm -f "$BIN_DIR/$TUI_COMMAND_NAME"
  fi
  rm -f \
    "$BIN_DIR/deepcode-kernel" \
    "$BIN_DIR/deepcode-cli" \
    "$BIN_DIR/deepcode-tui" \
    "$BIN_DIR/README.txt" \
    "$BIN_DIR/build-info.json"

  rm -f \
    "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" \
    "$CARGO_TARGET_ROOT/release/deepcode-cli" \
    "$CARGO_TARGET_ROOT/release/deepcode-tui" \
    "$CARGO_TARGET_ROOT/release/$TAURI_BIN_NAME"
}

ensure_macos_arm64() {
  [ "$(uname -s)" = "Darwin" ] || fail "macOS packaging must run on macOS."
  [ "$(uname -m)" = "arm64" ] || fail "this package target is macOS arm64; current arch is $(uname -m)."
}

ensure_xcode_tools() {
  command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild not found. Install Xcode Command Line Tools first."
  command -v xcrun >/dev/null 2>&1 || fail "xcrun not found. Install Xcode Command Line Tools first."
  xcrun --find clang >/dev/null 2>&1 || fail "clang not available through xcrun."
}

prepend_path_dir() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) export PATH="$1:$PATH" ;;
  esac
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local node_path node_real node_major
    node_path="$(command -v node)"
    node_real="$(realpath "$node_path" 2>/dev/null || printf '%s\n' "$node_path")"
    node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"
    if [ "$node_major" -ge 20 ] 2>/dev/null && ! printf '%s\n' "$node_real" | grep -q '/Applications/Codex.app/'; then
      return
    fi
  fi

  if [ "$BOOTSTRAP" != "1" ]; then
    fail "node 20+ not found. Set DEEPCODE_MACOS_BOOTSTRAP=1 to allow user-level Node install."
  fi

  install_user_node
}

install_user_node() {
  log "install official Node $NODE_MAJOR into $NODE_HOME"

  local latest_dir checksums archive version_dir tmp_dir expected
  latest_dir="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tmp_dir="$(mktemp -d)"

  checksums="$(
    /usr/bin/curl --connect-timeout 20 --max-time 120 --retry 4 --retry-all-errors -fsSL \
      "$latest_dir/SHASUMS256.txt"
  )"
  archive="$(printf '%s\n' "$checksums" | awk '/darwin-arm64\.tar\.gz$/ { print $2; exit }')"
  [ -n "$archive" ] || fail "could not resolve latest Node $NODE_MAJOR darwin arm64 archive."
  version_dir="${archive%.tar.gz}"

  /usr/bin/curl --connect-timeout 20 --max-time 600 --retry 4 --retry-all-errors -fL \
    "$latest_dir/$archive" \
    -o "$tmp_dir/$archive"

  expected="$(printf '%s\n' "$checksums" | awk -v archive="$archive" '$2 == archive { print $1; exit }')"
  [ -n "$expected" ] || fail "missing checksum for $archive"
  printf '%s  %s\n' "$expected" "$tmp_dir/$archive" | shasum -a 256 -c - >/dev/null

  tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
  rm -rf "$NODE_HOME"
  mkdir -p "$(dirname "$NODE_HOME")"
  mv "$tmp_dir/$version_dir" "$NODE_HOME"
  rm -rf "$tmp_dir"

  mkdir -p "$HOME/.local/bin"
  for tool in node npm npx corepack; do
    if [ -x "$NODE_HOME/bin/$tool" ]; then
      ln -sf "$NODE_HOME/bin/$tool" "$HOME/.local/bin/$tool"
    fi
  done
  prepend_path_dir "$NODE_HOME/bin"
  prepend_path_dir "$HOME/.local/bin"

  command -v node >/dev/null 2>&1 || fail "node still not found after user-level install."
  local installed_major
  installed_major="$(node -p "process.versions.node.split('.')[0]")"
  [ "$installed_major" -ge 20 ] || fail "installed node is too old: $(node --version)"
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    log "pnpm not found; enabling pnpm through corepack"
    corepack enable
    corepack prepare pnpm@9 --activate
  elif command -v npm >/dev/null 2>&1; then
    log "pnpm not found; installing pnpm@9 into user npm prefix"
    export npm_config_prefix="${npm_config_prefix:-$HOME/.local}"
    mkdir -p "$npm_config_prefix/bin"
    prepend_path_dir "$npm_config_prefix/bin"
    npm install -g pnpm@9
  elif [ "$BOOTSTRAP" = "1" ]; then
    log "pnpm not found; installing pnpm $PNPM_VERSION through the official user-level installer"
    export PNPM_HOME="${PNPM_HOME:-$HOME/Library/pnpm}"
    mkdir -p "$PNPM_HOME"

    local curl_wrapper_dir
    curl_wrapper_dir="$(mktemp -d)"
    cat > "$curl_wrapper_dir/curl" <<'CURL_WRAPPER'
#!/usr/bin/env sh
exec /usr/bin/curl --connect-timeout 20 --max-time 300 --retry 4 --retry-all-errors "$@"
CURL_WRAPPER
    chmod +x "$curl_wrapper_dir/curl"
    PATH="$curl_wrapper_dir:$PATH" /usr/bin/curl --connect-timeout 20 --max-time 60 --retry 4 --retry-all-errors -fsSL https://get.pnpm.io/install.sh \
      | env PATH="$curl_wrapper_dir:$PATH" SHELL="${SHELL:-/bin/zsh}" PNPM_HOME="$PNPM_HOME" PNPM_VERSION="$PNPM_VERSION" sh -
    rm -rf "$curl_wrapper_dir"
    prepend_path_dir "$PNPM_HOME"
  fi

  command -v pnpm >/dev/null 2>&1 || fail "pnpm not found and could not be bootstrapped from node/corepack/npm."
}

ensure_rust() {
  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    return
  fi

  if [ "$BOOTSTRAP" != "1" ]; then
    fail "cargo/rustc not found. Set DEEPCODE_MACOS_BOOTSTRAP=1 to allow user-level rustup install."
  fi

  log "Rust toolchain not found; installing rustup toolchain $RUST_TOOLCHAIN into the user profile"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --default-toolchain "$RUST_TOOLCHAIN"
  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

  command -v cargo >/dev/null 2>&1 || fail "cargo still not found after rustup install."
  command -v rustc >/dev/null 2>&1 || fail "rustc still not found after rustup install."
}

seed_cargo_cache_from_docker() {
  [ "$SEED_CARGO_REGISTRY" = "1" ] || return
  command -v docker >/dev/null 2>&1 || return
  docker container inspect deepcode-dev >/dev/null 2>&1 || return

  log "seed host Cargo cache from deepcode-dev Docker container"
  mkdir -p "$HOME/.cargo/registry" "$HOME/.cargo/git"
  docker cp deepcode-dev:/usr/local/cargo/registry/. "$HOME/.cargo/registry/" >/dev/null 2>&1 || true
  docker cp deepcode-dev:/usr/local/cargo/git/. "$HOME/.cargo/git/" >/dev/null 2>&1 || true
}

configure_cargo_network_mode() {
  if [ "$CARGO_OFFLINE" = "1" ]; then
    export CARGO_NET_OFFLINE=true
    log "Cargo offline mode enabled for macOS package build"
  fi
}

install_dependencies() {
  log "install workspace JS dependencies"
  pnpm install --frozen-lockfile
}

prepare_tauri_dist() {
  [ -f "$CLIENT_DIST_DIR/index.html" ] || fail "GUI dist missing at $CLIENT_DIST_DIR"
  validate_frontend_dist "$CLIENT_DIST_DIR" "$PRODUCT"
  log "prepare Tauri embedded dist"
  rm -rf "$TAURI_DIR/dist"
  mkdir -p "$TAURI_DIR/dist"
  cp -R "$CLIENT_DIST_DIR/." "$TAURI_DIR/dist/"
}

validate_frontend_dist() {
  local dist_dir="$1"
  local label="$2"
  local index_file="$dist_dir/index.html"
  [ -f "$index_file" ] || fail "$label frontend dist missing index.html at $index_file"
  if ! grep -q '<script[^>]*type="module"[^>]*assets/' "$index_file"; then
    fail "$label frontend dist index.html has no production module entry; rebuild the GUI dist with DEEPCODE_FORCE_BUILD=1."
  fi
}

refresh_gui_dist_with_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  docker container inspect deepcode-dev >/dev/null 2>&1 || return 1
  log "refresh $PRODUCT GUI dist in deepcode-dev Docker container"
  docker exec deepcode-dev bash -lc "DEEPCODE_FORCE_BUILD=1 bash ./build.sh --stage $DOCKER_GUI_STAGE"
}

ensure_gui_dist() {
  if [ "$REFRESH_GUI_DIST" = "1" ]; then
    if ! refresh_gui_dist_with_docker; then
      if [ "$BUILD_GUI_ON_HOST" != "1" ]; then
        fail "DEEPCODE_MACOS_REFRESH_GUI_DIST=1 was requested, but Docker refresh failed. Set DEEPCODE_MACOS_BUILD_GUI_ON_HOST=1 to build GUI on host."
      fi
    else
      prepare_tauri_dist
      return
    fi
  fi

  if [ -f "$CLIENT_DIST_DIR/index.html" ]; then
    log "reuse existing GUI dist at $CLIENT_DIST_DIR"
    prepare_tauri_dist
    return
  fi

  if refresh_gui_dist_with_docker; then
    prepare_tauri_dist
    return
  fi

  if [ "$BUILD_GUI_ON_HOST" = "1" ] && [ "$PRODUCT" = "DeepCode-GUI" ]; then
    fail "DeepCode-GUI frontend dist must be produced in Docker. Run 'make build-deepcode-gui' first."
  fi

  if [ "$BUILD_GUI_ON_HOST" = "1" ]; then
    ensure_node
    ensure_pnpm
    install_dependencies
    build_gui_dist
    return
  fi

  fail "GUI dist missing. Run Docker GUI build first, or set DEEPCODE_MACOS_BUILD_GUI_ON_HOST=1 for the original DeepCode GUI."
}

build_gui_dist() {
  log "build TS protocol/session-core/React GUI"
  pnpm --filter @deepcode/protocol build
  pnpm --filter @deepcode/session-core build
  if [ "$PRODUCT" = "DeepCode-GUI" ]; then
    fail "DeepCode-GUI host-side frontend build is disabled; use Docker build stage deepcode-gui."
  fi
  pnpm --filter @deepcode/client build

  prepare_tauri_dist
}

build_rust_bins() {
  log "build Darwin Kernel/CLI/TUI release binaries"
  DEEPCODE_BUILD_COMMIT="$BUILD_COMMIT" cargo build --release -p deepcode-kernel-daemon -p deepcode-cli -p deepcode-tui
}

build_tauri_app() {
  log "build macOS $PRODUCT Tauri shell binary"
  if (cd "$TAURI_SRC_DIR" && DEEPCODE_BUILD_COMMIT="$BUILD_COMMIT" cargo build --release --bin "$TAURI_BIN_NAME"); then
    return
  fi

  if [ "$CARGO_OFFLINE" = "1" ] && [ "$TAURI_NETWORK_FALLBACK" = "1" ]; then
    log "retry Tauri shell build with Cargo network enabled"
    (cd "$TAURI_SRC_DIR" && CARGO_NET_OFFLINE=false DEEPCODE_BUILD_COMMIT="$BUILD_COMMIT" cargo build --release --bin "$TAURI_BIN_NAME")
    return
  fi

  fail "failed to build macOS $PRODUCT Tauri shell binary"
}

copy_required_file() {
  local src="$1"
  local dst="$2"
  local mode="$3"
  [ -f "$src" ] || fail "missing artifact: $src"
  install -m "$mode" "$src" "$dst"
}

copy_web_dist() {
  local dst="$1"
  [ -f "$CLIENT_DIST_DIR/index.html" ] || fail "GUI dist missing at $CLIENT_DIST_DIR"
  validate_frontend_dist "$CLIENT_DIST_DIR" "$PRODUCT"
  rm -rf "$dst"
  mkdir -p "$dst"
  cp -R "$CLIENT_DIST_DIR/." "$dst/"
}

write_file_if_missing() {
  local dst="$1"
  [ ! -f "$dst" ] || return 0
  mkdir -p "$(dirname "$dst")"
  cat > "$dst"
}

prepare_portable_config_root() {
  log "prepare portable config/session/cache root"
  mkdir -p \
    "$BIN_DIR/config/user/local/settings" \
    "$BIN_DIR/config/user/local/secrets" \
    "$BIN_DIR/sessions" \
    "$BIN_DIR/conversation-archives" \
    "$BIN_DIR/kernel"

  write_file_if_missing "$BIN_DIR/config/user/local/settings/user-settings.json" <<'JSON'
{
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "editor.wordWrap": "off",
  "editor.fontSize": 14,
  "editor.fontFamily": "Consolas, 'Courier New', monospace",
  "editor.renderWhitespace": "none",
  "files.autoSave": "afterDelay",
  "files.autoSaveDelay": 1000,
  "files.hotExit": true,
  "files.encoding": "utf8",
  "files.eol": "\n",
  "keyboard.enableBasicShortcuts": true,
  "explorer.confirmDelete": false,
  "workbench.colorTheme": "vs-dark",
  "workbench.language": "zh-CN",
  "workbench.styleTokenOverrides": "{}",
  "terminal.integrated.defaultProfile.windows": "wsl",
  "terminal.integrated.prewarm": "afterStartup",
  "terminal.integrated.spawnTimeoutMs": 8000,
  "agent.defaultMode": "plan",
  "agent.defaultWorkflow": "planFirst",
  "agent.permissions.allowFileRead": true,
  "agent.permissions.allowFileWrite": true,
  "agent.permissions.allowCodeSearch": true,
  "agent.permissions.allowShellPropose": true,
  "agent.permissions.allowShellExec": true,
  "agent.shell.autoExecuteCommands": false,
  "skills.pythonPath": "python",
  "skills.autoLoad": true,
  "skills.mounts": "[]",
  "mcp.autoLoad": false,
  "mcp.servers": "[]",
  "ruler.enabled": true,
  "ruler.rules": "[{\"id\":\"default-safety\",\"name\":\"Default Safety Boundary\",\"source\":\"system\",\"priority\":100,\"path\":\"<builtin>/default-safety.md\",\"content\":\"Default to plan mode. Read before write. Show diff before saving files. Never run destructive commands without explicit approval.\",\"enabled\":true}]"
}
JSON

  write_file_if_missing "$BIN_DIR/config/user/local/settings/llm-profiles.json" <<'JSON'
{
  "profiles": [
    {
      "id": "deepseek-v4-flash-openai",
      "name": "DeepSeek V4 Flash",
      "kind": "openaiCompatible",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-flash",
      "contextWindowTokens": 1000000,
      "maxOutputTokens": 384000,
      "temperature": 0.2,
      "reasoningEffort": "high",
      "thinking": "enabled",
      "enabled": true
    },
    {
      "id": "deepseek-v4-pro-openai",
      "name": "DeepSeek V4 Pro",
      "kind": "openaiCompatible",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-pro",
      "contextWindowTokens": 1000000,
      "maxOutputTokens": 384000,
      "temperature": 0.2,
      "reasoningEffort": "max",
      "thinking": "enabled",
      "enabled": true
    }
  ],
  "defaultProfileId": "deepseek-v4-pro-openai",
  "storePath": null
}
JSON

  write_file_if_missing "$BIN_DIR/config/user/local/settings/agent-workflow-config.json" <<'JSON'
{
  "plan": {},
  "check": {},
  "complete": {},
  "review": {}
}
JSON

  write_file_if_missing "$BIN_DIR/config/README.txt" <<README
DeepCode writable portable configuration
========================================

This directory is used by the macOS local package when launched through
$APP_NAME.app or package launcher scripts.

Writable runtime data:
  config/user/local/settings/     User settings, profiles, workflow config.
  config/user/local/secrets/      Local secret references. Do not share.
  sessions/                       Session projection and transcript cache.
  conversation-archives/          Conversation archive exports and debug packages.
  kernel/                         Kernel ledger and runtime records.

Set DEEPCODE_CONFIG_DIR to override this package-local root.
README
}

write_tui_launcher() {
  [ "$WRITE_TUI_LAUNCHER" = "1" ] || return 0
  cat > "$BIN_DIR/$TUI_COMMAND_NAME" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
HOST="\${DEEPCODE_HOST:-127.0.0.1}"
KERNEL_BIN="\$SCRIPT_DIR/deepcode-kernel"
TUI_BIN="\$SCRIPT_DIR/deepcode-tui"
WEB_DIR="\$SCRIPT_DIR/$WEB_DIR_NAME"
CONFIG_ROOT="\${DEEPCODE_CONFIG_DIR:-\$SCRIPT_DIR}"
LOG_DIR="\${DEEPCODE_LOG_DIR:-\$CONFIG_ROOT/logs}"
mkdir -p "\$LOG_DIR"

fail() {
  printf '$PRODUCT TUI launcher error: %s\n' "\$*" >&2
  printf 'Press Enter to close this window...'
  read -r _ || true
  exit 1
}

port_is_free() {
  ! /usr/bin/nc -z "\$HOST" "\$1" >/dev/null 2>&1
}

choose_port() {
  if [ "\${DEEPCODE_PORT:-}" != "" ]; then
    printf '%s\n' "\$DEEPCODE_PORT"
    return
  fi

  local port=$DEFAULT_PORT
  while [ "\$port" -le 31345 ]; do
    if port_is_free "\$port"; then
      printf '%s\n' "\$port"
      return
    fi
    port=\$((port + 1))
  done

  fail "no free localhost port found in $DEFAULT_PORT-31345"
}

health_ok() {
  /usr/bin/curl -fsS "\$1/api/health" >/dev/null 2>&1
}

wait_for_kernel() {
  local api_url="\$1"
  local attempt=1
  while [ "\$attempt" -le 80 ]; do
    if health_ok "\$api_url"; then
      return 0
    fi
    sleep 0.1
    attempt=\$((attempt + 1))
  done
  return 1
}

[ -x "\$KERNEL_BIN" ] || fail "missing executable: \$KERNEL_BIN"
[ -x "\$TUI_BIN" ] || fail "missing executable: \$TUI_BIN"
[ -f "\$WEB_DIR/index.html" ] || fail "missing GUI web assets: \$WEB_DIR/index.html"

PORT="\$(choose_port)"
API_URL="http://\$HOST:\$PORT"
KERNEL_PID=""
STARTED_KERNEL=0

cleanup() {
  if [ "\$STARTED_KERNEL" = "1" ] && [ "\$KERNEL_PID" != "" ]; then
    kill "\$KERNEL_PID" >/dev/null 2>&1 || true
    wait "\$KERNEL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if ! health_ok "\$API_URL"; then
  DEEPCODE_HOST="\$HOST" \
  DEEPCODE_PORT="\$PORT" \
  DEEPCODE_CONFIG_DIR="\$CONFIG_ROOT" \
  DEEPCODE_CLIENT_DIST="\$WEB_DIR" \
    "\$KERNEL_BIN" >>"\$LOG_DIR/deepcode-kernel.log" 2>&1 &
  KERNEL_PID="\$!"
  STARTED_KERNEL=1

  if ! wait_for_kernel "\$API_URL"; then
    fail "kernel did not become ready at \$API_URL; see \$LOG_DIR/deepcode-kernel.log"
  fi
fi

export DEEPCODE_HOST="\$HOST"
export DEEPCODE_PORT="\$PORT"
export DEEPCODE_CONFIG_DIR="\$CONFIG_ROOT"
export DEEPCODE_API_URL="\$API_URL"
"\$TUI_BIN" --api "\$API_URL"
LAUNCHER
  chmod +x "$BIN_DIR/$TUI_COMMAND_NAME"
}

write_app_info_plist() {
  local plist="$1"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$TAURI_BIN_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST
}

sign_app_bundle() {
  local app_dir="$1"
  command -v codesign >/dev/null 2>&1 || return
  log "ad-hoc sign $APP_NAME.app"
  codesign --force --deep --sign - "$app_dir" >/dev/null 2>&1 || {
    log "warning: ad-hoc signing failed; leaving local app unsigned"
  }
}

sync_signed_kernel_sidecar_to_root() {
  local app_kernel="$BIN_DIR/$APP_NAME.app/Contents/MacOS/deepcode-kernel"
  [ -x "$app_kernel" ] || fail "missing bundled Kernel sidecar: $app_kernel"
  install -m 755 "$app_kernel" "$BIN_DIR/deepcode-kernel"
}

write_readme() {
  local tui_section root_web_entry asset_entries notes app_entries gui_section note_assets
  if [ "$WRITE_TUI_LAUNCHER" = "1" ]; then
    tui_section="TUI:
  open $TUI_COMMAND_NAME
  ./deepcode-tui --api http://127.0.0.1:$DEFAULT_PORT"
  else
    tui_section="TUI:
  Use the shared DeepCode TUI launcher or ./deepcode-tui. DeepCode-GUI is only an alternate GUI shell."
  fi

  if [ "$COPY_ROOT_WEB_DIST" = "1" ]; then
    root_web_entry="  $WEB_DIR_NAME/             React GUI static assets served by the Kernel daemon."
  else
    root_web_entry="  $APP_NAME.app/Contents/MacOS/$WEB_DIR_NAME/
	                         Bundled conversational GUI assets; the shared root web/ is not replaced."
  fi
  asset_entries="$root_web_entry"

  notes="  bin/macos-arm64 is the shared macOS distribution directory for DeepCode and
  DeepCode-GUI. Both GUI variants use the same kernel/session/user settings
  model unless DEEPCODE_CONFIG_DIR is explicitly overridden.
	  By default, this local package stores writable user data under:
	    config/user/local/settings/
	    config/user/local/secrets/
	    sessions/
	    conversation-archives/
	    kernel/"

  app_entries=""
  gui_section=""
  note_assets=""
  if [ "$PRODUCT" = "DeepCode" ] || [ -d "$BIN_DIR/DeepCode.app" ]; then
    app_entries="  DeepCode.app              Native macOS Editor shell. Starts its bundled Kernel."
    gui_section="  open DeepCode.app"
    note_assets="  DeepCode.app contains deepcode-kernel and web/ under Contents/MacOS."
  fi
  if [ "$PRODUCT" = "DeepCode-GUI" ] || [ -d "$BIN_DIR/DeepCode-GUI.app" ]; then
    if [ "$WEB_DIR_NAME" != "web-deepcode-gui" ]; then
      asset_entries="$asset_entries
  DeepCode-GUI.app/Contents/MacOS/web-deepcode-gui/
                         Bundled conversational GUI assets."
    fi
    if [ -n "$app_entries" ]; then
      app_entries="$app_entries
  DeepCode-GUI.app          Native macOS conversational GUI shell. Starts its bundled Kernel."
      gui_section="$gui_section
  open DeepCode-GUI.app"
      note_assets="$note_assets
  DeepCode-GUI.app contains deepcode-kernel and web-deepcode-gui/ under Contents/MacOS."
    else
      app_entries="  DeepCode-GUI.app          Native macOS conversational GUI shell. Starts its bundled Kernel."
      gui_section="  open DeepCode-GUI.app"
      note_assets="  DeepCode-GUI.app contains deepcode-kernel and web-deepcode-gui/ under Contents/MacOS."
    fi
  fi

  cat > "$BIN_DIR/README.txt" <<README
DeepCode macOS arm64 Distribution
=================================

GUI:
$gui_section

$tui_section

Files:
$app_entries
  deepcode-kernel           Darwin arm64 Kernel daemon.
  deepcode-cli              Darwin arm64 CLI host.
  deepcode-tui              Darwin arm64 Ratatui/Crossterm TUI host.
$asset_entries
  config/                  Package-local writable user config root.
  sessions/                Package-local session projection/transcript cache.
  conversation-archives/   Package-local conversation exports and debug packages.
  kernel/                  Package-local Kernel ledger/runtime records.

Notes:
$notes
  This is a local runnable package. It is ad-hoc signed for local execution,
  but it is not Developer ID signed, notarized, or wrapped in a DMG.
$note_assets
README
}

write_build_info() {
  local dst="$1"
  local product="${2:-$PRODUCT}"
  cat > "$dst" <<JSON
{
  "buildCommit": "$BUILD_COMMIT",
  "protocolVersion": "deepcode.agent.protocol.v2",
  "toolCatalogVersion": "deepcode.tool_catalog.k7-k9.v1",
  "product": "$product"
}
JSON
}

package_distribution() {
  log "prepare $BIN_DIR"
  mkdir -p "$BIN_DIR"
  rm -rf "$BIN_DIR/$APP_NAME.app" "$BIN_DIR/$WEB_DIR_NAME"
  if [ -n "$TUI_COMMAND_NAME" ]; then
    rm -rf "$BIN_DIR/$TUI_COMMAND_NAME"
  fi
  rm -f "$BIN_DIR/README.txt"
  if [ "$PRODUCT" = "DeepCode-GUI" ]; then
    rm -rf "$ROOT_DIR/bin/macos-arm64-deepcode-gui"
    rm -rf "$BIN_DIR/web-deepcode-gui" "$BIN_DIR/DeepCode-GUI-TUI.command"
  fi

  local app_macos_dir="$BIN_DIR/$APP_NAME.app/Contents/MacOS"
  local app_resources_dir="$BIN_DIR/$APP_NAME.app/Contents/Resources"
  mkdir -p "$app_macos_dir" "$app_resources_dir"
  prepare_portable_config_root
  write_app_info_plist "$BIN_DIR/$APP_NAME.app/Contents/Info.plist"

  log "copy Tauri shell into app bundle"
  copy_required_file "$CARGO_TARGET_ROOT/release/$TAURI_BIN_NAME" "$app_macos_dir/$TAURI_BIN_NAME" 755
  [ -d "$app_macos_dir" ] || fail "unexpected app layout: missing Contents/MacOS"

  log "copy Darwin sidecars into app bundle and distribution root"
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" "$app_macos_dir/deepcode-kernel" 755
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" "$BIN_DIR/deepcode-kernel" 755
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-cli" "$BIN_DIR/deepcode-cli" 755
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-tui" "$BIN_DIR/deepcode-tui" 755
  write_build_info "$BIN_DIR/build-info.json" "macos-arm64"
  write_build_info "$app_macos_dir/build-info.json"

  copy_web_dist "$app_macos_dir/$WEB_DIR_NAME"
  if [ "$COPY_ROOT_WEB_DIST" = "1" ]; then
    copy_web_dist "$BIN_DIR/$WEB_DIR_NAME"
  fi
  write_tui_launcher
  write_readme
  sign_app_bundle "$BIN_DIR/$APP_NAME.app"
  sync_signed_kernel_sidecar_to_root
}

verify_packaged_kernel_markers() {
  local kernel_bin="$BIN_DIR/deepcode-kernel"
  local app_kernel_bin="$BIN_DIR/$APP_NAME.app/Contents/MacOS/deepcode-kernel"
  local root_hash app_hash
  [ -x "$kernel_bin" ] || fail "missing packaged Kernel binary: $kernel_bin"
  [ -x "$app_kernel_bin" ] || fail "missing bundled Kernel binary: $app_kernel_bin"

  root_hash="$(shasum -a 256 "$kernel_bin" | awk '{print $1}')"
  app_hash="$(shasum -a 256 "$app_kernel_bin" | awk '{print $1}')"
  [ "$root_hash" = "$app_hash" ] || fail "root deepcode-kernel and bundled app Kernel differ"

  [ -f "$BIN_DIR/build-info.json" ] || fail "missing root build-info.json"
  [ -f "$BIN_DIR/$APP_NAME.app/Contents/MacOS/build-info.json" ] || fail "missing bundled build-info.json"
  for build_info in "$BIN_DIR/build-info.json" "$BIN_DIR/$APP_NAME.app/Contents/MacOS/build-info.json"; do
    local build_info_commit
    build_info_commit="$(awk -F '"' '/"buildCommit"/ { print $4; exit }' "$build_info")"
    [ "$build_info_commit" = "$BUILD_COMMIT" ] || fail "$build_info buildCommit=$build_info_commit does not match current build commit $BUILD_COMMIT"
  done

  for candidate in "$kernel_bin" "$app_kernel_bin"; do
    local strings_file
    strings_file="$(mktemp "${TMPDIR:-/tmp}/deepcode-kernel-strings.XXXXXX")"
    strings "$candidate" >"$strings_file"
    if ! grep -Fq 'deepcode.agent.protocol.v2' "$strings_file"; then
      rm -f "$strings_file"
      fail "$candidate is missing deepcode.agent.protocol.v2 marker"
    fi
    if ! grep -Fq 'deepcode.tool_catalog.k7-k9.v1' "$strings_file"; then
      rm -f "$strings_file"
      fail "$candidate is missing tool catalog version marker"
    fi
    if ! grep -Fq 'web.search' "$strings_file"; then
      rm -f "$strings_file"
      fail "$candidate tool catalog is missing web.search"
    fi
    if ! grep -Fq 'git.status' "$strings_file"; then
      rm -f "$strings_file"
      fail "$candidate tool catalog is missing git.status"
    fi
    if ! grep -Fq 'browser.snapshot' "$strings_file"; then
      rm -f "$strings_file"
      fail "$candidate tool catalog is missing browser.snapshot"
    fi
    if grep -Fq 'Kernel terminal placeholder ready' "$strings_file"; then
      rm -f "$strings_file"
      fail "$candidate still contains old placeholder terminal runtime"
    fi
    if grep -Fq 'terminal runtime reserved' "$strings_file"; then
      rm -f "$strings_file"
      fail "$candidate still contains reserved terminal placeholder output"
    fi
    if ! grep -Fq 'Kernel PTY terminal runtime is ready.' "$strings_file"; then
      rm -f "$strings_file"
      fail "$candidate is missing PTY terminal runtime marker"
    fi
    rm -f "$strings_file"
  done
}

main() {
  cd "$ROOT_DIR"
  prepend_path_dir "$HOME/.cargo/bin"
  prepend_path_dir "$HOME/.local/bin"
  prepend_path_dir "${PNPM_HOME:-$HOME/Library/pnpm}"
  prepend_path_dir "$HOME/bin"

  ensure_macos_arm64
  ensure_xcode_tools
  fail_if_target_app_is_running
  if [ "$CLEAN_PACKAGE_CACHE" = "1" ]; then
    clean_macos_package_cache
  fi
  ensure_rust
  seed_cargo_cache_from_docker
  configure_cargo_network_mode
  ensure_gui_dist
  build_rust_bins
  build_tauri_app
  package_distribution
  verify_packaged_kernel_markers

  log "done: $BIN_DIR"
  log "GUI: open $BIN_DIR/$APP_NAME.app"
  if [ "$WRITE_TUI_LAUNCHER" = "1" ]; then
    log "TUI: open $BIN_DIR/$TUI_COMMAND_NAME"
  else
    log "TUI: use the shared DeepCode TUI launcher or ./deepcode-tui"
  fi
}

main "$@"
