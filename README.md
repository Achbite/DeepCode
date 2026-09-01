# DeepCode

> 中文说明：[README.zh-CN.md](README.zh-CN.md)

DeepCode is a local-first coding-agent framework. The Editor, DeepCode-GUI, CLI, and TUI share one local Session Runtime, Kernel, and `SessionProjection`; their differences are limited to rendering and interaction.

“Local-first” means workspace access, the Session journal, shared projections, tool execution, and tool records stay on this machine. Prompts and context selected by the Agent are still sent to the configured model provider unless you use a local provider such as Ollama.

## How it works

```text
user input
  -> the single Agent Loop owned by Session
  -> typed Provider turn deltas or a native tool call
  -> Session classifies and journals narrative / answer / interaction / Plan facts
  -> optional complete Plan confirmation under the current workspace policy
  -> Kernel prepares, authorizes, executes, and records one effect
  -> Session continues and reduces a shared projection
  -> UI / CLI / TUI render the same facts
```

- Session owns the Agent Loop, context, Provider lifecycle, journal, and shared projection.
- Kernel owns the controlled tool catalog, `PreparedEffect`, real side-effect boundary, and tool-result records that remain immutable while their Session is retained.
- Host only composes local services and owns process, transport, and configuration concerns.
- UI submits commands and consumes `SessionProjection`; it does not maintain another task state machine.
- Skills and MCP servers contribute through plugin-shaped values without creating another Agent Loop.

DeepCode has no parallel Requirement, Plan, or Review workflow engine. Ordinary narrative and final answers are native LLM Markdown; Session classifies them only from the typed Provider turn lifecycle and projects the current run's text deltas as a disposable `assistantDraft` to every shell. Plan and interaction facts can only come from the LLM invoking reserved structured Session control tools—there is no JSONL body envelope, prose inference, or parse-failure fallback. `plan.publish` publishes one complete revision; `plan.respond(confirm)` commits session-scoped authority only for its exact workspace, operation, and normalized targets and atomically seeds the Todo list from the Plan steps. Revision requests retain the Plan identity and increment its revision, while cancellation creates no authority or Todo. Confirmed Plan/Todo state survives ordinary supplemental input and subsequent runs until an explicit Plan lifecycle fact supersedes, completes, cancels, or invalidates it.

A Session binding always limits workspace tools to its immutable run snapshot. `agent.permissions.workspaceMutation` defaults to `plan`; setting it to `allow` removes the Plan admission gate for workspace mutations, including `bash` calls declared with `workspaceMode=write`. On macOS, `bash` is an independently authorized project-debugging capability: it needs a bound workspace, runs bounded non-interactive `/bin/bash` with closed stdin, and retains destructive-command hard denials. `workspaceMode=read` permits writes only under the Kernel-owned `$TMPDIR`; `workspaceMode=write` additionally requires an exact confirmed Plan operation before changing workspace files. The working directory is always the bound workspace root, so commands use `cd` explicitly for subdirectories. PATH combines the Host PATH with existing standard developer-tool directories. `HOME` remains readable but not writable, and the Kernel removes the private temporary directory after every reachable call path. Exit zero produces a completed ToolRecord; nonzero exit or timeout produces a failed ToolRecord while retaining bounded stdout, stderr, exit status, and timeout facts. The catalog reports `bash` as blocked outside macOS until a platform workspace sandbox is implemented. Network reads default to `allow` and may reach any HTTP(S) destination available to the Host; external-effect tools continue to default to `ask`. `web.search` uses the built-in Bing RSS backend when `agent.web.search.endpointTemplate` is empty; an explicit template overrides it with the existing JSON search-result contract. Neither setting relaxes workspace path resolution or approval for out-of-workspace effects. `agent.permissions.engineeringDecisions` independently chooses whether material engineering-route ambiguity is asked through `interaction.request` or delegated to the Agent. Public GitHub repository/issue search and contents reads work without credentials; REST code search uses `DEEPCODE_GITHUB_TOKEN` captured at daemon startup, as required by GitHub.

## Interfaces

| Interface       | Best for                                                   | Entry                                                |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| DeepCode Editor | Files, editor, terminal, Git panel, and Agent conversation | `DeepCode.app`, `DeepCode.exe`, or the Linux GUI |
| DeepCode-GUI    | A focused local Agent conversation                         | `DeepCode-GUI.app` or `DeepCode-GUI.exe`         |
| CLI             | One-shot tasks, scripts, and terminal workflows            | `DeepCode-CLI.command` or `deepcode-cli`         |
| TUI             | Continuous interactive terminal conversations              | `DeepCode-TUI.command` or `deepcode-tui`         |

For day-to-day development, use the full DeepCode GUI when you want the file tree, editor, terminal, Git, and Agent workflow in one place. Use the TUI for terminal-first development. The CLI remains available for one-shot operations, automation, and diagnostics.

All interfaces read the same model profiles, Session journal, Kernel records, and projection when they use the same configuration root.

## macOS quick start

Open an existing local package:

