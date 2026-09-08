use super::*;
use deepcode_kernel_tools::kernel_internal::{
    process_shell_hard_deny_reason, MAX_TERMINAL_STDIN_BYTES,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(target_os = "macos")]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
#[cfg(target_os = "macos")]
use std::time::{SystemTime, UNIX_EPOCH};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(unix)]
const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(100);
const BASH_OUTPUT_LIMIT_BYTES: usize = 50 * 1024;
const BASH_OUTPUT_LIMIT_LINES: usize = 2000;
const BASH_TERMINAL_COLS: u16 = 120;
const BASH_TERMINAL_ROWS: u16 = 30;
const AGENT_SHELL_PATH_SOURCE: &str = "hostPlusStandardDeveloperPaths";
const AGENT_SHELL_READ_MODE_WRITE_SCOPE: &str = "kernelTemporaryOnly";
const AGENT_SHELL_WRITE_MODE_WRITE_SCOPE: &str = "workspaceAndKernelTemporary";
const AGENT_SHELL_HOST_WRITE_SCOPE: &str = "hostUser";
#[cfg(target_os = "macos")]
static NEXT_PROCESS_SCOPE_ID: AtomicU64 = AtomicU64::new(1);
const AGENT_SHELL_ENV_ALLOWLIST: &[&str] = &[
    "AR",
    "CARGO_HOME",
    "CARGO_TARGET_DIR",
    "CC",
    "CPATH",
    "CPLUS_INCLUDE_PATH",
    "CXX",
    "DEVELOPER_DIR",
    "GOPATH",
    "GOROOT",
    "HOME",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LIBRARY_PATH",
    "LOGNAME",
    "MACOSX_DEPLOYMENT_TARGET",
    "NPM_CONFIG_CACHE",
    "NVM_DIR",
    "PATH",
    "PKG_CONFIG_PATH",
    "PNPM_HOME",
    "PYENV_ROOT",
    "RUSTC_WRAPPER",
    "RUSTFLAGS",
    "RUSTUP_HOME",
    "SDKROOT",
    "SHELL",
    "USER",
    "VIRTUAL_ENV",
    "VOLTA_HOME",
];

pub(super) struct ProcessShellExecutor;

impl KernelToolExecutor for ProcessShellExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let command_text = required_string(&invocation.input, "command")?;
        if let Some(reason) = process_shell_hard_deny_reason(&command_text) {
            return Err(KernelError::Structured {
                code: "bash_hard_denied",
                stage: "execution",
                message: format!("bash command {reason}"),
                details: serde_json::json!({ "toolId": "bash" }),
            });
        }
        let workspace_mode = required_string(&invocation.input, "workspaceMode")?;
        if !matches!(workspace_mode.as_str(), "read" | "write") {
            return Err(KernelError::InvalidCommand(
                "bash workspaceMode must be read or write".to_string(),
            ));
        }
        let execution_scope = required_string(&invocation.input, "executionScope")?;
        if !matches!(execution_scope.as_str(), "workspace" | "host") {
            return Err(KernelError::InvalidCommand(
                "bash executionScope must be workspace or host".to_string(),
            ));
        }
        let terminal_stdin = terminal_stdin(&invocation.input)?;
        let write_scope = shell_write_scope(&execution_scope, &workspace_mode);
        let workspace_id = workspace_id(&context)?.to_string();
        let workspace_root = canonical_process_workspace_root(&context)?;
        let cwd = prepared_process_cwd(&context, &workspace_root)?;
        let timeout_seconds = invocation
            .input
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(120)
            .clamp(1, 600);
        let bash_program = resolved_bash_program()?;

        if let Some(terminal_stdin) = terminal_stdin {
            return invoke_terminal_shell(
                invocation.id,
                command_text,
                workspace_mode,
                execution_scope,
                terminal_stdin,
                timeout_seconds,
                workspace_id,
                workspace_root,
                cwd,
                bash_program,
                context,
            );
        }

        #[cfg(target_os = "macos")]
        let process_scope_id = (execution_scope == "workspace").then(new_process_scope_id);
        #[cfg(target_os = "macos")]
        let mut process_temp = process_scope_id
            .as_deref()
            .map(AgentShellTempDir::create)
            .transpose()?;
        let mut process = platform_shell_command(
            &command_text,
            &bash_program,
            &workspace_root,
            &workspace_mode,
            &execution_scope,
            #[cfg(target_os = "macos")]
            process_temp.as_ref().map(AgentShellTempDir::path),
            #[cfg(target_os = "macos")]
            process_scope_id.as_deref(),
        )?;
        apply_agent_shell_environment(&mut process, &bash_program, &execution_scope, false);
        process
            .current_dir(&cwd)
            .env("DEEPCODE_AGENT_SHELL", "1")
            .env("DEEPCODE_WORKSPACE_ROOT", &workspace_root);
        #[cfg(target_os = "macos")]
        if let Some(process_temp) = process_temp.as_ref() {
            process
                .env("TMPDIR", process_temp.path())
                .env("TMP", process_temp.path())
                .env("TEMP", process_temp.path());
        }
        process
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let started = Instant::now();
        let archive = ShellOutputArchive::create(&context)?;
        let stdout_file = archive.open("stdout")?;
        let stderr_file = archive.open("stderr")?;
        let mut child = process.spawn().map_err(|error| {
            KernelError::Other(format!("spawn bash in {}: {error}", cwd.display()))
        })?;
        #[cfg(unix)]
        let child_id = child.id();
        #[cfg(target_os = "macos")]
        let mut process_scope_guard = process_scope_id
            .map(|process_scope_id| ProcessScopeGuard::new(child_id, process_scope_id));
        let Some(stdout) = child.stdout.take() else {
            let _ = terminate_child(&mut child);
            return Err(KernelError::Other(
                "bash stdout pipe is unavailable".to_string(),
            ));
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = terminate_child(&mut child);
            return Err(KernelError::Other(
                "bash stderr pipe is unavailable".to_string(),
            ));
        };
        if let Err(error) = set_pipe_nonblocking(&stdout, "stdout")
            .and_then(|_| set_pipe_nonblocking(&stderr, "stderr"))
        {
            let _ = terminate_child(&mut child);
            return Err(error);
        }
        let stop_capture = Arc::new(AtomicBool::new(false));
        let stdout_reader = spawn_output_reader(
            stdout,
            stdout_file,
            BASH_OUTPUT_LIMIT_BYTES,
            Arc::clone(&stop_capture),
        );
        let stderr_reader = spawn_output_reader(
            stderr,
            stderr_file,
            BASH_OUTPUT_LIMIT_BYTES,
            Arc::clone(&stop_capture),
        );

        let wait_result = wait_for_bounded_child(
            &mut child,
            Duration::from_secs(timeout_seconds),
            &context.cancellation,
        );
        if wait_result.is_err() {
            let _ = terminate_child(&mut child);
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        terminate_remaining_process_group(child_id);
        #[cfg(target_os = "macos")]
        let process_scope_cleanup = match process_scope_guard.as_mut() {
            Some(guard) => guard.terminate(),
            None => {
                terminate_remaining_process_group(child_id);
                Ok(())
            }
        };
        stop_capture.store(true, AtomicOrdering::Release);

        let stdout_result = join_output_reader(stdout_reader, "stdout");
        let stderr_result = join_output_reader(stderr_reader, "stderr");
        #[cfg(target_os = "macos")]
        let process_temp_cleanup = match process_temp.as_mut() {
            Some(process_temp) => process_temp.cleanup(),
            None => Ok(()),
        };

        let (status, timed_out, cancelled) = wait_result?;
        let mut stdout = stdout_result?;
        let mut stderr = stderr_result?;
        bound_combined_output(&mut stdout, &mut stderr, BASH_OUTPUT_LIMIT_BYTES);
        bound_output_lines(&mut stdout, &mut stderr);
        #[cfg(target_os = "macos")]
        process_scope_cleanup?;
        #[cfg(target_os = "macos")]
        process_temp_cleanup?;
        if cancelled {
            return Err(KernelError::Structured {
                code: "tool_execution_cancelled",
                stage: "execution",
                message: "bash was cancelled after its process scope was reclaimed".to_string(),
                details: serde_json::json!({
                    "toolId": "bash",
                    "workspaceMode": workspace_mode,
                    "executionScope": execution_scope,
                }),
            });
        }
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let captured_bytes = stdout.bytes.len().saturating_add(stderr.bytes.len());
        let truncated = stdout.truncated || stderr.truncated;
        let exit_code = status.code();
        let success = !timed_out && status.success();

        let mut output = serde_json::json!({
            "workspaceId": workspace_id,
            "command": command_text,
            "cwd": ".",
            "workspaceMode": workspace_mode,
            "executionScope": execution_scope,
            "terminal": false,
            "stdout": String::from_utf8_lossy(&stdout.bytes),
            "stderr": String::from_utf8_lossy(&stderr.bytes),
            "exitCode": exit_code,
            "success": success,
            "timedOut": timed_out,
            "truncated": truncated,
            "capturedBytes": captured_bytes,
            "durationMs": duration_ms,
            "environment": {
                "shell": bash_program.to_string_lossy(),
                "interactive": false,
                "executionScope": execution_scope,
                "terminal": false,
                "pathSource": AGENT_SHELL_PATH_SOURCE,
                "writeScope": write_scope,
                "homeWritable": execution_scope == "host",
                "networkAccess": execution_scope == "host"
            }
        });
        archive.finish(&mut output, truncated)?;
        if success {
            Ok(ok(invocation.id, output))
        } else if timed_out {
            Ok(known_failure(
                invocation.id,
                output,
                "bash_timed_out",
                format!("Bash command exceeded the {timeout_seconds}-second timeout."),
            ))
        } else {
            Ok(known_failure(
                invocation.id,
                output,
                "bash_exit_nonzero",
                match exit_code {
                    Some(code) => format!("Bash command exited with status {code}."),
                    None => "Bash command terminated without an exit status.".to_string(),
                },
            ))
        }
    }
}

