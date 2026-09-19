use super::*;
use deepcode_kernel_abi::{
    HostProcessIdentity, HOST_INSTANCE_ID_ENV, HOST_INSTANCE_ID_PREFIX, HOST_SHELL_TOKEN_PREFIX,
    HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS, HOST_TOKEN_ENTROPY_BYTES, KERNEL_DAEMON_SERVICE,
};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const KERNEL_LISTENER_STARTUP_WAIT: Duration = Duration::from_secs(6);
const KERNEL_STARTUP_PROBE_INTERVAL: Duration = Duration::from_millis(75);
const KERNEL_OWNED_SHUTDOWN_CONNECT_WAIT: Duration = Duration::from_millis(500);
const KERNEL_OWNED_SHUTDOWN_IO_WAIT: Duration =
    Duration::from_millis(HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS);
const KERNEL_OWNED_SHUTDOWN_EXIT_ATTEMPTS: usize = 200;

use deepcode_host_connection::process::{
    spawn_owned_host_process, terminate_owned_process_tree, wait_for_child_exit, OwnedHostProcess,
};
use deepcode_host_connection::{HostClientLease, HOST_LIFETIME_ENV};
#[cfg(all(test, unix))]
use std::os::unix::process::CommandExt;

#[derive(Clone)]
pub struct KernelBootstrapOptions {
    pub api: Option<String>,
    pub auto_start: bool,
    pub persistent: bool,
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
            persistent: false,
            host_shell_token: None,
        }
    }

    pub fn auto_start(mut self, auto_start: bool) -> Self {
        self.auto_start = auto_start;
        self
    }

    pub fn persistent(mut self, persistent: bool) -> Self {
        self.persistent = persistent;
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
    _client_lease: HostClientLease,
}

impl KernelBootstrap {
    fn attached(
        client: HttpKernelClient,
        mut guard: KernelBootstrapGuard,
        connection: &KernelClientConfig,
        persistent: bool,
    ) -> KernelClientResult<Self> {
        let token = connection
            .host_shell_token
            .as_ref()
            .ok_or(KernelClientError::HostConnectionTokenMissing)?;
        let lease = HostClientLease::connect(
            &client.config.base_url,
            token.expose_to_transport(),
            persistent,
        )
        .map_err(|error| {
            if let Some(process) = guard.process.as_mut() {
                terminate_owned_kernel_process(process);
            }
            KernelClientError::Bootstrap(format!("Host client registration failed: {error}"))
        })?;
        Ok(Self {
            client,
            _guard: guard,
            _client_lease: lease,
        })
    }

