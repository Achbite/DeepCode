# DeepCode Tauri 薄壳

当前产品版本与完整使用说明见[项目 README](../../README.zh-CN.md)。本壳与 DeepCode-GUI、CLI、TUI 随同一产品版本打包，版本由各包清单声明；分发目录的 `build-info.json` 记录实际源码提交与制品版本。

这个包只负责 DeepCode Editor 的本地桌面窗口、进程托管和传输装配。它内嵌 React 资源，启动同目录的 Kernel Daemon 与 Host proxy，并把用户操作转发到三层运行时：

```text
Tauri 壳
  -> Host proxy
  -> TypeScript Session（唯一 Agent Loop 与 SessionProjection）
  -> Rust Kernel（工具副作用与结果记录）
```

Tauri 壳不拥有 Agent Loop、Provider 逻辑、工具执行、Session journal 或任务终态，也不会从 UI 内容推断这些事实。

## 开发运行

常规开发与资源构建在项目 Docker 开发容器中进行：

```bash
make shell
bash ./build.sh --stage gui
```

## 打包

```bash
bash ./build.sh
```

Windows 便携包的核心布局：

```text
bin/win64/
  DeepCode.exe
  DeepCode-GUI.exe
  WebView2Loader.dll
  deepcode-host-web.exe
  deepcode-kernel.exe
  deepcode-cli.exe
  deepcode-tui.exe
  session-core/
  web/
  web-deepcode-gui/
  config/
  runtime/agent-runtime/
  build-info.json
```

同一配置根的壳通过共享 Host 连接信息连接同一个 daemon；没有可用实例时由启动入口创建。设置 `DEEPCODE_SHELL_CONNECT_ONLY=1` 时只连接已有实例。壳把实际连接地址与本地 Host token 交给内嵌页面；启动及代理失败保留原始错误。

模型配置从共享配置根加载，首次提供 DeepSeek Flash 模板。每个模型在自己的配置卡内保存；上次选中的模型作为新对话默认值。配置错误保留在设置页，已有 Session store 有效时仍可显示历史消息。

`WebView2Loader.dll` 必须与 `DeepCode.exe` 保持在同一目录。目标 Windows 系统仍需安装 Microsoft Edge WebView2 Evergreen Runtime。