fn terminal_stdin(input: &Value) -> KernelResult<Option<String>> {
    let Some(terminal) = input.get("terminal") else {
        return Ok(None);
    };
    let object = terminal.as_object().ok_or_else(|| {
        KernelError::InvalidCommand("bash terminal must be an object".to_string())
    })?;
    if object.len() != 1 || !object.contains_key("stdin") {
        return Err(KernelError::InvalidCommand(
            "bash terminal must contain only stdin".to_string(),
        ));
    }
    let stdin = object.get("stdin").and_then(Value::as_str).ok_or_else(|| {
        KernelError::InvalidCommand("bash terminal.stdin must be a string".to_string())
    })?;
    if stdin.len() > MAX_TERMINAL_STDIN_BYTES {
        return Err(KernelError::InvalidCommand(format!(
            "bash terminal.stdin exceeds {MAX_TERMINAL_STDIN_BYTES} bytes"
        )));
    }
    Ok(Some(stdin.to_string()))
}

#[allow(clippy::too_many_arguments)]
fn invoke_terminal_shell(
    invocation_id: String,
    command_text: String,
    workspace_mode: String,
    execution_scope: String,
    terminal_stdin: String,
    timeout_seconds: u64,
    workspace_id: String,
    workspace_root: PathBuf,
    cwd: PathBuf,
    bash_program: PathBuf,
    context: KernelToolExecutionContext,
) -> KernelResult<KernelToolExecutionResult> {
    let write_scope = shell_write_scope(&execution_scope, &workspace_mode);
    #[cfg(target_os = "macos")]
    let process_scope_id = (execution_scope == "workspace").then(new_process_scope_id);
    #[cfg(target_os = "macos")]
    let mut process_temp = process_scope_id
        .as_deref()
        .map(AgentShellTempDir::create)
        .transpose()?;

    let pty = native_pty_system()
        .openpty(PtySize {
            rows: BASH_TERMINAL_ROWS,
            cols: BASH_TERMINAL_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| KernelError::Other(format!("open bash pty: {error}")))?;
    let mut command = platform_terminal_command(
        &command_text,
        &bash_program,
        &workspace_root,
        &workspace_mode,
        &execution_scope,
        #[cfg(target_os = "macos")]
        process_temp.as_ref().map(AgentShellTempDir::path),
        #[cfg(target_os = "macos")]
        process_scope_id.as_deref(),
    )?;
    apply_agent_terminal_environment(&mut command, &bash_program, &execution_scope);
    command.cwd(&cwd);
    command.env("DEEPCODE_AGENT_SHELL", "1");
    command.env("DEEPCODE_WORKSPACE_ROOT", &workspace_root);
    #[cfg(target_os = "macos")]
    if let Some(process_temp) = process_temp.as_ref() {
        command.env("TMPDIR", process_temp.path());
        command.env("TMP", process_temp.path());
        command.env("TEMP", process_temp.path());
    }

    let archive = ShellOutputArchive::create(&context)?;
    let stdout_file = archive.open("stdout")?;
    let spawned_child = pty.slave.spawn_command(command).map_err(|error| {
        KernelError::Other(format!("spawn bash pty in {}: {error}", cwd.display()))
    })?;
    #[cfg(unix)]
    let mut spawned_child = spawned_child;
    #[cfg(unix)]
    let Some(process_id) = spawned_child.process_id() else {
        let _ = spawned_child.kill();
        let _ = spawned_child.wait();
        return Err(KernelError::Other(
            "bash pty child process identity is unavailable".to_string(),
        ));
    };
    #[cfg(unix)]
    let mut child = PtyChildGuard::new(spawned_child, process_id);
    #[cfg(not(unix))]
    let mut child = PtyChildGuard::new(spawned_child);
    #[cfg(target_os = "macos")]
    let mut process_scope_guard = process_scope_id
        .map(|process_scope_id| ProcessScopeGuard::new(process_id, process_scope_id));
    drop(pty.slave);

    #[cfg(unix)]
    if let Some(fd) = pty.master.as_raw_fd() {
        set_raw_fd_nonblocking(fd, "pty")?;
    }
    let reader = pty
        .master
        .try_clone_reader()
        .map_err(|error| KernelError::Other(format!("clone bash pty reader: {error}")))?;
    let mut writer = pty
        .master
        .take_writer()
        .map_err(|error| KernelError::Other(format!("open bash pty writer: {error}")))?;
    let stop_capture = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_pty_output_reader(
        reader,
        stdout_file,
        BASH_OUTPUT_LIMIT_BYTES,
        Arc::clone(&stop_capture),
    );
    let write_result = writer
        .write_all(terminal_stdin.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| KernelError::Other(format!("write bash pty stdin: {error}")));
    drop(writer);
    if let Err(error) = write_result {
        let _ = child.terminate_and_wait();
        #[cfg(target_os = "macos")]
        if let Some(guard) = process_scope_guard.as_mut() {
            let _ = guard.terminate();
        }
        stop_capture.store(true, AtomicOrdering::Release);
        drop(pty.master);
        let _ = join_output_reader(stdout_reader, "pty");
        #[cfg(target_os = "macos")]
        if let Some(process_temp) = process_temp.as_mut() {
            let _ = process_temp.cleanup();
        }
        return Err(error);
    }

    let started = Instant::now();
    let wait_result = wait_for_bounded_pty_child(
        &mut child,
        Duration::from_secs(timeout_seconds),
        &context.cancellation,
    );
    if wait_result.is_ok() {
        child.reclaim_remaining_process_group();
    } else {
        let _ = child.terminate_and_wait();
    }
    #[cfg(target_os = "macos")]
    let process_scope_cleanup = match process_scope_guard.as_mut() {
        Some(guard) => guard.terminate(),
        None => Ok(()),
    };
    stop_capture.store(true, AtomicOrdering::Release);
    drop(pty.master);
    let stdout_result = join_output_reader(stdout_reader, "pty");
    #[cfg(target_os = "macos")]
    let process_temp_cleanup = match process_temp.as_mut() {
        Some(process_temp) => process_temp.cleanup(),
        None => Ok(()),
    };

    let (status, timed_out, cancelled) = wait_result?;
    let mut stdout = stdout_result?;
    stdout.truncated |= retain_tail_lines(&mut stdout.bytes, BASH_OUTPUT_LIMIT_LINES);
    trim_utf8_prefix(&mut stdout.bytes);
    #[cfg(target_os = "macos")]
    process_scope_cleanup?;
    #[cfg(target_os = "macos")]
    process_temp_cleanup?;
    if cancelled {
        return Err(KernelError::Structured {
            code: "tool_execution_cancelled",
            stage: "execution",
            message: "bash was cancelled after its PTY process scope was reclaimed".to_string(),
            details: serde_json::json!({
                "toolId": "bash",
                "workspaceMode": workspace_mode,
                "executionScope": execution_scope,
                "terminal": true,
            }),
        });
    }

    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let exit_code = i32::try_from(status.exit_code()).ok();
    let success = !timed_out && status.success();
    let mut output = serde_json::json!({
        "workspaceId": workspace_id,
        "command": command_text,
        "cwd": ".",
        "workspaceMode": workspace_mode,
        "executionScope": execution_scope,
        "terminal": true,
        "stdout": String::from_utf8_lossy(&stdout.bytes),
        "stderr": "",
        "exitCode": exit_code,
        "success": success,
        "timedOut": timed_out,
        "truncated": stdout.truncated,
        "capturedBytes": stdout.bytes.len(),
        "durationMs": duration_ms,
        "environment": {
            "shell": bash_program.to_string_lossy(),
            "interactive": true,
            "executionScope": execution_scope,
            "terminal": true,
            "pathSource": AGENT_SHELL_PATH_SOURCE,
            "writeScope": write_scope,
            "homeWritable": execution_scope == "host",
            "networkAccess": execution_scope == "host"
        }
    });
    archive.finish(&mut output, stdout.truncated)?;
    if success {
        Ok(ok(invocation_id, output))
    } else if timed_out {
        Ok(known_failure(
            invocation_id,
            output,
            "bash_timed_out",
            format!("Bash command exceeded the {timeout_seconds}-second timeout."),
        ))
    } else {
        Ok(known_failure(
            invocation_id,
            output,
            "bash_exit_nonzero",
            match exit_code {
                Some(code) => format!("Bash command exited with status {code}."),
                None => "Bash command terminated without an exit status.".to_string(),
            },
        ))
    }
}

fn apply_agent_shell_environment(
    command: &mut Command,
    bash_program: &Path,
    execution_scope: &str,
    terminal: bool,
) {
    if execution_scope == "workspace" {
        command.env_clear();
        for key in AGENT_SHELL_ENV_ALLOWLIST {
            if *key == "PATH" {
                continue;
            }
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    command
        .env("PATH", resolved_agent_shell_path())
        .env("TERM", if terminal { "xterm-256color" } else { "dumb" })
        .env("SHELL", bash_program)
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
}

fn apply_agent_terminal_environment(
    command: &mut CommandBuilder,
    bash_program: &Path,
    execution_scope: &str,
) {
    if execution_scope == "workspace" {
        command.env_clear();
        for key in AGENT_SHELL_ENV_ALLOWLIST {
            if *key == "PATH" {
                continue;
            }
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    command.env("PATH", resolved_agent_shell_path());
    command.env("TERM", "xterm-256color");
    command.env("SHELL", bash_program);
    command.env("NO_COLOR", "1");
    command.env("CLICOLOR", "0");
}

fn shell_write_scope(execution_scope: &str, workspace_mode: &str) -> &'static str {
    if execution_scope == "host" {
        AGENT_SHELL_HOST_WRITE_SCOPE
    } else if workspace_mode == "write" {
        AGENT_SHELL_WRITE_MODE_WRITE_SCOPE
    } else {
        AGENT_SHELL_READ_MODE_WRITE_SCOPE
    }
}

struct PtyChildGuard {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    #[cfg(unix)]
    process_id: u32,
    active: bool,
}

impl PtyChildGuard {
    #[cfg(unix)]
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>, process_id: u32) -> Self {
        Self {
            child,
            process_id,
            active: true,
        }
    }

    #[cfg(not(unix))]
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self {
            child,
            active: true,
        }
    }

    fn reclaim_remaining_process_group(&mut self) {
        if !self.active {
            return;
        }
        #[cfg(unix)]
        terminate_remaining_process_group(self.process_id);
        self.active = false;
    }

    fn terminate_and_wait(&mut self) -> KernelResult<portable_pty::ExitStatus> {
        #[cfg(unix)]
        {
            signal_process_group(self.process_id, UNIX_SIGTERM);
            let deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
            loop {
                if let Some(status) = self.child.try_wait().map_err(|error| {
                    KernelError::Other(format!("poll bash pty termination: {error}"))
                })? {
                    terminate_remaining_process_group(self.process_id);
                    self.active = false;
                    return Ok(status);
                }
                if Instant::now() >= deadline {
                    break;
                }
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            signal_process_group(self.process_id, UNIX_SIGKILL);
        }
        let _ = self.child.kill();
        let status = self
            .child
            .wait()
            .map_err(|error| KernelError::Other(format!("reap bash pty child: {error}")))?;
        #[cfg(unix)]
        terminate_remaining_process_group(self.process_id);
        self.active = false;
        Ok(status)
    }
}

impl Drop for PtyChildGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = self.terminate_and_wait();
        }
    }
}

