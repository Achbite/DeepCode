use super::*;
use deepcode_kernel_abi::{
    HostProcessIdentity, HostShutdownReceipt, HostShutdownRequest, HOST_INSTANCE_ID_ENV,
    HOST_INSTANCE_ID_PREFIX, HOST_SHELL_TOKEN_HEADER, HOST_SHELL_TOKEN_PREFIX,
    HOST_TOKEN_ENTROPY_BYTES, KERNEL_DAEMON_SERVICE,
};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const KERNEL_LISTENER_STARTUP_WAIT: Duration = Duration::from_secs(6);
const KERNEL_STARTUP_PROBE_INTERVAL: Duration = Duration::from_millis(75);
const KERNEL_OWNED_SHUTDOWN_CONNECT_WAIT: Duration = Duration::from_millis(500);
const KERNEL_OWNED_SHUTDOWN_IO_WAIT: Duration = Duration::from_secs(10);
const KERNEL_OWNED_SHUTDOWN_EXIT_ATTEMPTS: usize = 200;

#[cfg(unix)]
use std::os::unix::process::CommandExt as UnixCommandExt;
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use std::os::windows::process::CommandExt as WindowsCommandExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::HANDLE;
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[derive(Clone)]
pub struct KernelBootstrapOptions {
    pub api: Option<String>,
    pub auto_start: bool,
    host_shell_token: Option<HostShellToken>,
}

