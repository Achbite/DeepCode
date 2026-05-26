# DeepCode

DeepCode 是一个本地 AI Agent 工作台，当前以 GUI IDE 形态提供文件编辑、工作区资源管理、终端、LLM 对话、工具调用审批和 Tauri 桌面打包能力。

长期架构目标是：

```text
DeepCode = Rust Agent Kernel + 可配置 Pack 体系 + GUI/CLI/TUI 多 Host Shell
```

当前 GUI 是首个 Host Shell。Server/Tauri 运行链路继续保持可用，Rust Kernel crates 先作为阶段 0 骨架旁路存在，后续逐步承载 Config、Prompt、Locale、Policy、Skill、Workflow、Ledger、ChangeSet 与 ReviewGate。

核心原则：模型负责生成计划和结构化动作，本地运行时负责权限校验、工具执行和结果记录。

当前优先支持 DeepSeek / OpenAI-compatible 模型，同时保留 Anthropic、Ollama、Codex-compatible 等 Provider 扩展接口。


## 快速开始

### 环境要求

| 依赖    | 建议版本     | 用途                      |
| ------- | ------------ | ------------------------- |
| Node.js | 20+          | Web/Server/Client 构建    |
| pnpm    | 9+           | Monorepo 包管理           |
| Rust    | 1.88+        | Tauri 构建、Kernel 骨架校验 |
| Docker  | 24+          | 推荐构建环境              |
| WSL     | Windows 推荐 | Windows 下默认 shell 环境 |

### 安装依赖

```bash
pnpm install
```

### Web 开发态

```bash
pnpm dev
```

默认地址：

- Client: `http://127.0.0.1:5173`
- Server: `http://127.0.0.1:31245`

单独启动：

```bash
pnpm dev:client
pnpm dev:server
```

### Tauri 开发态

```bash
pnpm tauri:dev
```

### Docker/WSL 构建

```bash
make shell
```

进入容器后执行：

```bash
./test.sh
BUILD_TAURI=1 ./build.sh
```

输出目录：

```text
bin/
├── linux-x64/deepcode
├── win-x64/deepcode.exe
├── win-x64/WebView2Loader.dll
└── installers/DeepCode_0.1.0_x64-setup.exe
```

## 项目介绍

- **IDE 基础能力**：工作区打开、文件树、编辑器、多标签、保存、草稿恢复、基础快捷键。
- **Agent 工作流**：支持 `plan -> check -> complete -> review` 阶段模型配置，也支持直接执行类任务的精简工作流。
- **权限门禁**：文件写入、补丁应用、Shell 执行进入统一 Permission Gate；命令黑名单可强制人工确认。
- **临时 Shell**：Agent 执行命令使用独立临时 shell，不污染用户手动终端会话。
- **LLM Provider**：支持配置 OpenAI-compatible / DeepSeek-compatible / Anthropic / Ollama profile。
- **Tauri 桌面端**：打包态通过 Rust 原生命令承载文件、工作区、LLM、Agent、终端能力。
- **Web 开发态**：通过 Vite + Fastify 快速调试 UI 与协议，避免频繁重新打包。

## 架构概览

DeepCode 正在从“GUI IDE + Agent runtime”演进为“Agent Kernel + 多 Host Shell”。当前阶段保持现有 GUI、Server、Tauri 路径稳定，同时建立根级 Rust workspace 作为 Kernel ABI/Core/Pack 子系统的落点：

```text
Host Shells
  ├─ React GUI              当前首个 Host，负责展示、输入、审批、配置编辑
  ├─ CLI                    后续复用同一 Kernel ABI
  └─ TUI                    后续复用同一 Kernel ABI

Kernel boundary
  ├─ KernelCommand          Host -> Kernel 的结构化命令
  ├─ KernelEvent            Kernel -> Host 的结构化事件
  ├─ KernelSnapshot         会话、配置、权限、Trace 的快照
  └─ WorkspaceBinding       Host 受控的运行工作区绑定

Rust Kernel crates
  ├─ deepcode-kernel-abi
  ├─ deepcode-kernel-core
  ├─ deepcode-kernel-config
  ├─ deepcode-kernel-policy
  ├─ deepcode-kernel-prompt
  ├─ deepcode-kernel-skills
  ├─ deepcode-kernel-workflow
  └─ deepcode-kernel-ledger
```

现有 Web 开发态和 Tauri 打包态的差异仍被限制在 `runtimeAdapter` 之下：