fn resolved_agent_shell_path() -> OsString {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let host_path = std::env::var_os("PATH");
    let mut configured_tool_paths = Vec::new();
    for key in ["PNPM_HOME"] {
        if let Some(path) = std::env::var_os(key) {
            configured_tool_paths.push(PathBuf::from(path));
        }
    }
    for key in ["CARGO_HOME", "GOPATH", "JAVA_HOME", "VOLTA_HOME"] {
        if let Some(path) = std::env::var_os(key) {
            configured_tool_paths.push(PathBuf::from(path).join("bin"));
        }
    }
    if let Some(path) = std::env::var_os("PYENV_ROOT") {
        let root = PathBuf::from(path);
        configured_tool_paths.push(root.join("shims"));
        configured_tool_paths.push(root.join("bin"));
    }
    compose_agent_shell_path(
        home.as_deref(),
        host_path.as_deref(),
        &configured_tool_paths,
    )
}

fn compose_agent_shell_path(
    home: Option<&Path>,
    host_path: Option<&OsStr>,
    configured_tool_paths: &[PathBuf],
) -> OsString {
    let mut paths = Vec::new();
    if let Some(home) = home {
        for relative in ["bin", ".local/bin", ".cargo/bin"] {
            push_existing_unique_path(&mut paths, home.join(relative));
        }
    }
    for path in configured_tool_paths {
        push_existing_unique_path(&mut paths, path.clone());
    }
    for path in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
    ] {
        push_existing_unique_path(&mut paths, PathBuf::from(path));
    }
    if let Some(host_path) = host_path {
        for path in std::env::split_paths(host_path) {
            push_unique_path(&mut paths, path);
        }
    }
    for path in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        push_existing_unique_path(&mut paths, PathBuf::from(path));
    }
    std::env::join_paths(paths).unwrap_or_else(|_| {
        host_path
            .map(OsStr::to_os_string)
            .unwrap_or_else(|| OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"))
    })
}

