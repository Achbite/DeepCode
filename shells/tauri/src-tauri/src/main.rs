#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "31245";
const APP_ASSET_SCHEME: &str = "deepcode-editor";
const APP_ASSET_DIR: &str = "web";

struct KernelProcess {
    child: Mutex<Option<Child>>,
}

impl KernelProcess {
    fn new(child: Option<Child>) -> Self {
        Self {
            child: Mutex::new(child),
        }
    }

    fn replace(&self, child: Option<Child>) {
        if let Ok(mut current) = self.child.lock() {
            if let Some(mut process) = current.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
            *current = child;
        }
    }

    fn terminate(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}

impl Drop for KernelProcess {
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
            app.manage(target.clone());
            app.manage(KernelProcess::new(None));
            create_main_window(app, &target)?;
            if startup_permission_preflight(APP_ASSET_DIR) {
                let child = spawn_kernel_if_available(&target.host, &target.port);
                app.state::<KernelProcess>().replace(child);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                window.state::<KernelProcess>().terminate();
                window.app_handle().exit(0);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build DeepCode Tauri shell");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            app_handle.state::<KernelProcess>().terminate();
        }
        _ => {}
    });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchTarget {
    host: String,
    port: String,
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
    kernel: State<'_, KernelProcess>,
) -> KernelStartResult {
    if !startup_permission_preflight(APP_ASSET_DIR) {
        return KernelStartResult {
            started: false,
            blocked: true,
            message: "startup permission preflight did not complete".to_string(),
        };
    }

    let child = spawn_kernel_if_available(&target.host, &target.port);
    let started = child.is_some();
    kernel.replace(child);
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
    LaunchTarget { host, port }
}

fn create_main_window(
    app: &tauri::App,
    target: &LaunchTarget,
) -> Result<(), Box<dyn std::error::Error>> {
    let boot_url = format!(
        "{APP_ASSET_SCHEME}://localhost/index.html#host={}&port={}",
        target.host, target.port
    );
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(boot_url.parse()?))
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

// 发布包中 `deepcode-kernel(.exe)` 是同目录 Kernel daemon；macOS .app
// 同样优先查找 Contents/MacOS，并为后续资源式布局保留 Contents/Resources
// 兜底。开发态或 `DEEPCODE_SHELL_CONNECT_ONLY=1` 时可只连接外部已启动 daemon。
fn spawn_kernel_if_available(host: &str, port: &str) -> Option<Child> {
    if env_truthy("DEEPCODE_SHELL_CONNECT_ONLY") {
        return None;
    }

    let exe_dir = current_exe_dir()?;
    let kernel_path = find_bundled_file(&exe_dir, kernel_binary_name())?;
    let kernel_dir = parent_dir(&kernel_path).unwrap_or_else(|| exe_dir.clone());
    let config_root = std::env::var_os("DEEPCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| package_root(&exe_dir).unwrap_or_else(|| kernel_dir.clone()));

    let web_dir = std::env::var("DEEPCODE_CLIENT_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            find_bundled_dir(&exe_dir, "web").unwrap_or_else(|| kernel_dir.join("web"))
        });

    let mut command = Command::new(kernel_path);
    command
        .current_dir(&kernel_dir)
        .env("DEEPCODE_HOST", host)
        .env("DEEPCODE_PORT", port)
        .env("DEEPCODE_CONFIG_DIR", config_root)
        .env("DEEPCODE_CLIENT_DIST", web_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    command.spawn().ok()
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

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}
