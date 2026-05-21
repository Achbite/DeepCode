# DeepCode

> 轻量级 AI Agent 代码工作台 — 自建外壳 + 本地 Node.js 后端，专注于纯代码工作流。
> 会针对deepseek进行专门的优化

## 简介

DeepCode 是一个面向个人编程工作流的轻量级 AI 代理工具，定位区别于通用 IDE：

- 只保留编辑器、文件浏览、终端、源代码管理与 AI 对话侧栏。
- 前端基于 Monaco Editor 内核（首期使用简化文本编辑器，后续阶段接入 Monaco）。
- 终端基于 xterm.js + 后端 `node-pty`（后续阶段接入）。
- 后端基于本地 Node.js（Fastify + WebSocket）只监听 `127.0.0.1`。
- AI Agent 工作流遵循"规划 → 执行 → 验证"循环，所有写入和命令执行需经审批。

## 工程结构

```text
deepagent/
├── client/           # 前端轻量工作台（React + Vite + Monaco / xterm.js 待接入）
├── server/           # 本地 Agent 后端（Fastify + WebSocket + node-pty 待接入）
├── packages/
│   └── protocol/     # Client / Server 共享协议
└── workspace/        # 默认工作区目录（用户文件，运行时只读写此目录内）
```

## 第一阶段进展

- 双包骨架（`client` / `server` / `packages/protocol`）已就绪。
- `/api/health` + `/ws/heartbeat` 已就绪。
- `/api/files/tree` + `/api/files/read` + `/api/files/write` 已就绪（阶段 4-5 提前点）。
- 基础文件树 + 简化文本编辑器已就绪（阶段 4-5 提前点）。
- 默认工作区 = `./workspace`，可用 `WORKSPACE_ROOT` 环境变量覆盖。

详细规划见 `技术方案/开发规划方案.md` 与 `技术方案/临时上下文存储.md`。

## 开发命令

```bash
pnpm install
pnpm dev          # 同时启动 client 和 server
pnpm dev:client   # 仅前端 Vite (http://127.0.0.1:5173)
pnpm dev:server   # 仅后端 Fastify (http://127.0.0.1:31245)
pnpm typecheck    # 全工作区类型检查
```

## 端口与环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_LIGHT_PORT` | `31245` | 后端监听端口 |
| `WORKSPACE_ROOT` | `./workspace` | Agent 文件读写根目录；不允许出此目录 |

## 安全约束

- 后端只监听 `127.0.0.1`，不开放局域网。
- 文件读写严格限制在 `WORKSPACE_ROOT` 内，使用 `path.relative` 防穿越。
- `.env` 与构建产物不入库。

## 许可

待补。
