# DeepCode

> 轻量级 AI Agent 代码工作台 — Tauri (Rust) 桌面外壳 + 本地 Node.js 后端 + React 前端，专注纯代码工作流。
> 针对 DeepSeek 模型进行专项优化。

---

## 启动 / 运行 / 打包

### 环境要求

| 依赖    | 最低版本 | 说明                           |
| ------- | -------- | ------------------------------ |
| Node.js | 20+      | 后端运行时 & 前端构建          |
| pnpm    | 9+       | 包管理器                       |
| Rust    | 1.77+    | Tauri 桌面壳编译               |
| Docker  | 24+      | 开发容器（可选，WSL 环境推荐） |

### 开发模式

```bash
# 安装依赖
pnpm install

# 同时启动 client (Vite) + server (Fastify)
pnpm dev

# 仅前端 Vite 开发服务器 (http://127.0.0.1:5173)
pnpm dev:client

# 仅后端 Fastify (http://127.0.0.1:31245)
pnpm dev:server

# Tauri 桌面开发模式（自动启动前端 + Rust 热重载）
pnpm tauri:dev
```

### 类型检查

```bash
pnpm typecheck          # 全工作区 (protocol + client + server)
```

### 生产构建

```bash
# Web 模式构建（前端 + 后端）
pnpm build

# Tauri 桌面应用构建（输出 exe/msi 到 target/release/bundle/）
pnpm tauri:build
```

### Docker 开发容器（WSL 推荐）

```bash
make shell    # 进入开发容器（镜像/容器不存在则自动构建）
make clean    # 全量清理（容器 + 镜像 + named volumes）

# 容器内执行：
./build.sh    # 编译并输出双平台产物到 bin/
./test.sh     # 运行链路 ping 与环境检查
```

### 打包产物结构

```text
bin/
├── win-x64/
│   ├── deepcode.exe          # Tauri 主程序（含 WebView2 bootstrapper）
│   ├── *.dll                 # Rust 运行时依赖
│   └── config/               # 预置配置目录
│       ├── global/           # 全局 skills / prompts / ruler
│       └── user/local/       # 用户级 settings / sessions / secrets
└── linux-x64/
    ├── deepcode              # Linux 二进制
    └── config/               # 同上
```

> 打包采用 `exe + dll + config` 轻量分发，不捆绑完整 WebView2 Runtime（约 6MB 安装包 vs 旧方案 185MB）。

---

## 工程结构

```text
deepagent/
├── client/               # 前端工作台 (React 19 + Vite 6 + Monaco Editor)
│   └── src/
│       ├── app/          # 应用入口 & WorkbenchLayout 布局
│       ├── components/   # UI 组件（见下方架构说明）
│       ├── services/     # 运行时适配层 & API 客户端
│       ├── state/        # Zustand 状态管理
│       └── types/        # 前端类型定义
├── server/               # 本地 Agent 后端 (Fastify 5 + WebSocket)
│   └── src/
│       ├── api/          # REST 路由
│       ├── services/     # 业务服务层
│       ├── security/     # localhost 守卫
│       └── ws/           # WebSocket 心跳
├── packages/
│   └── protocol/         # Client / Server / Tauri 共享协议 & DTO
│       └── src/          # userSettings / workspace / files / agent / llm / tools
├── tauri/
│   └── src-tauri/        # Tauri v2 Rust 后端
│       ├── src/          # main.rs / fs.rs / workspace.rs / user_settings.rs / commands.rs
│       └── capabilities/ # ACL 权限声明
├── Makefile              # Docker 开发容器入口
├── build.sh              # 双平台打包脚本
├── Dockerfile.dev        # 开发容器镜像
└── Dockerfile.tauri      # Tauri 构建镜像
```

---

## 架构设计

### 整体分层

```text
┌─────────────────────────────────────────────────────────┐
│                    Tauri Shell (Rust)                     │
│  frameless window · ACL 权限 · 文件系统 · 工作区管理     │
│  用户设置持久化 · WebView2 embedBootstrapper             │
└────────────────────────┬────────────────────────────────┘
                         │ Tauri IPC (invoke / event)
┌────────────────────────┴────────────────────────────────┐
│                  Client (React SPA)                       │
│  Monaco Editor · FileTree · Terminal · Agent Panel        │
│  Settings Center · WorkbenchLayout · WindowControls      │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP REST + WebSocket
┌────────────────────────┴────────────────────────────────┐
│                  Server (Node.js Fastify)                 │
│  文件读写 · 工作区扫描 · LLM 代理 · Agent 会话          │
│  代码搜索 · 用户设置 · 密钥存储                          │
└─────────────────────────────────────────────────────────┘
```

### 运行时适配层 (RuntimeAdapter)

前端通过 `runtimeAdapter.ts` 统一抽象 Tauri IPC 和 HTTP API 两种通信方式：

