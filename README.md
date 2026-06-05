# DeepCode

DeepCode 当前可运行入口是 Rust Kernel Daemon + React GUI；Browser Dev Host 只作为开发态静态资源与 API 代理。正式桌面方向是 Tauri thin shell 承载同一套 GUI 并连接本地 daemon。先按快速开始运行，再看后续功能和架构说明。

## 快速开始

### 环境要求

| 依赖    | 建议版本     | 用途                                       |
| ------- | ------------ | ------------------------------------------ |
| Rust    | 1.88+        | Kernel crates、Kernel Daemon、统一分发构建 |
| Node.js | 20+          | TS protocol/session-core/GUI 构建          |
| pnpm    | 9+           | TS workspace 包管理                        |
| Docker  | 24+          | 推荐测试与交叉构建环境                     |
| WSL     | Windows 推荐 | Windows 默认 shell / build / test 建议环境 |

### 安装依赖

```
# 根目录make shell进入docker
bash
pnpm install
```

### 开发态运行

```bash
pnpm dev
```

默认入口：

- Rust Kernel Daemon API: `http://127.0.0.1:31245`
- React GUI dev server: `http://127.0.0.1:5173`

也可以单独启动：

```bash
pnpm dev:kernel
pnpm dev:client
```

### 打包态运行

先构建：

```bash
./build.sh
```

`build.sh` 默认完整产出 Linux / Windows 分发目录；开发迭代时可按阶段运行：

```bash
./build.sh --stage gui
./build.sh --stage kernel
./build.sh --stage tauri
./build.sh --stage package
```

Rust 构建默认复用统一 `CARGO_TARGET_DIR`，并在环境内存在 `sccache` 时自动使用本地 disk cache。`gui/kernel/tauri` 阶段会用 `.build-cache/build-stamps/` 判断输入是否变化；需要强制重跑时设置 `DEEPCODE_FORCE_BUILD=1`。排查缓存问题时可用 `DEEPCODE_DISABLE_SCCACHE=1 ./build.sh --stage kernel` 临时关闭 sccache。

Linux:

```bash
./bin/linux-x64/deepcode-gui
```

CLI/TUI 命令入口：

```bash
./bin/linux-x64/deepcode --help
./bin/linux-x64/deepcode daemon status
./bin/linux-x64/deepcode-tui --smoke
./bin/linux-x64/deepcode-tui
```

`deepcode` 不带参数启动时会进入轻量命令提示，避免双击或手动启动后立即退出。`deepcode-tui` 默认显示命令摘要，并支持：

```text
/help              显示所有 TUI 命令
/status            检查 Kernel daemon 连接
/ask <prompt>      通过 KernelClient 发送一条 prompt
/audit             显示审计状态占位
/clear             清空当前可见卡片
/quit              退出
```

不带 `/` 的普通文本会按一次 prompt 发送。当前 TUI 使用 Ratatui/Crossterm 布局，并保留 `Event -> CardModel -> Renderer` 投影边界；Slash Command 弹窗、文件补全、历史搜索、焦点导航等高级体验仍待完善。

Windows:

```bat
bin\win64\DeepCode.exe
bin\win64\deepcode.cmd --help
bin\win64\deepcode-tui.bat --smoke
```

`DeepCode.exe` 会立即渲染打包内置的完整 React 工作台，同时在后台启动同目录的 `deepcode-kernel.exe`。默认会选择一个空闲本地端口，避免撞上旧预览服务；如果你显式设置 `DEEPCODE_PORT`，则使用该端口。Windows 便携目录必须保留同目录的 `WebView2Loader.dll`；目标系统仍需要安装 Microsoft Edge WebView2 Evergreen Runtime。浏览器调试入口使用脚本默认端口时可以直接打开：

```text
http://127.0.0.1:31245/
```

Codex 内部浏览器常驻预览可使用单独端口，例如：

```bash
DEEPCODE_PORT=31250 \
DEEPCODE_CLIENT_DIST="$PWD/bin/linux-x64/web" \
DEEPCODE_CONFIG_DIR="$PWD/.deepcode-preview-config" \
./bin/linux-x64/deepcode-kernel
```

可通过环境变量调整：

