use super::*;
use deepcode_kernel_abi::{
    HOST_AUTHORITY_ENTROPY_BYTES_V2, HOST_INSTANCE_ID_ENV_V2, HOST_INSTANCE_ID_PREFIX_V2,
    HOST_SHELL_CAPABILITY_PREFIX_V2,
};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt as UnixCommandExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt as WindowsCommandExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
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
    host_shell_capability: Option<HostShellCapabilityV2>,
}

impl fmt::Debug for KernelBootstrapOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KernelBootstrapOptions")
            .field("api", &self.api)
            .field("auto_start", &self.auto_start)
            .field(
                "host_shell_capability",
                &self.host_shell_capability.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl KernelBootstrapOptions {
    pub fn new(api: Option<String>) -> Self {
        Self {
            api,
            auto_start: true,
            host_shell_capability: None,
        }
    }

    pub fn auto_start(mut self, auto_start: bool) -> Self {
        self.auto_start = auto_start;
        self
    }

    pub fn host_shell_capability(mut self, capability: impl Into<String>) -> Self {
        self.host_shell_capability = Some(HostShellCapabilityV2::new(capability));
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
        if let Some(capability) = options.host_shell_capability {
            config.host_shell_capability = Some(capability);
        }
        config.validate_host_shell_capability()?;
        if !is_local_kernel_url(&config.base_url) {
            if !config.has_host_shell_capability() {
                return Err(KernelClientError::HostAdmissionCapabilityMissing);
            }
            return Err(KernelClientError::DaemonUnavailable {
                base_url: config.base_url.clone(),
                reason: "Host admission is restricted to a local Kernel URL".to_string(),
            });
        }
        match probe_existing_kernel(&config).await? {
            ExistingKernelProbe::Healthy(client) => {
                return Ok(Self {
                    client,
                    _guard: KernelBootstrapGuard::external(),
                });
            }
            ExistingKernelProbe::NotListening => {}
            ExistingKernelProbe::AdmissionMissing => {
                return Err(KernelClientError::HostAdmissionCapabilityMissing);
            }
            ExistingKernelProbe::AdmissionRejected => {
                return Err(KernelClientError::HostAdmissionRejected {
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
            if !config.has_host_shell_capability() {
                return Err(KernelClientError::HostAdmissionCapabilityMissing);
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
            if !config.has_host_shell_capability() {
                return Err(KernelClientError::HostAdmissionCapabilityMissing);
            }
            for _ in 0..80 {
                match probe_existing_kernel(&config).await? {
                    ExistingKernelProbe::Healthy(client) => {
                        return Ok(Self {
                            client,
                            _guard: KernelBootstrapGuard::external(),
                        });
                    }
                    ExistingKernelProbe::AdmissionRejected => {
                        return Err(KernelClientError::HostAdmissionRejected {
                            base_url: config.base_url.clone(),
                        });
                    }
                    ExistingKernelProbe::AdmissionMissing => {
                        return Err(KernelClientError::HostAdmissionCapabilityMissing);
                    }
                    ExistingKernelProbe::NotListening | ExistingKernelProbe::Unavailable(_) => {}
                }
                std::thread::sleep(Duration::from_millis(75));
            }
            return Err(KernelClientError::DaemonUnavailable {
                base_url: config.base_url.clone(),
                reason: "another owner is starting the Kernel, but its authenticated health endpoint did not become ready".to_string(),
            });
        };
        match probe_existing_kernel(&config).await? {
            ExistingKernelProbe::Healthy(client) => {
                return Ok(Self {
                    client,
                    _guard: KernelBootstrapGuard::external(),
                });
            }
            ExistingKernelProbe::NotListening => {}
            ExistingKernelProbe::AdmissionMissing => {
                return Err(KernelClientError::HostAdmissionCapabilityMissing);
            }
            ExistingKernelProbe::AdmissionRejected => {
                return Err(KernelClientError::HostAdmissionRejected {
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
        let owned_capability = generate_host_authority_value(HOST_SHELL_CAPABILITY_PREFIX_V2)?;
        let owned_instance_id = generate_host_authority_value(HOST_INSTANCE_ID_PREFIX_V2)?;
        let mut process = spawn_kernel_binary(
            &kernel_bin,
            &host,
            &port,
            &owned_capability,
            &owned_instance_id,
        )?;
        let owned_config = config.with_host_shell_capability(owned_capability);
        drop(owned_instance_id);

        for _ in 0..80 {
            let probe = match probe_existing_kernel(&owned_config).await {
                Ok(probe) => probe,
                Err(error) => {
                    terminate_owned_kernel_process(&mut process);
                    return Err(error);
                }
            };
            match probe {
                ExistingKernelProbe::Healthy(client) => {
                    return Ok(Self {
                        client,
                        _guard: KernelBootstrapGuard::owned(process),
                    });
                }
                ExistingKernelProbe::AdmissionRejected => {
                    terminate_owned_kernel_process(&mut process);
                    return Err(KernelClientError::HostAdmissionRejected {
                        base_url: owned_config.base_url.clone(),
                    });
                }
                ExistingKernelProbe::AdmissionMissing => {
                    terminate_owned_kernel_process(&mut process);
                    return Err(KernelClientError::HostAdmissionCapabilityMissing);
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
            std::thread::sleep(Duration::from_millis(75));
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
    #[cfg(unix)]
    process_group_id: libc::pid_t,
    #[cfg(windows)]
    job: WindowsKillOnCloseJob,
}

#[cfg(windows)]
struct WindowsKillOnCloseJob {
    handle: Option<HANDLE>,
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
    AdmissionMissing,
    AdmissionRejected,
    Unavailable(String),
}

async fn probe_existing_kernel(
    config: &KernelClientConfig,
) -> KernelClientResult<ExistingKernelProbe> {
    if !probe_kernel_tcp(&config.base_url) {
        return Ok(ExistingKernelProbe::NotListening);
    }
    if !config.has_host_shell_capability() {
        return Ok(ExistingKernelProbe::AdmissionMissing);
    }
    let client = HttpKernelClient::new(config.clone())?;
    match client.health().await {
        Ok(status) if status.ok => Ok(ExistingKernelProbe::Healthy(client)),
        Ok(_) => Ok(ExistingKernelProbe::Unavailable(
            "authenticated health endpoint reported an unhealthy state".to_string(),
        )),
        Err(KernelClientError::Http(error))
            if error.status() == Some(reqwest::StatusCode::UNAUTHORIZED) =>
        {
            Ok(ExistingKernelProbe::AdmissionRejected)
        }
        Err(error) => Ok(ExistingKernelProbe::Unavailable(error.to_string())),
    }
}

fn generate_host_authority_value(prefix: &str) -> KernelClientResult<String> {
    let mut entropy = [0_u8; HOST_AUTHORITY_ENTROPY_BYTES_V2];
    getrandom::fill(&mut entropy).map_err(|error| {
        KernelClientError::Bootstrap(format!(
            "operating-system CSPRNG could not create Host admission authority: {error}"
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
    let authority = rest.split('/').next()?.split('@').next_back()?;
    if authority.is_empty() {
        return None;
    }
    if let Some(after_bracket) = authority.strip_prefix('[') {
        let (host, tail) = after_bracket.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| default_port_for_scheme(scheme).to_string());
        return Some((host.to_string(), port));
    }
    let (host, port) = authority
        .rsplit_once(':')
        .map(|(host, port)| (host.to_string(), port.to_string()))
        .unwrap_or_else(|| {
            (
                authority.to_string(),
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
    host_shell_capability: &str,
    host_instance_id: &str,
) -> KernelClientResult<OwnedKernelProcess> {
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
        .env(HOST_SHELL_CAPABILITY_ENV_V2, host_shell_capability)
        .env(HOST_INSTANCE_ID_ENV_V2, host_instance_id)
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
        return Ok(OwnedKernelProcess {
            child,
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
        return Ok(OwnedKernelProcess { child, job });
    }
}

fn terminate_owned_kernel_process(process: &mut OwnedKernelProcess) {
    if process.child.try_wait().ok().flatten().is_some() {
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
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            unsafe {
                CloseHandle(handle);
            }
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            handle: Some(handle),
        })
    }

    fn assign(&self, child: &Child) -> std::io::Result<()> {
        let Some(handle) = self.handle else {
            return Err(std::io::Error::other("Kernel Job Object is closed"));
        };
        let process_handle = child.as_raw_handle() as HANDLE;
        if unsafe { AssignProcessToJobObject(handle, process_handle) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn close(&mut self) {
        if let Some(handle) = self.handle.take() {
            unsafe {
                CloseHandle(handle);
            }
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsKillOnCloseJob {
    fn drop(&mut self) {
        self.close();
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
