# Execution environments

## Native Windows

Settings > Execution environment contains the global Windows Shell preference. Automatic selection prefers PowerShell 7 (`pwsh.exe`), then built-in Windows PowerShell 5.1 when PowerShell 7 is absent. Explicit PowerShell 7, Windows PowerShell and Git Bash choices do not switch to another shell on failure. Git Bash can use a custom executable path. The WSL launcher `System32/bash.exe` is not a Git Bash candidate.

PowerShell user scripts are passed as temporary UTF-8 BOM `.ps1` files, with no profile and UTF-8 output. The temporary file is removed after execution. The script-file transport avoids the Windows command-line length limit and preserves Unicode, quotes and multiline text. Process-scoped execution policy allows this generated script; machine policy is not changed. Native executable exit codes should be reported explicitly using `$LASTEXITCODE`.

## Explicit WSL projects

Open the project menu > Manage workspace > Runtime shell. Choose WSL, name the distribution and specify the Linux `deepcode-kernel-daemon` executable installed inside it (an absolute path or a command on that distribution's PATH). Use a Linux package built from the current implementation; a Windows `.exe` cannot be used as the Linux worker.

Workspace filesystem tools and Bash execute in a single-invocation Linux Kernel worker through `wsl.exe --distribution ... --exec ... --kernel-tool-worker`. The worker does not create a Session, start a Provider, open a service port or write a second journal. The Windows Host and shared Session continue to own conversation identity, Plan admission, tool records and progress. Native Windows paths are translated using `wslpath`; a WSL UNC project must belong to the selected distribution. Output archives remain in the Session-owned storage directory.

The distribution, Kernel executable and project files must already be available. An unavailable worker or invalid project path is reported as an error; DeepCode does not install a distribution, move files or switch to native execution automatically.

## Stable context

Each new run captures the selected operating system, architecture, locale, shell and command search path. A running or restored run keeps its prepared facts. On macOS, the Host reads PATH from the user's login shell at initialization or explicit environment refresh; tool invocations do not reload profiles. Discovery and execution use that same prepared PATH. Windows and WSL use the selected execution endpoint's environment.

Execution target, project build requirements and sandbox permissions are separate. Read project files to identify the build/test environment; a native shell may invoke Docker for a Linux build. `commandPaths` records commands found on `executionPath`, not an inventory of installed software. A missing command, sandbox denial or unreachable socket cannot establish that the host lacks a tool or a service is stopped. The Kernel selects Shell permissions from the approved Plan, user settings and call approval, not model input. Host permission changes access, not the selected target, shell or prepared PATH. Required approval happens before execution; the Kernel does not retry failed commands automatically. Service readiness is checked on demand in the intended scope.

## Workspace Shell

Shell selection and workspace isolation are separate capabilities. macOS uses sandbox-exec. Linux and WSL2 use Bubblewrap; the Linux package includes its helper. A system installation needs the `bubblewrap` package and permission to create user, mount, PID and network namespaces. WSL1 does not provide these namespaces. Container policies may restrict them even when Bubblewrap is installed.

Native Windows uses a dedicated local execution account, per-invocation write-restricted tokens and ACL grants. Open Settings > Execution environment > Workspace Shell and choose Initialize Windows support. Windows requests administrator confirmation to create the account and its offline network policy. Daily tool execution does not run as administrator. The account credential is stored using Windows DPAPI and an owner-restricted file ACL, not in model context or product logs. The Kernel operator command `deepcode-kernel.exe --workspace-sandbox-init` performs the same initialization. `--workspace-sandbox-status` reports observed backend availability.

The existing policy permits reading installed developer tools. Read mode permits temporary storage writes. Every Shell invocation, including Host and PTY calls, receives a Kernel-owned TMPDIR/TMP/TEMP directory. The Kernel removes it after process and output cleanup; paths in it cannot be reused by a later call. On macOS, standard system temporary directories and the OS user temporary directory are also writable because Bash heredocs and system tools can use them independently of TMPDIR. These shared directories are not the invocation-owned directory; the Kernel does not claim ownership of arbitrary files created there. Persist files needed by later calls in an authorized workspace path. Workspace write mode enforces declared paths when authorized by a Plan. A separate call approval, or advance permission with no confirmed Plan, can grant workspace writes; the workspace boundary still applies. Workspace Shell runs offline. Shell scripts, compilers and interpreters share this policy, including PTY execution and child processes.

Use directory grants for build/generator output. An authorized output directory can be created during setup. A file-only Shell grant requires an existing file and does not implicitly authorize temporary sibling files or atomic replacement through its parent. Use filesystem tools for precise file creation/editing, or request the required directory scope. Scope changes still require the existing user decision; phase Todos do not need to be rewritten for a scope extension.

Backend availability and its original diagnostic are captured in the stable environment context. Initialization or Refresh environment takes effect at the next run boundary. `*_workspace_sandbox_unavailable` means the backend or initialization is unavailable; inspect the recorded reason. Installing PowerShell 7 alone does not supply a sandbox.

For writable workspaces, external permission `ask` or `allow` selects Host Shell; external permission `deny` and read-only attachment workspaces select workspace-sandbox execution. Workspace Shell authorized by a Plan enforces its declared writable paths. A separate approval can authorize an additional call within the workspace boundary; it applies only to that call and leaves the Plan unchanged. With an active Plan or workspace permission set to `plan`, each Host call requires its own explicit approval before execution, including commands needing Docker or network access. Plan writable paths, global external permission `allow` and existing run-level Host grants do not authorize the broader Host call. Approving it grants host-user permissions for that call only and leaves the Plan unchanged. With no confirmed Plan, workspace permission `allow` remains an explicit advance authorization for workspace changes. The command denylist is checked before approval or execution. There is no automatic retry with host scope. Filesystem tools retain their Kernel workspace and target checks. Windows Job Objects clean up the invocation's descendant processes; they are not a filesystem permission boundary.

## Product docs and Skills

`doc.read` returns bundled English Markdown describing the product. `skill.read` returns workflow guidance for a relevant task. Plugins settings lists text Skills and their sources; documentation is not listed as an executable plugin or a Skill.
