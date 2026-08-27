# DeepCode

> English guide: [README.md](README.md)

DeepCode 是一个本地优先的编码 Agent 框架。Editor、DeepCode-GUI、CLI 和 TUI 共用同一个本地 Session Runtime、Kernel 与 `SessionProjection`，界面差异只体现在渲染粒度和交互方式。

“本地优先”表示工作区访问、Session journal、共享投影、工具执行和工具记录都保存在本机。除非使用 Ollama 等本地 Provider，否则提示词和 Agent 选取的上下文仍会发送到你配置的模型服务。

## 核心工作方式

一次任务沿着一条简单链路运行：

```text
用户输入
  -> Session 中唯一的 Agent Loop
  -> Provider 返回 typed turn 文本增量或原生工具调用
  -> Session 按 turn 生命周期记录叙述、答案、交互或 Plan 事实
  -> 工作区变更前等待精确 Plan 选择
  -> Kernel 以同一 PreparedEffect 授权、执行并记录
  -> Session 继续循环并生成共享投影
  -> UI / CLI / TUI 渲染同一份事实
```

- Session 负责 Agent Loop、上下文、Provider 生命周期、journal 和共享投影。
- Kernel 负责受控工具目录、`PreparedEffect`、真实副作用边界，以及 Session 保留期间不可变的工具结果记录。
- Host 只负责本地装配、进程、传输和配置，不推进 Agent 业务语义。
- UI 只提交命令并消费 `SessionProjection`，不维护另一套任务状态或执行事实。
- Skill 与 MCP 以插件贡献接入组合，不产生第二个 Agent Loop。

DeepCode 不包含 Requirement、Plan、Review 等并行工作流引擎。普通叙述和最终回答是 LLM 的原生 Markdown 正文；Session 只依据 typed Provider turn 是否包含工具调用来区分两者，并把当前 run 的文本增量作为可丢弃 `assistantDraft` 投影给所有界面。Plan 与 interaction 只能由 LLM 调用 Session 保留的结构化 control 工具产生，不使用 JSONL 正文封装、自然语言推断或失败回退。Plan 选择持久化为 `plan.respond(select)` 后，只为该 run 中精确的 workspace、operation 和 normalized targets 产生 authority。自由输入调整会关闭旧 Plan但不产生 authority；明确忽略会让同一 Loop 进入 answer-only continuation。Session binding 允许读取 immutable workspace snapshot 内的内容；工作区变更不存在逐调用 `ask` 或全局 `allow` 兜底。其他 effect class 仍可使用各自明确的 interaction request。

## 选择界面

| 界面 | 适合场景 | 入口 |
| --- | --- | --- |
| DeepCode Editor | 文件树、编辑器、终端、Git 面板和 Agent 对话 | `DeepCode.app`、`DeepCode.exe` 或 Linux GUI |
| DeepCode-GUI | 专注的本地 Agent 对话 | `DeepCode-GUI.app` 或 `DeepCode-GUI.exe` |
| CLI | 一次性任务、脚本和终端工作流 | `DeepCode-CLI.command` 或 `deepcode-cli` |
| TUI | 持续的交互式终端对话 | `DeepCode-TUI.command` 或 `deepcode-tui` |

只要使用同一配置根，四个界面就会读取同一批模型配置、Session journal、Kernel 工具记录和共享投影。

## macOS 快速开始

已有本地包时：

```bash
open bin/macos-arm64/DeepCode.app
open bin/macos-arm64/DeepCode-GUI.app
```

终端入口：

```bash
cd bin/macos-arm64
./DeepCode-TUI.command -C /path/to/project
./DeepCode-CLI.command --help
```

从源码生成本地包：

```bash
make package-macos
```

输出位于 `bin/macos-arm64/`，包含两个 App、CLI/TUI launcher、Kernel、Session runtime、Web assets 和包内可写数据根。若包仍显示旧资源，请先退出全部 DeepCode App，再执行：

```bash
make package-macos-clean
```

当前 macOS 包用于本机运行，采用 ad-hoc 签名；它不是 Developer ID 签名或公证的 DMG。

## Linux 与 Windows 包

开发和便携打包通过项目容器完成。Windows 请在 WSL 中运行：

```bash
make shell
bash ./build.sh
```

产物写入：

```text
bin/linux-x64/
bin/win64/
```

Linux 启动方式：

```bash
cd bin/linux-x64
./deepcode-gui
```