- **Tauri 模式**：桌面应用内直接调用 Rust 命令（`@tauri-apps/api`），零网络开销
- **Web 模式**：降级为 HTTP REST 调用本地 Node.js 后端，支持浏览器开发调试

调用方无需关心底层通信协议，所有文件操作、工作区管理、设置读写均通过 RuntimeAdapter 统一分发。

### 前端组件架构

| 组件                    | 职责                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `WorkbenchLayout`     | 主布局容器，管理侧边栏/编辑器/底部面板/Agent面板的拖拽调整与持久化 |
| `FileTree`            | 文件浏览器，支持新建/重命名/删除/拖拽排序，Codicons SVG 图标       |
| `CodeEditor`          | Monaco Editor 封装，支持多标签、Ctrl+S 保存、草稿恢复(hotExit)     |
| `TerminalPlaceholder` | 终端面板骨架，多会话管理、右键菜单、拖拽排序                       |
| `AgentPanel`          | AI 对话侧栏，消息列表 + 输入框 + 上下文附件 + 权限审批             |
| `SettingsCenter`      | 用户设置 UI，三层合并（默认 → 用户 → 工作区）                    |
| `WindowControls`      | 自定义窗口控制按钮（最小化/最大化/关闭），仅 Tauri 模式渲染        |

### 状态管理 (Zustand)

| Store                 | 职责                                                   |
| --------------------- | ------------------------------------------------------ |
| `editorStore`       | 标签页管理、文件内容缓存、dirty 状态、保存/草稿恢复    |
| `workspaceStore`    | 当前工作区路径、文件树数据、目录刷新                   |
| `settingsStore`     | 三层设置合并（default → user → workspace）、实时应用 |
| `agentSessionStore` | Agent 会话、消息历史、工具调用记录                     |
| `appStatusStore`    | 全局应用状态（连接状态、错误）                         |
| `uiStore`           | UI 临时状态（对话框、面板可见性）                      |

### Tauri Rust 后端

| 模块                 | 职责                                                 |
| -------------------- | ---------------------------------------------------- |
| `fs.rs`            | 文件读写（16MB 阈值）、目录树扫描、路径安全校验      |
| `workspace.rs`     | 工作区打开/扫描/保存 `.code-workspace`、工作区设置 |
| `user_settings.rs` | 用户设置 CRUD、配置目录分层（global/user）           |
| `commands.rs`      | Tauri command 注册入口、文件系统浏览                 |

### Node.js 后端服务

| 服务                    | 职责                                 |
| ----------------------- | ------------------------------------ |
| `fileService`         | 文件 CRUD、路径防穿越、大小限制      |
| `workspaceService`    | 工作区管理、`.code-workspace` 解析 |
| `userSettingsService` | 用户设置持久化（原子写）             |
| `llmService`          | LLM API 代理（DeepSeek 优先）        |
| `llmProfileService`   | 模型配置管理                         |
| `agentToolService`    | Agent 工具注册与执行                 |
| `codeSearchService`   | 代码搜索（grep 模式）                |
| `secretStore`         | 密钥安全存储                         |
| `fsBrowseService`     | 系统级目录浏览（工作区选择器）       |

### 协议层 (packages/protocol)

Client、Server、Tauri 三端共享的 TypeScript 类型定义：

- `workspace.ts` — 工作区 DTO、扫描结果、`.code-workspace` 结构
- `files.ts` — 文件读写请求/响应、目录树节点
- `userSettings.ts` — 用户设置 schema、默认值、分组定义
- `agent.ts` — Agent 会话、消息、工具调用
- `llm.ts` — LLM 配置、请求/响应
- `tools.ts` — 工具注册、输入 schema
- `events.ts` — WebSocket 事件类型
- `htmlRenderer.ts` — HTML 渲染器接口契约（预留）

### 安全模型

- Tauri ACL 权限声明：所有窗口操作、文件系统访问均需在 `capabilities/default.json` 显式授权
- Node.js 后端仅监听 `127.0.0.1`，不开放局域网
- 文件读写严格限制在工作区根目录内，`path.relative` 防穿越
- 桌面应用 frameless window + 自定义窗口控制，关闭时拦截未保存文件
- 敏感信息（API Key）通过 `secretStore` 加密存储，不入库

---

## 环境变量

| 变量                 | 默认值          | 说明                 |
| -------------------- | --------------- | -------------------- |
| `AGENT_LIGHT_PORT` | `31245`       | Node.js 后端监听端口 |
| `WORKSPACE_ROOT`   | `./workspace` | Agent 文件读写根目录 |

---

## 许可

本工程项目遵循MIT开源协议

## 特别鸣谢

DeepCode 的规划、实现和迭代过程中使用了多种 AI 编程工具辅助完成需求拆解、架构讨论、代码生成、前端风格探索和文档整理。特别感谢 Codex 在工程实现、代码审查与方案落地中的协作，Gemini 3.1 Pro 在前端视觉与交互方向上的设计辅助，以及 Claude Opus 4.6/4.7 在项目规划、系统设计和阶段目标拆解中的支持。

