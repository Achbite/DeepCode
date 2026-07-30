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
BUILD_TIME_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SOURCE_STATUS_HASH="$(
  git -C "$ROOT_DIR" status --porcelain=v1 2>/dev/null \
    | shasum -a 256 2>/dev/null \
    | awk '{ print $1 }'
)"
SOURCE_STATUS_HASH="${SOURCE_STATUS_HASH:-unknown}"
if git -C "$ROOT_DIR" diff --quiet --ignore-submodules -- 2>/dev/null \
  && git -C "$ROOT_DIR" diff --cached --quiet --ignore-submodules -- 2>/dev/null \
  && [ -z "$(git -C "$ROOT_DIR" ls-files --others --exclude-standard 2>/dev/null)" ]; then
  SOURCE_DIRTY=0
else
  SOURCE_DIRTY=1
fi
REQUESTED_PRODUCTS_RAW="${DEEPCODE_MACOS_PRODUCTS:-DeepCode-GUI,DeepCode}"
declare -a REQUESTED_PRODUCTS=()
PRODUCT=""
APP_NAME=""
BUNDLE_ID=""
TAURI_DIR=""
TAURI_SRC_DIR=""
TAURI_BIN_NAME=""
CLIENT_DIST_DIR=""
WEB_DIR_NAME=""
DOCKER_GUI_STAGE=""
DEFAULT_PORT=""
TUI_COMMAND_NAME=""
COPY_ROOT_WEB_DIST="0"
WRITE_TUI_LAUNCHER="0"
BIN_DIR="$ROOT_DIR/bin/macos-arm64"
KERNEL_ABI_VERSION="deepcode.kernel.abi.v2"
TOOL_REGISTRY_VERSION="deepcode.kernel.tools.v2"
SESSION_BRIDGE_NAME="hostBridgeV2.js"

add_requested_product() {
  local product="$1"
  local existing
  case "$product" in
    DeepCode|DeepCode-GUI) ;;
    *)
      printf '==[macos-package][error]== unsupported macOS product: %s\n' "$product" >&2
      exit 2
      ;;
  esac
  for existing in "${REQUESTED_PRODUCTS[@]:-}"; do
    [ "$existing" != "$product" ] || return 0
  done
  REQUESTED_PRODUCTS+=("$product")
}

parse_requested_products() {
  local raw="${REQUESTED_PRODUCTS_RAW//,/ }"
  local product
  for product in $raw; do
    add_requested_product "$product"
  done
  if [ "${#REQUESTED_PRODUCTS[@]}" -eq 0 ]; then
    printf '==[macos-package][error]== macOS product set must not be empty\n' >&2
    exit 2
  fi
}

expand_requested_products_with_published_apps() {
  local before_count="${#REQUESTED_PRODUCTS[@]}"
  [ ! -d "$BIN_DIR/DeepCode-GUI.app" ] || add_requested_product "DeepCode-GUI"
  [ ! -d "$BIN_DIR/DeepCode.app" ] || add_requested_product "DeepCode"
  if [ "${#REQUESTED_PRODUCTS[@]}" -ne "$before_count" ]; then
    printf '==[macos-package]== expand product set to refresh every app sharing %s\n' "$BIN_DIR"
  fi
}

configure_product() {
  PRODUCT="$1"
  case "$PRODUCT" in
    DeepCode)
      APP_NAME="DeepCode"
      BUNDLE_ID="com.achbite.deepcode"
      TAURI_DIR="$ROOT_DIR/shells/tauri"
      TAURI_BIN_NAME="DeepCode"
      CLIENT_DIST_DIR="$CLIENT_DIR/dist"
      WEB_DIR_NAME="web"
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
      DOCKER_GUI_STAGE="deepcode-gui"
      DEFAULT_PORT="31246"
      TUI_COMMAND_NAME=""
      COPY_ROOT_WEB_DIST="0"
      WRITE_TUI_LAUNCHER="0"
      ;;
  esac
  TAURI_SRC_DIR="$TAURI_DIR/src-tauri"
}

parse_requested_products
expand_requested_products_with_published_apps
configure_product "${REQUESTED_PRODUCTS[0]}"
CARGO_TARGET_ROOT="${DEEPCODE_MACOS_CARGO_TARGET_DIR:-$ROOT_DIR/target/macos-arm64}"
RUST_TOOLCHAIN="${DEEPCODE_MACOS_RUST_TOOLCHAIN:-1.84.0}"
NODE_MAJOR="${DEEPCODE_MACOS_NODE_MAJOR:-22}"
NODE_HOME="${DEEPCODE_MACOS_NODE_HOME:-$HOME/.local/deepcode-node}"
PNPM_VERSION="${DEEPCODE_MACOS_PNPM_VERSION:-9.15.9}"
BOOTSTRAP="${DEEPCODE_MACOS_BOOTSTRAP:-1}"
BUILD_GUI_ON_HOST="${DEEPCODE_MACOS_BUILD_GUI_ON_HOST:-0}"
REFRESH_GUI_DIST="${DEEPCODE_MACOS_REFRESH_GUI_DIST:-1}"
KILL_RUNNING="${DEEPCODE_MACOS_KILL_RUNNING:-1}"
SEED_CARGO_REGISTRY="${DEEPCODE_MACOS_SEED_CARGO_REGISTRY:-1}"
CARGO_OFFLINE="${DEEPCODE_MACOS_CARGO_OFFLINE:-1}"
TAURI_NETWORK_FALLBACK="${DEEPCODE_MACOS_TAURI_NETWORK_FALLBACK:-1}"
CLEAN_PACKAGE_CACHE="${DEEPCODE_MACOS_CLEAN:-0}"
CLI_COMMAND_NAME="DeepCode-CLI.command"
LIBEXEC_DIR="$BIN_DIR/libexec"
PACKAGE_STAGE_ROOT="$CARGO_TARGET_ROOT/package-stage"
TUI_EXEC_NAME="DeepCode-TUI"
CLI_EXEC_NAME="DeepCode-CLI"

export CARGO_TARGET_DIR="$CARGO_TARGET_ROOT"

