# DeepCode

Current product version: **0.5.60**.

> 中文说明：[README.zh-CN.md](README.zh-CN.md)

DeepCode is a local-first coding-agent framework. The Editor, DeepCode-GUI, CLI, and TUI share one local Session Runtime, Kernel, and `SessionProjection`; their differences are limited to rendering and interaction.

“Local-first” means workspace access, the Session journal, shared projections, tool execution, and tool records stay on this machine. Prompts and context selected by the Agent are still sent to the configured model provider unless you use a local provider such as Ollama.

## What's new in 0.5.60

- Submit messages while the Agent is working. Session queues them in order and introduces them before the next model request after the current model output and tool results settle. Pending decisions keep their dedicated response flow; stopping is explicit.
- Kernel tools and Session extension points have been simplified around their actual consumers. An unselected plugin's loading error stays local to that plugin; selected plugins must load successfully.
- Shared Host discovery preserves startup and proxy errors. Native Windows workspace sandbox, process execution, and shell selection include the current Windows fixes.
- Invalid model configuration no longer prevents the Host from starting or displaying existing conversations. Settings retains the configuration error and provides an explicit repair action.
- A new configuration starts with a DeepSeek Flash template. Save each model in its own configuration card; the last selected model becomes the default for new conversations.
- Drag projects and conversations to reorder the sidebar. Copy, thumbs-up, and thumbs-down actions now share consistent hover and keyboard-focus behavior.

The release version is declared in the package manifests. Generated `build-info.json` records `productVersion`, source commit, build time, and source state; these identify the artifact independently of database and wire schema versions.

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

