#!/usr/bin/env bash
# Platform preflight and the sequential default build. No toolchain installation.

build_platform_support() {
  local platform="$1" tool required node_bin
  if [ "$platform" = macos ]; then
    if is_docker_environment; then
      bash "$ROOT_DIR/scripts/macos-package-service.sh" status --quiet >/dev/null 2>&1 || {
        printf 'macOS arm64 package worker is unavailable for this worktree\n'; return 1;
      }
      return 0
    fi
    [ "$(uname -s)/$(uname -m)" = Darwin/arm64 ] || {
      printf 'requires a macOS arm64 host or its package worker\n'; return 1;
    }
    # Match the native packager's existing user toolchain locations.
    local PATH="$HOME/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    for tool in xcodebuild xcrun cargo rustc node; do
      command -v "$tool" >/dev/null 2>&1 || { printf 'missing macOS tool: %s\n' "$tool"; return 1; }
    done
    xcrun --find clang >/dev/null 2>&1 && xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 || {
      printf 'macOS SDK/clang is unavailable\n'; return 1;
    }
    # macOS packaging also builds the frontends through the project container.
    build_container_support || return 1
  elif ! is_docker_environment; then
    build_container_support || return 1
    docker exec "${CONTAINER_NAME:-deepcode-dev}" bash ./scripts/build-platforms.sh --check "$platform"
    return $?
  else
    for tool in cargo rustc node pnpm cc pkg-config; do
      command -v "$tool" >/dev/null 2>&1 || { printf 'missing build tool: %s\n' "$tool"; return 1; }
    done
  fi

  required="$(awk -F '"' '/^[[:space:]]*channel[[:space:]]*=/ { print $2; exit }' "$ROOT_DIR/rust-toolchain.toml")"
  if command -v rustup >/dev/null 2>&1; then
    rustup toolchain list | grep -Eq "^${required}(-|[[:space:]])" || {
      printf 'Rust toolchain %s is not installed\n' "$required"; return 1;
    }
  fi
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1 || {
    printf 'Node 20+ is unavailable\n'; return 1;
  }
  case "$platform" in
    linux)
      pkg-config --exists openssl gtk+-3.0 webkit2gtk-4.1 ayatana-appindicator3-0.1 librsvg-2.0 || {
        printf 'Linux desktop SDK is incomplete (OpenSSL/GTK/WebKitGTK/AppIndicator/librsvg)\n'; return 1;
      }
      node_bin="${DEEPCODE_LINUX_NODE_BIN:-$(command -v node)}"
      [ -x "$node_bin" ] || { printf 'Linux Node runtime is unavailable: %s\n' "$node_bin"; return 1; }
      ;;
    windows)
      for tool in x86_64-w64-mingw32-gcc x86_64-w64-mingw32-g++ x86_64-w64-mingw32-ar x86_64-w64-mingw32-windres; do
        command -v "$tool" >/dev/null 2>&1 || { printf 'missing Windows GNU tool: %s\n' "$tool"; return 1; }
      done
      local target_libdir
      target_libdir="$(rustc --print target-libdir --target x86_64-pc-windows-gnu 2>/dev/null)"
      [ -d "$target_libdir" ] || { printf 'Rust target x86_64-pc-windows-gnu is not installed\n'; return 1; }
      node_bin="${DEEPCODE_WINDOWS_NODE_BIN:-/opt/deepcode-node-win64/node.exe}"
      [ -f "$node_bin" ] || { printf 'Windows Node runtime is unavailable: %s\n' "$node_bin"; return 1; }
      ;;
    macos) ;;
    *) printf 'unknown platform: %s\n' "$platform"; return 1 ;;
  esac
}

build_container_support() {
  local container="${CONTAINER_NAME:-deepcode-dev}" mounted_root
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
    printf 'Docker daemon is unavailable\n'; return 1;
  }
  [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = true ] || {
    printf 'project container %s is not running; prepare it with make shell\n' "$container"; return 1;
  }
  mounted_root="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "$container")"
  [ "$mounted_root" = "$ROOT_DIR" ] || {
    printf 'project container %s is mounted to another worktree\n' "$container"; return 1;
  }
}

build_selected_platform() {
  local platform="$1"
  local args=(--stage "package-$platform")
  if [ "$platform" = macos ]; then
    [ "$clean_cache" != 1 ] || args+=(--clean-cache)
    [ "$kill_running" != 0 ] || args+=(--no-kill-running)
  fi
  # A fresh shell retains errexit inside the build, even though the caller
  # captures its status to continue with the other independent platforms.
  bash "$ROOT_DIR/build.sh" "${args[@]}"
}

run_all_platform_builds() {
  local platform reason status failed=0 built=0 skipped=0 interrupted=0
  local summaries=()
  for platform in linux windows macos; do
    if reason="$(build_platform_support "$platform")"; then
      printf '\n==[build][platform][START]== %s\n' "$platform"
      if build_selected_platform "$platform"; then
        built=$((built + 1))
        summaries+=("$platform: BUILT")
      else
        status=$?
        failed=$((failed + 1))
        summaries+=("$platform: FAILED (exit=$status; see its build log above)")
        case "$status" in
          130|143) interrupted="$status"; break ;;
        esac
      fi
    else
      skipped=$((skipped + 1))
      summaries+=("$platform: SKIPPED ($reason)")
      printf '==[build][platform][SKIPPED]== %s: %s\n' "$platform" "$reason"
    fi
  done
  printf '\n==[build][SUMMARY]== built=%s skipped=%s failed=%s\n' "$built" "$skipped" "$failed"
  printf '  %s\n' "${summaries[@]}"
  printf '  Linux uses the development container architecture; other Linux architectures require a matching container.\n'
  if [ "$built" -eq 0 ]; then
    printf '  No new distribution was produced by this build.\n'
  fi
  if [ "$interrupted" -ne 0 ]; then
    printf '  Build interrupted; remaining platforms were not started.\n'
    return "$interrupted"
  fi
  [ "$failed" -eq 0 ]
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  is_docker_environment() {
    [ -f /.dockerenv ] || grep -qaE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null
  }
  [ "${1:-}" = --check ] && [ "$#" -eq 2 ] || { printf 'Usage: %s --check linux|windows|macos\n' "$0" >&2; exit 2; }
  build_platform_support "$2"
fi