| 变量                     | 说明                                      |
| ------------------------ | ----------------------------------------- |
| `DEEPCODE_HOST`        | Host 监听地址，默认 `127.0.0.1`         |
| `DEEPCODE_PORT`        | Host 监听端口，默认 `31245`             |
| `DEEPCODE_CLIENT_DIST` | GUI 静态资源目录，打包态默认指向 `web/` |
| `DEEPCODE_CONFIG_DIR`  | 可写配置根目录                            |
| `DEEPCODE_LLM_MOCK`    | 设为 `1` 时使用测试 mock LLM            |

### 配置目录

`bin/<platform>/config` 只保存分发默认配置与 Pack 目录，不作为用户运行时写入位置。

用户设置、LLM profile 与本地 secret 引用默认写入：

- Linux：`$XDG_CONFIG_HOME/deepcode/config` 或 `~/.config/deepcode/config`
- Windows：`%APPDATA%\DeepCode\config`

可以用 `DEEPCODE_CONFIG_DIR` 覆盖。

## 验证

统一验证入口：

```bash
./test.sh
```

推荐在 Docker 中跑完整验证：

```bash
docker build -f Dockerfile.dev -t deepcode-dev .
docker run --rm -t -v "$PWD:/workspace" -w /workspace deepcode-dev ./test.sh
```

`./test.sh` 覆盖当前默认门禁：

- Rust workspace `cargo fmt/test`
- TS `protocol/session-core/gui` build/typecheck
- Stage 10.5 构建缓存自检：Cargo incremental、`build.sh --stage`、sccache 开关、Docker BuildKit cache 配置
- `deepcode-kernel-audit` canonical/hash chain/segment seal/tamper tests
- CLI/TUI Host Shell smoke：`deepcode --help`、CLI REPL、`deepcode-tui --smoke`
- Kernel Daemon `/api/health`、`/api/kernel/commands`、`/api/kernel/snapshot`
- session-core transcript / projection / resume 最小模型
- Dev Host proxy `/api/*` smoke
- LLM profile 保存、secretRef、token integer guard
- Agent 动态会话投影、PlanReview / 计划确认、permission resume 与临时文件生命周期
- Conversation Archive 本地归档、完整对话导出和 debug 包 smoke
- Workspace 打开、浏览、保存 `.code-workspace`
- Windows 盘符枚举与文件树排序
- hidden `fs.delete` 受控能力
- 打包态 Linux GUI 静态资源 smoke
- Windows GNU `DeepCode.exe` GUI shell 与 Kernel 交叉编译产物 smoke
- 旧 Node server、pkg、Tauri Agent 后端不进入默认链路

如只需要快速开发检查，可跳过慢速打包 smoke：

```bash
DEEPCODE_SKIP_PACKAGING_SMOKE=1 ./test.sh
```

需要生成构建基线报告时，仍通过统一测试入口启用：

```bash
DEEPCODE_RUN_BUILD_BENCH=1 ./test.sh
```

报告写入被忽略的 `.deepcode/build-baselines/`，用于对比 repeat build、Rust 文件 mtime 变化和 GUI 文件 mtime 变化后的重编范围。

## 当前能力

### 已可用

- **Rust Kernel Daemon**

  - 由 `deepcode-kernel-daemon` 拥有 runtime、ledger、provider transport、session/config storage adapter 和 `/api/*`。
  - `deepcode-host-web` 仅保留为开发态静态资源 host + daemon proxy，不再持有 Kernel runtime。
  - 新增 Kernel Gateway：`/api/kernel/commands`、`/api/kernel/snapshot`、`/api/kernel/events/stream`。
  - 未知 `/api/*` 返回结构化 JSON 错误，不回退旧 Node server。
- **GUI Host**

  - 文件树、Tab、编辑器、设置中心、Agent 面板、终端面板和内部浏览器面板可加载。
  - 设置页可保存 LLM profile；API Key 通过本地 secretRef 管理，profile 文件不保存明文 key。
  - 打开工作区对话框支持宿主文件系统浏览。
  - Windows 端可枚举可用盘符；Linux / WSL / macOS 使用本机文件系统入口。
  - 打开普通文件夹后可保存为 `.code-workspace`，保存后重新作为 workspace 文件打开。
- **Workspace syscall**

  - 支持 `open/current/list/read/write/create/createFolder/rename/delete/search`。
  - 读写、创建、重命名、删除均通过 Rust Kernel 边界。
  - `fs.delete` 是高风险受控能力：GUI 可以通过受控接口删除，模型普通工具目录不直接暴露删除能力。
  - 工作区内路径必须为相对路径；绝对路径、`..` 穿越、Windows 盘符形式的工具路径会被拒绝。
