#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use deepcode_kernel_abi::{
    is_valid_host_instance_id_v2, is_valid_host_shell_capability_v2,
    is_valid_host_ui_capability_v2, HOST_AUTHORITY_ENTROPY_BYTES_V2, HOST_INSTANCE_ID_ENV_V2,
    HOST_INSTANCE_ID_PREFIX_V2, HOST_SHELL_CAPABILITY_ENV_V2, HOST_SHELL_CAPABILITY_HEADER_V2,
    HOST_SHELL_CAPABILITY_PREFIX_V2, HOST_UI_CAPABILITY_ENV_V2, HOST_UI_CAPABILITY_HEADER_V2,
    HOST_UI_CAPABILITY_PREFIX_V2,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::HANDLE;
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "31245";
const APP_ASSET_SCHEME: &str = "deepcode-editor";
const APP_ASSET_DIR: &str = "web";

struct HostProcessGroup {
    children: Mutex<Option<OwnedHostChildren>>,
}

struct OwnedHostChildren {
    daemon: OwnedHostProcess,
    proxy: OwnedHostProcess,
    daemon_host: String,
    daemon_port: String,
    daemon_capability: String,
    instance_id: String,
}

struct OwnedHostProcess {
    child: Child,
    #[cfg(unix)]
    process_group_id: libc::pid_t,
    #[cfg(windows)]
    job: WindowsKillOnCloseJob,
}

#[cfg(windows)]
struct WindowsKillOnCloseJob {
    handle: Option<OwnedHandle>,
}

impl HostProcessGroup {
    fn new(children: Option<OwnedHostChildren>) -> Self {
        Self {
            children: Mutex::new(children),
        }
    }

    fn replace(&self, children: Option<OwnedHostChildren>) {
        if let Ok(mut current) = self.children.lock() {
            if let Some(mut processes) = current.take() {
                processes.shutdown();
            }
            *current = children;
        }
    }

    fn terminate(&self) {
        if let Ok(mut children) = self.children.lock() {
            if let Some(mut processes) = children.take() {
                processes.shutdown();
            }
        }
    }
}

impl OwnedHostChildren {
    fn shutdown(&mut self) {
        let requested = request_daemon_shutdown(
            &self.daemon_host,
            &self.daemon_port,
            &self.daemon_capability,
            &self.instance_id,
            self.daemon.child.id(),
        );
        terminate_owned_process_tree(&mut self.proxy);
        if !requested || !wait_for_child_exit(&mut self.daemon, 80) {
            terminate_owned_process_tree(&mut self.daemon);
        }
    }
}

impl Drop for HostProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol(APP_ASSET_SCHEME, |_ctx, request| {
            serve_bundled_asset(APP_ASSET_DIR, request)
        })
        .invoke_handler(tauri::generate_handler![
            deepcode_boot_target,
            deepcode_start_kernel_after_permission,
            deepcode_window_minimize,
            deepcode_window_toggle_maximize,
            deepcode_window_close
        ])
        .setup(|app| {
            let target = resolve_launch_target();
            let host_admission = HostAdmissionCapabilities::resolve()?;
            app.manage(target.clone());
            app.manage(host_admission.clone());
            app.manage(HostProcessGroup::new(None));
            create_main_window(app, &target, &host_admission)?;
            if startup_permission_preflight(APP_ASSET_DIR) {
                let children = spawn_host_processes_if_available(&target, &host_admission);
                app.state::<HostProcessGroup>().replace(children);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                window.state::<HostProcessGroup>().terminate();
                window.app_handle().exit(0);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build DeepCode Tauri shell");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            app_handle.state::<HostProcessGroup>().terminate();
        }
        _ => {}
    });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchTarget {
    host: String,
    port: String,
    #[serde(skip)]
    daemon_port: String,
}

#[derive(Clone)]
struct HostAdmissionCapabilities {
    daemon: String,
    proxy: String,
    instance_id: String,
}

