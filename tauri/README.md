# DeepCode Tauri 子包

> 桌面壳工程：前端复用 `@deepcode/client`，后端使用 Rust + Tauri v2，
> 系统级能力（原生 dialog、工作区文件、终端、LLM profile/chat、Agent runtime）通过 `#[tauri::command]` 暴露给前端。

## 目录结构

```text
tauri/
  package.json                pnpm 子包入口；提供 tauri / tauri:dev / tauri:build
  src-tauri/
    Cargo.toml                Rust crate
    build.rs                  Tauri 构建脚本
    tauri.conf.json           Tauri v2 配置（指向 client/dist）
    capabilities/default.json Tauri v2 权限集（仅 core + dialog）
    src/
      main.rs                 应用入口（注册插件与命令）
      commands.rs             Tauri command 薄转发层
      agent.rs                打包态 Agent session / tool / trace runtime
      llm_profiles.rs         LLM profile、secret 与 chat 调用
      terminal.rs             用户终端与 Agent 临时 shell runtime
    icons/                    应用图标资源（待设计稿替换）
```

## 本地开发

```bash
# 安装 Tauri CLI（首次）
cargo install tauri-cli --version "^2.0"

# 启动桌面壳（自动起 Vite + Cargo）
pnpm tauri:dev
```

## 打包

```bash
pnpm tauri:build
```

打包产物位置由根目录 `bin/` 收集（CI 中通过容器化 Dockerfile.tauri 执行；
本地构建时由 `tools/copy-tauri-bin.*` 脚本拷贝到 `bin/`，待后续阶段补齐）。

## 命令说明

| 命令族 | 用途 | 状态 |
| --- | --- | --- |
| Runtime / Workspace / File | 运行状态、工作区打开、文件树、文本读写 | 已实现 |
| LLM Profiles / Chat | DeepSeek / OpenAI-compatible profile、probe、chat | 已实现 |
| Agent Session | 会话、消息、权限、工具、事件快照、TraceLedger | 已实现 |
| Terminal | 用户终端、WSL 探测、Agent 临时 shell | 已实现 |
| Internal Browser | Browser 骨架、inspect/snapshot/attach 占位 | 接口预留 |