    pub async fn connect(options: KernelBootstrapOptions) -> KernelClientResult<Self> {
        let implicit_endpoint = options.api.is_none()
            && std::env::var_os("DEEPCODE_API_URL").is_none()
            && std::env::var_os("DEEPCODE_PORT").is_none();
        let _shared_start_guard;
        let shared_connection = if implicit_endpoint {
            let directories = deepcode_host_connection::UserDirectories::resolve()
                .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
            let root = directories.data_dir;
            _shared_start_guard = Some(
                deepcode_host_connection::HostStartGuard::acquire(&root)
                    .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?,
            );
            deepcode_host_connection::LocalHostConnection::discover(&root)
                .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?
        } else {
            _shared_start_guard = None;
            None
        };
        let mut config = options
            .api
            .map(KernelClientConfig::new)
            .unwrap_or_else(KernelClientConfig::from_env);
        if let Some(connection) = shared_connection {
            config.base_url = connection.identity.address.clone();
            if !config.has_host_shell_token() {
                config = config.with_host_shell_token(connection.shell_token());
            }
        } else if implicit_endpoint && kernel_auto_start_enabled(options.auto_start) {
            // A different config root may already use the conventional port.
            // New shared Hosts receive a private port; other shells discover it.
            let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| "127.0.0.1".into());
            let listener = std::net::TcpListener::bind((host.as_str(), 0))
                .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
            let address = listener
                .local_addr()
                .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
            config.base_url = format!("http://{address}");
        }
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
                return Self::attached(
                    client,
                    KernelBootstrapGuard::external(),
                    &config,
                    options.persistent,
                );
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
                        return Self::attached(
                            client,
                            KernelBootstrapGuard::external(),
                            &config,
                            options.persistent,
                        );
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
                return Self::attached(
                    client,
                    KernelBootstrapGuard::external(),
                    &config,
                    options.persistent,
                );
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
        let kernel_bin = find_kernel_binary()?.ok_or_else(|| {
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
                    // Startup owns failure cleanup. A ready service is shared by all shells.
                    #[cfg(windows)]
                    if let Err(error) = process.job.release_on_close() {
                        terminate_owned_kernel_process(&mut process);
                        return Err(KernelClientError::Bootstrap(error.to_string()));
                    }
                    return Self::attached(
                        client,
                        KernelBootstrapGuard::owned(process),
                        &owned_config,
                        options.persistent,
                    );
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
                        "owned Kernel process exited before authenticated health became ready: {status}; log: {}",
                        process.log_path.display()
                    )));
                }
                Ok(None) => {}
                Err(error) => {
                    terminate_owned_kernel_process(&mut process);
                    return Err(KernelClientError::Bootstrap(format!(
                        "failed to observe the owned Kernel process: {error}; log: {}",
                        process.log_path.display()
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
            "kernel did not become healthy at {}; log: {}",
            owned_config.base_url,
            process.log_path.display()
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
        // The connection lease notifies the Host; only the Host decides whether work permits exit.
        drop(self.process.take());
    }
}

struct OwnedKernelProcess {
    process: OwnedHostProcess,
    log_path: PathBuf,
    shutdown_target: OwnedKernelShutdownTarget,
}
impl std::ops::Deref for OwnedKernelProcess {
    type Target = OwnedHostProcess;
    fn deref(&self) -> &Self::Target {
        &self.process
    }
}
impl std::ops::DerefMut for OwnedKernelProcess {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.process
    }
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

fn find_kernel_binary() -> KernelClientResult<Option<PathBuf>> {
    if let Some(path) = std::env::var_os("DEEPCODE_KERNEL_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Ok(Some(path));
        }
        return Err(KernelClientError::Bootstrap(format!(
            "DEEPCODE_KERNEL_BIN points to a missing file: {}",
            path.display()
        )));
    }

    let executable =
        std::env::current_exe().map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    let directory = executable.parent().ok_or_else(|| {
        KernelClientError::Bootstrap("executable directory is unavailable".into())
    })?;
    let candidate = directory.join(format!("deepcode-kernel{}", std::env::consts::EXE_SUFFIX));
    Ok(candidate.is_file().then_some(candidate))
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
    let directories = deepcode_host_connection::UserDirectories::resolve()
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    let (log_file, log_path) = open_kernel_log_file(&directories.log_dir)?;
    let stderr = log_file.try_clone().map_err(|error| {
        KernelClientError::Bootstrap(format!("failed to clone kernel log handle: {error}"))
    })?;
    let mut command = Command::new(kernel_bin);
    directories.configure_child(&mut command);
    command
        .current_dir(&kernel_dir)
        .env(
            "DEEPCODE_RUNTIME_DIR",
            deepcode_host_connection::runtime_root(&kernel_dir),
        )
        .env("DEEPCODE_HOST", host)
        .env("DEEPCODE_PORT", port)
        .env(HOST_SHELL_TOKEN_ENV, host_shell_token)
        .env(HOST_INSTANCE_ID_ENV, host_instance_id)
        .env(HOST_LIFETIME_ENV, "automatic")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr));

    let process = spawn_owned_host_process(&mut command).map_err(|error| {
        KernelClientError::Bootstrap(format!("failed to start {}: {error}", kernel_bin.display()))
    })?;
    let shutdown_target = owned_kernel_shutdown_target(
        host,
        port_number,
        host_shell_token,
        host_instance_id,
        process.child.id(),
    );
    Ok(OwnedKernelProcess {
        process,
        log_path,
        shutdown_target,
    })
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
        && wait_for_child_exit(process, KERNEL_OWNED_SHUTDOWN_EXIT_ATTEMPTS)
    {
        let _ = process.child.wait();
        return;
    }
    terminate_owned_process_tree(&mut process.process);
}

fn request_owned_kernel_graceful_shutdown(target: &OwnedKernelShutdownTarget) -> bool {
    let Some(identity) = target.expected_identity.as_ref() else {
        return false;
    };
    deepcode_host_connection::shell_lifecycle::request_daemon_shutdown(
        &target.host,
        &target.port.to_string(),
        &target.host_shell_token,
        identity,
    )
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
    let temporary = deepcode_host_connection::UserDirectories::resolve()
        .and_then(|directories| {
            std::fs::create_dir_all(&directories.temp_dir)?;
            Ok(directories.temp_dir)
        })
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    let path = temporary.join(format!(
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

fn open_kernel_log_file(log_dir: &Path) -> KernelClientResult<(File, PathBuf)> {
    open_log_in_dir(log_dir).map_err(|error| {
        KernelClientError::Bootstrap(format!(
            "failed to open kernel log at {}: {error}",
            log_dir.display()
        ))
    })
}

fn open_log_in_dir(log_dir: &Path) -> std::io::Result<(File, PathBuf)> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join("deepcode-kernel.log");
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((file, path))
}

#[cfg(all(test, unix))]
mod ownership_tests {
    use super::*;

    #[test]
    fn closing_a_client_leaves_the_ready_host_running() {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id() as libc::pid_t;
        let guard = KernelBootstrapGuard::owned(OwnedKernelProcess {
            process: OwnedHostProcess {
                child,
                process_group_id: pid,
            },
            log_path: PathBuf::from("unused-test-log"),
            shutdown_target: OwnedKernelShutdownTarget {
                host: "127.0.0.1".into(),
                port: 0,
                host_shell_token: String::new(),
                expected_instance_id: "fixture".into(),
                expected_pid: pid as u32,
                expected_identity: None,
            },
        });
        drop(guard);
        let mut status = 0;
        let still_running = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) == 0 };
        // Reclaim only this test's child, including when the assertion fails.
        if still_running {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::waitpid(pid, &mut status, 0);
            }
        }
        assert!(
            still_running,
            "a client exit must not terminate the shared Host"
        );
    }
}