impl HostAdmissionCapabilities {
    fn resolve() -> Result<Self, std::io::Error> {
        let daemon = resolve_capability(
            HOST_SHELL_CAPABILITY_ENV_V2,
            HOST_SHELL_CAPABILITY_PREFIX_V2,
            is_valid_host_shell_capability_v2,
        )?;
        let proxy = resolve_capability(
            HOST_UI_CAPABILITY_ENV_V2,
            HOST_UI_CAPABILITY_PREFIX_V2,
            is_valid_host_ui_capability_v2,
        )?;
        if daemon == proxy {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Host UI and daemon capabilities must be independent",
            ));
        }
        let instance_id =
            generate_local_identity(HOST_INSTANCE_ID_PREFIX_V2, is_valid_host_instance_id_v2)?;
        Ok(Self {
            daemon,
            proxy,
            instance_id,
        })
    }

    fn daemon_capability(&self) -> &str {
        &self.daemon
    }

    fn proxy_capability(&self) -> &str {
        &self.proxy
    }

    fn instance_id(&self) -> &str {
        &self.instance_id
    }
}

fn resolve_capability(
    environment_key: &str,
    prefix: &str,
    validator: fn(&str) -> bool,
) -> Result<String, std::io::Error> {
    if let Ok(value) = std::env::var(environment_key) {
        if validator(&value) {
            return Ok(value);
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{environment_key} is malformed"),
        ));
    }
    generate_local_identity(prefix, validator)
}