```bash
open bin/macos-arm64/DeepCode.app
open bin/macos-arm64/DeepCode-GUI.app
```

Use a terminal interface:

```bash
cd bin/macos-arm64
./DeepCode-TUI.command -C /path/to/project
./DeepCode-CLI.command --help
```

Build the local package from source:

```bash
make package-macos
```

Output is written to `bin/macos-arm64/` and includes both apps, the CLI/TUI launchers, Kernel, Session runtime, web assets, and a package-local writable data root. If a package still shows stale resources, quit every DeepCode app and run:

```bash
make package-macos-clean
```

The macOS package is intended for local use and is ad-hoc signed. It is not a Developer ID signed or notarized DMG.

The macOS package service uses the request directory inside this repository and publishes only to this repository's `bin/macos-arm64/`. Its receipt reports the worker root, output directory, and log. The packaging transaction still verifies that source content did not change before publication.

## Linux and Windows packages

Portable builds use the single `deepcode-dev` container. The recommended host entrypoint for a complete build is:

```bash
make build
```

For an interactive development shell (enter WSL first on Windows):

```bash
make shell
bash ./build.sh
```

Every entrypoint reevaluates `Dockerfile.dev` through Docker's build cache. If the source mount, image, or port changed, the tooling recreates only the fixed `deepcode-dev` container and preserves dependency/build caches. Branch-specific containers and `DEEPCODE_WORKTREE_ID` are no longer part of the development model. To recreate only the container, run:

```bash
make reset-dev
```

`rust-toolchain.toml` pins development and packaging to Rust 1.88.0. The Cargo workspace declares Rust 1.86 as its minimum, matching the actual requirement of the current lockfile.

Artifacts are written to:

```text
bin/linux-x64/
bin/win64/
```

On Linux:

```bash
cd bin/linux-x64
./deepcode-gui
```

