# DeepCode

> Chinese guide: [README.zh-CN.md](README.zh-CN.md)

DeepCode is a local-first AI coding workbench with four user interfaces over the same local Session Runtime and Kernel: a full Editor, a focused conversational GUI, a CLI, and a TUI.

“Local-first” means the application, workspace access, session records, permissions, and tool execution are hosted locally. Prompts and selected context are still sent to the LLM provider you configure unless you use a local provider such as Ollama.

## Choose an interface

| Interface | Best for | Entry |
| --- | --- | --- |
| DeepCode Editor | Editing, file tree, terminal, Git panel, browser, and Agent conversation in one workbench | `DeepCode.app`, `DeepCode.exe`, or the Linux GUI launcher |
| DeepCode-GUI | Focused conversations, attachments, project sessions, and review | `DeepCode-GUI.app` or `DeepCode-GUI.exe` |
| CLI | Scripts, one-shot questions, session inspection, and terminal workflows | `DeepCode-CLI.command` or `deepcode-cli` |
| TUI | Interactive terminal conversations | `DeepCode-TUI.command` or `deepcode-tui` |

The interfaces share sessions, model profiles, permissions, and the canonical timeline when they use the same configuration root.

## macOS quick start

### Use an existing local package

If `bin/macos-arm64/` has already been built:

```bash
open bin/macos-arm64/DeepCode.app
open bin/macos-arm64/DeepCode-GUI.app
```

For terminal interfaces:

```bash
cd bin/macos-arm64
./DeepCode-TUI.command
./DeepCode-CLI.command --help
```

Both apps start their bundled local Kernel automatically. The TUI launcher starts a package-local Kernel when it cannot connect to one.

### Build the local package from source

Start Docker Desktop or Colima, then run:

```bash
make package-macos
```

The output is written to `bin/macos-arm64/` and includes both apps, CLI/TUI launchers, the Kernel, Session runtime, web assets, and a package-local writable data root.

If a packaged app appears to be using stale assets or an old Kernel, quit the running DeepCode apps and rebuild with:

```bash
make package-macos-clean
```

The macOS package is intended for local use. It is ad-hoc signed, but it is not distributed as a DMG and is not Developer ID signed or notarized.

## Linux and Windows packages

Development and portable packaging use the project container. On Windows, run these commands from WSL; native PowerShell is not a supported build entry.

```bash
make shell
```

Then, inside the container:

```bash
bash ./build.sh
```

The build writes:

```text
bin/linux-x64/
bin/win64/
```

On Linux, start the GUI host and open its local URL:

```bash
cd bin/linux-x64
./deepcode-gui
```

