#!/usr/bin/env bash
# DeepCode 本地开发验证入口。测试直接调用真实构建与运行路径，不经过自定义控制器。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

profile='required'
if [ "${1:-}" = '--profile' ]; then
  [ "$#" -eq 2 ] || { printf '用法：%s --profile <static|required|full>\n' "$0" >&2; exit 2; }
  profile="$2"
elif [ "$#" -eq 1 ]; then
  profile="$1"
elif [ "$#" -ne 0 ]; then
  printf '用法：%s [static|required|full]\n' "$0" >&2
  exit 2
fi

case "$profile" in
  static|required|full) ;;
  help|-h|--help)
    printf '用法：%s [static|required|full]\n' "$0"
    exit 0
    ;;
  *) printf '未知验证范围：%s\n' "$profile" >&2; exit 2 ;;
esac

for tool in cargo node pnpm python3; do
  command -v "$tool" >/dev/null 2>&1 || { printf '缺少命令：%s\n' "$tool" >&2; exit 1; }
done

run_static() {
  printf '[test] 分层与 R0 资产\n'
  python3 -I -S ./scripts/tests/architecture.py
  bash -n ./test.sh ./build.sh ./scripts/branch-flow.sh ./scripts/check-architecture.sh ./scripts/package-macos.sh
  bash ./scripts/check-architecture.sh
  git diff --check
}

run_required() {
  run_static
  printf '[test] Rust workspace\n'
  cargo fmt --all -- --check
  cargo test --workspace
  printf '[test] TypeScript 协议、Session 与 UI\n'
  pnpm --filter @deepcode/protocol test
  pnpm --filter @deepcode/session-core test
  pnpm --filter @deepcode/client typecheck
}

case "$profile" in
  static) run_static ;;
  required) run_required ;;
  full)
    run_required
    printf '[test] CLI、TUI 与 GUI 正式包入口\n'
    cargo build -p deepcode-kernel-daemon -p deepcode-cli -p deepcode-tui
    pnpm build:deepcode-gui
    pnpm --filter @deepcode/deepcode-gui-shell prepare:dist
    printf '[test] 本地 Agent 真实链路与共享投影壳\n'
    python3 -I -S ./scripts/tests/local-agent-e2e.py
    ;;
esac

printf '[test] PASS profile=%s\n' "$profile"