```text
React Workbench UI
  ├─ Editor / Explorer / Settings / Terminal / Agent Panel
  └─ runtimeAdapter
       ├─ Web dev: HTTP + WebSocket -> Node Fastify server
       └─ Tauri: invoke/event -> Rust native commands

Shared packages
  ├─ @deepcode/protocol   DTO, settings schema, tool/event contracts
  └─ @deepcode/agent-core action parser, workflow runner, permission model

Stage 0 Rust Kernel workspace
  ├─ deepcode-kernel-abi       KernelCommand / KernelEvent / KernelSnapshot
  ├─ deepcode-kernel-core      Kernel facade 与 Host adapter 边界
  ├─ deepcode-kernel-config    Config / Locale / CodeStyle 接口
  ├─ deepcode-kernel-policy    Capability / Policy / Permission 接口
  ├─ deepcode-kernel-prompt    PromptEnvelope / PromptCompiler 接口
  ├─ deepcode-kernel-skills    SkillDescriptor / SkillRuntime 接口
  ├─ deepcode-kernel-workflow  Workflow / WorkUnit / ChangeSet / Review 接口
  └─ deepcode-kernel-ledger    EventLedger / RunConfigSnapshot 接口
```

阶段 0 的 Kernel crates 只提供接口、DTO、trait 和 fail-closed facade，不接管现有 Server/Tauri Agent 主循环。

### 目录结构

```text
deepagent/
├── Cargo.toml                # 根级 Rust workspace，排除 tauri/src-tauri
├── crates/                   # 阶段 0 Agent Kernel crate 骨架
│   ├── deepcode-kernel-abi/
│   ├── deepcode-kernel-core/
│   ├── deepcode-kernel-config/
│   ├── deepcode-kernel-policy/
│   ├── deepcode-kernel-prompt/
│   ├── deepcode-kernel-skills/
│   ├── deepcode-kernel-workflow/
│   └── deepcode-kernel-ledger/
├── client/                  # React + Vite 前端
│   └── src/
│       ├── app/             # 应用入口与 WorkbenchLayout
│       ├── components/      # IDE 与 Agent UI 组件
│       ├── features/        # feature 分层入口
│       ├── services/        # runtimeAdapter、apiClient 等薄适配层
│       └── state/           # Zustand 状态
├── server/                  # Web 开发态本地服务
│   └── src/
│       ├── api/             # REST 路由
│       ├── modules/         # agent / llm / terminal / files / context
│       ├── services/        # 兼容保留的业务服务
│       └── ws/              # WebSocket 心跳
├── packages/
│   ├── protocol/            # 三端共享协议
│   └── agent-core/          # Agent 纯 TS 核心，不依赖 React/Node/Tauri
├── tauri/
│   └── src-tauri/           # Tauri v2 Rust 后端
│       └── src/
│           ├── agent.rs
│           ├── commands.rs
│           ├── fs.rs
│           ├── llm_profiles.rs
│           ├── terminal.rs
│           ├── user_settings.rs
│           └── workspace.rs
├── fixtures/agent-actions/  # Agent 行为协议测试夹具
├── build.sh                 # Docker 内双端打包入口
└── test.sh                  # 协议、服务端、Agent fixture smoke
```

### Agent 执行链路

```text
User message
  -> ContextSourceRegistry
  -> LLM Provider
  -> AgentActionParser
  -> Schema validation
  -> PermissionGate
  -> ToolExecutorRouter
  -> Observation / Trace events
  -> Final response
```

LLM 不直接读写本地资源。所有模型输出必须先被解析为结构化 action 或 tool call，再经过校验、权限判断和工具路由。

当前运行链路还增加了 `WorkspaceBinding` 约束：

- `fs.read`、`fs.list`、`fs.diff`、`fs.write`、`code.search` 必须有当前工作区。
- `fs.*` 路径只能是工作区相对路径，不能使用 `/tmp`、Windows 盘符、绝对路径或 `..` 穿越。
- `.code-workspace` 只能通过 Host 受控的 `openWorkspace` / `workspaceBinding.openPath` 进入 runtime，不能由模型 tool call 自行指定。
- 如果 runtime 丢失 current workspace，但 Host 请求携带有效 `WorkspaceBinding`，运行时会先恢复工作区绑定再执行工具。

### 内置工具

- `fs.read`
- `fs.list`
- `fs.diff`
- `fs.write`
- `code.search`
- `patch.plan`
- `shell.propose`
- `shell.exec`
- `final`

`shell.exec` 使用 Agent 专用临时 shell。用户手动终端和 Agent 临时 shell 是两个独立运行域。

## 构建与测试

常用检查：

