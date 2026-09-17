#!/usr/bin/env bash
# One invocation prepares shared assets once, then builds the selected native targets.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/source-identity.sh"
CONTAINER_NAME="${CONTAINER_NAME:-deepcode-dev}"
WORKDIR_IN_CTNR="${WORKDIR_IN_CTNR:-/workspace}"
OUTPUT_DIR="${DEEPCODE_OUTPUT_DIR:-$ROOT_DIR/bin}"
[[ "$OUTPUT_DIR" = /* ]] || OUTPUT_DIR="$ROOT_DIR/$OUTPUT_DIR"
export DEEPCODE_BUILD_COMMIT="${DEEPCODE_BUILD_COMMIT:-$(deepcode_source_commit "$ROOT_DIR")}"
export DEEPCODE_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAGES=()
usage() {
  cat <<'HELP'
Usage: bash build.sh [--stage STAGE]...
  package (default)    Build every available platform; fail if none built.
  package-linux       Linux runtime for the container architecture.
  package-windows     Windows x64 runtime (GNU cross toolchain).
  package-macos       macOS arm64 runtime; invoke on the macOS host.
  ui                  Build shared TypeScript + GUI once, publish bin/ui.
  daemon | cli | tui  Build only the selected Linux native executable.
  native-gui          Build only the Linux native GUI shell.
Environment: CONTAINER_NAME, WORKDIR_IN_CTNR, DEEPCODE_OUTPUT_DIR,
  CARGO_TARGET_DIR, RUSTC_WRAPPER, SCCACHE_DIR,
  DEEPCODE_MACOS_CARGO, DEEPCODE_MACOS_NODE_BIN, DEEPCODE_MACOS_CARGO_TARGET_DIR.
Tools must already be installed. Package stages use a fresh staging directory;
Cargo/pnpm caches are retained. User data in existing output directories is retained.
HELP
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; STAGES+=("$2"); shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ "${#STAGES[@]}" -gt 0 ] || STAGES=(package)
IN_CONTAINER=0
[ ! -f /.dockerenv ] || IN_CONTAINER=1
if [ "$IN_CONTAINER" -eq 0 ]; then
  mounted_root="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$WORKDIR_IN_CTNR\"}}{{.Source}}{{end}}{{end}}" "$CONTAINER_NAME")"
  [ "$mounted_root" = "$ROOT_DIR" ] || { printf 'Container %s mounts another worktree; use make shell with this worktree configuration.\n' "$CONTAINER_NAME" >&2; exit 1; }
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" = true ] || { printf 'Container is not running; use make shell.\n' >&2; exit 1; }
fi
case "$OUTPUT_DIR/" in "$ROOT_DIR/"*) ;; *) printf 'Output must be inside the mounted worktree.\n' >&2; exit 2 ;; esac
mkdir -p "$OUTPUT_DIR" "$ROOT_DIR/.build-cache"
TRANSACTION="$(mktemp -d "$ROOT_DIR/.build-cache/package.XXXXXX")"
cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  if [ "$IN_CONTAINER" -eq 0 ] && [ -f "$TRANSACTION/container.pid" ]; then
    local process_group
    process_group="$(cat "$TRANSACTION/container.pid")"
    docker exec "$CONTAINER_NAME" kill -TERM -- "-$process_group" || printf 'Could not stop this build process group: %s\n' "$process_group" >&2
  fi
  rm -rf -- "$TRANSACTION"
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
container_path() { printf '%s/%s' "$WORKDIR_IN_CTNR" "${1#"$ROOT_DIR/"}"; }
container_step() {
  if [ "$IN_CONTAINER" -eq 1 ]; then
    bash "$ROOT_DIR/scripts/build-platforms.sh" "$@"
  else
    local name
    local environment=(-e DEEPCODE_BUILD_COMMIT -e DEEPCODE_BUILD_TIME)
    for name in PNPM_STORE_DIR DEEPCODE_WINDOWS_NODE_BIN DEEPCODE_NODE_LICENSE DEEPCODE_DISABLE_SCCACHE; do
      [ -z "${!name+x}" ] || environment+=(-e "$name")
    done
    docker exec -w "$WORKDIR_IN_CTNR" "${environment[@]}" -e DEEPCODE_BUILD_PID_FILE="$(container_path "$TRANSACTION")/container.pid" "$CONTAINER_NAME" setsid --wait bash ./scripts/build-platforms.sh "$@"
  fi
}
if [ "$IN_CONTAINER" -eq 1 ]; then
  SHARED_DIR="$TRANSACTION/shared"
  CONTAINER_OUTPUT="$OUTPUT_DIR"
else
  SHARED_DIR="$(container_path "$TRANSACTION")/shared"
  CONTAINER_OUTPUT="$(container_path "$OUTPUT_DIR")"
fi
platforms=()
native_stages=()
ui=0
all=0
add_platform() { local existing; for existing in "${platforms[@]:-}"; do [ "$existing" != "$1" ] || return 0; done; platforms+=("$1"); }
for stage in "${STAGES[@]}"; do
  case "$stage" in
    package) all=1; add_platform linux; add_platform windows; add_platform macos ;;
    package-linux|package-windows|package-macos) add_platform "${stage#package-}" ;;
    ui) ui=1 ;;
    daemon|cli|tui|native-gui) native_stages+=("$stage") ;;
    *) printf 'Unknown stage: %s\n' "$stage" >&2; usage >&2; exit 2 ;;
  esac
done
available=()
for platform in "${platforms[@]:-}"; do
  [ -n "$platform" ] || continue
  if [ "$platform" = macos ]; then
    check=(bash "$ROOT_DIR/scripts/package-macos.sh" --check)
  else
    check=(container_step --check "$platform")
  fi
  if reason="$("${check[@]}" 2>&1)"; then
    available+=("$platform")
  elif [ "$all" -eq 1 ]; then
    printf '==[build][SKIPPED]== %s: %s\n' "$platform" "$reason"
  else
    printf '==[build][error]== %s: %s\n' "$platform" "$reason" >&2; exit 1
  fi
done
[ "${#platforms[@]}" -eq 0 ] || [ "${#available[@]}" -gt 0 ] || { printf 'No platform can be built.\n' >&2; exit 1; }
started=$SECONDS
if [ "$ui" -eq 1 ] || [ "${#available[@]}" -gt 0 ]; then
  container_step --shared "$SHARED_DIR"
fi
if [ "$ui" -eq 1 ]; then
  python3 "$ROOT_DIR/scripts/update-ui.py" --assets "$TRANSACTION/shared/web-deepcode-gui" --output "$OUTPUT_DIR/ui/web-deepcode-gui"
  rm -rf -- "$OUTPUT_DIR/ui/web"
fi
for stage in "${native_stages[@]:-}"; do
  [ -z "$stage" ] || container_step --native "$stage"
done
built=0
for platform in "${available[@]:-}"; do
  [ -n "$platform" ] || continue
  phase_start=$SECONDS
  printf '==[build][platform][START]== %s\n' "$platform"
  if [ "$platform" = macos ]; then
    bash "$ROOT_DIR/scripts/package-macos.sh" "$TRANSACTION/shared" "$OUTPUT_DIR"
  else
    container_step --package "$platform" "$SHARED_DIR" "$CONTAINER_OUTPUT"
  fi
  built=$((built + 1))
  printf '==[build][platform][DONE]== %s seconds=%s\n' "$platform" "$((SECONDS - phase_start))"
done
printf '==[build][DONE]== packages=%s seconds=%s output=%s\n' "$built" "$((SECONDS - started))" "$OUTPUT_DIR"