fn push_existing_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        push_unique_path(paths, path);
    }
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

fn resolved_bash_program() -> KernelResult<PathBuf> {
    let system_bash = PathBuf::from("/bin/bash");
    if system_bash.is_file() {
        return Ok(system_bash);
    }
    if let Some(host_path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&host_path) {
            let candidate = directory.join("bash");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(KernelError::Structured {
        code: "bash_unavailable",
        stage: "execution",
        message: "No Bash executable is available for the bound workspace.".to_string(),
        details: serde_json::json!({ "toolId": "bash" }),
    })
}

#[cfg(target_os = "macos")]
fn new_process_scope_id() -> String {
    let sequence = NEXT_PROCESS_SCOPE_ID.fetch_add(1, AtomicOrdering::Relaxed);
    let unix_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "com.deepcode.process-scope.{}.{unix_nanos}.{sequence}",
        std::process::id()
    )
}

#[cfg(target_os = "macos")]
struct AgentShellTempDir {
    path: PathBuf,
    active: bool,
}

#[cfg(target_os = "macos")]
impl AgentShellTempDir {
    fn create(process_scope_id: &str) -> KernelResult<Self> {
        let path = std::env::temp_dir().join(format!("deepcode-agent-shell-{process_scope_id}"));
        fs::create_dir(&path).map_err(|error| {
            KernelError::Other(format!(
                "create bash temporary directory {}: {error}",
                path.display()
            ))
        })?;
        if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(0o700)) {
            let _ = fs::remove_dir_all(&path);
            return Err(KernelError::Other(format!(
                "secure bash temporary directory {}: {error}",
                path.display()
            )));
        }
        let canonical = match path.canonicalize() {
            Ok(canonical) => canonical,
            Err(error) => {
                let _ = fs::remove_dir_all(&path);
                return Err(KernelError::Other(format!(
                    "canonicalize bash temporary directory {}: {error}",
                    path.display()
                )));
            }
        };
        Ok(Self {
            path: canonical,
            active: true,
        })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn cleanup(&mut self) -> KernelResult<()> {
        if !self.active {
            return Ok(());
        }
        fs::remove_dir_all(&self.path).map_err(|error| {
            KernelError::Other(format!(
                "remove bash temporary directory {}: {error}",
                self.path.display()
            ))
        })?;
        self.active = false;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
impl Drop for AgentShellTempDir {
    fn drop(&mut self) {
        if self.active {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn prepared_process_cwd(
    context: &KernelToolExecutionContext,
    root: &Path,
) -> KernelResult<PathBuf> {
    if context.private_resolved_targets.len() != 1 {
        return Err(KernelError::InvalidCommand(
            "bash requires exactly one PreparedEffect workspace root".to_string(),
        ));
    }
    let prepared = PathBuf::from(&context.private_resolved_targets[0]);
    let canonical_cwd = prepared.canonicalize().map_err(|error| {
        KernelError::InvalidCommand(format!("bash workspace root is unavailable: {error}"))
    })?;
    if canonical_cwd != root {
        return Err(KernelError::PermissionDenied(
            "bash PreparedEffect target does not match the bound workspace root".to_string(),
        ));
    }
    if !canonical_cwd.is_dir() {
        return Err(KernelError::InvalidCommand(
            "bash workspace root is not a directory".to_string(),
        ));
    }
    Ok(canonical_cwd)
}

fn canonical_process_workspace_root(context: &KernelToolExecutionContext) -> KernelResult<PathBuf> {
    workspace_root(context)?.canonicalize().map_err(|error| {
        KernelError::WorkspaceRootUnreadable(format!(
            "canonicalize process workspace root: {error}"
        ))
    })
}

fn platform_shell_command(
    command_text: &str,
    bash_program: &Path,
    workspace_root: &Path,
    workspace_mode: &str,
    execution_scope: &str,
    #[cfg(target_os = "macos")] temporary_root: Option<&Path>,
    #[cfg(target_os = "macos")] process_scope_id: Option<&str>,
) -> KernelResult<Command> {
    if execution_scope == "host" {
        let mut command = Command::new(bash_program);
        command.arg("-c").arg(command_text);
        #[cfg(unix)]
        command.process_group(0);
        return Ok(command);
    }
    #[cfg(target_os = "macos")]
    {
        let temporary_root = temporary_root.ok_or_else(|| {
            KernelError::InvalidCommand("workspace bash temporary root is missing".to_string())
        })?;
        let process_scope_id = process_scope_id.ok_or_else(|| {
            KernelError::InvalidCommand("workspace bash scope identity is missing".to_string())
        })?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-p")
            .arg(macos_workspace_profile(
                workspace_root,
                temporary_root,
                process_scope_id,
                workspace_mode,
            )?)
            .arg(bash_program)
            .arg("-c")
            .arg(command_text);
        command.process_group(0);
        Ok(command)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            command_text,
            bash_program,
            workspace_root,
            workspace_mode,
            execution_scope,
        );
        Err(KernelError::Structured {
            code: "bash_workspace_sandbox_unavailable",
            stage: "execution",
            message: "bash requires a platform workspace sandbox".to_string(),
            details: serde_json::json!({ "toolId": "bash" }),
        })
    }
}

fn platform_terminal_command(
    command_text: &str,
    bash_program: &Path,
    workspace_root: &Path,
    workspace_mode: &str,
    execution_scope: &str,
    #[cfg(target_os = "macos")] temporary_root: Option<&Path>,
    #[cfg(target_os = "macos")] process_scope_id: Option<&str>,
) -> KernelResult<CommandBuilder> {
    if execution_scope == "host" {
        let mut command = CommandBuilder::new(bash_program);
        command.arg("-c");
        command.arg(command_text);
        return Ok(command);
    }
    #[cfg(target_os = "macos")]
    {
        let temporary_root = temporary_root.ok_or_else(|| {
            KernelError::InvalidCommand("workspace bash temporary root is missing".to_string())
        })?;
        let process_scope_id = process_scope_id.ok_or_else(|| {
            KernelError::InvalidCommand("workspace bash scope identity is missing".to_string())
        })?;
        let mut command = CommandBuilder::new("/usr/bin/sandbox-exec");
        command.arg("-p");
        command.arg(macos_workspace_profile(
            workspace_root,
            temporary_root,
            process_scope_id,
            workspace_mode,
        )?);
        command.arg(bash_program);
        command.arg("-c");
        command.arg(command_text);
        Ok(command)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            command_text,
            bash_program,
            workspace_root,
            workspace_mode,
            execution_scope,
        );
        Err(KernelError::Structured {
            code: "bash_workspace_sandbox_unavailable",
            stage: "execution",
            message: "bash requires a platform workspace sandbox".to_string(),
            details: serde_json::json!({ "toolId": "bash" }),
        })
    }
}

#[cfg(target_os = "macos")]
fn macos_workspace_profile(
    workspace_root: &Path,
    temporary_root: &Path,
    process_scope_id: &str,
    workspace_mode: &str,
) -> KernelResult<String> {
    let escaped_workspace = macos_sandbox_path(workspace_root, "workspace")?;
    let escaped_temporary = macos_sandbox_path(temporary_root, "temporary directory")?;
    if process_scope_id.is_empty()
        || !process_scope_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err(KernelError::InvalidCommand(
            "bash scope identity is invalid".to_string(),
        ));
    }
    let workspace_write_rule = match workspace_mode {
        "read" => String::new(),
        "write" => format!("\n(allow file-write* (subpath \"{escaped_workspace}\"))"),
        _ => {
            return Err(KernelError::InvalidCommand(
                "bash workspaceMode must be read or write".to_string(),
            ))
        }
    };
    Ok(format!(
        "(version 1)\n(allow default)\n(deny network*)\n(deny file-write*){workspace_write_rule}\n(allow file-write* (subpath \"{escaped_temporary}\"))\n(allow file-write* (literal \"/dev/null\"))\n(deny mach-lookup (global-name \"{process_scope_id}\"))"
    ))
}

#[cfg(target_os = "macos")]
fn macos_sandbox_path(path: &Path, label: &str) -> KernelResult<String> {
    let path = path.to_str().ok_or_else(|| {
        KernelError::InvalidCommand(format!("bash {label} path is not valid UTF-8"))
    })?;
    if path.chars().any(char::is_control) {
        return Err(KernelError::InvalidCommand(format!(
            "bash {label} path contains control characters"
        )));
    }
    Ok(path.replace('\\', "\\\\").replace('"', "\\\""))
}

struct ShellOutputArchive {
    directory: PathBuf,
    retained: bool,
}

impl ShellOutputArchive {
    fn create(context: &KernelToolExecutionContext) -> KernelResult<Self> {
        let directory = context.output_directory.clone().ok_or_else(|| {
            KernelError::Other("bash output archive directory is missing".to_string())
        })?;
        if let Some(parent) = directory.parent() {
            fs::create_dir_all(parent).map_err(output_archive_error)?;
        }
        fs::create_dir(&directory).map_err(output_archive_error)?;
        Ok(Self {
            directory,
            retained: false,
        })
    }

    fn open(&self, stream: &str) -> KernelResult<fs::File> {
        fs::File::create(self.directory.join(format!("{stream}.log"))).map_err(output_archive_error)
    }

    fn finish(mut self, output: &mut Value, truncated: bool) -> KernelResult<()> {
        if truncated {
            let mut paths = serde_json::Map::new();
            for stream in ["stdout", "stderr"] {
                let path = self.directory.join(format!("{stream}.log"));
                match fs::metadata(&path) {
                    Ok(metadata) => {
                        paths.insert(
                            stream.to_string(),
                            serde_json::json!({
                                "path": path, "bytes": metadata.len(),
                            }),
                        );
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::NotFound && stream == "stderr" => {}
                    Err(error) => return Err(output_archive_error(error)),
                }
            }
            output["fullOutput"] = Value::Object(paths);
            self.retained = true;
        } else {
            fs::remove_dir_all(&self.directory).map_err(output_archive_error)?;
        }
        Ok(())
    }
}

impl Drop for ShellOutputArchive {
    fn drop(&mut self) {
        if !self.retained {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

fn output_archive_error(error: std::io::Error) -> KernelError {
    KernelError::Other(format!("bash output archive: {error}"))
}

pub(super) struct CapturedOutput {
    pub(super) bytes: Vec<u8>,
    pub(super) truncated: bool,
}

fn spawn_output_reader(
    mut reader: impl Read + Send + 'static,
    mut archive: fs::File,
    max_bytes: usize,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<std::io::Result<CapturedOutput>> {
    thread::spawn(move || {
        let mut captured = Vec::new();
        let mut truncated = false;
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            let read = match reader.read(&mut chunk) {
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if stop.load(AtomicOrdering::Acquire) {
                        break;
                    }
                    thread::sleep(PROCESS_POLL_INTERVAL);
                    continue;
                }
                Err(error) => return Err(error),
            };
            if read == 0 {
                break;
            }
            archive.write_all(&chunk[..read])?;
            truncated |= append_tail(&mut captured, &chunk[..read], max_bytes);
        }
        Ok(CapturedOutput {
            bytes: captured,
            truncated,
        })
    })
}

fn spawn_pty_output_reader(
    mut reader: impl Read + Send + 'static,
    mut archive: fs::File,
    max_bytes: usize,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<std::io::Result<CapturedOutput>> {
    thread::spawn(move || {
        let mut captured = Vec::new();
        let mut truncated = false;
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            let read = match reader.read(&mut chunk) {
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if stop.load(AtomicOrdering::Acquire) {
                        break;
                    }
                    thread::sleep(PROCESS_POLL_INTERVAL);
                    continue;
                }
                #[cfg(unix)]
                Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
                Err(error) => return Err(error),
            };
            if read == 0 {
                break;
            }
            archive.write_all(&chunk[..read])?;
            truncated |= append_tail(&mut captured, &chunk[..read], max_bytes);
        }
        Ok(CapturedOutput {
            bytes: captured,
            truncated,
        })
    })
}

fn append_tail(target: &mut Vec<u8>, bytes: &[u8], max_bytes: usize) -> bool {
    if bytes.len() >= max_bytes {
        let truncated = !target.is_empty() || bytes.len() > max_bytes;
        target.clear();
        target.extend_from_slice(&bytes[bytes.len() - max_bytes..]);
        return truncated;
    }
    let overflow = target
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(max_bytes);
    if overflow > 0 {
        target.drain(..overflow);
    }
    target.extend_from_slice(bytes);
    overflow > 0
}

pub(super) fn bound_combined_output(
    stdout: &mut CapturedOutput,
    stderr: &mut CapturedOutput,
    max_bytes: usize,
) {
    if stdout.bytes.len().saturating_add(stderr.bytes.len()) <= max_bytes {
        return;
    }
    let half = max_bytes / 2;
    let mut stdout_keep = stdout.bytes.len().min(half);
    let mut stderr_keep = stderr.bytes.len().min(half);
    let mut remaining = max_bytes.saturating_sub(stdout_keep + stderr_keep);
    let stdout_extra = stdout
        .bytes
        .len()
        .saturating_sub(stdout_keep)
        .min(remaining);
    stdout_keep += stdout_extra;
    remaining -= stdout_extra;
    stderr_keep += stderr
        .bytes
        .len()
        .saturating_sub(stderr_keep)
        .min(remaining);
    stdout.truncated |= retain_tail(&mut stdout.bytes, stdout_keep);
    stderr.truncated |= retain_tail(&mut stderr.bytes, stderr_keep);
}

fn retain_tail(bytes: &mut Vec<u8>, keep: usize) -> bool {
    if bytes.len() <= keep {
        return false;
    }
    let remove = bytes.len() - keep;
    bytes.drain(..remove);
    true
}

fn line_count(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'))
}

fn retain_tail_lines(bytes: &mut Vec<u8>, keep: usize) -> bool {
    let count = line_count(bytes);
    if count <= keep {
        return false;
    }
    if keep == 0 {
        bytes.clear();
        return true;
    }
    let start = bytes
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'\n')
        .nth(count - keep - 1)
        .map(|(index, _)| index + 1)
        .expect("line boundary");
    bytes.drain(..start);
    true
}

fn trim_utf8_prefix(bytes: &mut Vec<u8>) {
    let count = bytes
        .iter()
        .take_while(|byte| **byte & 0xc0 == 0x80)
        .count();
    bytes.drain(..count);
}

fn bound_output_lines(stdout: &mut CapturedOutput, stderr: &mut CapturedOutput) {
    let stdout_lines = line_count(&stdout.bytes);
    let stderr_lines = line_count(&stderr.bytes);
    let stderr_keep = stderr_lines.min(BASH_OUTPUT_LIMIT_LINES / 2);
    let stdout_keep = stdout_lines.min(BASH_OUTPUT_LIMIT_LINES - stderr_keep);
    stdout.truncated |= retain_tail_lines(&mut stdout.bytes, stdout_keep);
    stderr.truncated |= retain_tail_lines(&mut stderr.bytes, BASH_OUTPUT_LIMIT_LINES - stdout_keep);
    trim_utf8_prefix(&mut stdout.bytes);
    trim_utf8_prefix(&mut stderr.bytes);
}

#[cfg(unix)]
fn set_pipe_nonblocking(reader: &impl AsRawFd, stream: &str) -> KernelResult<()> {
    set_raw_fd_nonblocking(reader.as_raw_fd(), stream)
}

#[cfg(unix)]
fn set_raw_fd_nonblocking(fd: std::os::fd::RawFd, stream: &str) -> KernelResult<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(KernelError::Other(format!(
            "read bash {stream} pipe flags: {}",
            std::io::Error::last_os_error()
        )));
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(KernelError::Other(format!(
            "set bash {stream} pipe nonblocking: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_pipe_nonblocking(_reader: &impl Read, _stream: &str) -> KernelResult<()> {
    Ok(())
}

fn join_output_reader(
    reader: thread::JoinHandle<std::io::Result<CapturedOutput>>,
    stream: &str,
) -> KernelResult<CapturedOutput> {
    reader
        .join()
        .map_err(|_| KernelError::Other(format!("bash {stream} reader panicked")))?
        .map_err(|error| KernelError::Other(format!("read bash {stream}: {error}")))
}

pub(super) fn wait_for_bounded_child(
    child: &mut Child,
    timeout: Duration,
    cancellation: &KernelCancellationToken,
) -> KernelResult<(ExitStatus, bool, bool)> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("poll bash: {error}")))?
        {
            return Ok((status, false, false));
        }
        if cancellation.is_cancelled() {
            return terminate_child(child).map(|status| (status, false, true));
        }
        if Instant::now() >= deadline {
            return terminate_child(child).map(|status| (status, true, false));
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn wait_for_bounded_pty_child(
    child: &mut PtyChildGuard,
    timeout: Duration,
    cancellation: &KernelCancellationToken,
) -> KernelResult<(portable_pty::ExitStatus, bool, bool)> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("poll bash pty: {error}")))?
        {
            return Ok((status, false, false));
        }
        if cancellation.is_cancelled() {
            return child
                .terminate_and_wait()
                .map(|status| (status, false, true));
        }
        if Instant::now() >= deadline {
            return child
                .terminate_and_wait()
                .map(|status| (status, true, false));
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

#[cfg(unix)]
fn terminate_child(child: &mut Child) -> KernelResult<ExitStatus> {
    signal_process_group(child.id(), UNIX_SIGTERM);
    let deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("poll timed-out bash: {error}")))?
        {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
    signal_process_group(child.id(), UNIX_SIGKILL);
    let _ = child.kill();
    child
        .wait()
        .map_err(|error| KernelError::Other(format!("reap timed-out bash: {error}")))
}

#[cfg(not(unix))]
fn terminate_child(child: &mut Child) -> KernelResult<ExitStatus> {
    let _ = child.kill();
    child
        .wait()
        .map_err(|error| KernelError::Other(format!("reap timed-out bash: {error}")))
}

#[cfg(unix)]
fn terminate_remaining_process_group(process_id: u32) {
    signal_process_group(process_id, UNIX_SIGHUP);
    signal_process_group(process_id, UNIX_SIGTERM);
    thread::sleep(Duration::from_millis(10));
    signal_process_group(process_id, UNIX_SIGKILL);
}

#[cfg(target_os = "macos")]
struct ProcessScopeGuard {
    process_id: u32,
    scope_id: String,
    active: bool,
}

#[cfg(target_os = "macos")]
impl ProcessScopeGuard {
    fn new(process_id: u32, scope_id: String) -> Self {
        Self {
            process_id,
            scope_id,
            active: true,
        }
    }

    fn terminate(&mut self) -> KernelResult<()> {
        terminate_remaining_process_group(self.process_id);
        let result = terminate_process_scope(&self.scope_id);
        if result.is_ok() {
            self.active = false;
        }
        result
    }
}

#[cfg(target_os = "macos")]
impl Drop for ProcessScopeGuard {
    fn drop(&mut self) {
        if self.active {
            terminate_remaining_process_group(self.process_id);
            let _ = terminate_process_scope(&self.scope_id);
        }
    }
}

#[cfg(target_os = "macos")]
fn terminate_process_scope(scope_id: &str) -> KernelResult<()> {
    let scope = CString::new(scope_id)
        .map_err(|_| KernelError::Other("bash scope identity contains a NUL byte".to_string()))?;
    let control = CString::new(format!("{scope_id}.control")).map_err(|_| {
        KernelError::Other("bash scope control identity contains a NUL byte".to_string())
    })?;
    let mut remaining = macos_processes_in_scope(&scope, &control)?;
    if remaining.is_empty() {
        return Ok(());
    }

    // Freeze the kernel-inherited sandbox scope before termination. A process
    // that forks just before SIGSTOP passes the same scope to its child, so
    // repeated scans close that race even after a descendant creates a new
    // Unix session or clears its environment.
    for _ in 0..4 {
        signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGSTOP)?;
        thread::sleep(Duration::from_millis(2));
        let next = macos_processes_in_scope(&scope, &control)?;
        if next == remaining {
            break;
        }
        remaining = next;
        if remaining.is_empty() {
            return Ok(());
        }
    }

    signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGTERM)?;
    signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGCONT)?;
    let term_deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
    loop {
        remaining = macos_processes_in_scope(&scope, &control)?;
        if remaining.is_empty() {
            return Ok(());
        }
        if Instant::now() >= term_deadline {
            break;
        }
        signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGTERM)?;
        signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGCONT)?;
        thread::sleep(PROCESS_POLL_INTERVAL);
    }

    signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGKILL)?;
    let kill_deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
    loop {
        remaining = macos_processes_in_scope(&scope, &control)?;
        if remaining.is_empty() {
            return Ok(());
        }
        if Instant::now() >= kill_deadline {
            return Err(KernelError::Other(format!(
                "bash could not terminate scoped descendant pids: {remaining:?}"
            )));
        }
        signal_scoped_processes(&remaining, &scope, &control, UNIX_SIGKILL)?;
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

#[cfg(target_os = "macos")]
fn macos_processes_in_scope(scope: &CStr, control: &CStr) -> KernelResult<Vec<i32>> {
    let required = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if required < 0 {
        return Err(KernelError::Other(format!(
            "list bash scope processes: {}",
            std::io::Error::last_os_error()
        )));
    }
    let capacity = usize::try_from(required)
        .unwrap_or(0)
        .saturating_mul(2)
        .saturating_add(64)
        .max(64);
    let mut pids = vec![0_i32; capacity];
    let buffer_bytes = i32::try_from(pids.len().saturating_mul(std::mem::size_of::<i32>()))
        .map_err(|_| KernelError::Other("process list buffer exceeds i32".to_string()))?;
    let returned = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), buffer_bytes) };
    if returned < 0 {
        return Err(KernelError::Other(format!(
            "read bash scope process list: {}",
            std::io::Error::last_os_error()
        )));
    }
    pids.truncate(usize::try_from(returned).unwrap_or(0).min(pids.len()));
    let daemon_pid = i32::try_from(std::process::id()).unwrap_or(-1);
    let mut scoped = Vec::new();
    for pid in pids {
        if pid > 1 && pid != daemon_pid && macos_process_has_scope(pid, scope, control)? {
            scoped.push(pid);
        }
    }
    scoped.sort_unstable();
    scoped.dedup();
    Ok(scoped)
}

