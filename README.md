# DeepCode

**0.6.2** · [中文](README.zh-CN.md)

DeepCode is a local-first coding agent with a desktop GUI, a CLI for scripts, and an interactive terminal UI. All three share conversations, tool records, model connections, and permissions.

## Quick start

Build the current package using [Build from source](#build-from-source), or use a matching package from [Releases](https://github.com/Achbite/DeepCode/releases) when one is available. Choose an installer or a portable package:


| Platform            | Install or launch                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS Apple Silicon | Run `DeepCode-<version>-macos-arm64.pkg`, then open `/Applications/DeepCode-GUI.app`. The portable package contains `DeepCode-GUI.app`. |
| Windows x64         | Run `DeepCode-<version>-win64-setup.exe`, then open DeepCode from the Start menu. The portable package contains `DeepCode-GUI.exe`.     |
| Linux x64 / ARM64   | Extract the package for your architecture and run `./DeepCode-GUI`.                                                                     |


In **Settings → Models and services**, add an API connection or sign in to a supported Coding Plan. Create a conversation, select a model, and describe the task. Use a project's **Manage workspace** menu to choose its folders and execution environment. Windows projects can select a local shell or WSL.

The same package includes terminal interfaces:

```bash
# Linux; use DeepCode-CLI.command / DeepCode-TUI.command on macOS,
# or deepcode-cli.bat / deepcode-tui.bat on Windows.
./deepcode-cli connections
./deepcode-cli auth login openai-codex browser
./deepcode-cli ask -C /path/to/project "Explain this project"
./deepcode-tui -C /path/to/project
```

After installation with PKG or Windows Setup, use `deepcode-cli` and `deepcode-tui` directly in a terminal; on Windows, open a new terminal so it receives the updated PATH.

`-C` explicitly selects a workspace. Omit it for an independent conversation, or use `--session <id>` to continue one. Run `--help` for more commands. Connection and subscription setup is covered in [Models and services](docs/product/model-services.md).

In the GUI, attach files or folders to a message, open artifacts and diffs, or ask the Agent to open an HTML preview. Browser annotations stay active until you leave with the toolbar button or Esc. New conversations inherit the last model used for a submitted task and its remembered reasoning level. Use **Cmd+Shift+R** on macOS or **Ctrl+Shift+R** elsewhere to reload the interface.

Windows Setup installs WebView2 Evergreen Runtime if it is missing; portable Windows packages require it to be installed separately. Linux GUI requires GTK/WebKitGTK. The macOS package is ad-hoc signed. Configuration, persistent data, caches, temporary files and logs use separate platform directories. See [installation and user files](docs/distribution.md).

## Build from source

Install Docker and GNU Make. On Windows, run the build commands in WSL2 with Docker integration enabled. macOS packaging additionally needs the host's Xcode Command Line Tools, Rust toolchain from `rust-toolchain.toml`, and Node.js.

```bash
git clone --branch main https://github.com/Achbite/DeepCode.git
cd DeepCode
make shell
```

`make shell` prepares the development container. On macOS it also starts the worktree's native build bridge. Run the desired command inside that container, or from the host while it is running:


| Target                        | Command                                   | Output                                 |
| ----------------------------- | ----------------------------------------- | -------------------------------------- |
| macOS Apple Silicon           | `bash ./build.sh --stage package-macos`   | `bin/macos-arm64/`                     |
| Windows x64                   | `bash ./build.sh --stage package-windows` | `bin/win64/`                           |
| Linux, container architecture | `bash ./build.sh --stage package-linux`   | `bin/linux-x64/` or `bin/linux-arm64/` |
| All available platforms       | `bash ./build.sh`                         | The supported directories above        |


Shared TypeScript and GUI assets, Linux binaries, and Windows cross-compilation run in Docker. macOS native compilation and signing run on the Mac host through the bridge. Unsupported platforms are reported explicitly; build failures remain failures. Each package also produces a versioned archive under `bin/`; macOS adds a PKG installer and Windows adds a Setup executable. User configuration and sessions live outside the program directory and are excluded from packages.

For a frontend-only update to an existing package:

```bash
make ui-update UI_PACKAGE=bin/macos-arm64
```

Choose `bin/win64` or the Linux package directory for those platforms. This command builds and copies the GUI bundle; run macOS resource updates on the host for signing, then reload the interface. It does not replace the running Session or Kernel. Changes to their source or bundled product guidance require a corresponding service/package build and restart. Plugin update timing is described in [product operations](docs/product/operations.md#updates).

## What DeepCode does

- <strong>Work on projects:</strong> read and edit files, search code, run Bash or PowerShell, and inspect diffs. Workspace access and external effects follow the configured permission policy.
- <strong>Follow task progress:</strong> the task panel shows the Agent's phase list and current statuses. Related work can share a phase; the list stays separate from tool results and Plan approval.
- <strong>Preview and iterate:</strong> inspect an internal browser through screenshots and page interactions, annotate elements or regions, and continue editing from the same conversation. Attached originals stay read-only; editable copies can live in a DeepCode-managed session directory.
- <strong>Use your model service:</strong> API connections and subscription services have separate configuration and usage views. Provider-reported token/cache counts remain distinct from context estimates.
- <strong>Extend the tools and interface:</strong> Skills, CLI tools, MCP integrations and UI plugins add capabilities. The Agent can discover and activate an available plugin; users can also explicitly mention it. External desktop control currently supports macOS and requires separate approval.
- <strong>Create and read documents:</strong> generate HTML, Markdown and PDF artifacts. The file reader shows text source and PDFs; open HTML in the internal browser to view the page. PDF reading uses the bundled web reader; PDF generation needs the [document runtime prerequisites](skills/deepcode-documents/SKILL.md).

Workspace data, journals and tool execution stay local. The selected prompts, context and images are sent to your configured model service unless that service also runs locally.

Session owns the Agent Loop and conversation state; Kernel owns tools and execution permissions; the GUI, CLI and TUI present their shared results. Details belong in the product docs:

- [Models, subscriptions and usage](docs/product/model-services.md)
- [Shells, workspace environments and permissions](docs/product/execution-environments.md)
- [Operations and local data](docs/product/operations.md)
- [Computer Use](plugins/computer-use/README.md) · [UI plugins](docs/product/ui-plugins.md)

## Development checks

Run the checks inside `make shell`:

```bash
bash ./test.sh required   # Rust formatting/tests, shared TS, GUI contracts/types, build behavior
bash ./test.sh cli        # Required checks plus the CLI → Session → Kernel path
bash ./test.sh full       # Also covers the terminal/web shells and document output
```

`bash ./test.sh static` checks shell syntax and Git whitespace and can run on the host. End-to-end scripts use a local fixture Provider; they do not replace real model or native GUI acceptance. Native GUI tests have their own Cargo workspace: `shells/deepcode-gui/src-tauri/Cargo.toml`.

## License

[MIT](LICENSE). See [attributions](ATTRIBUTION.md), [third-party notices](THIRD_PARTY_NOTICES.md), and [citation metadata](CITATION.cff).
