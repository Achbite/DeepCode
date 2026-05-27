# DeepCode Tauri Thin Shell

This package is a desktop window shell for the DeepCode Rust Kernel Web Host.

It intentionally does not contain Agent runtime, tool execution, workflow
logic, permission evaluation, session truth, or provider logic. The shell only
opens the local Kernel Host GUI URL and delegates all product behavior to the
three-layer runtime:

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
