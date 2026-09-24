#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../../../shared/file_reader.rs"]
mod file_reader;
#[path = "../../../shared/open_file.rs"]
mod open_file;

#[path = "../../../shared/native_browser/mod.rs"]
mod native_browser;
#[path = "../../../shared/native_path_dialog/mod.rs"]
mod native_path_dialog;

use deepcode_host_connection::loopback_http::request_loopback_json;
use deepcode_kernel_abi::{
    is_valid_host_instance_id, is_valid_host_shell_token, is_valid_host_ui_token,
    HostProcessIdentity, HOST_INSTANCE_ID_ENV, HOST_INSTANCE_ID_PREFIX, HOST_SHELL_TOKEN_ENV,
    HOST_SHELL_TOKEN_HEADER, HOST_SHELL_TOKEN_PREFIX, HOST_TOKEN_ENTROPY_BYTES, HOST_UI_TOKEN_ENV,
    HOST_UI_TOKEN_HEADER, HOST_UI_TOKEN_PREFIX, KERNEL_DAEMON_SERVICE,
};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use deepcode_host_connection::process::{
    spawn_owned_host_process, terminate_owned_process_tree, OwnedHostProcess,
};
use deepcode_host_connection::shell_lifecycle::{shutdown_daemon_process, OwnedHostChildren};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "31246";
const APP_ASSET_SCHEME: &str = "deepcode-gui";
const APP_ASSET_DIR: &str = "web-deepcode-gui";

struct RuntimeLocations {
    resources: PathBuf,
    user: deepcode_host_connection::UserDirectories,
}

static RUNTIME_LOCATIONS: OnceLock<RuntimeLocations> = OnceLock::new();

fn initialize_runtime_locations() -> std::io::Result<()> {
    let executable_dir = current_exe_dir()
        .ok_or_else(|| std::io::Error::other("executable directory is unavailable"))?;
    let resources = deepcode_host_connection::runtime_root(&executable_dir);
    let user = deepcode_host_connection::UserDirectories::resolve()?;
    user.create()?;
    RUNTIME_LOCATIONS
        .set(RuntimeLocations { resources, user })
        .map_err(|_| std::io::Error::other("runtime locations already initialized"))
}

fn runtime_locations() -> &'static RuntimeLocations {
    RUNTIME_LOCATIONS
        .get()
        .expect("Host runtime locations initialized before opening windows")
}

struct HostProcessGroup {
    state: Mutex<HostProcessState>,
    startup_idle: Condvar,
}

struct HostProcessState {
    external_client: Option<deepcode_host_connection::HostClientLease>,
    children: Option<OwnedHostChildren>,
    active_startups: usize,
    shutting_down: bool,
}

struct HostStartupLease<'a> {
    processes: &'a HostProcessGroup,
}

use deepcode_host_connection::{HostStartupStatusV1, HOST_STARTUP_STATUS_SCHEMA};

struct HostStartupStatusStore {
    status: Mutex<HostStartupStatusV1>,
}

impl HostStartupStatusStore {
    fn new() -> Self {
        Self {
            status: Mutex::new(HostStartupStatusV1 {
                schema_version: HOST_STARTUP_STATUS_SCHEMA,
                revision: 0,
                attempt_id: "not-started".to_string(),
                mode: startup_mode(),
                phase: "idle",
                stage: "permissionPreflight",
                code: "host_startup_idle".to_string(),
                reason_code: None,
                message: "Host startup has not started.".to_string(),
                retryable: true,
                owns_processes: false,
                diagnostic_ref: None,
                updated_at: startup_timestamp(),
            }),
        }
    }

    fn read(&self) -> HostStartupStatusV1 {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| HostStartupStatusV1 {
                schema_version: HOST_STARTUP_STATUS_SCHEMA,
                revision: 0,
                attempt_id: "unavailable".to_string(),
                mode: startup_mode(),
                phase: "failed",
                stage: "ready",
                code: "host_startup_status_unavailable".to_string(),
                reason_code: None,
                message: "Host startup status is unavailable.".to_string(),
                retryable: true,
                owns_processes: false,
                diagnostic_ref: None,
                updated_at: startup_timestamp(),
            })
    }

    fn replace(&self, mut next: HostStartupStatusV1) -> HostStartupStatusV1 {
        if let Ok(mut current) = self.status.lock() {
            next.revision = current.revision.saturating_add(1);
            next.updated_at = startup_timestamp();
            *current = next.clone();
            return next;
        }
        next
    }

    fn update(
        &self,
        attempt_id: &str,
        phase: &'static str,
        stage: &'static str,
        code: impl Into<String>,
        reason_code: Option<String>,
        message: impl Into<String>,
        retryable: bool,
        owns_processes: bool,
        diagnostic_ref: Option<String>,
    ) -> HostStartupStatusV1 {
        self.replace(HostStartupStatusV1 {
            schema_version: HOST_STARTUP_STATUS_SCHEMA,
            revision: 0,
            attempt_id: attempt_id.to_string(),
            mode: startup_mode(),
            phase,
            stage,
            code: code.into(),
            reason_code,
            message: message.into(),
            retryable,
            owns_processes,
            diagnostic_ref,
            updated_at: startup_timestamp(),
        })
    }
}

impl HostProcessGroup {
    fn new(children: Option<OwnedHostChildren>) -> Self {
        Self {
            state: Mutex::new(HostProcessState {
                external_client: None,
                children,
                active_startups: 0,
                shutting_down: false,
            }),
            startup_idle: Condvar::new(),
        }
    }