impl fmt::Debug for KernelBootstrapOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KernelBootstrapOptions")
            .field("api", &self.api)
            .field("auto_start", &self.auto_start)
            .field(
                "host_shell_token",
                &self.host_shell_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl KernelBootstrapOptions {
    pub fn new(api: Option<String>) -> Self {
        Self {
            api,
            auto_start: true,
            host_shell_token: None,
        }
    }

    pub fn auto_start(mut self, auto_start: bool) -> Self {
        self.auto_start = auto_start;
        self
    }

    pub fn host_shell_token(mut self, token: impl Into<String>) -> Self {
        self.host_shell_token = Some(HostShellToken::new(token));
        self
    }
}

pub struct KernelBootstrap {
    client: HttpKernelClient,
    _guard: KernelBootstrapGuard,
}

impl KernelBootstrap {
    pub async fn connect(options: KernelBootstrapOptions) -> KernelClientResult<Self> {
        let mut config = options
            .api
            .map(KernelClientConfig::new)
            .unwrap_or_else(KernelClientConfig::from_env);
        if let Some(token) = options.host_shell_token {
            config.host_shell_token = Some(token);
        }
        config.validate_host_shell_token()?;
        if !is_local_kernel_url(&config.base_url) {
            if !config.has_host_shell_token() {
                return Err(KernelClientError::HostConnectionTokenMissing);
            }
            return Err(KernelClientError::DaemonUnavailable {
                base_url: config.base_url.clone(),
                reason: "Host connection is restricted to a local Kernel URL".to_string(),
            });
        }
        let initial_probe = probe_existing_kernel(&config).await?;
        match initial_probe {
            ExistingKernelProbe::Healthy(client) => {
                return Ok(Self {
                    client,
                    _guard: KernelBootstrapGuard::external(),
                });
            }
            ExistingKernelProbe::NotListening => {}
            ExistingKernelProbe::TokenMissing => {
                return Err(KernelClientError::HostConnectionTokenMissing);
            }
            ExistingKernelProbe::TokenRejected => {
                return Err(KernelClientError::HostConnectionRejected {
                    base_url: config.base_url.clone(),
                });
            }
            ExistingKernelProbe::Unavailable(reason) => {
                return Err(KernelClientError::DaemonUnavailable {
                    base_url: config.base_url.clone(),
                    reason,
                });
            }
        }

        if !kernel_auto_start_enabled(options.auto_start) {
            if !config.has_host_shell_token() {
                return Err(KernelClientError::HostConnectionTokenMissing);
            }
            return Err(KernelClientError::DaemonUnavailable {
                base_url: config.base_url.clone(),
                reason: "automatic startup is disabled".to_string(),
            });
        }

        let (host, port) = parse_kernel_host_port(&config.base_url).ok_or_else(|| {
            KernelClientError::Bootstrap(format!(
                "cannot resolve local host/port from {}",
                config.base_url
            ))
        })?;
        let Some(_start_lock) = acquire_kernel_start_lock(&host, &port)? else {
            if !config.has_host_shell_token() {
                return Err(KernelClientError::HostConnectionTokenMissing);
            }
            let listener_deadline = Instant::now() + KERNEL_LISTENER_STARTUP_WAIT;
            loop {
                let probe = probe_existing_kernel(&config).await?;
                match probe {
                    ExistingKernelProbe::Healthy(client) => {
                        return Ok(Self {
                            client,
                            _guard: KernelBootstrapGuard::external(),
                        });
                    }
                    ExistingKernelProbe::TokenRejected => {
                        return Err(KernelClientError::HostConnectionRejected {
                            base_url: config.base_url.clone(),
                        });
                    }
                    ExistingKernelProbe::TokenMissing => {
                        return Err(KernelClientError::HostConnectionTokenMissing);
                    }
                    ExistingKernelProbe::NotListening | ExistingKernelProbe::Unavailable(_) => {}
                }
                if Instant::now() >= listener_deadline {
                    break;
                }
                std::thread::sleep(KERNEL_STARTUP_PROBE_INTERVAL);
            }
            return Err(KernelClientError::DaemonUnavailable {
                base_url: config.base_url.clone(),
                reason: "another owner is starting the Kernel, but its authenticated health endpoint did not become ready".to_string(),
            });
        };
        let locked_probe = probe_existing_kernel(&config).await?;
        match locked_probe {
            ExistingKernelProbe::Healthy(client) => {
                return Ok(Self {
                    client,
                    _guard: KernelBootstrapGuard::external(),
                });
            }
            ExistingKernelProbe::NotListening => {}
            ExistingKernelProbe::TokenMissing => {
                return Err(KernelClientError::HostConnectionTokenMissing);
            }
            ExistingKernelProbe::TokenRejected => {
                return Err(KernelClientError::HostConnectionRejected {
                    base_url: config.base_url.clone(),
                });
            }
            ExistingKernelProbe::Unavailable(reason) => {
                return Err(KernelClientError::DaemonUnavailable {
                    base_url: config.base_url.clone(),
                    reason,
                });
            }
        }
        let kernel_bin = find_kernel_binary().ok_or_else(|| {
            KernelClientError::Bootstrap(
                "cannot find deepcode-kernel or deepcode-kernel-daemon; set DEEPCODE_KERNEL_BIN"
                    .to_string(),
            )
        })?;
        let owned_token = generate_local_token(HOST_SHELL_TOKEN_PREFIX)?;
        let owned_instance_id = generate_local_token(HOST_INSTANCE_ID_PREFIX)?;
        let mut process =
            spawn_kernel_binary(&kernel_bin, &host, &port, &owned_token, &owned_instance_id)?;
        let owned_config = config.with_host_shell_token(owned_token);
        drop(owned_instance_id);

        let listener_deadline = Instant::now() + KERNEL_LISTENER_STARTUP_WAIT;
        loop {
            let probe = match probe_existing_kernel(&owned_config).await {
                Ok(probe) => probe,
                Err(error) => {
                    terminate_owned_kernel_process(&mut process);
                    return Err(error);
                }
            };
            match probe {
                ExistingKernelProbe::Healthy(client) => {
                    if !bind_owned_kernel_shutdown_identity(&mut process.shutdown_target) {
                        terminate_owned_kernel_process(&mut process);
                        return Err(KernelClientError::Bootstrap(
                            "owned Kernel public identity did not match its startup target"
                                .to_string(),
                        ));
                    }
                    return Ok(Self {
                        client,
                        _guard: KernelBootstrapGuard::owned(process),
                    });
                }
                ExistingKernelProbe::TokenRejected => {
                    terminate_owned_kernel_process(&mut process);
                    return Err(KernelClientError::HostConnectionRejected {
                        base_url: owned_config.base_url.clone(),
                    });
                }
                ExistingKernelProbe::TokenMissing => {
                    terminate_owned_kernel_process(&mut process);
                    return Err(KernelClientError::HostConnectionTokenMissing);
                }
                ExistingKernelProbe::NotListening | ExistingKernelProbe::Unavailable(_) => {}
            }
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    return Err(KernelClientError::Bootstrap(format!(
                        "owned Kernel process exited before authenticated health became ready: {status}"
                    )));
                }
                Ok(None) => {}
                Err(error) => {
                    terminate_owned_kernel_process(&mut process);
                    return Err(KernelClientError::Bootstrap(format!(
                        "failed to observe the owned Kernel process: {error}"
                    )));
                }
            }
            if Instant::now() >= listener_deadline {
                break;
            }
            std::thread::sleep(KERNEL_STARTUP_PROBE_INTERVAL);
        }

        terminate_owned_kernel_process(&mut process);
        Err(KernelClientError::Bootstrap(format!(
            "kernel did not become healthy at {}",
            owned_config.base_url
        )))
    }

    pub fn client(&self) -> &HttpKernelClient {
        &self.client
    }
}

