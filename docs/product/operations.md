# Product operations

## Tools and validation

`fs.read`, `fs.write`, `fs.edit`, `fs.delete` and the selected shell tool operate on bound workspaces. Shell `workspaceMode` and `executionScope` describe the actual mutation and execution scope. Host/external permission and workspace Plan authorization are checked separately. Commands in a confirmed Plan are execution examples; whitespace, log paths and equivalent commands within the same scope do not require reconfirmation. New targets, deletions and broader write scope remain subject to the permission layer.

The project README, build scripts and user instructions determine the validation environment. If the user requires a container, run the declared scripts in that container; the presence of a host compiler does not authorize a host build. Interactive input belongs to its individual tool invocation. One invocation does not permanently change the shell or working directory of later calls.

Tool results retain success, failure and denial facts. Read a denial and the current Plan scope before correcting arguments or scope; do not repeat an unchanged rejected call. `plan.progress` references current-run ToolRecord IDs and current Todo IDs. Failed records cannot prove completion. Reports distinguish executed, passed, not executed and unsupported-environment results.

Todo entries describe stable phases. When creating a module, a Plan can propose that module's explicit directory scope, including new files, for user approval. Adding scope to an existing Plan preserves phases, verification and progress and requires confirmation of the added scope. The review shows the additions and reason first, with the complete effective Plan available in a disclosure.

Tools report their actual start and available stdout/stderr while running. Live output is a bounded view; the Kernel keeps the full captured output archive, while the Session journal stores lifecycle facts. A silent command or output redirected to a file does not generate console output. Final results replace the live view and remain the authority for success or failure.

## Host lifetime

GUI, Editor, CLI and TUI share the same Host and Session. A Host automatically started by an application stops after its last client disconnects and no tasks are running. Running tasks continue in the background, then the Host stops when they finish. A task waiting for a user decision keeps its state in the Session journal and permits the idle Host to stop. Opening that Session again restores the waiting task so the user can respond or cancel it.

Use `deepcode-cli start-host` to start a persistent service, or keep the currently shared Host running after clients exit. Use `deepcode-cli stop-host` to explicitly stop that service. Closing one client does not stop another client's work. The Host owns service shutdown and each tool invocation owns its child processes.

## Models and context

The model picker shows user-defined profile names and the reasoning levels supported by that profile. Reasoning status and elapsed time describe the current request. A long request alone does not establish that the Agent Loop is stuck; inspect Provider completion, tool duration and the last error.

The local Provider stream has no body idle timeout or total duration limit. Users can cancel an unresponsive request. A transport interruption preserves its error cause and does not automatically retry the request or fabricate a completed response; provider-side timeouts and network failures can still end a stream.

Input cache hit rate is cached input tokens divided by total input tokens. The context indicator refers to the last settled request, while the top session indicator aggregates the entire session. Settings provide token details. Different ratios across these scopes are not by themselves a calculation error.

The tool catalog and system instructions remain stable during a run. Tool results, product Skill text and new messages append to history. Do not rewrite historical facts, reduce reasoning effort, hide errors or fabricate usage to claim improved cache efficiency.

## Settings and extensions

Settings are grouped into Appearance, Agent behavior, Execution environment, Tool permissions, Models & services, and Plugins. Plugins currently lists built-in text Skills and configured Skill sources. A text Skill supplies instructions; it is not an executable binary. MCP and other executable extensions belong to the plugin system, with their own activation and execution facts. Saving a source is not evidence that a plugin has executed.

Desktop selection uses the operating system's dialog. Attachments keep one "Files and folders" entry: choose either type in the same window and add it to the existing reference list. Skill sources and workspaces also use a single selection window; creating a project requires a directory. Windows provides a "Select" action inside its native dialog to confirm the highlighted file or folder, while the standard Open action can navigate into folders. Cancelling leaves the selection unchanged. Browser sessions use the existing Host directory browser because a browser file upload does not provide a usable absolute Host path.

In Plugins, choose a Skill folder or an individual SKILL.md file, review the displayed path and save the changes. Sources can be enabled, changed or removed. Manual path entry is a secondary option. Native paths, including Windows drive paths and UNC shares, pass to the existing Skill loader without POSIX conversion. The available Skill list is read through the Host UI proxy.