fn generate_local_identity(
    prefix: &str,
    validator: fn(&str) -> bool,
) -> Result<String, std::io::Error> {
    let mut entropy = [0_u8; HOST_AUTHORITY_ENTROPY_BYTES_V2];
    getrandom::fill(&mut entropy)
        .map_err(|error| std::io::Error::other(format!("generate local identity: {error}")))?;
    let mut encoded = String::with_capacity(HOST_AUTHORITY_ENTROPY_BYTES_V2 * 2);
    for byte in entropy {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    let value = format!("{prefix}{encoded}");
    if validator(&value) {
        Ok(value)
    } else {
        Err(std::io::Error::other(
            "generated Host authority value does not satisfy the v2 format",
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostIdentityV2 {
    service: String,
    instance_id: String,
    pid: u32,
    address: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostShutdownReceiptV2 {
    accepted: bool,
    identity: HostIdentityV2,
    cleanup_complete: bool,
}

#[derive(Debug, Deserialize)]
struct HostApiEnvelopeV2<T> {
    ok: bool,
    data: Option<T>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelStartResult {
    started: bool,
    blocked: bool,
    message: String,
}

#[tauri::command]
fn deepcode_boot_target(target: State<'_, LaunchTarget>) -> LaunchTarget {
    target.inner().clone()
}

#[tauri::command]
fn deepcode_start_kernel_after_permission(
    target: State<'_, LaunchTarget>,
    host_admission: State<'_, HostAdmissionCapabilities>,
    processes: State<'_, HostProcessGroup>,
) -> KernelStartResult {
    if !startup_permission_preflight(APP_ASSET_DIR) {
        return KernelStartResult {
            started: false,
            blocked: true,
            message: "startup permission preflight did not complete".to_string(),
        };
    }

    if local_port_has_listener(&target.host, &target.port)
        || local_port_has_listener(&target.host, &target.daemon_port)
    {
        return KernelStartResult {
            started: false,
            blocked: false,
            message: "a required private Host port is already in use".to_string(),
        };
    }
    let children = spawn_host_processes_if_available(&target, &host_admission);
    let started = children.is_some();
    if started {
        processes.replace(children);
    }
    KernelStartResult {
        started,
        blocked: false,
        message: if started {
            "kernel start requested".to_string()
        } else {
            "kernel binary was not found or could not be started".to_string()
        },
    }
}

#[tauri::command]
fn deepcode_window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|err| err.to_string())
}

#[tauri::command]
fn deepcode_window_toggle_maximize(window: Window) -> Result<(), String> {
    if window.is_maximized().map_err(|err| err.to_string())? {
        window.unmaximize().map_err(|err| err.to_string())
    } else {
        window.maximize().map_err(|err| err.to_string())
    }
}

#[tauri::command]
fn deepcode_window_close(window: Window) -> Result<(), String> {
    window.close().map_err(|err| err.to_string())
}

fn resolve_launch_target() -> LaunchTarget {
    let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string());
    assert!(
        is_loopback_host(&host),
        "DeepCode desktop Host requires a loopback target"
    );
    let port = std::env::var("DEEPCODE_PORT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if local_port_is_available(&host, DEFAULT_PORT) {
                DEFAULT_PORT.to_string()
            } else {
                available_local_port(&host).unwrap_or_else(|| DEFAULT_PORT.to_string())
            }
        });
    let daemon_port = available_local_port(&host)
        .filter(|candidate| candidate != &port)
        .expect("available loopback daemon port");
    LaunchTarget {
        host,
        port,
        daemon_port,
    }
}

fn create_main_window(
    app: &tauri::App,
    target: &LaunchTarget,
    host_admission: &HostAdmissionCapabilities,
) -> Result<(), Box<dyn std::error::Error>> {
    let boot_url = format!("{APP_ASSET_SCHEME}://localhost/index.html");
    let initialization_script = format!(
        "Object.defineProperty(window,'__DEEPCODE_HOST_BOOT_V2__',{{value:Object.freeze({{schemaVersion:'deepcode.host-ui-bootstrap.v2',host:'{}',port:'{}',proxyCapability:'{}'}}),writable:false,configurable:true}});",
        target.host,
        target.port,
        host_admission.proxy_capability()
    );
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(boot_url.parse()?))
        .initialization_script(initialization_script)
        .on_navigation(trusted_app_navigation)
        .title("DeepCode")
        .inner_size(1500.0, 900.0)
        .min_inner_size(1100.0, 700.0)
        .resizable(true)
        .fullscreen(false)
        .decorations(false)
        .background_color(tauri::window::Color(10, 10, 12, 255))
        .build()?;
    Ok(())
}

fn trusted_app_navigation(url: &tauri::Url) -> bool {
    (url.scheme() == APP_ASSET_SCHEME && url.host_str() == Some("localhost"))
        || (url.scheme() == "http"
            && url.host_str() == Some(concat!("deepcode-editor", ".localhost")))
}

fn startup_permission_preflight(web_dir_name: &str) -> bool {
    if env_truthy("DEEPCODE_SKIP_STARTUP_PERMISSION_PREFLIGHT") || !cfg!(target_os = "macos") {
        return true;
    }

    let Some(exe_dir) = current_exe_dir() else {
        return true;
    };
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("DEEPCODE_CONFIG_DIR").map(PathBuf::from) {
        paths.push(path);
    }
    if let Some(path) = std::env::var_os("DEEPCODE_CLIENT_DIST").map(PathBuf::from) {
        paths.push(path);
    }
    if let Some(path) = std::env::var_os("DEEPCODE_DEFAULT_WORKSPACE").map(PathBuf::from) {
        paths.push(path);
    }
    if let Some(path) = find_bundled_dir(&exe_dir, web_dir_name) {
        paths.push(path);
    }
    if let Some(path) = package_root(&exe_dir) {
        paths.push(path);
    }

    paths.iter().all(|path| path_permission_available(path))
}

fn path_permission_available(path: &Path) -> bool {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => return error.kind() != std::io::ErrorKind::PermissionDenied,
    };
    if metadata.is_dir() {
        return match std::fs::read_dir(path) {
            Ok(mut entries) => {
                let _ = entries.next();
                true
            }
            Err(error) => error.kind() != std::io::ErrorKind::PermissionDenied,
        };
    }
    match std::fs::File::open(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::PermissionDenied,
    }
}