usage() {
  cat <<USAGE
Usage:
  scripts/package-macos.sh [--clean] [--no-kill-running]

Environment:
  DEEPCODE_MACOS_PRODUCTS=DeepCode-GUI,DeepCode
                                Build one ordered product-set transaction.
  DEEPCODE_MACOS_CLEAN=1        Clean macOS package build artifacts before rebuilding.
  DEEPCODE_MACOS_REFRESH_GUI_DIST=1
                                Ensure GUI dist through one incremental Docker build. Defaults to 1 for package builds.
  DEEPCODE_MACOS_NODE_MODULES_VOLUME=<name>
                                Override the checkout-scoped frontend dependency volume.
  DEEPCODE_MACOS_KILL_RUNNING=1 Automatically stop processes occupying the target .app bundle. Defaults to 1.

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
    --kill-running)
      KILL_RUNNING=1
      shift
      ;;
    --no-kill-running)
      KILL_RUNNING=0
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
case "$KILL_RUNNING" in
  0|1) ;;
  *)
    printf '==[macos-package][error]== invalid DEEPCODE_MACOS_KILL_RUNNING: %s\n' "$KILL_RUNNING" >&2
    exit 2
    ;;
esac

log() {
  printf '==[macos-package]== %s\n' "$*"
}

fail() {
  printf '==[macos-package][error]== %s\n' "$*" >&2
  exit 1
}

source_fingerprint() {
  if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    {
      git -C "$ROOT_DIR" rev-parse HEAD
      git -C "$ROOT_DIR" diff --binary --no-ext-diff HEAD --
      git -C "$ROOT_DIR" ls-files --others --exclude-standard \
        | while IFS= read -r path; do
            printf 'untracked=%s\n' "$path"
            [ -f "$ROOT_DIR/$path" ] && shasum -a 256 "$ROOT_DIR/$path"
          done
    } | shasum -a 256 | awk '{ print $1 }'
    return
  fi

  find "$ROOT_DIR" \
    \( -type d \( -name .git -o -name node_modules -o -name target -o -name bin -o -name dist -o -name 'dist-*' -o -name .build-cache \) -prune \) -o \
    \( -type f ! -name .DS_Store ! -name '*.tsbuildinfo' -exec shasum -a 256 {} + \) \
    | LC_ALL=C sort \
    | shasum -a 256 \
    | awk '{ print $1 }'
}

SOURCE_FINGERPRINT="$(source_fingerprint)"

verify_source_fingerprint_unchanged() {
  local current
  current="$(source_fingerprint)"
  [ "$current" = "$SOURCE_FINGERPRINT" ] \
    || fail "source changed during package transaction; refusing to publish a mixed product set"
}

running_processes_for_path() {
  local target="$1"
  ps -axo pid=,command= | DEEPCODE_PROCESS_TARGET="$target" awk 'index($0, ENVIRON["DEEPCODE_PROCESS_TARGET"]) > 0 { print }'
}

running_process_ids_for_path() {
  local target="$1"
  ps -axo pid=,command= | DEEPCODE_PROCESS_TARGET="$target" awk 'index($0, ENVIRON["DEEPCODE_PROCESS_TARGET"]) > 0 { print $1 }'
}

target_app_process_ids() {
  local app_bin="$BIN_DIR/$APP_NAME.app/Contents/MacOS/$TAURI_BIN_NAME"
  local kernel_bin="$BIN_DIR/$APP_NAME.app/Contents/MacOS/deepcode-kernel"
  local host_web_bin="$BIN_DIR/$APP_NAME.app/Contents/MacOS/deepcode-host-web"
  local distribution_kernel_bin="$BIN_DIR/deepcode-kernel"

  if [ -e "$app_bin" ]; then
    running_process_ids_for_path "$app_bin" || true
  fi
  if [ -e "$kernel_bin" ]; then
    running_process_ids_for_path "$kernel_bin" || true
  fi
  if [ -e "$host_web_bin" ]; then
    running_process_ids_for_path "$host_web_bin" || true
  fi
  if [ -e "$distribution_kernel_bin" ]; then
    running_process_ids_for_path "$distribution_kernel_bin" || true
  fi
}

describe_process_ids() {
  local pid
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    ps -p "$pid" -o pid=,command= 2>/dev/null || true
  done
}

current_target_app_process_ids() {
  target_app_process_ids | awk 'NF > 0 { print $1 }' | sort -u
}