    fn begin_startup(&self) -> Option<HostStartupLease<'_>> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.shutting_down {
            return None;
        }
        state.active_startups = state.active_startups.saturating_add(1);
        Some(HostStartupLease { processes: self })
    }

    fn install(&self, children: OwnedHostChildren) -> bool {
        let mut candidate = Some(children);
        let previous = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.shutting_down {
                None
            } else {
                candidate
                    .as_mut()
                    .expect("candidate is present")
                    .share_ready_daemon();
                state
                    .children
                    .replace(candidate.take().expect("candidate is present"))
            }
        };
        if let Some(mut processes) = previous {
            processes.shutdown();
        }
        if let Some(mut rejected) = candidate {
            rejected.shutdown();
            return false;
        }
        true
    }

    fn reclaim_current(&self) {
        let current = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .children
            .take();
        if let Some(mut processes) = current {
            processes.shutdown();
        }
    }

    fn detach(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.shutting_down = true;
        drop(state.external_client.take());
        if let Some(mut children) = state.children.take() {
            children.shutdown();
        }
        while state.active_startups > 0 {
            state = self
                .startup_idle
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn is_shutting_down(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .shutting_down
    }
}

impl Drop for HostStartupLease<'_> {
    fn drop(&mut self) {
        let mut state = self
            .processes
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active_startups = state.active_startups.saturating_sub(1);
        if state.active_startups == 0 {
            self.processes.startup_idle.notify_all();
        }
    }
}

impl Drop for HostProcessGroup {
    fn drop(&mut self) {
        self.detach();
    }
}

fn main() {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        native_path_dialog::deepcode_pick_path,
        open_file::deepcode_open_file,
        file_reader::deepcode_read_local_file,
        open_file::deepcode_locate_path,
        deepcode_boot_target,
        deepcode_default_workspace_path,
        deepcode_host_startup_status,
        deepcode_start_kernel_after_permission,
        deepcode_window_minimize,
        deepcode_window_toggle_maximize,
        deepcode_window_close,
        deepcode_open_external_url,
        native_browser::deepcode_browser_host,
        native_browser::deepcode_browser_command
    ];
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol(APP_ASSET_SCHEME, |_ctx, request| {
            serve_bundled_asset(APP_ASSET_DIR, request)
        })
        .invoke_handler(move |invoke| {
            if invoke.message.webview_ref().label() != "main" {
                invoke
                    .resolver
                    .reject("Host commands belong to the primary GUI view.");
                return true;
            }
            handler(invoke)
        })
        .setup(|app| {
            initialize_runtime_locations()?;
            let target = resolve_launch_target();
            let mut host_tokens = HostConnectionTokens::resolve()?;
            let registration = Arc::clone(&host_tokens.browser_registration);
            let browser_id = host_tokens.browser_instance_id.clone();
            let callback_token = host_tokens.browser_token.clone();
            host_tokens.browser_endpoint = native_browser::start(
                app.handle(),
                runtime_locations().user.clone(),
                host_tokens.browser_instance_id.clone(),
                host_tokens.browser_token.clone(),
                host_bootstrap_script(&target, &host_tokens, true),
                Box::new(move || {
                    if let Ok(mut registration) = registration.lock() {
                        if let Some((host, port, token, endpoint)) = registration.take() {
                            let _ = register_native_browser(
                                &host,
                                &port,
                                &token,
                                &browser_id,
                                &endpoint,
                                &callback_token,
                                true,
                            );
                        }
                    }
                }),
            )
            .map_err(std::io::Error::other)?;
            app.manage(target.clone());
            app.manage(host_tokens.clone());
            app.manage(HostProcessGroup::new(None));
            app.manage(HostStartupStatusStore::new());
            create_main_window(app, &target, &host_tokens)?;
            let menu = tauri::menu::Menu::default(app.handle())?;
            let reload = tauri::menu::MenuItem::with_id(
                app,
                "reload-interface",
                "重新加载界面",
                true,
                Some("CmdOrCtrl+Shift+R"),
            )?;
            let mut added = false;
            for item in menu.items()? {
                if let tauri::menu::MenuItemKind::Submenu(submenu) = item {
                    if submenu.text()? == "View" {
                        submenu.insert(&reload, 0)?;
                        added = true;
                        break;
                    }
                }
            }
            if !added {
                menu.append(&tauri::menu::Submenu::with_items(
                    app,
                    "视图",
                    true,
                    &[&reload],
                )?)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "reload-interface" {
                    let _ = tauri::Emitter::emit_to(app, "main", "deepcode:reload-interface", ());
                }
            });
            // Actual Host I/O reports access failures. Do not enumerate parent
            // directories before startup or block the native window event loop.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let processes = app_handle.state::<HostProcessGroup>();
                let status = app_handle.state::<HostStartupStatusStore>();
                start_host_processes(&target, &host_tokens, &processes, &status);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                window.state::<native_browser::NativeBrowser>().stop();
                window.state::<HostProcessGroup>().detach();
                window.app_handle().exit(0);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build DeepCode-GUI Tauri shell");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            app_handle.state::<native_browser::NativeBrowser>().stop();
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
    browser_endpoint: String,
    browser_instance_id: String,
    browser_token: String,
    browser_registration: Arc<Mutex<Option<(String, String, String, String)>>>,
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
            browser_instance_id: instance_id.clone(),
            browser_token: daemon.clone(),
            browser_registration: Arc::new(Mutex::new(None)),
            daemon,
            proxy,
            instance_id,
            browser_endpoint: String::new(),
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostHealthData {
    ok: bool,
    status: String,
}

#[derive(Debug)]
struct HostStartupFailure {
    stage: &'static str,
    code: &'static str,
    reason_code: Option<String>,
    message: String,
    retryable: bool,
}

struct HostDiagnosticAttempt {
    directory: PathBuf,
    reference: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelStartResult {
    started: bool,
    blocked: bool,
    message: String,
    status: HostStartupStatusV1,
}

#[tauri::command]
fn deepcode_boot_target(target: State<'_, LaunchTarget>) -> LaunchTarget {
    target.inner().clone()
}

#[tauri::command]
fn deepcode_default_workspace_path() -> Option<String> {
    default_workspace_path().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn deepcode_host_startup_status(status: State<'_, HostStartupStatusStore>) -> HostStartupStatusV1 {
    status.read()
}

#[tauri::command(async)]
fn deepcode_start_kernel_after_permission(
    target: State<'_, LaunchTarget>,
    host_tokens: State<'_, HostConnectionTokens>,
    processes: State<'_, HostProcessGroup>,
    status: State<'_, HostStartupStatusStore>,
) -> KernelStartResult {
    let current = start_host_processes(&target, &host_tokens, &processes, &status);
    let started = current.phase == "ready";
    KernelStartResult {
        started,
        blocked: current.phase == "blocked",
        message: current.message.clone(),
        status: current,
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
    let initialization_script = host_bootstrap_script(target, host_tokens, false);
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(boot_url.parse()?))
        .data_directory(runtime_locations().user.cache_dir.join("webview"))
        .initialization_script(initialization_script)
        .on_navigation(trusted_app_navigation)
        .title("DeepCode-GUI")
        .inner_size(1500.0, 920.0)
        .min_inner_size(1120.0, 720.0)
        .resizable(true)
        .fullscreen(false);

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 12.0))
        .hidden_title(true)
        .shadow(true)
        .background_color(tauri::window::Color(245, 246, 247, 255));

    #[cfg(not(target_os = "macos"))]
    let builder = builder
        .decorations(false)
        .background_color(tauri::window::Color(245, 246, 247, 255));

    builder.build()?;
    Ok(())
}

fn host_bootstrap_script(
    target: &LaunchTarget,
    host_tokens: &HostConnectionTokens,
    preview: bool,
) -> String {
    let bootstrap = serde_json::json!({
        "schemaVersion":"deepcode.host-ui-bootstrap", "host":target.host, "port":target.port.to_string(),
        "uiToken":host_tokens.ui_token(), "windowChrome":if cfg!(target_os="macos") && !preview {"nativeOverlay"} else {"custom"}
    });
    format!("Object.defineProperty(window,'__DEEPCODE_HOST_BOOT__',{{value:Object.freeze({bootstrap}),writable:false,configurable:true}});")
}

fn trusted_app_navigation(url: &tauri::Url) -> bool {
    (url.scheme() == APP_ASSET_SCHEME && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some(concat!("deepcode-gui", ".localhost")))
        // WKWebView also reports navigation inside the sandboxed document iframe.
        || (url.scheme() == "about" && matches!(url.path(), "srcdoc" | "blank"))
}

fn serve_bundled_asset(web_dir_name: &str, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match resolve_asset_path(web_dir_name, request.uri().path()) {
        Ok(path) => match std::fs::read(&path) {
            Ok(bytes) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type_for_path(&path))
                .header(header::CACHE_CONTROL, "no-cache")
                .body(bytes)
                .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR)),
            Err(_) => text_response(StatusCode::NOT_FOUND, "asset not found"),
        },
        Err(message) => text_response(StatusCode::BAD_REQUEST, &message),
    }
}