fn serve_bundled_asset(web_dir_name: &str, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match resolve_asset_path(web_dir_name, request.uri().path()) {
        Ok(path) => match std::fs::read(&path) {
            Ok(bytes) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type_for_path(&path))
                .body(bytes)
                .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR)),
            Err(_) => text_response(StatusCode::NOT_FOUND, "asset not found"),
        },
        Err(message) => text_response(StatusCode::BAD_REQUEST, &message),
    }
}

fn resolve_asset_path(web_dir_name: &str, uri_path: &str) -> Result<PathBuf, String> {
    let exe_dir =
        current_exe_dir().ok_or_else(|| "failed to resolve executable directory".to_string())?;
    let web_root =
        find_bundled_dir(&exe_dir, web_dir_name).unwrap_or_else(|| exe_dir.join(web_dir_name));
    let requested = uri_path.trim_start_matches('/');
    let relative = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let relative_path = Path::new(relative);

    if relative_path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("invalid asset path".to_string());
    }

    Ok(web_root.join(relative_path))
}

fn text_response(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body.as_bytes().to_vec())
        .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("empty response should be valid")
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

fn spawn_host_processes_if_available(
    target: &LaunchTarget,
    host_admission: &HostAdmissionCapabilities,
) -> Option<OwnedHostChildren> {
    if env_truthy("DEEPCODE_SHELL_CONNECT_ONLY") {
        return None;
    }
    if local_port_has_listener(&target.host, &target.port)
        || local_port_has_listener(&target.host, &target.daemon_port)
    {
        return None;
    }
    let _start_lock = acquire_kernel_start_lock(&target.host, &target.port)?;
    if local_port_has_listener(&target.host, &target.port)
        || local_port_has_listener(&target.host, &target.daemon_port)
    {
        return None;
    }

    let exe_dir = current_exe_dir()?;
    let daemon_path =
        configured_or_bundled_file("DEEPCODE_KERNEL_DAEMON_BIN", &exe_dir, kernel_binary_name())?;
    let proxy_path =
        configured_or_bundled_file("DEEPCODE_HOST_WEB_BIN", &exe_dir, host_web_binary_name())?;
    let daemon_dir = parent_dir(&daemon_path).unwrap_or_else(|| exe_dir.clone());
    let proxy_dir = parent_dir(&proxy_path).unwrap_or_else(|| exe_dir.clone());
    let config_root = std::env::var_os("DEEPCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| package_root(&exe_dir).unwrap_or_else(|| daemon_dir.clone()));

    let web_dir = std::env::var("DEEPCODE_CLIENT_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            find_bundled_dir(&exe_dir, "web").unwrap_or_else(|| proxy_dir.join("web"))
        });

    let mut daemon_command = Command::new(daemon_path);
    daemon_command
        .current_dir(&daemon_dir)
        .env("DEEPCODE_HOST", &target.host)
        .env("DEEPCODE_PORT", &target.daemon_port)
        .env("DEEPCODE_CONFIG_DIR", config_root)
        .env_remove(HOST_UI_CAPABILITY_ENV_V2)
        .env(
            HOST_SHELL_CAPABILITY_ENV_V2,
            host_admission.daemon_capability(),
        )
        .env(HOST_INSTANCE_ID_ENV_V2, host_admission.instance_id())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut daemon = spawn_owned_host_process(&mut daemon_command).ok()?;
    if !wait_for_public_identity(
        &mut daemon,
        &target.host,
        &target.daemon_port,
        "deepcode-kernel-daemon",
        host_admission.instance_id(),
        40,
    ) || !wait_for_authenticated_health(
        &mut daemon,
        &target.host,
        &target.daemon_port,
        HOST_SHELL_CAPABILITY_HEADER_V2,
        host_admission.daemon_capability(),
        40,
    ) {
        terminate_owned_process_tree(&mut daemon);
        return None;
    }

    let mut proxy_command = Command::new(proxy_path);
    proxy_command
        .current_dir(&proxy_dir)
        .env("DEEPCODE_HOST", &target.host)
        .env("DEEPCODE_PORT", &target.port)
        .env("DEEPCODE_DAEMON_HOST", &target.host)
        .env("DEEPCODE_DAEMON_PORT", &target.daemon_port)
        .env("DEEPCODE_HOST_WEB_SPAWN_DAEMON", "0")
        .env("DEEPCODE_CLIENT_DIST", web_dir)
        .env(HOST_UI_CAPABILITY_ENV_V2, host_admission.proxy_capability())
        .env(
            HOST_SHELL_CAPABILITY_ENV_V2,
            host_admission.daemon_capability(),
        )
        .env(HOST_INSTANCE_ID_ENV_V2, host_admission.instance_id())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut proxy = match spawn_owned_host_process(&mut proxy_command) {
        Ok(proxy) => proxy,
        Err(_) => {
            shutdown_daemon_process(
                &mut daemon,
                &target.host,
                &target.daemon_port,
                host_admission.daemon_capability(),
                host_admission.instance_id(),
            );
            return None;
        }
    };
    if !wait_for_public_identity(
        &mut proxy,
        &target.host,
        &target.port,
        "deepcode-host-web",
        host_admission.instance_id(),
        40,
    ) || !wait_for_authenticated_health(
        &mut proxy,
        &target.host,
        &target.port,
        HOST_UI_CAPABILITY_HEADER_V2,
        host_admission.proxy_capability(),
        40,
    ) {
        terminate_owned_process_tree(&mut proxy);
        shutdown_daemon_process(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            host_admission.daemon_capability(),
            host_admission.instance_id(),
        );
        return None;
    }
    Some(OwnedHostChildren {
        daemon,
        proxy,
        daemon_host: target.host.clone(),
        daemon_port: target.daemon_port.clone(),
        daemon_capability: host_admission.daemon_capability().to_string(),
        instance_id: host_admission.instance_id().to_string(),
    })
}

