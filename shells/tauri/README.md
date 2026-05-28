# DeepCode Tauri Thin Shell

This package is a desktop window shell for the DeepCode Rust Kernel Web Host.

It intentionally does not contain Agent runtime, tool execution, workflow
logic, permission evaluation, session truth, or provider logic. The shell embeds
the full React GUI for immediate first paint, starts or connects to the same-dir
Kernel Host in the background, and delegates all product behavior to the
three-layer runtime:

```text
Tauri Shell -> Kernel Host URL -> TS Session Layer projection -> Rust Kernel
```

Development command:

```bash
pnpm --filter @deepcode/tauri-shell tauri:dev
```

Packaged build command:

```bash
./build.sh
```

Direct Tauri development still expects the GUI dist to exist first:

```bash
pnpm --filter @deepcode/client build
mkdir -p shells/tauri/dist
find shells/tauri/dist -mindepth 1 -delete
cp -r userspace/gui/dist/. shells/tauri/dist/
pnpm --filter @deepcode/tauri-shell tauri:dev
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
localhost port only when needed. The selected target is written into the GUI URL
hash so bundled React code can talk to the background Kernel Host without a
blocking boot-page redirect.

Keep `WebView2Loader.dll` next to `DeepCode.exe`; it is copied from the Windows
Tauri build output by `build.sh`. The target Windows system is still expected to
have the Microsoft Edge WebView2 Evergreen Runtime installed.