fn resolve_asset_path(web_dir_name: &str, uri_path: &str) -> Result<PathBuf, String> {
    let web_root = std::env::var_os("DEEPCODE_CLIENT_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_locations().resources.join(web_dir_name));
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

fn start_host_processes(
    target: &LaunchTarget,
    host_tokens: &HostConnectionTokens,
    processes: &HostProcessGroup,
    status: &HostStartupStatusStore,
) -> HostStartupStatusV1 {
    let attempt_id = startup_attempt_id();
    let Some(_startup_lease) = processes.begin_startup() else {
        return status.update(
            &attempt_id,
            "stopped",
            "shutdown",
            "host_startup_stopped",
            None,
            "Host startup was stopped because the application is closing.",
            false,
            false,
            None,
        );
    };
    if env_truthy("DEEPCODE_SHELL_CONNECT_ONLY") {
        let result = deepcode_host_connection::HostClientLease::connect(
            &format!("http://{}:{}", target.host, target.daemon_port),
            host_tokens.daemon_token(),
            false,
        );
        return match result {
            Ok(lease) => {
                let mut state = processes
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if state.shutting_down {
                    drop(lease);
                    status.update(
                        &attempt_id,
                        "stopped",
                        "shutdown",
                        "host_startup_stopped",
                        None,
                        "Host connection was stopped because the application is closing.",
                        false,
                        false,
                        None,
                    )
                } else {
                    state.external_client = Some(lease);
                    status.update(
                        &attempt_id,
                        "external",
                        "connectOnly",
                        "host_startup_external",
                        None,
                        "Connected to the externally owned Host.",
                        false,
                        false,
                        None,
                    )
                }
            }
            Err(error) => status.update(
                &attempt_id,
                "failed",
                "connectOnly",
                "host_client_attach_failed",
                None,
                error.to_string(),
                true,
                false,
                None,
            ),
        };
    }

    // Retry may be requested while this shell still owns a surviving proxy or
    // daemon.  Reclaim only those exact children before checking ports; an
    // external listener is never terminated by this path.
    processes.reclaim_current();
    let diagnostic = prepare_host_startup_diagnostics(&attempt_id).ok();
    let diagnostic_ref = diagnostic.as_ref().map(|value| value.reference.clone());
    status.update(
        &attempt_id,
        "starting",
        "startAdmission",
        "host_startup_starting",
        None,
        "Starting the managed DeepCode Host.",
        true,
        false,
        diagnostic_ref.clone(),
    );

    match spawn_host_processes_if_available(
        target,
        host_tokens,
        processes,
        status,
        &attempt_id,
        diagnostic.as_ref(),
    ) {
        Ok(children) => {
            if !processes.install(children) {
                return status.update(
                    &attempt_id,
                    "stopped",
                    "shutdown",
                    "host_startup_stopped",
                    None,
                    "Host startup completed after application shutdown and was reclaimed.",
                    false,
                    false,
                    diagnostic_ref,
                );
            }
            status.update(
                &attempt_id,
                "ready",
                "ready",
                "host_startup_ready",
                None,
                "DeepCode Host is ready.",
                false,
                true,
                diagnostic_ref,
            )
        }
        Err(failure) => {
            if processes.is_shutting_down() || failure.code == "host_startup_stopped" {
                status.update(
                    &attempt_id,
                    "stopped",
                    "shutdown",
                    "host_startup_stopped",
                    None,
                    "Host startup was stopped because the application is closing.",
                    false,
                    false,
                    diagnostic_ref,
                )
            } else {
                status.update(
                    &attempt_id,
                    "failed",
                    failure.stage,
                    failure.code,
                    failure.reason_code,
                    failure.message,
                    failure.retryable,
                    false,
                    diagnostic_ref,
                )
            }
        }
    }
}

fn spawn_host_processes_if_available(
    target: &LaunchTarget,
    host_tokens: &HostConnectionTokens,
    processes: &HostProcessGroup,
    status: &HostStartupStatusStore,
    attempt_id: &str,
    diagnostic: Option<&HostDiagnosticAttempt>,
) -> Result<OwnedHostChildren, HostStartupFailure> {
    if processes.is_shutting_down() {
        return Err(startup_stopped_failure());
    }
    let _start_lock = acquire_kernel_start_lock(&target.host, &target.port)
        .map_err(|error| {
            startup_failure(
                "startAdmission",
                "host_startup_lock_failed",
                None,
                format!("Host startup lock failed: {error}"),
                true,
            )
        })?
        .ok_or_else(|| {
            startup_failure(
                "startAdmission",
                "host_startup_lock_unavailable",
                None,
                "Another Host startup attempt owns the startup lock.",
                true,
            )
        })?;
    status.update(
        attempt_id,
        "starting",
        "binaryResolution",
        "host_startup_resolving_binaries",
        None,
        "Resolving bundled Host binaries.",
        true,
        false,
        diagnostic.map(|value| value.reference.clone()),
    );
    let exe_dir = current_exe_dir().ok_or_else(|| {
        startup_failure(
            "binaryResolution",
            "host_startup_executable_directory_unavailable",
            None,
            "The desktop executable directory could not be resolved.",
            false,
        )
    })?;
    let daemon_path =
        configured_or_bundled_file("DEEPCODE_KERNEL_DAEMON_BIN", &exe_dir, kernel_binary_name())
            .ok_or_else(|| {
                startup_failure(
                    "binaryResolution",
                    "host_startup_daemon_binary_missing",
                    None,
                    "The bundled Kernel daemon binary is unavailable.",
                    false,
                )
            })?;
    let proxy_path =
        configured_or_bundled_file("DEEPCODE_HOST_WEB_BIN", &exe_dir, host_web_binary_name())
            .ok_or_else(|| {
                startup_failure(
                    "binaryResolution",
                    "host_startup_proxy_binary_missing",
                    None,
                    "The bundled Host UI proxy binary is unavailable.",
                    false,
                )
            })?;
    let daemon_dir = parent_dir(&daemon_path).unwrap_or_else(|| exe_dir.clone());
    let proxy_dir = parent_dir(&proxy_path).unwrap_or_else(|| exe_dir.clone());
    let data_root = runtime_locations().user.data_dir.clone();

    let shared_start_guard = deepcode_host_connection::HostStartGuard::acquire(&data_root)
        .map_err(|error| {
            startup_failure(
                "sharedHost",
                "host_connection_start_failed",
                None,
                error.to_string(),
                true,
            )
        })?;
    let data_root = data_root.canonicalize().map_err(|error| {
        startup_failure(
            "sharedHost",
            "host_data_root_invalid",
            None,
            error.to_string(),
            false,
        )
    })?;
    let shared =
        deepcode_host_connection::LocalHostConnection::discover(&data_root).map_err(|error| {
            startup_failure(
                "sharedHost",
                "host_connection_discovery_failed",
                None,
                error.to_string(),
                true,
            )
        })?;
    // A ready daemon outlives this shell. On retry its original port is still
    // occupied by that shared service; only ports we will bind are private.
    admit_private_host_ports(target, shared.is_some())?;
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

    let web_dir = std::env::var_os("DEEPCODE_CLIENT_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_locations().resources.join(APP_ASSET_DIR));

    let (mut daemon, daemon_identity) = if let Some(connection) = shared {
        if !matches!(
            authenticated_health_status(
                &target.host,
                &target.daemon_port,
                HOST_SHELL_TOKEN_HEADER,
                host_tokens.daemon_token()
            ),
            AuthenticatedHealthStatus::Ready
        ) {
            return Err(startup_failure(
                "sharedHost",
                "host_connection_health_failed",
                None,
                "The shared Host did not pass authenticated health.",
                true,
            ));
        }
        (None, connection.identity)
    } else {
        status.update(
            attempt_id,
            "starting",
            "daemonSpawn",
            "host_startup_spawning_daemon",
            None,
            "Starting the Kernel daemon.",
            true,
            false,
            diagnostic.map(|value| value.reference.clone()),
        );
        if processes.is_shutting_down() {
            return Err(startup_stopped_failure());
        }
        let mut daemon_command = Command::new(daemon_path);
        runtime_locations()
            .user
            .configure_child(&mut daemon_command);
        daemon_command
            .current_dir(&daemon_dir)
            .env("DEEPCODE_HOST", &target.host)
            .env("DEEPCODE_PORT", &target.daemon_port)
            .env("DEEPCODE_RUNTIME_DIR", &runtime_locations().resources)
            .env_remove(HOST_UI_TOKEN_ENV)
            .env(HOST_SHELL_TOKEN_ENV, host_tokens.daemon_token())
            .env(deepcode_host_connection::HOST_LIFETIME_ENV, "automatic")
            .env(HOST_INSTANCE_ID_ENV, host_tokens.instance_id())
            .stdin(Stdio::null());
        if let Err(error) = configure_process_capture(
            &mut daemon_command,
            diagnostic.map(|value| value.directory.as_path()),
            "daemon",
        ) {
            return Err(startup_failure(
                "daemonSpawn",
                "host_startup_log_capture_failed",
                None,
                error.to_string(),
                true,
            ));
        }

        let mut daemon = spawn_owned_host_process(&mut daemon_command).map_err(|error| {
            startup_failure(
                "daemonSpawn",
                "host_startup_daemon_spawn_failed",
                None,
                format!("The Kernel daemon could not be started: {error}"),
                true,
            )
        })?;

        status.update(
            attempt_id,
            "starting",
            "daemonIdentity",
            "host_startup_waiting_daemon_identity",
            None,
            "Waiting for the Kernel daemon identity.",
            true,
            true,
            diagnostic.map(|value| value.reference.clone()),
        );
        let daemon_identity = match wait_for_public_identity(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            KERNEL_DAEMON_SERVICE,
            host_tokens.instance_id(),
            processes,
            40,
            diagnostic,
        ) {
            Ok(identity) => identity,
            Err(failure) => {
                terminate_owned_process_tree(&mut daemon);
                return Err(failure);
            }
        };
        status.update(
            attempt_id,
            "starting",
            "daemonRecovery",
            "host_startup_waiting_daemon_recovery",
            None,
            "Waiting for Kernel and Session recovery.",
            true,
            true,
            diagnostic.map(|value| value.reference.clone()),
        );
        if let Err(failure) = wait_for_authenticated_health(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            HOST_SHELL_TOKEN_HEADER,
            host_tokens.daemon_token(),
            processes,
            400,
        ) {
            terminate_owned_process_tree(&mut daemon);
            return Err(startup_failure(
                "daemonRecovery",
                failure.code,
                failure.reason_code,
                failure.message,
                failure.retryable,
            ));
        }

        (Some(daemon), daemon_identity)
    };

    if let Err(message) = register_native_browser(
        &target.host,
        &target.daemon_port,
        host_tokens.daemon_token(),
        &host_tokens.browser_instance_id,
        &host_tokens.browser_endpoint,
        &host_tokens.browser_token,
        false,
    ) {
        eprintln!("[native-browser] {message}");
    } else if let Ok(mut registration) = host_tokens.browser_registration.lock() {
        *registration = Some((
            target.host.clone(),
            target.daemon_port.clone(),
            host_tokens.daemon.clone(),
            host_tokens.browser_endpoint.clone(),
        ));
    }
    status.update(
        attempt_id,
        "starting",
        "proxySpawn",
        "host_startup_spawning_proxy",
        None,
        "Starting the Host UI proxy.",
        true,
        true,
        diagnostic.map(|value| value.reference.clone()),
    );
    if processes.is_shutting_down() {
        shutdown_daemon_process(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            host_tokens.daemon_token(),
            &daemon_identity,
        );
        return Err(startup_stopped_failure());
    }
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
        .env(deepcode_host_connection::HOST_LIFETIME_ENV, "automatic")
        .env(HOST_INSTANCE_ID_ENV, host_tokens.instance_id())
        .stdin(Stdio::null());
    if let Err(error) = configure_process_capture(
        &mut proxy_command,
        diagnostic.map(|value| value.directory.as_path()),
        "proxy",
    ) {
        shutdown_daemon_process(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            host_tokens.daemon_token(),
            &daemon_identity,
        );
        return Err(startup_failure(
            "proxySpawn",
            "host_startup_log_capture_failed",
            None,
            error.to_string(),
            true,
        ));
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
            return Err(startup_failure(
                "proxySpawn",
                "host_startup_proxy_spawn_failed",
                None,
                format!("The Host UI proxy could not be started: {error}"),
                true,
            ));
        }
    };

    status.update(
        attempt_id,
        "starting",
        "proxyIdentity",
        "host_startup_waiting_proxy_identity",
        None,
        "Waiting for the Host UI proxy identity.",
        true,
        true,
        diagnostic.map(|value| value.reference.clone()),
    );
    if let Err(failure) = wait_for_public_identity(
        &mut proxy,
        &proxy_host,
        &target.port,
        "deepcode-host-web",
        host_tokens.instance_id(),
        processes,
        40,
        diagnostic,
    ) {
        terminate_owned_process_tree(&mut proxy);
        shutdown_daemon_process(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            host_tokens.daemon_token(),
            &daemon_identity,
        );
        return Err(failure);
    }
    status.update(
        attempt_id,
        "starting",
        "proxyHealth",
        "host_startup_waiting_proxy_health",
        None,
        "Waiting for the Host UI proxy health check.",
        true,
        true,
        diagnostic.map(|value| value.reference.clone()),
    );
    if let Err(failure) = wait_for_authenticated_health(
        &mut proxy,
        &proxy_host,
        &target.port,
        HOST_UI_TOKEN_HEADER,
        host_tokens.ui_token(),
        processes,
        80,
    ) {
        terminate_owned_process_tree(&mut proxy);
        shutdown_daemon_process(
            &mut daemon,
            &target.host,
            &target.daemon_port,
            host_tokens.daemon_token(),
            &daemon_identity,
        );
        return Err(startup_failure(
            "proxyHealth",
            failure.code,
            failure.reason_code,
            failure.message,
            failure.retryable,
        ));
    }
    let mut children = OwnedHostChildren {
        daemon,
        start_guard: Some(shared_start_guard),
        proxy,
        daemon_host: target.host.clone(),
        daemon_port: target.daemon_port.clone(),
        daemon_token: host_tokens.daemon_token().to_string(),
        daemon_identity,
        client_lease: None,
    };
    if let Err(error) = children.attach_client() {
        children.shutdown();
        return Err(startup_failure(
            "sharedHost",
            "host_client_attach_failed",
            None,
            error.to_string(),
            true,
        ));
    }
    Ok(children)
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
    let path = exe_dir.join(bundled_name);
    path.is_file().then_some(path)
}

fn startup_mode() -> &'static str {
    if env_truthy("DEEPCODE_SHELL_CONNECT_ONLY") {
        "connectOnly"
    } else {
        "managed"
    }
}

fn startup_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn startup_attempt_id() -> String {
    let mut entropy = [0_u8; 12];
    if getrandom::fill(&mut entropy).is_err() {
        return format!("host-startup-{}", startup_timestamp());
    }
    let mut encoded = String::with_capacity(entropy.len() * 2);
    for byte in entropy {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    format!("host-startup-{encoded}")
}

fn startup_failure(
    stage: &'static str,
    code: &'static str,
    reason_code: Option<String>,
    message: impl Into<String>,
    retryable: bool,
) -> HostStartupFailure {
    HostStartupFailure {
        stage,
        code,
        reason_code,
        message: message.into(),
        retryable,
    }
}

fn startup_stopped_failure() -> HostStartupFailure {
    startup_failure(
        "shutdown",
        "host_startup_stopped",
        None,
        "Host startup was stopped because the application is closing.",
        false,
    )
}

fn prepare_host_startup_diagnostics(attempt_id: &str) -> std::io::Result<HostDiagnosticAttempt> {
    let root = runtime_locations().user.log_dir.join("host-startup");
    let directory = root.join(attempt_id);
    std::fs::create_dir_all(&directory)?;
    set_private_directory_permissions(&root)?;
    set_private_directory_permissions(&directory)?;
    Ok(HostDiagnosticAttempt {
        directory,
        reference: format!("host-startup/{attempt_id}"),
    })
}

fn set_private_directory_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn configure_process_capture(
    command: &mut Command,
    directory: Option<&Path>,
    process_name: &str,
) -> std::io::Result<()> {
    if let Some(directory) = directory {
        command
            .stdout(Stdio::from(private_log_file(
                &directory.join(format!("{process_name}.stdout.log")),
            )?))
            .stderr(Stdio::from(private_log_file(
                &directory.join(format!("{process_name}.stderr.log")),
            )?));
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    Ok(())
}

fn private_log_file(path: &Path) -> std::io::Result<File> {
    let file = OpenOptions::new().create_new(true).write(true).open(path)?;
    set_private_file_permissions(path)?;
    Ok(file)
}

struct KernelStartLock {
    path: PathBuf,
}

impl Drop for KernelStartLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_kernel_start_lock(host: &str, port: &str) -> std::io::Result<Option<KernelStartLock>> {
    let path = runtime_locations().user.temp_dir.join(format!(
        "deepcode-kernel-start-{}-{}.lock",
        sanitize_lock_component(host),
        sanitize_lock_component(port)
    ));
    let create = || {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
    };
    let result = match create() {
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if kernel_start_lock_is_stale(&path)? {
                std::fs::remove_file(&path)?;
                create()
            } else {
                Err(error)
            }
        }
        result => result,
    };
    match result {
        Ok(mut file) => {
            let lock = KernelStartLock { path };
            std::io::Write::write_all(
                &mut file,
                format!("pid={}\n", std::process::id()).as_bytes(),
            )?;
            Ok(Some(lock))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            wait_for_kernel_listener(host, port, 40);
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn kernel_start_lock_is_stale(path: &Path) -> std::io::Result<bool> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())?
        .elapsed()
        .map(|age| age > Duration::from_secs(30))
        .map_err(std::io::Error::other)
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
    processes: &HostProcessGroup,
    attempts: usize,
) -> Result<(), HostStartupFailure> {
    for _ in 0..attempts {
        if processes.is_shutting_down() {
            return Err(startup_stopped_failure());
        }
        match process.child.try_wait() {
            Ok(Some(status)) => {
                return Err(startup_failure(
                    "daemonRecovery",
                    "host_startup_process_exited",
                    None,
                    format!("A managed Host process exited before becoming ready: {status}"),
                    true,
                ));
            }
            Err(error) => {
                return Err(startup_failure(
                    "daemonRecovery",
                    "host_startup_process_status_failed",
                    None,
                    format!("A managed Host process status could not be read: {error}"),
                    true,
                ));
            }
            Ok(None) => {}
        }
        match authenticated_health_status(host, port, token_header, token) {
            AuthenticatedHealthStatus::Ready => return Ok(()),
            AuthenticatedHealthStatus::Failed => {
                return Err(startup_failure(
                    "daemonRecovery",
                    "host_startup_daemon_recovery_failed",
                    None,
                    "Kernel 与 Session 未能进入就绪状态。",
                    true,
                ));
            }
            AuthenticatedHealthStatus::Unavailable => {}
        }
        std::thread::sleep(Duration::from_millis(75));
    }
    Err(startup_failure(
        "daemonRecovery",
        "host_startup_health_timeout",
        None,
        "A managed Host process did not become ready before the startup deadline.",
        true,
    ))
}

fn wait_for_public_identity(
    process: &mut OwnedHostProcess,
    host: &str,
    port: &str,
    expected_service: &str,
    expected_instance_id: &str,
    processes: &HostProcessGroup,
    attempts: usize,
    diagnostic: Option<&HostDiagnosticAttempt>,
) -> Result<HostProcessIdentity, HostStartupFailure> {
    let (stage, identity_failure, process_name) = if expected_service == KERNEL_DAEMON_SERVICE {
        (
            "daemonIdentity",
            "host_startup_daemon_identity_failed",
            "daemon",
        )
    } else {
        (
            "proxyIdentity",
            "host_startup_proxy_identity_failed",
            "proxy",
        )
    };
    let expected_pid = process.child.id();
    for _ in 0..attempts {
        if processes.is_shutting_down() {
            return Err(startup_stopped_failure());
        }
        match process.child.try_wait() {
            Ok(Some(exit_status)) => {
                let mut message = format!(
                    "{expected_service} exited during initialization ({exit_status}), before publishing its process identity."
                );
                if let Some(diagnostic) = diagnostic {
                    let path = diagnostic
                        .directory
                        .join(format!("{process_name}.stderr.log"));
                    message.push_str(&format!(
                        "\nStartup log: {}/{process_name}.stderr.log",
                        diagnostic.reference
                    ));
                    match read_startup_log_tail(&path) {
                        Ok(tail) if !tail.trim().is_empty() => {
                            message.push_str("\n\n");
                            message.push_str(tail.trim());
                        }
                        Ok(_) => {}
                        Err(error) => {
                            message.push_str(&format!("\nCould not read startup log: {error}"))
                        }
                    }
                }
                return Err(startup_failure(
                    stage,
                    "host_startup_process_exited",
                    None,
                    message,
                    true,
                ));
            }
            Err(error) => {
                return Err(startup_failure(
                    stage,
                    "host_startup_process_status_failed",
                    None,
                    format!("Could not read {expected_service} process status: {error}"),
                    true,
                ));
            }
            Ok(None) => {}
        }
        if let Some(identity) = matching_public_identity(
            host,
            port,
            expected_service,
            expected_instance_id,
            expected_pid,
        ) {
            return Ok(identity);
        }
        std::thread::sleep(Duration::from_millis(75));
    }
    Err(startup_failure(
        stage, identity_failure, None,
        format!("{expected_service} did not publish the expected process identity before the startup deadline."), true,
    ))
}

fn read_startup_log_tail(path: &Path) -> std::io::Result<String> {
    const LIMIT: u64 = 4096;
    let mut file = File::open(path)?;
    let offset = file.metadata()?.len().saturating_sub(LIMIT);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.take(LIMIT).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(if offset > 0 {
        format!("…\n{text}")
    } else {
        text.into_owned()
    })
}

fn matching_public_identity(
    host: &str,
    port: &str,
    expected_service: &str,
    expected_instance_id: &str,
    expected_pid: u32,
) -> Option<HostProcessIdentity> {
    let request = http_request(host, port, "GET", "/api/host/identity", &[]);
    let Ok(envelope) =
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

enum AuthenticatedHealthStatus {
    Ready,
    Failed,
    Unavailable,
}

fn authenticated_health_status(
    host: &str,
    port: &str,
    token_header: &str,
    token: &str,
) -> AuthenticatedHealthStatus {
    let request = http_request(host, port, "GET", "/api/health", &[(token_header, token)]);
    let Ok(envelope) =
        request_loopback_json::<HostApiEnvelope<HostHealthData>>(host, port, &request, 500)
    else {
        return AuthenticatedHealthStatus::Unavailable;
    };
    let Some(data) = envelope.ok.then_some(envelope.data).flatten() else {
        return AuthenticatedHealthStatus::Unavailable;
    };
    if data.ok && data.status == "ok" {
        return AuthenticatedHealthStatus::Ready;
    }
    AuthenticatedHealthStatus::Failed
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

fn register_native_browser(
    host: &str,
    port: &str,
    token: &str,
    id: &str,
    endpoint: &str,
    callback_token: &str,
    remove: bool,
) -> Result<(), String> {
    let body=serde_json::json!({"hostInstanceId":id,"endpoint":endpoint,"callbackToken":callback_token,"remove":remove}).to_string();
    let request = http_request(
        host,
        port,
        "POST",
        "/api/host/native-browser",
        &[
            (HOST_SHELL_TOKEN_HEADER, token),
            ("Content-Type", "application/json"),
        ],
    )
    .replace(
        "Content-Length: 0",
        &format!("Content-Length: {}", body.len()),
    ) + &body;
    let response: serde_json::Value = request_loopback_json(host, port, &request, 6000)
        .map_err(|error| format!("Native browser registration connection failed: {error}"))?;
    if response["ok"] == true {
        Ok(())
    } else {
        Err(response["message"]
            .as_str()
            .unwrap_or("Native browser registration failed.")
            .into())
    }
}

fn admit_private_host_ports(
    target: &LaunchTarget,
    reuse_daemon: bool,
) -> Result<(), HostStartupFailure> {
    let unavailable = if local_port_has_listener(&target.host, &target.port) {
        Some(("Host proxy", &target.port))
    } else if !reuse_daemon && local_port_has_listener(&target.host, &target.daemon_port) {
        Some(("Kernel daemon", &target.daemon_port))
    } else {
        None
    };
    if let Some((service, port)) = unavailable {
        return Err(startup_failure(
            "startAdmission",
            "host_startup_port_in_use",
            None,
            format!(
                "The {service} port {}:{port} is already in use.",
                target.host
            ),
            true,
        ));
    }
    Ok(())
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

fn default_workspace_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("DEEPCODE_DEFAULT_WORKSPACE").map(PathBuf::from) {
        if path.is_dir() {
            return Some(path);
        }
    }
    None
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_only_requires_ports_for_processes_it_will_start() {
        let daemon = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let proxy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let target = LaunchTarget {
            host: "127.0.0.1".into(),
            port: proxy.local_addr().unwrap().port().to_string(),
            daemon_port: daemon.local_addr().unwrap().port().to_string(),
        };
        let occupied_proxy = admit_private_host_ports(&target, true).unwrap_err();
        assert_eq!(occupied_proxy.code, "host_startup_port_in_use");
        assert!(occupied_proxy.message.contains("Host proxy"));
        drop(proxy); // Retry has reclaimed its private proxy, not the daemon.
        assert!(admit_private_host_ports(&target, true).is_ok());
        let occupied_daemon = admit_private_host_ports(&target, false).unwrap_err();
        assert_eq!(occupied_daemon.code, "host_startup_port_in_use");
        assert!(occupied_daemon.message.contains("Kernel daemon"));
        assert!(TcpStream::connect(daemon.local_addr().unwrap()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn identity_wait_preserves_process_exit_and_original_startup_error() {
        let directory = std::env::temp_dir().join(format!(
            "deepcode-startup-diagnostic-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir(&directory).unwrap();
        let diagnostic = HostDiagnosticAttempt {
            directory: directory.clone(),
            reference: "host-startup/test-attempt".into(),
        };
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf '%s\\n' 'session_store_event_schema_mismatch: original error' >&2; exit 17",
        ]);
        configure_process_capture(&mut command, Some(&directory), "daemon").unwrap();
        let mut daemon = spawn_owned_host_process(&mut command).unwrap();
        let status = daemon.child.wait().unwrap();
        let failure = wait_for_public_identity(
            &mut daemon,
            "127.0.0.1",
            "0",
            KERNEL_DAEMON_SERVICE,
            "test-instance",
            &HostProcessGroup::new(None),
            1,
            Some(&diagnostic),
        )
        .unwrap_err();
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(failure.stage, "daemonIdentity");
        assert_eq!(failure.code, "host_startup_process_exited");
        assert!(failure.message.contains(&status.to_string()));
        assert!(failure
            .message
            .contains("session_store_event_schema_mismatch: original error"));
        assert!(failure
            .message
            .contains("host-startup/test-attempt/daemon.stderr.log"));
    }

    #[cfg(unix)]
    fn sleeping_owned_host_process() -> OwnedHostProcess {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        spawn_owned_host_process(&mut command).expect("spawn owned test process")
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn closing_shell_reclaims_private_proxy_and_leaves_shared_daemon_alive() {
        let mut shared_daemon = sleeping_owned_host_process();
        let daemon_pid = shared_daemon.child.id();
        let proxy = sleeping_owned_host_process();
        let proxy_pid = proxy.child.id();
        let processes = HostProcessGroup::new(None);
        let installed = processes.install(OwnedHostChildren {
            client_lease: None,
            daemon: None,
            start_guard: None,
            proxy,
            daemon_host: "127.0.0.1".into(),
            daemon_port: "0".into(),
            daemon_token: "test-token".into(),
            daemon_identity: HostProcessIdentity {
                service: KERNEL_DAEMON_SERVICE.into(),
                instance_id: format!("{HOST_INSTANCE_ID_PREFIX}test"),
                pid: daemon_pid,
                address: "127.0.0.1:0".into(),
            },
        });
        processes.detach();
        let proxy_alive = process_exists(proxy_pid);
        let shared_alive = process_exists(daemon_pid);
        terminate_owned_process_tree(&mut shared_daemon);
        assert!(installed);
        assert!(!proxy_alive);
        assert!(shared_alive);
    }

    #[test]
    fn application_shutdown_latches_before_late_startup_can_install_children() {
        let processes = HostProcessGroup::new(None);
        assert!(!processes.is_shutting_down());

        processes.detach();

        assert!(processes.is_shutting_down());
    }

    #[cfg(unix)]
    #[test]
    fn application_shutdown_rejects_and_reclaims_late_host_children() {
        let processes = HostProcessGroup::new(None);
        processes.detach();

        let daemon = sleeping_owned_host_process();
        let proxy = sleeping_owned_host_process();
        let daemon_pid = daemon.child.id();
        let proxy_pid = proxy.child.id();
        let children = OwnedHostChildren {
            client_lease: None,
            daemon: Some(daemon),
            start_guard: None,
            proxy,
            daemon_host: "127.0.0.1".to_string(),
            daemon_port: "0".to_string(),
            daemon_token: "test-token".to_string(),
            daemon_identity: HostProcessIdentity {
                service: KERNEL_DAEMON_SERVICE.to_string(),
                instance_id: format!("{HOST_INSTANCE_ID_PREFIX}test"),
                pid: daemon_pid,
                address: "127.0.0.1:0".to_string(),
            },
        };

        assert!(process_exists(daemon_pid));
        assert!(process_exists(proxy_pid));
        assert!(!processes.install(children));
        assert!(!process_exists(daemon_pid));
        assert!(!process_exists(proxy_pid));
    }

    #[test]
    fn retry_reclaim_does_not_latch_application_shutdown() {
        let processes = HostProcessGroup::new(None);

        processes.reclaim_current();

        assert!(!processes.is_shutting_down());
    }

    #[test]
    fn application_shutdown_waits_for_every_active_startup_lease() {
        let processes = std::sync::Arc::new(HostProcessGroup::new(None));
        let startup_processes = std::sync::Arc::clone(&processes);
        let startup_finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let startup_finished_by_thread = std::sync::Arc::clone(&startup_finished);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let startup_thread = std::thread::spawn(move || {
            let _startup_lease = startup_processes
                .begin_startup()
                .expect("startup is admitted before application shutdown");
            started_tx.send(()).expect("report admitted startup");
            while !startup_processes.is_shutting_down() {
                std::thread::yield_now();
            }
            startup_finished_by_thread.store(true, std::sync::atomic::Ordering::Release);
        });
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("startup lease is active");

        processes.detach();

        assert!(startup_finished.load(std::sync::atomic::Ordering::Acquire));
        startup_thread.join().expect("startup thread exits");
    }
}
