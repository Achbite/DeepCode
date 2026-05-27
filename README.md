# DeepCode

DeepCode 是一个本地 Agent Kernel 工作台。当前代码正在收束为统一的三层架构：

```text
UI 层
  GUI / CLI / TUI / Browser forwarder
  只负责展示、输入、审批和交互入口。

TS 用户会话层
  @deepcode/session-core
  负责用户态会话、附件、上下文拼装策略、事件投影和 Host 侧工作区绑定。
  不负责权限裁决、工具执行、workflow、文件系统事实或完成判定。

Rust 内核层
  DeepCode Kernel + Host adapters
  负责 workspace、context、policy、skill runtime、workflow、ledger、changeset、
  validation 和 review。所有敏感操作只能通过 Kernel syscall 发起。
```

核心原则：用户态只能提出意图，系统调用层传递结构化命令，内核态裁决资源访问、权限、工作流迁移、执行事实和完成判定。

## 快速开始

### 环境要求

| 依赖    | 建议版本     | 用途                                       |
| ------- | ------------ | ------------------------------------------ |
| Rust    | 1.88+        | Kernel crates、Axum Web Host、统一分发构建 |
| Node.js | 20+          | TS protocol/session-core/client 构建       |
| pnpm    | 9+           | TS workspace 包管理                        |
| Docker  | 24+          | 推荐构建与测试环境                         |
| WSL     | Windows 推荐 | Windows 默认 shell 与 Docker 集成环境      |

### 安装依赖

```bash
pnpm install
```

### 开发态

```bash
pnpm dev
```

默认入口：

- Rust Kernel Web Host: `http://127.0.0.1:31245`
- React Client: `http://127.0.0.1:5173`

单独启动：

```bash
pnpm dev:kernel   # cargo run -p deepcode-host-web
pnpm dev:client
```

### 测试与构建

```bash
./test.sh
./build.sh
```

`./build.sh` 输出 Linux 与 Windows 两个统一分发目录：

```text
bin/
├── linux-x64/
│   ├── deepcode-kernel
│   ├── deepcode-gui
│   ├── deepcode-cli
│   ├── deepcode-tui
│   ├── web/
│   ├── config/
│   └── packs/
└── win64/
    ├── deepcode-kernel.exe
    ├── deepcode-gui.bat
    ├── deepcode-cli.bat
    ├── deepcode-tui.bat
    ├── web/
    ├── config/
    └── packs/
```

GUI、CLI、TUI 的区别只是入口不同；Kernel、配置、Pack、事件协议和工作区 syscall 共享同一套实现。

`bin/<platform>/config` 只作为分发默认配置与 Pack 目录，不作为运行时用户设置写入位置。用户设置、LLM profile 与本地 secret 引用默认写入用户配置目录：

- Linux：`$XDG_CONFIG_HOME/deepcode/config` 或 `~/.config/deepcode/config`
- Windows：`%APPDATA%\DeepCode\config`

可通过 `DEEPCODE_CONFIG_DIR` 覆盖可写配置根目录。

打包态 GUI 入口会启动同一个 Rust Kernel Web Host 并服务 `web/` 静态资源。启动 `bin/linux-x64/deepcode-gui` 或 `bin\win64\deepcode-gui.bat` 后，在 Codex 内部浏览器、Chrome 或普通浏览器中打开：

```text
http://127.0.0.1:31245/
```

Codex 内部浏览器只是 Host 客户端；事实源仍然是 Rust Kernel。

## 当前架构

```text
deepagent/
├── Cargo.toml
├── crates/
│   ├── deepcode-kernel-abi        # KernelCommand / KernelEvent / KernelSnapshot
│   ├── deepcode-kernel-runtime    # Headless runtime dispatch 与 syscall
│   ├── deepcode-kernel-policy     # capability / policy / permission gate
│   ├── deepcode-kernel-skills     # SkillDescriptor 与受控外部进程 runtime
│   ├── deepcode-kernel-workflow   # WorkflowMachine / WorkUnit / Review 结构
│   ├── deepcode-kernel-ledger     # EventLedger 与 run snapshot
│   ├── deepcode-kernel-config
│   ├── deepcode-kernel-prompt
│   └── deepcode-host-web          # Rust Axum Web Host，默认 /api 入口
├── userspace/
│   ├── protocol                   # TS 迁移期 DTO 投影
│   ├── session-core               # TS 用户会话层
│   └── gui                        # React GUI Host
└── fixtures/                      # Agent/workflow/kernel fixture
```

旧多入口运行结构已退出默认源码树。默认开发、测试和打包链路走 Rust Kernel Web Host；TS 只保留 `userspace/protocol`、`userspace/session-core` 和 `userspace/gui` 三个用户态包。

## Kernel syscall

阶段 5.7 开始，工作区和 Skill 操作统一进入 Rust Kernel：

- workspace: `open/current/list/read/write/create/rename/delete/search`
- skill: `discover/invoke/result`
- context: 外部只读引用与 `.deepcode/references` 托管副本入口
- session/run: `run.start/resume/cancel`、permission、snapshot、event stream

文件操作规则：

- `workspace.open` 是 Host 受控入口，可以接收目录或 `.code-workspace` 绝对路径。
- 其他 `workspace.*` syscall 只能使用工作区相对路径。
- `..`、绝对路径、Windows 盘符均拒绝。
- `.deepcode/prompts`、`.deepcode/skills`、`.deepcode/ruler`、`.deepcode/policy` 是配置资产，不被普通 workspace full access 覆盖。
- `fs.delete` 是隐藏高风险能力，存在于 Kernel syscall 与受控 SkillDescriptor 中，但默认不暴露给模型工具目录。

## Skill Runtime

外部 Skill，包括 Python 脚本、二进制、shell wrapper、未来 MCP adapter wrapper，都必须经 Rust Kernel controlled process runtime 启动：

```text
SkillDescriptor
  -> PolicyGate / PermissionGate
  -> Kernel controlled process runtime
  -> stdout/stderr/exit/timeout capture
  -> SkillResult / Observation / EventLedger
```

TS、GUI、CLI、TUI、MCP server 和 LLM 都不能直接 spawn Skill 进程。

## Windows / Linux / Docker 策略

默认运行策略以 Linux 环境为主。Windows 用户启动 GUI 后，Agent shell 默认建议 WSL；如果未安装 WSL，应提示安装 WSL 与 Docker Desktop WSL integration。用户明确选择 PowerShell、cmd 或宿主机执行时，Host 可以记录 override，但 Kernel 仍负责权限、审计和边界检查。

## 验证入口

`./test.sh` 覆盖当前阶段的默认门禁：

- Rust workspace `cargo check/test`
- TS `protocol/session-core/client` typecheck
- Rust Axum Host `/api/*` smoke
- 打包态 Linux GUI 静态资源 smoke
- Windows GNU 交叉编译产物 smoke
- workspaceBinding 与工作区 syscall
- hidden `fs.delete` 受控能力
- `session-core` 不含工具执行、权限裁决、workflow runtime
- 旧 Node server、pkg、Tauri 独立后端链路不进入默认构建

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
