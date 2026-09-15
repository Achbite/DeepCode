use std::{path::PathBuf, process::Command};

#[tauri::command]
pub async fn deepcode_open_file(webview: tauri::Webview, path: String) -> Result<(), String> {
    if webview.label() != "main" { return Err("File opening belongs to the primary application view.".into()); }
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_file() { return Err("The selected file does not exist.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os="macos")]
        let mut command = { let mut command = Command::new("/usr/bin/open"); command.args(["-a", "Visual Studio Code"]); command };
        #[cfg(not(target_os="macos"))]
        let mut command = Command::new(if cfg!(windows) { "code.cmd" } else { "code" });
        let output = command.arg(path).output().map_err(|error| format!("Open in VS Code: {error}"))?;
        if output.status.success() { Ok(()) } else { Err(format!("Open in VS Code: {}", String::from_utf8_lossy(&output.stderr))) }
    }).await.map_err(|error| error.to_string())?
}
