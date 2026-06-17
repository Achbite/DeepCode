#!/usr/bin/env bash
# ====================================================================
# Cargo registry fallback wrapper
# 用途：
#   - 默认先使用仓库现有 Cargo 配置。
#   - 仅当失败日志命中 registry / network / TLS 下载错误时，临时切换到备用 sparse 源重试一次。
#   - 不修改 .cargo/config.toml，不影响业务编译错误的失败语义。
# ====================================================================
set -euo pipefail

MODE="${DEEPCODE_CARGO_SOURCE:-auto}"
FALLBACK_REGISTRY_URL="${DEEPCODE_CARGO_FALLBACK_REGISTRY_URL:-sparse+https://index.crates.io/}"
AUTO_PRIMARY_RETRY="${DEEPCODE_CARGO_AUTO_PRIMARY_RETRY:-0}"
CARGO_BIN="${DEEPCODE_CARGO_BIN:-cargo}"
CALLER_CWD="${DEEPCODE_CARGO_CALLER_CWD:-$(pwd)}"

log() {
  printf '==[cargo][fallback]== %s\n' "$*" >&2
}

fail_usage() {
  log "invalid DEEPCODE_CARGO_SOURCE=$MODE; expected auto, repo, or official"
  exit 2
}

fallback_config_args() {
  printf '%s\0' \
    --config 'source.crates-io.replace-with="deepcode-fallback"' \
    --config "source.deepcode-fallback.registry=\"$FALLBACK_REGISTRY_URL\""
}

is_official_crates_io_fallback() {
  [ "${FALLBACK_REGISTRY_URL%/}/" = "sparse+https://index.crates.io/" ]
}

primary_config_args() {
  printf '%s\0' \
    --config "net.retry=$AUTO_PRIMARY_RETRY"
}

proxy_env_summary() {
  local vars=(
    HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
    http_proxy https_proxy all_proxy no_proxy
    CARGO_HTTP_PROXY CARGO_HTTP_TIMEOUT CARGO_HTTP_CAINFO CARGO_HTTP_PROXY_CAINFO
  )
  local name state parts=()
  for name in "${vars[@]}"; do
    if [ -n "${!name:-}" ]; then
      state="set"
    else
      state="unset"
    fi
    parts+=("$name=$state")
  done
  log "network env: ${parts[*]}"
}

is_registry_network_error() {
  local output_file="$1"
  grep -Eiq \
    'SSL connect error|TLS connect error|packet length too long|spurious network error|failed to download|download of .* failed|failed to query replaced source registry|failed to fetch|failed to get .* as a dependency|Timeout was reached|Could not resolve host|Connection timed out|connection refused|connection reset|failed to send request|error sending request|certificate verify failed|invalid peer certificate|HTTP/2 stream|early EOF|network failure' \
    "$output_file"
}

has_proxy_protocol_hint() {
  local output_file="$1"
  grep -Eiq 'packet length too long' "$output_file"
}

run_with_capture() {
  local output_file="$1"
  shift
  local status
  set +e
  "$@" 2>&1 | tee "$output_file"
  status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

has_manifest_path_arg() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --manifest-path|--manifest-path=*)
        return 0
        ;;
    esac
  done
  return 1
}

should_add_manifest_path() {
  if [ "$#" -eq 0 ]; then
    return 1
  fi

  local subcommand="$1"
  if [[ "$subcommand" == +* ]]; then
    [ "$#" -ge 2 ] || return 1
    subcommand="$2"
  fi

  case "$subcommand" in
    --version|-V|--help|-h|version|help)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

default_manifest_path() {
  if [ -n "${DEEPCODE_CARGO_MANIFEST_PATH:-}" ]; then
    printf '%s\n' "$DEEPCODE_CARGO_MANIFEST_PATH"
  elif [ -f "$CALLER_CWD/Cargo.toml" ]; then
    printf '%s\n' "$CALLER_CWD/Cargo.toml"
  else
    return 1
  fi
}

