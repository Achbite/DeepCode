# DeepCode Tauri Thin Shell

This package is a desktop window shell for the DeepCode Rust Kernel Web Host.

It intentionally does not contain Agent runtime, tool execution, workflow
logic, permission evaluation, session truth, or provider logic. The shell only
renders a bundled local boot shell immediately, starts or connects to the
same-dir Kernel Host, then opens the real GUI URL. It delegates all product
behavior to the three-layer runtime:

```text
Tauri Shell -> Kernel Host URL -> TS Session Layer projection -> Rust Kernel
```

Development command:

```bash
pnpm --filter @deepcode/tauri-shell tauri:dev
```

Build command:

```bash
pnpm --filter @deepcode/tauri-shell tauri:build
```

The Kernel Host must be running before the shell opens:

```bash
pnpm dev:kernel
```

Packaged Windows distribution layout:

```text
bin/win64/
  DeepCode.exe
  WebView2Loader.dll
  deepcode-kernel.exe
  web/
  config/
  packs/
```

`DeepCode.exe` starts `deepcode-kernel.exe` unless `DEEPCODE_SHELL_CONNECT_ONLY=1`
is set. It prefers `127.0.0.1:31245` when free and falls back to an available
localhost port only when needed. The selected target is also written into the
boot page hash, so the shell can connect even if the Tauri invoke bridge is not
ready yet. This keeps cold start responsive because the user sees the local
shell while the Kernel Host and React workbench finish loading.

Keep `WebView2Loader.dll` next to `DeepCode.exe`; it is copied from the Windows
Tauri build output by `build.sh`. The target Windows system is still expected to
have the Microsoft Edge WebView2 Evergreen Runtime installed.