fn configured_or_bundled_file(
    environment_key: &str,
    exe_dir: &Path,
    bundled_name: &str,
) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(environment_key).map(PathBuf::from) {
        return path
            .is_absolute()
            .then_some(path)
            .filter(|path| path.is_file());
    }
    find_bundled_file(exe_dir, bundled_name)
}

struct KernelStartLock {
    path: PathBuf,
}

impl Drop for KernelStartLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_kernel_start_lock(host: &str, port: &str) -> Option<KernelStartLock> {
    let path = std::env::temp_dir().join(format!(
        "deepcode-kernel-start-{}-{}.lock",
        sanitize_lock_component(host),
        sanitize_lock_component(port)
    ));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            let _ = std::io::Write::write_all(
                &mut file,
                format!("pid={}\n", std::process::id()).as_bytes(),
            );
            Some(KernelStartLock { path })
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if kernel_start_lock_is_stale(&path) {
                let _ = std::fs::remove_file(&path);
                return acquire_kernel_start_lock(host, port);
            }
            wait_for_kernel_listener(host, port, 40);
            None
        }
        Err(_) => None,
    }
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

fn wait_for_kernel_listener(host: &str, port: &str, attempts: usize) -> bool {
    for _ in 0..attempts {
        if local_port_has_listener(host, port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(75));
    }
    false
}

fn wait_for_authenticated_health(
    process: &mut OwnedHostProcess,
    host: &str,
    port: &str,
    capability_header: &str,
    capability: &str,
    attempts: usize,
) -> bool {
    for _ in 0..attempts {
        match process.child.try_wait() {
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) => {}
        }
        if authenticated_health_ready(host, port, capability_header, capability) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(75));
    }
    false
}