```bash
pnpm --filter @deepcode/protocol build
pnpm --filter @deepcode/agent-core build
pnpm --filter @deepcode/server typecheck
pnpm --filter @deepcode/client typecheck
pnpm --filter @deepcode/client build
```

完整 smoke：

```bash
./test.sh
```

Tauri/Rust：

```bash
cd tauri/src-tauri
cargo check
```

Docker/WSL 打包：

```bash
BUILD_TAURI=1 ./build.sh
```

Windows 打包产物默认使用 WSL 作为命令行运行环境；如果没有 WSL，Agent 会返回结构化提示，建议安装 WSL 并配置 Docker。

## 配置

DeepCode 的配置目录按作用域拆分：

```text
config/
├── global/          # 全局 prompts / skills / ruler
├── user/local/      # 用户 settings / sessions / secrets
└── i18n/            # 本地化资源预留
```

打包态用户配置默认写入系统用户目录，例如 Windows：

```text
C:\Users\<user>\AppData\Roaming\DeepCode\config\user\local\
```

### LLM Provider

在 Settings -> LLM Providers 中添加模型配置。DeepSeek OpenAI-compatible 默认配置：

| 字段             | 值                                           |
| ---------------- | -------------------------------------------- |
| Base URL         | `https://api.deepseek.com`                 |
| Model            | `deepseek-v4-flash` 或 `deepseek-v4-pro` |
| API Key          | 用户自行申请并保存                           |
| Thinking         | 可选开启                                     |
| Reasoning effort | `low` / `medium` / `high`              |

API Key 只保存在本地 secret store，不应提交到 Git。

### Agent 权限

Settings -> Common Settings 中提供 Agent 权限开关：

- 文件读取/写入权限
- 代码搜索权限
- Shell propose / exec 权限
- Shell 自动执行开关
- 命令黑名单

黑名单命令即使开启自动执行也会进入人工确认。

## 开发约束

- UI 只调用 store/runtime facade，不直接调用 LLM SDK、shell spawn 或底层 executor。
- `packages/agent-core` 保持纯 TypeScript、无 React/Node/Tauri 依赖。
- 工具执行必须通过 Tool Registry、Permission Gate 和 Tool Executor Router。
- Tauri 打包态不依赖 Node sidecar；Web/Node 只作为开发调试与协议验证入口。
- 新增能力优先补协议 DTO、Web API、Tauri command stub，避免打包态出现 unknown command。
- 敏感信息不得写入仓库、日志或测试夹具。

## 贡献流程

1. Fork 或创建分支。
2. 保持变更按功能分组提交。
3. 提交前至少运行：

```bash
pnpm --filter @deepcode/client typecheck
pnpm --filter @deepcode/server typecheck
./test.sh
```

4. 涉及 Tauri 或打包态能力时运行：

```bash
BUILD_TAURI=1 ./build.sh
```

5. PR 描述中写明影响范围、验证命令和已知限制。

## 许可

DeepCode 使用 MIT License。详见 [LICENSE](./LICENSE)。

## 特别鸣谢

DeepCode 的设计、实现和验证过程使用了 AI 编程工具辅助完成需求拆解、架构讨论、代码生成、界面原型和文档整理。感谢 Codex 在工程实现、代码审查和测试闭环中的协作，感谢 Gemini 3.1Pro在前端美术风格UI布局设计上的帮助，感谢Claude Opus 4.6/4.7在方案规划、代码审查、架构优化上的帮助

本项目仍以人工确认的需求、权限边界、代码审查和测试结果作为最终事实源；AI 输出只作为工程决策的辅助材料。

## 参考文献

本节按仓库去重记录 DeepCode 的架构、Agent 工作流、Skill 组织和扩展机制参考来源。引用仅表示设计启发，不表示复制外部源码或兼容外部项目实现。

### 核心 Agent / IDE 架构参考

[1] openai/codex. *Codex CLI*. GitHub repository. Available: https://github.com/openai/codex. Accessed: 2026-05-25.

[2] sst/opencode. *OpenCode*. GitHub repository. Available: https://github.com/sst/opencode. Accessed: 2026-05-25.

[3] continuedev/continue. *Continue*. GitHub repository. Available: https://github.com/continuedev/continue. Accessed: 2026-05-25.

[4] Aider-AI/aider. *Aider*. GitHub repository. Available: https://github.com/Aider-AI/aider. Accessed: 2026-05-25.

[5] cline/cline. *Cline*. GitHub repository. Available: https://github.com/cline/cline. Accessed: 2026-05-25.

[6] RooCodeInc/Roo-Code. *Roo-Code*. GitHub repository. Available: https://github.com/RooCodeInc/Roo-Code. Accessed: 2026-05-25.

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
