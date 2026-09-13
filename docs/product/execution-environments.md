# Execution environments

## Native Windows

Settings > Execution environment contains the global Windows Shell preference. Automatic selection prefers PowerShell 7 (`pwsh.exe`), then built-in Windows PowerShell 5.1 when PowerShell 7 is absent. Explicit PowerShell 7, Windows PowerShell and Git Bash choices do not switch to another shell on failure. Git Bash can use a custom executable path. The WSL launcher `System32/bash.exe` is not a Git Bash candidate.

PowerShell user scripts are passed as temporary UTF-8 BOM `.ps1` files, with no profile and UTF-8 output. The temporary file is removed after execution. The script-file transport avoids the Windows command-line length limit and preserves Unicode, quotes and multiline text. Process-scoped execution policy allows this generated script; machine policy is not changed. Native executable exit codes should be reported explicitly using `$LASTEXITCODE`.

## Explicit WSL projects

Select a project in Settings > Execution environment > Project execution environment. Choose WSL, name the distribution and specify the Linux `deepcode-kernel-daemon` executable installed inside it (an absolute path or a command on that distribution's PATH). Use a Linux package built from the current implementation; a Windows `.exe` cannot be used as the Linux worker.

Workspace filesystem tools and Bash execute in a single-invocation Linux Kernel worker through `wsl.exe --distribution ... --exec ... --kernel-tool-worker`. The worker does not create a Session, start a Provider, open a service port or write a second journal. The Windows Host and shared Session continue to own conversation identity, Plan admission, tool records and progress. Native Windows paths are translated using `wslpath`; a WSL UNC project must belong to the selected distribution. Output archives remain in the Session-owned storage directory.

The distribution, Kernel executable and project files must already be available. An unavailable worker or invalid project path is reported as an error; DeepCode does not install a distribution, move files or switch to native execution automatically.

## Stable context

The first prepared run captures the selected operating system, architecture, locale, shell dialect/path and detected developer commands. Subsequent runs reuse the Session's saved observation. Shell changes, project environment changes or Refresh environment create a new observation at the next run boundary. A running or restored run keeps its prepared environment. Changing another project's environment does not refresh this project's context.

The command list records executable discovery, not service readiness. A listed Docker command does not establish that Docker daemon is running. No credentials or unrelated environment variables are included.

## Workspace Shell

Shell selection and workspace isolation are separate capabilities. macOS uses sandbox-exec. Linux and WSL2 use Bubblewrap; the Linux package includes its helper. A system installation needs the `bubblewrap` package and permission to create user, mount, PID and network namespaces. WSL1 does not provide these namespaces. Container policies may restrict them even when Bubblewrap is installed.

Native Windows uses a dedicated local execution account, per-invocation write-restricted tokens and ACL grants. Open Settings > Execution environment > Workspace Shell and choose Initialize Windows support. Windows requests administrator confirmation to create the account and its offline network policy. Daily tool execution does not run as administrator. The account credential is stored using Windows DPAPI and an owner-restricted file ACL, not in model context or product logs. The Kernel operator command `deepcode-kernel.exe --workspace-sandbox-init` performs the same initialization. `--workspace-sandbox-status` reports observed backend availability.

The existing policy permits reading installed developer tools. Read mode writes only to invocation-owned temporary storage. Write mode additionally allows the confirmed Plan files/directories, or the workspace when the existing permission explicitly grants it. Workspace Shell runs offline. Shell scripts, compilers and interpreters share this policy, including PTY execution and child processes.

Use directory grants for build/generator output. An authorized output directory can be created during setup. A file-only Shell grant requires an existing file and does not implicitly authorize temporary sibling files or atomic replacement through its parent. Use filesystem tools for precise file creation/editing, or request the required directory scope. Scope changes still require the existing user decision; phase Todos do not need to be rewritten for a scope extension.

Backend availability and its original diagnostic are captured in the stable environment context. Initialization or Refresh environment takes effect at the next run boundary. `*_workspace_sandbox_unavailable` means the backend or initialization is unavailable; inspect the recorded reason. Installing PowerShell 7 alone does not supply a sandbox.

Host-scoped shell commands use the existing explicit external permission and Plan checks. There is no automatic retry with host scope. Filesystem tools retain their own Kernel workspace and Plan target checks. Windows Job Objects clean up the invocation's descendant processes; they are not a filesystem permission boundary.

## Product docs and Skills

`doc.read` returns bundled English Markdown describing the product. `skill.read` returns workflow guidance for a relevant task. Plugins settings lists text Skills and their sources; documentation is not listed as an executable plugin or a Skill.
