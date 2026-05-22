# DeepCode Tauri 子包

> 桌面壳工程：前端复用 `@deepcode/client`，后端使用 Rust + Tauri v2，
> 系统级能力（原生 dialog、LLM 网关、Skill 运行时桥）通过 `#[tauri::command]` 暴露给前端。

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
      commands.rs             命令实现（pick_workspace_path / LLM / Skill stub）
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

| 命令 | 用途 | 状态 |
| --- | --- | --- |
| `get_app_version` | 返回 Tauri app 版本 | 已实现 |
| `pick_workspace_path` | 弹原生 dialog 选目录 | 已实现 |
| `llm_invoke_stub` | LLM 网关空操作占位 | NotImplemented |
| `skill_invoke_stub` | Skill 运行时桥空操作占位 | NotImplemented |