wait_for_target_app_release() {
  local timeout_seconds="$1"
  local deadline
  deadline=$(( $(date +%s) + timeout_seconds ))
  while true; do
    if [ -z "$(current_target_app_process_ids)" ]; then
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

release_or_fail_if_target_app_is_running() {
  local pids=""
  local remaining=""
  pids="$(current_target_app_process_ids || true)"

  if [ -z "$pids" ]; then
    return 0
  fi

  describe_process_ids $pids >&2
  if [ "$KILL_RUNNING" != "1" ]; then
    fail "$APP_NAME.app is still running from $BIN_DIR. Re-run without --no-kill-running, or quit it before packaging."
  fi

  log "stop running $APP_NAME.app processes before packaging"
  local pid
  for pid in $pids; do
    kill -TERM "$pid" >/dev/null 2>&1 || true
  done
  if ! wait_for_target_app_release 8; then
    remaining="$(current_target_app_process_ids || true)"
    if [ -n "$remaining" ]; then
      log "force stop stubborn $APP_NAME.app processes"
      describe_process_ids $remaining >&2
      for pid in $remaining; do
        kill -KILL "$pid" >/dev/null 2>&1 || true
      done
    fi
  fi

  if ! wait_for_target_app_release 5; then
    remaining="$(current_target_app_process_ids || true)"
    describe_process_ids $remaining >&2
    fail "$APP_NAME.app is still occupying $BIN_DIR after stop attempts."
  fi
}

clean_product_package_cache() {
  log "clean macOS package build artifacts for $PRODUCT"
  rm -rf "$BIN_DIR/$APP_NAME.app" "$BIN_DIR/$WEB_DIR_NAME" "$TAURI_DIR/dist"
  if [ -n "$TUI_COMMAND_NAME" ]; then
    rm -f "$BIN_DIR/$TUI_COMMAND_NAME"
  fi
  rm -f "$CARGO_TARGET_ROOT/release/$TAURI_BIN_NAME"
}

clean_shared_package_cache() {
  log "clean shared macOS package build artifacts"
  log "preserve package-local user data: config/, sessions/, conversation-archives/, kernel/"
  rm -rf "$BIN_DIR/session-core" "$BIN_DIR/node_modules" "$BIN_DIR/node" "$LIBEXEC_DIR"
  rm -f \
    "$BIN_DIR/deepcode-kernel" \
    "$BIN_DIR/deepcode-cli" \
    "$BIN_DIR/deepcode-tui" \
    "$BIN_DIR/$CLI_COMMAND_NAME" \
    "$BIN_DIR/README.txt" \
    "$BIN_DIR/build-info.json" \
    "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" \
    "$CARGO_TARGET_ROOT/release/deepcode-host-web" \
    "$CARGO_TARGET_ROOT/release/deepcode-cli" \
    "$CARGO_TARGET_ROOT/release/deepcode-tui"
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
    if [ "$node_major" -ge 20 ] 2>/dev/null && ! printf '%s\n' "$node_real" | grep -Eq '/Applications/[^/]+\.app/'; then
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

cargo_cache_ready() {
  local original_product="$PRODUCT"
  local product host_target
  host_target="$(rustc -vV | awk '/^host:/ { print $2; exit }')"
  [ -n "$host_target" ] || host_target="aarch64-apple-darwin"
  cargo fetch --locked --offline --target "$host_target" --manifest-path "$ROOT_DIR/Cargo.toml" >/dev/null 2>&1 || return 1
  for product in "${REQUESTED_PRODUCTS[@]}"; do
    configure_product "$product"
    cargo fetch --locked --offline --target "$host_target" --manifest-path "$TAURI_SRC_DIR/Cargo.toml" >/dev/null 2>&1 || {
      configure_product "$original_product"
      return 1
    }
  done
  configure_product "$original_product"
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

ensure_cargo_cache() {
  if cargo_cache_ready; then
    log "Cargo cache already satisfies the requested product set"
    return
  fi

  log "Cargo offline probe found missing dependencies; seed once from deepcode-dev"
  seed_cargo_cache_from_docker
  if [ "$CARGO_OFFLINE" = "1" ] && ! cargo_cache_ready; then
    fail "Cargo cache is incomplete for offline packaging; refresh the Docker dependency cache or set DEEPCODE_MACOS_CARGO_OFFLINE=0"
  fi
}

configure_cargo_network_mode() {
  if [ "$CARGO_OFFLINE" = "1" ]; then
    export CARGO_NET_OFFLINE=true
    log "Cargo offline mode enabled for macOS package build"
  else
    unset CARGO_NET_OFFLINE
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

frontend_asset_manifest() {
  local index_file="$1"
  grep -Eo 'assets/[^"<>[:space:]]+\.(js|css)' "$index_file" | LC_ALL=C sort -u || true
}

frontend_asset_summary() {
  local index_file="$1"
  frontend_asset_manifest "$index_file" | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

requested_gui_stages() {
  local original_product="$PRODUCT"
  local product stages=""
  for product in "${REQUESTED_PRODUCTS[@]}"; do
    configure_product "$product"
    if [ -n "$stages" ]; then
      stages="$stages,$DOCKER_GUI_STAGE"
    else
      stages="$DOCKER_GUI_STAGE"
    fi
  done
  configure_product "$original_product"
  printf '%s\n' "$stages"
}

refresh_gui_dists_with_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  docker image inspect deepcode-dev:latest >/dev/null 2>&1 || return 1
  local workspace_source="" stages force_build checkout_id node_modules_volume
  stages="$(requested_gui_stages)"
  force_build="${DEEPCODE_FORCE_BUILD:-0}"
  workspace_source="$(
    docker container inspect \
      --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' \
      deepcode-dev 2>/dev/null || true
  )"
  if [ -n "$workspace_source" ] \
    && [ "$(cd "$workspace_source" 2>/dev/null && pwd -P)" = "$(cd "$ROOT_DIR" && pwd -P)" ]; then
    log "ensure frontend product set in deepcode-dev: $stages"
    docker exec \
      -e PNPM_STORE_DIR=/root/.local/share/pnpm/store \
      -e DEEPCODE_FORCE_BUILD="$force_build" \
      deepcode-dev \
      bash -c "bash ./build.sh --stage '$stages'"
    return
  fi

  if [ -n "$workspace_source" ]; then
    log "deepcode-dev uses $workspace_source; ensure active-checkout frontends in one isolated container"
  else
    log "ensure active-checkout frontends in one isolated container"
  fi
  checkout_id="$(basename "$ROOT_DIR" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_.-' '-')"
  checkout_id="${checkout_id#-}"
  checkout_id="${checkout_id%-}"
  [ -n "$checkout_id" ] || checkout_id="checkout"
  node_modules_volume="${DEEPCODE_MACOS_NODE_MODULES_VOLUME:-deepcode-node-modules-$checkout_id}"
  docker run --rm \
    --mount "type=bind,src=$ROOT_DIR,dst=/workspace" \
    --mount "type=volume,src=$node_modules_volume,dst=/workspace/node_modules" \
    --mount "type=volume,src=deepcode-pnpm-store,dst=/root/.local/share/pnpm/store" \
    -e PNPM_STORE_DIR=/root/.local/share/pnpm/store \
    -e DEEPCODE_FORCE_BUILD="$force_build" \
    --workdir /workspace \
    deepcode-dev:latest \
    bash -c "bash ./build.sh --stage '$stages'"
}

all_frontend_dists_exist() {
  local original_product="$PRODUCT"
  local product
  for product in "${REQUESTED_PRODUCTS[@]}"; do
    configure_product "$product"
    if [ ! -f "$CLIENT_DIST_DIR/index.html" ]; then
      configure_product "$original_product"
      return 1
    fi
  done
  configure_product "$original_product"
}

prepare_all_tauri_dists() {
  local original_product="$PRODUCT"
  local product
  for product in "${REQUESTED_PRODUCTS[@]}"; do
    configure_product "$product"
    validate_frontend_dist "$CLIENT_DIST_DIR" "$PRODUCT"
    prepare_tauri_dist
  done
  configure_product "$original_product"
}

ensure_gui_dists() {
  if [ "$REFRESH_GUI_DIST" = "1" ] || ! all_frontend_dists_exist; then
    if ! refresh_gui_dists_with_docker; then
      if [ "$BUILD_GUI_ON_HOST" != "1" ] || [ "${#REQUESTED_PRODUCTS[@]}" -ne 1 ] || [ "${REQUESTED_PRODUCTS[0]}" != "DeepCode" ]; then
        fail "Docker frontend transaction failed; host fallback is supported only for a single DeepCode product"
      fi
      configure_product "DeepCode"
      ensure_node
      ensure_pnpm
      install_dependencies
      build_gui_dist
    fi
  else
    log "reuse current frontend product set"
  fi

  all_frontend_dists_exist || fail "one or more requested frontend distributions are missing"
  prepare_all_tauri_dists
}

build_gui_dist() {
  log "build TS protocol/session-core/React GUI"
  pnpm --filter @deepcode/protocol clean
  rm -f "$ROOT_DIR/userspace/protocol/tsconfig.tsbuildinfo"
  pnpm --filter @deepcode/protocol build
  pnpm --filter @deepcode/session-core build
  if [ "$PRODUCT" = "DeepCode-GUI" ]; then
    fail "DeepCode-GUI host-side frontend build is disabled; use Docker build stage deepcode-gui."
  fi
  pnpm --filter @deepcode/client build

  prepare_tauri_dist
}

build_rust_bins() {
  log "build Darwin Kernel/private Host proxy/CLI/TUI release binaries"
  DEEPCODE_BUILD_COMMIT="$BUILD_COMMIT" cargo build --locked --release \
    -p deepcode-kernel-daemon -p deepcode-host-web -p deepcode-cli -p deepcode-tui
}

build_tauri_app() {
  log "build macOS $PRODUCT Tauri shell binary"
  if (cd "$TAURI_SRC_DIR" && DEEPCODE_BUILD_COMMIT="$BUILD_COMMIT" cargo build --locked --release --bin "$TAURI_BIN_NAME"); then
    return
  fi

  if [ "$CARGO_OFFLINE" = "1" ] && [ "$TAURI_NETWORK_FALLBACK" = "1" ]; then
    log "retry Tauri shell build with Cargo network enabled"
    (cd "$TAURI_SRC_DIR" && CARGO_NET_OFFLINE=false DEEPCODE_BUILD_COMMIT="$BUILD_COMMIT" cargo build --locked --release --bin "$TAURI_BIN_NAME")
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

validate_protocol_v2_dist() {
  local dist_dir="$1"
  local label="$2"
  local emitted name source stem

  [ -d "$dist_dir" ] || fail "$label protocol dist is missing at $dist_dir"
  for emitted in "$dist_dir"/*; do
    [ -f "$emitted" ] || continue
    name="$(basename "$emitted")"
    case "$name" in
      *.d.ts.map) stem="${name%.d.ts.map}" ;;
      *.js.map) stem="${name%.js.map}" ;;
      *.d.ts) stem="${name%.d.ts}" ;;
      *.js) stem="${name%.js}" ;;
      *) continue ;;
    esac
    [ -f "$ROOT_DIR/userspace/protocol/src/$stem.ts" ] \
      || fail "$label protocol dist contains retired output without a source module: $name"
  done
  for source in "$ROOT_DIR"/userspace/protocol/src/*.ts; do
    [ -f "$source" ] || continue
    stem="$(basename "${source%.ts}")"
    [ -f "$dist_dir/$stem.js" ] \
      || fail "$label protocol dist is missing $stem.js"
    [ -f "$dist_dir/$stem.d.ts" ] \
      || fail "$label protocol dist is missing $stem.d.ts"
  done
  for name in index.js tools.js kernelAbiV2.js; do
    [ -f "$dist_dir/$name" ] \
      || fail "$label protocol dist is missing $name"
  done
  if find "$dist_dir" -maxdepth 1 -type f \
    \( -name 'kernel.*' -o -name 'kernelAbiV1.*' \) -print -quit | grep -q .; then
    fail "$label protocol dist contains a retired Kernel ABI module"
  fi
}

copy_session_core_runtime() {
  local session_dist="$ROOT_DIR/userspace/session-core/dist"
  local protocol_dist="$ROOT_DIR/userspace/protocol/dist"
  local session_dst="$BIN_DIR/session-core"
  local protocol_dst="$BIN_DIR/node_modules/@deepcode/protocol"

  [ -f "$session_dist/$SESSION_BRIDGE_NAME" ] || fail "session-core bridge missing at $session_dist/$SESSION_BRIDGE_NAME; build session-core before packaging"
  [ -d "$protocol_dist" ] || fail "protocol dist missing at $protocol_dist; build protocol before packaging"
  validate_protocol_v2_dist "$protocol_dist" "source"

  rm -rf "$session_dst" "$protocol_dst"
  mkdir -p "$session_dst/dist" "$protocol_dst/dist"
  cp -R "$session_dist/." "$session_dst/dist/"
  cp -R "$protocol_dist/." "$protocol_dst/dist/"
  validate_protocol_v2_dist "$protocol_dst/dist" "packaged"
  copy_required_file "$ROOT_DIR/userspace/session-core/package.json" "$session_dst/package.json" 644
  copy_required_file "$ROOT_DIR/userspace/protocol/package.json" "$protocol_dst/package.json" 644

  cat > "$session_dst/$SESSION_BRIDGE_NAME" <<BRIDGE
import "./dist/$SESSION_BRIDGE_NAME";
BRIDGE
  chmod 644 "$session_dst/$SESSION_BRIDGE_NAME"
}

ensure_packaged_node_runtime() {
  local src=""
  if [ -x "$NODE_HOME/bin/node" ]; then
    src="$NODE_HOME/bin/node"
  else
    ensure_node
    if [ -x "$NODE_HOME/bin/node" ]; then
      src="$NODE_HOME/bin/node"
    elif command -v node >/dev/null 2>&1; then
      src="$(command -v node)"
    fi
  fi

  [ -n "$src" ] && [ -x "$src" ] || fail "node 20+ not found for packaged daemon session runtime"
  local node_major
  node_major="$("$src" -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"
  [ "$node_major" -ge 20 ] 2>/dev/null || fail "packaged node runtime is too old: $("$src" --version 2>/dev/null || printf 'unknown')"

  rm -rf "$BIN_DIR/node"
  mkdir -p "$BIN_DIR/node/bin"
  install -m 755 "$src" "$BIN_DIR/node/bin/node"
}

copy_web_dist() {
  local dst="$1"
  [ -f "$CLIENT_DIST_DIR/index.html" ] || fail "GUI dist missing at $CLIENT_DIST_DIR"
  validate_frontend_dist "$CLIENT_DIST_DIR" "$PRODUCT"
  rm -rf "$dst"
  mkdir -p "$dst"
  cp -R "$CLIENT_DIST_DIR/." "$dst/"
}

verify_copied_web_dist() {
  local dst="$1"
  local source_index="$CLIENT_DIST_DIR/index.html"
  local copied_index="$dst/index.html"
  local source_assets copied_assets asset source_hash copied_hash

  [ -f "$copied_index" ] || fail "$PRODUCT bundled frontend dist missing index.html at $copied_index"
  source_assets="$(frontend_asset_manifest "$source_index")"
  copied_assets="$(frontend_asset_manifest "$copied_index")"
  [ -n "$source_assets" ] || fail "$PRODUCT source frontend dist has no css/js assets at $source_index"
  [ "$source_assets" = "$copied_assets" ] || {
    printf '==[macos-package][error]== source assets:\n%s\n' "$source_assets" >&2
    printf '==[macos-package][error]== bundled assets:\n%s\n' "$copied_assets" >&2
    fail "$PRODUCT bundled frontend asset manifest does not match source dist."
  }

  while IFS= read -r asset; do
    [ -f "$CLIENT_DIST_DIR/$asset" ] || fail "$PRODUCT source frontend asset missing: $asset"
    [ -f "$dst/$asset" ] || fail "$PRODUCT bundled frontend asset missing: $asset"
    source_hash="$(shasum -a 256 "$CLIENT_DIST_DIR/$asset" | awk '{ print $1 }')"
    copied_hash="$(shasum -a 256 "$dst/$asset" | awk '{ print $1 }')"
    [ "$source_hash" = "$copied_hash" ] || fail "$PRODUCT bundled frontend asset hash mismatch: $asset"
  done <<ASSETS
$source_assets
ASSETS

  log "$PRODUCT bundled frontend assets: $(frontend_asset_summary "$copied_index")"
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
  "agent.requirementConfirmationMode": "auto",
  "agent.reviewContinuationMode": "auto",
  "agent.interventionLevel": "medium",
  "agent.memory.projectMode": "confirm",
  "agent.permissions.workspaceRead": "allow",
  "agent.permissions.autoApprovePlans": false,
  "agent.permissions.workspaceWrite": "ask",
  "agent.permissions.gitWrite": "ask",
  "agent.permissions.webRead": "deny",
  "agent.permissions.privateWebRead": "deny",
  "agent.permissions.processExec": "deny",
  "agent.permissions.browserControl": "deny",
  "agent.permissions.providerEgress": "ask",
  "agent.web.search.endpointTemplate": "",
  "agent.web.search.authHeaderName": "Authorization",
  "agent.web.search.authSecretRef": "",
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
TUI_BIN="\$SCRIPT_DIR/libexec/$TUI_EXEC_NAME"
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
if [ -f "\$SCRIPT_DIR/session-core/$SESSION_BRIDGE_NAME" ]; then
  export DEEPCODE_SESSION_BRIDGE="\$SCRIPT_DIR/session-core/$SESSION_BRIDGE_NAME"
fi
if [ -x "\$SCRIPT_DIR/node/bin/node" ]; then
  export DEEPCODE_NODE="\$SCRIPT_DIR/node/bin/node"
elif [ "\${DEEPCODE_NODE:-}" = "" ] && command -v node >/dev/null 2>&1; then
  export DEEPCODE_NODE="\$(command -v node)"
fi
TUI_ARGS=(--api "\$API_URL")
if [ "\${DEEPCODE_WORKSPACE:-}" != "" ]; then
  TUI_ARGS+=(--workspace "\$DEEPCODE_WORKSPACE")
fi
"\$TUI_BIN" "\${TUI_ARGS[@]}" "\$@"
LAUNCHER
  chmod +x "$BIN_DIR/$TUI_COMMAND_NAME"
}

write_cli_launcher() {
  [ "$WRITE_TUI_LAUNCHER" = "1" ] || return 0
  cat > "$BIN_DIR/$CLI_COMMAND_NAME" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CLI_BIN="\$SCRIPT_DIR/libexec/$CLI_EXEC_NAME"
KERNEL_BIN="\$SCRIPT_DIR/deepcode-kernel"
CONFIG_ROOT="\${DEEPCODE_CONFIG_DIR:-\$SCRIPT_DIR}"
HOST="\${DEEPCODE_HOST:-127.0.0.1}"
PORT="\${DEEPCODE_PORT:-$DEFAULT_PORT}"

fail() {
  printf '$PRODUCT CLI launcher error: %s\n' "\$*" >&2
  printf 'Press Enter to close this window...'
  read -r _ || true
  exit 1
}

[ -x "\$CLI_BIN" ] || fail "missing executable: \$CLI_BIN"
[ -x "\$KERNEL_BIN" ] || fail "missing executable: \$KERNEL_BIN"

export DEEPCODE_HOST="\$HOST"
export DEEPCODE_PORT="\$PORT"
export DEEPCODE_CONFIG_DIR="\$CONFIG_ROOT"
export DEEPCODE_KERNEL_BIN="\$KERNEL_BIN"
if [ -f "\$SCRIPT_DIR/session-core/$SESSION_BRIDGE_NAME" ]; then
  export DEEPCODE_SESSION_BRIDGE="\$SCRIPT_DIR/session-core/$SESSION_BRIDGE_NAME"
fi
if [ -x "\$SCRIPT_DIR/node/bin/node" ]; then
  export DEEPCODE_NODE="\$SCRIPT_DIR/node/bin/node"
elif [ "\${DEEPCODE_NODE:-}" = "" ] && command -v node >/dev/null 2>&1; then
  export DEEPCODE_NODE="\$(command -v node)"
fi

"\$CLI_BIN" "\$@"
LAUNCHER
  chmod +x "$BIN_DIR/$CLI_COMMAND_NAME"
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
  command -v codesign >/dev/null 2>&1 \
    || fail "codesign is required to publish $APP_NAME.app"
  log "ad-hoc sign $APP_NAME.app"
  codesign --force --deep --sign - "$app_dir" >/dev/null 2>&1 \
    || fail "ad-hoc signing failed for $APP_NAME.app"
  codesign --verify --deep --strict "$app_dir" >/dev/null 2>&1 \
    || fail "strict signature verification failed for $APP_NAME.app"
}

sync_signed_kernel_sidecar_to_root() {
  local app_kernel="$BIN_DIR/$APP_NAME.app/Contents/MacOS/deepcode-kernel"
  [ -x "$app_kernel" ] || fail "missing bundled Kernel sidecar: $app_kernel"
  install -m 755 "$app_kernel" "$BIN_DIR/deepcode-kernel"
}

write_readme() {
  local terminal_section root_web_entry asset_entries notes app_entries gui_section note_assets
  if [ "$WRITE_TUI_LAUNCHER" = "1" ]; then
    terminal_section="TUI/CLI:
  ./$TUI_COMMAND_NAME
  DEEPCODE_WORKSPACE=/path/to/project ./$TUI_COMMAND_NAME
  ./$TUI_COMMAND_NAME --smoke -C /path/to/project
  In TUI, /cancel submits a daemon session run cancel and refreshes shared session projection.
  ./$CLI_COMMAND_NAME --help
  ./$CLI_COMMAND_NAME ask -C /path/to/project \"explain this project\""
  else
    terminal_section="TUI/CLI:
  Use the shared DeepCode package terminal launchers. DeepCode-GUI is only an alternate GUI shell."
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
  TUI/CLI ordinary input, decisions, and cancel requests go through the daemon
  shared Session Runtime run API. The daemon uses session-core/dist/$SESSION_BRIDGE_NAME,
  package-local node/bin/node, and node_modules/@deepcode/protocol internally.
  Set DEEPCODE_NODE or DEEPCODE_SESSION_BRIDGE only when overriding that packaged
  daemon runtime. DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS controls the daemon session
  run hard timeout; default 600000 ms, 0 disables it.
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
    app_entries="  DeepCode.app              Native macOS Editor shell. Starts its bundled Kernel and private Host proxy."
    gui_section="  open DeepCode.app"
    note_assets="  DeepCode.app contains deepcode-kernel, deepcode-host-web, and web/ under Contents/MacOS."
  fi
  if [ "$PRODUCT" = "DeepCode-GUI" ] || [ -d "$BIN_DIR/DeepCode-GUI.app" ]; then
    if [ "$WEB_DIR_NAME" != "web-deepcode-gui" ]; then
      asset_entries="$asset_entries
  DeepCode-GUI.app/Contents/MacOS/web-deepcode-gui/
                         Bundled conversational GUI assets."
    fi
    if [ -n "$app_entries" ]; then
      app_entries="$app_entries
  DeepCode-GUI.app          Native macOS conversational GUI shell. Starts its bundled Kernel and private Host proxy."
      gui_section="$gui_section
  open DeepCode-GUI.app"
      note_assets="$note_assets
  DeepCode-GUI.app contains deepcode-kernel, deepcode-host-web, and web-deepcode-gui/ under Contents/MacOS."
    else
      app_entries="  DeepCode-GUI.app          Native macOS conversational GUI shell. Starts its bundled Kernel and private Host proxy."
      gui_section="  open DeepCode-GUI.app"
      note_assets="  DeepCode-GUI.app contains deepcode-kernel, deepcode-host-web, and web-deepcode-gui/ under Contents/MacOS."
    fi
  fi

  cat > "$BIN_DIR/README.txt" <<README
DeepCode macOS arm64 Distribution
=================================

GUI:
$gui_section

$terminal_section

Files:
$app_entries
  deepcode-kernel           Darwin arm64 Kernel daemon.
  $TUI_COMMAND_NAME         User-facing TUI launcher.
  $CLI_COMMAND_NAME         User-facing CLI launcher.
  libexec/$CLI_EXEC_NAME    Internal Darwin arm64 CLI host.
  libexec/$TUI_EXEC_NAME    Internal Darwin arm64 Ratatui/Crossterm TUI host.
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
  "buildTimeUtc": "$BUILD_TIME_UTC",
  "sourceDirty": $SOURCE_DIRTY,
  "sourceStatusHash": "$SOURCE_STATUS_HASH",
  "sourceFingerprint": "$SOURCE_FINGERPRINT",
  "kernelAbiVersion": "$KERNEL_ABI_VERSION",
  "toolRegistryVersion": "$TOOL_REGISTRY_VERSION",
  "sessionBridge": "$SESSION_BRIDGE_NAME",
  "product": "$product"
}
JSON
}

prepare_shared_distribution() {
  log "prepare shared runtime in $BIN_DIR"
  mkdir -p "$BIN_DIR"
  rm -rf "$LIBEXEC_DIR" "$BIN_DIR/session-core" "$BIN_DIR/node_modules" "$BIN_DIR/node"
  mkdir -p "$LIBEXEC_DIR"
  rm -f \
    "$BIN_DIR/$CLI_COMMAND_NAME" \
    "$BIN_DIR/deepcode-cli" \
    "$BIN_DIR/deepcode-tui" \
    "$BIN_DIR/README.txt"
  configure_product "DeepCode"
  prepare_portable_config_root
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" "$BIN_DIR/deepcode-kernel" 755
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-cli" "$LIBEXEC_DIR/$CLI_EXEC_NAME" 755
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-tui" "$LIBEXEC_DIR/$TUI_EXEC_NAME" 755
  copy_session_core_runtime
  ensure_packaged_node_runtime
  write_build_info "$BIN_DIR/build-info.json" "macos-arm64"
}

stage_product_app() {
  local stage_app="$PACKAGE_STAGE_ROOT/$APP_NAME.app"
  local app_macos_dir="$stage_app/Contents/MacOS"
  local app_resources_dir="$stage_app/Contents/Resources"
  log "stage $APP_NAME.app"
  rm -rf "$stage_app"
  mkdir -p "$app_macos_dir" "$app_resources_dir"
  write_app_info_plist "$stage_app/Contents/Info.plist"

  copy_required_file "$CARGO_TARGET_ROOT/release/$TAURI_BIN_NAME" "$app_macos_dir/$TAURI_BIN_NAME" 755
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-kernel-daemon" "$app_macos_dir/deepcode-kernel" 755
  copy_required_file "$CARGO_TARGET_ROOT/release/deepcode-host-web" "$app_macos_dir/deepcode-host-web" 755
  write_build_info "$app_macos_dir/build-info.json"

  copy_web_dist "$app_macos_dir/$WEB_DIR_NAME"
  verify_copied_web_dist "$app_macos_dir/$WEB_DIR_NAME"
  sign_app_bundle "$stage_app"
}

publish_product_apps() {
  local product stage_app final_app
  verify_source_fingerprint_unchanged
  for product in "${REQUESTED_PRODUCTS[@]}"; do
    configure_product "$product"
    stage_app="$PACKAGE_STAGE_ROOT/$APP_NAME.app"
    final_app="$BIN_DIR/$APP_NAME.app"
    [ -d "$stage_app" ] || fail "missing staged app: $stage_app"

    rm -rf "$final_app"
    mv "$stage_app" "$final_app"
    if [ "$COPY_ROOT_WEB_DIST" = "1" ]; then
      copy_web_dist "$BIN_DIR/$WEB_DIR_NAME"
      verify_copied_web_dist "$BIN_DIR/$WEB_DIR_NAME"
    fi
    sync_signed_kernel_sidecar_to_root
  done
  verify_packaged_kernel_markers
}

finalize_shared_distribution() {
  configure_product "DeepCode"
  if [ -f "$BIN_DIR/web/index.html" ]; then
    write_tui_launcher
    write_cli_launcher
  else
    rm -f "$BIN_DIR/DeepCode-TUI.command" "$BIN_DIR/$CLI_COMMAND_NAME"
  fi
  write_readme
}

verify_packaged_kernel_markers() {
  local kernel_bin="$BIN_DIR/deepcode-kernel"
  local original_product="$PRODUCT"
  local product app_kernel_bin app_host_proxy root_hash app_hash build_info build_info_commit build_info_fingerprint build_info_product
  local build_info_kernel_abi build_info_tool_registry build_info_session_bridge strings_file
  local checked_app=0
  [ -x "$kernel_bin" ] || fail "missing packaged Kernel binary: $kernel_bin"
  root_hash="$(shasum -a 256 "$kernel_bin" | awk '{print $1}')"
  [ -f "$BIN_DIR/build-info.json" ] || fail "missing root build-info.json"

  for build_info in "$BIN_DIR/build-info.json"; do
    build_info_commit="$(awk -F '"' '/"buildCommit"/ { print $4; exit }' "$build_info")"
    build_info_fingerprint="$(awk -F '"' '/"sourceFingerprint"/ { print $4; exit }' "$build_info")"
    build_info_kernel_abi="$(awk -F '"' '/"kernelAbiVersion"/ { print $4; exit }' "$build_info")"
    build_info_tool_registry="$(awk -F '"' '/"toolRegistryVersion"/ { print $4; exit }' "$build_info")"
    build_info_session_bridge="$(awk -F '"' '/"sessionBridge"/ { print $4; exit }' "$build_info")"
    [ "$build_info_commit" = "$BUILD_COMMIT" ] || fail "$build_info buildCommit=$build_info_commit does not match current build commit $BUILD_COMMIT"
    [ "$build_info_fingerprint" = "$SOURCE_FINGERPRINT" ] || fail "$build_info source fingerprint does not match the package transaction"
    [ "$build_info_kernel_abi" = "$KERNEL_ABI_VERSION" ] || fail "$build_info kernelAbiVersion=$build_info_kernel_abi does not match $KERNEL_ABI_VERSION"
    [ "$build_info_tool_registry" = "$TOOL_REGISTRY_VERSION" ] || fail "$build_info toolRegistryVersion=$build_info_tool_registry does not match $TOOL_REGISTRY_VERSION"
    [ "$build_info_session_bridge" = "$SESSION_BRIDGE_NAME" ] || fail "$build_info sessionBridge=$build_info_session_bridge does not match $SESSION_BRIDGE_NAME"
  done

  for product in DeepCode-GUI DeepCode; do
    configure_product "$product"
    [ -d "$BIN_DIR/$APP_NAME.app" ] || continue
    checked_app=1
    app_kernel_bin="$BIN_DIR/$APP_NAME.app/Contents/MacOS/deepcode-kernel"
    app_host_proxy="$BIN_DIR/$APP_NAME.app/Contents/MacOS/deepcode-host-web"
    build_info="$BIN_DIR/$APP_NAME.app/Contents/MacOS/build-info.json"
    [ -x "$app_kernel_bin" ] || fail "missing bundled Kernel binary: $app_kernel_bin"
    [ -x "$app_host_proxy" ] || fail "missing bundled private Host proxy: $app_host_proxy"
    codesign --verify --deep --strict "$BIN_DIR/$APP_NAME.app" >/dev/null 2>&1 \
      || fail "published $APP_NAME.app failed strict signature verification"
    app_hash="$(shasum -a 256 "$app_kernel_bin" | awk '{print $1}')"
    [ "$root_hash" = "$app_hash" ] || fail "root deepcode-kernel and $APP_NAME.app bundled Kernel differ"
    [ -f "$build_info" ] || fail "missing bundled build-info.json: $build_info"
    build_info_commit="$(awk -F '"' '/"buildCommit"/ { print $4; exit }' "$build_info")"
    build_info_fingerprint="$(awk -F '"' '/"sourceFingerprint"/ { print $4; exit }' "$build_info")"
    build_info_product="$(awk -F '"' '/"product"/ { print $4; exit }' "$build_info")"
    build_info_kernel_abi="$(awk -F '"' '/"kernelAbiVersion"/ { print $4; exit }' "$build_info")"
    build_info_tool_registry="$(awk -F '"' '/"toolRegistryVersion"/ { print $4; exit }' "$build_info")"
    build_info_session_bridge="$(awk -F '"' '/"sessionBridge"/ { print $4; exit }' "$build_info")"
    [ "$build_info_commit" = "$BUILD_COMMIT" ] || fail "$build_info buildCommit=$build_info_commit does not match current build commit $BUILD_COMMIT"
    [ "$build_info_fingerprint" = "$SOURCE_FINGERPRINT" ] || fail "$build_info source fingerprint does not match the package transaction"
    [ "$build_info_product" = "$product" ] || fail "$build_info product=$build_info_product does not match app product $product"
    [ "$build_info_kernel_abi" = "$KERNEL_ABI_VERSION" ] || fail "$build_info kernelAbiVersion=$build_info_kernel_abi does not match $KERNEL_ABI_VERSION"
    [ "$build_info_tool_registry" = "$TOOL_REGISTRY_VERSION" ] || fail "$build_info toolRegistryVersion=$build_info_tool_registry does not match $TOOL_REGISTRY_VERSION"
    [ "$build_info_session_bridge" = "$SESSION_BRIDGE_NAME" ] || fail "$build_info sessionBridge=$build_info_session_bridge does not match $SESSION_BRIDGE_NAME"
  done
  [ "$checked_app" = "1" ] || fail "no packaged macOS app was published in $BIN_DIR"
  configure_product "$original_product"

  strings_file="$(mktemp "${TMPDIR:-/tmp}/deepcode-kernel-strings.XXXXXX")"
  strings "$kernel_bin" >"$strings_file"
  grep -Fq "$KERNEL_ABI_VERSION" "$strings_file" || { rm -f "$strings_file"; fail "$kernel_bin is missing $KERNEL_ABI_VERSION marker"; }
  grep -Fq "$TOOL_REGISTRY_VERSION" "$strings_file" || { rm -f "$strings_file"; fail "$kernel_bin is missing $TOOL_REGISTRY_VERSION marker"; }
  grep -Fq 'web.search' "$strings_file" || { rm -f "$strings_file"; fail "$kernel_bin tool catalog is missing web.search"; }
  grep -Fq 'git.status' "$strings_file" || { rm -f "$strings_file"; fail "$kernel_bin tool catalog is missing git.status"; }
  ! grep -Fq 'Kernel terminal placeholder ready' "$strings_file" || { rm -f "$strings_file"; fail "$kernel_bin still contains old placeholder terminal runtime"; }
  ! grep -Fq 'terminal runtime reserved' "$strings_file" || { rm -f "$strings_file"; fail "$kernel_bin still contains reserved terminal placeholder output"; }
  grep -Fq 'Host PTY terminal runtime is ready.' "$strings_file" || { rm -f "$strings_file"; fail "$kernel_bin is missing Host PTY terminal runtime marker"; }
  rm -f "$strings_file"
}

run_timed_phase() {
  local label="$1"
  shift
  local started="$SECONDS"
  "$@"
  log "$label completed in $((SECONDS - started))s"
}

main() {
  local product
  cd "$ROOT_DIR"
  prepend_path_dir "$HOME/.cargo/bin"
  prepend_path_dir "$HOME/.local/bin"
  prepend_path_dir "${PNPM_HOME:-$HOME/Library/pnpm}"
  prepend_path_dir "$HOME/bin"

  ensure_macos_arm64
  ensure_xcode_tools
  for product in "${REQUESTED_PRODUCTS[@]}"; do
    configure_product "$product"
    release_or_fail_if_target_app_is_running
  done
  if [ "$CLEAN_PACKAGE_CACHE" = "1" ]; then
    clean_shared_package_cache
    for product in "${REQUESTED_PRODUCTS[@]}"; do
      configure_product "$product"
      clean_product_package_cache
    done
  fi
  ensure_rust
  run_timed_phase "Cargo dependency readiness" ensure_cargo_cache
  configure_cargo_network_mode
  run_timed_phase "frontend product set" ensure_gui_dists
  run_timed_phase "Darwin shared binaries" build_rust_bins

  rm -rf "$PACKAGE_STAGE_ROOT"
  mkdir -p "$PACKAGE_STAGE_ROOT"
  for product in "${REQUESTED_PRODUCTS[@]}"; do
    configure_product "$product"
    run_timed_phase "$PRODUCT Tauri shell" build_tauri_app
    run_timed_phase "$PRODUCT app staging" stage_product_app
  done

  verify_source_fingerprint_unchanged
  run_timed_phase "shared runtime assembly" prepare_shared_distribution
  run_timed_phase "product-set publish" publish_product_apps
  finalize_shared_distribution
  verify_source_fingerprint_unchanged
  rm -rf "$PACKAGE_STAGE_ROOT"

  log "done: $BIN_DIR"
  for product in "${REQUESTED_PRODUCTS[@]}"; do
    log "GUI: open $BIN_DIR/$product.app"
  done
  if [ -f "$BIN_DIR/DeepCode-TUI.command" ]; then
    log "TUI: open $BIN_DIR/$TUI_COMMAND_NAME"
    log "CLI: open $BIN_DIR/$CLI_COMMAND_NAME or run it with arguments"
  else
    log "TUI/CLI: use the shared DeepCode package terminal launchers"
  fi
}

main "$@"