#[cfg(target_os = "macos")]
fn macos_process_has_scope(pid: i32, scope: &CStr, control: &CStr) -> KernelResult<bool> {
    let filter_type = SANDBOX_FILTER_GLOBAL_NAME
        | unsafe { u32::try_from(DEEPCODE_SANDBOX_CHECK_NO_REPORT).unwrap_or(0) };
    let scope_denied = unsafe {
        deepcode_sandbox_check(
            pid,
            SANDBOX_MACH_LOOKUP_OPERATION.as_ptr().cast(),
            filter_type,
            scope.as_ptr(),
        )
    };
    if scope_denied < 0 {
        return Err(KernelError::Other(format!(
            "query bash scope for pid {pid}: {}",
            std::io::Error::last_os_error()
        )));
    }
    if scope_denied == 0 {
        return Ok(false);
    }
    let control_allowed = unsafe {
        deepcode_sandbox_check(
            pid,
            SANDBOX_MACH_LOOKUP_OPERATION.as_ptr().cast(),
            filter_type,
            control.as_ptr(),
        )
    };
    if control_allowed < 0 {
        return Err(KernelError::Other(format!(
            "query bash scope control for pid {pid}: {}",
            std::io::Error::last_os_error()
        )));
    }

    // macOS does not permit an already-sandboxed process to replace or stack
    // another profile: the new profile is ignored and its application fails.
    // Every surviving descendant therefore retains this exact one-rule delta.
    // The sibling control name distinguishes it from unrelated profiles that
    // deny arbitrary mach lookups; negative query results remain explicit errors.
    Ok(scope_membership_from_checks(scope_denied, control_allowed))
}

