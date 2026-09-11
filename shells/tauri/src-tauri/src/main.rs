#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use deepcode_host_connection::{HostStartupStatusV1, HOST_STARTUP_STATUS_SCHEMA};
use deepcode_kernel_abi::{
    is_valid_host_instance_id, is_valid_host_shell_token, is_valid_host_ui_token,
    HostProcessIdentity, HostShutdownReceipt, HostShutdownRequest, HOST_INSTANCE_ID_ENV,
    HOST_INSTANCE_ID_PREFIX, HOST_SHELL_TOKEN_ENV, HOST_SHELL_TOKEN_HEADER,
    HOST_SHELL_TOKEN_PREFIX, HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS, HOST_TOKEN_ENTROPY_BYTES,
    HOST_UI_TOKEN_ENV, HOST_UI_TOKEN_HEADER, HOST_UI_TOKEN_PREFIX, KERNEL_DAEMON_SERVICE,
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
    daemon: Option<OwnedHostProcess>,
    start_guard: Option<deepcode_host_connection::HostStartGuard>,
    proxy: OwnedHostProcess,
    daemon_host: String,
    daemon_port: String,
    daemon_token: String,
    daemon_identity: HostProcessIdentity,
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

    fn replace(&self, mut children: Option<OwnedHostChildren>) {
        if let Ok(mut current) = self.children.lock() {
            if let Some(mut processes) = current.take() {
                processes.shutdown();
            }
            if let Some(children) = children.as_mut() {
                children.share_ready_daemon();
            }
            *current = children;
        }
    }

    fn detach(&self) {
        if let Ok(mut children) = self.children.lock() {
            if let Some(mut children) = children.take() {
                children.shutdown();
            }
        }
    }
}

impl OwnedHostChildren {
    fn share_ready_daemon(&mut self) {
        // Authenticated startup succeeded. From here the service outlives shells.
        drop(self.daemon.take());
        drop(self.start_guard.take());
    }

    fn shutdown(&mut self) {
        terminate_owned_process_tree(&mut self.proxy);
        shutdown_daemon_process(
            &mut self.daemon,
            &self.daemon_host,
            &self.daemon_port,
            &self.daemon_token,
            &self.daemon_identity,
        );
    }
}