fn wait_for_public_identity(
    process: &mut OwnedHostProcess,
    host: &str,
    port: &str,
    expected_service: &str,
    expected_instance_id: &str,
    attempts: usize,
) -> bool {
    let expected_pid = process.child.id();
    for _ in 0..attempts {
        match process.child.try_wait() {
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) => {}
        }
        if public_identity_matches(
            host,
            port,
            expected_service,
            expected_instance_id,
            expected_pid,
        ) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(75));
    }
    false
}

fn public_identity_matches(
    host: &str,
    port: &str,
    expected_service: &str,
    expected_instance_id: &str,
    expected_pid: u32,
) -> bool {
    let request = http_request(host, port, "GET", "/api/host/identity", &[]);
    let Some(envelope) =
        request_loopback_json::<HostApiEnvelopeV2<HostIdentityV2>>(host, port, &request, 300)
    else {
        return false;
    };
    let Some(identity) = envelope.ok.then_some(envelope.data).flatten() else {
        return false;
    };
    identity.service == expected_service
        && identity.instance_id == expected_instance_id
        && identity.pid == expected_pid
        && identity.address == loopback_http_address(host, port)
}

fn authenticated_health_ready(
    host: &str,
    port: &str,
    capability_header: &str,
    capability: &str,
) -> bool {
    let Ok(port_number) = port.parse::<u16>() else {
        return false;
    };
    let Ok(addrs) = (host, port_number).to_socket_addrs() else {
        return false;
    };
    let request = http_request(
        host,
        port,
        "GET",
        "/api/health",
        &[(capability_header, capability)],
    );
    addrs.into_iter().any(|addr| {
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(180)) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }
        let mut response = Vec::with_capacity(4096);
        let _ = stream.take(64 * 1024).read_to_end(&mut response);
        response.starts_with(b"HTTP/1.1 200")
            && response
                .windows(br#""ok":true"#.len())
                .any(|window| window == br#""ok":true"#)
    })
}

fn request_daemon_shutdown(
    host: &str,
    port: &str,
    capability: &str,
    instance_id: &str,
    pid: u32,
) -> bool {
    let request = http_request(
        host,
        port,
        "POST",
        "/api/host/shutdown",
        &[(HOST_SHELL_CAPABILITY_HEADER_V2, capability)],
    );
    let Some(envelope) = request_loopback_json::<HostApiEnvelopeV2<HostShutdownReceiptV2>>(
        host, port, &request, 600,
    ) else {
        return false;
    };
    let Some(receipt) = envelope.ok.then_some(envelope.data).flatten() else {
        return false;
    };
    receipt.accepted
        && receipt.cleanup_complete
        && receipt.identity.service == "deepcode-kernel-daemon"
        && receipt.identity.instance_id == instance_id
        && receipt.identity.pid == pid
        && receipt.identity.address == loopback_http_address(host, port)
}

fn shutdown_daemon_process(
    process: &mut OwnedHostProcess,
    host: &str,
    port: &str,
    capability: &str,
    instance_id: &str,
) {
    if !request_daemon_shutdown(host, port, capability, instance_id, process.child.id())
        || !wait_for_child_exit(process, 80)
    {
        terminate_owned_process_tree(process);
    }
}