- **LLM 会话工作流**

  - 会话层不再把 `plan-check-complete-review` 当作固定 UI 路径；Kernel 仍拥有 workflow/state machine，Session 负责选择 `workflowRef`、解析结构化 proposal、组织投影和用户决策。
  - LLM 的计划输出采用 tagged Markdown + JSON `ACTION_BUNDLE`；自然语言不会直接变成工具执行、权限授权或完成事实。
  - 正式 Plan 默认进入 Check / 计划确认卡：Kernel `PlanReview` 生成权限预览，用户可直接同意计划，或在同一个评审输入框提交修改意见；空评审提交视为拒绝计划。
  - `Permission` 只展示执行前真实授权请求；写入、删除、shell、network、secret 等能力仍由 Kernel PermissionGate 控制。
  - `Execution` 主视图只展示工具进度、权限结果和执行事实；执行完成后必须生成 `ReviewPacket` 或显示 `Review pending`。
  - `Review` 合并 Kernel facts 与 LLM review guidance：修改文件、权限使用、工具结果、验证结果来自 Kernel / ledger，模型只给自检摘要、风险和用户审查建议。
  - 支持 OpenAI-compatible、Anthropic、Ollama profile；DeepSeek 按 OpenAI-compatible profile 使用。
  - token 字段有整数 guard，避免 `max_tokens: 384000.0` 这类请求体错误。
  - 写入类工具会生成 permission card；用户接受后 workflow 可从 pending tool 继续执行。
  - “身份 + 临时文件读写删除”fixture 已覆盖：身份只最终回答一次，未清理临时文件不得 review accepted。
- **Conversation Archive**

  - Daemon session store 会把会话投影、transcript、debug 记录和导出快照持续归档到用户配置目录下的 `conversation-archives/`。
  - 会话与归档默认按 `workspaceScopeKey/sessionId/runId` 归属；GUI 打开不同工作区时只显示当前 workspace 的 Agent session。Windows `E:\...` 与 WSL `/mnt/e/...` 默认是不同 workspace scope，避免 31245 / 31250 互相串会话。
  - `/api/agent/sessions?workspaceId&workspaceHash` 与 `/api/agent/sessions/current?workspaceId&workspaceHash` 返回当前 workspace scope 的 session；无 workspace 的 CLI/TUI 旧调用落到 `unbound-workspace`，不复用 GUI 当前工作区会话。
  - 普通安装默认使用 `%APPDATA%/DeepCode/conversation-archives` 或 `~/.config/deepcode/conversation-archives`；portable / `DEEPCODE_CONFIG_DIR` 模式使用对应可写配置根。
  - `/api/session-store/index` 返回归档根目录，`/api/session-store/:session_id/archive` 返回单个 session 的 manifest、文件列表和导出路径。
  - GUI 后续可基于该 manifest 提供“复制完整对话 / 导出调试包 / 打开归档目录”；默认 session selector 不混合跨 workspace 历史，跨 workspace 历史只通过显式 archive/history 入口查看。
  - 完整 raw event 与 parser/debug 数据保留在归档和调试视图，不进入默认阅读主视图。
- **打包与预览**

  - `./build.sh` 输出 `bin/linux-x64` 和 `bin/win64`。
  - Windows `bin/win64/DeepCode.exe` 是可双击启动的 GUI thin shell，会直接渲染内置 React 工作台并在后台启动同目录 Kernel；默认选择空闲本地端口，`WebView2Loader.dll` 会随分发目录一起输出。
  - Linux `bin/linux-x64/deepcode-gui` 启动同一个 Rust Kernel Daemon 并服务 `web/`。
  - Codex 内部浏览器、Chrome 或普通浏览器都可以打开 GUI URL。
- **CLI / TUI 命令入口（待完善）**

  - `deepcode` / `deepcode-cli` 支持 `--help`、`-p`、`ask`、`daemon status` 和轻量 REPL。
  - `deepcode-tui` 是 Ratatui/Crossterm Host 壳：提供顶部状态、主卡片区、命令提示区和底部输入栏，并保留 `Event -> CardModel -> Renderer` 投影边界。
  - CLI/TUI 只通过 `deepcode-kernel-client` 调 daemon，不引用 `DeepCodeKernelRuntime`，不执行工具、不裁决权限、不判定完成。
