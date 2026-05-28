#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "31245";

struct KernelProcess {
    child: Mutex<Option<Child>>,
}

impl KernelProcess {
    fn new(child: Option<Child>) -> Self {
        Self {
            child: Mutex::new(child),
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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![deepcode_boot_target])
        .setup(|app| {
            let target = resolve_launch_target();
            app.manage(target.clone());
            create_main_window(app, &target)?;
            let child = spawn_kernel_if_available(&target.host, &target.port);
            app.manage(KernelProcess::new(child));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                window.state::<KernelProcess>().terminate();
                window.app_handle().exit(0);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("failed to run DeepCode Tauri shell");
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchTarget {
    host: String,
    port: String,
}

#[tauri::command]
fn deepcode_boot_target(target: State<'_, LaunchTarget>) -> LaunchTarget {
    target.inner().clone()
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
    let boot_url = format!("index.html#host={}&port={}", target.host, target.port);
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App(boot_url.into()))
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

fn spawn_kernel_if_available(host: &str, port: &str) -> Option<Child> {
    if env_truthy("DEEPCODE_SHELL_CONNECT_ONLY") {
        return None;
    }

    let exe_dir = current_exe_dir()?;
    let kernel_path = exe_dir.join(kernel_binary_name());
    if !kernel_path.is_file() {
        return None;
    }

    let web_dir = std::env::var("DEEPCODE_CLIENT_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| exe_dir.join("web"));

    let mut command = Command::new(kernel_path);
    command
        .current_dir(&exe_dir)
        .env("DEEPCODE_HOST", host)
        .env("DEEPCODE_PORT", port)
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