pub struct KernelBootstrapGuard {
    process: Option<OwnedKernelProcess>,
}

impl KernelBootstrapGuard {
    fn external() -> Self {
        Self { process: None }
    }

    fn owned(process: OwnedKernelProcess) -> Self {
        Self {
            process: Some(process),
        }
    }
}

impl Drop for KernelBootstrapGuard {
    fn drop(&mut self) {
        // Only the shell that spawned the daemon owns its lifetime. Connections to an
        // already-running daemon use the external guard and are never terminated here.
        if let Some(mut process) = self.process.take() {
            terminate_owned_kernel_process(&mut process);
        }
    }
}

struct OwnedKernelProcess {
    child: Child,
    shutdown_target: OwnedKernelShutdownTarget,
    #[cfg(unix)]
    process_group_id: libc::pid_t,
    #[cfg(windows)]
    job: WindowsKillOnCloseJob,
}

struct OwnedKernelShutdownTarget {
    host: String,
    port: u16,
    host_shell_token: String,
    expected_instance_id: String,
    expected_pid: u32,
    expected_identity: Option<HostProcessIdentity>,
}

#[derive(Deserialize)]
struct HostApiEnvelope<T> {
    ok: bool,
    data: Option<T>,
}

#[cfg(windows)]
struct WindowsKillOnCloseJob {
    handle: Option<OwnedHandle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub service: String,
    pub ok: bool,
    pub raw: Value,
}

enum ExistingKernelProbe {
    NotListening,
    Healthy(HttpKernelClient),
    TokenMissing,
    TokenRejected,
    Unavailable(String),
}

async fn probe_existing_kernel(
    config: &KernelClientConfig,
) -> KernelClientResult<ExistingKernelProbe> {
    if !probe_kernel_tcp(&config.base_url) {
        return Ok(ExistingKernelProbe::NotListening);
    }
    if !config.has_host_shell_token() {
        return Ok(ExistingKernelProbe::TokenMissing);
    }
    let client = HttpKernelClient::new(config.clone())?;
    match client.health().await {
        Ok(status) if status.ok => Ok(ExistingKernelProbe::Healthy(client)),
        Ok(_) => Ok(ExistingKernelProbe::Unavailable(
            "Kernel health endpoint reported an unhealthy state".to_string(),
        )),
        Err(KernelClientError::Http(error))
            if error.status() == Some(reqwest::StatusCode::UNAUTHORIZED) =>
        {
            Ok(ExistingKernelProbe::TokenRejected)
        }
        Err(error) => Ok(ExistingKernelProbe::Unavailable(error.to_string())),
    }
}

fn generate_local_token(prefix: &str) -> KernelClientResult<String> {
    let mut entropy = [0_u8; HOST_TOKEN_ENTROPY_BYTES];
    getrandom::fill(&mut entropy).map_err(|error| {
        KernelClientError::Bootstrap(format!(
            "operating-system CSPRNG could not create a Host connection token: {error}"
        ))
    })?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(prefix.len() + entropy.len() * 2);
    encoded.push_str(prefix);
    for &byte in &entropy {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    entropy.fill(0);
    Ok(encoded)
}

fn probe_kernel_tcp(base_url: &str) -> bool {
    let Some((host, port)) = parse_kernel_host_port(base_url) else {
        return false;
    };
    let Ok(port) = port.parse::<u16>() else {
        return false;
    };
    let Ok(addrs) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|addr| connect_socket(addr, Duration::from_millis(180)).is_ok())
}