Then open [http://127.0.0.1:31245/](http://127.0.0.1:31245/). The Linux package also includes `deepcode-cli` and `deepcode-tui`.

On Windows, open `DeepCode.exe` for the full Editor or `DeepCode-GUI.exe` for the conversation-focused GUI. Keep `WebView2Loader.dll` next to the executable and install the Microsoft Edge WebView2 Evergreen Runtime on the target system.

## Configure an LLM

Before the first conversation:

1. Open **Settings** and select **LLM**.
2. Add a preset or create an OpenAI-compatible, Anthropic, or Ollama profile.
3. Enter the provider base URL, model name, and API key when the provider requires one.
4. Enable the profile, select the default profile, and save it.
5. Use **Probe** to check connectivity when available.

Packaged builds may include profile presets, but they do not include your API key. API keys are written to the local secret store for the active configuration root; do not share that directory.

The model selector in the conversation composer chooses the profile for the current session. Once a session has started work, the selector can be locked until the active run reaches a safe boundary.

## Start a conversation

The usual GUI flow is:

1. Open or select a project workspace, or attach the files needed for a read-only question.
2. Create a session and choose a model profile.
3. Describe the result you want in the composer.
4. Review requirement or Plan cards when DeepCode needs confirmation.
5. Approve or deny Kernel permission requests based on their exact target.
6. Review the resulting facts and changes before accepting the final review.

An accepted Plan is not blanket permission. File writes, deletes, Git mutations, and other gated actions still follow the Kernel permission and audit path.

For ordinary chat without a workspace, use the GUI without a project binding or pass `--no-workspace` in CLI/TUI. Workspace tools fail closed when no workspace is bound.

## CLI examples

The following examples use the macOS launcher. On Linux, replace `./DeepCode-CLI.command` with `./deepcode-cli`.

```bash
./DeepCode-CLI.command daemon status
./DeepCode-CLI.command sessions list
./DeepCode-CLI.command ask -C /path/to/project "Explain this project"
./DeepCode-CLI.command -p ask --no-workspace "Explain RAII briefly"
./DeepCode-CLI.command timeline
```

Use an existing session:

```bash
./DeepCode-CLI.command sessions resume <session-id>
./DeepCode-CLI.command --session <session-id> ask "Continue the analysis"
```

Run `./DeepCode-CLI.command --help` for permission and requirement/plan/review decision commands.

## TUI basics

Start the TUI with the current directory as its workspace:

```bash
./DeepCode-TUI.command
```

Or bind an explicit workspace:

```bash
./DeepCode-TUI.command -C /path/to/project
```

Useful interactive commands include:

- `/help` — show all commands.
- `/status` — check the local Kernel.
- `/workspace` — inspect or change the workspace binding.
- `/sessions`, `/new`, `/use`, `/timeline` — manage and inspect sessions.
- `/allow` and `/deny` — resolve a displayed permission request.
- `/decision` — resolve requirement, Plan, or review requests.
- `/cancel` — cancel the active run request and refresh the shared projection.

## Local data and configuration

Packaged desktop shells keep writable data under the distribution root by default:

```text
config/user/local/settings/   Settings and LLM profiles
config/user/local/secrets/    Local secret references
sessions/                     Session projection and transcript cache
conversation-archives/        Conversation exports and debug packages
kernel/                       Kernel ledger and runtime records
logs/                         Launcher and Kernel logs when emitted
```

Set `DEEPCODE_CONFIG_DIR` to use another configuration root. Direct CLI or daemon runs use the OS configuration root unless this variable is set. To share sessions and profiles between interfaces, start them with the same configuration root.

Do not publish the secrets directory, raw conversation archives, or debug exports without reviewing their contents.

## Troubleshooting

### No model is available

Open **Settings → LLM**, make sure at least one profile is enabled, add the required API key, save, and probe the profile.

### The app cannot reach the Kernel

Check the local health endpoint:

```bash
curl http://127.0.0.1:31245/api/health
```

Desktop shells normally choose or start a local port automatically. For direct CLI/TUI use, `DEEPCODE_API_URL` selects an existing daemon and `DEEPCODE_PORT` overrides the default port.

### CLI/TUI reports a missing Session runtime

Use a packaged distribution, or build the Session runtime in the source checkout:

```bash
pnpm --filter @deepcode/session-core build
```

A portable package must keep its `session-core/`, bundled Node runtime, and protocol package next to the launchers.

### The packaged macOS app looks stale

Quit every running DeepCode app and run:

```bash
make package-macos-clean
```

You can also inspect `bin/macos-arm64/build-info.json` and `/api/health` to compare the packaged source identity.

### Inspect runtime diagnostics

Use **Settings → Runtime Doctor**, the session timeline, or the package-local `logs/` directory. Conversation exports are under `conversation-archives/`.

## Run from source for UI development

For a local conversational GUI preview:

```bash
make dev-deepcode-gui
```

Open [http://127.0.0.1:31246/](http://127.0.0.1:31246/). Use `make docker-info` to inspect the effective container, port, mounts, and volumes.

Contributor workflow and protected test-change rules live in [docs/git-branch-flow.md](docs/git-branch-flow.md) and [docs/test-change-request.md](docs/test-change-request.md); they are not part of the end-user workflow.

## Third-party notices and license

See [NOTICE.md](NOTICE.md), [ATTRIBUTION.md](ATTRIBUTION.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [CITATION.cff](CITATION.cff).

DeepCode is licensed under the [MIT License](LICENSE).
