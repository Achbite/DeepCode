# DeepCode 分支与 Pull Request 流程

本文只说明贡献者如何创建任务分支、验证改动并通过 Pull Request 合并。它不参与
Agent 运行时，也不构造额外的测试审批或发布凭证体系。

## 分支职责

- `main`：稳定发布分支。
- `dev-main`：日常集成分支。
- `kernel/*`：Kernel / Runtime 单层任务，从 `dev-main` 创建并合并回 `dev-main`。
- `session/*`：Session / Orchestration 单层任务，从 `dev-main` 创建并合并回 `dev-main`。
- `ui/*`：UI / Host Shell 单层任务，从 `dev-main` 创建并合并回 `dev-main`。
- `fix/*`：通用修复，从 `dev-main` 创建并合并回 `dev-main`。
- `hotfix/*`：稳定版本紧急修复，从 `main` 创建并合并回 `main`，之后通过 PR 回同步 `dev-main`。
- `release/*`：仅在明确启用独立发布稳定阶段时使用。

`main` 与 `dev-main` 只通过 Pull Request 更新，不直接 push，不 force push，不删除。
合并方式使用 merge commit。

## 日常开发

先同步本地永久分支，再从对应基线创建短期任务分支：

```bash
./scripts/branch-flow.sh sync-protected
./scripts/branch-flow.sh start session local-agent-loop --worktree /absolute/worktree
```

在任务分支完成单一目标后运行：

```bash
./test.sh required
./scripts/branch-flow.sh prepare-pr --target dev-main
```

跨层改动使用 `./test.sh full`。测试通过说明当前源码在当前环境下通过了相应验证，
不替代代码 Review，也不代表自动获得发布权限。

## 发布任务分支

`prepare-pr` 输出当前 head SHA 与目标 SHA。核对无误后，显式确认 push 副作用：

```bash
./scripts/branch-flow.sh publish-task \
  --target dev-main \
  --expected-head <完整-head-sha> \
  --acknowledge-side-effect
```

该命令只发布当前短期分支，不更新 `main` 或 `dev-main`。

## 合并前核对

从已复核目标提交物化 `scripts/branch-flow.sh`，再核对 PR 的来源、目标、SHA、祖先关系、
工作区清洁度和 diff：

```bash
./scripts/branch-flow.sh verify-pr \
  --head session/local-agent-loop \
  --target dev-main \
  --expected-head <完整-head-sha> \
  --expected-target <完整-target-sha>
```

任一 SHA、分支目标或工作区状态变化后都要重新运行。脚本不生成自签名 Review 回执，
也不要求额外的 Test Change Request 文件。

## 合并后清理

确认 PR 已经以 merge commit 进入目标分支后：

```bash
./scripts/branch-flow.sh finish \
  --branch session/local-agent-loop \
  --target dev-main \
  --expected-head <完整-head-sha> \
  --acknowledge-side-effect
```

脚本只删除已经合并且 SHA 匹配的短期分支；活动 worktree 会回到目标分支或停在目标提交。

## 发布到 `main`

正常发布路径只有：

```text
dev-main -> Pull Request -> main
```

发布前运行完整验证，解决 Review 对话，并基于最新 `main` 重做 `verify-pr`。创建版本 tag
或 push 永久分支仍需要用户明确授权。

## 只读检查

以下命令不会修改分支：

```bash
./scripts/branch-flow.sh audit
./scripts/branch-flow.sh self-check
./scripts/branch-flow.sh check-pr-route session/example dev-main
```