fn connect_socket(addr: SocketAddr, timeout: Duration) -> std::io::Result<TcpStream> {
    TcpStream::connect_timeout(&addr, timeout)
}

fn kernel_auto_start_enabled(default_enabled: bool) -> bool {
    match std::env::var("DEEPCODE_KERNEL_AUTO_START") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "no" | "off")
        }
        Err(_) => default_enabled,
    }
}

fn parse_kernel_host_port(base_url: &str) -> Option<(String, String)> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed.split_once("://")?;
    let target = rest.split('/').next()?.split('@').next_back()?;
    if target.is_empty() {
        return None;
    }
    if let Some(after_bracket) = target.strip_prefix('[') {
        let (host, tail) = after_bracket.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| default_port_for_scheme(scheme).to_string());
        return Some((host.to_string(), port));
    }
    let (host, port) = target
        .rsplit_once(':')
        .map(|(host, port)| (host.to_string(), port.to_string()))
        .unwrap_or_else(|| {
            (
                target.to_string(),
                default_port_for_scheme(scheme).to_string(),
            )
        });
    Some((host, port))
}

fn default_port_for_scheme(scheme: &str) -> &'static str {
    if scheme.eq_ignore_ascii_case("https") {
        "443"
    } else {
        "80"
    }
}

fn is_local_kernel_url(base_url: &str) -> bool {
    let Some((host, _)) = parse_kernel_host_port(base_url) else {
        return false;
    };
    matches!(
        host.trim_matches(|ch| ch == '[' || ch == ']')
            .to_ascii_lowercase()
            .as_str(),
        "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"
    )
}

fn find_kernel_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("DEEPCODE_KERNEL_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let mut search_dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_unique_path(&mut search_dirs, parent.to_path_buf());
            if cfg!(target_os = "macos") {
                if let Some(contents) = parent.parent() {
                    push_unique_path(&mut search_dirs, contents.to_path_buf());
                    push_unique_path(&mut search_dirs, contents.join("MacOS"));
                    push_unique_path(&mut search_dirs, contents.join("Resources"));
                }
            }
            add_target_profile_dirs(&mut search_dirs, parent);
            add_packaged_kernel_dirs(&mut search_dirs, parent);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        push_unique_path(&mut search_dirs, cwd.clone());
        add_packaged_kernel_dirs(&mut search_dirs, &cwd);
        add_target_profile_dirs(&mut search_dirs, &cwd);
    }

    for root in &search_dirs {
        for candidate in kernel_binary_candidates(root) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    for root in search_dirs {
        for ancestor in root.ancestors() {
            for platform_dir in kernel_platform_dir_names() {
                for profile in ["release", "debug"] {
                    for name in kernel_binary_names() {
                        let direct = ancestor
                            .join("target")
                            .join(platform_dir)
                            .join(profile)
                            .join(name);
                        if direct.is_file() {
                            return Some(direct);
                        }
                        let nested = ancestor
                            .join("DeepCode")
                            .join("target")
                            .join(platform_dir)
                            .join(profile)
                            .join(name);
                        if nested.is_file() {
                            return Some(nested);
                        }
                    }
                }
            }
            for platform_dir in kernel_platform_dir_names() {
                for name in kernel_binary_names() {
                    let direct = ancestor.join("bin").join(platform_dir).join(name);
                    if direct.is_file() {
                        return Some(direct);
                    }
                    let nested = ancestor
                        .join("DeepCode")
                        .join("bin")
                        .join(platform_dir)
                        .join(name);
                    if nested.is_file() {
                        return Some(nested);
                    }
                }
            }
            for profile in ["release", "debug"] {
                for name in kernel_binary_names() {
                    let direct = ancestor.join("target").join(profile).join(name);
                    if direct.is_file() {
                        return Some(direct);
                    }
                    let nested = ancestor
                        .join("DeepCode")
                        .join("target")
                        .join(profile)
                        .join(name);
                    if nested.is_file() {
                        return Some(nested);
                    }
                }
            }
        }
    }
    None
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn add_packaged_kernel_dirs(paths: &mut Vec<PathBuf>, root: &Path) {
    for ancestor in root.ancestors() {
        for platform_dir in kernel_platform_dir_names() {
            push_unique_path(paths, ancestor.join("bin").join(platform_dir));
            push_unique_path(
                paths,
                ancestor.join("DeepCode").join("bin").join(platform_dir),
            );
        }
    }
}

fn add_target_profile_dirs(paths: &mut Vec<PathBuf>, root: &Path) {
    for ancestor in root.ancestors() {
        for platform_dir in kernel_platform_dir_names() {
            for profile in ["release", "debug"] {
                push_unique_path(
                    paths,
                    ancestor.join("target").join(platform_dir).join(profile),
                );
                push_unique_path(
                    paths,
                    ancestor
                        .join("DeepCode")
                        .join("target")
                        .join(platform_dir)
                        .join(profile),
                );
            }
        }
    }
}

fn kernel_binary_candidates(root: &Path) -> Vec<PathBuf> {
    kernel_binary_names()
        .into_iter()
        .map(|name| root.join(name))
        .collect()
}

fn kernel_binary_names() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["deepcode-kernel-daemon.exe", "deepcode-kernel.exe"]
    } else {
        vec!["deepcode-kernel-daemon", "deepcode-kernel"]
    }
}