cargo_args_with_manifest_path() {
  local manifest_path
  if ! should_add_manifest_path "$@"; then
    printf '%s\0' "$@"
    return
  fi
  if has_manifest_path_arg "$@"; then
    printf '%s\0' "$@"
    return
  fi
  if ! manifest_path="$(default_manifest_path)"; then
    printf '%s\0' "$@"
    return
  fi
  if [ "$#" -eq 0 ]; then
    return
  fi
  if [[ "${1:-}" == +* && "$#" -ge 2 ]]; then
    local toolchain="$1"
    local subcommand="$2"
    shift 2
    printf '%s\0' "$toolchain" "$subcommand" --manifest-path "$manifest_path" "$@"
  else
    local subcommand="$1"
    shift
    printf '%s\0' "$subcommand" --manifest-path "$manifest_path" "$@"
  fi
}

run_with_fallback_source() {
  if is_official_crates_io_fallback; then
    run_with_official_crates_io "$@"
    return
  fi

  local config_args=()
  while IFS= read -r -d '' arg; do
    config_args+=("$arg")
  done < <(fallback_config_args)
  "$CARGO_BIN" "${config_args[@]}" "$@"
}

run_with_official_crates_io() {
  local args=()
  while IFS= read -r -d '' arg; do
    args+=("$arg")
  done < <(cargo_args_with_manifest_path "$@")

  local official_cwd="${DEEPCODE_CARGO_OFFICIAL_CWD:-/tmp/deepcode-cargo-official-cwd}"
  mkdir -p "$official_cwd"
  log "using built-in crates.io source from $official_cwd"
  (cd "$official_cwd" && "$CARGO_BIN" "${args[@]}")
}

run_with_primary_source() {
  local config_args=()
  while IFS= read -r -d '' arg; do
    config_args+=("$arg")
  done < <(primary_config_args)
  "$CARGO_BIN" "${config_args[@]}" "$@"
}

if [ -z "$FALLBACK_REGISTRY_URL" ]; then
  log "DEEPCODE_CARGO_FALLBACK_REGISTRY_URL must not be empty"
  exit 2
fi

if ! [[ "$AUTO_PRIMARY_RETRY" =~ ^[0-9]+$ ]]; then
  log "invalid DEEPCODE_CARGO_AUTO_PRIMARY_RETRY=$AUTO_PRIMARY_RETRY; expected a non-negative integer"
  exit 2
fi

case "$MODE" in
  repo)
    exec "$CARGO_BIN" "$@"
    ;;
  official)
    log "using fallback registry directly because DEEPCODE_CARGO_SOURCE=official"
    run_with_fallback_source "$@"
    exit $?
    ;;
  auto)
    ;;
  *)
    fail_usage
    ;;
esac

output_file="$(mktemp "${TMPDIR:-/tmp}/deepcode-cargo-primary.XXXXXX")"
trap 'rm -f "$output_file"' EXIT

log "auto mode primary probe uses repo Cargo source with net.retry=$AUTO_PRIMARY_RETRY"
if run_with_capture "$output_file" run_with_primary_source "$@"; then
  exit 0
else
  primary_status=$?
fi

log "primary Cargo command failed in DEEPCODE_CARGO_SOURCE=auto; inspecting output for registry/network errors"

if ! is_registry_network_error "$output_file"; then
  log "failure does not look like a registry/network/TLS download error; fallback is skipped"
  exit "$primary_status"
fi

proxy_env_summary
if has_proxy_protocol_hint "$output_file"; then
  log "detected 'packet length too long'; in WSL/Docker, verify HTTPS_PROXY uses the right proxy protocol"
  log "common case: an HTTP CONNECT proxy should be configured as http://host:port, not https://host:port"
fi

log "retrying once with fallback registry: $FALLBACK_REGISTRY_URL"
log "set DEEPCODE_CARGO_SOURCE=repo to disable fallback, or DEEPCODE_CARGO_SOURCE=official to use it directly"
run_with_fallback_source "$@"
