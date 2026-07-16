use super::*;

#[derive(Debug, Clone)]
pub struct KernelBootstrapOptions {
    pub api: Option<String>,
    pub auto_start: bool,
}

impl KernelBootstrapOptions {
    pub fn new(api: Option<String>) -> Self {
        Self {
            api,
            auto_start: true,
        }
    }

    pub fn auto_start(mut self, auto_start: bool) -> Self {
        self.auto_start = auto_start;
        self
    }
}

pub struct KernelBootstrap {
    client: HttpKernelClient,
    _guard: KernelBootstrapGuard,
}

impl KernelBootstrap {
    pub async fn connect(options: KernelBootstrapOptions) -> KernelClientResult<Self> {
        let config = options
            .api
            .map(KernelClientConfig::new)
            .unwrap_or_else(KernelClientConfig::from_env);
        let client = HttpKernelClient::new(config);
        if probe_kernel_health(&client).await {
            return Ok(Self {
                client,
                _guard: KernelBootstrapGuard::external(),
            });
        }

        if !kernel_auto_start_enabled(options.auto_start) {
            return Ok(Self {
                client,
                _guard: KernelBootstrapGuard::external(),
            });
        }

        if !is_local_kernel_url(client.base_url()) {
            return Ok(Self {
                client,
                _guard: KernelBootstrapGuard::external(),
            });
        }

        let (host, port) = parse_kernel_host_port(client.base_url()).ok_or_else(|| {
            KernelClientError::Bootstrap(format!(
                "cannot resolve local host/port from {}",
                client.base_url()
            ))
        })?;
        let Some(_start_lock) = acquire_kernel_start_lock(&host, &port)? else {
            for _ in 0..80 {
                if probe_kernel_health(&client).await {
                    return Ok(Self {
                        client,
                        _guard: KernelBootstrapGuard::external(),
                    });
                }
                std::thread::sleep(Duration::from_millis(75));
            }
            return Err(KernelClientError::Bootstrap(format!(
                "kernel start is already in progress for {} but did not become healthy",
                client.base_url()
            )));
        };
        if probe_kernel_health(&client).await {
            return Ok(Self {
                client,
                _guard: KernelBootstrapGuard::external(),
            });
        }
        let kernel_bin = find_kernel_binary().ok_or_else(|| {
            KernelClientError::Bootstrap(
                "cannot find deepcode-kernel or deepcode-kernel-daemon; set DEEPCODE_KERNEL_BIN"
                    .to_string(),
            )
        })?;
        let mut child = spawn_kernel_binary(&kernel_bin, &host, &port)?;

        for _ in 0..80 {
            if probe_kernel_health(&client).await {
                return Ok(Self {
                    client,
                    _guard: KernelBootstrapGuard::owned(child),
                });
            }
            std::thread::sleep(Duration::from_millis(75));
        }

        let _ = child.kill();
        let _ = child.wait();
        Err(KernelClientError::Bootstrap(format!(
            "kernel did not become healthy at {}",
            client.base_url()
        )))
    }

    pub fn client(&self) -> &HttpKernelClient {
        &self.client
    }
}

pub struct KernelBootstrapGuard {
    child: Option<Child>,
}

impl KernelBootstrapGuard {
    fn external() -> Self {
        Self { child: None }
    }

    fn owned(child: Child) -> Self {
        Self { child: Some(child) }
    }
}

impl Drop for KernelBootstrapGuard {
    fn drop(&mut self) {
        // The daemon outlives one-shot clients; dropping Child detaches without terminating it.
        let _ = self.child.take();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub service: String,
    pub ok: bool,
    pub raw: Value,
}

async fn probe_kernel_health(client: &HttpKernelClient) -> bool {
    if !probe_kernel_tcp(client.base_url()) {
        return false;
    }
    matches!(client.health().await, Ok(status) if status.ok)
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

fn spawn_kernel_binary(kernel_bin: &Path, host: &str, port: &str) -> KernelClientResult<Child> {
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
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr));

    #[cfg(unix)]
    command.process_group(0);

    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    command.spawn().map_err(|error| {
        KernelClientError::Bootstrap(format!("failed to start {}: {error}", kernel_bin.display()))
    })
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