fn kernel_platform_dir_names() -> Vec<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        vec!["macos-arm64"]
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        vec!["macos-x64", "macos-arm64"]
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        vec!["linux-x64"]
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        vec!["linux-arm64", "linux-x64"]
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        vec!["windows-x64"]
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        vec!["windows-arm64", "windows-x64"]
    } else {
        Vec::new()
    }
}

fn spawn_kernel_binary(
    kernel_bin: &Path,
    host: &str,
    port: &str,
    host_shell_token: &str,
    host_instance_id: &str,
) -> KernelClientResult<OwnedKernelProcess> {
    let port_number = port.parse::<u16>().map_err(|_| {
        KernelClientError::Bootstrap("Kernel port is not a valid TCP port".to_string())
    })?;
    let kernel_dir = kernel_bin
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let log_file = open_kernel_log_file(&kernel_dir)?;
    let stderr = log_file.try_clone().map_err(|error| {
        KernelClientError::Bootstrap(format!("failed to clone kernel log handle: {error}"))
    })?;
    let mut command = Command::new(kernel_bin);
    command
        .current_dir(&kernel_dir)
        .env("DEEPCODE_HOST", host)
        .env("DEEPCODE_PORT", port)
        .env(HOST_SHELL_TOKEN_ENV, host_shell_token)
        .env(HOST_INSTANCE_ID_ENV, host_instance_id)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr));

    #[cfg(unix)]
    {
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            KernelClientError::Bootstrap(format!(
                "failed to start {}: {error}",
                kernel_bin.display()
            ))
        })?;
        let pid = child.id() as libc::pid_t;
        let process_group_id = unsafe { libc::getpgid(pid) };
        if process_group_id <= 0 || process_group_id != pid {
            let _ = child.kill();
            let _ = child.wait();
            return Err(KernelClientError::Bootstrap(format!(
                "{} did not enter its exact owned process group",
                kernel_bin.display()
            )));
        }
        let shutdown_target = owned_kernel_shutdown_target(
            host,
            port_number,
            host_shell_token,
            host_instance_id,
            child.id(),
        );
        return Ok(OwnedKernelProcess {
            child,
            shutdown_target,
            process_group_id,
        });
    }

    #[cfg(windows)]
    {
        let job = WindowsKillOnCloseJob::new().map_err(|error| {
            KernelClientError::Bootstrap(format!(
                "failed to create the Kernel process owner: {error}"
            ))
        })?;
        command.creation_flags(0x0800_0200);
        let mut child = command.spawn().map_err(|error| {
            KernelClientError::Bootstrap(format!(
                "failed to start {}: {error}",
                kernel_bin.display()
            ))
        })?;
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(KernelClientError::Bootstrap(format!(
                "failed to assign {} to its process owner: {error}",
                kernel_bin.display()
            )));
        }
        let shutdown_target = owned_kernel_shutdown_target(
            host,
            port_number,
            host_shell_token,
            host_instance_id,
            child.id(),
        );
        return Ok(OwnedKernelProcess {
            child,
            shutdown_target,
            job,
        });
    }
}

