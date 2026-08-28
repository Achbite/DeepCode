# DeepCode Tauri 薄壳

这个包只负责 DeepCode Editor 的本地桌面窗口、进程托管和传输装配。它内嵌 React 资源，启动同目录的 Kernel Daemon 与 Host proxy，并把用户操作转发到三层运行时：

```text
Tauri 壳
  -> Host proxy
  -> TypeScript Session（唯一 Agent Loop 与 SessionProjection）
  -> Rust Kernel（工具副作用与结果记录）
```

Tauri 壳不拥有 Agent Loop、Provider 逻辑、工具执行、Session journal 或任务终态，也不会从 UI 内容推断这些事实。

## 开发运行

先构建 Editor Web 资源，再启动 Tauri：

```bash
pnpm --filter @deepcode/client build
mkdir -p shells/tauri/dist
find shells/tauri/dist -mindepth 1 -delete
cp -r userspace/gui/dist/. shells/tauri/dist/
pnpm --filter @deepcode/tauri-shell tauri:dev
```

## 打包

```bash
bash ./build.sh
```

Windows 便携包的核心布局：

```text
bin/win64/
  DeepCode.exe
  WebView2Loader.dll
  deepcode-host-web.exe
  deepcode-kernel.exe
  session-core/
  web/
  config/
  sessions/
```

`DeepCode.exe` 默认启动并持有同目录的本地进程树；设置 `DEEPCODE_SHELL_CONNECT_ONLY=1` 时只连接已有实例。壳优先使用 `127.0.0.1:31245`，端口被占用时选择其他本地端口，并把目标与本地 Host token 交给内嵌页面。

`WebView2Loader.dll` 必须与 `DeepCode.exe` 保持在同一目录。目标 Windows 系统仍需安装 Microsoft Edge WebView2 Evergreen Runtime。