#[cfg(target_os = "macos")]
pub(super) fn scope_membership_from_checks(scope_denied: i32, control_allowed: i32) -> bool {
    scope_denied > 0 && control_allowed == 0
}

#[cfg(target_os = "macos")]
fn signal_scoped_processes(
    pids: &[i32],
    scope: &CStr,
    control: &CStr,
    signal: i32,
) -> KernelResult<()> {
    for pid in pids {
        // Recheck the immutable sandbox scope immediately before signalling so
        // PID reuse cannot target an unrelated process.
        if !macos_process_has_scope(*pid, scope, control)? {
            continue;
        }
        if unsafe { deepcode_process_kill(*pid, signal) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(KernelError::Other(format!(
                    "signal bash scoped pid {pid}: {error}"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn signal_process_group(process_id: u32, signal: i32) {
    let Ok(process_group_id) = i32::try_from(process_id) else {
        return;
    };
    unsafe {
        let _ = deepcode_process_kill(-process_group_id, signal);
    }
}

#[cfg(unix)]
const UNIX_SIGHUP: i32 = 1;
#[cfg(unix)]
const UNIX_SIGKILL: i32 = 9;
#[cfg(target_os = "macos")]
const UNIX_SIGSTOP: i32 = 17;
#[cfg(unix)]
const UNIX_SIGTERM: i32 = 15;
#[cfg(target_os = "macos")]
const UNIX_SIGCONT: i32 = 19;
#[cfg(target_os = "macos")]
const SANDBOX_FILTER_GLOBAL_NAME: u32 = 2;
#[cfg(target_os = "macos")]
const SANDBOX_MACH_LOOKUP_OPERATION: &[u8] = b"mach-lookup\0";

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "kill"]
    fn deepcode_process_kill(process_id: i32, signal: i32) -> i32;
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    #[link_name = "SANDBOX_CHECK_NO_REPORT"]
    static DEEPCODE_SANDBOX_CHECK_NO_REPORT: i32;
    #[link_name = "sandbox_check"]
    fn deepcode_sandbox_check(
        process_id: i32,
        operation: *const libc::c_char,
        filter_type: u32,
        ...
    ) -> i32;
}
