#!/usr/bin/env bash
# DeepCode 本地开发验证入口。测试直接调用真实构建与运行路径，不经过自定义控制器。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/source-identity.sh"

profile='required'
if [ "${1:-}" = '--profile' ]; then
  [ "$#" -eq 2 ] || { printf '用法：%s --profile <static|required|cli|full>\n' "$0" >&2; exit 2; }
  profile="$2"
elif [ "$#" -eq 1 ]; then
  profile="$1"
elif [ "$#" -ne 0 ]; then
  printf '用法：%s [static|required|cli|full]\n' "$0" >&2
  exit 2
fi

case "$profile" in
  static|required|cli|full) ;;
  help|-h|--help)
    printf '用法：%s [static|required|cli|full]\n' "$0"
    exit 0
    ;;
  *) printf '未知验证范围：%s\n' "$profile" >&2; exit 2 ;;
esac

if [ "$profile" != 'static' ]; then
  if [ ! -f /.dockerenv ] && ! grep -qaE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null; then
    printf 'required/cli/full 验证必须在开发容器内执行；请先运行 make shell。\n' >&2
    exit 3
  fi
  for tool in cargo node pnpm python3; do
    command -v "$tool" >/dev/null 2>&1 || { printf '缺少命令：%s\n' "$tool" >&2; exit 1; }
  done
fi
if [ "$profile" = 'cli' ] || [ "$profile" = 'full' ]; then
  command -v python3 >/dev/null 2>&1 || { printf '缺少命令：python3\n' >&2; exit 1; }
fi

run_static() {
  printf '[test] 源码身份与脚本语法\n'
  local script
  for script in ./test.sh ./build.sh ./entrypoint.sh ./scripts/source-identity.sh ./scripts/branch-flow.sh ./scripts/package-macos.sh ./scripts/macos-package-service.sh ./scripts/check-architecture.sh; do
    bash -n "$script"
  done
  bash ./scripts/check-architecture.sh
  if deepcode_source_git_available "$ROOT_DIR"; then
    git -C "$ROOT_DIR" diff --check
  else
    printf '[test] Git diff check: SKIP (Git metadata is host-owned and unavailable in this compile/test snapshot)\n'
  fi
}

run_required() {
  run_static
  printf '[test] Rust workspace\n'
  cargo fmt --all -- --check
  cargo test --workspace
  printf '[test] Session 事件约束显式修复\n'
  python3 -I -S ./scripts/tests/session-tool-interrupted-repair.py
  printf '[test] Userspace 共享依赖\n'
  bash ./build.sh --stage deps
  pnpm build:userspace-shared
  printf '[test] Session 数据流\n'
  pnpm --filter @deepcode/session-core test
  printf '[test] GUI 投影合同与状态交互\n'
  pnpm --filter @deepcode/client test
  printf '[test] 跨包类型接线\n'
  pnpm typecheck
}

case "$profile" in
  static) run_static ;;
  required) run_required ;;
  cli)
    run_required
    printf '[test] CLI 与 daemon 正式入口\n'
    cargo build -p deepcode-first-party-tools -p deepcode-kernel-daemon -p deepcode-cli
    python3 -I -S ./scripts/tests/tool-input-cli-e2e.py
    ;;
  full)
    run_required
    printf '[test] CLI、TUI 与 GUI 正式包入口\n'
    cargo build -p deepcode-first-party-tools -p deepcode-kernel-daemon -p deepcode-cli -p deepcode-tui
    pnpm build:deepcode-gui
    pnpm --filter @deepcode/deepcode-gui-shell prepare:dist
    printf '[test] 本地 Agent 真实链路与共享投影壳\n'
    python3 -I -S ./scripts/tests/tool-input-cli-e2e.py
    python3 -I -S ./scripts/tests/local-agent-e2e.py
    ;;
esac

printf '[test] 登记链路检查完成 profile=%s（不等于效果、稳定性、真实 Provider 或发布验收）\n' "$profile"
