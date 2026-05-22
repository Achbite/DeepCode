# DeepCode

DeepCode 是一个本地 AI Agent IDE，提供文件编辑、工作区资源管理、终端、LLM 对话、工具调用审批和 Tauri 桌面打包能力。

核心原则：模型负责生成计划和结构化动作，本地运行时负责权限校验、工具执行和结果记录。

当前优先支持 DeepSeek / OpenAI-compatible 模型，同时保留 Anthropic、Ollama、Codex-compatible 等 Provider 扩展接口。


## 快速开始

### 环境要求

| 依赖    | 建议版本     | 用途                      |
| ------- | ------------ | ------------------------- |
| Node.js | 20+          | Web/Server/Client 构建    |
| pnpm    | 9+           | Monorepo 包管理           |
| Rust    | 1.88+        | Tauri 构建                |
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

DeepCode 只有一套 React 前端。Web 开发态和 Tauri 打包态的差异被限制在 `runtimeAdapter` 之下：

```text
React Workbench UI
  ├─ Editor / Explorer / Settings / Terminal / Agent Panel
  └─ runtimeAdapter
       ├─ Web dev: HTTP + WebSocket -> Node Fastify server
       └─ Tauri: invoke/event -> Rust native commands

Shared packages
  ├─ @deepcode/protocol   DTO, settings schema, tool/event contracts
  └─ @deepcode/agent-core action parser, workflow runner, permission model
```

### 目录结构

```text
deepagent/
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

DeepCode 的设计、实现和验证过程使用了 AI 编程工具辅助完成需求拆解、架构讨论、代码生成、界面原型和文档整理。感谢 Codex 在工程实现、代码审查和测试闭环中的协作，感谢 Gemini 与 Claude 在界面探索、系统规划和方案推演中的帮助。

本项目仍以人工确认的需求、权限边界、代码审查和测试结果作为最终事实源；AI 输出只作为工程决策的辅助材料。

## 参考文献

[1] OpenAI. *Codex CLI*. GitHub repository. Available: https://github.com/openai/codex. Accessed: 2026-05-22.

[2] SST. *OpenCode*. GitHub repository. Available: https://github.com/sst/opencode. Accessed: 2026-05-22.

[3] Continue. *Continue*. GitHub repository. Available: https://github.com/continuedev/continue. Accessed: 2026-05-22.

[4] Aider-AI. *Aider*. GitHub repository. Available: https://github.com/Aider-AI/aider. Accessed: 2026-05-22.

[5] Cline. *Cline*. GitHub repository. Available: https://github.com/cline/cline. Accessed: 2026-05-22.

[6] Roo Code. *Roo-Code*. GitHub repository. Available: https://github.com/RooCodeInc/Roo-Code. Accessed: 2026-05-22.

[7] SWE-agent. *SWE-agent*. GitHub repository. Available: https://github.com/SWE-agent/SWE-agent. Accessed: 2026-05-22.

[8] All Hands AI. *OpenHands*. GitHub repository. Available: https://github.com/All-Hands-AI/OpenHands. Accessed: 2026-05-22.

[9] Microsoft. *Visual Studio Code terminal and extension host architecture*. Documentation and source repository. Available: https://github.com/microsoft/vscode. Accessed: 2026-05-22.

[10] Earendil Works. *Pi*. GitHub repository. Available: https://github.com/earendil-works/pi. Accessed: 2026-05-22.

[11] Anthropic. *Skills*. GitHub repository. Available: https://github.com/anthropics/skills. Accessed: 2026-05-22.

[12] GitHub. *Spec Kit*. GitHub repository. Available: https://github.com/github/spec-kit. Accessed: 2026-05-22.