fn owned_kernel_shutdown_target(
    host: &str,
    port: u16,
    host_shell_token: &str,
    host_instance_id: &str,
    pid: u32,
) -> OwnedKernelShutdownTarget {
    OwnedKernelShutdownTarget {
        host: host.to_string(),
        port,
        host_shell_token: host_shell_token.to_string(),
        expected_instance_id: host_instance_id.to_string(),
        expected_pid: pid,
        expected_identity: None,
    }
}

fn bind_owned_kernel_shutdown_identity(target: &mut OwnedKernelShutdownTarget) -> bool {
    let Some(identity) = request_owned_kernel_public_identity(target) else {
        return false;
    };
    if identity.service != KERNEL_DAEMON_SERVICE
        || identity.instance_id != target.expected_instance_id
        || identity.pid != target.expected_pid
        || !is_local_kernel_url(&identity.address)
        || parse_kernel_host_port(&identity.address).and_then(|(_, port)| port.parse::<u16>().ok())
            != Some(target.port)
    {
        return false;
    }
    target.expected_identity = Some(identity);
    true
}

fn terminate_owned_kernel_process(process: &mut OwnedKernelProcess) {
    if process.child.try_wait().ok().flatten().is_some() {
        return;
    }
    if request_owned_kernel_graceful_shutdown(&process.shutdown_target)
        && wait_for_kernel_exit(process, KERNEL_OWNED_SHUTDOWN_EXIT_ATTEMPTS)
    {
        let _ = process.child.wait();
        return;
    }
    #[cfg(unix)]
    {
        let pid = process.child.id() as libc::pid_t;
        if unsafe { libc::getpgid(pid) } == process.process_group_id {
            unsafe {
                libc::kill(-process.process_group_id, libc::SIGTERM);
            }
        }
        if !wait_for_kernel_exit(process, 20) {
            if unsafe { libc::getpgid(pid) } == process.process_group_id {
                unsafe {
                    libc::kill(-process.process_group_id, libc::SIGKILL);
                }
            } else {
                let _ = process.child.kill();
            }
        }
    }
    #[cfg(windows)]
    {
        process.job.close();
        if !wait_for_kernel_exit(process, 20) {
            let _ = process.child.kill();
        }
    }
    let _ = process.child.wait();
}

fn request_owned_kernel_graceful_shutdown(target: &OwnedKernelShutdownTarget) -> bool {
    let Some(expected_identity) = target.expected_identity.as_ref() else {
        return false;
    };
    let host_header = if target.host.contains(':') {
        format!("[{}]:{}", target.host, target.port)
    } else {
        format!("{}:{}", target.host, target.port)
    };
    let body = match serde_json::to_vec(&HostShutdownRequest {
        expected_identity: expected_identity.clone(),
    }) {
        Ok(body) => body,
        Err(_) => return false,
    };
    let request_head = format!(
        "POST /api/host/shutdown HTTP/1.1\r\nHost: {host_header}\r\n{HOST_SHELL_TOKEN_HEADER}: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        target.host_shell_token,
        body.len()
    );
    let mut request = request_head.into_bytes();
    request.extend_from_slice(&body);
    let Some(envelope) = request_owned_kernel_api::<HostShutdownReceipt>(target, &request) else {
        return false;
    };
    envelope
        .ok
        .then_some(envelope.data)
        .flatten()
        .is_some_and(|receipt| receipt.confirms_shutdown_of(expected_identity))
}

