use super::*;
use deepcode_kernel_tools::kernel_internal::process_shell_hard_deny_reason;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::ffi::{OsStr, OsString};
use std::io::Read;
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(target_os = "macos")]
use std::os::unix::{fs::PermissionsExt, process::CommandExt};
use std::process::{Child, Command, ExitStatus, Stdio};
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(target_os = "macos")]
use std::time::{SystemTime, UNIX_EPOCH};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(unix)]
const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(100);
const AGENT_SHELL_PROGRAM: &str = "/bin/sh";
const AGENT_SHELL_PATH_SOURCE: &str = "hostPlusStandardDeveloperPaths";
const AGENT_SHELL_WRITE_SCOPE: &str = "workspaceAndKernelTemporary";
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
                code: "process_shell_hard_denied",
                stage: "execution",
                message: format!("process.shell command {reason}"),
                details: serde_json::json!({ "toolId": "process.shell" }),
            });
        }
        let logical_cwd = get_string(&invocation.input, "cwd").unwrap_or_else(|| ".".to_string());
        let workspace_id = workspace_id(&context)?;
        let workspace_root = canonical_process_workspace_root(&context)?;
        let cwd = prepared_process_cwd(&context, &workspace_root, &logical_cwd)?;
        let timeout_ms = invocation
            .input
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(120_000)
            .clamp(100, 600_000);
        let max_output_bytes = invocation
            .input
            .get("maxOutputBytes")
            .and_then(Value::as_u64)
            .unwrap_or(262_144)
            .clamp(1_024, 1_048_576) as usize;

        #[cfg(target_os = "macos")]
        let process_scope_id = new_process_scope_id();
        #[cfg(target_os = "macos")]
        let mut process_temp = AgentShellTempDir::create(&process_scope_id)?;
        let mut process = platform_shell_command(
            &command_text,
            &workspace_root,
            #[cfg(target_os = "macos")]
            process_temp.path(),
            #[cfg(target_os = "macos")]
            &process_scope_id,
        )?;
        apply_agent_shell_environment(&mut process);
        process
            .current_dir(&cwd)
            .env("DEEPCODE_AGENT_SHELL", "1")
            .env("DEEPCODE_WORKSPACE_ROOT", &workspace_root);
        #[cfg(target_os = "macos")]
        process
            .env("TMPDIR", process_temp.path())
            .env("TMP", process_temp.path())
            .env("TEMP", process_temp.path());
        process
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let started = Instant::now();
        let mut child = process.spawn().map_err(|error| {
            KernelError::Other(format!("spawn process.shell in {}: {error}", cwd.display()))
        })?;
        let child_id = child.id();
        #[cfg(target_os = "macos")]
        let mut process_scope_guard = ProcessScopeGuard::new(child_id, process_scope_id);
        let Some(stdout) = child.stdout.take() else {
            let _ = terminate_child(&mut child);
            return Err(KernelError::Other(
                "process.shell stdout pipe is unavailable".to_string(),
            ));
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = terminate_child(&mut child);
            return Err(KernelError::Other(
                "process.shell stderr pipe is unavailable".to_string(),
            ));
        };
        if let Err(error) = set_pipe_nonblocking(&stdout, "stdout")
            .and_then(|_| set_pipe_nonblocking(&stderr, "stderr"))
        {
            let _ = terminate_child(&mut child);
            return Err(error);
        }
        let remaining = Arc::new(Mutex::new(max_output_bytes));
        let stop_capture = Arc::new(AtomicBool::new(false));
        let stdout_reader =
            spawn_output_reader(stdout, Arc::clone(&remaining), Arc::clone(&stop_capture));
        let stderr_reader = spawn_output_reader(stderr, remaining, Arc::clone(&stop_capture));

        let (status, timed_out) =
            wait_for_bounded_child(&mut child, Duration::from_millis(timeout_ms))?;
        #[cfg(all(unix, not(target_os = "macos")))]
        terminate_remaining_process_group(child_id);
        #[cfg(target_os = "macos")]
        let process_scope_cleanup = process_scope_guard.terminate();
        stop_capture.store(true, AtomicOrdering::Release);

        let stdout = join_output_reader(stdout_reader, "stdout")?;
        let stderr = join_output_reader(stderr_reader, "stderr")?;
        #[cfg(target_os = "macos")]
        process_scope_cleanup?;
        #[cfg(target_os = "macos")]
        process_temp.cleanup()?;
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let captured_bytes = stdout.bytes.len().saturating_add(stderr.bytes.len());
        let truncated = stdout.truncated || stderr.truncated;
        let exit_code = status.code();
        let success = !timed_out && status.success();

        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id,
                "command": command_text,
                "cwd": normalize_relative_path(&logical_cwd),
                "stdout": String::from_utf8_lossy(&stdout.bytes),
                "stderr": String::from_utf8_lossy(&stderr.bytes),
                "exitCode": exit_code,
                "success": success,
                "timedOut": timed_out,
                "truncated": truncated,
                "capturedBytes": captured_bytes,
                "durationMs": duration_ms,
                "environment": {
                    "shell": AGENT_SHELL_PROGRAM,
                    "interactive": false,
                    "pathSource": AGENT_SHELL_PATH_SOURCE,
                    "writeScope": AGENT_SHELL_WRITE_SCOPE,
                    "homeWritable": false
                }
            }),
        ))
    }
}