本项目仍以人工确认的需求、权限边界、代码审查和测试结果作为最终事实源；AI 工具输出仅作为辅助材料进入工程决策流程。

## 参考文献

[1] OpenAI. *Codex CLI*. GitHub repository, commit `22dd9ad3929253ed24d7ee4f10f238e95ab25f37`. Available: https://github.com/openai/codex. Accessed: 2026-05-22.

[2] SST. *OpenCode*. GitHub repository, commit `7afd477d1a1a147440f810c122d2f4b408e1b95c`. Available: https://github.com/sst/opencode. Accessed: 2026-05-22.

[3] Continue. *Continue*. GitHub repository, commit `cb273098d968906d25ee737b454f0b5f13ea2482`. Available: https://github.com/continuedev/continue. Accessed: 2026-05-22.

[4] Aider-AI. *Aider*. GitHub repository, commit `6435cb8b1e885d7275327d4b61206b1b1618dfe1`. Available: https://github.com/Aider-AI/aider. Accessed: 2026-05-22.

[5] Cline. *Cline*. GitHub repository, commit `b4d1b83bad502f940dfe8d9d796e1eba5d260c2a`. Available: https://github.com/cline/cline. Accessed: 2026-05-22.

[6] Roo Code. *Roo-Code*. GitHub repository, commit `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16`. Available: https://github.com/RooCodeInc/Roo-Code. Accessed: 2026-05-22.

[7] SWE-agent. *SWE-agent*. GitHub repository, commit `0f4f3bba990e01ca8460b9963abdcd89e38042f2`. Available: https://github.com/SWE-agent/SWE-agent. Accessed: 2026-05-22.

[8] All Hands AI. *OpenHands*. GitHub repository, commit `e3d9abfd014ffd4283d03071fdb88c1c8edc77f6`. Available: https://github.com/All-Hands-AI/OpenHands. Accessed: 2026-05-22.

[9] Anthropic. *Claude Code official and internal documentation*. Internal/reference documentation. Accessed: 2026-05-22.

[10] OpenAI. *Codex CLI internal documentation*. Internal/reference documentation. Accessed: 2026-05-22.

[11] Matt Pocock. *Skills*. GitHub repository. Available: https://github.com/mattpocock/skills. Accessed: 2026-05-22.

[12] Nous Research. *Hermes Agent*. GitHub repository. Available: https://github.com/nousresearch/hermes-agent. Accessed: 2026-05-22.

[13] Multica AI. *Andrej Karpathy Skills*. GitHub repository. Available: https://github.com/multica-ai/andrej-karpathy-skills. Accessed: 2026-05-22.

[14] Addy Osmani. *Agent Skills*. GitHub repository. Available: https://github.com/addyosmani/agent-skills. Accessed: 2026-05-22.

[15] Jesse Vincent. *Superpowers*. GitHub repository. Available: https://github.com/obra/superpowers. Accessed: 2026-05-22.

[16] Affaan M. *Everything Claude Code*. GitHub repository. Available: https://github.com/affaan-m/everything-claude-code. Accessed: 2026-05-22.

[17] GitHub. *Spec Kit*. GitHub repository. Available: https://github.com/github/spec-kit. Accessed: 2026-05-22.

[18] Datawhale China. *Hello Agents*. GitHub repository. Available: https://github.com/datawhalechina/hello-agents. Accessed: 2026-05-22.

[19] Ruvnet. *Ruflo*. GitHub repository. Available: https://github.com/ruvnet/ruflo. Accessed: 2026-05-22.

[20] Anthropic. *Skills*. GitHub repository. Available: https://github.com/anthropics/skills. Accessed: 2026-05-22.

[21] Siteboon. *ClaudeCodeUI*. GitHub repository. Available: https://github.com/siteboon/claudecodeui. Accessed: 2026-05-22.

[22] JackProAI. *JackProAi ClaudeCode 3.1*. GitHub repository. Available: https://github.com/JackProAi/JackProAi-claudecode3.1. Accessed: 2026-05-22.

[23] LING71671. *Open-ClaudeCode*. GitHub repository. Available: https://github.com/LING71671/Open-ClaudeCode. Accessed: 2026-05-22.

[24] Yeachan Heo. *Oh My Codex*. GitHub repository. Available: https://github.com/Yeachan-Heo/oh-my-codex. Accessed: 2026-05-22.

[25] Libukai. *Awesome Agent Skills*. GitHub repository. Available: https://github.com/libukai/awesome-agent-skills. Accessed: 2026-05-22.

[26] Earendil Works. *Pi*. GitHub repository. Available: https://github.com/earendil-works/pi. Accessed: 2026-05-22.