impl Drop for HostProcessGroup {
    fn drop(&mut self) {
        self.detach();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol(APP_ASSET_SCHEME, |_ctx, request| {
            serve_bundled_asset(APP_ASSET_DIR, request)
        })
        .invoke_handler(tauri::generate_handler![
            deepcode_boot_target,
            deepcode_host_startup_status,
            deepcode_start_kernel_after_permission,
            deepcode_window_minimize,
            deepcode_window_toggle_maximize,
            deepcode_window_close,
            deepcode_open_external_url
        ])
        .setup(|app| {
            let target = resolve_launch_target();
            let host_tokens = HostConnectionTokens::resolve()?;
            app.manage(target.clone());
            app.manage(host_tokens.clone());
            app.manage(HostProcessGroup::new(None));
            app.manage(EditorStartupStatus::new());
            create_main_window(app, &target, &host_tokens)?;
            let result = deepcode_start_kernel_after_permission(
                app.state::<LaunchTarget>(),
                app.state::<HostConnectionTokens>(),
                app.state::<HostProcessGroup>(),
                app.state::<EditorStartupStatus>(),
            );
            if result.status.phase == "failed" {
                eprintln!("host_startup_failed: {}", result.message);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                window.state::<HostProcessGroup>().detach();
                window.app_handle().exit(0);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build DeepCode Tauri shell");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            app_handle.state::<HostProcessGroup>().detach();
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
struct HostConnectionTokens {
    daemon: String,
    proxy: String,
    instance_id: String,
}

impl HostConnectionTokens {
    fn resolve() -> Result<Self, std::io::Error> {
        let daemon = resolve_token(
            HOST_SHELL_TOKEN_ENV,
            HOST_SHELL_TOKEN_PREFIX,
            is_valid_host_shell_token,
        )?;
        let proxy = resolve_token(
            HOST_UI_TOKEN_ENV,
            HOST_UI_TOKEN_PREFIX,
            is_valid_host_ui_token,
        )?;
        if daemon == proxy {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Host UI 与 daemon 必须使用不同的本地连接令牌",
            ));
        }
        let instance_id =
            generate_local_identity(HOST_INSTANCE_ID_PREFIX, is_valid_host_instance_id)?;
        Ok(Self {
            daemon,
            proxy,
            instance_id,
        })
    }

    fn daemon_token(&self) -> &str {
        &self.daemon
    }

    fn ui_token(&self) -> &str {
        &self.proxy
    }

    fn instance_id(&self) -> &str {
        &self.instance_id
    }
}

fn resolve_token(
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
    let mut entropy = [0_u8; HOST_TOKEN_ENTROPY_BYTES];
    getrandom::fill(&mut entropy)
        .map_err(|error| std::io::Error::other(format!("generate local identity: {error}")))?;
    let mut encoded = String::with_capacity(HOST_TOKEN_ENTROPY_BYTES * 2);
    for byte in entropy {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    let value = format!("{prefix}{encoded}");
    if validator(&value) {
        Ok(value)
    } else {
        Err(std::io::Error::other("生成的 Host 本地连接令牌格式无效"))
    }
}

#[derive(Debug, Deserialize)]
struct HostApiEnvelope<T> {
    ok: bool,
    data: Option<T>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelStartResult {
    started: bool,
    blocked: bool,
    message: String,
    status: HostStartupStatusV1,
}

struct EditorStartupStatus(Mutex<HostStartupStatusV1>);

impl EditorStartupStatus {
    fn new() -> Self {
        Self(Mutex::new(HostStartupStatusV1 {
            schema_version: HOST_STARTUP_STATUS_SCHEMA,
            revision: 0,
            attempt_id: "not-started".into(),
            mode: "managed",
            phase: "idle",
            stage: "permissionPreflight",
            code: "host_startup_idle".into(),
            reason_code: None,
            message: "Host startup has not started.".into(),
            retryable: true,
            owns_processes: false,
            diagnostic_ref: None,
            updated_at: String::new(),
        }))
    }

    fn finish(&self, started: bool, blocked: bool, message: String) -> KernelStartResult {
        let mut status = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        status.revision += 1;
        status.attempt_id = format!("editor-startup:{}:{}", std::process::id(), status.revision);
        status.phase = if blocked {
            "blocked"
        } else if started {
            "ready"
        } else {
            "failed"
        };
        status.stage = "ready";
        status.code = if blocked {
            "host_startup_permission_blocked"
        } else if started {
            "host_startup_ready"
        } else {
            "host_startup_failed"
        }
        .into();
        status.message = message.clone();
        status.owns_processes = started;
        status.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string();
        KernelStartResult {
            started,
            blocked,
            message,
            status: status.clone(),
        }
    }
}

#[tauri::command]
fn deepcode_host_startup_status(status: State<'_, EditorStartupStatus>) -> HostStartupStatusV1 {
    status
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[tauri::command]
fn deepcode_boot_target(target: State<'_, LaunchTarget>) -> LaunchTarget {
    target.inner().clone()
}

#[tauri::command]
fn deepcode_start_kernel_after_permission(
    target: State<'_, LaunchTarget>,
    host_tokens: State<'_, HostConnectionTokens>,
    processes: State<'_, HostProcessGroup>,
    status: State<'_, EditorStartupStatus>,
) -> KernelStartResult {
    if !startup_permission_preflight(APP_ASSET_DIR) {
        return status.finish(
            false,
            true,
            "startup permission preflight did not complete".into(),
        );
    }
    if local_port_has_listener(&target.host, &target.port)
        || local_port_has_listener(&target.host, &target.daemon_port)
    {
        return status.finish(
            false,
            false,
            "a required private Host port is already in use".into(),
        );
    }
    match spawn_host_processes_if_available(&target, &host_tokens) {
        Ok(Some(children)) => {
            processes.replace(Some(children));
            status.finish(true, false, "Host is ready.".into())
        }
        Ok(None) => status.finish(
            false,
            false,
            "kernel binary was not found or could not be started".into(),
        ),
        Err(message) => status.finish(false, false, message),
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

#[tauri::command]
async fn deepcode_open_external_url(url: String) -> Result<(), String> {
    let url = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS links can open in the system browser.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler");
            command
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = Command::new("xdg-open");
        let output = command
            .arg(url.as_str())
            .output()
            .map_err(|error| format!("Failed to open the system browser: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Failed to open the system browser ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    })
    .await
    .map_err(|error| error.to_string())?
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
    host_tokens: &HostConnectionTokens,
) -> Result<(), Box<dyn std::error::Error>> {
    let boot_url = format!("{APP_ASSET_SCHEME}://localhost/index.html");
    let initialization_script = format!(
        "Object.defineProperty(window,'__DEEPCODE_HOST_BOOT__',{{value:Object.freeze({{schemaVersion:'deepcode.host-ui-bootstrap',host:'{}',port:'{}',uiToken:'{}',windowChrome:'custom'}}),writable:false,configurable:true}});",
        target.host,
        target.port,
        host_tokens.ui_token()
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
    host_tokens: &HostConnectionTokens,
) -> Result<Option<OwnedHostChildren>, String> {
    if env_truthy("DEEPCODE_SHELL_CONNECT_ONLY") {
        return Ok(None);
    }
    if local_port_has_listener(&target.host, &target.port)
        || local_port_has_listener(&target.host, &target.daemon_port)
    {
        return Ok(None);
    }
    let _start_lock = acquire_kernel_start_lock(&target.host, &target.port)
        .ok_or("无法取得本地 Host 启动锁。")?;
    if local_port_has_listener(&target.host, &target.port)
        || local_port_has_listener(&target.host, &target.daemon_port)
    {
        return Ok(None);
    }

    let exe_dir = current_exe_dir().ok_or("无法定位壳可执行文件目录。")?;
    let daemon_path =
        configured_or_bundled_file("DEEPCODE_KERNEL_DAEMON_BIN", &exe_dir, kernel_binary_name())?;
    let proxy_path =
        configured_or_bundled_file("DEEPCODE_HOST_WEB_BIN", &exe_dir, host_web_binary_name())?;
    let daemon_dir = parent_dir(&daemon_path).unwrap_or_else(|| exe_dir.clone());
    let proxy_dir = parent_dir(&proxy_path).unwrap_or_else(|| exe_dir.clone());
    let config_root = std::env::var_os("DEEPCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| package_root(&exe_dir).unwrap_or_else(|| daemon_dir.clone()));

    let shared_start_guard = deepcode_host_connection::HostStartGuard::acquire(&config_root)
        .map_err(|error| format!("host_connection_start_failed: {error}"))?;
    let config_root = config_root
        .canonicalize()
        .map_err(|error| format!("host_config_root_invalid: {error}"))?;
    let shared = deepcode_host_connection::LocalHostConnection::discover(&config_root)
        .map_err(|error| format!("host_connection_discovery_failed: {error}"))?;
    let proxy_host = target.host.clone();
    let mut target = target.clone();
    let mut host_tokens = host_tokens.clone();
    if let Some(connection) = shared.as_ref() {
        let address = connection.address().expect("validated Host address");
        target.host = address.ip().to_string();
        target.daemon_port = address.port().to_string();
        host_tokens.daemon = connection.shell_token().to_string();
        host_tokens.instance_id = connection.identity.instance_id.clone();
    }

    let web_dir = std::env::var("DEEPCODE_CLIENT_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            find_bundled_dir(&exe_dir, "web").unwrap_or_else(|| proxy_dir.join("web"))
        });

    let log_dir = std::env::var_os("DEEPCODE_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| config_root.join("runtime/logs"));
    std::fs::create_dir_all(&log_dir).map_err(|error| format!("创建启动日志目录失败：{error}"))?;
    let log_path = log_dir.join(format!("editor-{}.log", std::process::id()));
    let (mut daemon, daemon_identity) = if let Some(connection) = shared {
        if !authenticated_health_ready(
            &target.host,
            &target.daemon_port,
            HOST_SHELL_TOKEN_HEADER,
            host_tokens.daemon_token(),
        ) {
            return Err("host_connection_health_failed: shared Host is not ready".into());
        }
        (None, connection.identity)
    } else {
        let mut daemon_command = Command::new(daemon_path);
        daemon_command
            .current_dir(&daemon_dir)
            .env("DEEPCODE_HOST", &target.host)
            .env("DEEPCODE_PORT", &target.daemon_port)
            .env("DEEPCODE_CONFIG_DIR", config_root)
            .env_remove(HOST_UI_TOKEN_ENV)
            .env(HOST_SHELL_TOKEN_ENV, host_tokens.daemon_token())
            .env(HOST_INSTANCE_ID_ENV, host_tokens.instance_id())
            .stdin(Stdio::null());
        capture_startup_log(&mut daemon_command, &log_path)?;

        let mut daemon = spawn_owned_host_process(&mut daemon_command)
            .map_err(|error| format!("无法启动 Kernel：{error}；日志：{}", log_path.display()))?;
        let Some(daemon_identity) = wait_for_public_identity(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            KERNEL_DAEMON_SERVICE,
            host_tokens.instance_id(),
            40,
        ) else {
            let error = startup_process_error(&mut daemon, "Kernel", &log_path);
            terminate_owned_process_tree(&mut daemon);
            return Err(error);
        };
        if !wait_for_authenticated_health(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            HOST_SHELL_TOKEN_HEADER,
            host_tokens.daemon_token(),
            40,
        ) {
            let error = startup_process_error(&mut daemon, "Kernel", &log_path);
            terminate_owned_process_tree(&mut daemon);
            return Err(error);
        }

        (Some(daemon), daemon_identity)
    };

    let mut proxy_command = Command::new(proxy_path);
    proxy_command
        .current_dir(&proxy_dir)
        .env("DEEPCODE_HOST", &proxy_host)
        .env("DEEPCODE_PORT", &target.port)
        .env("DEEPCODE_DAEMON_HOST", &target.host)
        .env("DEEPCODE_DAEMON_PORT", &target.daemon_port)
        .env("DEEPCODE_HOST_WEB_SPAWN_DAEMON", "0")
        .env("DEEPCODE_CLIENT_DIST", web_dir)
        .env(HOST_UI_TOKEN_ENV, host_tokens.ui_token())
        .env(HOST_SHELL_TOKEN_ENV, host_tokens.daemon_token())
        .env(HOST_INSTANCE_ID_ENV, host_tokens.instance_id())
        .stdin(Stdio::null());
    if let Err(error) = capture_startup_log(&mut proxy_command, &log_path) {
        shutdown_daemon_process(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            host_tokens.daemon_token(),
            &daemon_identity,
        );
        return Err(error);
    }

    let mut proxy = match spawn_owned_host_process(&mut proxy_command) {
        Ok(proxy) => proxy,
        Err(error) => {
            shutdown_daemon_process(
                &mut daemon,
                &target.host,
                &target.daemon_port,
                host_tokens.daemon_token(),
                &daemon_identity,
            );
            return Err(format!(
                "无法启动私有代理：{error}；日志：{}",
                log_path.display()
            ));
        }
    };
    if wait_for_public_identity(
        &mut proxy,
        &proxy_host,
        &target.port,
        "deepcode-host-web",
        host_tokens.instance_id(),
        40,
    )
    .is_none()
        || !wait_for_authenticated_health(
            &mut proxy,
            &proxy_host,
            &target.port,
            HOST_UI_TOKEN_HEADER,
            host_tokens.ui_token(),
            40,
        )
    {
        let error = startup_process_error(&mut proxy, "私有代理", &log_path);
        terminate_owned_process_tree(&mut proxy);
        shutdown_daemon_process(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            host_tokens.daemon_token(),
            &daemon_identity,
        );
        return Err(error);
    }
    #[cfg(windows)]
    if let Err(error) = daemon
        .as_ref()
        .map(|process| process.job.release_on_close())
        .unwrap_or(Ok(()))
        .and_then(|_| proxy.job.release_on_close())
    {
        terminate_owned_process_tree(&mut proxy);
        shutdown_daemon_process(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            host_tokens.daemon_token(),
            &daemon_identity,
        );
        return Err(format!("host_lifetime_transfer_failed: {error}"));
    }
    Ok(Some(OwnedHostChildren {
        daemon,
        start_guard: Some(shared_start_guard),
        proxy,
        daemon_host: target.host.clone(),
        daemon_port: target.daemon_port.clone(),
        daemon_token: host_tokens.daemon_token().to_string(),
        daemon_identity,
    }))
}

fn configured_or_bundled_file(
    environment_key: &str,
    exe_dir: &Path,
    bundled_name: &str,
) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(environment_key).map(PathBuf::from) {
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "{environment_key} 指定的文件无效：{}",
            path.display()
        ));
    }
    find_bundled_file(exe_dir, bundled_name)
        .ok_or_else(|| format!("未找到包内文件：{bundled_name}"))
}

fn capture_startup_log(command: &mut Command, path: &Path) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let log = options
        .open(path)
        .map_err(|error| format!("打开启动日志失败：{error}"))?;
    let stderr = log
        .try_clone()
        .map_err(|error| format!("复制启动日志句柄失败：{error}"))?;
    command.stdout(Stdio::from(log)).stderr(Stdio::from(stderr));
    Ok(())
}

fn startup_process_error(process: &mut OwnedHostProcess, name: &str, log_path: &Path) -> String {
    let state = match process.child.try_wait() {
        Ok(Some(status)) => format!("已退出：{status}"),
        Ok(None) => "未在启动期限内通过身份或健康检查".into(),
        Err(error) => format!("无法读取进程状态：{error}"),
    };
    format!("{name} {state}；原始输出日志：{}", log_path.display())
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
    token_header: &str,
    token: &str,
    attempts: usize,
) -> bool {
    for _ in 0..attempts {
        match process.child.try_wait() {
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) => {}
        }
        if authenticated_health_ready(host, port, token_header, token) {
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
) -> Option<HostProcessIdentity> {
    let expected_pid = process.child.id();
    for _ in 0..attempts {
        match process.child.try_wait() {
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) => {}
        }
        if let Some(identity) = matching_public_identity(
            host,
            port,
            expected_service,
            expected_instance_id,
            expected_pid,
        ) {
            return Some(identity);
        }
        std::thread::sleep(Duration::from_millis(75));
    }
    None
}

fn matching_public_identity(
    host: &str,
    port: &str,
    expected_service: &str,
    expected_instance_id: &str,
    expected_pid: u32,
) -> Option<HostProcessIdentity> {
    let request = http_request(host, port, "GET", "/api/host/identity", &[]);
    let Some(envelope) =
        request_loopback_json::<HostApiEnvelope<HostProcessIdentity>>(host, port, &request, 300)
    else {
        return None;
    };
    let Some(identity) = envelope.ok.then_some(envelope.data).flatten() else {
        return None;
    };
    (identity.service == expected_service
        && identity.instance_id == expected_instance_id
        && identity.pid == expected_pid)
        .then_some(identity)
}

fn authenticated_health_ready(host: &str, port: &str, token_header: &str, token: &str) -> bool {
    let Ok(port_number) = port.parse::<u16>() else {
        return false;
    };
    let Ok(addrs) = (host, port_number).to_socket_addrs() else {
        return false;
    };
    let request = http_request(host, port, "GET", "/api/health", &[(token_header, token)]);
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
    token: &str,
    expected_identity: &HostProcessIdentity,
) -> bool {
    let Ok(body) = serde_json::to_string(&HostShutdownRequest {
        expected_identity: expected_identity.clone(),
    }) else {
        return false;
    };
    let request = http_request_with_json_body(
        host,
        port,
        "POST",
        "/api/host/shutdown",
        &[(HOST_SHELL_TOKEN_HEADER, token)],
        &body,
    );
    let Some(envelope) = request_loopback_json::<HostApiEnvelope<HostShutdownReceipt>>(
        host,
        port,
        &request,
        HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS,
    ) else {
        return false;
    };
    let Some(receipt) = envelope.ok.then_some(envelope.data).flatten() else {
        return false;
    };
    receipt.confirms_shutdown_of(expected_identity)
}

fn shutdown_daemon_process(
    process: &mut Option<OwnedHostProcess>,
    host: &str,
    port: &str,
    token: &str,
    expected_identity: &HostProcessIdentity,
) {
    let Some(process) = process.as_mut() else {
        return;
    };
    if !request_daemon_shutdown(host, port, token, expected_identity)
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

#[cfg(unix)]
fn owned_process_group_exists(process_group_id: libc::pid_t) -> bool {
    if unsafe { libc::kill(-process_group_id, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(unix)]
fn wait_for_owned_process_group_exit(process: &mut OwnedHostProcess, attempts: usize) -> bool {
    for _ in 0..attempts {
        let _ = process.child.try_wait();
        if !owned_process_group_exists(process.process_group_id) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !owned_process_group_exists(process.process_group_id)
}

fn terminate_owned_process_tree(process: &mut OwnedHostProcess) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-process.process_group_id, libc::SIGTERM);
        }
        if !wait_for_owned_process_group_exit(process, 20) {
            unsafe {
                libc::kill(-process.process_group_id, libc::SIGKILL);
            }
            let _ = wait_for_owned_process_group_exit(process, 20);
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

    fn release_on_close(&self) -> std::io::Result<()> {
        let handle = self
            .handle
            .as_ref()
            .ok_or_else(|| std::io::Error::other("Kernel Job Object is closed"))?;
        let information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
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
        Ok(())
    }

    fn assign(&self, child: &Child) -> std::io::Result<()> {
        let Some(handle) = self.handle.as_ref() else {
            return Err(std::io::Error::other("Host Job Object is closed"));
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
        if let Some(handle) = self.handle.as_ref() {
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    handle.as_raw_handle() as HANDLE,
                    1,
                );
            }
        }
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
    let token = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {token}\r\n");
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
    request
}

fn http_request_with_json_body(
    host: &str,
    port: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> String {
    let token = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {token}\r\n");
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("Content-Type: application/json\r\n");
    request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    request.push_str("Connection: close\r\n\r\n");
    request.push_str(body);
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn startup_error_keeps_the_child_exit_and_original_stderr() {
        let directory =
            std::env::temp_dir().join(format!("deepcode-editor-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("startup.log");
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf 'startup child diagnostic\\n' >&2; exit 71"]);
        capture_startup_log(&mut command, &path).unwrap();
        let mut child = spawn_owned_host_process(&mut command).unwrap();
        child.child.wait().unwrap();
        let error = startup_process_error(&mut child, "Kernel", &path);
        let log = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert!(error.contains("71"));
        assert!(error.contains(&path.display().to_string()));
        assert!(log.contains("startup child diagnostic"));
    }
}