fn wait_for_child_exit(process: &mut OwnedHostProcess, attempts: usize) -> bool {
    for _ in 0..attempts {
        match process.child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
    false
}

fn terminate_owned_process_tree(process: &mut OwnedHostProcess) {
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
        if !wait_for_child_exit(process, 20) {
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
        if !wait_for_child_exit(process, 20) {
            let _ = process.child.kill();
        }
    }
    let _ = process.child.wait();
}

fn spawn_owned_host_process(command: &mut Command) -> std::io::Result<OwnedHostProcess> {
    #[cfg(unix)]
    {
        command.process_group(0);
        let mut child = command.spawn()?;
        let pid = child.id() as libc::pid_t;
        let process_group_id = unsafe { libc::getpgid(pid) };
        if process_group_id <= 0 || process_group_id != pid {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other(
                "spawned Host child did not enter its exact owned process group",
            ));
        }
        return Ok(OwnedHostProcess {
            child,
            process_group_id,
        });
    }
    #[cfg(windows)]
    {
        let job = WindowsKillOnCloseJob::new()?;
        command.creation_flags(0x0800_0200);
        let mut child = command.spawn()?;
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        return Ok(OwnedHostProcess { child, job });
    }
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
            return Err(std::io::Error::other("Host Job Object is closed"));
        };
        let process_handle = child.as_raw_handle() as HANDLE;
        if unsafe {
            AssignProcessToJobObject(handle.as_raw_handle() as HANDLE, process_handle)
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn close(&mut self) {
        drop(self.handle.take());
    }
}

fn http_request(
    host: &str,
    port: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> String {
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {authority}\r\n");
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
    request
}

fn request_loopback_json<T: DeserializeOwned>(
    host: &str,
    port: &str,
    request: &str,
    read_timeout_millis: u64,
) -> Option<T> {
    let port_number = port.parse::<u16>().ok()?;
    let addrs = (host, port_number).to_socket_addrs().ok()?;
    addrs.into_iter().find_map(|addr| {
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(180)).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_millis(read_timeout_millis)))
            .ok()?;
        stream
            .set_write_timeout(Some(Duration::from_millis(300)))
            .ok()?;
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = Vec::with_capacity(4096);
        stream.take(64 * 1024).read_to_end(&mut response).ok()?;
        if !response.starts_with(b"HTTP/1.1 200") {
            return None;
        }
        let body_offset = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|offset| offset + 4)?;
        serde_json::from_slice(&response[body_offset..]).ok()
    })
}

fn loopback_http_address(host: &str, port: &str) -> String {
    if host.contains(':') {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    }
}

fn local_port_has_listener(host: &str, port: &str) -> bool {
    let Ok(port) = port.parse::<u16>() else {
        return false;
    };
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(180)).is_ok())
}

fn available_local_port(host: &str) -> Option<String> {
    TcpListener::bind((host, 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port().to_string())
}

fn local_port_is_available(host: &str, port: &str) -> bool {
    let Ok(port) = port.parse::<u16>() else {
        return false;
    };
    TcpListener::bind((host, port)).is_ok()
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| parent_dir(&path))
}

fn parent_dir(path: &Path) -> Option<PathBuf> {
    path.parent().map(Path::to_path_buf)
}

fn find_bundled_file(exe_dir: &Path, name: &str) -> Option<PathBuf> {
    bundled_candidates(exe_dir, name)
        .into_iter()
        .find(|path| path.is_file())
}

fn find_bundled_dir(exe_dir: &Path, name: &str) -> Option<PathBuf> {
    bundled_candidates(exe_dir, name)
        .into_iter()
        .find(|path| path.is_dir())
}

fn bundled_candidates(exe_dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut candidates = vec![exe_dir.join(name)];
    if cfg!(target_os = "macos") {
        if let Some(contents_dir) = exe_dir.parent() {
            candidates.push(contents_dir.join("Resources").join(name));
        }
    }
    candidates
}

fn package_root(exe_dir: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return exe_dir
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(Path::to_path_buf);
    }
    Some(exe_dir.to_path_buf())
}

fn kernel_binary_name() -> &'static str {
    if cfg!(windows) {
        "deepcode-kernel.exe"
    } else {
        "deepcode-kernel"
    }
}

fn host_web_binary_name() -> &'static str {
    if cfg!(windows) {
        "deepcode-host-web.exe"
    } else {
        "deepcode-host-web"
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host.trim(), "127.0.0.1" | "::1" | "localhost")
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}