fn request_owned_kernel_public_identity(
    target: &OwnedKernelShutdownTarget,
) -> Option<HostProcessIdentity> {
    let host_header = if target.host.contains(':') {
        format!("[{}]:{}", target.host, target.port)
    } else {
        format!("{}:{}", target.host, target.port)
    };
    let request = format!(
        "GET /api/host/identity HTTP/1.1\r\nHost: {host_header}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let envelope = request_owned_kernel_api::<HostProcessIdentity>(target, request.as_bytes())?;
    envelope.ok.then_some(envelope.data).flatten()
}

fn request_owned_kernel_api<T: for<'de> Deserialize<'de>>(
    target: &OwnedKernelShutdownTarget,
    request: &[u8],
) -> Option<HostApiEnvelope<T>> {
    let mut addresses = (target.host.as_str(), target.port).to_socket_addrs().ok()?;
    let mut stream = addresses
        .find_map(|address| connect_socket(address, KERNEL_OWNED_SHUTDOWN_CONNECT_WAIT).ok())?;
    stream
        .set_read_timeout(Some(KERNEL_OWNED_SHUTDOWN_IO_WAIT))
        .ok()?;
    stream
        .set_write_timeout(Some(KERNEL_OWNED_SHUTDOWN_IO_WAIT))
        .ok()?;
    stream.write_all(request).ok()?;
    stream.flush().ok()?;
    let mut response = Vec::with_capacity(4096);
    stream.take(64 * 1024).read_to_end(&mut response).ok()?;
    if !(response.starts_with(b"HTTP/1.1 200 ") || response.starts_with(b"HTTP/1.0 200 ")) {
        return None;
    }
    let body_offset = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?
        + 4;
    serde_json::from_slice(&response[body_offset..]).ok()
}

fn wait_for_kernel_exit(process: &mut OwnedKernelProcess, attempts: usize) -> bool {
    for _ in 0..attempts {
        match process.child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
    false
}

#[cfg(windows)]
impl WindowsKillOnCloseJob {
    fn new() -> std::io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            handle: Some(handle),
        })
    }

    fn assign(&self, child: &Child) -> std::io::Result<()> {
        let Some(handle) = self.handle.as_ref() else {
            return Err(std::io::Error::other("Kernel Job Object is closed"));
        };
        let process_handle = child.as_raw_handle() as HANDLE;
        if unsafe { AssignProcessToJobObject(handle.as_raw_handle() as HANDLE, process_handle) }
            == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn close(&mut self) {
        drop(self.handle.take());
    }
}

struct KernelStartLock {
    path: PathBuf,
}

impl Drop for KernelStartLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_kernel_start_lock(
    host: &str,
    port: &str,
) -> KernelClientResult<Option<KernelStartLock>> {
    let path = std::env::temp_dir().join(format!(
        "deepcode-kernel-start-{}-{}.lock",
        sanitize_lock_component(host),
        sanitize_lock_component(port)
    ));
    match create_kernel_start_lock_file(&path) {
        Ok(()) => Ok(Some(KernelStartLock { path })),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            if kernel_start_lock_is_stale(&path) {
                let _ = std::fs::remove_file(&path);
                return match create_kernel_start_lock_file(&path) {
                    Ok(()) => Ok(Some(KernelStartLock { path })),
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(None),
                    Err(error) => Err(KernelClientError::Bootstrap(format!(
                        "failed to create kernel start lock {}: {error}",
                        path.display()
                    ))),
                };
            }
            Ok(None)
        }
        Err(error) => Err(KernelClientError::Bootstrap(format!(
            "failed to create kernel start lock {}: {error}",
            path.display()
        ))),
    }
}

fn create_kernel_start_lock_file(path: &Path) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    writeln!(file, "pid={}", std::process::id())?;
    Ok(())
}

fn kernel_start_lock_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map(|age| age > Duration::from_secs(30))
        .unwrap_or(false)
}

fn sanitize_lock_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn open_kernel_log_file(kernel_dir: &Path) -> KernelClientResult<File> {
    let log_dir = std::env::var_os("DEEPCODE_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| kernel_dir.join("logs"));
    match open_log_in_dir(&log_dir) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            open_log_in_dir(&std::env::temp_dir().join("deepcode")).map_err(|fallback_error| {
                KernelClientError::Bootstrap(format!(
                    "failed to open kernel log at {}: {error}; fallback failed: {fallback_error}",
                    log_dir.display()
                ))
            })
        }
        Err(error) => Err(KernelClientError::Bootstrap(format!(
            "failed to open kernel log at {}: {error}",
            log_dir.display()
        ))),
    }
}

fn open_log_in_dir(log_dir: &Path) -> std::io::Result<File> {
    std::fs::create_dir_all(log_dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("deepcode-kernel.log"))
}