- **本地签名审计链 V1**

  - `deepcode-kernel-audit` 已提供 canonical JSON、signed entry、hash chain、segment seal、verify、degraded mode 与 tamper tests。
  - 当前签名链是开发/便携包 V1，签名算法封装在 audit signer 内；最终企业级签名、OS keychain 和发布防伪策略仍待完善。

### 当前预留

- **Tauri thin shell**：正式 GUI 壳方向已确定为 Tauri，但只允许承载窗口、文件选择、菜单、快捷键、系统集成和 Kernel daemon bridge，不承载 Agent runtime。
- **Browser Host**：保留为开发快速验证入口，不作为最终桌面运行模型。
- **KernelClient 兼容层**：当前 CLI/TUI 通过 KernelClient 封装 daemon `/api/agent/*` 兼容投影；后续替换为 IPC / stable KernelClient transport 时，不应影响 CLI/TUI 调用点。
- **CLI / TUI 高级体验**：当前只完成基础命令入口和终端面板；完整 stdout/stderr 分流、stdin 管道、权限交互、Slash Command、补全、历史搜索和焦点导航仍待完善，且不会重新实现 Agent runtime。
- **版本身份 / 发布防伪**：当前发行版本只沿用 Cargo workspace `[workspace.package].version`，不生成 build tag、source hash 或 build metadata 文件；正式源码哈希和签名发布链仍待完善。
- **MCP adapter**：当前只保留 ExternalConnector / SkillPack 兼容方向，尚未实现完整 MCP client adapter。
- **Source Control / Git / Validator runtime**：ChangeSet、ReviewGate 和 validation 已有 Kernel 结构基础，真实 Git / lint / test 深度接入仍待完善。

## 项目定位与架构

DeepCode 是一个本地 AI Agent 代码工作台。当前项目已经从旧的多 runtime 形态收束为统一的 Rust Kernel 架构：

```text
UI Shell
  Tauri GUI / Browser Dev Host / CLI / TUI
  只负责展示、输入、审批和交互入口。

TS 用户会话层
  userspace/session-core
  负责用户态会话、附件、上下文拼装策略、事件投影和 Host 侧工作区绑定。
  不负责权限裁决、工具执行、workflow、文件系统事实或完成判定。

Rust Kernel 层
  deepcode-kernel-* + deepcode-kernel-daemon
  负责 workspace、context、policy、skill runtime、workflow、ledger、changeset、
  validation 和 review。所有敏感操作只能通过 Kernel syscall 发起。
```

核心原则：用户态只能提出意图，系统调用层传递结构化命令，内核态裁决资源访问、权限、工作流迁移、执行事实和完成判定。

Browser Dev Host 是开发验证入口，只做静态资源服务和 daemon proxy；正式 GUI 壳采用 Tauri thin shell。Tauri 只负责启动或连接本地 Kernel Daemon、加载打包后的 `web/`、文件选择和系统集成，不允许出现 Tauri-side Agent workflow、tool executor、permission evaluator 或 session truth。

## 分发目录

`./build.sh` 输出：

```text
bin/
├── linux-x64/
│   ├── deepcode-kernel
│   ├── deepcode-gui
│   ├── deepcode
│   ├── deepcode-cli
│   ├── deepcode-tui
│   ├── web/
│   ├── config/
│   ├── packs/
│   └── README.txt
└── win64/
    ├── DeepCode.exe
    ├── WebView2Loader.dll
    ├── deepcode-kernel.exe
    ├── deepcode-cli.exe
    ├── deepcode-tui.exe
    ├── deepcode.cmd
    ├── deepcode-cli.bat
    ├── deepcode-tui.bat
    ├── web/
    ├── config/
    ├── packs/
    └── README.txt
```

GUI、CLI、TUI 入口共享同一个 Kernel daemon、配置目录、Pack 目录和事件协议。当前 GUI 是可用主入口；CLI/TUI 是基础命令入口，只通过 KernelClient 调 daemon，不拥有 workflow、permission、tool execution 或 review 事实。

## 当前源码结构