fn apply_agent_shell_environment(command: &mut Command) {
    command.env_clear();
    for key in AGENT_SHELL_ENV_ALLOWLIST {
        if *key == "PATH" {
            continue;
        }
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("PATH", resolved_agent_shell_path())
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
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

#[cfg(test)]
pub(super) fn composed_agent_shell_path_for_test(home: &Path, host_path: &OsStr) -> OsString {
    compose_agent_shell_path(Some(home), Some(host_path), &[])
}

#[cfg(test)]
pub(super) fn agent_shell_environment_key_allowed(key: &str) -> bool {
    AGENT_SHELL_ENV_ALLOWLIST.contains(&key)
        || matches!(
            key,
            "TERM"
                | "NO_COLOR"
                | "CLICOLOR"
                | "DEEPCODE_AGENT_SHELL"
                | "DEEPCODE_WORKSPACE_ROOT"
                | "TMPDIR"
                | "TMP"
                | "TEMP"
        )
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
                "create process.shell temporary directory {}: {error}",
                path.display()
            ))
        })?;
        if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(0o700)) {
            let _ = fs::remove_dir_all(&path);
            return Err(KernelError::Other(format!(
                "secure process.shell temporary directory {}: {error}",
                path.display()
            )));
        }
        let canonical = match path.canonicalize() {
            Ok(canonical) => canonical,
            Err(error) => {
                let _ = fs::remove_dir_all(&path);
                return Err(KernelError::Other(format!(
                    "canonicalize process.shell temporary directory {}: {error}",
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
                "remove process.shell temporary directory {}: {error}",
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
    logical_cwd: &str,
) -> KernelResult<PathBuf> {
    if context.private_resolved_targets.len() != 1 {
        return Err(KernelError::InvalidCommand(
            "process.shell requires exactly one PreparedEffect cwd".to_string(),
        ));
    }
    let prepared = PathBuf::from(&context.private_resolved_targets[0]);
    let canonical_cwd = prepared.canonicalize().map_err(|error| {
        KernelError::InvalidCommand(format!(
            "process.shell cwd {logical_cwd} is unavailable: {error}"
        ))
    })?;
    if !canonical_cwd.starts_with(root) {
        return Err(KernelError::PermissionDenied(format!(
            "process.shell cwd resolves outside workspace: {logical_cwd}"
        )));
    }
    if !canonical_cwd.is_dir() {
        return Err(KernelError::InvalidCommand(format!(
            "process.shell cwd is not a directory: {logical_cwd}"
        )));
    }
    let requested_cwd = root.join(logical_cwd).canonicalize().map_err(|error| {
        KernelError::InvalidCommand(format!(
            "process.shell cwd {logical_cwd} is unavailable: {error}"
        ))
    })?;
    if requested_cwd != canonical_cwd {
        return Err(KernelError::PermissionDenied(
            "process.shell PreparedEffect cwd does not match the canonical invocation".to_string(),
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
    workspace_root: &Path,
    #[cfg(target_os = "macos")] temporary_root: &Path,
    #[cfg(target_os = "macos")] process_scope_id: &str,
) -> KernelResult<Command> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-p")
            .arg(macos_workspace_write_profile(
                workspace_root,
                temporary_root,
                process_scope_id,
            )?)
            .arg(AGENT_SHELL_PROGRAM)
            .arg("-c")
            .arg(command_text);
        command.process_group(0);
        Ok(command)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (command_text, workspace_root);
        Err(KernelError::Structured {
            code: "process_shell_workspace_sandbox_unavailable",
            stage: "execution",
            message: "process.shell requires a platform workspace-write sandbox".to_string(),
            details: serde_json::json!({ "toolId": "process.shell" }),
        })
    }
}

#[cfg(target_os = "macos")]
fn macos_workspace_write_profile(
    workspace_root: &Path,
    temporary_root: &Path,
    process_scope_id: &str,
) -> KernelResult<String> {
    let escaped_workspace = macos_sandbox_path(workspace_root, "workspace")?;
    let escaped_temporary = macos_sandbox_path(temporary_root, "temporary directory")?;
    if process_scope_id.is_empty()
        || !process_scope_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err(KernelError::InvalidCommand(
            "process.shell scope identity is invalid".to_string(),
        ));
    }
    Ok(format!(
        "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath \"{escaped_workspace}\"))\n(allow file-write* (subpath \"{escaped_temporary}\"))\n(allow file-write* (literal \"/dev/null\"))\n(deny mach-lookup (global-name \"{process_scope_id}\"))"
    ))
}

#[cfg(target_os = "macos")]
fn macos_sandbox_path(path: &Path, label: &str) -> KernelResult<String> {
    let path = path.to_str().ok_or_else(|| {
        KernelError::InvalidCommand(format!("process.shell {label} path is not valid UTF-8"))
    })?;
    if path.chars().any(char::is_control) {
        return Err(KernelError::InvalidCommand(format!(
            "process.shell {label} path contains control characters"
        )));
    }
    Ok(path.replace('\\', "\\\\").replace('"', "\\\""))
}

struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

fn spawn_output_reader(
    mut reader: impl Read + Send + 'static,
    remaining: Arc<Mutex<usize>>,
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
            let keep = {
                let mut remaining = remaining
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let keep = read.min(*remaining);
                *remaining -= keep;
                keep
            };
            captured.extend_from_slice(&chunk[..keep]);
            truncated |= keep < read;
        }
        Ok(CapturedOutput {
            bytes: captured,
            truncated,
        })
    })
}

#[cfg(unix)]
fn set_pipe_nonblocking(reader: &impl AsRawFd, stream: &str) -> KernelResult<()> {
    let fd = reader.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(KernelError::Other(format!(
            "read process.shell {stream} pipe flags: {}",
            std::io::Error::last_os_error()
        )));
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(KernelError::Other(format!(
            "set process.shell {stream} pipe nonblocking: {}",
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
        .map_err(|_| KernelError::Other(format!("process.shell {stream} reader panicked")))?
        .map_err(|error| KernelError::Other(format!("read process.shell {stream}: {error}")))
}

fn wait_for_bounded_child(
    child: &mut Child,
    timeout: Duration,
) -> KernelResult<(ExitStatus, bool)> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("poll process.shell: {error}")))?
        {
            return Ok((status, false));
        }
        if Instant::now() >= deadline {
            return terminate_child(child).map(|status| (status, true));
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
            .map_err(|error| KernelError::Other(format!("poll timed-out process.shell: {error}")))?
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
        .map_err(|error| KernelError::Other(format!("reap timed-out process.shell: {error}")))
}

#[cfg(not(unix))]
fn terminate_child(child: &mut Child) -> KernelResult<ExitStatus> {
    let _ = child.kill();
    child
        .wait()
        .map_err(|error| KernelError::Other(format!("reap timed-out process.shell: {error}")))
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
    let scope = CString::new(scope_id).map_err(|_| {
        KernelError::Other("process.shell scope identity contains a NUL byte".to_string())
    })?;
    let control = CString::new(format!("{scope_id}.control")).map_err(|_| {
        KernelError::Other("process.shell scope control identity contains a NUL byte".to_string())
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
                "process.shell could not terminate scoped descendant pids: {remaining:?}"
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
            "list process.shell scope processes: {}",
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
            "read process.shell scope process list: {}",
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
            "query process.shell scope for pid {pid}: {}",
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
            "query process.shell scope control for pid {pid}: {}",
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
                    "signal process.shell scoped pid {pid}: {error}"
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