Then open [http://127.0.0.1:31245/](http://127.0.0.1:31245/). On Windows, use `DeepCode.exe` or `DeepCode-GUI.exe`; Microsoft Edge WebView2 Evergreen Runtime is required.

## Configure a model

Before the first task:

1. Open **Settings → LLM**.
2. Create an OpenAI-compatible, Anthropic, or Ollama profile.
3. Enter the base URL, model, and any API key required by the provider.
4. Enable the profile, select it as the default, and save.
5. Use **Probe** when available to check connectivity.

Packages never include your API key. Secrets are stored in the active configuration root's local secret store; do not share that directory.

For providers that require a reasoning field to be echoed across a tool continuation, Session keeps that field only in memory for the current run and sends it back along the same Provider call chain. It is never journaled, projected, or rendered as narrative. User-visible intermediate progress still comes only from ordinary model Markdown and structured tool activities.

## GUI workflow

1. Start an independent conversation, or create a project and attach one or more local folders.
2. A project's ordered folders are a template for new Sessions; every created Session keeps an immutable creation snapshot. Changing the project affects only Sessions created afterwards.
3. The composer places files and folders in one attachment area. A file is copied into that user message as an immutable content snapshot. A folder is not copied: it is retained as a logical reference on that message and enters only the frozen directory snapshot of the run started by that message, where the model explores it with `fs.list`, `fs.glob`, `code.grep`, and `fs.read`.
4. A folder reference remains visible on its original message but does not mutate the Session or Project directory indexes. The explicit CLI/TUI `attach-directory`/`/attach` commands still manage Session directory indexes for subsequent runs and never silently change the project template.
5. Describe the coding result you want. An independent Session may remain unbound until folder access is actually needed.
6. While the Provider/tool loop runs, Session projects the current typed turn's LLM text deltas as a shared `assistantDraft`, then commits that text as narrative or a final answer when the turn closes.
7. When a Plan is published, review its complete steps and mutation manifest in the expandable Plan card. Confirm it, request a revision with free-form feedback, or cancel it. Confirmation automatically collapses the card without removing it and atomically creates the Todo list. If workspace mutation is configured as `allow`, the Agent may work directly inside bound workspaces without publishing a gate-only Plan.
8. The model selector remains available during the conversation and changes subsequent Provider turns.
9. Messages, Plan state, activities, artifacts, context usage, and run status all come from the shared projection.
10. A committed Assistant answer can be copied, rated up or down, or have its rating cleared. Ratings are durable local Session facts, recover after restart, are not stored by the GUI, and are not sent to the Provider.
11. Click the context ball in the composer to inspect the current Provider request partitions. Per-partition item counts and estimates come from Session; cache hit and miss counts come from Provider usage. Missing facts display `N/A`, and GUI/TUI do not attribute or recompute them. Settings shows Session-aggregated per-round token consumption newest first, 10 rows per page.
12. For complex work, the LLM publishes a complete Plan through `plan.publish`; confirmation atomically seeds the Todo list from Plan steps, and later `todo.progress` calls may update only those generated item states. The right task panel consumes only that shared projection; it does not reinterpret tool calls or GUI state as tasks. Tool calls remain interleaved with narrative in the main Session timeline.

Deleting a Session deletes the conversation catalog entry and its complete archive: Session events, command replay rows, binding relations, and Kernel tool records. An active run must be stopped first.

## CLI

These examples use the macOS launcher. Replace it with `./deepcode-cli` on Linux.

```bash
./DeepCode-CLI.command status
./DeepCode-CLI.command ask "Explain this coding question without a workspace"
./DeepCode-CLI.command ask -C /path/to/project "Find and fix the current build error"
./DeepCode-CLI.command chat -C /path/to/project
./DeepCode-CLI.command show --session <session-id>
```

Respond to an existing Session or pending Plan:

```bash
./DeepCode-CLI.command ask --session <session-id> 1
./DeepCode-CLI.command ask --session <session-id> "Adjust the targets and propose the Plan again"
./DeepCode-CLI.command cancel-plan --session <session-id>
./DeepCode-CLI.command model --session <session-id> <profile-id>
./DeepCode-CLI.command cancel --session <session-id> <run-id>
./DeepCode-CLI.command attach-directory --session <session-id> /path/to/folder
./DeepCode-CLI.command detach-directory --session <session-id> <workspace-id>
```

Only an explicit `-C` / `--workspace` creates a binding for a new CLI Session; the current directory is never implicit. During a pending Plan, `1`/`confirm` confirms the complete Plan and other non-empty text requests a revision; `cancel-plan` explicitly cancels it. `ask` waits until the run is terminal or needs user action, and failed, cancelled, or indeterminate runs exit non-zero. The CLI submits only through `ConversationPort` and never invokes tools directly.

## TUI

```bash
./DeepCode-TUI.command -C /path/to/project
./DeepCode-TUI.command -C /path/to/project --session <session-id>
```

Plain text is submitted to the current Session. Interactive commands are:

- `/help` — show command hints.
- `/show` — render the current shared projection again.
- `/cancel-plan` — explicitly cancel the current pending Plan.
- `/model <profile>` — switch the profile used by subsequent Provider turns.
- `/cancel` — cancel the active run.
- `/attach <path>` — attach a folder as a Session directory index.
- `/detach <workspace-id>` — detach a Session directory index for subsequent runs.
- `/clear` — refresh visible state without changing the durable Session.
- `/quit`, `/exit` — exit the TUI.

For a pending Plan, enter `1`/`confirm` to confirm the complete Plan or enter other non-empty text as revision feedback. `Esc` explicitly cancels the pending Plan; empty input, EOF, and Ctrl-C do not cancel it. As with the CLI, only explicit `-C` / `--workspace` creates a new binding.

## Local data

The default configuration root contains:

```text
config/user/local/settings/llm-profiles.json  Model profiles
config/user/local/settings/user-settings.json User settings
config/user/local/secrets/                    Local secrets
runtime/agent-runtime/catalog.sqlite3        Host-private project/workspace catalog
runtime/agent-runtime/session.sqlite3        Session journal and command replay
runtime/agent-runtime/tool-record.sqlite3    Kernel tool-result records
logs/                                         Launcher or Kernel logs when emitted
```

Set `DEEPCODE_CONFIG_DIR` to select another root. Interfaces must use the same root to share Sessions.
The packaged `session-core/` directory contains Session Runtime code, not conversation archives. Conversation history lives in `runtime/agent-runtime/session.sqlite3`.

Within `contracts/agent-runtime/`, `catalog.sql`, `session.sql`, and `tool-record.sql` are the current creation contracts for the three fact owners. Runtime opens only this exact schema and rejects other database versions; there is no migration or alternate history path. See [contracts/agent-runtime/README.md](contracts/agent-runtime/README.md).

## Troubleshooting

### No model is available

Open **Settings → LLM**, enable and select a default profile, add the required API key, save, and probe it.

### CLI/TUI cannot reach the local Daemon

Run:

```bash
./DeepCode-CLI.command status
```

Desktop shells and launchers normally start the local Daemon they own. Direct runs can use `--api` for an existing instance or `DEEPCODE_PORT` to change the default port. Protected Host APIs require the shell's local token, so an unauthenticated `curl /api/health` is not a supported diagnostic path.

### The Session runtime is missing

Use a complete package or build it in the source checkout:

```bash
pnpm --filter @deepcode/session-core build
```

Portable packages must keep `session-core/`, the Node runtime, and the protocol package next to their launchers.

### Inspect a runtime problem

Use CLI `status`, the UI's API/Agent status, and package-local `logs/`. Session and tool facts live in the two SQLite files above; there is no separate UI-owned fact store.

## Source validation

```bash
bash ./test.sh static
bash ./test.sh required
bash ./test.sh full
```

`static` checks layering and repository structure. `required` runs Rust/TypeScript builds and unit tests. `full` additionally exercises a local Provider, tool decisions, cancellation, command replay, and restart recovery end to end.

## Notices and license

See [NOTICE.md](NOTICE.md), [ATTRIBUTION.md](ATTRIBUTION.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [CITATION.cff](CITATION.cff).

DeepCode is licensed under the [MIT License](LICENSE).