```text
deepagent/
├── Cargo.toml
├── crates/
│   ├── deepcode-kernel-abi        # KernelCommand / KernelEvent / KernelSnapshot
│   ├── deepcode-kernel-runtime    # Headless runtime dispatch 与 workspace syscall
│   ├── deepcode-kernel-policy     # capability / policy / permission gate
│   ├── deepcode-kernel-skills     # SkillDescriptor 与受控外部进程 runtime
│   ├── deepcode-kernel-workflow   # WorkflowMachine / WorkUnit / Review 结构
│   ├── deepcode-kernel-ledger     # EventLedger 与 run snapshot
│   ├── deepcode-kernel-context    # ContextSnapshot / evidence refs
│   ├── deepcode-kernel-audit      # 本地签名审计链 canonical/hash/verify
│   ├── deepcode-kernel-client     # CLI/TUI/Host 共享 KernelClient
│   ├── deepcode-kernel-daemon     # Kernel Daemon 与 localhost API
│   ├── deepcode-kernel-config
│   ├── deepcode-kernel-prompt
│   └── deepcode-host-web          # 开发态静态资源 host + daemon proxy
├── userspace/
│   ├── protocol                   # TS 迁移期 DTO 投影
│   ├── session-core               # TS 用户会话层
│   └── gui                        # React GUI Host
├── shells/
│   ├── cli                        # CLI Host Shell
│   ├── tui                        # TUI Host Shell
│   └── tauri                      # GUI thin shell
├── fixtures/                      # Agent/workflow/kernel fixture
└── legacy/                        # 迁移期参考与历史遗留隔离区
```

旧 `server/`、旧 `client/`、旧 `packages/agent-core`、旧 Tauri Agent 后端不再是默认运行结构。

## Kernel 边界

### Workspace

规则：

- `workspace.open` 是 Host 受控入口，可以接收目录或 `.code-workspace` 绝对路径。
- 其他 `workspace.*` syscall 只能使用工作区相对路径。
- `.code-workspace` 支持 VSCode 风格 `folders + settings` 子集。
- `.deepcode/prompts`、`.deepcode/skills`、`.deepcode/ruler`、`.deepcode/policy` 是配置资产，不被普通 workspace full access 覆盖。
- 外部参考文件后续应通过只读引用或导入 `.deepcode/references/` 的托管副本进入上下文。

### Skill

外部 Skill，包括 Python 脚本、二进制、shell wrapper、未来 MCP adapter wrapper，都必须经 Rust Kernel controlled process runtime 启动：

```text
SkillDescriptor
  -> PolicyGate / PermissionGate
  -> Kernel controlled process runtime
  -> stdout/stderr/exit/timeout capture
  -> SkillResult / Observation / EventLedger
```

TS、GUI、CLI、TUI、MCP server 和 LLM 都不能直接 spawn Skill 进程。

### LLM Workflow

DeepCode 当前采用 Kernel-owned workflow / state machine + Session dynamic projection：

```text
Kernel workflow descriptor / state machine
  -> Session parses typed proposal and submits PlanContract
  -> Kernel PlanReview / PermissionGate / execution facts
  -> Session projects Plan / Check / Permission / Execution / Review cards
```

边界规则：

- `Plan` 是用户可见计划卡，来自 LLM 结构化输出和 Session parser；其中 `ACTION_BUNDLE` 只是草案。
- `Check` 是 Kernel `PlanReview` + 用户计划评审卡，不再是单独的 LLM 检查阶段文本；用户可同意计划，也可提交评审意见进入 revise。
- `Permission` 是执行前真实授权请求，权限摘要只来自 Kernel report / PermissionGate。
- `Execution` 展示工具、权限、文件变更和验证事实；LLM 的执行期开场白不进入主阅读流。
- `Review` 展示 Kernel facts + LLM guidance，并等待用户最终 review；模型不能替代用户标记 accepted。
- `Plan / Check / Permission / Execution / Review` 是稳定投影语义，不是所有 workflow 都必须照搬的固定状态序列。

## Windows / Linux / Docker 策略

DeepCode 应用进程运行在宿主 OS：

- Windows 版本读写 Windows 文件。
- Linux/macOS 版本读写本机文件。
- WSL/Docker 是默认推荐的开发执行环境，不是应用自身运行位置。

Windows 默认建议：

- 文件浏览和编辑使用 Windows 宿主路径。
- Agent shell、build、test 默认建议走 WSL 与 Docker。
- 用户明确选择 PowerShell、cmd、宿主 shell 或不使用 Docker 时，Kernel 记录 override 并尊重选择。

