# DeepCode - 轻量级代码环境专用 AI Agent IDE

> 基于 Monaco Editor + xterm.js + 本地 Node.js 后端的轻量级 AI Agent IDE

## 项目概述

DeepCode 是一个运行在本地、专注代码开发场景的轻量级 AI Agent IDE。它结合了现代代码编辑器的体验和 AI Agent 的智能辅助能力，为开发者提供纯净、可控的开发环境。

## 核心特性

- 🚀 **轻量启动**：默认只显示文件树、编辑器、终端、Git 面板、Agent 对话面板
- 🤖 **智能辅助**：AI Agent 能读文件、生成补丁、预览 Diff、运行命令
- 🔒 **安全可控**：所有高风险操作都需要用户确认，确保代码安全
- 📁 **本地优先**：所有数据存储在本地，保护隐私和安全
- 🛠️ **工具闭环**：完整的文件编辑、终端执行、Git 版本控制能力

## 技术架构

- **前端**：React + TypeScript + Monaco Editor + xterm.js
- **后端**：Node.js + TypeScript + Fastify/Express
- **通信**：REST API + WebSocket
- **权限**：多层安全门禁 + 审批中心

## 开发状态

项目目前处于初期开发阶段，正在构建基础架构。

## 快速开始

```bash
# 克隆项目
git clone https://github.com/Achbite/DeepCode.git
cd DeepCode

# 安装依赖
npm run setup

# 启动开发环境
npm run dev
```

## 许可证

MIT License