然后打开 [http://127.0.0.1:31245/](http://127.0.0.1:31245/)。Windows 可打开 `DeepCode.exe` 或 `DeepCode-GUI.exe`；目标系统需要 Microsoft Edge WebView2 Evergreen Runtime。

## 配置模型

首次运行任务前：

1. 打开“设置 → LLM”。
2. 新建 OpenAI-compatible、Anthropic 或 Ollama profile。
3. 填写 Base URL、模型名和 Provider 所需的 API key。
4. 启用 profile，设为默认值并保存。
5. 界面提供 Probe 时，可用它检查连接。

打包产物不会包含你的 API key。密钥保存在当前配置根的本地 secret store；不要分享该目录。

对于要求在工具续轮中回传思考字段的 Provider，Session 只在当前 run 的内存中暂存并随同一 Provider 调用链回传该字段；它不会进入 Session journal、共享投影或界面叙述。用户可见的中间过程仍只来自模型的普通 Markdown 正文和结构化工具活动。

## GUI 使用流程

1. 可以直接开始独立对话，也可以新建项目并附加一个或多个本地文件夹。
2. 项目的有序文件夹列表只作为新 Session 的模板；Session 创建后保留不可变的 creation snapshot，项目变化只影响之后创建的 Session。
3. 输入框可以附加文件或文件夹。文件会作为该条消息的不可变内容快照保存；文件夹不复制内容，而是作为 Session 目录索引，由模型通过 `fs.list`、`fs.glob`、`code.grep` 和 `fs.read` 自主探索。
4. 对话目录索引可以随后移除，但不会删除既有消息、activity 或工具记录。活动 run 中的附加或移除会标记为“下轮生效”，只改变下一 run 冻结的有效目录集合，也不会静默写回项目模板。
5. 输入希望 Agent 完成的编码任务。独立 Session 可以保持无 binding，直到确实需要访问文件夹。
6. Agent 在 Provider 与工具循环运行时，将当前 typed turn 的 LLM 文本增量作为共享 `assistantDraft` 投影；turn 闭合后再提交为叙述或终答。
7. 工作区变更使用原输入框中的 Plan 卡。选项按 `1..N` 纵向排列：首次点击只选中，再次点击或按 Enter 才确认；也可以自由输入调整细节，或明确忽略 Plan 并直接回答。
8. 对话中仍可切换模型，新的 profile 从后续 Provider turn 起生效。
9. 消息、Plan、activities、产物、上下文用量和 run 状态都来自同一份共享投影。
10. 已提交的 Assistant 回答可以复制、赞、踩或清除反馈。赞踩是本地 Session 持久事实，重启后可恢复，不会由 GUI 私存，也不会发送给 Provider。
11. 点击输入框中的上下文球可以查看当前 Provider 请求实际采用的上下文分类；设置页显示累计用量，以及按新到旧排列的逐轮 Token 消耗（每页 10 条）。一轮包含的多次 Provider 调用由 Session 汇总，GUI 不重新计算。schema 4 升级前的历史用量会保留在统计中，但不会伪造当时不存在的请求构成。
12. 复杂任务由 LLM 通过结构化 `todo.update` 明确提交 Todo；右侧任务面板只消费该共享投影，不把工具调用或 GUI 推断伪装成任务。工具调用仍与叙述按 Session 时间线交错显示在主对话区。

删除 active-v2 Session 会同时删除对话 Catalog 条目及其完整 active archive：Session events、command replay、binding 关系和 Kernel ToolRecord。活动 run 必须先停止。Hard cut 保留的只读旧历史不会通过 v2 执行路径删除。

旧历史若存在，由 Host 的独立只读适配器合并到会话列表，并明确标记为“旧版只读历史”。它不写入 active-v2 Catalog，不能继续对话、切换模型、写入反馈或调用 active-v2 删除命令；GUI 仍允许复制其中的 Assistant 文本。该入口只恢复旧归档原本拥有的事实，不执行双读、双写或旧 schema 迁移。

## CLI

以下示例使用 macOS launcher；Linux 将入口替换为 `./deepcode-cli`。

```bash
./DeepCode-CLI.command status
./DeepCode-CLI.command ask "解释一个不需要工作区的编码问题"
./DeepCode-CLI.command ask -C /path/to/project "分析并修复当前构建错误"
./DeepCode-CLI.command chat -C /path/to/project
./DeepCode-CLI.command show --session <session-id>
```

继续已有 Session 或回应等待中的 Plan：

```bash
./DeepCode-CLI.command ask --session <session-id> 1
./DeepCode-CLI.command ask --session <session-id> "调整目标后重新给出 Plan"
./DeepCode-CLI.command ignore-plan --session <session-id>
./DeepCode-CLI.command model --session <session-id> <profile-id>
./DeepCode-CLI.command cancel --session <session-id> <run-id>
./DeepCode-CLI.command attach-directory --session <session-id> /path/to/folder
./DeepCode-CLI.command detach-directory --session <session-id> <workspace-id>
```

只有显式 `-C` / `--workspace` 才会为新的 CLI Session 创建 binding，当前目录不会被隐式采用。Plan 等待时输入 `1..N` 选择选项，其他非空文本作为调整反馈；只有 `ignore-plan` 表示忽略。`ask` 会等待 run 到达终态或需要用户决定；failed、cancelled 或 indeterminate 必须非零退出。CLI 只通过 `ConversationPort` 提交命令，不直接调用工具。

## TUI

```bash
./DeepCode-TUI.command -C /path/to/project
./DeepCode-TUI.command -C /path/to/project --session <session-id>
```

普通文本会提交到当前 Session。交互命令包括：

- `/help`：显示命令提示。
- `/show`：重新显示当前共享投影。
- `/ignore`：明确忽略当前 Plan，并以 answer-only continuation 继续。
- `/model <profile>`：切换后续 Provider turn 使用的 profile。
- `/cancel`：取消活动 run。
- `/attach <path>`：把文件夹作为 Session 目录索引附加。
- `/detach <workspace-id>`：从后续 run 的有效目录集合中移除该对话目录索引。
- `/clear`：刷新可见状态，不修改 durable Session。
- `/quit`、`/exit`：退出 TUI。

Plan 等待时输入 `1..N` 选择选项，其他非空文本作为调整反馈。`Esc` 是 TUI 的明确忽略动作；空输入、EOF 和 Ctrl-C 都不会忽略 Plan。与 CLI 相同，只有显式 `-C` / `--workspace` 才为新 Session 创建 binding。

## 本地数据

默认配置根包含：

```text
config/user/local/settings/llm-profiles.json  模型 profiles
config/user/local/settings/user-settings.json 用户设置
config/user/local/secrets/                    本地密钥
runtime/local-agent-v2/catalog.sqlite3        Host 私有 project/workspace catalog
runtime/local-agent-v2/session.sqlite3        Session journal 与命令回放
runtime/local-agent-v2/tool-record.sqlite3    Kernel 工具结果记录
sessions/                                     旧数据只读历史（存在时）
logs/                                         launcher 或 Kernel 日志（产生时）
```

设置 `DEEPCODE_CONFIG_DIR` 可指定其他配置根。需要多个入口共享 Session 时，应让它们使用同一配置根。
打包目录中的 `session-core/` 保存 Session Runtime 代码，不是对话归档。active-v2 对话历史位于 `runtime/local-agent-v2/session.sqlite3`；`sessions/` 只保存 hard cut 后原样保留的旧版只读历史。

`contracts/agent-runtime-v2/` 中的 `catalog.sql`、`session.sql` 与 `tool-record.sql` 是三个事实 owner 的当前建库合同；同目录的 `*-to-*.sql` 只负责从精确旧版本单向迁移到下一版本，不是另一套运行路径。完整版本链见 [contracts/agent-runtime-v2/README.md](contracts/agent-runtime-v2/README.md)。

## 常见问题

### 没有可用模型

打开“设置 → LLM”，确认至少一个 profile 已启用并设为默认值，填写所需 API key，保存后 Probe。

### CLI/TUI 无法连接本地 Daemon

先运行：

```bash
./DeepCode-CLI.command status
```

桌面壳和 launcher 通常会启动各自拥有的本地 Daemon。直接运行时可用 `--api` 连接已有实例，或用 `DEEPCODE_PORT` 修改默认端口。受保护的 Host API 需要壳持有的本地 token，不应使用无 token 的裸 `curl /api/health` 作为诊断方式。

### 缺少 Session runtime

使用完整打包产物，或在源码 checkout 中构建：

```bash
pnpm --filter @deepcode/session-core build
```

便携包必须保留 launcher 同目录下的 `session-core/`、Node runtime 和 protocol package。

### 查看运行问题

使用 CLI `status`、界面中的 API/Agent 状态和包内 `logs/`。Session 与工具事实保存在上述两个 SQLite 文件中，不存在另一套 UI 私有事实源。

## 源码验证

```bash
bash ./test.sh static
bash ./test.sh required
bash ./test.sh full
```

`static` 检查分层与仓库结构，`required` 执行 Rust/TypeScript 构建和单元测试，`full` 额外运行本地 Provider、工具决定、取消、命令回放和重启恢复的端到端路径。

贡献者分支与 Pull Request 流程见 [docs/git-branch-flow.md](docs/git-branch-flow.md)。

## 第三方说明与许可证

详见 [NOTICE.md](NOTICE.md)、[ATTRIBUTION.md](ATTRIBUTION.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [CITATION.cff](CITATION.cff)。

DeepCode 使用 [MIT License](LICENSE)。