A Session binding always limits workspace tools to its immutable run snapshot. `agent.permissions.workspaceMutation` defaults to `plan`; setting it to `allow` removes the Plan admission gate for workspace mutations, including `bash` calls declared with `workspaceMode=write`. The selected shell tool (`bash` or `powershell`) executes one bounded command from the bound workspace and requires both `workspaceMode` and `executionScope`. `executionScope=workspace` uses the workspace sandbox; read mode may write only to Kernel-owned temporary storage, while write mode requires exact workspace mutation authority. The platform adapters use sandbox-exec on macOS, Bubblewrap on Linux/WSL2, and initialized native Windows workspace support. Missing prerequisites produce an explicit error; see [Execution environments](docs/product/execution-environments.md). `executionScope=host` uses the host user environment and additionally requires `agent.permissions.external`; a host command that mutates the workspace must declare write mode and therefore needs both workspace mutation and external authority. Optional `terminal.stdin` is written exactly once to a temporary PTY; without it stdin is closed, and no persistent terminal session is created. The working directory starts at the bound workspace root, PATH combines the host PATH with existing standard developer-tool directories, and every attempt owns and reclaims only its child process group, PTY, and temporary files. Exit zero produces a completed ToolRecord; nonzero exit or timeout produces a failed ToolRecord while retaining bounded output and exit facts. Network reads default to `allow`; host Bash and external-effect tools use the separate external permission. `web.search` and `web.fetch` remain the generic core network tools, while GitHub-, arXiv-, and PDF-specific workflows are activated through Skills or plugins. `agent.permissions.engineeringDecisions` independently chooses whether material engineering-route ambiguity is asked through `interaction.request` or delegated to the Agent.

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
bash ./build.sh
```

The script attempts Linux, Windows and macOS packaging by default, skipping targets whose support environment is unavailable; `make build` uses the same entrypoint. Frontend and Session assets are built from source in Docker, while native Rust/Tauri packaging runs on the Darwin host.

Output is written to `bin/macos-arm64/` and includes both apps, the CLI/TUI launchers, Kernel, Session runtime, web assets, and a package-local writable data root. If a package still shows stale resources, quit every DeepCode app and run:

```bash
make package-macos-clean
```

The macOS package is intended for local use and is ad-hoc signed. It is not a Developer ID signed or notarized DMG.

The macOS package service uses the request directory inside this repository and publishes only to this repository's `bin/macos-arm64/`. Its receipt reports the worker root, output directory, and log. The packaging transaction still verifies that source content did not change before publication.

## Linux and Windows packages

Run the same command to build all supported platform packages. Linux and Windows builds use the single `deepcode-dev` container; macOS requires its native package worker:

```bash
bash ./build.sh
```

No stage argument is needed. `make build`, `--full`, `--stage all`, and `--stage package` use the same platform selection.

Each build invokes the source build for every selected product and its dependencies. Cargo, sccache, Docker layers and dependency stores accelerate these steps; existing `dist` files or stage stamps never replace them. Packaging also builds its inputs before assembling the distribution.

For an interactive development shell (enter WSL first on Windows):

```bash
make shell
bash ./build.sh
```

`make shell` passes the host platform into the container and prepares the native packaging service on Mac. Running `build.sh` inside that container still attempts all three platforms; unavailable targets are reported as skipped. A target that starts and fails is reported as failed and makes the final build exit nonzero.

Every entrypoint reevaluates `Dockerfile.dev` through Docker's build cache. If the source mount, image, or port changed, the tooling recreates only the fixed `deepcode-dev` container and preserves dependency/build caches. Branch-specific containers and `DEEPCODE_WORKTREE_ID` are no longer part of the development model. To recreate only the container, run:

```bash
make reset-dev
```

`rust-toolchain.toml` pins development and packaging to Rust 1.88.0. The Cargo workspace declares Rust 1.86 as its minimum, matching the actual requirement of the current lockfile.

Artifacts are written to:

```text
bin/linux-x64/
bin/linux-arm64/
bin/win64/
```

For WSL/Linux builds, the Linux directory matches the development container architecture: `linux-x64` for amd64, or `linux-arm64` for arm64. A supported build emits one Linux architecture plus `win64`, and adds `macos-arm64` when the macOS packaging environment is available. Use `--stage package-linux`, `--stage package-windows` or `--stage package-macos` to select one platform explicitly.

On Linux:

```bash
cd bin/linux-x64
./deepcode-gui
```

Use `bin/linux-arm64` instead for an ARM64 Linux build.

Then open [http://127.0.0.1:31245/](http://127.0.0.1:31245/). On Windows, use `DeepCode.exe` or `DeepCode-GUI.exe`; Microsoft Edge WebView2 Evergreen Runtime is required.

## Update the UI independently

Build both frontends while retaining the installed Kernel, Session runtime and native applications:

```bash
make ui
python3 scripts/update-ui.py --package bin/macos-arm64
# Build and update in one command:
make ui-update UI_PACKAGE=bin/macos-arm64
```

`make ui` runs dependency setup, frontend type checking and Vite builds in Docker. It emits `bin/ui/web` and `bin/ui/web-deepcode-gui` without compiling Rust or the Session runtime. The updater replaces only Web resource directories in an existing package. Use `bin/win64` or the appropriate Linux directory for those platforms, a single `.app`, or `--surface gui` / `--surface editor`. Windows development builds continue through WSL / Docker; the updater uses only Python's standard library.

Run macOS updates on the host so the updater can refresh and verify each App's resource signature. Then choose **Reload interface** in Settings → Appearance / Common settings → Runtime information, or reopen the window. Save edits and unsent input first. User configuration, session history and the original package `build-info.json` remain intact. Each frontend has its own `frontend-build-info.json` with source and build time; these identities do not impose a version-equality gate with the Kernel.

This path covers UI changes using existing Host / Session interfaces. New backend interfaces or executors still require the corresponding service build. The document tools and resource API introduced here require an initial full version containing those services.

UI plugins also support live replacement in the open window. Add a local plugin folder in **Settings → Plugins → UI plugins**; saved entry changes update only its presentation. The first slots cover committed message text, document previews and themes. See the [plugin API and example](docs/product/ui-plugins.md). No Session, Provider or tool ports are exposed.

## Document composition and preview

The built-in [deepcode-documents Skill](skills/deepcode-documents/SKILL.md) is read on demand when a user requests polished layouts or document exports. It includes design guidance inspired by Kami, a reusable HTML template and format instructions. Ordinary replies do not automatically create files. For example: “Format this analysis as a concise report and save HTML, PDF and Markdown versions in the workspace.”

`document.render` uses existing workspace write permissions and Plan scope, publishing a Session artifact only after the file is written. HTML and Markdown need no additional generation runtime. PDF uses WeasyPrint with self-contained HTML. Set the Python interpreter in **Settings → Plugins → Document composition** after installing [WeasyPrint's platform prerequisites](https://doc.courtbouillon.org/weasyprint/stable/first_steps.html) and the [Python requirements](skills/deepcode-documents/scripts/requirements.txt). The development container includes this environment. Native installations need the corresponding runtime; configuration errors remain visible and do not overwrite an existing document.

GUI and Editor artifacts and workspace links open a shared preview: static HTML with source view, local PDF.js with page navigation, zoom, text selection and download, and the existing Markdown renderer. PDF reading needs no Python or online viewer. Generated HTML embeds its images, SVG and styles; PDF generation does not run JavaScript. Ordinary text retains its paged reader.

## Execution, settings and extensions

Native Windows defaults to automatic shell selection: PowerShell 7 is preferred, with Windows PowerShell 5.1 used when PowerShell 7 is absent. Git Bash is optional; WSL is an explicit project execution environment. The selected shell, platform and detected development commands form stable Session context, refreshed at an environment boundary rather than every model turn. Shell selection and workspace sandbox availability are separate capabilities.

Settings groups configuration into Appearance, Agent behavior, Execution environment, Tool permissions, Models & services, and Plugins. Plugins can load text Skills from a directory or a `SKILL.md` file. Bundled English Markdown product documentation is available through `doc.read`; workflow Skills use `skill.read`. MCP and executable extensions remain part of the shared plugin architecture.

Desktop attachments retain one **Files and folders** entry backed by the operating system's native picker. Skill sources and workspace opening also use one selection window. Windows includes a Select action for the highlighted file or directory. Cancellation leaves existing references unchanged.

Todos describe stable development phases. Adding authorized file/directory scope uses a separate confirmation that preserves steps, verification and progress; a complete Plan revision remains available when the plan itself needs to change. Tool activities display real start and stdout/stderr progress, with final outcomes owned by Kernel records. Reading earlier messages keeps the viewport in place while the conversation runs.

An application-started Host exits after its last client disconnects and active tasks finish. An explicitly started service remains running; use `deepcode-cli start-host` and `deepcode-cli stop-host` to manage it. The local Provider stream has no body idle timeout or total-duration cap; cancellation remains available and interrupted requests are not automatically replayed.

See [Execution environments](docs/product/execution-environments.md) for platform setup and [Product operations](docs/product/operations.md) for tools, Host lifecycle, settings and extensions.

## Configure a model

Before the first task:

1. Open **Settings → Models & services**.
2. Use the initial DeepSeek Flash template, or add an OpenAI-compatible, Responses, Anthropic, or Ollama profile.
3. Enter the API key required by the provider and adjust the base URL and model if needed.
4. Enable the profile and use **Save model** in that model's card. Each saved model has its own save and probe actions.
5. Select a model in the conversation. The shared configuration remembers that selection as the default for new conversations; Settings can also change the default directly.

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
8. The model selector remains available during the conversation and changes subsequent Provider turns. New conversations start with the last selected model.
9. Messages, Plan state, activities, artifacts, context usage, and run status all come from the shared projection.
10. A committed Assistant answer can be copied, rated up or down, or have its rating cleared. The action bar appears on message hover or keyboard focus and hides after the pointer leaves. Ratings are durable local Session facts, recover after restart, are not stored by the GUI, and are not sent to the Provider.
11. Click the context ball in the composer to inspect the current Provider request partitions. Per-partition item counts and estimates come from Session; cache hit and miss counts come from Provider usage. Missing facts display `N/A`, and GUI/TUI do not attribute or recompute them. Settings shows Session-aggregated per-round token consumption newest first, 10 rows per page.
12. For complex work, the LLM publishes a complete Plan through `plan.publish`; confirmation atomically seeds the Todo list from Plan steps, and later `plan.progress` calls may update only those generated item states. The right task panel consumes only that shared projection; it does not reinterpret tool calls or GUI state as tasks. Tool calls remain interleaved with narrative in the main Session timeline.

Drag a project to change project order, or drag a conversation within its current group to change conversation order. The order is saved in user settings and survives reopening. Sorting does not move conversations between projects or change Session facts.

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
./DeepCode-TUI.command --session <session-id>
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

Open **Settings → Models & services**, add the required API key and save the model in its own card, then select an enabled model. If the profile file cannot be read, the settings page shows the original error and an explicit repair action. Model requests remain unavailable until valid configuration is saved; existing conversation history remains readable when its Session store is valid.

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

Run `required` and `full` inside `make shell`. They prepare the current TypeScript dependencies before running checks; host execution is rejected. `static` can run on the host and checks shell syntax, Git whitespace changes and the existing layer-dependency rules. `required` runs Rust workspace tests, TypeScript checks and the registered Session/GUI contract tests. `full` additionally builds CLI/TUI and GUI web resources and runs the existing local Provider fixture, tool execution and session lifecycle checks. It does not certify live Provider behavior, native GUI interaction or release packages.

The native GUI tests belong to a separate Cargo workspace. Their explicit entrypoint in a supported native build environment is `cargo test --manifest-path shells/deepcode-gui/src-tauri/Cargo.toml`; they are not part of the default `required` or `full` profiles.

## Notices and license

See [NOTICE.md](NOTICE.md), [ATTRIBUTION.md](ATTRIBUTION.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [CITATION.cff](CITATION.cff).

DeepCode is licensed under the [MIT License](LICENSE).