## 许可

DeepCode 使用 MIT License。详见 [LICENSE](./LICENSE)。

## 特别鸣谢

DeepCode 的设计、实现和验证过程使用了 AI 编程工具辅助完成需求拆解、架构讨论、代码生成、界面原型和文档整理。感谢 Codex 在工程实现、代码审查和测试闭环中的协作，感谢 Gemini 3.1 Pro 在前端美术风格和 UI 布局设计上的帮助，感谢 Claude Opus 4.6/4.7 在方案规划、代码审查、架构优化上的帮助。

本项目仍以人工确认的需求、权限边界、代码审查和测试结果作为最终事实源；AI 输出只作为工程决策的辅助材料。

## 参考文献

本节按仓库去重记录 DeepCode 的架构、Agent 工作流、Skill 组织和扩展机制参考来源。引用仅表示设计启发，不表示复制外部源码或兼容外部项目实现。

### 核心 Agent / IDE 架构参考

[1] openai/codex. *Codex CLI*. GitHub repository. Available: https://github.com/openai/codex. Accessed: 2026-05-25.

[2] sst/opencode. *OpenCode*. GitHub repository. Available: https://github.com/sst/opencode. Accessed: 2026-05-25.

[3] continuedev/continue. *Continue*. GitHub repository. Available: https://github.com/continuedev/continue. Accessed: 2026-05-25.

[4] Aider-AI/aider. *Aider*. GitHub repository. Available: https://github.com/Aider-AI/aider. Accessed: 2026-05-25.

[5] cline/cline. *Cline*. GitHub repository. Available: https://github.com/cline/cline. Accessed: 2026-05-25.

[6] RooCodeInc/Roo-Code. *Roo Code*. GitHub repository. Available: https://github.com/RooCodeInc/Roo-Code. Accessed: 2026-05-25.

[7] SWE-agent/SWE-agent. *SWE-agent*. GitHub repository. Available: https://github.com/SWE-agent/SWE-agent. Accessed: 2026-05-25.

[8] All-Hands-AI/OpenHands. *OpenHands*. GitHub repository. Available: https://github.com/All-Hands-AI/OpenHands. Accessed: 2026-05-25.

[9] microsoft/vscode. *Visual Studio Code*. GitHub repository. Available: https://github.com/microsoft/vscode. Accessed: 2026-05-25.

[10] earendil-works/pi. *Pi*. GitHub repository. Available: https://github.com/earendil-works/pi. Accessed: 2026-05-25.

### Skill / Agent 生态参考

[11] mattpocock/skills. *Skills*. GitHub repository. Available: https://github.com/mattpocock/skills. Accessed: 2026-05-25.

[12] nousresearch/hermes-agent. *Hermes Agent*. GitHub repository. Available: https://github.com/nousresearch/hermes-agent. Accessed: 2026-05-25.

[13] multica-ai/andrej-karpathy-skills. *Andrej Karpathy Skills*. GitHub repository. Available: https://github.com/multica-ai/andrej-karpathy-skills. Accessed: 2026-05-25.

[14] addyosmani/agent-skills. *Agent Skills*. GitHub repository. Available: https://github.com/addyosmani/agent-skills. Accessed: 2026-05-25.

[15] obra/superpowers. *Superpowers*. GitHub repository. Available: https://github.com/obra/superpowers. Accessed: 2026-05-25.

[16] affaan-m/everything-claude-code. *Everything Claude Code*. GitHub repository. Available: https://github.com/affaan-m/everything-claude-code. Accessed: 2026-05-25.

[17] github/spec-kit. *Spec Kit*. GitHub repository. Available: https://github.com/github/spec-kit. Accessed: 2026-05-25.

[18] datawhalechina/hello-agents. *Hello Agents*. GitHub repository. Available: https://github.com/datawhalechina/hello-agents. Accessed: 2026-05-25.

[19] ruvnet/ruflo. *Ruflo*. GitHub repository. Available: https://github.com/ruvnet/ruflo. Accessed: 2026-05-25.

[20] anthropics/skills. *Skills*. GitHub repository. Available: https://github.com/anthropics/skills. Accessed: 2026-05-25.

[22] LangChain GitHub repository Available:https://github.com/langchain-ai/langchain Accessed: 2026-05-29
